#!/usr/bin/env node
/**
 * (правка 1080) scripts/make-core-patches-033.mjs — пересобирает набор патчей
 * ядра под ОТКАТНУю ветку: ComfyUI 0.33.x + comfy-aimdo 0.4.13.
 *
 * Зачем: студия поддерживает два поколения бэкенда. Для 0.44+ набор лежит в
 * install/comfy-patches, для 0.33.x — в install/comfy-patches-0.33, и
 * syncCorePatches() выбирает набор по версии ядра. Чтобы второй набор не
 * заводился руками (класс ошибок правок 866/901: апдейтер ComfyUI не трогает),
 * он генерируется из трёх источников:
 *   • распакованный исходник официального релиза 0.33.0 (main.py, model_prefetch.py);
 *   • текущее ядро студии (comfy/audio.py — в 0.33 такого модуля нет);
 *   • набор 0.44 (comfy_extras/nodes_minimax_h3.py, nodes_context_windows.py,
 *     utils/extra_config.py — списки путей YAML, которых 0.33 не понимает).
 *
 * Использование:
 *   node scripts/make-core-patches-033.mjs --v33 <папка с исходником 0.33.0>
 * Папку берём из https://github.com/comfyanonymous/ComfyUI/archive/refs/tags/v0.33.0.zip
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const argv = process.argv.slice(2)
const flag = (name, dflt) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}
const V33 = flag('v33', 'E:/StudioTest/dl/ComfyUI-0.33.0')
const DST = join(ROOT, 'install', 'comfy-patches-0.33')

if (!existsSync(join(V33, 'main.py'))) {
  console.error(`[patches-033] нет исходника 0.33.0: ${V33}\n` +
    '  скачайте https://github.com/comfyanonymous/ComfyUI/archive/refs/tags/v0.33.0.zip и распакуйте,' +
    ' затем: node scripts/make-core-patches-033.mjs --v33 <папка>')
  process.exit(1)
}

const ANCHOR = '    simple_vram_headroom = None if args.reserve_vram is None else int(args.reserve_vram * 1024 ** 3)'
const BLOCK = [
  '    # (правка 967) --vram-headroom в ядре только парсился и нигде не применялся:',
  '    # DynamicVRAM (comfy-aimdo) получал лишь reserve_vram. Теперь запас',
  '    # складывается с резервом — ползунок «Запас свободной VRAM» реально держит',
  '    # эту память свободной (с учётом чужих приложений по NVML).',
  '    _reserve_gb = args.reserve_vram or 0',
  '    _headroom_gb = getattr(args, "vram_headroom", 0) or 0',
  '    _keep_free_gb = _reserve_gb + _headroom_gb',
  '    simple_vram_headroom = int(_keep_free_gb * 1024 ** 3) if _keep_free_gb > 0 else None',
].join('\n')

const SHIM = `
# (правка 1080) shim: в этом ядре нет malloc-graph (comfy-aimdo без модуля
# comfy_aimdo.malloc_graph), а наши патч-ноды H3 вызывают pause_malloc_graph как
# контекст-менеджер. Здесь он обязан ничего не делать.
import contextlib as _contextlib


@_contextlib.contextmanager
def pause_malloc_graph(sync=False):
    yield
`

const mkdir = (p) => mkdirSync(p, { recursive: true })
function replaceOnce(src, old, neu, what) {
  const i = src.indexOf(old)
  if (i < 0) {
    console.error(`[patches-033] в 0.33 не найден фрагмент: ${what}`)
    process.exit(1)
  }
  return src.slice(0, i) + neu + src.slice(i + old.length)
}
mkdir(DST)

// 1) main.py: 0.33 + тот же патч 967, что и для 0.44
{
  const src = readFileSync(join(V33, 'main.py'), 'utf8')
  const i = src.indexOf(ANCHOR)
  if (i < 0) {
    console.error('[patches-033] в main.py 0.33 не найдена строка simple_vram_headroom — набор не собран')
    process.exit(1)
  }
  writeFileSync(join(DST, 'main.py'), src.slice(0, i) + BLOCK + src.slice(i + ANCHOR.length), 'utf8')
  console.log('[patches-033] main.py: патч 967 наложен на 0.33')
}

// 2) comfy/model_prefetch.py: 0.33 + shim pause_malloc_graph
{
  const src = readFileSync(join(V33, 'comfy', 'model_prefetch.py'), 'utf8')
  if (src.includes('def pause_malloc_graph')) {
    console.error('[patches-033] pause_malloc_graph уже есть в 0.33 — shim не нужен, проверьте версию')
    process.exit(1)
  }
  mkdir(join(DST, 'comfy'))
  writeFileSync(join(DST, 'comfy', 'model_prefetch.py'), src.replace(/\n+$/, '') + '\n' + SHIM, 'utf8')
  console.log('[patches-033] comfy/model_prefetch.py: добавлен shim pause_malloc_graph')
}

// 3) comfy/audio.py — в 0.33 модуля нет, берём из текущего ядра
copyFileSync(join(ROOT, 'ComfyUI', 'comfy', 'audio.py'), join(DST, 'comfy', 'audio.py'))
console.log('[patches-033] comfy/audio.py: скопирован из ядра 0.44')

// 4) comfy_extras — те же файлы, что и для 0.44 (импорт на 0.33 проверен)
mkdir(join(DST, 'comfy_extras'))
for (const f of ['nodes_minimax_h3.py', 'nodes_context_windows.py']) {
  copyFileSync(join(ROOT, 'install', 'comfy-patches', 'comfy_extras', f), join(DST, 'comfy_extras', f))
  console.log(`[patches-033] comfy_extras/${f}: как в наборе 0.44`)
}

// 5) utils/extra_config.py — студия пишет пути списками YAML, а штатный
// загрузчик 0.33 умеет только строки (`conf[x].split`). Файл из набора 0.44
// понимает и строки, и списки — без него ComfyUI 0.33 падает на старте
// (AttributeError: 'list' object has no attribute 'split').
mkdir(join(DST, 'utils'))
copyFileSync(join(ROOT, 'install', 'comfy-patches', 'utils', 'extra_config.py'), join(DST, 'utils', 'extra_config.py'))
console.log('[patches-033] utils/extra_config.py: списки путей из набора 0.44')

// 6) comfy/model_base.py — 0.33 + фильтр keyframe-латентов как в 0.44:
// аудио-гайд в Refine — keyframe без видео-латента, и старый код падал
// KeyError: 'latent'. Заодно keyframe-аудио попадает в cond_audio_latents.
{
  const old = `        keyframes = kwargs.get("minimax_keyframes", None)
        if keyframes is not None:
            payload["keyframes"] = keyframes
            payload["frame_count"] = kwargs.get("minimax_frame_count", None)
            payload["cond_video_latents"] = [kf["latent"] for kf in keyframes]
        refs = kwargs.get("minimax_refs", None)
        if refs is not None:
            payload["refs"] = refs
            payload["cond_video_latents"] = [r["latent"] for r in refs if "latent" in r]
            payload["cond_audio_latents"] = [r["audio_latent"] for r in refs if r.get("audio_latent") is not None]`
  const neu = `        keyframes = kwargs.get("minimax_keyframes", None)
        refs = kwargs.get("minimax_refs", None)
        if keyframes is not None:
            payload["keyframes"] = keyframes
            payload["frame_count"] = kwargs.get("minimax_frame_count", None)
        if refs is not None:
            payload["refs"] = refs
        # (правка 1087) keyframe может быть только аудио-гайдом (без latent):
        # в 0.44 такие кадры отфильтрованы, в 0.33 падало KeyError: 'latent'.
        keyframes = keyframes or []
        refs = refs or []
        payload["cond_video_latents"] = (
            [kf["latent"] for kf in keyframes if kf.get("latent") is not None]
            + [r["latent"] for r in refs if "latent" in r]
        )
        payload["cond_audio_latents"] = (
            [kf["audio_latent"] for kf in keyframes if kf.get("audio_latent") is not None]
            + [r["audio_latent"] for r in refs if r.get("audio_latent") is not None]
        )`
  const src = readFileSync(join(V33, 'comfy', 'model_base.py'), 'utf8')
  mkdir(join(DST, 'comfy'))
  writeFileSync(join(DST, 'comfy', 'model_base.py'), replaceOnce(src, old, neu, 'cond_video_latents keyframes'), 'utf8')
  console.log('[patches-033] comfy/model_base.py: keyframe без видео-латента (как в 0.44)')
}

// 7) comfy/ldm/minimax/model.py — keyframe может содержать только аудио-гайд:
// PackedLayout добавляет cond_audio-строки, forward знает их таймстеп/тег.
{
  const oldKf = `        if keyframes:
            # fl2va: keyframe cond rows right after text, sharing the target spatial grid
            for kf in keyframes:
                pixel_index = kf["resolved_frame_index"]
                if pixel_index == 0:
                    cond_t = float(text_len)
                elif frame_count is not None and pixel_index == frame_count - 1:
                    cond_t = float(text_len) + sum(_video_t_spans(latent_t)) - FRAME_RESCALE
                else:
                    raise ValueError("only first/last keyframe anchors are supported")
                g = torch.empty(frame_rows, 3, dtype=torch.float64)
                g[:, 0] = cond_t
                g[:, 1:] = frame
                segments.append(("cond", frame_rows))
                pos.append(g)
                img_pos.append(torch.arange(row, row + frame_rows))
                img_update.append(torch.zeros(frame_rows, dtype=torch.bool))
                row += frame_rows

        target_audio_w = (float(w_grid[0]), float(w_grid[-1]))`
  const newKf = `        target_audio_w = (float(w_grid[0]), float(w_grid[-1]))
        if keyframes:
            # keyframe cond rows right after text, sharing the target spatial grid.
            # (правка 1087) keyframe может быть только аудио-гайдом (без latent):
            # тогда видео-строк нет, а аудио-строки идут отдельным cond_audio.
            for kf in keyframes:
                cond_t = cursor + FRAME_RESCALE * kf["resolved_frame_index"]
                video_latent = kf.get("latent")
                if video_latent is not None:
                    vt = video_latent.shape[2]
                    n = vt * frame_rows
                    segments.append(("cond", n))
                    pos.append(_video_grid(vt, frame, cond_t))
                    img_pos.append(torch.arange(row, row + n))
                    img_update.append(torch.zeros(n, dtype=torch.bool))
                    row += n
                audio_latent = kf.get("audio_latent")
                if audio_latent is not None:
                    rt = audio_latent.shape[-1]
                    segments.append(("cond_audio", rt * 2))
                    pos.append(_audio_grid(cond_t, rt, *target_audio_w))
                    audio_pos.append(torch.arange(row, row + rt * 2))
                    audio_update.append(torch.zeros(rt * 2, dtype=torch.bool))
                    row += rt * 2`
  const oldTags = `        has_aud_cond = any(k == "ref_audio" for _, _, k in layout.segments)
        seg_t = {"text": t_v, "video": t_v, "audio": t_a,
                 "cond": max(t_v, vis_aug), "ref_img": max(t_v, vis_aug),
                 "ref_audio": max(t_a, aud_aug)}
        unique_t = sorted({t_v, t_a} | ({seg_t["cond"]} if has_vis_cond else set())
                          | ({seg_t["ref_audio"]} if has_aud_cond else set()))
        t_row = {t: i for i, t in enumerate(unique_t)}
        seg_tag = {"text": 1, "video": 0, "audio": 2, "cond": 0, "ref_img": 0, "ref_audio": 2}`
  const newTags = `        has_aud_cond = any(k in ("ref_audio", "cond_audio") for _, _, k in layout.segments)
        seg_t = {"text": t_v, "video": t_v, "audio": t_a,
                 "cond": max(t_v, vis_aug), "ref_img": max(t_v, vis_aug),
                 "ref_audio": max(t_a, aud_aug), "cond_audio": max(t_a, aud_aug)}
        unique_t = sorted({t_v, t_a} | ({seg_t["cond"]} if has_vis_cond else set())
                          | ({seg_t["cond_audio"]} if has_aud_cond else set()))
        t_row = {t: i for i, t in enumerate(unique_t)}
        seg_tag = {"text": 1, "video": 0, "audio": 2, "cond": 0, "ref_img": 0,
                   "ref_audio": 2, "cond_audio": 2}`
  let src = readFileSync(join(V33, 'comfy', 'ldm', 'minimax', 'model.py'), 'utf8')
  src = replaceOnce(src, oldKf, newKf, 'PackedLayout keyframes')
  src = replaceOnce(src, oldTags, newTags, 'PackedLayout cond_audio tags')
  mkdir(join(DST, 'comfy', 'ldm', 'minimax'))
  writeFileSync(join(DST, 'comfy', 'ldm', 'minimax', 'model.py'), src, 'utf8')
  console.log('[patches-033] comfy/ldm/minimax/model.py: cond_audio для аудио-keyframe')
}


// 8) comfy/model_base.py — keyframe-гиды внутри context windows.
// В 0.44 MiniMaxH3 сам режет гайды по окну и переносит их во времени. В 0.33
// этих методов нет, а ключевое для продления — _window_payload: без него
// якорь головы остаётся на абсолютной позиции в КАЖДОМ окне, и первые кадры
// клипа «пересвечиваются», пока модель не подстроит свет (баг на откатном ядре).
// Методы перенесены из ядра 0.44; API окон (Window.total_frames,
// get_window_for_modality, causal_anchor_index) в 0.33 совпадает.
{
  const p = join(DST, 'comfy', 'model_base.py')
  let src = readFileSync(p, 'utf8')
  const methods = `    @staticmethod
    def _cond_latents(keyframes, refs):
        # condition latents in packed-layout order: keyframes, then references
        keyframes, refs = keyframes or [], refs or []
        return {"cond_video_latents": [kf["latent"] for kf in keyframes if kf.get("latent") is not None] + [r["latent"] for r in refs if "latent" in r],
                "cond_audio_latents": [kf["audio_latent"] for kf in keyframes if kf.get("audio_latent") is not None] + [r["audio_latent"] for r in refs if r.get("audio_latent") is not None]}

    def context_window_modality_dims(self, latent_shapes, dim):
        # audio is [B, C, 2, T], time on the last axis
        return [dim] + [len(s) - 1 for s in latent_shapes[1:]]

    @staticmethod
    def _latent_pixel_starts(latent_t):
        # pixel frame each video latent starts at, plus the end of the last one
        starts = [0]
        for k in range(latent_t):
            starts.append(starts[-1] + comfy.ldm.minimax.model.FRAME_PER_TOKEN[k % 5])
        return starts

    def map_context_window_to_modalities(self, primary_indices, latent_shapes, dim):
        # the streams share one time axis: split the audio at the video latents' pixel frame boundaries
        starts = self._latent_pixel_starts(latent_shapes[0][dim])
        edges = [round(s * latent_shapes[1][-1] / starts[-1]) for s in starts]
        return [primary_indices, [a for k in primary_indices for a in range(edges[k], edges[k + 1])]]

    def _window_payload(self, payload, window):
        # keyframes anchor the full video's timeline: keep the part of each guide
        # inside the window, cropped and re-anchored to it
        starts = self._latent_pixel_starts(window.total_frames)
        first, last = window.index_list[0], window.index_list[-1]
        origin = starts[first]
        if getattr(window, "causal_anchor_index", None) is not None:
            origin -= comfy.ldm.minimax.model.FRAME_PER_TOKEN[0]
        audio_window = window.get_window_for_modality(1)
        a0, a1 = audio_window.index_list[0], audio_window.index_list[-1] + 1
        rescale = comfy.ldm.minimax.model.FRAME_RESCALE
        keyframes = []
        for kf in payload.get("keyframes") or []:
            f = kf["resolved_frame_index"]
            latent = kf.get("latent")
            if latent is not None:
                vt = latent.shape[2]
                guide_starts = self._latent_pixel_starts(vt)
                chunks = [g for g in range(0, vt, 5)
                          if f + guide_starts[g] < starts[last + 1] and f + guide_starts[min(g + 5, vt)] > starts[first]]
                if chunks:
                    keyframes.append({"resolved_frame_index": f + guide_starts[chunks[0]] - origin,
                                      "latent": latent[:, :, chunks[0]:chunks[-1] + 5]})
            audio = kf.get("audio_latent")
            if audio is not None:
                t = rescale * f
                j0, j1 = max(0, math.ceil(a0 - t)), min(audio.shape[-1], math.ceil(a1 - t))
                if j1 > j0:
                    keyframes.append({"resolved_frame_index": (t + j0 - a0) / rescale, "audio_latent": audio[..., j0:j1]})
        payload = {k: v for k, v in payload.items() if k != "layout"}
        payload["keyframes"] = keyframes
        payload.update(self._cond_latents(keyframes, payload.get("refs")))
        return payload

    def resize_cond_for_context_window(self, cond_key, cond_value, window, x_in, device, retain_index_list=[]):
        if cond_key == "audio_denoise_mask":
            return cond_value._copy_with(window.get_window_for_modality(1).get_tensor(cond_value.cond, device))
        if cond_key == "minimax_payload" and cond_value.cond.get("keyframes"):
            return cond_value._copy_with(self._window_payload(cond_value.cond, window))
        return super().resize_cond_for_context_window(cond_key, cond_value, window, x_in, device, retain_index_list=retain_index_list)

`
  const classAt = src.indexOf('class MiniMaxH3(')
  if (classAt < 0) {
    console.error('[patches-033] в model_base 0.33 нет class MiniMaxH3')
    process.exit(1)
  }
  const nextClass = src.indexOf('\nclass ', classAt + 1)
  if (nextClass < 0) {
    console.error('[patches-033] не найден конец класса MiniMaxH3')
    process.exit(1)
  }
  src = src.slice(0, nextClass + 1) + methods + src.slice(nextClass + 1)
  writeFileSync(p, src, 'utf8')
  console.log('[patches-033] comfy/model_base.py: keyframe-гиды в context windows (как в 0.44)')
}

writeFileSync(join(DST, 'README.txt'), [
  'Патчи ядра ComfyUI 0.33.x — откатная ветка бэкенда (comfy-aimdo 0.4.13).',
  '',
  'Набор генерируется скриптом scripts/make-core-patches-033.mjs, руками его',
  'править нельзя: при следующем запуске скрипта правки потеряются.',
  '',
  'Отличия от набора comfy-patches (ядро 0.44+):',
  '  • main.py — тот же патч 967, но поверх 0.33;',
  '  • comfy/audio.py — в 0.33 модуля нет вовсе, его зовёт наш патч нод;',
  '  • comfy/model_prefetch.py — версия 0.33 + shim pause_malloc_graph;',
  '  • utils/extra_config.py — из набора 0.44: понимает и строки, и списки',
  '    путей (студия пишет списки, штатный 0.33 падал на них при старте);',
  '  • comfy/model_base.py и comfy/ldm/minimax/model.py — 0.33 + keyframe',
  '    с одним аудио-гайдом (без видео-латента): в 0.44 такие кадры',
  '    поддерживаются, в 0.33 extra_conds падал KeyError: latent;',
  '  • в model_base перенесены методы 0.44, которых нет в 0.33:',
  '    _window_payload / resize_cond_for_context_window / map_context_window_to_modalities.',
  '    Без них якорь головы не режется по context window и не переносится во времени:',
  '  • comfy/ldm/minimax/* и comfy/context_windows.py не подменяются: 0.44-версии',
  '    тянут ComfyAttention из 0.44, а в файлах 0.33 есть всё нужное',
  '    (FRAME_PER_TOKEN, FRAME_RESCALE, IMAGENET_MEAN, ContextSchedules,',
  '    ContextFuseMethods).',
  '',
].join('\r\n'), 'utf8')
console.log('[patches-033] готово:', DST)
