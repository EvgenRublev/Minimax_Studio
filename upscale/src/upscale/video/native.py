from __future__ import annotations

import collections
import ctypes
import json
import struct
import subprocess
import threading
import time
from contextlib import nullcontext, suppress
from functools import lru_cache

from ...core.gpu_detection import detect_gpus
from ...core.gpu_selection import resolve_ai_gpu
from ...core.jobs import Cancelled, JobController, current_job_controller, use_job_controller
from ...core.paths import RUNTIME
from .models import UpscaleCapabilities, UpscaleOptions

RUNTIME_DIR = RUNTIME / "rtx_video"
WORKER = RUNTIME_DIR / "rtx-video-worker.exe"
MAGIC, FRAME, VERSION = 0x31585452, 0x314D5246, 1


def gpu_luid(gpu: dict) -> str:
    driver = ctypes.WinDLL("nvcuda.dll")
    device, mask = ctypes.c_int(), ctypes.c_uint()
    luid = (ctypes.c_char * 8)()
    if driver.cuInit(0) or driver.cuDeviceGet(ctypes.byref(device), int(gpu["cuda_ordinal"])) or driver.cuDeviceGetLuid(luid, ctypes.byref(mask), device):
        raise RuntimeError("Cannot match the selected NVIDIA GPU to its DirectX adapter.")
    return bytes(luid).hex()


def runtime_files() -> None:
    for path in (WORKER, RUNTIME_DIR / "nvngx_vsr.dll", RUNTIME_DIR / "nvngx_truehdr.dll"):
        if not path.is_file():
            raise RuntimeError(f"RTX Video runtime is missing: {path}. Rebuild or restore the RTX Video runtime.")


@lru_cache(maxsize=8)
def _probe(luid: str, worker_stamp: int, vsr_stamp: int, hdr_stamp: int) -> dict:
    controller = current_job_controller() or JobController()
    process = subprocess.Popen([str(WORKER), "--probe", "--gpu-luid", luid], cwd=RUNTIME_DIR,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=subprocess.CREATE_NO_WINDOW)
    controller.register(process)
    deadline = time.monotonic() + 90
    try:
        while True:
            if controller.cancel.is_set():
                raise Cancelled("Stopped while checking RTX Video capabilities.")
            if time.monotonic() >= deadline:
                raise RuntimeError("RTX Video capability check timed out. Check the NVIDIA driver and retry.")
            try:
                stdout, stderr = process.communicate(timeout=.2)
                break
            except subprocess.TimeoutExpired:
                continue
        if controller.cancel.is_set():
            raise Cancelled("Stopped while checking RTX Video capabilities.")
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
        controller.unregister(process)
        process.stdout.close()
        process.stderr.close()
    try:
        data = json.loads(stdout)
    except ValueError as exc:
        raise RuntimeError("RTX Video capability probe returned invalid data: " + stderr.decode("utf-8", "replace")[-3000:]) from exc
    if process.returncode or "error" in data:
        raise RuntimeError(data.get("error") or stderr.decode("utf-8", "replace")[-3000:])
    if data.get("protocol_version") != VERSION:
        raise RuntimeError("RTX Video worker version does not match this application.")
    return data


def probe_capabilities(gpu_uuid: str = "auto", *, controller=None) -> UpscaleCapabilities:
    runtime_files()
    gpu = resolve_ai_gpu(detect_gpus(), gpu_uuid)
    luid = gpu_luid(gpu)
    with use_job_controller(controller) if controller is not None else nullcontext():
        if controller is not None and controller.cancel.is_set():
            raise Cancelled("Stopped before checking RTX Video capabilities.")
        data = _probe(luid, *(p.stat().st_mtime_ns for p in (WORKER, RUNTIME_DIR / "nvngx_vsr.dll", RUNTIME_DIR / "nvngx_truehdr.dll")))
    return UpscaleCapabilities(gpu, luid, data["vsr"], data["hdr"], data["sdk_version"], data["worker_version"])


class RTXVideoSession:
    """Bounded synchronous frame exchange with a watchdog and cancellable process."""

    def __init__(self, width: int, height: int, output_width: int, output_height: int,
                 options: UpscaleOptions, input_format: int, capabilities: UpscaleCapabilities,
                 controller: JobController, *, timeout: float = 180):
        options.validate()
        runtime_files()
        for enabled, cap, name in ((options.vsr_enabled, capabilities.vsr, "VSR"), (options.hdr_enabled, capabilities.hdr, "HDR")):
            if enabled and not cap.get("available"):
                raise RuntimeError(f"RTX Video {name} is unavailable on {capabilities.gpu['name']}. "
                                   f"Minimum driver {cap.get('min_driver_major', 0)}.{cap.get('min_driver_minor', 0)}; "
                                   f"initialization result 0x{cap.get('init_result', 0):08X}.")
        self.output_format = (3 if options.hdr_precision == "FP16" else 2) if options.hdr_enabled else input_format
        self.input_bytes = width * height * 4
        self.output_bytes = output_width * output_height * (8 if self.output_format == 3 else 4)
        self.controller, self.timeout = controller, timeout
        self.logs = collections.deque(maxlen=150)
        self.process = subprocess.Popen([str(WORKER), "--serve", "--gpu-luid", capabilities.luid], cwd=RUNTIME_DIR,
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                        bufsize=0, creationflags=subprocess.CREATE_NO_WINDOW)
        controller.register(self.process)
        self.closed = False
        self.completed_frames = 0
        self.last_results = (0, 0)
        self.deadline = time.monotonic() + timeout
        self.timed_out = False
        self._done = threading.Event()
        self._reader = threading.Thread(target=self._read_logs, daemon=True)
        self._guard = threading.Thread(target=self._watchdog, daemon=True)
        self._reader.start(); self._guard.start()
        try:
            self._write(struct.pack("<15I", MAGIC, VERSION, width, height, output_width, output_height,
                                    input_format, self.output_format, options.vsr_enabled, int(options.vsr_quality),
                                    options.hdr_enabled, int(options.hdr_contrast), int(options.hdr_saturation),
                                    int(options.hdr_middle_gray), int(options.hdr_peak_luminance)))
            magic, status, version, ibytes, obytes = struct.unpack("<5I", self._read(20))
            if (magic, status, version, ibytes, obytes) != (MAGIC, 0, VERSION, self.input_bytes, self.output_bytes):
                raise RuntimeError("RTX Video worker returned an invalid setup response.")
            self.deadline = float("inf")
        except BaseException:
            self.close(abort=True)
            raise

    def _read_logs(self):
        for line in iter(self.process.stderr.readline, b""):
            text = line.decode("utf-8", "replace").rstrip()
            if text:
                self.logs.append(text)

    def _watchdog(self):
        while not self._done.wait(.2):
            if time.monotonic() > self.deadline:
                self.timed_out = True
                self.process.kill()
                break

    def _error(self):
        if self.controller.cancel.is_set():
            raise Cancelled("Upscale stopped by user.")
        self._reader.join(timeout=.2)
        detail = "timed out" if self.timed_out else "closed unexpectedly"
        raise RuntimeError(f"RTX Video worker {detail}.\n" + "\n".join(self.logs)[-4000:])

    def _write(self, data):
        view = memoryview(data).cast("B")
        try:
            while view:
                n = self.process.stdin.write(view)
                if not n:
                    self._error()
                view = view[n:]
        except (OSError, ValueError):
            self._error()

    def _read(self, count):
        data = bytearray(count)
        view = memoryview(data)
        while view:
            n = self.process.stdout.readinto(view)
            if not n:
                self._error()
            view = view[n:]
        return data

    def process_frame(self, pixels) -> bytearray:
        if self.closed:
            raise RuntimeError("RTX Video session is closed.")
        if self.controller.cancel.is_set():
            raise Cancelled("Upscale stopped by user.")
        if memoryview(pixels).nbytes != self.input_bytes:
            raise ValueError("Incorrect RTX Video input frame byte count.")
        self.deadline = time.monotonic() + self.timeout
        try:
            self._write(struct.pack("<3I", FRAME, self.completed_frames, self.input_bytes))
            self._write(pixels)
            magic, index, status, size, vsr, hdr = struct.unpack("<6I", self._read(24))
            if (magic, index) != (FRAME, self.completed_frames):
                raise RuntimeError("RTX Video frame identity mismatch.")
            if status:
                raise RuntimeError(f"RTX Video evaluation failed: VSR=0x{vsr:08X}, HDR=0x{hdr:08X}.")
            if size != self.output_bytes:
                raise RuntimeError("RTX Video output frame byte count mismatch.")
            result = self._read(size)
            self.completed_frames += 1
            self.last_results = (vsr, hdr)
            return result
        finally:
            self.deadline = float("inf")

    def close(self, *, abort=False):
        if self.closed:
            return
        self.closed = True
        self._done.set()
        try:
            if abort and self.process.poll() is None:
                self.process.terminate()
            with suppress(OSError):
                self.process.stdin.close()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill(); self.process.wait(timeout=5)
        finally:
            self.controller.unregister(self.process)
            self._reader.join(timeout=1)
            self._guard.join(timeout=1)
            for stream in (self.process.stdout, self.process.stderr):
                stream.close()
        if not abort and self.process.returncode:
            raise RuntimeError("RTX Video worker failed during shutdown.\n" + "\n".join(self.logs)[-3000:])

    def __enter__(self):
        return self

    def __exit__(self, exc_type, *_):
        self.close(abort=exc_type is not None)
