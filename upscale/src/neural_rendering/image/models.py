from __future__ import annotations

from dataclasses import dataclass, field

IMAGE_FORMATS = ("PNG", "JPEG", "WebP", "AVIF", "TIFF")
IMAGE_EXTENSIONS = {"PNG": ".png", "JPEG": ".jpg", "WebP": ".webp", "AVIF": ".avif", "TIFF": ".tiff"}
RAW_EXTENSIONS = {
    ".3fr", ".arw", ".bay", ".cap", ".cr2", ".cr3", ".dcr", ".dcs", ".dng",
    ".drf", ".eip", ".erf", ".fff", ".gpr", ".iiq", ".k25", ".kdc", ".mdc",
    ".mef", ".mos", ".mrw", ".nef", ".nrw", ".obm", ".orf", ".pef", ".ptx",
    ".pxn", ".r3d", ".raf", ".raw", ".rw2", ".rwl", ".rwz", ".sr2", ".srf",
    ".srw", ".x3f",
}

@dataclass(slots=True)
class ImageConversionOptions:
    ai_gpu_uuid: str = "auto"
    nr_style: str = "Default"
    nr_intensity: float = 1.0
    local_tone_strength: float = 1.0
    local_structure_strength: float = 1.0
    skin_structure_strength: float = -1.0
    upscaling_factor: float = 1.0
    output_format: str = "PNG"
    quality: int = 95
    preserve_metadata: bool = True
    warmup_frames: int = 0
    nr_preset: str = "Default"
    automatic_mask: bool = False
    rename_mode: str = "Auto"
    custom_suffix: str = "_DLSS5"
    dlss_model_preset: str = "Default"

    def neural_options(self) -> "ImageConversionOptions":
        # Image already carries every shared neural-rendering field needed by core.runtime.
        return self


@dataclass(slots=True)
class ImageConversionResult:
    input_path: str
    output_path: str
    report_path: str
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
    output_format: str
    dlss_model_preset: str = "Default"
    applied_dlss_model_preset: int = 0
    warnings: list[str] = field(default_factory=list)


@dataclass(slots=True)
class ImageConversionFailure:
    input_path: str
    error: str


@dataclass(slots=True)
class ImageBatchResult:
    successes: list[ImageConversionResult]
    failures: list[ImageConversionFailure]
    cancelled: bool
    manifest_path: str
    zip_path: str | None
