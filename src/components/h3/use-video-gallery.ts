'use client'

/**
 * Shared gallery loading hook — lists generated videos from ComfyUI's
 * output directory via /api/comfy/files. Used by both the Generate view
 * (results under the prompt) and the Gallery tab so they stay in sync.
 *
 * Auto-refresh: the hook subscribes to the global generation phase and, while
 * a generation is in progress, silently polls the file list and detects
 * completion via ComfyUI's status endpoint. This means the Gallery tab picks
 * up a finished video immediately — even if the Generate tab is unmounted
 * (whose own polling would have stopped).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useGenProgress } from '@/lib/gen-progress-store'
import { useGenQueue } from '@/lib/gen-queue-store'
import { useGalleryRefresh } from '@/lib/gallery-refresh-store'
import type { VideoGalleryFile } from './video-gallery-grid'

const ACTIVE_PHASES = new Set(['submitting', 'queued', 'running'])
const ACTIVE_POLL_MS = 2500

export function useVideoGallery(opts?: {
  /** Current generation phase — retriggers loads shortly after 'done'. */
  phase?: string
}) {
  const [files, setFiles] = useState<VideoGalleryFile[]>([])
  /** (правка 91) Папки проектов (подпапки output; общая '' не входит). */
  const [folders, setFolders] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  // Монотонный id загрузки: применяем состояние только самого свежего
  // запроса — иначе параллельные load() (опрос + ручное обновление) могут
  // завершиться в обратном порядке и устаревший список перетрёт свежий.
  const loadSeq = useRef(0)
  // (правка 309) Fast-track: окно «горячих» файлов. Пока Date.now() <
  // hotUntilRef, обычный load() тоже шлёт include_hot=1 — иначе список без
  // hot-файлов (HOT_SKIP на сервере) выкинул бы только что показанное видео
  // из галереи на 4 секунды (мерцание).
  const hotUntilRef = useRef(0)
  // Известные ключи файлов (subfolder/filename) — fast-track ищет НОВЫЕ.
  const knownKeysRef = useRef<Set<string>>(new Set())
  // Guard против параллельных fast-track-циклов + cleanup при размонтировании.
  const fastTrackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fastTrackGenRef = useRef(0)
  // Prefer an explicitly passed phase; otherwise read the global store so
  // GalleryView (and any consumer) auto-refreshes without wiring a prop.
  const storePhase = useGenProgress((s) => s.video.phase)
  const phase = opts?.phase ?? storePhase
  // (правка 134) Сигнал внешнего обновления — заводской сброс / удаление
  // контента. При bump() галерея сразу перечитывает список файлов, не
  // дожидаясь переключения вкладок.
  const refreshVersion = useGalleryRefresh((s) => s.version)

  /**
   * Load the file list.
   * @param background When true, skip the visible "loading" state so the grid
   *   keeps showing the current files (no skeleton flicker) — used for the
   *   periodic/refresh loads, not the very first load.
   * @param hot (правка 309) Явно запросить include_hot=1 у сервера. Также
   *   включается автоматически, пока активно hot-окно (hotUntilRef).
   */
  const load = useCallback(async (background = false, hot = false) => {
    const seq = ++loadSeq.current
    if (!background) setLoading(true)
    try {
      const wantHot = hot || Date.now() < hotUntilRef.current
      const res = await fetch('/api/comfy/files?type=all' + (wantHot ? '&include_hot=1' : '') + '&_t=' + Date.now(), { cache: 'no-store' })
      if (seq !== loadSeq.current) return // уже есть более свежая загрузка
      if (!res.ok) {
        console.warn('[Gallery] Failed to load files:', res.status)
        return
      }
      const data = await res.json()
      if (seq !== loadSeq.current) return
      setFolders(Array.isArray(data.folders) ? data.folders : [])
      // (правка 308) Промежуточные клипы продления (extclip_*) и куски
      // рефайна (refinepart_*) не показываем в галерее — только итоговый
      // склеенный файл. Они временные файлы, после сшивки не нужны.
      const videoFiles = (data.files ?? []).filter(
        (f: { type?: string; name?: string; filename?: string }) =>
          (f.type?.startsWith('video') || f.name?.match(/\.(mp4|webm|mov)$/i)) &&
          !/Minimax_Studio_extclip_/i.test(f.name || f.filename || '') &&
          !/Minimax_Studio_refinepart_/i.test(f.name || f.filename || ''),
      )
      const next: VideoGalleryFile[] = videoFiles.map(
        (f: { url: string; filename?: string; name?: string; subfolder?: string; mtime?: number; generationTime?: number | null; pipeline?: string | null }) => ({
          url: f.url,
          filename: f.filename || f.name || '',
          subfolder: f.subfolder || '',
          mtime: f.mtime,
          generationTime: typeof f.generationTime === 'number' ? f.generationTime : null,
          // (правка 310) pipeline из .meta.json — красный бейдж «Draft».
          pipeline: f.pipeline === 'draft' || f.pipeline === 'full' ? f.pipeline : null,
        }),
      )
      // Only update state if the file list actually changed (avoids re-renders)
      setFiles((prev) => {
        if (
          prev.length === next.length &&
          prev.every((p, i) => p.filename === next[i].filename && p.subfolder === next[i].subfolder && p.mtime === next[i].mtime && p.pipeline === next[i].pipeline &&
            // (правка 348) generationTime участвует в сравнении: сайдкар
            // пишется ПОСЛЕ появления файла, и без этого бейдж времени
            // генерации не появлялся до смены списка по другой причине.
            p.generationTime === next[i].generationTime)
        ) {
          return prev
        }
        return next
      })
      // (правка 309) Обновляем известные ключи при каждом применённом списке.
      knownKeysRef.current = new Set(next.map((f) => `${f.subfolder}/${f.filename}`))
    } catch (err) {
      console.error('[Gallery] Error loading files:', err)
    } finally {
      // (фикс M5) loading снимает ПОСЛЕДНИЙ живой запрос — независимо от
      // background. Раньше фоновая загрузка (watcher активной генерации)
      // обгоняла стартовую: стартовая отбрасывалась по seq (не трогала
      // loading), фоновая — background и не должна была → skeleton висел
      // ВЕЧНО («не отображаются видео» после запуска с активной генерацией).
      if (seq === loadSeq.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // (правка 309) Fast-track: после завершения генерации опрашиваем список с
  // include_hot=1 каждые ~700 мс (потолок ~15 с). Новый файл показываем, как
  // только его размер перестал меняться между двумя опросами — значит VHS/
  // FFmpeg закончил муксинг и файл безопасно отдавать браузеру (URL с _t=mtime
  // уже финальный). Сам список fast-track НЕ применяет — только вызывает
  // load(true), чтобы не обходить защиту loadSeq. Staggered-таймеры ниже
  // остаются страховкой.
  const fastTrack = useCallback(() => {
    const gen = ++fastTrackGenRef.current
    if (fastTrackTimerRef.current) clearTimeout(fastTrackTimerRef.current)
    const startedAt = Date.now()
    const pendingSizes = new Map<string, number>()
    const tick = async () => {
      if (gen !== fastTrackGenRef.current) return
      if (Date.now() - startedAt > 15000) return // жёсткий потолок
      try {
        const res = await fetch('/api/comfy/files?type=all&include_hot=1&_t=' + Date.now(), { cache: 'no-store' })
        if (!res.ok) throw new Error(String(res.status))
        const data = await res.json()
        const videoFiles = (data.files ?? []).filter(
          (f: { type?: string; name?: string; filename?: string }) =>
            (f.type?.startsWith('video') || f.name?.match(/\.(mp4|webm|mov)$/i)) &&
            !/Minimax_Studio_extclip_/i.test(f.name || f.filename || '') &&
            !/Minimax_Studio_refinepart_/i.test(f.name || f.filename || ''),
        ) as Array<{ filename?: string; name?: string; subfolder?: string; size?: number }>
        const newOnes: Array<{ key: string; size: number }> = []
        for (const f of videoFiles) {
          const key = `${f.subfolder || ''}/${f.filename || f.name || ''}`
          if (!knownKeysRef.current.has(key)) newOnes.push({ key, size: typeof f.size === 'number' ? f.size : 0 })
        }
        // Новых файлов нет — файл мог ещё не создаться, продолжаем опрос.
        // Все новые уже видны дважды и размер не изменился → муксинг завершён.
        const stable = newOnes.length > 0 && newOnes.every((f) => pendingSizes.get(f.key) === f.size)
        for (const f of newOnes) pendingSizes.set(f.key, f.size)
        if (stable) {
          knownKeysRef.current = new Set([...knownKeysRef.current, ...newOnes.map((f) => f.key)])
          hotUntilRef.current = Date.now() + 8000
          void load(true)
          return
        }
      } catch { /* transient — следующий тик */ }
      fastTrackTimerRef.current = setTimeout(() => void tick(), 700)
    }
    fastTrackTimerRef.current = setTimeout(() => void tick(), 700)
  }, [load])

  useEffect(() => {
    return () => {
      fastTrackGenRef.current++
      if (fastTrackTimerRef.current) clearTimeout(fastTrackTimerRef.current)
    }
  }, [])

  // After a generation finishes the file may take a moment to flush/encode —
  // a few staggered silent reloads guarantee the newest video shows up.
  useEffect(() => {
    if (phase === 'done') {
      // 20s — запас на авто-конкатенацию (extend-режим: FFmpeg xfade)
      const timers = [1000, 3000, 6000, 12000, 20000].map((delay) => setTimeout(() => load(true), delay))
      fastTrack() // (правка 309) быстрый показ, как только муксинг завершён
      return () => timers.forEach(clearTimeout)
    }
  }, [phase, load, fastTrack])

  // (правка 134/259) Внешний сигнал обновления (заводской сброс / удаление
  // контента / ЗАВЕРШЕНИЕ джоба любой вкладкой — генерация, склейка extend,
  // рефайн, апскейл): перечитываем список файлов в фоне серией отложенных
  // загрузок — свежий файл мог ещё не закрыться (VHS-муксинг/ffmpeg), а
  // files-роут пропускает «горячие» файлы младше 4 секунд.
  useEffect(() => {
    if (refreshVersion === 0) return
    const delays = [300, 1500, 4000, 8000]
    const timers = delays.map((d) => setTimeout(() => void load(true), d))
    fastTrack() // (правка 309) bump приходит и от extend-склейки/рефайна/апскейла
    return () => timers.forEach(clearTimeout)
  }, [refreshVersion, load, fastTrack])

  // While a generation is active, keep the list fresh and detect completion
  // directly from the backend so the new video appears even if the Generate
  // tab (and its polling) is unmounted. Flipping the shared phase to
  // 'done'/'error' also keeps the status card and queue indicator in sync and
  // stops this watcher (the effect re-runs and clears the interval).
  const active = ACTIVE_PHASES.has(phase)
  useEffect(() => {
    if (!active) return
    // (фикс M5) Счётчик подряд идущих 'unknown': карточка может следить за
    // задачей, умершей вместе с перезапуском ComfyUI (persisted 'running'
    // остался после перезагрузки страницы). Если за prompt_id не осталось
    // активного элемента очереди — очередь его не подхватит, и карточка
    // вечно крутила бы «Генерация…». ~8 тиков × 2.5с = 20с — честно роняем.
    let unknownStreak = 0
    const tick = async () => {
      await load(true)
      const { promptId, phase: cur } = useGenProgress.getState().video
      if (!promptId || !ACTIVE_PHASES.has(cur)) return
      try {
        const res = await fetch(`/api/comfy/status?prompt_id=${encodeURIComponent(promptId)}`)
        if (!res.ok) return
        const s = await res.json()
        if (s.status === 'done') {
          useGenProgress.getState().setVideoPhase('done')
          useGenProgress.getState().setVideoProgress(100, 100)
        } else if (s.status === 'error') {
          // ComfyUI отвечает «error» на ПРЕРВАННЫЙ промпт: если задача
          // отменена осознанно (кнопка/очередь) — не показываем красную
          // «Ошибку», оставляем чистое состояние отмены.
          const qItem = useGenQueue.getState().items.find((i) => i.promptId === promptId)
          if (qItem?.status === 'cancelled') return
          useGenProgress.getState().setVideoPhase('error')
          if (s.detail) useGenProgress.getState().setVideoError(s.detail)
        } else if (s.status === 'unknown') {
          unknownStreak++
          if (unknownStreak >= 8) {
            const qItem = useGenQueue.getState().items.find((i) => i.promptId === promptId)
            const qActive = qItem && ['submitting', 'queued', 'running'].includes(qItem.status)
            // Элемент очереди активен → им занимается его собственный поллер
            // (он честно покажет ошибку после своих 20 'unknown'). Действуем
            // только когда карточка осталась одна, без элемента очереди.
            if (!qActive) {
              const isNotFound = s.detail?.includes('не найдена') || s.detail?.includes('отклонена')
              useGenProgress.getState().setVideoError(isNotFound
                ? 'Задача не найдена в ComfyUI (сервер был перезапущен) — отслеживание остановлено'
                : 'ComfyUI не отвечает — отслеживание остановлено')
              useGenProgress.getState().setVideoPhase('error')
            }
          }
        } else {
          unknownStreak = 0
        }
        // 'running'/'queued' — генерация жива, просто ждём следующего тика
      } catch {
        // transient network blip — retry on the next tick
      }
    }
    void tick()
    const id = setInterval(() => void tick(), ACTIVE_POLL_MS)
    return () => clearInterval(id)
  }, [active, phase, load])

  const deleteFile = useCallback(async (filename: string, subfolder: string) => {
    try {
      const res = await fetch('/api/comfy/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, subfolder }),
      })
      if (res.ok) {
        toast.success('Видео удалено')
        // (правка 587) Дисквалифицируем загрузки, стартовавшие ДО удаления:
        // их ответ ещё содержит удалённый файл, и без этого «воскресший»
        // элемент оставался бы в сетке до следующего тика опроса.
        loadSeq.current += 1
        setFiles((prev) => prev.filter((f) => !(f.filename === filename && f.subfolder === subfolder)))
      } else {
        toast.error('Не удалось удалить файл')
      }
    } catch {
      toast.error('Ошибка удаления')
    }
  }, [])

  return { files, folders, loading, load, deleteFile }
}