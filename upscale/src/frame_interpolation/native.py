from __future__ import annotations

import collections
import struct
import subprocess
import threading
from fractions import Fraction

import numpy as np

from ..core.jobs import Cancelled, JobController
from .capabilities import DLSSG_WORKER, RUNTIME_DIR


SETUP_MAGIC = 0x31534746
SETUP_OUT_MAGIC = 0x31524746
FRAME_MAGIC = 0x31464746
FRAME_OUT_MAGIC = 0x314F4746


def _read_into_exact(stream, destination) -> None:
    view = memoryview(destination).cast("B")
    offset = 0
    while offset < len(view):
        count = stream.readinto(view[offset:])
        if not count:
            raise RuntimeError("The direct DLSSG worker closed its output unexpectedly.")
        offset += count


def _read_exact(stream, size: int) -> bytes:
    data = bytearray(size)
    _read_into_exact(stream, data)
    return bytes(data)


def _write_all(stream, source) -> None:
    view = memoryview(source).cast("B")
    offset = 0
    while offset < len(view):
        count = stream.write(view[offset:])
        if not count:
            raise RuntimeError("The direct DLSSG worker closed its input unexpectedly.")
        offset += count


class DirectDLSSGSession:
    """One direct D3D12 NGX DLSSG history and binary stream."""

    def __init__(
        self,
        width: int,
        height: int,
        frame_count: int,
        generated_count: int,
        controller: JobController,
    ) -> None:
        if not DLSSG_WORKER.is_file():
            raise RuntimeError(f"Direct DLSSG worker is missing: {DLSSG_WORKER}")
        self.width = int(width)
        self.height = int(height)
        self.frame_bytes = self.width * self.height * 4
        self.generated_count = int(generated_count)
        self.controller = controller
        self.logs: collections.deque[str] = collections.deque(maxlen=300)
        command = [str(DLSSG_WORKER), "--serve"]
        self.process = subprocess.Popen(
            command,
            cwd=str(RUNTIME_DIR),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        controller.register(self.process)
        assert self.process.stdin is not None
        assert self.process.stdout is not None
        assert self.process.stderr is not None
        self._log_thread = threading.Thread(target=self._read_logs, daemon=True)
        self._log_thread.start()
        self.closed = False
        self._next_index = 0
        try:
            self._setup(frame_count)
        except BaseException:
            self.abort()
            self.close()
            raise

    def _setup(self, frame_count: int) -> None:
        _write_all(
            self.process.stdin,
            struct.pack(
                "<5I",
                SETUP_MAGIC,
                self.width,
                self.height,
                max(1, int(frame_count)),
                self.generated_count,
            )
        )
        self.process.stdin.flush()
        magic, status, maximum, _reserved = struct.unpack(
            "<4I", _read_exact(self.process.stdout, struct.calcsize("<4I"))
        )
        if magic != SETUP_OUT_MAGIC or status:
            self.close()
            raise RuntimeError(
                f"DLSSG session creation failed (status {status}); runtime maximum is "
                f"{maximum + 1}×.\n{self.log_text()}"
            )
        if self.generated_count > maximum:
            self.close()
            raise RuntimeError(
                f"DLSSG worker rejected {self.generated_count} generated frame(s); "
                f"MultiFrameCountMax is {maximum}."
            )

    def _read_logs(self) -> None:
        assert self.process.stderr is not None
        for raw in iter(self.process.stderr.readline, b""):
            self.logs.append(raw.decode("utf-8", "replace").rstrip())

    def log_text(self) -> str:
        return "\n".join(self.logs)

    def process_frame(
        self,
        rgba: np.ndarray,
        motion: np.ndarray,
        timestamp: Fraction,
        *,
        reset: bool,
    ) -> list[np.ndarray]:
        if self.closed:
            raise RuntimeError("DLSSG session is closed.")
        if self.controller.cancel.is_set():
            raise Cancelled("Frame interpolation was cancelled.")
        color = np.ascontiguousarray(rgba, dtype=np.uint8)
        vectors = np.ascontiguousarray(motion, dtype=np.float16)
        if color.shape != (self.height, self.width, 4):
            raise ValueError(f"DLSSG color frame has unexpected shape {color.shape}.")
        if vectors.shape != (self.height, self.width, 2):
            raise ValueError(f"DLSSG motion field has unexpected shape {vectors.shape}.")
        assert self.process.stdin is not None
        assert self.process.stdout is not None
        _write_all(
            self.process.stdin,
            struct.pack(
                "<4I2q",
                FRAME_MAGIC,
                self._next_index,
                int(reset),
                0,
                timestamp.numerator,
                timestamp.denominator,
            )
        )
        _write_all(self.process.stdin, color)
        _write_all(self.process.stdin, vectors)
        self.process.stdin.flush()
        self._next_index += 1
        magic, status, generated, disabled = struct.unpack(
            "<4I", _read_exact(self.process.stdout, struct.calcsize("<4I"))
        )
        if magic != FRAME_OUT_MAGIC or status:
            raise RuntimeError(
                f"DLSSG evaluation failed at input frame {self._next_index - 1} "
                f"(status {status}).\n{self.log_text()}"
            )
        if generated > self.generated_count or (disabled and generated):
            raise RuntimeError("DLSSG worker returned an invalid generated-frame count.")
        if disabled:
            return []
        frames = []
        for _ in range(generated):
            # Each returned array owns its storage until every downstream user
            # releases it. Reading into it avoids three full-frame copies.
            frame = np.empty((self.height, self.width, 4), dtype=np.uint8)
            _read_into_exact(self.process.stdout, frame)
            frames.append(frame)
        return frames

    def abort(self) -> None:
        if self.process.poll() is None:
            try:
                self.process.terminate()
            except OSError:
                pass

    def close(self) -> None:
        if getattr(self, "closed", False):
            return
        self.closed = True
        process = self.process
        try:
            if process.stdin and not process.stdin.closed:
                process.stdin.close()
        except OSError:
            pass
        try:
            process.wait(timeout=20)
        except subprocess.TimeoutExpired:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        self.controller.unregister(process)
        self._log_thread.join(timeout=1)
        for stream in (process.stdout, process.stderr):
            if stream is not None:
                stream.close()

    def __enter__(self) -> "DirectDLSSGSession":
        return self

    def __exit__(self, *_args) -> None:
        self.close()
