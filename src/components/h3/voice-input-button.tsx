'use client'

/**
 * (правка 65/74) VoiceInputButton — круглая кнопка-микрофон ВНУТРИ текстового
 * поля (поверх него, в правом нижнем углу) — как принято в мессенджерах.
 *
 * Клик:
 *  idle       → начать запись (модель STT стартует сама при первом
 *               обращении, если ещё не запущена);
 *  recording  → остановить и расшифровать; текст уходит в onText;
 *  processing → спиннер (расшифровка на CPU может идти десятки секунд).
 *
 * (правка 118) Горячая клавиша R (англ. раскладка) / К (рус. раскладка) —
 * та же физическая клавиша; тоггл диктовки кнопки: нажать — запись,
 * нажать ещё раз — стоп и вставка текста. Не срабатывает при печати в
 * полях ввода и при зажатых Ctrl/Alt/Meta (не ломает Ctrl+R и т.п.).
 *
 * Ошибки показываем тостом на русском — кнопка никогда не «молчит».
 *
 * Позиционирование: родительский контейнер поля обязан быть `relative`;
 * кнопка сама вешается `absolute bottom-2 right-2`. Для использования
 * вне поля (например, тест в настройках) — `variant="inline"`.
 */
import { useEffect, useRef, useState } from 'react'
import { MicIcon, Loader2Icon, SquareIcon } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { useVoiceDictation } from '@/lib/use-voice-dictation'

/* ─── (правка 118) Горячая клавиша: R (англ.) / К (рус.) ───
 * R и К — ОДНА физическая клавиша → ловим e.code === 'KeyR'
 * (независимо от активной раскладки). Слушатель ГЛОБАЛЬНЫЙ, один;
 * владелец — самый свежемонтированный VoiceInputButton с hotkey
 * (верх стека): открыт полноэкранный редактор — клавишу принимает он,
 * закрыт — поле под ним. Если какая-то кнопка уже ведёт запись /
 * расшифровку — клавиша уходит ЕЙ (стоп + вставка), чтобы диктовка
 * не «терялась» по середине. */
interface HotkeyEntry {
  run: () => void
  /** true — инстанс ведёт запись или расшифровку. */
  active: () => boolean
}
const hotkeyStack: HotkeyEntry[] = []
let hotkeyBound = false

function ensureHotkeyBound(): void {
  if (hotkeyBound || typeof window === 'undefined') return
  hotkeyBound = true
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyR' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return
    if (e.isComposing) return
    const t = e.target as HTMLElement | null
    if (
      t &&
      (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')
    ) return
    let pick = hotkeyStack[hotkeyStack.length - 1]
    if (!pick || !pick.active()) {
      const busy = hotkeyStack.find((en) => en.active())
      if (busy) pick = busy
    }
    if (!pick) return
    e.preventDefault()
    pick.run()
  })
}

interface VoiceInputButtonProps {
  /** Куда отправить распознанный текст. */
  onText: (text: string) => void
  disabled?: boolean
  className?: string
  title?: string
  /**
   * 'overlay' (по умолчанию) — круглая кнопка поверх поля ввода
   * (absolute bottom-2 right-2; родитель должен быть relative);
   * 'inline' — статичная круглая кнопка в потоке (тест в настройках).
   */
  variant?: 'overlay' | 'inline'
  /**
   * (правка 118) Включить горячую клавишу R / К (одна физическая клавиша
   * в обеих раскладках): нажать — начать диктовку, нажать ещё раз —
   * остановить и вставить текст. Не срабатывает, пока печатаете в
   * поле (чтобы не мешать набору), и с Ctrl/Alt/Meta.
   */
  hotkey?: boolean
}

export function VoiceInputButton({
  onText,
  disabled,
  className,
  title,
  variant = 'overlay',
  hotkey = false,
}: VoiceInputButtonProps) {
  const { state, start, stop } = useVoiceDictation()
  // (правка 65) Переключатель «Голосовой ввод» в настройках (stt.enabled):
  // раньше кнопки диктовки рисовались всегда, и при выключенном вводе
  // клик давал рантайм-ошибку вместо того, чтобы кнопки исчезли.
  const [sttOn, setSttOn] = useState(true)
  useEffect(() => {
    fetch('/api/config')
      .then((r) => r.json())
      .then((d: { stt_enabled?: boolean }) => setSttOn(d.stt_enabled !== false))
      .catch(() => {})
  }, [])
  const toggleRef = useRef<() => void>(() => {})
  const busyRef = useRef(false)
  busyRef.current = state === 'recording' || state === 'processing'

  const handleClick = async () => {
    if (state === 'processing') return
    if (state === 'recording') {
      // error берём из результата stop(): значение из замыкания (стейта на
      // момент клика) не видит ошибку, установленную внутри stop()
      const { text, error: stopError } = await stop()
      if (text) {
        onText(text)
        toast.success('Голосовой ввод: текст добавлен')
      } else if (stopError) {
        toast.error(stopError)
      }
      return
    }
    if (state === 'idle') {
      try {
        await start()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      }
    }
  }
  // Свежее замыкание для горячей клавиши (ref — стабильный адрес,
  // содержимое обновляется каждый рендер).
  toggleRef.current = handleClick

  // (правка 118) Регистрация в стеке горячей клавиши.
  useEffect(() => {
    if (!hotkey || disabled) return
    ensureHotkeyBound()
    const entry: HotkeyEntry = {
      run: () => { void toggleRef.current() },
      active: () => busyRef.current,
    }
    hotkeyStack.push(entry)
    return () => {
      const i = hotkeyStack.lastIndexOf(entry)
      if (i >= 0) hotkeyStack.splice(i, 1)
    }
  }, [hotkey, disabled])

  const recording = state === 'recording'
  const processing = state === 'processing'
  const hk = hotkey ? ' · R/К' : ''

  // Ввод выключен в настройках — кнопки диктовки не показываем
  // (после всех хуков, чтобы не нарушать правила хуков).
  if (!sttOn) return null

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled || processing}
      title={
        title
        ?? (recording
          ? `Остановить запись${hk ? ` (${hk.trim()})` : ''}`
          : processing
            ? 'Распознавание…'
            : `Голосовой ввод — нажмите и говорите${hk ? ` (горячая клавиша ${hk.trim()})` : ''}`)
      }
      aria-label="Голосовой ввод"
      className={cn(
        'inline-flex items-center justify-center rounded-full border transition-all select-none',
        variant === 'overlay'
          ? 'absolute bottom-2 right-2 z-10 h-8 w-8 shadow-sm backdrop-blur-sm'
          : 'h-8 w-8',
        recording
          ? 'border-red-500/60 bg-red-500/20 text-red-300 animate-pulse'
          : processing
            ? 'border-amber-500/50 bg-amber-500/15 text-amber-300 cursor-wait'
            : 'border-border bg-[var(--surface-2)]/80 text-muted-foreground hover:text-foreground hover:bg-[var(--surface-3)]',
        disabled && 'opacity-40 cursor-not-allowed',
        className,
      )}
    >
      {processing ? (
        <Loader2Icon className="w-4 h-4 animate-spin" />
      ) : recording ? (
        <SquareIcon className="w-3.5 h-3.5 fill-current" />
      ) : (
        <MicIcon className="w-4 h-4" />
      )}
    </button>
  )
}
