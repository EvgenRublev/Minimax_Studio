from __future__ import annotations

from dataclasses import dataclass, replace

import gradio as gr

from ..core.ffmpeg import hdr_mode_supported, probe_nvenc_codecs
from ..core.gpu_selection import gpu_choice_label
from ..core.paths import CONFIG_PATH
from ..core.runtime import UPSCALING_MODES, prepare_runtime
from ..core.ffmpeg.preview import normalize_preview_encoding
from .models import (
    DEFAULT_SETTINGS, PREVIEW_ENCODING_CHOICES, UPSCALE_MODE_CHOICES, UISettings,
    automatic_mask_choice, coerce_hdr_mode, parse_automatic_mask,
)
from .presets import export_settings_preset, import_settings_preset, preset_filename
from .storage import SETTINGS_STATE, load_settings, save_settings
from ..upscale.video.models import SETTING_FIELDS, UpscaleOptions
from ..upscale.image.models import SETTING_FIELDS as IMAGE_UPSCALE_FIELDS, ImageUpscaleOptions

_CONFIG_LOCK = SETTINGS_STATE.lock
UPSCALING_CHOICES = tuple((mode["label"], factor) for factor, mode in UPSCALING_MODES.items())

def _neural_values(
    settings: UISettings,
) -> tuple[str, str, float, float, float, float, float, str]:
    return (
        settings.nr_preset,
        settings.nr_style,
        settings.nr_intensity,
        settings.local_tone_strength,
        settings.local_structure_strength,
        settings.skin_structure_strength,
        settings.upscaling_factor,
        automatic_mask_choice(settings.automatic_mask),
    )


def _shared_dlss_values(
    settings: UISettings,
) -> tuple[str, str, float, float, float, float, float, str, str]:
    return (*_neural_values(settings), settings.dlss_model_preset)


def _mirrored_dlss_values(settings: UISettings) -> tuple:
    """Shared 9-tuple twice: feeds the Image and Video mode controls."""
    shared = _shared_dlss_values(settings)
    return (*shared, *shared)


def _notify_live_effects(settings: UISettings) -> None:
    # Call while holding _CONFIG_LOCK: submissions follow the saved commit
    # order, including imports/resets. This only enqueues an immutable snapshot.
    from ..live.pipeline import update_live_effects

    update_live_effects(settings)


def persist_image_settings(
    nr_preset: str,
    nr_style: str,
    nr_intensity: float,
    local_tone_strength: float,
    local_structure_strength: float,
    skin_structure_strength: float,
    upscaling_factor: float,
    automatic_mask: str,
    dlss_model_preset: str,
    image_format: str,
    image_quality: float,
    rename_mode: str,
    custom_suffix: str,
) -> tuple:
    with _CONFIG_LOCK:
        current = SETTINGS_STATE.current or load_settings(CONFIG_PATH)
        settings = replace(
            current,
            nr_preset=nr_preset,
            nr_style=nr_style,
            nr_intensity=nr_intensity,
            local_tone_strength=local_tone_strength,
            local_structure_strength=local_structure_strength,
            skin_structure_strength=skin_structure_strength,
            upscaling_factor=upscaling_factor,
            automatic_mask=parse_automatic_mask(automatic_mask),
            dlss_model_preset=dlss_model_preset,
            image_format=image_format,
            image_quality=int(image_quality),
            image_rename_mode=rename_mode,
            image_custom_suffix=custom_suffix,
        )
        if settings != current:
            save_settings(CONFIG_PATH, settings)
        SETTINGS_STATE.current = settings
        _notify_live_effects(settings)
    return _mirrored_dlss_values(settings)


def persist_video_settings(
    nr_preset: str,
    nr_style: str,
    nr_intensity: float,
    local_tone_strength: float,
    local_structure_strength: float,
    skin_structure_strength: float,
    upscaling_factor: float,
    automatic_mask: str,
    dlss_model_preset: str,
    codec: str,
    container: str,
    quality: str,
    hdr_mode: bool,
    rename_mode: str,
    custom_suffix: str,
) -> tuple:
    with _CONFIG_LOCK:
        current = SETTINGS_STATE.current or load_settings(CONFIG_PATH)
        coerced_hdr = coerce_hdr_mode(codec, hdr_mode)
        settings = replace(
            current,
            nr_preset=nr_preset,
            nr_style=nr_style,
            nr_intensity=nr_intensity,
            local_tone_strength=local_tone_strength,
            local_structure_strength=local_structure_strength,
            skin_structure_strength=skin_structure_strength,
            upscaling_factor=upscaling_factor,
            automatic_mask=parse_automatic_mask(automatic_mask),
            dlss_model_preset=dlss_model_preset,
            codec=codec,
            container=container,
            quality=quality,
            hdr_mode=coerced_hdr,
            video_rename_mode=rename_mode,
            video_custom_suffix=custom_suffix,
        )
        if settings != current:
            save_settings(CONFIG_PATH, settings)
        SETTINGS_STATE.current = settings
        _notify_live_effects(settings)
    return _mirrored_dlss_values(settings)


def persist_live_settings(
    nr_preset: str,
    nr_style: str,
    nr_intensity: float,
    local_tone_strength: float,
    local_structure_strength: float,
    skin_structure_strength: float,
    upscaling_factor: float,
    automatic_mask: str,
    dlss_model_preset: str,
) -> tuple:
    with _CONFIG_LOCK:
        current = SETTINGS_STATE.current or load_settings(CONFIG_PATH)
        settings = replace(
            current,
            nr_preset=nr_preset,
            nr_style=nr_style,
            nr_intensity=nr_intensity,
            local_tone_strength=local_tone_strength,
            local_structure_strength=local_structure_strength,
            skin_structure_strength=skin_structure_strength,
            upscaling_factor=upscaling_factor,
            automatic_mask=parse_automatic_mask(automatic_mask),
            dlss_model_preset=dlss_model_preset,
        )
        if settings != current:
            save_settings(CONFIG_PATH, settings)
        SETTINGS_STATE.current = settings
        _notify_live_effects(settings)
    return _mirrored_dlss_values(settings)


def persist_frame_interpolation_settings(
    target_fps: str,
    engine: str,
    codec: str,
    container: str,
    quality: str,
    hdr_mode: bool,
    rename_mode: str,
    custom_suffix: str,
) -> None:
    with _CONFIG_LOCK:
        current = SETTINGS_STATE.current or load_settings(CONFIG_PATH)
        coerced_hdr = coerce_hdr_mode(codec, hdr_mode)
        settings = replace(
            current,
            frame_interpolation_target_fps=target_fps,
            frame_interpolation_engine=engine,
            frame_interpolation_codec=codec,
            frame_interpolation_container=container,
            frame_interpolation_quality=quality,
            frame_interpolation_hdr_mode=coerced_hdr,
            frame_interpolation_rename_mode=rename_mode,
            frame_interpolation_custom_suffix=custom_suffix,
        )
        if settings != current:
            save_settings(CONFIG_PATH, settings)
        SETTINGS_STATE.current = settings


def persist_upscale_settings(*values) -> None:
    chosen = dict(zip(SETTING_FIELDS, values))
    if not hdr_mode_supported(chosen["codec"]):
        chosen["hdr_enabled"] = False
    options = UpscaleOptions(**chosen)
    options.validate(for_render=False)
    defaults = UpscaleOptions()
    for name in SETTING_FIELDS:
        if type(getattr(defaults, name)) is int:
            chosen[name] = int(chosen[name])
    chosen["scale_factor"] = float(chosen["scale_factor"])
    with _CONFIG_LOCK:
        current = SETTINGS_STATE.current or load_settings(CONFIG_PATH)
        settings = replace(current, **{"upscale_" + name: value for name, value in chosen.items()})
        if settings != current:
            save_settings(CONFIG_PATH, settings)
        SETTINGS_STATE.current = settings


def persist_image_upscale_settings(*values) -> None:
    chosen = dict(zip(IMAGE_UPSCALE_FIELDS, values))
    ImageUpscaleOptions(**chosen).validate()
    defaults = ImageUpscaleOptions()
    for name in IMAGE_UPSCALE_FIELDS:
        if type(getattr(defaults, name)) is int:
            chosen[name] = int(chosen[name])
    chosen["scale_factor"] = float(chosen["scale_factor"])
    with _CONFIG_LOCK:
        current = SETTINGS_STATE.current or load_settings(CONFIG_PATH)
        settings = replace(current, **{"upscale_image_" + n: v for n, v in chosen.items()})
        if settings != current:
            save_settings(CONFIG_PATH, settings)
        SETTINGS_STATE.current = settings


def persist_upscale_mode(mode: str) -> None:
    if mode not in UPSCALE_MODE_CHOICES:
        raise gr.Error(f"Upscale mode must be one of: {', '.join(UPSCALE_MODE_CHOICES)}.")
    with _CONFIG_LOCK:
        current = SETTINGS_STATE.current or load_settings(CONFIG_PATH)
        settings = replace(current, upscale_mode=mode)
        if settings != current:
            save_settings(CONFIG_PATH, settings)
        SETTINGS_STATE.current = settings


def _settings_component_values(settings: UISettings) -> tuple:
    shared = _shared_dlss_values(settings)
    return (
        *shared,
        *shared,
        settings.image_format,
        settings.image_quality,
        settings.image_rename_mode,
        gr.update(
            value=settings.image_custom_suffix,
            interactive=settings.image_rename_mode == "Custom",
        ),
        settings.codec,
        settings.container,
        settings.quality,
        gr.update(value=settings.hdr_mode, interactive=hdr_mode_supported(settings.codec)),
        settings.video_rename_mode,
        gr.update(
            value=settings.video_custom_suffix,
            interactive=settings.video_rename_mode == "Custom",
        ),
        settings.frame_interpolation_target_fps,
        settings.frame_interpolation_engine,
        settings.frame_interpolation_codec,
        settings.frame_interpolation_container,
        settings.frame_interpolation_quality,
        gr.update(value=settings.frame_interpolation_hdr_mode, interactive=hdr_mode_supported(settings.frame_interpolation_codec)),
        settings.frame_interpolation_rename_mode,
        gr.update(
            value=settings.frame_interpolation_custom_suffix,
            interactive=settings.frame_interpolation_rename_mode == "Custom",
        ),
        settings.ai_gpu_uuid,
        settings.video_gpu_uuid,
        settings.preview_encoding,
        *shared,
        settings.upscale_mode,
        *(getattr(settings, "upscale_" + name) for name in SETTING_FIELDS),
        *(getattr(settings, "upscale_image_" + name) for name in IMAGE_UPSCALE_FIELDS),
    )


def _gpu_choices(prepared) -> tuple[list[tuple[str, str]], list[tuple[str, str]]]:
    automatic = [("Auto", "auto")]
    ai = []
    for gpu in prepared.gpus:
        if not gpu.get("ai_compatible"):
            continue
        ai.append((gpu_choice_label(gpu), str(gpu["uuid"])))
    video = [
        (gpu_choice_label(gpu), str(gpu["uuid"]))
        for gpu in prepared.gpus
        if gpu.get("cuda_ordinal") is not None
        and probe_nvenc_codecs(int(gpu["cuda_ordinal"]))
    ]
    return automatic + ai, automatic + video


def _normalize_gpu_settings(settings: UISettings, prepared) -> tuple[UISettings, str]:
    ai_choices, video_choices = _gpu_choices(prepared)
    ai_values = {value for _label, value in ai_choices}
    video_values = {value for _label, value in video_choices}
    warnings = []
    ai_uuid = settings.ai_gpu_uuid
    video_uuid = settings.video_gpu_uuid
    if ai_uuid not in ai_values:
        warnings.append("Saved AI Processing GPU is unavailable; using Auto.")
        ai_uuid = "auto"
    if video_uuid not in video_values:
        warnings.append("Saved Video Processing GPU is unavailable; using Auto.")
        video_uuid = "auto"
    return replace(settings, ai_gpu_uuid=ai_uuid, video_gpu_uuid=video_uuid), " ".join(warnings)


def persist_preview_encoding(preview_encoding: str) -> None:
    normalized = normalize_preview_encoding(preview_encoding)
    if not isinstance(preview_encoding, str) or preview_encoding.strip() not in PREVIEW_ENCODING_CHOICES:
        raise gr.Error(
            f"Preview Encoding must be one of: {', '.join(PREVIEW_ENCODING_CHOICES)}."
        )
    with _CONFIG_LOCK:
        current = SETTINGS_STATE.current or load_settings(CONFIG_PATH)
        settings = replace(current, preview_encoding=normalized)
        if settings != current:
            save_settings(CONFIG_PATH, settings)
        SETTINGS_STATE.current = settings


def persist_gpu_settings(ai_gpu_uuid: str, video_gpu_uuid: str) -> str:
    prepared = prepare_runtime()
    ai_choices, video_choices = _gpu_choices(prepared)
    if ai_gpu_uuid not in {value for _label, value in ai_choices}:
        raise gr.Error("Choose an available AI Processing GPU.")
    if video_gpu_uuid not in {value for _label, value in video_choices}:
        raise gr.Error("Choose an available Video Processing GPU.")
    with _CONFIG_LOCK:
        current = SETTINGS_STATE.current or load_settings(CONFIG_PATH)
        settings = replace(
            current, ai_gpu_uuid=ai_gpu_uuid, video_gpu_uuid=video_gpu_uuid
        )
        if settings != current:
            save_settings(CONFIG_PATH, settings)
        SETTINGS_STATE.current = settings
    ai_name = "Auto" if ai_gpu_uuid == "auto" else next(
        label for label, value in ai_choices if value == ai_gpu_uuid
    )
    video_name = "Auto" if video_gpu_uuid == "auto" else next(
        label for label, value in video_choices if value == video_gpu_uuid
    )
    return f"AI Processing: {ai_name}\n\nVideo Processing: {video_name}"


def reset_saved_settings() -> tuple:
    with _CONFIG_LOCK:
        save_settings(CONFIG_PATH, DEFAULT_SETTINGS)
        SETTINGS_STATE.current = DEFAULT_SETTINGS
        _notify_live_effects(DEFAULT_SETTINGS)
    message = "All Neural Rendering, Upscale, and Frame Interpolation settings were reset to defaults."
    return (
        *_settings_component_values(DEFAULT_SETTINGS),
        message,
        message,
        message,
        message,
        message,
    )


def settings_preset_download(name: str) -> str | None:
    if not isinstance(name, str) or not name.strip():
        return None
    with _CONFIG_LOCK:
        current = SETTINGS_STATE.current or load_settings(CONFIG_PATH)
    try:
        path = export_settings_preset(name, current)
    except ValueError:
        return None
    return str(path)


def settings_preset_export_status(name: str) -> str:
    try:
        filename = preset_filename(name)
    except ValueError as exc:
        return f"Export failed: {exc}"
    return f"Exported preset {name.strip()!r} as {filename}."


def apply_settings_preset(
    uploaded_path: str | None, current_name: str
) -> tuple:
    with _CONFIG_LOCK:
        current = SETTINGS_STATE.current or load_settings(CONFIG_PATH)
        try:
            if not uploaded_path:
                raise ValueError("Choose a JSON preset file before importing.")
            name, imported = import_settings_preset(uploaded_path, current)
            imported, gpu_warning = _normalize_gpu_settings(
                imported, prepare_runtime()
            )
            save_settings(CONFIG_PATH, imported)
        except (OSError, ValueError) as exc:
            return (
                current_name,
                *_settings_component_values(current),
                f"Import failed: {exc}",
            )
        SETTINGS_STATE.current = imported
        _notify_live_effects(imported)
    return (
        name,
        *_settings_component_values(imported),
        f"Imported preset {name!r}; all modes, tabs, and saved startup settings were updated."
        + (f" {gpu_warning}" if gpu_warning else ""),
    )

@dataclass(slots=True)
class SettingsTab:
    ai_gpu_selector: object
    video_gpu_selector: object
    preview_encoding_selector: object
    preset_name: object
    preset_export: object
    preset_import: object
    preset_status: object


def initialize_settings(prepared) -> tuple[UISettings, str, list[tuple[str, str]], list[tuple[str, str]]]:
    settings = SETTINGS_STATE.current or load_settings(CONFIG_PATH)
    normalized, warning = _normalize_gpu_settings(settings, prepared)
    if normalized != settings:
        save_settings(CONFIG_PATH, normalized)
    SETTINGS_STATE.current = normalized
    ai_choices, video_choices = _gpu_choices(prepared)
    return normalized, warning, ai_choices, video_choices


def current_settings() -> UISettings:
    with _CONFIG_LOCK:
        return SETTINGS_STATE.current or load_settings(CONFIG_PATH)


def build_settings_tab(
    settings: UISettings,
    ai_gpu_choices: list[tuple[str, str]],
    video_gpu_choices: list[tuple[str, str]],
) -> SettingsTab:
    gr.Markdown(
        "## GPU Selection\n"
        "AI Processing controls DLSS, RTX Video, and Frame Generation. Video Processing "
        "controls only codecs suffixed (NVIDIA NVENC); plain H.264/H.265/AV1 and ProRes remain CPU-based."
    )
    with gr.Row():
        ai_gpu_selector = gr.Dropdown(
            choices=ai_gpu_choices,
            value=settings.ai_gpu_uuid,
            label="AI Processing GPU",
            info="Used for DLSS Neural Rendering, RTX Video, and Frame Generation.",
        )
        video_gpu_selector = gr.Dropdown(
            choices=video_gpu_choices,
            value=settings.video_gpu_uuid,
            label="Video Processing GPU",
            info="Used only for codecs suffixed (NVIDIA NVENC); plain H.264/H.265/AV1 and ProRes stay on CPU.",
        )
    gr.Markdown(
        "## Preview Encoding\n"
        "Controls how in-app video previews are produced for Neural Rendering's Video mode, "
        "Upscale, and Frame Interpolation (preview buttons and final-render player)."
    )
    preview_encoding_selector = gr.Radio(
        choices=list(PREVIEW_ENCODING_CHOICES),
        value=normalize_preview_encoding(settings.preview_encoding),
        label="Preview Encoding",
        info=(
            "Auto uses the result directly when the browser can play it (MP4 + H.264, "
            "verified by probe); otherwise creates an H.264 preview. "
            "Always H.264 always generates a browser-compatible preview. "
            "Disabled never creates one and sends the actual file to the browser. "
            "Non-H.264 previews can be slower and larger."
        ),
    )
    gr.Markdown(
        "## Settings Presets\n"
        "Export every adjustable option from Neural Rendering's Image and Video modes, "
        "Upscale, and Frame Interpolation, or import a preset to apply it everywhere."
    )
    preset_name = gr.Textbox(
        label="Preset name",
        placeholder="Cinematic 2",
        info="The exported file uses this name; the original name is stored in JSON.",
    )
    with gr.Row():
        preset_export = gr.DownloadButton(
            "Export preset",
            value=settings_preset_download,
            inputs=preset_name,
            variant="primary",
            scale=1,
        )
        preset_import = gr.UploadButton(
            "Import preset",
            file_count="single",
            file_types=[".json"],
            type="filepath",
            variant="primary",
            scale=1,
        )
    preset_status = gr.Markdown("", elem_id="preset-status")
    return SettingsTab(
        ai_gpu_selector, video_gpu_selector, preview_encoding_selector,
        preset_name, preset_export, preset_import, preset_status
    )



def settings_component_outputs(image_tab, video_tab, frame_tab, settings_tab, live_tab, upscale_tab) -> list[object]:
    return [
        *image_tab.neural,
        image_tab.model_preset,
        *video_tab.neural,
        video_tab.model_preset,
        image_tab.output_format,
        image_tab.quality,
        image_tab.rename_mode,
        image_tab.custom_suffix,
        video_tab.codec,
        video_tab.container,
        video_tab.quality,
        video_tab.hdr_mode,
        video_tab.rename_mode,
        video_tab.custom_suffix,
        frame_tab.target_fps,
        frame_tab.engine,
        frame_tab.codec,
        frame_tab.container,
        frame_tab.quality,
        frame_tab.hdr_mode,
        frame_tab.rename_mode,
        frame_tab.custom_suffix,
        settings_tab.ai_gpu_selector,
        settings_tab.video_gpu_selector,
        settings_tab.preview_encoding_selector,
        *live_tab.neural,
        live_tab.model_preset,
        upscale_tab.mode,
        *upscale_tab.video.settings_inputs,
        *upscale_tab.image.settings_inputs,
    ]


def bind_settings_events(settings_tab, image_tab, video_tab, frame_tab, live_tab, upscale_tab) -> None:
    video_mirror = [*video_tab.neural, video_tab.model_preset]
    image_mirror = [*image_tab.neural, image_tab.model_preset]
    live_mirror = [*live_tab.neural, live_tab.model_preset]
    for component in image_tab.settings_inputs:
        component.input(
            persist_image_settings,
            inputs=image_tab.settings_inputs,
            outputs=[*video_mirror, *live_mirror],
            queue=False,
        )
    for component in video_tab.settings_inputs:
        component.input(
            persist_video_settings,
            inputs=video_tab.settings_inputs,
            outputs=[*image_mirror, *live_mirror],
            queue=False,
        )
    for component in live_tab.settings_inputs:
        component.input(
            persist_live_settings,
            inputs=live_tab.settings_inputs,
            outputs=[*image_mirror, *video_mirror],
            queue=False,
        )
    for component in frame_tab.settings_inputs:
        component.input(
            persist_frame_interpolation_settings,
            inputs=frame_tab.settings_inputs,
            queue=False,
        )

    for component in upscale_tab.video.settings_inputs:
        component.change(persist_upscale_settings, inputs=upscale_tab.video.settings_inputs, queue=False, show_progress="hidden")
    for component in upscale_tab.image.settings_inputs:
        component.change(persist_image_upscale_settings, inputs=upscale_tab.image.settings_inputs, queue=False, show_progress="hidden")
    upscale_tab.mode.input(
        persist_upscale_mode,
        inputs=upscale_tab.mode,
        queue=False,
        show_progress="hidden",
    )
    outputs = settings_component_outputs(image_tab, video_tab, frame_tab, settings_tab, live_tab, upscale_tab)
    settings_tab.preset_export.click(
        settings_preset_export_status,
        inputs=settings_tab.preset_name,
        outputs=settings_tab.preset_status,
        queue=False,
    )
    settings_tab.preset_import.upload(
        apply_settings_preset,
        inputs=[settings_tab.preset_import, settings_tab.preset_name],
        outputs=[settings_tab.preset_name, *outputs, settings_tab.preset_status],
        queue=False,
    )
    for selector in [settings_tab.ai_gpu_selector, settings_tab.video_gpu_selector]:
        selector.input(
            persist_gpu_settings,
            inputs=[settings_tab.ai_gpu_selector, settings_tab.video_gpu_selector],
            queue=False,
        )
    settings_tab.preview_encoding_selector.input(
        persist_preview_encoding,
        inputs=settings_tab.preview_encoding_selector,
        queue=False,
    )
    reset_outputs = [*outputs, image_tab.status, video_tab.status, frame_tab.status, upscale_tab.video.status, upscale_tab.image.status]
    image_tab.reset.click(reset_saved_settings, outputs=reset_outputs, queue=False)
    video_tab.reset.click(reset_saved_settings, outputs=reset_outputs, queue=False)
    frame_tab.reset.click(reset_saved_settings, outputs=reset_outputs, queue=False)
    upscale_tab.video.reset.click(reset_saved_settings, outputs=reset_outputs, queue=False)
    upscale_tab.image.reset.click(reset_saved_settings, outputs=reset_outputs, queue=False)
