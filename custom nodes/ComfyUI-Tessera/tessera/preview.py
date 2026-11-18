"""
Tile-plan diagram.

The plan table is correct but hard to hold in your head -- especially the
clamped last row and column, whose masks are a different size and offset from
every other tile. A picture makes an off-by-one-cell mistake obvious in a
glance instead of requiring you to read 25 rows of numbers.

What's drawn is the *generated* (mask) region of each tile, not the tile
footprint. Mask regions partition the frame exactly -- no gaps, no overlap --
so they tile cleanly and any error shows up immediately as a seam or a
collision. One tile's full footprint is drawn dashed on top to show the
context border that the footprints all carry but that would be unreadable
if drawn 25 times.
"""

from PIL import Image, ImageDraw, ImageFont


# dark surface + two categorical slots, validated all-pairs for the dark
# surface (worst CVD dE 26.8, normal-vision 31.8, both >= 3:1 contrast).
SURFACE = (26, 26, 25)
PANEL = (33, 34, 38)
INK = (255, 255, 255)
INK_2 = (195, 194, 183)
INK_3 = (125, 134, 148)
STANDARD = (57, 135, 229)      # slot 1, blue  -- uniform-size masks
CLAMPED = (217, 89, 38)        # slot 2, orange -- clamped row/column
GAP = 2                        # surface gap between fills, per mark spec


def _font(size, bold=False):
    names = (["DejaVuSans-Bold.ttf", "arialbd.ttf", "Arial Bold.ttf"] if bold
             else ["DejaVuSans.ttf", "arial.ttf", "Arial.ttf"])
    for n in names:
        try:
            return ImageFont.truetype(n, size)
        except Exception:
            continue
    return ImageFont.load_default()


def _text(d, xy, s, font, fill, anchor="la"):
    d.text(xy, s, font=font, fill=fill, anchor=anchor)


def first_frame_to_pil(image_tensor):
    """
    ComfyUI IMAGE tensor -> PIL RGB of the FIRST frame.

    IMAGE is [B,H,W,C] with video frames stacked in the batch dim (a raw video
    decode may arrive 5D [B,T,H,W,C]); either way the first frame is the one
    drawn under the plan.
    """
    import numpy as np
    t = image_tensor
    if t.ndim == 5:
        t = t[0]
    frame = t[0]
    a = (frame.clamp(0, 1) * 255.0).to("cpu").numpy().astype(np.uint8)
    if a.shape[-1] == 1:
        a = a.repeat(3, axis=-1)
    return Image.fromarray(a[..., :3], "RGB")


def render_plan(plan, width_px=1500, coverage=None, background=None):
    """PIL image of the tile plan. Returns RGB.

    `background`: optional PIL image drawn under the tile overlay (stretched to
    the plot rect, dimmed so the overlay stays legible) -- lets you see exactly
    which content lands in which tile before spending sampling time.
    """
    LW, LH = plan["latent_size"]
    TWc, THc = plan["tile_cells"]
    cell = plan["cell"]

    pad_l, pad_t, pad_r = 58, 108, 58
    pad_b = 92
    plot_w = width_px - pad_l - pad_r
    scale = plot_w / LW
    plot_h = int(round(LH * scale))
    H = pad_t + plot_h + pad_b
    img = Image.new("RGB", (width_px, H), SURFACE)
    d = ImageDraw.Draw(img, "RGBA")

    f_title = _font(21, bold=True)
    f_sub = _font(13)
    f_small = _font(12)
    f_idx = _font(int(max(13, min(30, scale * 5))), bold=True)
    f_dim = _font(int(max(10, min(15, scale * 2.4))))

    def sx(c):
        return pad_l + c * scale

    def sy(c):
        return pad_t + c * scale

    # --- title ------------------------------------------------------------
    _text(d, (pad_l, 26), "Tile plan", f_title, INK)
    gw, gh = plan["grid"]
    sub = (f"{LW * cell} x {LH * cell} px   ·   "
           f"tile {TWc * cell} x {THc * cell}   ·   "
           f"border {plan['border_cells'] * cell} px   ·   "
           f"stride {plan['stride_cells'][0] * cell} x {plan['stride_cells'][1] * cell}   ·   "
           f"{gw} x {gh} = {plan['count']} tiles ({plan['order']}, "
           f"{plan.get('placement', 'flush')} layout)")
    _text(d, (pad_l, 55), sub, f_sub, INK_2)

    # --- frame ------------------------------------------------------------
    d.rectangle([pad_l, pad_t, pad_l + plot_w, pad_t + plot_h], fill=PANEL)
    fill_a = 58
    if background is not None:
        bg = background.convert("RGB").resize(
            (int(plot_w), int(plot_h)), Image.LANCZOS)
        # dim toward the surface so index labels and outlines stay readable
        bg = Image.blend(bg, Image.new("RGB", bg.size, SURFACE), 0.30)
        img.paste(bg, (pad_l, pad_t))
        fill_a = 22   # let the content show through the tile fills

    sizes = {}
    for t in plan["tiles"]:
        if not t["clamped"]:
            k = (t["mx1"] - t["mx0"], t["my1"] - t["my0"])
            sizes[k] = sizes.get(k, 0) + 1
    modal = max(sizes, key=sizes.get) if sizes else (TWc, THc)

    # Hero rect in screen coords, if present. Grid tiles whose mask region
    # overlaps it get the hero's footprint CUT OUT of their drawn fill --
    # that is what their generation mask actually looks like at refine time
    # (the hero runs first; its region is frozen context inside those tiles,
    # never repainted). Drawing whole rectangles here made the plan look
    # like double coverage when it isn't.
    hero_scr = None
    if plan.get("hero_rect_px"):
        hx0, hy0, hx1, hy1 = plan["hero_rect_px"]
        hero_scr = (pad_l + hx0 / (LW * cell) * plot_w,
                    pad_t + hy0 / (LH * cell) * plot_h,
                    pad_l + hx1 / (LW * cell) * plot_w,
                    pad_t + hy1 / (LH * cell) * plot_h)

    swallowed_ids = set()
    for t in plan["tiles"]:
        mw, mh = t["mx1"] - t["mx0"], t["my1"] - t["my0"]
        col = CLAMPED if t["clamped"] else STANDARD

        x0, y0 = sx(t["x"] + t["mx0"]), sy(t["y"] + t["my0"])
        x1, y1 = sx(t["x"] + t["mx1"]), sy(t["y"] + t["my1"])

        holed = (hero_scr is not None
                 and x0 < hero_scr[2] and x1 > hero_scr[0]
                 and y0 < hero_scr[3] and y1 > hero_scr[1]
                 and not t.get("hero_tile"))
        swallowed = (holed and hero_scr[0] <= x0 and hero_scr[1] <= y0
                     and hero_scr[2] >= x1 and hero_scr[3] >= y1)
        if swallowed:
            # the refine node drops this tile entirely (its whole generated
            # region is the hero's) -- show that instead of a live tile
            swallowed_ids.add(t["index"])
            cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
            _text(d, (cx, cy - 8), str(t["index"]), f_idx, INK_3, anchor="mm")
            _text(d, (cx, cy + 13), "inside hero — skipped",
                  f_dim, INK_3, anchor="mm")
            continue
        if holed:
            # draw on a scratch layer, erase the hero footprint, composite
            layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
            ld = ImageDraw.Draw(layer)          # direct-write mode: rects replace
            ld.rectangle([x0 + GAP, y0 + GAP, x1 - GAP, y1 - GAP],
                         fill=col + (fill_a,), outline=col + (235,), width=2)
            ld.rectangle(hero_scr, fill=(0, 0, 0, 0))
            img.paste(Image.alpha_composite(img.convert("RGBA"), layer)
                      .convert("RGB"), (0, 0))
        else:
            d.rectangle([x0 + GAP, y0 + GAP, x1 - GAP, y1 - GAP],
                        fill=col + (fill_a,), outline=col + (235,), width=2)

        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        _text(d, (cx, cy - 8), str(t["index"]), f_idx, INK, anchor="mm")
        dim_s = f"{mw * cell}x{mh * cell}"
        if holed:
            dim_s += "  (hero cut out)"
        _text(d, (cx, cy + 13), dim_s, f_dim, INK_2, anchor="mm")

    # --- one footprint with its context ring shaded --------------------
    # prefer a fully interior tile -- one with a context ring on all four
    # sides. An edge tile has no border on its outer sides, so its ring is
    # asymmetric and illustrates the concept poorly.
    def _hero_overlap(t):
        if hero_scr is None:
            return 0.0
        fx0, fy0 = sx(t["x"]), sy(t["y"])
        fx1, fy1 = sx(t["x"] + t["w"]), sy(t["y"] + t["h"])
        ow = max(0.0, min(fx1, hero_scr[2]) - max(fx0, hero_scr[0]))
        oh = max(0.0, min(fy1, hero_scr[3]) - max(fy0, hero_scr[1]))
        return ow * oh

    def _pick(pred):
        cands = [t for t in plan["tiles"]
                 if t["index"] not in swallowed_ids and pred(t)]
        return min(cands, key=_hero_overlap) if cands else None

    ref = (_pick(lambda t: not t["clamped"] and t["mx0"] > 0 and t["my0"] > 0
                 and t["mx1"] < t["w"] and t["my1"] < t["h"])
           or _pick(lambda t: not t["clamped"])
           or _pick(lambda t: True)
           or plan["tiles"][0])

    fx0, fy0 = sx(ref["x"]), sy(ref["y"])
    fx1, fy1 = sx(ref["x"] + ref["w"]), sy(ref["y"] + ref["h"])
    mx0, my0 = sx(ref["x"] + ref["mx0"]), sy(ref["y"] + ref["my0"])
    mx1, my1 = sx(ref["x"] + ref["mx1"]), sy(ref["y"] + ref["my1"])
    ring = Image.new("RGBA", img.size, (0, 0, 0, 0))
    rd = ImageDraw.Draw(ring)
    rd.rectangle([fx0, fy0, fx1, fy1], fill=INK_2 + (105,))
    rd.rectangle([mx0, my0, mx1, my1], fill=(0, 0, 0, 0))
    img.alpha_composite(ring) if img.mode == "RGBA" else img.paste(
        Image.alpha_composite(img.convert("RGBA"), ring).convert("RGB"), (0, 0))
    d.rectangle([fx0, fy0, fx1, fy1], outline=INK + (255,), width=2)
    cap = (f"tile {ref['index']} footprint {ref['w'] * cell}x{ref['h'] * cell} — "
           f"shaded ring ({plan['border_cells'] * cell}px) is context, held out of denoising")
    cw = d.textlength(cap, font=f_small)
    d.rounded_rectangle([fx0 - 4, fy0 - 24, fx0 + cw + 10, fy0 - 5],
                        radius=4, fill=SURFACE + (232,))
    _text(d, (fx0 + 3, fy0 - 21), cap, f_small, INK)

    # --- hero rect --------------------------------------------------------
    if plan.get("hero_rect_px"):
        hx0, hy0, hx1, hy1 = plan["hero_rect_px"]
        HERO = (27, 175, 122)
        rx0 = pad_l + hx0 / (LW * cell) * plot_w
        ry0 = pad_t + hy0 / (LH * cell) * plot_h
        rx1 = pad_l + hx1 / (LW * cell) * plot_w
        ry1 = pad_t + hy1 / (LH * cell) * plot_h
        d.rectangle([rx0, ry0, rx1, ry1], fill=HERO + (34,),
                    outline=HERO + (255,), width=4)
        cap = (f"HERO {hx1 - hx0}x{hy1 - hy0}px — runs first, no border; "
               f"grid tiles are FROZEN here (never regenerated)")
        cw2 = d.textlength(cap, font=f_small)
        d.rounded_rectangle([rx0, ry1 + 4, rx0 + cw2 + 12, ry1 + 24],
                            radius=4, fill=SURFACE + (232,))
        _text(d, (rx0 + 6, ry1 + 7), cap, f_small, HERO)

    # --- anchor marker ----------------------------------------------------
    if plan.get("anchor"):
        axp, ayp = plan["anchor"]
        ax = pad_l + (axp / (LW * cell)) * plot_w
        ay = pad_t + (ayp / (LH * cell)) * plot_h
        r = 11
        d.ellipse([ax - r, ay - r, ax + r, ay + r],
                  outline=(27, 175, 122, 255), width=3)
        d.line([ax - r * 2, ay, ax + r * 2, ay], fill=(27, 175, 122, 255), width=2)
        d.line([ax, ay - r * 2, ax, ay + r * 2], fill=(27, 175, 122, 255), width=2)

    # --- legend (>=2 categories, so always present) -----------------------
    ly = pad_t + plot_h + 22
    lx = pad_l
    for col, label in ((STANDARD, f"uniform mask  {modal[0] * cell}x{modal[1] * cell} px"),
                       (CLAMPED, "clamped to frame edge — wider border, narrower mask")):
        d.rectangle([lx, ly + 2, lx + 13, ly + 15], fill=col + (58,),
                    outline=col + (235,), width=2)
        _text(d, (lx + 21, ly + 1), label, f_small, INK_2)
        lx += 20 + int(d.textlength(label, font=f_small)) + 42

    _text(d, (pad_l, ly + 26),
          "Mask regions partition the frame exactly — every cell generated once, "
          "no gaps, no double-generation. Numbers are processing order.",
          f_small, INK_3)

    if coverage is not None:
        ok = coverage["ok"]
        badge = (f"coverage OK · {coverage['total']} cells" if ok else
                 f"COVERAGE BROKEN · {coverage['never']} never generated, "
                 f"{coverage['twice_or_more']} generated twice")
        bw = d.textlength(badge, font=f_small)
        bx = width_px - pad_r - bw - 20
        col = (27, 175, 122) if ok else (227, 73, 72)
        d.rounded_rectangle([bx, ly, bx + bw + 18, ly + 19], radius=9,
                            fill=col + (46,), outline=col + (235,), width=2)
        _text(d, (bx + 9, ly + 3), badge, f_small, INK)
    return img


def render_error(message, width_px=1500):
    """Error card, so a bad config shows up in the preview instead of silence."""
    img = Image.new("RGB", (width_px, 190), SURFACE)
    d = ImageDraw.Draw(img, "RGBA")
    f_t, f_b = _font(21, bold=True), _font(14)
    d.rounded_rectangle([40, 34, width_px - 40, 156], radius=8,
                        fill=(227, 73, 72, 34), outline=(227, 73, 72, 235), width=2)
    _text(d, (62, 58), "Geometry error", f_t, INK)
    words, line, lines = message.split(), "", []
    for w in words:
        t = (line + " " + w).strip()
        if d.textlength(t, font=f_b) > width_px - 140:
            lines.append(line); line = w
        else:
            line = t
    lines.append(line)
    for i, ln in enumerate(lines[:3]):
        _text(d, (62, 92 + i * 21), ln, f_b, INK_2)
    return img


def to_comfy_image(img):
    """PIL RGB -> ComfyUI IMAGE tensor [1, H, W, 3] float32 0..1."""
    import numpy as np
    import torch
    a = np.asarray(img.convert("RGB"), dtype=np.float32) / 255.0
    return torch.from_numpy(a).unsqueeze(0)
