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

export function DurationSlider({ min, max, step, fps, hint, disabled }: DurationSliderProps) {
  const videoLength = useGenStore((s) => s.video.videoLength)
  const setVideoLength = useGenStore((s) => s.setVideoLength)
  // Guard against undefined/NaN from stale localStorage
  const safeLength = typeof videoLength === 'number' && !isNaN(videoLength) ? videoLength : min
  const clamped = Math.min(Math.max(safeLength, min), max)

  // (правка 107) Ручной ввод кадров. Длительность НЕ выходит за границы модели:
  // бэкенд тихо климпает вне диапазона (знаковая ошибка «запросили 2 с, получили 5 с»),
  // поэтому при коммите значение привязывается к сетке (min + k·step ≡ 17n+5)
  // и ограничивается [min, max].
  const [draft, setDraft] = React.useState<string | null>(null)
  const commitLength = () => {
    if (draft === null) return
    const n = Number.parseFloat(draft.replace(',', '.'))
    setDraft(null)
    if (!Number.isFinite(n)) return // некорректно — откат к текущему
    const v = alignFrames(n, min, max, step)
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
            aria-label={`Длительность: ручной ввод (${min}–${max} кадров)`}
            title={`Кадров: ${min}–${max} (сетка 17n+5, ${fps} fps)`}
            value={draft ?? String(clamped)}
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
          {/* (правка 107) Бейдж показывает только секунды: кадры и так видны
              в поле ручного ввода рядом — дублируем нечего. */}
          <Badge variant="secondary" className="text-xs">
            {(clamped / fps).toFixed(1)} с
          </Badge>
        </span>
      </Label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={clamped}
        onChange={(e) => setVideoLength(Number(e.target.value))}
        disabled={disabled}
        className="w-full accent-cyan-500"
      />
      <p className="text-[10px] text-muted-foreground/60">
        {fps} кадр/с · от {(min / fps).toFixed(1)} до {(max / fps).toFixed(1)} с{hint ? ` · ${hint}` : ''}
        {' · '}
        <span title="Значение вне 17n+5 округляется до ближайшей валидной точки, вне границ модели — к границе">ручной ввод: {min}–{max} кадр.</span>
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
