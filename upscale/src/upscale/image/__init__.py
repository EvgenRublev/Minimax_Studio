"""RTX VSR still-image API."""
from .models import ImageUpscaleOptions, ImageUpscaleResult, ImageUpscaleBatchResult, ImageUpscaleFailure


def __getattr__(name):
    if name == "upscale_image":
        from .processor import upscale_image
        return upscale_image
    if name == "upscale_images":
        from .batch import upscale_images
        return upscale_images
    raise AttributeError(name)
