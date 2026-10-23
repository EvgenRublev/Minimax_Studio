"""Small, human-readable render notes; never embed diagnostic or machine data."""
from __future__ import annotations

import re

from .jobs import Cancelled

APPLICATION = "DLSS 5 Visual Enhancer"
PREFIX = "DLSS 5 Neural Rendering Settings - "
IMAGE_NOTE_FORMATS = frozenset({"PNG", "JPEG", "WebP", "AVIF", "TIFF"})
VIDEO_NOTE_FORMATS = frozenset({"MP4", "MKV"})
_LABELS = (
    "NR Preset", "NR Style", "NR Intensity", "Local Tone Strength",
    "Local Structure Strength", "Skin Structure Strength", "Automatic Mask",
    "DLSS Model Preset", "Upscaling Factor",
)
_NUMBER = r"-?\d+(?:\.\d+)?(?:e[+-]?\d+)?"
_VALUES = (
    r"(?:Default|Preset #[123])", r"(?:Default|Natural|Cinematic)",
    _NUMBER, _NUMBER, _NUMBER, _NUMBER + r"(?: \(Default\))?",
    r"(?:On|Off)", r"(?:Default|J|K|L|M)", _NUMBER + "x",
)
_OWN_NOTE = re.compile(
    r"(?m)^" + re.escape(APPLICATION + ":") + r"\r?\n" + re.escape(PREFIX)
    + ", ".join(re.escape(label + " - ") + value for label, value in zip(_LABELS, _VALUES))
    + r"(?=\r?$)"
)


class MetadataNoteError(ValueError):
    """The optional note could not be safely embedded or read back."""


def check_cancelled(controller) -> None:
    if controller is not None and controller.cancel.is_set():
        raise Cancelled("Render stopped by user.")


def record_embedding(diagnostics: dict | None, status: str, *, field=None, reason=None) -> None:
    if diagnostics is not None:
        diagnostics.update(status=status)
        if field is not None:
            diagnostics["field"] = field
        if reason is not None:
            diagnostics["reason"] = str(reason)


def embedding_warning(diagnostics: dict | None, exc: Exception) -> str:
    message = f"DLSS settings metadata was skipped; saved without the new note ({str(exc)[:500]})."
    record_embedding(diagnostics, "skipped", reason=str(exc)[:500])
    if diagnostics is not None:
        diagnostics["warning"] = message
    return message


def build_render_note(options, applied_model_preset: int) -> str:
    # Use the same validation and labels as the native protocol, with its
    # confirmed model preset rather than an unrelated current UI selection.
    from .runtime import DLSS_MODEL_PRESETS, resolve_native_settings, resolve_upscaling_mode

    native = resolve_native_settings(options)
    factor, _ = resolve_upscaling_mode(options.upscaling_factor)
    model = next(name for name, code in DLSS_MODEL_PRESETS.items() if code == applied_model_preset)
    number = lambda value: str(float(value)).removesuffix(".0")
    skin = number(native["skin_structure"])
    if native["skin_structure"] == -1:
        skin += " (Default)"
    values = (
        options.nr_preset, options.nr_style, number(native["intensity"]),
        number(native["local_tone"]), number(native["local_structure"]), skin,
        "On" if native["auto_mask"] else "Off", model, number(factor) + "x",
    )
    return APPLICATION + ":\n" + PREFIX + ", ".join(
        label + " - " + value for label, value in zip(_LABELS, values)
    )


def prepare_render_note(options, applied_model_preset: int, diagnostics: dict) -> str | None:
    try:
        return build_render_note(options, applied_model_preset)
    except (ValueError, TypeError, KeyError, AttributeError, StopIteration) as exc:
        embedding_warning(diagnostics, exc)
        return None


def merge_render_note(existing: str | None, note: str) -> str:
    if not isinstance(note, str) or not _OWN_NOTE.fullmatch(note):
        raise MetadataNoteError("Unrecognized render note")
    if existing is None or existing == "":
        return note
    if not isinstance(existing, str) or "\x00" in existing:
        raise MetadataNoteError("The existing description cannot be safely extended")
    matches = list(_OWN_NOTE.finditer(existing))
    if matches:
        # Replace only a complete, recognized note. User descriptions, including
        # similarly named prose, remain untouched.
        return _OWN_NOTE.sub(lambda _match: note, existing)
    return existing + "\n\n" + note
