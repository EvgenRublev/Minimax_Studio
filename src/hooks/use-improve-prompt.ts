'use client'

/**
 * useImprovePrompt — single entry point for "Исправить промпт" (правка 560:
 * раньше «Улучшить промпт»; из редактора промпта запрос теперь идёт ПАРНО —
 * задание пользователя «что изменить» (fixRequest) + сам черновик).
 *
 * Queues the improve-prompt request in the assistant-chats store (so it
 * survives a tab switch), then asks the app shell to open the assistant
 * panel (правка 442: правая панель на «Генерации»/«Продлении», не вкладка).
 * AssistantView picks it up on mount and auto-runs the completion.
 *
 * (правка 427) Режимы: 'generate' (по умолчанию, черновик вкладки
 * «Генерация»), 'extend' (промпт клипа на карточке вкладки «Продление»),
 * 'controlnet' (промпт вкладки «ControlNet», правка 502). Запрос всегда
 * идёт в существующий чат своего режима (правка 559) и переключает фильтр
 * чатов на этот режим.
 */
import { useCallback } from 'react'
import { useAssistantChats, type AssistantChatMode } from '@/lib/assistant-chats-store'

/** (правка 427) Опции исправления: режим чата и номер клипа (extend). */
export interface ImprovePromptOptions {
  mode?: AssistantChatMode
  /** Extend: номер карточки клипа (1-based) — цитируется в сообщении. */
  clipNumber?: number
  /** (правка 560) Конкретное задание пользователя «что изменить» из окна
   *  «Исправить промпт» в редакторе — цитируется в сообщении первым,
   *  чтобы LLM правела именно его, сохраняя остальной смысл промпта. */
  fixRequest?: string
}

/** Build the user-facing prompt text. */
export function buildImprovePrompt(currentPrompt: string, opts?: ImprovePromptOptions): string {
  const trimmed = currentPrompt.trim()
  const fix = opts?.fixRequest?.trim()
  // (правка 560) Задание пользователя — первой строкой, с требованием не
  // трогать всё, чего задание не касается.
  const fixLine = fix ? `Задание: «${fix}».\nВсё, чего задание НЕ касается, сохрани без изменений.\n` : ''
  // (правка 427) Extend: цитируем промпт КЛИПА с его номером; пустой промпт —
  // просим придумать с нуля по контексту исходника (он в системном промпте
  // extend-чата: мета .meta.json + референсы продления).
  if (opts?.mode === 'extend') {
    const n = opts.clipNumber ?? 1
    return trimmed
      ? `${fixLine}Исправь промпт клипа ${n}, сохранив смысл. Текущий промпт клипа:\n\n${trimmed}`
      : `Придумай промпт для клипа ${n} с нуля по контексту исходного видео и референсов продления (они в системном контексте).${fix ? ` Задание: «${fix}».` : ''}`
  }
  // (правка 502) ControlNet: движение/камера задаёт контрольное видео —
  // исправляем ТОЛЬКО описание сцены/внешности/стиля/света/звука.
  if (opts?.mode === 'controlnet') {
    return trimmed
      ? `${fixLine}Исправь мой промпт для режима ControlNet, сохранив смысл. Движение и камеру НЕ описывай — их задаёт контрольное видео; в промпте только сцена, внешность персонажей, стиль, свет и звук. Референсы — тегами <Picture N>. Текущий промпт:\n\n${trimmed}`
      : 'Придумай промпт для режима ControlNet с нуля: движение и камеру задаёт контрольное видео (оно в системном контексте), опиши только сцену, внешность персонажей, стиль, свет и звук. Если прикреплены референсы — ссылайся на них тегами <Picture N>.'
  }
  return trimmed
    ? `${fixLine}Исправь мой текущий промпт, сохранив смысл. Текущий промпт:\n\n${trimmed}`
    : 'Предложи 3 разных идеи для короткого видео (5–8 секунд) с референсами, которые я прикреплю.'
}

/**
 * Queue an improve-prompt request and switch to the assistant tab.
 * Safe to call from anywhere (the store is a module singleton).
 *
 * (правка 559) Раньше КАЖДЫЙ improve-запрос создавал новый чат — чаты
 * плодились от каждой кнопки «Улучшить промпт» (редактор промпта, карточка
 * клипа, ControlNet). Теперь запрос идёт в ТОТ ЖЕ чат режима, что и быстрая
 * кнопка панели: активный чат режима (тот, что открыт в панели вкладки),
 * иначе самый свежий чат этого режима; новый чат — только если чатов
 * режима ещё нет. Контекст запроса (режим + номер клипа) по-прежнему
 * цитируется в самом сообщении.
 */
export function requestImprovePrompt(currentPrompt: string, opts?: ImprovePromptOptions): void {
  if (typeof window === 'undefined') return

  const mode: AssistantChatMode = opts?.mode ?? 'generate'
  const content = buildImprovePrompt(currentPrompt, opts)
  // (правка 266) id чата проносим в pendingImprove: если AssistantView уже
  // смонтирован, improve должен выполниться именно в ЭТОМ чате (подписка на
  // pendingImprove в view перезапускает эффект автозапуска).
  // (правка 427) Фильтр списка чатов переключается на режим запроса —
  // иначе чат режима был бы скрыт фильтром другого режима.
  const st = useAssistantChats.getState()
  st.setAssistantMode(mode)
  // (правка 559) Переиспользуем существующий чат режима вместо создания
  // нового. Список чатов отсортирован по updatedAt (свежие сверху) —
  // fallback-ветка берёт самый свежий чат режима.
  const active = st.chats.find((c) => c.id === st.activeChatId)
  const chatId =
    active && active.mode === mode
      ? active.id
      : (st.chats.find((c) => c.mode === mode)?.id ?? st.createChat(mode))
  st.queueImprove(content, chatId)

  // (правка 442) Вкладки «Ассистент» больше нет: просим app-shell переключиться
  // на вкладку нужного режима и развернуть правую панель ассистента.
  window.dispatchEvent(new CustomEvent('h3:open-assistant-panel', { detail: { mode } }))
}

/**
 * Hook wrapper (so callers can memoize if needed). Returns a stable callback.
 */
export function useImprovePrompt() {
  return useCallback(
    (currentPrompt: string, opts?: ImprovePromptOptions) => {
      requestImprovePrompt(currentPrompt, opts)
    },
    [],
  )
}
