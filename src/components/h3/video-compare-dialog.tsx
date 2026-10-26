'use client'

/**
 * (правка 728) VideoCompareDialog — полноэкранное сравнение двух видео
 * «до / после» со слайдером-шторкой.
 *
 * Открывается из галереи: Ctrl+клик по двум карточкам → «Сравнить».
 * Два <video> наложены друг на друга; левое (A, «до») обрезается по позиции
 * шторки, правое (B, «после») видно целиком. Шторку тащат мышью/пальцем.
 *
 * Два режима:
 *  • «Видео» — оба ролика играют синхронно; цикл ограничен длительностью
 *    короткого, поэтому длинный не обгоняет и оба кадра совпадают;
 *  • «Кадр»  — только пауза, таймлайн и покадровое листание (←/→), без
 *    воспроизведения.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowLeftRightIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  PauseIcon,
  PlayIcon,
  Volume2Icon,
  VolumeXIcon,
  XIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'

/** Минимум, который нужен диалогу от файла галереи. */
export interface CompareVideo {
  url: string
  filename: string
  subfolder: string
}

interface VideoCompareDialogProps {
  a: CompareVideo | null
  b: CompareVideo | null
  onClose: () => void
}

const FPS = 24
/** Допустимый дрейф B относительно A — не больше одного кадра. */
const SYNC_TOLERANCE = 1 / FPS

/** m:ss.d — компактно и без «00:00.000». */
function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00.0'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  const d = Math.floor((sec % 1) * 10)
  return `${m}:${String(s).padStart(2, '0')}.${d}`
}

/** Короткое имя для подписи на кадре: без общего префикса. */
function shortName(name: string): string {
  return name.replace(/^Minimax_Studio_/i, '').replace(/\.(mp4|mov|mkv|webm|avi)$/i, '')
}

export function VideoCompareDialog({ a, b, onClose }: VideoCompareDialogProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const aRef = useRef<HTMLVideoElement>(null)
  const bRef = useRef<HTMLVideoElement>(null)
  const draggingRef = useRef(false)

  const [split, setSplit] = useState(0.5)
  const [mode, setMode] = useState<'video' | 'frame'>('video')
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  // Ограничиваем сравнение коротким роликом: длинный показываем только
  // до этой границы, чтобы оба кадра совпадали по времени/кадру.
  const [aDuration, setADuration] = useState(0)
  const [bDuration, setBDuration] = useState(0)
  const knownDurations = [aDuration, bDuration].filter((d) => Number.isFinite(d) && d > 0)
  const duration = knownDurations.length > 0 ? Math.min(...knownDurations) : 0
  const [muted, setMuted] = useState(true)

  /* ── Открыли новый набор — сбрасываем состояние ── */
  useEffect(() => {
    setSplit(0.5)
    setMode('video')
    setMuted(true)
    setTime(0)
    setADuration(0)
    setBDuration(0)
  }, [a?.url, b?.url])

  /* ── Блокируем прокрутку страницы, пока открыто ── */
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  const seek = useCallback((t: number) => {
    const va = aRef.current
    const vb = bRef.current
    const total = duration > 0
      ? duration
      : (va?.duration && Number.isFinite(va.duration) ? va.duration : 0)
    const target = Math.max(0, Math.min(total || 0, t))
    if (va) {
      try { va.currentTime = target } catch { /* meta ещё нет */ }
    }
    if (vb) {
      const bd = Number.isFinite(vb.duration) && vb.duration > 0 ? vb.duration : target
      try { vb.currentTime = Math.min(target, bd) } catch { /* meta ещё нет */ }
    }
    setTime(target)
  }, [duration])

  const playBoth = useCallback(() => {
    const va = aRef.current
    if (!va) return
    va.play().catch(() => { /* автоплей заблокирован — останется пауза */ })
    bRef.current?.play().catch(() => { /* второй ролик может быть ещё не готов */ })
  }, [])

  const pauseBoth = useCallback(() => {
    aRef.current?.pause()
    bRef.current?.pause()
  }, [])

  const togglePlay = useCallback(() => {
    // В режиме «Кадр» воспроизведения быть не должно — только ←/→ и таймлайн.
    if (mode === 'frame') return
    const va = aRef.current
    if (!va) return
    if (va.paused) {
      playBoth()
    } else {
      pauseBoth()
    }
  }, [mode, playBoth, pauseBoth])

  const applyMode = useCallback((next: 'video' | 'frame') => {
    setMode(next)
    if (next === 'frame') pauseBoth()
    else playBoth()
  }, [pauseBoth, playBoth])

  const stepFrame = useCallback((dir: number) => {
    const va = aRef.current
    if (!va) return
    setMode('frame')
    pauseBoth()
    seek(va.currentTime + dir / FPS)
  }, [pauseBoth, seek])

  /* ── Автозапуск: muted-видео стартует само; подстраховка на случай,
        если браузер не отработал autoPlay до готовности метаданных ── */
  useEffect(() => {
    if (mode !== 'video') return
    const id = setTimeout(() => playBoth(), 150)
    return () => clearTimeout(id)
  }, [a?.url, b?.url, mode, playBoth])

  /* ── В покадровом режиме не оставляем текущую позицию за границей
        короткого ролика (например, если B загрузился позже A). ── */
  useEffect(() => {
    if (mode !== 'frame' || duration <= 0) return
    const va = aRef.current
    if (va && va.currentTime > duration) seek(duration)
  }, [mode, duration, seek])

  /* ── Синхронизация B за A (A — ведущий). rAF вместо редкого интервала:
        держим расхождение в пределах одного кадра; вставший после
        конца/паузы B снова запускаем. ── */
  useEffect(() => {
    if (mode !== 'video') return
    let raf = 0
    const tick = () => {
      const va = aRef.current
      const vb = bRef.current
      if (va && vb) {
        const fallback = Number.isFinite(va.duration) && va.duration > 0 ? va.duration : 0
        const limit = duration > 0 ? duration : fallback

        // Оба ролика идут только до длительности короткого. Это и есть
        // «длинное подгоняется под короткое»: лишний хвост не играет, оба
        // кадра на одной временной позиции.
        if (limit > 0 && (va.ended || (!va.paused && va.currentTime >= limit - 1 / (FPS * 2)))) {
          try {
            va.currentTime = 0
            vb.currentTime = 0
          } catch { /* meta ещё нет */ }
          setTime(0)
          if (va.paused) void va.play().catch(() => { /* автоплей */ })
          if (vb.paused) void vb.play().catch(() => { /* автоплей */ })
        } else if (va.paused) {
          if (!vb.paused) vb.pause()
        } else if (vb.readyState >= 2) {
          if (vb.ended) {
            try { vb.currentTime = 0 } catch { /* пропускаем такт */ }
          }
          if (vb.paused && !vb.ended) {
            void vb.play().catch(() => { /* автоплей заблокирован */ })
          }
          const bd = Number.isFinite(vb.duration) && vb.duration > 0 ? vb.duration : Infinity
          const target = Math.min(va.currentTime, limit > 0 ? limit : bd)
          if (Math.abs(vb.currentTime - target) > SYNC_TOLERANCE) {
            try { vb.currentTime = target } catch { /* пропускаем такт */ }
          }
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [mode, duration])

  /* ── Клавиатура: Esc, пробел, покадрово ── */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      } else if (e.key === ' ') {
        e.preventDefault()
        togglePlay()
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        stepFrame(-1)
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        stepFrame(1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, togglePlay, stepFrame])

  /* ── Перетаскивание шторки ── */
  const setFromClientX = useCallback((clientX: number) => {
    const el = wrapRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    if (r.width <= 0) return
    setSplit(Math.max(0, Math.min(1, (clientX - r.left) / r.width)))
  }, [])

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = true
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* не критично */ }
    setFromClientX(e.clientX)
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (draggingRef.current) setFromClientX(e.clientX)
  }
  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* уже отпущен */ }
  }

  if (!a || !b) return null

  const percent = Math.round(split * 1000) / 10

  return createPortal(
    <div className="fixed inset-0 z-[400] flex flex-col bg-black/95 backdrop-blur-sm">
      {/* ── Шапка ── */}
      <div className="shrink-0 flex items-center gap-3 px-4 py-2.5 border-b border-white/10">
        <ArrowLeftRightIcon className="w-4 h-4 text-cyan-400 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-white leading-tight">Сравнение до / после</p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 text-[11px] text-white/60">
            <span className="inline-flex items-center gap-1.5 min-w-0">
              <span className="shrink-0 rounded bg-cyan-500/20 border border-cyan-400/40 px-1 text-[10px] font-bold text-cyan-300">A</span>
              <span className="truncate max-w-[42vw]">{a.filename}</span>
            </span>
            <span className="inline-flex items-center gap-1.5 min-w-0">
              <span className="shrink-0 rounded bg-fuchsia-500/20 border border-fuchsia-400/40 px-1 text-[10px] font-bold text-fuchsia-300">B</span>
              <span className="truncate max-w-[42vw]">{b.filename}</span>
            </span>
          </div>
        </div>
        <div className="hidden sm:block text-[10px] text-white/40 tabular-nums shrink-0">
          {percent.toFixed(1)} %
        </div>
        <button
          type="button"
          onClick={onClose}
          className="p-2 rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition-colors"
          title="Закрыть (Esc)"
        >
          <XIcon className="w-5 h-5" />
        </button>
      </div>

      {/* ── Кадр со шторкой ── */}
      <div
        ref={wrapRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className="relative flex-1 min-h-0 m-2 sm:m-3 rounded-xl overflow-hidden bg-black select-none touch-none cursor-ew-resize"
        title="Потяните шторку, чтобы сравнить"
      >
        {/* B — «после», целиком под шторкой. Цикл общий: ограничен
              длительностью короткого ролика, поэтому длинный не обгоняет. */}
        <video
          ref={bRef}
          src={b.url}
          muted
          playsInline
          preload="auto"
          onPlay={() => { aRef.current?.play().catch(() => {}) }}
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration
            if (Number.isFinite(d) && d > 0) setBDuration(d)
          }}
          className="absolute inset-0 w-full h-full object-contain pointer-events-none"
        />
        {/* A — «до», видна только слева от шторки */}
        <div
          className="absolute inset-0"
          style={{ clipPath: `inset(0 ${(1 - split) * 100}% 0 0)` }}
        >
          <video
            ref={aRef}
            src={a.url}
            muted={muted}
            playsInline
            preload="auto"
            onLoadedMetadata={(e) => {
              const d = e.currentTarget.duration
              if (Number.isFinite(d) && d > 0) setADuration(d)
            }}
            onPlay={() => {
              setPlaying(true)
              bRef.current?.play().catch(() => {})
            }}
            onPause={() => {
              setPlaying(false)
              bRef.current?.pause()
            }}
            onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
            className="absolute inset-0 w-full h-full object-contain pointer-events-none"
          />
        </div>

        {/* Подписи A/B прямо на кадре */}
        <span className="absolute top-3 left-3 inline-flex items-center gap-1.5 rounded-md bg-black/60 backdrop-blur-sm px-2 py-1 text-[11px] font-semibold text-cyan-300 border border-cyan-400/40 pointer-events-none">
          <span className="text-[10px]">A</span>
          <span className="max-w-[30vw] truncate text-white/80">{shortName(a.filename)}</span>
        </span>
        <span className="absolute top-3 right-3 inline-flex items-center gap-1.5 rounded-md bg-black/60 backdrop-blur-sm px-2 py-1 text-[11px] font-semibold text-fuchsia-300 border border-fuchsia-400/40 pointer-events-none">
          <span className="text-[10px]">B</span>
          <span className="max-w-[30vw] truncate text-white/80">{shortName(b.filename)}</span>
        </span>

        {/* Линия + ручка шторки */}
        <div
          className="absolute inset-y-0 w-px bg-white/90 shadow-[0_0_10px_rgba(0,0,0,0.8)] pointer-events-none"
          style={{ left: `${split * 100}%` }}
        />
        <div
          className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-white text-black flex items-center justify-center shadow-2xl pointer-events-none"
          style={{ left: `${split * 100}%` }}
        >
          <ArrowLeftRightIcon className="w-5 h-5" />
        </div>
      </div>

      {/* ── Управление ── */}
      <div className="shrink-0 px-3 sm:px-4 pb-3 pt-1 space-y-1.5">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={togglePlay}
            disabled={mode === 'frame'}
            className="shrink-0 w-10 h-10 rounded-full bg-white text-black flex items-center justify-center hover:bg-white/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title={
              mode === 'frame'
                ? 'В режиме «Кадр» воспроизведение отключено'
                : playing ? 'Пауза (пробел)' : 'Играть (пробел)'
            }
          >
            {playing ? <PauseIcon className="w-5 h-5" /> : <PlayIcon className="w-5 h-5 translate-x-[1px]" />}
          </button>

          {/* Режим: статичный кадр / проигрывание */}
          <div className="shrink-0 flex rounded-lg bg-white/10 p-0.5">
            <button
              type="button"
              onClick={() => applyMode('frame')}
              className={cn(
                'px-2.5 py-1.5 rounded-md text-[11px] font-medium transition-colors',
                mode === 'frame' ? 'bg-white text-black' : 'text-white/70 hover:text-white',
              )}
              title="Стоп-кадр: пауза и покадровое листание"
            >
              Кадр
            </button>
            <button
              type="button"
              onClick={() => applyMode('video')}
              className={cn(
                'px-2.5 py-1.5 rounded-md text-[11px] font-medium transition-colors',
                mode === 'video' ? 'bg-white text-black' : 'text-white/70 hover:text-white',
              )}
              title="Проигрывать оба видео синхронно"
            >
              Видео
            </button>
          </div>

          {/* Покадрово — только в режиме «Кадр» */}
          {mode === 'frame' && (
            <div className="shrink-0 flex items-center gap-1">
              <button
                type="button"
                onClick={() => stepFrame(-1)}
                className="p-1.5 rounded-md text-white/70 hover:text-white hover:bg-white/10 transition-colors"
                title="Предыдущий кадр (←)"
              >
                <ChevronLeftIcon className="w-4 h-4" />
              </button>
              <span className="text-[10px] text-white/50 tabular-nums w-[4.5rem] text-center">
                кадр {Math.max(0, Math.round(time * FPS))}
              </span>
              <button
                type="button"
                onClick={() => stepFrame(1)}
                className="p-1.5 rounded-md text-white/70 hover:text-white hover:bg-white/10 transition-colors"
                title="Следующий кадр (→)"
              >
                <ChevronRightIcon className="w-4 h-4" />
              </button>
            </div>
          )}

          <input
            type="range"
            min={0}
            max={Math.max(duration, 0.01)}
            step={1 / FPS}
            value={Math.min(time, duration || 0)}
            onChange={(e) => seek(Number(e.target.value))}
            className="flex-1 min-w-0 h-1 accent-cyan-400 cursor-pointer"
            title="Позиция в видео"
          />

          <span className="shrink-0 text-[11px] text-white/70 tabular-nums w-[92px] text-right">
            {fmtTime(time)} / {fmtTime(duration)}
          </span>

          <button
            type="button"
            onClick={() => setMuted((m) => !m)}
            className="shrink-0 p-1.5 rounded-md text-white/70 hover:text-white hover:bg-white/10 transition-colors"
            title={muted ? 'Включить звук (A)' : 'Выключить звук'}
          >
            {muted ? <VolumeXIcon className="w-4 h-4" /> : <Volume2Icon className="w-4 h-4" />}
          </button>
        </div>

        <p className="text-[10px] text-white/40 leading-tight">
          Тяните шторку мышью · «Кадр» — только ←/→ и таймлайн · Пробел — пауза/играть в режиме «Видео» · Esc — закрыть
        </p>
      </div>
    </div>,
    document.body,
  )
}
