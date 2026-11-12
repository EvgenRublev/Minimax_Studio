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
import {
  DEFAULT_IMAGE_TWO_PASS,
  IMAGE_ASPECTS,
  normalizeImageQuality,
  type ImageQualityKey,
  type ImageTwoPassMode,
} from '@/lib/comfy/image-template'

/** Ступени разрешения (0.5…8 МП), см. IMAGE_MEGAPIXELS. */
export type ImageQuality = ImageQualityKey
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
  /**
   * (правка 934) Апсемплер промпта: имя файла p-h3-image_prompt_upsampler_*;
   * '' — выключен (запрос уходит модели как есть).
   */
  upsampler: string
  /**
   * (правка 935) 'off' | 'detail' | 'upscale'. В 'upscale' качество (МП) — это
   * ИТОГ: базовый проход берётся меньше в baseScale раз по стороне.
   */
  twoPass: ImageTwoPassMode
  /** Во сколько раз стороны второго прохода больше базовых. */
  baseScale: number
  /** Сила второго прохода: 0.15 — только зерно/текстура, 0.5 — меняет лицо. */
  denoise2: number
  /** Шаги второго прохода. */
  steps2: number
  /** Добавка к промпту на втором проходе ('' — тот же текст). */
  prompt2: string
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
  upsampler: '',
  twoPass: 'off',
  baseScale: DEFAULT_IMAGE_TWO_PASS.baseScale,
  denoise2: DEFAULT_IMAGE_TWO_PASS.denoise,
  steps2: DEFAULT_IMAGE_TWO_PASS.steps,
  prompt2: '',
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
      // (правка 933) Ступени разрешения расширялись; старое значение из
      // localStorage могло оказаться вне списка — нормализуем при загрузке.
      merge: (persisted, current) => {
        const p = (persisted as { params?: Partial<ImageParams> } | null)?.params
        if (!p) return current
        const aspect = IMAGE_ASPECT_SET.has(p.aspect || '') ? p.aspect! : DEFAULT_IMAGE_PARAMS.aspect
        return {
          ...current,
          ...(persisted as ImageStoreState),
          params: { ...DEFAULT_IMAGE_PARAMS, ...p, aspect, quality: normalizeImageQuality(p.quality) },
        }
      },
    },
  ),
)
