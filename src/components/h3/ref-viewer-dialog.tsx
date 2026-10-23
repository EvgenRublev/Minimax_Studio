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
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom' // (правка 692) портал в body — без рамки, на весь экран
import { motion, AnimatePresence } from 'framer-motion'
import { FilmIcon, ImageIcon, AudioLinesIcon, PlayIcon, PauseIcon, XIcon } from 'lucide-react'

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
          title={playing ? 'Пауза' : 'Играть выделение'}
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
            Сбросить обрезку
          </button>
        )}
      </div>

      {/* (правка 694) Карточка без рамки: убраны border + bg, оставлен только отступ.
          (правка 702) space-y-3 → space-y-2 — компактнее блок обрезки/громкости. */}
      {duration > 0 && (
        <div className="w-full space-y-2 px-4">
          <div className="space-y-1">
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>Начало</span>
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
              <span>Конец</span>
              <span className="font-mono text-emerald-300">{trimEnd == null ? `${fmt(duration)} (до конца)` : fmt(end)}</span>
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
          {/* (правка 694) Громкость рефа: 0–100%, default 50%, персистится. */}
          <div className="space-y-1">
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>Громкость</span>
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
            В референс пойдёт фрагмент {fmt(start)} → {fmt(end || duration)} ({fmt(Math.max(0, (end || duration) - start))}).
            Обрезка виртуальная — копий файла не создаётся.
          </p>
        </div>
      )}
    </div>
  )
}

export function RefViewerDialog({
  data,
  onOpenChange,
  onTrimChange,
  onVolumeChange,
}: {
  data: RefViewerData | null
  onOpenChange: (v: boolean) => void
  /** (правка 1) Audio: колбэк сохранения обрезки (start, end|null). */
  onTrimChange?: (start: number, end: number | null) => void
  /** (правка 694) Audio: колбэк сохранения громкости (0–1). */
  onVolumeChange?: (v: number) => void
}) {
  const src = data
    ? data.url || `/api/comfy/file?filename=${encodeURIComponent(data.path)}&type=input`
    : ''

  // (правка 717) Автоскрытие верхней панели — как в видео-плеере.
  const [showControls, setShowControls] = useState(true)
  const controlsTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const close = () => onOpenChange(false)

  const handleMouseMove = () => {
    setShowControls(true)
    clearTimeout(controlsTimer.current)
    controlsTimer.current = setTimeout(() => setShowControls(false), 3000)
  }

  // (правка 717) Esc закрывает. Раньше это делал Radix-диалог; после
  // перехода на «сырой» оверлей обработчик нужен свой.
  // Без stopPropagation: вызывающий диалог (мета-диалог) сам себя
  // защищает проверкой «viewingRef не открыт», как и в VideoLightbox.
  useEffect(() => {
    if (!data) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [data, onOpenChange])

  // Таймер автоскрытия гасим при unmount (иначе колбэк стрелял бы по
  // размонтированному компоненту).
  useEffect(() => () => clearTimeout(controlsTimer.current), [])

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
            if (e.target === e.currentTarget) close()
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
              if (e.target === e.currentTarget) close()
            }}
          >
            {data.kind === 'image' && (
              <img
                src={src}
                alt={data.name}
                className="max-w-full max-h-full object-contain"
                draggable={false}
              />
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
            <button
              type="button"
              onClick={close}
              className="p-2 rounded-lg bg-white/10 hover:bg-white/20 text-white transition-colors shrink-0"
              title="Закрыть (Esc)"
            >
              <XIcon className="w-4 h-4" />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )

  // (правка 692) Портал в document.body — Radix fixed-позиционирование
  // ломается внутри framer-motion transformed ancestor; portal решает это.
  return createPortal(content, document.body)
}
