'use client'

/**
 * (правка 719) Кликабельное превью референса с полноэкранным просмотром.
 * (правка 972) Видео открываются общим VideoLightbox из «Галереи»; картинки и
 * аудио — RefViewerDialog (кроп/обрезка/громкость).
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
import { PlayIcon } from 'lucide-react'
import { RefViewerDialog, type CropRect, type RefViewerData } from './ref-viewer-dialog'
import { VideoLightbox } from './video-lightbox'
import { comfyInputUrl } from '@/lib/crop'
import { cn } from '@/lib/utils'
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
  /** (правка 972) Показывать Play-иконку поверх видео-превью. Для карточек
   *  источников/рефов — да; для строки файла или живого превью — нет. */
  videoIcon?: boolean
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
  videoIcon = true,
  onTrimChange,
  onVolumeChange,
  crop,
  originalSrc,
  onCrop,
}: RefPreviewThumbProps) {
  const { t } = useTranslation() // (правка 955)

  const [data, setData] = useState<RefViewerData | null>(null)
  // (правка 972) Видео открываем ОБЩИМ просмотрщиком галереи (VideoLightbox),
  // а не RefViewerDialog: у прикреплённых видео должен быть тот же плеер,
  // управление и звук, что и у роликов в «Галерее».
  const [videoOpen, setVideoOpen] = useState(false)
  const videoUrl = kind === 'video' ? (url || (path ? comfyInputUrl(path) : undefined)) : undefined
  const canOpen = kind === 'video' ? !!videoUrl : !!(path || url)

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
    if (kind === 'video') {
      setVideoOpen(true)
      onOpen?.(next)
      return
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
        className={cn(className, 'relative')}
      >
        {children}
        {kind === 'video' && videoIcon && canOpen && (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="rounded-full bg-black/55 p-1 ring-1 ring-white/20">
              <PlayIcon className="w-3 h-3 text-white/90" />
            </span>
          </span>
        )}
      </button>
      {videoOpen && videoUrl && (
        <VideoLightbox
          files={[{ url: videoUrl, filename: name, subfolder: '' }]}
          initialIndex={0}
          onClose={() => setVideoOpen(false)}
        />
      )}
      <RefViewerDialog
        data={kind === 'video' ? null : data}
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
