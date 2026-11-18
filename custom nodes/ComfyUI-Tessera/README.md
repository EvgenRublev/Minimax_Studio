# Tessera

Production video upscaling for ComfyUI, built on MiniMax H3. Load a
clip, set a scale factor, press run: Tessera refines it tile-by-tile
and chunk-by-chunk into clean 2K/4K/8K — on a single consumer GPU, at
any clip length. Streamed VAE encode/decode means the full-resolution
pixel clip never exists in memory.

## Install

```
cd ComfyUI/custom_nodes
git clone https://github.com/hashu786/ComfyUI-Tessera
```

No extra dependencies. The startup console prints
`[Tessera] loaded 9 node(s): ...` when everything registered.

## Quick start

Open `example_workflows/tessera_upscaler.json`, point LoadVideo at
your clip, set the upscale factor, press run. The defaults are the
validated recipe — they work out of the box.

Models (all local open weights):

| model | role |
|---|---|
| [MiniMax H3 ref2va](https://comfy.org/minimax-h3/) + video/audio VAEs + Qwen3-VL text encoder | core video model |
| [LMS detail LoRA (Alissonerdx)](https://huggingface.co/Alissonerdx/Minimax-H3-ComfyUI) | sharpness/detail enhancement — part of the house recipe |
| Qwen Image 2.1 (optional) | first-frame detail anchor still |
| SAM3 (optional) | hero-subject mask |

## The nodes

| node | what it does |
|---|---|
| **Tessera Streamed Encode** | source → upscaled plate latent + guide conditioning, in temporal windows; replaces the whole upscale/encode chain that OOMs at 4x |
| **Tessera Refine** | the tiled refiner: per-tile conditioning, temporal chunking, hero tiles, anti-hallucination tile skip, crash-insured output |
| **Tessera Streamed Decode** | standalone streamed decoder; also the recovery path for rescued latents |
| **Tessera Tile Plan** | dry run: tile grid, chunk layout, cost — before you spend GPU time |
| **Tessera Guide Anchor** | splices a detailed still into the guide's fine band (shift-corrected, flow-propagated) |
| **Tessera Temporal Dilate / Decimate** | per-span frame-rate dilation for fast action, exact re-timing on the way out |
| **Tessera Guide Grain** | matched grain for the guide |
| **Tessera Extra Options** | the expert knobs, with validated defaults |

## The settings that matter

- `spatial_tile` / `temporal_tile`: pick `high_vram` or `low_vram` —
  tiles and windows scale together to fit the budget, including under
  dilation.
- `flat_skip` (default 4.0): featureless tiles (sky, smoke, seamless
  backdrops) keep the plate instead of being sampled — the model
  cannot hallucinate into them, and you get the steps back. Needs the
  positive chain to come from Streamed Encode; set 0 to disable.
- First-frame anchor: feed a detailed still at 2x for real detail
  relay; at 4x and above leave the anchor unplugged and let the model
  render. When anchoring, set `motion_release_floor` to 0.3.
- `composite` (Extra Options): `pixel` decodes every tile and
  crossfades in pixel space (+0.9% fine detail); `latent` pastes in
  latent space and decodes once (+1.7% temporal stability, ~7% faster
  at 1080p, 10%+ at 4K). Quality workflow: pixel. Speed workflow:
  latent. Chunked (long) runs always use latent.
- If the final decode ever fails (disk full), the refined latent is
  saved as `tessera_rescue_*.latent` — LoadLatent → Tessera Streamed
  Decode recovers the render without resampling.

## Why the defaults are what they are

Every default was measured on real renders, and the failures are
documented next to the fixes: the group-phase law (why chunk windows
snap to H3's token timing), the content-time budget (why windows scale
with dilation), the splice-scale and relay-release laws (when anchors
help and when they hurt), the flat-tile law (why empty tiles
hallucinate), and the streamed encode/decode validation. The full
engineering notes live in [docs/LAWS.md](docs/LAWS.md).

## Credits

- [MiniMaxAI](https://comfy.org/minimax-h3/) — the H3 model;
  Comfy-Org — the ComfyUI-ready weights.
- [Alissonerdx](https://huggingface.co/Alissonerdx/Minimax-H3-ComfyUI)
  — the LMS detail-enhancement LoRA used in the house recipe.
- Qwen (Alibaba) — Qwen3-VL and Qwen Image 2.1. Meta — SAM3.

## License

MIT — see [LICENSE](LICENSE).
