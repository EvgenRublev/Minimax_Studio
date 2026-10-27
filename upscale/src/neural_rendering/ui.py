from __future__ import annotations

from dataclasses import dataclass

import gradio as gr

from ..settings.models import UISettings
from .image.ui import ImageTab, build_image_tab
from .video.ui import VideoTab, build_video_tab


MODE_CHOICES = ("Image", "Video")


def mode_visibility(mode: str) -> tuple[dict, dict]:
    """Show one workflow while keeping both component trees alive."""
    show_video = mode == "Video"
    return gr.update(visible=not show_video), gr.update(visible=show_video)


@dataclass(slots=True)
class NeuralRenderingTab:
    mode: object
    image: ImageTab
    video: VideoTab
    image_panel: object
    video_panel: object


def build_neural_rendering_tab(settings: UISettings) -> NeuralRenderingTab:
    mode = gr.Radio(
        choices=list(MODE_CHOICES),
        value="Image",
        label="Mode",
        interactive=True,
        elem_id="neural-rendering-mode",
    )
    with gr.Column(visible=True, elem_id="neural-rendering-image") as image_panel:
        image_tab = build_image_tab(settings)
    with gr.Column(visible=False, elem_id="neural-rendering-video") as video_panel:
        video_tab = build_video_tab(settings)

    mode.change(
        mode_visibility,
        inputs=mode,
        outputs=[image_panel, video_panel],
        queue=False,
        show_progress="hidden",
    )
    return NeuralRenderingTab(mode, image_tab, video_tab, image_panel, video_panel)
