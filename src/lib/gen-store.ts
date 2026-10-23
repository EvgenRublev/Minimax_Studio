/**
 * Persistent store for the generation form values.
 *
 * Uses Zustand + localStorage so that:
 *   - Switching between tabs doesn't lose form state (components unmount on switch)
 *   - Page refresh preserves the last-used parameters
 *   - Generated videos are loaded from ComfyUI's output directory,
 *     not stored here (only references are kept)
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/* ──────────────────────────── Video Gen ──────────────────────────── */

/**
 * One MiniMax H3 ref2va reference (reference manifest entry).
 * `path` is the ComfyUI input/ filename returned by /api/comfy/upload.
 */
export interface VideoRefItem {
  id: string
  kind: 'image' | 'video' | 'audio'
  /** ComfyUI input/ filename. */
  path: string
  /** Original file name (for display). */
  name: string
  /** Local blob URL preview — runtime only, stripped on persist. */
  previewUrl: string
  /** Free text: who/what this reference is (max 500 chars server-side). */
  role: string
  /** Images: how the reference is used by ref2va. */
  imageIntent: 'identity' | 'scene' | 'style' | 'composition'
  /** Videos: include the reference's own audio track. */
  includeAudio: boolean
  /** (правка 493) Videos: сжать до 480p перед подачей в conditioning. */
  compress?: boolean
  /** (правка 302) Audio: обрезка референса, секунды. trimEnd null/0 = до конца.
      Обрезка виртуальная (нода AudioTrim) — копий файла не создаётся. */
  trimStart?: number
  trimEnd?: number | null
  /** (правка 694) Audio: громкость референса 0–1 (default 0.5). Виртуальная
      (нода AudioGain) — без копий файла. */
  audioVolume?: number
}

/** FL2VA start/end frame upload slot. */
export interface VideoFrameSlot {
  /** ComfyUI input/ filename. */
  path: string
  name: string
  /** Local blob URL preview — runtime only, stripped on persist. */
  previewUrl: string
  /** (правка 152) Ширина изображения в пикселях (из первого кадра — для aspect ratio). */
  width?: number
  /** (правка 152) Высота изображения в пикселях. */
  height?: number
}

export interface VideoGenState {
  prompt: string
  seed: number
  /** Selected model_type (single workflow: minimax_h3_ref2va). */
  modelType: string
  /** (правка 146) Режим генерации: 'ref' | 't2v' | 'flf' | 'extend' (правка 161). Default 'ref'. */
  mode: 'ref' | 't2v' | 'flf' | 'extend'
  /** Пайплайн: 'draft' — один проход на low-res канве (быстрый черновик,
   *  апгрейд вкладкой Refine); 'full' — два прохода, как раньше. Default 'full'. */
  pipeline: 'draft' | 'full'
  /** (правка 161) extend: клипы для продления. (правка 587) id — стабильный
   *  ключ карточки (key={i} после удаления из середины переносил внутреннее
   *  состояние MentionTextarea на соседний клип); у старых записей нет. */
  extendClips: Array<{ prompt: string; duration: number; seed: number; id?: string }>
  /** (правка 162) extend: ОТДЕЛЬНЫЕ картинки-рефы для продления (не путать с refs!). */
  extendImageRefs: VideoRefItem[]
  /** (правка 164) extend: имя файла исходного видео в ComfyUI input/ (или staged). */
  extendSourceVideoPath: string
  /** (правка 291) Длительность исходного видео в секундах (ffprobe на клиенте при
   *  выборе/импорте). Показывается в badges и карточках клипов — пользователь
   *  видит, сколько секунд будет по итогу вместе с оригиналом. */
  extendSourceDuration: number
  /** (правка 363) extend: подпапка output, из которой взят источник-ГАЛЕРЕЯ
   *  ('' = корень output). null = источник с диска / не из галереи — тогда
   *  результат продления идёт в outputFolder, как раньше. Источник из галереи
   *  → результат падает в папку оригинала (цепочки продлений не расползаются). */
  extendSourceSubfolder: string | null
  /** (правка 385) extend: ИМЯ файла-оригинала в output/ (до импорта в input/,
   *  где копия получает случайное имя). Вместе с extendSourceSubfolder —
   *  адрес сайдкара исходника: роут по нему резолвит ЛАТЕНТ исходника
   *  (lossless-сид и lossless-часть комбинированного). null = с диска. */
  extendSourceName: string | null
  /** (правка 423) extend: двухпроходный режим (low-res pass 1 → апскейл →
   *  pass 2 рефайн до размера исходника). Default false = один проход. */
  extendTwoPass: boolean
  /** Resolution label — ТОЧНЫЙ номинал (правка 124): "1280x720", "1920x1080", ... */
  resolution: string
  /** Total output frames (H3: 17n+5 grid, min 60 ≈ 2.5 с, правка 138). */
  videoLength: number
  /** ref2va reference detail: 'match' | 'max'. (правка 286) — в режиме продления всегда 'match'. */
  referenceDetail: 'match' | 'max'
  /** FL2VA: first frame (image_prompt_type 'S'). */
  startFrame: VideoFrameSlot | null
  /** FL2VA: last frame (image_prompt_type 'E'). */
  endFrame: VideoFrameSlot | null
  /** ref2va reference manifest entries. */
  refs: VideoRefItem[]
  /** Two-pass latent upscaler: target resolution in MP (0 = auto from quality). */
  finalResolution: number
  /** Free-resolution mode: ignore quality presets, drive finalResolution directly. */
  freeResolution: boolean
  /** Pass 1 low-res resolution in MP (default 0.2). */
  lowResMP: number
  /** Pass 1 effective sampling steps (SplitSigmas split point, default 4, max 30). */
  firstSamplerSteps: number
  /**
   * (правка 719) ВСЕГО шагов в расписании BasicScheduler для pass 1.
   * undefined = авто (firstSamplerSteps × 2) — прежнее поведение «N из 2N».
   * Задаётся отдельно, чтобы можно было взять, например, «6 из 8».
   */
  firstSamplerTotalSteps?: number
  /**
   * (правка 719) Шаги клипа в режиме продления.
   *
   * В Extend это НЕ точка сплита: там один BasicScheduler на клип
   * (steps = это значение, denoise = 1, сплита нет вообще) — смысл другой,
   * чем в генерации. Значение по умолчанию 4 — как в эталонном extend-воркфлоу
   * (docs/Minimax_Studio_Extend_Workflow_420.json: BasicScheduler steps=4).
   * Вынесено в отдельное поле, чтобы смена дефолта точки сплита в
   * генерации не трогала продление.
   */
  extendClipSteps: number
  /** Draft pipeline: direct step count of the single pass (default 4 = turbo-эталон). */
  draftSteps: number
  /** Pass 2 sigma profile: '3step' | '4step' | '5step' | '6step' | '7step'. */
  sigmaVariant: string
  /** (правка 69) Pass 2 sampler (default 'euler'). */
  pass2Sampler: string
  /** (правка 70) Pass 1 sampler (default 'euler'). */
  pass1Sampler: string
  /** (правка 70) Pass 1 scheduler (default 'simple'). */
  pass1Scheduler: string
  /** (правка 70) Влияние турбо-лоры (default 1.0). */
  turboLoraStrength: number
  /** (правка 168) Разреженное внимание (Sol-Attn): ускоряет длинные последовательности. */
  sparseAttention: boolean
  /** (правка 466) Sol-Attn: порог разреженности tau (0–4, default 1.3). */
  sparseTau: number
  /** (правка 466) Sol-Attn: с какой доли шагов включается (0–0.9, default 0.2). */
  sparseStartPercent: number
  /** (правка 466) Sol-Attn: до какой доли шагов работает (0.1–1, default 1.0). */
  sparseEndPercent: number
  /** (правка 466) Sol-Attn: минимум токенов для включения (default 12288 — короткие клипы остаются плотными). */
  sparseMinTokens: number
  /** (правка 466) Sol-Attn: доп. токены контекста (default 256). */
  sparseExtraTokens: number
  /** (правка 301) Veda Sparse Attention: обученный предиктор, для длинных видео. */
  vedaAttention: boolean
  /** (правка 400) Veda: спарсити генерации, 'N%' (50–95, default '90%'). Выше = быстрее, но грубее. */
  vedaGeneratedSparsity: string
  /** (правка 400) Veda: спарсити референсов, 'N%' (0–95, default '90%'). 0% = полное внимание к референсам (точнее лицо, медленнее). */
  vedaReferenceSparsity: string
  /** (правка 400) Veda: 0-based блоки DiT с полным вниманием («0, 1, 47-49»; '' = все sparse). */
  vedaFullAttentionLayers: string
  /** (правка 400) Veda: 0-based шаги сэмплера с полным вниманием («0, 1»; '' = нет). */
  vedaFullAttentionSteps: string
  /** (правка 400) Veda: подробный лог ноды (default false). */
  vedaVerbose: boolean
  /** MiniMaxLowVRAMAttention: head-chunked attention (saves VRAM). */
  lowVramAttention: boolean
  /** MiniMaxChunkFeedForward: chunked FFN for long sequences (saves VRAM). */
  chunkFeedForward: boolean
  /** ChunkFF: number of feed-forward chunks. */
  chunkFFChunks: number
  /** ChunkFF: sequence length threshold above which chunking kicks in. */
  chunkFFThreshold: number
  /** (правка 91) Активная папка галереи: '' = общая, иначе имя подпапки output.
   *  Вкладка «Генерация» фильтрует галерею по ней и складывает новые видео в неё. */
  outputFolder: string
}

export const DEFAULT_VIDEO_STATE: VideoGenState = {
  prompt: '',
  seed: -1,
  modelType: 'minimax_h3_ref2va',
  mode: 'ref', // (правка 146)
  pipeline: 'full', // два прохода (low-res → upscale → Pass 2) по умолчанию
  extendClips: [], // (правка 161) extend: клипы для продления
  extendImageRefs: [], // (правка 162) extend: отдельные картинки-рефы
  extendSourceVideoPath: '', // (правка 164) extend: путь к исходному видео
  extendSourceDuration: 0, // (правка 291) длительность исходника, с (0 = неизвестно)
  extendSourceSubfolder: null, // (правка 363) подпапка галереи-источника (null = с диска)
  extendSourceName: null, // (правка 385) имя файла-оригинала в output/ (null = с диска)
  extendTwoPass: true, // (правка 437) extend: два прохода — default ON (был OFF, правка 423)
  resolution: '854x480', // (правка 138) дефолт 480p 16:9 — быстрее и дешевле в VRAM
  videoLength: 60, // (правка 138) минимум 2.5 с (60 кадров при 24 fps, сетка 17n+5)
  referenceDetail: 'match', // (правка 286) по умолчанию — Match (быстро)
  startFrame: null,
  endFrame: null,
  refs: [],
  finalResolution: 0,
  freeResolution: false,
  lowResMP: 0.2,
  firstSamplerSteps: 6,
  // (правка 719) undefined = авто (firstSamplerSteps × 2) — «N из 2N»,
  // как в эталоне вендора. Явно задаётся, чтобы взять «6 из 8».
  firstSamplerTotalSteps: undefined,
  // (правка 719) Шаги клипа продления — отдельное поле (эталон = 4).
  extendClipSteps: 4,
  draftSteps: 4, // turbo-эталон; минимум 2 — максимально быстрый черновик
  sigmaVariant: '3step',
  pass2Sampler: 'euler',
  pass1Sampler: 'euler',
  pass1Scheduler: 'simple',
  turboLoraStrength: 1.0,
  // (правка 575) SOL-Attn включен по умолчанию; при сбросе к заводским — тоже ON.
  sparseAttention: true,
  sparseTau: 1.3, // (правка 466)
  sparseStartPercent: 0.2, // (правка 466)
  sparseEndPercent: 1.0, // (правка 466)
  sparseMinTokens: 12288, // (правка 466)
  sparseExtraTokens: 256, // (правка 466)
  // (правка 575) Veda по умолчанию и при сбросе к заводским — OFF, SOL-Attn приоритетнее.
  vedaAttention: false,
  vedaGeneratedSparsity: '90%', // (правка 400)
  vedaReferenceSparsity: '90%', // (правка 400)
  vedaFullAttentionLayers: '', // (правка 400)
  vedaFullAttentionSteps: '', // (правка 400)
  vedaVerbose: false, // (правка 400)
  lowVramAttention: true,
  chunkFeedForward: true,
  chunkFFChunks: 2,
  chunkFFThreshold: 4096,
  outputFolder: '',
}

/* ──────────────────────────── Store ──────────────────────────── */

/**
 * Освобождение blob-URL превью. URL.createObjectURL держит файл в памяти,
 * пока URL не отозван (или страница не закрыта) — без отзыва каждое
 * удаление/замена референса копило блобы на всю сессию.
 * Серверные URL (/api/…) не трогаем — отзыв применим только к blob:.
 */
function revokePreview(url?: string): void {
  if (url && url.startsWith('blob:') && typeof URL !== 'undefined' && URL.revokeObjectURL) {
    try { URL.revokeObjectURL(url) } catch { /* уже отозван */ }
  }
}

interface GenStoreState {
  video: VideoGenState

  // Video gen setters
  setVideoPrompt: (v: string) => void
  setVideoSeed: (v: number) => void
  setVideoModel: (v: string) => void
  setVideoResolution: (v: string) => void
  setVideoLength: (v: number) => void
  setVideoReferenceDetail: (v: 'match' | 'max') => void
  setVideoStartFrame: (slot: VideoFrameSlot | null) => void
  setVideoEndFrame: (slot: VideoFrameSlot | null) => void
  addVideoRefs: (items: VideoRefItem[]) => void
  updateVideoRef: (id: string, patch: Partial<Omit<VideoRefItem, 'id'>>) => void
  removeVideoRef: (id: string) => void
  moveVideoRef: (fromIndex: number, toIndex: number) => void
  clearVideoRefs: () => void
  /** Replace several video fields at once (model-change defaults). */
  patchVideo: (patch: Partial<VideoGenState>) => void
}

export const useGenStore = create<GenStoreState>()(
  persist(
    (set) => ({
      video: { ...DEFAULT_VIDEO_STATE },

      // Video gen setters
      setVideoPrompt: (v) => set((s) => ({ video: { ...s.video, prompt: v } })),
      setVideoSeed: (v) => set((s) => ({ video: { ...s.video, seed: v } })),
      setVideoModel: (v) => set((s) => ({ video: { ...s.video, modelType: v } })),
      setVideoResolution: (v) => set((s) => ({ video: { ...s.video, resolution: v } })),
      setVideoLength: (v) => set((s) => ({ video: { ...s.video, videoLength: v } })),
      setVideoReferenceDetail: (v) => set((s) => ({ video: { ...s.video, referenceDetail: v } })),
      // (правка 716) Отзыв blob-URL сравнивается по previewUrl, а НЕ по
      // identity объекта. Раньше `slot !== s.video.startFrame` срабатывал и
      // при эквивалентном, но новом объекте ({...slot}) — и отзывался URL,
      // который новый слот всё ещё показывает (битое превью). В patchVideo
      // (правка 339) это уже исправлено — здесь тоже.
      setVideoStartFrame: (slot) =>
        set((s) => {
          if (s.video.startFrame && s.video.startFrame.previewUrl !== slot?.previewUrl) {
            revokePreview(s.video.startFrame.previewUrl)
          }
          return { video: { ...s.video, startFrame: slot } }
        }),
      setVideoEndFrame: (slot) =>
        set((s) => {
          if (s.video.endFrame && s.video.endFrame.previewUrl !== slot?.previewUrl) {
            revokePreview(s.video.endFrame.previewUrl)
          }
          return { video: { ...s.video, endFrame: slot } }
        }),
      addVideoRefs: (items) =>
        set((s) => ({ video: { ...s.video, refs: [...s.video.refs, ...items] } })),
      updateVideoRef: (id, patch) =>
        set((s) => ({
          video: {
            ...s.video,
            refs: s.video.refs.map((r) => {
              if (r.id !== id) return r
              if (patch.previewUrl && patch.previewUrl !== r.previewUrl) revokePreview(r.previewUrl)
              return { ...r, ...patch }
            }),
          },
        })),
      removeVideoRef: (id) =>
        set((s) => {
          const removed = s.video.refs.find((r) => r.id === id)
          if (removed) revokePreview(removed.previewUrl)
          return { video: { ...s.video, refs: s.video.refs.filter((r) => r.id !== id) } }
        }),
      moveVideoRef: (fromIndex, toIndex) =>
        set((s) => {
          const refs = [...s.video.refs]
          if (fromIndex < 0 || fromIndex >= refs.length || toIndex < 0 || toIndex >= refs.length) return s
          const [moved] = refs.splice(fromIndex, 1)
          refs.splice(toIndex, 0, moved)
          return { video: { ...s.video, refs } }
        }),
      clearVideoRefs: () =>
        set((s) => {
          for (const r of s.video.refs) revokePreview(r.previewUrl)
          return { video: { ...s.video, refs: [] } }
        }),
      patchVideo: (patch) =>
        set((s) => {
          // Полная замена списков/слотов патчем (restore-from-meta) — отзываем
          // blob-URL того, что не переехало в новый список
          if (patch.refs) {
            const kept = new Set(patch.refs.map((r) => r.previewUrl))
            for (const r of s.video.refs) {
              if (!kept.has(r.previewUrl)) revokePreview(r.previewUrl)
            }
          }
          // (правка 339) Отзываем previewUrl только если у нового слота
          // ДРУГОЙ URL — иначе patch с тем же blob отзывал превью, которое
          // продолжает показываться новым слотом (битая картинка).
          if (patch.startFrame !== undefined && patch.startFrame?.previewUrl !== s.video.startFrame?.previewUrl) {
            revokePreview(s.video.startFrame?.previewUrl)
          }
          if (patch.endFrame !== undefined && patch.endFrame?.previewUrl !== s.video.endFrame?.previewUrl) {
            revokePreview(s.video.endFrame?.previewUrl)
          }
          return { video: { ...s.video, ...patch } }
        }),
    }),
    {
      name: 'h3-gen-store',
      // (правка 340) version 3: миграция draftSteps 8→4 перенесена из merge
      // (она срабатывала при КАЖДОЙ ре-гидратации и стирала осознанный выбор
      // пользователя «8 шагов») в разовый migrate по версии persist.
      // (правка 449) version 6: Veda снова default OFF (отмена правки 425).
      // (правка 719) version 7: новый дефолт точки сплита pass 1 = 6
      // (при авто-правиле «всего = 2× сплита» это «6 из 12»).
      version: 7,
      // (правка 97) Новый дефолт шагов pass 1 = 4 (был 2).
      // Сбрасываем только значение, равное старому дефолту (2), — оно означает
      // «пользователь слайдер не трогал». Осознанный выбор (3–30) сохраняется.
      migrate: (persisted: any, oldVersion: number) => {
        const state = (persisted ?? {}) as any
        if (oldVersion < 2 && state?.video && state.video.firstSamplerSteps === 2) {
          state.video = { ...state.video, firstSamplerSteps: 4 }
        }
        // (правка 340) Разовая миграция старого дефолта draftSteps 8 → 4
        // (новый эталон turbo) — только для состояний, сохранённых до v3.
        if (oldVersion < 3 && state?.video && state.video.draftSteps === 8) {
          state.video = { ...state.video, draftSteps: 4 }
        }
        // (правка 449) Veda снова default OFF (отменяет правку 425):
        // разово гасим сохранённое «вкл»; осознанное включение делается
        // свитчем ПОСЛЕ миграции (та же схема, что у правок 340/425).
        if (oldVersion < 6 && state?.video && state.video.vedaAttention === true) {
          state.video = { ...state.video, vedaAttention: false }
        }
        // (правка 437) Двухпроходный extend теперь default ON: сохранённые
        // снимки со старым дефолтом false → true (та же оговорка, что у 425:
        // осознанный «Драфт» переживёт миграцию, только если выбрать его
        // ПОСЛЕ неё).
        if (oldVersion < 5 && state?.video && state.video.extendTwoPass === false) {
          state.video = { ...state.video, extendTwoPass: true }
        }
        // (правка 719) Новый дефолт точки сплита pass 1: 4 → 6 («6 из 12»).
        // Сбрасываем ТОЛЬКО старое значение дефолта (4) — оно означает
        // «пользователь ползунок не трогал». Осознанный выбор (2, 3, 5…30)
        // сохраняется.
        if (oldVersion < 7 && state?.video && state.video.firstSamplerSteps === 4) {
          state.video = { ...state.video, firstSamplerSteps: 6 }
        }
        return state
      },
      // Deep-merge persisted state with initial state so new fields get defaults
      merge: (persisted: any, current: any) => {
        const result = { ...current, ...persisted }
        if (persisted?.video) {
          result.video = { ...current.video, ...persisted.video }
          // Guard against undefined numeric fields from old localStorage
          if (typeof result.video.videoLength !== 'number' || isNaN(result.video.videoLength)) {
            result.video.videoLength = DEFAULT_VIDEO_STATE.videoLength
          }
          if (typeof result.video.lowResMP !== 'number' || isNaN(result.video.lowResMP)) {
            result.video.lowResMP = DEFAULT_VIDEO_STATE.lowResMP
          }
          if (typeof result.video.draftSteps !== 'number' || isNaN(result.video.draftSteps)) {
            result.video.draftSteps = DEFAULT_VIDEO_STATE.draftSteps
          }
          // (правка 340) Миграция draftSteps 8→4 перенесена в migrate
          // (version 3) — здесь она выполнялась при каждой ре-гидратации
          // и стирала осознанный выбор пользователя.
          if (typeof result.video.finalResolution !== 'number' || isNaN(result.video.finalResolution)) {
            result.video.finalResolution = DEFAULT_VIDEO_STATE.finalResolution
          }
          if (typeof result.video.freeResolution !== 'boolean') {
            result.video.freeResolution = DEFAULT_VIDEO_STATE.freeResolution
          }
          if (typeof result.video.sigmaVariant !== 'string' || !result.video.sigmaVariant) {
            result.video.sigmaVariant = DEFAULT_VIDEO_STATE.sigmaVariant
          }
          if (result.video.pipeline !== 'draft' && result.video.pipeline !== 'full') {
            result.video.pipeline = DEFAULT_VIDEO_STATE.pipeline
          }
          if (typeof result.video.pass2Sampler !== 'string' || !result.video.pass2Sampler) {
            result.video.pass2Sampler = DEFAULT_VIDEO_STATE.pass2Sampler
          }
          if (typeof result.video.pass1Sampler !== 'string' || !result.video.pass1Sampler) {
            result.video.pass1Sampler = DEFAULT_VIDEO_STATE.pass1Sampler
          }
          if (typeof result.video.pass1Scheduler !== 'string' || !result.video.pass1Scheduler) {
            result.video.pass1Scheduler = DEFAULT_VIDEO_STATE.pass1Scheduler
          }
          if (typeof result.video.turboLoraStrength !== 'number' || isNaN(result.video.turboLoraStrength)) {
            result.video.turboLoraStrength = DEFAULT_VIDEO_STATE.turboLoraStrength
          }
          if (typeof result.video.sparseAttention !== 'boolean') {
            result.video.sparseAttention = DEFAULT_VIDEO_STATE.sparseAttention
          }
          // (правка 400) регидрация старых persist-снимков без veda-настроек
          if (typeof result.video.vedaGeneratedSparsity !== 'string') {
            result.video.vedaGeneratedSparsity = DEFAULT_VIDEO_STATE.vedaGeneratedSparsity
          }
          if (typeof result.video.vedaReferenceSparsity !== 'string') {
            result.video.vedaReferenceSparsity = DEFAULT_VIDEO_STATE.vedaReferenceSparsity
          }
          if (typeof result.video.vedaFullAttentionLayers !== 'string') {
            result.video.vedaFullAttentionLayers = DEFAULT_VIDEO_STATE.vedaFullAttentionLayers
          }
          if (typeof result.video.vedaFullAttentionSteps !== 'string') {
            result.video.vedaFullAttentionSteps = DEFAULT_VIDEO_STATE.vedaFullAttentionSteps
          }
          if (typeof result.video.vedaVerbose !== 'boolean') {
            result.video.vedaVerbose = DEFAULT_VIDEO_STATE.vedaVerbose
          }
          if (typeof result.video.lowVramAttention !== 'boolean') {
            result.video.lowVramAttention = DEFAULT_VIDEO_STATE.lowVramAttention
          }
          if (typeof result.video.chunkFeedForward !== 'boolean') {
            result.video.chunkFeedForward = DEFAULT_VIDEO_STATE.chunkFeedForward
          }
          if (typeof result.video.chunkFFChunks !== 'number' || isNaN(result.video.chunkFFChunks)) {
            result.video.chunkFFChunks = DEFAULT_VIDEO_STATE.chunkFFChunks
          }
          if (typeof result.video.chunkFFThreshold !== 'number' || isNaN(result.video.chunkFFThreshold)) {
            result.video.chunkFFThreshold = DEFAULT_VIDEO_STATE.chunkFFThreshold
          }
          if (!Array.isArray(result.video.refs)) {
            result.video.refs = []
          }
          if (!Array.isArray(result.video.extendClips)) {
            result.video.extendClips = []
          }
          if (!Array.isArray(result.video.extendImageRefs)) {
            result.video.extendImageRefs = []
          }
          if (typeof result.video.extendSourceVideoPath !== 'string') {
            result.video.extendSourceVideoPath = ''
          }
          if (typeof result.video.extendSourceDuration !== 'number' || isNaN(result.video.extendSourceDuration)) {
            result.video.extendSourceDuration = 0
          }
          // (правка 363) регидрация старых persist-снимков без поля
          if (typeof result.video.extendSourceSubfolder !== 'string' && result.video.extendSourceSubfolder !== null) {
            result.video.extendSourceSubfolder = null
          }
          // (правка 385) регидрация старых persist-снимков без поля
          if (typeof result.video.extendSourceName !== 'string' && result.video.extendSourceName !== null) {
            result.video.extendSourceName = null
          }
          // (правка 423) регидрация старых persist-снимков без поля
          if (typeof result.video.extendTwoPass !== 'boolean') {
            result.video.extendTwoPass = DEFAULT_VIDEO_STATE.extendTwoPass
          }
          // (правка 466) регидрация старых persist-снимков без полей Sol-Attn
          for (const k of ['sparseTau', 'sparseStartPercent', 'sparseEndPercent', 'sparseMinTokens', 'sparseExtraTokens'] as const) {
            if (typeof result.video[k] !== 'number' || isNaN(result.video[k])) {
              result.video[k] = DEFAULT_VIDEO_STATE[k]
            }
          }
        }
        return result
      },
      // Persist form values. Preview blob URLs don't survive reload —
      // strip them and rebuild previews from the server-side input files.
      partialize: (state) => ({
        video: {
          ...state.video,
          startFrame: state.video.startFrame ? { ...state.video.startFrame, previewUrl: '' } : null,
          endFrame: state.video.endFrame ? { ...state.video.endFrame, previewUrl: '' } : null,
          refs: state.video.refs.map((r) => ({ ...r, previewUrl: '' })),
          extendImageRefs: state.video.extendImageRefs.map((r) => ({ ...r, previewUrl: '' })),
        },
      }),
    }
  )
)
