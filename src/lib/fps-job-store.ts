'use client'

/**
 * (правка 554) FpsJobStore — состояние джоба вкладки «FPS» ВНЕ React.
 * Копия паттерна ControlNetJobStore (правки 319/330/491/497/512):
 *  • promptId/phase/progress/error — в zustand-сторе, а не в useState вида;
 *    раньше FpsView держал их локально — смена вкладки размонтировала
 *    компонент, поллинг умирал, статус сбрасывался, задача становилась
 *    «сиротой» (кнопка снова активна → повторный клик = вторая задача);
 *  • ОДИН модульный цикл опроса /api/comfy/status — переживает unmount;
 *  • по завершении — useGalleryRefresh.bump();
 *  • активный promptId персистится → re-attach после перезагрузки страницы;
 *  • (правка 554) регистрация в общей очереди (useGenQueue, тип 'fps') —
 *    QueueIndicator видит задачу и переживает перезагрузку вместе с ней;
 *  • эпоха отмены: cancel() во время летящего POST отменяет принятую задачу;
 *  • собственная отмена никогда не рисуется красным баннером ошибки.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { toast } from 'sonner'
import { useGalleryRefresh } from '@/lib/gallery-refresh-store'
import { useGenQueue } from '@/lib/gen-queue-store'
import { acquireComfyTurn, isComfyTurnActive } from '@/lib/comfy-turn'

export type FpsPhase = 'idle' | 'submitting' | 'running' | 'done' | 'error'

export interface FpsSubmitBody {
  inputSource?: string
  sourceFilename?: string
  sourceSubfolder?: string
  mode?: string
  multiplier?: number
  [key: string]: unknown
}

interface FpsJobState {
  phase: FpsPhase
  progress: number
  error: string | null
  promptId: string | null
  startedAt: number | null
  busy: boolean

  submit: (body: FpsSubmitBody) => Promise<void>
  cancel: () => Promise<void>
  reset: () => void
}

const ACTIVE: ReadonlySet<FpsPhase> = new Set(['submitting', 'running'])

/* Эпоха отмены (как правка 330 в ControlNet): cancel() во время
 * 'submitting' (POST ещё в полёте, promptId нет) — submit() замечает смену
 * эпохи после await POST и сразу отменяет вернувшийся prompt_id. */
let cancelEpoch = 0

/** promptId, для которого пользователь запросил отмену. ComfyUI докладывает
 *  прерванную задачу в history как 'error' (execution_interrupted), а не
 *  'cancelled' — без пометки поллер рисовал собственную отмену красным
 *  баннером «Ошибка генерации» (это был старый баг fps-view). */
let cancelRequestedFor: string | null = null

/** queue-item, владеющий состоянием вкладки; защищает от запоздавшего
 *  ответа отменённого POST, когда следующая задача уже стартовала. */
let activeQid: string | null = null

/** (правка 555) Пометить promptId как отменяемый — вызывается из
 *  QueueIndicator при отмене FPS/ControlNet-задачи ИЗ очереди: собственный
 *  поллер вкладки тогда воспримет последующий 'error' (interrupted) как
 *  чистую отмену, а не сбой. */
export function markFpsCancelRequested(promptId: string) {
  cancelRequestedFor = promptId
}

export const useFpsJob = create<FpsJobState>()(
  persist(
    (set, get) => ({
      phase: 'idle',
      progress: 0,
      error: null,
      promptId: null,
      startedAt: null,
      busy: false,

      submit: async (body) => {
        // (правка 554) Очередь: нет блокировки на busy — можно добавлять
        // несколько задач. Store отслеживает ПОСЛЕДНЮЮ отправленную задачу
        // (для статуса в UI), а gen-queue-store — все.
        const label = typeof body.sourceFilename === 'string' && body.sourceFilename
          ? `FPS: ${body.sourceFilename}`
          : 'FPS'
        const qid = useGenQueue.getState().enqueue('fps', label)

        // Единый FIFO: не меняем состояние вкладки, пока задача ждёт ход.
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
          const res = await fetch('/api/comfy/fps', {
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
          toast.success('FPS запущен')
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
        // поллинга (как правка 491 в ControlNet).
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
          // карточка в QueueIndicator оставалась «running» без поллера и
          // через ~2 мин перекатывалась в «Ошибка».
          const qi = useGenQueue.getState().items.find((i) => i.promptId === promptId)
          if (qi) useGenQueue.getState().setStatus(qi.id, 'cancelled')
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
      name: 'fps-job',
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
  const s = useFpsJob.getState()
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
      // 'unknown' (как правка 491 в ControlNet): иначе при мёртвом ComfyUI
      // «Обработка…» висела бы бесконечно.
      unknownStreak++
      if (unknownStreak >= 10) {
        useFpsJob.setState({
          phase: 'error',
          error: 'ComfyUI не отвечает (сервер остановлен или перезапущен) — отслеживание остановлено',
          busy: false,
        })
        stopPolling()
      }
      return
    }
    const data = await res.json()
    const cur = useFpsJob.getState()
    if (cur.promptId !== promptId) return // уже другой джоб
    if (data.status === 'done') {
      useFpsJob.setState({ phase: 'done', progress: 100, busy: false })
      // (правка 554) Обновляем очередь
      const qi = useGenQueue.getState().items.find((i) => i.promptId === promptId)
      if (qi) useGenQueue.getState().setStatus(qi.id, 'done')
      // Галерея: bump сразу + отложенный — финализация .meta.json на
      // сервере может отставать от статуса done (старый fps-view делал
      // перезагрузки на 1/3/6 с).
      useGalleryRefresh.getState().bump()
      setTimeout(() => useGalleryRefresh.getState().bump(), 3000)
      stopPolling()
      setTimeout(() => {
        const c = useFpsJob.getState()
        if (c.promptId === promptId && c.phase === 'done') useFpsJob.setState({ promptId: null })
      }, 7000)
    } else if (data.status === 'cancelled') {
      cancelRequestedFor = null
      useFpsJob.setState({ phase: 'idle', progress: 0, busy: false, promptId: null, startedAt: null })
      const qi2 = useGenQueue.getState().items.find((i) => i.promptId === promptId)
      if (qi2) useGenQueue.getState().setStatus(qi2.id, 'cancelled')
      stopPolling()
    } else if (data.status === 'error') {
      if (cancelRequestedFor === promptId) {
        // Собственная отмена: ComfyUI докладывает interrupt как 'error' —
        // рисуем чистую отмену, а не красный баннер (старый баг fps-view:
        // data.status === 'cancelled' || 'error' шли в одну ветку error).
        cancelRequestedFor = null
        useFpsJob.setState({ phase: 'idle', progress: 0, busy: false, promptId: null, startedAt: null })
        const qi3 = useGenQueue.getState().items.find((i) => i.promptId === promptId)
        if (qi3) useGenQueue.getState().setStatus(qi3.id, 'cancelled')
      } else {
        useFpsJob.setState({
          phase: 'error',
          error: data.error || data.detail || 'Ошибка генерации',
          busy: false,
        })
        const qi4 = useGenQueue.getState().items.find((i) => i.promptId === promptId)
        if (qi4) useGenQueue.getState().setStatus(qi4.id, 'error', data.error || 'Ошибка')
      }
      stopPolling()
    } else if (data.status === 'unknown') {
      if (cancelRequestedFor === promptId) {
        cancelRequestedFor = null
        useFpsJob.setState({ phase: 'idle', progress: 0, busy: false, promptId: null, startedAt: null })
        stopPolling()
        return
      }
      unknownStreak++
      if (unknownStreak >= 10) {
        useFpsJob.setState({
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
            useFpsJob.setState({ progress: progData.progress.percent })
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
