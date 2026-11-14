'use client'

/**
 * (правка 969) Общие примитивы панелей настроек.
 *
 * Панели вкладок были разной ширины (360/400/350), с разными заголовками и
 * кучей мелких подписей под полями. Здесь единая ширина (как у Refine),
 * заголовок и иконка-подсказка: пояснение показывается только по наведению.
 */
import type { ReactNode } from 'react'
import { InfoIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/** Ширина панели параметров — эталон вкладки Refine. */
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
            'inline-flex items-center justify-center text-muted-foreground/50 hover:text-cyan-400 transition-colors shrink-0',
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
