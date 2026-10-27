from __future__ import annotations

import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class _NoCacheHandler(SimpleHTTPRequestHandler):
    """Serve a Live HLS dir on loopback; never cache playlists."""

    def __init__(self, *args, directory: str, **kwargs) -> None:
        super().__init__(*args, directory=directory, **kwargs)

    def end_headers(self) -> None:
        if self.path.split("?")[0].endswith(".m3u8"):
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            self.send_header("Pragma", "no-cache")
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def log_message(self, *args) -> None:  # noqa: ANN002, ANN003 - quiet by design
        return

    def handle(self) -> None:
        try:
            super().handle()
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
            # Players routinely cancel segment prefetches when seeking/exiting.
            pass

    def do_GET(self) -> None:
        if self.path.split("?")[0].endswith(".tmp"):
            self.send_error(404)
            return
        super().do_GET()


class HlsServer:
    """Loopback HTTP server for one Live session directory."""

    def __init__(self, directory: Path) -> None:
        self.directory = directory
        handler = partial(_NoCacheHandler, directory=str(directory))
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self._server.daemon_threads = True
        self._thread = threading.Thread(
            target=self._server.serve_forever,
            kwargs={"poll_interval": 0.2},
            daemon=True,
            name="dlss5-live-hls",
        )

    @property
    def port(self) -> int:
        return int(self._server.server_address[1])

    def playlist_url(self, name: str = "index.m3u8") -> str:
        return f"http://127.0.0.1:{self.port}/{name}"

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        try:
            self._server.shutdown()
        except Exception:
            pass
        try:
            self._server.server_close()
        except Exception:
            pass
        self._thread.join(timeout=5)
