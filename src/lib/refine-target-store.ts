'use client'

/**
 * RefineTargetStore — мост «галерея → вкладка Refine» + её UI-состояние.
 *
 * Кнопка «В Refine» на карточке видео в галерее кладёт сюда имя файла из
 * общей папки output ComfyUI и шлёт событие 'h3:goto-refine'. RefineView
 * забирает цель (клик происходит ДО монтирования вкладки — как с
 * UpscaleTargetStore, событие «на лету» было бы потеряно).
 *
 * Здесь же живёт UI-состояние вкладки (источник + параметры): вкладки
 * рендерятся с key={activeTab} и размонтируются при переключении, локальное
 * useState терялось — после возврата на вкладку кнопка запуска была
 * недоступна, пока заново не перетащишь видео. Zustand-стор живёт на уровне
 * модуля и переживает размонтирования.
 */
import { create } from 'zustand'

export interface RefineTarget {
  /** Имя файла в папке output ComfyUI. */
  filename: string
  /** Подпапка output (обычно '' — галерея листит корень). */
  subfolder: string
}

/** Источник рефайна: видео из галереи (output) или файл с диска (input/). */
export interface RefineSource {
  url: string
  filename: string
  subfolder: string
  /** Файл с диска, уже загруженный в ComfyUI input/ (через /api/comfy/upload). */
  inputSource?: string
}

/** Параметры вкладки Refine — переживают переключение вкладок. */
export interface RefineUiParams {
  /** (правка 494) 'free' — свободное разрешение в Мп (см. targetMp). */
  target: 'same' | '720' | '1080' | 'free'
  mode: 'whole' | 'chunks'
  chunkSec: '3' | '5' | '8'
  /** '2' = лёгкий ×2-рецепт (BasicScheduler 2 шага, denoise 0.2). */
  steps: '2' | '3' | '4' | '5'
  /** σ_start лестницы («Влияние Refine» в UI), 0.3–0.95. */
  strength: number
  /** (правка 1) Режим размера референсов: 'match' — без апскейла рефа
   *  (дешевле), 'max' — полное разрешение (точнее идентичность). */
  refDetail: 'match' | 'max'
  /** (правка 492) Оставить оригинальный звук (не перегенерировать). */
  keepOriginalAudio: boolean
  /** (правка 494) Цель «Свободное разрешение» в мегапикселях (до 4K =
   *  8.3 Мп); конвертация в короткую сторону — на сервере по реальным
   *  размерам источника (как во вкладке «Генерация», но до 4K). */
  targetMp: number
}

const DEFAULT_PARAMS: RefineUiParams = {
  // (правка 413) Дефолт 'same' (без апскейла): дефолтные 720 молча
  // разгоняли 480p-исходник до ~1.25 Мп (напр. 1120×480 → 1696×736) —
  // рефайн шёл в ~2,3 раза дольше ожидаемого, а пользователь видел
  // «480p тест» в настройках генерации. Повышение — только явным выбором.
  target: 'same',
  mode: 'whole',
  chunkSec: '5',
  steps: '3',
  // (правка 698) Дефолт 90% (σ 0.90) для режима «Целый»: пользователь
  // хочет, чтобы рефайн по умолчанию заметно улучшал картинку. Для режима
  // «Частями» при переключении в refine-view.tsx автоматически ставится 80%.
  strength: 0.9,
  refDetail: 'max', // (правка 1) дефолт Max — требование пользователя
  keepOriginalAudio: false, // (правка 492)
  targetMp: 2.0, // (правка 494)
}

interface RefineTargetState {
  target: RefineTarget | null
  setTarget: (t: RefineTarget) => void
  clear: () => void
  /** UI-состояние вкладки Refine. */
  source: RefineSource | null
  setSource: (s: RefineSource | null) => void
  params: RefineUiParams
  patchParams: (p: Partial<RefineUiParams>) => void
  // (правка 509) Промпт и референсы, вводимые вручную для источника с диска
  // (inputSource — у него нет .meta.json). В сторе, а не в useState вью:
  // вкладка размонтируется при переключении, локальный стейт терялся.
  prompt: string
  setPrompt: (p: string) => void
  userRefs: RefineUserRef[]
  addUserRefs: (items: RefineUserRef[]) => void
  removeUserRef: (id: string) => void
  clearUserRefs: () => void
}

/** (правка 509) Картинка-референс, загруженная пользователем для
 *  источника с диска (залита в ComfyUI input/ через /api/comfy/upload). */
export interface RefineUserRef {
  id: string
  path: string
  name: string
  previewUrl: string
}

export const useRefineTarget = create<RefineTargetState>((set, get) => ({
  target: null,
  setTarget: (target) => set({ target }),
  clear: () => set({ target: null }),
  source: null,
  // (правка 716) blob:URL предыдущего файла с диска ревокаем — каждый
  // перевыбор источника оставлял блоб в памяти до конца сессии (в
  // controlnet-target-store.ts это уже сделано, здесь — нет).
  setSource: (source) => {
    const prev = get().source
    if (prev?.url.startsWith('blob:') && prev.url !== source?.url) {
      try { URL.revokeObjectURL(prev.url) } catch { /* noop */ }
    }
    set({ source })
  },
  params: DEFAULT_PARAMS,
  patchParams: (p) => set((s) => ({ params: { ...s.params, ...p } })),
  prompt: '',
  setPrompt: (prompt) => set({ prompt }),
  userRefs: [],
  addUserRefs: (items) => set((s) => ({ userRefs: [...s.userRefs, ...items] })),
  // (правка 716) Превью удалённых референсов тоже ревокаем — блоб жил до
  // конца сессии.
  removeUserRef: (id) => set((s) => {
    const gone = s.userRefs.find((r) => r.id === id)
    if (gone?.previewUrl?.startsWith('blob:')) {
      try { URL.revokeObjectURL(gone.previewUrl) } catch { /* noop */ }
    }
    return { userRefs: s.userRefs.filter((r) => r.id !== id) }
  }),
  clearUserRefs: () => set((s) => {
    for (const r of s.userRefs) {
      if (r.previewUrl?.startsWith('blob:')) {
        try { URL.revokeObjectURL(r.previewUrl) } catch { /* noop */ }
      }
    }
    return { userRefs: [] }
  }),
}))
