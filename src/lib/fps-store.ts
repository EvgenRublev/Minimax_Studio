'use client'

/**
 * FpsStore — мост «галерея → вкладка FPS» + UI-состояние. (правка 268)
 *
 * Аналогичен TileUpscaleTargetStore: кнопка в галерее кладёт цель сюда и шлёт
 * событие 'h3:goto-fps'. FpsView забирает цель.
 *
 * Параметры двух режимов frame interpolation (Fannovel16/ComfyUI-Frame-Interpolation):
 *   RIFE VFI  — быстрый, мало VRAM; параметры: ckpt_name, multiplier, batch_size,
 *               scale_factor, dtype, fast_mode, ensemble, clear_cache_after_n_frames.
 *   FILM VFI  — для крупных движений; параметры: ckpt_name, multiplier,
 *               clear_cache_after_n_frames.
 */
import { create } from 'zustand'

export interface FpsTarget {
  filename: string
  subfolder: string
}

export interface FpsSource {
  url: string
  filename: string
  subfolder: string
  /** Файл с диска, уже загруженный в ComfyUI input/. */
  inputSource?: string
}

/** Режим VFI: RIFE VFI (быстрый) / FILM VFI (крупные движения). */
export type FpsMode = 'rife' | 'film'

/** Параметры вкладки FPS — переживают переключение вкладок. */
export interface FpsUiParams {
  /** Режим: 'rife' | 'film'. Default 'rife'. */
  mode: FpsMode
  /** Множитель FPS: 2 | 3 | 4. Default 2. */
  multiplier: number
  // (правка 269) rifeModel/filmModel удалены: по одной модели на режим,
  // зафиксированы в fps-template.ts (rife49.pth / film_net_fp32.pt) и
  // скачиваются в Настройках → Модели.
  /** RIFE batch_size (1–64). Default 4. */
  rifeBatchSize: number
  /** RIFE scale_factor: 0.25 | 0.5 | 1 | 2 | 4. Default 1. */
  rifeScale: number
  /** RIFE dtype: float32 | float16 | bfloat16. Default 'float16' (экономия VRAM). */
  rifeDtype: string
  /** RIFE fast_mode. Default false (качество). */
  rifeFastMode: boolean
  /** RIFE ensemble. Default true (качество). */
  rifeEnsemble: boolean
  /** Анти-OOM: меньше = меньше пик VRAM, медленнее. Default 4. */
  clearCacheAfterNFrames: number
}

const DEFAULT_PARAMS: FpsUiParams = {
  mode: 'rife',
  multiplier: 2,
  rifeBatchSize: 4,
  rifeScale: 1,
  rifeDtype: 'float16',
  rifeFastMode: false,
  rifeEnsemble: true,
  clearCacheAfterNFrames: 4,
}

interface FpsState {
  target: FpsTarget | null
  setTarget: (t: FpsTarget) => void
  clear: () => void
  source: FpsSource | null
  setSource: (s: FpsSource | null) => void
  params: FpsUiParams
  patchParams: (p: Partial<FpsUiParams>) => void
}

export const useFpsTarget = create<FpsState>((set, get) => ({
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
