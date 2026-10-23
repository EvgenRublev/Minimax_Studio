from __future__ import annotations

from dataclasses import dataclass

from ...core.runtime import DLSS_MODEL_PRESETS, NR_PRESETS, NR_STYLES, UPSCALING_MODES


@dataclass(slots=True)
class ConversionOptions:
    ai_gpu_uuid: str = "auto"
    video_gpu_uuid: str = "auto"
    nr_style: str = "Default"
    nr_intensity: float = 1.0
    local_tone_strength: float = 1.0
    local_structure_strength: float = 1.0
    skin_structure_strength: float = -1.0
    upscaling_factor: float = 1.0
    codec: str = "H.264"
    container: str = "MP4"
    quality: str = "Auto (Default)"
    preserve_hdr: bool = False
    warmup_frames: int = 0
    preview_seconds: float | None = None
    preview_frames: int | None = None
    nr_preset: str = "Default"
    automatic_mask: bool = False
    rename_mode: str = "Auto"
    custom_suffix: str = "_DLSS5"
    dlss_model_preset: str = "Default"
    # True = truncated preview uses the forced H.264 SDR path (current behavior).
    # False = truncated preview uses the user's codec/container (HDR preserved).
    preview_compat: bool = True

@dataclass(slots=True)
class ConversionResult:
    output_path: str
    report_path: str
    frames: int
    nr_count_evidence: int
    elapsed_seconds: float
    gpu: str
    input_width: int
    input_height: int
    render_width: int
    render_height: int
    output_width: int
    output_height: int
    upscaling_factor: float
    dlss_mode: str
    dlss_model_preset: str = "Default"
    applied_dlss_model_preset: int = 0


@dataclass(slots=True)
class VideoConversionSuccess:
    index: int
    input_path: str
    result: ConversionResult


@dataclass(slots=True)
class VideoConversionFailure:
    index: int
    input_path: str
    error: str
    cancelled: bool = False


@dataclass(slots=True)
class VideoBatchResult:
    successes: list[VideoConversionSuccess]
    failures: list[VideoConversionFailure]
    cancelled: bool
    manifest_path: str
