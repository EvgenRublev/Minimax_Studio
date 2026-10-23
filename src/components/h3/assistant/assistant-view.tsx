'use client'

/**
 * AssistantView — local LLM chat tab (правка 24; multi-chat in правка 30).
 *
 * Runs Gemma 4 12B (GGUF Q4, multimodal) through the ComfyUI embedded python
 * (llama-cpp-python) — see tools/llm_server.py and src/lib/llm-runner.ts.
 * The system prompt is the MiniMax H3 prompt guide (H3_OFFICIAL_PROMPT_SPEC
 * in src/lib/h3-prompt-spec.ts, sourced from src/lib/prompt-guide.md),
 * enriched with live session context (loaded references with their numbers),
 * so the assistant can emit correct <Picture N> tags automatically — no
 * manual binding (правка 168). The prompt draft is NOT injected into the
 * system prompt: it was the cross-chat topic leak; «Улучшить мой промпт»
 * quotes the draft in the user's message explicitly when wanted.
 *
 * Chats live in the persisted assistant-chats store: multiple named
 * conversations, the active one is restored on mount, and the model
 * "remembers" a chat because its (capped) history is replayed with every
 * request.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import {
  BotIcon,
  SendIcon,
  SquareIcon,
  DownloadIcon,
  ArrowDownToLineIcon,
  SparklesIcon,
  WandSparklesIcon,
  PlusIcon,
  MessageSquareIcon,
  XIcon,
  PencilIcon,
  CopyIcon,
  CheckIcon,
  ChevronRightIcon,
  PaperclipIcon,
  FilmIcon,
  Trash2Icon,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { getClipboardImageFiles, hasClipboardImage } from '@/lib/paste-utils'
import { useGenStore } from '@/lib/gen-store'
import { useAssistantChats, type AssistantChatMessage, type AssistantChatMode } from '@/lib/assistant-chats-store'
import { useControlNetTarget } from '@/lib/controlnet-target-store' // (правка 502)
import {
  useAssistantStream,
  runAssistantCompletion,
  stopAssistantStream,
  stopStreamForChat,
  isStreamActive,
  type LlmStatusResp,
  type ChatAttachment,
} from '@/lib/assistant-stream'
import { uploadChatAttachment } from '@/lib/upload'
import { MentionTagWithPreview } from '@/components/h3/mention-preview'
import { VoiceInputButton } from '@/components/h3/voice-input-button'
// (правка 719) Превью вложения с полноэкранным просмотром — как на «Генерации».
import { RefPreviewThumb } from '@/components/h3/ref-preview-thumb'
import { parseAllFences, parseClipMarker, stripClipMarker, hasH3Field, extractInsertablePrompt } from '@/lib/assistant-fence'
import { MarkdownText } from '@/components/h3/assistant/markdown-text'
// (правка 719) Просмотр референса по клику на тег — как на «Генерации».
import { RefViewerDialog, type RefViewerData } from '@/components/h3/ref-viewer-dialog'
import { useAssistantDraft } from '@/lib/assistant-draft-store'
import { DEFAULT_LLM_MODEL_ID } from '@/components/h3/llm-model-selector' // (правка 268)
import { MODELS } from '@/lib/models-config'

/** Live download state derived from /api/models/status. */
interface DlInfo {
  active: boolean
  received: number
  total: number | null
  speed: number
  error: string | null
}

/**
 * Имя модели ассистента для подписей — из конфига моделей по modelId
 * статуса, с fallback на стандартную Qwen3.5 9B.
 * Своя модель ('llm_custom') — по имени файла из статуса.
 */
function llmDisplayName(modelId?: string | null, modelName?: string | null): string {
  if (modelId === 'llm_custom') return modelName ? `своя: ${modelName}` : 'своя модель (GGUF)'
  if (modelId) {
    const m = MODELS.find((x) => x.id === modelId)
    if (m) return m.label
  }
  return 'Qwen3.5 9B (по умолчанию)'
}

export function AssistantView({
  panelMode,
  onCollapse,
}: {
  /** (правка 442) Панельный режим: режим чатов жёстко привязан к вкладке
   *  ('generate'/'extend'), переключатель режима в списке чатов скрыт,
   *  шапка компактная, список чатов — выдвижной поверх чата. */
  panelMode?: AssistantChatMode
  /** (правка 442) Кнопка сворачивания панели в узкий рейл (в шапке). */
  onCollapse?: () => void
} = {}) {
  const inPanel = panelMode !== undefined
  // (правка 442) Список чатов в панели — выдвижной поверх чата (места мало).
  const [chatListOpen, setChatListOpen] = useState(false)
  /* ── chats (persisted store; hydrated on mount to stay SSR-safe) ── */
  const chats = useAssistantChats((s) => s.chats)
  // (правка 266) Реактивная подписка на pendingImprove: если вкладка уже
  // смонтирована, ни streaming, ни activeId не меняются — без подписки эффект
  // автозапуска не перезапускался и запрос висел бессрочно.
  const pendingImprove = useAssistantChats((s) => s.pendingImprove)
  // (правка 427) Режим-фильтр списка чатов: «Генерация» / «Продление».
  const assistantMode = useAssistantChats((s) => s.assistantMode)
  const [activeId, setActiveId] = useState<string | null>(null)
  // (правка 427) Режим АКТИВНОГО чата: от него зависят превью тегов
  // (<Picture N> → extendImageRefs в extend-чатах, refImages вкладки
  // ControlNet в controlnet-чатах (правка 502)), подписи карточек fence
  // и набор кнопок вставки («В промпт» vs «В клип N»).
  const activeChatMode: AssistantChatMode =
    chats.find((c) => c.id === activeId)?.mode ?? 'generate'
  const isExtendChat = activeChatMode === 'extend'
  // (правка 502)
  const isControlNetChat = activeChatMode === 'controlnet'
  // (правка 540) guide3d убран — перенос движения через вкладку ControlNet

  // (правка 256) Черновик ввода/вложения — в стиле-сторе, а не useState:
  // вкладки размонтируются (AnimatePresence key={activeTab}) и локальный
  // стейт терялся при переключении «Ассистент → Генерация → обратно».
  const input = useAssistantDraft((s) => s.input)
  const setInput = useAssistantDraft((s) => s.setInput)
  const [status, setStatus] = useState<LlmStatusResp | null>(null)
  const [dl, setDl] = useState<DlInfo>({ active: false, received: 0, total: null, speed: 0, error: null })
  // (правка 83) Фактический размер выбранной LLM-модели (из /api/models/status)
  // вместо хардкода «~5.7 ГБ» (у Qwen ~5.7 ГБ, у других квантов — свой размер).
  const [sizeLabel, setSizeLabel] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  // (правка 267) «Прилип к низу»: автопрокрутка только пока пользователь у низа
  // (<80px от дна); прокрутил вверх — стрим его не сбрасывает. См. onScroll
  // контейнера и эффект ниже.
  const stickToBottomRef = useRef(true)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [copiedPrompt, setCopiedPrompt] = useState<string | null>(null)

  /* ── (правка 86) Вложение к сообщению чата (изображение / видео) ── */
  const attachment = useAssistantDraft((s) => s.attachment)
  const setAttachment = useAssistantDraft((s) => s.setAttachment)
  const [attUploading, setAttUploading] = useState(false)
  const attFileRef = useRef<HTMLInputElement>(null)
  /**
   * (правка 717) Флаг «отправка уже идёт». isStreamActive() не помогает в
   * окне загрузки вложения (поток ещё не стартовал), и быстрые кнопки/Enter
   * могли запустить второй send() — сообщение дописывалось дважды, а второй
   * запрос молча отбрасывался по `if (running) return`.
   */
  const sendingRef = useRef(false)

  /* ── In-flight reply (правка 31: движок живёт на уровне модуля) ──
   * Стрим выполняется в src/lib/assistant-stream.ts и переживает
   * размонтирование этой вкладки (AnimatePresence). Здесь только
   * «переподключаемся»: пока ответ идёт в этом чате — рендерим живой
   * хвост; завершённый ответ появляется сам, т.к. сообщения ниже
   * выводятся реактивно из персист-стора чатов. */
  const streamChatId = useAssistantStream((s) => s.chatId)
  const streamText = useAssistantStream((s) => s.text)
  const streaming = streamChatId !== null
  const streamingHere = streamChatId === activeId

  // (правка 719) Просмотр референса по клику на тег <Picture N>/<Video N>
  // в ответе ассистента — как на вкладке «Генерация».
  const [viewingRef, setViewingRef] = useState<RefViewerData | null>(null)

  // Live references (for hover previews on <Picture N>/<Video N> tags).
  const refs = useGenStore((s) => s.video.refs)
  // (правка 587) Подписка на непустоту промпта: ярлык кнопки «Исправить мой
  // промпт / Предложить идеи» раньше читал getState() в рендере — нереактивно,
  // метка оставалась старой до чужого ре-рендера.
  const hasPrompt = useGenStore((s) => s.video.prompt.trim().length > 0)
  // (правка 427) Extend-режим: референсы и клипы вкладки «Продление» —
  // <Picture N> в extend-чатах нумеруются по extendImageRefs, а кнопки
  // «В клип N» — по числу extendClips.
  const extendRefs = useGenStore((s) => s.video.extendImageRefs)
  const extendClipsCount = useGenStore((s) => s.video.extendClips.length)
  // (правка 502) ControlNet-режим: <Picture N> нумеруются по refImages
  // вкладки «ControlNet» (controlnet-target-store).
  const controlnetRefs = useControlNetTarget((s) => s.refImages)

  /** Build a preview URL for a reference by (kind, 1-based index).
   *  (правка 427) В extend-чате <Picture N> — это extendImageRefs вкладки
   *  «Продление», а не refs вкладки «Генерация».
   *  (правка 502) В controlnet-чате — refImages вкладки «ControlNet». */
  const previewFor = useCallback(
    (kind: 'image' | 'video', index: number): { url?: string; label?: string; path?: string } => {
      // (правка 502) ControlNet: только картинки (refImages без поля kind).
      if (isControlNetChat) {
        if (kind !== 'image') return {}
        const r = controlnetRefs[index - 1]
        if (!r) return {}
        const url =
          r.previewUrl ||
          (r.path ? `/api/comfy/file?filename=${encodeURIComponent(r.path)}&type=input` : undefined)
        return { url, label: r.name, path: r.path }
      }
      const source = isExtendChat ? extendRefs : refs
      const list = source.filter((r) => r.kind === kind)
      const r = list[index - 1]
      if (!r) return {}
      const url =
        r.previewUrl ||
        (r.path ? `/api/comfy/file?filename=${encodeURIComponent(r.path)}&type=input` : undefined)
      return { url, label: r.name, path: r.path }
    },
    [refs, extendRefs, controlnetRefs, isExtendChat, isControlNetChat],
  )

  /**
   * (правка 719) Клик по тегу <Picture N>/<Video N> в ответе ассистента —
   * полноэкранный просмотр референса (как на вкладке «Генерация»).
   */
  const openRefByTag = useCallback(
    (kind: 'image' | 'video', index: number) => {
      const info = previewFor(kind, index)
      if (!info.url && !info.path) return
      setViewingRef({
        kind,
        name: info.label || `Референс ${index}`,
        path: info.path ?? '',
        url: info.url,
      })
    },
    [previewFor],
  )

  /** Copy prompt to clipboard with visual feedback. */
  const copyPrompt = useCallback(
    async (prompt: string, id: string) => {
      try {
        await navigator.clipboard.writeText(prompt)
        setCopiedPrompt(id)
        toast.success('Промпт скопирован')
        setTimeout(() => setCopiedPrompt(null), 2000)
      } catch {
        toast.error('Не удалось скопировать')
      }
    },
    [],
  )

  /**
   * Render chat message content with hover previews on <Picture N>/<Video N>
   * tags (audio excluded). Plain text passes through unchanged. The tags are
   * highlighted the same way as the Learn guide (purple/cyan) so the user
   * can still read them as tags, but hovering now shows the asset preview.
   *
   * If the message contains a ```text / ``` code-fence, everything inside
   * the fence is treated as "the prompt" and rendered with a distinct
   * background so the user can visually separate the LLM's explanation
   * from the actual prompt to copy.
   */
  const renderChatContent = useCallback(
    (rawText: string): React.ReactNode => {
      if (!rawText) return null

      // Fence parsing — единый источник истины: src/lib/assistant-fence.ts
      // (правка 34). Fence в ответе ассистента = «промпт»; текст ПЕРЕД ним
      // (preamble) и ПОСЛЕ закрывающего fence (trailing) рендерится обычным
      // приглушённым текстом. parseAllFences также ловит только ОТКРЫВАЮЩИЙ
      // fence во время стрима — карточка появляется сразу и заполняется,
      // вместо того чтобы сырой «```text» мелькнул обычным текстом.
      // (правка 427) parseAllFences возвращает ВСЕ fence сообщения: в
      // extend-чатах модель выдаёт промпт каждого клипа отдельным fence с
      // маркером `clip: N` — карточка рисуется на каждый. Один fence —
      // рендер идентичен старому parseFence.
      const fences = parseAllFences(rawText)
      if (fences.length) {
        return (
          <div className="space-y-3">
            {fences.map((fence, fi) => {
              const fenceStreaming = fence.streaming
              // (правка 427) extend: маркер `clip: N` первой строкой fence —
              // показываем номер в подписи карточки и вырезаем строку из тела
              // (в карточку клипа она не попадёт — stripClipMarker при вставке).
              const clipMarker = isExtendChat ? parseClipMarker(fence.prompt) : null
              const prompt = clipMarker !== null ? stripClipMarker(fence.prompt) : fence.prompt
              // Render preamble (if any) with muted style, then the prompt
              // as plain text — (правка 444) без фиолетовой рамки/фона и без
              // моноширинного шрифта; остаются только кнопка копирования,
              // метка клипа (extend) и курсор стрима.
              // (правка 88) Preamble/trailing и ответы без fence рендерятся как
              // markdown (списки, жирный, заголовки…); текст промпта — обычный,
              // с подсветкой тегов.
              const preambleNodes = fence.preamble ? (
                <MarkdownText text={fence.preamble} previewFor={previewFor} onRefClick={openRefByTag} />
              ) : null
              const trailingNodes = fence.trailing ? (
                <MarkdownText text={fence.trailing} previewFor={previewFor} onRefClick={openRefByTag} />
              ) : null
              return (
                <div key={fi} className="space-y-3">
                  {preambleNodes && (
                    <div className="text-sm leading-relaxed text-foreground/75">
                      {preambleNodes}
                    </div>
                  )}
                  {/* (правка 448) Тонкая разделительная полоска между
                      пояснением ассистента и самим промптом — только когда
                      пояснение есть (иначе линия висела бы в воздухе). */}
                  {preambleNodes && <div className="h-px bg-border/50" />}
                  <div>
                    <div className="flex items-center justify-between gap-2 mb-0.5">
                      <span className="text-[10px] text-muted-foreground/60 flex items-center gap-1.5">
                        {fenceStreaming && (
                          <span className="w-1.5 h-1.5 rounded-full bg-cyan-400/80 animate-pulse" />
                        )}
                        {clipMarker !== null
                          ? `Клип ${clipMarker}`
                          : fenceStreaming ? 'генерируется…' : ''}
                      </span>
                      <button
                        type="button"
                        onClick={() => copyPrompt(prompt, prompt.slice(0, 40))}
                        className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-[var(--surface-2)] transition-colors"
                        title="Скопировать промпт"
                      >
                        {copiedPrompt === prompt.slice(0, 40) ? (
                          <CheckIcon className="w-3 h-3 text-emerald-400" />
                        ) : (
                          <CopyIcon className="w-3 h-3" />
                        )}
                      </button>
                    </div>
                    <div className="leading-relaxed whitespace-pre-wrap break-words text-foreground/95">
                      {renderHighlightedParts(prompt)}
                      {fenceStreaming && (
                        <span className="inline-block w-[7px] h-[14px] align-middle ml-0.5 bg-cyan-400/80 animate-pulse" />
                      )}
                    </div>
                  </div>
                  {trailingNodes && (
                    <div className="text-sm leading-relaxed text-foreground/75">
                      {trailingNodes}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )
      }

      // No fence — render the whole text as markdown.
      return <MarkdownText text={rawText} previewFor={previewFor} onRefClick={openRefByTag} />

      function renderHighlightedParts(text: string): React.ReactNode[] {
        const parts = text.split(/(<(?:Picture|Video|Audio) \d+>|<d>[\s\S]*?<\/d>)/g)
        return parts.map((p, i) => {
          if (!p) return null
          const m = p.match(/^<(Picture|Video) (\d+)>$/)
          if (m) {
            const kind = m[1] === 'Picture' ? 'image' : 'video'
            const index = parseInt(m[2], 10)
            const { url, label } = previewFor(kind, index)
            const cls =
              kind === 'video'
                ? 'bg-cyan-500/15 text-cyan-300'
                : 'bg-purple-500/15 text-purple-300'
            return (
              <MentionTagWithPreview
                key={i}
                triggerText={p}
                previewUrl={url}
                label={label}
                kind={kind}
                className={cn('rounded', cls)}
              />
            )
          }
          if (/^<Audio \d+>$/.test(p)) {
            return (
              <span key={i} className="rounded bg-emerald-500/15 text-emerald-300">
                {p}
              </span>
            )
          }
          if (/^<d>[\s\S]*<\/d>$/.test(p)) {
            return (
              <span key={i} className="rounded bg-amber-500/15 text-amber-300">
                {p}
              </span>
            )
          }
          return <span key={i}>{p}</span>
        })
      }
    },
    [previewFor, copiedPrompt, isExtendChat],
  )

  /** Activate the persisted chat (or create one) on first mount only. */
  useEffect(() => {
    const st = useAssistantChats.getState()
    let id = st.activeChatId && st.chats.some((c) => c.id === st.activeChatId)
      ? st.activeChatId
      : (st.chats[0]?.id ?? null)
    if (!id) id = st.createChat()
    setActiveId(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // (правка 427) Смена режима-фильтра: если открытый чат — чужого режима,
  // АВТОМАТИЧЕСКИ открываем первый чат выбранного режима (или создаём новый,
  // если в режиме пусто). Выбрано вместо заглушки «этот чат из другого
  // режима» с кнопкой: фильтр ощущается фильтром, а не тупиком — лишний
  // клик не требуется ни при переключении, ни при пустом режиме.
  useEffect(() => {
    const st = useAssistantChats.getState()
    const current = st.chats.find((c) => c.id === activeId)
    if (current && current.mode === assistantMode) return
    const first = st.chats.find((c) => c.mode === assistantMode)
    const id = first ? first.id : st.createChat(assistantMode)
    st.setActiveChat(id)
    if (id !== activeId) setActiveId(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assistantMode, activeId, chats])

  // (правка 442) Панельный режим: режим-фильтр жёстко следует за вкладкой —
  // панель на «Генерации» всегда показывает generate-чаты, на «Продлении» —
  // extend-чаты (переключателя режима в панели нет). Эффект выше подхватит
  // смену assistantMode и откроет/создаст чат нужного режима.
  useEffect(() => {
    if (!panelMode) return
    const st = useAssistantChats.getState()
    if (st.assistantMode !== panelMode) st.setAssistantMode(panelMode)
  }, [panelMode, assistantMode])

  /**
   * Auto-run a queued "improve prompt" request (правка 32): the user
   * message is appended to the active chat and the completion starts.
   * Правка 32: смена вкладки/чата больше НЕ обрывает идущий ответ — значит
   * при монтировании стрим может ещё жить. runAssistantCompletion() — no-op
   * при running, и запрос завис бы без ответа; поэтому, пока стрим активен,
   * запрос ЖДЁТ в сторе и стартует сразу после его завершения.
   * (правка 266) Эффект зависит и от pendingImprove: при уже смонтированной
   * вкладке запрос приходит БЕЗ смены streaming/activeId — без подписки на
   * стор эффект не перезапускался и запрос висел бессрочно.
   */
  useEffect(() => {
    if (streaming || !activeId) return
    const pending = useAssistantChats.getState().pendingImprove
    if (!pending) return
    const st = useAssistantChats.getState()
    // (правка 266) Improve выполняется в чате, который создал
    // requestImprovePrompt (его id пронесён в pendingImprove), а не в текущем
    // activeId — иначе запрос попадал в чужой диалог, а созданный чат оставался
    // пустым. Фолбэк на activeId — для персистнутых pending без chatId.
    const id = st.chats.some((c) => c.id === pending.chatId)
      ? pending.chatId
      : st.chats.some((c) => c.id === activeId) ? activeId : st.createChat()
    // (правка 427) Фильтр списка — в режим чата improve-запроса, иначе
    // свежий extend-чат остался бы скрытым фильтром «Генерация» (дублирует
    // setAssistantMode в requestImprovePrompt — для персистнутых pending).
    const targetChat = st.chats.find((c) => c.id === id)
    if (targetChat && targetChat.mode !== st.assistantMode) st.setAssistantMode(targetChat.mode)
    if (id !== activeId) setActiveId(id)
    st.clearImprove()
    const userMsg: AssistantChatMessage = { role: 'user', content: pending.content }
    const history = [...(st.chats.find((c) => c.id === id)?.messages ?? []), userMsg]
    st.appendMessage(id, userMsg)
    runAssistantCompletion(id, history)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming, activeId, pendingImprove])

  const activeChat = chats.find((c) => c.id === activeId) ?? null
  /** Сообщения выведены РЕАКТИВНО из персист-стора: ответ, закоммиченный
   *  движком, пока мы были на другой вкладке, появляется здесь сам. */
  const messages = activeChat?.messages ?? []
  // Стабильные ключи (index сдвигается при обрезке >200 сообщений и
  // ре-анимирует все пузыри); одинаковые сообщения различаем счётчиком.
  const messageKeys = useMemo(() => {
    const seen = new Map<string, number>()
    return messages.map((m) => {
      const base = `${m.role}-${hashStr(m.content)}-${m.attachment?.path ?? ''}`
      const n = seen.get(base) ?? 0
      seen.set(base, n + 1)
      return n === 0 ? base : `${base}-${n}`
    })
  }, [messages])

  /** Идёт генерация видео — отправка сообщений заблокирована (vram-arbiter). */
  const chatBlocked = status?.blockedByGeneration === true

  // Poll LLM status + download progress
  useEffect(() => {
    let cancelled = false
    // Факт использования ассистента в этой сессии: экран генерации
    // опрашивает /api/llm/status (для блокировки кнопки) только если он был
    sessionStorage.setItem('assistantUsed', '1')
    const tick = async () => {
      try {
        const r = await fetch('/api/llm/status', { signal: AbortSignal.timeout(4000) })
        const s = (await r.json()) as LlmStatusResp
        if (!cancelled) setStatus(s)
        if (s.modelReady) {
          if (!cancelled) setDl((d) => (d.active || d.error ? { active: false, received: 0, total: null, speed: 0, error: null } : d))
          return
        }
        const mr = await fetch('/api/models/status', { signal: AbortSignal.timeout(4000) })
        const md = await mr.json()
        const activeId = s.modelId || DEFAULT_LLM_MODEL_ID
        const mine = (md.models ?? []).find((m: { id: string; sizeLabel?: string }) => m.id === activeId)
        if (!cancelled && mine) {
          if (mine.sizeLabel) setSizeLabel(mine.sizeLabel)
          if (mine.status === 'downloading') {
            setDl({
              active: true,
              received: mine.bytesReceived ?? 0,
              total: mine.totalBytes ?? null,
              speed: mine.speed ?? 0,
              error: null,
            })
          } else if (mine.status === 'error') {
            setDl({ active: false, received: 0, total: null, speed: 0, error: mine.error || 'Ошибка загрузки' })
          }
        }
      } catch {
        /* backend not up */
      }
    }
    void tick()
    const id = setInterval(() => void tick(), 2000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  // Autoscroll on new content (use rAF to ensure DOM has updated)
  useEffect(() => {
    const el = scrollRef.current
    // (правка 267) Скроллим только «прилипнув» к низу — иначе каждый токен
    // стрима сбрасывал пользователя, прокрутившего вверх читать историю.
    // rAF отменяем при размонтировании/перезапуске эффекта.
    if (!el || !stickToBottomRef.current) return
    const raf = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight
    })
    return () => cancelAnimationFrame(raf)
  }, [messages, streamText, activeId, status?.modelReady])

  /* ── Авто-растекание textarea (правка 38): до 8 строк, дальше скролл ── */
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    // text-sm = 14px, line-height ≈ 1.5 → ~21px/line; 8 lines = 168px + 20px padding
    el.style.height = Math.min(el.scrollHeight, 188) + 'px'
  }, [input])

  const clickTs = useRef(0)

  const startDownload = useCallback(async () => {
    clickTs.current = Date.now()
    setDl({ active: true, received: 0, total: null, speed: 0, error: null })
    try {
      const modelId = status?.modelId || DEFAULT_LLM_MODEL_ID // (правка 268)
      const r = await fetch('/api/models/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId }),
      })
      const d = await r.json()
      if (!d.ok) {
        setDl({ active: false, received: 0, total: null, speed: 0, error: d.error || 'Не удалось начать загрузку' })
        toast.error(d.error || 'Не удалось начать загрузку')
      } else {
        toast.success('Загрузка модели началась')
      }
    } catch {
      setDl({ active: false, received: 0, total: null, speed: 0, error: 'Ошибка запуска загрузки' })
      toast.error('Ошибка запуска загрузки')
    }
  }, [status?.modelId])

  // (правка 86) Обработка выбора файла для вложения
  const handleAttFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const isVideo = file.type.startsWith('video/')
    const isImage = file.type.startsWith('image/')
    if (!isVideo && !isImage) {
      toast.error('Поддерживаются только изображения и видео')
      return
    }
    // (правка 349) Старое превью отзываем при замене вложения — иначе
    // blob-URL утекает на каждый перевыбор файла.
    const prevAtt = useAssistantDraft.getState().attachment
    if (prevAtt) {
      try { URL.revokeObjectURL(prevAtt.previewUrl) } catch { /* уже отозван */ }
    }
    setAttachment({
      file,
      previewUrl: URL.createObjectURL(file),
      name: file.name,
      kind: isVideo ? 'video' : 'image',
    })
    e.target.value = '' // сброс, чтобы повторный выбор того же файла сработал
  }, [])

  const removeAttachment = useCallback(() => {
    if (attachment) URL.revokeObjectURL(attachment.previewUrl)
    setAttachment(null)
  }, [attachment])

  const send = useCallback(
    async (text?: string) => {
      const content = (text ?? input).trim()
      // chatBlocked: генерация идёт — vram-arbiter всё равно вернёт 409,
      // блокируем заранее (Enter и быстрые кнопки идут в обход disabled)
      if (!content || isStreamActive() || chatBlocked) return
      // (правка 717) Защита от ДВОЙНОЙ отправки. Проверка isStreamActive()
      // не срабатывала в окне загрузки вложения (поток ещё не начался), и
      // быстрые кнопки/Enter могли запустить второй send(): сообщение
      // дописывалось дважды, а второй runAssistantCompletion отваливался по
      // `if (running) return` — без ответа и без ошибки.
      if (sendingRef.current) return
      sendingRef.current = true
      try {
        // (правка 267) Отправка своего сообщения — возвращаемся к низу ленты.
        stickToBottomRef.current = true
        let id = activeId
        if (!id || !useAssistantChats.getState().chats.some((c) => c.id === id)) {
          id = useAssistantChats.getState().createChat()
          setActiveId(id)
        }

        // (правка 87; правка 108) Загружаем вложение ПЕРВЫМ, чтобы сохранить путь
        // в сообщение. (правка 108) Загрузка в ИЗОЛИРОВАННОЕ хранилище
        // data/chat-attachments/ (НЕ в ComfyUI/input/): файл существует только в
        // чате и используется только для LLM-описания — не попадает в референсы
        // генерации, галерею, upscale и «чистку input».
        let attInfo: { path: string; name: string; kind: 'image' | 'video'; src?: 'chat' | 'comfy' } | undefined
        let atts: ChatAttachment[] | undefined
        if (attachment) {
          setAttUploading(true)
          try {
            const { path } = await uploadChatAttachment(attachment.file)
            attInfo = { path, name: attachment.name, kind: attachment.kind, src: 'chat' }
            atts = [{ path, name: attachment.name, kind: attachment.kind }]
          } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Не удалось загрузить файл')
            setAttUploading(false)
            removeAttachment()
            return
          }
          setAttUploading(false)
          removeAttachment()
        }

        setInput('')
        const userMsg: AssistantChatMessage = { role: 'user', content, attachment: attInfo }
        // Persist the user message immediately (с вложением для отображения в чате)
        useAssistantChats.getState().appendMessage(id, userMsg)
        // (правка 265) history — свежий снапшот ПОСЛЕ appendMessage: userMsg в нём
        // уже есть; добавление его в литерал дублировало сообщение в запросе.
        const history = useAssistantChats.getState().chats.find((c) => c.id === id)?.messages ?? []

        runAssistantCompletion(id, history, atts)
      } finally {
        // (правка 717) Флаг снимается в finally — иначе после исключения
        // (например, ошибка загрузки вложения) чат «залипал» бы заблокирован.
        sendingRef.current = false
      }
    },
    [input, activeId, chatBlocked, attachment, removeAttachment],
  )

  const stop = useCallback(() => {
    stopAssistantStream()
  }, [])

  /**
   * Switch to another chat (правка 32: стрим НЕ обрываем).
   * Ответ, который уже летит, продолжает генерироваться в СВОЁМ чате —
   * движок живёт на уровне модуля и переживает смену чата/вкладки.
   * Живой хвост виден только в том чате, где он начался (streamingHere),
   * «Стоп» доступен глобально у поля ввода.
   */
  const switchChat = useCallback(
    (id: string) => {
      useAssistantChats.getState().setActiveChat(id)
      setActiveId(id)
      // (правка 442) В панели список чатов — выдвижной: после выбора закрываем.
      if (inPanel) setChatListOpen(false)
    },
    [inPanel],
  )

  /** Новый чат (правка 32: идущий в другом чате ответ не трогаем). */
  const newChat = useCallback(() => {
    const id = useAssistantChats.getState().createChat()
    setActiveId(id)
    if (inPanel) setChatListOpen(false)
  }, [inPanel])

  const deleteChat = useCallback(
    (id: string) => {
      // Правка 32: если стрим идёт ИМЕННО в удаляемом чате — сначала его
      // останавливаем. Движок докоммитит частичный ответ в finally ПОСЛЕ
      // удаления чата, appendMessage не найдёт чат и молча отбросит —
      // как и надо (мусорный хвост не сохраняется), модель освобождается.
      // Для чужого чата — no-op.
      stopStreamForChat(id)
      const st = useAssistantChats.getState()
      st.deleteChat(id)
      const remaining = useAssistantChats.getState()
      if (id === activeId) {
        const nextId = remaining.activeChatId ?? remaining.createChat()
        setActiveId(nextId)
      }
    },
    [activeId],
  )

  /* ── (правка 264) Переименование чата ──
   * Инлайн-редактор в списке: pencil → input (prefilled текущим названием),
   * Enter/blur/✓ — сохранить, Esc/× — отмена. Двойной клик по имени — то же.
   * renameChat из стора обновляет только title (без updatedAt) — список
   * не пересортировывается, синхронизация (assistant-chats-sync) сама
   * отправит изменённый chats-массив на сервер через debounce-PUT. */
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)

  const startRename = useCallback((id: string, current: string) => {
    setRenamingId(id)
    setRenameValue(current)
    // Фокус + выделение всего после рендера input'а
    requestAnimationFrame(() => {
      renameInputRef.current?.focus()
      renameInputRef.current?.select()
    })
  }, [])

  const commitRename = useCallback(() => {
    if (!renamingId) return
    const v = renameValue.trim()
    if (v) useAssistantChats.getState().renameChat(renamingId, v)
    setRenamingId(null)
    setRenameValue('')
  }, [renamingId, renameValue])

  const cancelRename = useCallback(() => {
    setRenamingId(null)
    setRenameValue('')
  }, [])

  /** Insert an assistant reply into the prompt editor.
   *  Извлечение промпта — единый источник: src/lib/assistant-fence.ts
   *  (правка 34): fence-контент → от маркера H3-поля → последний
   *  содержательный абзац; всегда с обрезкой по закрывающему fence, без
   *  хвоста модели и декоративных кавычек. */
  const insertIntoPrompt = useCallback((content: string) => {
    const clean = extractInsertablePrompt(content)
    if (!clean) return
    useGenStore.getState().setVideoPrompt(clean)
    // (правка 161) Кнопка видна только когда !streaming — стрим завершён.
    // Но серверный assistantBusy может ещё быть true (drain-насос не
    // завершился). GenerateView при монтировании poll'ит /api/llm/status
    // и блокирует «Сгенерировать». Снимаем лок: генерация не мешает
    // LLM (strim уже закончен), реальный gate — 409 от runGeneration.
    void fetch('/api/llm/release', { method: 'POST' }).catch(() => {})
    window.dispatchEvent(new CustomEvent('h3:goto-generate'))
    toast.success('Промпт вставлен в редактор')
  }, [])

  /** (правка 502) Вставка fence-промпта controlnet-чата в поле промпта
   *  вкладки «ControlNet» (controlnet-target-store) + переход на вкладку. */
  const insertIntoControlNetPrompt = useCallback((content: string) => {
    const clean = extractInsertablePrompt(content)
    if (!clean) return
    useControlNetTarget.getState().setPrompt(clean)
    void fetch('/api/llm/release', { method: 'POST' }).catch(() => {})
    window.dispatchEvent(new CustomEvent('h3:goto-controlnet'))
    toast.success('Промпт вставлен во вкладку ControlNet')
  }, [])

  /** (правка 427) Вставка fence-промпта extend-чата в карточку клипа N.
   *  Маркерная строка `clip: N` вырезается (stripClipMarker) — она нужна
   *  только UI для адресации. Копия массива extendClips по индексу — как
   *  редактирование в extend-view; release LLM и переход на вкладку
   *  «Продление» — как у «В промпт» (правка 161). */
  const insertIntoClip = useCallback((fenceContent: string, clipNumber: number) => {
    const clean = stripClipMarker(fenceContent).trim()
    if (!clean) return
    const st = useGenStore.getState()
    const clips = [...st.video.extendClips]
    const idx = clipNumber - 1
    if (idx < 0 || idx >= clips.length) {
      toast.error(`Клипа ${clipNumber} нет — добавьте его на вкладке «Продление»`)
      return
    }
    clips[idx] = { ...clips[idx], prompt: clean }
    st.patchVideo({ extendClips: clips })
    void fetch('/api/llm/release', { method: 'POST' }).catch(() => {})
    window.dispatchEvent(new CustomEvent('h3:goto-extend'))
    toast.success(`Промпт вставлен в клип ${clipNumber}`)
  }, [])

  /** (правка 428) Массовая вставка: ассистент обычно выдаёт промпты ВСЕХ
   *  клипов одним сообщением (несколько fence с маркерами `clip: N`) — тогда
   *  вместо россыпи кнопок «В клип N» показываем ОДНУ «Вставить все (N)».
   *  Все правки применяются к одной копии массива и одним patchVideo. */
  const insertAllIntoClips = useCallback((pairs: Array<{ content: string; clip: number }>) => {
    const st = useGenStore.getState()
    const clips = [...st.video.extendClips]
    let applied = 0
    for (const { content, clip } of pairs) {
      const clean = stripClipMarker(content).trim()
      const idx = clip - 1
      if (!clean || idx < 0 || idx >= clips.length) continue
      clips[idx] = { ...clips[idx], prompt: clean }
      applied++
    }
    if (applied === 0) {
      toast.error('Нечего вставлять — клипы не найдены')
      return
    }
    st.patchVideo({ extendClips: clips })
    void fetch('/api/llm/release', { method: 'POST' }).catch(() => {})
    window.dispatchEvent(new CustomEvent('h3:goto-extend'))
    toast.success(`Промпты вставлены в клипы: ${applied} шт.`)
  }, [])

  /**
   * Does this assistant reply actually contain a structured prompt?
   * The "В промпт" button is rendered ONLY in that case — plain
   * conversational answers (greetings, Q&A, tips) have nothing to insert,
   * and a dead button there only confuses users.
   */
  const hasStructuredPrompt = useCallback((content: string): boolean => {
    if (!content.trim()) return false
    // A ``` code fence (the assistant wraps prompts in one)…
    if (/```/.test(content)) return true
    // …or an official H3 structural field marker.
    return hasH3Field(content)
  }, [])

  const modelReady = status?.modelReady
  const running = status?.running


  // SSR/hydration guard: persisted store (chats) differs between server and
  // first client render. Render a neutral placeholder until mounted.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  if (!mounted) {
    return (
      <div className="flex-1 flex flex-col min-h-0 bg-[var(--surface-1)]">
        <div className={cn('shrink-0', inPanel ? 'px-3 pt-3 pb-2' : 'px-6 pt-5 pb-3')}>
          <h1 className={cn('font-semibold text-foreground flex items-center gap-2.5', inPanel ? 'text-sm' : 'text-xl')}>
            <span className={cn('rounded-xl gradient-creative flex items-center justify-center shrink-0 shadow-lg shadow-amber-500/20', inPanel ? 'w-7 h-7' : 'w-9 h-9')}>
              <BotIcon className={cn('text-white', inPanel ? 'w-3.5 h-3.5' : 'w-4.5 h-4.5')} />
            </span>
            Ассистент
          </h1>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <div className="text-xs text-muted-foreground">Загрузка…</div>
        </div>
      </div>
    )
  }

  return (
    <div
      className="relative flex-1 flex flex-row min-h-0 bg-[var(--surface-1)]"
      onPaste={(e) => {
        // (правка 123) Ctrl+V из буфера обмена — изображение становится
        // вложением чата (то же, что кнопка «скрепка»). Срабатывает при
        // фокусе в любом поле вкладки; text-вставку не трогаем —
        // перехватываем только если в буфере есть картинка.
        // preventDefault синхронно (до await).
        if (!hasClipboardImage(e.clipboardData)) return
        e.preventDefault()
        if (attUploading) {
          toast.error('Дождитесь отправки сообщения — текущее вложение загружается')
          return
        }
        void getClipboardImageFiles(e.clipboardData).then((files) => {
          if (files.length === 0) return
          const file = files[0]
          if (attachment) URL.revokeObjectURL(attachment.previewUrl)
          setAttachment({ file, previewUrl: URL.createObjectURL(file), name: file.name, kind: 'image' })
        })
      }}
    >
      {/* Left: main content */}
      <div className="flex-1 flex flex-col min-h-0 min-w-0">
      {/* Header — (правка 442) в панели компактный: кнопка списка чатов слева,
          кнопка сворачивания панели справа */}
      <div className={cn('shrink-0 aurora-bg', inPanel ? 'px-3 pt-3 pb-2' : 'px-6 pt-5 pb-3')}>
        <div className={cn('flex gap-3', inPanel ? 'items-center' : 'items-end justify-between')}>
          {inPanel && (
            <button
              type="button"
              onClick={() => setChatListOpen((o) => !o)}
              title="Список чатов"
              className={cn(
                'shrink-0 w-8 h-8 rounded-lg border flex items-center justify-center transition-colors',
                chatListOpen
                  ? 'border-amber-500/50 bg-amber-500/15 text-amber-300'
                  : 'border-border bg-[var(--surface-2)] text-muted-foreground hover:text-foreground',
              )}
            >
              <MessageSquareIcon className="w-4 h-4" />
            </button>
          )}
          <div className="min-w-0 flex-1">
            <h1 className={cn('font-semibold text-foreground flex items-center gap-2.5', inPanel ? 'text-sm' : 'text-xl')}>
              <span className={cn('rounded-xl gradient-creative flex items-center justify-center shrink-0 shadow-lg shadow-amber-500/20', inPanel ? 'w-7 h-7' : 'w-9 h-9')}>
                <BotIcon className={cn('text-white', inPanel ? 'w-3.5 h-3.5' : 'w-4.5 h-4.5')} />
              </span>
              Ассистент
            </h1>
            <p className={cn('text-muted-foreground mt-1 truncate', inPanel ? 'text-[10px]' : 'text-xs')}>
              {inPanel
                ? `Локальная LLM: ${llmDisplayName(status?.modelId, status?.modelName)}`
                : `Локальная LLM (${llmDisplayName(status?.modelId, status?.modelName)}) · видит картинки · чаты сохраняются`}
            </p>
          </div>
          {modelReady && (
            <div className="flex items-center gap-2 shrink-0">
              {/* (правка 540) Тогл «3D → Video» убран — перенос движения через вкладку ControlNet */}
              <span
                className={cn(
                  'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] border',
                  running
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                    : 'border-border bg-[var(--surface-2)] text-muted-foreground',
                )}
              >
                <span className={cn('w-1.5 h-1.5 rounded-full', running ? 'bg-emerald-400' : 'bg-muted-foreground/50')} />
                {running ? (status?.gpuMode === 'gpu' ? 'GPU' : 'CPU') : 'спит'}
              </span>
            </div>
          )}
          {inPanel && onCollapse && (
            <button
              type="button"
              onClick={onCollapse}
              title="Свернуть панель"
              className="shrink-0 w-8 h-8 rounded-lg border border-border bg-[var(--surface-2)] flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
            >
              <ChevronRightIcon className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      {!modelReady ? (
        /* ── Model not downloaded yet ── */
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="max-w-md w-full rounded-2xl border border-amber-500/25 bg-amber-500/5 p-6 text-center space-y-4">
            <div className="w-14 h-14 rounded-2xl gradient-creative flex items-center justify-center mx-auto shadow-lg shadow-amber-500/20">
              <BotIcon className="w-7 h-7 text-white" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-foreground">
                {status?.modelId === 'llm_custom' ? 'Файл своей модели не найден' : 'Модель ассистента не скачана'}
              </h3>
              <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
                {status?.modelId === 'llm_custom' ? (
                  <>
                    Проверьте путь к своей модели в <b>Настройках → LLM</b>: файл
                    «{status?.modelName || '—'}» недоступен. Свои модели студия
                    не скачивает — исправьте путь или очистите поле, чтобы
                    вернуться к встроенной модели.
                  </>
                ) : (
                  <>
                    Локальная модель ассистента ({llmDisplayName(status?.modelId, status?.modelName)})
                    — скачивается в <span className="font-mono text-[10px]">ComfyUI/models/llm/</span>. Работает
                    локально, без интернета, прямо на вашем железе.
                  </>
                )}
              </p>
            </div>
            {status?.modelId === 'llm_custom' ? null : dl.error ? (
              <div className="space-y-2">
                <p className="text-xs text-red-400 break-words">Ошибка: {dl.error}</p>
                <Button variant="outline" size="sm" onClick={startDownload} className="gap-1.5">
                  <DownloadIcon className="w-3.5 h-3.5" />
                  Повторить
                </Button>
              </div>
            ) : dl.active ? (
              <div className="space-y-2">
                <div className="h-2 rounded-full bg-[var(--surface-2)] overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-amber-500 to-orange-500 rounded-full transition-all duration-500"
                    style={{
                      width: `${
                        dl.total && dl.total > 0
                          ? Math.min(100, Math.floor((dl.received / dl.total) * 100))
                          : 8
                      }%`,
                    }}
                  />
                </div>
                <p className="text-xs text-muted-foreground font-mono tabular-nums">
                  {dl.received > 0
                    ? `${(dl.received / 1024 / 1024 / 1024).toFixed(2)} / ${sizeLabel || '~5.7 ГБ'}` +
                      (dl.total && dl.total > 0 ? ` · ${Math.floor((dl.received / dl.total) * 100)}%` : '') +
                      (dl.speed > 0 ? ` · ${(dl.speed / 1024 / 1024).toFixed(1)} МБ/с` : '')
                    : 'Подключение к серверу загрузки…'}
                </p>
              </div>
            ) : (
              <Button
                onClick={startDownload}
                className="bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-400 hover:to-orange-500 text-white border-0 font-semibold gap-2"
              >
                <DownloadIcon className="w-4 h-4" />
                Скачать модель ({sizeLabel || '~5.7 ГБ'})
              </Button>
            )}
            <p className="text-[10px] text-muted-foreground/60">
              После загрузки первый запуск занимает 1–2 минуты. Пока идёт генерация видео,
              модель при нехватке VRAM сама стартует в CPU-режиме.
            </p>
          </div>
        </div>
      ) : (
        /* ── Chat ── */
        <>
          <div
            ref={scrollRef}
            // (правка 267) Отслеживаем «прилип к низу» для автопрокрутки
            onScroll={(e) => {
              const el = e.currentTarget
              stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
            }}
            className="flex-1 overflow-y-auto px-6 pb-4 min-h-0"
          >
            {messages.length === 0 && (
              <div className="h-full flex items-center justify-center">
                <div className="max-w-md text-center space-y-3">
                  <SparklesIcon className="w-8 h-8 text-amber-400/60 mx-auto" />
                  <p className="text-sm text-muted-foreground">
                    {/* (правка 427) Приветствие зависит от режима чата. */}
                    {isExtendChat
                      ? 'Опишите, как продолжить видео — ассистент соберёт промпты клипов (каждый отдельным блоком с меткой clip: N) с учётом исходника и референсов продления.'
                      : isControlNetChat
                        ? 'Опишите сцену — ассистент соберёт промпт для ControlNet. Движение и камеру задаёт контрольное видео, в промпте — только сцена, внешность, стиль, свет и звук.'
                        : 'Опишите идею видео по-русски — ассистент соберёт готовый промпт (на английском, с тегами ваших референсов) и запомнит диалог.'}
                  </p>
                </div>
              </div>
            )}
            <div className="space-y-3 max-w-3xl mx-auto">
              {messages.map((m, i) => (
                <motion.div
                  key={messageKeys[i]}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}
                >
                  <div
                    className={cn(
                      // (правка 564) select-text: текст сообщений чата выделяется
                      // (копирование ответов), кнопки внутри исключены в CSS.
                      'select-text max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed break-words',
                      // (правка 88) у ассистента текст рендерится маркдауном —
                      // pre-wrap там не нужен (двойные переносы), у юзера остаётся.
                      m.role === 'user' && 'whitespace-pre-wrap',
                      m.role === 'user'
                        ? 'bg-gradient-to-r from-slate-600/90 to-indigo-600/90 text-white rounded-br-sm'
                        : 'bg-[var(--surface-2)]/60 border border-border/60 text-foreground/95 rounded-bl-sm',
                    )}
                  >
                    {/* (правка 87) Вложение: изображение или видео в пузыре.
                        (правка 108) src='chat' → изолированное хранилище чата
                        (data/chat-attachments/); legacy (без src) → /api/comfy/file. */}
                    {m.attachment && (() => {
                      const attSrc = m.attachment.src === 'chat'
                        ? `/api/assistant/attachment?filename=${encodeURIComponent(m.attachment.path)}`
                        : `/api/comfy/file?filename=${encodeURIComponent(m.attachment.path)}&type=input`
                      return (
                        <div className="mb-2">
                          {/* (правка 719) Клик по вложению — полноэкранный
                              просмотр (как на вкладке «Генерация»). */}
                          <RefPreviewThumb
                            kind={m.attachment.kind}
                            name={m.attachment.name}
                            path={m.attachment.path}
                            url={attSrc}
                            className="block max-w-full"
                            title="Открыть вложение во весь экран"
                          >
                            {m.attachment.kind === 'image' ? (
                              <img
                                src={attSrc}
                                alt={m.attachment.name}
                                className="max-h-48 max-w-full rounded-lg object-contain cursor-zoom-in"
                              />
                            ) : (
                              <video
                                src={attSrc}
                                className="max-h-48 max-w-full rounded-lg"
                                controls
                                preload="metadata"
                                /* (правка 719) Клик по кнопкам плеера не должен
                                   открывать полноэкранный просмотр. */
                                onClick={(e) => e.stopPropagation()}
                              />
                            )}
                          </RefPreviewThumb>
                          <p className="mt-1 text-[10px] opacity-60">{m.attachment.name}</p>
                        </div>
                      )
                    })()}
                    {/* (правка 695) User messages — plain markdown, без fence-парсинга:
                        инструкция «```text fence с clip: N» содержит три backtick-а,
                        и parseAllFences находил их как «открытый fence», добавляя
                        «генерируется…» к сообщению юзера. Fence-карточки нужны
                        только в ответах ассистента. */}
                    {m.role === 'user'
                      ? (<div className="leading-relaxed break-words"><MarkdownText text={m.content} previewFor={previewFor} onRefClick={openRefByTag} /></div>)
                      : (renderChatContent(m.content) || '')}
                    {/* (правка 427) Вставка — по режиму чата: «В промпт»
                        только в чатах «Генерация»; в чатах «Продление» —
                        per-fence «В клип N» (по маркеру `clip: N`, а без
                        маркера — ряд кнопок по числу клипов).
                        (правка 502) В чатах «ControlNet» — «В промпт»
                        вкладки ControlNet. */}
                    {m.role === 'assistant' && !streaming && !isExtendChat && hasStructuredPrompt(m.content) && (
                      <div className="mt-2 pt-2 border-t border-border/60 flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => isControlNetChat ? insertIntoControlNetPrompt(m.content) : insertIntoPrompt(m.content)}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] border border-violet-500/30 bg-violet-500/10 text-violet-300 hover:bg-violet-500/20 transition-colors"
                        >
                          <ArrowDownToLineIcon className="w-3 h-3" />
                          В промпт
                        </button>
                      </div>
                    )}
                    {m.role === 'assistant' && !streaming && isExtendChat && (() => {
                      const msgFences = parseAllFences(m.content)
                      if (!msgFences.length) return null
                      // (правка 428) Fence с валидным маркером `clip: N`
                      // собираем в пары; если их 2+ — ОДНА кнопка «Вставить
                      // все» вместо россыпи «В клип N». Fence без маркера
                      // (или с устаревшим номером) — ряд ручных кнопок.
                      const marked: Array<{ content: string; clip: number }> = []
                      const unmarked: Array<{ content: string; fi: number }> = []
                      msgFences.forEach((f, fi) => {
                        const marker = parseClipMarker(f.prompt)
                        if (marker !== null && marker >= 1 && marker <= extendClipsCount) {
                          marked.push({ content: f.prompt, clip: marker })
                        } else {
                          unmarked.push({ content: f.prompt, fi })
                        }
                      })
                      // (правка 453) Дубли кнопок: модель часто выдаёт 2+
                      // fence БЕЗ маркера `clip: N` — раньше для КАЖДОГО
                      // рисовался идентичный ряд «В клип: [1] [2]…» (какой
                      // ряд к какому промпту — непонятно). Теперь: если все
                      // fence без маркеров и их ≥2 (но не больше, чем клипов)
                      // — сопоставляем ПОЗИЦИОННО (fence i → клип i+1) и
                      // показываем ОДНУ кнопку «Вставить все». Одиночный
                      // fence — ряд ручного выбора один раз. Нестыковка
                      // (fence'ов больше клипов) — ряды с подписью номера
                      // промпта, чтобы отличались.
                      const positional =
                        marked.length === 0 &&
                        unmarked.length >= 2 &&
                        unmarked.length <= extendClipsCount
                      return (
                        <div className="mt-2 pt-2 border-t border-border/60 space-y-1.5">
                          {marked.length >= 2 ? (
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => insertAllIntoClips(marked)}
                                className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] border border-violet-500/30 bg-violet-500/10 text-violet-300 hover:bg-violet-500/20 transition-colors"
                              >
                                <ArrowDownToLineIcon className="w-3 h-3" />
                                Вставить все ({marked.length})
                              </button>
                              <span className="text-[10px] text-muted-foreground/60">
                                → клипы {marked.map((p) => p.clip).join(', ')}
                              </span>
                            </div>
                          ) : (
                            marked.map((p) => (
                              <div key={p.clip} className="flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => insertIntoClip(p.content, p.clip)}
                                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] border border-violet-500/30 bg-violet-500/10 text-violet-300 hover:bg-violet-500/20 transition-colors"
                                >
                                  <ArrowDownToLineIcon className="w-3 h-3" />
                                  В клип {p.clip}
                                </button>
                              </div>
                            ))
                          )}
                          {positional ? (
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() =>
                                  insertAllIntoClips(
                                    unmarked.map((u, i) => ({ content: u.content, clip: i + 1 })),
                                  )
                                }
                                className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] border border-violet-500/30 bg-violet-500/10 text-violet-300 hover:bg-violet-500/20 transition-colors"
                              >
                                <ArrowDownToLineIcon className="w-3 h-3" />
                                Вставить все ({unmarked.length})
                              </button>
                              <span className="text-[10px] text-muted-foreground/60">
                                → клипы {unmarked.map((_, i) => i + 1).join(', ')}
                              </span>
                            </div>
                          ) : (
                            unmarked.map(({ content, fi }) => {
                              if (extendClipsCount === 0) {
                                return fi === unmarked[0].fi ? (
                                  <p key={fi} className="text-[10px] text-muted-foreground/60">
                                    Нет клипов — добавьте их на вкладке «Продление», затем вставьте промпт.
                                  </p>
                                ) : null
                              }
                              return (
                                <div key={fi} className="flex items-center gap-1 flex-wrap">
                                  <span className="text-[10px] text-muted-foreground/60 mr-0.5">
                                    {unmarked.length > 1 ? `Промпт ${fi + 1} →` : 'В клип:'}
                                  </span>
                                  {Array.from({ length: extendClipsCount }, (_, k) => (
                                    <button
                                      key={k}
                                      type="button"
                                      onClick={() => insertIntoClip(content, k + 1)}
                                      className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] border border-violet-500/30 bg-violet-500/10 text-violet-300 hover:bg-violet-500/20 transition-colors"
                                    >
                                      Клип {k + 1}
                                    </button>
                                  ))}
                                </div>
                              )
                            })
                          )}
                        </div>
                      )
                    })()}
                  </div>
                </motion.div>
              ))}
              {streamingHere && (
                <div className="flex justify-start">
                  <div className="select-text max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed break-words bg-[var(--surface-2)]/60 border border-border/60 text-foreground/95 rounded-bl-sm">
                    {streamText ? renderChatContent(streamText) : '…'}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Quick actions + input (правка 87: центрировано, max-width) */}
          <div className="shrink-0 border-t border-border px-4 py-3 bg-[var(--surface-0)]/90 backdrop-blur-sm">
          <div className="max-w-3xl mx-auto space-y-2">
            {!streaming && (
              <div className="flex items-center gap-1.5 flex-wrap">
                {isExtendChat ? (
                  /* (правка 427) Extend-чат: быстрая кнопка просит промпты
                      ВСЕХ клипов — по fence с маркером clip: N на клип. */
                  <button
                    type="button"
                    onClick={() => {
                      void send(
                        extendClipsCount > 0
                          ? `Заполни (или улучши) промпты всех ${extendClipsCount} клипов продления по контексту исходника — для каждого клипа отдельный \`\`\`text fence с первой строкой \`clip: N\`.`
                          : 'Предложи 2–3 клипа продления по контексту исходного видео: для каждого — отдельный ```text fence с первой строкой `clip: N` (я создам карточки клипов с этими номерами).',
                      )
                    }}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-amber-500/30 bg-amber-500/10 text-amber-300 text-xs hover:bg-amber-500/20 transition-colors"
                  >
                    <WandSparklesIcon className="w-3 h-3" />
                    {extendClipsCount > 0 ? 'Промпты для всех клипов' : 'Предложить клипы продления'}
                  </button>
                ) : isControlNetChat ? (
                  /* (правка 502) ControlNet-чат: «Исправить промпт» (правка 560
                      — переименовано) с текущим промптом вкладки «ControlNet»
                      (пустой — придумать с нуля). */
                  <button
                    type="button"
                    onClick={() => {
                      const draft = useControlNetTarget.getState().prompt.trim()
                      void send(
                        draft
                          ? `Исправь мой текущий промпт для режима ControlNet, сохранив смысл. Движение и камеру НЕ описывай — их задаёт контрольное видео. Текущий промпт:\n\n${draft}`
                          : 'Придумай промпт для режима ControlNet с нуля: движение и камеру задаёт контрольное видео, опиши только сцену, внешность персонажей, стиль, свет и звук.',
                      )
                    }}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-amber-500/30 bg-amber-500/10 text-amber-300 text-xs hover:bg-amber-500/20 transition-colors"
                  >
                    <WandSparklesIcon className="w-3 h-3" />
                    Исправить промпт
                  </button>
                ) : (
                <button
                  type="button"
                  onClick={() => {
                    const draft = useGenStore.getState().video.prompt.trim()
                    void send(
                      draft
                        ? `Исправь мой текущий промпт, сохранив смысл. Текущий промпт:\n\n${draft}`
                        : 'Предложи 3 разных идеи для короткого видео (по одной сцене на идею), я выберу и попрошу промпт.',
                    )
                  }}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-amber-500/30 bg-amber-500/10 text-amber-300 text-xs hover:bg-amber-500/20 transition-colors"
                >
                  <WandSparklesIcon className="w-3 h-3" />
                  {hasPrompt ? 'Исправить мой промпт' : 'Предложить идеи'}
                </button>
                )}
              </div>
            )}
            {/* (правка 86) Превью вложения */}
            {attachment && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-amber-500/30 bg-amber-500/10">
                {attachment.kind === 'image' ? (
                  <img
                    src={attachment.previewUrl}
                    alt={attachment.name}
                    className="w-10 h-10 rounded-md object-cover shrink-0"
                  />
                ) : (
                  <div className="w-10 h-10 rounded-md bg-[var(--surface-3)] flex items-center justify-center shrink-0">
                    <FilmIcon className="w-5 h-5 text-amber-400" />
                  </div>
                )}
                <span className="text-xs text-foreground truncate flex-1 min-w-0">{attachment.name}</span>
                {attUploading ? (
                  <span className="text-[10px] text-amber-400 animate-pulse shrink-0">Загрузка…</span>
                ) : (
                  <button
                    type="button"
                    onClick={removeAttachment}
                    className="p-1 rounded hover:bg-red-500/20 text-muted-foreground hover:text-red-400 transition-colors shrink-0"
                    title="Убрать вложение"
                  >
                    <XIcon className="w-3.5 h-3.5" />
                  </button>
                )}
                {/* (правка 691) «Очистить» — сбрасывает текст и вложение одним
                    жестом (показана, когда есть что чистить). */}
                {(input.trim() || attachment) && (
                  <button
                    type="button"
                    onClick={() => { setInput(''); removeAttachment() }}
                    className="p-1 rounded hover:bg-red-500/20 text-muted-foreground hover:text-red-400 transition-colors shrink-0"
                    title="Очистить поле ввода и вложение"
                  >
                    <Trash2Icon className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            )}
            <div className="flex items-center gap-2">
              {/* (правка 86) Кнопка «+» — прикрепить изображение или видео */}
              <button
                type="button"
                onClick={() => attFileRef.current?.click()}
                disabled={streaming || attUploading}
                title="Прикрепить изображение или видео для анализа LLM"
                className={cn(
                  'shrink-0 inline-flex items-center justify-center rounded-xl border transition-colors',
                  'h-11 w-11',
                  'border-border bg-[var(--surface-2)] text-muted-foreground',
                  'hover:text-foreground hover:bg-[var(--surface-3)]',
                  'disabled:opacity-40 disabled:cursor-not-allowed',
                )}
              >
                <PaperclipIcon className="w-4 h-4" />
              </button>
              <input
                ref={attFileRef}
                type="file"
                accept="image/*,video/*"
                className="hidden"
                onChange={handleAttFile}
              />
              {/* Поле ввода + микрофон (правка 87: центрировано) */}
              <div className="relative flex-1 min-w-0">
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      // Кнопка Send disabled во время загрузки вложения —
                      // Enter должен соблюдать тот же guard: иначе текст
                      // уходил БЕЗ вложения, а повторный send (по завершении
                      // загрузки) молча отбрасывался (running=true).
                      if (attUploading) {
                        toast.error('Дождитесь загрузки вложения')
                        return
                      }
                      void send()
                    }
                  }}
                  placeholder="Опишите идею сцены… (Enter — отправить, Shift+Enter — новая строка)"
                  rows={1}
                  // (правка 452) Точный вертикальный ритм: 11+20+11 + 2px рамки =
                  // ровно 44px (h-11 кнопок) — текст, плейсхолдер и кнопки стоят
                  // на одной оси. placeholder:text-xs убран: уменьшенный шрифт
                  // ломал baseline и плейсхолдер висел выше центра.
                  className="w-full resize-none rounded-xl border border-border bg-[var(--surface-2)] px-3.5 py-[11px] pr-12 text-sm leading-5 text-foreground placeholder:text-muted-foreground/50 placeholder:whitespace-nowrap placeholder:overflow-hidden placeholder:text-ellipsis focus:outline-none focus:ring-1 focus:ring-amber-500/50 min-h-[44px] max-h-[188px] overflow-y-auto"
                />
                {/* (правка 139) Микрофон: явный flex-center контейнер h-11, чтобы кнопка 32px
                    гарантированно стояла ровно по вертикали поля (раньше inline-flex 32px в
                    absolutely-positioned div с top-1/2 визуально «прижимался» к низу) */}
                <div className="absolute right-2.5 top-1/2 -translate-y-1/2 flex h-11 w-11 items-center justify-center">
                  <VoiceInputButton
                    variant="inline"
                    hotkey
                    onText={(t) => {
                      // (правка 256) setInput — прямой сеттер стора (не fn-апдейтер)
                      const prev = useAssistantDraft.getState().input
                      setInput(prev.trim() ? `${prev.replace(/\s+$/, '')} ${t}` : t)
                      textareaRef.current?.focus()
                    }}
                  />
                </div>
              </div>
              {streaming ? (
                <Button variant="outline" size="sm" onClick={stop} className="h-11 gap-1.5">
                  <SquareIcon className="w-4 h-4" />
                  Стоп
                </Button>
              ) : (
                <Button
                  size="sm"
                  onClick={() => { void send() }}
                  disabled={!input.trim() || chatBlocked || attUploading}
                  title={chatBlocked ? '⚙️ Идёт генерация видео — отправка недоступна' : 'Отправить'}
                  className="h-11 px-4 gap-1.5 rounded-xl border border-amber-500/30 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25 hover:border-amber-500/50 font-medium shadow-sm shadow-amber-500/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <SendIcon className="w-4 h-4" />
                  Отправить
                </Button>
              )}
            </div>
          </div>
          </div>
        </>
      )}
      </div>

      {/* Right: chat list sidebar (правка 87).
          (правка 442) В панели — выдвижной оверлей поверх чата (места для
          постоянной колонки нет), переключатель режима скрыт: режим задаёт
          вкладка (panelMode). */}
      {inPanel && chatListOpen && (
        <div className="absolute inset-0 z-10 bg-black/30" onClick={() => setChatListOpen(false)} />
      )}
      {(!inPanel || chatListOpen) && (
      <div
        className={cn(
          'border-l border-border flex flex-col',
          inPanel
            ? 'absolute inset-y-0 right-0 w-52 z-20 bg-[var(--surface-0)] shadow-2xl shadow-black/50'
            : 'w-56 bg-[var(--surface-0)]/60 shrink-0',
        )}
      >
        <div className="p-3 border-b border-border space-y-2">
          {/* (правка 427) Режим-фильтр чатов — стиль как «Качество прохода»
              в extend-view (grid-cols-2, активная — emerald). Переключает
              ТОЛЬКО список: режим открытого чата синхронизирует эффект выше
              (авто-открытие первого чата режима или создание нового).
              (правка 442) В панели скрыт — режим жёстко следует за вкладкой. */}
          {!inPanel && (
          <div className="grid grid-cols-3 gap-1.5">
            {/* (правка 502) Третий режим: «ControlNet». */}
            {([['generate', 'Генерация'], ['extend', 'Продление'], ['controlnet', 'ControlNet']] as const).map(([m, label]) => (
              <button
                key={m}
                type="button"
                onClick={() => useAssistantChats.getState().setAssistantMode(m)}
                className={cn(
                  'h-7 rounded-md border text-xs font-medium transition-all',
                  assistantMode === m
                    ? 'bg-emerald-500/15 border-emerald-500/50 text-emerald-300'
                    : 'bg-[var(--surface-2)] border-border text-muted-foreground hover:border-emerald-500/30',
                )}
              >
                {label}
              </button>
            ))}
          </div>
          )}
          <Button
            variant="outline"
            size="sm"
            className="w-full gap-1.5 text-xs justify-center"
            onClick={newChat}
          >
            <PlusIcon className="w-3.5 h-3.5" />
            Новый чат
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {/* (правка 427) Список показывает только чаты выбранного режима. */}
          {chats.filter((c) => c.mode === assistantMode).map((c) => {
            const isRenaming = renamingId === c.id
            return (
            <div
              key={c.id}
              onClick={() => { if (!isRenaming) switchChat(c.id) }}
              className={cn(
                'group flex items-center gap-2 px-3 py-2.5 cursor-pointer border-b border-border/40',
                c.id === activeId ? 'bg-amber-500/10' : 'hover:bg-white/5',
              )}
            >
              <MessageSquareIcon
                className={cn('w-3.5 h-3.5 shrink-0', c.id === activeId ? 'text-amber-400' : 'text-muted-foreground/60')}
              />
              {isRenaming ? (
                /* (правка 264) Инлайн-редактор имени чата */
                <div className="flex-1 min-w-0 flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                  <input
                    ref={renameInputRef}
                    type="text"
                    value={renameValue}
                    maxLength={80}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); commitRename() }
                      else if (e.key === 'Escape') { e.preventDefault(); cancelRename() }
                    }}
                    onBlur={commitRename}
                    className="flex-1 min-w-0 rounded-md border border-cyan-500/50 bg-[var(--surface-2)] px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
                    placeholder="Название чата"
                  />
                  <button
                    type="button"
                    onClick={commitRename}
                    className="shrink-0 w-6 h-6 flex items-center justify-center text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/10 rounded"
                    title="Сохранить (Enter)"
                  >
                    <CheckIcon className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={cancelRename}
                    className="shrink-0 w-6 h-6 flex items-center justify-center text-muted-foreground/60 hover:text-red-400 hover:bg-red-500/10 rounded"
                    title="Отмена (Esc)"
                  >
                    <XIcon className="w-3.5 h-3.5" />
                  </button>
                </div>
              ) : (
                <div className="flex-1 min-w-0">
                  <p
                    className="text-xs text-foreground truncate"
                    onDoubleClick={(e) => { e.stopPropagation(); startRename(c.id, c.title) }}
                    title={c.title}
                  >
                    {c.title}
                    {c.id === streamChatId && (
                      <span
                        className="ml-1.5 inline-block w-1.5 h-1.5 rounded-full bg-cyan-400/80 animate-pulse align-middle"
                        title="Ответ генерируется в этом чате"
                      />
                    )}
                  </p>
                  <p className="text-[10px] text-muted-foreground/60">
                    {c.id === streamChatId
                      ? 'ответ идёт…'
                      : `${c.messages.length} сообщ. · ${new Date(c.updatedAt).toLocaleDateString('ru-RU')}`}
                  </p>
                </div>
              )}
              {isRenaming ? null : (
                <>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      startRename(c.id, c.title)
                    }}
                    className="shrink-0 w-5 h-5 flex items-center justify-center text-muted-foreground/40 hover:text-cyan-400 opacity-0 group-hover:opacity-100 transition-opacity"
                    title="Переименовать (двойной клик по имени)"
                  >
                    <PencilIcon className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      deleteChat(c.id)
                    }}
                    className="shrink-0 w-5 h-5 flex items-center justify-center text-muted-foreground/40 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                    title="Удалить чат"
                  >
                    <XIcon className="w-3 h-3" />
                  </button>
                </>
              )}
            </div>
            )
          })}
          {chats.filter((c) => c.mode === assistantMode).length === 0 && (
            <p className="text-[10px] text-muted-foreground/50 text-center py-6 px-3">
              Нет чатов в режиме «{assistantMode === 'extend' ? 'Продление' : assistantMode === 'controlnet' ? 'ControlNet' : 'Генерация'}». Создайте новый.
            </p>
          )}
        </div>
      </div>
      )}

      {/* (правка 719) Просмотр референса по клику на тег <Picture N>/
          <Video N> в ответе ассистента. */}
      <RefViewerDialog
        data={viewingRef}
        onOpenChange={(v) => { if (!v) setViewingRef(null) }}
      />
    </div>
  )
}

/** Короткий хэш строки (djb2). */
function hashStr(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(36)
}
