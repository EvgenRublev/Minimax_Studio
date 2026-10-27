"""Direct filesystem input and non-overwriting publication of rendered files."""
from __future__ import annotations

import mimetypes
import os
import tempfile
import time
import uuid
import zipfile
from pathlib import Path

from .naming import require_available_output
from .paths import OUTPUTS


def clean_path(value: str | None) -> str:
    value = str(value or "").strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        value = value[1:-1].strip()
    return value


def direct_disk_mode(input_path: str | None, output_path: str | None) -> bool:
    return bool(str(input_path or "").strip() or str(output_path or "").strip())


def _absolute(value: str, label: str) -> Path:
    path = Path(clean_path(value))
    if not clean_path(value) or not path.is_absolute():
        raise ValueError(f"{label} must be an absolute path on this computer.")
    return path.resolve()


def supported_file(path: Path, kind: str) -> bool:
    suffix = path.suffix.casefold()
    if kind == "image":
        # Lazy imports avoid coupling the core module's initialization to Image.
        from PIL import Image
        from ..neural_rendering.image.models import RAW_EXTENSIONS
        return suffix in (set(Image.registered_extensions()) | RAW_EXTENSIONS | {".svg", ".heic", ".heif"})
    if kind != "video":
        raise ValueError(f"Unknown media type: {kind}")
    # Windows file associations sometimes label still-image containers video/heic.
    if suffix in {".heic", ".heif", ".avif", ".avifs"}:
        return False
    mime = mimetypes.guess_type(path.name)[0] or ""
    return mime.startswith("video/") or suffix in {
        ".mkv", ".m4v", ".mts", ".m2ts", ".ts", ".mxf", ".vob", ".wmv", ".flv",
        ".mp4", ".mov", ".avi", ".webm", ".mpg", ".mpeg", ".mpe", ".ogv",
        ".3gp", ".3g2", ".asf", ".divx", ".f4v", ".m2v", ".m1v", ".m2t",
    }


def resolve_inputs(input_path: str | None, uploads, kind: str) -> list[str]:
    if str(input_path or "").strip():
        path = _absolute(input_path, "Input path")
        if path.is_file():
            if not supported_file(path, kind):
                raise ValueError(f"Not a supported {kind} file: {path.name}")
            return [str(path)]
        if not path.is_dir():
            raise ValueError(f"Input path does not exist or is not accessible: {path}")
        files = sorted(
            (item for item in path.iterdir() if item.is_file() and supported_file(item, kind)),
            key=lambda item: (item.name.casefold(), item.name),
        )
        if not files:
            raise ValueError(f"No supported {kind} files in this folder (subfolders are excluded).")
        return [str(item.resolve()) for item in files]
    values = [uploads] if isinstance(uploads, (str, os.PathLike)) else list(uploads or [])
    if not values:
        raise ValueError(f"Enter an Input path or choose at least one {kind}.")
    return [str(Path(value).resolve()) for value in values]


def prepare_output_dir(value=None, *, default: Path = OUTPUTS, user_input: bool = False) -> Path:
    if user_input and str(value or "").strip():
        directory = _absolute(value, "Output path")
    else:
        directory = Path(value or default).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    if not directory.is_dir():
        raise ValueError(f"Output path must be a directory: {directory}")
    # Check actual create permission, including ACLs and network shares.
    with tempfile.TemporaryFile(dir=directory):
        pass
    return directory


class OutputFile:
    """Own a same-directory temporary file; never replace an existing destination."""

    def __init__(self, destination: Path):
        self.destination = destination
        require_available_output(destination)
        handle, name = tempfile.mkstemp(prefix=".dlss-", suffix=destination.suffix, dir=destination.parent)
        os.close(handle)
        self.temporary = Path(name)
        self._published_identity = None

    def publish(self) -> None:
        if not self.temporary.stat().st_size:
            raise RuntimeError("The encoder produced an empty output.")
        if os.name == "nt":
            # Windows rename is atomic and fails if destination already exists.
            os.rename(self.temporary, self.destination)
        else:
            os.link(self.temporary, self.destination)
            self.temporary.unlink()
        stat = self.destination.stat()
        self._published_identity = (stat.st_dev, stat.st_ino)

    def cleanup(self, *, rollback: bool = False) -> None:
        self.temporary.unlink(missing_ok=True)
        if rollback and self._published_identity is not None:
            try:
                stat = self.destination.stat()
                if (stat.st_dev, stat.st_ino) == self._published_identity:
                    self.destination.unlink()
            except FileNotFoundError:
                pass


def create_media_archive(
    paths,
    output_dir,
    prefix: str,
    *,
    controller=None,
) -> str | None:
    """Atomically store successful media in an uncompressed, cancellable ZIP."""
    sources = [Path(path).resolve() for path in paths]
    if not sources or (controller is not None and controller.cancel.is_set()):
        return None
    destination = prepare_output_dir(output_dir)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    archive_path = destination / f"{prefix}_{stamp}_{uuid.uuid4().hex[:8]}.zip"
    output_file = OutputFile(archive_path)
    cancelled = False
    try:
        used_names: set[str] = set()
        with zipfile.ZipFile(
            output_file.temporary, "w", compression=zipfile.ZIP_STORED, allowZip64=True,
        ) as archive:
            for source in sources:
                if controller is not None and controller.cancel.is_set():
                    cancelled = True
                    break
                candidate = source.name
                index = 2
                while candidate.casefold() in used_names:
                    candidate = f"{source.stem}_{index}{source.suffix}"
                    index += 1
                used_names.add(candidate.casefold())
                info = zipfile.ZipInfo.from_file(source, arcname=candidate)
                info.compress_type = zipfile.ZIP_STORED
                with source.open("rb") as input_stream, archive.open(
                    info, "w", force_zip64=True,
                ) as output_stream:
                    while True:
                        if controller is not None and controller.cancel.is_set():
                            cancelled = True
                            break
                        chunk = input_stream.read(1024 * 1024)
                        if not chunk:
                            break
                        output_stream.write(chunk)
                if cancelled:
                    break
        if cancelled or (controller is not None and controller.cancel.is_set()):
            return None
        output_file.publish()
        return str(archive_path)
    finally:
        output_file.cleanup()
