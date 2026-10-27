from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
import threading
import time
from contextlib import nullcontext
from dataclasses import asdict, dataclass, replace
from fractions import Fraction
from pathlib import Path
from typing import Callable

import av
import numpy as np

from ..core import ffmpeg
from ..core.gpu_selection import resolve_runtime_ai_gpu
from ..core.jobs import Cancelled, active_job
from ..core.naming import output_filename, validate_rename
from ..core.disk_paths import OutputFile, prepare_output_dir
from ..core.paths import JOBS, LOGS, OUTPUTS
from ..core.runtime import prepare_runtime, rotate_frame
from .capabilities import probe_frame_interpolation_capabilities
from .guides import DLSSGGuideGenerator, Guide
from .models import FrameInterpolationOptions, FrameInterpolationResult
from .native import DirectDLSSGSession
from .scheduler import choose_interpolation_plan, output_frame_count
from .pipeline import run_pipeline, PipeWriter

_BATCH_CONTEXT = threading.local()

@dataclass(frozen=True, slots=True)
class TimedFrame:
    rgba: np.ndarray
    timestamp: Fraction
    segment: int
    provenance: str
    source_index: int | None = None


@dataclass(frozen=True, slots=True)
class PreparedFrame:
    frame: TimedFrame
    previous_timestamp: Fraction | None
    guide: Guide
    reset: bool


class DLSSGStage:
    def __init__(
        self,
        session: DirectDLSSGSession,
        width: int,
        height: int,
        generated_count: int,
        *,
        detect_source_cuts: bool,
    ) -> None:
        self.session = session
        self.guides = DLSSGGuideGenerator(width, height)
        self.generated_count = generated_count
        self.previous: TimedFrame | None = None
        self.detect_source_cuts = detect_source_cuts
        self.scene_cuts = 0
        self.duplicates = 0

    def prepare(self, frame: TimedFrame) -> PreparedFrame:
        # Only the guide worker advances this history. Capture all temporal
        # decisions here so native evaluation can overlap the next preparation.
        previous = self.previous
        force_reset = self.previous is not None and frame.segment != self.previous.segment
        guide = self.guides.process(frame.rgba, force_reset=force_reset)
        if previous is not None and self.detect_source_cuts and guide.reset and not force_reset:
            frame = replace(frame, segment=previous.segment + 1)
            force_reset = True
            self.scene_cuts += 1
        if previous is not None and guide.duplicate:
            self.duplicates += 1
        self.previous = frame
        return PreparedFrame(frame, previous.timestamp if previous else None, guide,
                             previous is None or force_reset or guide.reset)

    def evaluate(self, prepared: PreparedFrame) -> list[TimedFrame]:
        frame = prepared.frame
        generated = self.session.process_frame(
            frame.rgba,
            prepared.guide.motion,
            frame.timestamp,
            reset=prepared.reset,
        )
        output: list[TimedFrame] = []
        if not prepared.reset and prepared.previous_timestamp is not None:
            interval = frame.timestamp - prepared.previous_timestamp
            for index, rgba in enumerate(generated, start=1):
                output.append(
                    TimedFrame(
                        rgba,
                        prepared.previous_timestamp
                        + interval * Fraction(index, self.generated_count + 1),
                        frame.segment,
                        "DLSSG",
                        None,
                    )
                )
        output.append(frame)
        return output

    def push(self, frame: TimedFrame) -> list[TimedFrame]:
        return self.evaluate(self.prepare(frame))


class NearestTimestampWriter:
    def __init__(self, nut, stream, target_rate: Fraction, output_count: int) -> None:
        self.nut = nut
        self.stream = stream
        self.target_rate = target_rate
        self.output_count = output_count
        self.next_index = 0
        self.previous: TimedFrame | None = None
        self.tie_late = False
        self.copied = 0
        self.generated = 0
        self.max_error = Fraction(0)
        self.selected_real_ids: set[int] = set()

    def _write(self, frame: TimedFrame, ideal: Fraction) -> None:
        packet = av.Packet(memoryview(frame.rgba).cast("B"))
        packet.stream = self.stream
        packet.pts = packet.dts = self.next_index
        packet.duration = 1
        packet.time_base = Fraction(1, 1) / self.target_rate
        packet.is_keyframe = True
        self.nut.mux(packet)
        error = abs(frame.timestamp - ideal)
        self.max_error = max(self.max_error, error)
        if frame.provenance == "DLSSG":
            self.generated += 1
        else:
            self.copied += 1
            if frame.source_index is not None:
                self.selected_real_ids.add(frame.source_index)
        self.next_index += 1

    def push(self, current: TimedFrame) -> None:
        if self.previous is None:
            self.previous = current
            return
        midpoint = (self.previous.timestamp + current.timestamp) / 2
        while self.next_index < self.output_count:
            ideal = Fraction(self.next_index, 1) / self.target_rate
            if ideal < midpoint:
                self._write(self.previous, ideal)
            elif ideal == midpoint:
                selected = current if self.tie_late else self.previous
                self.tie_late = not self.tie_late
                self._write(selected, ideal)
            else:
                break
        self.previous = current

    def finish(self) -> None:
        if self.previous is None:
            raise RuntimeError("The input video contains no decodable frames.")
        while self.next_index < self.output_count:
            ideal = Fraction(self.next_index, 1) / self.target_rate
            # A finite video has no future endpoint beyond its final real frame.
            # Extend that endpoint over the final frame-duration without asking a
            # synthesizer to extrapolate beyond known motion.
            endpoint = TimedFrame(
                self.previous.rgba,
                ideal,
                self.previous.segment,
                "Source",
                self.previous.source_index,
            )
            self._write(endpoint, ideal)

def _json_safe(value):
    if isinstance(value, Fraction):
        return str(value)
    if isinstance(value, dict):
        return {key: _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    return value


def _duration_fraction(
    metadata: dict, source_rate: Fraction, frames: int, *, cfr: bool
) -> Fraction:
    if cfr and frames > 0:
        return Fraction(frames, 1) / source_rate
    return Fraction(str(metadata["duration"]))


def _validate(options: FrameInterpolationOptions) -> None:
    _ = options.target_rate
    validate_rename(options.rename_mode, options.custom_suffix)
    ffmpeg.validate_codec_container(options.codec, options.container)
    if getattr(options, "hdr_mode", False) and not ffmpeg.hdr_mode_supported(options.codec):
        raise ValueError(
            f"HDR Mode is only available for H.265, H.265 (NVIDIA NVENC), AV1, AV1 (NVIDIA NVENC) and ProRes Proxy; current codec is {options.codec!r}."
        )
    if options.preview_seconds is not None:
        if not math.isfinite(float(options.preview_seconds)) or float(options.preview_seconds) <= 0:
            raise ValueError("Preview duration must be positive.")

def interpolate_video(
    input_path: str | os.PathLike[str],
    options: FrameInterpolationOptions | None = None,
    progress: Callable[[float, str], None] | None = None,
    *, output_dir: str | os.PathLike[str] | None = None, controller=None,
) -> FrameInterpolationResult:
    options = options or FrameInterpolationOptions()
    _validate(options)
    source = Path(input_path).resolve()
    if not source.is_file():
        raise FileNotFoundError(source)
    prepared_runtime = prepare_runtime()
    ai_gpu = resolve_runtime_ai_gpu(
        prepared_runtime.gpus, prepared_runtime.runtime_bundle, options.ai_gpu_uuid
    )
    capabilities = probe_frame_interpolation_capabilities(options.ai_gpu_uuid)
    if not capabilities.available:
        raise RuntimeError(
            "Direct NVIDIA DLSS Frame Generation is unavailable. " + capabilities.detail
        )
    prepared_controller = getattr(_BATCH_CONTEXT, "controller", None)
    job_context = nullcontext(prepared_controller) if prepared_controller is not None else active_job(controller)
    with job_context as controller:
        assert controller is not None
        started = time.perf_counter()

        def _report_progress(value: float, desc: str) -> None:
            if progress is None:
                return
            try:
                v = float(value)
                v = 0.0 if v < 0 else (1.0 if v > 1 else v)
                elapsed = time.perf_counter() - started
                if 0.01 < v < 0.99 and elapsed > 0.5:
                    eta = elapsed * (1 - v) / max(v, 1e-6)
                    desc = f"{desc} - Time Remaining: {eta:.1f}s"
                progress(v, desc)
            except Exception:
                try:
                    progress(value, desc)
                except Exception:
                    pass

        timings: dict[str, float] = {}
        output: Path | None = None
        job_dir: Path | None = None
        sessions: list[DirectDLSSGSession] = []
        encoder = None
        encoder_thread = None
        nut = None
        output_file: OutputFile | None = None
        performance = {}
        try:
            probe_started = time.perf_counter()
            metadata = ffmpeg.probe_video(source, count_mode="metadata")
            is_preview = options.preview_seconds is not None
            compat_preview = is_preview and bool(getattr(options, "preview_compat", True))
            effective_hdr = (
                bool(getattr(options, "hdr_mode", False))
                and (not is_preview or not compat_preview)
                and ffmpeg.hdr_mode_supported(options.codec)
            )
            if metadata["hdr"] and not effective_hdr:
                raise ValueError(
                    "Frame Interpolation v1 accepts SDR video only. Enable HDR Mode (H.265/AV1/ProRes, 10-bit, copies input colorspace) to keep HDR, or convert PQ/HLG to SDR."
                )
            hdr_metadata = None
            if effective_hdr:
                hdr_metadata = {
                    "color_space": metadata.get("color_space", "unknown"),
                    "color_primaries": metadata.get("color_primaries", "unknown"),
                    "color_transfer": metadata.get("color_transfer", "unknown"),
                    "hdr": bool(metadata.get("hdr", False)),
                }
            source_rate = Fraction(metadata["rate"])
            cfr = bool(metadata.get("cfr", True))
            frames = int(metadata["frames"])
            if frames <= 0:
                frames = int(ffmpeg.probe_video(source, count_mode="exact")["frames"])
            full_duration = _duration_fraction(
                metadata, source_rate, frames, cfr=cfr
            )
            duration = full_duration
            if options.preview_seconds is not None:
                duration = min(duration, Fraction(str(options.preview_seconds)))
                frames = min(frames, ffmpeg.preview_frame_count(source, float(duration)))
                duration = min(duration, Fraction(frames, 1) / source_rate)
            plan = choose_interpolation_plan(
                source_rate,
                options.target_rate,
                options.engine,
                capabilities.native_multiplier,
                cfr=cfr,
            )
            output_count = output_frame_count(duration, options.target_rate)
            timings["probe_seconds"] = time.perf_counter() - probe_started
            _report_progress(0.01, f"{plan.path}: {source_rate} → {options.target_rate} FPS")

            destination = prepare_output_dir(output_dir, default=OUTPUTS)
            JOBS.mkdir(exist_ok=True)
            LOGS.mkdir(exist_ok=True)
            stamp = time.strftime("%Y%m%d-%H%M%S") + f"-{time.time_ns() % 1_000_000:06d}"
            job_dir = JOBS / f"{source.stem}-DLSSFG-{stamp}-{os.getpid()}"
            job_dir.mkdir(parents=True, exist_ok=False)
            extension = {"MP4": ".mp4", "MKV": ".mkv", "MOV": ".mov"}[options.container]
            auto_stem = f"{source.stem}_{'DLSSFG_PREVIEW' if options.preview_seconds else 'DLSSFG'}_{stamp}"
            output = destination / output_filename(
                source, extension, options.rename_mode, options.custom_suffix, auto_stem
            )
            output_file = OutputFile(output)
            # NUT preserves the exact rational frame clock between PyAV and FFmpeg;
            # Matroska's millisecond timestamp scale rounds 60000/1001 and short previews.
            temp_video = job_dir / "interpolated-video.nut"
            selected_codec = "H.264" if compat_preview else options.codec
            video_gpu = ffmpeg.resolve_video_gpu(
                prepared_runtime.gpus,
                options.video_gpu_uuid,
                selected_codec,
                int(metadata["width"]),
                int(metadata["height"]),
            )
            setup_started = time.perf_counter()
            encoder, encoder_thread, encoder_logs, selected_encoder, quality = ffmpeg.start_encoder(
                temp_video,
                selected_codec,
                options.quality,
                controller,
                int(metadata["width"]),
                int(metadata["height"]),
                float(options.target_rate),
                None if video_gpu is None else int(video_gpu["cuda_ordinal"]),
                video_gpu is not None,
                hdr_mode=effective_hdr,
                hdr_metadata=hdr_metadata,
            )
            assert encoder.stdin is not None
            if plan.path == "Native DLSSG":
                sessions.append(
                    DirectDLSSGSession(
                        int(metadata["width"]), int(metadata["height"]), frames,
                        plan.generated_per_interval, controller,
                    )
                )
            elif plan.path == "Cascade":
                for stage_index in range(plan.cascade_stages):
                    expected = max(1, (frames - 1) * (1 << stage_index) + 1)
                    sessions.append(
                        DirectDLSSGSession(
                            int(metadata["width"]), int(metadata["height"]), expected, 1, controller
                        )
                    )
            stages = [
                DLSSGStage(
                    session,
                    int(metadata["width"]),
                    int(metadata["height"]),
                    plan.generated_per_interval if plan.path == "Native DLSSG" else 1,
                    detect_source_cuts=index == 0,
                )
                for index, session in enumerate(sessions)
            ]
            nut = av.open(PipeWriter(encoder.stdin), mode="w", format="nut")
            raw_stream = nut.add_stream("rawvideo", rate=options.target_rate)
            raw_stream.width = int(metadata["width"])
            raw_stream.height = int(metadata["height"])
            raw_stream.pix_fmt = "rgba"
            raw_stream.codec_context.codec_tag = "RGBA"
            raw_stream.time_base = Fraction(1, 1) / options.target_rate
            nut.start_encoding()
            writer = NearestTimestampWriter(nut, raw_stream, options.target_rate, output_count)
            timings["encoder_and_worker_setup_seconds"] = time.perf_counter() - setup_started

            decoded = 0
            discontinuities = 0
            nominal_interval = Fraction(1, 1) / source_rate

            def decode_frames():
                nonlocal decoded, discontinuities
                segment = 0
                last_timestamp = None
                with av.open(str(source)) as container:
                    stream = container.streams.video[0]
                    stream.thread_type = "AUTO"
                    for frame in container.decode(stream):
                        if decoded >= frames:
                            break
                        if controller.cancel.is_set():
                            raise Cancelled("Frame interpolation stopped by user.")
                        timestamp = (
                            Fraction(frame.pts) * Fraction(stream.time_base)
                            if frame.pts is not None and stream.time_base is not None
                            else Fraction(decoded, 1) / source_rate
                        )
                        if last_timestamp is not None and (
                            timestamp <= last_timestamp or timestamp - last_timestamp > nominal_interval * 2
                        ):
                            segment += 1
                            discontinuities += 1
                        last_timestamp = timestamp
                        rgba = rotate_frame(frame.to_ndarray(format="rgba"), int(metadata["rotation"]))
                        item = TimedFrame(np.ascontiguousarray(rgba), timestamp, segment, "Source", decoded)
                        decoded += 1
                        yield item

            def pipeline_progress(processed):
                if processed % max(1, frames // 100) == 0:
                    _report_progress(0.04 + 0.82 * processed / frames,
                                     f"DLSSG source frame {processed}/{frames}")

            performance = run_pipeline(
                decode_frames(), stages, writer, controller,
                int(metadata["width"]) * int(metadata["height"]) * 4,
                timings, pipeline_progress,
            )
            nut.close()
            nut = None
            encoder.stdin.close()
            shutdown_started = time.perf_counter()
            for session in sessions:
                session.close()
            sessions.clear()
            timings["worker_shutdown_seconds"] = time.perf_counter() - shutdown_started
            drain_started = time.perf_counter()
            encoder_code = encoder.wait(timeout=180)
            encoder_thread.join(timeout=2)
            controller.unregister(encoder)
            if encoder_code:
                raise RuntimeError("Video encoder failed:\n" + "\n".join(encoder_logs[-40:]))
            timings["encoder_drain_seconds"] = time.perf_counter() - drain_started
            _report_progress(0.9, "Muxing original audio, subtitles, chapters, and metadata")
            mux_started = time.perf_counter()
            ffmpeg.final_mux(
                temp_video,
                source,
                output_file.temporary,
                options.container,
                controller,
                preserve_supported_subtitles=True,
            )
            timings["mux_seconds"] = time.perf_counter() - mux_started
            verification_started = time.perf_counter()
            _report_progress(0.96, "Verifying saved output")
            verified = ffmpeg.probe_video(output_file.temporary, count_mode="packets", controller=controller)
            if int(verified["frames"]) != output_count:
                verified = ffmpeg.probe_video(output_file.temporary, count_mode="exact", controller=controller)
            if int(verified["frames"]) != output_count:
                raise RuntimeError(
                    f"Output verification found {verified['frames']} frames; expected {output_count}."
                )
            if Fraction(verified["rate"]) != options.target_rate:
                raise RuntimeError(
                    f"Output verification found {verified['rate']} FPS; expected {options.target_rate}."
                )
            scene_cuts = sum(stage.scene_cuts for stage in stages)
            duplicate_intervals = sum(stage.duplicates for stage in stages)
            dropped_frames = max(0, decoded - len(writer.selected_real_ids))
            timings["verification_seconds"] = time.perf_counter() - verification_started
            elapsed = time.perf_counter() - started
            timings["total_seconds"] = elapsed
            performance.update(source_frames_per_second=decoded / elapsed,
                               output_frames_per_second=output_count / elapsed)
            report = {
                "status": "success",
                "input": str(source),
                "output": str(output),
                "options": _json_safe(asdict(options)),
                "capabilities": asdict(capabilities),
                "ai_gpu": ai_gpu,
                "video_gpu": video_gpu,
                "plan": {key: str(value) if isinstance(value, Fraction) else value for key, value in asdict(plan).items()},
                "input_frames": decoded,
                "output_frames": output_count,
                "copied_frames": writer.copied,
                "generated_frames": writer.generated,
                "dropped_frames": dropped_frames,
                "maximum_temporal_approximation_seconds": float(writer.max_error),
                "scene_cuts": scene_cuts,
                "duplicate_intervals": duplicate_intervals,
                "timestamp_discontinuities": discontinuities,
                "encoder": selected_encoder,
                "encoding_quality": quality,
                "elapsed_seconds": elapsed,
                "timings": timings,
                "performance": performance,
            }
            report_path = LOGS / f"DLSSFG_{source.stem}_{stamp}.report.json"
            report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
            if controller.cancel.is_set():
                raise Cancelled("Frame interpolation stopped by user.")
            output_file.publish()
            _report_progress(1.0, "Frame interpolation complete")
            return FrameInterpolationResult(
                output_path=str(output.resolve()),
                report_path=str(report_path.resolve()),
                selected_path=plan.path,
                native_multiplier=plan.native_multiplier,
                cascade_stages=plan.cascade_stages,
                copied_frames=writer.copied,
                generated_frames=writer.generated,
                dropped_frames=dropped_frames,
                output_frames=output_count,
                maximum_temporal_approximation_seconds=float(writer.max_error),
                scene_cuts=scene_cuts,
                elapsed_seconds=elapsed,
                timings=timings,
            )
        except Exception as exc:
            controller.terminate_processes()
            if output_file is not None:
                output_file.cleanup(rollback=True)
            if controller.cancel.is_set():
                raise Cancelled("Frame interpolation stopped by user.") from exc
            if isinstance(exc, Cancelled):
                raise
            LOGS.mkdir(exist_ok=True)
            failure_stamp = time.strftime("%Y%m%d-%H%M%S") + f"-{time.time_ns() % 1_000_000:06d}"
            failure_path = LOGS / f"DLSSFG_{source.stem}_{failure_stamp}.failure.json"
            failure_path.write_text(
                json.dumps(
                    {
                        "status": "failure",
                        "input": str(source),
                        "options": _json_safe(asdict(options)),
                        "error": str(exc),
                        "capabilities": asdict(capabilities),
                        "worker_logs": [session.log_text() for session in sessions],
                        "timings": timings,
                        "performance": performance,
                    },
                    indent=2,
                ),
                encoding="utf-8",
            )
            raise RuntimeError(f"{exc}\nDiagnostic report: {failure_path.resolve()}") from exc
        finally:
            if output_file is not None:
                output_file.cleanup()
            if encoder is not None and encoder.poll() is None:
                encoder.terminate()
                try:
                    encoder.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    encoder.kill()
                    encoder.wait(timeout=5)
            if nut is not None:
                try:
                    nut.close()
                except (OSError, ValueError):
                    pass
            for session in sessions:
                session.close()
            if encoder is not None:
                if encoder_thread is not None:
                    encoder_thread.join(timeout=2)
                for stream in (encoder.stdin, encoder.stderr):
                    if stream is not None and not stream.closed:
                        try:
                            stream.close()
                        except OSError:
                            pass
                controller.unregister(encoder)
            if job_dir and job_dir.exists():
                shutil.rmtree(job_dir, ignore_errors=True)
