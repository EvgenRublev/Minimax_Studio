"""Smoke-тест математики MiniMax Studio Loop на CPU (без ComfyUI-графа)."""
import sys, os
ROOT = r"D:\Minimax_Studio_V7.1\ComfyUI-Easy-Install\ComfyUI"
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "custom_nodes"))

import torch
import importlib
loop = importlib.import_module("minimax_studio_loop")

CL = loop.CLIP_LATENTS
TAIL = loop.VIDEO_TAIL

# --- wrap_pad: периодичность и любая длина паддинга -------------------------
x = torch.arange(7).view(1, 1, 7, 1, 1)
for before, after in [(0, 0), (1, 2), (7, 7), (9, 3)]:
    y = loop.wrap_pad(x, before, after, 2)
    assert y.shape[2] == before + 7 + after, (before, after, y.shape)
    # каждый элемент = x[i mod 7]
    vals = y.view(-1).tolist()
    assert all(v == (i - before) % 7 for i, v in enumerate(vals)), (before, after, vals)
print("wrap_pad OK")

# --- audio_span ---------------------------------------------------------------
assert loop.audio_span(1) == round(17 * 40 / 24) == 28
assert loop.audio_span(12) == round(12 * 17 * 40 / 24) == 340
print("audio_span OK, 12 клипов =", loop.audio_span(12), "аудио-латентов")

# --- joint_weight: веса 0 в своей точке склейки, 1 в чужой -----------------
n = 57
w = loop.joint_weight(n, n - loop.audio_span(1), torch.zeros(n))
assert w.shape == (n,)
assert 0.0 <= float(w.min()) and float(w.max()) <= 1.0
print("joint_weight OK, min/max =", round(float(w.min()), 4), round(float(w.max()), 4))

# --- loop_wrapper: формы и смещение контекста -------------------------------
class Exec:
    def __init__(self):
        self.calls = 0
        self.shapes = []
    def __call__(self, x, timestep, context, transformer_options, **kwargs):
        self.calls += 1
        self.shapes.append((tuple(x[0].shape), tuple(x[1].shape)))
        # «модель»: возвращаем вход как есть (проверяем только геометрию)
        return x

for clips, pad, views in [(2, 1, 1), (2, 1, 2), (12, 1, 2), (12, 3, 2)]:
    n = clips * CL
    na = loop.audio_span(clips)
    tail = 8
    video = torch.arange((n + TAIL) * 2 * 3, dtype=torch.float32).reshape(1, 2, n + TAIL, 3, 1)
    audio = torch.zeros(1, 2, 1, na + tail)
    to = {
        "sigmas": torch.tensor(0.4),
        "minimax_studio_loop_pad_clips": pad,
        "minimax_studio_loop_views": views,
        # нулевой swap = паддинг сохраняет свой шум (ветка «шум не задан»)
        "minimax_studio_loop_noise_swap": torch.zeros(1, 2, n + TAIL, 3, 1),
    }
    ex = Exec()
    out = loop.loop_wrapper(ex, [video, audio], torch.tensor(500.0), torch.zeros(1, 2), to)
    assert tuple(out[0].shape) == (1, 2, n + TAIL, 3, 1), tuple(out[0].shape)
    assert tuple(out[1].shape) == (1, 2, 1, na + tail), tuple(out[1].shape)
    # вызовов: views=2 и clips>1 -> 2, иначе 1
    assert ex.calls == (2 if (views == 2 and clips > 1) else 1), ex.calls
    # паддинг видит ровно pad клипов с каждой стороны
    for vshape, ashape in ex.shapes:
        assert vshape[2] == pad * CL + n + pad * CL + TAIL, (vshape, pad, n)
        assert ashape[-1] == loop.audio_span(pad) + na + loop.audio_span(pad) + tail, ashape
    print(f"loop_wrapper OK: clips={clips} pad={pad} views={views} -> calls={ex.calls}, "
          f"вход видео {ex.shapes[0][0]}, аудио {ex.shapes[0][1]}")

# --- декод: сколько кадров вырезается ---------------------------------------
for clips, pad in [(12, 1), (2, 1), (19, 1)]:
    lat = pad * CL + clips * CL + pad * CL + TAIL
    frames = 17 * ((lat - TAIL) // CL) + 5   # как у MiniMaxH3VideoVAE: 5 латентов ↔ 17 кадров
    cut = frames - 17 * (pad + clips) - 17 * pad
    assert cut == 5, (clips, pad, lat, frames, cut)
    print(f"decode OK: clips={clips} pad={pad}: латент {lat} -> {frames} кадров -> цикл {17*clips}")

print("\nВСЁ ОК")
