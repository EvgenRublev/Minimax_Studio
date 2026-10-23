'use client'

/**
 * MarkdownText — маркдаун-рендер «обычного» текста ассистента (правка 88).
 *
 * Применяется ТОЛЬКО вне fence-карточки-промпта: пояснения до/после
 * ```text … ``` и ответы без промпта вообще. Содержимое fence остаётся
 * моноширинным plain-текстом (карточка с копированием в assistant-view).
 *
 * Инлайн-теги <Picture N>/<Video N>/<Audio N> сохраняются как живые
 * превью-чипы: перед парсингом они подменяются на markdown-изображение
 * с псевдо-URL `tag:Kind-N`, которое перехватывается кастомным
 * компонентом img (urlTransform пропускаем, чтобы псевдо-протокол
 * не вырезался санитайзером react-markdown по умолчанию).
 */
import { memo } from 'react'
import type { Components } from 'react-markdown'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'
import { MentionTagWithPreview } from '@/components/h3/mention-preview'

export type TagPreviewFn = (
  kind: 'image' | 'video',
  index: number,
) => { url?: string; label?: string; path?: string }

const TAG_RE = /<(Picture|Video|Audio) (\d+)>/g

/** Заменить инлайн-теги на markdown-изображения с псевдо-URL tag:Kind-N. */
function substituteTags(text: string): string {
  return text.replace(TAG_RE, (_m, kind: string, n: string) => `![${kind} ${n}](tag:${kind}-${n})`)
}

interface Props {
  text: string
  previewFor: TagPreviewFn
  className?: string
  /**
   * (правка 719) Клик по тегу <Picture N>/<Video N> — полноэкранный
   * просмотр референса (как на вкладке «Генерация»).
   */
  onRefClick?: (kind: 'image' | 'video', index: number) => void
}

function MarkdownTextInner({ text, previewFor, className, onRefClick }: Props) {
  const components: Components = {
    img: ({ alt }) => {
      const m = (alt ?? '').match(/^(Picture|Video|Audio) (\d+)$/)
      if (m) {
        const kindName = m[1]
        const index = parseInt(m[2], 10)
        if (kindName === 'Audio') {
          return (
            <span className="rounded bg-emerald-500/15 text-emerald-300">
              {`<Audio ${index}>`}
            </span>
          )
        }
        const kind = kindName === 'Picture' ? 'image' : 'video'
        const { url, label } = previewFor(kind, index)
        const cls =
          kind === 'video' ? 'bg-cyan-500/15 text-cyan-300' : 'bg-purple-500/15 text-purple-300'
        return (
          <MentionTagWithPreview
            triggerText={`<${kindName} ${index}>`}
            previewUrl={url}
            label={label}
            kind={kind}
            className={cn('rounded', cls)}
            /* (правка 719) Клик по тегу — полноэкранный просмотр рефа. */
            onClick={onRefClick ? () => onRefClick(kind, index) : undefined}
          />
        )
      }
      return <span>{alt}</span>
    },
    p: ({ children }) => <p className="my-1 first:mt-0 last:mb-0">{children}</p>,
    ul: ({ children }) => <ul className="my-1 list-disc pl-5 space-y-0.5">{children}</ul>,
    ol: ({ children }) => <ol className="my-1 list-decimal pl-5 space-y-0.5">{children}</ol>,
    li: ({ children }) => <li className="leading-relaxed">{children}</li>,
    strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
    em: ({ children }) => <em className="italic">{children}</em>,
    h1: ({ children }) => <h1 className="my-2 text-base font-bold first:mt-0">{children}</h1>,
    h2: ({ children }) => <h2 className="my-2 text-sm font-bold first:mt-0">{children}</h2>,
    h3: ({ children }) => <h3 className="my-1.5 text-sm font-bold first:mt-0">{children}</h3>,
    h4: ({ children }) => <h4 className="my-1.5 text-sm font-semibold first:mt-0">{children}</h4>,
    a: ({ children, href }) => (
      <a href={href} target="_blank" rel="noreferrer" className="text-amber-300 underline underline-offset-2 hover:text-amber-200">
        {children}
      </a>
    ),
    blockquote: ({ children }) => (
      <blockquote className="my-1.5 border-l-2 border-border pl-3 text-muted-foreground">{children}</blockquote>
    ),
    hr: () => <hr className="my-2 border-border/60" />,
    // Инлайн-код и код-блоки вне fence-карточки (маленькие цитаты в Q&A).
    code: ({ className: cls, children }) => {
      const isBlock = /language-/.test(cls ?? '') || String(children).includes('\n')
      if (isBlock) {
        return (
          <code className={cn('block font-mono text-xs whitespace-pre-wrap break-words', cls)}>
            {children}
          </code>
        )
      }
      return (
        <code className="rounded bg-[var(--surface-3)] px-1 py-0.5 font-mono text-xs text-foreground/90">
          {children}
        </code>
      )
    },
    pre: ({ children }) => (
      <pre className="my-1.5 overflow-x-auto rounded-lg border border-border/60 bg-[var(--surface-3)] p-2.5 text-foreground/90">
        {children}
      </pre>
    ),
    table: ({ children }) => (
      <div className="my-1.5 overflow-x-auto">
        <table className="w-full text-xs border-collapse">{children}</table>
      </div>
    ),
    th: ({ children }) => (
      <th className="border border-border/60 bg-[var(--surface-3)] px-2 py-1 text-left font-semibold">{children}</th>
    ),
    td: ({ children }) => <td className="border border-border/60 px-2 py-1">{children}</td>,
  }

  // Пропускаем URL только по белому списку протоколов: раньше пропускалось
  // ВСЁ (ради псевдо-протокола tag:), и модельный вывод мог подсунуть
  // кликабельную ссылку javascript:/data: — react-markdown по умолчанию
  // такие вырезает, но полный passthrough это отключал.
  const urlWhitelist = (url: string) => {
    const u = url.trim().toLowerCase()
    const safe = ['tag:', 'http:', 'https:', 'mailto:', '#', '/']
    const unsafe = ['javascript:', 'data:', 'vbscript:', 'file:']
    if (unsafe.some((p) => u.startsWith(p))) return ''
    if (safe.some((p) => u.startsWith(p))) return url
    // относительный URL без схемы — безопасен
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url.trim())) return url
    return ''
  }

  return (
    <div className={cn('text-sm leading-relaxed text-foreground/85', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={components}
        urlTransform={urlWhitelist}
      >
        {substituteTags(text)}
      </ReactMarkdown>
    </div>
  )
}

export const MarkdownText = memo(MarkdownTextInner)
