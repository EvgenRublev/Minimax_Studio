from __future__ import annotations

import atexit
import ctypes
from ctypes import wintypes
import io
import logging
import os
import shutil
import sys
import threading
import time
import warnings
import webbrowser
from pathlib import Path


GITHUB_URL = "https://github.com/Merserk/dlss5-visual-enhancer"
AUTHOR_NAME = "Merserk"

# Palette:
# Left (0%):   #0286C3 -> RGB(2, 134, 195)
# 63%:          #0FB881 -> RGB(15, 184, 129)
# Right (100%): #079E6E -> RGB(7, 158, 110)
C_LEFT = (2, 134, 195)
C_MID = (15, 184, 129)
C_RIGHT = (7, 158, 110)


def get_gradient_rgb(t: float) -> tuple[int, int, int]:
    """Interpolate RGB color according to the 90deg linear gradient."""
    t = max(0.0, min(1.0, float(t)))
    if t <= 0.63:
        st = t / 0.63
        r = int(C_LEFT[0] + (C_MID[0] - C_LEFT[0]) * st)
        g = int(C_LEFT[1] + (C_MID[1] - C_LEFT[1]) * st)
        b = int(C_LEFT[2] + (C_MID[2] - C_LEFT[2]) * st)
    else:
        st = (t - 0.63) / 0.37
        r = int(C_MID[0] + (C_RIGHT[0] - C_MID[0]) * st)
        g = int(C_MID[1] + (C_RIGHT[1] - C_MID[1]) * st)
        b = int(C_MID[2] + (C_RIGHT[2] - C_MID[2]) * st)
    return (max(0, min(255, r)), max(0, min(255, g)), max(0, min(255, b)))


def colorize_text(text: str, t_start: float = 0.0, t_end: float = 1.0, bold: bool = False) -> str:
    """Colorize a single line with gradient based on character column."""
    res = []
    n = max(1, len(text) - 1)
    for i, ch in enumerate(text):
        if ch == " ":
            res.append(" ")
        else:
            t = t_start + (t_end - t_start) * (i / n)
            r, g, b = get_gradient_rgb(t)
            if bold:
                res.append(f"\033[1;38;2;{r};{g};{b}m{ch}\033[0m")
            else:
                res.append(f"\033[38;2;{r};{g};{b}m{ch}\033[0m")
    return "".join(res)


class FileLoggerStream:
    """Redirects stdout/stderr cleanly to a log file instead of terminal.

    Implements the minimal file-like API expected by uvicorn/click/gradio
    (isatty, fileno, reconfigure, encoding) so `sys.stdout.isatty()` etc.
    do not crash after `sys.stdout` is replaced.
    """

    def __init__(self, log_path: Path):
        self.log_path = log_path
        self._lock = threading.Lock()
        self.encoding = "utf-8"
        self.errors = "replace"
        self._closed = False

    def write(self, s: str) -> int:
        if not s:
            return 0
        try:
            with self._lock:
                with open(self.log_path, "a", encoding="utf-8", errors="replace") as f:
                    f.write(s)
        except Exception:
            pass
        return len(s)

    def writelines(self, lines) -> None:
        for line in lines:
            self.write(line)

    def flush(self) -> None:
        pass

    def isatty(self) -> bool:
        return False

    def fileno(self):
        raise io.UnsupportedOperation("FileLoggerStream has no fileno")

    def reconfigure(self, *args, **kwargs) -> None:
        # Accept stream.reconfigure(encoding=...) calls from render_screen / libs
        if "encoding" in kwargs:
            self.encoding = kwargs["encoding"]
        if "errors" in kwargs:
            self.errors = kwargs["errors"]

    @property
    def buffer(self):
        raise io.UnsupportedOperation("FileLoggerStream has no buffer")

    def readable(self) -> bool:
        return False

    def writable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return False

    @property
    def closed(self) -> bool:
        return self._closed

    def close(self) -> None:
        self._closed = True


class TerminalUI:
    """Renders and manages the clean console window UI."""

    def __init__(self, log_dir: Path):
        self.log_dir = log_dir
        self.log_file = log_dir / "app.log"
        self._stop_event = threading.Event()
        self._listener_thread: threading.Thread | None = None
        self._button_row = 0
        self._button_col_start = 2
        self._button_col_end = 14
        self._alt_active = False

    def enable_vt_mode(self) -> None:
        """Enable Windows Virtual Terminal Processing for 24-bit ANSI colors."""
        if sys.platform != "win32":
            return
        try:
            kernel32 = ctypes.windll.kernel32
            # Enable ANSI on standard out
            h_out = kernel32.GetStdHandle(-11)  # STD_OUTPUT_HANDLE
            mode = wintypes.DWORD()
            if kernel32.GetConsoleMode(h_out, ctypes.byref(mode)):
                # ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004
                kernel32.SetConsoleMode(h_out, mode.value | 0x0004)
        except Exception:
            pass

    def render_screen(self) -> None:
        """Draw the complete styled terminal interface."""
        for stream in (sys.__stdout__, sys.stdout):
            if hasattr(stream, "reconfigure"):
                try:
                    stream.reconfigure(encoding="utf-8", errors="replace")
                except Exception:
                    pass

        # Robust VT and size - retry until real window size
        for _ in range(4):
            self.enable_vt_mode()
            os.system("")
            term_cols, term_rows = shutil.get_terminal_size((100, 30))
            if term_cols >= 80 and term_rows >= 20:
                break
            time.sleep(0.05)
        else:
            term_cols, term_rows = shutil.get_terminal_size((120, 30))

        # Single line - DLSS 5 VISUAL ENHANCER, DLSS closer (1 space) and larger via fullwidth + bold
        dlss_part = "Ｄ Ｌ Ｓ Ｓ    ５"
        visual_part = "V  I  S  U  A  L     E  N  H  A  N  C  E  R"
        title_text = dlss_part + "     " + visual_part
        # Use len as an approximation for centering.
        title_w = len(title_text)
        pad_title = " " * max(0, (term_cols - title_w) // 2)

        # Enter alternate screen buffer on first render, otherwise just move home and clear
        if not self._alt_active:
            sys.__stdout__.write("\033[?1049h")
            self._alt_active = True
        sys.__stdout__.write("\033[H\033[?25l")
        sys.__stdout__.flush()

        out_lines: list[str] = []
        # Center single title vertically, keep footer at bottom
        banner_block_h = 1
        footer_h = 1
        target_rows = max(term_rows, 24)
        available = max(0, target_rows - banner_block_h - footer_h - 2)
        pad_top = available // 2
        pad_bottom = available - pad_top
        out_lines.extend([""] * pad_top)
        out_lines.append(pad_title + colorize_text(title_text, bold=True))
        out_lines.append("")

        # Vertical spacing after block before footer
        for _ in range(pad_bottom):
            out_lines.append("")

        # Bottom row: GitHub on left, Merserk on right
        self._button_row = len(out_lines) + 1

        # OSC 8 Hyperlink button (plain GitHub text without brackets) - GitHub #0286C3, Merserk #079E6E
        osc8_button = (
            f"\033]8;;{GITHUB_URL}\033\\"
            f"\033[1;38;2;{C_LEFT[0]};{C_LEFT[1]};{C_LEFT[2]}mGitHub\033[0m"
            f"\033]8;;\033\\"
        )
        visible_button_len = len("  GitHub")
        author_colored = f"\033[1;38;2;{C_RIGHT[0]};{C_RIGHT[1]};{C_RIGHT[2]}m{AUTHOR_NAME}\033[0m"
        visible_author_len = len(AUTHOR_NAME) + 2

        gap = max(2, term_cols - visible_button_len - visible_author_len)
        footer_line = "  " + osc8_button + (" " * gap) + author_colored + "  "
        out_lines.append(footer_line)

        # Output in-place without adding to scrollback - no trailing newline, erase to end
        sys.__stdout__.write("\n".join(out_lines))
        sys.__stdout__.write("\033[J")
        sys.__stdout__.flush()

    def render_loading(self) -> None:
        """Draw centered LOADING screen with same DLSS 5 Visual Enhancer style, no footer."""
        for stream in (sys.__stdout__, sys.stdout):
            if hasattr(stream, "reconfigure"):
                try:
                    stream.reconfigure(encoding="utf-8", errors="replace")
                except Exception:
                    pass
        # Robust VT and size - early import time conhost may report 0,0 / 80x24 fallback
        for _ in range(4):
            self.enable_vt_mode()
            os.system("")
            term_cols, term_rows = shutil.get_terminal_size((100, 30))
            if term_cols >= 80 and term_rows >= 20:
                break
            time.sleep(0.05)
        else:
            term_cols, term_rows = shutil.get_terminal_size((120, 30))
        loading_text = "L  O  A  D  I  N  G"
        loading_w = len(loading_text)
        pad_loading = " " * max(0, (term_cols - loading_w) // 2)
        # Center vertically, no footer
        banner_block_h = 1
        target_rows = max(term_rows, 24)
        available = max(0, target_rows - banner_block_h - 2)
        pad_top = available // 2
        pad_bottom = available - pad_top
        if not self._alt_active:
            sys.__stdout__.write("\033[?1049h")
            self._alt_active = True
        sys.__stdout__.write("\033[H\033[?25l")
        sys.__stdout__.flush()
        out_lines: list[str] = []
        out_lines.extend([""] * pad_top)
        out_lines.append(pad_loading + colorize_text(loading_text, bold=True))
        out_lines.append("")
        for _ in range(pad_bottom):
            out_lines.append("")
        # No footer on loading screen per request - in-place, no trailing newline
        sys.__stdout__.write("\n".join(out_lines))
        sys.__stdout__.write("\033[J")
        sys.__stdout__.flush()

    def start_input_listener(self) -> None:
        """Start background daemon thread listening for clicks or hotkey to open GitHub."""
        if sys.platform != "win32":
            return

        def _input_worker() -> None:
            kernel32 = ctypes.windll.kernel32
            GENERIC_READ = 0x80000000
            GENERIC_WRITE = 0x40000000
            FILE_SHARE_READ = 1
            FILE_SHARE_WRITE = 2
            OPEN_EXISTING = 3
            ENABLE_MOUSE_INPUT = 0x0010
            ENABLE_EXTENDED_FLAGS = 0x0080
            ENABLE_WINDOW_INPUT = 0x0008

            h_in = kernel32.CreateFileW(
                "CONIN$",
                GENERIC_READ | GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                None,
                OPEN_EXISTING,
                0,
                None,
            )
            if h_in == -1 or h_in == 0:
                return

            try:
                orig_mode = wintypes.DWORD()
                if kernel32.GetConsoleMode(h_in, ctypes.byref(orig_mode)):
                    # Enable mouse events, disable quick edit mode to receive clicks
                    new_mode = (orig_mode.value | ENABLE_MOUSE_INPUT | ENABLE_EXTENDED_FLAGS | ENABLE_WINDOW_INPUT) & ~0x0040
                    kernel32.SetConsoleMode(h_in, new_mode)

                class COORD(ctypes.Structure):
                    _fields_ = [("X", wintypes.SHORT), ("Y", wintypes.SHORT)]

                class KEY_EVENT_RECORD(ctypes.Structure):
                    _fields_ = [
                        ("bKeyDown", wintypes.BOOL),
                        ("wRepeatCount", wintypes.WORD),
                        ("wVirtualKeyCode", wintypes.WORD),
                        ("wVirtualScanCode", wintypes.WORD),
                        ("uChar", wintypes.WCHAR),
                        ("dwControlKeyState", wintypes.DWORD),
                    ]

                class MOUSE_EVENT_RECORD(ctypes.Structure):
                    _fields_ = [
                        ("dwMousePosition", COORD),
                        ("dwButtonState", wintypes.DWORD),
                        ("dwControlKeyState", wintypes.DWORD),
                        ("dwEventFlags", wintypes.DWORD),
                    ]

                class EVENT_UNION(ctypes.Union):
                    _fields_ = [
                        ("KeyEvent", KEY_EVENT_RECORD),
                        ("MouseEvent", MOUSE_EVENT_RECORD),
                    ]

                class INPUT_RECORD(ctypes.Structure):
                    _fields_ = [
                        ("EventType", wintypes.WORD),
                        ("Event", EVENT_UNION),
                    ]

                record = INPUT_RECORD()
                events_read = wintypes.DWORD()

                last_open_time = 0.0

                while not self._stop_event.is_set():
                    # Wait with 250ms timeout so thread responds to stop event
                    wait_res = kernel32.WaitForSingleObject(h_in, 250)
                    if wait_res != 0:
                        continue

                    if not kernel32.ReadConsoleInputW(
                        h_in, ctypes.byref(record), 1, ctypes.byref(events_read)
                    ) or events_read.value == 0:
                        continue

                    # Key event: 'g', 'G', or Enter
                    if record.EventType == 0x0001:  # KEY_EVENT
                        ke = record.Event.KeyEvent
                        if ke.bKeyDown:
                            char = str(ke.uChar).lower()
                            if char == "g" or ke.wVirtualKeyCode == 0x0D:  # Enter
                                now = time.time()
                                if now - last_open_time > 1.5:
                                    last_open_time = now
                                    webbrowser.open(GITHUB_URL)

                    # Mouse event: click on bottom-left region
                    elif record.EventType == 0x0002:  # MOUSE_EVENT
                        me = record.Event.MouseEvent
                        # FROM_LEFT_1ST_BUTTON_PRESSED = 0x0001
                        if me.dwButtonState & 0x0001:
                            x = me.dwMousePosition.X
                            y = me.dwMousePosition.Y
                            _, term_rows = shutil.get_terminal_size((100, 30))
                            # Check if click is near the bottom left (GitHub button area)
                            if y >= term_rows - 4 and x <= 16:
                                now = time.time()
                                if now - last_open_time > 1.5:
                                    last_open_time = now
                                    webbrowser.open(GITHUB_URL)

            except Exception:
                pass
            finally:
                try:
                    kernel32.CloseHandle(h_in)
                except Exception:
                    pass

        self._listener_thread = threading.Thread(target=_input_worker, daemon=True)
        self._listener_thread.start()

    def silence_and_redirect(self) -> None:
        """Silence stdout/stderr and redirect all logging/exceptions to app.log."""
        self.log_dir.mkdir(parents=True, exist_ok=True)
        log_stream = FileLoggerStream(self.log_file)

        # Redirect standard streams
        sys.stdout = log_stream  # type: ignore[assignment]
        sys.stderr = log_stream  # type: ignore[assignment]

        # Suppress warnings
        warnings.filterwarnings("ignore")

        # Configure file logging for libraries
        file_handler = logging.FileHandler(str(self.log_file), encoding="utf-8")
        file_handler.setLevel(logging.INFO)
        formatter = logging.Formatter("[%(asctime)s] %(levelname)s:%(name)s: %(message)s")
        file_handler.setFormatter(formatter)

        for logger_name in ("uvicorn", "uvicorn.error", "uvicorn.access", "gradio", "fastapi"):
            lg = logging.getLogger(logger_name)
            lg.handlers = [file_handler]
            lg.setLevel(logging.WARNING)

    def restore_cursor(self) -> None:
        """Show terminal cursor and leave alternate buffer on exit."""
        try:
            if getattr(self, "_alt_active", False):
                sys.__stdout__.write("\033[?1049l")
                self._alt_active = False
            sys.__stdout__.write("\033[?25h")
            sys.__stdout__.flush()
        except Exception:
            pass


def init_console(log_dir: Path) -> TerminalUI:
    """Initialize and display the loading screen immediately, then final UI after prep."""
    ui = TerminalUI(log_dir)
    ui.render_loading()
    ui.start_input_listener()
    ui.silence_and_redirect()
    atexit.register(ui.restore_cursor)
    return ui
