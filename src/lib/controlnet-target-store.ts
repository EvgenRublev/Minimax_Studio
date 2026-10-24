'use client'

/**
 * ControlNetTargetStore — мост «галерея → вкладка ControlNet»
 * + её UI-состояние.
 *
 * (правка 511) ControlNet теперь полностью на стандартном References-воркфлоу:
 *  • Тип контроля: depth | canny | direct (новый «Прямой» — видео идёт как реф
 *    напрямую, без карт глубины/кэнни);
 *  • Дефолт «Рефы: режим размера» — Max (было Match);
 *  • Доп. параметры: шаги (draft: 1, full: 2), сэмплер + планировщик (Pass 1),
 *    Sigma-профиль + сэмплер (Pass 2), low-res разрешение (Pass 1) — как на
 *    вкладке «Генерация»;
 *  • Сжатие исходника до 480p — работает во всех режимах (правка 511).
 */
import { create } from 'zustand'
import type { ControlNetType } from '@/lib/comfy/controlnet-template'

export interface ControlNetTarget {
  filename: string
  subfolder: string
}

export interface ControlNetSource {
  url: string
  filename: string
  subfolder: string
  /** Файл с диска, уже загруженный в ComfyUI input/. */
  inputSource?: string
}

/** Параметры вкладки ControlNet — переживают переключение вкладок. */
export interface ControlNetUiParams {
  /** Тип контроля: depth | canny | direct (прямой, без карт). */
  controlType: ControlNetType
  /** Длительность генерации, секунды (клампится к длине исходника). */
  duration: number
  /** Короткая сторона генерации, px. Default 720. */
  targetShortSide: number
  /** «Только карта»: сохранить depth/canny-видео без генерации Minimax.
   *  В режиме direct недоступно (карта не строится). */
  preprocessOnly: boolean
  /** Рефы: режим размера входных картинок. Дефолт — 'max' (правка 511). */
  refImageSize: 'match' | 'max'
  /** 'draft' — однопроходный; 'full' — двухпроходный. */
  pipeline: 'draft' | 'full'
  /** Сжать исходное видео до 480p (сервер, кэш) — во всех режимах (правка 511). */
  compressSource: boolean

  // ── Доп. параметры (правка 511) — как на вкладке «Генерация» ──
  /** Draft pipeline: шаги единственного прохода (default 4, min 2, max 30). */
  draftSteps: number
  /** Full pipeline, Pass 1: эффективные шаги (SplitSigmas split, default 6). */
  firstSamplerSteps: number
  /**
   * ВСЕГО шагов в расписании BasicScheduler для pass 1.
   * По умолчанию 6 — столько же, сколько забирает сплит («6 из 6»).
   */
  firstSamplerTotalSteps?: number
  /** Pass 1 sampler (default 'euler'). */
  pass1Sampler: string
  /** Pass 1 scheduler (default 'simple'). */
  pass1Scheduler: string
  /** Pass 2 sigma profile: '3step' | '4step' | '5step' | '6step' | '7step'. */
  sigmaVariant: string
  /** Pass 2 sampler (default 'euler'). */
  pass2Sampler: string
  /** Full pipeline, Pass 1 low-res разрешение, MP (default 0.2). */
  lowResMP: number
}

const DEFAULT_PARAMS: ControlNetUiParams = {
  controlType: 'depth',
  duration: 5,
  targetShortSide: 720,
  preprocessOnly: false,
  refImageSize: 'max', // (правка 511) было 'match'
  pipeline: 'draft',
  compressSource: true, // (правка 512) default ON — во всех режимах
  draftSteps: 4,
  firstSamplerSteps: 6,
  firstSamplerTotalSteps: 6,
  pass1Sampler: 'euler',
  pass1Scheduler: 'simple',
  sigmaVariant: '3step',
  pass2Sampler: 'euler',
  lowResMP: 0.2,
}

/** Картинка-референс вкладки ControlNet (персонаж/локация/кадр). */
export interface ControlNetRefImage {
  id: string
  path: string
  name: string
  previewUrl: string
}

interface ControlNetState {
  target: ControlNetTarget | null
  setTarget: (t: ControlNetTarget) => void
  clear: () => void
  source: ControlNetSource | null
  setSource: (s: ControlNetSource | null) => void
  /**
   * (правка 727) Папка результата — как на вкладке «Генерация». По умолчанию
   * совпадает с папкой исходника ('' = общая), пользователь может сменить.
   */
  outputFolder: string
  setOutputFolder: (folder: string) => void
  params: ControlNetUiParams
  patchParams: (p: Partial<ControlNetUiParams>) => void
  prompt: string
  setPrompt: (p: string) => void
  seed: number
  setSeed: (n: number) => void
  refImages: ControlNetRefImage[]
  addRefImages: (items: ControlNetRefImage[]) => void
  removeRefImage: (id: string) => void
}

export const useControlNetTarget = create<ControlNetState>((set, get) => ({
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
    // (правка 727) Новый исходник — папка результата снова его папка.
    set({ source, outputFolder: source?.subfolder ?? '' })
  },
  outputFolder: '',
  setOutputFolder: (outputFolder) => set({ outputFolder }),
  params: DEFAULT_PARAMS,
  patchParams: (p) => set((s) => ({ params: { ...s.params, ...p } })),
  prompt: '',
  setPrompt: (prompt) => set({ prompt }),
  seed: -1,
  setSeed: (seed) => set({ seed }),
  refImages: [],
  addRefImages: (items) => set((s) => ({ refImages: [...s.refImages, ...items] })),
  // (правка 716) Превью удалённого референса ревокаем — блоб жил до конца
  // сессии.
  removeRefImage: (id) => set((s) => {
    const gone = s.refImages.find((r) => r.id === id)
    if (gone?.previewUrl?.startsWith('blob:')) {
      try { URL.revokeObjectURL(gone.previewUrl) } catch { /* noop */ }
    }
    return { refImages: s.refImages.filter((r) => r.id !== id) }
  }),
}))