from __future__ import annotations

import json
import os
import subprocess
from functools import lru_cache
from pathlib import Path

from ..core.paths import DLSSG_DIR
from ..core.gpu_selection import detect_gpu
from .models import FrameInterpolationCapabilities


RUNTIME_DIR = DLSSG_DIR
DLSSG_RUNTIME = RUNTIME_DIR / "nvngx_dlssg.dll"
DLSSG_WORKER = RUNTIME_DIR / "dlssg-worker.exe"
def _hags_enabled() -> bool:
    if os.name != "nt":
        return False
    try:
        import winreg

        with winreg.OpenKey(
            winreg.HKEY_LOCAL_MACHINE,
            r"SYSTEM\CurrentControlSet\Control\GraphicsDrivers",
        ) as key:
            value, _kind = winreg.QueryValueEx(key, "HwSchMode")
        return int(value) == 2
    except (OSError, ValueError):
        return False


def _authenticode_status(path: Path) -> str:
    if os.name != "nt":
        return "Unavailable"
    escaped = str(path.resolve()).replace("'", "''")
    try:
        process = subprocess.run(
            [
                "powershell.exe",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Import-Module \"$env:WINDIR\\System32\\WindowsPowerShell\\v1.0\\Modules\\"
                "Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1\"; "
                f"[string](Get-AuthenticodeSignature -LiteralPath '{escaped}').Status",
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=15,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.TimeoutExpired):
        return "Unavailable"
    return process.stdout.strip() if process.returncode == 0 else "Unavailable"


def _probe_worker() -> dict:
    if not DLSSG_WORKER.is_file():
        raise RuntimeError(f"DLSSG worker is missing: {DLSSG_WORKER}")
    command = [str(DLSSG_WORKER), "--probe"]
    process = subprocess.run(
        command,
        cwd=str(RUNTIME_DIR),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=45,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if process.returncode:
        detail = process.stderr.strip() or process.stdout.strip()
        raise RuntimeError(detail or f"DLSSG capability probe exited with {process.returncode}.")
    lines = [line for line in process.stdout.splitlines() if line.strip()]
    if not lines:
        raise RuntimeError("DLSSG capability probe returned no result.")
    return json.loads(lines[-1])


@lru_cache(maxsize=32)
def probe_frame_interpolation_capabilities(
    ai_gpu_uuid: str = "auto",
) -> FrameInterpolationCapabilities:
    gpu = detect_gpu(ai_gpu_uuid)
    gpu_name = str(gpu.get("display_name") or gpu.get("name") or "NVIDIA RTX GPU")
    driver = str(gpu.get("driver") or "unknown")
    hags = _hags_enabled()
    if not DLSSG_RUNTIME.is_file():
        return FrameInterpolationCapabilities(
            available=False,
            gpu=gpu_name,
            driver=driver,
            hags_enabled=hags,
            native_generated_frame_max=0,
            native_multiplier=1,
            cascade_available=False,
            runtime_version="missing",
            worker_version="missing",
            signature_status="Missing",
            detail=f"NVIDIA DLSSG runtime is missing: {DLSSG_RUNTIME}",
            gpu_uuid=str(gpu.get("uuid") or ai_gpu_uuid),
        )
    if not DLSSG_WORKER.is_file():
        return FrameInterpolationCapabilities(
            available=False,
            gpu=gpu_name,
            driver=driver,
            hags_enabled=hags,
            native_generated_frame_max=0,
            native_multiplier=1,
            cascade_available=False,
            runtime_version="unknown",
            worker_version="missing",
            signature_status=_authenticode_status(DLSSG_RUNTIME),
            detail=f"Direct D3D12 DLSSG worker is missing: {DLSSG_WORKER}",
            gpu_uuid=str(gpu.get("uuid") or ai_gpu_uuid),
        )

    signature_status = _authenticode_status(DLSSG_RUNTIME)
    try:
        probed = _probe_worker()
        generated_max = max(0, int(probed.get("multi_frame_count_max", 0)))
        multiplier = generated_max + 1 if generated_max else 1
        available = bool(probed.get("available", False)) and generated_max >= 1
        detail = str(probed.get("detail") or "")
    except Exception as exc:
        generated_max = 0
        multiplier = 1
        available = False
        detail = str(exc)
        probed = {}

    diagnostic_notes: list[str] = []
    if not hags:
        diagnostic_notes.append("HAGS is disabled; the native runtime may reject Frame Generation.")
    if signature_status not in {"Valid", "Unavailable"}:
        diagnostic_notes.append(
            f"Authenticode status is {signature_status}; this is diagnostic only and is not blocked."
        )
    if diagnostic_notes:
        detail = " ".join([part for part in [detail, *diagnostic_notes] if part])

    return FrameInterpolationCapabilities(
        available=available,
        gpu=gpu_name,
        driver=driver,
        hags_enabled=hags,
        native_generated_frame_max=generated_max,
        native_multiplier=multiplier,
        cascade_available=available and multiplier >= 2,
        runtime_version=str(probed.get("runtime_version") or "unknown"),
        worker_version=str(probed.get("worker_version") or "unknown"),
        signature_status=signature_status,
        detail=detail,
        gpu_uuid=str(gpu.get("uuid") or ai_gpu_uuid),
    )


def clear_capability_cache() -> None:
    probe_frame_interpolation_capabilities.cache_clear()
