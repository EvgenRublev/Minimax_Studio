from __future__ import annotations

import json
import os
import time
from dataclasses import asdict, replace
from pathlib import Path
from typing import Callable, Iterable

from ..core.batch_progress import BatchItemUpdate, BatchProgress
from ..core.disk_paths import prepare_output_dir
from ..core.jobs import Cancelled, JobController, active_job
from ..core.paths import LOGS
from .models import FrameInterpolationBatchResult, FrameInterpolationFailure, FrameInterpolationOptions, FrameInterpolationSuccess
from . import processor


def interpolate_videos(
    input_paths: Iterable[str | os.PathLike[str]],
    options: FrameInterpolationOptions | None = None,
    progress: Callable[[float, str], None] | None = None,
    *, output_dir: str | os.PathLike[str] | None = None,
    controller: JobController | None = None,
    on_item_update: Callable[[BatchItemUpdate], None] | None = None,
) -> FrameInterpolationBatchResult:
    options = replace(options) if options else FrameInterpolationOptions()
    paths = [Path(path).resolve() for path in input_paths]
    if not paths:
        raise ValueError("Choose at least one video.")
    controller = controller or JobController()
    reporter = BatchProgress(paths, on_item_update, progress)
    stamp = time.strftime("%Y%m%d-%H%M%S") + f"-{time.time_ns() % 1_000_000:06d}"
    successes, failures = [], []
    try:
        destination = prepare_output_dir(output_dir, default=processor.OUTPUTS)
        with active_job(controller):
            processor._BATCH_CONTEXT.controller = controller
            try:
                for index, path in enumerate(paths):
                    if controller.cancel.is_set():
                        break
                    reporter.advance(index)
                    try:
                        result = processor.interpolate_video(
                            path, options, lambda value, message, i=index: reporter.advance(i, value, message),
                            output_dir=destination,
                        )
                    except Exception as exc:
                        cancelled = isinstance(exc, Cancelled) or controller.cancel.is_set()
                        failures.append(FrameInterpolationFailure(index, str(path), str(exc), cancelled))
                        reporter.fail(index, exc, cancelled=cancelled)
                        if cancelled:
                            controller.stop()
                            break
                    else:
                        successes.append(FrameInterpolationSuccess(index, str(path), result))
                        reporter.complete(index, result.output_path, f"{result.output_frames} frames; report: {result.report_path}")
            finally:
                del processor._BATCH_CONTEXT.controller
        cancelled = controller.cancel.is_set()
        if cancelled:
            for item in reporter.items:
                if item.state == "Queued":
                    failures.append(FrameInterpolationFailure(item.index, item.input_path, "Cancelled before rendering.", True))
            reporter.skip_from(0)
        manifest = {
            "status": "cancelled" if cancelled else ("partial" if failures else "success"),
            "options": processor._json_safe(asdict(options)),
            "successes": [asdict(item) for item in successes],
            "failures": [asdict(item) for item in failures],
            "output_directory": str(destination), "batch": reporter.diagnostics(final=True),
        }
        LOGS.mkdir(exist_ok=True)
        manifest_path = LOGS / f"DLSSFG_BATCH_{stamp}.manifest.json"
        manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        reporter.finish(cancelled=cancelled, manifest_path=str(manifest_path))
        return FrameInterpolationBatchResult(successes, failures, cancelled, str(manifest_path.resolve()))
    except BaseException as exc:
        reporter.finish(cancelled=controller.cancel.is_set(), error=str(exc))
        raise
