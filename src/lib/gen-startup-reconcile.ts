/**
 * (правка 718) Сверка персистентного состояния «генерация идёт» с живым
 * ComfyUI при запуске приложения.
 *
 * Проблема: стор `gen-progress` (и очередь `gen-queue`) сохраняются в
 * localStorage. При перезапуске приложения они восстанавливают фазу
 * 'running'/'queued' — и карточка «Генерация идёт» сразу показывается,
 * хотя генерации давно нет (ComfyUI был перезапущен, задача упала, компьютер
 * перезагрузили). Пользователь видит «идёт генерация», хотя ничего не
 * происходит, и кнопка «Сгенерировать» заблокирована.
 *
 * Что делаем: один раз за сессию спрашиваем ComfyUI, какие prompt_id
 * реально в очереди/выполняются, и снимаем «зависшее» состояние.
 *
 * Важные правила:
 *   • Если ComfyUI НЕ ОТВЕЧАЕТ (поднимается) — состояние НЕ трогаем:
 *     мы не знаем, что происходит, и не имеем права врать.
 *   • Если задача в ComfyUI есть — оставляем «идёт» как есть, поллеры
 *     переподключатся и сами доведут задачу до конца.
 *   • Если задачи в ComfyUI нет — снимаем фазу «идёт» и помечаем элемент
 *     очереди как прерванный (с понятным текстом, а не молчаливый висяк).
 */
import { useGenProgress } from './gen-progress-store'
import { useGenQueue } from './gen-queue-store'
import { useControlNetJob } from './controlnet-job-store'
import { useFpsJob } from './fps-job-store'
import { useTileUpscaleJob } from './tile-upscale-job-store'
import { useFaceRefineJob } from './face-refine-job-store'

/** Фазы, в которых карточка показывает «генерация идёт». */
const ACTIVE_PHASES = ['submitting', 'queued', 'running'] as const

/** Запущено ли уже (за сессию) — повторно не сверяем. */
let started = false
/** Отменён ли (компонент размонтировался до ответа). */
let cancelled = false

/**
 * Сверить состояние. Возвращает промис, который резолвится, когда сверка
 * завершена (успешной ИЛИ окончательно невозможной).
 */
export function reconcileGenerationOnStartup(): Promise<void> {
  if (started) return Promise.resolve()
  started = true
  cancelled = false
  return run().catch(() => {
    /* сверка не критична — молча продолжаем */
  })
}

async function run(): Promise<void> {
  // ComfyUI поднимается ~30-60 с. Пока он не отвечает — сверять нечего, но и
  // сбрасывать нельзя. Ждём до 5 минут и сверяем на ПЕРВЫЙ удачный ответ.
  const deadline = Date.now() + 5 * 60_000
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

  for (;;) {
    if (cancelled) return
    // Кандидаты на проверку: карточка прогресса + активные элементы очереди.
    const candidates = collectCandidates()
    const answer = await fetchActive(candidates)
    if (answer) {
      applyReconciliation(answer)
      return
    }
    if (Date.now() > deadline) return
    await delay(2500)
  }
}

/** prompt_id, которые могут выглядеть «висящими». */
function collectCandidates(): string[] {
  const out = new Set<string>()
  const video = useGenProgress.getState().video
  if (video.promptId && (ACTIVE_PHASES as readonly string[]).includes(video.phase)) {
    out.add(video.promptId)
  }
  for (const it of useGenQueue.getState().items) {
    if (it.status !== 'queued' && it.status !== 'running') continue
    if (it.promptId) out.add(it.promptId)
  }
  // Отдельные сторы вкладок ControlNet / FPS / Tile Upscale — у них свой
  // персистентный 'busy' и своя карточка статуса.
  const cn = useControlNetJob.getState()
  if (cn.busy && cn.promptId) out.add(cn.promptId)
  const fps = useFpsJob.getState()
  if (fps.busy && fps.promptId) out.add(fps.promptId)
  const tu = useTileUpscaleJob.getState()
  if (tu.busy && tu.promptId) out.add(tu.promptId)
  const fr = useFaceRefineJob.getState()
  if (fr.busy && fr.promptId) out.add(fr.promptId)
  return [...out]
}

interface ActiveAnswer {
  /** prompt_id, реально живые в очереди ComfyUI. */
  alive: Set<string>
  /** Уточнённое состояние запрошенных промптов. */
  states: Record<string, 'alive' | 'done' | 'gone'>
}

/** Состояние ComfyUI. null — ComfyUI не ответил (сверять нельзя). */
async function fetchActive(candidates: string[]): Promise<ActiveAnswer | null> {
  try {
    const qs = candidates.length ? `?check=${encodeURIComponent(candidates.join(','))}` : ''
    const res = await fetch(`/api/comfy/active${qs}`, { cache: 'no-store' })
    if (!res.ok) return null
    const data = (await res.json()) as {
      ok?: boolean
      prompts?: string[]
      states?: Record<string, 'alive' | 'done' | 'gone'>
    }
    // ok === false → ComfyUI недоступен, ответ неинформативен.
    if (data.ok !== true) return null
    return {
      alive: new Set(Array.isArray(data.prompts) ? data.prompts : []),
      states: data.states ?? {},
    }
  } catch {
    return null
  }
}

function applyReconciliation(answer: ActiveAnswer): void {
  const { alive, states } = answer
  const gone = (id: string) => states[id] === 'gone'

  // ── 1) Карточка «Генерация идёт» ──
  const video = useGenProgress.getState().video
  if (video.promptId && (ACTIVE_PHASES as readonly string[]).includes(video.phase)) {
    // «Нет в очереди» ещё не значит «прервана»: задача могла только что
    // завершиться (ComfyUI переносит её в history). Сбрасываем только когда
    // ComfyUI о таком промпте вообще не знает ('gone').
    if (!alive.has(video.promptId) && gone(video.promptId)) {
      console.log(
        `[reconcile] генерация ${video.promptId} в ComfyUI отсутствует — снимаем фазу «${video.phase}»`,
      )
      useGenProgress.getState().resetVideoGen()
    }
  }

  // ── 2) Элементы очереди в активных статусах ──
  // «submitting» без prompt_id — это задача, чей POST /generate был в полёте
  // на момент закрытия приложения. Её разбирает существующая логика
  // восстановления через журнал inflight (use-video-gen) — не трогаем.
  const items = useGenQueue.getState().items
  for (const it of items) {
    if (it.status !== 'queued' && it.status !== 'running') continue
    if (!it.promptId) continue
    if (alive.has(it.promptId)) continue
    if (!gone(it.promptId)) continue
    console.log(
      `[reconcile] задача ${it.promptId} в ComfyUI отсутствует — помечаем прерванной`,
    )
    useGenQueue
      .getState()
      .setStatus(it.id, 'error', 'Прервана: приложение было перезапущено, генерации в ComfyUI нет')
  }

  // ── 3) Отдельные сторы вкладок ControlNet / FPS / Tile Upscale ──
  // У них свой персистентный 'busy': после перезапуска вкладка тоже показывала
  // «генерация идёт», пока их поллер не набирал неизвестных ответов.
  const cn = useControlNetJob.getState()
  if (cn.busy && cn.promptId && !alive.has(cn.promptId) && gone(cn.promptId)) {
    console.log(`[reconcile] ControlNet ${cn.promptId} в ComfyUI отсутствует — снимаем busy`)
    useControlNetJob.getState().reset()
  }
  const fps = useFpsJob.getState()
  if (fps.busy && fps.promptId && !alive.has(fps.promptId) && gone(fps.promptId)) {
    console.log(`[reconcile] FPS ${fps.promptId} в ComfyUI отсутствует — снимаем busy`)
    useFpsJob.getState().reset()
  }
  const tu = useTileUpscaleJob.getState()
  if (tu.busy && tu.promptId && !alive.has(tu.promptId) && gone(tu.promptId)) {
    console.log(`[reconcile] Tile Upscale ${tu.promptId} в ComfyUI отсутствует — снимаем busy`)
    useTileUpscaleJob.getState().reset()
  }
  const fr = useFaceRefineJob.getState()
  if (fr.busy && fr.promptId && !alive.has(fr.promptId) && gone(fr.promptId)) {
    console.log(`[reconcile] Face Refine ${fr.promptId} в ComfyUI отсутствует — снимаем busy`)
    useFaceRefineJob.getState().reset()
  }
}

/** Отменить ожидание (вызывается при размонтировании). */
export function cancelReconcile(): void {
  cancelled = true
}

/**
 * Почистить элементы общей очереди, которые после перезапуска приложения
 * уже некому отправить. Очередь persisted, а payload/ожидающие промисы живут
 * только в памяти страницы. У видео есть отдельное inflight-восстановление
 * через clientToken, поэтому `submitting`-видео не трогаем; `queued`-видео
 * означает, что оно ждало ход и не было отправлено.
 */
export function cleanupLostPendingQueueItems(): void {
  const { items, setStatus } = useGenQueue.getState()
  for (const item of items) {
    if (item.promptId) continue
    if (item.type === 'upscale') continue // DLSS живёт отдельно
    if (item.status !== 'submitting' && item.status !== 'queued') continue
    if (item.type === 'video' && item.status === 'submitting') continue

    setStatus(
      item.id,
      'error',
      'Приложение было перезапущено — задача не была отправлена. Запустите её заново.',
    )
  }

  // Если потерянная задача была видео, карточка «Отправка…/В очереди» могла
  // остаться в persisted gen-progress. Не сбрасываем её, пока есть шанс
  // восстановить POST через clientToken (`submitting` без promptId).
  const itemsNow = useGenQueue.getState().items
  const hasRecoverableVideo = itemsNow.some(
    (item) =>
      item.type === 'video' &&
      (!!item.promptId ||
        item.status === 'submitting' ||
        item.status === 'running' ||
        item.status === 'queued'),
  )
  if (!hasRecoverableVideo) {
    const video = useGenProgress.getState().video
    if (video.phase === 'submitting' || video.phase === 'queued') {
      useGenProgress.getState().resetVideoGen()
    }
  }
}
