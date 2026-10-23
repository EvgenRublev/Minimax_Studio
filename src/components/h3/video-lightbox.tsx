'use client'

/**
 * VideoLightbox — modern cinematic video player modal.
 * Used by gallery-tab and video-gallery-grid for fullscreen preview.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
  XIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  DownloadIcon,
  Trash2Icon,
  PlayIcon,
  PauseIcon,
  Volume2Icon,
  VolumeXIcon,
} from 'lucide-react'

interface VideoFile {
  url: string
  filename: string
  subfolder: string
}

interface VideoLightboxProps {
  files: VideoFile[]
  initialIndex: number
  onClose: () => void
  onDelete?: (filename: string, subfolder: string) => void | Promise<void>
}

/** (правка 256) Громкость/мьют лайтбокса — в localStorage: жалоба с YouTube
 *  «каждый раз приходится убавлять заново, не запоминается». */
const VOLUME_KEY = 'minimax.lightbox.volume'

function readStoredVolume(): number {
  if (typeof window === 'undefined') return 0.7
  const raw = window.localStorage.getItem(VOLUME_KEY)
  const n = parseFloat(raw ?? '')
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.7
}

export function VideoLightbox({ files, initialIndex, onClose, onDelete }: VideoLightboxProps) {
  const [index, setIndex] = useState(initialIndex)
  const [showControls, setShowControls] = useState(true)
  const [isPlaying, setIsPlaying] = useState(false)
  const [isMuted, setIsMuted] = useState(false)
  const [volume, setVolume] = useState(readStoredVolume)
  const [progress, setProgress] = useState(0)
  const [duration, setDuration] = useState(0)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  /** Bumped by "Повторить" — remounts the <video> with a fresh request. */
  const [retryCount, setRetryCount] = useState(0)
  /** Set when the video element fails to load (broken cache entry etc.). */
  const [loadError, setLoadError] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const controlsTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const goTo = useCallback(
    (i: number) => {
      if (files.length === 0) return
      setIndex(((i % files.length) + files.length) % files.length)
      setShowDeleteConfirm(false)
    },
    [files.length],
  )

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'Escape': onClose(); break
        case 'ArrowLeft': goTo(index - 1); break
        case 'ArrowRight': goTo(index + 1); break
        case ' ':
          e.preventDefault()
          togglePlay()
          break
        case 'm':
        case 'M':
          toggleMute()
          break
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [index, onClose, goTo])

  // Apply volume imperatively — covers slider changes and initial mount alike
  useEffect(() => {
    const v = videoRef.current
    if (v) v.volume = Math.min(1, Math.max(0, volume))
  }, [volume, index])

  // Reset the load error when switching files or retrying
  useEffect(() => {
    setLoadError(false)
  }, [index, retryCount])

  // (правка 352) Таймер авто-скрытия контролов — гасим при unmount,
  // иначе колбэк стрелял по размонтированному компоненту.
  useEffect(() => () => clearTimeout(controlsTimer.current), [])

  // Страховка: если текущий файл исчез из списка (удалён извне), закрываем
  // модалку явно — рендер null оставил бы её «зависшей» без возможности Esc.
  const hasFile = index >= 0 && index < files.length
  useEffect(() => {
    if (!hasFile) onClose()
  }, [hasFile, onClose])

  const file = hasFile ? files[index] : null
  if (!file) return null

  const togglePlay = () => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) {
      v.play().catch(() => {})
      setIsPlaying(true)
    } else {
      v.pause()
      setIsPlaying(false)
    }
  }

  const toggleMute = () => {
    const v = videoRef.current
    if (!v) return
    v.muted = !v.muted
    setIsMuted(v.muted)
  }

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const vol = parseFloat(e.target.value)
    setVolume(vol)
    try { window.localStorage.setItem(VOLUME_KEY, String(vol)) } catch { /* private mode */ }
    const v = videoRef.current
    if (v) {
      v.volume = vol
      if (vol > 0 && v.muted) {
        v.muted = false
        setIsMuted(false)
      }
      if (vol === 0) {
        v.muted = true
        setIsMuted(true)
      }
    }
  }

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    const v = videoRef.current
    if (!v || !duration) return
    const rect = e.currentTarget.getBoundingClientRect()
    const pct = (e.clientX - rect.left) / rect.width
    v.currentTime = Math.max(0, Math.min(duration, pct * duration))
  }



  const handleTimeUpdate = () => {
    const v = videoRef.current
    if (!v || !duration) return
    setProgress((v.currentTime / duration) * 100)
  }

  const handleMouseMove = () => {
    setShowControls(true)
    clearTimeout(controlsTimer.current)
    controlsTimer.current = setTimeout(() => {
      if (isPlaying) setShowControls(false)
    }, 3000)
  }

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60)
    return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`
  }

  const handleDelete = async () => {
    if (!file || !onDelete) return
    await onDelete(file.filename, file.subfolder)
    if (files.length <= 1) onClose()
    else goTo(index < files.length - 1 ? index : index - 1)
  }

  const content = (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[9999] bg-black flex flex-col"
      onMouseMove={handleMouseMove}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      {/* Video area */}
      <div
        className="flex-1 relative flex items-center justify-center cursor-none group min-h-0 min-w-0"
        style={{ cursor: showControls ? 'default' : 'none' }}
        onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
      >
        {/* Video — volume is applied imperatively (React types dropped the
            `volume` attribute for <video>, so a prop here is a silent no-op) */}
        <video
          key={`${file.subfolder}/${file.filename}#${retryCount}`}
          ref={videoRef}
          src={file.url}
          autoPlay
          muted={isMuted}
          loop
          playsInline
          preload="metadata"
          className="max-w-full max-h-full object-contain"
          onClick={togglePlay}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onDurationChange={(e) => {
            const d = e.currentTarget.duration
            setDuration(Number.isFinite(d) ? d : 0)
          }}
          onTimeUpdate={handleTimeUpdate}
          onError={() => setLoadError(true)}
        />

        {/* Load error overlay with retry */}
        {loadError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/60 pointer-events-auto">
            <p className="text-sm text-white/80">Не удалось загрузить видео</p>
            <button
              onClick={() => setRetryCount((n) => n + 1)}
              className="px-4 py-1.5 rounded-lg bg-white/15 hover:bg-white/25 text-white text-xs font-medium transition-colors"
            >
              Повторить
            </button>
          </div>
        )}

        {/* Play/Pause center indicator */}
        <AnimatePresence>
          {!isPlaying && showControls && (
            <motion.div
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 0.3, scale: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 flex items-center justify-center pointer-events-none"
            >
              <PlayIcon className="w-20 h-20 text-white fill-white/50" />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Top bar */}
        <div
          className={`absolute top-0 left-0 right-0 flex items-center justify-between px-4 py-3 transition-opacity duration-300 ${
            showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
          style={{ background: 'linear-gradient(to bottom, rgba(0,0,0,0.7) 0%, transparent 100%)' }}
        >
          <div className="flex items-center gap-3">
            <h3 className="text-sm text-white/90 font-medium truncate max-w-[60%]">{file.filename}</h3>
            <span className="text-xs text-white/40 font-mono">
              {index + 1}/{files.length}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            {/* Download */}
            <a
              href={file.url}
              download={file.filename}
              className="p-2 rounded-lg bg-white/10 hover:bg-white/20 text-white transition-colors"
              title="Скачать"
            >
              <DownloadIcon className="w-4 h-4" />
            </a>
            {/* Delete */}
            {onDelete && (
              showDeleteConfirm ? (
                <div className="flex items-center gap-1 ml-1">
                  <button
                    onClick={() => void handleDelete()}
                    className="px-3 py-1.5 rounded-lg bg-red-500/80 hover:bg-red-500 text-white text-xs font-medium transition-colors"
                  >
                    Удалить
                  </button>
                  <button
                    onClick={() => setShowDeleteConfirm(false)}
                    className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white text-xs transition-colors"
                  >
                    Отмена
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setShowDeleteConfirm(true)}
                  className="p-2 rounded-lg bg-white/10 hover:bg-red-500/40 text-white transition-colors"
                  title="Удалить"
                >
                  <Trash2Icon className="w-4 h-4" />
                </button>
              )
            )}
            {/* Close */}
            <button
              onClick={onClose}
              className="p-2 rounded-lg bg-white/10 hover:bg-white/20 text-white transition-colors ml-1"
              title="Закрыть (Esc)"
            >
              <XIcon className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Bottom controls */}
        <div
          className={`absolute bottom-0 left-0 right-0 transition-opacity duration-300 ${
            showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
          style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.7) 0%, transparent 100%)' }}
        >
          {/* Progress bar */}
          <div
            className="mx-4 mb-2 h-1 bg-white/20 rounded-full cursor-pointer group/bar hover:h-1.5 transition-all"
            onClick={handleSeek}
          >
            <div
              className="h-full bg-gradient-to-r from-cyan-500 to-blue-500 rounded-full relative"
              style={{ width: `${progress}%` }}
            >
              <div className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full opacity-0 group-hover/bar:opacity-100 transition-opacity shadow-lg" />
            </div>
          </div>

          {/* Controls row */}
          <div className="flex items-center justify-between px-4 pb-3">
            <div className="flex items-center gap-2">
              {/* Play/Pause */}
              <button onClick={togglePlay} className="p-1.5 text-white/90 hover:text-white transition-colors" title="Play/Pause (Space)">
                {isPlaying ? <PauseIcon className="w-5 h-5 fill-current" /> : <PlayIcon className="w-5 h-5 fill-current" />}
              </button>

              {/* Mute */}
              <button onClick={toggleMute} className="p-1.5 text-white/70 hover:text-white transition-colors" title="Mute (M)">
                {isMuted ? <VolumeXIcon className="w-4 h-4" /> : <Volume2Icon className="w-4 h-4" />}
              </button>

              {/* Volume slider */}
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={isMuted ? 0 : volume}
                onChange={handleVolumeChange}
                className="w-20 h-1 accent-cyan-500 cursor-pointer"
                title={`Громкость: ${Math.round((isMuted ? 0 : volume) * 100)}%`}
              />

              {/* Time */}
              <span className="text-xs text-white/60 font-mono ml-1">
                {formatTime((progress / 100) * duration)} / {formatTime(duration)}
              </span>
            </div>

            {/* Nav + fullscreen */}
            <div className="flex items-center gap-1.5">
              {files.length > 1 && (
                <>
                  <button onClick={() => goTo(index - 1)} className="p-1.5 text-white/70 hover:text-white transition-colors" title="Предыдущее">
                    <ChevronLeftIcon className="w-4 h-4" />
                  </button>
                  <button onClick={() => goTo(index + 1)} className="p-1.5 text-white/70 hover:text-white transition-colors" title="Следующее">
                    <ChevronRightIcon className="w-4 h-4" />
                  </button>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Side nav arrows */}
        {files.length > 1 && showControls && (
          <>
            <motion.button
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              onClick={() => goTo(index - 1)}
              className="absolute left-4 top-1/2 -translate-y-1/2 p-3 rounded-xl bg-black/40 hover:bg-black/60 text-white/80 backdrop-blur-sm transition-colors"
            >
              <ChevronLeftIcon className="w-5 h-5" />
            </motion.button>
            <motion.button
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              onClick={() => goTo(index + 1)}
              className="absolute right-4 top-1/2 -translate-y-1/2 p-3 rounded-xl bg-black/40 hover:bg-black/60 text-white/80 backdrop-blur-sm transition-colors"
            >
              <ChevronRightIcon className="w-5 h-5" />
            </motion.button>
          </>
        )}
      </div>

      {/* Keyboard hints */}
      {showControls && (
        <div className="absolute bottom-[80px] left-1/2 -translate-x-1/2 flex items-center gap-4 text-[10px] text-white/30 pointer-events-none">
          <span>Space — Play/Pause</span>
          <span>M — Mute</span>
          <span>←→ — Навигация</span>
          <span>Esc — Закрыть</span>
        </div>
      )}
    </motion.div>
  )

  return createPortal(content, document.body)
}
