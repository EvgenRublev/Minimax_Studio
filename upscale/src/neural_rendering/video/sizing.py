from __future__ import annotations

from ...core import ffmpeg
from ...core.runtime import (
    UPSCALING_MODES,
    resolve_native_settings, resolve_output_size, resolve_upscaling_mode,
)
from .models import ConversionOptions

UPSCALING_CHOICES = tuple((mode["label"], factor) for factor, mode in UPSCALING_MODES.items())
ENCODING_QUALITIES = ffmpeg.ENCODING_QUALITIES
AUTO_BITRATE_DIVISORS = ffmpeg.AUTO_BITRATE_DIVISORS
calculate_auto_bitrate_kbps = ffmpeg.calculate_auto_bitrate_kbps
probe_video = ffmpeg.probe_video
validate_codec_container = ffmpeg.validate_codec_container


def resolve_encoding_quality(
    options: ConversionOptions, width: int, height: int, fps: float
) -> dict:
    return ffmpeg.resolve_encoding_quality(
        options.quality, options.codec, width, height, fps
    )
