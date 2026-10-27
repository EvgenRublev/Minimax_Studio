from dataclasses import dataclass

import gradio as gr

from ..settings.models import UPSCALE_MODE_CHOICES
from .image.ui import build_image_tab
from .video.ui import build_upscale_tab as build_video_tab


def mode_visibility(mode):
    return gr.update(visible=mode == "Image"), gr.update(visible=mode == "Video")


@dataclass
class UpscaleTab:
    mode: object
    image: object
    video: object
    image_panel: object
    video_panel: object


def build_upscale_tab(settings):
    selected_mode = settings.upscale_mode
    mode = gr.Radio(
        list(UPSCALE_MODE_CHOICES), value=selected_mode, label="Mode", elem_id="upscale-mode"
    )
    with gr.Column(visible=selected_mode == "Image", elem_id="upscale-image") as image_panel:
        image = build_image_tab(settings)
    with gr.Column(visible=selected_mode == "Video", elem_id="upscale-video") as video_panel:
        video = build_video_tab(settings)
    mode.change(mode_visibility, inputs=mode, outputs=[image_panel, video_panel], queue=False, show_progress="hidden")
    return UpscaleTab(mode, image, video, image_panel, video_panel)
