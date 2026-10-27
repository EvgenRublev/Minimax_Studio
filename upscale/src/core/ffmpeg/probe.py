from __future__ import annotations

import json
import os
import subprocess
import tempfile
from fractions import Fraction
from pathlib import Path

import av

from ..paths import FFPROBE
from ..jobs import Cancelled, JobController

def _run_json(
    command: list[str], *, strict_decode: bool = False,
    controller: JobController | None = None,
) -> dict:
    if controller is not None and controller.cancel.is_set():
        raise Cancelled("Render stopped by user.")
    # ffprobe can report decoding errors and still exit with code zero. Keep its
    # error output outside RAM, and retain a bounded excerpt for diagnostics.
    with tempfile.TemporaryFile() as errors:
        process = subprocess.Popen(
            command, stdout=subprocess.PIPE, stderr=errors,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if controller is not None:
            controller.register(process)
        try:
            while True:
                if controller is not None and controller.cancel.is_set():
                    raise Cancelled("Render stopped by user.")
                try:
                    stdout, _ = process.communicate(timeout=0.2)
                    break
                except subprocess.TimeoutExpired:
                    continue
            if controller is not None and controller.cancel.is_set():
                raise Cancelled("Render stopped by user.")
            size = errors.seek(0, os.SEEK_END)
            errors.seek(max(0, size - 8000))
            details = errors.read().decode("utf-8", "replace").strip()
            if strict_decode and size:
                raise RuntimeError("Source decoding failed during frame-count verification:\n" + details)
            if process.returncode:
                raise RuntimeError(details or "Media probe failed")
            return json.loads(stdout)
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            if process.stdout is not None:
                process.stdout.close()
            if controller is not None:
                controller.unregister(process)


def _positive_count(value: object) -> int:
    try:
        return max(0, int(value))
    except (ValueError, TypeError, OverflowError):
        return 0


def probe_video(
    path: str | os.PathLike[str], *, count_mode: str = "exact",
    strict_decode: bool = False, controller: JobController | None = None,
) -> dict:
    """Probe video metadata, optionally counting decoded frames or packets.

    The default remains the legacy exact decoded-frame count for external callers.
    Conversion paths use metadata first and pay for exact counting only as fallback.
    Strict decoding rejects decoder errors and unavailable decoded counts, even
    when ffprobe exits successfully or the container declares a positive count.
    """
    if count_mode not in {"metadata", "exact", "packets"}:
        raise ValueError(f"Unknown video count mode: {count_mode!r}.")
    if strict_decode and count_mode != "exact":
        raise ValueError("Strict decoding requires count_mode='exact'.")
    count_args = {
        "metadata": [],
        "exact": ["-count_frames"],
        "packets": ["-count_packets"],
    }[count_mode]
    data = _run_json(
        [
            str(FFPROBE),
            "-v",
            "error",
            *count_args,
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=index,codec_name,width,height,avg_frame_rate,r_frame_rate,time_base,duration,nb_frames,nb_read_frames,nb_read_packets,color_primaries,color_transfer,color_space:stream_tags=rotate:stream_side_data=rotation",
            "-show_entries",
            "format=duration,format_name",
            "-of",
            "json",
            str(path),
        ], strict_decode=strict_decode, controller=controller,
    )
    streams = data.get("streams") or []
    if not streams:
        raise ValueError("The selected file contains no decodable video stream.")
    stream = streams[0]
    rotation = int((stream.get("tags") or {}).get("rotate", 0) or 0)
    for side in stream.get("side_data_list") or []:
        if "rotation" in side:
            rotation = int(side["rotation"] or 0)
    rotation %= 360
    width, height = int(stream["width"]), int(stream["height"])
    if rotation in (90, 270):
        width, height = height, width
    declared_frames = _positive_count(stream.get("nb_frames"))
    decoded_frames = _positive_count(stream.get("nb_read_frames"))
    packet_frames = _positive_count(stream.get("nb_read_packets"))
    if count_mode == "packets":
        frames = packet_frames or declared_frames
        frame_count_source = "packets" if packet_frames else "metadata"
    elif count_mode == "exact":
        frames = decoded_frames if strict_decode else (decoded_frames or declared_frames)
        frame_count_source = "decoded" if decoded_frames else "metadata"
    else:
        frames = declared_frames
        frame_count_source = "metadata" if frames > 0 else "unavailable"
    if count_mode == "exact" and frames <= 0:
        raise ValueError("Could not determine an exact frame count for this video.")
    average_rate_text = stream.get("avg_frame_rate") or "0/0"
    nominal_rate_text = stream.get("r_frame_rate") or "0/0"
    rate_text = average_rate_text if average_rate_text != "0/0" else nominal_rate_text
    if rate_text == "0/0":
        rate_text = "30/1"
    rate = Fraction(rate_text) if rate_text != "0/0" else Fraction(30, 1)
    nominal_rate = (
        Fraction(nominal_rate_text)
        if nominal_rate_text != "0/0"
        else rate
    )
    transfer = stream.get("color_transfer") or "unknown"
    primaries = stream.get("color_primaries") or "unknown"
    color_space = stream.get("color_space") or "unknown"
    return {
        "width": width,
        "height": height,
        "coded_width": int(stream["width"]),
        "coded_height": int(stream["height"]),
        "rotation": rotation,
        "frames": frames,
        "frame_count_source": frame_count_source,
        "fps": float(rate),
        "rate": rate,
        "nominal_rate": nominal_rate,
        "cfr": rate == nominal_rate,
        "time_base": Fraction(stream.get("time_base") or "1/1000"),
        "duration": float(
            (data.get("format") or {}).get("duration") or stream.get("duration") or 0
        ),
        "codec": stream.get("codec_name") or "unknown",
        "format": (data.get("format") or {}).get("format_name") or "unknown",
        "color_transfer": transfer,
        "color_primaries": primaries,
        "color_space": color_space,
        "hdr": transfer in {"smpte2084", "arib-std-b67"},
    }

def preview_frame_count(source: Path, seconds: float) -> int:
    """Count frames whose presentation times fall within the opening interval."""
    container = av.open(str(source))
    try:
        stream = container.streams.video[0]
        rate = float(stream.average_rate or 30)
        first_time: float | None = None
        count = 0
        for frame in container.decode(stream):
            timestamp = (
                float(frame.pts * stream.time_base)
                if frame.pts is not None and stream.time_base is not None
                else count / rate
            )
            if first_time is None:
                first_time = timestamp
            if count and timestamp - first_time >= seconds:
                break
            count += 1
        if count == 0:
            raise RuntimeError("The input video contains no decodable preview frames.")
        return count
    finally:
        container.close()
