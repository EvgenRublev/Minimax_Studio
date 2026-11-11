'use client'

/**
 * (правка 929) ImageJobStore — состояние прогона вкладки «Изображение».
 * Копия паттерна FpsJobStore/ControlNetJobStore (правки 554/319/330/491/512):
 *  • phase/progress/promptId — вне React (модульный zustand-стор), поэтому
 *    смена вкладки размонтирует компонент, а задача живёт и доезжает до конца;
 *  • ОДИН модульный цикл опроса /api/comfy/status, переживающий unmount;
 *  • активный promptId персистится → re-attach после перезагрузки страницы;
 *  • регистрация в общей очереди (useGenQueue, тип 'image') — задача видна в
 *    QueueIndicator и переживает перезагрузку;
 *  • эпоха отмены: cancel() во время летящего POST отменяет принятую задачу;
 *  • собственная отмена не рисуется красным баннером;
 *  • по 'done' выходы SaveImage складываются в useImageStore.results —
 *    картинка появляется во вкладке, даже если пользователь уже ушёл с неё.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { toast } from 'sonner'
import { useGalleryRefresh } from '@/lib/gallery-refresh-store'
import { useGenQueue } from '@/lib/gen-queue-store'
import { useImageStore } from '@/lib/image-store'
import { acquireComfyTurn, isComfyTurnActive } from '@/lib/comfy-turn'

export type ImagePhase = 'idle' | 'submitting' | 'running' | 'done' | 'error'

export interface ImageSubmitBody {
  prompt: string
  width: number
  height: number
  schedule?: string
  seed?: number
  diffusionModel?: string
  imageLora?: string | null
  loraStrength?: number
  textEncoder?: string
  vae?: string
  references?: Array<{ name?: string; filename?: string; subfolder?: string }>
  lowVramAttention?: boolean
  chunkFeedForward?: boolean
  [key: string]: unknown
}

interface ImageJobState {
  phase: ImagePhase
  progress: number
  error: string | null
  promptId: string | null
  startedAt: number | null
  busy: boolean
  /** Картинки последнего завершённого прогона (для баннера «готово»). */
  lastOutputs: Array<{ filename: string; subfolder: string }>

  submit: (body: ImageSubmitBody) => Promise<void>
  cancel: () => Promise<void>
  reset: () => void
}

const ACTIVE: ReadonlySet<ImagePhase> = new Set(['submitting', 'running'])

let cancelEpoch = 0
let cancelRequestedFor: string | null = null
let activeQid: string | null = null
/** Промпт/seed прогона — подписать карточки результатов. */
let pendingLabel: { prompt?: string; seed?: number } = {}

/** Пометить promptId отменяемым (QueueIndicator отменяет задачу ИЗ очереди). */
export function markImageCancelRequested(promptId: string) {
  cancelRequestedFor = promptId
}

export const useImageJob = create<ImageJobState>()(
  persist(
    (set, get) => ({
      phase: 'idle',
      progress: 0,
      error: null,
      promptId: null,
      startedAt: null,
      busy: false,
      lastOutputs: [],

      submit: async (body) => {
        const short = body.prompt.length > 48 ? `${body.prompt.slice(0, 48)}…` : body.prompt
        const qid = useGenQueue.getState().enqueue('image', `Изображение: ${short}`)
        pendingLabel = { prompt: body.prompt, seed: body.seed }

        const granted = await acquireComfyTurn(qid)
        if (!granted || !isComfyTurnActive(qid)) return

        const myEpoch = cancelEpoch
        cancelRequestedFor = null
        activeQid = qid
        set({ phase: 'submitting', busy: true, error: null, progress: 0, startedAt: Date.now(), lastOutputs: [] })

        try {
          const res = await fetch('/api/comfy/image', {
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
          // Отмена пришла, пока POST был в полёте — отменяем принятую задачу.
          if (cancelEpoch !== myEpoch || !isComfyTurnActive(qid)) {
            await fetch('/api/comfy/cancel', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ prompt_id: data.prompt_id }),
            }).catch(() => {})
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
          toast.success('Генерация изображения запущена')
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
        cancelEpoch++
        const { promptId, phase } = get()
        if (!promptId) {
          if (phase === 'submitting') {
            set({ phase: 'idle', busy: false, progress: 0, startedAt: null })
            toast.info('Отменено')
          }
          return
        }
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
        set({ phase: 'idle', progress: 0, error: null, promptId: null, startedAt: null, busy: false, lastOutputs: [] })
      },
    }),
    {
      name: 'image-job',
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
  const s = useImageJob.getState()
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
      unknownStreak++
      if (unknownStreak >= 10) {
        useImageJob.setState({
          phase: 'error',
          error: 'ComfyUI не отвечает (сервер остановлен или перезапущен) — отслеживание остановлено',
          busy: false,
        })
        stopPolling()
      }
      return
    }
    const data = await res.json()
    const cur = useImageJob.getState()
    if (cur.promptId !== promptId) return // уже другой джоб
    if (data.status === 'done') {
      const outputs: Array<{ filename: string; subfolder: string }> = Array.isArray(data.outputs)
        ? data.outputs.filter((o: { filename?: string }) => typeof o?.filename === 'string')
        : []
      useImageJob.setState({ phase: 'done', progress: 100, busy: false, lastOutputs: outputs })
      if (outputs.length) {
        useImageStore.getState().addResults(
          outputs.map((o) => ({
            filename: o.filename,
            subfolder: o.subfolder || '',
            prompt: pendingLabel.prompt,
            seed: pendingLabel.seed,
            createdAt: Date.now(),
          })),
        )
      } else {
        toast.warning('Генерация завершилась, но ComfyUI не вернул файл')
      }
      const qi = useGenQueue.getState().items.find((i) => i.promptId === promptId)
      if (qi) useGenQueue.getState().setStatus(qi.id, 'done')
      useGalleryRefresh.getState().bump()
      stopPolling()
      setTimeout(() => {
        const c = useImageJob.getState()
        if (c.promptId === promptId && c.phase === 'done') useImageJob.setState({ promptId: null })
      }, 7000)
    } else if (data.status === 'cancelled') {
      cancelRequestedFor = null
      useImageJob.setState({ phase: 'idle', progress: 0, busy: false, promptId: null, startedAt: null })
      const qi2 = useGenQueue.getState().items.find((i) => i.promptId === promptId)
      if (qi2) useGenQueue.getState().setStatus(qi2.id, 'cancelled')
      stopPolling()
    } else if (data.status === 'error') {
      if (cancelRequestedFor === promptId) {
        cancelRequestedFor = null
        useImageJob.setState({ phase: 'idle', progress: 0, busy: false, promptId: null, startedAt: null })
        const qi3 = useGenQueue.getState().items.find((i) => i.promptId === promptId)
        if (qi3) useGenQueue.getState().setStatus(qi3.id, 'cancelled')
      } else {
        useImageJob.setState({
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
        useImageJob.setState({ phase: 'idle', progress: 0, busy: false, promptId: null, startedAt: null })
        stopPolling()
        return
      }
      unknownStreak++
      if (unknownStreak >= 10) {
        useImageJob.setState({
          phase: 'error',
          error: 'Задача не найдена в ComfyUI (сервер был перезапущен) — отслеживание остановлено',
          busy: false,
        })
        stopPolling()
      }
    } else {
      unknownStreak = 0
      try {
        const progRes = await fetch(`/api/comfy/progress?prompt_id=${encodeURIComponent(promptId)}`)
        if (progRes.ok) {
          const progData = await progRes.json()
          if (progData.progress && typeof progData.progress.percent === 'number') {
            useImageJob.setState({ progress: progData.progress.percent })
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
