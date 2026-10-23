'use client'

/**
 * FaceRefineTargetStore — мост «галерея → вкладка Face Refine» + её UI-состояние.
 *
 * Аналогичен TileUpscaleTargetStore: кнопка в галерее кладёт цель сюда и шлёт
 * событие 'h3:goto-face-refine'; FaceRefineView забирает цель.
 */
import { create } from 'zustand'
import type {
  FaceIdentityModel,
  FacePasteRegion,
  FaceSelectMode,
  FaceUndetected,
} from '@/lib/comfy/face-refine-template'

export interface FaceRefineTarget {
  filename: string
  subfolder: string
}

export interface FaceRefineSource {
  url: string
  filename: string
  subfolder: string
  /** Файл с диска, уже загруженный в ComfyUI input/. */
  inputSource?: string
}

/** Референс лица «этого конкретного человека» — файл в ComfyUI input/. */
export interface FaceIdentityRef {
  /** Имя файла в ComfyUI input/ — его и подаём в ноду. */
  name: string
  /** Превью в интерфейсе (data-URL или URL из input/). */
  previewUrl: string
}

/**
 * (правка 723) Точка на лице, указанная кликом по кадру исходника.
 *
 * Координаты — в пикселях САМОГО ВИДЕО (не элемента в браузере), как их ждёт
 * нода в X/Y. `frame` — номер кадра, на котором сделан клик: нода меряет
 * расстояние до центров лиц именно на нём, а дальше ведёт это лицо
 * непрерывностью.
 */
export interface FaceRefinePoint {
  x: number
  y: number
  frame: number
}

export interface FaceRefineUiParams {
  /** Канва H3, px. 512 дешевле 768 в 2.25× по latent-токенам. */
  canvas: number
  /** Базовый denoise. H3 — flow matching со сдвигом 12: 0.25 → sigma 0.800. */
  denoise: number
  /** Шаги сэмплирования (должны совпадать с турбо-лорой). */
  steps: number
  /** Правило выбора субъекта. */
  select: FaceSelectMode
  /** Номер лица в рейтинге правила (0-based). */
  selectIndex: number
  /** Чем сравнивать лица при выборе по референсу. */
  identityModel: FaceIdentityModel
  /** Держать одного субъекта через толпу. */
  identityTrack: boolean
  /** Сторона кропа как кратное высоты лица. */
  cropFactor: number
  /** Порог детектора лиц. */
  confidence: number
  /** Что вклеивать обратно. */
  pasteRegion: FacePasteRegion
  /** Размытие края вклейки, px исходника. */
  feather: number
  /** Колор-матч вклейки. */
  colourMatch: number
  /** Общая непрозрачность вклейки. */
  blend: number
  /** Что делать с кадрами без найденного лица. */
  undetectedFrames: FaceUndetected
  /**
   * (правка 722) «Далёкие планы»: на кадрах без лица искать человека и брать
   * голову от его бокса (fallback_detector). Нужна модель person_yolov8m-seg.
   */
  fallback: boolean
  /** Множитель denoise для самых мелких лиц. */
  denoiseSmall: number
  /** Множитель denoise для крупных лиц. */
  denoiseLarge: number
}

const DEFAULT_PARAMS: FaceRefineUiParams = {
  canvas: 512,
  denoise: 0.35,
  steps: 4,
  select: 'largest_face',
  selectIndex: 0,
  identityModel: 'insightface',
  identityTrack: true,
  cropFactor: 2.5,
  confidence: 0.35,
  pasteRegion: 'face_only',
  feather: 6,
  colourMatch: 1,
  blend: 1,
  undetectedFrames: 'fade_out',
  fallback: true,
  denoiseSmall: 1,
  denoiseLarge: 0.35,
}

interface FaceRefineState {
  target: FaceRefineTarget | null
  setTarget: (t: FaceRefineTarget) => void
  clear: () => void
  source: FaceRefineSource | null
  setSource: (s: FaceRefineSource | null) => void
  identityRef: FaceIdentityRef | null
  setIdentityRef: (r: FaceIdentityRef | null) => void
  /** (правка 723) Клик по лицу в превью исходника. */
  facePoint: FaceRefinePoint | null
  setFacePoint: (p: FaceRefinePoint | null) => void
  params: FaceRefineUiParams
  patchParams: (p: Partial<FaceRefineUiParams>) => void
}

export const useFaceRefineTarget = create<FaceRefineState>((set, get) => ({
  target: null,
  setTarget: (target) => set({ target }),
  clear: () => set({ target: null }),
  source: null,
  setSource: (source) => {
    const prev = get().source
    if (prev?.url.startsWith('blob:') && prev.url !== source?.url) {
      try { URL.revokeObjectURL(prev.url) } catch { /* noop */ }
    }
    set({ source })
  },
  identityRef: null,
  setIdentityRef: (identityRef) => set({ identityRef }),
  facePoint: null,
  setFacePoint: (facePoint) => set({ facePoint }),
  params: DEFAULT_PARAMS,
  patchParams: (p) => set((s) => ({ params: { ...s.params, ...p } })),
}))
