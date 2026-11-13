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
import { RefViewerDialog, type CropRect, type RefViewerData } from './ref-viewer-dialog'
import { useTranslation } from 'react-i18next' // (правка 955)

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
  /** (правка 895) Картинки: текущий кроп (рамка при повторном кропе). */
  crop?: CropRect
  /** (правка 895) Картинки: URL оригинала — режим кропа всегда показывает его. */
  originalSrc?: string
  /** (правка 895) Картинки: применить кроп — родитель загружает PNG и
   *  обновляет путь рефа. Без колбэка кнопка кропа не показывается. */
  onCrop?: (rect: CropRect, blob: Blob) => void
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
  crop,
  originalSrc,
  onCrop,
}: RefPreviewThumbProps) {
  const { t } = useTranslation() // (правка 955)

  const [data, setData] = useState<RefViewerData | null>(null)
  const canOpen = !!(path || url)

  const open = (e: React.MouseEvent) => {
    if (stopPropagation) e.stopPropagation()
    if (!canOpen) return
    const next: RefViewerData = {
      kind,
      name,
      path: path ?? '',
      url,
      trimStart,
      trimEnd,
      audioVolume,
      crop,
      originalSrc,
    }
    setData(next)
    onOpen?.(next)
  }

  return (
    <>
      <button
        type="button"
        onClick={open}
        disabled={!canOpen}
        title={title ?? (canOpen ? t("Открыть во весь экран") : undefined)}
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
        onCropChange={
          onCrop
            ? (rect, blob) => {
                // Локально показываем кроп сразу и запоминаем оригинал,
                // чтобы повторный кроп снова начинался с него.
                setData((d) =>
                  d
                    ? {
                        ...d,
                        crop: rect,
                        originalSrc:
                          d.originalSrc ||
                          d.url ||
                          (d.path
                            ? `/api/comfy/file?filename=${encodeURIComponent(d.path)}&type=input`
                            : undefined),
                        url: URL.createObjectURL(blob),
                      }
                    : d,
                )
                onCrop(rect, blob)
              }
            : undefined
        }
      />
    </>
  )
}
