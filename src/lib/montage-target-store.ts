'use client'

/**
 * (правка 855) MontageTargetStore — мост «галерея → вкладка Монтаж».
 *
 * Пункт «В Монтаж» в меню действий карточки видео кладёт сюда имя файла из
 * общей папки output ComfyUI и шлёт событие 'h3:goto-montage' (его page.tsx
 * уже слушает — заготовка правки 720). MontageView забирает цель и добавляет
 * файл следующим клипом на таймлайн.
 *
 * Store нужен, потому что клик происходит ДО монтирования MontageView
 * (вкладка меняется), и событие «на лету» было бы потеряно.
 * Паттерн повторяет ExtendTargetStore / RefineTargetStore.
 */
import { create } from 'zustand'

export interface MontageTarget {
  /** Имя файла в папке output ComfyUI. */
  filename: string
  /** Подпапка output (обычно '' — галерея листит корень). */
  subfolder: string
  /** Истинно — вставить на плейхеде; иначе — в конец таймлайна. */
  atPlayhead?: boolean
}

interface MontageTargetState {
  target: MontageTarget | null
  setTarget: (t: MontageTarget) => void
  clear: () => void
}

export const useMontageTarget = create<MontageTargetState>((set) => ({
  target: null,
  setTarget: (target) => set({ target }),
  clear: () => set({ target: null }),
}))
