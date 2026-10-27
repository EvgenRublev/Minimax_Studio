from __future__ import annotations

import io
import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import numpy as np
import pillow_heif
import rawpy
import resvg_py
from PIL import Image, ImageCms, ImageOps

from .models import RAW_EXTENSIONS

pillow_heif.register_heif_opener()
Image.MAX_IMAGE_PIXELS = 100_000_000

@dataclass(slots=True)
class _DecodedImage:
    rgba: np.ndarray
    alpha: np.ndarray
    decoder: str
    metadata: dict[str, object]
    warnings: list[str]

def _orientation_swaps_dimensions(image: Image.Image) -> bool:
    try:
        return int(image.getexif().get(274, 1)) in {5, 6, 7, 8}
    except (TypeError, ValueError):
        return False


def _open_pillow_source(path: Path) -> tuple[Image.Image, str]:
    suffix = path.suffix.lower()
    if suffix in RAW_EXTENSIONS:
        with rawpy.imread(str(path)) as raw:
            array = raw.postprocess(
                use_camera_wb=True,
                output_color=rawpy.ColorSpace.sRGB,
                output_bps=8,
            )
        return Image.fromarray(array, mode="RGB"), "LibRaw"
    if suffix == ".svg":
        png = resvg_py.svg_to_bytes(svg_path=str(path), resources_dir=str(path.parent))
        return Image.open(io.BytesIO(png)), "resvg"
    return Image.open(path), "Pillow"


def probe_image(path: str | os.PathLike[str]) -> tuple[int, int]:
    source = Path(path).resolve()
    if not source.is_file():
        raise FileNotFoundError(source)
    image, _decoder = _open_pillow_source(source)
    try:
        width, height = image.size
        if _orientation_swaps_dimensions(image):
            width, height = height, width
    finally:
        image.close()
    if width < 64 or height < 64:
        raise ValueError(
            f"{source.name} is {width}×{height}; DLSS requires both input dimensions to be at least 64 pixels."
        )
    return width, height


@lru_cache(maxsize=1)
def _srgb_profile_bytes() -> bytes:
    return ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()


def initialize_image_runtime() -> None:
    """Initialize reusable image color-management state during app preparation."""
    _srgb_profile_bytes()

def decode_image(path: str | os.PathLike[str]) -> _DecodedImage:
    source = Path(path).resolve()
    image, decoder = _open_pillow_source(source)
    opened_image = image
    warnings: list[str] = []
    try:
        frame_count = int(getattr(image, "n_frames", 1) or 1)
        if frame_count > 1:
            warnings.append(f"Used the first frame/page of {frame_count}.")
            image.seek(0)
        original_mode = image.mode
        info = dict(image.info)
        image = ImageOps.exif_transpose(image)
        image.load()
        if original_mode not in {"1", "L", "LA", "P", "RGB", "RGBA", "CMYK"}:
            warnings.append(f"Converted {original_mode} source data to 8-bit SDR sRGB.")

        has_alpha = image.mode in {"LA", "RGBA"} or (
            image.mode == "P" and "transparency" in info
        )
        alpha_image = (
            image.convert("RGBA").getchannel("A")
            if has_alpha
            else Image.new("L", image.size, 255)
        )
        rgb_image = image.convert("RGB")
        icc_profile = info.get("icc_profile")
        if isinstance(icc_profile, bytes) and icc_profile:
            try:
                source_profile = ImageCms.ImageCmsProfile(io.BytesIO(icc_profile))
                rgb_image = ImageCms.profileToProfile(
                    rgb_image,
                    source_profile,
                    ImageCms.createProfile("sRGB"),
                    outputMode="RGB",
                )
            except (ImageCms.PyCMSError, OSError, ValueError) as exc:
                warnings.append(f"Embedded color profile could not be applied ({exc}); assumed sRGB.")

        rgb = np.asarray(rgb_image, dtype=np.uint8)
        alpha = np.asarray(alpha_image, dtype=np.uint8)
        rgba = np.empty((*rgb.shape[:2], 4), dtype=np.uint8)
        rgba[..., :3] = rgb
        rgba[..., 3] = alpha
        exif = image.getexif()
        if exif:
            exif[274] = 1
        metadata: dict[str, object] = {
            "icc_profile": _srgb_profile_bytes(),
            "exif": exif.tobytes() if exif else None,
            "dpi": info.get("dpi"),
            "xmp": info.get("xmp"),
            "source_mode": original_mode,
            "source_format": image.format or source.suffix.lstrip(".").upper(),
            "frame_count": frame_count,
        }
        return _DecodedImage(
            np.ascontiguousarray(rgba),
            np.ascontiguousarray(alpha),
            decoder,
            metadata,
            warnings,
        )
    finally:
        image.close()
        if opened_image is not image:
            opened_image.close()
