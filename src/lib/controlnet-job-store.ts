'use client'

/**
 * (правка 497) ControlNetJobStore — состояние джоба вкладки «ControlNet»
 * ВНЕ React. Копия паттерна TileUpscaleJobStore (правки 319/330/491):
 *  • promptId/phase/progress/error — в zustand-сторе;
 *  • ОДИН модульный цикл опроса /api/comfy/status — переживает unmount;
 *  • по завершении — useGalleryRefresh.bump();
 *  • активный promptId персистится → re-attach после перезагрузки страницы;
 *  • эпоха отмены: cancel() во время летящего POST отменяет принятую задачу;
 *  • собственная отмена никогда не рисуется красным баннером ошибки.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { toast } from 'sonner'
import { useGalleryRefresh } from '@/lib/gallery-refresh-store'
import { useGenQueue } from '@/lib/gen-queue-store' // (правка 512) общая очередь
import { acquireComfyTurn, isComfyTurnActive } from '@/lib/comfy-turn'

export type ControlNetPhase = 'idle' | 'submitting' | 'running' | 'done' | 'error'

export interface ControlNetSubmitBody {
  inputSource?: string
  sourceFilename?: string
  sourceSubfolder?: string
  prompt?: string
  seed?: number
  duration?: number
  targetShortSide?: number
  controlType?: string
  [key: string]: unknown
}

interface ControlNetJobState {
  phase: ControlNetPhase
  progress: number
  error: string | null
  promptId: string | null
  startedAt: number | null
  busy: boolean

  submit: (body: ControlNetSubmitBody) => Promise<void>
  cancel: () => Promise<void>
  reset: () => void
}

const ACTIVE: ReadonlySet<ControlNetPhase> = new Set(['submitting', 'running'])

/* Эпоха отмены (правка 330): cancel() во время 'submitting' (POST ещё в
 * полёте, promptId нет) — submit() замечает смену эпохи после await POST
 * и сразу отменяет вернувшийся prompt_id. */
let cancelEpoch = 0

/** promptId, для которого пользователь запросил отмену. ComfyUI докладывает
 *  прерванную задачу в history как 'error' (execution_interrupted), а не
 *  'cancelled' — без пометки поллер рисовал собственную отмену красным
 *  баннером «Ошибка». */
let cancelRequestedFor: string | null = null

/** Какой queue-item сейчас владеет состоянием вкладки. Нужен, чтобы
 *  запоздавший ответ отменённого POST не перетёр состояние следующей
 *  задачи, которая уже получила ход. */
let activeQid: string | null = null

/** (правка 555) Пометить promptId как отменяемый — вызывается из
 *  QueueIndicator при отмене ControlNet-задачи ИЗ очереди: собственный
 *  поллер вкладки тогда воспримет последующий 'error' (interrupted) как
 *  чистую отмену, а не сбой. */
export function markControlNetCancelRequested(promptId: string) {
  cancelRequestedFor = promptId
}

export const useControlNetJob = create<ControlNetJobState>()(
  persist(
    (set, get) => ({
      phase: 'idle',
      progress: 0,
      error: null,
      promptId: null,
      startedAt: null,
      busy: false,

      submit: async (body) => {
        // (правка 512) Очередь: нет блокировки на busy — можно добавлять
        // несколько задач. Store отслеживает ПОСЛЕДНЮЮ отправленную задачу
        // (для статуса в UI), а gen-queue-store — все.
        // (правка 512) Регистрация в общей очереди
        const label = typeof body.sourceFilename === 'string' && body.sourceFilename
          ? `ControlNet: ${body.sourceFilename}`
          : 'ControlNet'
        const qid = useGenQueue.getState().enqueue('controlnet', label)

        // Единый FIFO: store вкладки не трогаем, пока не получили ход.
        // Иначе отмена ожидающей задачи оставила бы вкладку в busy.
        const granted = await acquireComfyTurn(qid)
        if (!granted || !isComfyTurnActive(qid)) return

        // Эпоху отмены фиксируем только на старте своей задачи, а не в
        // момент постановки: Cancel текущего джоба не должен отменять все
        // задачи, которые ещё стоят в очереди.
        const myEpoch = cancelEpoch
        cancelRequestedFor = null
        activeQid = qid
        set({ phase: 'submitting', busy: true, error: null, progress: 0, startedAt: Date.now() })

        try {
          const res = await fetch('/api/comfy/controlnet', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
          const data = await res.json()
          if (!res.ok) {
            useGenQueue.getState().setStatus(qid, 'error', data.error || `Ошибка ${res.status}`)
            throw new Error(data.error || `Ошибка ${res.status}`)
          }
          if (!data.prompt_id) {
            const msg = 'ComfyUI не вернул prompt_id'
            useGenQueue.getState().setStatus(qid, 'error', msg)
            throw new Error(msg)
          }
          // Отмена пришла, пока POST был в полёте: задача уже в ComfyUI —
          // отменяем её на сервере и НЕ запускаем поллинг.
          if (cancelEpoch !== myEpoch || !isComfyTurnActive(qid)) {
            if (data.prompt_id) {
              await fetch('/api/comfy/cancel', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt_id: data.prompt_id }),
              }).catch(() => {})
            }
            useGenQueue.getState().setStatus(qid, 'cancelled')
            if (activeQid === qid) {
              activeQid = null
              set({ phase: 'idle', busy: false, progress: 0, startedAt: null })
            }
            return
          }
          set({ promptId: data.prompt_id ?? null, phase: 'running' })
          useGenQueue.getState().setPromptId(qid, data.prompt_id)
          useGenQueue.getState().setStatus(qid, 'running')
          toast.success('ControlNet-генерация запущена')
          ensurePolling()
        } catch (e) {
          if (!useGenQueue.getState().items.find((i) => i.id === qid)?.error) {
            useGenQueue.getState().setStatus(qid, 'error', e instanceof Error ? e.message : String(e))
          }
          if (activeQid === qid) {
            activeQid = null
            set({ phase: 'error', error: e instanceof Error ? e.message : String(e), busy: false })
          }
        }
      },

      cancel: async () => {
        // Ломаем эпоху ДО проверки promptId: если POST ещё в полёте,
        // продолжение submit() увидит смену и отменит принятую задачу само.
        cancelEpoch++
        const { promptId, phase } = get()
        if (!promptId) {
          if (phase === 'submitting') {
            set({ phase: 'idle', busy: false, progress: 0, startedAt: null })
            toast.info('Отменено')
          }
          return
        }
        // После ПОДТВЕРЖДЁННОЙ сервером отмены — сразу чистый idle и стоп
        // поллинга (правка 491).
        let cancelled = false
        try {
          cancelRequestedFor = promptId
          const res = await fetch('/api/comfy/cancel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt_id: promptId }),
          })
          const data = await res.json().catch(() => ({}))
          cancelled = res.ok && data.ok !== false
        } catch { /* ignore */ }
        if (cancelled) {
          cancelRequestedFor = null
          // (правка 555) Помечаем элемент общей очереди отменённым — раньше
          // карточка в QueueIndicator оставалась «running» без своего
          // поллера и через ~2 мин перекатывалась в «Ошибка» / «Задача не найдена».
          const qi = useGenQueue.getState().items.find((i) => i.promptId === promptId)
          if (qi) useGenQueue.getState().setStatus(qi.id, 'cancelled')
          // Если следующая задача уже получила ход, не останавливаем её
          // поллер и не затираем её состояние.
          if (activeQid === null || activeQid === qi?.id) {
            activeQid = null
            stopPolling()
            set({ phase: 'idle', progress: 0, busy: false, promptId: null, startedAt: null })
          }
          toast.info('Отменено')
        } else {
          cancelRequestedFor = null
          toast.error('Отмена не подтверждена сервером — проверьте, что ComfyUI запущен')
        }
      },

      reset: () => {
        cancelEpoch++
        cancelRequestedFor = null
        activeQid = null
        stopPolling()
        set({ phase: 'idle', progress: 0, error: null, promptId: null, startedAt: null, busy: false })
      },
    }),
    {
      name: 'controlnet-job',
      partialize: (s) =>
        ACTIVE.has(s.phase) ? { promptId: s.promptId, startedAt: s.startedAt, phase: s.phase } : {},
      onRehydrateStorage: () => (state) => {
        if (state?.promptId && ACTIVE.has(state.phase)) {
          state.busy = true
          ensurePolling()
          void pollOnce()
        }
      },
    },
  ),
)

/* ─── Модульный поллинг /api/comfy/status (живёт вне React) ─── */

const POLL_MS = 2000
let pollTimer: ReturnType<typeof setInterval> | null = null
let pollInFlight = false
let unknownStreak = 0

function ensurePolling() {
  if (pollTimer) return
  unknownStreak = 0
  pollTimer = setInterval(() => void pollOnce(), POLL_MS)
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
  unknownStreak = 0
}

async function pollOnce() {
  if (pollInFlight) return
  const s = useControlNetJob.getState()
  const promptId = s.promptId
  if (!promptId || !ACTIVE.has(s.phase)) {
    stopPolling()
    return
  }
  pollInFlight = true
  try {
    const res = await fetch(`/api/comfy/status?prompt_id=${encodeURIComponent(promptId)}`, {
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) {
      // Не-OK ответ (502 — ComfyUI лежит/перезапускается) считаем как
      // 'unknown' (правка 491): иначе при мёртвом ComfyUI «Генерация идёт…»
      // висела бы бесконечно.
      unknownStreak++
      if (unknownStreak >= 10) {
        useControlNetJob.setState({
          phase: 'error',
          error: 'ComfyUI не отвечает (сервер остановлен или перезапущен) — отслеживание остановлено',
          busy: false,
        })
        stopPolling()
      }
      return
    }
    const data = await res.json()
    const cur = useControlNetJob.getState()
    if (cur.promptId !== promptId) return // уже другой джоб
    if (data.status === 'done') {
      useControlNetJob.setState({ phase: 'done', progress: 100, busy: false })
      // (правка 512) Обновляем очередь
      const qi = useGenQueue.getState().items.find((i) => i.promptId === promptId)
      if (qi) useGenQueue.getState().setStatus(qi.id, 'done')
      useGalleryRefresh.getState().bump()
      stopPolling()
      setTimeout(() => {
        const c = useControlNetJob.getState()
        if (c.promptId === promptId && c.phase === 'done') useControlNetJob.setState({ promptId: null })
      }, 7000)
    } else if (data.status === 'cancelled') {
      cancelRequestedFor = null
      useControlNetJob.setState({ phase: 'idle', progress: 0, busy: false, promptId: null, startedAt: null })
      // (правка 512)
      const qi2 = useGenQueue.getState().items.find((i) => i.promptId === promptId)
      if (qi2) useGenQueue.getState().setStatus(qi2.id, 'cancelled')
      stopPolling()
    } else if (data.status === 'error') {
      if (cancelRequestedFor === promptId) {
        cancelRequestedFor = null
        useControlNetJob.setState({ phase: 'idle', progress: 0, busy: false, promptId: null, startedAt: null })
        const qi3 = useGenQueue.getState().items.find((i) => i.promptId === promptId)
        if (qi3) useGenQueue.getState().setStatus(qi3.id, 'cancelled')
      } else {
        useControlNetJob.setState({
          phase: 'error',
          error: data.error || data.detail || 'Ошибка генерации',
          busy: false,
        })
        // (правка 512)
        const qi4 = useGenQueue.getState().items.find((i) => i.promptId === promptId)
        if (qi4) useGenQueue.getState().setStatus(qi4.id, 'error', data.error || 'Ошибка')
      }
      stopPolling()
    } else if (data.status === 'unknown') {
      if (cancelRequestedFor === promptId) {
        cancelRequestedFor = null
        useControlNetJob.setState({ phase: 'idle', progress: 0, busy: false, promptId: null, startedAt: null })
        stopPolling()
        return
      }
      unknownStreak++
      if (unknownStreak >= 10) {
        useControlNetJob.setState({
          phase: 'error',
          error: 'Задача не найдена в ComfyUI (сервер был перезапущен) — отслеживание остановлено',
          busy: false,
        })
        stopPolling()
      }
    } else {
      unknownStreak = 0
      // Прогресс из трекера (/api/comfy/progress) — по счётчику KJ-событий.
      try {
        const progRes = await fetch(`/api/comfy/progress?prompt_id=${encodeURIComponent(promptId)}`)
        if (progRes.ok) {
          const progData = await progRes.json()
          if (progData.progress && typeof progData.progress.percent === 'number') {
            useControlNetJob.setState({ progress: progData.progress.percent })
          }
        }
      } catch { /* non-critical */ }
    }
  } catch {
    /* transient — следующий тик попробует снова */
  } finally {
    pollInFlight = false
  }
}
