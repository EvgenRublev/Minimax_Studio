'use client'

/**
 * (правка 319) TileUpscaleJobStore — состояние джоба tile-upscale ВНЕ React.
 *
 * Раньше promptId/phase/progress жили в useState TileUpscaleView, а поллинг
 * /api/comfy/status — в useEffect: переключение вкладки (unmount) убивало
 * интервал → прогресс «замораживался», результат не попадал в галерею, а
 * staggered-reload галереи отменялся cleanup'ом.
 *
 * Теперь (упрощённый паттерн из upscale-service.ts):
 *  • promptId/phase/progress/error живут в zustand-сторе;
 *  • ОДИН модульный цикл опроса — переживает unmount вкладки;
 *  • по завершении — useGalleryRefresh.bump(): staggered-перезагрузки уже
 *    встроены в useVideoGallery по bump, локальные таймеры не нужны;
 *  • активный promptId персистится (localStorage) → после перезагрузки
 *    страницы onRehydrateStorage перезапускает поллинг (re-attach).
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { toast } from 'sonner'
import { useGalleryRefresh } from '@/lib/gallery-refresh-store'

export type TileUpscalePhase = 'idle' | 'submitting' | 'running' | 'done' | 'error'

export interface TileUpscaleSubmitBody {
  inputSource?: string
  sourceFilename?: string
  sourceSubfolder?: string
  prompt?: string
  seed?: number
  [key: string]: unknown
}

interface TileUpscaleJobState {
  phase: TileUpscalePhase
  progress: number
  error: string | null
  promptId: string | null
  startedAt: number | null
  busy: boolean

  submit: (body: TileUpscaleSubmitBody) => Promise<void>
  cancel: () => Promise<void>
  reset: () => void
}

const ACTIVE: ReadonlySet<TileUpscalePhase> = new Set(['submitting', 'running'])

/* (правка 330) Эпоха отмены (по образцу fix H2 в use-video-gen.ts): cancel()
 * во время 'submitting' (POST /api/comfy/tile-upscale ещё в полёте, promptId
 * нет) раньше был no-op — когда POST возвращался, джоб-сирота запускался
 * в ComfyUI без отслеживания. Теперь submit() замечает смену эпохи после
 * await POST и сразу отменяет вернувшийся prompt_id. */
let cancelEpoch = 0

/** promptId, для которого пользователь запросил отмену. ComfyUI докладывает
 *  прерванную задачу в history как 'error' (execution_interrupted), а не
 *  'cancelled' — без пометки поллер рисовал собственную отмену красным
 *  баннером «Ошибка». Поллер переводит такой терминальный статус в чистый
 *  idle. */
let cancelRequestedFor: string | null = null

export const useTileUpscaleJob = create<TileUpscaleJobState>()(
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
        const myEpoch = cancelEpoch // (правка 330)
        cancelRequestedFor = null
        set({ phase: 'submitting', busy: true, error: null, progress: 0, startedAt: Date.now() })
        try {
          const res = await fetch('/api/comfy/tile-upscale', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
          const data = await res.json()
          if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`)
          // (правка 330) Отмена пришла, пока POST был в полёте: задача уже в
          // ComfyUI — отменяем её на сервере и НЕ запускаем поллинг.
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
          toast.success('Tile Upscale запущен')
          ensurePolling()
        } catch (e) {
          set({ phase: 'error', error: e instanceof Error ? e.message : String(e), busy: false })
        }
      },

      cancel: async () => {
        // (правка 330) Ломаем эпоху ДО проверки promptId: если POST ещё в
        // полёте ('submitting'), продолжение submit() увидит смену и отменит
        // принятую задачу само.
        cancelEpoch++
        const { promptId, phase } = get()
        if (!promptId) {
          if (phase === 'submitting') {
            set({ phase: 'idle', busy: false, progress: 0, startedAt: null })
            toast.info('Отменено')
          }
          return
        }
        // (правка 491) После ПОДТВЕРЖДЁННОЙ сервером отмены сразу чистый idle
        // и стоп поллинга. Раньше UI ждал, пока поллер наткнётся на финальный
        // статус: отменённая из ОЧЕРЕДИ задача не попадает в history → статус
        // 'unknown' → 20 секунд «Генерация идёт…» → красный баннер «Задача не
        // найдена в ComfyUI (сервер был перезапущен)». cancelRequestedFor при
        // этом срабатывал только на статус 'error' (прерванный running).
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
          // Сервер не подтвердил (ComfyUI недоступен?) — оставляем состояние,
          // чтобы пользователь мог повторить отмену.
          cancelRequestedFor = null
          toast.error('Отмена не подтверждена сервером — проверьте, что ComfyUI запущен')
        }
      },

      reset: () => {
        cancelEpoch++ // (правка 330) сброс тоже инвалидирует летящий POST
        cancelRequestedFor = null
        stopPolling()
        set({ phase: 'idle', progress: 0, error: null, promptId: null, startedAt: null, busy: false })
      },
    }),
    {
      name: 'tile-upscale-job',
      // Персистим ТОЛЬКО активный джоб — после перезагрузки страницы
      // onRehydrateStorage re-attach'ит поллинг. Прогресс/ошибки не храним.
      partialize: (s) =>
        ACTIVE.has(s.phase) ? { promptId: s.promptId, startedAt: s.startedAt, phase: s.phase } : {},
      onRehydrateStorage: () => (state) => {
        if (state?.promptId && ACTIVE.has(state.phase)) {
          state.busy = true
          ensurePolling()
          void pollOnce() // свежий тик сразу, не ждём интервала
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
 *  перезапуском ComfyUI (persisted 'running' после перезагрузки). */
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
  const s = useTileUpscaleJob.getState()
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
      // (правка 491) Не-OK ответ (502 — ComfyUI лежит/перезапускается) раньше
      // просто пропускал тик: unknownStreak не рос, и при мёртвом ComfyUI
      // «Генерация идёт…» висела БЕСКОНЕЧНО. Считаем такие тики как 'unknown'.
      unknownStreak++
      if (unknownStreak >= 10) {
        useTileUpscaleJob.setState({
          phase: 'error',
          error: 'ComfyUI не отвечает (сервер остановлен или перезапущен) — отслеживание остановлено',
          busy: false,
        })
        stopPolling()
      }
      return
    }
    const data = await res.json()
    const cur = useTileUpscaleJob.getState()
    if (cur.promptId !== promptId) return // уже другой джоб
    if (data.status === 'done') {
      useTileUpscaleJob.setState({ phase: 'done', progress: 100, busy: false })
      // Staggered-перезагрузки галереи — внутри useVideoGallery по bump.
      useGalleryRefresh.getState().bump()
      stopPolling()
      // promptId оставляем ещё немного для карточки статуса, потом чистим
      setTimeout(() => {
        const c = useTileUpscaleJob.getState()
        if (c.promptId === promptId && c.phase === 'done') useTileUpscaleJob.setState({ promptId: null })
      }, 7000)
    } else if (data.status === 'cancelled') {
      // Отмена — НЕ ошибка: чистый возврат в исходное состояние без красного
      // баннера (раньше сворачивалось в phase 'error' с текстом «Отменено»).
      cancelRequestedFor = null
      useTileUpscaleJob.setState({ phase: 'idle', progress: 0, busy: false, promptId: null, startedAt: null })
      stopPolling()
    } else if (data.status === 'error') {
      if (cancelRequestedFor === promptId) {
        // ComfyUI докладывает прерывание по /interrupt как error
        // (execution_interrupted) — для задачи, отменённой пользователем,
        // это ожидаемый финал, а не ошибка: чистый idle.
        cancelRequestedFor = null
        useTileUpscaleJob.setState({ phase: 'idle', progress: 0, busy: false, promptId: null, startedAt: null })
      } else {
        useTileUpscaleJob.setState({
          phase: 'error',
          error: data.error || data.detail || 'Ошибка генерации',
          busy: false,
        })
      }
      stopPolling()
    } else if (data.status === 'unknown') {
      // (правка 491) Собственная отмена из очереди: удалённая pending-задача
      // не попадает в history → 'unknown'. Это ожидаемый финал, а не сбой —
      // чистый idle (раньше: 20с ожидания → красный баннер).
      if (cancelRequestedFor === promptId) {
        cancelRequestedFor = null
        useTileUpscaleJob.setState({ phase: 'idle', progress: 0, busy: false, promptId: null, startedAt: null })
        stopPolling()
        return
      }
      // ~10 тиков × 2с = 20с неизвестности — честно роняем (задача умерла
      // вместе с перезапуском ComfyUI, иначе busy висел бы вечно).
      unknownStreak++
      if (unknownStreak >= 10) {
        useTileUpscaleJob.setState({
          phase: 'error',
          error: 'Задача не найдена в ComfyUI (сервер был перезапущен) — отслеживание остановлено',
          busy: false,
        })
        stopPolling()
      }
    } else {
      unknownStreak = 0
      // (правка 479) Прогресс из трекера (/api/comfy/progress) — монотонный
      // 0→100 по счётчику KJ-событий, а не замороженный progress.value/max
      // из ComfyUI status (MMH3UltimateUpscale не шлёт стандартные progress).
      try {
        const progRes = await fetch(`/api/comfy/progress?prompt_id=${encodeURIComponent(promptId)}`)
        if (progRes.ok) {
          const progData = await progRes.json()
          if (progData.progress && typeof progData.progress.percent === 'number') {
            useTileUpscaleJob.setState({ progress: progData.progress.percent })
          }
        }
      } catch { /* non-critical — следующий тик попробует снова */ }
    }
  } catch {
    /* transient — следующий тик попробует снова */
  } finally {
    pollInFlight = false
  }
}
