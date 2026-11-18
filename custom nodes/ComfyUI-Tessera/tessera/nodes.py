"""
Tessera -- ROI / saliency-aware sequential tiled video refinement.

What V2 adds over V1, and why (grounded in the T1-T3 bench, 2026-08-11/12):

  * ROI selection. The bench showed uniform full-frame refinement is the slow
    opt-in path (~2 min/tile at 1088-class tiles), while 70%+ of a typical
    frame is background that the plate already serves. V2 takes a saliency
    MASK (from SAM2, a face detector, or a hand-painted mask) and can skip
    tiles whose generated region carries no salience -- the "hero tiles only"
    production mode that keeps a 10s clip inside the 5-15 min budget.

  * Per-class sigma schedules. T2/T3 measured the entry-sigma knee directly:
    hot entries (0.85) maximise detail but destabilise texture and eat
    mid-band structure; cold entries (0.60) preserve but soften. V2 lets
    salient tiles run a hotter schedule (`hero_sigmas`) while everything else
    runs the base schedule -- detail where it pays, stability where it shows.

  * dc_match defaults ON. It is a constant offset per tile (cannot alter
    structure) and the T3 composite showed the DC step at tile joins is the
    main residual seam signal.

Everything else -- sequential write-back, cell-aligned geometry, AV latent
handling, supersampling -- lives in core.py (shared latent/plan machinery), so
fixes there propagate here.
"""

import math
import os as _os
import time

import torch

from .geometry import (build_plan, format_plan, verify_coverage,
                       auto_tile_axis, GeometryError, DEFAULT_CELL)
from .preview import (render_plan, render_error, to_comfy_image,
                      first_frame_to_pil)
from .resample import _as_image

from . import core as _core
from .core import (split_latent, rewrap_latent, _null_masks, _full_mask,
                    _tile_mask, _match_dc, _window, _paste,
                    _spatial_dims, detect_cell, detect_patch, detect_temporal,
                    _fmt, _pbar_enabled)

_SAMPLING_OK = _core._SAMPLING_OK
if _SAMPLING_OK:
    import comfy.sample
    import comfy.samplers
    import comfy.utils
    import comfy.model_management
    from comfy.ldm.minimax.model import FRAME_PER_TOKEN

try:
    import latent_preview as _latent_preview
    _PREVIEW_OK = True
except Exception:                                          # pragma: no cover
    _PREVIEW_OK = False

try:
    from tqdm.auto import tqdm
except Exception:                                          # pragma: no cover
    tqdm = None


# --------------------------------------------------------------------------
# nodes
# --------------------------------------------------------------------------

class TesseraPlan:
    """
    Dry-run of the refine node's geometry: tile grid, hero rect, ref-crop
    preview (EXACT SLICE vs RESAMPLED), motion oracle. Run it before
    committing GPU time. The `settings` output carries this node's geometry
    settings to the refine node's `plan` input, so tiling is configured in
    ONE place.
    """

    CATEGORY = "Tessera"
    RETURN_TYPES = ("IMAGE", "STRING", "IMAGE", "TESSERA_PLAN")
    RETURN_NAMES = ("diagram", "plan", "ref_crop", "settings")
    FUNCTION = "run"
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # ---- plate ------------------------------------------------
                "width":          ("INT", {"default": 3840, "min": 64, "max": 16384, "step": 8}),
                "height":         ("INT", {"default": 2176, "min": 64, "max": 16384, "step": 8}),
                # ---- tiling (mirrors the refine node) ---------------------
                # AUTO TILE SIZING. off = use tile_width/tile_height.
                # low_vram / high_vram pick the fewest evenly-spread tiles
                # under a 768px / 1024px per-side cap, sized and positioned
                # on the ref-grid unit so per-tile ref crops slice exactly.
                "spatial_tile":   (["high_vram", "low_vram", "custom"],),
                # manual tile size -- used only when spatial_tile = custom
                "tile_width":     ("INT", {"default": 1024, "min": 64, "max": 4096,  "step": 8}),
                "tile_height":    ("INT", {"default": 1024, "min": 64, "max": 4096,  "step": 8}),
                "context_border": ("INT", {"default": 64,   "min": 0,  "max": 512,   "step": 8}),
                # ---- hero -------------------------------------------------
                "hero_min":       ("INT", {"default": 896, "min": 0, "max": 4096, "step": 32}),
                "hero_fit":       (["median", "union"],),
                # ---- temporal preview (mirrors the refine node) ----------
                # frames = the clip length FED TO THE REFINE NODE (after
                # any dilation; wire frame_map below and the plan accounts
                # for the dilation ratio exactly like the refine node).
                # 0 = skip the temporal preview.
                "frames":         ("INT", {"default": 0, "min": 0, "max": 8192}),
                "temporal_tile":  (["high_vram", "low_vram", "custom",
                                    "off"],),
                "temporal_size":  ("INT", {"default": 124, "min": 0, "max": 1024}),
                "temporal_overlap": ("INT", {"default": 4, "min": 0, "max": 16}),
                # ---- preview ----------------------------------------------
                "diagram_width":  ("INT", {"default": 1500, "min": 512, "max": 4096, "step": 2}),
                # Preview the CROPPED REFERENCE for this tile index on the
                # `ref_crop` output (first frame, first video ref). Needs the
                # `positive` conditioning (carrying minimax_refs) and `vae`
                # inputs connected. -1 = the hero tile (when a hero_mask is
                # wired). The preview crop is cell-exact; the sampler's crop
                # may extend up to one DiT patch further (patch alignment).
                "ref_tile":       ("INT", {"default": -1, "min": -1, "max": 4096}),
            },
            "optional": {
                # subject mask for the tracked hero tile (see refine node);
                # the plan draws the resulting hero rect and auto-anchor
                "hero_mask":     ("MASK",),
                # spatial guide_noise: corruption weighted by this mask
                # (0..1); freedom only where painted. See the noising
                # function's docstring.
                "guide_noise_mask": ("MASK",),
                # Drawn under the tile overlay (first frame of a video batch)
                # so you can see exactly which content lands in which tile --
                # e.g. whether a face straddles a tile boundary -- before
                # spending sampling time.
                "preview_image": ("IMAGE",),
                "positive":      ("CONDITIONING",),
                "vae":           ("VAE",),
                # wire the dilate node's frame_map to preview the
                # dilation-aware window/cap scaling
                "frame_map":     ("STRING", {"default": "",
                                             "forceInput": True}),
            },
        }

    def run(self, width, height, tile_width, tile_height, context_border,
            diagram_width=1500, ref_tile=-1,
            frames=0, temporal_tile="high_vram", temporal_size=124,
            temporal_overlap=4, frame_map="",
            hero_fit="median", hero_min=896, spatial_tile="high_vram",
            # retired widgets, hardcoded to the validated choices
            hero_pad=64, tile_layout="even",
            hero_mask=None, preview_image=None, positive=None, vae=None,
            ref_latent=None):
        tile_auto = spatial_tile
        # H3's VAE is 16x; detect from the VAE when wired, else assume H3
        spatial_compression = detect_cell(vae) or 16
        order = "raster"
        anchor_x = anchor_y = -1
        settings = {"tile_auto": tile_auto, "tile_width": tile_width,
                    "tile_height": tile_height,
                    "context_border": context_border,
                    "tile_layout": tile_layout, "hero_pad": hero_pad,
                    "hero_fit": hero_fit, "hero_min": hero_min,
                    "width": width, "height": height}
        q = _ref_snap_q(positive, ref_latent,
                        width // spatial_compression,
                        height // spatial_compression)

        if tile_auto == "off":           # legacy workflows
            tile_auto = "custom"
        # resolve the temporal choice exactly like the refine node
        _dratio = 1.0
        if frame_map:
            try:
                import json as _json0
                _fm0 = _json0.loads(frame_map)
                _dratio = (len(_fm0)
                           / max(1, len(set(int(x) for x in _fm0))))
                if frames <= 0:
                    frames = len(_fm0)
            except Exception:
                _dratio = 1.0
        _tt_scale = True
        if temporal_tile == "high_vram":
            temporal_chunk = 124
        elif temporal_tile == "low_vram":
            temporal_chunk = 73
        elif temporal_tile == "off":
            temporal_chunk, _tt_scale = 0, False
        else:
            temporal_chunk, _tt_scale = temporal_size, False
        _cap_ratio = _dratio
        if _dratio > 1.05 and temporal_chunk > 0 and _tt_scale:
            _tc0 = temporal_chunk
            temporal_chunk = int(
                -(-(temporal_chunk * _dratio - 5) // 17) * 17 + 5)
            print(f"[TesseraPlan] dilation-aware budget: x{_dratio:.2f} "
                  f"dilation -> temporal_tile {_tc0} -> {temporal_chunk} "
                  f"dilated frames (same real content per window)")
            # CLIP-LENGTH CLAMP (r74): the cap shrink pays for the
            # scaled window, but a clip shorter than the window never
            # fills it -- the real token count is tile area x
            # min(window, clip). Measured: a 90-frame clip at x1.61
            # dilation got cap 1024 -> 768 and 15 small tiles for a
            # sequence that fit the BASE window at full cap.
            _base_lat = (_tc0 - 5) // 17 * 5 + 2
            _scaled_lat = (temporal_chunk - 5) // 17 * 5 + 2
            _clip_lat = (frames - 5) // 17 * 5 + 2 if frames >= 22 else 0
            _eff = min(_scaled_lat, _clip_lat) if _clip_lat else _scaled_lat
            _cap_ratio = max(1.0, min(_eff / _base_lat, _dratio))
        if tile_auto != "custom":
            cap = 768 if tile_auto == "low_vram" else 1024
            if _cap_ratio > 1.05 and temporal_chunk > 0 and _tt_scale:
                _cap0 = cap
                cap = max(512, (int(cap / math.sqrt(_cap_ratio)) // 64) * 64)
                print(f"[TesseraPlan] dilation-aware budget: tile cap "
                      f"{_cap0} -> {cap}px (token budget held flat)")
            elif _dratio > 1.05 and temporal_chunk > 0 and _tt_scale:
                print(f"[TesseraPlan] dilation-aware budget: clip fits "
                      f"the base window -- tile cap stays {cap}px")
            grid_px = spatial_compression * 2 * max(1, q)
            try:
                tw_auto, _ = auto_tile_axis(width, cap, context_border,
                                            snap=grid_px)
                th_auto, _ = auto_tile_axis(height, cap, context_border,
                                            snap=grid_px)
            except GeometryError as e:
                msg = f"GEOMETRY ERROR\n{e}"
                print(f"[TesseraPlan] {msg}")
                img = to_comfy_image(render_error(str(e), diagram_width))
                return {"ui": {"text": [msg]},
                        "result": (img, msg, torch.zeros(1, 8, 8, 3),
                                   settings)}
            if (tile_width, tile_height) != (tw_auto, th_auto):
                print(f"[TesseraPlan] tile_auto={tile_auto} (cap {cap}px): "
                      f"tiles {tw_auto}x{th_auto} chosen for {width}x{height} "
                      f"(tile_width/tile_height widgets ignored)")
            tile_width, tile_height = tw_auto, th_auto

        hero_rect = None
        if hero_mask is not None:
            if q > 1:
                print(f"[TesseraPlan] hero snapped to "
                      f"{spatial_compression * 2 * q}px grid so its ref crop "
                      f"slices exactly (video ref is 1/{q} plate scale)")
            hb = _hero_bbox_from_mask(hero_mask, width, height, hero_pad,
                                      spatial_compression * 2 * q,
                                      fit=hero_fit)
            if hb is not None:
                hb = _hero_floor(hb, hero_min, width, height,
                                 spatial_compression * 2 * q)
                hero_rect = hb
                if anchor_x < 0 or anchor_y < 0:
                    anchor_x = (hb[0] + hb[2]) // 2
                    anchor_y = (hb[1] + hb[3]) // 2
                    if order in ("raster", "serpentine"):
                        order = "anchor_out"
        try:
            plan = build_plan(width, height, tile_width, tile_height,
                              context_border, order, cell=spatial_compression,
                              anchor_x_px=anchor_x, anchor_y_px=anchor_y,
                              placement=tile_layout,
                              pos_snap_px=(spatial_compression * 2 * q
                                           if q > 1 else 0),
                              hero_rect_px=hero_rect)
        except GeometryError as e:
            msg = f"GEOMETRY ERROR\n{e}"
            print(f"[TesseraPlan] {msg}")
            img = to_comfy_image(render_error(str(e), diagram_width))
            return {"ui": {"text": [msg]}, "result": (img, msg,
                                                      torch.zeros(1, 8, 8, 3),
                                                      settings)}

        if hero_rect is not None:
            plan["hero_rect_px"] = hero_rect
        cov = verify_coverage(plan)
        txt = format_plan(plan) + (
            f"\n\ncoverage: {'OK' if cov['ok'] else 'BROKEN'}  "
            f"({cov['total']} cells, {cov['never']} never generated, "
            f"{cov['twice_or_more']} generated more than once)"
        )

        if hero_rect is not None:
            hx0, hy0, hx1, hy1 = hero_rect
            txt += (f"\n\nhero tile: {hx1-hx0}x{hy1-hy0}px at ({hx0},{hy0}) "
                    f"-- runs FIRST, no border, frozen context for the grid; "
                    f"grid auto-anchored on its center")

        if frames > 0 and temporal_chunk >= 0:
            F = int(frames)
            T_lat = (F - 5) // 17 * 5 + 2 if F >= 22 else 1
            tl = []
            if temporal_chunk == 0 or T_lat <= 1:
                tl.append(f"temporal plan: {F} frames ({T_lat} latent) "
                          f"-- one window (unchunked)")
            else:
                cl = (temporal_chunk - 5) // 17 * 5 + 2
                if cl >= T_lat:
                    tl.append(f"temporal plan: {F} frames ({T_lat} "
                              f"latent) -- temporal_tile "
                              f"{temporal_chunk} covers the whole clip "
                              f"(unchunked)")
                else:
                    stride = max(1, cl - temporal_overlap)
                    last = T_lat - cl
                    n_mv = max(1, -(-last // stride))
                    pos = sorted(set(round(i * last / n_mv)
                                     for i in range(n_mv + 1)))
                    body = []
                    gs = 0
                    for p in pos:
                        body.append(f"[{p}+{gs - p}:{cl}]")
                        gs = p + cl
                    _real = temporal_chunk / _dratio
                    tl.append(f"temporal plan: {F} frames ({T_lat} "
                              f"latent) -> {len(pos)} chunk(s), window "
                              f"{temporal_chunk} frames"
                              + (f" (~{_real:.0f} real content frames "
                                 f"at x{_dratio:.2f} dilation)"
                                 if _dratio > 1.05 else "")
                              + f", border {temporal_overlap}: "
                              + ", ".join(body)
                              + " (even-spread preview; the refine node "
                                "may slide hand-offs to regime minima)")
                    _floor = 100 if _dratio > 1.05 else 56
                    if _real < _floor if _dratio > 1.05                             else temporal_chunk < _floor:
                        tl.append(f"WARNING: ~"
                                  f"{temporal_chunk / _dratio:.0f} real "
                                  f"frames per window is below the "
                                  f"content-time floor (~{_floor}) -- "
                                  f"expect texture churn / flicker")
            for _l in tl:
                if _l.startswith("WARNING"):
                    _warn(f"[TesseraPlan] {_l}")
                else:
                    print(f"[TesseraPlan] {_l}")
            txt += "\n\n" + "\n".join(tl)

        if ref_latent is not None:
            rz = ref_latent.get("samples")
            rz = split_latent(rz)[0] if rz is not None else None
            _, mo_spans, mo_fast = _motion_oracle(rz)
            if mo_spans or mo_fast is not None:
                _motion_report("TilePlanV2", mo_spans, mo_fast)
                if mo_fast is not None:
                    txt += (f"\n\nmotion oracle: clip is GLOBALLY high-"
                            f"motion (median ~{mo_fast:.1f} latent cells/"
                            f"frame, smear threshold ~1.2) -- prefer "
                            f"gentler detail settings")
                else:
                    txt += ("\n\nmotion oracle -- high-motion span(s): "
                            + ", ".join(f"latent {a}-{b} "
                                        f"(~px f{_lat_to_px_frame(a)}-"
                                        f"f{_lat_to_px_frame(b)}, "
                                        f"peak {r:.1f} cells/frame)"
                                        for a, b, r in mo_spans))

        print(f"[TesseraPlan]\n{txt}")
        bg = None
        if preview_image is not None:
            try:
                bg = first_frame_to_pil(preview_image)
            except Exception as e:
                print(f"[TesseraPlan] preview_image ignored ({e})")
        img = to_comfy_image(render_plan(plan, diagram_width, coverage=cov,
                                         background=bg))

        ref_img = torch.zeros(1, 8, 8, 3)
        hero_preview = (ref_tile == -1 and hero_rect is not None
                        and positive is not None and vae is not None)
        if ref_tile >= 0 or hero_preview:
            if positive is None or vae is None:
                print("[TesseraPlan] ref_tile set but positive/vae not "
                      "connected -- ref_crop output is blank")
            elif not hero_preview and ref_tile >= plan["count"]:
                print(f"[TesseraPlan] ref_tile={ref_tile} but the plan has "
                      f"indices 0..{plan['count'] - 1}")
            else:
                LW, LH = plan["latent_size"]
                if hero_preview:
                    sc = spatial_compression
                    t = {"x": hero_rect[0] // sc, "y": hero_rect[1] // sc,
                         "w": (hero_rect[2] - hero_rect[0]) // sc,
                         "h": (hero_rect[3] - hero_rect[1]) // sc}
                    print("[TesseraPlan] ref_crop preview: HERO tile "
                          "(wire ref_tile >= 0 to preview a grid tile instead)")
                else:
                    t = plan["tiles"][ref_tile]
                pos_eff = positive
                if ref_latent is not None:
                    rz = ref_latent["samples"]
                    swapped = False
                    pos_eff = []
                    for emb, d in positive:
                        refs = d.get("minimax_refs")
                        if not refs:
                            pos_eff.append([emb, d])
                            continue
                        nr = []
                        for b in refs:
                            if not swapped and "video" in b.get("kind", ""):
                                nb = dict(b)
                                nb["latent"] = rz
                                nb["latent_h"] = int(rz.shape[-2])
                                nb["latent_w"] = int(rz.shape[-1])
                                nr.append(nb)
                                swapped = True
                            else:
                                nr.append(b)
                        nd = dict(d)
                        nd["minimax_refs"] = nr
                        pos_eff.append([emb, nd])
                    if swapped:
                        print(f"[TesseraPlan] previewing with ref_latent "
                              f"override ({int(rz.shape[-1])}x"
                              f"{int(rz.shape[-2])} cells)")
                cropped, did = _crop_minimax_refs(
                    pos_eff, t["x"], t["y"], t["w"], t["h"], LW, LH, patch=1)
                blk = next((b for _, d in cropped
                            for b in (d.get("minimax_refs") or [])
                            if "video" in b.get("kind", "")), None)
                if blk is None:
                    print("[TesseraPlan] ref_tile set but the conditioning "
                          "carries no video reference")
                elif not did:
                    print("[TesseraPlan] reference found but nothing was "
                          "cropped (unexpected)")
                else:
                    # Decode the FULL reference (post-override/normalize)
                    # and crop in PIXELS. Decoding a cropped latent adds
                    # conv edge artifacts the sampler never sees (it reads
                    # tokens; it doesn't decode crops), so a latent-crop
                    # decode overstates corruption. Full decode + pixel crop
                    # shows the tokens' true content. Frame 0 only.
                    full_blk = next(b for _, d in pos_eff
                                    for b in (d.get("minimax_refs") or [])
                                    if "video" in b.get("kind", ""))
                    zf = full_blk["latent"]
                    px = _as_image(vae.decode(zf))[:1]
                    ph, pw = px.shape[1], px.shape[2]
                    cx0 = int(round(t["x"] / LW * pw))
                    cy0 = int(round(t["y"] / LH * ph))
                    cx1 = int(round((t["x"] + t["w"]) / LW * pw))
                    cy1 = int(round((t["y"] + t["h"]) / LH * ph))
                    ref_img = px[:, cy0:cy1, cx0:cx1, :]
                    if bg is not None:
                        # side-by-side: source tile region (left) vs decoded
                        # ref crop (right), matched in size -- framing,
                        # proportion and artifact differences read at a glance
                        from PIL import Image as _PIL
                        import numpy as _np
                        LWp, LHp = plan["latent_size"]
                        sw, sh = bg.size
                        sx0 = int(round(t["x"] / LWp * sw))
                        sy0 = int(round(t["y"] / LHp * sh))
                        sx1 = int(round((t["x"] + t["w"]) / LWp * sw))
                        sy1 = int(round((t["y"] + t["h"]) / LHp * sh))
                        src = bg.crop((sx0, sy0, sx1, sy1))
                        rh, rw = ref_img.shape[1], ref_img.shape[2]
                        src = src.resize((rw, rh), _PIL.LANCZOS)
                        s_t = torch.from_numpy(
                            _np.asarray(src.convert("RGB"),
                                        dtype=_np.float32) / 255.0
                        ).unsqueeze(0)
                        gap = torch.zeros(1, rh, 8, 3)
                        ref_img = torch.cat(
                            [s_t, gap, ref_img.to(s_t.dtype)], dim=2)
                    # report whether the refine node would slice or resample
                    bh0 = next(int(b.get("latent_h", 0)) for _, d in pos_eff
                               for b in (d.get("minimax_refs") or [])
                               if "video" in b.get("kind", ""))
                    bw0 = next(int(b.get("latent_w", 0)) for _, d in pos_eff
                               for b in (d.get("minimax_refs") or [])
                               if "video" in b.get("kind", ""))
                    # mirror the refine node's grid normalization
                    g0 = math.gcd(int(LW), int(LH))
                    u0w, u0h = int(LW) // g0, int(LH) // g0
                    k0 = max(1, int(round((bw0 / u0w + bh0 / u0h) / 2.0)))
                    nw, nh = u0w * k0, u0h * k0
                    sx, sy = nw / float(LW), nh / float(LH)
                    vals = (t["x"] * sx, t["y"] * sy,
                            (t["x"] + t["w"]) * sx, (t["y"] + t["h"]) * sy)
                    exact = (all(abs(v - round(v)) < 1e-6 for v in vals)
                             and int(round(vals[2] - vals[0])) % 2 == 0
                             and int(round(vals[3] - vals[1])) % 2 == 0)
                    if (nw, nh) != (bw0, bh0):
                        print(f"[TesseraPlan] ref will be grid-normalized "
                              f"{bw0}x{bh0} -> {nw}x{nh} at refine time")
                    print(f"[TesseraPlan] ref_crop preview: tile {ref_tile} -> "
                          f"{blk['latent_w']}x{blk['latent_h']} latent cells "
                          f"({ref_img.shape[2]}x{ref_img.shape[1]} px decoded) "
                          f"· {'EXACT SLICE' if exact else 'RESAMPLED (fractional/odd fit)'}")

        return {"ui": {"text": [txt]}, "result": (img, txt, ref_img,
                                                  settings)}


def _align_span(lo, hi, size, align):
    """Expand [lo, hi) outward to a multiple-of-`align` span within [0, size).

    The DiT patchifies reference latents in align x align patches, so a crop
    whose height or width is not a multiple of the patch size cannot be
    reshaped (patchify_video RuntimeError). Expanding outward -- never
    shrinking -- means the aligned crop always covers at least the tile's
    content.
    """
    lo = (lo // align) * align
    hi = min(size, ((hi + align - 1) // align) * align)
    span = ((hi - lo) // align) * align
    if span <= 0:
        span = min((size // align) * align, align)
    if span <= 0:                       # ref smaller than one patch: no crop
        return 0, size
    hi = min(size, lo + span)
    lo = max(0, hi - span)
    return lo, hi


def _crop_minimax_refs(cond, x, y, w, h, lw, lh, patch=2, kinds=("video",)):
    """
    Return a copy of `cond` whose H3 reference blocks (minimax_refs) are
    cropped to the tile window [x, y, w, h] (plate latent-cell coords, plate
    grid lw x lh cells).

    Only the FIRST block of each kind in `kinds` ("video", "image") is
    cropped -- by convention the first video carries the source clip and the
    first image its (upscaled) first frame, both spatially aligned with the
    plate, so a tile window maps 1:1 onto their content. Every other block
    (further images/videos, audio) passes through WHOLE: identity stills /
    character sheets are not spatially aligned views of the frame, and
    cropping them would hand the tile a meaningless corner of the reference.

    The cropped block's window is mapped proportionally onto its own latent
    grid (the reference may be any resolution), then aligned outward to the
    DiT patch grid (`patch`). Temporal extent is kept in full: the reference
    stays a complete performance, just spatially narrowed to this tile.
    """
    out = []
    changed = False
    for emb, d in cond:
        refs = d.get("minimax_refs")
        if not refs:
            out.append([emb, d])
            continue
        new_refs = []
        done = set()
        for blk in refs:
            kind = blk.get("kind", "")
            base = "video" if "video" in kind else kind
            z = blk.get("latent")
            if z is None or base not in kinds or base in done:
                new_refs.append(blk)
                continue
            done.add(base)
            bh = int(blk.get("latent_h", z.shape[-2]))
            bw = int(blk.get("latent_w", z.shape[-1]))

            # Normalize the ref grid to plate proportions. Comfy's H3
            # reference node re-canvases videos with a 768x1344 area cap
            # regardless of its width/height widgets, so a 1.79-AR source
            # comes back 1344x768: squeezed ~2.3% AND proportionally
            # mismatched with the plate (every crop fractional). One global
            # bilinear resize to the nearest plate-aligned grid fixes both:
            # geometry back to true aspect, and all tile crops become exact
            # slices. One uniform resample beats a fractional one per tile.
            g = math.gcd(int(lw), int(lh))
            ulw, ulh = int(lw) // g, int(lh) // g
            k = max(1, int(round((bw / ulw + bh / ulh) / 2.0)))
            tgw, tgh = ulw * k, ulh * k
            if (bw, bh) != (tgw, tgh):
                key = "_REF_NORM_NOTED"
                if not globals().get(key):
                    globals()[key] = True
                    print(f"[TesseraRefine] reference latent {bw}x{bh} does "
                          f"not match plate proportions {lw}x{lh} -- "
                          f"resizing once to {tgw}x{tgh} (corrects the ref "
                          f"node's canvas squeeze; enables exact tile slices)")
                x5 = z.ndim == 5
                zz = (z.permute(0, 2, 1, 3, 4)
                       .reshape(-1, z.shape[1], bh, bw) if x5 else z)
                zz = torch.nn.functional.interpolate(
                    zz.float(), size=(tgh, tgw), mode="bilinear",
                    align_corners=False).to(z.dtype)
                if x5:
                    zz = zz.reshape(z.shape[0], z.shape[2], z.shape[1],
                                    tgh, tgw).permute(0, 2, 1, 3, 4).contiguous()
                z = zz
                bw, bh = tgw, tgh

            sx, sy = bw / float(lw), bh / float(lh)
            fx0, fy0 = x * sx, y * sy
            fx1, fy1 = (x + w) * sx, (y + h) * sy
            ints = all(abs(v - round(v)) < 1e-6 for v in (fx0, fy0, fx1, fy1))
            if ints and int(round(fx1 - fx0)) % patch == 0 \
                    and int(round(fy1 - fy0)) % patch == 0:
                # window lands exactly on the ref grid: plain slice
                rx0, ry0 = int(round(fx0)), int(round(fy0))
                rx1, ry1 = int(round(fx1)), int(round(fy1))
                zc = z[..., ry0:ry1, rx0:rx1]
            else:
                if not globals().get("_REF_FRAC_WARNED"):
                    globals()["_REF_FRAC_WARNED"] = True
                    _warn(f"[TesseraRefine] WARNING: a tile window does not "
                          f"land on the reference grid (window "
                          f"{fx0:.1f}..{fx1:.1f} x {fy0:.1f}..{fy1:.1f} ref "
                          f"cells; spans must be integers and multiples of "
                          f"{patch}). Its ref crop is RESAMPLED -- latent "
                          f"interpolation, which shifts/softens the ref and "
                          f"shows up as tile drift at high denoise. Fix: make "
                          f"tile sizes/positions multiples of "
                          f"{patch * max(1, lw // max(1, bw))} plate latent "
                          f"cells (x16 for px).")
                # Fractional landing. Rounding the bounds outward would make
                # the ref cover MORE than the tile shows -- geometrically
                # wrong, and at high denoise (where the ref owns the
                # geometry) it renders as a zoom-out/offset of the whole
                # tile. Instead sample the EXACT fractional window with
                # grid_sample onto a patch-aligned grid: geometry exact,
                # size legal for the DiT patchifier.
                tw = max(patch, int(round((fx1 - fx0) / patch)) * patch)
                th = max(patch, int(round((fy1 - fy0) / patch)) * patch)
                x5 = z.ndim == 5
                zz = (z.permute(0, 2, 1, 3, 4)
                       .reshape(-1, z.shape[1], bh, bw) if x5 else z)
                # normalized coords of the window center-span, align_corners=False
                gx = torch.linspace(fx0 + (fx1 - fx0) / (2 * tw),
                                    fx1 - (fx1 - fx0) / (2 * tw), tw,
                                    dtype=torch.float32)
                gy = torch.linspace(fy0 + (fy1 - fy0) / (2 * th),
                                    fy1 - (fy1 - fy0) / (2 * th), th,
                                    dtype=torch.float32)
                gx = gx * (2.0 / bw) - 1.0
                gy = gy * (2.0 / bh) - 1.0
                grid = torch.stack(
                    torch.meshgrid(gy, gx, indexing="ij")[::-1], dim=-1
                ).unsqueeze(0).expand(zz.shape[0], -1, -1, -1).to(
                    device=zz.device, dtype=torch.float32)
                zc = torch.nn.functional.grid_sample(
                    zz.float(), grid, mode="bilinear",
                    padding_mode="border", align_corners=False).to(z.dtype)
                if x5:
                    zc = zc.reshape(z.shape[0], z.shape[2], z.shape[1], th, tw
                                    ).permute(0, 2, 1, 3, 4).contiguous()
            nb = dict(blk)
            nb["latent"] = zc
            nb["latent_h"], nb["latent_w"] = zc.shape[-2], zc.shape[-1]
            new_refs.append(nb)
            changed = True
        nd = dict(d)
        nd["minimax_refs"] = new_refs
        out.append([emb, nd])
    return (out, changed)


def _px_start(k):
    """First pixel frame of latent frame k (H3: 1, 4, 4, 4, 4 px per latent)."""
    return sum(FRAME_PER_TOKEN[j % 5] for j in range(k))


def _tile_ref_items(refs, pixels, kinds, x, y, w, h, lw, lh, f0, f1, px_full):
    """Rebuild the ref node's Qwen presentation (minimax_ref_items) for one
    tile window: the first block of each kind in `kinds` is cropped to the
    window in PIXELS (from the full-frame decode, so no crop-decode edge
    artifacts), video blocks are sliced to pixel frames [f0, f1) when they
    span the whole gen, and everything else is presented whole. Same order
    and 2 fps sampling as MiniMaxH3ReferenceToVideo."""
    items, done = [], set()
    for blk, px in zip(refs, pixels):
        kind = blk.get("kind", "")
        if px is None:
            items.append({"type": "audio"})
            continue
        base = "video" if "video" in kind else "image"
        if base in kinds and base not in done:
            done.add(base)
            ph, pw = px.shape[1], px.shape[2]
            px = px[:, round(y / lh * ph):round((y + h) / lh * ph),
                    round(x / lw * pw):round((x + w) / lw * pw)]
        if base == "image":
            items.append({"type": "image", "data": px[:1]})
            continue
        if px.shape[0] == px_full:
            px = px[f0:f1]
        if kind == "video_audio":
            items.append({"type": "audio"})
        frames = px[::12]
        items.append({"type": "video", "data": frames,
                      "timestamps": [i / 2.0 for i in range(frames.shape[0])]})
    return items


def _inherit_guide(cond, work_m, upto):
    """Detail relay across temporal chunks: return a copy of `cond` whose
    full-span in-band guide latents have frames [0, upto) replaced by the
    refined canvas `work_m` (same latent grid as the guide, by the
    guide-grid law). Later chunks then see the ALREADY-REFINED output as
    evidence for everything before their generated range -- aligned by
    construction, graded by construction. With a detailed frame-0 anchor
    spliced into the guide clip, this relays its texture mandate forward:
    chunk 1 renders it, chunk 2 inherits chunk 1's render as truth, and so
    on. Only full-span video guides are touched (picture refs, audio and
    sliced spans pass through)."""
    if upto <= 0:
        return cond
    T = int(work_m.shape[2])
    out = []
    for emb, d in cond:
        kfs = d.get("minimax_keyframes")
        if not kfs:
            out.append([emb, d])
            continue
        nk, did = [], False
        for kf in kfs:
            z = kf.get("latent")
            if (z is None or z.ndim != 5 or int(z.shape[2]) != T
                    or z.shape[-2:] != work_m.shape[-2:]):
                nk.append(kf)
                continue
            nz = z.clone()
            nz[:, :, :upto] = work_m[:, :, :upto].to(device=z.device,
                                                     dtype=z.dtype)
            nkf = dict(kf)
            nkf["latent"] = nz
            nk.append(nkf)
            did = True
        if did:
            nd = dict(d)
            nd["minimax_keyframes"] = nk
            out.append([emb, nd])
        else:
            out.append([emb, d])
    return out


def _rect_sub(x0, y0, x1, y1, hx0, hy0, hx1, hy1):
    """Rectangle subtraction: [x0,x1)x[y0,y1) minus the hole -> <=4 rects."""
    hx0, hy0 = max(x0, hx0), max(y0, hy0)
    hx1, hy1 = min(x1, hx1), min(y1, hy1)
    if hx0 >= hx1 or hy0 >= hy1:
        return [(x0, y0, x1, y1)]
    out = []
    if hy0 > y0: out.append((x0, y0, x1, hy0))          # top band
    if hy1 < y1: out.append((x0, hy1, x1, y1))          # bottom band
    if hx0 > x0: out.append((x0, hy0, hx0, hy1))        # left of hole
    if hx1 < x1: out.append((hx1, hy0, x1, hy1))        # right of hole
    return out


def _ref_snap_q(positive, ref_latent, lw, lh):
    """Integer factor q such that the plate latent grid is q x the first
    video reference's grid (a 2752px plate over a 1376px source encode -> 2).

    The hero bbox must land on multiples of q * patch plate cells for its
    ref crop to be an EXACT, patch-aligned slice. A span like 864px (27 ref
    cells at half scale -- odd) cannot patchify, so the crop falls to the
    fractional-resample path: latent interpolation, the artifact source this
    pack exists to avoid. Snapping the hero to the coarser grid costs at
    most q*patch-1 cells of window growth and buys a clean slice.

    Returns 1 when there is no video ref or the ratio is non-integer
    (snapping cannot help there; the crop path prints its own warning)."""
    g = None
    if ref_latent is not None:
        rz = split_latent(ref_latent["samples"])[0]
        g = (int(rz.shape[-1]), int(rz.shape[-2]))
    elif positive is not None:
        for _, d in positive:
            for b in (d.get("minimax_refs") or []):
                if "video" in b.get("kind", ""):
                    g = (b.get("latent_w"), b.get("latent_h"))
                    break
            if g:
                break
    if not g or not g[0] or not g[1]:
        return 1
    gw, gh = g
    if gw > 0 and gh > 0 and lw % gw == 0 and lh % gh == 0 \
            and lw // gw == lh // gh:
        return lw // gw
    # tolerate the ref node's CANVAS SQUEEZE: a half-res ref often
    # arrives at e.g. 84x48 against a 172x96 plate (172/84 = 2.048,
    # non-integer), gets resized once to 86x48 at the tile loop -- but
    # by then the tiles are already sized on the q=1 grid and every
    # span lands at odd ref cells -> fractional resample (measured:
    # the dilation-shrunk cap produced 672px tiles = 21 ref cells and
    # the resample warning on every run). Detect the INTENDED ratio
    # within 8% and size the tiles for the grid the ref will have
    # after its correction.
    if gw > 0 and gh > 0:
        rw, rh = lw / gw, lh / gh
        qr = round((rw + rh) / 2)
        if (qr >= 2 and abs(rw - qr) / qr < 0.08
                and abs(rh - qr) / qr < 0.08):
            print(f"[Tessera] ref grid {gw}x{gh} vs plate {lw}x{lh}: "
                  f"treating as 1/{qr}-scale ref (canvas squeeze "
                  f"tolerated); tiles sized on the corrected grid")
            return qr
    return 1


def _hero_bbox_from_mask(mask, plate_w_px, plate_h_px, pad_px, unit,
                         fit="union"):
    """Bbox of a (possibly per-frame) MASK -> plate-px rect snapped outward
    to the unit grid. Returns (x0, y0, x1, y1) px or None.

    fit="union": the whole track fits the window (safe; can grow large).
    fit="median": median per-frame bbox size around the median center --
    tight head-fit for long tracks, at the cost that extreme frames may
    poke outside the hero window (those parts fall to the grid).
    """
    m = mask
    if m.ndim == 2:
        m = m[None]
    mh, mw = m.shape[-2], m.shape[-1]
    mask_ar, plate_ar = mw / mh, plate_w_px / plate_h_px
    if abs(mask_ar - plate_ar) / plate_ar > 0.02:
        _warn(f"[Tessera] WARNING: hero_mask is {mw}x{mh} "
              f"(AR {mask_ar:.3f}) but the plate is AR {plate_ar:.3f}. "
              f"If this mask is the tracker's CROP-SPACE output, the hero "
              f"window will be wrong -- wire the FULL-FRAME subject mask.")
    sy, sx = plate_h_px / mh, plate_w_px / mw
    boxes = []
    for f in range(m.shape[0]):
        idx = torch.nonzero(m[f] > 0.5)
        if idx.numel():
            boxes.append((float(idx[:, 1].min()), float(idx[:, 0].min()),
                          float(idx[:, 1].max()) + 1, float(idx[:, 0].max()) + 1))
    if not boxes:
        return None
    bx = torch.tensor(boxes)
    if fit == "median" and len(boxes) > 2:
        cx = torch.median((bx[:, 0] + bx[:, 2]) / 2)
        cy = torch.median((bx[:, 1] + bx[:, 3]) / 2)
        bw = torch.median(bx[:, 2] - bx[:, 0])
        bh = torch.median(bx[:, 3] - bx[:, 1])
        x0 = float(cx - bw / 2) * sx - pad_px
        x1 = float(cx + bw / 2) * sx + pad_px
        y0 = float(cy - bh / 2) * sy - pad_px
        y1 = float(cy + bh / 2) * sy + pad_px
    else:
        x0 = float(bx[:, 0].min()) * sx - pad_px
        y0 = float(bx[:, 1].min()) * sy - pad_px
        x1 = float(bx[:, 2].max()) * sx + pad_px
        y1 = float(bx[:, 3].max()) * sy + pad_px
    x0 = max(0, int(x0 // unit) * unit)
    y0 = max(0, int(y0 // unit) * unit)
    x1 = min(plate_w_px, int(-(-x1 // unit)) * unit)
    y1 = min(plate_h_px, int(-(-y1 // unit)) * unit)
    if x1 - x0 < 2 * unit: x1 = min(plate_w_px, x0 + 2 * unit)
    if y1 - y0 < 2 * unit: y1 = min(plate_h_px, y0 + 2 * unit)
    x0 = max(0, min(x0, x1 - 2 * unit))
    y0 = max(0, min(y0, y1 - 2 * unit))
    return (x0, y0, x1, y1)


def _hero_floor(hb, min_px, plate_w_px, plate_h_px, unit):
    """Grow the hero rect around its center to at least `min_px` per axis.

    A tight head-fit window can land far below the model's native band --
    a 320x448 hero is a 140-token generation steered by a 35-token ref, and
    measured against source it drifts (shift + zoom) at ANY denoise, super-
    sampled or not, while 960px tiles in the same run lock pixel-perfect.
    References pin composition only when the canvas is in the band the model
    was trained at, so the window gets a size floor and the face simply
    occupies less of it. 0 disables."""
    if not min_px:
        return hb
    x0, y0, x1, y1 = hb
    out = []
    for lo, hi, total in ((x0, x1, plate_w_px), (y0, y1, plate_h_px)):
        m = ((min_px + unit - 1) // unit) * unit
        m = min(m, (total // unit) * unit)
        if hi - lo >= m:
            out.append((lo, hi))
            continue
        c = (lo + hi) // 2
        nlo = ((c - m // 2) // unit) * unit
        nlo = max(0, min(nlo, ((total - m) // unit) * unit))
        out.append((nlo, nlo + m))
    (x0, x1), (y0, y1) = out
    return (x0, y0, x1, y1)


def _apply_seam_regen(selected, E, patch, LW, LH, forward=False):
    """Expand later-running tiles' masks across partitions shared with
    EARLIER-running tiles, by E cells (multiple of `patch`).

    forward=True flips the direction: the EARLIER tile grows forward into
    the later tile's side. The strip it gives up is frozen PLATE context
    (the truth anyway), so the later tile keeps its whole border of refined
    context -- growing the later tile backward halves that border, and at
    entry 1.0 a 32px refined anchor let it redraw a candle 30px off
    (measured). Both tiles generate the strip either way; the pixel
    compositor crossfades across it.

    Why: the last DiT patch of a tile's generated region, where it abuts
    frozen context that has not been refined yet, comes out texture-damped --
    the model blends toward the blurry plate it sees across the mask edge.
    Whichever tile runs first at a boundary bakes a soft ~1-patch strip into
    its side, and along a full row those strips line up into a visible line.
    The later tile regenerates that strip with refined context on both sides
    and overwrites it (later tiles paste later, in both the latent and pixel
    paths), so the strip comes out at full texture.

    Rules: expansion is only toward neighbors that (a) run earlier, (b) are
    not the hero, and (c) fully cover the edge segment. It also never
    consumes the whole frozen border -- at least `patch` cells of context
    stay frozen, so tiles keep communicating.

    HERO RIM: separately, every grid tile whose window holds a hero hole
    shrinks that hole by E on each side that lies strictly inside its own
    mask. The uncovered strip -- the hero's outer rim -- is then regenerated
    by the grid tile with refined content on both sides, which removes the
    residual displacement/tone step where the hero boundary crosses
    high-contrast content (measured: 2-3px + tone break on a dress edge).
    The hero's interior stays untouchable; only its outer E cells are
    re-owned, and the pixel compositor pastes the hero FIRST so the
    regenerated rim wins there while the face keeps hero pixels.
    Returns (n_edges, n_cells, n_rim_edges).
    """
    order_of = {}
    for pos, (t, _, _) in enumerate(selected):
        order_of.setdefault(id(t), pos)

    def rect(t):
        return (t["x"] + t["mx0"], t["y"] + t["my0"],
                t["x"] + t["mx1"], t["y"] + t["my1"])

    # neighbours are found on the ORIGINAL masks: a tile already grown
    # across one edge must not register as touching its neighbours'
    # other edges (it blocked the whole bottom row in forward mode)
    base = [t for t, _, _ in selected]
    n_edges = n_cells = 0
    grown = []
    for pos, (t, s, c) in enumerate(selected):
        if t.get("hero_tile"):
            continue
        bx0, by0, bx1, by1 = rect(t)
        new = dict(t)
        for side in ("left", "right", "top", "bottom"):
            if side == "left":
                if bx0 <= 0: continue
                seg = [(o, oy0, oy1) for (o, (ox0, oy0, ox1, oy1)) in
                       ((o2, rect(o2)) for o2 in base)
                       if ox1 == bx0 and oy0 < by1 and oy1 > by0]
            elif side == "right":
                if bx1 >= LW: continue
                seg = [(o, oy0, oy1) for (o, (ox0, oy0, ox1, oy1)) in
                       ((o2, rect(o2)) for o2 in base)
                       if ox0 == bx1 and oy0 < by1 and oy1 > by0]
            elif side == "top":
                if by0 <= 0: continue
                seg = [(o, ox0, ox1) for (o, (ox0, oy0, ox1, oy1)) in
                       ((o2, rect(o2)) for o2 in base)
                       if oy1 == by0 and ox0 < bx1 and ox1 > bx0]
            else:
                if by1 >= LH: continue
                seg = [(o, ox0, ox1) for (o, (ox0, oy0, ox1, oy1)) in
                       ((o2, rect(o2)) for o2 in base)
                       if oy0 == by1 and ox0 < bx1 and ox1 > bx0]
            if not seg:
                continue                       # boundary against plate/skip
            if any(o.get("hero_tile") for o, _, _ in seg):
                continue                       # never repaint the hero
            if forward:
                if any(order_of.get(id(o), -1) <= pos for o, _, _ in seg):
                    continue                   # an earlier tile owns (part of) it
            elif any(order_of.get(id(o), 1 << 30) >= pos for o, _, _ in seg):
                continue                       # a later tile owns (part of) it
            lo = (by0, bx0)[side in ("top", "bottom")]
            hi = (by1, bx1)[side in ("top", "bottom")]
            cover = sorted((max(a, lo), min(b, hi)) for _, a, b in seg)
            reach = lo
            for a, b in cover:
                if a > reach: break
                reach = max(reach, b)
            if reach < hi:
                continue                       # segment not fully refined
            # room check: keep >= patch cells of frozen context on that side
            if side == "left":
                e = min(E, new["mx0"] - patch)
                if e >= patch: new["mx0"] -= e; n_cells += e * (by1 - by0)
            elif side == "right":
                e = min(E, (new["w"] - new["mx1"]) - patch)
                if e >= patch: new["mx1"] += e; n_cells += e * (by1 - by0)
            elif side == "top":
                e = min(E, new["my0"] - patch)
                if e >= patch: new["my0"] -= e; n_cells += e * (bx1 - bx0)
            else:
                e = min(E, (new["h"] - new["my1"]) - patch)
                if e >= patch: new["my1"] += e; n_cells += e * (bx1 - bx0)
            if e >= patch:
                n_edges += 1
            elif E > 0:
                print(f"[TesseraRefine] seam_regen: tile {t['index']} {side} "
                      f"edge has no border room -- raise context_border "
                      f"(needs seam_regen + 1 patch of border on that side)")
        if new != t:
            selected[pos] = (new, s, c)
            order_of[id(new)] = pos     # keep order identity after mutation
            grown.append(new["index"])

    # ---- hero rim: shrink each grid tile's hero hole by E per interior side
    n_rim = 0
    for pos, (t, s, c) in enumerate(selected):
        if t.get("hero_tile") or "hole" not in t:
            continue
        hx0, hy0, hx1, hy1 = t["hole"]
        nh = [hx0, hy0, hx1, hy1]
        if hx0 > t["mx0"] and (hx1 - hx0) > E + 2 * patch:
            nh[0] += E; n_rim += 1
        if hx1 < t["mx1"] and (nh[2] - nh[0]) > E + 2 * patch:
            nh[2] -= E; n_rim += 1
        if hy0 > t["my0"] and (hy1 - hy0) > E + 2 * patch:
            nh[1] += E; n_rim += 1
        if hy1 < t["my1"] and (nh[3] - nh[1]) > E + 2 * patch:
            nh[3] -= E; n_rim += 1
        if tuple(nh) != (hx0, hy0, hx1, hy1):
            new = dict(t)
            new["hole"] = tuple(nh)
            selected[pos] = (new, s, c)
            order_of[id(new)] = pos
    return n_edges, n_cells, n_rim


def _crop_minimax_keyframes(cond, x, y, w, h, lw, lh, drop=False):
    """Crop in-band guide latents (minimax_keyframes, e.g. the H3 AddGuide
    node feeding an IC/detailer LoRA) to the tile window [x, y, w, h].

    Guides ride IN-BAND: PackedLayout sizes their token rows from the
    GENERATION's spatial grid ("keyframe cond rows share the target spatial
    grid"), so a frame-sized guide against a tile-sized gen is a hard shape
    mismatch. The AddGuide node resizes guides to the target's full pixel
    size before encoding, so the guide latent sits on the plate grid and a
    window slice is always EXACT -- no resampling, ever.

    drop=True strips guide latents instead (supersampled tiles: the gen is
    a different size from the window and the guide cannot follow without a
    pixel round trip). Audio guides and anchor indices pass through.
    Returns (cond, did_crop)."""
    out = []
    did = False
    for emb, d in cond:
        kfs = d.get("minimax_keyframes")
        if not kfs:
            out.append([emb, d])
            continue
        nk = []
        for kf in kfs:
            z = kf.get("latent")
            if z is None:
                nk.append(kf)
                continue
            if drop:
                nkf = dict(kf)
                nkf.pop("latent", None)
                nk.append(nkf)
                did = True
                continue
            if int(z.shape[-1]) != lw or int(z.shape[-2]) != lh:
                if not globals().get("_KF_SIZE_WARNED"):
                    globals()["_KF_SIZE_WARNED"] = True
                    _warn(f"[TesseraRefine] WARNING: guide latent "
                          f"{int(z.shape[-1])}x{int(z.shape[-2])} cells does "
                          f"not match the plate grid {lw}x{lh} -- cannot crop "
                          f"per tile, passing through whole (the DiT will "
                          f"likely reject it). Feed the AddGuide node the "
                          f"guide at the PLATE's resolution.")
                nk.append(kf)
                continue
            nkf = dict(kf)
            nkf["latent"] = z[..., y:y + h, x:x + w]
            nk.append(nkf)
            did = True
        nd = dict(d)
        nd["minimax_keyframes"] = nk
        out.append([emb, nd])
    return out, did


_NOCOLOR = bool(_os.environ.get("NO_COLOR"))


def _warn(msg):
    """Console warning in yellow (NO_COLOR env disables)."""
    print(msg if _NOCOLOR else f"\033[93m{msg}\033[0m")


def _scratch_dirs():
    """Candidate dirs for disk-backed buffers, best first: LTX_SCRATCH
    (env override), the system temp dir, ComfyUI's output dir."""
    import tempfile as _tf
    cand = []
    for _v in ("TESSERA_SCRATCH", "LTX_SCRATCH"):
        env = _os.environ.get(_v)
        if env:
            cand.append(env)
    cand.append(_tf.gettempdir())
    try:
        import folder_paths
        cand.append(folder_paths.get_output_directory())
    except Exception:
        pass
    out = []
    for d in cand:
        if d and d not in out and _os.path.isdir(d):
            out.append(d)
    return out


def _free_bytes(d):
    try:
        import shutil as _sh
        return _sh.disk_usage(d).free
    except OSError:
        return 0


def _motion_oracle(z, thresh=2.0, min_span=2):
    """Jerk oracle, stage 1: per-latent-frame motion profile of a video
    latent [B,C,T,H,W]. Motion = mean |z_t - z_{t-1}|; frames sustaining
    more than `thresh` x the clip's median for >= min_span latent frames
    are flagged as high-motion spans -- where model-side fast-motion
    smearing concentrates (measured: VAE round trip is clean on fast
    frames; the damage is rendering, and detail stacks sharpening motion
    blur into invented anatomy make it worse). Returns (motions, spans)
    with spans as (lat_t0, lat_t1, peak_ratio)."""
    if z is None or z.ndim != 5 or z.shape[2] < 3:
        return None, [], None
    zf = z.float()
    dt = (zf[:, :, 1:] - zf[:, :, :-1]).abs().mean(dim=(0, 1, 3, 4)).cpu()
    dx = (zf[..., 1:] - zf[..., :-1]).abs().mean(dim=(0, 1, 3, 4)).cpu()
    dy = (zf[..., 1:, :] - zf[..., :-1, :]).abs().mean(dim=(0, 1, 3, 4)).cpu()
    sg = ((dx[1:] + dy[1:]) / 2).clamp_min(1e-6)
    disp = dt / sg                       # ~latent cells moved per latent frame
    med = float(disp.median())
    # ABSOLUTE scale: ~>1.2 cells/latent-frame is where model-side smearing
    # starts (calibrated on measured-problematic footage at 1.25-2.85; calm
    # locked-off content reads well below 1)
    FAST = 1.2
    hot = ((disp > FAST) | (disp > thresh * max(med, 1e-6))).tolist()
    spans, s = [], None
    for i, h in enumerate(hot):
        if h and s is None:
            s = i
        elif not h and s is not None:
            if i - s >= min_span:
                spans.append((s + 1, i + 1, float(disp[s:i].max())))
            s = None
    if s is not None and len(hot) - s >= min_span:
        spans.append((s + 1, len(hot) + 1, float(disp[s:].max())))
    global_fast = med if (sum(hot) > 0.7 * len(hot)) else None
    return [float(x) for x in disp], spans, global_fast


def _lat_to_px_frame(l):
    """Approximate pixel-frame index of latent frame l (H3: 2 latent = first
    5 px frames, then 5 latent per 17 px)."""
    return 0 if l < 2 else round((l - 2) * 17 / 5 + 5)


def _match_dc_frame(out, ref, mask):
    """Per-TEMPORAL-FRAME DC match of the generated region to the plate.

    The v1 matcher shifts one constant per tile, which removes the spatial
    brightness step between adjacent tiles but cannot correct a temporal
    ramp: a chunk's first generated frames can land a few gray levels off
    and recover over ~4 frames (measured as a visible flash at the chunk
    seam under reduced-entry schedules, where the model corrects DC less
    aggressively than at full denoise). Brightness is plate truth frame by
    frame, so match it frame by frame. Still a constant offset per frame --
    it cannot touch structure. Frames whose mask is empty (frozen temporal
    borders) are untouched."""
    if out.ndim < 5:
        # no temporal axis: identical to the per-tile constant match
        dims = tuple(range(2, out.ndim))
    else:
        dims = (-2, -1)
    m = (mask > 0.5).to(out.dtype)
    denom = m.sum(dim=dims, keepdim=True).clamp(min=1.0)
    om = (out * m).sum(dim=dims, keepdim=True) / denom
    rm = (ref * m).sum(dim=dims, keepdim=True) / denom
    return torch.where(m > 0.5, out - om + rm, out)


def _decode_stream_video(vae, z, as_image, frame_map=""):
    """Segmented causal decode of a long H3 video latent, streaming into ONE
    preallocated CPU tensor.

    A monolithic vae.decode() of a long 4K clip must materialize the whole
    float32 pixel tensor INSIDE the VAE (plus scratch) -- measured as a
    Windows access violation in write_part at ~45GB on a 447-frame 4K
    canvas. Here the latent is decoded in small segments along the H3
    block structure (head 2 latents <-> 5 px frames, then 5 latents <-> 17
    px frames per block): each interior segment is decoded with a
    1-block+head lead whose 22 warm-up px frames are DROPPED (causal
    context, same principle as chunk borders), and only the kept frames are
    written into the output. Peak memory = one small segment decode + the
    single output tensor. The output falls back to float16 storage when
    even one float32 copy would exceed ~12GB (downstream save nodes
    convert to uint8 anyway; the note is printed).

    With `frame_map` (Tessera Temporal Dilate's map, wired through), duplicated
    frames are dropped DURING the decode: the output is the decimated
    real-time clip and the Temporal Decimate node passes it through
    untouched.

    Returns the IMAGE tensor, or None when the latent is not an H3 ladder
    shape (caller falls back to the monolithic decode)."""
    import json as _json
    if z.ndim != 5 or (int(z.shape[2]) - 2) % 5:
        return None
    T = int(z.shape[2])
    Kb = (T - 2) // 5
    px_T = 5 + 17 * Kb
    keep = None
    fmap_l = None
    if frame_map:
        try:
            fmap = _json.loads(frame_map)
            if len(fmap) != px_T:
                print(f"[TesseraRefine] frame_map length {len(fmap)} != "
                      f"{px_T} px frames -- ignored (wire the SAME Dilate "
                      f"node's frame_map here)")
            else:
                fmap_l = [int(x) for x in fmap]
                first = {}
                for j, fi in enumerate(fmap):
                    if fi not in first:
                        first[int(fi)] = j
                keep = torch.zeros(px_T, dtype=torch.bool)
                keep[sorted(first.values())] = True
                print(f"[TesseraRefine] frame_map wired: decimating "
                      f"{px_T} -> {int(keep.sum())} frames during the "
                      f"decode (Temporal Decimate then passes through)")
        except Exception as e:
            print(f"[TesseraRefine] frame_map ignored ({e})")
    n_out = int(keep.sum()) if keep is not None else px_T

    M = 2                                   # blocks per segment (34 px)
    segs = []
    b = 0
    while b < Kb:
        m = min(M, Kb - b)
        segs.append((b, m))
        b += m

    out = None
    out_dtype = None
    wrote = 0
    twin_idx, twin_n = {}, {}
    n_avg = 0
    for (b, m) in segs:
        if b == 0:
            zin = z[:, :, :2 + 5 * m]
            drop = 0                        # head segment: keep everything
            g0 = 0
        else:
            zin = z[:, :, 5 * (b - 1):2 + 5 * (b + m)]
            drop = 22                       # 1-block+head warm-up, dropped
            g0 = 5 + 17 * b                 # global px index of first kept
        px = as_image(vae.decode(zin))
        px = px[drop:] if drop else px
        if out is None:
            Hp, Wp = int(px.shape[1]), int(px.shape[2])
            need32 = n_out * Hp * Wp * 3 * 4
            out_dtype = torch.float32
            if need32 > 12 << 30:
                out_dtype = torch.float16
                print(f"[TesseraRefine] streamed decode: output "
                      f"{need32 / (1 << 30):.1f}GB as float32 -- storing "
                      f"float16 ({need32 / (2 << 30):.1f}GB). Save nodes "
                      f"convert to 8-bit anyway.")
            print(f"[TesseraRefine] streamed decode: {len(segs)} segment(s) "
                  f"of ~{17 * M} px frames, {n_out} frame(s) kept, "
                  f"peak ~= one segment + the output tensor")
            # Large whole-clip output tensors go to a DISK-BACKED buffer
            # PROACTIVELY, not just on allocation failure. Two measured
            # crashes on a 294-frame 2.7K canvas (6.9GB fp16): first the
            # allocation itself failed cleanly; after the reactive
            # fallback, the allocation SUCCEEDED -- and the win starved
            # Windows commit (RAM+pagefile) so the very next VAE segment
            # died as an access violation inside write_part. A file-backed
            # memmap does not charge commit at all (pages are backed by
            # the file, not the pagefile), so the VAE keeps the headroom
            # it has on short runs. Downstream nodes read it
            # transparently through the page cache.
            def _disk_out(why):
                import glob as _gl
                import numpy as _np
                import tempfile as _tf
                import weakref as _wr
                # sweep ORPHANED buffers from earlier runs first: a
                # buffer still referenced by Comfy's output cache is
                # memory-mapped, and Windows refuses to delete a mapped
                # file -- so try-delete is self-guarding (on Linux the
                # space frees when the mapping closes). Measured: a few
                # back-to-back long runs fill the temp drive at ~8.6GB
                # per clip.
                _dirs = _scratch_dirs()
                _freed = 0
                for _d in _dirs:
                    for _pat in ("tessera_decode_*.raw", "ltx_decode_*.raw"):
                      for _old in _gl.glob(_os.path.join(_d, _pat)):
                          try:
                              _sz = _os.path.getsize(_old)
                              _os.unlink(_old)
                              _freed += _sz
                          except OSError:
                              pass    # still mapped by a live output
                if _freed:
                    print(f"[TesseraRefine] streamed decode: freed "
                          f"{_freed / (1 << 30):.1f}GB of orphaned "
                          f"decode buffer(s) from earlier runs")
                # pick the first candidate dir with room for the whole
                # buffer (measured: a 67.6GB buffer died at [Errno 28]
                # on a tight temp drive AFTER 8h49m of sampling); fall
                # back to the roomiest one with a warning
                _dir = None
                for _d in _dirs:
                    if _free_bytes(_d) >= need * 1.05:
                        _dir = _d
                        break
                if _dir is None:
                    _dir = max(_dirs, key=_free_bytes)
                    _warn(f"[TesseraRefine] streamed decode: NO scratch "
                          f"dir has the {need / (1 << 30):.1f}GB this "
                          f"buffer needs (best: {_dir}, "
                          f"{_free_bytes(_dir) / (1 << 30):.1f}GB free) "
                          f"-- attempting anyway; set TESSERA_SCRATCH to a "
                          f"roomier drive")
                elif _dir != _tf.gettempdir():
                    print(f"[TesseraRefine] streamed decode: scratch on "
                          f"{_dir} ({_free_bytes(_dir) / (1 << 30):.0f}GB "
                          f"free)")
                _np_dt = (_np.float16 if out_dtype == torch.float16
                          else _np.float32)
                _tmp = _tf.NamedTemporaryFile(prefix="tessera_decode_",
                                              suffix=".raw", delete=False,
                                              dir=_dir)
                _path = _tmp.name
                _tmp.close()
                _mm = _np.memmap(_path, dtype=_np_dt, mode="w+",
                                 shape=(n_out, Hp, Wp, 3))
                _t = torch.from_numpy(_mm)
                # delete the file the moment the tensor is garbage
                # collected (Comfy evicting it from the output cache).
                # The memmap must close before Windows allows the
                # unlink, so drop the mapping reference first.
                def _cleanup(path=_path, mm_ref=[_mm]):
                    try:
                        mm_ref.clear()
                        _os.unlink(path)
                    except OSError:
                        pass          # next run's sweep will catch it
                _wr.finalize(_t, _cleanup)
                print(f"[TesseraRefine] streamed decode: {why} -- "
                      f"output streams to a disk-backed buffer "
                      f"({_path}; deleted automatically when the "
                      f"output is released; stale buffers swept on "
                      f"the next run).")
                return _t

            need = n_out * Hp * Wp * 3 * \
                (2 if out_dtype == torch.float16 else 4)
            if need > (4 << 30):
                out = _disk_out(f"output tensor is "
                                f"{need / (1 << 30):.1f}GB, above the "
                                f"4GB in-RAM ceiling (protects the VAE "
                                f"from commit exhaustion)")
            else:
                try:
                    out = torch.empty((n_out, Hp, Wp, 3),
                                      dtype=out_dtype, device="cpu")
                except RuntimeError:
                    out = _disk_out("system RAM refused the output "
                                    "tensor")
        for j in range(px.shape[0]):
            g = g0 + j
            if keep is None or bool(keep[g]):
                out[wrote] = px[j].to(device="cpu", dtype=out_dtype)
                if fmap_l is not None and keep is not None:
                    s = fmap_l[g]
                    twin_idx[s] = wrote
                    twin_n[s] = 1
                wrote += 1
            elif fmap_l is not None:
                # ---- render-twin AVERAGING (dilated clips only) ----------
                # Dilation renders each duplicated source frame as
                # INDEPENDENT latent frames, and at 2x slow motion the real
                # content barely changes per frame -- so the model's
                # per-frame texture invention dominates the frame-to-frame
                # delta, and decimation doubles that churn's apparent rate
                # (measured: detail oscillation 5.3-6.8% on dilated chunked
                # runs vs 2.4% undilated, in BOTH auto and full modes --
                # uniformity is not the cause, doubling is). Each kept
                # frame becomes the running MEAN of its render-twin group:
                # aligned content is identical between twins and survives
                # at full strength; uncorrelated invention stacks down by
                # sqrt(n) -- frame stacking. By the persistence law, detail
                # that does not survive its own twin was noise.
                s = fmap_l[g]
                idx = twin_idx.get(s)
                if idx is not None:
                    c = twin_n[s]
                    f32 = out[idx].float()
                    f32 += (px[j].float().to("cpu") - f32) / (c + 1)
                    out[idx] = f32.to(out_dtype)
                    twin_n[s] = c + 1
                    n_avg += 1
        del px
    if n_avg:
        print(f"[TesseraRefine] render-twin averaging: {n_avg} dropped "
              f"duplicate render(s) averaged into their kept frames "
              f"(aligned content survives; uncorrelated invention stacks "
              f"out)")
    return out


def _motion_report(tag, spans, global_fast):
    if global_fast is not None:
        print(f"[{tag}] motion oracle: clip is GLOBALLY high-motion "
              f"(median ~{global_fast:.1f} latent cells/frame; smear "
              f"threshold ~1.2). Fast content renders smeared at high "
              f"denoise, and detail LoRAs sharpen motion blur into "
              f"invented structure (hands, thin objects). Consider "
              f"gentler detail settings for this clip (dilation: future "
              f"stage).")
        return
    if not spans:
        return
    shown = sorted(spans, key=lambda s: -s[2])[:4]
    shown = sorted(shown)
    body = ", ".join(f"latent {a}-{b} (~px f{_lat_to_px_frame(a)}-"
                     f"f{_lat_to_px_frame(b)}, peak {r:.1f})"
                     for a, b, r in shown)
    more = f" +{len(spans) - len(shown)} more" if len(spans) > len(shown) \
        else ""
    print(f"[{tag}] motion oracle: {len(spans)} high-motion span(s), "
          f"strongest: {body}{more} (cells/latent-frame; fast content "
          f"smears at high denoise -- consider dilation)")


def _latent_blur_hw(z, sigma=1.5):
    """Small spatial gaussian over the last two dims of a latent (any lead
    dims), separable conv. Used to split guide noise into bands -- NOT for
    resampling content (size never changes)."""
    r = max(1, int(3 * sigma))
    x = torch.arange(-r, r + 1, dtype=torch.float32)
    k = torch.exp(-(x ** 2) / (2 * sigma ** 2))
    k = (k / k.sum()).to(z.device)
    lead = z.shape[:-2]
    h, w = z.shape[-2], z.shape[-1]
    f = z.reshape(-1, 1, h, w).float()
    f = torch.nn.functional.conv2d(f, k.view(1, 1, -1, 1), padding=(r, 0))
    f = torch.nn.functional.conv2d(f, k.view(1, 1, 1, -1), padding=(0, r))
    return f.reshape(*lead, h, w).to(z.dtype)


def _noise_minimax_keyframes(cond, amount, seed, band="full",
                             tmode="per_frame", mask=None):
    """Conditioning noise augmentation for in-band video guides: mix
    deterministic unit noise into every guide latent, z' = (1-a)z + a*n*std.
    Blur tells the model the truth is SMOOTH (it renders smoothness --
    measured); noise tells it the truth is UNCERTAIN, licensing synthesis
    above the guide's band while the surviving signal still anchors
    geometry. The video analog of comfy's audio_cond_noise_aug. Applied
    ONCE per run (same noise for every tile/chunk crop, so neighboring
    tiles see a consistent guide). Returns (cond, did).

    tmode controls the noise's TEMPORAL structure (video guides only):
      per_frame -- independent noise every frame. Maximum synthesis freedom,
                   but the uncertainty license changes frame to frame, so
                   invented texture swims and temporal chunks re-derive it
                   differently (measured: chunk-seam frame-diff 5.6-9.2 vs
                   3.2 baseline at amount 0.5).
      smooth    -- the same noise low-passed along T (5-frame window,
                   re-normalized to unit std). WARNING: persistent faint
                   structure reads as CONTENT to the model -- measured as
                   ghosting at amount 0.5. Low amounts only.
      static    -- ONE noise field broadcast across all frames. Same
                   ghost/dirty-window risk, stronger. Low amounts only.

    mask (optional, pixel MASK [N,H,W], values 0..1) makes the
    corruption SPATIAL: amount is scaled per latent cell by the mask,
    so re-decision freedom lands only where painted (smudged distant
    faces) while everything else keeps the full clamp (measured: amount
    0.5 static turned background smudges into credible faces but also
    quietly re-decided storefront shelves -- the mask buys the first
    without the second). N=1 broadcasts over time; N=frame-count maps
    per latent frame via the 17k+5 ladder. A mask made from the dilated
    plate must itself live in dilated time."""
    if amount <= 0.0:
        return cond, False
    out, did = [], False
    for emb, d in cond:
        kfs = d.get("minimax_keyframes")
        if not kfs:
            out.append([emb, d])
            continue
        nk = []
        for kf in kfs:
            z = kf.get("latent")
            if z is None:
                nk.append(kf)
                continue
            gen = torch.Generator("cpu").manual_seed(int(seed) ^ 0x6B1D)
            n = torch.randn(z.shape, generator=gen, dtype=torch.float32)
            if tmode != "per_frame" and n.ndim == 5 and n.shape[2] > 1:
                if tmode == "static":
                    n = n[:, :, :1].expand_as(n).contiguous()
                else:                                   # smooth
                    k = min(5, n.shape[2])
                    p = torch.nn.functional.pad(
                        n, (0, 0, 0, 0, k // 2, k - 1 - k // 2),
                        mode="replicate")
                    n = torch.nn.functional.avg_pool3d(
                        p, kernel_size=(k, 1, 1), stride=1)
                    n = n / n.std().clamp(min=1e-6)      # back to unit std
            n = (n * z.float().std()).to(device=z.device, dtype=z.dtype)
            a = amount
            if mask is not None and z.ndim == 5:
                mm = mask.float().clamp(0.0, 1.0)
                if mm.ndim == 2:
                    mm = mm[None]
                T = int(z.shape[2])
                if mm.shape[0] > 1 and T > 1:
                    idx = [min(_lat_to_px_frame(t), mm.shape[0] - 1)
                           for t in range(T)]
                    mm = mm[idx]
                else:
                    mm = mm[:1].expand(T, -1, -1)
                mm = torch.nn.functional.interpolate(
                    mm[None], size=z.shape[-2:], mode="bilinear",
                    align_corners=False)[0]
                a = (amount * mm[None, None]).to(device=z.device,
                                                 dtype=torch.float32)
            nkf = dict(kf)
            if band == "fine":
                # noise only the guide's FINE band: low frequencies (layout,
                # object placement, the low-freq trace of thin structures
                # like jewelry) stay bit-exact as anchor; only texture-scale
                # content is released for synthesis
                zl = _latent_blur_hw(z)
                zh = z - zl
                nh = n - _latent_blur_hw(n)
                nkf["latent"] = (zl + zh * (1.0 - a) + nh * a).to(z.dtype)
            else:
                nkf["latent"] = (z * (1.0 - a) + n * a).to(z.dtype)
            nk.append(nkf)
            did = True
        nd = dict(d)
        nd["minimax_keyframes"] = nk
        out.append([emb, nd])
    return out, did


def _crop_cond_temporal(cond, t0, t1, T_full):
    """Slice every H3 conditioning latent (video reference blocks AND in-band
    guide latents) to the temporal chunk [t0, t1) of the gen latent.

    The ref clip and the guide clip cover the same pixel-frame span as the
    gen, so their latent time axes line up 1:1 with the gen's and an integer
    slice is exact -- the temporal analog of the spatial ref-grid law.
    Blocks whose temporal length differs from the gen's full T pass through
    whole with a one-time warning (a mismatched span retimes motion).
    Picture refs (T==1) and audio blocks pass through. Returns (cond, did)."""
    out, did = [], False
    for emb, d in cond:
        nd = dict(d)
        changed = False
        for key in ("minimax_refs", "minimax_keyframes"):
            blks = d.get(key)
            if not blks:
                continue
            nb = []
            for blk in blks:
                z = blk.get("latent")
                if z is None or z.ndim != 5 or int(z.shape[2]) <= 1:
                    nb.append(blk)              # picture ref / audio / empty
                    continue
                if int(z.shape[2]) != T_full:
                    if not globals().get("_T_SPAN_WARNED"):
                        globals()["_T_SPAN_WARNED"] = True
                        _warn(f"[TesseraRefine] WARNING: {key} latent has "
                              f"{int(z.shape[2])} temporal frames but the gen "
                              f"has {T_full} -- cannot slice per chunk, "
                              f"passing through whole (expect retiming)")
                    nb.append(blk)
                    continue
                nblk = dict(blk)
                nblk["latent"] = z[:, :, t0:t1]
                if key == "minimax_refs":
                    # PackedLayout counts video-ref rows from METADATA
                    # (blk["latent_t"]), not the tensor -- update it, or the
                    # layout expects full-clip rows against a sliced tensor
                    # ([5040, 96] vs [9360, 96], measured the hard way)
                    if "latent_t" in nblk:
                        nblk["latent_t"] = int(t1 - t0)
                    at = int(nblk.get("ref_audio_t") or 0)
                    if at > 0:
                        alen = max(1, round(at * (t1 - t0) / T_full))
                        a0 = min(max(0, round(at * t0 / T_full)), at - alen)
                        nblk["ref_audio_t"] = alen
                        az = nblk.get("audio_latent")
                        if az is not None and az.shape[-1] == at:
                            nblk["audio_latent"] = az[..., a0:a0 + alen]
                else:
                    az = nblk.get("audio_latent")
                    if az is not None and az.shape[-1] > 1:
                        at = int(az.shape[-1])
                        alen = max(1, round(at * (t1 - t0) / T_full))
                        a0 = min(max(0, round(at * t0 / T_full)), at - alen)
                        nblk["audio_latent"] = az[..., a0:a0 + alen]
                nb.append(nblk)
                did = True
            nd[key] = nb
            changed = True
        out.append([emb, nd] if changed else [emb, d])
    return out, did


def _feather_weight(h, w, f, open_edges):
    """[h, w] float32 blend weight, linear ramps of width `f` on the edges
    marked open (interior edges). Closed edges (frame boundary) stay 1."""
    wt = torch.ones(h, w, dtype=torch.float32)
    f = min(f, h // 2, w // 2)
    if f > 0:
        ramp = (torch.arange(f, dtype=torch.float32) + 1.0) / f
        if open_edges[0]: wt[:f, :] *= ramp.view(-1, 1)
        if open_edges[1]: wt[h - f:, :] *= ramp.flip(0).view(-1, 1)
        if open_edges[2]: wt[:, :f] *= ramp.view(1, -1)
        if open_edges[3]: wt[:, w - f:] *= ramp.flip(0).view(1, -1)
    return wt


def _px_lowpass(x, k=48):
    """Low-frequency color field of [T,H,W,C] pixels (cheap: down/up resize)."""
    t = x.permute(0, 3, 1, 2).float()
    h, w = t.shape[-2], t.shape[-1]
    th, tw = max(2, h // k), max(2, w // k)
    small = torch.nn.functional.interpolate(t, size=(th, tw), mode="area")
    big = torch.nn.functional.interpolate(small, size=(h, w), mode="bilinear",
                                          align_corners=False)
    return big.permute(0, 2, 3, 1)


def _px_color_match(tile_px, plate_px, mode):
    """Anchor tile_px's grade to plate_px (both [T,H,W,C], same size)."""
    if mode == "dc":
        d = (plate_px.float().mean(dim=(1, 2), keepdim=True)
             - tile_px.float().mean(dim=(1, 2), keepdim=True))
        return (tile_px.float() + d).clamp(0, 1).to(tile_px.dtype)
    # lowpass: transfer the plate's low-frequency color field
    d = _px_lowpass(plate_px) - _px_lowpass(tile_px)
    return (tile_px.float() + d).clamp(0, 1).to(tile_px.dtype)


def _px_shift(a, b):
    """Translation of `a` relative to `b` (both [T,H,W,C] pixels, same size)
    by cross-correlation of the frame-averaged luma, parabolic sub-pixel
    peak. (dx, dy) > 0 means a's content sits right/down of b's. Measures
    how far a tile's generation drifted off the plate geometry.

    8px area pooling and an UNwhitened correlation on purpose: the plate is
    soft, so whitening (phase correlation) amplifies the VAE's 16px latent
    grid texture shared by both images and the peak locks onto it --
    measured as exact 0.0 / +-16.0 readings while the content actually
    moved ~4px."""
    k = 8

    def prep(x):
        g = torch.nn.functional.avg_pool2d(
            x.float().mean(dim=(0, 3))[None, None], k, k)[0, 0]
        wy = torch.hann_window(g.shape[0], periodic=False).view(-1, 1)
        wx = torch.hann_window(g.shape[1], periodic=False).view(1, -1)
        return (g - g.mean()) * (wy * wx)
    ga, gb = prep(a), prep(b)
    f = torch.fft.rfft2(ga) * torch.conj(torch.fft.rfft2(gb))
    r = torch.fft.irfft2(f, s=ga.shape)
    h, w = r.shape
    iy, ix = divmod(int(torch.argmax(r)), w)

    def sub(c, m, p):
        d = m - 2 * c + p
        return 0.0 if abs(float(d)) < 1e-12 else 0.5 * float(m - p) / float(d)
    dy = iy + sub(r[iy, ix], r[iy - 1, ix], r[(iy + 1) % h, ix])
    dx = ix + sub(r[iy, ix], r[iy, ix - 1], r[iy, (ix + 1) % w])
    return ((dx - w if dx > w / 2 else dx) * k,
            (dy - h if dy > h / 2 else dy) * k)


def _tile_weight(t, E, LW, LH, dtype, device):
    """Per-cell paste weight [h, w] for a tile's mask rect, for overlap-mode
    latent accumulation.

    Interior edges (not on the plate canvas border) rise linearly over E
    cells -- the seam_regen strip both neighbours generated. A hero hole in
    the window is weighted 0 with the same ramp rising outward across the
    regenerated rim, so the hero keeps its interior and the rim crossfades.

    Weights are NOT meant to sum to 1 between neighbours: the caller
    accumulates sum(W*gen) and sum(W) and normalizes, which makes every
    doubly-generated strip an exact gen<->gen crossfade and rescales
    single-owner regions (edges against skipped tiles / plate) back to full
    weight instead of softening them."""
    h = t["my1"] - t["my0"]
    w = t["mx1"] - t["mx0"]

    def ramp(n, lo_open, hi_open):
        v = torch.ones(n, dtype=dtype, device=device)
        m = min(E, n)
        r = torch.arange(1, m + 1, dtype=dtype, device=device) / (E + 1)
        if not lo_open:
            v[:m] = torch.minimum(v[:m], r)
        if not hi_open:
            v[n - m:] = torch.minimum(v[n - m:], r.flip(0))
        return v

    ax0, ay0 = t["x"] + t["mx0"], t["y"] + t["my0"]
    wx = ramp(w, ax0 <= 0, ax0 + w >= LW)
    wy = ramp(h, ay0 <= 0, ay0 + h >= LH)
    W = torch.minimum(wy[:, None], wx[None, :])
    if t.get("hole"):
        hx0, hy0, hx1, hy1 = t["hole"]
        hx0 -= t["mx0"]; hx1 -= t["mx0"]
        hy0 -= t["my0"]; hy1 -= t["my0"]
        ix = torch.arange(w, dtype=dtype, device=device)
        iy = torch.arange(h, dtype=dtype, device=device)
        dx = torch.clamp(torch.maximum(hx0 - ix, ix - (hx1 - 1)), min=0)
        dy = torch.clamp(torch.maximum(hy0 - iy, iy - (hy1 - 1)), min=0)
        d = torch.maximum(dy[:, None], dx[None, :])     # 0 inside the hole
        W = torch.minimum(W, torch.clamp(d / (E + 1), max=1.0))
    return W


def _px_paste(canvas, tile_px, x0, y0, feather, open_edges, hole_px=None):
    """Feather-composite tile_px [T,h,w,C] onto canvas [T,H,W,C] at x0,y0.

    hole_px: optional (hx0, hy0, hx1, hy1) LOCAL px rect where the weight is
    forced to 0, with a `feather`-wide ramp rising outward from the hole
    edge. This pastes a holed region as ONE piece: decomposing it into
    sub-rectangles and feathering each separately blends the tile with the
    canvas along every internal cut -- a crosshatch of soft seams around
    the hole (observed exactly that way around the hero)."""
    _, h, w, _ = tile_px.shape
    wt = _feather_weight(h, w, feather, open_edges)
    if hole_px is not None:
        hx0, hy0, hx1, hy1 = hole_px
        f = max(1, min(feather, h // 2, w // 2))
        xs = torch.arange(w, dtype=torch.float32)
        ys = torch.arange(h, dtype=torch.float32)
        dx = torch.clamp(torch.maximum(hx0 - xs, xs - (hx1 - 1)), min=0)
        dy = torch.clamp(torch.maximum(hy0 - ys, ys - (hy1 - 1)), min=0)
        d = torch.maximum(dx.view(1, w).expand(h, w),
                          dy.view(h, 1).expand(h, w))
        wt = wt * torch.clamp(d / f, max=1.0)
    wt = wt.view(1, h, w, 1)
    reg = canvas[:, y0:y0 + h, x0:x0 + w, :]
    canvas[:, y0:y0 + h, x0:x0 + w, :] = (
        reg * (1.0 - wt) + tile_px.to(dtype=reg.dtype, device=reg.device) * wt)


_DEFAULT_PROMPT = """subject_definitions:
<Video 1>: the reference video. Its picture, motion, framing, timing and content are the target video's content.
<Picture 1> is a reference of a high resolution upscaled version of the first frame of the video. 

retention_analysis:
<Video 1>: fully_preserved - <Video 1> is reproduced one to one as the target video. Every frame matches the source.

Enhance this video with sharp, crisp details while preserving a natural photorealistic appearance."""


class TesseraRefine:
    """
    Sequential masked tiled refinement for MiniMax H3: hero-aware spatial
    tiling, temporal chunking, per-tile exact reference/guide slicing,
    guide-noise augmentation, motion-adaptive treatment, and a pixel-space
    output path. Wire Tile Plan V2's `settings` output to the `plan` input
    to configure the tile geometry in one place.
    """

    CATEGORY = "Tessera"
    RETURN_TYPES = ("LATENT", "STRING", "IMAGE")
    RETURN_NAMES = ("latent", "report", "image")
    FUNCTION = "run"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # NOTE: `model` is the only REQUIRED link; the other
                # essential sockets (positive/negative/latent/sampler/
                # sigmas) live in `optional` purely to control socket
                # ORDER in the UI (Comfy lists required links first).
                # run() fail-fasts with a clear message if any is unwired.
                "model":          ("MODEL",),
                # ---- MAIN OPTIONS (the per-shot decisions). Everything
                # advanced lives on the Refine Extra Options node, wired
                # into the `args` socket. ----------------------------------
                # auto tile sizing: fewest evenly-spread ~1MP (high_vram) /
                # ~0.6MP (low_vram) tiles, ref-grid aligned. off = manual
                # tile_width/height from the extras node.
                "spatial_tile":   (["high_vram", "low_vram", "custom"],),
                # manual tile size -- used only when spatial_tile = custom
                "tile_width":     ("INT", {"default": 1024, "min": 64, "max": 4096, "step": 8}),
                "tile_height":    ("INT", {"default": 1024, "min": 64, "max": 4096, "step": 8}),
                # temporal chunking: high_vram = 124-frame windows,
                # low_vram = 73 -- both mean REAL content frames and
                # scale with dilation automatically (the tile cap
                # shrinks in step to hold VRAM flat). custom = the
                # exact temporal_size below, no scaling. off = whole
                # clip in one window (the quality lane).
                "temporal_tile":  (["high_vram", "low_vram", "custom",
                                    "off"],),
                # window length used only when temporal_tile = custom
                # (17k+5 ladder; raw frames, NOT dilation-adjusted)
                "temporal_size":  ("INT", {"default": 124, "min": 0, "max": 1024}),
                # frozen context frames each later chunk inherits from the
                # previous chunk's refined output (latent frames).
                "temporal_overlap": ("INT", {"default": 4, "min": 0, "max": 16}),
                "context_border": ("INT", {"default": 64,  "min": 0,  "max": 512,  "step": 8}),
                # width of the seam strip BOTH neighbouring tiles generate
                # and crossfade (was seam_regen). 32 recommended; 0 = off.
                "seam_overlap":   ("INT", {"default": 32, "min": 0, "max": 128, "step": 32}),
                # minimum hero window size (px, 0 = off); 896 = measured
                # flicker floor. Active when hero_mask is wired.
                "hero_min":       ("INT", {"default": 896, "min": 0, "max": 4096, "step": 32}),
                # union = whole subject track fits the window (traveling
                # shots); median = tight window (static shots).
                "hero_fit":       (["median", "union"],),
                "cfg":            ("FLOAT", {"default": 1.0, "min": 0.0, "max": 20.0, "step": 0.1}),
                "seed":           ("INT", {"default": 1, "min": 0, "max": 0xFFFFFFFFFFFFFFFF}),
                # global = ONE noise field over the whole latent; cells
                # shared by two tiles or chunks get the same noise, so
                # crossfaded strips agree (the validated default).
                "seed_mode":      (["global", "fixed", "per_tile"],),
                "pixel_out":      ("BOOLEAN", {"default": True}),
                "console_progress": (["overall", "per_tile", "off"],),
                # per-tile text encode prompt (active when clip is wired):
                # MUST match the ref node's text. Defaults to the standard
                # upscale template.
                "prompt":         ("STRING", {"multiline": True,
                                              "default": _DEFAULT_PROMPT}),
            },
            "optional": {
                # Tail-split pair (with fine_below_sigma > 0): the model
                # and/or sampler that take over below the split sigma
                # (detail-LoRA model, euler for released tails).
                "model_fine":    ("MODEL",),
                # HERO MODEL SPLIT: the hero tile's HEAD runs this model
                # (grid tiles keep the main model). Pair with hero_sigmas
                # for the face hybrid: main = turbo, model_hero = clean.
                "model_hero":    ("MODEL",),
                # PER-TILE TEXT ENCODE (with ref_crop=per_tile): each
                # tile's embedding is re-encoded from its own cropped
                # reference (the whole-frame embedding paints the subject
                # into tiles that don't contain it). `prompt` below must be
                # the ref node's exact text. Needs vae.
                "clip":          ("CLIP",),
                "positive":      ("CONDITIONING",),
                "negative":      ("CONDITIONING",),
                "latent":        ("LATENT",),
                "vae":           ("VAE",),
                "sampler":       ("SAMPLER",),
                "sampler_fine":  ("SAMPLER",),
                "sigmas":        ("SIGMAS",),
                # Hero schedule (falls back to `sigmas`).
                "hero_sigmas":   ("SIGMAS",),
                # Subject mask; the union bbox over the clip + hero_pad
                # becomes a dedicated FIRST tile. First dim is TIME, not
                # objects -- combine multi-subject masks before wiring.
                "hero_mask":     ("MASK",),
                # Per-tile prompt override list (advanced).
                "tile_cond":     ("TILE_COND",),
                # Tile Plan V2's `settings` output: overrides this node's
                # tiling + hero geometry widgets so the plan you previewed
                # is exactly what runs.
                "plan":          ("TESSERA_PLAN",),
                # Refine Extra Options node output: the advanced knobs
                # (ref crops, guide noise/release/inherit, motion adapt,
                # fine split, manual tile size, tile select/limit).
                # Unwired = the validated v4 defaults.
                "args":          ("TESSERA_ARGS",),
                # Tessera Temporal Dilate's frame_map output. When wired (and
                # pixel_out is on a chunked run), duplicated frames are
                # dropped DURING the streamed decode.
                "frame_map":     ("STRING", {"forceInput": True}),
            },
        }


    def run(self, model, positive=None, negative=None, latent=None,
            sampler=None, sigmas=None,
            # main widgets (renamed)
            spatial_tile="high_vram", temporal_tile="high_vram",
            temporal_size=124, temporal_overlap=4,
            tile_width=1024, tile_height=1024,
            context_border=64, seam_overlap=32,
            hero_min=896, hero_fit="median",
            cfg=1.0, seed=1, seed_mode="global", pixel_out=True,
            console_progress="overall", prompt=_DEFAULT_PROMPT,
            # extras (from the Refine Extra Options node via `args`;
            # these defaults ARE the validated v4 recipe)
            video_ref_crop="per_tile", image_ref_crop="per_tile",
            guide_noise=0.0, guide_noise_band="full",
            guide_noise_t="per_frame", guide_release=0.8,
            guide_inherit=True, hero_guide_noise=-1.0,
            motion_adapt=False, motion_release_floor=0.0,
            fine_below_sigma=0.75,
            tile_select="", tile_limit=0,
            # retired widgets, hardcoded to the validated choices
            tile_layout="even", hero_pad=64, hero_border=0,
            frame_match="dc", pixel_color_match="off", dc_match=False,
            seam_direction="forward", border_mode="overlap",
            latent_preview=False,
            # sockets
            model_hero=None, model_fine=None, sampler_fine=None,
            hero_sigmas=None, hero_mask=None, guide_noise_mask=None,
            vae=None, tile_cond=None, plan=None, args=None,
            frame_map="", clip=None):

        _t_run0 = time.perf_counter()        # timing breakdown (r78)
        # widget renames -> internal names (the code keeps the old ones)
        tile_auto = spatial_tile
        if tile_auto == "off":           # legacy workflows
            tile_auto = "custom"
        _tt_scale = True
        if temporal_tile == "high_vram":
            temporal_chunk = 124
        elif temporal_tile == "low_vram":
            temporal_chunk = 73
        elif temporal_tile == "off" or temporal_tile == 0:
            temporal_chunk, _tt_scale = 0, False
        elif temporal_tile == "custom":
            temporal_chunk, _tt_scale = temporal_size, False
        else:                            # legacy workflows: plain INT
            temporal_chunk, _tt_scale = int(temporal_tile), False
        temporal_border = temporal_overlap
        seam_regen = seam_overlap
        ref_crop = video_ref_crop
        flat_skip = 0.0
        composite = "pixel"

        if isinstance(args, dict):
            ref_crop = args.get("video_ref_crop", ref_crop)
            image_ref_crop = args.get("image_ref_crop", image_ref_crop)
            guide_noise = args.get("guide_noise", guide_noise)
            guide_noise_band = args.get("guide_noise_band", guide_noise_band)
            guide_noise_t = args.get("guide_noise_t", guide_noise_t)
            guide_release = args.get("guide_release", guide_release)
            guide_inherit = args.get("guide_inherit", guide_inherit)
            hero_guide_noise = args.get("hero_guide_noise", hero_guide_noise)
            motion_adapt = args.get("motion_adapt", motion_adapt)
            motion_release_floor = args.get("motion_release_floor",
                                            motion_release_floor)
            fine_below_sigma = args.get("fine_below_sigma", fine_below_sigma)
            tile_select = args.get("tile_select", tile_select)
            tile_limit = args.get("tile_limit", tile_limit)
            flat_skip = args.get("flat_skip", 0.0)
            composite = args.get("composite", "pixel")
            print(f"[TesseraRefine] args wired: "
                  f"{', '.join(f'{k}={v}' for k, v in sorted(args.items()))}")


        missing = [n for n, v in (("positive", positive),
                                  ("negative", negative),
                                  ("latent", latent), ("sampler", sampler),
                                  ("sigmas", sigmas)) if v is None]
        if missing:
            raise ValueError("Tiled Refine V2: required socket(s) not "
                             "wired: " + ", ".join(missing))

        # ---- pixel-evidence stats (r77) ---------------------------------
        # Tessera Streamed Encode measures the PLATE PIXELS' block
        # energies while it still has them and rides the stats through
        # the conditioning. Read them here, then STRIP the key so the
        # sampler's cond processing never sees a foreign tensor.
        _flat_stats = next((d.get("tessera_flat_stats")
                            for _, d in positive
                            if isinstance(d, dict)
                            and d.get("tessera_flat_stats")), None)

        def _strip_fs(_cond):
            if not isinstance(_cond, list):
                return _cond
            return [[_e, {_k: _v for _k, _v in _d.items()
                          if _k != "tessera_flat_stats"}]
                    if isinstance(_d, dict) else [_e, _d]
                    for _e, _d in _cond]
        positive = _strip_fs(positive)
        negative = _strip_fs(negative)
        if tile_cond is not None:
            tile_cond = [_strip_fs(_tc) for _tc in tile_cond]

        # ---- plan settings pass-through ---------------------------------
        # Tile Plan V2's `settings` output configures the tile geometry in
        # one place; this node's own geometry widgets are then ignored.
        plan_px = None
        if isinstance(plan, dict) and plan:
            over = {k: plan[k] for k in
                    ("tile_auto", "tile_width", "tile_height",
                     "context_border", "tile_layout", "hero_pad",
                     "hero_fit", "hero_min") if k in plan}
            tile_auto = over.get("tile_auto", tile_auto)
            if tile_auto == "off":       # plan from a legacy TilePlanV2
                tile_auto = "custom"
            tile_width = over.get("tile_width", tile_width)
            tile_height = over.get("tile_height", tile_height)
            context_border = over.get("context_border", context_border)
            tile_layout = over.get("tile_layout", tile_layout)
            hero_pad = over.get("hero_pad", hero_pad)
            hero_fit = over.get("hero_fit", hero_fit)
            hero_min = over.get("hero_min", hero_min)
            plan_px = (plan.get("width"), plan.get("height"))
            print(f"[TesseraRefine] plan input wired: geometry from Tile "
                  f"Plan V2 ({', '.join(f'{k}={v}' for k, v in over.items())})"
                  f" -- this node's tiling/hero widgets are ignored")
        plan = None

        samples_in = latent["samples"]
        samples, companions, wrapper = split_latent(samples_in)

        if companions:
            print(f"[TesseraRefine] joint AV latent: tiling video "
                  f"{tuple(samples.shape)}, carrying {len(companions)} companion "
                  f"tensor(s) through untouched")
        lh, lw = _spatial_dims(samples)

        detected = detect_cell(vae)
        if detected:
            cell = detected
            if cell != 16:
                print(f"[TesseraRefine] detected spatial compression "
                      f"{cell}x from the VAE")
        else:
            cell = 16       # H3's VAE; wire the VAE to detect explicitly
            print(f"[TesseraRefine] no VAE connected; assuming H3 ({cell}x)")

        patch = detect_patch(model)
        tcomp = detect_temporal(vae)

        width, height = lw * cell, lh * cell
        if plan_px and None not in plan_px and plan_px != (width, height):
            _warn(f"[TesseraRefine] WARNING: the wired plan was previewed at "
                  f"{plan_px[0]}x{plan_px[1]} but this latent is "
                  f"{width}x{height} -- the geometry recomputes here, but "
                  f"re-check the Tile Plan preview")
        order = "raster"
        anchor_x = anchor_y = -1

        # ---- guide grid validation (fail FAST, not after sampling) ------
        # An in-band guide that does not sit on the plate grid cannot be
        # cropped per tile; passed through whole, H3's packer ACCEPTS it at
        # its own grid and every tile paints the guide's full composition
        # into its window (measured: ghost duplicates of the subject in
        # corner tiles on a 3840 hop whose AddGuide was still fed 2752
        # pixels). Refuse up front with the fix in the message.
        for _, d in positive:
            for kf in (d.get("minimax_keyframes") or []):
                z = kf.get("latent")
                if z is not None and (int(z.shape[-1]) != lw
                                      or int(z.shape[-2]) != lh):
                    raise ValueError(
                        f"guide latent is {int(z.shape[-1])}x"
                        f"{int(z.shape[-2])} cells but the plate is "
                        f"{lw}x{lh}. An in-band guide must be built at the "
                        f"PLATE's resolution or every tile will paint the "
                        f"whole guide composition into its window (ghost "
                        f"subjects in background tiles). Feed the AddGuide "
                        f"node the guide clip upscaled to "
                        f"{lw * cell}x{lh * cell}px.")

        q = _ref_snap_q(positive, None, lw, lh)

        # ---- dilation-aware budget rebalance ------------------------
        # temporal_tile means REAL frames of content per window; VRAM is
        # spent on tokens = window frames x tile area. Dilation inflates
        # frames per real second, so at fixed widgets a dilated window
        # holds 1/ratio of the content the user budgeted (measured: the
        # same clip at 1.8% osc undilated-unchunked flickered at 7.2% /
        # 54% peaks when 2x dilation halved each window's content).
        # Restore content by scaling the window WITH the ratio, and keep
        # the token budget flat by shrinking the auto-tile cap by
        # sqrt(ratio). Manual tile sizes are the user's explicit choice:
        # scale the window, print the shrink they'd need, touch nothing.
        _dratio = 1.0
        if frame_map:
            try:
                import json as _json0
                _fm0 = _json0.loads(frame_map)
                _dratio = (len(_fm0)
                           / max(1, len(set(int(x) for x in _fm0))))
            except Exception:
                _dratio = 1.0
        if _dratio > 1.05 and temporal_chunk > 0 and not _tt_scale:
            print(f"[TesseraRefine] temporal_tile=custom under "
                  f"x{_dratio:.2f} dilation: {temporal_chunk} frames "
                  f"per window = ~{temporal_chunk / _dratio:.0f} real "
                  f"content frames (not auto-scaled)")
        _cap_ratio = _dratio
        if _dratio > 1.05 and temporal_chunk > 0 and _tt_scale:
            _tc0 = temporal_chunk
            temporal_chunk = int(
                -(-(temporal_chunk * _dratio - 5) // 17) * 17 + 5)
            print(f"[TesseraRefine] dilation-aware budget: x{_dratio:.2f} "
                  f"dilation -> temporal_tile {_tc0} -> {temporal_chunk} "
                  f"dilated frames (same real content per window)")
            # CLIP-LENGTH CLAMP (r74): see the plan node -- real token
            # count is tile area x min(window, clip), so a short clip
            # keeps the full cap.
            _base_lat = (_tc0 - 5) // 17 * 5 + 2
            _scaled_lat = (temporal_chunk - 5) // 17 * 5 + 2
            _clip_lat = (int(samples.shape[2])
                         if samples.ndim == 5 else 0)
            _eff = min(_scaled_lat, _clip_lat) if _clip_lat else _scaled_lat
            _cap_ratio = max(1.0, min(_eff / _base_lat, _dratio))
            if tile_auto == "custom":
                print(f"[TesseraRefine] manual tile sizes: shrink tile "
                      f"area ~x{_dratio:.2f} (each side by "
                      f"/{math.sqrt(_dratio):.2f}) to keep the token "
                      f"budget flat, or expect higher VRAM per window")

        if tile_auto != "custom":
            # Fewest evenly-spread tiles under the VRAM cap, per axis. The
            # sizing grid is the ref-grid unit when a scaled ref is wired
            # (tile sizes and positions then land on whole reference cells
            # -> exact per-tile ref slices), else one DiT patch.
            cap = 768 if tile_auto == "low_vram" else 1024
            if _cap_ratio > 1.05 and temporal_chunk > 0 and _tt_scale:
                _cap0 = cap
                # snap the shrunk cap DOWN to a 64px multiple: half-res
                # refs need tile spans in 64px units, and an off-grid
                # cap resamples every ref crop (measured: cap 707 ->
                # 672px tiles -> 10.5 ref cells -> resample warning)
                cap = max(512, (int(cap / math.sqrt(_cap_ratio)) // 64) * 64)
                print(f"[TesseraRefine] dilation-aware budget: tile cap "
                      f"{_cap0} -> {cap}px (token budget held flat "
                      f"against the effective x{_cap_ratio:.2f} window; "
                      f"ref-grid aligned)")
            elif _dratio > 1.05 and temporal_chunk > 0 and _tt_scale:
                print(f"[TesseraRefine] dilation-aware budget: clip fits "
                      f"the base window -- tile cap stays {cap}px")
            grid_px = cell * patch * max(1, q)
            if cap <= 2 * context_border + grid_px:
                raise GeometryError(
                    f"tile_auto={tile_auto}: cap {cap}px cannot fit "
                    f"context_border {context_border}px twice plus one "
                    f"{grid_px}px grid step -- lower the border")
            tw_auto, _ = auto_tile_axis(width, cap, context_border,
                                        snap=grid_px)
            th_auto, _ = auto_tile_axis(height, cap, context_border,
                                        snap=grid_px)
            if (tile_width, tile_height) != (tw_auto, th_auto):
                print(f"[TesseraRefine] tile_auto={tile_auto} (cap {cap}px): "
                      f"tiles {tw_auto}x{th_auto} chosen for {width}x{height} "
                      f"(tile_width/tile_height widgets ignored)")
            tile_width, tile_height = tw_auto, th_auto

        if q > 1:
            ref_unit = cell * patch * q
            bad = [f"{n}={v}" for n, v in (("tile_width", tile_width),
                                           ("tile_height", tile_height))
                   if v % ref_unit]
            if bad:
                _warn(f"[TesseraRefine] WARNING: {', '.join(bad)} is not a "
                      f"multiple of {ref_unit}px (one DiT patch on the 1/{q}-"
                      f"scale reference). Per-tile ref crops will RESAMPLE "
                      f"(latent interpolation -> tile drift/softness). Use "
                      f"{[(v // ref_unit) * ref_unit for _, v in (('w', tile_width), ('h', tile_height)) if v % ref_unit]} "
                      f"or the next multiple up.")

        hero = None
        hero_inner_px = None
        if hero_mask is not None:
            unit = cell * patch * q
            if q > 1:
                print(f"[TesseraRefine] hero snapped to {unit}px grid so its "
                      f"ref crop slices exactly (video ref is 1/{q} plate scale)")
            hb = _hero_bbox_from_mask(hero_mask, width, height, hero_pad, unit,
                                      fit=hero_fit)
            if hb is None:
                print("[TesseraRefine] hero_mask is empty -- hero tile disabled")
            else:
                grown = _hero_floor(hb, hero_min, width, height, unit)
                if grown != hb:
                    print(f"[TesseraRefine] hero_min={hero_min}: window grown "
                          f"{hb[2]-hb[0]}x{hb[3]-hb[1]} -> "
                          f"{grown[2]-grown[0]}x{grown[3]-grown[1]}px around the "
                          f"head center")
                hb = grown
                hero_inner_px = hb
                hx0, hy0, hx1, hy1 = hb
                # Optional frozen ring of PLATE around the hero's mask. Grid
                # tiles hold timing/geometry even at hot sigmas because their
                # frozen borders re-anchor them to the plate at every step;
                # a border-0 hero's only anchor is the ref, which fails on
                # dark or low-detail subjects (measured: variable 1-3 frame
                # motion retiming confined to the hero). The ring gives the
                # hero the same anchor; only the inner mask is repainted,
                # and grid tiles keep ownership of the ring area.
                ring = 0
                if hero_border > 0:
                    ring = (hero_border // unit) * unit
                    if ring != hero_border:
                        print(f"[TesseraRefine] hero_border={hero_border} "
                              f"rounded to {ring}px (ref-grid unit {unit})")
                ox0, oy0 = max(0, hx0 - ring), max(0, hy0 - ring)
                ox1 = min(width, hx1 + ring)
                oy1 = min(height, hy1 + ring)
                hero = {"x": ox0 // cell, "y": oy0 // cell,
                        "w": (ox1 - ox0) // cell, "h": (oy1 - oy0) // cell,
                        "mx0": (hx0 - ox0) // cell, "my0": (hy0 - oy0) // cell,
                        "mx1": (hx1 - ox0) // cell, "my1": (hy1 - oy0) // cell}
                if anchor_x < 0 or anchor_y < 0:
                    anchor_x = (hx0 + hx1) // 2
                    anchor_y = (hy0 + hy1) // 2
                    if order in ("raster", "serpentine"):
                        order = "anchor_out"
                ring_s = (f", {ring}px plate ring frozen as anchor"
                          if ring else "")
                print(f"[TesseraRefine] hero tile: {hx1-hx0}x{hy1-hy0}px at "
                      f"({hx0},{hy0}) from mask {hero_fit} fit + {hero_pad}px "
                      f"pad{ring_s}; grid anchored on its center")

        plan = build_plan(width, height, tile_width, tile_height, context_border,
                          order, cell=cell, temporal=tcomp or 1, patch=patch,
                          anchor_x_px=anchor_x, anchor_y_px=anchor_y,
                          placement=tile_layout,
                          pos_snap_px=cell * patch * q if q > 1 else 0,
                          hero_rect_px=hero_inner_px)
        if plan.get("pos_snap_px"):
            off = [t["index"] for t in plan["tiles"]
                   if (t["px"] % plan["pos_snap_px"])
                   or (t["py"] % plan["pos_snap_px"])]
            if off:
                print(f"[TesseraRefine] NOTE: tile(s) {off} sit off the "
                      f"{plan['pos_snap_px']}px ref grid (frame edge not a "
                      f"grid multiple) -- their ref crops will resample; "
                      f"all other tiles slice exactly")
        cov = verify_coverage(plan)
        if not cov["ok"]:
            raise GeometryError(
                f"coverage check failed: {cov['never']} cells never generated, "
                f"{cov['twice_or_more']} generated more than once")

        scores = [1.0] * plan["count"]
        cls = ["base"] * plan["count"]

        if hero_sigmas is None:
            hero_sigmas = sigmas

        positive_clean = positive
        if guide_noise > 0.0:
            positive, gn_did = _noise_minimax_keyframes(positive, guide_noise,
                                                        seed,
                                                        guide_noise_band,
                                                        guide_noise_t,
                                                        guide_noise_mask)
            if gn_did:
                print(f"[TesseraRefine] guide_noise={guide_noise:.2f} "
                      f"({guide_noise_band} band, {guide_noise_t} in time"
                      + (", MASKED -- freedom only where painted"
                         if guide_noise_mask is not None else "")
                      + "): guide latents noised (geometry anchor kept, "
                      f"texture released for synthesis)")
            if tile_cond is not None:
                tile_cond = [(_noise_minimax_keyframes(tc, guide_noise,
                                                       seed,
                                                       guide_noise_band,
                                                       guide_noise_t,
                                                       guide_noise_mask)[0]
                              if tc is not None else None)
                             for tc in tile_cond]

        # Hero-only guide noise: built from the CLEAN positive (never
        # stacked on top of the global guide_noise) and always full-band --
        # its job is releasing face GEOMETRY (lip articulation under audio
        # conditioning), which fine-band noise cannot do. Noise is drawn on
        # the full-length guide before any temporal crop, so chunk borders
        # see the same noise field.
        positive_hero = None
        if hero_guide_noise == 0.0:
            # explicit 0 = hero runs a CLEAN guide even when the global
            # guide_noise is active
            positive_hero = positive_clean
            if guide_noise > 0.0:
                print("[TesseraRefine] hero_guide_noise=0: hero tile keeps "
                      "a clean guide (grid keeps guide_noise="
                      f"{guide_noise:.2f})")
        elif hero_guide_noise > 0.0:
            positive_hero, hgn_did = _noise_minimax_keyframes(
                positive_clean, hero_guide_noise, seed ^ 0x4E80, "full")
            if hgn_did:
                print(f"[TesseraRefine] hero_guide_noise="
                      f"{hero_guide_noise:.2f} (full band): hero tile runs "
                      f"its own guide-noise level (face window unclamped; "
                      f"grid keeps guide_noise={guide_noise:.2f})")
            else:
                positive_hero = None

        ref_kinds = ("video",) if image_ref_crop == "whole" \
            else ("video", "image")
        if ref_crop == "per_tile":
            kinds_in = [("video" if "video" in b.get("kind", "")
                         else b.get("kind", ""))
                        for b in (next((d.get("minimax_refs") for _, d in positive
                                        if d.get("minimax_refs")), None) or [])]
            n_crop = sum(1 for k in ref_kinds if k in kinds_in)
            if "video" in kinds_in:
                print(f"[TesseraRefine] ref_crop=per_tile: first "
                      f"{' + first '.join(k for k in ref_kinds if k in kinds_in)} "
                      f"reference cropped to each tile's window"
                      + (f"; {len(kinds_in) - n_crop} other ref block(s) "
                         f"pass through whole" if len(kinds_in) > n_crop else ""))
            else:
                print("[TesseraRefine] ref_crop=per_tile but the positive "
                      "conditioning carries no video reference -- nothing to "
                      "crop (image/audio refs always pass through whole)")

        selected = [(t, s, c) for t, s, c in zip(plan["tiles"], scores, cls)
                    if c != "skip"]
        n_skip = plan["count"] - len(selected)

        if hero is not None:
            # punch the hero's MASK footprint (inner rect, excluding any
            # frozen ring) out of every grid tile's generated region
            # (frozen there: conditioning, not repainting), and queue
            # the hero itself as the FIRST tile.
            hx0g = hero["x"] + hero["mx0"]
            hy0g = hero["y"] + hero["my0"]
            hx1g = hero["x"] + hero["mx1"]
            hy1g = hero["y"] + hero["my1"]
            patched = []
            for t, s, c in selected:
                gx0g, gy0g = t["x"] + t["mx0"], t["y"] + t["my0"]
                gx1g, gy1g = t["x"] + t["mx1"], t["y"] + t["my1"]
                ox0, oy0 = max(gx0g, hx0g), max(gy0g, hy0g)
                ox1, oy1 = min(gx1g, hx1g), min(gy1g, hy1g)
                if ox0 < ox1 and oy0 < oy1:
                    t = dict(t)
                    t["hole"] = (ox0 - t["x"], oy0 - t["y"],
                                 ox1 - t["x"], oy1 - t["y"])  # window-local
                    if (ox0, oy0, ox1, oy1) == (gx0g, gy0g, gx1g, gy1g):
                        t = None                # fully swallowed by the hero
                patched.append((t, s, c))
            n_swallowed = sum(1 for t, _, _ in patched if t is None)
            if n_swallowed:
                print(f"[TesseraRefine] {n_swallowed} grid tile(s) fully "
                      f"swallowed by the hero footprint -- skipped "
                      f"(hero-aware placement)")
            selected = [(t, s, c) for t, s, c in patched if t is not None]
            t_hero = {"index": -1, "row": -1,
                      "x": hero["x"], "y": hero["y"],
                      "w": hero["w"], "h": hero["h"],
                      "mx0": hero["mx0"], "my0": hero["my0"],
                      "mx1": hero["mx1"], "my1": hero["my1"],
                      "clamped": False, "hero_tile": True}
            selected.insert(0, (t_hero, 1.0, "hero"))
        if not selected:
            print("[TesseraRefine] no tile selected; returning the plate "
                  "unchanged")
            return (latent, "0 tiles refined (no tile cleared the threshold)",
                    torch.zeros(1, 8, 8, 3))

        if pixel_out and vae is None:
            print("[TesseraRefine] pixel_out needs the VAE input -- "
                  "disabled for this run (LATENT output is unaffected)")
            pixel_out = False

        # ---- selection bookkeeping ---------------------------------------
        if tile_select.strip():
            toks = [s.strip().lower() for s in
                    tile_select.replace(";", ",").split(",") if s.strip()]
            want_hero = any(s in ("h", "hero") for s in toks)
            try:
                wanted = {int(s) for s in toks if s not in ("h", "hero")}
            except ValueError:
                raise ValueError(
                    f"tile_select={tile_select!r} — expected comma-separated "
                    f"tile indices like \"4\" or \"4,7\" (plus \"h\" for the "
                    f"hero tile)")
            if want_hero:
                wanted.add(-1)
            bad = wanted - {t["index"] for t, _, _ in selected} - {-1}
            bad = bad - {t["index"] for t in plan["tiles"]}
            if bad:
                raise ValueError(
                    f"tile_select names tile(s) {sorted(bad)} but the plan has "
                    f"indices 0..{plan['count'] - 1}")
            before = len(selected)
            selected = [(t, s, c) for t, s, c in selected
                        if t["index"] in wanted]
            n_skip = plan["count"] - len(selected)
            dropped_by_mask = wanted - {t["index"] for t, _, _ in selected}
            if dropped_by_mask:
                print(f"[TesseraRefine] note: tile_select includes "
                      f"{sorted(dropped_by_mask)} but they are not in the "
                      f"plan; they will NOT run")
            print(f"[TesseraRefine] tile_select: running only "
                  f"{sorted(t['index'] for t, _, _ in selected)} "
                  f"({len(selected)} of {before} selected tiles) — the rest of "
                  f"the frame keeps the plate")
            if not selected:
                return (latent, "0 tiles refined (tile_select excluded everything)",
                        torch.zeros(1, 8, 8, 3))
        if tile_limit > 0 and tile_limit < len(selected):
            print(f"[TesseraRefine] tile_limit: running {tile_limit} of "
                  f"{len(selected)} selected tiles (debug only)")
            selected = selected[:tile_limit]

        # (flat-tile skip moved below the chunk plan -- the decision is
        # per (tile, chunk), judged on the evidence the sampler SEES)

        seam_E = 0
        if seam_regen > 0:
            if seam_regen % (cell * patch):
                raise GeometryError(
                    f"seam_regen={seam_regen} is not a multiple of one DiT "
                    f"patch ({cell * patch}px). Use "
                    f"{(seam_regen // (cell * patch)) * cell * patch} or "
                    f"{(seam_regen // (cell * patch) + 1) * cell * patch}.")
            E = (seam_regen // cell // patch) * patch
            seam_E = E
            selected = list(selected)
            ne, nc, nrim = _apply_seam_regen(selected, E, patch, lw, lh,
                                             forward=seam_direction == "forward")
            if ne or nrim:
                print(f"[TesseraRefine] seam_regen {seam_regen}px "
                      f"({seam_direction}): {ne} partition edge(s) + {nrim} "
                      f"hero-rim edge(s) generated by both tiles and "
                      f"crossfaded ({nc} cells intentionally sampled twice; "
                      f"hero interior protected)")
            else:
                print(f"[TesseraRefine] seam_regen {seam_regen}px: no "
                      f"expandable edges (single tile, or no border room)")

        # ---- motion oracle (stage 1: report only) ------------------------
        _mo, _mo_spans, _mo_fast = _motion_oracle(
            samples if samples.ndim == 5 else None)
        _motion_report("TiledRefineV2", _mo_spans, _mo_fast)

        # ---- temporal chunk plan -----------------------------------------
        T_lat = int(samples.shape[2]) if samples.ndim == 5 else 1
        t_chunks = [(0, 0, T_lat, T_lat)]
        chunk_lat = T_lat
        if temporal_chunk > 0:
            if samples.ndim != 5:
                print("[TesseraRefine] temporal_chunk set but the latent has "
                      "no temporal axis -- ignored")
            elif temporal_chunk < 22 or (temporal_chunk - 5) % 17:
                lo = max(22, ((temporal_chunk - 5) // 17) * 17 + 5)
                raise ValueError(
                    f"temporal_chunk={temporal_chunk} is not an H3-native "
                    f"clip length (17k+5: 22, 39, 56, ...). Use {lo} or "
                    f"{lo + 17}.")
            else:
                chunk_lat = (temporal_chunk - 5) // 17 * 5 + 2
                if chunk_lat >= T_lat:
                    print(f"[TesseraRefine] temporal_chunk={temporal_chunk} "
                          f"covers the whole clip ({chunk_lat} >= {T_lat} "
                          f"latent frames) -- running unchunked")
                    chunk_lat = T_lat
                elif chunk_lat - temporal_border <= 0:
                    raise ValueError(
                        f"temporal_border={temporal_border} too large for "
                        f"chunk of {chunk_lat} latent frames")
                else:
                    # One-sided chain: each chunk's LEADING latent frames are
                    # frozen context from the previous chunk's refined
                    # result; gen runs to the window end (no trailing
                    # border -- the next chunk owns what follows).
                    # EVEN-SPREAD PLACEMENT: positions are distributed
                    # uniformly instead of greedy full strides with the
                    # remainder clamped flush. The greedy plan ends in a
                    # degenerate STUB -- e.g. 62 latent at chunk 22/border 4
                    # gave [0,18,36,40]: a final chunk that is 82% frozen
                    # lead and generates 4 latent frames (~14 px) of pure
                    # future at the causal end of the clip. Measured: a
                    # departed subject was hallucinated back EXACTLY inside
                    # that stub's span, across four runs and four falsified
                    # conditioning theories, while the 18-frame chunks and
                    # the unchunked run stayed clean. Even spacing keeps
                    # every chunk's generated span comparable (same chunk
                    # count, spacing <= stride so leads never fall below
                    # the border) and the stub never exists.
                    def _bcost_abs(babs):
                        if _mo is None:
                            return 0.0
                        lo = max(0, babs - 4)
                        hi = min(len(_mo), babs + 3)
                        m = babs - 1
                        if lo >= m or m >= hi:
                            return 0.0
                        before = sum(_mo[lo:m]) / max(1, m - lo)
                        after = sum(_mo[m:hi]) / max(1, hi - m)
                        return abs(after - before)

                    def _plan_span(a, b):
                        """Even-spread + regime-snap chunk plan for latent
                        span [a, b) with its own native window length."""
                        S = b - a
                        # pick the largest native window whose remainder is
                        # not a degenerate stub (the stub law applies at
                        # segment scale too: S=18 with wl=17 would leave a
                        # 1-frame generation)
                        wl = min(chunk_lat, ((S - 2) // 5) * 5 + 2)
                        while wl > 7 and 0 < S - wl < max(4, temporal_border):
                            wl -= 5
                        stride_s = max(1, wl - temporal_border)
                        if S <= wl:
                            # whole-shot window: immune to the content-time
                            # law (complete context, no hand-offs)
                            return [(a, 0, wl, wl)]
                        if wl < 17:
                            _warn(f"[TesseraRefine] WARNING: segment "
                                  f"latent {a}-{b} must be split into "
                                  f"windows of only ~{_px_start(wl)} px "
                                  f"frames -- below the measured "
                                  f"content-time floor (~56). Expect mild "
                                  f"texture churn within this shot; a "
                                  f"different cut position or trim would "
                                  f"avoid it.")
                        last_s = S - wl
                        n_mv = max(1, -(-last_s // stride_s))
                        pos = sorted(set(round(i * last_s / n_mv)
                                         for i in range(n_mv + 1)))
                        if _mo is not None and len(pos) > 2:
                            even = list(pos)
                            n_p = len(pos)
                            dp = [dict() for _ in range(n_p)]
                            dp[0][0] = (0.0, -1)
                            for i in range(1, n_p):
                                fixed_last = (i == n_p - 1)
                                cands = ([last_s] if fixed_last
                                         else range(1, last_s))
                                for p in cands:
                                    best = None
                                    for pp, (cst, _) in dp[i - 1].items():
                                        if 1 <= p - pp <= stride_s:
                                            if best is None or cst < best[0]:
                                                best = (cst, pp)
                                    if best is None:
                                        continue
                                    c = best[0] + (0.0 if fixed_last else
                                                   _bcost_abs(a + p + wl)
                                                   + 0.02 * abs(p - even[i]))
                                    old = dp[i].get(p)
                                    if old is None or c < old[0]:
                                        dp[i][p] = (c, best[1])
                            if last_s in dp[-1]:
                                seq, i, p = [last_s], n_p - 1, last_s
                                while i > 0:
                                    p = dp[i][p][1]
                                    seq.append(p)
                                    i -= 1
                                npos = sorted(seq)
                                if npos != pos:
                                    print(f"[TesseraRefine] regime-aware "
                                          f"boundaries (latent {a}-{b}): "
                                          f"hand-offs at "
                                          f"{[a + q + wl for q in npos[:-1]]}")
                                    pos = npos
                        # ---- GROUP-PHASE SNAP (FRAME_PER_TOKEN law) ----
                        # The model lays a window's token time out as
                        # cumsum(FRAME_PER_TOKEN[k % 5]) with k WINDOW-
                        # LOCAL (comfy/ldm/minimax/model.py,
                        # _video_t_spans): token 0 is the 1-frame head
                        # token, the next four carry 4 px frames each.
                        # A window starting at an absolute latent != 0
                        # (mod 5) therefore runs its whole span pattern
                        # out of phase with the sliced content -- a
                        # periodic time-warp beating every 5 latents.
                        # Measured (190-194): a 17-px-frame flicker
                        # metronome through every misaligned chunk
                        # (starts 22, 46 -> phases 2, 1), ZERO spikes in
                        # the phase-aligned ones (0 and 70). Snap every
                        # mid-span start to the nearest absolute multiple
                        # of 5 -- the lead absorbs the shift. The first
                        # window is pinned at `a`, and the last start
                        # (b - wl) is phase-aligned by construction on
                        # whole clips (b == 2 and wl == 2, mod 5).
                        if len(pos) > 2:
                            snapped = [pos[0]]
                            for p in pos[1:-1]:
                                q = 5 * round((a + p) / 5.0) - a
                                while q - snapped[-1] > stride_s:
                                    q -= 5
                                if q - snapped[-1] >= 1 and q < last_s:
                                    snapped.append(q)
                            if last_s - snapped[-1] > stride_s:
                                # the tail window's lead fell below the
                                # border; add one aligned start (rounded
                                # UP to phase 0) to restore it
                                q = last_s - stride_s
                                q += (-(a + q)) % 5
                                if (q - snapped[-1] >= 1
                                        and last_s - q >= 1):
                                    snapped.append(q)
                            snapped.append(last_s)
                            if snapped != pos:
                                mis = [a + q for q in snapped
                                       if (a + q) % 5]
                                print(f"[TesseraRefine] group-phase snap: "
                                      f"window starts -> "
                                      f"{[a + q for q in snapped]}"
                                      + (f" (unalignable, expect the "
                                         f"17-frame beat: {mis})"
                                         if mis else ""))
                                pos = snapped
                        elif (a + pos[-1]) % 5 or a % 5:
                            _warn(f"[TesseraRefine] group-phase: window "
                                  f"start(s) "
                                  f"{[a + q for q in pos if (a + q) % 5]} "
                                  f"not on a 5-latent group boundary "
                                  f"(segment edges are fixed) -- expect "
                                  f"the 17-frame beat in those windows")
                        out, gen_start = [], a
                        for p in pos:
                            p_abs = a + p
                            out.append((p_abs, gen_start - p_abs, wl, wl))
                            gen_start = p_abs + wl
                        return out

                    # ---- CUT WALLS ------------------------------------
                    # A chunk window spanning a scene cut makes the model
                    # negotiate two unrelated shots in one attention
                    # context (measured: detail oscillation 24.6% near
                    # spanned cuts vs 8.2% away, instability persisting
                    # several frames after each cut; the regime snap even
                    # AVOIDS cuts, since they read as maximal contrast).
                    # Detected cuts become hard walls: no window spans
                    # one, the pre-cut chunk ends flush at it, and the
                    # post-cut chunk starts FRESH with zero lead -- a new
                    # clip in all but name. Detection is by APPEARANCE,
                    # not motion magnitude: |dz/dt| is a motion meter,
                    # and in uniformly fast footage a cut's spike (2.6-
                    # 2.9 cells/lf) drowns in the shot's own motion
                    # (~1.9 median) -- measured missing ALL five cuts of
                    # a dark fast-cut clip while every chunk spanned one.
                    # Spatial correlation of latent frames TWO steps
                    # apart separates cuts cleanly. Two steps, not one:
                    # the VAE packs ~3.4 px frames into each latent
                    # frame, so a cut usually lands INSIDE one latent
                    # frame's aggregation window and that frame is a
                    # blend of both shots -- its correlation to either
                    # neighbor reads 0.35-0.74, inside the fast-motion
                    # range (measured; a 1-step detector caught 2 of 5
                    # cuts). Skipping the contaminated frame compares
                    # pure shot A to pure shot B. Calibrated ON THE
                    # REAL LATENT (a 5-cut, uniformly fast dark clip):
                    # the causal VAE drags pre-cut state across the
                    # boundary, so cuts dip to 0.47-0.67 (not the ~0.2
                    # a pixel-space model predicts) while every within-
                    # shot value stayed above 0.69 at median 0.89. The
                    # threshold sits in that gap, with a relative guard
                    # (0.8 x median) so calm clips, whose median runs
                    # ~0.96+, cannot false-trigger on mild dips.
                    # Candidates cluster around each cut, so the wall
                    # lands on the cluster's minimum.
                    walls = []
                    zc = samples.float()
                    if zc.shape[2] > 8:
                        zt = zc[0].permute(1, 0, 2, 3).reshape(
                            zc.shape[2], -1)
                        zt = zt - zt.mean(dim=1, keepdim=True)
                        zn = zt / zt.norm(dim=1, keepdim=True).clamp_min(
                            1e-6)
                        cs = (zn[:-2] * zn[2:]).sum(dim=1)  # [T-2]
                        csl = [float(c) for c in cs]
                        cmed = sorted(csl)[len(csl) // 2]
                        thr = min(0.72, 0.8 * cmed)
                        cand = [(c, i + 1) for i, c in enumerate(csl)
                                if c < thr]
                        while cand:
                            seedc, seedw = min(cand)
                            walls.append(seedw)
                            cand = [(c, w_) for c, w_ in cand
                                    if abs(w_ - seedw) > 3]
                        walls.sort()
                        lows = sorted(range(len(csl)),
                                      key=lambda i: csl[i])[:10]
                        lows.sort()
                        print(f"[TesseraRefine] cut oracle: 2-step latent "
                              f"corr median {cmed:.3f} (threshold "
                              f"{thr:.3f}) -> {len(walls)} wall "
                              f"candidate(s); 10 lowest dips: "
                              + ", ".join(f"lat {i + 1}={csl[i]:.3f}"
                                          for i in lows))
                        del zt, zn, cs
                    del zc
                    if walls:
                        _wpx = [_lat_to_px_frame(w_) for w_ in walls]
                        _warn(f"[TesseraRefine] cut oracle: scene cut(s) "
                              f"detected at latent {walls} (~px {_wpx}). "
                              f"Chunk windows cannot start fresh mid-clip "
                              f"(the window's first latents carry head "
                              f"timing) nor carry leads across a cut "
                              f"cleanly -- for best results SPLIT the "
                              f"clip at these frames and upscale each "
                              f"shot separately, or run temporal_tile off "
                              f"if the whole clip fits. Proceeding with "
                              f"the standard plan (expect instability "
                              f"near the cuts under chunking).")
                    t_chunks = _plan_span(0, T_lat)
                    min_gen = min(me - ms for _, ms, me, _ in t_chunks)
                    if min_gen < max(4, temporal_border):
                        _warn(f"[TesseraRefine] WARNING: a chunk generates "
                              f"only {min_gen} latent frame(s) -- the clip "
                              f"length leaves a degenerate remainder even "
                              f"under even spacing (measured hallucination "
                              f"risk at the clip end). Prefer temporal_tile "
                              f"off if it fits, or a chunk length that "
                              f"divides this clip more evenly.")
                    if wrapper is not None:
                        print("[TesseraRefine] AV chunking: audio "
                              "companions sliced per chunk as frozen "
                              "conditioning (originals pass through "
                              "untouched)")
                    if pixel_out:
                        print("[TesseraRefine] chunked: one decode of "
                              "the finished canvas (per-tile pastes "
                              "skipped)")
                    print(f"[TesseraRefine] temporal plan: {len(t_chunks)} "
                          f"chunk(s) (window <= {chunk_lat} latent frames) "
                          f"(~{temporal_chunk} px frames), border "
                          f"{temporal_border} latent frame(s), over {T_lat} "
                          f"total: "
                          + ", ".join(f"[{p}+{ms}:{me}]"
                                      + (f"(+{wl - me} frozen trail)"
                                         if wl > me else "")
                                      for p, ms, me, wl in t_chunks))
        chunked = len(t_chunks) > 1

        # ---- content-time guardrail (the chunking law) -------------------
        # Chunk windows are budgeted in FRAMES, but render stability is
        # budgeted in CONTENT-TIME: below ~2-3s of real content per window
        # the model has too little motion structure to anchor its rendering
        # and frame-to-frame texture jitters (measured three ways: 22-frame
        # chunks flashing at ~3 gen latents; 2x-dilated 73-frame chunks
        # flickering at 1.5s of content while the SAME chunks undilated ran
        # clean; and the same dilated clip going clean the moment the
        # window was doubled to hold full content). Dilation silently
        # divides every window's content by its factor -- temporal_tile
        # must scale WITH the dilation factor. The frame_map gives the
        # exact ratio, so starved plans are caught before GPU time burns.
        if chunked and frame_map:
            try:
                import json as _json2
                _fm = _json2.loads(frame_map)
                _ratio = len(_fm) / max(1, len(set(int(x) for x in _fm)))
                _content = temporal_chunk / _ratio
                # the floor is HIGHER under dilation than the plain ~56:
                # decimation samples the render back at the dilation
                # rate, doubling apparent churn (measured: 62 real
                # frames per dilated window flickered at 7.2% osc /
                # 54% peaks while the same clip undilated-unchunked ran
                # 1.8%). Dilated chunks want >= ~100 real frames.
                _floor = 100 if _ratio > 1.05 else 56
                if _content < _floor:
                    _want = int(-(-_floor * _ratio // 17) * 17 + 5)
                    _warn(f"[TesseraRefine] WARNING: dilated clip "
                          f"(x{_ratio:.2f}): each {temporal_chunk}-frame "
                          f"chunk holds only ~{_content:.0f} real frames "
                          f"of content -- below the measured flicker "
                          f"threshold (~{_floor} under this dilation). "
                          f"Chunk length must scale with the dilation "
                          f"factor: use temporal_tile >= {_want}, or "
                          f"temporal_tile off if the dilated clip fits.")
            except Exception:
                pass

        # ---- stage 1.5: per-chunk motion-adaptive guide release -----------
        # v3-aware motion adaptation. The sigma ladder is NEVER touched (the
        # old entry-cap design truncated the head and skipped the released
        # tail -- incompatible with the v3 phase split). Instead each chunk's
        # global motion scales guide_release toward motion_release_floor.
        # Why: released-tail texture is born in screen/tile coordinates. On a
        # locked-off camera it lands in the same place every frame and reads
        # as solid detail; on a moving camera the image slides underneath it
        # and the whole frame boils (measured: 11-16% detail-energy
        # oscillation on panning clips vs 2-3% locked-off, UNIFORM across
        # frames -- not tied to per-frame motion, which is the screen-locked
        # signature). Freedom only where invention can persist.
        #   m = oracle motion, ~latent cells per latent frame.
        #   m <= 0.2 (~1 px/frame): full release.
        #   m >= 1.2 (the oracle's calibrated smearing threshold,
        #             ~6 px/frame): release at the floor.
        chunk_motion = [0.0] * len(t_chunks)
        if _mo is not None:
            for ci, (tp, tms, tme, _) in enumerate(t_chunks):
                i0 = max(0, tp + tms - 1)
                i1 = max(i0 + 1, min(len(_mo), tp + tme - 1))
                seg = _mo[i0:i1]
                chunk_motion[ci] = (sum(seg) / len(seg)) if seg else 0.0
        chunk_grel = [guide_release] * len(t_chunks)
        if motion_adapt and _mo is not None:
            _G_LO, _G_HI = 0.2, 1.2
            _floor = min(max(0.0, motion_release_floor), guide_release)
            for ci, m in enumerate(chunk_motion):
                sc = min(1.0, max(0.0, (_G_HI - m) / (_G_HI - _G_LO)))
                chunk_grel[ci] = _floor + (guide_release - _floor) * sc
            print(f"[TesseraRefine] motion_adapt: guide_release "
                  f"{guide_release:.2f} -> per chunk "
                  + " ".join(f"{g:.2f}" for g in chunk_grel)
                  + "  (motion "
                  + " ".join(f"{m:.1f}" for m in chunk_motion)
                  + " cells/lf)")

        # (the r38 "image-ref staleness guard" lived here and was REMOVED:
        # the subject-injection it defended against was measured to occur
        # with whole refs too -- the real cause was the degenerate final
        # stub chunk, fixed by the even-spread planner above)

        # ---- FLAT-TILE SKIP (hallucination guard, r77) ----------------
        # A tile window with no visual evidence is featureless: the
        # plate already renders it perfectly and a detail model can
        # only INVENT there (measured: on a coin-on-grey stress plate
        # the ref2va checkpoint painted the reference face into every
        # empty tile once release opened). Four design rules, each
        # bought with a measured failure:
        #   PIXEL EVIDENCE, not latent -- two latent metrics were
        #     falsified in a row: the 1-cell Laplacian (r75) and a
        #     fine+mid two-band read (r76) both sit on a broadband VAE
        #     carrier that compresses real content to 1.7-6.5x of floor
        #     -- a greenscreen plate's SOFT FACES scored below boat-
        #     wood edges and were skipped (runs 238/239) while the SAME
        #     tiles separated 9-188x in pixel space. The stats are
        #     measured on the plate PIXELS by Tessera Streamed Encode
        #     (the only place they ever exist at full resolution) and
        #     ride here through the conditioning; without them the
        #     skip stays off rather than guessing blind.
        #   BLOCK-MAX, not tile-mean -- a tile 95% grey with the coin's
        #     crown in one corner averaged "flat" and was skipped,
        #     cutting a 24/255 band across the coin (run 236). The max
        #     over 128px blocks refuses to skip any tile the subject
        #     ever touches.
        #   RATIO-TO-FLOOR, not absolute -- scored against the clip's
        #     own median block, one default travels across source
        #     grain/compression with no calibration run. Flat noise
        #     peaks at ~2-3x its own median (coin plate 2.7-2.8x);
        #     content clears by multiples (soft faces 9x+, coin sliver
        #     15x, ground dust 41x, hero 502x -- all pixel-measured).
        #   PER (TILE, CHUNK) -- the model only sees its own window. A
        #     tile where the subject exits before a later chunk starts
        #     is EMPTY in that window (the 234 setup); it skips there
        #     and refines where the subject is. The handoff is invisible
        #     by construction: it only happens across content that is
        #     flat on both sides (refined-flat == plate-flat, measured
        #     grain 0.0011 vs 0.0012), feathered by the chunk overlap.
        # A skipped (tile, chunk) keeps the plate: no sampling, no
        # invention. Heroes never skip.
        flat_drop = set()
        if flat_skip > 0.0 and selected and _flat_stats is None:
            print("[TesseraRefine] flat_skip: no pixel-evidence stats "
                  "in the conditioning -- chain `positive` from "
                  "Tessera Streamed Encode to enable the flat-tile "
                  "skip (it measures the plate pixels; the latent "
                  "reads blind). Skipping disabled this run.")
        if (flat_skip > 0.0 and selected and _flat_stats is not None
                and samples.ndim == 5):
            if flat_skip < 1.0:
                _warn(f"[TesseraRefine] WARNING: flat_skip {flat_skip:g} "
                      f"is below 1.0 -- since r75 it is a RATIO to the "
                      f"clip's own block-energy floor (old absolute "
                      f"values like 0.035 disable it in practice). "
                      f"House setting: 4.0.")
            _bl = _flat_stats["blocks"].float()        # [Fpx, bh, bw]
            _bpx = float(_flat_stats.get("px_x",
                                         _flat_stats.get("block_px", 128)))
            _bpy = float(_flat_stats.get("px_y", _bpx))
            _fs_ok = int(_bl.shape[0]) == _px_start(T_lat)
            if not _fs_ok:
                _warn(f"[TesseraRefine] WARNING: pixel-evidence stats "
                      f"cover {int(_bl.shape[0])} frames but the latent "
                      f"is {_px_start(T_lat)} px frames -- a node "
                      f"between Streamed Encode and this one re-timed "
                      f"the clip. flat_skip disabled this run.")
            if _fs_ok:
                # FLOOR CAP (r79): the floor is the clip's median block,
                # which is the noise level only when flat blocks are the
                # majority. On a busy-everywhere plate the median IS
                # content (parade clip: 8.4e-3 vs 3.8e-5 coin / 2.9e-4
                # greenscreen) and a merely-less-busy tile reads as
                # "flat" -- measured: a quadrant of brick, awnings and
                # bunting skipped at ratio 3.8. Capping the floor at an
                # absolute 1e-3 keeps busy clips from over-skipping; a
                # grainy-but-flat clip just refines (the safe direction).
                _med0 = float(_bl.median())
                _floor = max(min(_med0, 1e-3), 1e-12)
                if _med0 > 1e-3:
                    print(f"[TesseraRefine] flat_skip: busy plate -- median "
                          f"block {_med0:.3e} capped to floor 1e-3 (skips "
                          f"only truly empty tiles)")
                _bh, _bw = int(_bl.shape[1]), int(_bl.shape[2])
                _ratios = []                    # per tile: [chunk...]
                for _t, _s, _c in selected:
                    _bx0 = int((_t["x"] + _t["mx0"]) * cell / _bpx)
                    _by0 = int((_t["y"] + _t["my0"]) * cell / _bpy)
                    _bx1 = min(int(math.ceil(
                        (_t["x"] + _t["mx1"]) * cell / _bpx)), _bw)
                    _by1 = min(int(math.ceil(
                        (_t["y"] + _t["my1"]) * cell / _bpy)), _bh)
                    _tb = _bl[:, _by0:max(_by1, _by0 + 1),
                              _bx0:max(_bx1, _bx0 + 1)]
                    _r = []
                    for _ci, (_tp, _tms, _tme, _) in enumerate(t_chunks):
                        # the chunk's GENERATED span only -- frozen
                        # context is not this window's output
                        _g0, _g1 = _tp + _tms, _tp + _tme
                        _f0, _f1 = _px_start(_g0), _px_start(_g1)
                        _r.append(float(_tb[_f0:_f1].max()) / _floor
                                  if _f1 > _f0 else float("inf"))
                    _ratios.append(_r)
                print(f"[TesseraRefine] flat_skip {flat_skip:g}: plate "
                      f"px block-energy floor {_floor:.3e}; tile ratio"
                      + ("s per chunk" if chunked else "s") + ": "
                      + "  ".join(
                          f"{_t['index']}:"
                          + "/".join(f"{_v:.1f}" for _v in _r)
                          for (_t, _, _), _r in zip(selected, _ratios)))
                for (_t, _s, _c), _r in zip(selected, _ratios):
                    if _c == "hero" or _t.get("hero_tile"):
                        continue
                    for _ci, _v in enumerate(_r):
                        if _v < flat_skip:
                            flat_drop.add((_ci, _t["index"]))
                _full = [_t["index"] for _t, _, _ in selected
                         if all((_ci, _t["index"]) in flat_drop
                                for _ci in range(len(t_chunks)))]
                if _full:
                    selected = [(_t, _s, _c) for _t, _s, _c in selected
                                if _t["index"] not in _full]
                    n_skip = plan["count"] - len(selected)
                    print(f"[TesseraRefine] flat_skip: {len(_full)} "
                          f"featureless tile(s) keep the plate everywhere "
                          f"(no sampling, no invention): {_full}")
                    if not selected:
                        return (latent, "0 tiles refined (flat_skip: the "
                                "whole frame is featureless)",
                                torch.zeros(1, 8, 8, 3))
                _part = sorted((_i, _ci) for _ci, _i in flat_drop
                               if _i not in _full)
                if _part:
                    print("[TesseraRefine] flat_skip: plate kept per "
                          "chunk: "
                          + "  ".join(f"tile {_i} chunk {_ci}"
                                      for _i, _ci in _part))

        def sigmas_for(c):
            return hero_sigmas if c == "hero" else sigmas

        def steps_for(c):
            return max(1, len(sigmas_for(c)) - 1)

        n = len(selected)
        total_steps = sum(steps_for(c)
                          for ci in range(len(t_chunks))
                          for t, _, c in selected
                          if (ci, t["index"]) not in flat_drop)
        n_hero = sum(1 for _, _, c in selected if c == "hero")

        print(f"[TesseraRefine] {plan['grid'][0]}x{plan['grid'][1]} grid: "
              f"{n} tile(s) to run "
              f"({n_hero} hero @ entry {float(hero_sigmas[0]):.3f}, "
              f"{n - n_hero} base @ entry {float(sigmas[0]):.3f}), "
              f"{n_skip} skipped  ·  {total_steps} total steps, "
              f"border {context_border}px ({border_mode})"
              + (f"  ·  {len(flat_drop)} (tile,chunk) window(s) keep "
                 f"the plate" if flat_drop else ""))

        # ---- DISK PREFLIGHT: the decode's scratch need is knowable NOW.
        # Measured: an 8h49m 8K sampling completed and then died at
        # [Errno 28] allocating the 67.6GB decode buffer -- a failure
        # that was predictable before the first tile sampled.
        if pixel_out and samples.ndim == 5:
            try:
                import json as _json
                _Tl = int(samples.shape[2])
                if (_Tl - 2) % 5 == 0:
                    _pxT = 5 + 17 * ((_Tl - 2) // 5)
                    _nout = _pxT
                    if frame_map:
                        try:
                            _fm = _json.loads(frame_map)
                            if len(_fm) == _pxT:
                                _nout = len(set(int(x) for x in _fm))
                        except Exception:
                            pass
                    _b = _nout * int(samples.shape[3] * 16) \
                        * int(samples.shape[4] * 16) * 3 * 4
                    if _b > (12 << 30):
                        _b //= 2              # fp16 storage kicks in
                    if _b > (4 << 30):        # disk-backed path
                        _best = max((_free_bytes(d)
                                     for d in _scratch_dirs()), default=0)
                        if _best < _b * 1.05:
                            _warn(f"[TesseraRefine] DISK PREFLIGHT: the "
                                  f"final decode will stream "
                                  f"~{_b / (1 << 30):.1f}GB to a scratch "
                                  f"buffer but the roomiest scratch dir "
                                  f"has only {_best / (1 << 30):.1f}GB "
                                  f"free. Free space or set TESSERA_SCRATCH "
                                  f"to a bigger drive BEFORE this run "
                                  f"ends, or the decode will fail (the "
                                  f"latent is insured either way).")
                        else:
                            print(f"[TesseraRefine] disk preflight: "
                                  f"decode needs "
                                  f"~{_b / (1 << 30):.1f}GB scratch, "
                                  f"{_best / (1 << 30):.1f}GB free -- OK")
            except Exception:
                pass

        work = samples.clone()
        noise_full = (comfy.sample.prepare_noise(samples, seed)
                      if seed_mode == "global" else None)

        pbar = comfy.utils.ProgressBar(total_steps)
        previewer = None
        if latent_preview and _PREVIEW_OK:
            try:
                previewer = _latent_preview.get_previewer(
                    model.load_device, model.model.latent_format)
            except Exception as e:
                print(f"[TesseraRefine] previewer unavailable ({e}); continuing without")
                previewer = None

        state = {"done": 0}
        enabled = _pbar_enabled()
        disable_inner = (console_progress != "per_tile") or not enabled
        outer = None
        if console_progress == "overall" and tqdm is not None and enabled:
            outer = tqdm(total=total_steps, desc="Tessera refine", unit="step")

        def callback(step, x0, x, _total):
            preview = None
            if previewer is not None:
                try:
                    # hand the previewer its OWN copy: threaded preview
                    # overrides (e.g. kjnodes) queue frames to a worker
                    # thread, and a live view of the sampler's working
                    # latent can be freed mid-resize when the tile ends --
                    # Windows access violation at 95% of a long run
                    preview = previewer.decode_latent_to_preview_image(
                        "JPEG", x0.detach().clone())
                except Exception:
                    preview = None
            pbar.update_absolute(state["done"] + step + 1, total_steps, preview)
            if outer is not None:
                outer.update(1)

        step_times = []
        t_start = time.perf_counter()
        report_lines = []
        px_tiles = []

        # ---- timing instrumentation (r78) -----------------------------
        # Measure before optimizing: one breakdown line at the end of the
        # run splits wall time into its real costs. The model load/swap
        # estimate works per sampler call: the first step carries the
        # load, so (first-step latency - median pure step) ~= load cost.
        _tm = {"sample": 0.0, "text": 0.0, "first": [], "steps": []}

        def _timed_sample(*_a, **_k):
            _c0 = time.perf_counter()
            _marks = []
            _ocb = _k.get("callback")

            def _cb(_s, _x0, _x, _tot):
                _marks.append(time.perf_counter())
                if _ocb is not None:
                    _ocb(_s, _x0, _x, _tot)
            _k["callback"] = _cb
            _r = comfy.sample.sample_custom(*_a, **_k)
            _tm["sample"] += time.perf_counter() - _c0
            if _marks:
                _tm["first"].append(_marks[0] - _c0)
                _tm["steps"] += [_marks[_i] - _marks[_i - 1]
                                 for _i in range(1, len(_marks))]
            return _r

        jobs = [(ci, tc, k, sel) for ci, tc in enumerate(t_chunks)
                for k, sel in enumerate(selected)
                if (ci, sel[0]["index"]) not in flat_drop]

        # overlap mode + seam_regen: latent write-back goes through a
        # weighted accumulator, normalized when each chunk's last tile
        # lands (see the paste site). acc_ci tracks which chunk the
        # accumulator belongs to.
        overlap_blend = border_mode == "overlap" and seam_E > 0
        acc = wsum = None
        acc_ci = -1

        # ---- per-tile text encode ----------------------------------------
        # The references are decoded at full frame and cropped in pixels
        # (cropping a full decode avoids the edge artifacts of decoding
        # crops). All windows are encoded up front so the text encoder loads
        # once instead of swapping with the DiT on every tile.
        text_cache = {}
        refs0 = next((d.get("minimax_refs") for _, d in positive
                      if d.get("minimax_refs")), None)
        want_text = clip is not None and ref_crop == "per_tile" and bool(refs0)
        _t_text0 = time.perf_counter()
        pixels = None
        if want_text:
            if vae is None:
                raise ValueError("clip is wired for per-tile text encoding, "
                                 "which needs the VAE input to decode the "
                                 "reference latents")
            if not prompt.strip():
                _warn("[TesseraRefine] WARNING: clip is wired but `prompt` "
                      "is EMPTY -- every tile will be re-encoded with NO "
                      "text, while the whole-frame baseline embedding "
                      "carried the ref node's prompt. Per-tile conditioning "
                      "should differ from the baseline only in the cropped "
                      "refs: paste the ref node's prompt into this node's "
                      "prompt widget.")
            pixels = [_as_image(vae.decode(b["latent"])).cpu()
                      if b.get("latent") is not None else None for b in refs0]

        if want_text:
            px_full = _px_start(T_lat)
            for ci, (tp, tms, tme, twl), k, (t, _, _) in jobs:
                t_len = twl if chunked else T_lat
                i = t["index"]
                if tile_cond is not None and 0 <= i < len(tile_cond)                         and tile_cond[i] is not None:
                    continue
                tkey = (t["x"], t["y"], t["w"], t["h"], tp, t_len)
                if tkey in text_cache:
                    continue
                items = _tile_ref_items(
                    refs0, pixels, ref_kinds, t["x"], t["y"], t["w"], t["h"],
                    lw, lh, _px_start(tp), _px_start(tp + t_len), px_full)
                text_cache[tkey] = clip.encode_from_tokens_scheduled(
                    clip.tokenize(prompt, minimax_ref_items=items))
            print(f"[TesseraRefine] per-tile text encode: {len(text_cache)} "
                  f"window(s) re-encoded with the tile-cropped reference "
                  f"(Qwen no longer sees the whole frame)")
        elif clip is not None:
            print("[TesseraRefine] clip wired but ref_crop=global or no "
                  "reference blocks -- per-tile text encode skipped")
        del pixels
        _tm["text"] = time.perf_counter() - _t_text0

        # detail relay: chunk-local conditioning whose guide carries the
        # already-refined canvas for all frames before the chunk's generated
        # range. Rebuilt once per chunk; chunk 0 uses the originals.
        inh_ci = -1
        positive_j, positive_clean_j = positive, positive_clean
        positive_hero_j, tile_cond_j = positive_hero, tile_cond

        _tm["loop0"] = time.perf_counter()

        # ---- PHASE-BATCHED SAMPLING (r80) ------------------------------
        # The tail split swaps main -> fine -> main around EVERY tile:
        # measured 51s of 424s (12%) on a 4-tile 1080p run, ~6s a swap,
        # linear in tile count. Within a chunk the tiles are independent
        # (overlap mode: every window is anchored to its own conditioning
        # and the canvas is only written when the chunk's last tile lands),
        # so the order is free: run every tile's HEAD call with the main
        # model loaded once, park the intermediates, then every TAIL call
        # with the fine model loaded once. Two swaps per chunk instead of
        # two per tile; same math, same seeds, same outputs. The prep
        # (conditioning crops, masks, noise) is recomputed in the tail
        # pass -- it is deterministic and cheap, and recomputing keeps the
        # loop body in one piece. Hard-paste mode (seam_regen 0) writes
        # the canvas tile by tile, so it keeps the sequential order.
        # composite=latent (r84, Extra Options): the UNCHUNKED path
        # composites the way chunked runs already do -- tiles accumulate
        # in latent space (the overlap accumulator writes the canvas
        # either way) and the finished canvas is decoded once. No
        # per-tile decodes, no pixel compositor, no drift probe.
        # Measured against pixel compositing on the same clip/seed/LoRA:
        # -0.9% fine-band energy (uniform, not seam-localized), +1.7%
        # temporal stability, seams equal; -7% time at 1080p, -10%+ at
        # 4K. A quality/speed switch, not a correctness one.
        _latent_comp = (composite == "latent")
        if _latent_comp and pixel_out and not chunked:
            print("[TesseraRefine] composite=latent: tiles pasted in latent "
                  "space, one decode of the finished canvas (per-tile "
                  "decodes and the drift probe are off)")
        _batched = overlap_blend
        if _batched:
            _grps, _prev = [], None
            for _j, _jb in enumerate(jobs):
                if _jb[0] != _prev:
                    _grps.append([])
                    _prev = _jb[0]
                _grps[-1].append(_j)
            _sched = [(_j, _ph) for _g in _grps
                      for _ph in ("head", "tail") for _j in _g]
            if len(jobs) > 1:
                print(f"[TesseraRefine] phase-batched sampling: head pass "
                      f"then tail pass per chunk ({2 * len(_grps)} model "
                      f"swaps instead of {2 * len(jobs)})")
        else:
            _sched = [(_j, "both") for _j in range(len(jobs))]
        _pending = {}

        for j, _phase in _sched:
            ci, (tp, tms, tme, twl), k, (t, score, c) = jobs[j]
            comfy.model_management.throw_exception_if_processing_interrupted()
            t0 = time.perf_counter()
            i = t["index"]
            grel_eff = chunk_grel[ci]
            if guide_inherit and chunked and ci != inh_ci:
                inh_ci = ci
                if ci > 0:
                    upto = tp + tms
                    positive_j = _inherit_guide(positive, work, upto)
                    positive_clean_j = _inherit_guide(positive_clean, work,
                                                      upto)
                    positive_hero_j = (_inherit_guide(positive_hero, work,
                                                      upto)
                                       if positive_hero is not None else None)
                    tile_cond_j = ([(_inherit_guide(tc, work, upto)
                                     if tc is not None else None)
                                    for tc in tile_cond]
                                   if tile_cond is not None else None)
                    print(f"[TesseraRefine] guide_inherit: chunk {ci + 1} "
                          f"guide carries the refined canvas for latent "
                          f"frames 0..{upto} (detail relay)")
            sig_t = sigmas_for(c)
            steps = steps_for(c)
            t_len = twl if chunked else T_lat
            src_nd = work[:, :, tp:tp + t_len] if chunked else work
            win_plate = _window(src_nd, t["x"], t["y"], t["w"], t["h"]).clone()

            win_src = win_plate
            gx0, gx1, gy0, gy1 = t["mx0"], t["mx1"], t["my0"], t["my1"]

            if border_mode == "overlap":
                # nothing frozen: the tile is anchored by its own conditioning
                # only, never by (possibly drifted) neighbour output
                gx0, gx1, gy0, gy1 = 0, t["w"], 0, t["h"]
            mask = _tile_mask(win_src, gx0, gx1, gy0, gy1,
                              win_src.device, win_src.dtype)

            if t.get("hole"):
                # freeze the hero's footprint inside this window:
                # conditioning context, never repainted
                zx0, zy0, zx1, zy1 = t["hole"]
                mask[..., zy0:zy1, zx0:zx1] = 0.0

            if chunked and mask.ndim == 5:
                # freeze the temporal context: leading frames carry the
                # previous chunk's refined result, trailing frames (non-final
                # chunks) carry plate context -- the temporal border
                if tms > 0:
                    mask[:, :, :tms] = 0.0
                if tme < t_len:
                    mask[:, :, tme:] = 0.0

            pos = positive_j
            tagged = ""
            if t.get("hero_tile") and positive_hero_j is not None:
                # hero_guide_noise is an opt-in for face-window synthesis
                # (lip articulation) and the user asked for it by setting it
                pos = positive_hero_j
                tagged += " [hero gn]"
            own_prompt = (tile_cond_j is not None and 0 <= i < len(tile_cond_j)
                          and tile_cond_j[i] is not None)
            if own_prompt:
                pos = tile_cond_j[i]
                tagged = " [own prompt]"
            if t.get("hero_tile"):
                tagged += " [HERO]"

            if chunked:
                pos, tdid = _crop_cond_temporal(pos, tp, tp + t_len, T_lat)
                if tdid:
                    tagged += f" [t {tp}:{tp + t_len}]"

            if ref_crop == "per_tile":
                pos, did = _crop_minimax_refs(
                    pos, t["x"], t["y"], t["w"], t["h"], lw, lh, patch,
                    kinds=ref_kinds)
                if did:
                    tagged += " [ref cropped]"
                tkey = (t["x"], t["y"], t["w"], t["h"], tp, t_len)
                if tkey in text_cache and not own_prompt:
                    emb, nd = text_cache[tkey][0]
                    pos = [[emb, {**d, **nd}] for _, d in pos]
                    tagged += " [text cropped]"

            # In-band guides MUST match the gen's grid, so they are cropped
            # regardless of ref_crop.
            pos, kf_did = _crop_minimax_keyframes(
                pos, t["x"], t["y"], t["w"], t["h"], lw, lh, drop=False)
            if kf_did:
                tagged += " [guide cropped]"

            tile_seed = (seed if seed_mode == "fixed"
                         else seed + i + ci * 131071)
            # Chunked AV: slice each companion (audio) along ITS time axis,
            # proportional to the video window's share of the clip. Audio
            # latents are uniform-rate, so the linear map is faithful to a
            # token or so -- and companions are frozen conditioning (null
            # masks), so the slice is context, never content.
            comp_win = companions
            if chunked and wrapper is not None:
                comp_win = []
                for cmp in companions:
                    # H3 audio companions are [B, C, ch=2, T]: TIME IS THE
                    # LAST AXIS (dim 2 is the stereo pair -- slicing it cuts
                    # a channel, not a chunk; measured as a 2x row shortfall)
                    if cmp.ndim >= 3 and cmp.shape[-1] > 1:
                        Ta = int(cmp.shape[-1])
                        # constant slice length across chunks (uniform
                        # audio:video token ratio for the packed layout);
                        # offset proportional, clamped to bounds
                        alen = max(1, round(Ta * t_len / T_lat))
                        a0 = min(max(0, round(Ta * tp / T_lat)), Ta - alen)
                        comp_win.append(cmp[..., a0:a0 + alen])
                    else:
                        comp_win.append(cmp)
            if noise_full is not None:
                noise_base = _window(noise_full[:, :, tp:tp + t_len]
                                     if chunked else noise_full,
                                     t["x"], t["y"], t["w"], t["h"]).contiguous()
            else:
                noise_base = comfy.sample.prepare_noise(win_src, tile_seed)
            comp_noises = [comfy.sample.prepare_noise(cmp, tile_seed)
                           for cmp in comp_win] if wrapper is not None else []
            noise = (rewrap_latent(noise_base, comp_noises, wrapper)
                     if wrapper is not None else noise_base)

            mw = (t["mx1"] - t["mx0"]) * cell
            mh = (t["my1"] - t["my0"]) * cell
            ck = f"chunk {ci + 1}/{len(t_chunks)}  " if chunked else ""
            hdr = (f"{ck}tile {k + 1}/{n}  idx {i}  {mw}x{mh}  {c} "
                   f"(entry {float(sig_t[0]):.3f})"
                   f"{' clamped' if t['clamped'] else ''}{tagged}")
            if outer is not None:
                outer.set_postfix_str(f"{ck}tile {k + 1}/{n} {c}",
                                      refresh=False)
            elif not disable_inner and _phase != "tail":
                print(f"[TesseraRefine] {hdr}")

            lat_in = rewrap_latent(win_src, comp_win, wrapper)
            mask_in = (rewrap_latent(_full_mask(mask, win_src),
                                     _null_masks(comp_win), wrapper)
                       if wrapper is not None else mask)

            # ---- optional model/sampler tail split -----------------------
            # Head: main model+sampler down to the first sigma <= threshold.
            # Tail: fine pair continues the SAME trajectory. The handoff is
            # exact in flow space: for CONST (flow-matching) models comfy
            # enters sampling at  sigma*noise + (1-sigma)*process_in(latent),
            # so passing the head's raw output as BOTH the latent and (pre-
            # processed) noise reproduces it identically at the split sigma.
            # The frozen (context) region keeps the ORIGINAL noise/latent
            # pair so the per-step mask blend keeps denoising it on schedule.
            # per-tile head model: hero tiles run model_hero when wired
            # (grid tiles keep the main model); the tail below
            # fine_below_sigma hands off to model_fine for EVERY tile
            m_head = (model_hero if (c == "hero" and model_hero is not None)
                      else model)
            if c == "hero" and model_hero is not None and k == 0:
                print("[TesseraRefine] hero tile: running model_hero "
                      "(grid tiles use the main model)")
            m_fine = model_fine if model_fine is not None else m_head
            s_fine = sampler_fine if sampler_fine is not None else sampler
            # tail conditioning: same as pos, with the guide released
            # (noised per-frame) so the fine phase can texture freely.
            # Head calls keep `pos` untouched.
            pos_tail = pos
            if grel_eff > 0.0:
                pos_tail, _grel = _noise_minimax_keyframes(
                    pos, grel_eff, tile_seed, "full", "per_frame")
                if _grel and j == 0 and _phase != "tail":
                    print(f"[TesseraRefine] guide_release="
                          f"{grel_eff:.2f}: guide noised for the fine "
                          f"TAIL only (head keeps the clean guide -- "
                          f"structure at full evidence, texture freed)")
            jcut = None
            if fine_below_sigma > 0.0 and (model_fine is not None
                                           or sampler_fine is not None):
                jcut = next(idx for idx in range(len(sig_t))
                            if float(sig_t[idx]) <= fine_below_sigma)
            # phase bookkeeping: `_st` carries the head pass's result into
            # the tail pass; `_credit` is the step count this pass earns
            # on the progress bar; `_dt_head` the head pass's wall time.
            _st = _pending.pop(j) if _phase == "tail" else None
            _dt_head = _st["dt"] if _st else 0.0
            _credit = steps
            _split = (jcut is not None and 0 < jcut < len(sig_t) - 1)
            if jcut is not None and jcut == 0:
                # whole schedule below the threshold: fine pair runs it all
                out = _st["out"] if _st else _timed_sample(
                    m_fine, noise, cfg, s_fine, sig_t, pos_tail, negative,
                    lat_in, noise_mask=mask_in, callback=callback,
                    disable_pbar=disable_inner, seed=tile_seed)
            elif _split:
                mid = _st["mid"] if _st else _timed_sample(
                    m_head, noise, cfg, sampler, sig_t[:jcut + 1], pos,
                    negative, lat_in, noise_mask=mask_in, callback=callback,
                    disable_pbar=disable_inner, seed=tile_seed)
                if _phase == "head":
                    # park the intermediate; the tail pass picks it up
                    # once the fine model is the loaded one
                    _pending[j] = {"mid": mid,
                                   "dt": time.perf_counter() - t0}
                    state["done"] += jcut
                    pbar.update_absolute(state["done"], total_steps, None)
                    continue
                _credit = steps - jcut if _st else steps
                # The handoff math runs on plain tensors: unwrap (NestedTensor
                # when audio companions ride along), compose per component,
                # rewrap. Companions were denoised under null masks, so they
                # continue whole (same tensor as both noise and latent).
                mid_m, mid_c, _ = split_latent(mid)
                mid_m = mid_m.to(device=win_src.device, dtype=win_src.dtype)
                sel = (mask > 0.5).expand(mid_m.shape)
                # A run stopped at nonzero sigma comes back through comfy's
                # inverse_noise_scaling (CONST: divided by 1-sigma; EPS:
                # identity), which exists precisely so continuation works
                # with ZERO added noise: the tail's entry recomposes
                #   sigma*0 + (1-sigma)*process_in(mid)  ==  true x_k
                # for CONST, and  mid + sigma*0  ==  x_k  for EPS. Adding
                # any noise on top of `mid` here double-counts amplitude and
                # the tail sculpts it into frame-wide grain (measured 4-5x
                # fine-band energy before this was understood).
                n2_gen = torch.zeros_like(mid_m)
                n2_m = torch.where(sel, n2_gen,
                                   noise_base.to(win_src.device, win_src.dtype))
                lat2_m = torch.where(sel, mid_m, win_src)
                if wrapper is not None:
                    mid_c = [mc.to(device=win_src.device, dtype=win_src.dtype)
                             for mc in mid_c]
                    noise2 = rewrap_latent(n2_m, [torch.zeros_like(mc)
                                                  for mc in mid_c], wrapper)
                    lat2 = rewrap_latent(lat2_m, list(mid_c), wrapper)
                else:
                    noise2, lat2 = n2_m, lat2_m
                if k == 0 and ci == 0:
                    print(f"[TesseraRefine] tail split at sigma "
                          f"{float(sig_t[jcut]):.3f}: {jcut} head step(s) on "
                          f"main pair, {len(sig_t) - 1 - jcut} tail step(s) "
                          f"on fine pair"
                          f"{' [model_fine]' if model_fine is not None else ''}"
                          f"{' [sampler_fine]' if sampler_fine is not None else ''}")
                out = _timed_sample(
                    m_fine, noise2, cfg, s_fine, sig_t[jcut:], pos_tail,
                    negative, lat2, noise_mask=mask_in, callback=callback,
                    disable_pbar=disable_inner, seed=tile_seed)
            else:
                if jcut is not None and k == 0 and _phase != "tail":
                    print(f"[TesseraRefine] fine_below_sigma="
                          f"{fine_below_sigma} leaves no tail steps "
                          f"(schedule ends at {float(sig_t[-2]):.3f} before 0)"
                          f" -- running main pair only")
                out = _st["out"] if _st else _timed_sample(
                    m_head, noise, cfg, sampler, sig_t, pos, negative, lat_in,
                    noise_mask=mask_in, callback=callback,
                    disable_pbar=disable_inner, seed=tile_seed)
            if _phase == "head":
                # single-call tile: fully sampled in the head pass; the
                # tail pass only composites it (keeps the paste order)
                _pending[j] = {"out": out, "dt": time.perf_counter() - t0}
                state["done"] += steps
                pbar.update_absolute(state["done"], total_steps, None)
                continue
            if _st is not None and "out" in _st:
                _credit = 0
            out = split_latent(out)[0]

            # per-tile LATENT sharpness probe: high-frequency energy of the
            # sampler's own output, before compositing/decode/encode can
            # touch it. Comparing this stat for the same tile between a
            # solo and a full run isolates WHERE quality diverges: equal
            # stats = downstream; unequal = the sampling itself (inputs or
            # execution environment).
            _om = out.float().mean(dim=1)
            _L = (_om[..., 1:-1, 1:-1] * 4 - _om[..., :-2, 1:-1]
                  - _om[..., 2:, 1:-1] - _om[..., 1:-1, :-2]
                  - _om[..., 1:-1, 2:])
            hf_stat = float(_L.pow(2).mean())
            del _om, _L

            if dc_match:
                out = _match_dc_frame(out, win_src, mask)

            drift = ""
            # per-tile pixel pastes are skipped under temporal chunking:
            # decoding an INTERIOR chunk standalone glitches the causal
            # VAE's head frames. The final composite is a single decode
            # of the finished canvas instead.
            if pixel_out and not chunked and not _latent_comp:
                win_px = _as_image(vae.decode(out))
                my0p, my1p = t["my0"] * cell, t["my1"] * cell
                mx0p, mx1p = t["mx0"] * cell, t["mx1"] * cell
                # r82: the plate window is decoded ONLY to feed the drift
                # probe (and the retired pixel color match) -- a spatial
                # shift estimate does not need 124 frames. One latent
                # block (5 px frames) is the same measurement at ~4% of
                # the cost; the full decode stays for color match only.
                if pixel_color_match != "off":
                    plate_px = _as_image(vae.decode(win_plate))
                    probe_n = win_px.shape[0]
                else:
                    plate_px = _as_image(vae.decode(win_plate[:, :, :2]))
                    probe_n = min(plate_px.shape[0], win_px.shape[0])
                sdx, sdy = _px_shift(
                    win_px[:probe_n, my0p:my1p, mx0p:mx1p].cpu(),
                    plate_px[:probe_n, my0p:my1p, mx0p:mx1p].cpu())
                drift = f"  drift {sdx:+.1f},{sdy:+.1f}px"
                if pixel_color_match != "off":
                    win_px = _px_color_match(win_px, plate_px,
                                             pixel_color_match)
                del plate_px
                px_tiles.append((t, win_px.to(device="cpu",
                                              dtype=torch.float16)))

            if overlap_blend:
                # Weighted accumulation instead of hard pastes: every tile
                # adds gen*W and W (ramped over the seam_E strip, 0 in the
                # hero hole), and the chunk slice is normalized by the summed
                # weights once its last tile lands. This makes the doubly
                # generated strips exact gen<->gen crossfades in LATENT
                # space too -- the chunked path never runs the pixel
                # compositor, so a hard paste there was last-writer-wins,
                # and a sequential feather would compound to ~25% plate
                # residue mid-strip. Normalizing per chunk (not at the end)
                # keeps the temporal chaining intact: the next chunk's
                # frozen context frames read this chunk's finished output.
                tgt = work[:, :, tp + tms:tp + tme] if chunked else work
                if acc_ci != ci:
                    acc = torch.zeros_like(tgt)
                    wsum = torch.zeros(tgt.shape[-2:], dtype=tgt.dtype,
                                       device=tgt.device)
                    acc_ci = ci
                Wt = _tile_weight(t, seam_E, lw, lh, tgt.dtype, tgt.device)
                gen = out[..., t["my0"]:t["my1"], t["mx0"]:t["mx1"]]
                if chunked:
                    # only the chunk's GENERATED temporal range; frozen
                    # context frames stay owned by their own chunk
                    gen = gen[:, :, tms:tme]
                ax0, ay0 = t["x"] + t["mx0"], t["y"] + t["my0"]
                ah, aw = Wt.shape
                acc[..., ay0:ay0 + ah, ax0:ax0 + aw] += gen * Wt
                wsum[ay0:ay0 + ah, ax0:ax0 + aw] += Wt
                if j + 1 == len(jobs) or jobs[j + 1][0] != ci:
                    lit = wsum > 0
                    tgt.copy_(torch.where(lit, acc / wsum.clamp(min=1e-6),
                                          tgt))
                    acc = wsum = None
                    acc_ci = -1
            else:
                paste_rects = [(t["mx0"], t["my0"], t["mx1"], t["my1"])]
                if t.get("hole"):
                    paste_rects = _rect_sub(t["mx0"], t["my0"],
                                            t["mx1"], t["my1"], *t["hole"])
                for (rx0, ry0, rx1, ry1) in paste_rects:
                    gen = out[..., ry0:ry1, rx0:rx1]
                    if chunked:
                        # write only the chunk's GENERATED temporal range;
                        # frozen context frames stay owned by their own chunk
                        _paste(work[:, :, tp + tms:tp + tme],
                               gen[:, :, tms:tme], t["x"] + rx0,
                               t["y"] + ry0)
                    else:
                        _paste(work, gen, t["x"] + rx0, t["y"] + ry0)

            state["done"] += _credit
            pbar.update_absolute(state["done"], total_steps, None)

            dt = time.perf_counter() - t0 + _dt_head
            step_times.append(dt / steps)
            per_step = sum(step_times) / len(step_times)
            rem = max(0, total_steps - state["done"])
            eta = per_step * rem
            line = f"{hdr}{drift}  hf {hf_stat:.4f}  {_fmt(dt)}"
            report_lines.append(line)
            if disable_inner:
                print(f"[TesseraRefine] {line}  ·  eta {_fmt(eta)}")
            else:
                print(f"[TesseraRefine]  {drift}  hf {hf_stat:.4f}  "
                      f"{_fmt(dt)}  ·  eta {_fmt(eta)}")

        if outer is not None:
            outer.close()
        _tm["loop"] = time.perf_counter() - _tm["loop0"]
        elapsed = time.perf_counter() - t_start
        summary = (f"{n} tile(s) refined ({n_hero} hero, {n - n_hero} base), "
                   f"{n_skip} skipped"
                   + (f", x{len(t_chunks)} temporal chunks" if chunked else "")
                   + f", in {_fmt(elapsed)}")
        print(f"[TesseraRefine] done — {summary}")
        _tm["out0"] = time.perf_counter()

        if frame_match == "dc" and samples.ndim == 5:
            # GLOBAL per-frame anchor: one offset per (channel, frame) over
            # the whole canvas, pulling each frame's latent DC back to the
            # plate's. Pins the clip's exposure arc (an unanchored gen was
            # measured flattening a 42-level luma arc to 15) and removes
            # the chunk-entry transient (frame-diff 9.2 -> baseline), with
            # no spatial structure, so it cannot draw tile seams.
            fm_d = (samples.float().mean(dim=(-2, -1), keepdim=True)
                    - work.float().mean(dim=(-2, -1), keepdim=True))
            # TRANSIENT-ONLY correction: remove the clip-wide average of the
            # offset per channel, so only the temporal SHAPE (exposure arc,
            # chunk-entry transient) is corrected. The static component is
            # the refined canvas's legitimate departure from the soft plate
            # -- the refinement itself. Anchoring it back to plate means
            # shifted fully-refined latents ~1.4 off-manifold and the VAE
            # decoded them as mush (measured: chunked-full tile detail 87
            # vs 319 solo, while the pre-frame_match latents were
            # hf-identical; unchunked runs hid it because the pixel path
            # bypasses the matched latent).
            fm_d = fm_d - fm_d.mean(dim=2, keepdim=True)
            work = work + fm_d.to(work.dtype)
            md = float(fm_d.abs().max())
            print(f"[TesseraRefine] frame_match=dc: per-frame TRANSIENT DC "
                  f"anchored to the plate's arc (max channel offset "
                  f"{md:.4f}; static refined-vs-plate offset preserved)")

        out_latent = latent.copy()
        out_latent["samples"] = rewrap_latent(work, companions, wrapper)

        image_out = torch.zeros(1, 8, 8, 3)
        try:
            if pixel_out and not px_tiles:
                # chunked runs paste in latent space; there is nothing to
                # composite -- decode straight to the output. Long clips go
                # through the STREAMED segment decode: a monolithic decode
                # must hold the whole float32 pixel tensor inside the VAE
                # (measured: access violation in write_part at ~45GB on a
                # 447-frame 4K canvas).
                est32 = 0
                if samples.ndim == 5:
                    px_T_est = 5 + 17 * ((T_lat - 2) // 5) \
                        if (T_lat - 2) % 5 == 0 else T_lat * 4
                    est32 = px_T_est * (lh * cell) * (lw * cell) * 3 * 4
                streamed = None
                if est32 > (8 << 30):
                    print(f"[TesseraRefine] pixel_out: streamed segment decode "
                          f"(full canvas ~= {est32 / (1 << 30):.1f}GB float32)")
                    streamed = _decode_stream_video(vae, work, _as_image,
                                                    frame_map)
                if streamed is not None:
                    image_out = streamed
                else:
                    print("[TesseraRefine] pixel_out: single decode of the "
                          "finished canvas (latent-space pastes; no "
                          "compositing pass)")
                    image_out = _as_image(vae.decode(work)).to(device="cpu")
                    if image_out.dtype != torch.float32:
                        image_out = image_out.float()
                    # r83: a frame_map no longer forces the segment
                    # decoder onto small canvases (its warm-ups cost ~65%
                    # extra decode work); decimate the monolithic decode
                    # the same way -- first occurrence of each source
                    # frame -- so Temporal Decimate passes through.
                    if frame_map and samples.ndim == 5:
                        try:
                            import json as _json
                            _fm = [int(x) for x in _json.loads(frame_map)]
                            if len(_fm) == int(image_out.shape[0]):
                                _first = {}
                                for _j, _fi in enumerate(_fm):
                                    _first.setdefault(_fi, _j)
                                _keep = sorted(_first.values())
                                if len(_keep) < len(_fm):
                                    image_out = image_out[_keep]
                                    print(f"[TesseraRefine] frame_map wired: "
                                          f"decimated {len(_fm)} -> "
                                          f"{len(_keep)} frames after the "
                                          f"decode")
                        except Exception as _e:
                            print(f"[TesseraRefine] frame_map ignored ({_e})")
            elif pixel_out:
                print(f"[TesseraRefine] pixel_out: decoding plate + compositing "
                      f"{len(px_tiles)} refined tile(s) in pixel space "
                      f"(no re-encode on the output path)")
                # the monolithic plate decode materializes the full float32
                # canvas inside the VAE (measured: 49.7GB alloc failure on
                # a 124-frame 8K canvas). Big canvases go through the
                # STREAMED segment decode instead (fp16 + disk-backed
                # buffer); the tile pastes below write into that buffer in
                # place. frame_map stays OUT of this decode: pastes index
                # the full timeline, decimation happens downstream.
                canvas = None
                if samples.ndim == 5:
                    _est = ((5 + 17 * ((T_lat - 2) // 5))
                            * (lh * cell) * (lw * cell) * 3 * 4
                            if (T_lat - 2) % 5 == 0 else 0)
                    if _est > (8 << 30):
                        print(f"[TesseraRefine] pixel_out: plate via "
                              f"streamed decode (monolithic would be "
                              f"~{_est / (1 << 30):.1f}GB float32)")
                        canvas = _decode_stream_video(vae, work,
                                                      _as_image, "")
                if canvas is None:
                    canvas = _as_image(vae.decode(work)).to(
                        dtype=torch.float32, device="cpu").contiguous()
                Hpx, Wpx = canvas.shape[1], canvas.shape[2]
                # the canvas base decodes the frame_match-anchored latent; the
                # pasted tiles were decoded before that anchor existed. Capture
                # the anchored per-frame means now and restore them after
                # compositing, so the pixel output keeps the global anchor.
                # (fp32 accumulation: the canvas may be fp16.)
                fm_target = (canvas.mean(dim=(1, 2), keepdim=True,
                                         dtype=torch.float32)
                             if frame_match == "dc" else None)
                # Hero pastes FIRST; grid tiles paste only their mask MINUS the
                # hero hole, so the face keeps hero pixels while any regenerated
                # hero-rim strips (seam_regen) and grid content paste after and
                # win at the boundary.
                px_tiles.sort(key=lambda p: 0 if p[0].get("hero_tile") else 1)
                for t, wpx in px_tiles:
                    x0 = (t["x"] + t["mx0"]) * cell
                    y0 = (t["y"] + t["my0"]) * cell
                    crop = wpx[:, t["my0"] * cell:t["my1"] * cell,
                               t["mx0"] * cell:t["mx1"] * cell, :]
                    if crop.dtype != canvas.dtype:
                        crop = crop.to(canvas.dtype)
                    open_edges = (y0 > 0,
                                  y0 + crop.shape[1] < Hpx,
                                  x0 > 0,
                                  x0 + crop.shape[2] < Wpx)
                    hole_px = None
                    if t.get("hole"):
                        hx0, hy0, hx1, hy1 = t["hole"]
                        # hole is window-local; make it mask-crop-local px
                        hole_px = ((hx0 - t["mx0"]) * cell, (hy0 - t["my0"]) * cell,
                                   (hx1 - t["mx0"]) * cell, (hy1 - t["my0"]) * cell)
                    # feather == the seam_regen overlap: the later tile's rising
                    # ramp then spans exactly the strip both tiles generated, so
                    # the join is a true crossfade between two generations
                    # instead of each tile fading into the canvas decode
                    _px_paste(canvas, crop, x0, y0, seam_regen or 32, open_edges,
                              hole_px=hole_px)
                if fm_target is not None:
                    # IN-PLACE: the old `(canvas + off).clamp()` form allocated
                    # two extra full-canvas float32 copies (a ~2x19GB transient
                    # on a 192-frame 4K canvas -- measured DefaultCPUAllocator
                    # failure) just to apply a 3-numbers-per-frame offset.
                    canvas.add_((fm_target
                                 - canvas.mean(dim=(1, 2), keepdim=True,
                                               dtype=torch.float32)
                                 ).to(canvas.dtype))
                    canvas.clamp_(0.0, 1.0)
                image_out = canvas
        except Exception as _pe:
            import traceback
            traceback.print_exc()
            _rp = ""
            try:
                import folder_paths
                _rp = _os.path.join(
                    folder_paths.get_output_directory(),
                    "tessera_rescue_%d.latent" % int(time.time()))
                comfy.utils.save_torch_file(
                    {"latent_tensor": work.contiguous().cpu(),
                     "latent_format_version_0": torch.tensor([])}, _rp)
            except Exception as _se:
                _rp = "(rescue save also failed: %s)" % _se
            _warn("[TesseraRefine] pixel_out FAILED (%s) -- the refined "
                  "LATENT is returned anyway and a rescue copy was saved "
                  "to %s. Fix the cause (disk space / TESSERA_SCRATCH), move "
                  "the .latent file into ComfyUI/input, and decode it "
                  "with LoadLatent -> Streamed Decode (recovery): no "
                  "resampling needed." % (_pe, _rp))
            report_lines.append("pixel_out FAILED: %s; rescue: %s"
                                % (_pe, _rp))
            # the placeholder must carry the CORRECT frame count or
            # downstream nodes (Temporal Decimate, video save) error out
            # and poison Comfy's cache with a failing graph (measured:
            # three cascade failures after a rescued 8K run)
            _ph = 1
            if samples.ndim == 5 and (T_lat - 2) % 5 == 0:
                _ph = 5 + 17 * ((T_lat - 2) // 5)
            image_out = torch.zeros(_ph, 16, 16, 3)

        # ---- timing breakdown (r78): where the wall time went ---------
        _t_end = time.perf_counter()
        _sv = sorted(_tm["steps"])
        _med = _sv[len(_sv) // 2] if _sv else 0.0
        _load = sum(max(0.0, _f - _med) for _f in _tm["first"])
        _ovh = max(0.0, _tm.get("loop", 0.0) - _tm["sample"])
        _prep = max(0.0, (_tm.get("loop0", _t_end) - _t_run0)
                    - _tm["text"])
        _out = _t_end - _tm.get("out0", _t_end)
        print(f"[TesseraRefine] timing: total {_fmt(_t_end - _t_run0)} = "
              f"prep {_fmt(_prep)} + text-encode {_fmt(_tm['text'])} + "
              f"sampling {_fmt(_tm['sample'])} (pure steps "
              f"~{_fmt(max(0.0, _tm['sample'] - _load))}, model load/swap "
              f"~{_fmt(_load)}) + tile overhead {_fmt(_ovh)} + "
              f"output {_fmt(_out)}")
        report_lines.append(
            f"timing: total {_fmt(_t_end - _t_run0)}, sampling "
            f"{_fmt(_tm['sample'])}, load/swap ~{_fmt(_load)}, "
            f"output {_fmt(_out)}")
        return (out_latent, summary + "\n" + "\n".join(report_lines),
                image_out)


class TesseraDilate:
    """Stage 2, front half: expand a pixel clip to ~2x slow motion by frame
    duplication, trimmed to the largest H3-native length (17k+5) that fits.

    Fast motion renders smeared because per-frame displacement exceeds what
    the model can track (~1.2 latent cells/frame); at 2x dilation the same
    motion is half as fast per frame and renders cleanly, detail stacks
    included. Wire this on the SOURCE before everything (upscale, AddGuide,
    encodes) so the whole graph runs on the dilated timeline -- chunking
    keeps VRAM constant regardless of the doubled length. Decimate at the
    output with Tessera Temporal Decimate (same original_frames), and keep the
    ORIGINAL audio at the write node.

    17k+5 doesn't close under doubling, so the first (K - N) real frames
    are duplicated and the remaining tail runs at real time (printed).
    For dialogue, time-stretch the conditioning audio 2x upstream or expect
    lipsync drift during dilated spans.

    mode "auto" (stage 2): measures per-frame displacement in pixel space
    (the motion oracle's formula: mean |dt| / mean spatial gradient,
    converted to GEN latent cells via upscale_factor) and dilates ONLY the
    spans above `threshold` (+-2 frames of margin), padding with extra calm
    duplicates to land on the 17k+5 ladder. A mostly-calm clip with one
    fast crossing then costs ~1.2-1.4x sampling instead of the flat 2x.
    Wire the frame_map output to Decimate's frame_map input (the
    original_frames wire alone only describes "full" mode's fixed map)."""
    CATEGORY = "Tessera"
    RETURN_TYPES = ("IMAGE", "INT", "STRING", "STRING")
    RETURN_NAMES = ("dilated", "original_frames", "info", "frame_map")
    FUNCTION = "run"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "images": ("IMAGE",),
            "mode": (["full", "auto"],),
            # smear knee in GEN latent cells/frame (oracle-calibrated)
            "threshold": ("FLOAT", {"default": 1.2, "min": 0.1, "max": 10.0, "step": 0.1}),
            # the spatial upscale factor the refine stage will apply --
            # needed to convert source-pixel velocity to gen latent cells
            "upscale_factor": ("FLOAT", {"default": 2.0, "min": 1.0, "max": 8.0, "step": 0.5}),
        }}

    @staticmethod
    def _ladder_up(n):
        """smallest 17m+5 >= n (m >= 1)"""
        import math
        m = max(1, math.ceil((n - 5) / 17))
        return 17 * m + 5

    def run(self, images, mode="full", threshold=1.2, upscale_factor=2.0):
        import json
        n = int(images.shape[0])
        ident = json.dumps(list(range(n)))
        if n < 3:
            return (images, n, "clip too short -- passed through", ident)

        if mode == "auto":
            # per-transition displacement, source pixels/frame -> gen cells.
            # Measured on a stride-4 grayscale subsample (16x less memory;
            # the RAM law applies to analysis passes too). On the strided
            # grid both |dt| and the gradient are per-strided-pixel, so
            # dt/grad is velocity in strided px -- times stride = source px.
            s = 4
            g = images[:, ::s, ::s, :].float().mean(dim=-1)
            gx = (g[:, :, 1:] - g[:, :, :-1]).abs().mean()
            gy = (g[:, 1:, :] - g[:, :-1, :]).abs().mean()
            grad = float(gx + gy) / 2.0 + 1e-6
            dt = (g[1:] - g[:-1]).abs().mean(dim=(1, 2))   # [n-1]
            # CAL folds the pixel-vs-latent scale gap into the oracle's
            # units: pixel gradients are texture-dominated, so |dt|/grad
            # under-reads velocity ~2x vs the in-sampler latent oracle.
            # Calibrated on three graded clips (street globally-hot 0.69
            # proxy vs oracle >1.2; cyclist crossing 0.63 peak = borderline
            # hot; ballroom calm 0.10) -- CAL=2 reproduces all three
            # verdicts at the shared 1.2 threshold.
            CAL = 2.0
            disp = (dt / grad) * s * CAL * (upscale_factor / 16.0)
            hot_tr = disp > threshold                       # transitions
            hot = [False] * n
            for i in range(n - 1):
                if bool(hot_tr[i]):
                    for j in range(max(0, i - 2), min(n, i + 4)):
                        hot[j] = True                       # +-2 frame margin
            n_hot = sum(hot)
            if n_hot == 0:
                # snap a passthrough onto the 17k+5 ladder: a non-native
                # length gets silently TRUNCATED by the H3 encode downstream
                # while the frame_map keeps the original count -- the map
                # and the clip then disagree at Decimate (measured: a
                # 24-frame source erroring as 24 != 22)
                k_fit = ((n - 5) // 17) * 17 + 5 if n >= 22 else n
                if k_fit != n and k_fit >= 22:
                    info = (f"auto: max disp {float(disp.max()):.2f} "
                            f"cells/frame <= {threshold:.2f} -- no dilation "
                            f"needed; {n} frames is not an H3-native length, "
                            f"trimmed to {k_fit} (17k+5) so the encode and "
                            f"frame_map agree")
                    print(f"[TesseraDilate] {info}")
                    import json as _j
                    return (images[:k_fit], k_fit, info,
                            _j.dumps(list(range(k_fit))))
                info = (f"auto: max disp {float(disp.max()):.2f} cells/frame "
                        f"<= {threshold:.2f} -- no dilation needed, passed "
                        f"through at real time")
                print(f"[TesseraDilate] {info}")
                return (images, n, info, ident)
            k = self._ladder_up(n + n_hot)
            pad = k - (n + n_hot)
            dup = list(hot)
            # spend padding on extra calm duplicates: first widen the hot
            # spans outward, then walk from the clip start
            while pad > 0:
                spent = False
                for i in range(n):
                    if pad <= 0:
                        break
                    if not dup[i] and (
                            (i > 0 and dup[i - 1]) or
                            (i < n - 1 and dup[i + 1])):
                        dup[i] = True; pad -= 1; spent = True
                if not spent:
                    for i in range(n):
                        if pad <= 0:
                            break
                        if not dup[i]:
                            dup[i] = True; pad -= 1; spent = True
                if not spent:
                    break                                   # all doubled
            idx = []
            for i in range(n):
                idx.append(i)
                if dup[i]:
                    idx.append(i)
            while len(idx) < k:                             # all-doubled edge
                idx.insert(1, 0)
            spans = []
            i = 0
            while i < n:
                if hot[i]:
                    j = i
                    while j < n - 1 and hot[j + 1]:
                        j += 1
                    spans.append((i, j)); i = j + 1
                else:
                    i += 1
            info = (f"auto: {n} -> {len(idx)} frames, hot span(s) "
                    f"{', '.join(f'{a}-{b}' for a, b in spans)} dilated "
                    f"(max disp {float(disp.max()):.2f} cells/frame, "
                    f"threshold {threshold:.2f}) -- "
                    f"{len(idx) / n:.2f}x sampling vs real time")
            print(f"[TesseraDilate] {info}")
            return (images[torch.tensor(idx, dtype=torch.long)], n, info,
                    json.dumps(idx))

        k = ((2 * n - 5) // 17) * 17 + 5          # largest 17k+5 <= 2n
        k = max(k, n)
        d = k - n                                  # frames that get doubled
        idx = []
        for i in range(n):
            idx.append(i)
            if i < d:
                idx.append(i)
        out = images[torch.tensor(idx, dtype=torch.long)]
        if d == 0:
            info = f"{n} frames: too short to dilate to a longer 17k+5 length -- passed through"
        elif d < n:
            info = (f"{n} -> {k} frames: real frames 0-{d - 1} at 2x slow "
                    f"motion, {d}-{n - 1} at real time")
        else:
            info = f"{n} -> {k} frames, fully dilated"
        print(f"[TesseraDilate] {info}")
        return (out, n, info, json.dumps(idx))


class TesseraDecimate:
    """Stage 2, back half: recover real-time playback from a refined
    dilated clip by keeping exactly the original frames' timestamps
    (inverse of Tessera Temporal Dilate's duplication map). Pixel-space frame
    SELECTION -- no interpolation, no VAE round trip."""
    CATEGORY = "Tessera"
    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "run"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "images": ("IMAGE",),
            "original_frames": ("INT", {"default": 0, "min": 0, "max": 8192}),
        }, "optional": {
            # Dilate's frame_map output (JSON). Required for mode "auto"
            # (its duplication pattern is content-dependent); optional for
            # "full", where original_frames alone describes the fixed map.
            "frame_map": ("STRING", {"default": "", "multiline": False}),
        }}

    def run(self, images, original_frames, frame_map=""):
        import json
        k, n = int(images.shape[0]), int(original_frames)
        if frame_map:
            try:
                m = json.loads(frame_map)
            except Exception as e:
                raise ValueError(f"frame_map is not valid JSON: {e}")
            first = {}
            for j, i in enumerate(m):
                if i not in first:
                    first[int(i)] = j
            if len(m) != k:
                if k == len(first):
                    # already decimated upstream (the refine node's
                    # frame_map input decimates during its streamed decode)
                    print(f"[TesseraDecimate] clip is already at real "
                          f"time ({k} frames) -- passing through")
                    return (images,)
                raise ValueError(
                    f"frame_map length {len(m)} != clip length {k} -- wire "
                    f"the SAME Dilate node's frame_map output here")
            n_map = max(first) + 1
            idx = [first[i] for i in range(n_map)]
            print(f"[TesseraDecimate] {k} -> {n_map} frames via "
                  f"frame_map (kept original timestamps)")
            return (images[torch.tensor(idx, dtype=torch.long)],)
        if n <= 0 or k <= n:
            return (images,)
        d = k - n
        idx = [2 * i if i < d else d + i for i in range(n)]
        if idx[-1] >= k:
            raise ValueError(
                f"decimation map exceeds clip: {k} frames with "
                f"original_frames={n} is not a Temporal Dilate output pair")
        print(f"[TesseraDecimate] {k} -> {n} frames (kept original "
              f"timestamps)")
        return (images[torch.tensor(idx, dtype=torch.long)],)


class TesseraGrain:
    """Pixel grain for the guide image, applied BEFORE the VAE encode
    (wire: source -> Guide Grain -> AddGuide).

    Pixel-space grain is the detail mandate: encode(image + grain) is an
    on-manifold latent that confidently asserts fine texture, which the
    model renders (measured: the mechanism behind every high-detail run).
    The grain is LUMA-only (per-channel RGB noise reads as digital chroma
    speckle) and band-limited to `grain_size` px (raw 1px white noise
    renders as salt-and-pepper stipple -- measured on marble), per-frame
    independent on purpose (the causal VAE integrates ~4 px frames per
    latent frame into film-grain statistics; temporally persistent
    patterns read as CONTENT and ghost -- measured on both counts).

    By default the grain is UNIFORM. Regions whose content lives in faint
    gradients -- smoke, sky, volumetrics -- get ERASED by uniform grain
    (the model then has freedom + no evidence there: the ghost recipe,
    measured), so wire `protect_mask` (white = keep clean) with a quick
    roto/SAM mask of those regions. Auto-detection was tried and removed:
    at source resolution "smooth surface that should get invented texture"
    and "smooth smoke that must stay clean" are statistically identical --
    a local-contrast mask degenerates into an edge-outline map (measured),
    and the distinction is semantic. You know where the smoke is; the
    node does not."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "image":    ("IMAGE",),
            "strength": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 1.0,
                                   "step": 0.05}),
            # grain scale in source pixels: ~2.0 asserts texture at the
            # 2-8px scale where believable fine detail lives; 1.0 = raw
            # white noise (legacy / harshest)
            "grain_size": ("FLOAT", {"default": 2.0, "min": 1.0,
                                     "max": 6.0, "step": 0.25}),
            "seed":     ("INT", {"default": 0, "min": 0,
                                 "max": 0xFFFFFFFFFFFFFFFF}),
        }, "optional": {
            # white = protected (no grain): smoke, sky, volumetrics, any
            # region whose faint gradients ARE the content. Static [1,H,W]
            # masks broadcast to the whole clip; [T,H,W] applies per frame.
            "protect_mask": ("MASK",),
        }}

    RETURN_TYPES = ("IMAGE", "IMAGE")
    RETURN_NAMES = ("image", "grain_mask")
    FUNCTION = "run"
    CATEGORY = "Tessera"

    @staticmethod
    def _shape(n_hw, size):
        """Band-limit 2D unit noise to `size` px (gaussian low-pass,
        re-normalized to unit std) -- clumpy organic grain, no stipple."""
        if size <= 1.01:
            return n_hw
        sig = size / 2.0
        r = max(1, int(3.0 * sig))
        xs = torch.arange(-r, r + 1, dtype=torch.float32)
        g = torch.exp(-(xs * xs) / (2.0 * sig * sig))
        g = g / g.sum()
        t = n_hw[None, None]
        t = torch.nn.functional.conv2d(t, g.view(1, 1, 1, -1),
                                       padding=(0, r))
        t = torch.nn.functional.conv2d(t, g.view(1, 1, -1, 1),
                                       padding=(r, 0))
        t = t[0, 0]
        return t / t.std().clamp(min=1e-6)

    def run(self, image, strength, grain_size, seed, protect_mask=None):
        x = image.float()                          # [T, H, W, C] in 0..1
        T, H, W = x.shape[0], x.shape[1], x.shape[2]
        if protect_mask is not None:
            m = protect_mask.float()
            if m.ndim == 2:
                m = m[None]
            if m.shape[-2] != H or m.shape[-1] != W:
                m = torch.nn.functional.interpolate(
                    m[:, None], size=(H, W), mode="bilinear",
                    align_corners=False)[:, 0]
            keep = (1.0 - m).clamp(0.0, 1.0)       # [B, H, W]
            if keep.shape[0] == 1:
                keep = keep.expand(T, -1, -1)
            elif keep.shape[0] < T:
                keep = torch.cat([keep, keep[-1:].expand(
                    T - keep.shape[0], -1, -1)], dim=0)
            pct = 100.0 * float(keep.mean())
            print(f"[TesseraGrain] strength {strength:.2f}, grain_size "
                  f"{grain_size:.2f}: protect_mask wired, grain covers "
                  f"{pct:.0f}% of frame")
        else:
            keep = None
            print(f"[TesseraGrain] strength {strength:.2f}, grain_size "
                  f"{grain_size:.2f}: UNIFORM grain (no protect_mask). "
                  f"If this clip has smoke/sky/volumetrics, wire a mask "
                  f"-- uniform grain erases faint content and ghosts "
                  f"there (measured)")
        gen = torch.Generator("cpu").manual_seed(int(seed) ^ 0x6E61)
        out = x.clone()
        for f in range(T):                         # frame-wise: bounds RAM
            n = self._shape(torch.randn((H, W), generator=gen),
                            grain_size)[..., None]
            k = keep[f][..., None] if keep is not None else 1.0
            out[f] = (x[f] + strength * k * n).clamp(0.0, 1.0)
        gm = (keep[..., None].expand(-1, -1, -1, x.shape[-1])
              if keep is not None else torch.ones_like(x))
        return (out.to(image.dtype), gm.to(image.dtype))


class TesseraArgs:
    """Advanced options for Tiled Refine V2, bundled into its `args` socket.
    Unwired, the refiner runs the validated v4 defaults (which are also
    this node's defaults) -- wire it only to deviate."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            # crop the first video / image reference to each tile's window
            "video_ref_crop":  (["per_tile", "global"],),
            "image_ref_crop":  (["per_tile", "whole"],),
            # all-step guide corruption (legacy detail lever; v4 keeps the
            # guide clean and uses an anchor + guide_release instead)
            "guide_noise":     ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.05}),
            "guide_noise_band": (["full", "fine"],),
            "guide_noise_t":   (["per_frame", "smooth", "static"],),
            # phase-split release: guide noised ONLY for the fine tail
            "guide_release":   ("FLOAT", {"default": 0.8, "min": 0.0, "max": 1.0, "step": 0.05}),
            # detail relay: later chunks' guides carry the refined canvas
            "guide_inherit":   ("BOOLEAN", {"default": True}),
            # hero-only full-band guide noise (lipsync articulation);
            # -1 = follow guide_noise, 0 = hero always clean
            "hero_guide_noise": ("FLOAT", {"default": -1.0, "min": -1.0, "max": 1.0, "step": 0.05}),
            # v3-aware motion adaptation: each chunk's global motion (latent
            # oracle) scales guide_release toward motion_release_floor -- the
            # sigma ladder is never touched. Released-tail texture is
            # screen-locked, so on moving cameras it boils (measured 11-16%
            # detail oscillation on pans vs 2-3% locked-off); this grants
            # texture freedom only where invention can persist. Locked-off
            # chunks keep full release; >=1.2 cells/lf (~6 px/frame) drops
            # to the floor; between, linear.
            "motion_adapt":    ("BOOLEAN", {"default": False}),
            "motion_release_floor": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.05}),
            # sigma below which the fine pair (model_fine/sampler_fine)
            # takes over -- the released euler tail
            "fine_below_sigma": ("FLOAT", {"default": 0.75, "min": 0.0, "max": 2.0, "step": 0.01}),
            # debug: run only these tile indices ("4,7", "h" = hero)
            "tile_select":     ("STRING", {"default": ""}),
            "tile_limit":      ("INT", {"default": 0, "min": 0, "max": 4096}),
            # hallucination guard: a (tile, chunk) window whose busiest
            # fine-band block is below flat_skip x the clip's own
            # block-energy floor (the median block -- self-calibrating,
            # no calibration run) is featureless and keeps the plate:
            # no sampling, no invention. Flat noise peaks at ~2-3x the
            # floor; real content clears 4.0 by multiples. 0 = off.
            "flat_skip":       ("FLOAT", {"default": 4.0, "min": 0.0,
                                          "max": 64.0, "step": 0.1}),
            # how the refined tiles become the output (unchunked runs;
            # chunked runs always composite in latent space):
            #   pixel  -- every tile decoded on its own and crossfaded in
            #             pixel space. Measured: +0.9% fine-band energy.
            #   latent -- tiles land in latent space, ONE decode of the
            #             finished canvas. Measured: +1.7% temporal
            #             stability, no per-tile decodes (-7% time at
            #             1080p, -10%+ at 4K, growing with tile count).
            "composite":       (["pixel", "latent"], {"default": "pixel"}),
        }}

    RETURN_TYPES = ("TESSERA_ARGS",)
    RETURN_NAMES = ("args",)
    FUNCTION = "run"
    CATEGORY = "Tessera"

    def run(self, **kw):
        return (dict(kw),)


class TesseraAnchor:
    """Splice a DETAILED still into a guide clip as the anchor frame,
    tolerating an imperfect match (wire: anchor still + guide clip ->
    Guide Anchor -> AddGuide).

    The detail-relay doctrine: a detailed anchor at frame 0 (and
    guide_inherit for later chunks) sets the texture ceiling for the whole
    clip. But a full-frame replacement pops unless the still is
    pixel-aligned (measured: f0->f1 frame-diff 30 vs 4.7). This node makes
    rough anchors legal:

      texture mode (default) -- keep the PLATE frame's low band (geometry,
        lighting, placement: pop-proof by construction) and transplant the
        anchor's FINE band onto it (the detail mandate). Texture offset by
        a few px is invisible on stochastic detail; structure cannot pop
        because structure is the plate's.
      replace mode -- the full anchor after shift + grade correction, for
        stills that ARE well aligned (img2img of the plate frame itself).

    Global translation is auto-corrected first (same unwhitened correlation
    as the drift probe), the residual is printed, and the anchor's grade is
    matched to the plate frame. A correction above 8px per 1088 rows of height is refused as a
    false lock (a still taken from its own frame cannot drift that far;
    measured: the correlator chasing a Qwen-redrawn subject reported
    (+11,-30)px on a static camera) -- the splice then runs unshifted with
    a warning. `strength` scales the transplanted fine band (>1 amplifies
    the mandate).

    `spread` gives the anchor REACH (measured: a 1-frame splice is a +-2
    frame blip -- VAE packing averages it with unspliced neighbors, and
    mid-guide detail does not propagate on its own; only the window head
    relays detail forward). The anchor's fine band is carried outward
    BOTH directions for up to `spread` frames: frame-to-frame block flow
    is composed so the texture is warped from the anchor exactly once per
    frame (no resampling pileup), a confidence gate fades it wherever the
    warped structure stops matching the plate (occlusions, new content),
    the share tapers linearly from the anchor frame to zero (r73: the
    old full-strength plateau over +-2 frames ended in a hard cliff --
    measured as a frame-2->3 pop at big hops -- and the packing-dilution
    rationale never applied at frame 0, whose head token is 1 px frame). Each frame
    keeps its own low band throughout -- pop-proof exactly like the
    anchor frame itself. Chain one node per anchor; overlapping spreads
    crossfade. spread=0 is the old single-frame splice."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "frames":    ("IMAGE",),
            "anchor":    ("IMAGE",),
            "frame_idx": ("INT", {"default": 0, "min": 0, "max": 9999}),
            "mode":      (["texture", "replace"],),
            # low/fine split scale in px: structures larger than this come
            # from the plate, finer than this from the anchor
            "split":     ("FLOAT", {"default": 16.0, "min": 4.0,
                                    "max": 64.0, "step": 2.0}),
            "strength":  ("FLOAT", {"default": 1.0, "min": 0.0, "max": 2.0,
                                    "step": 0.05}),
            # frames of flow-warped detail propagation each direction
            "spread":    ("INT", {"default": 4, "min": 0, "max": 120}),
        }}

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "run"
    CATEGORY = "Tessera"

    @staticmethod
    def _lp(x, k):
        """[H,W,C] gaussian-ish low-pass via separable box passes."""
        t = x.permute(2, 0, 1)[None]
        kk = max(3, int(k) | 1)
        p = kk // 2
        for _ in range(3):
            t = torch.nn.functional.avg_pool2d(
                torch.nn.functional.pad(t, (p, p, p, p), mode="replicate"),
                kk, 1)
        return t[0].permute(1, 2, 0)

    @classmethod
    def _block_flow(cls, src, dst):
        """Two-level backward flow dst(x) ~= src(x + u(x)), [H,W] luma ->
        [H,W,2] px. Coarse wide-range match (1/8 res, +-48px) then a
        fine-scale refinement (1/2 res, +-6px) where real texture is
        visible -- a single coarse level leaves ~1px of estimation noise,
        which is enough to decorrelate pixel-scale detail."""
        u1 = cls._bf_level(src, dst, 8, 4, 6)
        src_w = cls._flow_sample(src[None], u1)[0]
        u2 = cls._bf_level(src_w, dst, 2, 8, 3)
        return u2 + cls._flow_sample(
            u1.permute(2, 0, 1).contiguous(), u2).permute(1, 2, 0)

    @staticmethod
    def _bf_level(src, dst, scale, block, rad):
        """One block-matching level: matched at 1/scale res on block x
        block cells over a +-rad cell search, parabolic sub-cell
        refinement, confidence-filled, bilinearly upsampled to [H,W,2]
        full-res pixels."""
        F = torch.nn.functional
        H, W = src.shape
        s = F.avg_pool2d(src[None, None], scale)[0, 0]
        d = F.avg_pool2d(dst[None, None], scale)[0, 0]
        h, w = s.shape
        dev = src.device
        nby, nbx = h // block, w // block
        if nby < 1 or nbx < 1:
            return torch.zeros(H, W, 2, device=dev)
        d_c = d[:nby * block, :nbx * block]
        sp = F.pad(s[None, None], (rad, rad, rad, rad),
                   mode="replicate")[0, 0]
        n = 2 * rad + 1
        cost = torch.empty(n, n, nby, nbx, device=dev)
        for iy in range(n):
            for ix in range(n):
                sh = sp[iy:iy + h, ix:ix + w]
                diff = (d_c - sh[:nby * block, :nbx * block]) ** 2
                cost[iy, ix] = F.avg_pool2d(diff[None, None], block)[0, 0]
        cf = cost.view(n * n, nby, nbx)
        best = cf.argmin(dim=0)
        by, bx = best // n, best % n
        u = (bx - rad).float()
        v = (by - rad).float()
        # parabolic sub-cell refinement where the minimum is interior
        ii = torch.arange(nby, device=dev)[:, None].expand(nby, nbx)
        jj = torch.arange(nbx, device=dev)[None, :].expand(nby, nbx)
        for axis, bb, out in ((1, bx, u), (0, by, v)):
            ok = (bb > 0) & (bb < n - 1)
            if not ok.any():
                continue
            if axis == 1:
                c0 = cost[by.clamp(0, n - 1), (bb - 1).clamp(0), ii, jj]
                c1 = cost[by.clamp(0, n - 1), bb, ii, jj]
                c2 = cost[by.clamp(0, n - 1), (bb + 1).clamp(max=n - 1),
                          ii, jj]
            else:
                c0 = cost[(bb - 1).clamp(0), bx.clamp(0, n - 1), ii, jj]
                c1 = cost[bb, bx.clamp(0, n - 1), ii, jj]
                c2 = cost[(bb + 1).clamp(max=n - 1), bx.clamp(0, n - 1),
                          ii, jj]
            den = c0 - 2.0 * c1 + c2
            off = torch.where(den.abs() > 1e-8,
                              0.5 * (c0 - c2) / den.clamp_min(1e-8),
                              torch.zeros_like(den)).clamp(-0.5, 0.5)
            out += torch.where(ok, off, torch.zeros_like(off))
        # low-texture blocks have a flat cost surface and default to zero
        # motion even inside a moving object. Fill them CONSERVATIVELY:
        # each pass, a block blends toward its 3x3 confidence-weighted
        # neighborhood only in proportion to its own lack of confidence,
        # so edges and texture keep their measured motion and flat areas
        # inherit from the nearest confident neighbors, a ring per pass.
        cmin = cf.min(dim=0).values
        conf = (cf.mean(dim=0) - cmin).clamp_min(0.0)
        conf = conf / (conf.mean() + 1e-8)
        box3 = lambda t: F.avg_pool2d(
            F.pad(t[None, None], (1, 1, 1, 1), mode="replicate"), 3, 1)[0, 0]
        w = conf
        for _ in range(4):
            nw = box3(w)
            fu = box3(u * w) / nw.clamp_min(1e-8)
            fv = box3(v * w) / nw.clamp_min(1e-8)
            t = w / (w + 0.3)
            u = t * u + (1.0 - t) * fu
            v = t * v + (1.0 - t) * fv
            w = torch.maximum(w, 0.5 * nw)
        flow = torch.stack([u, v], dim=0)[None] * scale
        flow = F.interpolate(flow, size=(H, W), mode="bilinear",
                             align_corners=False)
        return flow[0].permute(1, 2, 0)

    @staticmethod
    def _flow_sample(img_chw, flow_hw2):
        """Sample img at x + flow(x): [C,H,W], [H,W,2] -> [C,H,W]."""
        F = torch.nn.functional
        C, H, W = img_chw.shape
        dev = img_chw.device
        yy = torch.arange(H, device=dev).float()[:, None].expand(H, W)
        xx = torch.arange(W, device=dev).float()[None, :].expand(H, W)
        gx = (xx + flow_hw2[..., 0]) / max(W - 1, 1) * 2.0 - 1.0
        gy = (yy + flow_hw2[..., 1]) / max(H - 1, 1) * 2.0 - 1.0
        grid = torch.stack([gx, gy], dim=-1)[None]
        return F.grid_sample(img_chw[None], grid, mode="bilinear",
                             padding_mode="border",
                             align_corners=True)[0]

    def run(self, frames, anchor, frame_idx, mode, split, strength, spread):
        x = frames.float()
        T, H, W, C = x.shape
        if not (0 <= frame_idx < T):
            raise ValueError(f"frame_idx {frame_idx} outside the clip's "
                             f"{T} frames")
        a = anchor.float()[0:1]
        if a.shape[1] != H or a.shape[2] != W:
            a = torch.nn.functional.interpolate(
                a.permute(0, 3, 1, 2), size=(H, W), mode="bilinear",
                align_corners=False).permute(0, 2, 3, 1)
        a = a[0]                                   # [H, W, Ca]
        if a.shape[-1] != C:
            # reconcile channel counts (RGBA anchor vs RGB clip, or mono)
            a = (a[..., :C] if a.shape[-1] > C
                 else a[..., :1].expand(H, W, C)).contiguous()
        plate = x[frame_idx]
        # ---- global shift correction (sub-pixel, via FFT phase ramp) ----
        dx, dy = _px_shift(a[None], plate[None])
        _lim = 8.0 * max(1.0, H / 1088.0)
        if abs(dx) > _lim or abs(dy) > _lim:
            # a still taken from its own frame cannot drift that far: the
            # correlator locked onto redrawn content (measured (+11,-30)px
            # on a static camera). Applying it would smear the whole splice.
            _warn(f"[TesseraAnchor] frame {frame_idx}: shift estimate "
                  f"({dx:+.1f},{dy:+.1f})px exceeds the {_lim:.0f}px "
                  f"sanity limit -- false lock, splicing unshifted "
                  f"(check the still really is from frame {frame_idx})")
            dx = dy = 0.0
        if abs(dx) > 0.25 or abs(dy) > 0.25:
            g = torch.fft.rfft2(a.permute(2, 0, 1))
            fy = torch.fft.fftfreq(H).view(1, -1, 1)
            fx = torch.fft.rfftfreq(W).view(1, 1, -1)
            ramp = torch.exp(-2j * torch.pi * (fx * (-dx) + fy * (-dy)))
            a = torch.fft.irfft2(g * ramp, s=(H, W)).permute(1, 2, 0)
        # ---- grade match (anchor low band -> plate low band) ------------
        lp_p = self._lp(plate, split)
        lp_a = self._lp(a, split)
        fine = (a - lp_a) * strength
        if mode == "replace":
            # full anchor, re-graded: its own structure + matched grade
            out0 = (a + (self._lp(plate, split * 3)
                         - self._lp(a, split * 3))).clamp(0, 1)
        else:
            # plate structure + anchor texture
            out0 = (lp_p + fine).clamp(0, 1)
        res = float((out0 - plate).abs().mean())
        print(f"[TesseraAnchor] frame {frame_idx} ({mode}): shift "
              f"corrected ({dx:+.1f},{dy:+.1f})px, fine-band strength "
              f"{strength:.2f}, residual vs plate {res:.4f}")
        y = x.clone()
        y[frame_idx] = out0
        # ---- flow-composed detail propagation, both directions ----------
        # frame-to-frame block flow is COMPOSED so the anchor's fine band
        # is resampled exactly once per frame (iterative warping would
        # smear the texture); a confidence gate (warped anchor low band vs
        # the frame's own low band) fades the mandate over occlusions and
        # content the anchor never saw.
        if spread > 0:
            # the flow/warp math runs on the GPU when one is idle (this
            # node executes in the preamble, before sampling); the clip
            # itself stays on CPU, frames visit the device one at a time
            dev = (torch.device("cuda") if torch.cuda.is_available()
                   else x.device)
            fineC = fine.permute(2, 0, 1).contiguous().to(dev)  # [C,H,W]
            base_low = self._lp(plate, split * 2.0).mean(dim=-1).to(dev)
            anchor_lum = x[frame_idx].mean(dim=-1).to(dev)
            reach = {1: (0, 1.0), -1: (0, 1.0)}
            for step in (1, -1):
                Fcum = torch.zeros(H, W, 2, device=dev)
                l_prev = anchor_lum
                for d in range(1, spread + 1):
                    f2 = frame_idx + step * d
                    if f2 < 0 or f2 >= T:
                        break
                    pf = x[f2].to(dev)
                    l_cur = pf.mean(dim=-1)
                    # compose: anchor offset at x in f2 = u(x) + Fcum(x+u)
                    u = self._block_flow(l_prev, l_cur)
                    Fcum = u + self._flow_sample(
                        Fcum.permute(2, 0, 1).contiguous(),
                        u).permute(1, 2, 0)
                    # re-anchor: frame-to-frame composition accumulates
                    # drift, so match the warped ANCHOR frame against the
                    # target directly and fold the residual in -- error
                    # stays bounded instead of growing
                    wa = self._flow_sample(anchor_lum[None], Fcum)[0]
                    r = self._block_flow(wa, l_cur)
                    Fcum = r + self._flow_sample(
                        Fcum.permute(2, 0, 1).contiguous(),
                        r).permute(1, 2, 0)
                    # PURE linear taper from the anchor out (r73). The
                    # r68 "packing group at full strength" plateau put
                    # the fine band at weight 1.0 on frames 0-2 and then
                    # cliffed -- measured: adjacent-frame corr 0.96 0.95
                    # 0.25 0.99 on an 8K run, a hard pop at f2->f3. The
                    # plateau's rationale (VAE packing dilution) does not
                    # even apply at frame 0: the head token is the 1-px-
                    # frame token (FRAME_PER_TOKEN[0] = 1). Plateau idea
                    # shelved for mid-clip anchors only (phase 2).
                    wgt = 1.0 - d / float(spread + 1)
                    lp_f = self._lp(pf, split)
                    fw = self._flow_sample(fineC, Fcum).permute(1, 2, 0)
                    low_w = self._flow_sample(base_low[None], Fcum)[0]
                    cur_low = self._lp(pf, split * 2.0).mean(dim=-1)
                    conf = (1.0 - (low_w - cur_low).abs() / 0.12
                            ).clamp(0.0, 1.0)
                    conf = self._lp(conf[..., None], 8.0)[..., 0]
                    m = (wgt * conf)[..., None]
                    y[f2] = (lp_f + m * fw
                             + (1.0 - m) * (pf - lp_f)).clamp(0, 1).cpu()
                    reach[step] = (d, float(conf.mean()))
                    l_prev = l_cur
            print(f"[TesseraAnchor] frame {frame_idx}: detail spread "
                  f"fwd {reach[1][0]}f (edge conf {reach[1][1]:.2f}), "
                  f"back {reach[-1][0]}f (edge conf {reach[-1][1]:.2f})")
        return (y.to(frames.dtype),)


NODE_CLASS_MAPPINGS = {"TesseraPlan": TesseraPlan,
                       "TesseraGrain": TesseraGrain,
                       "TesseraAnchor": TesseraAnchor,
                       "TesseraArgs": TesseraArgs,
                       "TesseraDilate": TesseraDilate,
                       "TesseraDecimate": TesseraDecimate}
NODE_DISPLAY_NAME_MAPPINGS = {
    "TesseraPlan": "Tessera Tile Plan",
    "TesseraGrain": "Tessera Guide Grain",
    "TesseraAnchor": "Tessera Guide Anchor",
    "TesseraArgs": "Tessera Extra Options",
    "TesseraDilate": "Tessera Temporal Dilate",
    "TesseraDecimate": "Tessera Temporal Decimate"}

class TesseraEncode:
    """Streamed source -> plate latent + guide conditioning: upscale and
    VAE-encode a long clip in temporal windows so the full-resolution
    pixel clip NEVER exists in memory.

    At 4x, a 15s clip as a ComfyUI IMAGE is ~36GB float32 PER COPY, and
    the plain graph (ImageScaleBy -> VAEEncode + Guide Anchor ->
    AddGuide) holds three such copies plus two whole-clip VAE encodes --
    OOM regardless of GPU. This node replaces that chain for big
    targets: it takes the SOURCE clip (small; wire the Dilate output),
    upscales each temporal window to the target size, encodes it, keeps
    the latents and drops the pixels. Windows are disjoint on the 17-px
    block grid (the stock H3 VAE encodes 17-frame clips independently,
    so a block encodes identically in any window); each carries the
    5-frame ladder tail, whose 2 tokens the next window re-derives
    exactly. The stitch is bit-identical to a monolithic encode.

    Outputs replace the whole 4K pixel chain: `positive` carries the
    guide as the frame-0 keyframe (replaces MiniMax H3 AddGuide --
    chain FROM this node's positive, do not keep the old AddGuide);
    `latent` is the plate video latent (replaces VAEEncode; wire into
    LTXVConcatAVLatent as before); width/height/frames feed the nodes
    that used to read them off the upscaled clip.

    `anchor` is the frame-0 detailed still. Generate it from a SINGLE-
    frame upscale of the source (GetImageRange -> ImageScaleBy -> Qwen),
    NOT from this node's output -- that would be a graph cycle. It is
    spliced into the guide with the Guide Anchor texture machinery
    (shift-corrected fine-band transplant + flow-warped spread, split
    16) before the window-0 guide encode; the PLATE stays unspliced,
    exactly like the AddGuide-path graph. `segment_frames` trades peak
    memory for encode count (17k+5 frames per window; 56 => ~5.6GB of
    window pixels at 3840x2176 -- lower it if the encode OOMs)."""
    CATEGORY = "Tessera"
    RETURN_TYPES = ("CONDITIONING", "LATENT", "INT", "INT", "INT")
    RETURN_NAMES = ("positive", "latent", "width", "height", "frames")
    FUNCTION = "run"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "images":     ("IMAGE",),
            "vae":        ("VAE",),
            "positive":   ("CONDITIONING",),
            "upscale_by": ("FLOAT", {"default": 4.0, "min": 1.0,
                                     "max": 8.0, "step": 0.25}),
            "upscale_method": (["lanczos", "bicubic", "bilinear",
                                "nearest-exact"],),
            "segment_frames": ("INT", {"default": 56, "min": 39,
                                       "max": 209, "step": 17}),
        }, "optional": {
            "anchor":          ("IMAGE",),
            "anchor_strength": ("FLOAT", {"default": 1.0, "min": 0.0,
                                          "max": 2.0, "step": 0.05}),
            "anchor_spread":   ("INT", {"default": 4, "min": 0,
                                        "max": 120}),
        }}

    @staticmethod
    def _windows(K, m):
        """Window plan for K blocks, up to m blocks per window: returns
        [(start_block, n_blocks)], disjoint on the 17-px block grid.

        r81: the stock H3 VAE encodes a clip as INDEPENDENT 17-frame
        clips (comfy/ldm/minimax/vae.py `encode_temporal`: each clip
        through `_adaptive_encode` on its own, tokens concatenated, the
        last 3 tokens dropped), causal only INSIDE a clip. So block g
        encodes identically whether it is a window's first block or its
        fifth, and the old 22-px warm-up (re-encode head + one block,
        discard) bought nothing: 168 frames encoded to keep 124 on the
        1080p baseline. Each window now encodes its blocks plus the
        5-frame tail the ladder demands (17n+5 -- without it the
        token_drop eats the last block's final 3 tokens); the tail's 2
        tokens are the NEXT block's first two, exact by causality, and
        the next window re-encodes only those 5 frames."""
        m = max(1, min(m, K)) if K > 0 else 1
        starts = list(range(0, max(K, 1), m))
        return [(g, min(m, K - g)) for g in starts]

    def run(self, images, vae, positive, upscale_by, upscale_method,
            segment_frames, anchor=None, anchor_strength=1.0,
            anchor_spread=24):
        import node_helpers
        F, H, W, C = images.shape
        if (F - 5) % 17:
            Fl = max(5, ((F - 5) // 17) * 17 + 5)
            _warn(f"[TesseraEncode] {F} frames is not on the 17k+5 "
                  f"ladder -- trimming to {Fl} (wire the Dilate output, "
                  f"which is ladder-snapped)")
            images = images[:Fl]
            F = Fl
        K = (F - 5) // 17
        Wt = int(round(W * upscale_by))
        Ht = int(round(H * upscale_by))
        if Wt % 16 or Ht % 16:
            _warn(f"[TesseraEncode] target {Wt}x{Ht} is not a "
                  f"multiple of 16 -- the VAE cell grid will pad; "
                  f"prefer an upscale_by landing on x16 dims")
        plan = self._windows(K, max(2, (segment_frames - 5) // 17))
        m = max(n for _, n in plan)
        wpx = 17 * m + 5
        est = wpx * Ht * Wt * 3 * 4 / (1 << 30)
        whole = F * Ht * Wt * 3 * 4 / (1 << 30)
        _enc_px = sum(17 * n + 5 for _, n in plan)
        print(f"[TesseraEncode] streamed encode: {len(plan)} "
              f"window(s) of up to {wpx} px frames at {Wt}x{Ht} "
              f"(~{est:.1f}GB pixels per window; a whole-clip copy would "
              f"be {whole:.1f}GB); {_enc_px} frames encoded for {F} kept")
        T_abs = 2 + 5 * K
        # pixel-evidence stats (r77): fine-band energy per block,
        # measured on the SOURCE pixels -- the only sharp image in the
        # graph. The upscaled plate has no top-octave energy by
        # construction (4x lanczos: soft faces measured 2.7x floor on
        # the plate vs 38-43x for hard frame borders -- the same
        # blindness as the latent, one octave milder); the source is
        # real footage and its fine band IS the evidence the refiner
        # will work from. One block maps to ~128px on the target.
        _sb = max(4, int(round(128.0 / upscale_by)))
        _sp = []
        for _f0 in range(0, F, 16):
            _gr = images[_f0:min(_f0 + 16, F), :, :, :3] \
                .float().mean(-1).unsqueeze(1)
            _e = (_gr[:, :, 1:-1, 1:-1] * 4 - _gr[:, :, :-2, 1:-1]
                  - _gr[:, :, 2:, 1:-1] - _gr[:, :, 1:-1, :-2]
                  - _gr[:, :, 1:-1, 2:]).pow(2)
            _kk = (min(_sb, _e.shape[-2]), min(_sb, _e.shape[-1]))
            _sp.append(torch.nn.functional.avg_pool2d(
                _e, _kk, _kk, ceil_mode=True,
                count_include_pad=False).squeeze(1).cpu())
        flat_stats = torch.cat(_sp, dim=0)             # [F, bh, bw] cpu
        del _sp
        plate_parts, guide_parts = [], []
        # TESSERA_VERIFY_ENCODE=1: also encode the whole clip through the
        # stock path and print max|delta| against the stitch (one-off
        # check of the r81 no-warm-up plan; needs the whole-clip copy in
        # RAM, so only on clips that fit).
        _verify = _os.environ.get("TESSERA_VERIFY_ENCODE", "") == "1"
        _ver_full = None
        if _verify:
            _ver_full = comfy.utils.common_upscale(
                images.movedim(-1, 1), Wt, Ht, upscale_method,
                "disabled").movedim(1, -1)
            _ver_full = vae.encode(_ver_full[:, :, :, :3]).cpu()
        t_start = time.time()
        for i, (g, nb) in enumerate(plan):
            seg = images[17 * g:17 * g + 17 * nb + 5]
            seg = comfy.utils.common_upscale(
                seg.movedim(-1, 1), Wt, Ht, upscale_method,
                "disabled").movedim(1, -1)
            lat = vae.encode(seg[:, :, :, :3])
            glat = lat
            if i == 0 and anchor is not None and anchor_strength > 0.0:
                sp = max(0, min(anchor_spread, seg.shape[0] - 1))
                spliced = TesseraAnchor().run(
                    seg, anchor, 0, "texture", 16.0, anchor_strength,
                    sp)[0]
                glat = vae.encode(spliced[:, :, :, :3])
                del spliced
            del seg
            # window tokens: [5g, 5g + 5nb + 2); the first 2 of an
            # interior window duplicate the previous window's tail
            w_lo = 0 if i == 0 else 2
            plate_parts.append(lat[:, :, w_lo:].clone())
            guide_parts.append(glat[:, :, w_lo:].clone())
            del lat
            if glat is not None:
                del glat
            el = time.time() - t_start
            eta = el / (i + 1) * (len(plan) - i - 1)
            print(f"[TesseraEncode] window {i + 1}/{len(plan)} "
                  f"(blocks {g}-{g + nb - 1}) encoded  ·  "
                  f"eta {int(eta // 60)}m{int(eta % 60):02d}s")
        plate = torch.cat(plate_parts, dim=2)
        guide = torch.cat(guide_parts, dim=2)
        del plate_parts, guide_parts
        if plate.shape[2] != T_abs:
            raise RuntimeError(
                f"[TesseraEncode] stitched {plate.shape[2]} latent "
                f"tokens, expected {T_abs} -- window plan bug, please "
                f"report")
        if _ver_full is not None:
            _d = (plate.cpu().float() - _ver_full.float()).abs()
            _per = _d.amax(dim=(0, 1, 3, 4))
            _bad = [int(_i) for _i in torch.nonzero(_per > 1e-5).flatten()]
            print(f"[TesseraEncode] VERIFY: stitched vs whole-clip stock "
                  f"encode max|delta| {float(_d.max()):.3e} (mean "
                  f"{float(_d.mean()):.3e}); tokens over 1e-5: "
                  f"{_bad if _bad else 'none'}")
            del _ver_full, _d
        keyframes = list(positive[0][1].get("minimax_keyframes", []))
        keyframes.append({"resolved_frame_index": 0, "latent": guide})
        pos = node_helpers.conditioning_set_values(
            positive, {"minimax_keyframes": keyframes,
                       "tessera_flat_stats": {
                           "blocks": flat_stats,
                           "px_x": _sb * Wt / float(W),
                           "px_y": _sb * Ht / float(H)}})
        print(f"[TesseraEncode] done: {T_abs} latent tokens "
              f"({F} px frames) in {int(time.time() - t_start)}s; "
              f"guide wired as frame-0 keyframe + source-pixel "
              f"evidence stats for flat_skip "
              f"({int(flat_stats.shape[1])}x"
              f"{int(flat_stats.shape[2])} blocks)")
        return (pos, {"samples": plate}, Wt, Ht, F)


class TesseraDecode:
    """Decode an H3 video latent through the STREAMED segment decode,
    standalone: the same machinery as the refine's pixel_out (segment
    decode with warm-up discard, fp16 storage and disk-backed buffer
    for big canvases, optional frame_map decimation).

    Built for recovery: when the refine's pixel_out fails (e.g. disk
    full), it saves the refined latent as tessera_rescue_*.latent in the
    output folder -- move that file into ComfyUI/input, wire
    LoadLatent -> this node -> your video save, and the render is
    recovered without resampling. Also works as a general decoder for
    any H3 latent too large for a monolithic VAE Decode. Non-ladder
    latents fall back to the monolithic decode."""
    CATEGORY = "Tessera"
    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "run"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "latent": ("LATENT",),
            "vae":    ("VAE",),
        }, "optional": {
            "frame_map": ("STRING", {"default": "",
                                     "forceInput": True}),
        }}

    def run(self, latent, vae, frame_map=""):
        z = latent["samples"]
        if getattr(z, "is_nested", False):
            z = z.tensors[0]
        out = _decode_stream_video(vae, z, _as_image, frame_map)
        if out is None:
            print("[TesseraDecode] latent is not an H3 ladder shape "
                  "-- monolithic decode")
            out = _as_image(vae.decode(z)).to(device="cpu").float()
        return (out,)


if _SAMPLING_OK:
    NODE_CLASS_MAPPINGS["TesseraRefine"] = TesseraRefine
    NODE_DISPLAY_NAME_MAPPINGS["TesseraRefine"] = "Tessera Refine"
    NODE_CLASS_MAPPINGS["TesseraEncode"] = TesseraEncode
    NODE_DISPLAY_NAME_MAPPINGS["TesseraEncode"] = "Tessera Streamed Encode"
NODE_CLASS_MAPPINGS["TesseraDecode"] = TesseraDecode
NODE_DISPLAY_NAME_MAPPINGS["TesseraDecode"] = "Tessera Streamed Decode"

TESSERA_REV = "r84"
print("[Tessera] %s loaded %d node(s): %s"
      % (TESSERA_REV, len(NODE_CLASS_MAPPINGS),
         ", ".join(sorted(NODE_CLASS_MAPPINGS))))
