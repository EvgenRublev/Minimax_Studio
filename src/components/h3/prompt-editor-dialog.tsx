'use client'

/**
 * A full-screen modal editor for long prompts.
 * Left: large highlighted textarea (MentionTextarea) + live quality checklist.
 * Right: insert panel — reference tag buttons, "+ реплика" (<d>…</d>),
 * cinema vocabulary chips and scene skeletons from the Learn guide.
 */
import { useState, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  PencilLineIcon,
  TagsIcon,
  MessageSquareQuoteIcon,
  CameraIcon,
  LayoutTemplateIcon,
  CopyIcon,
  TrashIcon,
  WrapTextIcon,
  HistoryIcon,
  SparklesIcon,
  WandSparklesIcon,
  StarIcon,
  XIcon,
  Trash2Icon,
} from 'lucide-react'
import {
  MentionTextarea,
  type MentionItem,
  type MentionTextareaHandle,
} from './mention-textarea'
import { PromptQuality } from './prompt-quality'
import { CAMERA_WORDS, EXAMPLES } from './learn/prompt-guide'
import { usePromptHistory } from '@/lib/prompt-history-store'
import { useImprovePrompt, type ImprovePromptOptions } from '@/hooks/use-improve-prompt'
import { VoiceInputButton } from './voice-input-button'
import { cn } from '@/lib/utils'

interface PromptEditorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialText: string
  onSave: (text: string) => void
  /** Optional "save & immediately start generation" action (Ctrl+Enter). */
  onSaveAndRun?: (text: string) => void
  placeholder?: string
  mentions?: MentionItem[]
  /** (правка 443) Опции «Улучшить промпт»: из редактора клипа продления
   *  запрос уходит в extend-чат с номером клипа (по умолчанию — generate). */
  improveOptions?: ImprovePromptOptions
}

type RightTab = 'insert' | 'history' | 'examples'

/** Scene skeletons following the guide's formula (WHO→WHAT→WHERE→LIGHT→CAMERA→LINES).
 *  English — the model follows English noticeably better; bracket hints
 *  [in brackets] are placeholders for the user to fill in. */
const SKELETONS: Array<{ label: string; text: string }> = [
  {
    label: 'Портрет',
    text: 'A character with <Picture 1> [what they are doing], [place, time of day], [lighting and mood]. The camera [movement/shot]. He/She says: <d>short line.</d>',
  },
  {
    label: 'Сцена',
    text: 'A character with <Picture 1> [action] in [location from <Video 1>], [surrounding details], [light]. The camera [movement]. Sounds: [background sounds].',
  },
  {
    label: 'Диалог',
    text: 'A character with <Picture 1> [scene context and place]. He/She says: <d>first short line.</d> A pause, [reaction/gesture]. Then: <d>second line.</d>',
  },
]

export function PromptEditorDialog({
  open,
  onOpenChange,
  initialText,
  onSave,
  onSaveAndRun,
  placeholder = 'Введите или отредактируйте промпт…',
  mentions,
  improveOptions,
}: PromptEditorDialogProps) {
  const [text, setText] = useState(initialText)
  const [rightTab, setRightTab] = useState<RightTab>('insert')
  const editorRef = useRef<MentionTextareaHandle>(null)

  // History + improve prompt
  const historyEntries = usePromptHistory((s) => s.entries)
  const toggleHistoryFavorite = usePromptHistory((s) => s.toggleFavorite)
  const removeHistoryEntry = usePromptHistory((s) => s.remove)
  const clearHistory = usePromptHistory((s) => s.clear)
  const improvePrompt = useImprovePrompt()

  // Sync text when dialog opens with new content
  useEffect(() => {
    if (open) setText(initialText)
  }, [open, initialText])

  const insert = (snippet: string) => editorRef.current?.insertAtCursor(snippet)

  /** Apply a full prompt (from history/examples) — replaces the current text. */
  const applyPrompt = (snippet: string) => {
    setText(snippet)
    toast.success('Промпт подставлен')
  }

  /** (правка 560) «Исправить промпт»: сначала спрашиваем, ЧТО именно
   *  изменить, — окно с полем задания; промпт + задание уходят в чат
   *  ассистента текущей вкладки парой. */
  const [fixOpen, setFixOpen] = useState(false)
  const [fixText, setFixText] = useState('')

  /** "Исправить промпт" — open the "what to change" dialog (правка 560). */
  const handleImprove = () => {
    if (!text.trim()) {
      toast.info('Промпт пуст', { description: 'Введите хотя бы несколько слов, чтобы LLM мог его исправить.' })
      return
    }
    setFixText('')
    setFixOpen(true)
  }

  /** Отправить: черновик сохраняется, редактор закрывается, задание
   *  пользователя + текущий промпт уходят в соответствующий чат ассистента
   *  (правка 559: существующий чат режима, без плодания новых). */
  const submitFix = () => {
    const req = fixText.trim()
    if (!req) return
    onSave(text)
    setFixOpen(false)
    improvePrompt(text, { ...improveOptions, fixRequest: req })
    // (правка 560b) Редактор закрываем ОТДЕЛЬНЫМ тиком после окна задания:
    // при одновременном exit двух Presence в одном React-коммите анимации
    // закрытия могли не отрабатывать (диалоги-призраки с data-state=closed
    // висли над UI). Разделение по тикам даёт каждому диалогу чистый exit.
    setTimeout(() => onOpenChange(false), 50)
  }

  const handleSave = () => {
    onSave(text)
    onOpenChange(false)
  }

  const handleSaveAndRun = () => {
    onSave(text)
    onOpenChange(false)
    onSaveAndRun?.(text)
  }

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success('Промпт скопирован в буфер обмена')
    } catch {
      toast.error('Не удалось скопировать')
    }
  }

  // Ctrl+Enter inside the editor = save (+run when wired)
  const handleKeyDownFs = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      if (onSaveAndRun) handleSaveAndRun()
      else handleSave()
    }
  }

  const panelBlock = (
    icon: React.ReactNode,
    title: string,
    children: React.ReactNode,
  ) => (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        {icon}
        <span className="text-[10px] font-medium uppercase tracking-wide">{title}</span>
      </div>
      {children}
    </div>
  )

  return (
    <>
    {/* (правка 560b) Два НЕЗАВИСИМЫХ sibling-диалога. Окно задания НЕ вложено
        в дерево редактора: при одновременном закрытии обоих (сабмит)
        вложенный Radix-Dialog застревал в DOM с data-state=closed —
        exit-анимация не отрабатывала и диалоги-призраки висели над UI.
        Сиблинги закрываются как два обычных диалога (проверено на шаблоне
        «Настройки»). */}
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* (правка 454) Ширина диалога уменьшена на 30%: 80vw → 56vw — на
          широких мониторах редактор не разъезжался на пол-экрана. */}
      <DialogContent className="max-w-[56vw] sm:max-w-[56vw] w-full h-[85vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-4 pt-3 pb-2 border-b border-border shrink-0 flex items-center justify-between">
          <div>
            <DialogTitle className="text-base font-semibold">
              Редактор промпта
            </DialogTitle>
            {mentions && mentions.length > 0 && (
              <p className="text-[10px] text-muted-foreground mt-0.5">
                Введите <span className="font-mono text-foreground/80">@</span> для вставки референса
              </p>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground mr-2">{text.length} символов</span>
            {/* (правка 560) «Исправить промпт» — открывает окно задания. */}
            <button
              type="button"
              onClick={handleImprove}
              title="Отправить в LLM-ассистент с указанием, что именно изменить"
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium bg-gradient-to-r from-violet-500/20 to-fuchsia-500/20 text-violet-300 border border-violet-500/30 hover:from-violet-500/30 hover:to-fuchsia-500/30 transition-colors"
            >
              <WandSparklesIcon className="w-3.5 h-3.5" />
              Исправить промпт
            </button>
            {/* Mini-toolbar: wrap selection · copy · clear */}
            <button
              type="button"
              onClick={() => editorRef.current?.wrapSelection('<d>', '</d>')}
              title="Обернуть выделение в <d>…</d>"
              className="p-1.5 rounded-md text-muted-foreground hover:text-amber-300 hover:bg-amber-500/10 transition-colors"
            >
              <WrapTextIcon className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={copyPrompt}
              title="Скопировать промпт"
              className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-[var(--surface-3)] transition-colors"
            >
              <CopyIcon className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => setText('')}
              title="Очистить"
              className="p-1.5 rounded-md text-muted-foreground hover:text-red-400 hover:bg-red-500/10 transition-colors"
            >
              <TrashIcon className="w-4 h-4" />
            </button>
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              Отмена
            </Button>
            {onSaveAndRun ? (
              <Button
                size="sm"
                onClick={handleSaveAndRun}
                className="bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white border-0 font-semibold"
                title="Ctrl+Enter"
              >
                Сохранить и запустить
              </Button>
            ) : null}
            <Button size="sm" variant={onSaveAndRun ? 'outline' : 'default'} onClick={handleSave}>
              Сохранить
            </Button>
          </div>
        </DialogHeader>

        <div className="flex-1 min-h-0 flex flex-col lg:flex-row gap-2 px-3 py-2">
          {/* Editor + quality checklist */}
          <div className="flex-1 min-h-0 flex flex-col gap-2">
            {/* (правка 74) Круглый микрофон ВНУТРИ поля редактора */}
            <div className="relative flex-1 min-h-0">
              <MentionTextarea
                ref={editorRef}
                value={text}
                onChange={setText}
                onKeyDown={handleKeyDownFs}
                placeholder={placeholder}
                mentions={mentions}
                className="w-full h-full resize-none rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50 pr-10"
              />
              {/* (правка 118) hotkey: диалог монтируется последним → пока открыт, клавишу принимает он */}
              <VoiceInputButton
                hotkey
                onText={(t) => editorRef.current?.insertAtCursor(t)}
                title="Голосовой ввод — вставка по курсору"
              />
            </div>
            <PromptQuality prompt={text} refsCount={mentions?.length ?? 0} className="shrink-0" />
          </div>

          {/* Right panel: insert / history / examples */}
          <aside className="w-full lg:w-[300px] shrink-0 rounded-lg border border-border bg-[var(--surface-1)]/70 flex flex-col max-h-[38vh] lg:max-h-none p-5">
            {/* Right-panel tabs */}
            <div className="flex items-center gap-1 p-1 rounded-lg bg-[var(--surface-2)]/60 border border-border mb-3 shrink-0">
              {([
                ['insert', 'Вставка', <TagsIcon key="i" className="w-3.5 h-3.5" />],
                ['history', 'История', <HistoryIcon key="h" className="w-3.5 h-3.5" />],
                ['examples', 'Примеры', <SparklesIcon key="e" className="w-3.5 h-3.5" />],
              ] as const).map(([id, label, icon]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setRightTab(id)}
                  className={cn(
                    'flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium transition-colors',
                    rightTab === id
                      ? 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/30'
                      : 'text-muted-foreground border border-transparent hover:text-foreground',
                  )}
                >
                  {icon}
                  {label}
                </button>
              ))}
            </div>
            {rightTab === 'insert' && (
              <div className="flex-1 overflow-y-auto space-y-4 min-h-0 px-1">
            {panelBlock(<TagsIcon className="w-3.5 h-3.5" />, 'Референсы (вставить тег)', (
              <div className="flex flex-wrap gap-1.5">
                {(mentions ?? []).map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => insert(m.trigger)}
                    title={m.label}
                    className="px-2 py-1 rounded-md text-[10px] font-mono border border-border bg-[var(--surface-2)] hover:border-cyan-500/40 hover:text-cyan-300 transition-colors"
                  >
                    {m.trigger.replace(/[<>]/g, '')}
                  </button>
                ))}
                {(!mentions || mentions.length === 0) && (
                  <p className="text-[10px] text-muted-foreground/70">Загрузите референсы на вкладке генерации.</p>
                )}
              </div>
            ))}

            {panelBlock(<MessageSquareQuoteIcon className="w-3.5 h-3.5" />, 'Реплика (озвучка)', (
              <div className="space-y-1">
                <button
                  type="button"
                  onClick={() => insert('<d>речь героя</d>')}
                  className="w-full px-2 py-1.5 rounded-md text-xs border border-amber-500/30 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 transition-colors"
                >
                  + &lt;d&gt;…&lt;/d&gt;
                </button>
                <button
                  type="button"
                  onClick={() => editorRef.current?.wrapSelection('<d>', '</d>')}
                  className="w-full px-2 py-1.5 rounded-md text-xs border border-amber-500/20 text-amber-300/80 hover:bg-amber-500/10 transition-colors"
                  title="Выделите текст в промпте и нажмите"
                >
                  Обернуть выделение в &lt;d&gt;
                </button>
              </div>
            ))}

            {panelBlock(<CameraIcon className="w-3.5 h-3.5" />, 'Камера и свет', (
              <div className="flex flex-wrap gap-1">
                {CAMERA_WORDS.map((w) => (
                  <button
                    key={w}
                    type="button"
                    onClick={() => insert(w)}
                    className="px-1.5 py-0.5 rounded-full border border-border bg-[var(--surface-2)]/70 text-[10px] text-foreground/80 hover:border-cyan-500/40 hover:text-cyan-300 transition-colors"
                  >
                    {w}
                  </button>
                ))}
              </div>
            ))}

            {panelBlock(<LayoutTemplateIcon className="w-3.5 h-3.5" />, 'Шаблоны сцены', (
              <div className="space-y-1">
                {SKELETONS.map((s) => (
                  <button
                    key={s.label}
                    type="button"
                    onClick={() => insert(s.text)}
                    className="w-full text-left px-2 py-1.5 rounded-md text-xs border border-border bg-[var(--surface-2)]/70 text-foreground/85 hover:border-cyan-500/40 transition-colors"
                  >
                    {s.label} <span className="text-muted-foreground/60">— вставить скелет</span>
                  </button>
                ))}
              </div>
            ))}
              </div>
            )}

            {/* ─── HISTORY TAB ─── */}
            {rightTab === 'history' && (
              <div className="flex-1 overflow-y-auto min-h-0 space-y-1">
                <div className="flex items-center justify-between px-1 py-1.5 border-b border-border sticky top-0 bg-[var(--surface-1)]">
                  <span className="text-[10px] font-semibold text-foreground">История промптов</span>
                  {historyEntries.length > 0 && (
                    <button
                      type="button"
                      onClick={clearHistory}
                      className="text-[10px] text-muted-foreground hover:text-red-400"
                    >
                      очистить всё
                    </button>
                  )}
                </div>
                {historyEntries.length === 0 && (
                  <p className="px-2 py-4 text-xs text-muted-foreground text-center">
                    Пока пусто — запущенные промпты сохраняются здесь автоматически.
                  </p>
                )}
                {historyEntries.map((e) => (
                  <div
                    key={e.id}
                    className="group flex items-start gap-2 px-2 py-1.5 hover:bg-white/5 cursor-pointer rounded-md"
                    onClick={() => applyPrompt(e.text)}
                  >
                    <button
                      type="button"
                      onClick={(ev) => {
                        ev.stopPropagation()
                        toggleHistoryFavorite(e.id)
                      }}
                      title={e.favorite ? 'Убрать из избранного' : 'В избранное'}
                      className={cn(
                        'shrink-0 mt-0.5 w-4 h-4 flex items-center justify-center transition-colors',
                        e.favorite ? 'text-amber-400' : 'text-muted-foreground/40 hover:text-amber-400',
                      )}
                    >
                      <StarIcon className="w-3 h-3" fill={e.favorite ? 'currentColor' : 'none'} />
                    </button>
                    <p className="flex-1 min-w-0 text-xs text-foreground/90 leading-snug line-clamp-2 break-words">
                      {e.text}
                    </p>
                    <button
                      type="button"
                      onClick={(ev) => {
                        ev.stopPropagation()
                        removeHistoryEntry(e.id)
                      }}
                      className="shrink-0 mt-0.5 w-4 h-4 flex items-center justify-center text-muted-foreground/40 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                      title="Удалить из истории"
                    >
                      <XIcon className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* ─── EXAMPLES TAB ─── */}
            {rightTab === 'examples' && (
              <div className="flex-1 overflow-y-auto min-h-0 space-y-1">
                <div className="px-1 py-1.5 border-b border-border sticky top-0 bg-[var(--surface-1)]">
                  <span className="text-[10px] font-semibold text-foreground">Готовые примеры</span>
                </div>
                {EXAMPLES.map((ex) => (
                  <div
                    key={ex.title}
                    className="px-2 py-1.5 hover:bg-white/5 cursor-pointer rounded-md"
                    onClick={() => applyPrompt(ex.text)}
                  >
                    <p className="text-xs font-medium text-foreground">{ex.title}</p>
                    <p className="text-[10px] text-muted-foreground/80 line-clamp-2 leading-snug break-words">
                      {ex.note}
                    </p>
                  </div>
                ))}
                <p className="px-2 py-2 text-[10px] text-muted-foreground/60 border-t border-border mt-2">
                  Заменяет текущий промпт. Промпты — на английском: модель понимает его лучше всего.
                </p>
              </div>
            )}
          </aside>
        </div>
      </DialogContent>
    </Dialog>

    {/* (правка 560) Окно «что изменить»: открывается по кнопке
        «Исправить промпт». Задание пользователя + текущий черновик
        уходят в чат ассистента (submitFix). Сиблинг редактора, не
        вложенный диалог — см. комментарий в начале return. */}
    <Dialog open={fixOpen} onOpenChange={setFixOpen}>
      <DialogContent className="max-w-lg p-0 gap-0">
          <DialogHeader className="px-4 pt-4 pb-2 border-b border-border">
            <DialogTitle className="text-base font-semibold">Исправить промпт</DialogTitle>
            <DialogDescription className="text-xs leading-relaxed">
              Напишите, что бы вы хотели изменить в этом промпте
            </DialogDescription>
          </DialogHeader>
          <div className="p-4 space-y-3">
            <textarea
              autoFocus
              value={fixText}
              onChange={(e) => setFixText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setFixOpen(false)
                } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault()
                  submitFix()
                }
              }}
              rows={4}
              placeholder="Например: сделай камеру статичной, убери дождь, реплику героя — короче…"
              className="w-full resize-none rounded-xl border border-border bg-[var(--surface-2)] px-3.5 py-2.5 text-sm leading-5 text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-violet-500/50"
            />
            <p className="text-[10px] text-muted-foreground/70 leading-relaxed">
              Промпт и ваше задание уйдут в чат ассистента этой вкладки — ответ
              можно будет вставить обратно кнопкой «В промпт». Ctrl+Enter — отправить, Esc — отмена.
            </p>
            <div className="flex items-center justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setFixOpen(false)}>
                Отмена
              </Button>
              <Button
                size="sm"
                onClick={submitFix}
                disabled={!fixText.trim()}
                className="gap-1.5 rounded-lg border border-violet-500/30 bg-violet-500/15 text-violet-200 hover:bg-violet-500/25 hover:border-violet-500/50 font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <WandSparklesIcon className="w-3.5 h-3.5" />
                Отправить ассистенту
              </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
    </>
  )
}

/**
 * (правка 717) Вертикальная колонка кнопок поля промпта.
 *
 * Раньше каждая кнопка позиционировалась САМА: absolute top-2 с волшебными
 * смещениями right-2 / right-10 / right-[4.25rem]. Эти «магические» значения
 * не учитывали реальную ширину кнопки (p-1.5 + иконка w-3.5 + рамка ≈ 28px),
 * из-за чего кнопки налезали друг на друга и съезжали при смене размера
 * поля. Теперь это ОДИН flex-контейнер: строгая колонка, РОВНЫЕ интервалы
 * (gap) и никакой магии в координатах.
 *
 * Кнопки внутри не позиционируются — позиционирует контейнер.
 */
export function PromptFieldTools({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="absolute right-2 top-2 z-10 flex flex-col items-center gap-1.5"
      data-prompt-field-tools=""
    >
      {children}
    </div>
  )
}

/** (правка 691) «Исправить промпт» — компактная кнопка над полем ввода:
 * открывает диалог «что изменить» и отправляет текущий промпт + задание
 * в чат ассистента этой вкладки (тот же поток, что и «Исправить промпт»
 * в полноэкранном редакторе).
 * (правка 717) Позиционирование — контейнером PromptFieldTools (вертикальная
 * колонка), кнопка сама не absolute. */
export function PromptFixButton({
  onFix,
}: {
  /** Вызывается при клике (промпт пуст / непустой — решение за родителем). */
  onFix: () => void
}) {
  return (
    <button
      type="button"
      onClick={onFix}
      title="Исправить промпт с ассистентом: напишите, что изменить — промпт и задание уйдут в чат"
      className="p-1.5 rounded-md bg-[var(--surface-3)]/80 hover:bg-[var(--surface-4)] text-violet-300 hover:text-violet-200 transition-colors border border-violet-500/30 backdrop-blur-sm"
    >
      <WandSparklesIcon className="w-3.5 h-3.5" />
    </button>
  )
}

/** (правка 691) «Очистить поле» — компактная кнопка над полем ввода.
 * Пустое поле — неактивна (красный hover).
 * (правка 717) Позиционирование — контейнером PromptFieldTools. */
export function PromptClearButton({
  onClear,
  disabled,
}: {
  onClear: () => void
  /** true — промпт пуст: кнопку не показываем (нет смысла чистить). */
  disabled?: boolean
}) {
  if (disabled) return null
  return (
    <button
      type="button"
      onClick={onClear}
      title="Очистить поле промпта"
      className="p-1.5 rounded-md bg-[var(--surface-3)]/80 hover:bg-red-500/15 text-muted-foreground hover:text-red-400 transition-colors border border-border/50 backdrop-blur-sm"
    >
      <Trash2Icon className="w-3.5 h-3.5" />
    </button>
  )
}

/**
 * A small button that triggers the PromptEditorDialog.
 * Place it next to a prompt textarea to open the editor.
 * (правка 717) Позиционирование — контейнером PromptFieldTools.
 */
export function PromptEditButton({
  onOpen,
}: {
  onOpen: () => void
}) {
  return (
    <button
      onClick={onOpen}
      className="p-1.5 rounded-md bg-[var(--surface-3)] hover:bg-[var(--surface-4)] text-muted-foreground hover:text-foreground transition-colors border border-border/50"
      title="Открыть редактор промпта"
    >
      <PencilLineIcon className="w-3.5 h-3.5" />
    </button>
  )
}

/** (правка 691) Диалог «Исправить промпт»: пользователь описывает, что
 * изменить, — текущий промпт + задание уходят в чат ассистента вкладки
 * (requestImprovePrompt с fixRequest). Тот же UX, что в полноэкранном
 * редакторе, но вызывается прямо из поля ввода.
 *
 * (правка 560b) Закрытие — отдельным тиком, чтобы анимации exit Presence
 * не конфликтовали с другими диалогами в одном React-коммите. */
export function PromptFixDialog({
  open,
  onOpenChange,
  /** (правка 691) Вызывается при отправке задания: parent шлёт промпт +
   * задание в нужный чат (режим/клип). */
  onSubmit,
  hint,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (fixRequest: string) => void
  /** (правка 691) Контекстная подсказка под полем: куда уйдёт задание
   *  (чат вкладки, номер клипа и т.п.). По умолчанию — обобщённая. */
  hint?: string
}) {
  const [text, setText] = useState('')

  // Сброс текста при каждом открытии — задание вводится заново.
  useEffect(() => {
    if (open) setText('')
  }, [open])

  const submit = () => {
    const req = text.trim()
    if (!req) return
    onSubmit(req)
    onOpenChange(false)
    // (правка 560b) закрытие повторным вызовом через отдельный тик —
    // Presence exit-анимации не конфликтуют с другими диалогами в одном
    // React-коммите.
    setTimeout(() => onOpenChange(false), 50)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg p-0 gap-0">
        <DialogHeader className="px-4 pt-4 pb-2 border-b border-border">
          <DialogTitle className="text-base font-semibold">Исправить промпт</DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">
            Напишите, что бы вы хотели изменить в этом промпте
          </DialogDescription>
        </DialogHeader>
        <div className="p-4 space-y-3">
          <textarea
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                onOpenChange(false)
              } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                submit()
              }
            }}
            rows={4}
            placeholder="Например: сделай камеру статичной, убери дождь, реплику героя — короче…"
            className="w-full resize-none rounded-xl border border-border bg-[var(--surface-2)] px-3.5 py-2.5 text-sm leading-5 text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-violet-500/50"
          />
          <p className="text-[10px] text-muted-foreground/70 leading-relaxed">
            {hint ?? 'Промпт и ваше задание уйдут в чат ассистента этой вкладки — ответ можно будет вставить обратно кнопкой «В промпт». Ctrl+Enter — отправить, Esc — отмена.'}
          </p>
          <div className="flex items-center justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Отмена
            </Button>
            <Button
              size="sm"
              onClick={submit}
              disabled={!text.trim()}
              className="gap-1.5 rounded-lg border border-violet-500/30 bg-violet-500/15 text-violet-200 hover:bg-violet-500/25 hover:border-violet-500/50 font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <WandSparklesIcon className="w-3.5 h-3.5" />
              Отправить ассистенту
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
