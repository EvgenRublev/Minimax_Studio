'use client'

/**
 * VideoTrimDialog — мини-видеоредактор для обрезки видео.
 *
 * Показывает видео, таймлайн с двумя маркерами (начало / конец),
 * кнопку проигрывания и «Обрезать и сохранить».
 * После обрезки — новый файл в галерее с бейджем «Edited».
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ScissorsIcon, PlayIcon, PauseIcon, CheckIcon, Loader2Icon } from 'lucide-react'
import { useGalleryRefresh } from '@/lib/gallery-refresh-store' // (правка 474)
import type { VideoGalleryFile } from './video-gallery-grid'

interface VideoTrimDialogProps {
  file: VideoGalleryFile | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone?: () => void // refresh gallery
}

function fmt(sec: number): string {
  if (!isFinite(sec) || sec < 0) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  const ms = Math.round((sec % 1) * 10)
  return `${m}:${String(s).padStart(2, '0')}.${ms}`
}

export function VideoTrimDialog({ file, open, onOpenChange, onDone }: VideoTrimDialogProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [duration, setDuration] = useState(0)
  const [current, setCurrent] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [trimStart, setTrimStart] = useState(0)
  const [trimEnd, setTrimEnd] = useState(0)
  const [saving, setSaving] = useState(false)
  const [dragging, setDragging] = useState<'start' | 'end' | null>(null)
  const timelineRef = useRef<HTMLDivElement>(null)

  // Reset when file changes or dialog opens
  useEffect(() => {
    if (open && file) {
      setTrimStart(0)
      setTrimEnd(0) // will be set on metadata load
      setCurrent(0)
      setPlaying(false)
    }
  }, [open, file])

  const handleLoadedMetadata = useCallback(() => {
    const v = videoRef.current
    if (v && v.duration > 0) {
      setDuration(v.duration)
      setTrimEnd(v.duration)
    }
  }, [])

  const handleTimeUpdate = useCallback(() => {
    const v = videoRef.current
    if (v) setCurrent(v.currentTime)
  }, [])

  const togglePlay = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) {
      // If at or past trimEnd, jump to trimStart
      if (v.currentTime >= trimEnd - 0.05) v.currentTime = trimStart
      v.play().catch(() => {})
      setPlaying(true)
    } else {
      v.pause()
      setPlaying(false)
    }
  }, [trimStart, trimEnd])

  // Pause when reaching trimEnd during preview
  useEffect(() => {
    if (playing && current >= trimEnd - 0.05) {
      videoRef.current?.pause()
      setPlaying(false)
    }
  }, [current, playing, trimEnd])

  const handleSeek = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const el = timelineRef.current
    const v = videoRef.current
    if (!el || !v || duration === 0) return
    const rect = el.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    v.currentTime = pct * duration
    setCurrent(pct * duration)
  }, [duration])

  // (правка 474) Кадр под маркером во время перетаскивания: видео встаёт
  // на позицию маркера и на паузу — видно, что именно попадёт в обрезок.
  const seekPreview = useCallback((t: number) => {
    const v = videoRef.current
    if (!v) return
    if (!v.paused) v.pause()
    setPlaying(false)
    v.currentTime = t
    setCurrent(t)
  }, [])

  const handleTrimDrag = useCallback((e: React.MouseEvent) => {
    if (!dragging) return
    const el = timelineRef.current
    if (!el || duration === 0) return
    const rect = el.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    const t = pct * duration
    if (dragging === 'start') {
      const nt = Math.min(t, trimEnd - 0.2)
      setTrimStart(nt)
      seekPreview(nt) // (правка 474)
    } else {
      const nt = Math.max(t, trimStart + 0.2)
      setTrimEnd(nt)
      seekPreview(nt) // (правка 474)
    }
  }, [dragging, duration, trimStart, trimEnd, seekPreview])

  useEffect(() => {
    if (!dragging) return
    const onMove = (e: MouseEvent) => handleTrimDrag(e as unknown as React.MouseEvent)
    const onUp = () => setDragging(null)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [dragging, handleTrimDrag])

  const handleSave = useCallback(async () => {
    if (!file || saving) return
    if (trimStart >= trimEnd - 0.1) {
      toast.error('Диапазон слишком короткий')
      return
    }
    setSaving(true)
    try {
      const res = await fetch('/api/comfy/trim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: file.filename,
          subfolder: file.subfolder,
          start: Math.round(trimStart * 100) / 100,
          end: Math.round(trimEnd * 100) / 100,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Ошибка обрезки')
      toast.success(`Обрезано: ${fmt(trimStart)} → ${fmt(trimEnd)} (${data.duration} с)`)
      // (правка 474) Глобальный сигнал обновления: onDone → load() без
      // include_hot не видел свежий файл — files-роут пропускает «горячие»
      // файлы младше 4 секунд. bump запускает во всех галереях серию
      // отложенных загрузок + fast-track с include_hot — обрезанный файл
      // появляется сразу, без ручного обновления.
      useGalleryRefresh.getState().bump()
      onOpenChange(false)
      onDone?.()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Ошибка')
    } finally {
      setSaving(false)
    }
  }, [file, saving, trimStart, trimEnd, onOpenChange, onDone])

  // Percentages for the timeline
  const startPct = duration > 0 ? (trimStart / duration) * 100 : 0
  const endPct = duration > 0 ? (trimEnd / duration) * 100 : 100
  const currentPct = duration > 0 ? (current / duration) * 100 : 0
  const selectedDuration = Math.max(0, trimEnd - trimStart)

  if (!file) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <ScissorsIcon className="w-4 h-4 text-cyan-400" />
            Обрезка видео
          </DialogTitle>
          <DialogDescription className="text-xs">
            Перетащите маркеры на таймлайне, чтобы выбрать диапазон. Кнопка ▶ проигрывает только выбранный фрагмент.
          </DialogDescription>
        </DialogHeader>

        {/* Video player */}
        <div className="relative rounded-lg overflow-hidden bg-black aspect-video">
          <video
            ref={videoRef}
            src={file.url}
            className="w-full h-full object-contain"
            onLoadedMetadata={handleLoadedMetadata}
            onTimeUpdate={handleTimeUpdate}
            onEnded={() => setPlaying(false)}
            playsInline
          />
        </div>

        {/* Timeline with trim handles */}
        <div className="mt-3 space-y-1">
          <div
            ref={timelineRef}
            className="relative h-8 rounded-md bg-[var(--surface-3)] cursor-pointer select-none"
            onClick={handleSeek}
          >
            {/* Selected range highlight */}
            <div
              className="absolute top-0 h-full rounded-md bg-cyan-500/20 border-x-2 border-cyan-400/60"
              style={{ left: `${startPct}%`, width: `${Math.max(0, endPct - startPct)}%` }}
            />
            {/* Playhead */}
            <div
              className="absolute top-0 h-full w-0.5 bg-white/80 pointer-events-none"
              style={{ left: `${currentPct}%` }}
            />
            {/* Start handle */}
            <div
              className="absolute top-0 h-full w-3 -ml-1.5 cursor-ew-resize z-10 flex items-center justify-center"
              style={{ left: `${startPct}%` }}
              onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); setDragging('start') }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="w-2.5 h-5 rounded-sm bg-cyan-400 border border-cyan-200 shadow" />
            </div>
            {/* End handle */}
            <div
              className="absolute top-0 h-full w-3 -ml-1.5 cursor-ew-resize z-10 flex items-center justify-center"
              style={{ left: `${endPct}%` }}
              onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); setDragging('end') }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="w-2.5 h-5 rounded-sm bg-cyan-400 border border-cyan-200 shadow" />
            </div>
          </div>

          {/* Time labels */}
          <div className="flex justify-between text-[10px] text-muted-foreground font-mono">
            <span>0:00</span>
            <span className="text-cyan-400">{fmt(trimStart)} → {fmt(trimEnd)}</span>
            <span>{fmt(duration)}</span>
          </div>
        </div>

        {/* Controls */}
        <div className="flex items-center gap-2 mt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={togglePlay}
            className="h-8 px-3 gap-1.5 text-xs"
          >
            {playing ? <PauseIcon className="w-3.5 h-3.5" /> : <PlayIcon className="w-3.5 h-3.5" />}
            {playing ? 'Пауза' : 'Превью'}
          </Button>

          <div className="flex-1" />

          <span className="text-[10px] text-muted-foreground">
            Фрагмент: <span className="text-foreground font-medium">{selectedDuration.toFixed(1)} с</span>
          </span>

          <Button
            size="sm"
            onClick={() => void handleSave()}
            disabled={saving || duration === 0 || selectedDuration < 0.2}
            className="h-8 px-4 gap-1.5 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white border-0 text-xs font-medium"
          >
            {saving ? (
              <Loader2Icon className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <CheckIcon className="w-3.5 h-3.5" />
            )}
            {saving ? 'Сохранение…' : 'Обрезать и сохранить'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
