'use client'

/**
 * VideoGalleryGrid — compact video gallery for the video generation tab.
 * Shows generated videos as a grid with thumbnails, click → VideoLightbox player.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom' // (правка 692) портал меню в body — поверх всех элементов UI
import { motion, AnimatePresence } from 'framer-motion'
import {
  DownloadIcon,
  RefreshCcwIcon,
  VideoIcon,
  Trash2Icon,
  InfoIcon,
  RotateCcwIcon,
  SparklesIcon,
  Maximize2Icon,
  FilmIcon,
  Wand2Icon,
  Grid3x3Icon,
  MoreVerticalIcon,
  ScissorsIcon,
  GaugeIcon,
  ZapIcon,
  WaypointsIcon,
  ScanFaceIcon,
  ArrowLeftRightIcon,
  XIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { MetaDialog } from './meta-dialog'
import { VideoTrimDialog } from './video-trim-dialog'
// (правка 729) Полноэкранное сравнение двух видео «до/после».
import { VideoCompareDialog } from './video-compare-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { VideoLightbox } from './video-lightbox'
import { useGenDurations, formatDuration, formatSeconds } from '@/lib/gen-duration-store'
import { restoreFromMeta } from '@/lib/restore-from-meta'
import { useUpscaleTarget } from '@/lib/upscale-target-store'
import { useRefineTarget } from '@/lib/refine-target-store'
import { useTileUpscaleTarget } from '@/lib/tile-upscale-target-store'
import { useControlNetTarget } from '@/lib/controlnet-target-store' // (правка 497)
import { useFpsTarget } from '@/lib/fps-store'
import { useExtendTarget } from '@/lib/extend-target-store'
import { useFaceRefineTarget } from '@/lib/face-refine-target-store'


/** Custom MIME для drag&drop видео из галереи в поле загрузки Upscale. */
export const H3_VIDEO_DND_MIME = 'application/x-h3-video'

/** Thumbnail width for gallery cards (server-side sharp/ffmpeg resize). */
const THUMB_WIDTH = 600

export interface VideoGalleryFile {
  url: string
  filename: string
  subfolder: string
  size?: number
  mtime?: number
  /** Время генерации (секунды) из .meta.json sidecar — показывается на бейдже. */
  generationTime?: number | null
  /** (правка 313) 'draft' → красный бейдж «Draft» на превью. */
  pipeline?: 'draft' | 'full' | null
}

interface VideoGalleryGridProps {
  files: VideoGalleryFile[]
  loading?: boolean
  onRefresh?: () => void
  onDeleteFile?: (filename: string, subfolder: string) => void | Promise<void>
  emptyHint?: string
}

/**
 * (правка 78) Пометки источников видео в галерее:
 * - «DLSS 5» — вывод neural-rendering моста (DLSS 5 Visual Enhancer):
 *   «<исходное>_DLSS5_<YYYYMMDD-HHMMSS-NNNNNN>.ext»
 *   (upscale/src/…/processor.py + core/naming.py, rename_mode=Auto);
 * - «Upscale» — вывод настоящего апскейла (RTX Video SDK, вкладка
 *   «Upscale»): «<исходное>_RTXVIDEO[_PREVIEW]_<stamp>-<uuid8>.ext»
 *   (upscale/src/upscale/video/processor.py:67-69).
 * Minimax-генерации так не называются — это надёжные маркеры.
 * (правка 233) «Extended» — вывод вкладки «Продление»:
 *   «Minimax_Studio_extclip_<i>_<stamp>.ext» (каждый клип) и
 *   «Minimax_Studio_combined*.mp4» (финальная склейка оригинала + клипы).
 * Маркеры уникальны и не пересекаются с обычными генерациями
 * (Minimax_Studio_<stamp>.mp4 — без подстроки extclip/combined).
 * (правка 312) «FPS» — вывод вкладки «FPS» (вставка кадров):
 *   «Minimax_Studio_fps_<stamp>.ext» (filename_prefix в fps-template.ts).
 */
export type VideoSourceBadge = 'dlss5' | 'upscale' | 'extended' | 'refined' | 'tileupscale' | 'fps' | 'edited' | 'controlnet' | 'facerefine' | 'draft'

export function videoSourceBadge(file: Pick<VideoGalleryFile, 'filename'>): VideoSourceBadge | null {
  // (правка 306) "Edited" — самый приоритетный: обрезанный файл всегда обрезанный,
  // независимо от того, что в base name (combined, fps, refine и т.д.)
  if (/_trim_\d/.test(file.filename)) return 'edited'
  if (/_DLSS5_\d{8}-\d{6}-\d{6}/.test(file.filename)) return 'dlss5'
  if (/_RTXVIDEO(?:_PREVIEW)?_\d{8}-\d{6}-[0-9a-f]{8}/.test(file.filename)) return 'upscale'
  if (/Minimax_Studio_extclip_\d+/i.test(file.filename) || /Minimax_Studio_combined/i.test(file.filename)) return 'extended'
  if (/Minimax_Studio_tileupscale/i.test(file.filename)) return 'tileupscale'
  // (правка 497) «ControlNet» — вывод вкладки «ControlNet» (Fun ControlNet).
  if (/Minimax_Studio_controlnet/i.test(file.filename)) return 'controlnet'
  // (правка 722) «Face Refine» — вывод вкладки «Face Refine».
  if (/Minimax_Studio_facerefine/i.test(file.filename)) return 'facerefine'
  if (/Minimax_Studio_refine/i.test(file.filename)) return 'refined'
  // (правка 312) «FPS» — вывод вкладки «FPS»: Minimax_Studio_fps_<stamp>.mp4.
  if (/Minimax_Studio_fps/i.test(file.filename)) return 'fps'
  return null
}

/**
 * (правка 722) ЕДИНЫЙ бейдж на карточку.
 *
 * Раньше бейдж «Draft» рисовался ОТДЕЛЬНО от бейджа источника, оба в одной
 * точке (top-left). Для обрезанного драфта (`X_trim_0-2.mp4`) сайдкар
 * наследует `pipeline: 'draft'` от исходника, поэтому на превью висели
 * ДВА бейджа: жёлтый «Edited» и красный «Draft» — второй перекрывал первый,
 * и пользователь видел «Draft» вместо «Edited».
 *
 * Теперь метка одна, с приоритетом источника: обрезка > DLSS > Upscale >
 * Extend > Tile > ControlNet > Refine > FPS > Draft. «Draft» показывается
 * ТОЛЬКО когда никакой другой источник не распознан (обычная генерация в
 * режиме «Драфт»). Тот же принцип, что у правки 508 для ControlNet.
 */
export function videoGalleryBadge(
  file: Pick<VideoGalleryFile, 'filename' | 'pipeline'>,
): VideoSourceBadge | null {
  const src = videoSourceBadge(file)
  if (src) return src
  if (file.pipeline === 'draft') return 'draft'
  return null
}

function thumbUrl(file: VideoGalleryFile): string {
  // The file URL from /api/comfy/files already carries `&_t=<mtime>` for
  // cache-busting — just add the thumbnail width.
  const sep = file.url.includes('?') ? '&' : '?'
  return `${file.url}${sep}width=${THUMB_WIDTH}`
}

/**
 * Poster URL — server-side extracted JPEG frame (ffmpeg, disk-cached).
 * Used as the <video poster> so the grid paints instantly without
 * downloading full videos.
 */
function posterUrl(file: VideoGalleryFile): string {
  return thumbUrl(file)
}

export const VideoGalleryGrid = memo(function VideoGalleryGrid({
  files,
  loading = false,
  onRefresh,
  onDeleteFile,
  emptyHint = 'Пока нет видео',
}: VideoGalleryGridProps) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const [metaIndex, setMetaIndex] = useState<number | null>(null)
  /** Удаление, ожидающее подтверждения (диалог «Удалить видео?»). */
  const [pendingDelete, setPendingDelete] = useState<{ filename: string; subfolder: string } | null>(null)
  // (правка 272) Индекс карточки, у которой открыто меню действий (MoreVertical)
  const [actionsOpenIndex, setActionsOpenIndex] = useState<number | null>(null)
  // (правка 305) Мини-видеоредактор: файл для обрезки
  const [trimFile, setTrimFile] = useState<VideoGalleryFile | null>(null)
  const [trimOpen, setTrimOpen] = useState(false)
  // (правка 729) Сравнение двух видео: ключи выбранных карточек (Ctrl+клик)
  // и пара файлов, открытая в полноэкранном диалоге.
  const [selectedKeys, setSelectedKeys] = useState<string[]>([])
  const [compare, setCompare] = useState<{ a: VideoGalleryFile; b: VideoGalleryFile } | null>(null)

  /** Ctrl+клик (⌘ на Mac): выбрать/снять. Больше двух не держим — третий
   *  вытесняет самый первый (FIFO), чтобы не блокировать выбор на полпути. */
  const toggleSelect = useCallback((file: VideoGalleryFile) => {
    const key = `${file.subfolder}/${file.filename}`
    setSelectedKeys((prev) => {
      if (prev.includes(key)) return prev.filter((k) => k !== key)
      if (prev.length >= 2) return [prev[1], key]
      return [...prev, key]
    })
  }, [])

  /** Выбранные файлы могли исчезнуть (удаление/обновление списка) — чистим. */
  useEffect(() => {
    setSelectedKeys((prev) => {
      const next = prev.filter((k) => files.some((f) => `${f.subfolder}/${f.filename}` === k))
      return next.length === prev.length ? prev : next
    })
  }, [files])

  const openCompare = useCallback(() => {
    if (selectedKeys.length !== 2) return
    const a = files.find((f) => `${f.subfolder}/${f.filename}` === selectedKeys[0])
    const b = files.find((f) => `${f.subfolder}/${f.filename}` === selectedKeys[1])
    if (!a || !b) return
    setCompare({ a, b })
  }, [selectedKeys, files])

  /* (правка 730) Esc — снять выделение, Enter (при двух выбранных) — сравнение.
     Пока открыт какой-нибудь диалог, клавиши не трогаем: ими управляет диалог. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (compare || pendingDelete || trimOpen) return
      if (e.key === 'Escape' && selectedKeys.length > 0) {
        e.preventDefault()
        setSelectedKeys([])
      } else if (e.key === 'Enter' && selectedKeys.length === 2) {
        e.preventDefault()
        openCompare()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [compare, pendingDelete, trimOpen, selectedKeys, openCompare])
  // (правка 272) Клик вне меню → закрыть (глобальный listener на document)
  useEffect(() => {
    if (actionsOpenIndex === null) return
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.closest('[data-video-actions-menu]'))) return
      setActionsOpenIndex(null)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [actionsOpenIndex])
  const videoRefs = useRef<(HTMLVideoElement | null)[]>([])
  // (правка 692) Ref к кнопке «⋮» каждой карточки — для позиционирования portaled-меню.
  const actionBtnRefs = useRef<(HTMLButtonElement | null)[]>([])
  // (правка 353) При смене списка обрезаем/сбрасываем ref-массив: stale-
  // элементы удалённых карточек продолжали жить в videoRefs и на hover
  // по старому индексу мог проигрываться чужой <video>.
  useEffect(() => {
    videoRefs.current.length = files.length
  }, [files])
  const durations = useGenDurations((s) => s.entries)

  // Build a filename → entry map. Entries without a filename (very old
  // sessions) are NOT matched — an index-based guess ("N-th newest entry ↔
  // N-th newest file") happily showed another video's generation time.
  const durationMap = useMemo(() => {
    const byName = new Map<string, (typeof durations)[0]>()
    const sorted = [...durations].sort((a, b) => b.ts - a.ts)
    for (const entry of sorted) {
      if (entry.filename) {
        byName.set(entry.filename, entry)
      }
    }
    return byName
  }, [durations])

  /* ── «Отправить на апскейл»: кладём цель в store и переключаем вкладку.
   *    UpscaleView заберёт её и импортирует видео через сервер
   *    (/api/upscale/import) — браузер в цикле не участвует. ── */
  const sendToUpscale = useCallback((file: VideoGalleryFile) => {
    useUpscaleTarget.getState().setTarget({ filename: file.filename, subfolder: file.subfolder })
    window.dispatchEvent(new CustomEvent('h3:goto-upscale'))
  }, [])

  /* ── «В Refine»: генеративный v2v-апскейл — тот же паттерн. ── */
  const sendToRefine = useCallback((file: VideoGalleryFile) => {
    useRefineTarget.getState().setTarget({ filename: file.filename, subfolder: file.subfolder })
    window.dispatchEvent(new CustomEvent('h3:goto-refine'))
  }, [])

  /* ── «Tile Upscale»: tiled latent upscale — кладём цель в store + переключаем вкладку. ── */
  const sendToTileUpscale = useCallback((file: VideoGalleryFile) => {
    useTileUpscaleTarget.getState().setTarget({ filename: file.filename, subfolder: file.subfolder })
    window.dispatchEvent(new CustomEvent('h3:goto-tile-upscale'))
  }, [])

  /* ── «Face Refine»: перерисовка мелких лиц — кладём цель в store + переключаем вкладку. ── */
  const sendToFaceRefine = useCallback((file: VideoGalleryFile) => {
    useFaceRefineTarget.getState().setTarget({ filename: file.filename, subfolder: file.subfolder })
    window.dispatchEvent(new CustomEvent('h3:goto-face-refine'))
  }, [])

  /* ── (правка 497) «ControlNet»: видео как контрольный ролик (движение) — тот же паттерн. ── */
  const sendToControlNet = useCallback((file: VideoGalleryFile) => {
    useControlNetTarget.getState().setTarget({ filename: file.filename, subfolder: file.subfolder })
    window.dispatchEvent(new CustomEvent('h3:goto-controlnet'))
  }, [])

  /* ── «FPS»: frame interpolation (RIFE/FILM VFI) — кладём цель в store + переключаем вкладку. ── */
  const sendToFps = useCallback((file: VideoGalleryFile) => {
    useFpsTarget.getState().setTarget({ filename: file.filename, subfolder: file.subfolder })
    window.dispatchEvent(new CustomEvent('h3:goto-fps'))
  }, [])

  /* ── (правка 369) «Продлить»: источник для вкладки «Продление» — тот же паттерн. ── */
  const sendToExtend = useCallback((file: VideoGalleryFile) => {
    useExtendTarget.getState().setTarget({ filename: file.filename, subfolder: file.subfolder })
    window.dispatchEvent(new CustomEvent('h3:goto-extend'))
  }, [])

  /* ── Delete handler (оптимистичное обновление в useVideoGallery) ── */
  const handleDelete = useCallback(
    async (filename: string, subfolder: string) => {
      if (!onDeleteFile) return
      await onDeleteFile(filename, subfolder)
    },
    [onDeleteFile],
  )

  /** Подтвердить отложенное удаление (кнопка «Удалить» или Enter). */
  const confirmPendingDelete = useCallback(async () => {
    if (!pendingDelete) return
    const { filename, subfolder } = pendingDelete
    setPendingDelete(null)
    await handleDelete(filename, subfolder)
  }, [pendingDelete, handleDelete])

  /* ── Empty state ── */
  if (!loading && files.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center py-12">
        <VideoIcon className="w-10 h-10 text-muted-foreground/30 mb-3" />
        <p className="text-sm text-muted-foreground">{emptyHint}</p>
      </div>
    )
  }

  /* ── Loading skeletons ── */
  if (loading) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="aspect-video rounded-lg bg-[var(--surface-2)] animate-pulse"
          />
        ))}
      </div>
    )
  }

  return (
    <>
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <Badge variant="secondary" className="text-xs shrink-0">
            {files.length} видео
          </Badge>
          {/* (правка 729) Подсказка о сравнении: Ctrl+клик по двум карточкам */}
          {selectedKeys.length === 0 ? (
            <span className="hidden sm:inline text-[10px] text-muted-foreground/70 truncate">
              Ctrl+клик по двум видео — сравнить
            </span>
          ) : (
            <span className="text-[10px] text-muted-foreground truncate">
              {selectedKeys.length === 1
                ? 'Выбрано 1 из 2 — выберите ещё одно'
                : 'Можно сравнить'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {/* (правка 729) Кнопка «Сравнить» появляется, когда выбраны ровно два видео */}
          {selectedKeys.length === 2 && (
            <Button
              size="sm"
              onClick={openCompare}
              className="h-7 gap-1.5 px-2.5 text-xs bg-cyan-500 hover:bg-cyan-400 text-black font-semibold"
              title="Открыть сравнение до/после (Enter)"
            >
              <ArrowLeftRightIcon className="w-3.5 h-3.5" />
              Сравнить
            </Button>
          )}
          {selectedKeys.length > 0 && (
            <button
              onClick={() => setSelectedKeys([])}
              className="p-1.5 rounded-lg hover:bg-[var(--surface-3)] text-muted-foreground transition-colors"
              title="Сбросить выбор (Esc)"
            >
              <XIcon className="w-3.5 h-3.5" />
            </button>
          )}
          {onRefresh && (
            <button
              onClick={() => onRefresh()}
              className="p-1.5 rounded-lg hover:bg-[var(--surface-3)] text-muted-foreground transition-colors"
              title="Обновить"
            >
              <RefreshCcwIcon className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
        <AnimatePresence mode="popLayout">
          {files.map((file, index) => (
            <motion.div
              key={`${file.subfolder}/${file.filename}`}
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              className={cn(
                'group relative aspect-video rounded-lg border border-border bg-[var(--surface-2)] cursor-pointer transition-shadow',
                // (правка 729) Подсветка выбранных для сравнения
                selectedKeys.includes(`${file.subfolder}/${file.filename}`) &&
                  'ring-2 ring-cyan-400 border-cyan-400/60 shadow-[0_0_14px_rgba(34,211,238,0.35)]',
              )}
              onClick={(e) => {
                // (правка 729) Ctrl/⌘+клик — выбор для сравнения, обычный клик — лайтбокс.
                if (e.ctrlKey || e.metaKey) {
                  e.preventDefault()
                  toggleSelect(file)
                  return
                }
                setLightboxIndex(index)
              }}
              // (правка 388) draggable потерялся при рефакторинге меню (272/379):
              // без атрибута браузер вообще не стартует HTML5-DnD, и ломался
              // drag&drop карточек ВО ВСЕ цели (Upscale/Refine/FPS/Tile/Продление/
              // папки галереи). Обработчик ниже лишь заполняет dataTransfer.
              draggable
              onDragStartCapture={(e) => {
                // Drag&drop в поле загрузки Upscale: отдаём имя файла из
                // общей папки output (а не локальный File) — upscale-view
                // импортирует его на сервере (/api/upscale/import).
                // (правка 93) 'copyMove': цель в галерее папок объявляет
                // dropEffect 'move' — при effectAllowed 'copy' браузер
                // считает их несовместимыми и событие drop НЕ наступает.
                e.dataTransfer.setData(
                  H3_VIDEO_DND_MIME,
                  JSON.stringify({ filename: file.filename, subfolder: file.subfolder }),
                )
                e.dataTransfer.setData('text/plain', file.filename)
                e.dataTransfer.effectAllowed = 'copyMove'
              }}
              onPointerEnter={() => { videoRefs.current[index]?.play().catch(() => {}) }}
              onPointerLeave={() => { const v = videoRefs.current[index]; if (v) { v.pause(); v.currentTime = 0; } }}
            >
              {/* Video thumbnail — poster JPEG (server-cached) + lazy video.
                  preload="none" keeps the grid light: full video streams
                  only on hover (pointer events below) or in the lightbox. */}
              <video
                ref={(el) => { videoRefs.current[index] = el }}
                src={file.url}
                poster={posterUrl(file)}
                muted
                loop
                preload="none"
                playsInline
                className="w-full h-full object-cover pointer-events-none rounded-lg"
                onLoadedMetadata={(e) => { e.currentTarget.currentTime = 0; }}
              />

              {/* (правка 729) Метка выбранного для сравнения: A — «до», B — «после».
                  Порядок выбора задаёт сторону (первый = A), поэтому метка
                  подписана буквой, а не просто галочкой. */}
              {selectedKeys.includes(`${file.subfolder}/${file.filename}`) && (() => {
                const selIndex = selectedKeys.indexOf(`${file.subfolder}/${file.filename}`)
                return (
                  <div className="absolute inset-0 z-[5] flex items-center justify-center pointer-events-none">
                    <span
                      className={cn(
                        'w-9 h-9 rounded-full flex items-center justify-center text-sm font-extrabold border-2 shadow-lg backdrop-blur-sm',
                        selIndex === 0
                          ? 'bg-cyan-500/85 text-black border-cyan-100/80'
                          : 'bg-fuchsia-500/85 text-black border-fuchsia-100/80',
                      )}
                      title={selIndex === 0 ? 'A — «до» (слева)' : 'B — «после» (справа)'}
                    >
                      {selIndex === 0 ? 'A' : 'B'}
                    </span>
                  </div>
                )
              })()}

              {/* (правка 272) Одна кнопка в правом верхнем углу → меню действий.
                  Hover-оверлей больше не перекрывает всё превью: превью видно
                  полностью, а действия открываются по клику на «⋮».
                  (правка 379) Открытое меню НЕ гасим вместе с hover-обёрткой:
                  раньше уход курсора с карточки делал opacity-0 и самому меню. */}
              <div
                data-video-actions-menu
                className={`absolute top-1.5 right-1.5 transition-opacity z-10 ${
                  actionsOpenIndex === index
                    ? 'opacity-100'
                    : 'opacity-0 group-hover:opacity-100'
                }`}
              >
                <button
                  ref={(el) => { if (el) actionBtnRefs.current[index] = el }}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    setActionsOpenIndex((prev) => (prev === index ? null : index))
                  }}
                  className="p-1.5 rounded-lg bg-black/60 backdrop-blur-sm hover:bg-black/80 text-white transition-colors"
                  title="Действия"
                >
                  <MoreVerticalIcon className="w-4 h-4" />
                </button>
                {(actionsOpenIndex === index && actionBtnRefs.current[index]) && (() => {
                  /* (правка 692, доп. правка 700) Меню действий через createPortal в
                     document.body. Portal + fixed + z-[300] — поверх UI по z-индексу.

                     (правка 700) РЕАЛЬНАЯ причина перекрытия: position:fixed-потомок
                     ОБРЕЗАЕТСЯ stacking-context предка — а AnimatePresence mode="popLayout"
                     ставит transform на обёртку грида (создаёт stacking context). Поэтому
                     левая панель (сосед по DOM) рисовалась ПОВЕРХ меню при любом z-index.
                     Решение независимо от z: открываем меню НАЛЕВО (якорь — правый край
                     кнопки). Кнопка «⋮» сидит в правом верхнем углу карточки, так что
                     меню целиком остаётся в правой зоне галереи и физически НЕ МОЖЕТ
                     залезть под левую панель при любом размере окна. top/left клампим
                     к вьюпорту, чтобы не вылезло за нижний/левый край. */
                  const _btn = actionBtnRefs.current[index]!
                  const _rect = _btn.getBoundingClientRect()
                  const _MENU_W = 224 // 14rem
                  const _MENU_H = 560 // запас: реальный рост ~470px, кламп влезает
                  const _top = Math.max(4, Math.min(_rect.bottom + 4, window.innerHeight - _MENU_H - 4))
                  // Меню занимает [left .. left+_MENU_W]; правый край = правый край кнопки.
                  let _left = _rect.right - _MENU_W
                  if (_left < 4) _left = Math.max(4, _rect.left) // слишком узко — сдвигаем вправо
                  return createPortal(
                  <div
                    data-video-actions-menu
                    className="fixed z-[300] flex flex-col gap-0.5 p-1 rounded-lg border border-border bg-[var(--surface-1)] shadow-xl"
                    style={{
                      top: _top,
                      left: _left,
                      width: '14rem',
                    }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {/* (правка 371 сделала меню сеткой 5×2 из иконок — на практике
                       оно схлопывалось в крошечный штраф (abspos shrink-to-fit
                       зажимался шириной обёртки кнопки «⋮», колонки
                       minmax(0,1fr) схлопываются в ноль) и значки не читались.
                       (правка 380) ОТКАТ к версии с надписями: вертикальный
                       список «иконка + подпись», явная ширина w-56 — не зависит
                       от контекста позиционирования. Тултипы не нужны: подпись
                       видна всегда.
                       (правка 717) Комментарий стоял ГОЛЫМ блок-комментарием —
                       в JSX это не комментарий, а текст: он печатался в меню
                       поверх пунктов. В JSX комментарий оборачивается в
                       фигурные скобки. */}
                    <a
                      href={file.url}
                      download={file.filename}
                      onClick={(e) => { e.stopPropagation(); setActionsOpenIndex(null) }}
                      title="Скачать"
                      className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-xs text-foreground hover:bg-[var(--surface-3)] transition-colors"
                    >
                      <DownloadIcon className="w-4 h-4 shrink-0 text-muted-foreground" />
                      Скачать
                    </a>
                    <button
                      onClick={() => { setMetaIndex(index); setActionsOpenIndex(null) }}
                      title="Метаданные"
                      className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-xs text-foreground hover:bg-[var(--surface-3)] transition-colors text-left"
                    >
                      <InfoIcon className="w-4 h-4 shrink-0 text-muted-foreground" />
                      Метаданные
                    </button>
                    <button
                      onClick={() => {
                        void restoreFromMeta(`${file.subfolder}/${file.filename}`)
                        setActionsOpenIndex(null)
                      }}
                      title="Повторить генерацию"
                      className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-xs text-foreground hover:bg-[var(--surface-3)] transition-colors text-left"
                    >
                      <RotateCcwIcon className="w-4 h-4 shrink-0 text-cyan-400" />
                      Повторить генерацию
                    </button>
                    <button
                      onClick={() => {
                        sendToUpscale(file)
                        setActionsOpenIndex(null)
                      }}
                      title="Отправить на апскейл (DLSS 5)"
                      className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-xs text-foreground hover:bg-[var(--surface-3)] transition-colors text-left"
                    >
                      <SparklesIcon className="w-4 h-4 shrink-0 text-violet-400" />
                      Апскейл (DLSS 5)
                    </button>
                    <button
                      onClick={() => {
                        sendToRefine(file)
                        setActionsOpenIndex(null)
                      }}
                      title="В Refine (v2v-апскейл)"
                      className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-xs text-foreground hover:bg-[var(--surface-3)] transition-colors text-left"
                    >
                      <Wand2Icon className="w-4 h-4 shrink-0 text-emerald-400" />
                      Рефайн (v2v)
                    </button>
                    <button
                      onClick={() => {
                        sendToTileUpscale(file)
                        setActionsOpenIndex(null)
                      }}
                      title="В Tile Upscale"
                      className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-xs text-foreground hover:bg-[var(--surface-3)] transition-colors text-left"
                    >
                      <Grid3x3Icon className="w-4 h-4 shrink-0 text-pink-400" />
                      Tile Upscale
                    </button>
                    <button
                      onClick={() => {
                        sendToFaceRefine(file)
                        setActionsOpenIndex(null)
                      }}
                      title="Перерисовать лица (вкладка «Face Refine»)"
                      className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-xs text-foreground hover:bg-[var(--surface-3)] transition-colors text-left"
                    >
                      <ScanFaceIcon className="w-4 h-4 shrink-0 text-lime-400" />
                      Face Refine
                    </button>
                    <button
                      onClick={() => {
                        sendToControlNet(file)
                        setActionsOpenIndex(null)
                      }}
                      title="Использовать как контрольное видео (вкладка «ControlNet»)"
                      className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-xs text-foreground hover:bg-[var(--surface-3)] transition-colors text-left"
                    >
                      <WaypointsIcon className="w-4 h-4 shrink-0 text-orange-400" />
                      ControlNet (движение)
                    </button>
                    <button
                      onClick={() => {
                        sendToFps(file)
                        setActionsOpenIndex(null)
                      }}
                      title="Увеличить FPS"
                      className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-xs text-foreground hover:bg-[var(--surface-3)] transition-colors text-left"
                    >
                      <GaugeIcon className="w-4 h-4 shrink-0 text-cyan-400" />
                      Увеличить FPS
                    </button>
                    <button
                      onClick={() => {
                        sendToExtend(file)
                        setActionsOpenIndex(null)
                      }}
                      title="Продлить"
                      className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-xs text-foreground hover:bg-[var(--surface-3)] transition-colors text-left"
                    >
                      <FilmIcon className="w-4 h-4 shrink-0 text-cyan-400" />
                      Продлить
                    </button>
                    <button
                      onClick={() => {
                        setTrimFile(file)
                        setTrimOpen(true)
                        setActionsOpenIndex(null)
                      }}
                      title="Обрезать"
                      className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-xs text-foreground hover:bg-[var(--surface-3)] transition-colors text-left"
                    >
                      <ScissorsIcon className="w-4 h-4 shrink-0 text-amber-400" />
                      Обрезать
                    </button>
                    {onDeleteFile && (
                      <button
                        onClick={() => {
                          setPendingDelete({ filename: file.filename, subfolder: file.subfolder })
                          setActionsOpenIndex(null)
                        }}
                        title="Удалить"
                        className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-xs text-red-400 hover:bg-red-500/10 transition-colors text-left"
                      >
                        <Trash2Icon className="w-4 h-4 shrink-0" />
                        Удалить
                      </button>
                    )}
                  </div>, document.body)
                  })()}
              </div>

              {/* (правки 78, 233) Пометка источника — результат DLSS 5 / апскейла
                  / продления. Всегда видна, не только при наведении.
                  (правка 722) Метка ОДНА: videoGalleryBadge отдаёт источник
                  с приоритетом, «Draft» — только если другого источника нет. */}
              {(() => {
                const badge = videoGalleryBadge(file)
                if (!badge) return null
                if (badge === 'upscale') {
                  return (
                    <span
                      className="absolute top-1.5 left-1.5 inline-flex items-center gap-1 rounded-md bg-black/60 backdrop-blur-sm px-1.5 py-0.5 text-[10px] font-semibold text-cyan-300 border border-cyan-400/40"
                      title="Результат апскейла (RTX Video SDK, вкладка «Upscale»)"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Maximize2Icon className="w-2.5 h-2.5" />
                      Upscale
                    </span>
                  )
                }
                if (badge === 'dlss5') {
                  return (
                    <span
                      className="absolute top-1.5 left-1.5 inline-flex items-center gap-1 rounded-md bg-black/60 backdrop-blur-sm px-1.5 py-0.5 text-[10px] font-semibold text-fuchsia-300 border border-fuchsia-400/40"
                      title="Результат апскейла (вкладка «Upscale»)"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <SparklesIcon className="w-2.5 h-2.5" />
                      DLSS 5
                    </span>
                  )
                }
                // «Refined» — генеративный апскейл вкладки «Refine»:
                // Minimax_Studio_refine_<stamp>.mp4.
                if (badge === 'refined') {
                  return (
                    <span
                      className="absolute top-1.5 left-1.5 inline-flex items-center gap-1 rounded-md bg-black/60 backdrop-blur-sm px-1.5 py-0.5 text-[10px] font-semibold text-emerald-300 border border-emerald-400/40"
                      title="Генеративный апскейл (вкладка «Refine», v2v)"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Wand2Icon className="w-2.5 h-2.5" />
                      Refined
                    </span>
                  )
                }
                // «TileUpscale» — tiled latent upscale (вкладка «Tile Upscale»).
                if (badge === 'tileupscale') {
                  return (
                    <span
                      className="absolute top-1.5 left-1.5 inline-flex items-center gap-1 rounded-md bg-black/60 backdrop-blur-sm px-1.5 py-0.5 text-[10px] font-semibold text-pink-300 border border-pink-400/40"
                      title="Tiled latent upscale (вкладка «Tile Upscale»)"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Grid3x3Icon className="w-2.5 h-2.5" />
                      Tile
                    </span>
                  )
                }
                // (правка 497) «ControlNet» — генерация по контрольному видео
                // (вкладка «ControlNet»): Minimax_Studio_controlnet_<stamp>.mp4.
                // (правка 508) Двухпроходный режим (pipeline='full' в мете) —
                // бейдж «ControlNet x2».
                if (badge === 'controlnet') {
                  const twoPass = file.pipeline === 'full'
                  return (
                    <span
                      className="absolute top-1.5 left-1.5 inline-flex items-center gap-1 rounded-md bg-black/60 backdrop-blur-sm px-1.5 py-0.5 text-[10px] font-semibold text-orange-300 border border-orange-400/40"
                      title={twoPass
                        ? 'Генерация по контрольному видео, два прохода (вкладка «ControlNet»)'
                        : 'Генерация по контрольному видео (вкладка «ControlNet»)'}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <WaypointsIcon className="w-2.5 h-2.5" />
                      {twoPass ? 'ControlNet x2' : 'ControlNet'}
                    </span>
                  )
                }
                // (правка 312) «FPS» — вывод вкладки «FPS»:
                // Minimax_Studio_fps_<stamp>.mp4 (RIFE/FILM VFI, вставка кадров).
                // Фиолетовый — чтобы не путать с cyan-маркерами Upscale/Extended.
                if (badge === 'fps') {
                  return (
                    <span
                      className="absolute top-1.5 left-1.5 inline-flex items-center gap-1 rounded-md bg-black/60 backdrop-blur-sm px-1.5 py-0.5 text-[10px] font-semibold text-violet-300 border border-violet-400/40"
                      title="Увеличение FPS (вкладка «FPS», вставка кадров)"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <GaugeIcon className="w-2.5 h-2.5" />
                      FPS
                    </span>
                  )
                }
                // (правка 233) «Extended» — вывод вкладки «Продление»:
                // Minimax_Studio_extclip_<i> (клип) / Minimax_Studio_combined (склейка).
                if (badge === 'extended') {
                  return (
                    <span
                      className="absolute top-1.5 left-1.5 inline-flex items-center gap-1 rounded-md bg-black/60 backdrop-blur-sm px-1.5 py-0.5 text-[10px] font-semibold text-cyan-300 border border-cyan-400/40"
                      title="Результат продления (вкладка «Продление»)"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <FilmIcon className="w-2.5 h-2.5" />
                      Extended
                    </span>
                  )
                }
                // (правка 722) «Face Refine» — вывод вкладки «Face Refine»:
                // Minimax_Studio_facerefine_<stamp>.mp4.
                if (badge === 'facerefine') {
                  return (
                    <span
                      className="absolute top-1.5 left-1.5 inline-flex items-center gap-1 rounded-md bg-black/60 backdrop-blur-sm px-1.5 py-0.5 text-[10px] font-semibold text-lime-300 border border-lime-400/40"
                      title="Перерисованные лица (вкладка «Face Refine»)"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <ScanFaceIcon className="w-2.5 h-2.5" />
                      Face Refine
                    </span>
                  )
                }
                // (правка 305) «Edited» — результат обрезки видео.
                if (badge === 'edited') {
                  return (
                    <span
                      className="absolute top-1.5 left-1.5 inline-flex items-center gap-1 rounded-md bg-black/60 backdrop-blur-sm px-1.5 py-0.5 text-[10px] font-semibold text-amber-300 border border-amber-400/40"
                      title="Отредактировано (обрезка)"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <ScissorsIcon className="w-2.5 h-2.5" />
                      Edited
                    </span>
                  )
                }
                // (правка 313) Красный бейдж «Draft» — однопроходная генерация
                // (pipeline='draft' в .meta.json). Показывается ТОЛЬКО когда
                // другого источника нет (videoGalleryBadge): у обрезанного
                // драфта приоритет у «Edited», у ControlNet — у «ControlNet»
                // (правка 508), у Refine/FPS/Extend/Tile — у их бейджей.
                if (badge === 'draft') {
                  return (
                    <span
                      className="absolute top-1.5 left-1.5 inline-flex items-center gap-1 rounded-md bg-black/60 backdrop-blur-sm px-1.5 py-0.5 text-[10px] font-semibold text-red-300 border border-red-400/40"
                      title="Драфт: один проход в черновом разрешении (апгрейд — вкладка «Refine»)"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <ZapIcon className="w-2.5 h-2.5" />
                      Draft
                    </span>
                  )
                }
              })()}

              {/* Filename + duration badge.
                  (правка 522) Убран градиент-затемнение снизу — пользователь
                  просил убрать во всех режимах. Текст остаётся на тонком
                  полупрозрачном фоне без градиента. */}
              <div className="absolute bottom-0 left-0 right-0 rounded-b-lg p-1.5">
                <div className="flex items-center justify-between gap-1">
                  <p className="text-[10px] text-white/70 truncate font-mono">
                    {String(files.length - index).padStart(3, '0')}
                  </p>
                  {(() => {
                    // Время генерации: приоритет — значение из метаданных
                    // (.meta.json → generation_time, то же, что в диалоге
                    // метаданных); фолбэк — клиентская оценка useGenDurations.
                    const metaSec = typeof file.generationTime === 'number' && file.generationTime > 0
                      ? file.generationTime
                      : null
                    const storeEntry = durationMap.get(file.filename)
                    const label = metaSec != null
                      ? formatSeconds(metaSec)
                      : storeEntry
                        ? formatDuration(storeEntry.durationMs)
                        : null
                    if (!label) return null
                    return (
                      <span
                        className="text-[10px] text-cyan-300/80 font-medium shrink-0"
                        title="Время генерации (из метаданных)"
                      >
                        {label}
                      </span>
                    )
                  })()}
                </div>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {/* Lightbox: onDelete вызывает удаление напрямую — у лайтбокса есть
          собственное inline-подтверждение, второй диалог здесь не нужен
          (раньше было двойное подтверждение). */}
      {lightboxIndex !== null && (
        <VideoLightbox
          files={files.map((f) => ({ url: f.url, filename: f.filename, subfolder: f.subfolder }))}
          initialIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onDelete={onDeleteFile ? (filename, subfolder) => handleDelete(filename, subfolder) : undefined}
        />
      )}

      {/* Metadata dialog */}
      {metaIndex !== null && files[metaIndex] && (
        <MetaDialog
          filePath={`${files[metaIndex].subfolder}/${files[metaIndex].filename}`}
          filename={files[metaIndex].filename}
          onClose={() => setMetaIndex(null)}
        />
      )}

      {/* (правка 305) Мини-видеоредактор — обрезка видео */}
      <VideoTrimDialog
        file={trimFile}
        open={trimOpen}
        onOpenChange={(v) => { setTrimOpen(v); if (!v) setTrimFile(null) }}
        onDone={() => onRefresh?.()}
      />

      {/* (правка 729) Полноэкранное сравнение двух выбранных видео */}
      {compare && (
        <VideoCompareDialog
          a={compare.a}
          b={compare.b}
          onClose={() => setCompare(null)}
        />
      )}

      {/* Delete confirmation — Enter confirms, Esc cancels */}
      <Dialog open={!!pendingDelete} onOpenChange={(v) => !v && setPendingDelete(null)}>
        <DialogContent
          className="max-w-sm"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void confirmPendingDelete()
            }
          }}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Trash2Icon className="w-4 h-4 text-red-400" />
              Удалить видео?
            </DialogTitle>
            <DialogDescription>
              Файл «{pendingDelete?.filename}» и его метаданные будут удалены
              безвозвратно. Это действие нельзя отменить.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 mt-1">
            <Button variant="outline" size="sm" onClick={() => setPendingDelete(null)}>
              Отмена
            </Button>
            <Button
              variant="destructive"
              size="sm"
              autoFocus
              onClick={() => void confirmPendingDelete()}
            >
              <Trash2Icon className="w-3.5 h-3.5" />
              Удалить
            </Button>
          </div>
          <p className="text-[10px] text-muted-foreground/50 text-right -mt-1">
            Enter — удалить · Esc — отмена
          </p>
        </DialogContent>
      </Dialog>
    </>
  )
})
