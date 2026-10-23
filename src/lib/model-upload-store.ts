/**
 * (правка 104) Общие состояние загрузки моделей/LoRAs для всех панелей.
 *
 * ЗАЧЕМ: раньше `uploading`/`uploadProgress` жили в useState компонента
 * (DiffusionModelSelector, LoraSettingsPanel) внутри Radix-диалога
 * настроек. Radix при закрытии размонтирует содержимое диалога —
 * прогресс-бар исчезал, пользователь видел «загрузка прервалась»
 * (а из-за OOM-бага на сервере она реально умирала — правки 102/103).
 *
 * Теперь состояние в модульном zustand-store (вне React-дерева):
 * закрытие и повторное открытие окна настроек НЕ сбрасывает прогресс и
 * НЕ прерывает загрузку — XHR живёт в промисе вне компонента, а
 * индикатор подхватывается новым экземпляром панели.
 */
import { create } from 'zustand'

/** Куда грузится файл — чтобы панели могли показывать «уже идёт загрузка» своей цели. */
export type UploadTarget = 'diffusion' | 'lora'

interface ModelUploadState {
  /** Идёт ли сейчас загрузка (любой цели). */
  active: boolean
  /** Целевая папка текущей загрузки. */
  target: UploadTarget | null
  /** Прогресс 0–100. */
  progress: number
  /** Имя файла, который грузится (для индикатора). */
  fileName: string | null

  start: (target: UploadTarget, fileName: string) => void
  setProgress: (pct: number) => void
  done: () => void
}

export const useModelUploadStore = create<ModelUploadState>((set) => ({
  active: false,
  target: null,
  progress: 0,
  fileName: null,

  start: (target, fileName) =>
    set({ active: true, target, fileName, progress: 0 }),

  setProgress: (pct) => set({ progress: Math.min(100, Math.max(0, Math.round(pct))) }),

  done: () => set({ active: false, target: null, progress: 0, fileName: null }),
}))
