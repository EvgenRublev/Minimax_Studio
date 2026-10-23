/**
 * (правка 256) Черновик ассистента, живущий ДОЛЬШЕ компонента.
 *
 * Жалоба с YouTube: написал промпт в окне ассистента, вставил референсы,
 * переключился на вкладку «Генерация» — вернулся, а черновик пуст. Причина:
 * вкладки рендерятся с key={activeTab} внутри AnimatePresence и размонтируются,
 * а input/attachment были локальными useState. Zustand-стор живёт в памяти
 * процесса всё время сессии — черновик переживает переключение вкладок.
 * (На диск не пишем — File-объекты всё равно несериализуемы.)
 */
import { create } from 'zustand'

/** Вложение чата: файл + превью (см. assistant-view). */
export interface AssistantDraftAttachment {
  file: File
  previewUrl: string
  name: string
  kind: 'image' | 'video'
}

interface AssistantDraftState {
  /** Текст в поле ввода ассистента. */
  input: string
  /** Незавершённое вложение (картинка/видео до отправки). */
  attachment: AssistantDraftAttachment | null
  setInput: (v: string) => void
  setAttachment: (a: AssistantDraftAttachment | null) => void
}

export const useAssistantDraft = create<AssistantDraftState>((set) => ({
  input: '',
  attachment: null,
  setInput: (v) => set({ input: v }),
  setAttachment: (a) => set({ attachment: a }),
}))
