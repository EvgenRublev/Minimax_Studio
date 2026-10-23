'use client'

/**
 * Hover preview for reference mentions (<Picture N>, <Video N>).
 *
 * A small, dependency-free floating preview that appears next to the
 * hovered reference tag. For images it shows the image; for videos it shows
 * the poster frame (via the /api/comfy/file thumbnail endpoint). Audio refs
 * are intentionally excluded (no meaningful visual preview).
 *
 * The preview is rendered as a fixed-positioned portal so it can float above
 * any stacking context (textarea backdrop, dialog, chat bubble).
 *
 * Usage:
 *   <MentionPreview
 *     triggerText="<Picture 1>"
 *     previewUrl="https://.../thumb.jpg"
 *     label="girl.png"
 *     kind="image"
 *     anchorRef={someSpanRef}
 *   />
 *
 * Or use the <MentionTagWithPreview> wrapper, which handles all of this
 * for a single tag:
 *   <MentionTagWithPreview
 *     triggerText="<Picture 1>"
 *     previewUrl="..."
 *     label="girl.png"
 *     kind="image"
 *   />
 */
import {
  useState,
  useRef,
  useEffect,
  useCallback,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'

const PREVIEW_WIDTH = 220
const PREVIEW_HEIGHT = 130
const GAP = 8
const MARGIN = 8

/** Compute the preview's fixed viewport coordinates from an anchor element. */
function computePosition(anchor: HTMLElement): { top: number; left: number; flipUp: boolean } {
  const r = anchor.getBoundingClientRect()
  const vw = window.innerWidth
  const vh = window.innerHeight

  // Prefer to the right of the anchor; if no room, to the left.
  let left = r.right + GAP
  if (left + PREVIEW_WIDTH + MARGIN > vw) {
    left = r.left - PREVIEW_WIDTH - GAP
  }
  left = Math.max(MARGIN, Math.min(left, vw - PREVIEW_WIDTH - MARGIN))

  // Prefer below the anchor; if no room, above.
  let top = r.bottom + GAP
  let flipUp = false
  if (top + PREVIEW_HEIGHT + MARGIN > vh) {
    top = r.top - PREVIEW_HEIGHT - GAP
    flipUp = true
  }
  top = Math.max(MARGIN, Math.min(top, vh - PREVIEW_HEIGHT - MARGIN))

  return { top, left, flipUp }
}

/**
 * Renders the floating preview card. Only mounted (via portal) while the
 * parent is hovering, so there is zero cost otherwise.
 */
export function PreviewCard({
  previewUrl,
  label,
  kind,
  position,
  className,
}: {
  previewUrl: string
  label?: string
  kind?: 'image' | 'video'
  position: { top: number; left: number; flipUp: boolean }
  className?: string
}) {
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)

  if (!previewUrl || failed) return null

  return createPortal(
    <div
      className={cn(
        'fixed z-[9999] pointer-events-none',
        'rounded-xl overflow-hidden',
        'bg-[var(--surface-2)] border border-border/80',
        'shadow-2xl shadow-black/50',
        className,
      )}
      style={{ top: position.top, left: position.left, width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT }}
      aria-hidden
    >
      <div className="w-full h-full relative">
        {!loaded && (
          <div className="absolute inset-0 flex items-center justify-center bg-[var(--surface-3)]">
            <div className="w-4 h-4 rounded-full border-2 border-cyan-400/40 border-t-cyan-400 animate-spin" />
          </div>
        )}
        {kind === 'video' ? (
          // Video reference: play it inline (muted, looped) — an <img> can't
          // decode an mp4, which previously made the preview silently vanish.
          <video
            src={previewUrl}
            muted
            autoPlay
            loop
            playsInline
            preload="auto"
            className={cn(
              'w-full h-full object-cover transition-opacity duration-150',
              loaded ? 'opacity-100' : 'opacity-0',
            )}
            onLoadedData={() => setLoaded(true)}
            onError={() => setFailed(true)}
            draggable={false}
          />
        ) : (
          <img
            src={previewUrl}
            alt={label || 'preview'}
            className={cn(
              'w-full h-full object-cover transition-opacity duration-150',
              loaded ? 'opacity-100' : 'opacity-0',
            )}
            onLoad={() => setLoaded(true)}
            onError={() => setFailed(true)}
            draggable={false}
          />
        )}
        {kind === 'video' && loaded && (
          <div className="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded-md bg-black/60 text-white text-[10px] font-medium">
            Видео
          </div>
        )}
        {label && loaded && (
          <div className="absolute bottom-0 left-0 right-0 px-2 py-1 bg-gradient-to-t from-black/70 to-transparent">
            <p className="text-[10px] text-white/90 truncate">{label}</p>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

export interface MentionTagWithPreviewProps {
  triggerText: string
  previewUrl?: string
  label?: string
  kind?: 'image' | 'video'
  /** Class applied to the inline tag span (styling: color, background, etc.). */
  className?: string
  /** Extra classes for the preview card. */
  previewClassName?: string
  /** Render extra children after the tag text inside the span (rarely needed). */
  children?: ReactNode
  /**
   * (правка 719) Клик по тегу — действие (например, открыть референс во
   * весь экран). В textarea-подложке не передаётся: там клик должен
   * редактировать текст.
   */
  onClick?: () => void
}

/**
 * A self-contained reference tag with hover preview.
 *
 * Replaces the plain <span>{'<Picture 1>'}</span> with the same span plus a
 * hover preview. The span keeps EXACTLY the same metrics (no padding/weight
 * change) so it can be dropped into the textarea backdrop without drift.
 */
/** Alias used by the textarea backdrop for clarity. */
export { PreviewCard as MentionPreviewCard }

export function MentionTagWithPreview({
  triggerText,
  previewUrl,
  label,
  kind,
  className,
  previewClassName,
  children,
  onClick,
}: MentionTagWithPreviewProps) {
  const spanRef = useRef<HTMLSpanElement>(null)
  const [hover, setHover] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number; flipUp: boolean } | null>(null)

  // Only show the preview when we actually have a URL and are hovering.
  const active = hover && !!previewUrl

  const handleEnter = useCallback(() => {
    const el = spanRef.current
    if (!el) return
    setPos(computePosition(el))
    setHover(true)
  }, [])

  const handleLeave = useCallback(() => {
    setHover(false)
  }, [])

  // Re-compute position while hovering if the page scrolls/resizes so the
  // preview stays anchored to the tag.
  useEffect(() => {
    if (!active) return
    const el = spanRef.current
    if (!el) return
    const update = () => setPos(computePosition(el))
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [active])

  return (
    <>
      <span
        ref={spanRef}
        className={cn(onClick ? 'cursor-pointer' : 'cursor-default', className)}
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
        onClick={onClick}
      >
        {children ?? triggerText}
      </span>
      {active && pos && (
        <PreviewCard
          previewUrl={previewUrl!}
          label={label}
          kind={kind}
          position={pos}
          className={previewClassName}
        />
      )}
    </>
  )
}

/**
 * Parse a mention tag like "<Picture 1>" into { kind, index } or null.
 * Audio is excluded (no preview).
 */
export function parseMentionTag(
  text: string,
): { kind: 'image' | 'video'; index: number } | null {
  const m = text.match(/^<(Picture|Video) (\d+)>$/)
  if (!m) return null
  const kind = m[1] === 'Picture' ? 'image' : 'video'
  return { kind, index: parseInt(m[2], 10) }
}
