'use client'

/**
 * (правка 987) Верхняя панель на всё окно и на все вкладки.
 * Слева — бренд, по центру — сводка текущей генерации, справа — очередь.
 * Раньше бренд жил в сайдбаре, а очередь плавала поверх контента.
 */
import { useEffect, useState } from 'react'
import { useGenProgress } from '@/lib/gen-progress-store'
import { useGenQueue, TYPE_LABEL } from '@/lib/gen-queue-store'
import { QueueIndicator } from '@/components/queue-indicator'
import { useTranslation } from 'react-i18next'

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  return h > 0
    ? `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
    : `${m}:${String(s % 60).padStart(2, '0')}`
}

function GenerationInfo() {
  const { t } = useTranslation()
  // (правка 998) Сводка берётся из ОБЩЕЙ очереди, а не только из видео-стора:
  // Refine/Tile/FPS/Face/Upscale не пишут в useGenProgress, поэтому панель
  // раньше была пустой при их генерации.
  const items = useGenQueue((s) => s.items)
  const current =
    items.find((i) => i.status === 'running') ??
    items.find((i) => i.status === 'submitting') ??
    items.find((i) => i.status === 'queued')
  const v = useGenProgress((s) => s.video)
  const [, tick] = useState(0)

  useEffect(() => {
    const started = current?.startedAt ?? current?.createdAt
    if (!started || !current) return
    const timer = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [current?.startedAt, current?.createdAt, current])

  if (!current) return null
  const pct = current.progressMax > 0 ? Math.min(100, Math.round((current.progressValue / current.progressMax) * 100)) : 0
  const statusLabel =
    current.status === 'submitting' ? t('Отправка…')
      : current.status === 'queued' ? t('В очереди')
        : t('Генерация…')
  const startedAt = current.startedAt ?? current.createdAt
  const videoDetail = current.type === 'video' && v.promptId === current.promptId
  const detail = v && videoDetail ? (v.executingTitle || v.statusMessage) : current.message

  return (
    <div className="min-w-0 flex-1">
      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-xs font-medium text-cyan-300">
          {t(TYPE_LABEL[current.type])} · {statusLabel}
        </span>
        {current.progressMax > 0 && (
          <span className="shrink-0 text-[11px] font-mono tabular-nums text-cyan-300">{pct}%</span>
        )}
        {startedAt > 0 && (
          <span className="shrink-0 text-[10px] font-mono tabular-nums text-muted-foreground/70">
            {formatElapsed(Date.now() - startedAt)}
          </span>
        )}
        {detail && (
          <span className="min-w-0 truncate text-[11px] text-muted-foreground">
            {t(detail)}
          </span>
        )}
        {videoDetail && v.nodeStep != null && v.nodeTotal != null && v.nodeTotal > 0 && (
          <span className="shrink-0 text-[10px] font-mono tabular-nums text-muted-foreground/70">
            {t('шаг')} {v.nodeStep}/{v.nodeTotal}
          </span>
        )}
      </div>
      <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-[var(--surface-3)]">
        <div
          className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-blue-500 transition-[width] duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

export function AppTopBar({ activeTab }: { activeTab?: string }) {
  return (
    <header className="relative z-40 flex h-14 w-full shrink-0 items-center border-b border-border bg-[var(--surface-1)]">
      {/* Слева — бренд, ширина совпадает с сайдбаром */}
      <div className="flex h-full w-[240px] shrink-0 items-center gap-2.5 border-r border-border px-4">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg gradient-creative shadow-lg shadow-cyan-500/20">
          <span className="text-sm font-bold tracking-tight text-white">H3</span>
        </div>
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-semibold leading-tight text-foreground">
            MiniMax H3 <span className="gradient-creative-text font-bold">Studio 7</span>
          </span>
          <span className="truncate text-[10px] text-muted-foreground">by Evgen Rublev</span>
        </div>
      </div>

      {/* Центр — сводка текущей генерации */}
      <div className="flex min-w-0 flex-1 items-center px-4">
        <GenerationInfo />
      </div>

      {/* Справа — очередь задач */}
      <div className="flex h-full shrink-0 items-center border-l border-border px-3">
        <QueueIndicator activeTab={activeTab} embedded />
      </div>
    </header>
  )
}
