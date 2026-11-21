"""Smoke-тест bounded attention на CPU/CUDA (без загрузки модели H3).

Проверяет, что блочный forward совпадает со штатным Attention.forward:
  • fp32 без RoPE — точность float;
  • bf16 с RoPE — в пределах bf16-округления;
  • list-вход (формат MiniMaxLowVRAMAttention) и короткая последовательность
    (fallback на previous) не ломаются.
"""

import importlib.util
import pathlib
import sys

import torch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

import comfy.ops  # noqa: E402
import comfy.quant_ops  # noqa: E402
import comfy.model_management as mm  # noqa: E402
from comfy.ldm.minimax.model import Attention, rope_rotation_table  # noqa: E402

_HERE = pathlib.Path(__file__).resolve().parent / "__init__.py"
spec = importlib.util.spec_from_file_location("minimax_bounded_attn", _HERE)
node = importlib.util.module_from_spec(spec)
spec.loader.exec_module(node)


def make_attn(dtype, device):
    attn = Attention(512, 8, 64, 1e-5, dtype=dtype, device=device, operations=torch.nn).eval()
    for p in attn.parameters():
        p.requires_grad_(False)
    return attn


def run(dtype, device, with_rope, use_list):
    torch.manual_seed(0)
    attn = make_attn(dtype, device)
    x = torch.randn(257, 512, dtype=dtype, device=device)
    rope = None
    if with_rope:
        angles = torch.rand(257, 64, dtype=torch.float32, device=device) * 6.28
        rope = rope_rotation_table(angles, dtype)
    with torch.inference_mode():
        ref = attn.forward(x, rope_freqs=rope, transformer_options={})
        inp = [x] if use_list else x
        got = node._bounded_forward(
            attn, inp, rope, {"minimax_bounded_chunk": 64}, attn.forward)
    diff = (ref.float() - got.float()).abs().max().item()
    limit = 1e-5 if dtype == torch.float32 else 5e-3
    assert diff <= limit, f"{dtype} rope={with_rope} list={use_list}: diff {diff} > {limit}"
    print(f"ok  {str(dtype):15} rope={with_rope!s:5} list={use_list!s:5} diff={diff:.2e}")


def run_wrapper():
    torch.manual_seed(0)
    attn = make_attn(torch.float32, "cpu")
    x = torch.randn(40, 512, dtype=torch.float32)
    calls = []

    def previous(x, rope_freqs=None, transformer_options=None):
        calls.append(x.shape[0])
        return attn.forward(x, transformer_options=transformer_options or {})

    wrapped = node._make_forward(previous)
    with torch.inference_mode():
        wrapped(attn, x, None, {"minimax_bounded_chunk": 16})
        wrapped(attn, x, None, {"minimax_bounded_chunk": 100})
    assert calls == [40], f"previous should be used only for the short call, got {calls}"
    print("ok  wrapper: long call chunks, short call falls back")


def run_patch_stub():
    from types import MethodType, SimpleNamespace

    class StubPatcher:
        def __init__(self):
            self.blocks = [SimpleNamespace(attn=make_attn(torch.float32, "cpu"))]
            self.model_options = {"transformer_options": {}}
            self.object_patches = {}

        def clone(self):
            other = StubPatcher.__new__(StubPatcher)
            other.blocks = self.blocks
            other.model_options = {"transformer_options": dict(self.model_options["transformer_options"])}
            other.object_patches = dict(self.object_patches)
            return other

        def get_model_object(self, name):
            return SimpleNamespace(blocks=self.blocks)

        def add_object_patch(self, key, value):
            self.object_patches[key] = value

    (patched,) = node.MiniMaxStudioBoundedAttention().patch(StubPatcher(), 512)
    key = "diffusion_model.blocks.0.attn.forward"
    assert patched.model_options["transformer_options"]["minimax_bounded_chunk"] == 512
    assert isinstance(patched.object_patches[key], MethodType), "attn.forward должен быть MethodType"
    print("ok  patch(): forward обёрнут, token_chunk проброшен")


def run_fallback():
    torch.manual_seed(0)
    attn = make_attn(torch.float32, "cpu")
    x = torch.randn(40, 512, dtype=torch.float32)
    with torch.inference_mode():
        ref = attn.forward(x, transformer_options={})
        got = node._bounded_forward(
            attn, x, None, {"minimax_bounded_chunk": 4096}, attn.forward)
    diff = (ref - got).abs().max().item()
    assert diff == 0.0, diff
    print(f"ok  fallback (S < chunk) diff={diff:.2e}")


if __name__ == "__main__":
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    print("device:", dev)
    run_fallback()
    run_wrapper()
    run_patch_stub()
    run(torch.float32, dev, False, False)
    run(torch.float32, dev, False, True)
    run(torch.bfloat16, dev, False, False)
    if dev == "cuda":
        run(torch.bfloat16, dev, True, False)
        run(torch.bfloat16, dev, True, True)
    print("bounded attention: OK")
