'use client'

/**
 * (правка 77) UpscaleService — клиентский синглтон состояния DLSS-сервиса.
 *
 * Почему он существует: раньше поллинг статуса/автозапуск/job жили в
 * useEffect компонента UpscaleView. Переключение вкладки (AnimatePresence
 * в page.tsx) unmount-ит вкладку → интервал умирает → во время запуска
 * сервиса UI «зависает», а после возврата на вкладку «вдруг живёт»
 * (свежий mount видит running=true). Точно так же терялся прогресс job,
 * если юзер отходил на другую вкладку.
 *
 * Теперь (паттерн как в assistant-stream.ts):
 *  • статус сервиса, схема параметров и активный job живут в zustand-сторе;
 *  • ОДИН цикл опроса на уровень модуля — переживает unmount вкладок;
 *  • тосты о завершении job fire'ятся в цикле — один раз, независимо от
 *    того, смонтирована вкладка или нет;
 *  • любой (пере)смонтированный UpscaleView мгновенно видит актуальное
 *    состояние, потому что при attach сразу идёт свежий tick.
 */
import { create } from 'zustand'
import { toast } from 'sonner'

/* ────────────────────────────────────────────────────────────────
 * Типы API (вынесены из upscale-view.tsx)
 * ──────────────────────────────────────────────────────────────── */

export interface UpscaleGpu {
  uuid: string
  label: string
  ai_compatible: boolean
  memory_gb: number
}

export interface UpscaleStatusResp {
  enabled: boolean
  port: number
  dir: string
  service: { running: boolean; starting: boolean; error: string | null; startedAt: number }
  health: {
    ok: boolean
    ready: boolean
    error: string | null
    gpus: UpscaleGpu[]
    output_dir: string
    features: string[]
    log_tail: string[]
  } | null
}

export interface UpscaleFeatureSchema {
  label: string
  media: string
  quality_kind: 'int' | 'str'
  defaults: Record<string, unknown>
  choices: Record<string, unknown>
}

export type UpscaleSchema = Record<string, UpscaleFeatureSchema>

export interface UpscaleJob {
  id: string
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled'
  progress: number
  message: string | null
  error: string | null
  output: Record<string, unknown> | null
  downloadUrl?: string
  downloadName?: string
}

export const isUpscaleJobActive = (j: UpscaleJob | null): boolean =>
  !!j && (j.status === 'queued' || j.status === 'running')

/* ────────────────────────────────────────────────────────────────
 * Store
 * ──────────────────────────────────────────────────────────────── */

interface UpscaleServiceState {
  /** Последний ответ /api/upscale/status. */
  st: UpscaleStatusResp | null
  /** Схема параметров (загружается один раз, когда сервис жив). */
  schema: UpscaleSchema | null
  /** Активный/последний job (прогресс, статус). */
  job: UpscaleJob | null
  /** POST /start в полёте (спиннер на кнопке). */
  startBusy: boolean
  /** POST /cancel в полёте. */
  cancelBusy: boolean
  /** Не автозапускаем после жёсткой ошибки сервера (пока не «Запустить»). */
  gaveUp: boolean

  tick: () => Promise<void>
  loadSchema: () => Promise<void>
  start: (opts?: { auto?: boolean }) => Promise<void>
  stop: () => Promise<void>
  /**
   * (правка 716) Возвращает результат запуска: ok/jobId/error/busy.
   * Раньше возвращался void, и очередь upscale не могла отличить
   * «сервер не принял (GPU занята)» от «успешно запущено».
   */
  run: (
    feature: string,
    input: string,
    options: Record<string, unknown>,
  ) => Promise<{ ok: boolean; jobId?: string; error?: string; busy?: boolean }>
  cancel: () => Promise<void>
  resetJob: () => void
  _pollJob: (id: string) => Promise<void>
  _setSt: (st: UpscaleStatusResp | null) => void
  _setSchema: (s: UpscaleSchema | null) => void
  _setJob: (j: UpscaleJob | null) => void
  _setFlag: (p: Partial<Pick<UpscaleServiceState, 'startBusy' | 'cancelBusy' | 'gaveUp'>>) => void
}

export const useUpscaleService = create<UpscaleServiceState>((set, get) => ({
  st: null,
  schema: null,
  job: null,
  startBusy: false,
  cancelBusy: false,
  gaveUp: false,

  tick: async () => {
    if (tickInFlight) return
    tickInFlight = true
    try {
      let d: UpscaleStatusResp | null = null
      try {
        const r = await fetch('/api/upscale/status', { signal: AbortSignal.timeout(6000) })
        if (r.ok) d = (await r.json()) as UpscaleStatusResp
      } catch {
        /* сервер недоступен — состояние не трогаем (может быть и так) */
      }
      const s = get()
      if (d) {
        s._setSt(d)
        // Автозапуск: сервис не жив и не стартует, пользователь не
        // останавливал явно, мы не в режиме «сдался».
        if (
          d.enabled !== false &&
          !d.service.running &&
          !d.service.starting &&
          !s.gaveUp &&
          Date.now() - lastStopAt > 10_000
        ) {
          void s.start({ auto: true })
        }
        // Жёсткая ошибка сервера (не «стартует») — перестаём авто-пинговать.
        if (d.service.error && !d.service.starting) {
          s._setFlag({ gaveUp: true })
        }
        // Схема — один раз, когда сервис поднялся.
        if (d.service.running && !s.schema) {
          void s.loadSchema()
        }
        // Job — один запрос на тик, пока активен (плейсхолдерный id '…'
        // означает, что POST /render ещё в полёте — опрашивать нечего).
        const j = s.job
        if (isUpscaleJobActive(j) && j!.id !== '…') {
          void s._pollJob(j!.id)
        }
      }
    } finally {
      tickInFlight = false
    }
  },

  loadSchema: async () => {
    if (schemaInFlight || get().schema) return
    schemaInFlight = true
    try {
      const r = await fetch('/api/upscale/schema', { signal: AbortSignal.timeout(8000) })
      if (!r.ok) return
      const s = (await r.json()) as { features?: UpscaleSchema }
      if (s.features) get()._setSchema(s.features)
    } catch {
      /* мост ещё поднимается — попробуем на следующем тике */
    } finally {
      schemaInFlight = false
    }
  },

  start: async (opts?: { auto?: boolean }) => {
    const s = get()
    if (s.startBusy) return
    // Явный «Запустить» сбрасывает «сдался»/«остановлено пользователем».
    if (!opts?.auto) s._setFlag({ gaveUp: false })
    s._setFlag({ startBusy: true })
    try {
      const r = await fetch(opts?.auto ? '/api/upscale/start?auto=1' : '/api/upscale/start', {
        method: 'POST',
      })
      const d = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string }
      if (!r.ok) {
        // (фикс) явная неудача — ставим gaveUp, иначе tick через 2.5 с
        // снова пошлёт /start?auto=1 и пользователь будет видеть
        // повторяющиеся ошибки, хотя уже нажал «Запустить».
        if (!opts?.auto) {
          s._setFlag({ gaveUp: true })
          toast.error(d.error ?? 'Не удалось запустить сервис Upscale')
        }
        // auto-запуск молча — tick будет пытаться снова, пока gaveUp не станет true
      }
    } catch (e) {
      if (!opts?.auto) {
        s._setFlag({ gaveUp: true })
        toast.error(e instanceof Error ? e.message : 'Не удалось запустить сервис Upscale')
      }
    } finally {
      s._setFlag({ startBusy: false })
      void get().tick()
    }
  },

  stop: async () => {
    try {
      const r = await fetch('/api/upscale/stop', { method: 'POST' })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      // (фикс) успех: только теперь сбрасываем состояние — иначе UI «застревает»
      // на последнем статусе при сетевом сбое (st=null + gaveUp=true → поллинг
      // молча останавливается, пользователь видит «висит»).
      lastStopAt = Date.now()
      get()._setSchema(null)
      get()._setSt(null)
      // (фикс) после явной остановки НЕ автозапускаемся, пока пользователь не
      // нажмёт «Запустить» (start без auto сбрасывает флаг). Раньше через 10 с
      // tick снова начинал слать /start?auto=1 вечно.
      get()._setFlag({ gaveUp: true })
      // (фикс) активный job умирает вместе с сервисом — иначе isBusy навсегда.
      const j = get().job
      if (j && isUpscaleJobActive(j)) {
        get()._setJob({ ...j, status: 'cancelled', message: 'Сервис остановлен' })
        toast.info('Рендер прерван — сервис остановлен')
      }
      toast.success('Сервис Upscale остановлен')
    } catch {
      // (фикс) ошибка остановки: состояние НЕ трогаем — сервис на сервере
      // скорее всего ещё жив. Если сбросить st/gaveUp, tick через 2.5 с
      // молча перезапустит сервис, который пользователь просил остановить.
      // Пользователь увидит тост и может повторить попытку вручную.
      toast.error('Не удалось остановить сервис — попробуйте ещё раз')
    } finally {
      void get().tick()
    }
  },

  run: async (feature, input, options): Promise<{ ok: boolean; jobId?: string; error?: string; busy?: boolean }> => {
    set({
      job: { id: '…', status: 'queued', progress: 0, message: 'Запуск…', error: null, output: null },
    })
    try {
      const r = await fetch('/api/upscale/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feature, input, options }),
        signal: AbortSignal.timeout(180000),
      })
      const d = (await r.json().catch(() => ({}))) as {
        ok?: boolean
        jobId?: string
        error?: string
        busy?: boolean
      }
      if (!r.ok || !d.ok || !d.jobId) {
        // (правка 716) Результат ВОЗВРАЩАЕМ: раньше run() никогда не бросал
        // и ничего не возвращал, поэтому очередь upscale не могла отличить
        // «сервер не принял (GPU занята)» от «запустился» и подставляла
        // безликое «Задача потеряна».
        const error = d.busy ? 'GPU занята другим рендером' : d.error ?? `render → ${r.status}`
        set({ job: null })
        toast.error(error)
        return { ok: false, error, busy: !!d.busy }
      }
      set({
        job: { id: d.jobId, status: 'queued', progress: 0, message: 'Ожидание GPU', error: null, output: null },
      })
      toast.info('Рендер запущен')
      return { ok: true, jobId: d.jobId }
    } catch (e) {
      const error = e instanceof Error ? e.message : 'Не удалось запустить рендер'
      set({ job: null })
      toast.error(error)
      return { ok: false, error }
    }
  },

  cancel: async () => {
    const j = get().job
    if (!j || !isUpscaleJobActive(j)) return
    // (фикс) id ещё плейсхолдерный — /render в полёте, отменять на мосту нечего
    // (было: /cancel?id=… → 404 → пугающий тост об ошибке).
    if (j.id === '…') {
      toast.info('Рендер ещё запускается — отмена будет доступна через несколько секунд')
      return
    }
    get()._setFlag({ cancelBusy: true })
    try {
      const r = await fetch(`/api/upscale/cancel?id=${encodeURIComponent(j.id)}`, { method: 'POST' })
      const d = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string }
      if (r.ok && d.ok) toast.info('Отмена отправлена — процесс завершится')
      else toast.error(d.error ?? 'Не удалось отправить отмену')
    } catch {
      toast.error('Сервис Upscale не отвечает')
    } finally {
      get()._setFlag({ cancelBusy: false })
    }
  },

  resetJob: () => set({ job: null }),

  _pollJob: async (id: string) => {
    try {
      const r = await fetch(`/api/upscale/job?id=${encodeURIComponent(id)}`, {
        signal: AbortSignal.timeout(10000),
      })
      const d = (await r.json().catch(() => ({}))) as UpscaleJob & { error?: string }
      if (!r.ok) {
        // Сервис мог временно провалиться — показываем и продолжаем опрашивать.
        const prev = get().job
        if (prev && isUpscaleJobActive(prev)) {
          get()._setJob({ ...prev, message: d.error ?? `job → ${r.status}` })
        }
        return
      }
      const prev = get().job
      if (!prev || prev.id !== d.id) return
      get()._setJob(d)
      if (d.status === 'done') {
        toast.success('Обработка завершена — результат в общей галерее')
      } else if (d.status === 'error') {
        toast.error(d.error ?? 'Ошибка обработки')
      } else if (d.status === 'cancelled') {
        toast.info('Обработка отменена')
      }
    } catch {
      /* мост не ответил — следующий тик попробует снова */
    }
  },

  _setSt: (st) => set({ st }),
  _setSchema: (schema) => set({ schema }),
  _setJob: (job) => set({ job }),
  _setFlag: (p) => set(p),
}))

/* ────────────────────────────────────────────────────────────────
 * Singleton poll loop (module level — переживает unmount вкладок)
 * ──────────────────────────────────────────────────────────────── */

let pollTimer: ReturnType<typeof setInterval> | null = null
let tickInFlight = false
let schemaInFlight = false
let attached = 0
/** Не автозапускаем в течение 10 с после явной остановки пользователем. */
let lastStopAt = 0

function ensurePolling() {
  if (pollTimer) return
  pollTimer = setInterval(() => {
    void useUpscaleService.getState().tick()
  }, 2500)
}

/** Подписаться (mount вкладки). Повторные attach идемпотентны. */
export function attachUpscaleService() {
  attached += 1
  ensurePolling()
  void useUpscaleService.getState().tick()
}

/** Отписаться (unmount вкладки). Цикл опроса ЖИВЁТ — это и есть фикс бага:
 * состояние сервиса и job продолжают обновляться, когда юзер отходит. */
export function detachUpscaleService() {
  attached = Math.max(0, attached - 1)
}
