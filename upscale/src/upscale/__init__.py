"""NVIDIA RTX Super Resolution workflows for images and videos."""


def __getattr__(name):
    if name in {"upscale_image", "upscale_images", "ImageUpscaleOptions", "ImageUpscaleResult", "ImageUpscaleBatchResult"}:
        from . import image
        return getattr(image, name)
    if name == "upscale_video":
        from .video.processor import upscale_video
        return upscale_video
    if name == "upscale_videos":
        from .video.batch import upscale_videos
        return upscale_videos
    raise AttributeError(name)
