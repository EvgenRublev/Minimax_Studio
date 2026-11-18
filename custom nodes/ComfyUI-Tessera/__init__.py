"""Tessera -- tiled, guided video refinement/upscaling for ComfyUI.

Every tile is anchored to the same ground truth (plate + cropped refs +
cropped guide), so tiles agree without ever reading each other. Streamed
encode/decode keep any resolution and clip length inside fixed memory.
"""

from .tessera.nodes import (NODE_CLASS_MAPPINGS,
                            NODE_DISPLAY_NAME_MAPPINGS)

# context-sensitive widget visibility (hides inactive tiling widgets)
WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS",
           "WEB_DIRECTORY"]
