'use client'

/**
 * PromptQuality — compact live checklist under the prompt field.
 * Non-blocking hints for beginners:
 *   - are references bound with tags at all;
 *   - do tag numbers point to existing references;
 *   - is <d>…</d> balanced (and are the lines short enough);
 *   - word/sentence counter with the "3–6 sentences" sweet spot.
 */
import { useMemo } from 'react'
import { cn } from '@/lib/utils'

interface PromptQualityProps {
  prompt: string
  /** Number of currently loaded references (unified numbering). */
  refsCount: number
  className?: string
}

type Item = { kind: 'ok' | 'warn' | 'muted'; text: string }

function analyze(prompt: string, refsCount: number): Item[] {
  const items: Item[] = []
  const trimmed = prompt.trim()
  if (!trimmed) return items

  // ── Reference tags ──
  const tags = [...trimmed.matchAll(/<(Picture|Video|Audio) (\d+)>/g)]
  if (tags.length === 0) {
    if (refsCount > 0) {
      items.push({ kind: 'warn', text: `Референсы не привязаны — введите @ в промпте (${refsCount} загружено)` })
    }
  } else {
    // Уникальные теги: повторное использование того же референса
    // (например, два раза <Picture 1>) — это ОДИН тег.
    const unique = new Set(tags.map((t) => t[0]))
    const maxNum = Math.max(...tags.map((t) => parseInt(t[2], 10)))
    if (maxNum > refsCount) {
      items.push({ kind: 'warn', text: `Тег №${maxNum} указывает на несуществующий референс (загружено ${refsCount})` })
    } else {
      const repeated = tags.length - unique.size
      items.push({
        kind: 'ok',
        text: `Референсы: ${unique.size} тег(ов)${repeated > 0 ? ` · повторов: ${repeated}` : ''}`,
      })
    }
  }

  // ── Dialogue balance ──
  const dOpen = (trimmed.match(/<d>/g) || []).length
  const dClose = (trimmed.match(/<\/d>/g) || []).length
  if (dOpen !== dClose) {
    items.push({ kind: 'warn', text: `Незакрытый <d> — открывающих ${dOpen}, закрывающих ${dClose}` })
  }
  const longLine = [...trimmed.matchAll(/<d>(.*?)<\/d>/g)].find((m) => m[1].trim().split(/\s+/).length > 12)
  if (longLine) {
    items.push({ kind: 'warn', text: 'Длинная реплика (>12 слов) — озвучка любит короткие фразы' })
  }

  // ── Size ──
  const words = trimmed.split(/\s+/).filter(Boolean).length
  const sentences = Math.max(1, (trimmed.match(/[.!?]+(\s|$)/g) || []).length)
  if (sentences < 3 || sentences > 6) {
    items.push({ kind: 'muted', text: `${words} слов · ${sentences} предл. — оптимально 3–6 предложений` })
  } else {
    items.push({ kind: 'muted', text: `${words} слов · ${sentences} предл.` })
  }

  return items
}

const KIND_CLASS = {
  ok: 'text-emerald-400/90 bg-emerald-500/10 border-emerald-500/20',
  warn: 'text-amber-300 bg-amber-500/10 border-amber-500/25',
  muted: 'text-muted-foreground bg-[var(--surface-2)]/70 border-border',
} as const

export function PromptQuality({ prompt, refsCount, className }: PromptQualityProps) {
  const items = useMemo(() => analyze(prompt, refsCount), [prompt, refsCount])
  if (items.length === 0) return null

  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
      {items.map((it, i) => (
        <span
          key={i}
          className={cn(
            'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] leading-none',
            KIND_CLASS[it.kind],
          )}
        >
          {it.kind === 'ok' && '✓'}
          {it.kind === 'warn' && '!'}
          {it.text}
        </span>
      ))}
    </div>
  )
}
