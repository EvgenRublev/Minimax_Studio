/**
 * ComfyUI client for MiniMax H3 video generation.
 *
 * Endpoints:
 *   POST /prompt          — submit workflow
 *   GET  /history/:id     — result
 *   GET  /queue           — current queue state
 *   POST /upload/image    — upload reference images
 *   GET  /view            — serve output files
 */

import { buildMiniMaxH3Workflow, videoSamplerStages, type MiniMaxH3Params } from './minimax-h3-template'
import { buildRefineWorkflow, type RefineParams } from './refine-template'
import { getClientId, registerPromptStages, type TileGeometry } from './progress-tracker'
import { getVideoFormatSettings } from '../video-format-server' // (правка 386)

export const COMFY_URL =
  process.env.COMFY_URL?.replace(/\/+$/, '') || 'http://127.0.0.1:8188'

/**
 * (фикс Phase 6) Рутинные логи опроса статуса ([status] … RUNNING/QUEUED/…)
 * заспамили консоль start.bat — по строке на каждый тик поллинга (1/с на
 * задачу) и пугали пользователя. Теперь они видны ТОЛЬКО при запуске с
 * переменной окружения H3_DEBUG=1. Предупреждения об аномалиях (NOT FOUND,
 * ошибки выполнения) остаются в консоли всегда.
 */
const statusDbg = process.env.H3_DEBUG
  ? (...args: unknown[]) => console.log('[status]', ...args)
  : () => {}

export interface SubmitResult {
  prompt_id: string
  number?: number
}

/** (правка 161) Descriptor возвращаемый нодой MiniMaxH3Extender после
 *  upload картинки-рефа через /h3_extender/ref/upload. ID — 64 hex-символа
 *  (content-addressed), не имя файла из input/ ComfyUI. */
export interface ExtenderRefDescriptor {
  id: string
  source_id?: string
  original_name?: string
  width?: number
  height?: number
  size_bytes?: number
  saturation?: number
  contrast?: number
  brightness?: number
}

/** (правка 161) Upload одной картинки-рефа в внутренний кэш Extender-ноды.
 *  В отличие от uploadImage() — это НЕ имя файла в input/ ComfyUI, а
 *  content-addressed descriptor, который нода понимает и использует сама.
 *  Возвращает descriptor (id — 64 hex). */
export async function uploadExtenderRef(
  buffer: Buffer,
  filename: string,
  timeoutMs = 120_000,
): Promise<ExtenderRefDescriptor> {
  const form = new FormData()
  form.append('ref_file', new Blob([new Uint8Array(buffer)]), filename)
  const res = await fetch(`${COMFY_URL}/h3_extender/ref/upload`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Extender ref upload failed (${res.status}): ${text.slice(0, 300)}`)
  }
  const data = (await res.json()) as { ok: boolean; ref?: ExtenderRefDescriptor; error?: string }
  if (!data.ok || !data.ref?.id) {
    throw new Error(`Extender ref upload: ${data.error || 'no ref returned'}`)
  }
  return data.ref
}

export interface StatusResult {
  status: 'queued' | 'running' | 'done' | 'error' | 'unknown'
  progress?: number
  detail?: string
  /** Output files when done. */
  outputs?: Array<{ filename: string; subfolder: string; type: string }>
}

/**
 * Upload an image (or any reference file, e.g. a video) to ComfyUI's input
 * directory. Returns the filename. Large video references can take a while —
 * pass a longer timeout (or rely on the 5-minute default).
 */
export async function uploadImage(
  buffer: Buffer | Blob,
  filename: string,
  timeoutMs = 300_000,
): Promise<string> {
  const form = new FormData()
  // (правка 347) Blob (например, fs.openAsBlob) — потоковая отдача тела
  // без буферизации всего файла в heap.
  const blob = buffer instanceof Blob ? buffer : new Blob([new Uint8Array(buffer)])
  form.append('image', blob, filename)
  form.append('subfolder', '')
  form.append('type', 'input')

  const res = await fetch(`${COMFY_URL}/upload/image`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Upload failed (${res.status}): ${text.slice(0, 200)}`)
  }
  const data = await res.json()
  return data.name as string
}

/** Submit a MiniMax H3 workflow. Returns prompt_id. */
export async function submitVideo(params: MiniMaxH3Params): Promise<SubmitResult> {
  const workflow = buildMiniMaxH3Workflow({ ...params, videoFormat: getVideoFormatSettings() }) // (правка 386)
  // (правка 255) стадии сэмплеров → честный 0–100% в трекере
  return submitWorkflowJson(workflow, videoSamplerStages(params))
}

/**
 * Submit a Refine workflow (generative v2v upscale: encoded source latent →
 * LatentUpscaler3D → short Pass-2-style sampling).
 * Same VHS output options as submitVideo (no PNG poster / silent intermediate).
 */
export async function submitRefine(params: RefineParams): Promise<SubmitResult> {
  const workflow = buildRefineWorkflow({ ...params, videoFormat: getVideoFormatSettings() }) // (правка 386)
  // (правка 255) единственный проход — шкала 0–100 без деления на 2
  return submitWorkflowJson(workflow, [['46:21']])
}

/** POST an API-format workflow to ComfyUI /prompt. */
export async function submitWorkflowJson(
  workflow: Record<string, unknown>,
  stages?: string[][],
  tileGeometry?: TileGeometry | null, // (правка 479)
): Promise<SubmitResult> {
  const body = {
    prompt: workflow,
    client_id: getClientId(),
    // VideoHelperSuite (VHS_VideoCombine) otherwise writes THREE files per
    // generation: the first-frame PNG poster, an intermediate SILENT video,
    // and the muxed video-with-audio. We only want the audio video (+ our own
    // .meta.json sidecar). These VHS options are read from
    // extra_pnginfo.workflow.extra — skip the PNG and delete the silent video
    // so the output folder ends up clean.
    extra_data: {
      extra_pnginfo: {
        workflow: {
          extra: {
            VHS_MetadataImage: false,
            VHS_KeepIntermediate: false,
          },
        },
      },
    },
  }

  let res: Response
  try {
    res = await fetch(`${COMFY_URL}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (err) {
    throw new Error(
      `ComfyUI не отвечает на ${COMFY_URL}. ` +
        `Запустите ComfyUI и проверьте порт. (${String(err)})`,
    )
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    // (правка 504) Детектируем «модели не найдены» (value_not_in_list для
    // vae_name / unet_name / clip_name / tiny_vae) — даём дружелюбное
    // сообщение вместо сырого JSON-ошибки.
    let msg = `ComfyUI отклонил воркфлоу (HTTP ${res.status}): ${detail.slice(0, 500)}`
    try {
      const parsed = JSON.parse(detail)
      const nodeErrors: Record<string, { errors?: Array<{ type?: string; details?: string }> }> |
        undefined = parsed.node_errors
      if (nodeErrors && typeof nodeErrors === 'object') {
        const isModelMissing = Object.values(nodeErrors).some((ne) =>
          Array.isArray(ne?.errors) && ne.errors.some((e) =>
            e.type === 'value_not_in_list' &&
            /not in \[/.test(e.details || '') &&
            /(_vae|_unet|clip_name|tiny_vae|model_name|unet_name|vae_name|clip_name)/.test(e.details || ''),
          ),
        )
        if (isModelMissing) {
          msg =
            'Модели не найдены на диске. ' +
            'Откройте «Настройки → Модели» и скачайте необходимые файлы, ' +
            'либо положите их вручную в ComfyUI-Easy-Install/ComfyUI/models/ (vae/, text_encoders/, diffusion_models/).'
        }
      }
    } catch { /* не JSON — оставляем оригинальное сообщение */ }
    throw new Error(msg)
  }

  const data = (await res.json()) as SubmitResult
  if (!data.prompt_id) throw new Error('ComfyUI вернул ответ без prompt_id.')
  // (правка 255) регистрируем стадии ДО первых WS-событий промпта
  // (правка 479) + tile-геометрию для монотонного прогресса tile-upscale
  if (stages && stages.length > 0) {
    registerPromptStages(data.prompt_id, stages, tileGeometry)
  }
  return data
}

/**
 * (фикс) Ретраи при сетевых сбоях. Раньше один обрыв TCP (WinError 10054)
 * = getStatus возвращал 'unknown' → клиент считал это ошибкой и падал.
 * Теперь автоматически повторяем 2 раза с задержкой 1с, 2с.
 */
export async function getStatusWithRetry(promptId: string, maxRetries = 2): Promise<StatusResult> {
  let lastError: Error | null = null
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        // Экспоненциальная задержка: 1с, 2с
        // (правка 587) pow(2, attempt-1) — как model-downloader: было 2с/4с
        const delay = Math.pow(2, attempt - 1) * 1000
        await new Promise(r => setTimeout(r, delay))
      }
      
      return await getStatus(promptId)
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e))
      
      // Если это последний ретрай — бросаем ошибку
      if (attempt === maxRetries) {
        throw lastError
      }
      
      // Иначе — пробуем снова
    }
  }
  
  throw lastError || new Error('Unknown error')
}

/** Poll the status of a submitted prompt. */
export async function getStatus(promptId: string): Promise<StatusResult> {
  statusDbg(`getStatus(${promptId})`)
  // (фикс) Увеличенные таймауты для видео генерации. Раньше 5 секунд было
  // мало — при длинной генерации TCP-соединение разрывалось (WinError 10054),
  // и getStatus возвращал 'unknown' → клиент считал это ошибкой.
  // Теперь 30 секунд — достаточно даже для медленных машин.
  const histRes = await fetch(`${COMFY_URL}/history/${promptId}`, {
    signal: AbortSignal.timeout(30_000),
  }).catch(() => null)

  if (histRes && histRes.ok) {
    const hist = await histRes.json()
    const entry = hist[promptId]
    if (entry) {
      const statusStr = entry.status?.status_str?.toLowerCase() ?? ''
      // (правка 432) status.messages — это МАССИВ ПАР [type, data]
      // (['execution_error', {...}], ['execution_start', {...}], ...), а не
      // объектов {type, data}. Старый find(m.type === 'execution_error')
      // никогда не срабатывал → errMsg undefined → detail = голое «error»
      // без причины (в логе: «ERROR from history — error undefined»).
      // Ищем в ОБОИХ форматах (tuple и объект) — ComfyUI-версии разнятся.
      const msgs: unknown[] = Array.isArray(entry.status?.messages) ? entry.status.messages : []
      const pickMsg = (pred: (t: unknown, d: unknown) => boolean) => {
        for (const m of msgs) {
          if (Array.isArray(m)) {
            if (pred(m[0], m[1])) return m[1]
          } else if (m && typeof m === 'object') {
            const o = m as { type?: unknown; data?: unknown }
            if (pred(o.type, o.data)) return o.data
          }
        }
        return undefined
      }
      const errData =
        pickMsg((t) => t === 'execution_error') ??
        pickMsg((t) => typeof t === 'string' && t.toLowerCase().includes('error'))

      if (errData !== undefined || statusStr.includes('error')) {
        const ed = (errData ?? {}) as {
          exception_message?: string
          exception_type?: string
          node_type?: string
          node_id?: string | number
        }
        // Читаемая причина сбоя: exception_message + тип исключения + нода.
        const reason =
          (typeof ed.exception_message === 'string' && ed.exception_message.trim()) ||
          (typeof ed.exception_type === 'string' && ed.exception_type.trim()) ||
          (entry.status?.status_str && entry.status.status_str !== 'error' ? entry.status.status_str : '') ||
          'Ошибка выполнения в ComfyUI'
        const node = ed.node_type
          ? ` [нода: ${ed.node_type}${ed.node_id != null ? ` #${ed.node_id}` : ''}]`
          : ''
        // Однострочник с капом: traceback-строки и \n не даём в баннер/очередь.
        const detail = `${reason}${node}`.replace(/\s+/g, ' ').slice(0, 500)
        console.warn(`[status] ${promptId}: ERROR from history —`, detail)
        return {
          status: 'error',
          detail,
        }
      }

      // Extract outputs — check ALL keys for file arrays (robust to different node output names)
      const outputs: Array<{ filename: string; subfolder: string; type: string }> = []
      for (const nodeOutput of Object.values(entry.outputs ?? {})) {
        const o = nodeOutput as Record<string, unknown>
        for (const val of Object.values(o)) {
          if (Array.isArray(val)) {
            for (const item of val) {
              if (item && typeof item === 'object' && 'filename' in item) {
                outputs.push(item as { filename: string; subfolder: string; type: string })
              }
            }
          }
        }
      }
      statusDbg(`${promptId}: DONE`)
      return { status: 'done', outputs }
    }
    // No entry in history — fall through to queue check
    statusDbg(`${promptId}: not in history, checking queue...`)
  } else {
    statusDbg(`${promptId}: history request failed (histRes=${!!histRes}, ok=${histRes?.ok})`)
  }

  // Check queue
  // (фикс) Увеличенный таймаут — см. выше
  const queueRes = await fetch(`${COMFY_URL}/queue`, {
    signal: AbortSignal.timeout(30_000),
  }).catch(() => null)

  if (queueRes && queueRes.ok) {
    const queue = await queueRes.json()
    const running = queue.queue_running ?? []
    const pending = queue.queue_pending ?? []

    // ComfyUI queue format: [[number, prompt_id, prompt, ...], ...]
    // item[0] = queue number (int), item[1] = prompt_id (string)
    if (running.some((item: unknown[]) => item[1] === promptId)) {
      statusDbg(`${promptId}: RUNNING`)
      return { status: 'running' }
    }
    if (pending.some((item: unknown[]) => item[1] === promptId)) {
      statusDbg(`${promptId}: QUEUED`)
      return { status: 'queued' }
    }
    statusDbg(`${promptId}: NOT in queue (running=${running.length}, pending=${pending.length})`)
  } else {
    statusDbg(`${promptId}: queue request failed (queueRes=${!!queueRes})`)
  }

  // Оба запроса упали — ComfyUI недоступен/перезапускается. Это НЕ «queued»:
  // раньше такой ответ бесконечно показывал «В очереди…», пока не истекал
  // 60-минутный таймаут. Клиент считает подряд идущие 'unknown' и падает
  // в ошибку после N попыток.
  if (!histRes && !queueRes) {
    return { status: 'unknown', detail: 'ComfyUI не отвечает' }
  }

  // Not in queue and not in history. ComfyUI answers (both requests
  // succeeded) but this prompt_id is nowhere to be found — it was either
  // rejected (execution error that ComfyUI didn't record in /history for
  // this client_id), lost (ComfyUI restart), or never properly queued.
  //
  // Returning 'queued' here was a trap: the client polls forever, shows
  // «Генерация…» for the full 60-minute timeout, and the user sees a
  // phantom generation. Returning 'unknown' lets the client's consecutive-
  // unknown counter kick in (20 polls × 1s = 20s) and surface a clear
  // error: «ComfyUI не отвечает» — which, while slightly misleading in
  // this specific case (ComfyUI IS responding), is far better than
  // waiting an hour for a job that will never finish.
  console.warn(
    `[status] ${promptId}: NOT FOUND — ComfyUI отвечает (history+queue OK), ` +
    `но prompt_id отсутствует в обоих. Возможно, ComfyUI отклонил задачу, ` +
    `или был перезапущен. Возвращаю 'unknown'.`
  )
  return { status: 'unknown', detail: 'Задача не найдена в ComfyUI (отклонена или потеряна)' }
}

/**
 * Cancel a specific prompt (правка 145).
 *
 * ГЛАВНОЕ: /interrupt убивает ТЕКУЩУЮ выполняющуюся задачу ComfyUI — независимо
 * от того, какой prompt_id мы имеем в виду. Раньше /interrupt слался ВСЕГДА:
 * удаление ОЖИДАЮЩЕЙ задачи (или уже завершённой) прерывало ЧУЖУЮ идущую
 * генерацию (баг: «удалил последнюю из трёх — прервалась та, что генерировалась»).
 *
 * Теперь:
 *  • задача ВЫПОЛНЯЕТСЯ → /interrupt + удалить из очереди;
 *  • задача ОЖИДАЕТ → только удалить из очереди; затем перепроверка: если за
 *    это время она успела стартовать (гонка pending→running между GET и
 *    DELETE) — прерываем именно её;
 *  • задачи нет в очереди (завершена/потеряна) → ничего не делаем, /interrupt
 *    не трогаем.
 */
export async function cancelPrompt(promptId: string): Promise<void> {
  // (правка 356) null = /queue недоступен (сетевой сбой/ComfyUI лежит).
  // Раньше это молча трактовалось как «задачи нет» → no-op, а клиент
  // получал ok:true — «отмена» не происходила.
  const inQueueState = async (): Promise<{ running: boolean; pending: boolean } | null> => {
    try {
      const res = await fetch(`${COMFY_URL}/queue`, { signal: AbortSignal.timeout(5_000) })
      if (!res.ok) return null
      const q = await res.json()
      const match = (arr: unknown[]) => (arr ?? []).some((item) => Array.isArray(item) && item[1] === promptId)
      return {
        running: match(q.queue_running),
        pending: match(q.queue_pending),
      }
    } catch {
      return null
    }
  }
  const deleteFromQueue = () =>
    fetch(`${COMFY_URL}/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delete: [promptId] }),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => {})
  const interruptRunning = () =>
    fetch(`${COMFY_URL}/interrupt`, { method: 'POST' }).catch(() => {})

  const state = await inQueueState()
  if (state === null) {
    // (правка 356) /queue недоступен — не молчим: вызывающий роут вернёт ошибку.
    throw new Error('ComfyUI /queue недоступен — отмена не выполнена')
  }

  if (state.running) {
    // Наша задача исполняется: прерываем и вычищаем остатки из очереди.
    await interruptRunning()
    await deleteFromQueue()
    return
  }
  if (state.pending) {
    // Только удаление из очереди — НЕ трогаем чужую выполняющуюся задачу.
    await deleteFromQueue()
    // Гонка: задача могла стартовать между GET и DELETE — тогда DELETE её не
    // взял, и она теперь running. Перепроверяем и прерываем ИМЕННО её.
    const after = await inQueueState()
    if (after?.running) await interruptRunning()
    return
  }
  // Задачи в очереди нет (завершена/отклонена/потеряна): полный no-op.
  // Раньше здесь уходил безусловный /interrupt — и убивал чужую генерацию.
}

/** Build a URL for viewing a generated file. */
export function fileUrl(filename: string, subfolder = '', type = 'output'): string {
  const params = new URLSearchParams({ filename, subfolder, type })
  return `${COMFY_URL}/view?${params}`
}
