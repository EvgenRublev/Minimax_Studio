/**
 * Очередь рефайна — (правка 261).
 *
 * Прежде вкладка «Рефайн» выполняла задачи напрямую: одна задача занимала
 * вкладку до конца, вторую поставить было нельзя, а об общей очереди с
 * генерациями речи не шло. Теперь рефайн «Целый»/«Частями» ставится в
 * ОБЩУЮ очередь (useGenQueue, type 'refine') рядом с генерациями и
 * продлением — задачи выполняются по одной, карточка очереди показывает
 * все, отмена работает.
 *
 * Раннер — синглтон на уровне модуля (как движок ассистента): переживает
 * переключение вкладок; в фоне сабмитит задачу, опрашивает статус/прогресс,
 * для «Частями» сшивает куски и сигналит галерее. Продление и генерация
 * ходят в ту же очередь через use-video-gen (type 'video') — исполнение
 * сериализует ComfyUI на своей стороне.
 */
import { useGenQueue, type QueueItem } from './gen-queue-store'
import { useGalleryRefresh } from './gallery-refresh-store'

export interface RefineTask {
  mode: 'whole' | 'chunks'
  /** Оригинал из галереи (output), из которого делается рефайн. */
  source: { filename: string; subfolder: string }
  /** (правка 265) Файл с диска, уже в ComfyUI input/ (через /api/comfy/upload).
      При наличии — источник, а не копия из output. */
  inputSource?: string
  /** (правка 494) 'free' — свободное разрешение: сервер считает короткую
   *  сторону из targetMp по реальным размерам источника. */
  target: 'same' | 'x2' | number | 'free'
  /** (правка 494) Цель в мегапикселях для target='free' (до 4K = 8.3 Мп). */
  targetMp?: number
  steps: number
  /** σ_start лестницы (0.1–0.95) — ползунок «сколько шума убирать». */
  sigmaStart?: number
  seed: number
  prompt: string
  chunkSeconds: number
  /** (правка 315) Режим размера референсов ('match' | 'max', дефолт 'max'
   *  на сервере) — переключатель вкладки Refine. */
  refImageSize?: 'match' | 'max'
  /** (правка 407) Veda Sparse Attention + настройки ноды (из gen-store). */
  vedaAttention?: boolean
  vedaGeneratedSparsity?: string
  vedaReferenceSparsity?: string
  vedaFullAttentionLayers?: string
  vedaFullAttentionSteps?: string
  vedaVerbose?: boolean
  /** (правка 466) Sol-Attn + настройки ноды (из gen-store). */
  sparseAttention?: boolean
  sparseTau?: number
  sparseStartPercent?: number
  sparseEndPercent?: number
  sparseMinTokens?: number
  sparseExtraTokens?: number
  /** (правка 492) Оригинальная дорожка вместо перегенерированного звука. */
  keepOriginalAudio?: boolean
  /** (правка 509) Картинки-референсы от пользователя (имена в input/) —
   *  для источников с диска без метаданных. */
  refImages?: string[]
}

/** Задачи, ожидающие своей очереди (module-level — переживает вкладки). */
const tasks = new Map<string, RefineTask>()
let running = false
/**
 * (правка 716) id элемента очереди, который раннер обрабатывает ПРЯМО СЕЙЧАС.
 * Позволяет sweep'у отличить живую задачу от сироты после перезагрузки
 * страницы (module-level Map обнуляется при reload, элементы очереди — нет).
 */
let activeItemId: string | null = null

/** Поставить рефайн в общую очередь. Возвращает id элемента очереди. */
export function enqueueRefine(task: RefineTask): string {
  const id = useGenQueue.getState().enqueue('refine', `Refine: ${task.source.filename}`)
  tasks.set(id, task)
  kick()
  return id
}

/** Все активные элементы очереди типа «рефайн». */
export function activeRefineItems(items: QueueItem[]): QueueItem[] {
  return items.filter(
    (i) => i.type === 'refine' && (i.status === 'submitting' || i.status === 'queued' || i.status === 'running'),
  )
}

/** Отменить все активные рефайны (кнопка «Остановить» на вкладке). */
export async function cancelActiveRefines(): Promise<void> {
  const { setStatus } = useGenQueue.getState()
  for (const item of activeRefineItems(useGenQueue.getState().items)) {
    setStatus(item.id, 'cancelled')
    // (правка 334) Ожидающая очереди задача — из Map тоже: иначе запись-
    // сирота оставалась навсегда (раннер её не возьмёт — элемент cancelled).
    tasks.delete(item.id)
    if (item.promptId) {
      try {
        await fetch('/api/comfy/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt_id: item.promptId }),
        })
      } catch { /* ignore */ }
    }
  }
}

/**
 * (правки 329/334) Отмена ОДНОГО рефайна из QueueIndicator: статус cancelled,
 * запись из Map (у ещё не запущенной) и отмена в ComfyUI по prompt_id.
 */
export async function cancelRefineItem(id: string): Promise<void> {
  const { setStatus } = useGenQueue.getState()
  const item = useGenQueue.getState().items.find((i) => i.id === id)
  tasks.delete(id)
  setStatus(id, 'cancelled')
  if (item?.promptId) {
    try {
      await fetch('/api/comfy/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt_id: item.promptId }),
      })
    } catch { /* ignore */ }
  }
}

function kick() {
  if (running) return
  running = true
  void runLoop().finally(() => {
    running = false
    // За время выполнения могли добавиться новые задачи — крутим дальше.
    if (activeRefineItems(useGenQueue.getState().items).some((i) => tasks.has(i.id))) kick()
  })
}

async function runLoop(): Promise<void> {
  for (;;) {
    const item = useGenQueue
      .getState()
      .items.find(
        (i) =>
          i.type === 'refine' &&
          (i.status === 'submitting' || i.status === 'queued') &&
          tasks.has(i.id),
      )
    if (!item) return
    const task = tasks.get(item.id)!
    tasks.delete(item.id)

    try {
      // (правка 716) Помечаем элемент как «в работе» — sweep не считает его
      // сиротой и не запускает второго финализатора.
      activeItemId = item.id
      await runTask(item.id, task)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      useGenQueue.getState().setStatus(item.id, 'error', msg)
    } finally {
      if (activeItemId === item.id) activeItemId = null
    }
  }
}

const isCancelled = (id: string) =>
  useGenQueue.getState().items.find((i) => i.id === id)?.status === 'cancelled'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function runTask(id: string, task: RefineTask): Promise<void> {
  const q = () => useGenQueue.getState()
  q().setStatus(id, 'submitting')

  // (правка 264) Время генерации для сайдкара итогового файла:
  // от отправки в ComfyUI до done (генерация + для «Частями» сшивка).
  const t0 = Date.now()

  const res = await fetch('/api/comfy/refine', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourceFilename: task.source.filename,
      sourceSubfolder: task.source.subfolder,
      ...(task.inputSource ? { inputSource: task.inputSource } : {}),
      // (правка 494) free-режим: сервер конвертирует Мп в короткую сторону
      target: task.target === 'free' ? 'same' : task.target,
      ...(task.target === 'free' && task.targetMp ? { targetMp: task.targetMp } : {}),
      steps: task.steps,
      ...(task.sigmaStart ? { sigmaStart: task.sigmaStart } : {}),
      seed: task.seed,
      prompt: task.prompt.trim() ? task.prompt.trim() : undefined,
      refImageSize: task.refImageSize ?? 'max', // (правка 315)
      // (правка 407) Veda + настройки ноды — только при включённом тоггле
      ...(task.vedaAttention === true && {
        vedaAttention: true,
        vedaGeneratedSparsity: task.vedaGeneratedSparsity,
        vedaReferenceSparsity: task.vedaReferenceSparsity,
        vedaFullAttentionLayers: task.vedaFullAttentionLayers,
        vedaFullAttentionSteps: task.vedaFullAttentionSteps,
        vedaVerbose: task.vedaVerbose === true,
      }),
      // (правка 466) Sol-Attn + настройки ноды — только при включённом тоггле
      ...(task.sparseAttention === true && {
        sparseAttention: true,
        sparseTau: task.sparseTau,
        sparseStartPercent: task.sparseStartPercent,
        sparseEndPercent: task.sparseEndPercent,
        sparseMinTokens: task.sparseMinTokens,
        sparseExtraTokens: task.sparseExtraTokens,
      }),
      ...(task.mode === 'chunks' ? { mode: 'chunks', chunkSeconds: task.chunkSeconds } : {}),
      // (правка 492) Оригинальный звук — галочка вкладки Refine
      ...(task.keepOriginalAudio === true && { keepOriginalAudio: true }),
      // (правка 509) Референсы от пользователя (источник с диска)
      ...(task.refImages && task.refImages.length > 0 && { refImages: task.refImages }),
    }),
  })
  const data = (await res.json()) as {
    prompt_id?: string
    error?: string
    chunks?: number
    /** Промпт, который сервер реально подал в воркфлоу (мета исходника +
     *  её картинки-референсы резолвятся на сервере) — для сайдкара сшивки. */
    promptUsed?: string
  }
  if (!res.ok || data.error) {
    throw new Error(data.error || `HTTP ${res.status}`)
  }
  const promptId = data.prompt_id
  if (!promptId) throw new Error('ComfyUI не вернул prompt_id')
  q().setPromptId(id, promptId)
  q().setStatus(id, 'queued')

  // ── Опрос статуса + прогресса (как awaitJobDone прежней вкладки) ──
  let unknownStreak = 0
  for (;;) {
    if (isCancelled(id)) return
    await sleep(1500)
    let s: { status?: string; detail?: string; outputs?: Array<{ filename: string; subfolder?: string; type?: string }> }
    try {
      const r = await fetch(`/api/comfy/status?prompt_id=${encodeURIComponent(promptId)}`)
      if (!r.ok) throw new Error(`status ${r.status}`)
      s = await r.json()
    } catch {
      if (++unknownStreak >= 20) throw new Error('ComfyUI не отвечает (30 с подряд)')
      continue
    }
    // (правка 552) Перепроверка после await: отмена могла прийти, пока запрос
    // был в полёте. ComfyUI помечает прерванный промпт как 'error' — без
    // этой проверки статус «Отменено» перекатывался в «Ошибка».
    if (isCancelled(id)) return
    // (правка 552) Сброс счётчика unknown — ТОЛЬКО при достоверном статусе.
    // Раньше сброс стоял в try-блоке (любой HTTP-200) и обнулял счётчик
    // ПЕРЕД проверкой status:'unknown' — при «отвечает, но задачи нет»
    // (ComfyUI перезапущен / промпт удалён из очереди) счётчик никогда не
    // дорастал до 20, таймаут «Задача не найдена» был мёртв, цикл опроса
    // висел вечно и блокировал всю очередь рефайна (running = true в kick()).
    if (s.status !== 'unknown') unknownStreak = 0
    if (s.status === 'running' && q().items.find((i) => i.id === id)?.status !== 'running') {
      q().setStatus(id, 'running')
    }
    if (s.status === 'running' || s.status === 'queued') {
      try {
        const pr = await fetch(`/api/comfy/progress?prompt_id=${encodeURIComponent(promptId)}`)
        if (pr.ok) {
          const pd = await pr.json()
          if (pd.progress && typeof pd.progress.percent === 'number') {
            q().setProgress(id, pd.progress.percent, 100)
          }
        }
      } catch { /* non-critical */ }
      continue
    }
    if (s.status === 'error') throw new Error(s.detail || 'Ошибка выполнения')
    if (s.status === 'unknown') {
      if (++unknownStreak >= 20) throw new Error('Задача не найдена в ComfyUI')
      continue
    }
    if (s.status !== 'done') continue

    // ── done ──
    if (task.mode === 'chunks') {
      // (правка 311) Новый воркфлоу (правка 314 в refine-template.ts) склеивает
      // окна В ЛАТЕНТЕ и отдаёт ОДИН файл Minimax_Studio_refine_* — ffmpeg-
      // сшивка и повторное кодирование больше не нужны, мета пишется
      // сервером (recordPendingMetaRaw в /api/comfy/refine → финализация в
      // /api/comfy/status на done), как в режиме «Целиком».
      // LEGACY-путь: если в outputs пришли refinepart_* (старый воркфлоу) —
      // сортируем по номеру окна и сшиваем жёсткой конкатенацией, как раньше.
      const parts = (s.outputs || [])
        .filter((o) => o.type === 'output' && /refinepart.*[.]mp4$/i.test(o.filename))
        .sort((a, b) => {
          // (правка 310) Индекс окна явно в префиксе: refinepart_0, refinepart_1, …
          const num = (f: string) => {
            const m = f.match(/refinepart_(\d+)/i)
            return m ? parseInt(m[1], 10) : 0
          }
          return num(a.filename) - num(b.filename)
        })
      if (!parts.length) {
        // Новый путь: один файл результата, ничего сшивать не надо.
        const single = (s.outputs || []).find(
          (o) => o.type === 'output' && /Minimax_Studio_refine(?!part).*[.]mp4$/i.test(o.filename),
        )
        if (!single) throw new Error('ComfyUI не вернул файл рефайна')
        if (isCancelled(id)) return
      } else {
      if (isCancelled(id)) return
      q().setMessage(id, 'Сшивка кусков…')
      // (правка 272) Латент-цепочка: куски без дублей (голова срезана),
      // стыки непрерывны — жёсткая concat. (правка 311) LEGACY: только для
      // воркфлоу старого образца с покусочными refinepart_*.
      const st = await fetch('/api/comfy/refine/stitch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chunkFiles: parts.map((o) => ({ filename: o.filename, subfolder: o.subfolder || '' })),
          audioSource: { filename: task.source.filename, subfolder: task.source.subfolder },
          outSubfolder: task.source.subfolder || '',
          hard: true,
          meta: {
            // Сервер уже резолвил промпт (мета исходника + картинки) —
            // в сайдкар итога пишем его, а не сырое поле задачи.
            prompt: data.promptUsed || task.prompt,
            model_type: 'minimax_h3_ref2va',
            workflow: 'refine-chunks-latent-chain',
            generation_mode: 'refine',
            refine_mode: 'chunks',
            source_video: { filename: task.source.filename, subfolder: task.source.subfolder },
            steps: task.steps,
            sigma_start: task.sigmaStart,
            seed: task.seed,
            chunks: parts.length,
            // (правка 407) veda-настройки — «Повторить» восстанавливает
            ...(task.vedaAttention === true && {
              veda_attention: true,
              veda_generated_sparsity: task.vedaGeneratedSparsity ?? '90%',
              veda_reference_sparsity: task.vedaReferenceSparsity ?? '90%',
              veda_full_attention_layers: task.vedaFullAttentionLayers ?? '',
              veda_full_attention_steps: task.vedaFullAttentionSteps ?? '',
              veda_verbose: task.vedaVerbose === true,
            }),
            // (правка 264) Время генерации: submit → done (+ сшивка кусков).
            generation_time: Math.max(1, Math.round((Date.now() - t0) / 1000)),
          },
        }),
      })
      const sd = (await st.json()) as { error?: string }
      if (!st.ok || sd.error) throw new Error(sd.error || `HTTP ${st.status}`)
      }
    }
    q().setStatus(id, 'done')
    q().setProgress(id, 100, 100)
    useGalleryRefresh.getState().bump()
    return
  }
}

/**
 * Чистка после перезагрузки страницы: задачи очереди пережили reload
 * (persist), а их Runtime (Map задач / раннер) — нет. Отмечаем честной
 * ошибкой: файлы могли успеть сгенерироваться на сервере.
 * Вызывается с монтирования вкладки «Рефайн».
 */
/**
 * Чистка после перезагрузки страницы: задачи очереди пережили reload
 * (persist), а их Runtime (Map задач / раннер) — нет. Отмечаем честной
 * ошибкой: файлы могли успеть сгенерироваться на сервере.
 * Вызывается с монтирования вкладки «Рефайн».
 */
export function sweepOrphanRefineItems(): void {
  const { items, setStatus } = useGenQueue.getState()
  for (const it of items) {
    if (it.type !== 'refine') continue
    if (it.status !== 'submitting' && it.status !== 'queued' && it.status !== 'running') continue
    // (правка 716) Живая задача — та, что в очереди (tasks) или которую
    // раннер обрабатывает прямо сейчас (activeItemId). Раньше sweep
    // запускал recoverOrphanRefineItem для ЛЮБОГО элемента с prompt_id, в
    // том числе для идущей прямо сейчас задачи: получались ДВА поллера на
    // одном промпте, оба вызывали /api/comfy/refine/stitch → чанки
    // склеивались дважды, а два выхода писались параллельно.
    if (tasks.has(it.id) || it.id === activeItemId) continue
    // У активной задачи с prompt_id статус доведёт глобальный поллер
    // очереди (queue-indicator): файлы могли сохраниться. А вот ещё не
    // отправленные (без prompt_id) — потеряны вместе с задачей.
    if (!it.promptId) {
      setStatus(it.id, 'error', 'Страница перезагружена — задача не была отправлена. Запустите заново.')
    } else {
      // (правка 332) Задача с prompt_id: доводим до конца сами. Раньше её
      // done ставил глобальный поллер queue-indicator — БЕЗ legacy-stitch
      // покусочных refinepart_* и без bump галереи («Готово» без сшитого
      // файла). Теперь финализация refine-элементов — только здесь/в раннере.
      void recoverOrphanRefineItem(it).catch((err) => {
        console.warn('[refine-queue] recoverOrphanRefineItem failed:', err instanceof Error ? err.message : String(err))
      })
    }
  }
}

/* (правка 332) Восстановление refine-задачи после перезагрузки страницы.
 * Раннер (tasks Map) пережить reload не может, но задача в ComfyUI жива.
 * Опрашиваем статус; на done:
 *  • один файл Minimax_Studio_refine_* (новый воркфлоу) — просто done + bump;
 *  • refinepart_* (legacy) — сшиваем через /api/comfy/refine/stitch, как
 *    делал раннер: исходник и мета берём из сайдкара куска (его пишет
 *    pending-meta статусного роута на 'done' — recordPendingMetaRaw в
 *    /api/comfy/refine содержит source_video). Нет сайдкара — честная
 *    ошибка с понятным текстом, а не молчаливое «Готово». */
const orphanRecovery = new Set<string>()

async function recoverOrphanRefineItem(item: QueueItem): Promise<void> {
  const promptId = item.promptId
  if (!promptId || orphanRecovery.has(promptId)) return
  orphanRecovery.add(promptId)
  const q = () => useGenQueue.getState()
  try {
    let unknownStreak = 0
    for (;;) {
      const cur = q().items.find((i) => i.id === item.id)
      if (!cur || cur.status === 'cancelled') return
      await sleep(2000)
      let s: {
        status?: string
        detail?: string
        outputs?: Array<{ filename: string; subfolder?: string; type?: string }>
      }
      try {
        const r = await fetch(`/api/comfy/status?prompt_id=${encodeURIComponent(promptId)}`)
        if (!r.ok) throw new Error(`status ${r.status}`)
        s = await r.json()
      } catch {
        if (++unknownStreak >= 20) {
          q().setStatus(item.id, 'error', 'ComfyUI не отвечает после перезагрузки страницы')
          return
        }
        continue
      }
      if (s.status === 'running' || s.status === 'queued') {
        unknownStreak = 0
        continue
      }
      if (s.status === 'unknown') {
        if (++unknownStreak >= 20) {
          q().setStatus(item.id, 'error', 'Задача не найдена в ComfyUI (сервер был перезапущен)')
          return
        }
        continue
      }
      if (s.status === 'error') {
        q().setStatus(item.id, 'error', s.detail || 'Ошибка выполнения')
        return
      }
      if (s.status !== 'done') continue

      // ── done ──
      const parts = (s.outputs || [])
        .filter((o) => o.type === 'output' && /refinepart.*[.]mp4$/i.test(o.filename))
        .sort((a, b) => {
          const num = (f: string) => {
            const m = f.match(/refinepart_(\d+)/i)
            return m ? parseInt(m[1], 10) : 0
          }
          return num(a.filename) - num(b.filename)
        })
      if (!parts.length) {
        // Новый воркфлоу: один файл, сшивать нечего.
        q().setStatus(item.id, 'done')
        q().setProgress(item.id, 100, 100)
        useGalleryRefresh.getState().bump()
        return
      }

      // LEGACY: куски refinepart_* — сшиваем.
      q().setMessage(item.id, 'Сшивка кусков…')
      // Исходник и промпт — из сайдкара первого куска (pending-meta пишет
      // их на 'done' даже без живого браузера).
      let source: { filename: string; subfolder: string } | null = null
      let promptUsed = ''
      try {
        const metaPath = `${parts[0].subfolder ? parts[0].subfolder + '/' : ''}${parts[0].filename}`
        const mr = await fetch(`/api/comfy/meta?path=${encodeURIComponent(metaPath)}`)
        if (mr.ok) {
          const m = (await mr.json()) as {
            source_video?: { filename?: string; subfolder?: string }
            prompt?: string
          }
          if (m?.source_video?.filename) {
            source = {
              filename: m.source_video.filename,
              subfolder: m.source_video.subfolder ?? '',
            }
          }
          if (typeof m?.prompt === 'string') promptUsed = m.prompt
        }
      } catch { /* ниже — честная ошибка */ }
      if (!source) {
        q().setStatus(
          item.id,
          'error',
          'Рефайн «Частями» завершён, но страница была перезагружена: куски refinepart_* остались несшитыми (исходник не найден в метаданных кусков). Запустите рефайн заново.',
        )
        return
      }
      // stitch резолвит audioSource только в output/: у рефайна с диска
      // (inputSource) исходник лежит в input/ — тогда якорем существования
      // файла служит первый кусок (hard-склейка берёт звук из самих кусков).
      const audioSource =
        source.subfolder === 'input'
          ? { filename: parts[0].filename, subfolder: parts[0].subfolder || '' }
          : source
      const st = await fetch('/api/comfy/refine/stitch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chunkFiles: parts.map((o) => ({ filename: o.filename, subfolder: o.subfolder || '' })),
          audioSource,
          outSubfolder: source.subfolder === 'input' ? '' : source.subfolder,
          hard: true,
          meta: {
            prompt: promptUsed,
            model_type: 'minimax_h3_ref2va',
            workflow: 'refine-chunks-latent-chain',
            generation_mode: 'refine',
            refine_mode: 'chunks',
            source_video: source,
            chunks: parts.length,
            recovered_after_reload: true,
          },
        }),
      })
      const sd = (await st.json().catch(() => ({}))) as { error?: string }
      if (!st.ok || sd.error) {
        q().setStatus(
          item.id,
          'error',
          `Сшивка кусков после перезагрузки не удалась: ${sd.error || `HTTP ${st.status}`}. Куски refinepart_* остались в галерее.`,
        )
        return
      }
      q().setStatus(item.id, 'done')
      q().setProgress(item.id, 100, 100)
      useGalleryRefresh.getState().bump()
      return
    }
  } finally {
    orphanRecovery.delete(promptId)
  }
}
