#!/usr/bin/env python3
"""Switch FILM VFI from the old TorchScript path to an eager model.

The bundled `film_net_fp32.pt` uses `nn.Conv2d(..., padding='same')` with an
even kernel. PyTorch 2.11 + cuDNN 9.19 aborts inside that convolution on
Windows (`Fatal Python error: Aborted`, Convolution.cpp:1025). The eager model
uses explicit asymmetric padding and the same weights, which works with cuDNN
and produces matching output (max diff ~1e-5 in the 64x64 test).

Run:
    python scripts/patch-film-vfi.py
    python scripts/patch-film-vfi.py --comfy-root path/to/ComfyUI-Easy-Install/ComfyUI
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path


PATCHED_INIT = "def _load_film_eager(model_path):"
PATCHED_ARCH = "class SamePadConv(nn.Module):"


def default_comfy_root() -> Path:
    return Path(__file__).resolve().parents[1] / "ComfyUI-Easy-Install" / "ComfyUI"


def patch_film_arch(path: Path) -> bool:
    text = path.read_text(encoding="utf-8")
    if PATCHED_ARCH in text and "_conv = SamePadConv(" in text:
        return False

    replacement = '''class SamePadConv(nn.Module):
    """Conv2d with explicit padding.

    Avoids PyTorch/cuDNN's padding='same' path, which aborts on this FILM
    model's even-sized convolution with PyTorch 2.11 + cuDNN 9.19.
    """

    def __init__(self, in_channels, out_channels, size):
        super().__init__()
        self.pad = ((size - 1) // 2, size // 2, (size - 1) // 2, size // 2)
        self.conv = nn.Conv2d(in_channels, out_channels, size, padding=0)

    def forward(self, x):
        return self.conv(F.pad(x, self.pad))


def conv(in_channels, out_channels, size, activation: Optional[str] = 'relu'):
    _conv = SamePadConv(in_channels, out_channels, size)
    if activation is None:
        return _conv
    assert activation == 'relu'
    return nn.Sequential(
        _conv,
        nn.LeakyReLU(.2)
    )
'''

    marker = "def conv(in_channels, out_channels, size, activation: Optional[str] = 'relu'):"
    start = text.rfind(marker)
    if start < 0:
        raise RuntimeError(f"FILM conv() block not found in {path}")
    new_text = text[:start] + replacement
    path.write_text(new_text, encoding="utf-8")
    return True


def patch_film_init(path: Path) -> bool:
    text = path.read_text(encoding="utf-8")
    if PATCHED_INIT in text:
        return False

    if "from . import film_arch" not in text:
        # Keep the import after the existing stdlib/third-party imports.
        text = text.replace(
            "import pathlib\nimport gc\n",
            "import pathlib\nimport gc\n\nfrom . import film_arch\n",
            1,
        )

    helper = '''def _load_film_eager(model_path):
    """Load the TorchScript weights into the eager, explicitly-padded model."""
    scripted = torch.jit.load(model_path, map_location='cpu')
    model = film_arch.Interpolator()
    samepad = {
        name for name, module in model.named_modules()
        if isinstance(module, film_arch.SamePadConv)
    }
    state = {}
    for key, value in scripted.state_dict().items():
        if key.endswith(('.weight', '.bias')):
            base, suffix = key.rsplit('.', 1)
            if base in samepad:
                key = f'{base}.conv.{suffix}'
        state[key] = value
    model.load_state_dict(state)
    model.eval()
    return model


'''
    if "def inference(" not in text:
        raise RuntimeError(f"FILM inference() not found in {path}")
    text = text.replace("def inference(", helper + "def inference(", 1)

    old_load = """        model = torch.jit.load(model_path, map_location='cpu')
        model.eval()
        model = model.to(DEVICE)
        dtype = torch.float32
"""
    new_load = """        model = _load_film_eager(model_path).to(DEVICE)
        dtype = torch.float32
"""
    if old_load not in text:
        raise RuntimeError(f"FILM model load block not found in {path}")
    text = text.replace(old_load, new_load, 1)
    path.write_text(text, encoding="utf-8")
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--comfy-root",
        type=Path,
        default=default_comfy_root(),
        help="Path to ComfyUI root (the folder containing custom_nodes/)",
    )
    args = parser.parse_args()

    node = args.comfy_root / "custom_nodes" / "ComfyUI-Frame-Interpolation"
    film_init = node / "vfi_models" / "film" / "__init__.py"
    film_arch = node / "vfi_models" / "film" / "film_arch.py"
    missing = [str(p) for p in (film_init, film_arch) if not p.is_file()]
    if missing:
        print("Not found:\n  " + "\n  ".join(missing), file=sys.stderr)
        return 1

    changed_arch = patch_film_arch(film_arch)
    changed_init = patch_film_init(film_init)
    print(
        ("Patched " if changed_arch or changed_init else "Already patched: ")
        + str(node)
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
