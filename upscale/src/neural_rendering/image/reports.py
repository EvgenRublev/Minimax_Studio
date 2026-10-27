from __future__ import annotations

import json
import zipfile
from dataclasses import asdict, dataclass
from pathlib import Path

from PIL import TiffImagePlugin

from ...core.paths import LOGS, OUTPUTS
from ...core.disk_paths import OutputFile
from ...core.jobs import Cancelled
from ...core.runtime import DLSSFrameSession, DLSS_MODEL_PRESETS
from .decoder import _DecodedImage
from .models import ImageConversionFailure, ImageConversionOptions, ImageConversionResult

@dataclass(slots=True)
class _ImageReportData:
    decoder: str
    metadata: dict[str, object]
    warnings: list[str]


def _report_data(decoded: _DecodedImage) -> _ImageReportData:
    """Keep diagnostics without retaining the decoded pixel and alpha arrays."""
    return _ImageReportData(decoded.decoder, decoded.metadata, decoded.warnings)


def _json_safe_metadata(value: object) -> object:
    """Create a report-only JSON-safe copy without changing save metadata."""
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, TiffImagePlugin.IFDRational):
        return float(value)
    if isinstance(value, dict):
        return {str(key): _json_safe_metadata(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_json_safe_metadata(item) for item in value]
    if isinstance(value, bytes):
        return {"type": "bytes", "length": len(value)}
    return str(value)

def _write_report(
    result: ImageConversionResult,
    options: ImageConversionOptions,
    decoded: _ImageReportData,
    gpu: dict,
    session: DLSSFrameSession,
    evidence: dict[str, object],
    *, metadata_diagnostics: dict | None = None,
) -> str:
    report = {
        "status": "success",
        "input": result.input_path,
        "output": result.output_path,
        "options": asdict(options),
        "gpu": gpu,
        "decoder": decoded.decoder,
        "source_metadata": {
            key: _json_safe_metadata(value)
            for key, value in decoded.metadata.items()
            if key not in {"icc_profile", "exif", "xmp"}
        },
        "warnings": result.warnings,
        "metadata_embedding": metadata_diagnostics or {"status": "not_requested"},
        "input_dimensions": {"width": result.input_width, "height": result.input_height},
        "negotiated_render_dimensions": {"width": result.render_width, "height": result.render_height},
        "negotiated_render_range": {
            "minimum": {"width": session.minimum_width, "height": session.minimum_height},
            "maximum": {"width": session.maximum_width, "height": session.maximum_height},
        },
        "output_dimensions": {"width": result.output_width, "height": result.output_height},
        "dlss_mode": result.dlss_mode,
        "requested_upscaling_factor": result.upscaling_factor,
        "dlss_model_preset": result.dlss_model_preset,
        "requested_dlss_model_preset": result.dlss_model_preset,
        "requested_dlss_model_preset_code": DLSS_MODEL_PRESETS[
            result.dlss_model_preset
        ],
        "applied_dlss_model_preset": result.applied_dlss_model_preset,
        "applied_dlss_model_preset_name": next(
            name
            for name, code in DLSS_MODEL_PRESETS.items()
            if code == result.applied_dlss_model_preset
        ),
        "pipeline": "renodx-dlssnr-feature18-image",
        "feature_id": 18,
        "feature_18_confirmed": True,
        "ngx_setup_result": f"0x{session.setup_result:08X}",
        "carrier_create_result": evidence["carrier_create_result"],
        "native_settings": session.native_settings,
        "addon_release": session.runtime_bundle["addon"]["release"],
        "dlssnr_runtime": session.runtime_bundle["neural_runtime"],
        "worker_log": session.worker_logs,
        "worker_log_dropped_lines": session.worker_log_dropped_lines,
        "dlssnr_evidence": evidence["evidence"],
        "elapsed_seconds": result.elapsed_seconds,
    }
    report_path = LOGS / f"{Path(result.output_path).name}.report.json"
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    return str(report_path)


def _build_manifest_and_zip(
    stamp: str,
    options: ImageConversionOptions,
    successes: list[ImageConversionResult],
    failures: list[ImageConversionFailure],
    cancelled: bool,
    *, create_zip: bool = True, output_dir: Path | None = None, batch_diagnostics: dict | None = None,
    controller=None,
) -> tuple[str, str | None]:
    manifest = {
        "status": "cancelled" if cancelled else ("partial" if failures else "success"),
        "options": asdict(options),
        "successes": [asdict(item) for item in successes],
        "failures": [asdict(item) for item in failures],
        "batch": batch_diagnostics or {},
        "output_directory": str(output_dir or OUTPUTS),
    }
    manifest_path = LOGS / f"DLSS5_IMAGE_BATCH_{stamp}.manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    if not successes or not create_zip:
        return str(manifest_path), None
    zip_path = (output_dir or OUTPUTS) / f"DLSS5_IMAGE_BATCH_{stamp}.zip"
    output_file = OutputFile(zip_path)
    try:
        with zipfile.ZipFile(output_file.temporary, "w", compression=zipfile.ZIP_STORED) as archive:
            for item in successes:
                info = zipfile.ZipInfo.from_file(item.output_path, arcname=Path(item.output_path).name)
                with open(item.output_path, "rb") as source, archive.open(info, "w", force_zip64=True) as target:
                    while True:
                        if controller is not None and controller.cancel.is_set():
                            raise Cancelled("ZIP creation cancelled.")
                        chunk = source.read(1024 * 1024)
                        if not chunk:
                            break
                        target.write(chunk)
        if controller is not None and controller.cancel.is_set():
            raise Cancelled("ZIP creation cancelled.")
        output_file.publish()
    except Cancelled:
        manifest["status"] = "cancelled"
        if batch_diagnostics:
            manifest["batch"]["statistics"]["state"] = "Cancelled"
        manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        return str(manifest_path), None
    finally:
        output_file.cleanup()
    return str(manifest_path), str(zip_path)
