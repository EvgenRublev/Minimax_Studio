'use client'

/**
 * (правка 723) FacePickDialog — окно «кого перерисовывать»: исходник с
 * прокруткой по кадрам и клик по нужному лицу.
 *
 * Зачем: правило (самое крупное / левее / правее) видит только геометрию кадра
 * и в толпе или на общем плане упирается в одно и то же лицо. Клик задаёт цель
 * напрямую: нода H3 Face Track + Crop берёт ближайшее к точке лицо и ведёт
 * этого человека через весь ролик.
 *
 * Координаты считаются в пикселях САМОГО ВИДЕО (video.videoWidth/Height) —
 * именно их ждут входы X/Y. Номер кадра — из fps, который вернул ffprobe
 * (video.currentTime × fps): элемент <video> кадров не отдаёт.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { CrosshairIcon, PauseIcon, PlayIcon, XIcon } from 'lucide-react'
import type { FaceRefinePoint } from '@/lib/face-refine-target-store'

interface FacePickDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** URL исходника (тот же, что играет превью в панели). */
  url: string
  filename: string
  /** fps исходника; 24 — запасное значение, если ffprobe не ответил. */
  fps: number
  /** Всего кадров (0 — неизвестно). */
  frames: number
  point: FaceRefinePoint | null
  onPick: (point: FaceRefinePoint) => void
  /** Сбросить точку и вернуться к правилу. */
  onClear: () => void
}

function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) return '0:00.0'
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${s.toFixed(1).padStart(4, '0')}`
}

export function FacePickDialog({
  open,
  onOpenChange,
  url,
  filename,
  fps,
  frames,
  point,
  onPick,
  onClear,
}: FacePickDialogProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [duration, setDuration] = useState(0)
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [marker, setMarker] = useState<FaceRefinePoint | null>(point)
  // Браузер читает далеко не все контейнеры (mkv/mxf), а без кадра клик некуда ставить.
  const [loadFailed, setLoadFailed] = useState(false)
  // Каждое открытие подхватывает текущую точку; клики внутри окна её не сбивают.
  const openedRef = useRef(false)

  const frameOf = useCallback(
    (t: number) => Math.max(0, Math.round(t * (fps > 0 ? fps : 24))),
    [fps],
  )

  useEffect(() => {
    if (!open) {
      openedRef.current = false
      return
    }
    if (openedRef.current) return
    openedRef.current = true
    setMarker(point)
    setPlaying(false)
    setLoadFailed(false)
  }, [open, point])

  // Метаданные приходят после открытия: здесь же ставим курсор на кадр точки,
  // чтобы её было видно и можно было поправить.
  const handleMetadata = () => {
    const v = videoRef.current
    if (!v) return
    const dur = isFinite(v.duration) ? v.duration : 0
    setDuration(dur)
    setSize({ w: v.videoWidth, h: v.videoHeight })
    const t = point && fps > 0 ? point.frame / fps : 0
    v.currentTime = Math.max(0, Math.min(t, dur > 0 ? dur - 0.05 : 0))
    setTime(v.currentTime)
  }

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const v = videoRef.current
    if (!v || !v.videoWidth || !v.videoHeight) return
    const r = v.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return
    const x = Math.max(0, Math.min(v.videoWidth - 1,
      Math.round(((e.clientX - r.left) / r.width) * v.videoWidth)))
    const y = Math.max(0, Math.min(v.videoHeight - 1,
      Math.round(((e.clientY - r.top) / r.height) * v.videoHeight)))
    const picked: FaceRefinePoint = { x, y, frame: frameOf(v.currentTime) }
    setMarker(picked)
    onPick(picked)
  }

  const togglePlay = () => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) void v.play().catch(() => { /* автоплей заблокирован — не критично */ })
    else v.pause()
  }

  const seek = (t: number) => {
    const v = videoRef.current
    if (!v || !duration) return
    const next = Math.max(0, Math.min(t, duration))
    v.currentTime = next
    setTime(next)
  }

  const markerPct = marker && size.w > 0
    ? { left: `${(marker.x / size.w) * 100}%`, top: `${(marker.y / size.h) * 100}%` }
    : null

  // Вписываем даже вертикальное/огромное видео в окно: ширина ограничена
  // 52vh по высоте (52 * aspect), а не 900px по ширине. Иначе 9:16-ролик
  // получался высотой в несколько экранов и низ кадра уезжал под скролл.
  const maxVideoWidthVh =
    size.w > 0 && size.h > 0 ? 52 * (size.w / size.h) : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[900px] max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <CrosshairIcon className="w-4 h-4 text-yellow-400" />
            Кого перерисовывать
          </DialogTitle>
          <DialogDescription className="text-xs">
            Найдите кадр, где нужное лицо видно лучше всего, и кликните по нему.
            Нода возьмёт ближайшее к точке лицо и будет вести этого человека через
            весь ролик.
            {filename && <span className="text-muted-foreground/70"> {filename}</span>}
          </DialogDescription>
        </DialogHeader>

        {/* Кадр. Клик по видео = точка. Обёртка получает ширину из aspect
            видео и ограничения 52vh по высоте: даже огромный вертикальный
            ролик целиком помещается в окно, без прокрутки до нижнего края.
            Рамка обёртки совпадает с кадром, поэтому проценты маркера равны
            пикселям видео. */}
        <div className="flex justify-center">
          <div
            className="relative inline-block max-w-full rounded-lg overflow-hidden bg-black cursor-crosshair select-none"
            style={maxVideoWidthVh ? { width: `min(100%, ${maxVideoWidthVh}vh)` } : { width: '100%' }}
            onClick={handleClick}
            title="Кликните по лицу"
          >
            <video
              ref={videoRef}
              src={url}
              className="w-full h-auto block"
              preload="metadata"
              playsInline
              onLoadedMetadata={handleMetadata}
              onError={() => setLoadFailed(true)}
              onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onEnded={() => setPlaying(false)}
            />
            {markerPct && (
              <div
                className="absolute -translate-x-1/2 -translate-y-1/2 pointer-events-none"
                style={markerPct}
              >
                <span className="absolute -inset-3 rounded-full border-2 border-yellow-400" />
                <span className="absolute left-1/2 top-1/2 w-2 h-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-yellow-400" />
              </div>
            )}
          </div>
        </div>

        {/* Таймлайн и кадр */}
        <div className="space-y-1">
          {loadFailed && (
            <p className="text-[10px] text-yellow-400">
              Браузер не открыл этот файл (контейнер не читается) — выберите лицо
              правилом в панели слева.
            </p>
          )}
          <input
            type="range"
            min={0}
            max={Math.max(duration, 0.01)}
            step={1 / (fps > 0 ? fps : 24)}
            value={Math.min(time, duration || 0)}
            onChange={(e) => seek(parseFloat(e.target.value))}
            className="w-full accent-yellow-400"
            aria-label="Позиция в ролике"
          />
          <div className="flex items-center justify-between text-[10px] text-muted-foreground font-mono">
            <span>{fmtTime(time)} / {fmtTime(duration)}</span>
            <span className="text-yellow-400">
              кадр {frameOf(time)}{frames > 0 ? ` из ${frames}` : ''}
              {marker ? ` · точка на кадре ${marker.frame}` : ''}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={togglePlay} className="h-8 px-3 gap-1.5 text-xs">
            {playing ? <PauseIcon className="w-3.5 h-3.5" /> : <PlayIcon className="w-3.5 h-3.5" />}
            {playing ? 'Пауза' : 'Проиграть'}
          </Button>
          <div className="flex-1" />
          {marker && (
            <>
              <span className="text-[10px] text-muted-foreground font-mono">
                X {marker.x} · Y {marker.y}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { setMarker(null); onClear(); onOpenChange(false) }}
                className="h-8 px-2 gap-1 text-xs text-muted-foreground"
                title="Сбросить точку и вернуться к правилу"
              >
                <XIcon className="w-3.5 h-3.5" />
                Сбросить
              </Button>
            </>
          )}
          <Button
            size="sm"
            onClick={() => onOpenChange(false)}
            className="h-8 px-4 text-xs bg-yellow-500 hover:bg-yellow-400 text-black border-0 font-medium"
          >
            Готово
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
