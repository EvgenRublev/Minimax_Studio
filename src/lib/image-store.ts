'use client'

/**
 * (правка 929) ImageStore — состояние вкладки «Изображение»: параметры,
 * референсы и список полученных картинок.
 *
 * Параметры персистятся (localStorage + zustand/persist), референсы и
 * результаты — нет: файлы живут в ComfyUI input/, и висящая в UI ссылка на
 * уже удалённый референс была бы хуже, чем пустой список.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { IMAGE_ASPECTS } from '@/lib/comfy/image-template'

export type ImageQuality = '4' | '8'
export type ImageSchedule = 'image8' | 'fast4'

export interface ImageParams {
  prompt: string
  /** Соотношение сторон из IMAGE_ASPECTS. */
  aspect: string
  /** 4 МП (лучше для правок) или 8 МП (лучше для текста). */
  quality: ImageQuality
  /** Сетка сигм: 8 шагов (официальная) или 4 шага (дистиллированная база). */
  schedule: ImageSchedule
  /** 0 — каждый раз новый seed. */
  seed: number
  /** DiT; '' — спросить у сервера (дефолт вкладки). */
  model: string
  /** LoRA поверх DiT; '' — без LoRA (нужен image-DiT). */
  lora: string
  loraStrength: number
  /** '' — дефолт с сервера. */
  textEncoder: string
  /** '' — дефолт с сервера. */
  vae: string
  lowVramAttention: boolean
  chunkFeedForward: boolean
}

export const DEFAULT_IMAGE_PARAMS: ImageParams = {
  prompt: '',
  aspect: '1:1',
  quality: '4',
  schedule: 'image8',
  seed: 0,
  model: '',
  lora: '',
  loraStrength: 1,
  textEncoder: '',
  vae: '',
  lowVramAttention: true,
  chunkFeedForward: true,
}

export interface ImageReference {
  /** Имя файла в ComfyUI/input/ (то, что уйдёт в image_N). */
  name: string
  /** Локальное превью (blob:) или серверный URL для уже загруженных файлов. */
  url: string
  /** true — файл ещё не передан в ComfyUI (staged). */
  staged?: boolean
}

export interface ImageResult {
  filename: string
  subfolder: string
  /** seed/промпт текущего прогона — подписать карточку. */
  prompt?: string
  seed?: number
  createdAt: number
}

interface ImageStoreState {
  params: ImageParams
  references: ImageReference[]
  results: ImageResult[]
  /** Открыть «Дополнительно» (модель/TE/VAE/оптимизация). */
  advancedOpen: boolean

  setParams: (patch: Partial<ImageParams>) => void
  addReferences: (refs: ImageReference[]) => void
  removeReference: (name: string) => void
  clearReferences: () => void
  addResults: (res: ImageResult[]) => void
  clearResults: () => void
  setAdvancedOpen: (open: boolean) => void
}

export const IMAGE_ASPECT_SET = new Set<string>(IMAGE_ASPECTS)

export const useImageStore = create<ImageStoreState>()(
  persist(
    (set) => ({
      params: DEFAULT_IMAGE_PARAMS,
      references: [],
      results: [],
      advancedOpen: false,

      setParams: (patch) => set((s) => ({ params: { ...s.params, ...patch } })),
      addReferences: (refs) =>
        set((s) => {
          const seen = new Set(s.references.map((r) => r.name))
          return { references: [...s.references, ...refs.filter((r) => !seen.has(r.name))] }
        }),
      removeReference: (name) => set((s) => ({ references: s.references.filter((r) => r.name !== name) })),
      clearReferences: () => set({ references: [] }),
      addResults: (res) => set((s) => ({ results: [...res, ...s.results].slice(0, 40) })),
      clearResults: () => set({ results: [] }),
      setAdvancedOpen: (open) => set({ advancedOpen: open }),
    }),
    {
      name: 'image-studio',
      partialize: (s) => ({ params: s.params, advancedOpen: s.advancedOpen }) as ImageStoreState,
    },
  ),
)
