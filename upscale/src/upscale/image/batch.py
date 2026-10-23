from __future__ import annotations

import json
import time
import uuid
from dataclasses import asdict, replace
from pathlib import Path

from ...core.batch_progress import BatchProgress
from ...core.disk_paths import prepare_output_dir
from ...core.jobs import Cancelled, JobController, active_job
from ...core.paths import LOGS
from ..video.native import probe_capabilities
from .models import ImageUpscaleOptions, ImageUpscaleBatchResult, ImageUpscaleFailure
from .processor import upscale_image


def upscale_images(input_paths, options=None, progress=None, *, output_dir=None, controller=None,
                   on_item_update=None, generate_previews=True):
    options = replace(options) if options else ImageUpscaleOptions()
    options.validate()
    paths = [Path(p).resolve() for p in input_paths]
    if not paths:
        raise ValueError("Choose at least one image.")
    controller = controller or JobController()
    reporter = BatchProgress(paths, on_item_update, progress)
    successes, failures = [], []
    try:
        destination = prepare_output_dir(output_dir)
        with active_job(controller):
            if controller.cancel.is_set():
                raise Cancelled("Stopped before rendering.")
            caps = probe_capabilities(options.ai_gpu_uuid, controller=controller)
            for i, path in enumerate(paths):
                if controller.cancel.is_set():
                    break
                reporter.advance(i)
                try:
                    result = upscale_image(path, options, lambda v, m, i=i: reporter.advance(i, v, m),
                                           output_dir=destination, controller=controller, _owns_slot=True,
                                           _capabilities=caps, generate_previews=generate_previews)
                except Exception as exc:
                    cancelled = controller.cancel.is_set() or isinstance(exc, Cancelled)
                    failures.append(ImageUpscaleFailure(i, str(path), str(exc), cancelled))
                    reporter.fail(i, exc, cancelled=cancelled)
                    if cancelled:
                        controller.stop()
                        break
                else:
                    successes.append(result)
                    reporter.complete(i, result.output_path, "; ".join([*result.warnings, f"Report: {result.report_path}"]))
        if controller.cancel.is_set():
            for item in reporter.items:
                if item.state == "Queued":
                    failures.append(ImageUpscaleFailure(item.index, item.input_path, "Cancelled before rendering.", True))
            reporter.skip_from(0)
        LOGS.mkdir(exist_ok=True)
        manifest = LOGS / f"upscale-image-batch-{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}.json"
        result = ImageUpscaleBatchResult(successes, failures, controller.cancel.is_set(), str(manifest))
        manifest.write_text(json.dumps({**asdict(result), "options": asdict(options),
                                       "progress": reporter.diagnostics(final=True)}, indent=2), encoding="utf-8")
        reporter.finish(cancelled=result.cancelled, manifest_path=str(manifest))
        return result
    except BaseException as exc:
        reporter.finish(cancelled=controller.cancel.is_set(), error=str(exc))
        raise
