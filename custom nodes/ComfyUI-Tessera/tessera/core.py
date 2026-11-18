"""Tessera core -- shared latent helpers and the guarded ComfyUI
sampling imports. Split/rewrap of nested AV latents, cell/patch/temporal
detection, tile windows, masks and DC matching: the machinery every
Tessera node builds on.
"""

import math
import time

import torch

from .geometry import (build_plan, format_plan, verify_coverage,
                       GeometryError, DEFAULT_CELL)
from .preview import render_plan, render_error, to_comfy_image
from .resample import to_gen, from_gen, edge_extend

# The sampling path touches ComfyUI internals that move between builds. Import
# it defensively so that a signature change degrades to "the sampler node is
# missing" rather than taking the whole pack down -- LTXTilePlan needs none of
# it and is the thing you want working when you're debugging geometry.
try:
    import comfy.sample
    import comfy.samplers
    import comfy.utils
    import comfy.model_management
    _SAMPLING_OK, _SAMPLING_ERR = True, None
except Exception as _e:                                    # pragma: no cover
    _SAMPLING_OK, _SAMPLING_ERR = False, _e
    print(f"[Tessera] sampling imports failed ({_e}); "
          f"sampling nodes (Refine, Streamed Encode) disabled")

# Live latent preview, same as KSampler shows. Entirely optional -- if the
# previewer can't handle a 5D video latent we just lose the thumbnail, not
# the progress bar.
try:
    import latent_preview as _latent_preview
    _PREVIEW_OK = True
except Exception:                                          # pragma: no cover
    _PREVIEW_OK = False

# Joint audio-video models (MiniMax H3, and LTX-2's AV latents) carry both
# modalities in one LATENT as a NestedTensor pair. Its __getitem__ applies
# elementwise, so naive spatial slicing would chop the audio tensor's stereo
# axis and truncate it in time -- silently, because .shape reports the *video*
# tensor's shape. Split it, tile only the video, carry the rest through.
try:
    import comfy.nested_tensor
    _NESTED = comfy.nested_tensor.NestedTensor
except Exception:                                          # pragma: no cover
    _NESTED = None


def split_latent(samples):
    """
    -> (spatial_tensor, companions, wrapper)

    Uses `is_nested` + `unbind()` -- the exact pair comfy.samplers itself keys
    on ("if latent_image.is_nested: pack_latents(latent_image.unbind())").
    Plain torch tensors carry is_nested=False, so the check is safe for them.
    Reading `.tensors` directly is NOT reliable across builds, and when it
    fails it does so silently: the pair collapses to one entry and the model
    dies on x[1] rather than on anything that names the real cause.
    """
    if getattr(samples, "is_nested", False):
        ts = list(samples.unbind())
        return ts[0], ts[1:], type(samples)
    ts = getattr(samples, "tensors", None)          # last-resort duck-type
    if isinstance(ts, (list, tuple)) and ts:
        ts = list(ts)
        return ts[0], ts[1:], type(samples)
    return samples, [], None


def rewrap_latent(video, companions, wrapper):
    if wrapper is None:
        return video
    return wrapper([video] + list(companions))


def _null_masks(companions):
    """
    Zero masks for companions -- 0 means 'never denoise', so audio is inert.

    Full component shape, not channel-collapsed: comfy packs the nested masks
    by flattening each one and pads any it is missing with
    `torch.ones(latent_shapes[i])`, so a [B,1,...] mask would pack to the wrong
    element count. (It also means omitting the audio mask entirely would leave
    it at ones -- i.e. fully denoised, 25 times over.)
    """
    return [torch.zeros_like(c) for c in companions]


def _full_mask(mask, like):
    """Broadcast a [B,1,...] mask up to the full latent shape, for packing."""
    if tuple(mask.shape) == tuple(like.shape):
        return mask
    return mask.expand(like.shape).contiguous()


# The console bar KSampler shows is k-diffusion's own tqdm `trange`, gated by
# the `disable_pbar` argument -- not by comfy.utils.ProgressBar, which drives
# the UI ring. Passing disable_pbar=True suppresses it entirely; passing
# `not comfy.utils.PROGRESS_BAR_ENABLED` is what core nodes do and gives the
# identical bar, honouring the user's global setting.
try:
    from tqdm.auto import tqdm
except Exception:                                          # pragma: no cover
    tqdm = None


def _pbar_enabled():
    return getattr(comfy.utils, "PROGRESS_BAR_ENABLED", True) if _SAMPLING_OK else True


def detect_cell(vae):
    """
    Spatial compression factor from a ComfyUI VAE.

    `spacial_compression_encode()` is the supported accessor (the typo is
    ComfyUI's). Older builds only expose `downscale_ratio`, which video VAEs
    set to a (temporal_fn, y, x) tuple rather than an int -- hence the
    unpacking. Returns None if it can't be determined, so the caller can fall
    back to the manual value instead of guessing.
    """
    if vae is None:
        return None
    for attr in ("spacial_compression_encode", "spacial_compression_decode"):
        fn = getattr(vae, attr, None)
        if callable(fn):
            try:
                v = fn()
                if isinstance(v, int) and v > 0:
                    return v
            except Exception:
                pass
    r = getattr(vae, "downscale_ratio", None)
    if isinstance(r, (tuple, list)) and r:
        try:
            return int(r[-1])
        except Exception:
            return None
    if isinstance(r, int) and r > 0:
        return r
    return None


def detect_patch(model):
    """
    Spatial patch size of the diffusion transformer.

    H3 documents a 32px rounding requirement while its VAE compresses 16x --
    the missing factor of 2 is the DiT patch size. A tile that isn't a whole
    number of patches gets padded inside the model (pad_to_patch_size), which
    shifts the video relative to the mask we built. Returns 1 when unknown, so
    the check degrades to plain cell alignment rather than false-failing.
    """
    dm = getattr(getattr(model, "model", None), "diffusion_model", None)
    ps = getattr(dm, "patch_size", None)
    if isinstance(ps, (tuple, list)) and ps:
        try:
            return max(1, int(ps[-1]))
        except Exception:
            return 1
    if isinstance(ps, int) and ps > 0:
        return ps
    return 1


def detect_temporal(vae):
    fn = getattr(vae, "temporal_compression_decode", None)
    if callable(fn):
        try:
            v = fn()
            if isinstance(v, int) and v > 0:
                return v
        except Exception:
            pass
    return None


def _fmt(sec):
    if sec < 60:
        return f"{sec:.1f}s"
    m, s = divmod(int(round(sec)), 60)
    if m < 60:
        return f"{m}m{s:02d}s"
    h, m = divmod(m, 60)
    return f"{h}h{m:02d}m"


# --------------------------------------------------------------------------
# latent helpers -- LTX video latents are 5D [B, C, T, H, W]; stills are 4D.
# --------------------------------------------------------------------------

def _spatial_dims(t):
    if t.ndim == 5:
        return t.shape[-2], t.shape[-1]
    if t.ndim == 4:
        return t.shape[-2], t.shape[-1]
    raise ValueError(f"unexpected latent rank {t.ndim}; expected 4 or 5")


def _window(t, x, y, w, h):
    return t[..., y:y + h, x:x + w]


def _paste(dst, src, x, y):
    h, w = src.shape[-2], src.shape[-1]
    dst[..., y:y + h, x:x + w] = src
    return dst


def _tile_mask(window, mx0, mx1, my0, my1, device, dtype):
    """1.0 where the tile should be denoised, 0.0 over the context border."""
    h, w = window.shape[-2], window.shape[-1]
    m = torch.zeros((h, w), device=device, dtype=dtype)
    m[my0:my1, mx0:mx1] = 1.0
    if window.ndim == 5:                      # [B, C, T, H, W] -> [B, 1, T, H, W]
        b, _, f = window.shape[0], window.shape[1], window.shape[2]
        return m.view(1, 1, 1, h, w).expand(b, 1, f, h, w).contiguous()
    b = window.shape[0]                        # [B, C, H, W] -> [B, 1, H, W]
    return m.view(1, 1, h, w).expand(b, 1, h, w).contiguous()


def _match_dc(out, ref, mask):
    """
    Shift each tile's generated region so its per-channel MEAN matches the
    plate's over the same region. Mean only -- no std.

    Adjacent tiles are independent generations, so each lands on a slightly
    different DC level. The plate is continuous, so matching every tile back to
    it removes the brightness step at the join without touching structure.
    Unlike a std match, this cannot alter detail: it is a constant offset.
    """
    dims = tuple(range(2, out.ndim))
    m = (mask > 0.5).to(out.dtype)
    denom = m.sum(dim=dims, keepdim=True).clamp(min=1.0)
    om = (out * m).sum(dim=dims, keepdim=True) / denom
    rm = (ref * m).sum(dim=dims, keepdim=True) / denom
    return torch.where(m > 0.5, out - om + rm, out)


def _match_stats(out, ref, mask):
    """
    Per-channel mean/std match of the generated region against its source.

    Sequential conditioning propagates texture, but it propagates drift too --
    across a wide frame, contrast and saturation can ramp so the far side no
    longer matches the near side. Renormalising each tile against the plate it
    came from pins that down without touching structure.
    """
    dims = tuple(range(2, out.ndim))
    sel = mask > 0.5
    if sel.sum() == 0:
        return out
    om, osd = out.mean(dim=dims, keepdim=True), out.std(dim=dims, keepdim=True)
    rm, rsd = ref.mean(dim=dims, keepdim=True), ref.std(dim=dims, keepdim=True)
    scaled = (out - om) / (osd + 1e-6) * (rsd + 1e-6) + rm
    return torch.where(sel, scaled, out)


# --------------------------------------------------------------------------
# nodes
# --------------------------------------------------------------------------
