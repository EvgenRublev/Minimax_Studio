/**
 * Assistant chats store (Zustand, persisted to localStorage) — правка 30.
 *
 * Multiple named conversations with the local LLM assistant:
 *   - chats survive reloads / tab switches;
 *   - the active chat is restored on mount;
 *   - the title auto-derives from the first user message;
 *   - the model "remembers" a chat because the whole (capped) message
 *     history is replayed with every request — see assistant-view.tsx.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface AssistantChatMessage {
  role: 'user' | 'assistant'
  content: string
  /** (правка 87) Вложение к сообщению (изображение/видео для LLM-анализа). */
  attachment?: {
    path: string
    name: string
    kind: 'image' | 'video'
    /** (правка 108) Местоположение файла:
     *  'chat'  = data/chat-attachments/ (изолированное хранилище чата — новое);
     *  'comfy' = ComfyUI/input/ (legacy, правки 86–87) — подаётся через /api/comfy/file.
     *  Поля без src (старые сообщения) рендерятся как legacy. */
    src?: 'chat' | 'comfy'
  }
}

/** (правка 427) Режим чата ассистента: 'generate' — промпт вкладки
 *  «Генерация», 'extend' — промпты клипов вкладки «Продление»,
 *  (правка 502) 'controlnet' — промпт вкладки «ControlNet». Режим чата
 *  НЕ меняется после создания: системный промпт, набор референсов и логика
 *  вставки («В промпт» vs «В клип N») у режимов разные, смешение контекстов
 *  давало бы мусор в ответах модели. */
export type AssistantChatMode = 'generate' | 'extend' | 'controlnet'

export interface AssistantChat {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  /** (правка 427) Режим чата; у старых persisted-чатов поля нет — merge-гард
   *  ниже подставляет 'generate'. */
  mode: AssistantChatMode
  messages: AssistantChatMessage[]
}

const MAX_CHATS = 20
const MAX_MESSAGES_PER_CHAT = 200
/** (правка 267) Лимит длины одного сообщения: лимиты 20×200 не ограничивали
 *  РАЗМЕР — несколько огромных сообщений упирались в квоту localStorage
 *  (QuotaExceededError) и persist молча переставал сохранять чаты. */
const MAX_MESSAGE_CONTENT = 100_000

/** (правка 267) Обрезка контента сообщения до MAX_MESSAGE_CONTENT с пометкой. */
function capContent(content: string): string {
  return content.length > MAX_MESSAGE_CONTENT
    ? content.slice(0, MAX_MESSAGE_CONTENT) + '\n… [сообщение усечено]'
    : content
}

interface AssistantChatsState {
  chats: AssistantChat[]
  activeChatId: string | null
  /**
   * Pending user message to auto-run when the view mounts (e.g. the
   * "Улучшить промпт" flow from the prompt editor). Cleared after run.
   * (правка 266) Несёт id чата, созданного requestImprovePrompt, — improve
   * выполняется именно в нём, а не в текущем активном чате.
   */
  pendingImprove: { chatId: string; content: string } | null
  /** (правка 427) Выбранный режим-фильтр списка чатов («Генерация» /
   *  «Продление»). Persist — да: вкладка ассистента открывается в том же
   *  режиме, в котором её оставили. */
  assistantMode: AssistantChatMode

  /** Create a new empty chat, make it active, return its id.
   *  (правка 427) Режим чата — из аргумента или текущего assistantMode. */
  createChat: (mode?: AssistantChatMode) => string
  /** (правка 427) Переключить режим-фильтр списка чатов. */
  setAssistantMode: (mode: AssistantChatMode) => void
  deleteChat: (id: string) => void
  /** (правка 264) Переименовать чат. Пустое/пробельное имя — no-op. */
  renameChat: (id: string, newTitle: string) => void
  setActiveChat: (id: string) => void
  /** Append a message; auto-titles the chat from the first user message. */
  appendMessage: (id: string, msg: AssistantChatMessage) => void
  clearAll: () => void
  /** Queue an auto-run for the next AssistantView mount. */
  queueImprove: (content: string, chatId: string) => void
  /** Clear the queued auto-run. */
  clearImprove: () => void
}

function newId(): string {
  return `ac_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

function capChats(chats: AssistantChat[]): AssistantChat[] {
  return [...chats]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_CHATS)
}

export const useAssistantChats = create<AssistantChatsState>()(
  persist(
    (set, get) => ({
      chats: [],
      activeChatId: null,
      pendingImprove: null,
      assistantMode: 'generate',

      createChat: (mode) => {
        const id = newId()
        // (правка 427) Режим нового чата: явный аргумент (например, improve
        // с карточки клипа) либо текущий режим-фильтр — «Новый чат» в
        // сайдбаре создаёт чат именно выбранного режима.
        const chatMode: AssistantChatMode = mode ?? get().assistantMode
        set((s) => ({
          chats: capChats([
            { id, title: 'Новый чат', createdAt: Date.now(), updatedAt: Date.now(), mode: chatMode, messages: [] },
            ...s.chats,
          ]),
          activeChatId: id,
        }))
        return id
      },

      setAssistantMode: (mode) => set({ assistantMode: mode }),

      deleteChat: (id) =>
        set((s) => {
          const chats = s.chats.filter((c) => c.id !== id)
          let activeChatId = s.activeChatId
          if (activeChatId === id) {
            activeChatId = chats[0]?.id ?? null
          }
          // (правка 108) Файлы вложений удалённого чата существуют только в чате —
          // удаляем их с диска (best-effort, fire-and-forget). Legacy-файлы
          // в ComfyUI/input/ НЕ трогаем: они могут быть референсами генерации.
          const doomed = s.chats.find((c) => c.id === id)
          if (doomed && typeof window !== 'undefined') {
            for (const m of doomed.messages) {
              const a = m.attachment
              if (a && a.src === 'chat' && typeof a.path === 'string' && a.path) {
                void fetch(
                  `/api/assistant/attachment?filename=${encodeURIComponent(a.path)}`,
                  { method: 'DELETE' },
                ).catch(() => {})
              }
            }
          }
          return { chats, activeChatId }
        }),

      // (правка 264) Переименование: обновляем только title (без updatedAt —
      // иначе чат всплывает наверх списка из-за capChats-сортировки, что
      // дезориентирует при переименовании). Лимит 80 символов.
      renameChat: (id, newTitle) =>
        set((s) => {
          const title = newTitle.trim().slice(0, 80)
          if (!title) return s
          return {
            chats: s.chats.map((c) => (c.id === id ? { ...c, title } : c)),
          }
        }),

      setActiveChat: (id) =>
        set((s) => (s.chats.some((c) => c.id === id) ? { activeChatId: id } : s)),

      appendMessage: (id, msg) =>
        set((s) => ({
          chats: capChats(
            s.chats.map((c) => {
              if (c.id !== id) return c
              const title =
                (c.title === 'Новый чат' || !c.title) && msg.role === 'user'
                  ? msg.content.trim().replace(/\s+/g, ' ').slice(0, 48) || 'Чат'
                  : c.title
              return {
                ...c,
                title,
                updatedAt: Date.now(),
                messages: [...c.messages, { ...msg, content: capContent(msg.content) }].slice(-MAX_MESSAGES_PER_CHAT),
              }
            }),
          ),
        })),

      clearAll: () =>
        set((s) => {
          // (правка 108) «Очистить контент» в настройках = удаление ВСЕХ чатов:
          // удаляем и их файлы вложений из изолированного хранилища
          // (best-effort, как в deleteChat) — иначе останутся сироты на диске.
          if (typeof window !== 'undefined') {
            for (const c of s.chats) {
              for (const m of c.messages) {
                const a = m.attachment
                if (a && a.src === 'chat' && typeof a.path === 'string' && a.path) {
                  void fetch(
                    `/api/assistant/attachment?filename=${encodeURIComponent(a.path)}`,
                    { method: 'DELETE' },
                  ).catch(() => {})
                }
              }
            }
          }
          return { chats: [], activeChatId: null }
        }),

      queueImprove: (content, chatId) => set({ pendingImprove: { chatId, content } }),
      clearImprove: () => set({ pendingImprove: null }),
    }),
    {
      name: 'h3-assistant-chats',
      version: 1,
      partialize: (state) => ({
        chats: state.chats,
        activeChatId: state.activeChatId,
        pendingImprove: state.pendingImprove,
        assistantMode: state.assistantMode, // (правка 427)
      }),
      merge: (persisted, current) => {
        const raw = persisted as AssistantChatsState | null
        let chats: AssistantChat[] = Array.isArray(raw?.chats)
          ? raw.chats.filter(
              (c) =>
                c &&
                typeof c.id === 'string' &&
                Array.isArray(c.messages) &&
                c.messages.every((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'),
            )
          : []
        chats = capChats(chats)
        // (правка 267) Старые персисты без лимита размера — обрезаем при регидратации.
        // (правка 427) Старые персисты без mode — это чаты «Генерации»
        // (extend-режима тогда не существовало).
        chats = chats.map((c) => ({
          ...c,
          mode: typeof c.mode === 'string' ? c.mode : 'generate',
          messages: c.messages.map((m) => ({ ...m, content: capContent(m.content) })),
        }))
        const activeChatId =
          typeof raw?.activeChatId === 'string' && chats.some((c) => c.id === raw.activeChatId)
            ? raw.activeChatId
            : (chats[0]?.id ?? null)
        // (правка 266) pendingImprove — объект { chatId, content }; старые
        // персисты со строкой отбрасываем (без chatId их выполнять некуда).
        const pi = raw?.pendingImprove
        const pendingImprove =
          pi && typeof pi === 'object' &&
          typeof (pi as { chatId?: unknown }).chatId === 'string' &&
          typeof (pi as { content?: unknown }).content === 'string'
            ? (pi as { chatId: string; content: string })
            : null
        // (правка 427) Режим-фильтр из персиста; мусор → 'generate'.
        // (правка 502) Whitelist из трёх режимов (добавлен 'controlnet').
        const assistantMode: AssistantChatMode =
          raw?.assistantMode === 'extend' || raw?.assistantMode === 'controlnet'
            ? raw.assistantMode
            : 'generate'
        return { ...current, chats, activeChatId, pendingImprove, assistantMode }
      },
    },
  ),
)
