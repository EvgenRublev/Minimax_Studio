from __future__ import annotations

import os
import threading
import time
import warnings as python_warnings
from collections import OrderedDict
from pathlib import Path

import numpy as np
from PIL import Image

from .models import ImageConversionOptions
from ...core.jobs import Cancelled
from ...core.render_metadata import (
    IMAGE_NOTE_FORMATS, MetadataNoteError, check_cancelled, embedding_warning,
    merge_render_note, record_embedding,
)

_PREVIEW_CACHE_LIMIT = 32
_preview_cache: OrderedDict[str, Image.Image] = OrderedDict()
_preview_cache_lock = threading.Lock()

def take_image_preview(output_path: str | os.PathLike[str]) -> Image.Image | None:
    """Return and remove a UI thumbnail created from the rendered frame in memory."""
    key = str(Path(output_path).resolve())
    with _preview_cache_lock:
        return _preview_cache.pop(key, None)


def _remember_image_preview(
    output_path: Path, rgba: np.ndarray, output_format: str
) -> None:
    image = Image.fromarray(rgba, mode="RGBA")
    try:
        if output_format == "JPEG":
            background = Image.new("RGBA", image.size, (255, 255, 255, 255))
            background.alpha_composite(image)
            preview = background
        else:
            preview = image.copy()
        preview.thumbnail((1600, 1200), Image.Resampling.LANCZOS)
        key = str(output_path.resolve())
        with _preview_cache_lock:
            previous = _preview_cache.pop(key, None)
            if previous is not None:
                previous.close()
            _preview_cache[key] = preview
            while len(_preview_cache) > _PREVIEW_CACHE_LIMIT:
                _unused_key, unused = _preview_cache.popitem(last=False)
                unused.close()
    finally:
        image.close()


def _encode_image(
    output: Path,
    rgba: np.ndarray,
    options: ImageConversionOptions,
    metadata: dict[str, object],
    *, generate_preview: bool = True, preview_path: Path | None = None,
    render_note: str | None = None, metadata_diagnostics: dict | None = None, controller=None,
) -> list[str]:
    warnings = save_image(output, rgba, options, metadata, render_note=render_note,
                          metadata_diagnostics=metadata_diagnostics, controller=controller)
    try:
        if generate_preview:
            _remember_image_preview(preview_path or output, rgba, options.output_format)
    except Exception:
        # A UI convenience must never invalidate an otherwise correct output.
        pass
    return warnings

def _metadata_save_args(metadata: dict[str, object], output_format: str) -> dict[str, object]:
    args: dict[str, object] = {}
    if metadata.get("icc_profile"):
        args["icc_profile"] = metadata["icc_profile"]
    if metadata.get("dpi"):
        args["dpi"] = metadata["dpi"]
    if metadata.get("exif") and output_format in {"JPEG", "WebP", "AVIF", "TIFF", "PNG"}:
        args["exif"] = metadata["exif"]
    if metadata.get("xmp") and output_format in {"WebP", "AVIF"}:
        args["xmp"] = metadata["xmp"]
    return args


def save_image(
    output: Path,
    rgba: np.ndarray,
    options: ImageConversionOptions,
    metadata: dict[str, object],
    *, render_note: str | None = None, metadata_diagnostics: dict | None = None, controller=None,
) -> list[str]:
    output_format = options.output_format
    image = Image.fromarray(rgba, mode="RGBA")
    warnings: list[str] = []
    args = _metadata_save_args(metadata, output_format) if options.preserve_metadata else {}
    if output_format == "PNG":
        args.update(optimize=False, compress_level=6)
    elif output_format == "TIFF":
        args.update(compression="tiff_deflate")
    elif output_format == "JPEG":
        background = Image.new("RGBA", image.size, (255, 255, 255, 255))
        background.alpha_composite(image)
        image = background.convert("RGB")
        args.update(
            quality=int(options.quality),
            subsampling=0,
            optimize=False,
            progressive=False,
        )
        if np.any(rgba[..., 3] != 255):
            warnings.append("Transparency was composited over white for JPEG output.")
    elif output_format == "WebP":
        args.update(quality=int(options.quality), method=6)
    elif output_format == "AVIF":
        args.update(quality=int(options.quality), speed=4)

    temporary = output.with_name(f".{output.stem}.{time.time_ns()}{output.suffix}")
    note_requested = render_note is not None and output_format in IMAGE_NOTE_FORMATS
    original_args = args.copy()
    description = None
    try:
        check_cancelled(controller)
        if note_requested:
            try:
                args, description = _add_render_note(args, render_note)
            except (ValueError, TypeError, KeyError, SyntaxError, OSError) as exc:
                if isinstance(exc, OSError) and exc.errno is not None:
                    raise
                warnings.append(embedding_warning(metadata_diagnostics, exc))
                note_requested = False
        elif render_note is not None:
            record_embedding(metadata_diagnostics, "skipped", reason="unsupported_format")
        elif metadata_diagnostics is not None and not metadata_diagnostics:
            record_embedding(metadata_diagnostics, "not_requested")

        try:
            check_cancelled(controller)
            image.save(temporary, format=output_format, **args)
            check_cancelled(controller)
            # Note-free legacy calls retain their existing validation behavior.
            if render_note is not None or metadata_diagnostics is not None:
                _verify_image(temporary, image.size, description if note_requested else None)
        except Cancelled:
            raise
        except (ValueError, TypeError, KeyError, SyntaxError, OSError, RuntimeError) as exc:
            # Disk/permission errors and cancellation are not metadata failures.
            if not note_requested or (isinstance(exc, OSError) and exc.errno is not None):
                raise
            check_cancelled(controller)
            warnings.append(embedding_warning(metadata_diagnostics, exc))
            image.save(temporary, format=output_format, **original_args)
            check_cancelled(controller)
            _verify_image(temporary, image.size, None)
            note_requested = False
        check_cancelled(controller)
        os.replace(temporary, output)
        if note_requested:
            record_embedding(metadata_diagnostics, "embedded", field="EXIF.ImageDescription")
    finally:
        image.close()
        if temporary.exists():
            temporary.unlink()
    return warnings


def _add_render_note(args: dict, note: str) -> tuple[dict, str]:
    # EXIF may contain nested IFDs; Pillow preserves these through its Exif API.
    # Never alter the decoder's metadata object or its original byte payload.
    exif = Image.Exif()
    with python_warnings.catch_warnings(record=True) as caught:
        python_warnings.simplefilter("always")
        if args.get("exif"):
            exif.load(args["exif"])
        original_fields = _exif_fields(exif)
        description = merge_render_note(exif.get(270), note)
        exif[270] = description
        encoded = exif.tobytes()
        reread = Image.Exif()
        reread.load(encoded)
        if caught or reread.get(270) != description or _exif_fields(reread) != original_fields:
            raise MetadataNoteError("EXIF description could not be preserved exactly")
    return {**args, "exif": encoded}, description


def _exif_fields(exif: Image.Exif) -> dict:
    """Compare content, not relocated IFD offsets, before adding the note."""
    fields = {tag: value for tag, value in exif.items() if tag not in {270, 34665, 34853}}
    for tag in (34665, 34853):
        if tag in exif:
            nested = dict(exif.get_ifd(tag))
            if tag == 34665 and 40965 in nested:
                nested[40965] = dict(exif.get_ifd(40965))
            fields[tag] = nested
    return fields


def _verify_image(path: Path, size: tuple[int, int], description: str | None) -> None:
    with Image.open(path) as saved:
        saved.load()
        if saved.size != size:
            raise MetadataNoteError("Saved image dimensions changed")
        if description is not None and saved.getexif().get(270) != description:
            raise MetadataNoteError("Saved image did not retain the settings note")
