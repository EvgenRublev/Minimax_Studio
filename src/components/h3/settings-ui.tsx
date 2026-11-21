'use client'

/**
 * (правка 1067) Общие примитивы окна настроек.
 *
 * Раньше панели вкладок были разной ширины (360/400/350), с разными
 * заголовками и кучей мелких подписей под полями. Теперь у настроек один
 * визуальный язык — тот же, что у остального приложения:
 *   • левая навигация — как боковой сайдбар (surface-1, активный пункт
 *     surface-3 + цветная полоса слева);
 *   • группы — карточки `rounded-lg border border-border bg-surface-2`
 *     (как строки моделей в «Голосе» и блоки в метаданных);
 *   • строка настройки — подпись 12 px + пояснение 11 px, контрол справа;
 *   • тумблер — ровно тот же, что в панели «Голосовой ввод» (w-9 h-5, cyan);
 *   • сегментированный выбор — как «Текст / Кадры / Референсы» в «Генерации».
 *
 * Пояснения держим на полном `text-muted-foreground` (не /60): на 10 px
 * полупрозрачный серый давал контраст ~2:1 при норме 4.5:1.
 */
import type { ReactNode } from 'react'
import { InfoIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/** Ширина панели параметров — эталон вкладки Refine (оставлено для совместимости). */
export const SETTINGS_PANEL_WIDTH = 'w-[390px]'

export function SettingsAside({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <aside
      className={cn(
        SETTINGS_PANEL_WIDTH,
        'shrink-0 border-r border-border bg-[var(--surface-1)] flex flex-col',
        className,
      )}
    >
      {children}
    </aside>
  )
}

export function SettingsHeader({
  icon,
  title,
  hint,
  right,
}: {
  icon?: ReactNode
  title: ReactNode
  /** Пояснение к вкладке — вместо мелкой подписи под заголовком. */
  hint?: string
  right?: ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2 min-w-0">
        {icon}
        <h2 className="text-sm font-semibold text-foreground truncate">{title}</h2>
        {hint && <HintIcon text={hint} />}
      </div>
      {right}
    </div>
  )
}

/** Иконка «?» с подсказкой: заменяет мелкие пояснения под настройками. */
export function HintIcon({ text, className }: { text: string; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={text}
          className={cn(
            'inline-flex items-center justify-center text-muted-foreground/60 hover:text-cyan-400 transition-colors shrink-0',
            className,
          )}
        >
          <InfoIcon className="w-3.5 h-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[280px] text-xs leading-relaxed">
        {text}
      </TooltipContent>
    </Tooltip>
  )
}

/* ─────────────────────────── Карточка группы ─────────────────────────── */

/**
 * Группа настроек: тот же контейнер, что у строк моделей и блоков метаданных
 * (`rounded-lg border border-border bg-[var(--surface-2)]`), с шапкой
 * «иконка + название + одна строка пояснения».
 */
export function SettingsCard({
  icon,
  title,
  description,
  action,
  tone = 'default',
  children,
  className,
}: {
  icon?: ReactNode
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  tone?: 'default' | 'danger'
  children: ReactNode
  className?: string
}) {
  return (
    <section
      className={cn(
        'overflow-hidden rounded-lg border bg-[var(--surface-2)]',
        tone === 'danger' ? 'border-red-500/25' : 'border-border',
        className,
      )}
    >
      <header className="flex items-center gap-2.5 border-b border-border/60 px-3.5 py-2.5">
        {icon && (
          <span className={cn('shrink-0', tone === 'danger' ? 'text-red-400' : 'text-cyan-400')}>
            {icon}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <h3 className={cn('text-sm font-medium leading-tight', tone === 'danger' ? 'text-red-300' : 'text-foreground')}>
            {title}
          </h3>
          {description && (
            <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{description}</p>
          )}
        </div>
        {action && <div className="flex shrink-0 items-center gap-1.5">{action}</div>}
      </header>
      <div className="divide-y divide-border/50">{children}</div>
    </section>
  )
}

/* ─────────────────────────── Строка настройки ─────────────────────────── */

/** Горизонтальная строка: подпись и пояснение слева, контрол справа. */
export function SettingsRow({
  label,
  description,
  right,
  disabled,
  className,
}: {
  label: ReactNode
  description?: ReactNode
  right?: ReactNode
  disabled?: boolean
  className?: string
}) {
  return (
    <div className={cn('flex items-center justify-between gap-4 px-3.5 py-2.5', disabled && 'opacity-50', className)}>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-foreground/90">{label}</p>
        {description && (
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{description}</p>
        )}
      </div>
      {right && <div className="flex shrink-0 items-center gap-1.5">{right}</div>}
    </div>
  )
}

/** Вертикальный блок: подпись с текущим значением, пояснение и контрол снизу. */
export function SettingsField({
  label,
  description,
  value,
  children,
  className,
}: {
  label: ReactNode
  description?: ReactNode
  value?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn('px-3.5 py-3', className)}>
      {/* Контролы не растягиваем на всю ширину карточки: узкая колонка
          читается лучше и совпадает с шириной панелей самого приложения. */}
      <div className="max-w-[480px]">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-medium text-foreground/90">{label}</p>
          {value && <span className="shrink-0 text-xs font-mono tabular-nums text-foreground/80">{value}</span>}
        </div>
        {description && (
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{description}</p>
        )}
        <div className="mt-2">{children}</div>
      </div>
    </div>
  )
}

/** Мелкое примечание внизу карточки. */
export function SettingsNote({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn('px-3.5 py-2.5 text-[11px] leading-relaxed text-muted-foreground', className)}>
      {children}
    </p>
  )
}

/* ─────────────────────────── Контролы ─────────────────────────── */

/** Тумблер: ровно стиль панели «Голосовой ввод» (w-9 h-5, cyan-500/40). */
export function SettingsToggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  /** Для доступности, если рядом нет текстовой подписи. */
  label?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-5 w-9 shrink-0 rounded-full border transition-colors',
        checked ? 'bg-cyan-500/40 border-cyan-500/50' : 'bg-[var(--surface-4)] border-border',
        disabled && 'opacity-50 pointer-events-none',
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white transition-all',
          checked ? 'left-[18px]' : 'left-0.5',
        )}
      />
    </button>
  )
}

/**
 * Сегментированный выбор — как «Текст / Кадры / Референсы» в «Генерации»:
 * h-8, rounded-md, активный — cyan-500/15 + рамка cyan-500/50.
 */
export function SettingsChoice<T extends string>({
  value,
  options,
  onChange,
  cols,
  className,
}: {
  value: T
  options: Array<{ value: T; label: ReactNode; title?: string }>
  onChange: (next: T) => void
  /** Число колонок; по умолчанию — по числу вариантов (максимум 5). */
  cols?: 2 | 3 | 4 | 5
  className?: string
}) {
  const columns = cols ?? (Math.min(options.length, 5) as 2 | 3 | 4 | 5)
  const gridCols =
    columns === 2 ? 'grid-cols-2' : columns === 3 ? 'grid-cols-3' : columns === 4 ? 'grid-cols-4' : 'grid-cols-5'
  return (
    <div className={cn('grid gap-1.5', gridCols, className)}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          title={opt.title}
          onClick={() => onChange(opt.value)}
          className={cn(
            'h-8 min-w-0 truncate rounded-md border px-2 text-xs font-medium transition-colors',
            value === opt.value
              ? 'border-cyan-500/50 bg-cyan-500/15 text-cyan-300'
              : 'border-border bg-[var(--surface-1)] text-muted-foreground hover:border-cyan-500/30 hover:text-foreground',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}
