from __future__ import annotations

import atexit
import json
import math
import mmap
import re
import struct
import subprocess
import threading
import time
from contextlib import suppress
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from .gpu_detection import detect_gpus
from .gpu_selection import resolve_runtime_ai_gpu
from .jobs import BoundedLogBuffer, Cancelled, JobController, drain_bounded_text
from .paths import (
    ADDON, DLSS_SUPERRES, FFMPEG, FFPROBE, HOST_DIR, HOST_DXGI, LOGS,
    NEURAL_RUNTIME, RESHADE_LOG, RUNTIME, WORKER,
)



# Shared DLSS Neural Rendering controls and sizing. These are feature-neutral and
# used by both Image and Video processing.
NR_PRESETS = {
    "Default": 0,
    "Preset #1": 1,
    "Preset #2": 2,
    "Preset #3": 3,
}

NR_STYLES = {
    "Default": 0,
    "Natural": 1,
    "Cinematic": 2,
}

DLSS_MODEL_PRESETS = {
    "Default": 0,
    "J": 10,
    "K": 11,
    "L": 12,
    "M": 13,
}

UPSCALING_MODES = {
    1.0: {"label": "1× (DLAA / native)", "name": "DLAA", "perf_quality": 5},
    1.5: {"label": "1.5× (Quality)", "name": "Quality", "perf_quality": 2},
    1.724: {"label": "1.724× (Balanced)", "name": "Balanced", "perf_quality": 1},
    2.0: {"label": "2× (Performance)", "name": "Performance", "perf_quality": 0},
    3.0: {
        "label": "3× (Ultra Performance)",
        "name": "Ultra Performance",
        "perf_quality": 3,
    },
}
UPSCALING_CHOICES = tuple(
    (mode["label"], factor) for factor, mode in UPSCALING_MODES.items()
)

def resolve_upscaling_mode(raw_factor: float) -> tuple[float, dict[str, str | int]]:
    try:
        factor = float(raw_factor)
    except (TypeError, ValueError) as exc:
        raise ValueError(
            "Upscaling factor must be one of the supported NVIDIA DLSS modes."
        ) from exc
    if not math.isfinite(factor):
        raise ValueError("Upscaling factor must be one of the supported NVIDIA DLSS modes.")
    for supported, mode in UPSCALING_MODES.items():
        if math.isclose(factor, supported, rel_tol=0.0, abs_tol=1e-9):
            return supported, mode
    choices = ", ".join(f"{factor:g}×" for factor in UPSCALING_MODES)
    raise ValueError(f"Unsupported upscaling factor {factor:g}×. Choose one of: {choices}.")


def _nearest_even(value: float) -> int:
    return max(2, int(math.floor(value / 2.0 + 0.5)) * 2)


def resolve_output_size(width: int, height: int, factor: float) -> tuple[int, int]:
    factor, _ = resolve_upscaling_mode(factor)
    output_width = _nearest_even(int(width) * factor)
    output_height = _nearest_even(int(height) * factor)
    long_edge = max(output_width, output_height)
    short_edge = min(output_width, output_height)
    if long_edge > 7680 or short_edge > 4320:
        valid = [
            candidate
            for candidate in UPSCALING_MODES
            if max(_nearest_even(width * candidate), _nearest_even(height * candidate)) <= 7680
                       and min(_nearest_even(width * candidate), _nearest_even(height * candidate))
            <= 4320
        ]
        recommendation = max(valid) if valid else None
        hint = (
            f" Choose {recommendation:g}× or lower for this video."
            if recommendation is not None
            else " The source already exceeds the supported 8K boundary."
        )
        raise ValueError(
            f"The requested {output_width}×{output_height} output exceeds the supported "
            f"7680×4320 boundary.{hint}"
        )
    return output_width, output_height

def resolve_native_settings(options: Any) -> dict[str, int | float]:
    """Validate public NR controls and translate them to the worker protocol."""
    try:
        preset = NR_PRESETS[options.nr_preset]
    except KeyError as exc:
        choices = ", ".join(NR_PRESETS)
        raise ValueError(
            f"Unknown NR Preset: {options.nr_preset!r}. Choose one of: {choices}."
        ) from exc

    try:
        style = NR_STYLES[options.nr_style]
    except KeyError as exc:
        choices = ", ".join(NR_STYLES)
        raise ValueError(
            f"Unknown NR Style: {options.nr_style!r}. Choose one of: {choices}."
        ) from exc

    try:
        model_preset = DLSS_MODEL_PRESETS[options.dlss_model_preset]
    except KeyError as exc:
        choices = ", ".join(DLSS_MODEL_PRESETS)
        raise ValueError(
            f"Unknown DLSS Model Preset: {options.dlss_model_preset!r}. "
            f"Choose one of: {choices}."
        ) from exc

    controls = {
        "NR Intensity": (options.nr_intensity, 0.0, 2.0),
        "Local Tone Strength": (options.local_tone_strength, 0.0, 2.0),
        "Local Structure Strength": (options.local_structure_strength, 0.0, 2.0),
        "Skin Structure Strength": (options.skin_structure_strength, -1.0, 2.0),
    }
    validated: dict[str, float] = {}
    for label, (raw_value, minimum, maximum) in controls.items():
        try:
            value = float(raw_value)
        except (TypeError, ValueError) as exc:
            raise ValueError(
                f"{label} must be a number between {minimum:g} and {maximum:g}."
            ) from exc
        if not math.isfinite(value) or not minimum <= value <= maximum:
            raise ValueError(f"{label} must be between {minimum:g} and {maximum:g}.")
        validated[label] = value

    if not isinstance(options.automatic_mask, bool):
        raise ValueError("Automatic Mask must be a boolean value.")

    return {
        "profile": 0,
        "preset": preset,
        "style": style,
        "auto_mask": int(options.automatic_mask),
        "ui_correction": 0,
        "intensity": validated["NR Intensity"],
        "local_tone": validated["Local Tone Strength"],
        "local_structure": validated["Local Structure Strength"],
        "skin_structure": validated["Skin Structure Strength"],
        "dlss_model_preset": model_preset,
    }

VIDEO_MAGIC = 0x34563544
SETUP_MAGIC = 0x34505553
FRAME_MAGIC = 0x314D5246
OUT_MAGIC = 0x3154554F
END_MAGIC = 0x31444E45  # "END1": counted completion for an unknown-length stream.
VIDEO_HEADER_FORMAT = "<14I4f"
SETUP_RESPONSE_FORMAT = "<12I"

def inspect_runtime_bundle(
    addon_path: Path | None = None,
    neural_path: Path | None = None,
) -> dict[str, Any]:
    """Return runtime component identities for diagnostics without hash locking."""
    addon = addon_path or ADDON
    neural = neural_path or NEURAL_RUNTIME
    return {
        "addon": {
            "path": str(addon.resolve()),
            "version": "unlocked",
            "release": "RenoDX DLSS5 runtime (unlocked)",
        },
        "neural_runtime": {
            "path": str(neural.resolve()),
            "version": "unlocked",
            "release": "DLSS NR runtime (unlocked)",
        },
        "worker": {
            "path": str(WORKER.resolve()),
        },
    }


def validate_gpu_runtime(
    gpu: dict[str, Any], bundle: dict[str, Any] | None = None
) -> dict[str, Any]:
    """Return runtime metadata without version or hash compatibility locks."""
    del gpu
    return bundle or inspect_runtime_bundle()


def classify_worker_failure(
    *,
    worker_code: int,
    frame_index: int,
    worker_logs: list[str],
    reshade_lines: list[str],
    gpu: dict[str, Any],
    runtime_bundle: dict[str, Any],
) -> str:
    """Translate native/add-on failures into an actionable feature-18 diagnosis."""
    evidence = "\n".join([*worker_logs, *reshade_lines])
    access_violation = (
        "evaluate raised 0xC0000005" in evidence
        or "feature 18 evaluate raised an exception" in evidence
    )
    if access_violation:
        summary = (
            f"DLSS 5 feature 18 raised access violation 0xC0000005 before frame {frame_index} "
            "completed inside the universal neural runtime/add-on evaluation. Update the "
            "NVIDIA driver and verify the bundled DLSSNR runtime is intact."
        )
    else:
        summary = (
            f"Native DLSS worker exited with code {worker_code} before frame {frame_index} "
            "completed."
        )

    details = [
        summary,
        f"GPU: {gpu.get('name', 'unknown')} | driver: {gpu.get('driver', 'unknown')}",
        f"RenoDX add-on: {runtime_bundle.get('addon', {}).get('path', 'unavailable')}",
        f"DLSSNR runtime: {runtime_bundle.get('neural_runtime', {}).get('path', 'unavailable')}",
    ]
    if worker_logs:
        details.append("Worker log:\n" + "\n".join(worker_logs[-60:]))
    if reshade_lines:
        details.append("ReShade feature-18 log:\n" + "\n".join(reshade_lines[-60:]))
    return "\n".join(details)


def write_failure_report(
    *,
    operation: str,
    source: str,
    error: BaseException | str,
    gpu: dict[str, Any] | None,
    runtime_bundle: dict[str, Any] | None,
    worker_code: int | None = None,
    worker_logs: list[str] | None = None,
    reshade_lines: list[str] | None = None,
    logs_dir: Path | None = None,
    diagnostics: dict[str, Any] | None = None,
) -> Path:
    """Persist diagnostics even when the incomplete media output is removed."""
    destination = logs_dir or LOGS
    destination.mkdir(parents=True, exist_ok=True)
    safe_operation = re.sub(r"[^A-Za-z0-9_.-]+", "-", operation).strip("-") or "render"
    stamp = time.strftime("%Y%m%d-%H%M%S") + f"-{time.time_ns() % 1_000_000:06d}"
    report_path = destination / f"{safe_operation}-failure-{stamp}.json"
    report = {
        "status": "failure",
        "operation": operation,
        "input": source,
        "error": str(error),
        "gpu": gpu,
        "runtime_bundle": runtime_bundle,
        "worker_exit_code": worker_code,
        "worker_log": list(worker_logs or []),
        "reshade_feature_18_log": list(reshade_lines or []),
    }
    if diagnostics is not None:
        report["diagnostics"] = diagnostics
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    return report_path.resolve()

def resize_fit(rgba: np.ndarray, width: int, height: int) -> np.ndarray:
    source_height, source_width = rgba.shape[:2]
    if source_width == width and source_height == height:
        return np.ascontiguousarray(rgba, dtype=np.uint8)
    scale = min(width / source_width, height / source_height)
    fit_width = max(1, min(width, int(round(source_width * scale))))
    fit_height = max(1, min(height, int(round(source_height * scale))))
    resized = cv2.resize(rgba, (fit_width, fit_height), interpolation=cv2.INTER_LANCZOS4)
    canvas = np.zeros((height, width, 4), dtype=np.uint8)
    canvas[..., 3] = 255
    x = (width - fit_width) // 2
    y = (height - fit_height) // 2
    canvas[y : y + fit_height, x : x + fit_width] = resized
    return canvas


def rotate_frame(frame: np.ndarray, rotation: int) -> np.ndarray:
    if rotation == 90:
        return np.ascontiguousarray(np.rot90(frame, 3))
    if rotation == 180:
        return np.ascontiguousarray(np.rot90(frame, 2))
    if rotation == 270:
        return np.ascontiguousarray(np.rot90(frame, 1))
    return frame

def validate_runtime_files() -> None:
    # Old flat bin/runtime/ layout (pre host/dlss/dlssg split). Fail fast with a
    # clear message instead of auto-migrating, so a half-moved tree can't silently
    # run with mismatched NGX/add-on components.
    stale = [
        RUNTIME / "nvngx.dll",
        RUNTIME / "dxgi.dll",
        RUNTIME / "renodx-dlss5.addon64",
        RUNTIME / "ReShade.ini",
        RUNTIME / "nvngx_dlss.dll",
        RUNTIME / "nvngx_dlssnr.dll",
        RUNTIME / "frame_interpolation",
    ]
    leftovers = [str(path) for path in stale if path.exists()]
    if leftovers:
        raise RuntimeError(
            "The portable runtime still uses the old flat bin/runtime/ layout. "
            "Move host files (nvngx.dll, dxgi.dll, ReShade.ini) to bin/runtime/host/, "
            "nvngx_dlss.dll to bin/runtime/dlss/, renodx-dlss5.addon64 and "
            "nvngx_dlssnr.dll to bin/runtime/dlssnr/, and "
            "frame_interpolation/dlssg/* to bin/runtime/dlssg/.\n"
            + "\n".join(leftovers)
        )
    # Note: ReShade.ini is not required here. The worker rewrites every NR key
    # into the host's ReShade.ini on each run (and heals EnableHooks), so the
    # file is runtime state that is recreated when missing.
    required = [
        FFMPEG,
        FFPROBE,
        WORKER,
        HOST_DXGI,
        ADDON,
        DLSS_SUPERRES,
        NEURAL_RUNTIME,
    ]
    missing = [str(path) for path in required if not path.exists()]
    if missing:
        raise RuntimeError("Portable runtime is incomplete:\n" + "\n".join(missing))


def _read_exact(stream, size: int) -> bytes:
    chunks = bytearray()
    while len(chunks) < size:
        block = stream.read(size - len(chunks))
        if not block:
            raise EOFError(f"Native worker stopped after {len(chunks)} of {size} output bytes")
        chunks.extend(block)
    return bytes(chunks)


def _read_exact_into(stream, target: np.ndarray) -> None:
    view = memoryview(target).cast("B")
    offset = 0
    while offset < len(view):
        count = stream.readinto(view[offset:])
        if not count:
            raise EOFError(
                f"Native worker stopped after {offset} of {len(view)} output bytes"
            )
        offset += count


def _array_bytes(array: np.ndarray, dtype: np.dtype) -> memoryview:
    contiguous = np.ascontiguousarray(array, dtype=dtype)
    return memoryview(contiguous).cast("B")


class DLSSFrameSession:
    """A reusable native DLSSNR feature-18 frame stream."""

    def __init__(
        self,
        *,
        input_width: int,
        input_height: int,
        output_width: int,
        output_height: int,
        frame_count: int | None,
        warmup_frames: int,
        factor: float,
        mode: dict[str, str | int],
        native_settings: dict[str, int | float],
        gpu: dict[str, Any],
        runtime_bundle: dict[str, Any],
        controller: JobController,
    ) -> None:
        if frame_count is not None and (
            isinstance(frame_count, bool) or not isinstance(frame_count, int)
            or not 0 < frame_count <= 0xFFFFFFFF
        ):
            raise ValueError("Native frame count must be a positive uint32 or None.")
        self.controller = controller
        self._streaming = frame_count is None
        self._processed_frames = 0
        self.completed_frames: int | None = None
        self._worker_log_buffer = BoundedLogBuffer()
        self.closed = False
        self.factor = factor
        self.mode = mode
        self.native_settings = native_settings
        self.gpu = gpu
        self.runtime_bundle = runtime_bundle
        reshade_log_path = RESHADE_LOG
        self._reshade_log_baseline_size = 0
        self._reshade_log_baseline_tail = b""
        if reshade_log_path.exists():
            self._reshade_log_baseline_size = reshade_log_path.stat().st_size
            with reshade_log_path.open("rb") as stream:
                tail_size = min(256, self._reshade_log_baseline_size)
                stream.seek(self._reshade_log_baseline_size - tail_size)
                self._reshade_log_baseline_tail = stream.read(tail_size)
        creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        worker_command = [str(WORKER), "--video"]
        self.worker = subprocess.Popen(
            worker_command,
            cwd=HOST_DIR,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            creationflags=creation_flags,
        )
        controller.register(self.worker)
        assert self.worker.stderr is not None
        self.worker_thread = threading.Thread(
            target=drain_bounded_text,
            args=(self.worker.stderr, self._worker_log_buffer),
            daemon=True,
        )
        self.worker_thread.start()
        native = native_settings
        header = struct.pack(
            VIDEO_HEADER_FORMAT,
            VIDEO_MAGIC,
            input_width,
            input_height,
            output_width,
            output_height,
            int(warmup_frames),
            0 if frame_count is None else frame_count,
            int(mode["perf_quality"]),
            int(native["dlss_model_preset"]),
            native["profile"],
            native["preset"],
            native["style"],
            native["auto_mask"],
            native["ui_correction"],
            native["intensity"],
            native["local_tone"],
            native["local_structure"],
            native["skin_structure"],
        )
        assert self.worker.stdin is not None and self.worker.stdout is not None
        try:
            self.worker.stdin.write(header)
            self.worker.stdin.flush()
            try:
                setup_data = _read_exact(
                    self.worker.stdout, struct.calcsize(SETUP_RESPONSE_FORMAT)
                )
            except EOFError as exc:
                worker_code = self.worker.wait(timeout=10)
                self.worker_thread.join(timeout=2)
                details = (
                    "\n".join(self.worker_logs[-60:])
                    or "The worker produced no diagnostic output."
                )
                raise RuntimeError(
                    "The native worker is incompatible with the requested video protocol "
                    f"or failed during DLSS setup (exit {worker_code}):\n{details}"
                    + ("\nInstall the updated native worker with streaming completion support."
                       if self._streaming else "")
                ) from exc
            (
                setup_magic,
                setup_ok,
                self.setup_result,
                self.render_width,
                self.render_height,
                negotiated_output_width,
                negotiated_output_height,
                self.minimum_width,
                self.minimum_height,
                self.maximum_width,
                self.maximum_height,
                self.applied_dlss_model_preset,
            ) = struct.unpack(SETUP_RESPONSE_FORMAT, setup_data)
            if setup_magic != SETUP_MAGIC:
                raise RuntimeError(
                    "The installed native worker does not support the version-4 model-preset protocol. "
                    "Rebuild it."
                )
            if not setup_ok:
                details = "\n".join(self.worker_logs[-60:])
                raise RuntimeError(
                    f"DLSS {mode['name']} is unavailable for {output_width}×{output_height} "
                    f"(NGX 0x{self.setup_result:08X}). Choose a lower upscaling factor or update "
                    "the NVIDIA driver."
                    + (f"\n{details}" if details else "")
                )
            if (negotiated_output_width, negotiated_output_height) != (
                output_width,
                output_height,
            ):
                raise RuntimeError(
                    "The native worker returned output dimensions different from the request."
                )
            requested_model_preset = int(native["dlss_model_preset"])
            if self.applied_dlss_model_preset != requested_model_preset:
                raise RuntimeError(
                    "The native worker acknowledged DLSS model preset "
                    f"{self.applied_dlss_model_preset} instead of the requested "
                    f"{requested_model_preset}."
                )
            if self.render_width < 64 or self.render_height < 64:
                raise RuntimeError(
                    f"DLSS returned an unsupported render size: "
                    f"{self.render_width}×{self.render_height}; both dimensions must be at least "
                    "64 pixels."
                )
            self.output_width = output_width
            self.output_height = output_height
        except Exception:
            self.abort()
            raise

    def reshade_log_text(self) -> str:
        """Return only ReShade output created during this worker session."""
        path = RESHADE_LOG
        if not path.exists():
            return ""
        with path.open("rb") as stream:
            size = path.stat().st_size
            can_seek = size >= self._reshade_log_baseline_size
            tail = self._reshade_log_baseline_tail
            if can_seek and tail:
                stream.seek(self._reshade_log_baseline_size - len(tail))
                can_seek = stream.read(len(tail)) == tail
            stream.seek(self._reshade_log_baseline_size if can_seek else 0)
            current = stream.read()
        text = current.decode("utf-8", errors="replace")
        process_marker = f"[{self.worker.pid}]"
        process_lines = [line for line in text.splitlines() if process_marker in line]
        return "\n".join(process_lines) if process_lines else text

    @property
    def worker_logs(self) -> list[str]:
        return self._worker_log_buffer.snapshot()

    @property
    def worker_log_dropped_lines(self) -> int:
        return self._worker_log_buffer.dropped_lines

    def reshade_diagnostics(self, limit: int = 300) -> list[str]:
        """Return new log lines from this worker, favoring feature-18 evidence."""
        lines = self.reshade_log_text().splitlines()
        relevant = [
            line
            for line in lines
            if "DLSS 5 Neural Rendering" in line
            or "DLSSNR" in line
            or "feature 18" in line
            or "exception" in line.lower()
            or "failed" in line.lower()
        ]
        return (relevant or lines)[-limit:]

    def process(
        self,
        *,
        index: int,
        rgba: np.ndarray,
        motion: np.ndarray,
        reset: bool,
        pts: int,
    ) -> tuple[np.ndarray, int]:
        if self.controller.cancel.is_set():
            raise Cancelled("Render stopped by user.")
        if self.closed:
            raise RuntimeError("The native DLSS session is closed.")
        if self._streaming and (
            index != self._processed_frames or self._processed_frames >= 0xFFFFFFFF
        ):
            raise ValueError("Streaming native frames must have consecutive uint32 indices.")
        assert self.worker.stdin is not None and self.worker.stdout is not None
        frame_header = struct.pack("<4Iq", FRAME_MAGIC, index, int(reset), 0, pts)
        self.worker.stdin.write(frame_header)
        self.worker.stdin.write(_array_bytes(rgba, np.dtype(np.uint8)))
        self.worker.stdin.write(_array_bytes(motion, np.dtype(np.float16)))
        self.worker.stdin.flush()
        try:
            result_header = _read_exact(self.worker.stdout, struct.calcsize("<5Iq"))
        except EOFError as exc:
            worker_code = self.worker.wait(timeout=10)
            self.worker_thread.join(timeout=2)
            details = classify_worker_failure(
                worker_code=worker_code,
                frame_index=index,
                worker_logs=self.worker_logs,
                reshade_lines=self.reshade_diagnostics(),
                gpu=self.gpu,
                runtime_bundle=self.runtime_bundle,
            )
            raise RuntimeError(details) from exc
        magic, out_index, ok, byte_count, ngx_result, out_pts = struct.unpack(
            "<5Iq", result_header
        )
        expected = self.output_width * self.output_height * 4
        if (magic != OUT_MAGIC or not ok or out_index != index
                or byte_count != expected or out_pts != pts):
            raise RuntimeError(f"Invalid native worker response for frame {index}")
        if ngx_result != 1:
            raise RuntimeError(
                f"Direct feature-18 evaluation failed on frame {index}: 0x{ngx_result:08X}"
            )
        output = np.empty((self.output_height, self.output_width, 4), dtype=np.uint8)
        _read_exact_into(self.worker.stdout, output)
        self._processed_frames += 1
        return output, out_pts

    def close(self) -> None:
        if self.closed:
            return
        try:
            if self.controller.cancel.is_set():
                raise Cancelled("Render stopped by user.")
            if self._streaming:
                if not self._processed_frames:
                    raise RuntimeError("The input video contains no decodable frames.")
                assert self.worker.stdin is not None
                self.worker.stdin.write(struct.pack(
                    "<4Iq", END_MAGIC, self._processed_frames, 0, 0, 0,
                ))
                self.worker.stdin.flush()
            if self.worker.stdin and not self.worker.stdin.closed:
                self.worker.stdin.close()
            # The completion response is only 28 bytes and fits in the pipe.
            # Wait first so a missing acknowledgement cannot block past this timeout.
            worker_code = self.worker.wait(timeout=60)
            self.worker_thread.join(timeout=2)
            if self.controller.cancel.is_set():
                raise Cancelled("Render stopped by user.")
            if worker_code:
                raise RuntimeError(
                    "Native DLSS worker failed:\n" + "\n".join(self.worker_logs[-40:])
                )
            if self._streaming:
                assert self.worker.stdout is not None
                acknowledgement = struct.unpack(
                    "<5Iq", _read_exact(self.worker.stdout, struct.calcsize("<5Iq"))
                )
                if acknowledgement != (END_MAGIC, self._processed_frames, 1, 0, 1, 0):
                    raise RuntimeError("Native DLSS worker returned an invalid completion count.")
            self.completed_frames = self._processed_frames
            self.controller.unregister(self.worker)
            self.closed = True
            for stream in (self.worker.stdout, self.worker.stderr):
                if stream is not None and not stream.closed:
                    stream.close()
        except BaseException:
            with suppress(Exception):
                self.abort()
            raise

    def abort(self) -> None:
        if self.closed:
            return
        if self.worker.poll() is None:
            try:
                self.worker.terminate()
                self.worker.wait(timeout=10)
            except (OSError, subprocess.TimeoutExpired):
                try:
                    self.worker.kill()
                except OSError:
                    pass
                self.worker.wait(timeout=5)
        self.worker_thread.join(timeout=2)
        self.controller.unregister(self.worker)
        self.closed = True

        for stream in (self.worker.stdin, self.worker.stdout, self.worker.stderr):
            if stream is not None and not stream.closed:
                try:
                    stream.close()
                except OSError:
                    pass


def verify_feature_18(
    worker_logs: list[str], reshade_log: str | None = None
) -> dict[str, object]:
    if reshade_log is None:
        reshade_log_path = RESHADE_LOG
        reshade_log = (
            reshade_log_path.read_text(encoding="utf-8", errors="replace")
            if reshade_log_path.exists()
            else ""
        )
    feature_created = "feature 18 created via the signed snippet" in reshade_log
    feature_evaluated = "inline feature 18 evaluation succeeded" in reshade_log
    runtime_initialized = "signed DLSSNR 310.8.0 D3D12 runtime initialized" in reshade_log
    if not (runtime_initialized and feature_created and feature_evaluated):
        evidence = "\n".join(
            line
            for line in reshade_log.splitlines()
            if "DLSS 5 Neural Rendering" in line
            or "DLSSNR" in line
            or "feature 18" in line
        )
        raise RuntimeError(
            "The carrier render completed, but signed DLSSNR feature-18 execution was not "
            "verified.\n"
            + (evidence[-6000:] or "ReShade produced no DLSSNR evidence.")
        )
    carrier_matches = re.findall(
        r"DLSS carrier ready:.*result=0x([0-9A-Fa-f]{8})", "\n".join(worker_logs)
    )
    return {
        "reshade_log": reshade_log,
        "nr_upscaling_active": "[upscaling]" in reshade_log and feature_evaluated,
        "nr_native_fallback": "NR upscaling fell back to native" in reshade_log,
        "carrier_create_result": (
            f"0x{carrier_matches[-1].upper()}" if carrier_matches else "unreported"
        ),
        "evidence": [
            line
            for line in reshade_log.splitlines()
            if "signed DLSSNR" in line
            or "feature 18 created" in line
            or "feature 18 evaluation succeeded" in line
            or "NR upscaling fell back" in line
        ],
    }

@dataclass(slots=True)
class PreparedRuntime:
    """Reusable, source-independent state prepared once for this process."""

    gpu: dict[str, Any]
    gpus: tuple[dict[str, Any], ...]
    runtime_bundle: dict[str, Any]
    encoder_inventory: dict[str, bool]
    warmed_files: tuple[str, ...]
    _mappings: list[mmap.mmap] = field(default_factory=list, repr=False)

    def close(self) -> None:
        while self._mappings:
            mapping = self._mappings.pop()
            try:
                mapping.close()
            except (BufferError, OSError):
                pass


_PREPARE_LOCK = threading.Lock()
_PREPARED: PreparedRuntime | None = None


def _warm_mapping(path: Path) -> mmap.mmap | None:
    if not path.is_file() or path.stat().st_size == 0:
        return None
    with path.open("rb") as stream:
        mapping = mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ)
    # Touch regularly spaced pages. Sequential hashing already warms the largest
    # model; this also covers un-hashed loader and FFmpeg components.
    checksum = 0
    for offset in range(0, len(mapping), 64 * 1024):
        checksum ^= mapping[offset]
    checksum ^= mapping[-1]
    del checksum
    return mapping


def _encoder_inventory() -> dict[str, bool]:
    result = subprocess.run(
        [str(FFMPEG), "-hide_banner", "-encoders"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or "FFmpeg encoder inventory failed.")
    output = result.stdout
    return {
        "h264_nvenc": "h264_nvenc" in output,
        "hevc_nvenc": "hevc_nvenc" in output,
        "av1_nvenc": "av1_nvenc" in output,
        "prores_ks": "prores_ks" in output,
    }

def prepare_runtime() -> PreparedRuntime:
    """Prepare all reusable runtime state before UI launch or first conversion."""
    global _PREPARED
    if _PREPARED is not None:
        return _PREPARED
    with _PREPARE_LOCK:
        if _PREPARED is not None:
            return _PREPARED

        validate_runtime_files()
        gpus = detect_gpus()
        runtime_bundle = inspect_runtime_bundle()
        gpu = resolve_runtime_ai_gpu(gpus, runtime_bundle)
        inventory = _encoder_inventory()

        paths = (
            WORKER,
            HOST_DXGI,
            ADDON,
            DLSS_SUPERRES,
            NEURAL_RUNTIME,
            FFMPEG,
            FFPROBE,
        )
        mappings: list[mmap.mmap] = []
        try:
            for path in paths:
                mapping = _warm_mapping(path)
                if mapping is not None:
                    mappings.append(mapping)
        except Exception:
            for mapping in mappings:
                mapping.close()
            raise

        _PREPARED = PreparedRuntime(
            gpu=dict(gpu),
            gpus=tuple(dict(device) for device in gpus),
            runtime_bundle=runtime_bundle,
            encoder_inventory=inventory,
            warmed_files=tuple(str(path.resolve()) for path in paths),
            _mappings=mappings,
        )
        return _PREPARED


def close_prepared_runtime() -> None:
    global _PREPARED
    with _PREPARE_LOCK:
        prepared = _PREPARED
        _PREPARED = None
    if prepared is not None:
        prepared.close()

atexit.register(close_prepared_runtime)
