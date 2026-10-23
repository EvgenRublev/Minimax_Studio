'use client'

/**
 * UpscaleTargetStore — мост «галерея → вкладка Upscale».
 *
 * Кнопка «Отправить на апскейл» на превьюшке видео (и drag&drop карточки
 * галереи в поле загрузки Upscale) кладёт сюда имя файла из общей папки
 * output ComfyUI. UpscaleView забирает цель и шлёт её в
 * POST /api/upscale/import — сервер копирует файл в upscale-input
 * напрямую (видео может быть гигабайтами, браузер не участвует).
 *
 * Store нужен, потому что клик происходит ДО монтирования UpscaleView
 * (вкладка меняется), и событие «на лету» было бы потеряно.
 */
import { create } from 'zustand'

export interface UpscaleTarget {
  /** Имя файла в папке output ComfyUI. */
  filename: string
  /** Подпапка output (обычно '' — галерея листит корень). */
  subfolder: string
}

interface UpscaleTargetState {
  target: UpscaleTarget | null
  setTarget: (t: UpscaleTarget) => void
  clear: () => void
}

export const useUpscaleTarget = create<UpscaleTargetState>((set) => ({
  target: null,
  setTarget: (target) => set({ target }),
  clear: () => set({ target: null }),
}))
