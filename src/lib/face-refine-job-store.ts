'use client'

/**
 * FaceRefineJobStore — состояние джоба Face Refine ВНЕ React.
 *
 * Паттерн tile-upscale-job-store: promptId/phase/progress/error живут в
 * zustand-сторе, модульный цикл опроса /api/comfy/status переживает unmount
 * вкладки, по завершении — useGalleryRefresh.bump() (staggered-перезагрузки
 * галереи встроены в useVideoGallery по bump).
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { toast } from 'sonner'
import { useGalleryRefresh } from '@/lib/gallery-refresh-store'

export type FaceRefinePhase = 'idle' | 'submitting' | 'running' | 'done' | 'error'

export interface FaceRefineSubmitBody {
  inputSource?: string
  sourceFilename?: string
  sourceSubfolder?: string
  prompt?: string
  seed?: number
  [key: string]: unknown
}

interface FaceRefineJobState {
  phase: FaceRefinePhase
  progress: number
  error: string | null
  promptId: string | null
  startedAt: number | null
  busy: boolean

  submit: (body: FaceRefineSubmitBody) => Promise<void>
  cancel: () => Promise<void>
  reset: () => void
}

const ACTIVE: ReadonlySet<FaceRefinePhase> = new Set(['submitting', 'running'])

/** Эпоха отмены: cancel() во время 'submitting' ломает эпоху, и submit()
 *  отменяет принятую сервером задачу сам. */
let cancelEpoch = 0

/** promptId, для которого пользователь запросил отмену. ComfyUI докладывает
 *  прерванную задачу как 'error' (execution_interrupted) — без пометки поллер
 *  рисовал бы собственную отмену красным баннером «Ошибка». */
let cancelRequestedFor: string | null = null

export const useFaceRefineJob = create<FaceRefineJobState>()(
  persist(
    (set, get) => ({
      phase: 'idle',
      progress: 0,
      error: null,
      promptId: null,
      startedAt: null,
      busy: false,

      submit: async (body) => {
        if (get().busy) return
        const myEpoch = cancelEpoch
        cancelRequestedFor = null
        set({ phase: 'submitting', busy: true, error: null, progress: 0, startedAt: Date.now() })
        try {
          const res = await fetch('/api/comfy/face-refine', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
          const data = await res.json()
          if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`)
          if (cancelEpoch !== myEpoch) {
            if (data.prompt_id) {
              void fetch('/api/comfy/cancel', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt_id: data.prompt_id }),
              }).catch(() => {})
            }
            set({ phase: 'idle', busy: false, progress: 0, startedAt: null })
            return
          }
          set({ promptId: data.prompt_id ?? null, phase: 'running' })
          toast.success('Face Refine запущен')
          ensurePolling()
        } catch (e) {
          set({ phase: 'error', error: e instanceof Error ? e.message : String(e), busy: false })
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
          stopPolling()
          set({ phase: 'idle', progress: 0, busy: false, promptId: null, startedAt: null })
          toast.info('Отменено')
        } else {
          cancelRequestedFor = null
          toast.error('Отмена не подтверждена сервером — проверьте, что ComfyUI запущен')
        }
      },

      reset: () => {
        cancelEpoch++
        cancelRequestedFor = null
        stopPolling()
        set({ phase: 'idle', progress: 0, error: null, promptId: null, startedAt: null, busy: false })
      },
    }),
    {
      name: 'face-refine-job',
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
/** Счётчик подряд идущих 'unknown' — prompt мог умереть вместе с
 *  перезапуском ComfyUI. */
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
  const s = useFaceRefineJob.getState()
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
        useFaceRefineJob.setState({
          phase: 'error',
          error: 'ComfyUI не отвечает (сервер остановлен или перезапущен) — отслеживание остановлено',
          busy: false,
        })
        stopPolling()
      }
      return
    }
    const data = await res.json()
    const cur = useFaceRefineJob.getState()
    if (cur.promptId !== promptId) return
    if (data.status === 'done') {
      useFaceRefineJob.setState({ phase: 'done', progress: 100, busy: false })
      useGalleryRefresh.getState().bump()
      stopPolling()
      setTimeout(() => {
        const c = useFaceRefineJob.getState()
        if (c.promptId === promptId && c.phase === 'done') useFaceRefineJob.setState({ promptId: null })
      }, 7000)
    } else if (data.status === 'cancelled') {
      cancelRequestedFor = null
      useFaceRefineJob.setState({ phase: 'idle', progress: 0, busy: false, promptId: null, startedAt: null })
      stopPolling()
    } else if (data.status === 'error') {
      if (cancelRequestedFor === promptId) {
        cancelRequestedFor = null
        useFaceRefineJob.setState({ phase: 'idle', progress: 0, busy: false, promptId: null, startedAt: null })
      } else {
        useFaceRefineJob.setState({
          phase: 'error',
          error: data.error || data.detail || 'Ошибка Face Refine',
          busy: false,
        })
      }
      stopPolling()
    } else if (data.status === 'unknown') {
      if (cancelRequestedFor === promptId) {
        cancelRequestedFor = null
        useFaceRefineJob.setState({ phase: 'idle', progress: 0, busy: false, promptId: null, startedAt: null })
        return
      }
      unknownStreak++
      if (unknownStreak >= 10) {
        useFaceRefineJob.setState({
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
            useFaceRefineJob.setState({ progress: progData.progress.percent })
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
