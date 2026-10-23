from __future__ import annotations

import os
from typing import Callable

from .batch import convert_images
from .models import ImageConversionOptions, ImageConversionResult

def convert_image(
    input_path: str | os.PathLike[str],
    options: ImageConversionOptions | None = None,
    progress: Callable[[float, str], None] | None = None,
    *, output_dir=None, controller=None, generate_previews: bool = True, create_zip: bool = True,
) -> ImageConversionResult:
    result = convert_images([input_path], options, progress, output_dir=output_dir, controller=controller,
                            generate_previews=generate_previews, create_zip=create_zip)
    if result.successes:
        return result.successes[0]
    if result.failures:
        raise RuntimeError(result.failures[0].error)
    raise RuntimeError("Image conversion produced no result.")
