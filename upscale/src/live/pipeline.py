from __future__ import annotations

import atexit
import json
import math
import os
import queue
import re
import shutil
import subprocess
import threading
import time
from dataclasses import asdict, replace
from pathlib import Path

import av
import numpy as np

from ..core.gpu_selection import resolve_runtime_ai_gpu
from ..core.jobs import BoundedLogBuffer, Cancelled, JobController, active_job, drain_bounded_text
from ..core.paths import FFMPEG, LIVE_DIR, LOGS
from ..core.runtime import (DLSSFrameSession, prepare_runtime, resolve_native_settings,
                            resolve_output_size, resolve_upscaling_mode, verify_feature_18)
from ..settings.storage import processing_gpu_settings
from ..neural_rendering.video.guides import TemporalGuideGenerator
from .effects import EffectSettings, EffectUpdates, NativeDeadline, EFFECT_REPLACEMENT_TIMEOUT
from .hls_server import HlsServer
from .models import (LIVE_FRAME_COUNT, LIVE_FPS_CHOICES, LIVE_GUIDE_CHOICES,
                     LIVE_MAX_HEIGHTS, LIVE_SOURCE_QUALITY_CHOICES, LiveOptions, LiveSessionInfo, ResolvedSource)
from .player import check_live_binaries, launch_mpv
from .source_resolver import _classify, input_args, probe_source, resolve_source, run_capture
from .transport import TIME_BASE, AdaptiveRate, PipeReader, TimestampMuxer, VideoFrame, get, put

_LOCK = threading.Lock()
_CURRENT: LiveSession | None = None
_LAST: LiveSessionInfo | None = None


def _fit_height(width: int, height: int, max_height: int) -> tuple[int, int]:
    scale = min(1.0, max_height / height)
    return max(2, round(width * scale / 2) * 2), max(2, round(height * scale / 2) * 2)


def validate_options(options: LiveOptions) -> None:
    if not options.source.strip():
        raise ValueError("Enter a video file or a stream URL.")
    if options.max_height not in LIVE_MAX_HEIGHTS:
        raise ValueError(f"Max input height must be one of: {', '.join(map(str, LIVE_MAX_HEIGHTS))}.")
    if options.source_quality not in LIVE_SOURCE_QUALITY_CHOICES:
        raise ValueError("Choose a valid Source quality.")
    if options.target_fps not in LIVE_FPS_CHOICES or options.guide_quality not in LIVE_GUIDE_CHOICES:
        raise ValueError("Choose a valid frame rate and motion guide quality.")
    if options.segment_seconds not in (1, 2, 4, 6):
        raise ValueError("Segment length must be 1, 2, 4 or 6 seconds.")
    if not math.isfinite(options.buffer_seconds) or not 2 <= options.buffer_seconds <= 30:
        raise ValueError("Playback buffer must be between 2 and 30 seconds.")
    if not 1 <= options.queue_frames <= 8 or not 5 <= options.network_timeout <= 60:
        raise ValueError("Invalid Live queue size or network timeout.")
    resolve_upscaling_mode(options.upscaling_factor)
    resolve_native_settings(options)


def _redact(text: str) -> str:
    # Keep diagnostic errors, never store signed CDN query tokens.
    return re.sub(r"(https?://[^\s?]+)\?[^\s'\"]+", r"\1?<redacted>", text)


class LiveSession(threading.Thread):
    """Bounded decode/guide -> DLSS -> timestamped encode -> buffered playback."""

    def __init__(self, options: LiveOptions) -> None:
        super().__init__(daemon=True, name="dlss5-live-session")
        self.options = replace(options)
        self.effects = EffectUpdates(options)
        self.controller = JobController()
        self.info = LiveSessionInfo(running=True, processing=True, status="Starting...")
        self._info_lock = threading.Lock()
        self._ready = threading.Event()
        self._produced = threading.Event()
        self._mpv: subprocess.Popen | None = None
        self._session_dir: Path | None = None
        self._player_attempted = False
        self._player_state: dict = {}
        self._playback_started: float | None = None
        self._last_ui = 0.0
        self._last_progress = time.monotonic()
        self._error: str | None = None
        self._error_lock = threading.Lock()
        self._logs: dict[str, BoundedLogBuffer] = {}
        self._log_threads: list[threading.Thread] = []
        self._rate: AdaptiveRate | None = None
        self._native_logs: list[str] = []
        self._feature_evidence: dict = {}
        self._title = ""
        self._published_seconds = 0.0
        self._published_sequence = -1
        self._segment_count = 0
        self._first_frame_at: float | None = None
        self._finished = False
        self._started_at = time.monotonic()

    def _set(self, **fields) -> None:
        with self._info_lock:
            for key, value in fields.items():
                setattr(self.info, key, value)

    def snapshot(self) -> LiveSessionInfo:
        effects = self.effects.snapshot()
        with self._info_lock:
            return replace(self.info, failures=list(self.info.failures), **effects)

    def request_effects(self, settings) -> bool:
        return self.effects.submit(settings)

    def stop(self) -> None:
        self.effects.finish()
        if self.info.processing:
            self._set(status="Stopping...")
        self.controller.stop()

    def _stage_error(self, stage: str, exc: Exception) -> None:
        with self._error_lock:
            if self._error is None and not self.controller.cancel.is_set():
                self._error = _redact(f"{stage}: {exc}")
        self.controller.stop()

    def _spawn(self, name: str, command: list[str], **kwargs) -> subprocess.Popen:
        process = subprocess.Popen(command, stderr=subprocess.PIPE,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), **kwargs)
        self.controller.register(process)
        log = self._logs[name] = BoundedLogBuffer(max_tail=80)
        thread = threading.Thread(target=drain_bounded_text, args=(process.stderr, log), daemon=True)
        thread.start()
        self._log_threads.append(thread)
        return process

    def _process_error(self, name: str, process: subprocess.Popen) -> RuntimeError:
        detail = "\n".join(self._logs[name].snapshot()[-12:])
        return RuntimeError(_redact(f"{name} exited with code {process.returncode}.\n{detail}"))

    def _remember_native(self, native) -> None:
        self._native_logs = [*self._native_logs, *native.worker_logs][-500:]

    def _verified_effect_worker(self, settings: EffectSettings, native_args: dict,
                                item: VideoFrame, index: int):
        native = None
        try:
            with NativeDeadline(self.controller, EFFECT_REPLACEMENT_TIMEOUT) as deadline:
                native = DLSSFrameSession(**native_args, controller=deadline,
                                         native_settings=resolve_native_settings(settings))
                start = time.perf_counter()
                output, pts = native.process(index=index, rgba=item.rgba, motion=item.motion,
                                             reset=True, pts=item.pts)
                cost = time.perf_counter() - start
                if pts != item.pts:
                    raise RuntimeError("Replacement DLSS worker returned a different frame timestamp.")
                evidence = verify_feature_18(native.worker_logs, native.reshade_log_text())
            self._feature_evidence = {k: v for k, v in evidence.items() if k != "reshade_log"}
            return native, output, cost
        except Exception:
            if native is not None:
                self._remember_native(native)
                native.abort()
            raise

    def _replace_effects(self, native, request, native_args: dict, item: VideoFrame, index: int):
        start = time.perf_counter()
        self._remember_native(native)
        native.abort()  # release resources/config/log ownership before starting another
        error = ""
        try:
            replacement, output, cost = self._verified_effect_worker(request.settings, native_args, item, index)
        except Cancelled:
            raise
        except Exception as exc:
            if self.controller.cancel.is_set():
                raise Cancelled("Live stopped.") from exc
            error = _redact(str(exc))
            try:
                replacement, output, cost = self._verified_effect_worker(self.effects.applied, native_args, item, index)
            except Cancelled:
                raise
            except Exception as recovery:
                detail = f"{error}; recovery failed: {_redact(str(recovery))}"
                self.effects.complete(request, pts=item.pts, milliseconds=(time.perf_counter()-start)*1000,
                                      error=detail, restored=False)
                raise RuntimeError(detail) from recovery
        self.effects.complete(request, pts=item.pts, milliseconds=(time.perf_counter()-start)*1000,
                              error=error, worker_pid=getattr(getattr(replacement, "worker", None), "pid", None))
        self._rate.reset_measurements()
        self._last_progress = time.monotonic()
        self._write_report()
        return replacement, output, cost

    def _select_encoder(self, gpus: tuple, selected_uuid: str, width: int, height: int) -> tuple[bool, int | None]:
        candidates = [g for g in gpus if g.get("cuda_ordinal") is not None
                      and (selected_uuid == "auto" or g.get("uuid") == selected_uuid)]
        for gpu in candidates:
            ordinal = int(gpu["cuda_ordinal"])
            try:
                result = run_capture([str(FFMPEG), "-v", "error", "-f", "lavfi", "-i",
                    f"color=size={width}x{height}:rate=1", "-frames:v", "1", "-c:v", "h264_nvenc",
                    "-gpu", str(ordinal), "-f", "null", "-"], self.controller, 15)
                if result.returncode == 0:
                    return True, ordinal
            except Cancelled:
                raise
            except RuntimeError:
                continue
        # Live has always allowed a CPU fallback. Probe it via the real encoder
        # startup, and include its cost in automatic cadence selection.
        return False, None

    def _decoder_command(self, source: ResolvedSource, width: int, height: int, rate) -> list[str]:
        opts = self.options
        command = [str(FFMPEG), "-hide_banner", "-loglevel", "warning", "-nostdin", "-filter_threads", "2"]
        # HLS broadcasts can jump clocks at reconnects/ad boundaries. Let
        # FFmpeg repair those jumps for both streams before preserving the
        # resulting timeline through DLSS. copyts disables that repair.
        command += (["-dts_delta_threshold", "2"] if source.is_live
                    else ["-copyts", "-start_at_zero"])
        command += [*input_args(source.video_url, source.video_headers, opts.network_timeout),
                    "-thread_queue_size", "32", "-i", source.video_url]
        audio_input = "0"
        if source.audio_url and source.audio_url != source.video_url:
            command += [*input_args(source.audio_url, source.audio_headers, opts.network_timeout),
                        "-thread_queue_size", "32", "-i", source.audio_url]
            audio_input = "1"
        # FFmpeg autorotates once. Explicit transpose here used to rotate twice.
        filters = [] if opts.target_fps == "Source" else [f"fps={rate}"]
        filters += [f"scale={width}:{height}:flags=fast_bilinear", "setsar=1"]
        command += ["-map", "0:v:0", "-map", f"{audio_input}:a:0?", "-sn", "-dn",
                    "-vf", ",".join(filters),
                    "-c:v", "rawvideo", "-pix_fmt", "rgba", "-threads:v", "1",
                    "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2",
                    "-af", "aresample=async=1:first_pts=0",
                    "-fps_mode", "passthrough", "-f", "nut", "-write_index", "0", "pipe:1"]
        return command

    def _encoder_command(self, rate, gpu: int | None, nvenc: bool) -> list[str]:
        opts = self.options
        if nvenc:
            video = ["-c:v", "h264_nvenc"]
            if gpu is not None:
                video += ["-gpu", str(gpu)]
            video += ["-preset", "p1", "-tune", "ll", "-rc", "vbr", "-cq", "23", "-b:v", "0",
                      "-rc-lookahead", "0", "-zerolatency", "1", "-bf", "0", "-forced-idr", "1"]
        else:
            video = ["-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-crf", "23",
                     "-sc_threshold", "0"]
        # Timestamps from NUT survive frame selection. There is no -r or CFR
        # conversion after DLSS to squeeze skipped source time out of the video.
        return [str(FFMPEG), "-hide_banner", "-loglevel", "warning", "-nostdin", "-y",
            "-filter_threads", "2", "-probesize", "32768", "-analyzeduration", "0",
            "-f", "nut", "-i", "pipe:0", "-map", "0:v:0", "-map", "0:a:0?",
            *video, "-pix_fmt", "yuv420p", "-fps_mode", "passthrough", "-enc_time_base", "1:90000",
            "-g", str(max(1, math.ceil(float(rate) * opts.segment_seconds))),
            "-force_key_frames", f"expr:gte(t,n_forced*{opts.segment_seconds})",
            "-c:a", "aac", "-b:a", "160k", "-max_interleave_delta", "1000000",
            "-f", "hls", "-hls_time", str(opts.segment_seconds),
            "-hls_list_size", str(max(12, math.ceil((opts.buffer_seconds + 60) / opts.segment_seconds))),
            "-hls_delete_threshold", "6", "-hls_flags", "delete_segments+independent_segments+temp_file",
            "-hls_segment_filename", "seg%07d.ts", "index.m3u8"]

    def _decode(self, decoder: subprocess.Popen, prepared: queue.Queue, width: int, height: int) -> None:
        assert self._rate is not None
        rate = self._rate
        try:
            with av.open(PipeReader(decoder.stdout), format="nut", options={"probesize": "32768", "analyzeduration": "0"}) as container:
                audio = next(iter(container.streams.audio), None)
                put(prepared, audio, self.controller.cancel)  # stream header (None means silent)
                guides = TemporalGuideGenerator(width, height,
                    flow_width=320 if self.options.guide_quality == "Fast" else 640)
                index = 0
                last_pts: int | None = None
                sampled = 0
                for packet in container.demux():
                    if self.controller.cancel.is_set():
                        raise Cancelled("Live stopped.")
                    if not packet.size:
                        continue
                    self._last_progress = time.monotonic()
                    if packet.stream.type == "audio":
                        put(prepared, packet, self.controller.cancel)
                        continue
                    if packet.stream.type != "video":
                        continue
                    pts = round(packet.pts * packet.time_base / TIME_BASE)
                    current = index
                    index += 1
                    self._set(source_frames=index)
                    if not rate.accepts(current):
                        sampled += 1
                        self._set(sampled_frames=sampled)
                        continue
                    if packet.size != width * height * 4:
                        raise RuntimeError("Decoder returned an incomplete RGBA frame.")
                    rgba = np.frombuffer(packet, np.uint8).reshape(height, width, 4)
                    start = time.perf_counter()
                    guide = guides.process(rgba)
                    guide_ms = (time.perf_counter() - start) * 1000
                    old = self.snapshot().guide_ms
                    self._set(guide_ms=guide_ms if not old else old * 0.9 + guide_ms * 0.1)
                    # Temporal history spans the selected cadence, but a real
                    # timestamp discontinuity must reset both guide and DLSS.
                    discontinuity = last_pts is not None and (pts <= last_pts or (pts - last_pts) * TIME_BASE > 0.5)
                    if discontinuity:
                        guides.previous_gray = None
                    duration = (max(1, round(packet.duration * packet.time_base / TIME_BASE))
                                if self.options.target_fps == "Source" and packet.duration
                                else max(1, round(1 / rate.fps / TIME_BASE)))
                    put(prepared, VideoFrame(current, pts, duration, rgba, guide.motion,
                                             guide.reset or discontinuity), self.controller.cancel)
                    last_pts = pts
                code = decoder.wait(timeout=5)
                if code:
                    raise self._process_error("decoder", decoder)
                if not index:
                    raise RuntimeError("The decoder produced no video frames.")
                put(prepared, None, self.controller.cancel)
        except Cancelled:
            pass
        except Exception as exc:
            self._stage_error("Decode / motion guides", exc)

    def _encode(self, encoder: subprocess.Popen, outgoing: queue.Queue, width: int, height: int) -> None:
        muxer = None
        try:
            audio = get(outgoing, self.controller.cancel)
            muxer = TimestampMuxer(encoder.stdin, width, height, self._rate.rate, audio)
            while True:
                item = get(outgoing, self.controller.cancel)
                if item is None:
                    break
                start = time.perf_counter()
                muxer.write(item)
                if isinstance(item, VideoFrame):
                    cost = (time.perf_counter() - start) * 1000
                    old = self.snapshot().encode_ms
                    self._set(encode_ms=cost if not old else old * 0.9 + cost * 0.1,
                              media_seconds=float((item.pts + item.duration) * TIME_BASE))
                self._last_progress = time.monotonic()
            muxer.close()
            muxer = None
            encoder.stdin.close()
            code = encoder.wait(timeout=30)
            if code:
                raise self._process_error("encoder", encoder)
        except Cancelled:
            pass
        except Exception as exc:
            if encoder.poll() is not None and not self.controller.cancel.is_set():
                exc = self._process_error("encoder", encoder)
            self._stage_error("Encode / audio mux", exc)
        finally:
            if muxer:
                try:
                    muxer.close()
                except Exception:
                    pass

    def _playlist(self) -> tuple[int, float]:
        try:
            lines = (self._session_dir / "index.m3u8").read_text(encoding="utf-8").splitlines()
        except OSError:
            return 0, 0.0
        sequence = 0
        duration = 0.0
        count = 0
        for line in lines:
            if line.startswith("#EXT-X-MEDIA-SEQUENCE:"):
                sequence = int(line.split(":")[1])
            elif line.startswith("#EXTINF:"):
                duration = float(line.split(":")[1].split(",")[0])
            elif line and not line.startswith("#"):
                if sequence > self._published_sequence:
                    self._published_seconds += duration
                    self._published_sequence = sequence
                    self._segment_count += 1
                count += 1
                sequence += 1
        return count, self._published_seconds

    def _update_playback(self, *, finished: bool = False) -> None:
        now = time.monotonic()
        if now - self._last_ui < 0.25 and not finished:
            return
        self._last_ui = now
        count, published = self._playlist()
        if self._mpv:
            try:
                self._player_state = json.loads((self._session_dir / "player.json").read_text(encoding="utf-8"))
            except (OSError, ValueError):
                pass
            code = self._mpv.poll()
            self._set(mpv_running=code is None)
            self._set(player_dropped_frames=int(self._player_state.get("dropped", 0)) +
                      int(self._player_state.get("decoder_dropped", 0)),
                      rebuffer_events=int(self._player_state.get("stalls", 0)),
                      av_sync_ms=float(self._player_state.get("avsync", 0)) * 1000)
            if code is not None and not finished:
                if code:
                    raise RuntimeError(f"MPV exited with code {code}.")
                self.stop()
                return
        ready = count and (published >= self.options.buffer_seconds or finished)
        if ready and not self._player_attempted:
            self._player_attempted = True
            self._playback_started = now
            if self.options.open_mpv:
                self._mpv = launch_mpv(self.info.playlist_url, self._title, self.options.mpv_args,
                    buffer_seconds=min(self.options.buffer_seconds, published),
                    state_path=self._session_dir / "player.json")
                self._set(mpv_running=True)
        info = self.snapshot()
        position = (float(self._player_state.get("position", 0)) if self._mpv
                    else max(0, now - self._playback_started) if self._playback_started else 0)
        buffer = max(0, published - position)
        status = (f"Playing: {self._title}" if self._player_attempted else f"Buffering: {self._title}")
        if finished:
            status = f"Finished processing: {self._title}. Playback available until Stop."
        status += (f"\n{info.target_fps:.2f} fps target | {info.effective_fps:.1f} fps processing | "
                   f"{info.processed_frames} enhanced | {info.sampled_frames} sampled out | {buffer:.1f}s buffered")
        self._set(status=status, segments=self._segment_count, buffer_seconds=buffer,
                  elapsed_seconds=now - self._started_at)

    def _pace(self, pts: int) -> float:
        # Compress time only in the processing schedule, never in media PTS.
        # Keep finite videos from racing through/deleting their HLS window.
        start = time.perf_counter()
        while self._playback_started is not None and not self.controller.cancel.is_set():
            position = (float(self._player_state.get("position", 0)) if self._mpv
                        else time.monotonic() - self._playback_started)
            if pts * TIME_BASE - position <= self.options.buffer_seconds + 2 * self.options.segment_seconds:
                break
            self._update_playback()
            self.controller.cancel.wait(0.05)
        return time.perf_counter() - start

    def _watchdog(self, done: threading.Event) -> None:
        while not done.wait(0.5):
            if self.controller.cancel.is_set():
                return
            if self._playback_started and (self._player_state.get("paused") or self._player_state.get("buffering")):
                # Pausing the player intentionally backpressures the pipeline.
                # Only explicit pause excuses inactivity; rebuffering doesn't.
                if self._player_state.get("paused"):
                    self._last_progress = time.monotonic()
            if time.monotonic() - self._last_progress > max(45, self.options.network_timeout * 2):
                self._stage_error("Live stalled", RuntimeError("No pipeline progress. Check the source/network and try again."))
                return

    def _produce(self) -> None:
        options = self.options
        self._set(status="Resolving source...")
        resolved = resolve_source(options.source, options.max_height, self.controller,
                                  source_quality=options.source_quality)
        self._title = resolved.title
        self._set(status=f"Probing {resolved.title}...")
        metadata = probe_source(resolved, self.controller, options.network_timeout)
        source_size = f"{metadata['width']}x{metadata['height']}"
        source_limit = options.max_height if options.source_quality == "Auto" else int(options.source_quality)
        source_note = (f"Requested up to {source_limit}p; received {source_size}."
                       if resolved.kind in ("youtube", "twitch") else
                       "Source quality selection applies to YouTube/Twitch pages; using the supplied source.")
        if resolved.kind in ("youtube", "twitch") and metadata["height"] != source_limit:
            source_note += " The resolved stream differs from the requested height."
        self._set(source_size=source_size, source_quality=options.source_quality, source_quality_note=source_note)
        self._rate = AdaptiveRate(metadata["rate"], options.target_fps)
        self._set(source_fps=float(metadata["rate"]), target_fps=self._rate.fps)
        in_w, in_h = _fit_height(metadata["width"], metadata["height"], options.max_height)
        factor, mode = resolve_upscaling_mode(options.upscaling_factor)
        out_w, out_h = resolve_output_size(in_w, in_h, factor)
        self._set(status=f"Preparing DLSS: {in_w}x{in_h} -> {out_w}x{out_h}...")
        prepared_runtime = prepare_runtime()
        ai_uuid, video_uuid = processing_gpu_settings()
        gpu = resolve_runtime_ai_gpu(prepared_runtime.gpus, prepared_runtime.runtime_bundle, ai_uuid)
        nvenc, ordinal = self._select_encoder(prepared_runtime.gpus, video_uuid, out_w, out_h)
        self._set(input_size=f"{in_w}x{in_h}", output_size=f"{out_w}x{out_h}",
                  encoder="NVIDIA NVENC" if nvenc else "CPU x264")
        native = None
        processes: list[subprocess.Popen] = []
        threads: list[threading.Thread] = []
        watchdog_done = threading.Event()
        self._last_progress = time.monotonic()
        watchdog = threading.Thread(target=self._watchdog, args=(watchdog_done,), daemon=True)
        watchdog.start()
        try:
            native_args = dict(input_width=in_w, input_height=in_h, output_width=out_w, output_height=out_h,
                frame_count=LIVE_FRAME_COUNT, warmup_frames=0, factor=factor, mode=mode,
                gpu=gpu, runtime_bundle=prepared_runtime.runtime_bundle)
            native = DLSSFrameSession(**native_args, native_settings=resolve_native_settings(options),
                                      controller=self.controller)
            self._last_progress = time.monotonic()
            decoder = self._spawn("decoder", self._decoder_command(resolved, in_w, in_h, self._rate.rate),
                                  stdout=subprocess.PIPE, stdin=subprocess.DEVNULL)
            processes.append(decoder)
            encoder = self._spawn("encoder", self._encoder_command(self._rate.rate, ordinal, nvenc),
                                  stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, cwd=self._session_dir)
            processes.append(encoder)
            # Small bounded queues overlap CPU guides, GPU evaluation and pipe
            # writes. Playback seconds are stored as compressed HLS, not RGBA.
            incoming: queue.Queue = queue.Queue(maxsize=options.queue_frames)
            outgoing: queue.Queue = queue.Queue(maxsize=options.queue_frames)
            threads = [threading.Thread(target=self._decode, args=(decoder, incoming, in_w, in_h), daemon=True),
                       threading.Thread(target=self._encode, args=(encoder, outgoing, out_w, out_h), daemon=True)]
            for thread in threads:
                thread.start()
            put(outgoing, get(incoming, self.controller.cancel), self.controller.cancel)
            self._ready.set()
            processing_start = time.perf_counter()
            pacing_seconds = 0.0
            processed = 0
            while not self.controller.cancel.is_set():
                item = get(incoming, self.controller.cancel)
                if item is None:
                    self.effects.finish()
                    put(outgoing, None, self.controller.cancel)
                    break
                if isinstance(item, VideoFrame):
                    self._update_playback()
                    pacing_seconds += self._pace(item.pts)
                    request = self.effects.take_due()
                    if request:
                        native, output, cost = self._replace_effects(native, request, native_args, item, processed)
                    else:
                        start = time.perf_counter()
                        output, pts = native.process(index=processed, rgba=item.rgba, motion=item.motion,
                                                     reset=item.reset, pts=item.pts)
                        cost = time.perf_counter() - start
                        if pts != item.pts:
                            raise RuntimeError("DLSS worker returned a different frame timestamp.")
                    processed += 1
                    if processed == 1:
                        evidence = verify_feature_18(native.worker_logs, native.reshade_log_text())
                        self._feature_evidence = {k: v for k, v in evidence.items() if k != "reshade_log"}
                    if self._first_frame_at is None:
                        self._first_frame_at = time.monotonic()
                    info = self.snapshot()
                    self._rate.observe(cost, info.guide_ms / 1000, info.encode_ms / 1000)
                    self._set(processed_frames=processed, dlss_ms=cost * 1000 if processed == 1 or request else
                              info.dlss_ms * 0.9 + cost * 100, target_fps=self._rate.fps,
                              effective_fps=processed / max(time.perf_counter() - processing_start - pacing_seconds, 0.001))
                    item = VideoFrame(item.index, item.pts, item.duration, output)
                put(outgoing, item, self.controller.cancel)
                self._last_progress = time.monotonic()
            for thread in threads:
                # Check progress and player closure while the last segment drains.
                while thread.is_alive() and not self.controller.cancel.is_set():
                    thread.join(timeout=0.2)
                    self._update_playback()
            if self._error:
                raise RuntimeError(self._error)
            if self.controller.cancel.is_set():
                raise Cancelled("Live stopped.")
            self._finished = True
        except Exception as exc:
            if not self.controller.cancel.is_set():
                self._error = _redact(str(exc))
            self.controller.stop()
            raise
        finally:
            watchdog_done.set()
            if native is not None:
                self._remember_native(native)
                native.abort()
            for process in processes:
                if process.poll() is None:
                    process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
                self.controller.unregister(process)
            # Errors/Stop unblock queue operations as well as pipe reads/writes.
            for thread in threads:
                thread.join(timeout=2)
            for process in processes:
                for pipe in (process.stdin, process.stdout, process.stderr):
                    if pipe and not pipe.closed:
                        try:
                            pipe.close()
                        except OSError:
                            pass
            watchdog.join(timeout=1)

    def _write_report(self) -> None:
        if not self.info.report_path:
            return
        payload = {"session": asdict(self.snapshot()),
                   "settings": {k: v for k, v in asdict(self.options).items() if k not in ("source", "mpv_args")},
                   "effects": self.effects.report(),
                   "player": self._player_state, "rate_changes": self._rate.changes if self._rate else [],
                   "native": self._native_logs,
                   "feature_18": self._feature_evidence,
                   "logs": {name: [_redact(line) for line in log.snapshot()] for name, log in self._logs.items()}}
        try:
            Path(self.info.report_path).write_text(json.dumps(payload, indent=2), encoding="utf-8")
        except OSError:
            pass

    def run(self) -> None:
        started = time.monotonic()
        self._started_at = started
        server = None
        try:
            validate_options(self.options)
            LIVE_DIR.mkdir(parents=True, exist_ok=True)
            stamp = time.strftime("%Y%m%d-%H%M%S") + f"-{time.time_ns() % 1_000_000:06d}-{os.getpid()}"
            self._session_dir = LIVE_DIR / f"live-{stamp}"
            self._session_dir.mkdir()
            (self._session_dir / "owner.json").write_text(json.dumps({"pid": os.getpid(), "keep": self.options.keep_files}))
            report = LOGS / "live" / f"{stamp}.json"
            report.parent.mkdir(parents=True, exist_ok=True)
            self._set(report_path=str(report))
            server = HlsServer(self._session_dir)
            server.start()
            self._set(playlist_url=server.playlist_url())
            with active_job(self.controller):
                self._produce()
            self._set(processing=False)
            self._update_playback(finished=True)
            self._produced.set()
            self._write_report()
            # The server and final segments belong to playback, not GPU work.
            # Manual players can continue using the URL until Stop is pressed.
            while not self.controller.cancel.wait(0.25):
                self._update_playback(finished=True)
                if self._mpv and self._mpv.poll() is not None:
                    if self._mpv.returncode:
                        raise RuntimeError(f"MPV exited with code {self._mpv.returncode}.")
                    break
        except Exception as exc:
            error = self._error or (None if self.controller.cancel.is_set() else _redact(str(exc)))
            if error:
                self._set(status=f"Failed: {error}", failures=[error])
            else:
                self._set(status="Stopped.")
        finally:
            self.effects.finish()
            self.controller.terminate_processes()
            if self._mpv and self._mpv.poll() is None:
                self._mpv.terminate()
                try:
                    self._mpv.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self._mpv.kill()
                    self._mpv.wait(timeout=5)
            if server:
                server.stop()
            self._set(running=False, processing=False, mpv_running=False, playlist_url="",
                      elapsed_seconds=time.monotonic() - started)
            if self._finished and not self.snapshot().failures:
                self._set(status=f"Finished: {self._title}. {self.info.processed_frames} frames enhanced.")
            elif not self.snapshot().failures:
                self._set(status="Stopped.")
            self._write_report()
            if self._session_dir and not self.options.keep_files:
                shutil.rmtree(self._session_dir, ignore_errors=True)
            self._ready.set()
            self._produced.set()
            with _LOCK:
                global _CURRENT, _LAST
                _LAST = self.snapshot()
                if _CURRENT is self:
                    _CURRENT = None


def start_live_session(options: LiveOptions) -> LiveSessionInfo:
    try:
        validate_options(options)
        kind = _classify(options.source)
    except ValueError as exc:
        raise RuntimeError(str(exc)) from exc
    check_live_binaries(resolve_pages=kind in ("youtube", "twitch"), play=options.open_mpv)
    global _CURRENT
    with _LOCK:
        if _CURRENT is not None and _CURRENT.is_alive():
            raise RuntimeError("A Live session is already running; Stop it first.")
        session = LiveSession(options)
        _CURRENT = session
        session.start()
    # Resolution, probe and native setup are cancellable background work.
    return session.snapshot()


def stop_live_session() -> LiveSessionInfo:
    with _LOCK:
        session = _CURRENT
    if session is None or not session.is_alive():
        return live_status()
    session.stop()
    session.join(timeout=3)
    return session.snapshot()


def update_live_effects(settings) -> bool:
    """Called in shared-settings commit order; enqueue only, never do GPU work."""
    with _LOCK:
        session = _CURRENT
    return session.request_effects(settings) if session is not None else False


def is_live_running() -> bool:
    with _LOCK:
        return _CURRENT is not None and _CURRENT.is_alive()


def live_status() -> LiveSessionInfo:
    with _LOCK:
        session, last = _CURRENT, _LAST
    return session.snapshot() if session else replace(last, failures=list(last.failures)) if last else LiveSessionInfo()


def sweep_stale_live_dirs() -> int:
    """Keep diagnostics and other running app instances' playback intact."""
    removed = 0
    if not LIVE_DIR.is_dir():
        return 0
    for child in LIVE_DIR.glob("live-*"):
        if not child.is_dir():
            continue
        try:
            owner = json.loads((child / "owner.json").read_text())
            if owner.get("keep"):
                continue
            pid = int(owner["pid"])
            # On Windows os.kill(pid, 0) is not a safe process-existence check.
            if os.name == "nt":
                import ctypes
                kernel = ctypes.WinDLL("kernel32", use_last_error=True)
                kernel.OpenProcess.restype = ctypes.c_void_p
                handle = kernel.OpenProcess(0x1000, False, pid)
                if handle:
                    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
                    kernel.CloseHandle(handle)
                    continue
                if ctypes.get_last_error() == 5:  # access denied implies it exists
                    continue
            else:
                try:
                    os.kill(pid, 0)
                    continue
                except ProcessLookupError:
                    pass
                except PermissionError:
                    continue
        except (OSError, ValueError, KeyError):
            # Unknown legacy directories are only swept after a full day.
            if time.time() - child.stat().st_mtime < 86400:
                continue
        shutil.rmtree(child, ignore_errors=True)
        removed += not child.exists()
    return removed


def _shutdown() -> None:
    with _LOCK:
        session = _CURRENT
    if session:
        session.stop()
        session.join(timeout=5)


atexit.register(_shutdown)
