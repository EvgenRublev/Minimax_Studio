'use client'

/**
 * (правка 719) Кликабельное превью референса с полноэкранным просмотром.
 *
 * Зачем: просмотр рефов был реализован только на «Генерации» (картинки и
 * видео) и частично на «Продлении» (только картинки). На остальных вкладках
 * (Refine, ControlNet, Tile Upscale, FPS, Upscale) рефы и исходное видео
 * посмотреть было НЕЛЬЗЯ вообще. Теперь — один компонент и одно поведение
 * везде: клик по превью → просмотр во весь экран (см. RefViewerDialog).
 *
 * Компонент сам держит состояние просмотрщика и рендерит его через портал в
 * body (как VideoLightbox). Родителю достаточно передать kind/name/path/url.
 */
import { useState, type ReactNode } from 'react'
import { RefViewerDialog, type RefViewerData } from './ref-viewer-dialog'

export interface RefPreviewThumbProps {
  /** Тип рефа: картинка / видео / аудио. */
  kind: RefViewerData['kind']
  /** Отображаемое имя (в подписи просмотрщика). */
  name: string
  /** Путь к файлу в ComfyUI input/ (или staging) — для просмотрщика. */
  path?: string
  /** Прямой URL (blob:/file) — приоритетнее path. */
  url?: string
  /** Классы обёртки-кнопки (размер/скругления/рамка — как в конкретной вкладке). */
  className?: string
  /** Подсказка. По умолчанию — «Открыть во весь экран». */
  title?: string
  /** Содержимое превью (img/video/иконка) — рисуется внутри кнопки. */
  children: ReactNode
  /** Аудио: текущая обрезка/громкость — показываются в просмотрщике. */
  trimStart?: number
  trimEnd?: number | null
  audioVolume?: number
  /** Вызывается при открытии просмотрщика (родитель может запомнить id рефа). */
  onOpen?: (data: RefViewerData) => void
  /**
   * Остановить всплытие клика (true — клик по превью не должен доходить до
   * родителя: например, до drop-зоны, открывающей диалог выбора файла —
   * как в extend-view).
   */
  stopPropagation?: boolean
  /** Аудио: обрезка изменилась — сохранить в сторе. */
  onTrimChange?: (start: number, end: number | null) => void
  /** Аудио: громкость изменилась — сохранить в сторе. */
  onVolumeChange?: (v: number) => void
}

export function RefPreviewThumb({
  kind,
  name,
  path,
  url,
  className,
  title,
  children,
  trimStart,
  trimEnd,
  audioVolume,
  onOpen,
  stopPropagation,
  onTrimChange,
  onVolumeChange,
}: RefPreviewThumbProps) {
  const [data, setData] = useState<RefViewerData | null>(null)
  const canOpen = !!(path || url)

  const open = (e: React.MouseEvent) => {
    if (stopPropagation) e.stopPropagation()
    if (!canOpen) return
    const next: RefViewerData = { kind, name, path: path ?? '', url, trimStart, trimEnd, audioVolume }
    setData(next)
    onOpen?.(next)
  }

  return (
    <>
      <button
        type="button"
        onClick={open}
        disabled={!canOpen}
        title={title ?? (canOpen ? 'Открыть во весь экран' : undefined)}
        className={className}
      >
        {children}
      </button>
      <RefViewerDialog
        data={data}
        onOpenChange={(v) => {
          if (!v) setData(null)
        }}
        onTrimChange={(start, end) => {
          setData((d) => (d ? { ...d, trimStart: start, trimEnd: end } : d))
          onTrimChange?.(start, end)
        }}
        onVolumeChange={(v) => {
          setData((d) => (d ? { ...d, audioVolume: v } : d))
          onVolumeChange?.(v)
        }}
      />
    </>
  )
}
