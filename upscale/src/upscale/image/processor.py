from __future__ import annotations

import json
import time
import uuid
from contextlib import nullcontext, suppress
from dataclasses import asdict, replace
from pathlib import Path

import numpy as np
from PIL import Image

from ..video.native import RTXVideoSession, probe_capabilities
from ...core.disk_paths import OutputFile, prepare_output_dir
from ...core.jobs import Cancelled, active_job
from ...core.naming import output_filename
from ...core.paths import LOGS
from ...neural_rendering.image.decoder import decode_image
from ...neural_rendering.image.encoder import _encode_image
from ...neural_rendering.image.models import ImageConversionOptions
from .models import IMAGE_EXTENSIONS, ImageUpscaleOptions, ImageUpscaleResult, output_size


def srgb_to_worker(rgba):
    """The video pipeline uses BT.709 primaries with BT.470M (gamma 2.2) RGB."""
    rgb = rgba[..., :3].astype(np.float32) / 255
    linear = np.where(rgb <= .04045, rgb / 12.92, ((rgb + .055) / 1.055) ** 2.4)
    packed = np.empty_like(rgba)
    packed[..., :3] = np.rint(np.clip(linear, 0, 1) ** (1 / 2.2) * 255).astype(np.uint8)
    packed[..., 3] = 255
    return np.ascontiguousarray(packed)


def worker_to_srgb(data, width, height, alpha):
    rgba = np.frombuffer(data, dtype=np.uint8).reshape(height, width, 4).copy()
    linear = (rgba[..., :3].astype(np.float32) / 255) ** 2.2
    rgb = np.where(linear <= .0031308, linear * 12.92, 1.055 * linear ** (1 / 2.4) - .055)
    rgba[..., :3] = np.rint(np.clip(rgb, 0, 1) * 255).astype(np.uint8)
    with Image.fromarray(alpha) as mask:
        with mask.resize((width, height), Image.Resampling.LANCZOS) as scaled:
            rgba[..., 3] = np.asarray(scaled)
    return rgba


def upscale_image(input_path, options=None, progress=None, *, output_dir=None, controller=None,
                  generate_previews=True, _owns_slot=False, _capabilities=None):
    options = replace(options) if options else ImageUpscaleOptions()
    options.validate()
    source = Path(input_path).resolve()
    if not source.is_file():
        raise FileNotFoundError(source)
    with nullcontext(controller) if _owns_slot else active_job(controller) as controller:
        return _process(source, options, progress, output_dir, controller, generate_previews, _capabilities)


def _process(source, options, progress, output_dir, controller, generate_previews, capabilities):
    started = time.monotonic()
    stamp = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:8]
    LOGS.mkdir(exist_ok=True)
    report_path = LOGS / f"upscale-image-{stamp}.json"
    report = {"input": str(source), "options": asdict(options), "pipeline": "RTX VSR still image",
              "color": "sRGB → gamma 2.2 RGB → RTX VSR → sRGB"}
    destination_file = None
    session = None

    def update(value, message):
        if controller.cancel.is_set():
            raise Cancelled("Image upscale stopped by user.")
        if progress:
            progress(value, message)

    try:
        update(.01, "Decoding image")
        decoded = decode_image(source)
        height, width = decoded.rgba.shape[:2]
        ow, oh = output_size(width, height, options)
        caps = capabilities or probe_capabilities(options.ai_gpu_uuid, controller=controller)
        output = prepare_output_dir(output_dir) / output_filename(
            source, IMAGE_EXTENSIONS[options.output_format], options.rename_mode, options.custom_suffix,
            f"{source.stem}_RTXIMAGE_{stamp}")
        destination_file = OutputFile(output)
        report.update(input_dimensions=[width, height], output_dimensions=[ow, oh],
                      capabilities=asdict(caps), decoder=decoded.decoder, warnings=decoded.warnings)
        update(.15, f"RTX VSR: {width}×{height} → {ow}×{oh}")
        with RTXVideoSession(width, height, ow, oh, options.native_options(), 1, caps, controller) as session:
            processed = worker_to_srgb(session.process_frame(srgb_to_worker(decoded.rgba)), ow, oh, decoded.alpha)
            if session.completed_frames != 1:
                raise RuntimeError("RTX VSR did not process exactly one image.")
        update(.80, "Saving image")
        export = ImageConversionOptions(output_format=options.output_format, quality=int(options.quality),
                                        preserve_metadata=options.preserve_metadata)
        warnings = list(decoded.warnings)
        warnings.extend(_encode_image(destination_file.temporary, processed, export, decoded.metadata,
                                      generate_preview=generate_previews, preview_path=output, controller=controller))
        with Image.open(destination_file.temporary) as saved:
            saved.load()
            if saved.size != (ow, oh):
                raise RuntimeError("Saved image dimensions do not match the VSR output.")
        update(.98, "Verifying output")
        report.update(status="success", output=str(output), warnings=warnings, sdk_evaluations=1,
                      last_ngx_results=session.last_results, worker_log=list(session.logs),
                      elapsed_seconds=time.monotonic() - started)
        report_path.write_text(json.dumps(report, indent=2, default=str), encoding="utf-8")
        destination_file.publish()
        return ImageUpscaleResult(str(source), str(output), str(report_path), ow, oh,
                                  time.monotonic() - started, warnings)
    except BaseException as exc:
        cancelled = controller.cancel.is_set() or isinstance(exc, Cancelled)
        report.update(status="cancelled" if cancelled else "failed", error=str(exc),
                      worker_log=list(session.logs) if session else [], elapsed_seconds=time.monotonic() - started)
        with suppress(OSError):
            report_path.write_text(json.dumps(report, indent=2, default=str), encoding="utf-8")
        if cancelled and not isinstance(exc, Cancelled):
            raise Cancelled("Image upscale stopped by user.") from exc
        raise
    finally:
        if destination_file:
            destination_file.cleanup()
