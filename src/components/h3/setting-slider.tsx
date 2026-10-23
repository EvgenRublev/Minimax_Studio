'use client'

import * as React from 'react'
import { Slider } from '@/components/ui/slider'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

interface SettingSliderProps {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (value: number) => void
  formatValue?: (value: number) => string
  unit?: string
  disabled?: boolean
  /** (правка 107) Ручной ввод: допустимые границы значения. Могут быть шире
   *  диапазона ползунка (выход за рамки), но не уже. Если не заданы —
   *  компонент ручной ввод не показывает. */
  inputMin?: number
  inputMax?: number
  /** (правка 107) Подсказка в title у поля ввода (например, «выше 30 = медленнее»). */
  inputHint?: string
  /** Тултип-пояснение на лейбле (взамен мелкой серой подписи под слайдером). */
  labelTitle?: string
}

export function SettingSlider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  formatValue,
  unit,
  disabled,
  inputMin,
  inputMax,
  inputHint,
  labelTitle,
}: SettingSliderProps) {
  // Guard against undefined/null from stale localStorage
  const safeValue = typeof value === 'number' && !isNaN(value) ? value : min
  const manual = inputMin !== undefined || inputMax !== undefined
  const inMin = inputMin ?? min
  const inMax = inputMax ?? max
  // (правка 107) Значение вне диапазона ползунка — визуально помечаем
  // (сам Radix-ползунок такие значения безопасно «прижимает» к краю).
  const outOfSlider = safeValue < min || safeValue > max

  // (правка 107) Черновик поля ввода держим строкой: так корректно работает
  // ввод «1.», «0,5», пустое поле — без «залипания» на NaN.
  const [draft, setDraft] = React.useState<string | null>(null)

  const commit = () => {
    if (draft === null) return
    const n = Number.parseFloat(draft.replace(',', '.'))
    setDraft(null)
    if (!Number.isFinite(n)) return // некорректно — откат к текущему значению
    let v = Math.min(inMax, Math.max(inMin, n))
    if (step > 0) v = Math.round(v / step) * step
    v = Math.round(v * 10000) / 10000 // хвост плавающей запятой (0.05*3)
    if (v !== safeValue) onChange(v)
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-xs text-muted-foreground font-medium" title={labelTitle}>{label}</Label>
        {manual ? (
          // (правка 107) Ручной ввод — ЕДИНСТВЕННОЕ место значения: дублирующую
          // бейдж-надпись не показываем. Размер (для MP-ползунков) и так
          // виден в подсказке ниже.
          <input
            type="text"
            inputMode="decimal"
            aria-label={`${label}: ручной ввод (${inMin}–${inMax})`}
            title={inputHint || `Допустимо ${inMin}–${inMax}`}
            value={draft ?? String(safeValue)}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => {
              // Выделяем всё, чтобы ввод сразу заменил значение
              setDraft(null)
              requestAnimationFrame(() => e.target.select())
            }}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commit()
              } else if (e.key === 'Escape') {
                setDraft(null)
                ;(e.target as HTMLInputElement).blur()
              }
            }}
            disabled={disabled}
            className={cn(
              'h-6 w-16 shrink-0 rounded-md border bg-[var(--surface-2)] px-1.5 text-right font-mono text-xs tabular-nums',
              'focus:border-cyan-500/60 focus:outline-none focus:ring-1 focus:ring-cyan-500/40',
              outOfSlider ? 'border-amber-500/50 text-amber-300' : 'border-border text-foreground/80',
              disabled && 'opacity-40 pointer-events-none',
            )}
          />
        ) : (
          <span
            className={cn(
              'text-xs font-mono tabular-nums',
              outOfSlider ? 'text-amber-300' : 'text-foreground/80',
            )}
            title={outOfSlider ? 'Вне диапазона ползунка (ручной ввод)' : undefined}
          >
            {formatValue ? formatValue(safeValue) : safeValue}{unit ? ` ${unit}` : ''}
          </span>
        )}
      </div>
      <Slider
        value={[safeValue]}
        min={min}
        max={max}
        step={step}
        onValueChange={([v]) => onChange(v)}
        disabled={disabled}
        className={cn(
          'py-1 [&_[role=slider]]:h-3.5 [&_[role=slider]]:w-3.5 [&_[role=slider]]:border-0 [&_[role=slider]]:bg-primary [&_[role=slider]]:shadow-[0_0_8px_rgba(139,92,246,0.4)] [&_[role=slider]]:hover:shadow-[0_0_12px_rgba(139,92,246,0.6)]',
          disabled && 'opacity-40 pointer-events-none',
        )}
      />
    </div>
  )
}