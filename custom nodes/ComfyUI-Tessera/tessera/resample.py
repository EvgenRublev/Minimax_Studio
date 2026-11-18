"""
Per-tile supersampling.

Crop the tile at plate scale, generate it at a *higher* resolution, then
downsample the result back before writing it into the plate. The model spends
its capacity at the higher resolution and the downsample concentrates that
detail -- classic supersampling, and it recovers the sharpness that a
strictly-once refinement pass gives up.

Two scaling paths:

  latent  interpolate the latent tensor directly. Cheap, no VAE, keeps the
          node's one-encode-one-decode property. Latents don't interpolate as
          cleanly as pixels, but the input is about to be denoised anyway, so
          the model absorbs most of the crudeness.

  pixel   decode -> resize in pixel space -> re-encode. Faithful resampling,
          at the cost of two extra VAE round trips per tile. This is what the
          crop-and-stitch chain was effectively doing.
"""

import torch
import torch.nn.functional as F

_NO_ALIGN = {"nearest", "nearest-exact", "area"}


def resize_latent(t, w, h, mode="bicubic"):
    """
    Resize the spatial dims of a latent, 4D [B,C,H,W] or 5D [B,C,T,H,W].

    5D is folded to 4D by moving T into the batch dim, because F.interpolate's
    trilinear path would resample across time as well -- which would smear
    motion, not resolution.
    """
    if t.shape[-2] == h and t.shape[-1] == w:
        return t
    kw = {} if mode in _NO_ALIGN else {"align_corners": False}

    if t.ndim == 5:
        b, c, f, oh, ow = t.shape
        x = t.permute(0, 2, 1, 3, 4).reshape(b * f, c, oh, ow)
        x = F.interpolate(x.float(), size=(h, w), mode=mode, **kw)
        x = x.reshape(b, f, c, h, w).permute(0, 2, 1, 3, 4)
        return x.contiguous().to(t.dtype)

    if t.ndim == 4:
        return F.interpolate(t.float(), size=(h, w), mode=mode, **kw).to(t.dtype)

    raise ValueError(f"unexpected latent rank {t.ndim}; expected 4 or 5")


def resize_mask(m, w, h):
    """
    Nearest-resample a mask so it stays binary. A smoothed mask edge would put
    partial values on the border, which differential diffusion reads as a
    schedule offset -- a silent change in behaviour, not just a soft edge.
    """
    if m.shape[-2] == h and m.shape[-1] == w:
        return m
    return resize_latent(m, w, h, mode="nearest-exact")


def edge_extend(t, x0, x1, y0, y1):
    """
    Replace everything outside [y0:y1, x0:x1] with replicate padding of that
    region.

    Needed before downsampling a supersampled tile. The resize kernel spans the
    mask boundary, so it would otherwise pull the *un-denoised* context border
    into the outermost cells of the region about to be pasted -- a one-cell
    (32px at 4K) under-refined band at every tile edge, i.e. a visible grid.
    Extending the interior outward means the kernel only ever sees refined
    content, and because the window keeps its full size the coordinate mapping
    stays exact.
    """
    H, W = t.shape[-2], t.shape[-1]
    pad = (x0, W - x1, y0, H - y1)
    if not any(pad):
        return t
    inner = t[..., y0:y1, x0:x1]
    ih, iw = y1 - y0, x1 - x0

    if t.ndim == 5:
        b, c, f = t.shape[0], t.shape[1], t.shape[2]
        x = inner.permute(0, 2, 1, 3, 4).reshape(b * f, c, ih, iw)
        x = F.pad(x.float(), pad, mode="replicate")
        x = x.reshape(b, f, c, H, W).permute(0, 2, 1, 3, 4)
        return x.contiguous().to(t.dtype)

    return F.pad(inner.float(), pad, mode="replicate").to(t.dtype)


def _as_image(img):
    """
    Coerce a VAE.decode result to ComfyUI's IMAGE contract: 4D [T,H,W,C].

    Video VAEs (H3/LTX) return 5D [B,T,H,W,C] from decode, but comfy's
    VAE.encode is written for the 4D IMAGE type -- it rebuilds the video
    layout itself (movedim + unsqueeze in sd.py). Feeding it 5D is a trap:
    vae_encode_crop_pixels crops EVERY dim between batch and channels to a
    multiple of the *spatial* compression, which on 5D input includes the
    temporal axis. Each pixel round trip then silently drops frames to a
    multiple of 16 until a later encode sees zero frames and dies with
    torch.cat() on an empty list. Folding B into T here (B is 1 for these
    latents) keeps every frame and routes through comfy's intended path.
    """
    if img.ndim == 5:
        img = img.reshape(-1, *img.shape[-3:])
    return img


def resize_pixels(img, w, h, method="bicubic"):
    """Resize decoded frames [T,H,W,C] spatially, frame count untouched."""
    import comfy.utils
    x = img.movedim(-1, 1)
    x = comfy.utils.common_upscale(x, w, h, method, "disabled")
    return x.movedim(1, -1)


def to_gen(window, gen_cw, gen_ch, cell, space, method, vae=None):
    """Tile latent at plate scale -> tile latent at generation scale."""
    if space == "latent":
        return resize_latent(window, gen_cw, gen_ch, method)
    if vae is None:
        raise ValueError("scale_space='pixel' requires a VAE input")
    img = _as_image(vae.decode(window))
    img = resize_pixels(img, gen_cw * cell, gen_ch * cell, method)
    return vae.encode(img)


def from_gen(out, tile_cw, tile_ch, cell, space, method, vae=None):
    """Generated tile latent -> back to plate scale, ready to paste."""
    if space == "latent":
        return resize_latent(out, tile_cw, tile_ch, method)
    if vae is None:
        raise ValueError("scale_space='pixel' requires a VAE input")
    img = _as_image(vae.decode(out))
    img = resize_pixels(img, tile_cw * cell, tile_ch * cell, method)
    return vae.encode(img)
