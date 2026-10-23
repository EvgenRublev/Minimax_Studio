'use client'

/**
 * (правка 369) ExtendTargetStore — мост «галерея → вкладка Продление».
 *
 * Пункт «Продлить» в меню действий карточки видео в галерее кладёт сюда
 * имя файла из общей папки output ComfyUI и шлёт событие 'h3:goto-extend'.
 * ExtendView забирает цель и импортирует видео через importGalleryVideo
 * (POST /api/extend/import — сервер копирует output → input).
 *
 * Store нужен, потому что клик происходит ДО монтирования ExtendView
 * (вкладка меняется), и событие «на лету» было бы потеряно.
 * Паттерн повторяет UpscaleTargetStore / RefineTargetStore.
 */
import { create } from 'zustand'

export interface ExtendTarget {
  /** Имя файла в папке output ComfyUI. */
  filename: string
  /** Подпапка output (обычно '' — галерея листит корень). */
  subfolder: string
}

interface ExtendTargetState {
  target: ExtendTarget | null
  setTarget: (t: ExtendTarget) => void
  clear: () => void
}

export const useExtendTarget = create<ExtendTargetState>((set) => ({
  target: null,
  setTarget: (target) => set({ target }),
  clear: () => set({ target: null }),
}))
