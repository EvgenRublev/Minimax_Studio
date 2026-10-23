from __future__ import annotations

import json
import math
import tempfile
import time
import uuid
from contextlib import ExitStack, nullcontext, suppress
from dataclasses import asdict, replace
from fractions import Fraction
from pathlib import Path

import av

from ...core import ffmpeg
from ...core.disk_paths import OutputFile, prepare_output_dir
from ...core.gpu_detection import detect_gpus
from ...core.jobs import Cancelled, active_job
from ...core.naming import output_filename
from ...core.paths import JOBS, LOGS
from .media import PipeReader, PipeWriter, close_process, finish_process, inspect_video, output_filter, packed_bytes, result_frame, start_decoder
from .models import UpscaleOptions, UpscaleResult, output_size
from .native import RTXVideoSession, probe_capabilities


def upscale_video(input_path, options: UpscaleOptions | None = None, progress=None, *, output_dir=None,
                  controller=None, _owns_slot=False, _capabilities=None) -> UpscaleResult:
    options = replace(options) if options else UpscaleOptions()
    options.validate()
    source = Path(input_path).resolve()
    if not source.is_file():
        raise FileNotFoundError(source)
    context = nullcontext(controller) if _owns_slot else active_job(controller)
    with context as controller:
        return _process(source, options, progress, output_dir, controller, _capabilities)


def _process(source, options, progress, output_dir, controller, capabilities):
    started = time.monotonic()
    stamp = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:8]
    LOGS.mkdir(exist_ok=True); JOBS.mkdir(exist_ok=True)
    report_path = LOGS / f"upscale-{stamp}.json"
    report = {"input": str(source), "options": asdict(options), "status": "running", "pipeline": "RTX Video SDK / D3D11"}
    processes = []
    destination_file = None
    session = None
    delivered = 0
    def check_cancel():
        if controller.cancel.is_set():
            raise Cancelled("Upscale stopped by user.")
    def update(value, message):
        check_cancel()
        if progress:
            progress(value, message)
    try:
        update(.01, "Checking SDR source and RTX Video capabilities")
        meta = inspect_video(source, controller, reject_hdr=True)
        width, height = meta["width"], meta["height"]
        ow, oh, rounding = output_size(width, height, options)
        caps = capabilities or probe_capabilities(options.ai_gpu_uuid, controller=controller)
        video_gpu = ffmpeg.resolve_video_gpu(detect_gpus(), options.video_gpu_uuid, options.codec, ow, oh)
        report.update(capabilities=asdict(caps), video_gpu=video_gpu, input_metadata=meta,
                      output_dimensions=[ow, oh], rounding=rounding)
        destination = prepare_output_dir(output_dir)
        extension = {"MP4": ".mp4", "MKV": ".mkv", "MOV": ".mov"}[options.container]
        preview = options.preview_frames is not None or options.preview_seconds is not None
        kind = "RTXVIDEO_PREVIEW" if preview else "RTXVIDEO"
        output = destination / output_filename(source, extension, "Auto" if preview else options.rename_mode,
                                               options.custom_suffix, f"{source.stem}_{kind}_{stamp}")
        destination_file = OutputFile(output)
        input_format = 2 if meta["depth"] > 8 else 1
        ten_bit = options.hdr_enabled or (input_format == 2 and ffmpeg.hdr_mode_supported(options.codec))
        colors = {"color_space": "bt2020nc" if options.hdr_enabled else "bt709",
                  "color_transfer": "smpte2084" if options.hdr_enabled else "bt709",
                  "color_primaries": "bt2020" if options.hdr_enabled else "bt709", "hdr": options.hdr_enabled}
        with tempfile.TemporaryDirectory(prefix="rtx-video-", dir=JOBS) as job_dir, ExitStack() as stack:
            session = stack.enter_context(RTXVideoSession(width, height, ow, oh, options, input_format, caps, controller))
            # Matroska's millisecond time base would quantize fractional/VFR PTS.
            temp_video = Path(job_dir) / ("encoded.mov" if options.codec == "ProRes Proxy" else "encoded.mp4")
            encoder, enc_thread, enc_logs, selected, quality = ffmpeg.start_encoder(
                temp_video, options.codec, options.quality, controller, ow, oh, float(meta["rate"]),
                None if video_gpu is None else int(video_gpu["cuda_ordinal"]), video_gpu is not None,
                hdr_mode=ten_bit, hdr_metadata=colors, preserve_timestamps=True,
                video_filter=output_filter(session.output_format, options.hdr_enabled), keep_start_time=True,
                bounded_logs=True,
            )
            processes.append(encoder)
            stack.callback(close_process, encoder, controller, enc_thread)
            decoder, dec_thread, dec_logs, assumptions = start_decoder(source, meta, controller)
            processes.append(decoder)
            stack.callback(close_process, decoder, controller, dec_thread)
            report.update(encoder=selected, encoding_quality=quality, warnings=assumptions,
                          input_format=input_format, output_format=session.output_format, color=colors,
                          applied_settings={"vsr_enabled": options.vsr_enabled,
                                            "vsr_quality": options.vsr_quality if options.vsr_enabled else None,
                                            "hdr_enabled": options.hdr_enabled,
                                            "hdr": {name: getattr(options, name) for name in
                                                    ("hdr_contrast", "hdr_saturation", "hdr_middle_gray",
                                                     "hdr_peak_luminance", "hdr_precision")} if options.hdr_enabled else None,
                                            "input_dimensions": [width, height], "output_dimensions": [ow, oh],
                                            "input_color": "Full-range BT.709 RGB, gamma 2.2", "full_frame": True})
            decoded = stack.enter_context(av.open(PipeReader(decoder.stdout), mode="r", format="nut"))
            source_stream = decoded.streams.video[0]
            tb = source_stream.time_base
            nut = stack.enter_context(av.open(PipeWriter(encoder.stdin), mode="w", format="nut"))
            raw = nut.add_stream("rawvideo", rate=meta["rate"])
            raw.width, raw.height = ow, oh
            raw.pix_fmt = {1: "rgba", 2: "gbrp10le", 3: "gbrpf32le"}[session.output_format]
            raw.time_base = tb; raw.codec_context.time_base = tb
            first_time, last_pts, stopped_early = None, None, False
            eval_seconds = 0.0
            timestamps_fallback = 0
            estimated = max(1, meta["frames"] or math.ceil(meta["duration"] * float(meta["rate"])))
            limit = options.preview_frames
            if options.preview_seconds is not None:
                estimated = min(estimated, max(1, math.ceil(options.preview_seconds * float(meta["rate"]))))
            if limit:
                estimated = min(estimated, limit)
            last_update = 0
            for frame in decoded.decode(source_stream):
                check_cancel()
                if frame.pts is None:
                    pts = round(Fraction(delivered, 1) / meta["rate"] / tb)
                    timestamps_fallback += 1
                else:
                    pts = round(frame.pts * frame.time_base / tb)
                timestamp = pts * tb
                if first_time is None:
                    first_time = timestamp
                if (limit and delivered >= limit) or (options.preview_seconds is not None and delivered and timestamp - first_time >= options.preview_seconds):
                    stopped_early = True
                    break
                if last_pts is not None and pts <= last_pts:
                    raise ValueError("Source timestamps are not strictly increasing; refusing to drop or duplicate frames.")
                if (frame.width, frame.height) != (width, height):
                    raise ValueError("Source dimensions changed during decoding.")
                t0 = time.monotonic()
                pixels = session.process_frame(packed_bytes(frame))
                eval_seconds += time.monotonic() - t0
                result = result_frame(pixels, ow, oh, session.output_format)
                result.pts, result.time_base = pts, tb
                for packet in raw.encode(result):
                    nut.mux(packet)
                delivered += 1
                last_pts = pts
                now = time.monotonic()
                if now - last_update > .2:
                    update(min(.87, .05 + .82 * delivered / estimated),
                           f"RTX Video: {width}×{height} → {ow}×{oh}; {delivered} frames; {delivered / max(.01, now-started):.1f} fps")
                    last_update = now
            if not delivered:
                raise ValueError("The input contains no decodable video frames.")
            for packet in raw.encode():
                nut.mux(packet)
            nut.close(); encoder.stdin.close()
            decoded.close()
            finish_process(decoder, dec_thread, dec_logs, controller, expected_stop=stopped_early)
            session.close()
            finish_process(encoder, enc_thread, enc_logs, controller)
            if not preview and (not meta["frames"] or delivered != meta["frames"]):
                exact = ffmpeg.probe_video(source, count_mode="exact", strict_decode=True, controller=controller)
                if exact["frames"] != delivered:
                    raise RuntimeError(f"Source has {exact['frames']} frames but only {delivered} were processed.")
            if session.completed_frames != delivered:
                raise RuntimeError("RTX Video worker processed an unexpected number of frames.")
            update(.90, "Muxing original audio and subtitles")
            ffmpeg.final_mux(temp_video, source, destination_file.temporary, options.container, controller,
                             preserve_supported_subtitles=True, source_time_origin=meta["origin"])
            update(.96, "Verifying output frames, resolution, and HDR signaling")
            verified = ffmpeg.probe_video(destination_file.temporary, count_mode="packets", controller=controller)
            if verified["frames"] != delivered:
                verified = ffmpeg.probe_video(destination_file.temporary, count_mode="exact", strict_decode=True, controller=controller)
            if verified["frames"] != delivered or (verified["width"], verified["height"]) != (ow, oh):
                raise RuntimeError("Saved output does not match processed frame count or dimensions.")
            saved = inspect_video(destination_file.temporary, controller)
            if options.hdr_enabled and (saved["depth"] < 10 or not saved["hdr"] or
                                       saved["stream"].get("color_primaries") != "bt2020" or saved["stream"].get("color_space") != "bt2020nc"):
                raise RuntimeError("Saved file failed HDR color and bit-depth verification.")
            if not options.hdr_enabled and saved["hdr"]:
                raise RuntimeError("SDR output unexpectedly contains HDR signaling.")
            check_cancel()
            report.update(status="success", output=str(output), frames=delivered, verified_output=saved,
                          sdk_evaluations=delivered, last_ngx_results=session.last_results,
                          timestamp_fallback_frames=timestamps_fallback,
                          timings={"total_seconds": time.monotonic()-started, "ngx_evaluation_seconds": eval_seconds},
                          worker_log=list(session.logs), decoder_log=dec_logs.snapshot(), encoder_log=enc_logs.snapshot())
            report_path.write_text(json.dumps(report, indent=2, default=str), encoding="utf-8")
            destination_file.publish()
        return UpscaleResult(str(output), str(report_path), delivered, ow, oh, options.hdr_enabled, time.monotonic()-started)
    except BaseException as exc:
        report.update(status="cancelled" if controller.cancel.is_set() or isinstance(exc, Cancelled) else "failed",
                      error=str(exc), frames=delivered, elapsed_seconds=time.monotonic()-started,
                      worker_log=list(session.logs) if session else [])
        with suppress(OSError):
            report_path.write_text(json.dumps(report, indent=2, default=str), encoding="utf-8")
        if controller.cancel.is_set() and not isinstance(exc, Cancelled):
            raise Cancelled("Upscale stopped by user.") from exc
        raise
    finally:
        for process in processes:
            close_process(process, controller)
        if destination_file:
            destination_file.cleanup()
