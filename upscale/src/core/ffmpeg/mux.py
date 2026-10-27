from __future__ import annotations

import math
import subprocess
from pathlib import Path

from ..jobs import Cancelled, JobController
from ..render_metadata import (
    VIDEO_NOTE_FORMATS, MetadataNoteError, check_cancelled, embedding_warning,
    merge_render_note, record_embedding,
)
from ..paths import FFMPEG, FFPROBE
from .probe import _run_json

def _probe_rendered_duration(path: Path, controller: JobController | None = None) -> float:
    """Read the intermediate video's duration without decoding/counting its frames."""
    data = _run_json(
        [
            str(FFPROBE),
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=duration:format=duration",
            "-of",
            "json",
            str(path),
        ], controller=controller,
    )
    streams = data.get("streams") or []
    values = [
        (streams[0] if streams else {}).get("duration"),
        (data.get("format") or {}).get("duration"),
    ]
    for raw_value in values:
        try:
            duration = float(raw_value)
        except (TypeError, ValueError):
            continue
        if math.isfinite(duration) and duration > 0:
            return duration
    raise RuntimeError(
        "Could not determine the rendered video's duration for the final audio mux."
    )


def final_mux(
    temp_video: Path,
    source: Path,
    output: Path,
    container: str,
    controller: JobController | None = None,
    preserve_supported_subtitles: bool = False,
    *, render_note: str | None = None, metadata_diagnostics: dict | None = None,
    source_time_origin: float | None = None,
) -> None:
    check_cancelled(controller)
    if render_note is None or container not in VIDEO_NOTE_FORMATS:
        if render_note is not None:
            record_embedding(metadata_diagnostics, "skipped", reason="unsupported_format")
        elif metadata_diagnostics is not None and not metadata_diagnostics:
            record_embedding(metadata_diagnostics, "not_requested")
        _final_mux_once(temp_video, source, output, container, controller, preserve_supported_subtitles, source_time_origin=source_time_origin)
        return

    try:
        comment = merge_render_note(_read_comment(source, controller), render_note)
        # Windows has a finite command-line length. Never truncate source text.
        if len(comment.encode("utf-16-le")) > 16000:
            raise MetadataNoteError("Existing comment is too large to safely extend")
    except Cancelled:
        raise
    except (ValueError, TypeError, RuntimeError) as exc:
        check_cancelled(controller)
        embedding_warning(metadata_diagnostics, exc)
        _final_mux_once(temp_video, source, output, container, controller, preserve_supported_subtitles, source_time_origin=source_time_origin)
        return

    try:
        _final_mux_once(temp_video, source, output, container, controller,
                        preserve_supported_subtitles, comment=comment, source_time_origin=source_time_origin)
        if _read_comment(output, controller) != comment:
            raise MetadataNoteError("Saved video did not retain the settings note")
    except Cancelled:
        raise
    except (ValueError, RuntimeError) as exc:
        check_cancelled(controller)
        if isinstance(exc, _MuxFailure) and exc.filesystem_error:
            raise
        embedding_warning(metadata_diagnostics, exc)
        _final_mux_once(temp_video, source, output, container, controller, preserve_supported_subtitles, source_time_origin=source_time_origin)
        return
    record_embedding(metadata_diagnostics, "embedded", field="format.comment")


def _read_comment(path: Path, controller: JobController | None) -> str | None:
    data = _run_json([
        str(FFPROBE), "-v", "error", "-show_entries", "format_tags=comment",
        "-of", "json", str(path),
    ], controller=controller)
    return next((value for key, value in (data.get("format", {}).get("tags") or {}).items()
                 if key.casefold() == "comment"), None)


class _MuxFailure(RuntimeError):
    def __init__(self, stderr: str):
        super().__init__("Final audio/metadata mux failed:\n" + stderr[-4000:])
        self.filesystem_error = any(message in stderr.casefold() for message in (
            "permission denied", "access is denied", "no space left", "disk full",
            "input/output error", "i/o error", "read-only file system", "error opening output",
        ))


def _final_mux_once(
    temp_video: Path, source: Path, output: Path, container: str,
    controller: JobController | None, preserve_supported_subtitles: bool,
    *, comment: str | None = None, source_time_origin: float | None = None,
) -> None:
    check_cancelled(controller)
    duration = _probe_rendered_duration(temp_video, controller)
    if container == "MKV":
        maps = ["-map", "0:v:0", "-map", "1:a?", "-map", "1:s?"]
        streams = ["-c:v", "copy", "-c:a", "copy", "-c:s", "copy"]
    else:
        maps = ["-map", "0:v:0", "-map", "1:a?"]
        streams = [
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-movflags",
            "+faststart",
        ]
        if preserve_supported_subtitles:
            subtitle_data = _run_json(
                [
                    str(FFPROBE),
                    "-v",
                    "error",
                    "-select_streams",
                    "s",
                    "-show_entries",
                    "stream=index,codec_name",
                    "-of",
                    "json",
                    str(source),
                ], controller=controller,
            )
            supported_text = {"ass", "ssa", "subrip", "mov_text", "webvtt", "text"}
            subtitle_indices = [
                int(stream["index"])
                for stream in subtitle_data.get("streams") or []
                if stream.get("codec_name") in supported_text
            ]
            for stream_index in subtitle_indices:
                maps.extend(["-map", f"1:{stream_index}"])
            if subtitle_indices:
                streams.extend(["-c:s", "mov_text"])
    command = [
        str(FFMPEG),
        "-hide_banner",
        "-loglevel",
        "warning",
        "-y",
        *(["-copyts"] if source_time_origin is not None else []),
        "-i",
        str(temp_video),
        "-t",
        f"{duration:.9f}",
        *(["-itsoffset", f"{-source_time_origin:.9f}"] if source_time_origin is not None else []),
        "-i",
        str(source),
        *maps,
        "-map_metadata",
        "1",
        "-map_chapters",
        "1",
        *streams,
        *(["-avoid_negative_ts", "disabled", "-metadata:s:v:0", "rotate=0"] if source_time_origin is not None else []),
        *(["-metadata", "comment=" + comment] if comment is not None else []),
        str(output),
    ]
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if controller is not None:
        controller.register(process)
    try:
        while True:
            check_cancelled(controller)
            try:
                _stdout, stderr = process.communicate(timeout=0.2)
                break
            except subprocess.TimeoutExpired:
                continue
        check_cancelled(controller)
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
        if process.stderr is not None:
            process.stderr.close()
        if controller is not None:
            controller.unregister(process)
    if process.returncode:
        raise _MuxFailure(stderr)
