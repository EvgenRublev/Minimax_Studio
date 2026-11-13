'use client'

/**
 * Reference viewer — полноэкранный просмотр референса
 * (изображение / видео с плеером / аудио с редактором обрезки).
 * Источник файла — ComfyUI input/ (или локальный staging) через
 * /api/comfy/file, поэтому staged-рефы доступны офлайн.
 *
 * (правка 1) Аудио: встроенный редактор обрезки (start/end в секундах).
 * Обрезка ВИРТУАЛЬНАЯ: значения уходят в воркфлоу (нода AudioTrim режет
 * тензор), обрезанные копии файлов не создаются.
 *
 * (правка 717) Переделан ПО ТИПУ ВИДЕО-ПЛЕЕРА (video-lightbox.tsx):
 *   • настоящий полный экран — fixed inset-0 (было w-[98vw] h-[95vh] у
 *     Radix-диалога: оставался зазор по краям, и оверлей просвечивал —
 *     это и читалось как «рамка»);
 *   • никакого Dialog-каркаса: ни рамки, ни скруглений, ни отдельного
 *     оверлея — просто чёрный экран с картинкой;
 *   • верхняя панель-градиент с именем файла и крестиком, автоскрытие
 *     при бездействии мыши (как в плеере);
 *   • клик по чёрному фону закрывает, Esc закрывает, колесо скроллит.
 */
import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { createPortal } from 'react-dom' // (правка 692) портал в body — без рамки, на весь экран
import { motion, AnimatePresence } from 'framer-motion'
import { FilmIcon, ImageIcon, AudioLinesIcon, PlayIcon, PauseIcon, XIcon, CropIcon } from 'lucide-react'

// (правка 908) Тип кропа вынесен в src/lib/crop.ts — он нужен и всем остальным
// местам, где подключён кроп референсов. Ре-экспорт оставлен, чтобы существующие
// импорты `from './ref-viewer-dialog'` продолжали работать.
import { FULL_CROP, type CropRect } from '@/lib/crop'
export type { CropRect } from '@/lib/crop'
// (правка 909) Полноразмерный адрес: вкладки ControlNet/Refine передают сюда
// миниатюру (`...&width=200`) — во весь экран открывалась она же, крошечная.
import { fullSizeRefUrl } from '@/lib/ref-url'
import { useTranslation } from 'react-i18next' // (правка 955)

export interface RefViewerData {
  kind: 'image' | 'video' | 'audio'
  name: string
  /** ComfyUI input/ filename (staged names are served too). */
  path: string
  /** (правка 476) Прямой URL источника (blob:-превью свежезагруженного
   *  файла, которого ещё нет в input/). Приоритетнее path. */
  url?: string
  /** (правка 1) Audio: текущая обрезка, секунды. trimEnd null/0 = до конца. */
  trimStart?: number
  trimEnd?: number | null
  /** (правка 694) Audio: громкость 0–1 (default 0.5) — виртуальная (нода AudioGain). */
  audioVolume?: number
  /** (правка 895) Изображения: текущий кроп (рамка для повторного редактирования). */
  crop?: CropRect
  /** (правка 895) Изображения: URL ОРИГИНАЛА (до кропа) — режим кропа всегда
   *  показывает оригинал, даже если картинка уже обрезана. */
  originalSrc?: string
}

/** Формат 0:00.0 для подписей времени. */
function fmt(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec - m * 60
  return `${m}:${s.toFixed(1).padStart(4, '0')}`
}

/** (правка 1) Плеер + обрезка аудио-референса. */
function AudioTrimEditor({
  src,
  trimStart,
  trimEnd,
  onTrimChange,
  /** (правка 694) Громкость 0–1, default 0.5. */
  volume = 0.5,
  onVolumeChange,
}: {
  src: string
  trimStart?: number
  trimEnd?: number | null
  onTrimChange?: (start: number, end: number | null) => void
  /** (правка 694) Громкость 0–1 (default 0.5), персистится на реф. */
  volume?: number
  onVolumeChange?: (v: number) => void
}) {
  const { t } = useTranslation() // (правка 955)

  const audioRef = useRef<HTMLAudioElement>(null)
  const [duration, setDuration] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [pos, setPos] = useState(0)

  const start = Math.min(trimStart ?? 0, duration || Infinity)
  const end = trimEnd && trimEnd > 0 ? Math.min(trimEnd, duration || trimEnd) : duration

  // Автостоп на конце выделения при воспроизведении.
  useEffect(() => {
    const el = audioRef.current
    if (!el || !playing) return
    const onTime = () => {
      setPos(el.currentTime)
      if (end > 0 && el.currentTime >= end) {
        el.pause()
        setPlaying(false)
      }
    }
    el.addEventListener('timeupdate', onTime)
    return () => el.removeEventListener('timeupdate', onTime)
  }, [playing, end])

  // (правка 694) Громкость плеера = громкость рефа (persist).
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = Math.max(0, Math.min(1, volume))
  }, [volume])

  const togglePlay = () => {
    const el = audioRef.current
    if (!el) return
    if (playing) {
      el.pause()
      setPlaying(false)
    } else {
      // Старт воспроизведения — от начала выделения (или с текущей точки внутри него)
      if (el.currentTime < start || (end > 0 && el.currentTime >= end)) el.currentTime = start
      void el.play()
      setPlaying(true)
    }
  }

  const changeStart = (v: number) => {
    const s = Math.max(0, Math.min(v, (end || duration) - 0.05))
    onTrimChange?.(Math.round(s * 100) / 100, trimEnd ?? null)
  }
  const changeEnd = (v: number) => {
    const e = Math.max(start + 0.05, Math.min(v, duration))
    // Конец = длительности файла → null («до конца», без чисел)
    onTrimChange?.(start, duration > 0 && e >= duration - 0.005 ? null : Math.round(e * 100) / 100)
  }

  const trimmed = start > 0.004 || (trimEnd != null && trimEnd > 0)

  return (
    // (правка 702) Компактный плеер: была max-w-2xl (672px) + gap-4 + py-6 —
    // слишком «вытянутый» столбик в широком окне. Теперь max-w-md (448px),
    // плотнее: gap-3, py-3; иконка 16 → 12.
    <div className="w-full max-w-md flex flex-col items-center gap-3 py-3">
      <AudioLinesIcon className="w-12 h-12 text-emerald-400/60" />
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
        onEnded={() => setPlaying(false)}
      />

      {/* (правка 694) px-4: Play и «Сбросить обрезку» больше не прижаты к краям. */}
      <div className="w-full px-4 flex items-center gap-3">
        <button
          type="button"
          onClick={togglePlay}
          className="w-9 h-9 rounded-full bg-emerald-500/20 border border-emerald-400/40 flex items-center justify-center text-emerald-300 hover:bg-emerald-500/30 transition-colors shrink-0"
          title={playing ? t("Пауза") : t("Играть выделение")}
        >
          {playing ? <PauseIcon className="w-4 h-4" /> : <PlayIcon className="w-4 h-4 ml-0.5" />}
        </button>
        <span className="text-xs font-mono text-muted-foreground">
          {fmt(pos)} / {duration > 0 ? fmt(duration) : '…'}
        </span>
        {trimmed && (
          <button
            type="button"
            onClick={() => onTrimChange?.(0, null)}
            className="ml-auto text-[10px] text-red-300 hover:text-red-200 transition-colors"
          >
            {t("Сбросить обрезку")}
          </button>
        )}
      </div>

      {/* (правка 694) Карточка без рамки: убраны border + bg, оставлен только отступ.
          (правка 702) space-y-3 → space-y-2 — компактнее блок обрезки/громкости. */}
      {duration > 0 && (
        <div className="w-full space-y-2 px-4">
          <div className="space-y-1">
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>{t("Начало")}</span>
              <span className="font-mono text-emerald-300">{fmt(start)}</span>
            </div>
            <input
              type="range"
              min={0}
              max={duration}
              step={0.01}
              value={start}
              onChange={(e) => changeStart(parseFloat(e.target.value))}
              className="w-full accent-emerald-500"
            />
          </div>
          <div className="space-y-1">
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>{t("Конец")}</span>
              <span className="font-mono text-emerald-300">{trimEnd == null ? t("{{p1}} (до конца)", { p1: fmt(duration) }) : fmt(end)}</span>
            </div>
            <input
              type="range"
              min={0}
              max={duration}
              step={0.01}
              value={end || duration}
              onChange={(e) => changeEnd(parseFloat(e.target.value))}
              className="w-full accent-emerald-500"
            />
          </div>
          {/* (правка 694, правка 918) Громкость 0–100%, default 50%, персистится
              на рефе — ВЛИЯЕТ ТОЛЬКО НА ПРОСЛУШИВАНИЕ: в генерацию дорожка всегда
              идёт со 100% (иначе приглушённый звук плохо вёл липсинк). */}
          <div className="space-y-1">
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>{t("Громкость (прослушивание)")}</span>
              <span className="font-mono text-emerald-300">{Math.round(volume * 100)}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              onChange={(e) => onVolumeChange?.(parseFloat(e.target.value))}
              className="w-full accent-emerald-500"
            />
          </div>
          <p className="text-[10px] text-muted-foreground/60">
            {t("В референс пойдёт фрагмент")}{' '} {fmt(start)} → {fmt(end || duration)} ({fmt(Math.max(0, (end || duration) - start))}{t("). Обрезка виртуальная — копий файла не создаётся. Громкость со 100%: ползунок нужен только слушать потише, на генерацию не влияет.")}
          </p>
        </div>
      )}
    </div>
  )
}

/* ─────────── (правка 895) редактор кропа картинки-рефа ─────────── */

/** Ручки рамки: 4 угла + 4 стороны. */
const CROP_HANDLES: Array<{ dir: string; left: string; top: string; cursor: string }> = [
  { dir: 'nw', left: '0%', top: '0%', cursor: 'nwse-resize' },
  { dir: 'n', left: '50%', top: '0%', cursor: 'ns-resize' },
  { dir: 'ne', left: '100%', top: '0%', cursor: 'nesw-resize' },
  { dir: 'e', left: '100%', top: '50%', cursor: 'ew-resize' },
  { dir: 'se', left: '100%', top: '100%', cursor: 'nwse-resize' },
  { dir: 's', left: '50%', top: '100%', cursor: 'ns-resize' },
  { dir: 'sw', left: '0%', top: '100%', cursor: 'nesw-resize' },
  { dir: 'w', left: '0%', top: '50%', cursor: 'ew-resize' },
]

const CROP_MIN = 0.04
const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

/** (правка 895) Пересчёт рамки при перетаскивании ручки/самой рамки. */
function dragCropRect(mode: string, r0: CropRect, dx: number, dy: number): CropRect {
  let { x, y, w, h } = r0
  if (mode === 'move') {
    x = Math.min(clamp01(x + dx), 1 - w)
    y = Math.min(clamp01(y + dy), 1 - h)
    return { x, y, w, h }
  }
  if (mode.includes('w')) {
    const nx = Math.max(0, Math.min(x + dx, x + w - CROP_MIN))
    w += x - nx
    x = nx
  }
  if (mode.includes('e')) w = Math.max(CROP_MIN, Math.min(w + dx, 1 - x))
  if (mode.includes('n')) {
    const ny = Math.max(0, Math.min(y + dy, y + h - CROP_MIN))
    h += y - ny
    y = ny
  }
  if (mode.includes('s')) h = Math.max(CROP_MIN, Math.min(h + dy, 1 - y))
  return { x, y, w, h }
}

/**
 * (правка 895) Свободная рамка кропа поверх ОРИГИНАЛА: двигается целиком,
 * масштабируется за 8 ручек (углы + стороны), не выходит за картинку.
 */
function CropOverlay({
  src,
  initial,
  onApply,
  onCancel,
}: {
  src: string
  initial: CropRect
  onApply: (rect: CropRect, blob: Blob) => void
  onCancel: () => void
}) {
  const { t } = useTranslation() // (правка 955)

  const wrapRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const dragRef = useRef<{ mode: string; startX: number; startY: number; rect: CropRect } | null>(null)
  const [rect, setRect] = useState<CropRect>(() => {
    const w = Math.max(CROP_MIN, Math.min(1, initial.w || 1))
    const h = Math.max(CROP_MIN, Math.min(1, initial.h || 1))
    return { x: clamp01(initial.x || 0), y: clamp01(initial.y || 0), w, h }
  })
  const [busy, setBusy] = useState(false)

  const onDown = (e: RPointerEvent, mode: string) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    wrapRef.current?.setPointerCapture?.(e.pointerId)
    dragRef.current = { mode, startX: e.clientX, startY: e.clientY, rect }
  }
  const onMove = (e: RPointerEvent) => {
    const d = dragRef.current
    const wr = wrapRef.current?.getBoundingClientRect()
    if (!d || !wr || !wr.width || !wr.height) return
    setRect(dragCropRect(d.mode, d.rect, (e.clientX - d.startX) / wr.width, (e.clientY - d.startY) / wr.height))
  }
  const onUp = () => {
    dragRef.current = null
  }

  const apply = () => {
    const img = imgRef.current
    if (!img || !img.naturalWidth || !img.naturalHeight) return
    const sx = Math.round(rect.x * img.naturalWidth)
    const sy = Math.round(rect.y * img.naturalHeight)
    const sw = Math.max(1, Math.round(rect.w * img.naturalWidth))
    const sh = Math.max(1, Math.round(rect.h * img.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = sw
    canvas.height = sh
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh)
    setBusy(true)
    canvas.toBlob((b) => {
      setBusy(false)
      if (b) onApply(rect, b)
    }, 'image/png')
  }

  return (
    <div className="flex flex-col items-center gap-3 max-w-full max-h-full">
      <div
        ref={wrapRef}
        className="relative select-none touch-none max-w-full"
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        <img
          ref={imgRef}
          src={src}
          alt=""
          draggable={false}
          className="block max-w-full object-contain"
          style={{ maxHeight: 'calc(100vh - 11rem)' }}
        />
        {/* затемнение вокруг рамки: огромный box-shadow, сам «дыркой» не ставится */}
        <div
          className="absolute cursor-move border border-white/90"
          style={{
            left: `${rect.x * 100}%`,
            top: `${rect.y * 100}%`,
            width: `${rect.w * 100}%`,
            height: `${rect.h * 100}%`,
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)',
          }}
          onPointerDown={(e) => onDown(e, 'move')}
        >
          {/* сетка третей — чтобы кадрировать по композиции */}
          <div className="pointer-events-none absolute inset-0 opacity-40">
            <div className="absolute left-1/3 top-0 bottom-0 w-px bg-white/60" />
            <div className="absolute left-2/3 top-0 bottom-0 w-px bg-white/60" />
            <div className="absolute top-1/3 left-0 right-0 h-px bg-white/60" />
            <div className="absolute top-2/3 left-0 right-0 h-px bg-white/60" />
          </div>
          {CROP_HANDLES.map((h) => (
            <div
              key={h.dir}
              onPointerDown={(e) => onDown(e, h.dir)}
              title={t("Тяните, чтобы изменить рамку")}
              className="absolute w-3 h-3 rounded-sm bg-white border border-black/40"
              style={{ left: h.left, top: h.top, cursor: h.cursor, transform: 'translate(-50%, -50%)' }}
            />
          ))}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={apply}
          disabled={busy}
          className="px-4 py-1.5 rounded-md bg-cyan-500 hover:bg-cyan-400 text-black text-sm font-medium disabled:opacity-50"
        >
          {t("Применить кроп")}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-1.5 rounded-md bg-white/10 hover:bg-white/20 text-white text-sm"
        >
          {t("Отмена")}
        </button>
        <span className="text-xs text-white/60 hidden sm:inline">
          {t("тяните рамку · ручки по краям масштабируют")}
        </span>
      </div>
    </div>
  )
}

export function RefViewerDialog({
  data,
  onOpenChange,
  onTrimChange,
  onVolumeChange,
  onCropChange,
}: {
  data: RefViewerData | null
  onOpenChange: (v: boolean) => void
  /** (правка 1) Audio: колбэк сохранения обрезки (start, end|null). */
  onTrimChange?: (start: number, end: number | null) => void
  /** (правка 694) Audio: колбэк сохранения громкости (0–1). */
  onVolumeChange?: (v: number) => void
  /** (правка 895) Image: колбэк применения кропа — прямоугольник и PNG-blob.
   *  Родитель загружает кроп в input/ и обновляет путь рефа. Если колбэка
   *  нет, кнопка «Обрезать» не показывается (просмотр только). */
  onCropChange?: (rect: CropRect, blob: Blob) => void
}) {
  const { t } = useTranslation() // (правка 955)

  // (правка 909) Просмотр всегда полноразмерный: адрес миниатюры
  // (`/api/comfy/file?...&width=200`) приходит сюда с ControlNet и Refine —
  // снимаем `width`, иначе во весь экран открывалась картинка 200 px.
  const src = data
    ? fullSizeRefUrl(data.url) || `/api/comfy/file?filename=${encodeURIComponent(data.path)}&type=input`
    : ''
  // (правка 909) Рамка кропа тоже работает по оригиналу: fallback
  // `originalSrc` у этих вкладок — та же миниатюра.
  const cropSrc = fullSizeRefUrl(data?.originalSrc) || src

  // (правка 895) Кроп картинки: режим рамки + локальный предпросмотр кропа
  // до того, как родитель обновит путь рефа после загрузки.
  const [cropMode, setCropMode] = useState(false)
  const [croppedSrc, setCroppedSrc] = useState('')
  const [cropRect, setCropRect] = useState<CropRect>(FULL_CROP)
  const lastKeyRef = useRef<string>('')

  // Сброс при смене рефа/пути (после применения родитель меняет path —
  // предпросмотр подхватывает уже обрезанный файл).
  useEffect(() => {
    const key = data ? `${data.path}|${data.url ?? ''}` : ''
    if (key === lastKeyRef.current) return
    lastKeyRef.current = key
    setCropMode(false)
    setCroppedSrc('')
    setCropRect(data?.crop ?? FULL_CROP)
  }, [data])

  // (правка 717) Автоскрытие верхней панели — как в видео-плеере.
  const [showControls, setShowControls] = useState(true)
  const controlsTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const close = () => onOpenChange(false)

  const handleMouseMove = () => {
    setShowControls(true)
    clearTimeout(controlsTimer.current)
    // (правка 895) В режиме кропа панель не прячем — там кнопки управления.
    if (cropMode) return
    controlsTimer.current = setTimeout(() => setShowControls(false), 3000)
  }

  // (правка 717) Esc закрывает. Раньше это делал Radix-диалог; после
  // перехода на «сырой» оверлей обработчик нужен свой.
  // Без stopPropagation: вызывающий диалог (мета-диалог) сам себя
  // защищает проверкой «viewingRef не открыт», как и в VideoLightbox.
  useEffect(() => {
    if (!data) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // (правка 895) В режиме кропа Esc отменяет рамку, а не закрывает.
        if (cropMode) setCropMode(false)
        else close()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [data, onOpenChange, cropMode])

  // Таймер автоскрытия гасим при unmount (иначе колбэк стрелял бы по
  // размонтированному компоненту).
  useEffect(() => () => clearTimeout(controlsTimer.current), [])

  // (правка 895) В режиме кропа верхняя панель должна быть видна всегда —
  // сбрасываем уже запущенный таймер автоскрытия.
  useEffect(() => {
    if (!cropMode) return
    clearTimeout(controlsTimer.current)
    setShowControls(true)
  }, [cropMode])

  // Пока открыт просмотрщик — фон не скроллится (иначе страница под
  // оверлеем ездила при прокрутке колесом над картинкой).
  useEffect(() => {
    if (!data) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [data])

  const content = (
    <AnimatePresence>
      {data && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[9999] bg-black flex flex-col"
          onMouseMove={handleMouseMove}
          onClick={(e) => {
            // Закрываем только по клику по ЧЁРНОМУ фону — клик по самой
            // картинке/плееру/редактору не должен ничего закрывать.
            if (!cropMode && e.target === e.currentTarget) close()
          }}
        >
          {/* Контент — во весь экран, без полей и рамок */}
          <div
            className="flex-1 relative flex items-center justify-center min-h-0 min-w-0 overflow-auto"
            /* (правка 717) Клик по чёрному фону закрывает. Проверка нужна и
               здесь: содержимое перекрывает всю площадь motion.div, поэтому
               клик целиком в эту область (а не в motion.div) — и без второй
               проверки просмотрщик не закрывался бы. */
            onClick={(e) => {
              if (!cropMode && e.target === e.currentTarget) close()
            }}
          >
            {data.kind === 'image' && (
              cropMode && onCropChange ? (
                <CropOverlay
                  src={cropSrc}
                  initial={cropRect}
                  onApply={(rect, blob) => {
                    setCropRect(rect)
                    // Локальный предпросмотр сразу; после загрузки родитель
                    // заменит путь, и покажется уже обрезанный файл.
                    setCroppedSrc(URL.createObjectURL(blob))
                    setCropMode(false)
                    onCropChange(rect, blob)
                  }}
                  onCancel={() => setCropMode(false)}
                />
              ) : (
                <img
                  src={croppedSrc || src}
                  alt={data.name}
                  className="max-w-full max-h-full object-contain"
                  draggable={false}
                />
              )
            )}
            {data.kind === 'video' && (
              <video
                src={src}
                controls
                autoPlay
                loop
                playsInline
                className="max-w-full max-h-full"
              />
            )}
            {data.kind === 'audio' && (
              /* min-h-full + items-center в отдельном слое: при items-center
                 на самом контейнере верх панели обрезался бы и не
                 прокручивался (классическая проблема flex-центрирования). */
              <div className="w-full h-full overflow-auto">
                <div className="w-full min-h-full flex items-center justify-center p-6">
                  <AudioTrimEditor
                    src={src}
                    trimStart={data.trimStart}
                    trimEnd={data.trimEnd}
                    onTrimChange={onTrimChange}
                    volume={data.audioVolume}
                    onVolumeChange={onVolumeChange}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Верхняя панель — как в видео-плеере: градиент, имя слева,
              крестик справа; прячется при бездействии мыши. */}
          <div
            className={`absolute top-0 left-0 right-0 flex items-center justify-between gap-3 px-4 py-3 transition-opacity duration-300 ${
              showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'
            }`}
            style={{ background: 'linear-gradient(to bottom, rgba(0,0,0,0.7) 0%, transparent 100%)' }}
          >
            <div className="flex items-center gap-2 min-w-0">
              {data.kind === 'image' && <ImageIcon className="w-4 h-4 text-purple-400 shrink-0" />}
              {data.kind === 'video' && <FilmIcon className="w-4 h-4 text-cyan-400 shrink-0" />}
              {data.kind === 'audio' && <AudioLinesIcon className="w-4 h-4 text-emerald-400 shrink-0" />}
              <h3 className="text-sm text-white/90 font-medium truncate">{data.name}</h3>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {/* (правка 895) Кнопка кропа — только для картинок, если родитель
                  умеет сохранять кроп, и пока не в режиме рамки. */}
              {data.kind === 'image' && onCropChange && !cropMode && (
                <button
                  type="button"
                  onClick={() => setCropMode(true)}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white/10 hover:bg-white/20 text-white text-xs transition-colors"
                  title={t("Обрезать изображение")}
                >
                  <CropIcon className="w-4 h-4" />
                  <span>{t("Обрезать")}</span>
                </button>
              )}
              <button
                type="button"
                onClick={close}
                className="p-2 rounded-lg bg-white/10 hover:bg-white/20 text-white transition-colors shrink-0"
                title={t("Закрыть (Esc)")}
              >
                <XIcon className="w-4 h-4" />
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )

  // (правка 692) Портал в document.body — Radix fixed-позиционирование
  // ломается внутри framer-motion transformed ancestor; portal решает это.
  return createPortal(content, document.body)
}
