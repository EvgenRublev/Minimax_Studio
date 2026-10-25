'use client'

/**
 * TileUpscaleTargetStore — мост «галерея → вкладка Tile Upscale» + её UI-состояние.
 *
 * Аналогичен RefineTargetStore: кнопка в галерее кладёт цель сюда и шлёт
 * событие 'h3:goto-tile-upscale'. TileUpscaleView забирает цель.
 */
import { create } from 'zustand'

export interface TileUpscaleTarget {
  filename: string
  subfolder: string
}

export interface TileUpscaleSource {
  url: string
  filename: string
  subfolder: string
  /** Файл с диска, уже загруженный в ComfyUI input/. */
  inputSource?: string
}

/** Параметры вкладки Tile Upscale — переживают переключение вкладок. */
export interface TileUpscaleUiParams {
  /** Короткая сторона целевого разрешения: 720|1080|1440|2160. Default 1080. (правка 265) */
  targetResolution: number
  /** Уровень денойза 0–1. Default 0.1. */
  denoise: number
  /** Количество шагов. Default 2. */
  steps: number
  /** Размер тайла в пикселях (multiple of 32). Количество тайлов — авто. */
  tileSize: number
  /** Пространственное перекрытие, px. */
  overlap: number
  /** Ширина фейда, px. */
  fade: number
  /** Длина временного куска, кадры. */
  chunkFrames: number
  /** Временное перекрытие, кадры. */
  temporalOverlap: number
  /** Anchor strength 0–1. */
  anchorStrength: number
  /** (правка 481) SyncTile: per-step синхронизация тайлов (швы без мерцания). */
  syncTiles: boolean
}

const DEFAULT_PARAMS: TileUpscaleUiParams = {
  targetResolution: 1080,
  denoise: 0.1,
  steps: 2,
  tileSize: 768,
  overlap: 128,
  fade: 64,
  chunkFrames: 136,
  temporalOverlap: 34,
  anchorStrength: 0.999,
  syncTiles: true,
}

interface TileUpscaleState {
  target: TileUpscaleTarget | null
  setTarget: (t: TileUpscaleTarget) => void
  clear: () => void
  source: TileUpscaleSource | null
  setSource: (s: TileUpscaleSource | null) => void
  params: TileUpscaleUiParams
  patchParams: (p: Partial<TileUpscaleUiParams>) => void
}

export const useTileUpscaleTarget = create<TileUpscaleState>((set, get) => ({
  target: null,
  setTarget: (target) => set({ target }),
  clear: () => set({ target: null }),
  source: null,
  // (правка 558) blob:URL предыдущего файла с диска ревокаем — каждый
  // перевыбор источника оставлял блоб в памяти до конца сессии.
  setSource: (source) => {
    const prev = get().source
    if (prev?.url.startsWith('blob:') && prev.url !== source?.url) {
      try { URL.revokeObjectURL(prev.url) } catch { /* noop */ }
    }
    set({ source })
  },
  params: DEFAULT_PARAMS,
  patchParams: (p) => set((s) => ({ params: { ...s.params, ...p } })),
}))
