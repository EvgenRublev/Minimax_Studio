"""MiniMax Studio: bounded-memory attention для H3.

Зачем: штатный Attention.forward материализует QKV-буфер [S, 3*inner] целиком.
На 1080p/5 с это ~3 ГБ, на 10 с — ~6 ГБ, и именно он не даёт pass 2 влезть в
8 ГБ. Узел режет работу по токенам, не меняя математику:

  1. K и V считаются блоками и живут в двух буферах [heads, S, dim] (это те же
     2*S*inner байт, что и половина QKV, но без Q).
  2. Q проецируется блоками и сразу потребляется attention'ом: полный QKV-буфер
     больше не нужен, пик = K/V + Q-блок.
  3. out_proj применяется к блоку и пишется в готовый выход, поэтому полный
     [S, inner] буфер выхода attention тоже не материализуется.

Attention считается SDPA (`attention_pytorch`) по Q-блокам против полных K/V:
это тот же результат, что у плотного attention, но без int8-копий K/V на каждый
блок — иначе CK-ядро квантизовало бы K/V заново для каждого Q-блока.

Узел ставится ПОСЛЕ MiniMaxLowVRAMAttention: он оборачивает уже установленный
forward и отдаёт управление ему, если последовательность короче блока.
"""

import logging
import types

import torch

import comfy.model_management as mm
import comfy.quant_ops
from comfy.ldm.modules.attention import attention_pytorch


def _norm_rope(attn, q, k, rope_freqs):
    s = q.shape[0]
    q = q.view(1, s, attn.heads, attn.head_dim)
    k = k.view(1, s, attn.heads, attn.head_dim)
    qw = mm.cast_to(attn.q_norm.weight, device=q.device)
    kw = mm.cast_to(attn.k_norm.weight, device=k.device)
    rot = rope_freqs.shape[-3] * 2
    comfy.quant_ops.ck.rms_rope_split_half_(
        q, k, rope_freqs, qw, kw, epsilon=attn.q_norm.eps, rot_dim=rot)
    return q[0], k[0]


def _bounded_forward(attn, x, rope_freqs, transformer_options, previous):
    if isinstance(x, list):
        x = x.pop()
    chunk = int(transformer_options.get("minimax_bounded_chunk", 0))
    s = x.shape[0]
    if chunk <= 0 or s <= chunk:
        return previous(x, rope_freqs=rope_freqs, transformer_options=transformer_options)

    heads, dim = attn.heads, attn.head_dim
    inner = heads * dim
    device, dtype = x.device, x.dtype

    # K/V блок за блоком: каждая строка считается независимо, результат
    # раскладывается сразу по [heads, S, dim], чтобы attention читал их без
    # перестановок на каждый Q-блок.
    k_buf = torch.empty((heads, s, dim), dtype=dtype, device=device)
    v_buf = torch.empty((heads, s, dim), dtype=dtype, device=device)
    for start in range(0, s, chunk):
        end = min(s, start + chunk)
        qkv = attn.qkv_proj(x[start:end])
        q, k, v = qkv.split(inner, dim=-1)
        v = v.view(end - start, heads, dim)
        if rope_freqs is not None:
            q, k = _norm_rope(attn, q, k, rope_freqs[:, start:end])
        else:
            q = attn.q_norm(q.view(end - start, heads, dim))
            k = attn.k_norm(k.view(end - start, heads, dim))
        k_buf[:, start:end] = k.transpose(0, 1)
        v_buf[:, start:end] = v.transpose(0, 1)
        del qkv, q, k, v

    out = torch.empty((s, attn.out_proj.out_features), dtype=dtype, device=device)
    k_all = k_buf.unsqueeze(0)
    v_all = v_buf.unsqueeze(0)
    for start in range(0, s, chunk):
        end = min(s, start + chunk)
        qkv = attn.qkv_proj(x[start:end])
        q = qkv[:, :inner]
        if rope_freqs is not None:
            # fused RMSNorm+RoPE работает на паре q/k, k здесь нужен только
            # чтобы ядро отработало, дальше он не используется.
            q, _ = _norm_rope(
                attn, q.contiguous(), qkv[:, inner:2 * inner].contiguous(), rope_freqs[:, start:end])
        else:
            q = attn.q_norm(q.view(end - start, heads, dim))
        q = q.transpose(0, 1).unsqueeze(0)
        o = attention_pytorch(
            q, k_all, v_all, heads, mask=None, skip_reshape=True,
            skip_output_reshape=False, transformer_options=transformer_options)
        out[start:end] = attn.out_proj(o.squeeze(0))
        del qkv, q, o
    return out


def _make_forward(previous):
    def forward(self, x, rope_freqs=None, transformer_options=None):
        return _bounded_forward(self, x, rope_freqs, transformer_options or {}, previous)
    return forward


def _sdpa_fits_low_vram():
    """SDPA на bf16 держит O(S) памяти только на Ampere+ (flash/cudnn).

    На Turing PyTorch уходит в math-backend и материализует S×S — на 75k
    токенов это гарантированный OOM. Там оставляем штатный attention: лучше
    старое поведение, чем падение в новом месте.
    """
    if not torch.cuda.is_available():
        return True
    try:
        return torch.cuda.get_device_capability()[0] >= 8
    except Exception:
        return False


class MiniMaxStudioBoundedAttention:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "model": ("MODEL",),
            "token_chunk": ("INT", {"default": 4096, "min": 512, "max": 32768, "step": 512,
                "tooltip": "Сколько токенов обрабатывать за один Q-блок. Меньше — ниже пик VRAM, больше — быстрее. "
                           "Нужна карта Ampere+ (RTX 30/40/50): на Turing узел не активен."}),
        }}

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "patch"
    CATEGORY = "MiniMax Studio"

    def patch(self, model, token_chunk=4096):
        if not _sdpa_fits_low_vram():
            logging.warning("MiniMaxStudioBoundedAttention: нужен Ampere+ (SDPA на bf16); "
                            "на этой карте остаётся штатный attention.")
            return (model,)
        m = model.clone()
        m.model_options["transformer_options"]["minimax_bounded_chunk"] = int(token_chunk)
        diffusion_model = m.get_model_object("diffusion_model")
        blocks = getattr(diffusion_model, "blocks", None)
        if not blocks or not hasattr(blocks[0], "attn") or not hasattr(blocks[0].attn, "qkv_proj"):
            logging.warning("MiniMaxStudioBoundedAttention: модель не похожа на MiniMax H3 "
                            "(нет diffusion_model.blocks[*].attn.qkv_proj); модель не меняется.")
            return (model,)
        for idx, block in enumerate(blocks):
            key = f"diffusion_model.blocks.{idx}.attn.forward"
            previous = m.object_patches.get(key) or block.attn.forward
            m.add_object_patch(key, types.MethodType(_make_forward(previous), block.attn))
        return (m,)


NODE_CLASS_MAPPINGS = {"MiniMaxStudioBoundedAttention": MiniMaxStudioBoundedAttention}
NODE_DISPLAY_NAME_MAPPINGS = {"MiniMaxStudioBoundedAttention": "MiniMax Studio · Bounded Attention"}
