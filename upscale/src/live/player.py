from __future__ import annotations

import os
import subprocess
from pathlib import Path

from ..core.paths import MPV, YTDLP


def check_live_binaries(*, resolve_pages: bool, play: bool) -> None:
    """Raise a user-facing error if required Live externals are missing."""
    if resolve_pages and not YTDLP.is_file():
        raise RuntimeError(
            f"yt-dlp is not installed ({YTDLP} missing); Live cannot "
            "resolve YouTube/Twitch page URLs. Local files still work."
        )
    if play and not MPV.is_file():
        raise RuntimeError(
            f"MPV is not installed ({MPV} missing); uncheck "
            "'Open in MPV' or restore the portable player."
        )


def launch_mpv(
    playlist_url: str,
    title: str,
    extra_args: tuple[str, ...] = (),
    *,
    buffer_seconds: float = 6.0,
    state_path: Path | None = None,
) -> subprocess.Popen:
    """Open the vendored MPV on a Live playlist. Raises on missing binary."""
    if not MPV.is_file():
        raise RuntimeError(
            f"MPV is not installed ({MPV} missing); the Live stream "
            "is still being produced — restore the player to watch it."
        )
    env = os.environ.copy()
    env["PATH"] = str(YTDLP.parent) + os.pathsep + env.get("PATH", "")
    if state_path is not None:
        env["DLSS5_LIVE_PLAYER_STATE"] = str(state_path)
    command = [
        str(MPV),
        "--no-config",
        "--ytdl=no",
        "--cache=yes",
        "--cache-pause=yes",
        "--cache-pause-initial=yes",
        f"--cache-pause-wait={buffer_seconds:g}",
        f"--cache-secs={max(20, buffer_seconds * 3):g}",
        "--demuxer-max-bytes=128MiB",
        "--demuxer-lavf-o=live_start_index=0",
        "--hwdec=auto-safe",
        "--video-sync=audio",
        f"--script={Path(__file__).with_name('player_status.lua')}",
        f"--title=DLSS 5 Live — {title}",
        "--terminal=no",
        *extra_args,
        playlist_url,
    ]
    creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        return subprocess.Popen(
            command,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
            env=env,
            creationflags=creation_flags,
        )
    except OSError as exc:
        raise RuntimeError(f"Could not launch MPV: {exc}.") from exc
