from pathlib import Path

import gradio as gr
from gradio.data_classes import FileData

from gradio.events import Dependency

class ManagedVideo(gr.Video):
    """The Upscale pipeline owns color conversion and preview encoding."""

    is_template = True

    def postprocess(self, value):
        # gr.Video otherwise silently converts HEVC/MOV/MKV to H.264, including
        # when Preview Encoding is Disabled. FileData still uses Gradio's normal
        # file validation/cache/serving path; only automatic encoding is omitted.
        return None if value is None else FileData(path=str(value), orig_name=Path(value).name)
    from typing import Callable, Literal, Sequence, Any, TYPE_CHECKING
    from gradio.blocks import Block
    if TYPE_CHECKING:
        from gradio.components import Timer
        from gradio.components.base import Component