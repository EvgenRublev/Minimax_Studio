'use client'

/**
 * AssistantPanel — правая боковая панель ассистента (правка 442).
 *
 * Монтируется на вкладках «Генерация» и «Продление» (режим чатов жёстко
 * привязан к вкладке через проп panelMode у AssistantView). Ширина
 * тянется за левую границу (persist), кнопка в шапке чата сворачивает
 * панель в узкий рейл с вертикальной подписью.
 *
 * В свёрнутом состоянии AssistantView НЕ монтируется: его эффекты
 * (poll /api/llm/status) не работают зря, а стрим и черновик ввода живут
 * вне React (assistant-stream.ts / assistant-draft-store) и переживают
 * сворачивание. «Улучшить промпт» разворачивает панель через стор
 * до монтирования — pendingImprove подхватывается эффектом view.
 */
import { useCallback, useEffect, useState } from 'react'
import { ChevronLeftIcon } from 'lucide-react'
import { useAssistantPanel, ASSISTANT_PANEL_DEFAULT } from '@/lib/assistant-panel-store'
import { AssistantView } from './assistant-view'
import type { AssistantChatMode } from '@/lib/assistant-chats-store'

export function AssistantPanel({ mode }: { mode: AssistantChatMode }) {
  const width = useAssistantPanel((s) => s.width)
  const collapsed = useAssistantPanel((s) => s.collapsed)
  const setWidth = useAssistantPanel((s) => s.setWidth)
  const setCollapsed = useAssistantPanel((s) => s.setCollapsed)

  // Persist-стор (width/collapsed) отличается между SSR и первым клиентским
  // рендером — до монтирования рисуем нейтральную заглушку дефолтной ширины.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  /** Resize за левую границу: ширина = innerWidth − clientX (панель у правого края). */
  const onResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const onMove = (ev: MouseEvent) => setWidth(window.innerWidth - ev.clientX)
      const onUp = () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        document.body.style.userSelect = ''
        document.body.style.cursor = ''
      }
      document.body.style.userSelect = 'none'
      document.body.style.cursor = 'col-resize'
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [setWidth],
  )

  if (!mounted) {
    return (
      <div
        className="shrink-0 border-l border-border bg-[var(--surface-1)]"
        style={{ width: ASSISTANT_PANEL_DEFAULT }}
      />
    )
  }

  if (collapsed) {
    return (
      <div className="w-[46px] shrink-0 border-l border-border bg-[var(--surface-0)] flex flex-col items-center pt-3 gap-3">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          title="Развернуть ассистента"
          className="w-7 h-7 rounded-md flex items-center justify-center text-muted-foreground hover:text-amber-300 hover:bg-[var(--surface-2)] transition-colors"
        >
          <ChevronLeftIcon className="w-4 h-4" />
        </button>
        <span
          className="text-[10px] tracking-[0.12em] uppercase text-muted-foreground/60 select-none"
          style={{ writingMode: 'vertical-rl' }}
        >
          Ассистент
        </span>
      </div>
    )
  }

  return (
    <div
      className="relative shrink-0 border-l border-border bg-[var(--surface-1)] flex flex-col min-h-0"
      style={{ width }}
    >
      {/* Resize-ручка: полоса у левой границы, подсвечивается при hover/drag */}
      <div
        onMouseDown={onResizeStart}
        title="Тяните, чтобы изменить ширину панели"
        className="absolute -left-1 top-0 bottom-0 w-2 cursor-col-resize z-20 group"
      >
        <div className="absolute left-[3px] top-0 bottom-0 w-[2px] rounded-full bg-transparent group-hover:bg-amber-500/50 group-active:bg-amber-500/70 transition-colors" />
      </div>
      <AssistantView panelMode={mode} onCollapse={() => setCollapsed(true)} />
    </div>
  )
}
