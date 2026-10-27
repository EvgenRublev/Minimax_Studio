from __future__ import annotations

import json
import math
import os
import queue
import shutil
import subprocess
import threading
import time
from contextlib import nullcontext, suppress
from dataclasses import asdict, replace
from fractions import Fraction
from pathlib import Path
from typing import Callable

import av
import numpy as np

from ...core import ffmpeg
from ...core.gpu_selection import resolve_runtime_ai_gpu
from ...core.jobs import Cancelled, active_job
from ...core.naming import output_filename, validate_rename
from ...core.disk_paths import OutputFile, prepare_output_dir
from ...core.render_metadata import prepare_render_note
from ...core.paths import JOBS, LOGS, OUTPUTS
from ...core.runtime import (
    DLSSFrameSession, prepare_runtime, resize_fit, rotate_frame, verify_feature_18,
    write_failure_report,
)
from .guides import TemporalGuideGenerator
from .models import ConversionOptions, ConversionResult, DLSS_MODEL_PRESETS
from .sizing import resolve_native_settings, resolve_output_size, resolve_upscaling_mode

validate_codec_container = ffmpeg.validate_codec_container
_BATCH_CONTEXT = threading.local()

def _validate_preview_options(
    options: ConversionOptions,
) -> tuple[float | None, int | None]:
    preview_seconds: float | None = None
    if options.preview_seconds is not None:
        try:
            preview_seconds = float(options.preview_seconds)
        except (TypeError, ValueError) as exc:
            raise ValueError("Preview duration must be a positive number of seconds.") from exc
        if not math.isfinite(preview_seconds) or preview_seconds <= 0:
            raise ValueError("Preview duration must be a positive number of seconds.")

    preview_frames: int | None = None
    if options.preview_frames is not None:
        if isinstance(options.preview_frames, bool):
            raise ValueError("Preview frame count must be a positive integer.")
        try:
            preview_frames = int(options.preview_frames)
        except (TypeError, ValueError) as exc:
            raise ValueError("Preview frame count must be a positive integer.") from exc
        if preview_frames <= 0 or preview_frames != options.preview_frames:
            raise ValueError("Preview frame count must be a positive integer.")
    if preview_seconds is not None and preview_frames is not None:
        raise ValueError("Choose either a timed preview or a frame preview, not both.")
    return preview_seconds, preview_frames


def convert_video(
    input_path: str | os.PathLike[str],
    options: ConversionOptions | None = None,
    progress: Callable[[float, str], None] | None = None,
    *, output_dir: str | os.PathLike[str] | None = None, controller=None,
) -> ConversionResult:
    options = replace(options) if options is not None else ConversionOptions()
    source = Path(input_path).resolve()
    if not source.is_file():
        raise FileNotFoundError(source)
    validate_codec_container(options.codec, options.container)
    validate_rename(options.rename_mode, options.custom_suffix)
    preview_seconds, preview_frames = _validate_preview_options(options)
    is_preview = preview_seconds is not None or preview_frames is not None
    # Compat previews use the forced H.264 SDR 8-bit path; user-encoded previews
    # (Preview Encoding Auto-playable / Disabled) preserve the HDR choice.
    compat_preview = is_preview and bool(getattr(options, "preview_compat", True))
    hdr_requested = bool(options.preserve_hdr)
    if compat_preview:
        hdr_requested = False
    if hdr_requested and not ffmpeg.hdr_mode_supported(options.codec):
        raise ValueError(
            f"HDR Mode is only available for H.265, H.265 (NVIDIA NVENC), AV1, AV1 (NVIDIA NVENC) and ProRes Proxy; "
            f"current codec is {options.codec!r}."
        )
    prepared_runtime = getattr(_BATCH_CONTEXT, "prepared_runtime", None)
    if prepared_runtime is None:
        prepared_runtime = prepare_runtime()
    batch_controller = getattr(_BATCH_CONTEXT, "controller", None)
    job_context = nullcontext(batch_controller) if batch_controller is not None else active_job(controller)

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
                else:
                    v = float(value) if isinstance(value, (int, float)) else v
                # Use positional `desc` so it works for both gr.Progress(desc=) and report_item(message)
                progress(v, desc)
            except Exception:
                try:
                    progress(value, desc)
                except Exception:
                    pass

        timings: dict[str, float] = {}
        job_dir: Path | None = None
        output: Path | None = None
        output_file: OutputFile | None = None
        session: DLSSFrameSession | None = None
        gpu: dict | None = resolve_runtime_ai_gpu(
            prepared_runtime.gpus, prepared_runtime.runtime_bundle, options.ai_gpu_uuid
        )
        video_gpu: dict | None = None
        runtime_bundle: dict | None = prepared_runtime.runtime_bundle
        encoder = None
        encoder_setup_thread: threading.Thread | None = None
        producer_thread: threading.Thread | None = None
        writer_thread: threading.Thread | None = None
        pipeline_stop = threading.Event()
        pipeline_errors: queue.Queue[BaseException] = queue.Queue(maxsize=4)
        producer_stats: dict[str, float | int | str] = {}
        writer_stats: dict[str, float | int] = {}
        frame_accounting: dict[str, object] = {"source_verification": "not_required"}

        def record_pipeline_error(exc: BaseException) -> None:
            pipeline_stop.set()
            try:
                pipeline_errors.put_nowait(exc)
            except queue.Full:
                pass

        try:
            stage_started = time.perf_counter()
            metadata = ffmpeg.probe_video(source, count_mode="metadata", controller=controller)
            declared_frames = int(metadata["frames"])
            estimated_frames = declared_frames or max(
                1, int(math.ceil(float(metadata["duration"]) * float(metadata["fps"])))
            )
            if preview_frames is not None:
                estimated_frames = min(estimated_frames, preview_frames) if declared_frames else preview_frames
            elif preview_seconds is not None:
                estimated_frames = min(estimated_frames, max(
                    1, int(math.ceil(preview_seconds * float(metadata["fps"])))
                ))
            frame_accounting.update(
                declared_frames=declared_frames, estimated_frames=estimated_frames,
                metadata_corrected=False,
            )
            timings["probe_seconds"] = time.perf_counter() - stage_started
            input_width = int(metadata["width"])
            input_height = int(metadata["height"])
            factor, mode = resolve_upscaling_mode(options.upscaling_factor)
            output_width, output_height = resolve_output_size(
                input_width, input_height, factor
            )
            video_gpu = ffmpeg.resolve_video_gpu(
                prepared_runtime.gpus,
                options.video_gpu_uuid,
                "H.264" if compat_preview else options.codec,
                output_width,
                output_height,
            )
            # HDR metadata to copy – 10-bit path when HDR Mode is on
            hdr_metadata = None
            effective_hdr = hdr_requested and (not is_preview or not compat_preview)
            if effective_hdr:
                hdr_metadata = {
                    "color_space": metadata.get("color_space", "unknown"),
                    "color_primaries": metadata.get("color_primaries", "unknown"),
                    "color_transfer": metadata.get("color_transfer", "unknown"),
                    "hdr": bool(metadata.get("hdr", False)),
                }
            destination = prepare_output_dir(output_dir, default=OUTPUTS)
            LOGS.mkdir(exist_ok=True)
            JOBS.mkdir(exist_ok=True)
            stamp = time.strftime("%Y%m%d-%H%M%S") + f"-{time.time_ns() % 1_000_000:06d}"
            job_dir = JOBS / f"{source.stem}-{stamp}-{os.getpid()}"
            job_dir.mkdir(parents=True, exist_ok=False)
            extension = {"MP4": ".mp4", "MKV": ".mkv", "MOV": ".mov"}.get(
                options.container
            )
            if extension is None:
                raise ValueError(f"Unknown output container: {options.container!r}.")
            output_kind = (
                "DLSS5"
                if not is_preview
                else (
                    "DLSS5_PREVIEW_FRAME"
                    if preview_frames is not None
                    else "DLSS5_PREVIEW"
                )
            )
            output = destination / output_filename(
                source,
                extension,
                options.rename_mode,
                options.custom_suffix,
                f"{source.stem}_{output_kind}_{stamp}",
            )
            output_file = OutputFile(output)
            temp_video = job_dir / "processed-video.mkv"
            native = resolve_native_settings(options)
            _report_progress(0.01, f"Starting feature 18 on {gpu['display_name']}")

            encoder_setup: list[tuple] = []
            encoding_stage_started = time.perf_counter()

            def prepare_encoder() -> None:
                encoder_started = time.perf_counter()
                try:
                    encoder_setup.append(
                        ffmpeg.start_encoder(
                            temp_video,
                            options.codec,
                            options.quality,
                            controller,
                            output_width,
                            output_height,
                            float(metadata["fps"]),
                            None if video_gpu is None else int(video_gpu["cuda_ordinal"]),
                            video_gpu is not None,
                            hdr_mode=effective_hdr,
                            hdr_metadata=hdr_metadata,
                            preserve_timestamps=not metadata["cfr"],
                        )
                    )
                except BaseException as exc:
                    record_pipeline_error(exc)
                finally:
                    timings["encoder_setup_seconds"] = (
                        time.perf_counter() - encoder_started
                    )

            encoder_setup_thread = threading.Thread(
                target=prepare_encoder, name="dlss5-encoder-setup", daemon=True
            )
            encoder_setup_thread.start()
            session_started = time.perf_counter()
            session = DLSSFrameSession(
                input_width=input_width,
                input_height=input_height,
                output_width=output_width,
                output_height=output_height,
                frame_count=None,
                warmup_frames=options.warmup_frames,
                factor=factor,
                mode=mode,
                native_settings=native,
                gpu=gpu,
                runtime_bundle=runtime_bundle,
                controller=controller,
            )
            timings["native_setup_seconds"] = time.perf_counter() - session_started
            encoder_setup_thread.join()
            encoder_setup_thread = None
            timings["setup_seconds"] = max(
                timings["native_setup_seconds"],
                timings.get("encoder_setup_seconds", 0.0),
            )
            if not pipeline_errors.empty():
                raise pipeline_errors.get_nowait()
            if not encoder_setup:
                raise RuntimeError("Video encoder did not finish preparing.")
            render_width = session.render_width
            render_height = session.render_height
            setup_result = session.setup_result
            minimum_width = session.minimum_width
            minimum_height = session.minimum_height
            maximum_width = session.maximum_width
            maximum_height = session.maximum_height
            _report_progress(
                0.03,
                f"DLSS {mode['name']}: {render_width}×{render_height} → "
                f"{output_width}×{output_height}",
            )

            (
                encoder,
                encoder_log_thread,
                encoder_logs,
                selected_encoder,
                encoding_quality,
            ) = encoder_setup[0]
            assert encoder.stdin is not None

            prepared_bytes = render_width * render_height * 8
            rendered_bytes = output_width * output_height * 4
            queue_slots = max(
                1,
                min(3, (384 * 1024 * 1024) // max(1, prepared_bytes + rendered_bytes)),
            )
            prepared_frames: queue.Queue[object] = queue.Queue(maxsize=queue_slots)
            rendered_frames: queue.Queue[object] = queue.Queue(maxsize=queue_slots)
            stop_marker = object()

            def put_pipeline(target: queue.Queue[object], item: object) -> bool:
                while not pipeline_stop.is_set():
                    if controller.cancel.is_set():
                        return False
                    try:
                        target.put(item, timeout=0.1)
                        return True
                    except queue.Full:
                        continue
                return False

            def produce_frames() -> None:
                producer_started = time.perf_counter()
                decoded = 0
                container = None
                try:
                    container = av.open(str(source))
                    stream = container.streams.video[0]
                    stream.thread_type = "AUTO"
                    guides = TemporalGuideGenerator(render_width, render_height)
                    first_time: float | None = None
                    rate = float(stream.average_rate or 30)
                    for index, frame in enumerate(container.decode(stream)):
                        if controller.cancel.is_set():
                            raise Cancelled("Render stopped by user.")
                        if pipeline_stop.is_set():
                            return
                        if preview_frames is not None and index >= preview_frames:
                            producer_stats["completion_reason"] = "preview_limit"
                            break
                        if preview_seconds is not None:
                            timestamp = (
                                float(frame.pts * stream.time_base)
                                if frame.pts is not None and stream.time_base is not None
                                else decoded / rate
                            )
                            if first_time is None:
                                first_time = timestamp
                            if decoded and timestamp - first_time >= preview_seconds:
                                producer_stats["completion_reason"] = "preview_limit"
                                break
                        if frame.is_corrupt:
                            raise RuntimeError(f"The video decoder marked source frame {index} as corrupt.")
                        rgba = rotate_frame(
                            frame.to_ndarray(format="rgba"), metadata["rotation"]
                        )
                        if rgba.shape[1] != render_width or rgba.shape[0] != render_height:
                            rgba = resize_fit(rgba, render_width, render_height)
                        rgba = np.ascontiguousarray(rgba, dtype=np.uint8)
                        guide = guides.process(rgba)
                        pts = int(frame.pts if frame.pts is not None else index)
                        if not put_pipeline(
                            prepared_frames, (index, rgba, guide, pts)
                        ):
                            return
                        decoded += 1
                    else:
                        producer_stats["completion_reason"] = "eof"
                    put_pipeline(prepared_frames, stop_marker)
                except BaseException as exc:
                    record_pipeline_error(exc)
                    put_pipeline(prepared_frames, stop_marker)
                finally:
                    producer_stats["decoded_frames"] = decoded
                    if container is not None:
                        with suppress(Exception):
                            container.close()
                    producer_stats["seconds"] = time.perf_counter() - producer_started

            def write_frames() -> None:
                writer_started = time.perf_counter()
                written = 0
                nut = None
                try:
                    nut = av.open(encoder.stdin, mode="w", format="nut")
                    raw_stream = nut.add_stream("rawvideo", rate=metadata["rate"])
                    raw_stream.width = output_width
                    raw_stream.height = output_height
                    raw_stream.pix_fmt = "rgba"
                    raw_stream.time_base = metadata["time_base"]
                    # The raw encoder otherwise quantizes VFR timestamps to the
                    # average frame interval, potentially producing duplicate DTS.
                    raw_stream.codec_context.time_base = metadata["time_base"]
                    while not pipeline_stop.is_set():
                        if controller.cancel.is_set():
                            raise Cancelled("Render stopped by user.")
                        try:
                            item = rendered_frames.get(timeout=0.1)
                        except queue.Empty:
                            continue
                        if item is stop_marker:
                            break
                        processed, output_pts = item
                        output_frame = av.VideoFrame.from_ndarray(processed, format="rgba")
                        output_frame.pts = output_pts
                        output_frame.time_base = metadata["time_base"]
                        for packet in raw_stream.encode(output_frame):
                            nut.mux(packet)
                        written += 1
                    if not pipeline_stop.is_set():
                        for packet in raw_stream.encode():
                            nut.mux(packet)
                        nut.close()
                        nut = None
                except BaseException as exc:
                    record_pipeline_error(exc)
                finally:
                    writer_stats["written_frames"] = written
                    if nut is not None:
                        with suppress(Exception):
                            nut.close()
                    writer_stats["seconds"] = time.perf_counter() - writer_started

            producer_thread = threading.Thread(
                target=produce_frames, name="dlss5-video-producer", daemon=True
            )
            writer_thread = threading.Thread(
                target=write_frames, name="dlss5-video-writer", daemon=True
            )
            producer_thread.start()
            writer_thread.start()
            delivered = 0
            scene_resets = 0
            preview_pts_origin: int | None = None
            dlss_seconds = 0.0
            last_progress_update = 0.0
            while True:
                if controller.cancel.is_set():
                    raise Cancelled("Render stopped by user.")
                if not pipeline_errors.empty():
                    raise pipeline_errors.get_nowait()
                try:
                    item = prepared_frames.get(timeout=0.1)
                except queue.Empty:
                    continue
                if item is stop_marker:
                    break
                index, rgba, guide, pts = item
                scene_resets += int(guide.reset and index != 0)
                dlss_started = time.perf_counter()
                processed, out_pts = session.process(
                    index=index,
                    rgba=rgba,
                    motion=guide.motion,
                    reset=guide.reset,
                    pts=pts,
                )
                dlss_seconds += time.perf_counter() - dlss_started
                if is_preview:
                    if preview_pts_origin is None:
                        preview_pts_origin = out_pts
                    out_pts -= preview_pts_origin
                if not put_pipeline(rendered_frames, (processed, out_pts)):
                    if not pipeline_errors.empty():
                        raise pipeline_errors.get_nowait()
                    raise Cancelled("Render stopped by user.")
                delivered += 1
                frame_accounting["processed_frames"] = delivered
                now = time.perf_counter()
                if now - last_progress_update >= 0.1:
                    _report_progress(
                        0.04 + 0.84 * min(1.0, delivered / estimated_frames),
                        f"DLSS 5 frame {delivered} (estimated {estimated_frames})",
                    )
                    last_progress_update = now

            if not delivered:
                raise RuntimeError("The input video contains no decodable frames.")
            if not put_pipeline(rendered_frames, stop_marker):
                if not pipeline_errors.empty():
                    raise pipeline_errors.get_nowait()
                raise Cancelled("Render stopped by user.")
            producer_thread.join()
            producer_thread = None
            writer_thread.join()
            writer_thread = None
            if not pipeline_errors.empty():
                raise pipeline_errors.get_nowait()
            frame_accounting.update(
                decoded_frames=producer_stats.get("decoded_frames"),
                written_frames=writer_stats.get("written_frames"),
                completion_reason=producer_stats.get("completion_reason"),
            )
            if (producer_stats.get("decoded_frames") != delivered
                    or writer_stats.get("written_frames") != delivered
                    or producer_stats.get("completion_reason") not in {"eof", "preview_limit"}):
                raise RuntimeError(f"Video pipeline did not deliver every decoded frame: {frame_accounting}")
            timings["producer_seconds"] = float(producer_stats.get("seconds", 0.0))
            timings["decode_and_guide_seconds"] = timings["producer_seconds"]
            timings["dlss_seconds"] = dlss_seconds
            timings["encoder_feed_seconds"] = float(writer_stats.get("seconds", 0.0))
            if encoder.stdin and not encoder.stdin.closed:
                encoder.stdin.close()
            session.close()
            frame_accounting["worker_completed_frames"] = session.completed_frames
            if session.completed_frames != delivered:
                raise RuntimeError("Native worker completion does not match the processed frame count.")
            encoder_code = encoder.wait(timeout=120)
            encoder_log_thread.join(timeout=2)
            controller.unregister(encoder)
            timings["encoding_seconds"] = time.perf_counter() - encoding_stage_started
            if encoder_code:
                raise RuntimeError(
                    "Video encoder failed:\n" + "\n".join(encoder_logs[-40:])
                )

            if producer_stats["completion_reason"] == "eof" and (
                not declared_frames or declared_frames != delivered
            ):
                _report_progress(0.89, "Verifying the source's actual decoded frame count")
                verification_started = time.perf_counter()
                frame_accounting["source_verification"] = "pending"
                try:
                    exact = ffmpeg.probe_video(
                        source, count_mode="exact", strict_decode=True, controller=controller,
                    )
                    frame_accounting["verified_source_frames"] = exact["frames"]
                    if exact["frames"] != delivered:
                        raise RuntimeError(
                            f"Source verification decoded {exact['frames']} frames, but the render "
                            f"decoder delivered {delivered}; refusing an incomplete render."
                        )
                except Exception:
                    frame_accounting["source_verification"] = "failed"
                    raise
                finally:
                    timings["source_verification_seconds"] = time.perf_counter() - verification_started
                frame_accounting["source_verification"] = "passed"
                frame_accounting["metadata_corrected"] = bool(declared_frames != delivered)
            else:
                timings["source_verification_seconds"] = 0.0

            feature_evidence = verify_feature_18(
                session.worker_logs, session.reshade_log_text()
            )
            nr_count = delivered
            nr_upscaling_requested = factor > 1.0
            nr_upscaling_active = bool(feature_evidence["nr_upscaling_active"])
            nr_native_fallback = bool(feature_evidence["nr_native_fallback"])
            carrier_create_result = str(feature_evidence["carrier_create_result"])
            _report_progress(0.91, "Muxing original audio and metadata")
            mux_started = time.perf_counter()
            metadata_diagnostics = {}
            render_note = prepare_render_note(options, session.applied_dlss_model_preset, metadata_diagnostics)
            ffmpeg.final_mux(temp_video, source, output_file.temporary, options.container, controller,
                             render_note=render_note, metadata_diagnostics=metadata_diagnostics)
            timings["final_mux_seconds"] = time.perf_counter() - mux_started
            timings["muxing_seconds"] = timings["final_mux_seconds"]
            verify_started = time.perf_counter()
            _report_progress(0.96, "Verifying saved output")
            verified = ffmpeg.probe_video(output_file.temporary, count_mode="packets", controller=controller)
            if verified["frames"] != delivered or verified["frame_count_source"] != "packets":
                verified = ffmpeg.probe_video(
                    output_file.temporary, count_mode="exact", strict_decode=True, controller=controller,
                )
            frame_accounting["verified_output_frames"] = verified["frames"]
            if verified["frames"] != delivered:
                raise RuntimeError(
                    f"Output verification found {verified['frames']} frames instead of "
                    f"{delivered}."
                )
            if (verified["width"], verified["height"]) != (
                output_width,
                output_height,
            ):
                raise RuntimeError(
                    f"Output verification found {verified['width']}×{verified['height']} "
                    f"instead of {output_width}×{output_height}."
                )
            timings["verification_seconds"] = time.perf_counter() - verify_started

            elapsed = time.perf_counter() - started
            report = {
                "status": "success",
                "metadata_embedding": metadata_diagnostics,
                "warnings": [metadata_diagnostics["warning"]] if metadata_diagnostics.get("warning") else [],
                "input": str(source),
                "output": str(output),
                "options": asdict(options),
                "input_metadata": {
                    key: str(value) if isinstance(value, Fraction) else value
                    for key, value in metadata.items()
                },
                "output_metadata": {
                    key: str(value) if isinstance(value, Fraction) else value
                    for key, value in verified.items()
                },
                "gpu": gpu,
                "ai_gpu": gpu,
                "video_gpu": video_gpu,
                "encoder": selected_encoder,
                "encoding_quality": encoding_quality,
                "frames_processed": delivered,
                "frame_accounting": frame_accounting,
                "render_mode": (
                    "full"
                    if not is_preview
                    else ("preview-frame" if preview_frames is not None else "preview")
                ),
                "dlss_mode": mode["name"],
                "dlss_model_preset": options.dlss_model_preset,
                "requested_dlss_model_preset": options.dlss_model_preset,
                "requested_dlss_model_preset_code": native["dlss_model_preset"],
                "applied_dlss_model_preset": session.applied_dlss_model_preset,
                "applied_dlss_model_preset_name": next(
                    name
                    for name, code in DLSS_MODEL_PRESETS.items()
                    if code == session.applied_dlss_model_preset
                ),
                "requested_upscaling_factor": factor,
                "input_dimensions": {"width": input_width, "height": input_height},
                "negotiated_render_dimensions": {
                    "width": render_width,
                    "height": render_height,
                },
                "negotiated_render_range": {
                    "minimum": {"width": minimum_width, "height": minimum_height},
                    "maximum": {"width": maximum_width, "height": maximum_height},
                },
                "output_dimensions": {"width": output_width, "height": output_height},
                "effective_factor": {
                    "width": output_width / input_width,
                    "height": output_height / input_height,
                },
                "nr_upscaling_requested": nr_upscaling_requested,
                "nr_upscaling_active": nr_upscaling_active,
                "nr_native_fallback": nr_native_fallback,
                "ngx_setup_result": f"0x{setup_result:08X}",
                "scene_resets": scene_resets,
                "pipeline": "renodx-dlssnr-feature18",
                "feature_id": 18,
                "feature_18_confirmed": True,
                "carrier_create_result": carrier_create_result,
                "successful_neural_rendering_frames": nr_count,
                "addon_release": runtime_bundle["addon"]["release"],
                "dlssnr_runtime": runtime_bundle["neural_runtime"],
                "loaded_module_inventory": [
                    "host/nvngx.dll (standalone worker image)",
                    "host/dxgi.dll (ReShade carrier)",
                    "dlssnr/renodx-dlss5.addon64",
                    "dlss/nvngx_dlss.dll",
                    "dlssnr/nvngx_dlssnr.dll",
                    "system D3D12/DXGI/NGX core",
                ],
                "native_settings": native,
                "elapsed_seconds": elapsed,
                "average_fps": delivered / elapsed,
                "timings": timings,
                "worker_log": session.worker_logs,
                "worker_log_dropped_lines": session.worker_log_dropped_lines,
                "encoder_log": encoder_logs,
                "dlssnr_evidence": feature_evidence["evidence"],
            }
            report_path = LOGS / f"{output.name}.report.json"
            report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
            if controller.cancel.is_set():
                raise Cancelled("Render stopped by user.")
            output_file.publish()
            _report_progress(1.0, "Complete — feature 18 confirmed")
            return ConversionResult(
                str(output),
                str(report_path),
                delivered,
                nr_count,
                elapsed,
                gpu["display_name"],
                input_width,
                input_height,
                render_width,
                render_height,
                output_width,
                output_height,
                factor,
                str(mode["name"]),
                options.dlss_model_preset,
                session.applied_dlss_model_preset,
            )
        except Exception as exc:
            was_cancelled = controller.cancel.is_set()
            pipeline_stop.set()
            if controller.cancel.is_set():
                controller.stop()
            else:
                controller.terminate_processes()
            for target in (prepared_frames if "prepared_frames" in locals() else None,
                           rendered_frames if "rendered_frames" in locals() else None):
                if target is not None:
                    with suppress(queue.Full):
                        target.put_nowait(stop_marker)
            for thread in (encoder_setup_thread, producer_thread, writer_thread):
                if thread is not None:
                    thread.join(timeout=2)
            if session is not None and not session.closed:
                with suppress(Exception):
                    session.abort()
            if encoder is not None and encoder.stdin and not encoder.stdin.closed:
                with suppress(OSError):
                    encoder.stdin.close()
            if output_file is not None:
                output_file.cleanup(rollback=True)
            if was_cancelled and not isinstance(exc, Cancelled):
                raise Cancelled("Render stopped by user.") from exc
            if isinstance(exc, Cancelled):
                raise
            worker_logs = session.worker_logs if session is not None else []
            reshade_lines = session.reshade_diagnostics() if session is not None else []
            worker_code = session.worker.poll() if session is not None else None
            report_path = write_failure_report(
                operation="video-render",
                source=str(source),
                error=exc,
                gpu=gpu,
                runtime_bundle=runtime_bundle,
                worker_code=worker_code,
                worker_logs=worker_logs,
                reshade_lines=reshade_lines,
                diagnostics={
                    "frame_accounting": frame_accounting,
                    "producer": producer_stats, "writer": writer_stats, "timings": timings,
                },
            )
            raise RuntimeError(f"{exc}\nDiagnostic report: {report_path}") from exc
        finally:
            if output_file is not None:
                output_file.cleanup()
            pipeline_stop.set()
            # Also reap encoders from a failed parallel setup, before `encoder`
            # has been assigned. Pipes/log readers must not outlive the job.
            encoder_resources = encoder_setup[0] if "encoder_setup" in locals() and encoder_setup else None
            if encoder_resources is not None:
                encoder_process, log_thread = encoder_resources[:2]
                if encoder_process.poll() is None:
                    encoder_process.terminate()
                    try:
                        encoder_process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        encoder_process.kill()
                        encoder_process.wait(timeout=5)
                log_thread.join(timeout=2)
                controller.unregister(encoder_process)
                for stream in (encoder_process.stdin, encoder_process.stdout, encoder_process.stderr):
                    if stream is not None and not stream.closed:
                        with suppress(OSError):
                            stream.close()
            if job_dir and job_dir.exists():
                shutil.rmtree(job_dir, ignore_errors=True)
