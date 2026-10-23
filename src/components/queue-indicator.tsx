'use client'

import { useState, useMemo, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  ImageIcon,
  MusicIcon,
  Volume2Icon,
  VideoIcon,
  Wand2Icon,
  XIcon,
  Trash2Icon,
  LoaderIcon,
  CheckCircleIcon,
  AlertCircleIcon,
  ClockIcon,
  DownloadIcon,
  XCircleIcon,
  ArrowUpFromLineIcon,
  WaypointsIcon, // (правка 512) ControlNet
  GaugeIcon, // (правка 554) FPS
} from 'lucide-react'
import { useGenQueue, TYPE_ACCENT, TYPE_LABEL, type QueueItemType } from '@/lib/gen-queue-store'
import { useAssistantPanel } from '@/lib/assistant-panel-store' // (правка 442) отступ от панели ассистента
import { cn } from '@/lib/utils'

/* ──────────────────── Icon Map ──────────────────── */

const TYPE_ICON: Record<QueueItemType, typeof ImageIcon> = {
  image: ImageIcon,
  music: MusicIcon,
  sound: Volume2Icon,
  video: VideoIcon,
  refine: Wand2Icon, // (правка 261) рефайн в общей очереди
  upscale: ArrowUpFromLineIcon, // (правка 262) upscale в общей очереди
  controlnet: WaypointsIcon, // (правка 512)
  fps: GaugeIcon, // (правка 554)
}

/* ──────────────────── Status Icons ──────────────────── */

/** Detect if a WanGP status message indicates model downloading */
function isDownloading(message: string | null | undefined): boolean {
  if (!message) return false
  return /download|скачив|загружа/i.test(message)
}

function StatusIcon({ status, color, message }: { status: string; color: string; message?: string | null }) {
  switch (status) {
    case 'submitting':
    case 'queued':
      return <ClockIcon className="w-3 h-3" style={{ color }} />
    case 'running':
      if (isDownloading(message)) {
        return <DownloadIcon className="w-3 h-3 animate-pulse" style={{ color }} />
      }
      return <LoaderIcon className="w-3 h-3 animate-spin" style={{ color }} />
    case 'done':
      return <CheckCircleIcon className="w-3 h-3 text-emerald-400" />
    case 'cancelled':
      return <XIcon className="w-3 h-3 text-muted-foreground" />
    case 'error':
      return <AlertCircleIcon className="w-3 h-3 text-red-400" />
    default:
      return null
  }
}

/* ──────────────────── Status Labels ──────────────────── */

const STATUS_LABEL: Record<string, string> = {
  submitting: 'Отправка…',
  queued: 'В очереди',
  running: 'Генерация…',
  done: 'Готово',
  cancelled: 'Отменено',
  error: 'Ошибка',
}

/* ──────────────────── Global poller ──────────────────── */
const GLOBAL_POLL_INTERVAL_MS = 8000

/**
 * Fallback-поллер: держит очередь живой, когда use-video-gen размонтирован
 * (вкладка переключена). Интервал 8с (вместо 4с) — снижает нагрузку на
 * ComfyUI, который во время генерации отвечает медленно (GPU блокирует
 * event-loop). use-video-gen уже поллит каждый 1с — этот поллер дублирует
 * только для edge-case'ов.
 */
function useGlobalQueuePoller() {
  const items = useGenQueue((s) => s.items)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const activeJobIds = useMemo(
    () =>
      items
        .filter((it) => (it.status === 'submitting' || it.status === 'queued' || it.status === 'running') && it.promptId)
        .map((it) => it.promptId as string),
    [items],
  )

  useEffect(() => {
    if (activeJobIds.length === 0) {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
      return
    }

    if (pollRef.current) return // already polling

    // Slow requests must not stack ticks — skip while one is in flight
    let busy = false
    // (фикс) Счётчик ПОДРЯД идущих 'unknown' для каждого видео. Живёт в замыкании
    // эффекта, а не внутри тика: раньше Map пересоздавалась каждый тик, счётчик
    // никогда не накапливался и порог 15 был недостижим.
    const unknownCountMap = new Map<string, number>()
    // (фикс) Порог 15: во время активной генерации ComfyUI event-loop
    // заблокирован GPU-операциями, и /history может не уложиться в 30с →
    // ложный 502. 15 × 8с = 2 мин непрерывного недоступа.
    const UNKNOWN_THRESHOLD = 15
    pollRef.current = setInterval(async () => {
      if (busy) return
      busy = true
      try {
        const store = useGenQueue.getState()
        const active = store.items.filter(
          (it) => (it.status === 'submitting' || it.status === 'queued' || it.status === 'running') && it.promptId,
        )
        if (active.length === 0) {
          if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
          return
        }

        // (правка 141) Счётчик подряд идущих 'unknown' для каждого видео.
        // Если ComfyUI недоступен N раз подряд — показываем ошибку, но НЕ удаляем
        // сразу: даём пользователю время перезапустить ComfyUI.
        // (фикс) unknownCountMap/UNKNOWN_THRESHOLD — см. объявление выше.

        // (фикс) Параллельные запросы: 3 видео = 3 параллельных fetch
        // вместо 3 последовательных. ComfyUI во время генерации отвечает
        // медленно (GPU блокирует event-loop) — последовательные запросы
        // накапливали задержку, и часть падала в 502.
        await Promise.allSettled(active.map(async (item) => {
          try {
            const res = await fetch(`/api/comfy/status?prompt_id=${encodeURIComponent(item.promptId!)}`)
            if (!res.ok) {
              const count = (unknownCountMap.get(item.id) ?? 0) + 1
              unknownCountMap.set(item.id, count)
              if (count >= UNKNOWN_THRESHOLD) {
                store.setStatus(item.id, 'error', 'ComfyUI не отвечает. Перезапустите start.bat.')
              }
              return
            }
            unknownCountMap.delete(item.id)
            const s = await res.json()

            // Re-check: элемент могли отменить/удалить во время запроса
            const fresh = useGenQueue.getState().items.find((it) => it.id === item.id)
            if (!fresh || fresh.status === 'cancelled' || fresh.status === 'done' || fresh.status === 'error') return

            if (s.detail) store.setMessage(item.id, s.detail)

            if (s.status === 'running') {
              try {
                const progRes = await fetch(`/api/comfy/progress?prompt_id=${encodeURIComponent(item.promptId!)}`)
                if (progRes.ok) {
                  const progData = await progRes.json()
                  if (progData.progress) {
                    store.setProgress(item.id, progData.progress.percent, 100)
                  }
                }
              } catch { /* non-critical */ }
            }

            if (s.status === 'running') {
              // (фикс) Terminal-status guard: элемент мог стать error/done/cancelled
              // между fresh-check выше и этим вызовом (race с rehydration effect).
              // Без этого: error → running (resurrection).
              const guard = useGenQueue.getState().items.find((it) => it.id === item.id)
              if (guard && !['done', 'error', 'cancelled'].includes(guard.status)) {
                if (guard.status !== 'running') store.setStatus(item.id, 'running')
              }
            } else if (s.status === 'queued') {
              const guard = useGenQueue.getState().items.find((it) => it.id === item.id)
              if (guard && !['done', 'error', 'cancelled'].includes(guard.status)) {
                if (guard.status !== 'queued') store.setStatus(item.id, 'queued')
              }
            } else if (s.status === 'unknown') {
              // (фикс) ComfyUI отвечает, но prompt_id отсутствует — задача
              // отклонена или потеряна. Раньше 'unknown' обрабатывался ТОЛЬКО
              // через !res.ok (502), и при 200+unknown элемент вечно крутил
              // «В очереди». Теперь: счётчик + честная ошибка.
              const count = (unknownCountMap.get(item.id) ?? 0) + 1
              unknownCountMap.set(item.id, count)
              if (count >= UNKNOWN_THRESHOLD) {
                const isNotFound = s.detail?.includes('не найдена') || s.detail?.includes('отклонена')
                const errMsg = isNotFound
                  ? 'Задача не найдена в ComfyUI — отклонена или потеряна'
                  : 'ComfyUI не отвечает'
                store.setStatus(item.id, 'error', errMsg)
              }
              return
            } else if (s.status === 'error') {
              // (фикс) Только если элемент ещё не имеет статус 'error'
              const fresh = useGenQueue.getState().items.find((it) => it.id === item.id)
              if (fresh && fresh.status !== 'error') {
                console.warn(`[queue-poll] ${item.id}: SETTING ERROR — ${s.detail}`)
                store.setStatus(item.id, 'error', s.detail || 'Ошибка')
              }
            } else if (s.status === 'done') {
              // (правка 332) refine-элементы этот поллер НЕ финализирует:
              // раньше он ставил done без legacy-stitch покусочных
              // refinepart_* и без bump галереи. Финализация refine — в
              // refine-queue (раннер в живой сессии, recoverOrphanRefineItem
              // после перезагрузки).
              if (item.type === 'refine') return
              // (фикс) Только если элемент ещё не имеет статус 'done'
              // (use-video-gen уже обработал 'done' и запустил таймер удаления)
              const fresh = useGenQueue.getState().items.find((it) => it.id === item.id)
              if (fresh && fresh.status !== 'done') {
                store.setStatus(item.id, 'done')
              }
            }
          } catch {
            /* transient network error — keep polling */
          }
        }))
      } finally {
        busy = false
      }
    }, GLOBAL_POLL_INTERVAL_MS)

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
  }, [activeJobIds.length > 0]) // eslint-disable-line react-hooks/exhaustive-deps
}

/* ──────────────────── Cancel handler ──────────────────── */

async function cancelQueueItem(item: { id: string; promptId: string | null; type: QueueItemType }) {
  const { setStatus, remove } = useGenQueue.getState()
  // (правка 329) upscale: у очереди нет promptId, ветка !promptId просто
  // удаляла элемент, а серверный DLSS-рендер продолжал работать зомби.
  // Теперь — реальная отмена (статус + задача из Map + cancel на мосту).
  if (item.type === 'upscale') {
    const { cancelUpscaleItem } = await import('@/lib/upscale-queue')
    await cancelUpscaleItem(item.id)
    return
  }
  // (правка 334) refine: отмена через refine-queue — чистит tasks Map от
  // незапущенных задач (иначе запись оставалась сиротой навсегда).
  if (item.type === 'refine') {
    const { cancelRefineItem } = await import('@/lib/refine-queue')
    await cancelRefineItem(item.id)
    return
  }
  // (правка 555) ControlNet/FPS: помечаем promptId как отменяемый ДО
  // /api/comfy/cancel — иначе собственный модульный поллер вкладки увидит
  // от ComfyUI 'error' (interrupted) и нарисует красный баннер «Ошибка
  // генерации» вместо чистой отмены. Дальше — общий путь (cancel + статус).
  if (item.type === 'controlnet' && item.promptId) {
    const { markControlNetCancelRequested } = await import('@/lib/controlnet-job-store')
    markControlNetCancelRequested(item.promptId)
  }
  if (item.type === 'fps' && item.promptId) {
    const { markFpsCancelRequested } = await import('@/lib/fps-job-store')
    markFpsCancelRequested(item.promptId)
  }
  if (!item.promptId) {
    // No job yet — just remove from queue
    remove(item.id)
    return
  }
  // Mark cancelled FIRST so the status pollers stop tracking this prompt
  // (they watch for 'cancelled' / removed items) before we hit the API.
  setStatus(item.id, 'cancelled')
  try {
    await fetch('/api/comfy/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt_id: item.promptId }),
    })
  } catch { /* ignore */ }
}

/* ──────────────────── Component ──────────────────── */

export function QueueIndicator({ activeTab }: { activeTab?: string } = {}) {
  const [expanded, setExpanded] = useState(false)
  // The queue store is persisted — on first client render it may already
  // contain items while SSR rendered none → hydration mismatch (React #418).
  // Render only after mount.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  // Global poller: keeps queue alive even when source tab is unmounted
  useGlobalQueuePoller()

  // (правка 442) На вкладках с панелью ассистента справа («Генерация»,
  // «Продление») индикатор сдвигается левее панели, чтобы не перекрывать
  // поле ввода чата. Развёрнутая панель — её ширина, свёрнутый рейл — 46px.
  const panelSpace = useAssistantPanel((s) => (s.collapsed ? 46 : s.width))

  // Single subscription — compute everything from items
  const items = useGenQueue((s) => s.items)
  const clearFinished = useGenQueue((s) => s.clearFinished)
  const remove = useGenQueue((s) => s.remove)

  const activeItems = useMemo(
    () => items.filter((it) => it.status !== 'done' && it.status !== 'error' && it.status !== 'cancelled'),
    [items]
  )
  const activeCount = activeItems.length
  const currentRunning = useMemo(
    () => items.find((it) => it.status === 'running' || it.status === 'submitting' || it.status === 'queued'),
    [items]
  )

  // Don't render anything before mount (SSR) or when there are no items
  if (!mounted || items.length === 0) return null

  const accent = currentRunning ? TYPE_ACCENT[currentRunning.type] : '#8B5CF6'
  const progressPercent =
    currentRunning && currentRunning.progressMax > 0
      ? Math.round((currentRunning.progressValue / currentRunning.progressMax) * 100)
      : 0

  // (правка 442) Отступ справа: панель ассистента на generate/extend
  // (правка 502: и controlnet) + зазор 16px.
  const rightOffset =
    (activeTab === 'generate' || activeTab === 'extend' || activeTab === 'controlnet' ? panelSpace : 0) + 16

  return (
    // Bottom-right corner: stays out of the way of the prompt line.
    // flex-col-reverse makes the expanded panel open UP from the pill.
    <div
      className="fixed bottom-4 z-50 flex flex-col-reverse items-end gap-2 pointer-events-none transition-[right] duration-200 ease-in-out"
      style={{ right: rightOffset }}
    >
      {/* Main floating pill */}
      <motion.div
        layout
        initial={{ opacity: 0, y: -20, scale: 0.9 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -20, scale: 0.9 }}
        className="pointer-events-auto"
      >
        <button
          onClick={() => setExpanded(!expanded)}
          className={cn(
            'flex items-center gap-2.5 pl-3 pr-2 py-2 rounded-xl border backdrop-blur-xl transition-colors',
            'bg-[var(--surface-1)]/90 border-border hover:border-border shadow-lg shadow-black/30',
            activeCount > 0 && 'border-opacity-100'
          )}
          style={activeCount > 0 ? { borderColor: `${accent}40` } : undefined}
        >
          {/* Spinning/pulsing dot */}
          <div className="relative">
            {currentRunning && (
              <motion.div
                className="absolute inset-0 rounded-full"
                style={{ backgroundColor: accent }}
                animate={{ scale: [1, 1.6, 1], opacity: [0.4, 0, 0.4] }}
                transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
              />
            )}
            <div
              className="relative w-2 h-2 rounded-full"
              style={{
                backgroundColor: activeCount > 0 ? accent : '#555',
              }}
            />
          </div>

          {/* Label */}
          <div className="flex flex-col items-start min-w-0">
            <span className="text-xs font-medium text-foreground leading-tight">
              {activeCount > 0
                ? currentRunning
                  ? `${TYPE_LABEL[currentRunning.type]}: ${STATUS_LABEL[currentRunning.status]}`
                  : `${activeCount} в очереди`
                : 'Очередь пуста'}
            </span>
            {/* Real-time message from WanGP (e.g. "Downloading model...") */}
            {currentRunning?.message && (
              <span className="text-[10px] text-blue-400 leading-tight max-w-[180px] truncate">
                {currentRunning.message}
              </span>
            )}
            {currentRunning && currentRunning.progressMax > 0 && (
              <span className="text-[10px] text-muted-foreground font-mono leading-tight">
                {progressPercent}% · {currentRunning.progressValue}/{currentRunning.progressMax}
              </span>
            )}
          </div>

          {/* Queue count badge */}
          {activeCount > 0 && (
            <div
              className="flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-md text-[10px] font-bold text-white"
              style={{ backgroundColor: accent }}
            >
              {activeCount}
            </div>
          )}

          {/* Expand/collapse chevron (points up when collapsed — panel opens upward) */}
          <svg
            className={cn(
              'w-3.5 h-3.5 text-muted-foreground transition-transform',
              !expanded && 'rotate-180'
            )}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      </motion.div>

      {/* Expanded panel */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.95 }}
            transition={{ duration: 0.15 }}
            className="pointer-events-auto w-[300px] max-h-[400px] flex flex-col rounded-xl border bg-[var(--surface-1)]/95 backdrop-blur-xl border-border shadow-xl shadow-black/40 overflow-hidden"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-3 py-2.5 border-b border-border">
              <span className="text-xs font-semibold text-foreground">
                Очередь генераций
              </span>
              <div className="flex items-center gap-1">
                {items.some((it) => it.status === 'done' || it.status === 'error' || it.status === 'cancelled') && (
                  <button
                    onClick={clearFinished}
                    className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-[var(--surface-3)] transition-colors"
                    title="Очистить завершённые"
                  >
                    <Trash2Icon className="w-3 h-3" />
                  </button>
                )}
                <button
                  onClick={() => setExpanded(false)}
                  className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-[var(--surface-3)] transition-colors"
                >
                  <XIcon className="w-3 h-3" />
                </button>
              </div>
            </div>

            {/* Item list */}
            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              {[...items].reverse().map((item) => {
                const Icon = TYPE_ICON[item.type]
                const itemAccent = TYPE_ACCENT[item.type]
                const isActive =
                  item.status === 'submitting' ||
                  item.status === 'queued' ||
                  item.status === 'running'
                const itemProgress =
                  item.progressMax > 0
                    ? Math.round((item.progressValue / item.progressMax) * 100)
                    : 0

                return (
                  <motion.div
                    key={item.id}
                    layout
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -20 }}
                    className={cn(
                      'flex items-center gap-2 p-2 rounded-lg transition-colors group',
                      isActive
                        ? 'bg-[var(--surface-3)]'
                        : 'bg-[var(--surface-2)]/60'
                    )}
                  >
                    {/* Type icon */}
                    <div
                      className="w-7 h-7 rounded-md flex items-center justify-center shrink-0"
                      style={{ backgroundColor: `${itemAccent}15` }}
                    >
                      <Icon className="w-3.5 h-3.5" style={{ color: itemAccent }} />
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <StatusIcon status={item.status} color={itemAccent} message={item.message} />
                        <span className="text-xs font-medium text-foreground truncate">
                          {item.label}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-[10px] text-muted-foreground">
                          {isDownloading(item.message) ? 'Скачивание модели…' : STATUS_LABEL[item.status]}
                        </span>
                        {isActive && item.progressMax > 0 && (
                          <span className="text-[10px] text-muted-foreground font-mono">
                            {itemProgress}%
                          </span>
                        )}
                      </div>
                      {/* Real-time message (e.g. "Downloading model...") */}
                      {item.message && isActive && (
                        <p className={cn("text-[10px] mt-0.5 truncate", isDownloading(item.message) ? "text-cyan-400" : "text-blue-400")}>
                          {item.message}
                        </p>
                      )}
                      {/* (фикс M4) Причина ошибки — раньше панель показывала
                          только «Ошибка», без объяснения. */}
                      {item.error && !isActive && (
                        <p className="text-[10px] mt-0.5 truncate text-red-400" title={item.error}>
                          {item.error}
                        </p>
                      )}
                      {/* Mini progress bar for active items */}
                      {isActive && (
                        <div className="mt-1 h-1 bg-[var(--surface-3)] rounded-full overflow-hidden">
                          {item.progressMax > 0 ? (
                            <motion.div
                              className="h-full rounded-full"
                              style={{ backgroundColor: itemAccent }}
                              initial={false}
                              animate={{ width: `${itemProgress}%` }}
                              transition={{ duration: 0.3 }}
                            />
                          ) : (
                            <motion.div
                              className="h-full rounded-full"
                              style={{ backgroundColor: itemAccent }}
                              animate={{ width: ['0%', '60%', '40%', '70%'] }}
                              transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
                            />
                          )}
                        </div>
                      )}
                    </div>

                    {/* Cancel button (for active items) */}
                    {isActive && (
                      <button
                        onClick={() => cancelQueueItem(item)}
                        className="p-1 rounded-md text-muted-foreground/50 hover:text-red-400 hover:bg-red-900/20 transition-colors opacity-0 group-hover:opacity-100"
                        title="Отменить"
                      >
                        <XCircleIcon className="w-3.5 h-3.5" />
                      </button>
                    )}

                    {/* Remove button (only for finished items) */}
                    {!isActive && (
                      <button
                        onClick={() => remove(item.id)}
                        className="p-1 rounded-md text-muted-foreground/50 hover:text-foreground hover:bg-[var(--surface-3)] transition-colors opacity-0 group-hover:opacity-100"
                      >
                        <XIcon className="w-3 h-3" />
                      </button>
                    )}
                  </motion.div>
                )
              })}
            </div>

            {/* Footer */}
            {activeCount > 0 && (
              <div className="px-3 py-2 border-t border-border">
                <p className="text-[10px] text-muted-foreground text-center">
                  {activeCount} {activeCount === 1 ? 'задача' : activeCount < 5 ? 'задачи' : 'задач'} в очереди
                </p>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}