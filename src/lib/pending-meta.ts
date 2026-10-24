/**
 * Server-side metadata writer (правка 21).
 *
 * Previously .meta.json sidecars were written ONLY by the browser after it
 * saw the job finish — closing the tab/window while the ComfyUI queue kept
 * generating produced videos without metadata. Now:
 *
 *   1. /api/comfy/generate  → recordPendingMeta(promptId, params)
 *      (server persists the job params immediately at submit time)
 *   2. /api/comfy/status    → markPendingRunning(promptId) on 'running',
 *                             finalizePendingMeta(promptId, outputs) on 'done'
 *                             (writes the sidecar even with no browser alive)
 *   3. /api/comfy/metadata  → client fast path: writeMetaSidecar() +
 *      clearPendingMeta() so the server copy never overwrites fresher data.
 *
 * Pending entries live in `<outputDir>/.pending-meta.json` (a dotfile — the
 * files listing skips dotfiles) and are pruned after 24h.
 */
import fs from 'fs'
import path from 'path'
import { getAppConfig } from '@/lib/app-config'
import { sanitizeFolderPath } from '@/lib/gallery-folders' // (правка 495)
import { probeVideoFile } from '@/lib/video-probe' // (правка 410)
import { computeFinalDimensions, finalDimsFromMegapixels, framesForDuration, clampLowResMP, selectResolution, type MiniMaxH3Params } from '@/lib/comfy/minimax-h3-template'
import { replaceVideoAudio, resolveFlfAudioReplacement } from '@/lib/replace-video-audio' // (правка 699)

/* ──────────────────── shared helpers ──────────────────── */

/** (правки 121, 124) Итоговые размеры видео ПОСЛЕ точного кропа — ТО же
 *  формула, что в шаблоне (buildMiniMaxH3Workflow): пресет → номинал
 *  (computeFinalDimensions), свободное разрешение → finalDimsFromMegapixels.
 *  lowResMP на итог больше не влияет: апскейлер — «target dimensions». */
export function computeOutputDimensions(
  aspectRatio: string,
  megapixels: number,
  targetDimensions?: { width: number; height: number },
): { w: number; h: number } {
  const d = targetDimensions
    ? computeFinalDimensions(targetDimensions.width, targetDimensions.height)
    : finalDimsFromMegapixels(aspectRatio, megapixels)
  return { w: d.outW, h: d.outH }
}

/** Убрать undefined-значения: в режиме слияния явный undefined
 *  «съел» бы уже записанное в сайдкаре значение, а JSON.stringify
 *  undefined и так не сериализует (в обычном режиме поведение прежнее). */
function stripUndefined(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined) out[k] = v
  }
  return out
}

/**
 * (правка 722) Слияние массива `references` по элементам (ключ — path).
 *
 * Зачем не обычное «новое перетирает старое»: у писателей поля НЕ равны по
 * составу, и каждый знает что-то, чего не знает другой:
 *  • клиент знает `role` (imageIntent: персонаж/сцена/стиль/композиция) —
 *    сервер о роли не знает вообще (в теле запроса только пути);
 *  • сервер знает `trim_start`/`trim_end` (обрезка аудио-референсов) и
 *    `compress` (сжатое видео-в-480p) — клиент их не пишет.
 * Обычная перезапись теряла то или другое. Здесь: состав — от пришедших,
 * а поля, которых у пришедших нет, сохраняются; `role` берётся непустой.
 */
function mergeReferences(existing: unknown, incoming: unknown): unknown {
  if (!Array.isArray(incoming)) return existing
  if (!Array.isArray(existing)) return incoming
  const byPath = new Map<string, Record<string, unknown>>()
  for (const r of existing) {
    if (r && typeof r === 'object' && !Array.isArray(r)) {
      const rec = r as Record<string, unknown>
      byPath.set(String(rec.path ?? ''), rec)
    }
  }
  const out: Array<Record<string, unknown>> = []
  for (const r of incoming) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue
    const rec = r as Record<string, unknown>
    const prev = byPath.get(String(rec.path ?? ''))
    const merged: Record<string, unknown> = { ...(prev ?? {}), ...rec }
    // Роль: непустая из любой стороны (клиент знает, сервер — нет).
    const role = rec.role || (prev ? prev.role : '') || ''
    merged.role = role
    out.push(merged)
  }
  return out
}

/** Write a .meta.json sidecar next to the output file + clean VHS
 *  byproducts (silent video / first-frame png). Returns the path or null.
 *
 *  (правка 722) opts.merge — СЛИЯНИЕ с уже существующим сайдкаром вместо
 *  полной перезаписи. Проблема, которую это чинит: сайдкар одного и того же
 *  файла пишут ДВА независимых писателя — серверный (pending-meta:
 *  recordPendingMeta → finalizePendingMeta) и клиентский быстрый путь
 *  (POST /api/comfy/metadata). Наборы полей у них различались, а перезапись
 *  была полной → «кто отработал последним, тот и вычеркнул» поля другого.
 *  Например, реально применённые кастомные LoRA (`lora`) писал только
 *  сервер, а клиент их не знал и затирал. Теперь поля объединяются:
 *  пришедшие перетирают старые, старые незнакомые поля сохраняются. */
export function writeMetaSidecar(
  filename: string,
  subfolder: string,
  params: Record<string, unknown>,
  opts?: { merge?: boolean },
): string | null {
  const OUTPUT_DIR = getAppConfig().outputDir
  if (!OUTPUT_DIR || !filename) return null

  const safeName = path.basename(filename)
  // (правка 495) subfolder — многоуровневый относительный путь ('a/b').
  const safeSub = subfolder ? sanitizeFolderPath(subfolder) : ''
  // (правка 348) startsWith без нормализации на Windows сравнивал пути с
  // разным регистром/разделителями ('E:\\Out' vs 'e:\\out') — ложный отказ
  // или, наоборот, прохождение чужого префикса. Сравниваем resolve-нутые
  // пути (на win32 — в нижнем регистре), граница — по разделителю.
  const outRoot = path.resolve(OUTPUT_DIR)
  const dir = path.resolve(path.join(outRoot, safeSub))
  const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p)
  const nDir = norm(dir)
  const nRoot = norm(outRoot)
  if (nDir !== nRoot && !nDir.startsWith(nRoot + path.sep)) return null

  const metaFile = path.join(dir, safeName + '.meta.json')
  fs.mkdirSync(dir, { recursive: true })
  let metadata: Record<string, unknown>
  if (opts?.merge) {
    // (правка 722) Слияние: старый сайдкар — база, новые поля сверху.
    let existing: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(fs.readFileSync(metaFile, 'utf-8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed
    } catch { /* нет/битый сайдкар — пишем с нуля */ }
    // (правка 722) Слияние — ТОЛЬКО внутри одной задачи. Счётчик ComfyUI
    // сбрасывается после рестарта, и имя `Minimax_Studio_00001.mp4` может
    // достаться новой генерации: старая метa тогда смешалась бы с новой
    // (промпт новый, а `flf_resolution`/`lora` — от прежней задачи).
    const oldJob = typeof existing.job_id === 'string' ? existing.job_id : null
    const newJob = typeof params.job_id === 'string' ? params.job_id : null
    const sameJob = oldJob === newJob
    metadata = sameJob
      ? { ...existing, ...stripUndefined(params) }
      : { ...stripUndefined(params) }
    // (правка 722) references — слияние по элементам (см. mergeReferences).
    if (sameJob) {
      const mergedRefs = mergeReferences(existing.references, params.references)
      if (mergedRefs !== undefined) metadata.references = mergedRefs
    }
    // created_at — момент ПОЯВЛЕНИЯ файла: более поздняя запись не должна
    // его перетирать (иначе «дата создания» ползёт вместе с записями).
    if (sameJob && typeof existing.created_at === 'number') metadata.created_at = existing.created_at
    else metadata.created_at = Date.now() / 1000
  } else {
    metadata = {
      ...params,
      created_at: Date.now() / 1000,
    }
  }
  metadata.job_id = (params.job_id as string) || (metadata.job_id as string) || `srv_${Date.now().toString(36)}`
  fs.writeFileSync(metaFile, JSON.stringify(metadata, null, 2), 'utf-8')

  // VHS byproduct cleanup (same logic the client-facing route had).
  // Удаляем «сиблинга» ТОЛЬКО если он создан ПОЗЖЕ начала этой же задачи:
  // без фильтра по mtime файл пользователя foo-audio.mp4 из совсем другой
  // генерации мог стереть его легитимный foo.mp4.
  const audioMatch = safeName.match(/^(.*)-audio\.[^.]+$/i)
  // (правка 715) Без started_at чистку НЕ выполняем вовсе. Раньше здесь стояло
  // `jobStartMs = ... : 0`, и условие `st.mtimeMs >= 0` было истинно всегда —
  // защита «удалять сиблинга только если он создан ПОСЛЕ старта этой задачи»
  // вырождалась в ничто, и под cleanup попадали легитимные файлы ЧУЖОЙ
  // генерации (foo.mp4 рядом с foo-audio.mp4). Теперь: нет метки времени —
  // нет удаления (fail-safe, а не fail-open).
  // Дополнительно: метка должна быть правдоподобной (не 0 и не из будущего) —
  // иначе клиент подставил бы 0 и вернул прежнее fail-open поведение.
  const rawStart = params.started_at
  const jobStartMs =
    typeof rawStart === 'number' &&
    Number.isFinite(rawStart) &&
    rawStart > 0 &&
    rawStart <= Date.now() + 60 * 60 * 1000
      ? rawStart
      : null
  if (audioMatch && jobStartMs !== null) {
    const base = audioMatch[1]
    const ext = path.extname(safeName).toLowerCase()
    // (правка 587) Второе условие из комментария: сиблинг не новее самого
    // аудиофайла (иначе это более поздний чужой файл). stat аудио не удался —
    // прежнее поведение (Infinity = условие не ограничивает).
    let audioMtimeMs = Infinity
    try {
      audioMtimeMs = fs.statSync(path.join(dir, safeName)).mtimeMs
    } catch { /* аудиофайл недоступен — не блокируем чистку */ }
    const unwanted = [path.join(dir, base + ext), path.join(dir, base + '.png')]
    for (const f of unwanted) {
      try {
        const st = fs.statSync(f)
        // «Сиблинг» той же задачи: изменён после её старта и не старше
        // самого аудиофайла (иначе это более поздний чужой файл).
        if (st.mtimeMs >= jobStartMs && st.mtimeMs <= audioMtimeMs) fs.unlinkSync(f)
      } catch { /* нет файла — ок */ }
    }
  }
  return metaFile
}

/* ──────────────────── pending-meta store ──────────────────── */

interface PendingEntry {
  params: Record<string, unknown>
  started_at: number
  /** Set on the first status poll that saw the prompt executing. */
  running_since?: number
  /** Set when a status poll saw the prompt QUEUED behind other jobs.
   *  Mirrors the client's `sawQueued` (use-video-gen.ts): a job that waited
   *  in the queue counts from its execution start, a job that went straight
   *  to execution counts from submission — otherwise the sidecar's
   *  generation_time diverges from the gallery badge. */
  saw_queued?: boolean
}

const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000

function pendingFile(): string | null {
  const dir = getAppConfig().outputDir
  return dir ? path.join(dir, '.pending-meta.json') : null
}

function loadPending(): Record<string, PendingEntry> {
  const file = pendingFile()
  if (!file || !fs.existsSync(file)) return {}
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, PendingEntry>
    if (!parsed || typeof parsed !== 'object') return {}
    const now = Date.now()
    const fresh: Record<string, PendingEntry> = {}
    for (const [pid, e] of Object.entries(parsed)) {
      if (e && typeof e.started_at === 'number' && now - e.started_at < PENDING_MAX_AGE_MS) {
        fresh[pid] = e
      }
    }
    return fresh
  } catch {
    return {}
  }
}

function savePending(map: Record<string, PendingEntry>) {
  const file = pendingFile()
  if (!file) return
  try {
    fs.writeFileSync(file, JSON.stringify(map, null, 2), 'utf-8')
  } catch { /* non-critical */ }
}

/** Map a generate-request body to the canonical sidecar fields
 *  (same shape the browser writes — see use-video-gen genParamsMap). */
function bodyToMetaParams(body: MiniMaxH3Params): Record<string, unknown> {
  const fps = 24
  // (правка 138) дефолт 5 → 2.5: минимум 2.5 с
  const duration = body.duration ?? 2.5
  // Actual frame count the server produces (node 46:19), for metadata (правка 55).
  const videoLengthFrames = framesForDuration(duration, fps)
  const finalResolution = body.finalResolution ?? 0.7
  // (правки 121, 124) ТОЧНЫЕ финальные размеры: пресет → body.targetDimensions,
  // свободное разрешение → MP-путь (та же формула, что в шаблоне)
  const { w, h } = computeOutputDimensions(body.aspectRatio || '16:9', finalResolution, body.targetDimensions)
  const genMode0: 'ref' | 't2v' | 'flf' | 'extend' = body.mode === 't2v' || body.mode === 'flf' || body.mode === 'extend' ? body.mode : 'ref'
  const draft0 = genMode0 !== 'extend' && body.pipeline === 'draft'
  // Драфт: фактический выход = ОСНОВНОЕ разрешение (как flf):
  // пресет → ceil32(targetDimensions), свободное → finalRes MP
  const draftCanvas = draft0 && genMode0 !== 'flf'
    ? (body.targetDimensions
        ? {
            w: Math.max(32, Math.ceil(body.targetDimensions.width / 32) * 32),
            h: Math.max(32, Math.ceil(body.targetDimensions.height / 32) * 32),
          }
        : selectResolution(body.aspectRatio || '16:9', finalResolution))
    : null
  const resW = draftCanvas ? draftCanvas.w : w
  const resH = draftCanvas ? draftCanvas.h : h
  // (правка 2) Аудио-рефы: сохраняем обрезку (trim_start/trim_end) —
  // восстановление из меты вернёт её в UI.
  const references: Array<{ type: string; path: string; role: string; trim_start?: number; trim_end?: number | null; /** (правка 493) видео-реф сжимался до 480p */ compress?: boolean }> = [
    ...(body.refImages ?? []).map((p) => ({ type: 'image', path: p, role: '' })),
    // (правка 493) path — ОРИГИНАЛ (роут подменяет путь только для сабмита),
    // флаг compress — «Повторить» сожмёт заново (сжатие кэшируется).
    ...(body.refVideos ?? []).map((r) => ({ type: 'video', path: r.path, role: '', ...(r.compress === true && { compress: true }) })),
    ...(body.refAudios ?? []).map((p, i) => {
      const t = body.refAudioTrims?.[i]
      return t
        ? { type: 'audio', path: p, role: '', trim_start: t.start, trim_end: t.end }
        : { type: 'audio', path: p, role: '' }
    }),
  ]
  // (правка 470) flf: первый кадр — тоже якорь идентичности. Раньше он жил
  // только в поле first_frame, а references у flf-видео были пусты → рефайн
  // (readMetaImageRefs читает только references) шёл без мета-рефов, и сайдкар
  // результата рефайна обрывал цепочку якорей навсегда. Дедуп по path.
  if (genMode0 === 'flf' && body.firstFrame && !references.some((r) => r.path === body.firstFrame)) {
    references.unshift({ type: 'image', path: body.firstFrame, role: '' })
  }
  // (правка 157) Режимы + размеры первого кадра — для «Повторить»
  // (без first_frame_width/height ориентация из кадра не восстановится
  //  и flf-генерация снова даст не ту ориентацию).
  const genMode: 'ref' | 't2v' | 'flf' | 'extend' = genMode0
  const draft = draft0
  return {
    prompt: body.prompt,
    model_type: 'minimax_h3_ref2va',
    workflow: draft ? 'draft-single-pass' : 'two-pass-latent-upscaler',
    pipeline: draft ? 'draft' : 'full',
    seed: body.seed ?? -1,
    generation_mode: genMode,
    ...(genMode === 'flf' && {
      first_frame: body.firstFrame ?? null,
      last_frame: body.lastFrame ?? null,
      first_frame_width: body.firstFrameWidth ?? null,
      first_frame_height: body.firstFrameHeight ?? null,
      // (правка 722) Итоговый номинал flf — «Повторить» восстанавливает
      // именно его, а не UI-пресет. В пресетном режиме targetDimensions уже
      // посчитан клиентом как flfNominalDimensions (пропорция первого кадра).
      ...(body.targetDimensions && {
        flf_resolution: `${body.targetDimensions.width}x${body.targetDimensions.height}`,
      }),
    }),
    resolution: `${resW}x${resH}`,
    aspect_ratio: body.aspectRatio,
    // (правка 722) Папка вывода задачи — без неё fallback-поиск выходного
    // файла (concat/extend) не знает, где искать свой ролик.
    output_subfolder: body.outputSubfolder || '',
    final_resolution_mp: finalResolution,
    // Заклёмпленное значение — как в реальном workflow (clampLowResMP).
    // (правка 424) extend: дополнительный кап по МП исходника — канва pass 1
    // не должна превышать final ни по одной оси (апскейлер только upscale).
    low_res_mp: genMode0 === 'extend' && body.targetDimensions
      ? Math.min(
          clampLowResMP(body.lowResMP ?? 0.2, finalResolution),
          (body.targetDimensions.width * body.targetDimensions.height) / (1024 * 1024),
        )
      : clampLowResMP(body.lowResMP ?? 0.2, finalResolution),
    video_length: videoLengthFrames,
    duration_seconds: videoLengthFrames / fps,
    fps,
    pass1_steps: body.firstSamplerSteps ?? 6,
    // Всего шагов в расписании pass 1 (точка сплита = это число → «6 из 6»).
    pass1_total_steps: body.firstSamplerTotalSteps ?? body.firstSamplerSteps ?? 6,
    // (правка 722) Шаги ЕДИНСТВЕННОГО прохода драфта. Без этого поля серверный
    // сайдкар драфта показывал в диалоге метаданных «6» (значение точки
    // сплита) вместо реально использованных шагов драфта — а «Повторить»
    // вообще не умел восстанавливать draftSteps.
    ...(draft && { draft_steps: body.draftSteps ?? 4 }),
    pass2_steps: { '3step': 3, '4step': 4, '5step': 5, '6step': 6, '7step': 7 }[body.sigmaVariant || '3step'] ?? 3,
    sigma_variant: body.sigmaVariant || '3step',
    pass2_sampler: body.pass2Sampler || 'euler', // (правка 69)
    pass1_sampler: body.pass1Sampler || 'euler', // (правка 70)
    pass1_scheduler: body.pass1Scheduler || 'simple', // (правка 70)
    // Турбо-лора теперь снова подключается (через customLoras, включена по
    // умолчанию), поэтому её имя попадает в `lora` ниже. Отдельная сила
    // турбо в шаблоне не используется — сила хранится в loras.json.
    minimax_h3_reference_detail: body.refImageSize || 'match', // (правка 58)
    sparse_attention: body.sparseAttention === true, // (правки 168→387) Sol-Attn default OFF
    // (правка 466) настройки Sol-Attn — «Повторить» восстанавливает
    ...(body.sparseAttention === true && {
      sparse_tau: body.sparseTau ?? 1.3,
      sparse_start_percent: body.sparseStartPercent ?? 0.2,
      sparse_end_percent: body.sparseEndPercent ?? 1.0,
      sparse_min_tokens: body.sparseMinTokens ?? 12288,
      sparse_extra_tokens: body.sparseExtraTokens ?? 256,
    }),
    veda_attention: body.vedaAttention === true, // (правка 301)
    // (правка 404) veda-настройки — «Повторить» восстанавливает
    ...(body.vedaAttention === true && {
      veda_generated_sparsity: body.vedaGeneratedSparsity ?? '90%',
      veda_reference_sparsity: body.vedaReferenceSparsity ?? '90%',
      veda_full_attention_layers: body.vedaFullAttentionLayers ?? '',
      veda_full_attention_steps: body.vedaFullAttentionSteps ?? '',
      veda_verbose: body.vedaVerbose === true,
    }),
    low_vram_attention: body.lowVramAttention !== false,
    chunk_feed_forward: body.chunkFeedForward !== false,
    ...(body.chunkFeedForward !== false
      ? {
          chunk_ff_chunks: body.chunkFFChunks ?? 2,
          chunk_ff_threshold: body.chunkFFThreshold ?? 4096,
        }
      : {}),
    // Фактически применённые LoRA (включая встроенную турбо-лору, если она
    // не пропущена в flf+audio). Может быть пусто; MetaDialog «Ещё» удаляет поле.
    lora: (body.customLoras ?? []).map((l) => l.name).join(', '),
    references,
    // (правка 161) extend-режим: клипы + рефы
    ...(genMode === 'extend' && {
      extend_clips: body.extendClips || [],
      extend_refs: body.extendRefs || [],
      // (правка 260) исходник продления — из чего сделано видео
      source_video: body.extendSourceVideo ? { name: body.extendSourceVideo } : null,
      // (правка 722) Те же данные ИМЕНАМИ клиентского писателя: клиентский
      // сайдкар писал extend_source_video (строка) и extend_clips_count, а
      // серверный — source_video {name} и extend_clips (массив). Наборы полей
      // расходились, и «кто записал последним» решал судьбу метаданных.
      // Теперь сервер пишет оба варианта.
      extend_source_video: body.extendSourceVideo ?? null,
      extend_clips_count: (body.extendClips || []).length,
      ...((body.extendClips || []).length > 0 && {
        extend_prompts: (body.extendClips || [])
          .map((c) => (c.prompt || '').trim())
          .filter((p) => /[a-zA-Zа-яА-ЯёЁ\u00c0-\u024f\u0400-\u04ff]{2,}/.test(p)),
      }),
      // (правка 423) двухпроходный режим продления — в сайдкар
      extend_two_pass: body.extendTwoPass === true,
    }),
  }
}

/** /api/comfy/generate: persist job params right after submission. */
export function recordPendingMeta(promptId: string, body: MiniMaxH3Params) {
  try {
    const map = loadPending()
    const startedAt = Date.now()
    // (правка 715) started_at кладём ВНУТРЬ params — иначе финализация
    // (finalizePendingMeta) собирает params из entry.params и метка времени
    // терялась → защита от удаления чужих сиблингов не работала.
    map[promptId] = {
      params: { ...bodyToMetaParams(body), job_id: promptId, started_at: startedAt },
      started_at: startedAt,
    }
    savePending(map)
  } catch { /* non-critical */ }
}

/**
 * (правка 260) Запись pending-метаданных для НЕ-генерационных джобов
 * (рефайн «Целый»/«Частями»): параметры передаются ГОТОВЫМИ (без мэппинга
 * MiniMaxH3Params). Финализация — тем же /api/comfy/status на 'done',
 * значит сайдкар появится, даже если браузер закрыли.
 */
export function recordPendingMetaRaw(promptId: string, params: Record<string, unknown>) {
  try {
    const map = loadPending()
    const startedAt = Date.now()
    // (правка 715) started_at — внутри params (см. recordPendingMeta).
    map[promptId] = {
      params: { ...params, job_id: promptId, started_at: startedAt },
      started_at: startedAt,
    }
    savePending(map)
  } catch { /* non-critical */ }
}

/** /api/comfy/status: the prompt was seen waiting in the queue. */
export function markPendingQueued(promptId: string) {
  try {
    const map = loadPending()
    const e = map[promptId]
    if (e && !e.saw_queued) {
      e.saw_queued = true
      savePending(map)
    }
  } catch { /* non-critical */ }
}

/** /api/comfy/status: first observation of the prompt actually executing. */
export function markPendingRunning(promptId: string) {
  try {
    const map = loadPending()
    const e = map[promptId]
    if (e && e.running_since === undefined) {
      e.running_since = Date.now()
      savePending(map)
    }
  } catch { /* non-critical */ }
}

/** /api/comfy/status on 'done': write the sidecar server-side.
 *  Skips when the browser already wrote it (client data wins) or when the
 *  pending entry is missing. Returns the written path or null.
 *  `execMs` — REAL execution time from ComfyUI WS events (preferred);
 *  falls back to the submit/running-anchor estimate when unavailable
 *  (e.g. the tracker restarted mid-job). */
export async function finalizePendingMeta(
  promptId: string,
  outputs: Array<{ filename: string; subfolder?: string }>,
  execMs?: number | null,
): Promise<string | null> {
  try {
    const map = loadPending()
    const entry = map[promptId]
    if (!entry) return null
    delete map[promptId]
    savePending(map)

    const primary =
      outputs.find((o) => o.filename?.match(/\.(mp4|webm|mov|m4v)$/i) && !/Minimax_Studio_cnref/i.test(o.filename ?? '')) || outputs[0]
    if (!primary?.filename) return null

    // Generation time: prefer the REAL ComfyUI execution window (WS events);
    // fall back to the submit/running-anchor estimate (same rule as the
    // client badge: queued → from execution start, straight → from submit).
    const from = entry.saw_queued ? (entry.running_since ?? entry.started_at) : entry.started_at
    const durationMs = typeof execMs === 'number' && execMs > 0 ? execMs : Date.now() - from
    // (правка 375) Латент-пайплайн: выход MiniMaxStudioSaveAVLatent ('46:49')
    // приходит в outputs как {filename: *.latent, subfolder: '<sub>/latents'}.
    // Пишем в сайдкар путь относительно output/ — рефайн по нему стартует
    // с первозданного латента (lossless-ветка refine-роута).
    // (правка 383 → актуализировано правкой 397, откат — правка 417)
    // Страж «одно видео в джобе». После правки 417 extend снова отдаёт
    // НЕСКОЛЬКО видео (поштучные extclip-файлы) и латента у него нет —
    // страж автоматически отсекает latent_file у extend-джобов. Страж
    // защищает от джобов с несколькими видеовыходами, где единый латент
    // джоба не соответствовал бы каждому из файлов.
    // (правка 420) У extend-джоба с ОДНИМ клипом латент есть (combined,
    // пост-сборка), но он соответствует ИТОГУ склейки, а не extclip-файлу —
    // extend исключён явно; latent_file итога клиент пишет в мету combined
    // при вызове /api/comfy/concat.
    const vids = outputs.filter((o) => o.filename?.match(/\.(mp4|webm|mov|m4v)$/i) && !/Minimax_Studio_cnref/i.test(o.filename ?? ''))
    const latentOut = vids.length === 1 && entry.params.generation_mode !== 'extend'
      ? outputs.find((o) => o.filename?.match(/\.latent$/i))
      : undefined
    const latentFile = latentOut
      ? `${latentOut.subfolder ? latentOut.subfolder + '/' : ''}${latentOut.filename}`
      : null
    const params: Record<string, unknown> = {
      ...entry.params,
      // (правка 715) Метка времени старта джоба — внутри params, иначе
      // writeMetaSidecar не видел её и чистил «чужие» сиблинги.
      started_at: entry.started_at,
      generation_time: Math.max(1, Math.round(durationMs / 1000)),
      ...(latentFile && { latent_file: latentFile }),
    }

    // (правка 410, актуализировано правкой 417) Extend с исходником: probe
    // видеовыходов. Раньше чинил сайдкар combined-файла латент-комбайна
    // (video_length плана клипов ≠ факту итога). После отката 417 extend
    // снова пишет поштучные extclip-файлы — probe даёт им фактические
    // кадры/разрешение (файл клипа длиннее плана клипа на preserved-голову).
    // Итоговый combined делает ffmpeg-склейка /api/comfy/concat — она
    // прописывает probe-поля сама.
    const isExtendCombined =
      entry.params.generation_mode === 'extend' && !!entry.params.source_video
    // (правка 471) Рефайн: теперь сохраняет .latent результата → сайдкару
    // нужны ТОЧНЫЕ video_length/resolution выходного mp4 (resolveSourceLatent
    // сверяет их с ffprobe при повторном рефайне). Плановых полей у рефайна
    // нет (у «Частями» длина итога ≠ длине исходника: сетка 17k+5 и срезы
    // окон), поэтому probe выхода, как у extend.
    // (правка 722) Проба нужна и остальным режимам: у FPS/Tile Upscale/
    // ControlNet плановые размеры — это параметры ВХОДА, а в сайдкар должны
    // попасть размеры и длина ИТОГОВОГО файла (иначе метаданные врут:
    // у FPS кадров в ×multiplier больше, чем в исходнике).
    const needsProbe =
      isExtendCombined ||
      entry.params.generation_mode === 'refine' ||
      entry.params.generation_mode === 'fps' ||
      entry.params.generation_mode === 'tileupscale' ||
      entry.params.generation_mode === 'controlnet' ||
      entry.params.generation_mode === 'facerefine'

    // (правка 260) Сайдкар на КАЖДОМ видеовыходе джоба (клипы extend,
    // куски рефайна), а не только на первом — метаданные обязаны быть
    // у любого сгенерированного ролика. Дедуп по имени файла.
    const seen = new Set<string>()
    let last: string | null = null
    let i = 0
    const OUTPUT_DIR = getAppConfig().outputDir
    for (const o of outputs) {
      if (!o.filename?.match(/\.(mp4|webm|mov|m4v)$/i)) continue
      const key = `${o.subfolder || ''}/${o.filename}`
      if (seen.has(key)) continue
      seen.add(key)

      // (правка 699) FLF: подставляем оригинальную аудиодорожку (из
      // references type='audio') вместо перегенерированной, обрезая по
      // длительности видео. Делаем ДО пробы/сайдкара — иначе probe
      // увидит старый аудио-стим.
      if (i === 0 && OUTPUT_DIR) {
        const videoPath = path.join(OUTPUT_DIR, o.subfolder || '', path.basename(o.filename))
        const audioPath = resolveFlfAudioReplacement(params)
        if (audioPath) {
          try {
            const ok = await replaceVideoAudio(videoPath, audioPath)
            if (ok) {
              console.log(`[replace-audio] flf: swapped audio in ${o.filename} from ${path.basename(audioPath)}`)
              params.audio_replaced_from = path.basename(audioPath) // метка в сайдкар
            }
          } catch (err) {
            console.error('[replace-audio] flf swap failed:', err)
          }
        }
      }

      let probed: Record<string, unknown> = {}
      if (needsProbe) {
        try {
          const filePath = path.join(OUTPUT_DIR, o.subfolder || '', path.basename(o.filename))
          const pr = await probeVideoFile(filePath)
          if (pr.width > 0 && pr.height > 0 && pr.frames > 0) {
            probed = {
              video_length: pr.frames,
              duration_seconds: Number(pr.durationSec.toFixed(2)),
              // Фактический fps файла (probe из r_frame_rate): у режима FPS
              // итог 48/72 к/с — прежний хардкод 24 врал в сайдкаре.
              // Генерация/refine и так пишут 24 — значение не меняется.
              fps: Math.round(pr.fps ?? 24),
              resolution: `${pr.width}x${pr.height}`,
            }
          }
        } catch { /* probe не критичен — остаются плановые поля */ }
      }
      last = writeMetaSidecar(o.filename, o.subfolder || '', {
        ...params,
        ...probed,
        ...(outputs.length > 1 ? { output_index: i } : {}),
      }, { merge: true }) ?? last
      i++
    }
    if (last) return last
    return writeMetaSidecar(primary.filename, primary.subfolder || '', params, { merge: true })
  } catch {
    return null
  }
}

/** Drop a pending entry (client already wrote the sidecar / job errored). */
export function clearPendingMeta(promptId: string) {
  try {
    const map = loadPending()
    if (promptId in map) {
      delete map[promptId]
      savePending(map)
    }
  } catch { /* non-critical */ }
}

/** (правка 511) Удалить временные depth/canny карты (Minimax_Studio_cnref_*.mp4)
 *  из output-папки ComfyUI. Файлы создаются VHS_VideoCombine (cn_preout)
 *  во время ControlNet-генерации для VHS_LoadVideoPath; после завершения
 *  джоба они бесполезны. Режим «Карта» создаёт Minimax_Studio_controlmap_*
 *  (другой префикс) — на него cleanup не влияет.
 *
 *  (правка 716) Теперь удаляются ТОЛЬКО карты конкретного джоба (по
 *  уникальному префиксу cn_ref_prefix). Раньше префикс был общим
 *  («Minimax_Studio_cnref» + счётчик ComfyUI) и cleanup удалял ВСЕ карты —
 *  в том числе карты параллельно идущей ControlNet-задачи, из-за чего та
 *  падала внутри VHS_LoadVideoPath. Если префикс неизвестен (например,
 *  джоб был без ControlNet) — ничего не удаляем. */
export async function cleanupCnrefTempFiles(_promptId: string, prefix?: string | null) {
  try {
    if (!prefix) return
    const cfg = getAppConfig()
    const outDir = cfg.outputDir
    if (!outDir) return

    // Префикс из джоба — санитайзим, чтобы он не стал шаблоном для
    // произвольного удаления по glob-подобному совпадению.
    const safePrefix = prefix.replace(/[^A-Za-z0-9_.-]/g, '')
    if (!safePrefix) return
    const fileRe = new RegExp(`^${safePrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*\\.mp4$`, 'i')

    const files = fs.readdirSync(outDir)
    for (const f of files) {
      if (fileRe.test(f)) {
        try { fs.unlinkSync(path.join(outDir, f)) } catch { /* ignore */ }
      }
    }
    // Подпапки (outputSubfolder)
    for (const f of files) {
      const fp = path.join(outDir, f)
      try {
        if (!fs.statSync(fp)?.isDirectory()) continue
      } catch { continue }
      try {
        const sub = fs.readdirSync(fp)
        for (const sf of sub) {
          if (fileRe.test(sf)) {
            try { fs.unlinkSync(path.join(fp, sf)) } catch { /* ignore */ }
          }
        }
      } catch { /* ignore */ }
    }
  } catch { /* non-critical */ }
}

/**
 * (правка 716) Префикс временной карты референса для задачи (из pending-meta).
 * Читается ДО финализации, пока запись жива.
 */
export function getPendingCnRefPrefix(promptId: string): string | null {
  try {
    const map = loadPending()
    const e = map[promptId]
    const p = e?.params?.cn_ref_prefix
    return typeof p === 'string' && p ? p : null
  } catch {
    return null
  }
}
