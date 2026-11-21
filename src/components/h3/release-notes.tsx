'use client'

/**
 * (правка 891) Показ чейнджлога релиза студии.
 *
 * Текст приходит с GitHub (body релиза) — это markdown. Тяжёлый рендерер не
 * нужен: наш чейнджлог плоский (заголовки, «- » списки, **жирный**, `код`).
 * Поэтому парсер крошечный и БЕЗ dangerouslySetInnerHTML: все фрагменты
 * вставляются текстовыми узлами, так что HTML из релиза не может ни чего-то
 * отрендерить, ни выполнить скрипт.
 *
 * Два места показа:
 *   • <ReleaseNotes/> — полный список изменений в панели «О программе»;
 *   • стартовый тост об обновлении (правка 1072) показывает только версию:
 *     своих строк из чейнджлога в уведомлении больше нет.
 */
import type { ReactNode } from 'react'

/** Убираем markdown-разметку, оставляя текст. */
function stripInline(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .trim()
}

/** Инлайн-фрагменты: **жирный**, `код`, [текст](ссылка) → текст. */
function renderInline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /\*\*(.+?)\*\*|`(.+?)`|\[([^\]]+)\]\([^)]*\)/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const key = `${keyBase}-${i++}`
    if (m[1] !== undefined) out.push(<strong key={key} className="text-foreground">{m[1]}</strong>)
    else if (m[2] !== undefined) out.push(<code key={key} className="rounded bg-[var(--surface-3)] px-1 py-0.5 text-[10px]">{m[2]}</code>)
    else out.push(m[3])
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export function ReleaseNotes({ notes, className }: { notes: string; className?: string }) {
  if (!notes?.trim()) return null
  const items: ReactNode[] = []
  let key = 0
  for (const raw of notes.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim()) continue
    if (line.trim().startsWith('<!--')) continue
    if (/^-{3,}$/.test(line.trim())) continue
    const k = `n${key++}`
    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      items.push(
        <div key={k} className="mt-2 first:mt-0 text-[11px] font-semibold text-foreground">
          {renderInline(stripInline(heading[2]), k)}
        </div>,
      )
      continue
    }
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/)
    if (bullet) {
      items.push(
        <div key={k} className="flex gap-1.5 leading-relaxed">
          <span className="text-muted-foreground/60 shrink-0">•</span>
          <span className="min-w-0">{renderInline(bullet[1], k)}</span>
        </div>,
      )
      continue
    }
    items.push(<div key={k} className="leading-relaxed">{renderInline(line.trim(), k)}</div>)
  }
  if (!items.length) return null
  return (
    <div className={className ?? 'max-h-[260px] overflow-y-auto text-[11px] text-muted-foreground space-y-1 pr-1'}>
      {items}
    </div>
  )
}
