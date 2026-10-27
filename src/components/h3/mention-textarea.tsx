'use client'

import {
  useState,
  useRef,
  useEffect,
  useCallback,
  forwardRef,
  useImperativeHandle,
} from 'react'
import { cn } from '@/lib/utils'
import { FilmIcon, ImageIcon, AudioLinesIcon } from 'lucide-react'
import {
  MentionPreviewCard,
  parseMentionTag,
} from './mention-preview'

export interface MentionItem {
  id: string
  label: string
  trigger: string
  kind: string
  color?: string
  /** Optional thumbnail URL (reference preview) shown in the popup. */
  previewUrl?: string
}

/** Imperative API exposed via ref (used by the fullscreen editor panel). */
export interface MentionTextareaHandle {
  /** Insert text at the current caret position (or at the end). */
  insertAtCursor: (text: string) => void
  /** Wrap the current selection with open/close snippets (e.g. <d>…</d>). */
  wrapSelection: (open: string, close: string) => void
  focus: () => void
}

interface MentionTextareaProps {
  value: string
  onChange: (value: string) => void
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  placeholder?: string
  className?: string
  mentions?: MentionItem[]
}

/* ──────────────────── Tag highlighting ──────────────────── */

/**
 * Renders the prompt with colored reference/dialogue tags — the SAME colors
 * the Learn guide and MetaDialog use:
 *   <Picture N> purple · <Video N> cyan · <Audio N> emerald · <d>…</d> amber.
 * Plus structural tags the LLM emits in structured prompts:
 *   <Subject N> rose · <Scene N> / <Location N> sky.
 * Unbalanced <d>/</d> are highlighted too (50% amber) as a live hint.
 */
export function renderHighlightedPrompt(text: string): React.ReactNode[] {
  const parts = text.split(/(<(?:Picture|Video|Audio) \d+>|<Subject \d+>|<Scene \d+>|<Location \d+>|<d>[\s\S]*?<\/d>|<d>|<\/d>)/g)
  return parts.map((p, i) => {
    if (!p) return null
    if (/^<(?:Picture|Video|Audio) \d+>$/.test(p)) {
      const cls = p.startsWith('<Video')
        ? 'bg-cyan-500/25 text-cyan-200'
        : p.startsWith('<Audio')
          ? 'bg-emerald-500/25 text-emerald-200'
          : 'bg-purple-500/25 text-purple-200'
      // data-mention lets the hover-preview logic find this tag by index.
      // Picture/Video carry a numeric index; Audio is excluded (no preview).
      const idxMatch = p.match(/^<(Picture|Video) (\d+)>$/)
      const dataAttr = idxMatch
        ? { 'data-mention': idxMatch[1] === 'Picture' ? `image-${idxMatch[2]}` : `video-${idxMatch[2]}` }
        : undefined
      // NOTE: no padding / weight here — the span must have EXACTLY the
      // same metrics as the plain text in the textarea, otherwise the
      // visible highlight drifts away from the real caret/selection.
      return (
        <span key={i} className={cn('rounded', cls)} {...dataAttr}>
          {p}
        </span>
      )
    }
    if (/^<Subject \d+>$/.test(p)) {
      return (
        <span key={i} className="rounded bg-pink-500/25 text-pink-200">
          {p}
        </span>
      )
    }
    if (/^<(?:Scene|Location) \d+>$/.test(p)) {
      return (
        <span key={i} className="rounded bg-sky-500/25 text-sky-200">
          {p}
        </span>
      )
    }
    if (/^<d>[\s\S]*<\/d>$/.test(p)) {
      return (
        <span key={i} className="rounded bg-amber-500/25 text-amber-200">
          {p}
        </span>
      )
    }
    if (p === '<d>' || p === '</d>') {
      return (
        <span key={i} className="rounded bg-amber-500/20 text-amber-300/60">
          {p}
        </span>
      )
    }
    return <span key={i}>{p}</span>
  })
}

/**
 * Measure the caret coordinates inside a textarea using the classic
 * mirror-div technique: an off-screen div with identical typography
 * renders the text before the caret; a marker span at the end gives
 * the caret's (top, left) relative to the textarea's border box.
 */
function getCaretPosition(el: HTMLTextAreaElement): { top: number; left: number; lineHeight: number } {
  const styles = window.getComputedStyle(el)
  const mirror = document.createElement('div')

  const props = [
    'boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight',
    'textTransform', 'textIndent', 'wordSpacing', 'tabSize',
  ] as const
  for (const p of props) {
    ;(mirror.style as unknown as Record<string, string>)[p] = (
      styles as unknown as Record<string, string>
    )[p]
  }
  mirror.style.position = 'absolute'
  mirror.style.visibility = 'hidden'
  mirror.style.whiteSpace = 'pre-wrap'
  mirror.style.wordWrap = 'break-word'
  mirror.style.overflowWrap = 'break-word'
  document.body.appendChild(mirror)

  const pos = el.selectionStart ?? 0
  mirror.textContent = el.value.slice(0, pos)
  const marker = document.createElement('span')
  marker.textContent = el.value.slice(pos, pos + 1) || '.'
  mirror.appendChild(marker)

  const top = marker.offsetTop - el.scrollTop
  const left = marker.offsetLeft - el.scrollLeft
  const lineHeight = parseFloat(styles.lineHeight) || parseFloat(styles.fontSize) * 1.4 || 20
  document.body.removeChild(mirror)
  return { top, left, lineHeight }
}

/** Fixed popup width (w-72) used for clamping against the right edge. */
const POPUP_WIDTH = 288

/**
 * Typography shared by the textarea AND its highlight backdrop.
 *
 * IMPORTANT: the backdrop is a <pre> element, which inherits the browser
 * UA rule `font-family: monospace`. If the font/line-height were left to
 * inheritance, the two layers would have different character widths and the
 * transparent textarea's caret/selection would drift away from the visible
 * backdrop text (click here → delete there). So the font and line-height
 * are set explicitly on BOTH layers — identical to the fullscreen editor.
 * (правка 443) Шрифт — общий UI sans (font-sans), не mono: промпт — это
 * текст, а не код; моноширинный ввод выглядел инородно на фоне всего
 * приложения. Синхронность слоёв сохраняется — font-sans задан на ОБОИХ.
 *
 * Likewise, renderHighlightedPrompt() below must NOT add any padding,
 * width, or weight that the textarea text doesn't have — any metric
 * difference desynchronizes click/selection from the visible text.
 */
const TEXT_CLASSES =
  'w-full rounded-md border border-border bg-[var(--surface-2)] px-3 py-2 text-sm font-sans leading-relaxed text-foreground placeholder:text-muted-foreground/50 min-h-[200px] resize-none'

/**
 * Textarea with "@" mention autocomplete and live tag highlighting.
 *
 * Highlighting uses the classic overlay technique: a transparent-text
 * <textarea> sits on top of a <pre> that renders the same text with
 * colored <Picture N>/<Video N>/<Audio N>/<d>…</d> tags. The backdrop
 * scrolls in sync with the textarea.
 *
 * When the user types "@", a popup appears next to the caret (floating
 * above the content) with the list of attached references — titled by
 * their prompt tags (Picture 1, Video 2, …) rather than file names.
 * Typing more characters after "@" filters the list (by tag or file name).
 * Arrow keys navigate, Enter selects, Escape closes.
 */
export const MentionTextarea = forwardRef<MentionTextareaHandle, MentionTextareaProps>(
  function MentionTextarea(
    { value, onChange, onKeyDown, placeholder, className, mentions = [] },
    ref,
  ) {
    const [showPopup, setShowPopup] = useState(false)
    const [filter, setFilter] = useState('')
    const [selectedIndex, setSelectedIndex] = useState(0)
    const [atPosition, setAtPosition] = useState(-1) // char index where "@" was typed
    const [caretPos, setCaretPos] = useState<{ top: number; left: number } | null>(null)
    const textareaRef = useRef<HTMLTextAreaElement>(null)
    const backdropRef = useRef<HTMLPreElement>(null)
    const popupRef = useRef<HTMLDivElement>(null)

    // ── Hover preview state ──
    // The backdrop spans are pointer-events-none and the textarea sits on top
    // with transparent text, so hover is detected via mousemove on the
    // textarea: we hit-test the cursor against each [data-mention] span in
    // the backdrop and show a preview for the matching reference.
    const [hoverTag, setHoverTag] = useState<{ kind: 'image' | 'video'; index: number; anchor: HTMLElement } | null>(null)
    const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

    const findMentionAtPoint = useCallback(
      (clientX: number, clientY: number): { kind: 'image' | 'video'; index: number; anchor: HTMLElement } | null => {
        const backdrop = backdropRef.current
        if (!backdrop) return null
        const spans = backdrop.querySelectorAll<HTMLElement>('[data-mention]')
        for (const span of Array.from(spans)) {
          const r = span.getBoundingClientRect()
          if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
            const dm = span.dataset.mention
            if (!dm) continue
            const m = dm.match(/^(image|video)-(\d+)$/)
            if (m) {
              return { kind: m[1] as 'image' | 'video', index: parseInt(m[2], 10), anchor: span }
            }
          }
        }
        return null
      },
      [],
    )

    const handleMouseMove = useCallback(
      (e: React.MouseEvent<HTMLTextAreaElement>) => {
        const hit = findMentionAtPoint(e.clientX, e.clientY)
        if (hit) {
          if (hoverTimer.current) {
            clearTimeout(hoverTimer.current)
            hoverTimer.current = null
          }
          setHoverTag(hit)
        } else if (hoverTag) {
          // Small delay so moving within the tag area (and the preview) doesn't flicker.
          if (!hoverTimer.current) {
            hoverTimer.current = setTimeout(() => setHoverTag(null), 120)
          }
        }
      },
      [findMentionAtPoint, hoverTag],
    )

    const handleMouseLeave = useCallback(() => {
      if (hoverTimer.current) {
        clearTimeout(hoverTimer.current)
        hoverTimer.current = null
      }
      setHoverTag(null)
    }, [])

    // Imperative insert API for external panels (fullscreen editor)
    useImperativeHandle(
      ref,
      () => ({
        insertAtCursor: (text: string) => {
          const el = textareaRef.current
          if (!el) {
            onChange(value + (value.endsWith(' ') || value === '' ? '' : ' ') + text)
            return
          }
          const pos = el.selectionStart ?? value.length
          const before = value.slice(0, pos)
          const after = value.slice(pos)
          const pad = before !== '' && !before.endsWith(' ') && !before.endsWith('\n') ? ' ' : ''
          const newValue = before + pad + text + after
          onChange(newValue)
          requestAnimationFrame(() => {
            el.focus()
            const p = (before + pad + text).length
            el.setSelectionRange(p, p)
          })
        },
        wrapSelection: (open: string, close: string) => {
          const el = textareaRef.current
          if (!el) {
            onChange(value + (value ? ' ' : '') + open + 'речь героя' + close)
            return
          }
          const start = el.selectionStart ?? value.length
          const end = el.selectionEnd ?? start
          const selected = value.slice(start, end)
          const inner = selected || 'речь героя'
          const newValue = value.slice(0, start) + open + inner + close + value.slice(end)
          onChange(newValue)
          requestAnimationFrame(() => {
            el.focus()
            const s = start + open.length
            el.setSelectionRange(s, s + inner.length)
          })
        },
        focus: () => textareaRef.current?.focus(),
      }),
      [onChange, value],
    )

    // Keep the highlight backdrop scrolled together with the textarea
    const syncScroll = useCallback(() => {
      const pre = backdropRef.current
      const el = textareaRef.current
      if (pre && el) {
        pre.scrollTop = el.scrollTop
        pre.scrollLeft = el.scrollLeft
      }
    }, [])

    // Filtered mentions based on current filter text (tag or file name)
    const filteredMentions = mentions.filter(
      (m) =>
        m.trigger.toLowerCase().includes(filter.toLowerCase()) ||
        m.label.toLowerCase().includes(filter.toLowerCase()),
    )

    // Reset popup state when it closes
    useEffect(() => {
      if (!showPopup) {
        setFilter('')
        setSelectedIndex(0)
      }
    }, [showPopup])

    // Click outside to close
    useEffect(() => {
      const handleClick = (e: MouseEvent) => {
        if (
          popupRef.current &&
          !popupRef.current.contains(e.target as Node) &&
          textareaRef.current &&
          !textareaRef.current.contains(e.target as Node)
        ) {
          setShowPopup(false)
        }
      }
      document.addEventListener('mousedown', handleClick)
      return () => document.removeEventListener('mousedown', handleClick)
    }, [])

    // Reset filter when popup opens
    useEffect(() => {
      if (showPopup) {
        setSelectedIndex(0)
      }
    }, [showPopup])

    // Фильтр сузил список — выбранный индекс мог выйти за его пределы:
    // без клампа Enter/Tab брали undefined → краш всего приложения
    useEffect(() => {
      setSelectedIndex((i) => Math.min(i, Math.max(0, filteredMentions.length - 1)))
    }, [filteredMentions.length])

    /**
     * Position the popup at the caret: below the caret line, flipping above
     * when there is not enough room, clamped to the textarea's width.
     */
    const updateCaretCoords = useCallback((itemCount: number) => {
      const el = textareaRef.current
      if (!el) return
      const { top, left, lineHeight } = getCaretPosition(el)
      // Header (~26px) + rows (~40px, two-line) + padding
      const estHeight = Math.min(26 + itemCount * 40 + 8, 234)
      let y = top + lineHeight + 4
      if (y + estHeight > el.clientHeight) {
        y = Math.max(2, top - estHeight - 6)
      }
      const x = Math.min(Math.max(4, left), Math.max(4, el.clientWidth - POPUP_WIDTH - 8))
      setCaretPos({ top: y, left: x })
    }, [])

    const handleInsert = useCallback(
      (mention: MentionItem) => {
        const cursorPos = textareaRef.current?.selectionStart ?? value.length
        const before = value.slice(0, atPosition)
        const after = value.slice(cursorPos)
        const newValue = before + mention.trigger + ' ' + after
        onChange(newValue)
        setShowPopup(false)
        // Focus back and set cursor after inserted text
        requestAnimationFrame(() => {
          const el = textareaRef.current
          if (el) {
            el.focus()
            const pos = before.length + mention.trigger.length + 1
            el.setSelectionRange(pos, pos)
          }
        })
      },
      [value, atPosition, onChange],
    )

    /**
     * Re-evaluate the mention state from the current DOM caret position —
     * used on typing, caret moves (arrows) and clicks so the popup always
     * anchors to where the user actually is.
     */
    const evaluateAtCaret = useCallback(() => {
      const el = textareaRef.current
      if (!el || mentions.length === 0) return
      const cursorPos = el.selectionStart ?? el.value.length

      // Find the "@" before cursor that starts the current mention
      const textBeforeCursor = el.value.slice(0, cursorPos)
      const lastAt = textBeforeCursor.lastIndexOf('@')

      if (lastAt === -1) {
        // No "@" found before cursor — close popup
        setShowPopup(false)
        return
      }
      // Check if there's a space or newline between "@" and cursor (mention ended)
      const textAfterAt = textBeforeCursor.slice(lastAt + 1)
      if (textAfterAt.includes(' ') || textAfterAt.includes('\n') || textAfterAt.length > 30) {
        // Mention was completed or invalid — close popup
        setShowPopup(false)
        return
      }
      // Active mention — show popup at the caret and set filter
      setShowPopup(true)
      setFilter(textAfterAt)
      setAtPosition(lastAt)
      updateCaretCoords(mentions.length)
    }, [mentions.length, updateCaretCoords])

    const handleChange = useCallback(
      (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        onChange(e.target.value)
        evaluateAtCaret()
      },
      [onChange, evaluateAtCaret],
    )

    const handleKeyDownLocal = useCallback(
      (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (showPopup && filteredMentions.length > 0) {
          switch (e.key) {
            case 'ArrowDown':
              e.preventDefault()
              setSelectedIndex((prev) => (prev + 1) % filteredMentions.length)
              return
            case 'ArrowUp':
              e.preventDefault()
              setSelectedIndex((prev) => (prev - 1 + filteredMentions.length) % filteredMentions.length)
              return
            case 'Enter':
              // Ctrl/Cmd+Enter (генерация/сохранение) не перехватываем —
              // иначе попап @ блокировал горячую клавишу родителя
              if (e.ctrlKey || e.metaKey || e.altKey) break
              e.preventDefault()
              {
                const m = filteredMentions[selectedIndex]
                if (m) handleInsert(m)
              }
              return
            case 'Escape':
              e.preventDefault()
              setShowPopup(false)
              return
            case 'Tab':
              e.preventDefault()
              {
                const m = filteredMentions[selectedIndex]
                if (m) handleInsert(m)
              }
              return
          }
        }
        // Pass through to parent handler
        onKeyDown?.(e)
      },
      [showPopup, filteredMentions, selectedIndex, handleInsert, onKeyDown],
    )

    /* ── Custom bottom-edge resize ── */
    const [height, setHeight] = useState<number | null>(null) // null = auto
    const [isResizing, setIsResizing] = useState(false)
    const [isHovering, setIsHovering] = useState(false)
    const dragState = useRef<{ startY: number; startH: number } | null>(null)
    const MIN_H = 150
    /**
     * Макс. высота (правка 51) — 15 строк текста:
     * text-sm (14px) × leading-relaxed (1.625) = 22.75px/строка,
     * + py-2 (16px) + border (2px). Выше — внутренний скролл-бар.
     */
    const MAX_H = Math.ceil(15 * 22.75) + 18 // = 360px
    const isFullHeight = className?.includes('h-full')

    /* ── Auto-grow ──
     * In auto mode (no manual resize yet) the textarea grows with its
     * content up to MAX_H, then scrolls internally. Measured from the real
     * scrollHeight so the highlight backdrop (same height) stays in sync. */
    const [autoH, setAutoH] = useState<number | null>(null)
    useEffect(() => {
      if (height !== null || isFullHeight) return
      const el = textareaRef.current
      if (!el) return
      const prev = el.style.height
      el.style.height = 'auto'
      const h = Math.min(Math.max(el.scrollHeight + 2, 150), MAX_H)
      el.style.height = prev
      setAutoH(h)
    }, [value, height, isFullHeight])

    const effectiveH = isFullHeight ? null : (height ?? autoH)

    const handleResizeStart = useCallback((e: React.PointerEvent) => {
      e.preventDefault()
      const el = textareaRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      dragState.current = { startY: e.clientY, startH: rect.height }
      setIsResizing(true)

      const onMove = (ev: PointerEvent) => {
        const ds = dragState.current
        if (!ds) return
        const newH = Math.max(MIN_H, Math.min(MAX_H, ds.startH + (ev.clientY - ds.startY)))
        setHeight(newH)
      }
      const onUp = () => {
        dragState.current = null
        setIsResizing(false)
        document.removeEventListener('pointermove', onMove)
        document.removeEventListener('pointerup', onUp)
      }
      document.addEventListener('pointermove', onMove)
      document.addEventListener('pointerup', onUp)
    }, [])

    return (
      <div className={cn('relative w-full', isFullHeight && 'h-full')}>
        {/* Highlight backdrop — same typography, renders colored tags.
            Sits UNDER the transparent-text textarea and scrolls with it. */}
        <pre
          aria-hidden
          ref={backdropRef}
          className={cn(
            TEXT_CLASSES,
            'absolute inset-0 m-0 overflow-hidden pointer-events-none whitespace-pre-wrap break-words border-border',
            isFullHeight && 'h-full',
            className,
          )}
          style={
            effectiveH
              ? {
                  height: effectiveH,
                  // (правка 92) Раньше: auto только при effectiveH >= MAX_H —
                  // после РУЧНОГО сжатия поля ниже MAX_H текст не помещался,
                  // а overflow:hidden его обрезал без скролл-бара. Теперь:
                  // 'auto' всегда — браузер сам показывает бар только когда
                  // контент реально переполняет поле.
                  overflowY: 'auto',
                  overflowX: 'hidden',
                }
              : undefined
          }
        >
          {renderHighlightedPrompt(value)}
          {'\n'}
        </pre>

        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDownLocal}
          onKeyUp={(e) => {
            // Caret moved with arrows / Home / End — keep the popup anchored
            if (!e.ctrlKey && !e.metaKey && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
              evaluateAtCaret()
            }
          }}
          onClick={evaluateAtCaret}
          onScroll={syncScroll}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          placeholder={placeholder}
          className={cn(
            TEXT_CLASSES,
            'relative bg-transparent text-transparent caret-cyan-300 focus:outline-none focus:ring-1 focus:ring-cyan-500/50',
            className,
          )}
          rows={6}
          style={effectiveH ? { height: effectiveH, overflowY: 'auto', overflowX: 'hidden' } : undefined}
        />

        {/* Hover preview for a reference tag (<Picture N>/<Video N>).
            Rendered via portal (document.body) so it floats above the
            textarea and any enclosing dialog. Audio refs are excluded. */}
        {hoverTag && (() => {
          const mention = mentions.find((m) => {
            const parsed = parseMentionTag(m.trigger)
            return parsed && parsed.kind === hoverTag.kind && parsed.index === hoverTag.index
          })
          if (!mention?.previewUrl) return null
          const position = (() => {
            const el = hoverTag.anchor
            if (!el) return null
            const r = el.getBoundingClientRect()
            const vw = window.innerWidth
            const PREVIEW_W = 220
            const PREVIEW_H = 130
            const GAP = 8
            const MARGIN = 8
            let left = r.right + GAP
            if (left + PREVIEW_W + MARGIN > vw) left = r.left - PREVIEW_W - GAP
            left = Math.max(MARGIN, Math.min(left, vw - PREVIEW_W - MARGIN))
            let top = r.bottom + GAP
            let flipUp = false
            if (top + PREVIEW_H + MARGIN > window.innerHeight) {
              top = r.top - PREVIEW_H - GAP
              flipUp = true
            }
            top = Math.max(MARGIN, Math.min(top, window.innerHeight - PREVIEW_H - MARGIN))
            return { top, left, flipUp }
          })()
          if (!position) return null
          return (
            <MentionPreviewCard
              previewUrl={mention.previewUrl}
              label={mention.label}
              kind={hoverTag.kind}
              position={position}
            />
          )
        })()}

        {/* Bottom resize handle — hidden in full-height mode */}
        {!isFullHeight && (
          <div
            onPointerDown={handleResizeStart}
            onMouseEnter={() => setIsHovering(true)}
            onMouseLeave={() => setIsHovering(false)}
            className={cn(
              'absolute bottom-0 left-2 right-2 h-2 -mb-1 cursor-row-resize flex items-center justify-center z-10 rounded-b-md transition-colors',
              isResizing
                ? 'bg-cyan-500/40'
                : isHovering
                  ? 'bg-cyan-500/25'
                  : 'bg-transparent',
            )}
          >
            <div
              className={cn(
                'w-10 h-0.5 rounded-full transition-colors',
                isResizing ? 'bg-cyan-400' : isHovering ? 'bg-cyan-400/60' : 'bg-transparent',
              )}
            />
          </div>
        )}

        {/* Mention popup — anchored to the caret, floats above the content */}
        {showPopup && filteredMentions.length > 0 && caretPos && (
          <div
            ref={popupRef}
            style={{ top: caretPos.top, left: caretPos.left, width: POPUP_WIDTH }}
            className="absolute z-50 rounded-lg border border-border bg-[var(--surface-3)] shadow-2xl shadow-black/60 overflow-hidden"
          >
            <div className="px-2.5 py-1.5 text-[10px] text-muted-foreground/70 border-b border-border/50">
              Выберите референс
            </div>
            <div className="max-h-48 overflow-y-auto py-1">
              {filteredMentions.map((m, i) => {
                const title = m.trigger.replace(/[<>]/g, '')
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => handleInsert(m)}
                    onMouseEnter={() => setSelectedIndex(i)}
                    className={cn(
                      'w-full flex items-center gap-2.5 px-2.5 py-1.5 text-left transition-colors',
                      i === selectedIndex
                        ? 'bg-cyan-500/15'
                        : 'hover:bg-white/5',
                    )}
                  >
                    {/* (правка 735) Миниатюра-картинка только для изображений:
                        previewUrl у видео/аудио — это blob самого файла (mp4/mp3),
                        <img> его не декодирует и в списке оставался пустой
                        квадрат. Звук и видео показываем значком. */}
                    {m.kind === 'image' && m.previewUrl ? (
                      <img
                        src={m.previewUrl}
                        alt=""
                        className="w-5 h-5 shrink-0 rounded object-cover border border-border"
                      />
                    ) : (
                      <span
                        className={cn(
                          'inline-flex items-center justify-center w-5 h-5 shrink-0 rounded',
                          m.color || 'bg-purple-500/15 text-purple-400',
                        )}
                      >
                        {m.kind === 'image' ? (
                          <ImageIcon className="w-3 h-3" />
                        ) : m.kind === 'video' ? (
                          <FilmIcon className="w-3 h-3" />
                        ) : (
                          <AudioLinesIcon className="w-3 h-3" />
                        )}
                      </span>
                    )}
                    <span className="flex-1 min-w-0">
                      <span
                        className={cn(
                          'block text-xs font-medium truncate',
                          i === selectedIndex ? 'text-foreground' : 'text-foreground/90',
                        )}
                      >
                        {title}
                      </span>
                      <span className="block text-[10px] text-muted-foreground/70 truncate">
                        {m.label}
                      </span>
                    </span>
                    {i === selectedIndex && (
                      <span className="shrink-0 text-[10px] text-cyan-400/70 font-mono">↵</span>
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        )}
      </div>
    )
  },
)
