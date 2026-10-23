from __future__ import annotations

import json
from dataclasses import asdict

from ...core.paths import LOGS
from .models import ConversionOptions, VideoConversionFailure, VideoConversionSuccess

def _write_video_batch_manifest(
    stamp: str,
    options: ConversionOptions,
    successes: list[VideoConversionSuccess],
    failures: list[VideoConversionFailure],
    cancelled: bool,
    *, batch_diagnostics: dict | None = None, output_dir: str | None = None,
) -> str:
    LOGS.mkdir(exist_ok=True)
    manifest = {
        "status": "cancelled" if cancelled else ("partial" if failures else "success"),
        "options": asdict(options),
        "successes": [asdict(item) for item in successes],
        "failures": [asdict(item) for item in failures],
        "batch": batch_diagnostics or {},
        "output_directory": output_dir,
    }
    manifest_path = LOGS / f"DLSS5_VIDEO_BATCH_{stamp}.manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return str(manifest_path)
