'use client'

/**
 * Shared controls for the video generation view.
 * Components read/write the shared `video` slice of the gen-store,
 * so the parameters survive tab switches and page reloads.
 */

import * as React from 'react'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DicesIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useGenStore } from '@/lib/gen-store'
import type { ModelOptions } from '@/hooks/use-model-options'
import { uploadInputFile } from '@/lib/upload'
import { framesForDuration } from '@/lib/comfy/minimax-h3-template'

/* ──────────────── Shared helpers ──────────────── */

export { uploadInputFile }

/** Snap a frame count onto the model's alignment grid (min + k*step). */
export function alignFrames(value: number, min: number, max: number, step: number): number {
  const s = step > 0 ? step : 1
  const snapped = min + Math.round((value - min) / s) * s
  return Math.max(min, Math.min(max, snapped))
}

/**
 * Fallback resolution presets for H3 while model-options is loading.
 * (правка 124) Значения = ТОЧНЫЕ номинальные (финальные) размеры видео:
 * короткая сторона = «p», длинная = короткая × (A:B) до чётного.
 * Генерация идёт чуть крупнее (кратное 32), в конце — кроп ровно до
 * номинала (16:9 1080p → 1920×1080). Не путать с gen-размером!
 */
export const FALLBACK_H3_PRESETS: Record<string, Record<string, string>> = {
  '480p': { '16:9': '854x480', '9:16': '480x854', '1:1': '480x480', '4:3': '640x480', '3:4': '480x640', '21:9': '1120x480' },
  '720p': { '16:9': '1280x720', '9:16': '720x1280', '1:1': '720x720', '4:3': '960x720', '3:4': '720x960', '21:9': '1680x720' },
  '1080p': { '16:9': '1920x1080', '9:16': '1080x1920', '1:1': '1080x1080', '21:9': '2520x1080' },
}

/** Derive (quality, aspect) from a nominal resolution string like "1280x720". (правка 124) */
export function parseResolution(res: string, presets: Record<string, Record<string, string>>): { quality: string; aspect: string } {
  for (const [quality, aspects] of Object.entries(presets)) {
    for (const [aspect, value] of Object.entries(aspects)) {
      if (value === res) return { quality, aspect }
    }
  }
  return { quality: '720p', aspect: '16:9' }
}

/** Resolve a resolution string from quality + aspect using presets. */
export function resolveResolution(quality: string, aspect: string, presets: Record<string, Record<string, string>>): string {
  const aspects = presets[quality]
  if (aspects) {
    if (aspects[aspect]) return aspects[aspect]
    if (aspects['auto']) return aspects['auto']
  }
  return '1280x720'
}

/** Extract resolution presets from model-options (with H3 fallback). */
export function buildPresets(
  options: ModelOptions | null,
  isH3: boolean,
): Record<string, Record<string, string>> {
  const raw = options?.resolution_presets as Record<string, unknown> | null
  if (raw && Object.keys(raw).length > 0) {
    // Sort tiers by numeric quality first ("480p" → 480) so the list always
    // reads ascending; backend order breaks ties for non-numeric names.
    const order = (options?.resolution_preset_order as string[] | null) ?? []
    const qualityNum = (g: string) => Number.parseInt(g, 10) || 0
    const orderIdx = (g: string) => {
      const i = order.indexOf(g)
      return i === -1 ? 99 : i
    }
    const groups = Object.keys(raw).sort((a, b) => qualityNum(a) - qualityNum(b) || orderIdx(a) - orderIdx(b))
    const out: Record<string, Record<string, string>> = {}
    for (const g of groups) {
      const entry = raw[g]
      // { label, values: { aspect: resolution } } shape
      if (entry && typeof entry === 'object' && 'values' in (entry as Record<string, unknown>)) {
        out[g] = { ...((entry as { values: Record<string, string> }).values) }
      } else if (entry && typeof entry === 'object') {
        // Flat fallback: { aspect: resolution }
        out[g] = { ...(entry as Record<string, string>) }
      }
    }
    if (Object.keys(out).length > 0) return out
  }
  if (!isH3) return {}
  return JSON.parse(JSON.stringify(FALLBACK_H3_PRESETS)) as Record<string, Record<string, string>>
}

/** Flat list of all resolution values inside presets. */
export function collectResolutionValues(presets: Record<string, Record<string, string>>): string[] {
  const values: string[] = []
  for (const aspects of Object.values(presets)) values.push(...Object.values(aspects))
  return values
}

/* ──────────────── DurationSlider ──────────────── */

interface DurationSliderProps {
  min: number
  max: number
  step: number
  fps: number
  /** Extra hint appended under the slider (e.g. alignment rule). */
  hint?: string
  disabled?: boolean
}

export function DurationSlider({ min, max, fps, hint, disabled }: DurationSliderProps) {
  const videoLength = useGenStore((s) => s.video.videoLength)
  const setVideoLength = useGenStore((s) => s.setVideoLength)
  // Guard against undefined/NaN from stale localStorage
  const safeLength = typeof videoLength === 'number' && !isNaN(videoLength) ? videoLength : min
  const clamped = Math.min(Math.max(safeLength, min), max)

  /**
   * (правка 894) UI длительности — В ЦЕЛЫХ СЕКУНДАХ. В сторе по-прежнему
   * лежат кадры на валидной сетке модели (17n+5) — их ждёт шаблон ComfyUI,
   * — но ползунок и ручной ввод работают в секундах с шагом 1 с. Секунда
   * переводится в ближайшее валидное число кадров (framesForDuration),
   * поэтому «5 с» в интерфейсе = честные ~5.0–5.2 с в генерации.
   */
  const framesForSec = React.useCallback(
    (sec: number) => Math.max(min, Math.min(max, framesForDuration(sec, fps))),
    [fps, min, max],
  )
  /** допустимый диапазон ЦЕЛЫХ секунд: от первой валидной до последней */
  const secMin = Math.ceil(min / fps)
  const secMax = Math.max(secMin, Math.floor(max / fps))
  /** текущее значение в целых секундах: сначала ищем секунду, которая даёт
   *  ровно эти кадры (иначе 1 с → 39 кадров показывались бы как 2 с),
   *  и только потом — ближайшую секунду к сохранённым кадрам. */
  const curSec = React.useMemo(() => {
    for (let sec = secMin; sec <= secMax; sec++) {
      if (framesForSec(sec) === clamped) return sec
    }
    return Math.max(secMin, Math.min(secMax, Math.round(clamped / fps)))
  }, [clamped, secMin, secMax, framesForSec, fps])

  // (правка 107) Ручной ввод. Длительность НЕ выходит за границы модели:
  // бэкенд тихо климпает вне диапазона, поэтому при коммите значение
  // привязывается к ближайшей валидной сетке кадров и к [secMin, secMax].
  const [draft, setDraft] = React.useState<string | null>(null)
  const commitLength = () => {
    if (draft === null) return
    const n = Number.parseFloat(draft.replace(',', '.'))
    setDraft(null)
    if (!Number.isFinite(n)) return // некорректно — откат к текущему
    const sec = Math.max(secMin, Math.min(secMax, Math.round(n)))
    const v = framesForSec(sec)
    if (v !== safeLength) setVideoLength(v)
  }

  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground flex items-center justify-between gap-2">
        <span>Длительность</span>
        <span className="flex items-center gap-1.5">
          <input
            type="text"
            inputMode="numeric"
            aria-label={`Длительность: ручной ввод в секундах (${secMin}–${secMax} с)`}
            title={`Секунды: ${secMin}–${secMax} · внутри — ближайшие валидные кадры (${min}–${max}, 17n+5, ${fps} fps)`}
            value={draft ?? String(curSec)}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => {
              setDraft(null)
              requestAnimationFrame(() => e.target.select())
            }}
            onBlur={commitLength}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commitLength()
              } else if (e.key === 'Escape') {
                setDraft(null)
                ;(e.target as HTMLInputElement).blur()
              }
            }}
            disabled={disabled}
            className={cn(
              'h-6 w-16 rounded-md border border-border bg-[var(--surface-2)] px-1.5 text-right font-mono text-xs tabular-nums text-foreground/80',
              'focus:border-cyan-500/60 focus:outline-none focus:ring-1 focus:ring-cyan-500/40',
              disabled && 'opacity-40 pointer-events-none',
            )}
          />
          {/* (правка 894) Бейдж — целые секунды; реальные кадры в подсказке. */}
          <Badge
            variant="secondary"
            className="text-xs"
            title={`Фактически: ${(clamped / fps).toFixed(2)} с · ${clamped} кадров`}
          >
            {curSec} с
          </Badge>
        </span>
      </Label>
      <input
        type="range"
        min={secMin}
        max={secMax}
        step={1}
        value={curSec}
        onChange={(e) => setVideoLength(framesForSec(Number(e.target.value)))}
        disabled={disabled}
        className="w-full accent-cyan-500"
      />
      <p className="text-[10px] text-muted-foreground/60">
        {fps} кадр/с · от {secMin} до {secMax} с, шаг 1 с{hint ? ` · ${hint}` : ''}
        {' · '}
        <span title="Секунда переводится в ближайшее валидное число кадров модели; вне диапазона — к границе">ручной ввод в секундах: {secMin}–{secMax} с.</span>
      </p>
    </div>
  )
}

/* ──────────────── SeedBlock ──────────────────── */

export function SeedBlock({ disabled }: { disabled?: boolean }) {
  const seed = useGenStore((s) => s.video.seed)
  const setSeed = useGenStore((s) => s.setVideoSeed)

  return (
    <div className="space-y-2">
      <Label className="text-xs text-muted-foreground flex items-center justify-between">
        <span>Seed</span>
        <button
          onClick={() => setSeed(-1)}
          className="p-1 rounded hover:bg-[var(--surface-3)] transition-colors"
          title="Случайный seed (-1)"
        >
          <DicesIcon className="w-4 h-4 text-muted-foreground" />
        </button>
      </Label>
      <Input
        type="number"
        value={seed}
        onChange={(e) => {
          // Промежуточные значения («-», «1e-») дают NaN — поле «залипало»
          // на NaN: рендерилось как строка «NaN» и переставало парситься.
          // Некорректное вводимое значение трактуем как случайный seed.
          // Кламп [0, 2^31): выход за диапазон переполнял INT ComfyUI
          // (noise_seed) и давал непрозрачную ошибку отправки.
          const n = e.target.valueAsNumber
          const MAX_SEED = 2 ** 31 - 1
          if (!Number.isFinite(n)) { setSeed(-1); return }
          setSeed(n < 0 ? -1 : Math.min(Math.trunc(n), MAX_SEED))
        }}
        disabled={disabled}
        className={cn('h-9 bg-[var(--surface-2)] border-border text-sm font-mono')}
      />
    </div>
  )
}
