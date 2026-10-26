/**
 * Video generation configuration (ComfyUI-compatible).
 * The UI component passes VideoGenerateParams to useVideoGen,
 * which maps them to the ComfyUI workflow (MiniMax H3 Ref2VA).
 */

/** One ref2va reference. `path` is the ComfyUI input/ filename. */
export interface VideoReferenceParam {
  kind: 'image' | 'video' | 'audio'
  /** ComfyUI input/ filename (from /api/comfy/upload). */
  path: string
  /** Free text: who/what this reference is. */
  role?: string
  /** Images: identity | scene | style | composition. */
  imageIntent?: 'identity' | 'scene' | 'style' | 'composition'
  /** Videos: include the reference's own audio track. */
  includeAudio?: boolean
  /** (правка 493) Videos: сжать до 480p перед подачей в conditioning. */
  compress?: boolean
  /** (правка 302) Audio: обрезка, секунды. trimEnd null/0/undefined = до конца. */
  trimStart?: number
  trimEnd?: number | null
  /** (правка 694) Audio: громкость 0–1 (default 0.5) — виртуальная (нода AudioGain). */
  audioVolume?: number
}

/**
 * Parameters from the UI — the hook maps them to the ComfyUI workflow.
 */
export interface VideoGenerateParams {
  /** Model type (kept for UI compatibility; ComfyUI uses the workflow template). */
  modelType: string
  /** (правка 146) Режим генерации: 'ref' (default) | 't2v' | 'flf' | 'extend' (правка 161). */
  mode?: 'ref' | 't2v' | 'flf' | 'extend'
  /** Пайплайн: 'draft' — один проход на low-res канве (черновик для отбора,
   *  апгрейд вкладкой Refine); 'full' (default) — два прохода, как раньше. */
  pipeline?: 'draft' | 'full'
  /** Шаги единственного прохода в пайплайне 'draft' (default 4, min 2). */
  draftSteps?: number
  /** (правка 719) extend: шаги клипа продления. undefined = «авто» —
   *  шаги первого прохода исходника (из его меты), без меты — firstSamplerSteps. */
  extendClipSteps?: number
  /** (правка 161) extend: клипы для продления. */
  extendClips?: Array<{ prompt: string; duration: number; seed: number }>
  /** (правка 161) extend: картинки-рефы для продления (до 9). */
  extendRefs?: string[]
  /** (правка 164) extend: имя исходного видео в ComfyUI input/ (для LoadVideo → ref_video_1). */
  extendSourceVideo?: string
  /** (правка 385) extend: имя файла-ОРИГИНАЛА в output/ (копия в input/ имеет
   *  случайное имя) — вместе с extendSourceSubfolder адрес сайдкара исходника:
   *  роут по нему резолвит латент исходника (lossless-сид продления). */
  extendSourceName?: string
  /** (правка 385) extend: подпапка output, из которой взят источник-галерея. */
  extendSourceSubfolder?: string
  /** (правка 190) extend: число overlap-кадров между клипами (24 fps).
   *  Default 48 (2 sec). Эти кадры из конца предыдущего клипа
   *  подаются как latent-контекст для бесшовного продолжения. */
  extendOverlapFrames?: number
  /** (правка 423) extend: двухпроходный режим (low-res pass 1 → апскейл →
   *  pass 2 рефайн до размера исходника). Default false = один проход. */
  extendTwoPass?: boolean
  /** (правка 146) flf: ComfyUI input/ filename первого кадра. */
  firstFrame?: string
  /** (правка 146) flf: ComfyUI input/ filename последнего кадра. */
  lastFrame?: string
  /** (правка 152) flf: ширина первого кадра в пикселях (для aspect ratio). */
  firstFrameWidth?: number
  /** (правка 152) flf: высота первого кадра в пикселях. */
  firstFrameHeight?: number
  /** Positive prompt (supports <Picture 1>/<Picture 2> tags for refs). */
  prompt: string
  /** Random seed (-1 = random, default: -1). */
  seed?: number
  /** Sampling steps (default 20; turbo: 4). */
  steps?: number
  /** Resolution string — ТОЧНЫЙ номинал (правка 124), e.g. "1280x720", "1920x1080". */
  resolution?: string
  /** Total output frames (H3: 17n+5, min 124). */
  videoLength?: number
  /** Turbo mode (4-step LoRA). */
  turbo?: boolean
  /** Turbo LoRA multiplier 0.1–2.0 (default 0.7). */
  turboWeight?: number
  /** Custom LoRA filename (overrides turbo default). */
  turboLoraName?: string
  /** Non-turbo LoRA filename. */
  loraName?: string
  /** (правка 91) Подпапка вывода — папка проекта галереи ('' = общая). */
  outputSubfolder?: string

  /* ── FL2VA: first/last frame ── */
  imagePromptType?: '' | 'S' | 'E' | 'SE'
  startFramePath?: string
  endFramePath?: string

  /* ── ref2va: reference manifest ── */
  references?: VideoReferenceParam[]
  referenceDetail?: 'match' | 'max'
  /** ref + аудио-реф: подать аудио как Audio Guide (а не только ref_audio)
   *  и сохранить оригинальную дорожку в результате. */
  audioGuide?: boolean
  /** Серверная замена итоговой дорожки оригиналом (ставится вместе с audioGuide). */
  keepOriginalAudio?: boolean

  /* ── Two-pass latent upscaler ── */
  /** (правка 124) Точные номинальные (финальные) размеры видео — приоритет
   *  над finalResolution: gen = ceil32(nominal), кроп → ровно номинал. */
  targetDimensions?: { width: number; height: number }
  /** Target resolution in MP for the latent upscaler (default 0.7 ≈ 720p;
   *  (правка 124) используется в режиме свободного разрешения). */
  finalResolution?: number
  /** Low-res pass 1 resolution in MP (default 0.2). */
  lowResMP?: number
  /** Pass 1 effective sampling steps (SplitSigmas split point, default 6, max 30). */
  firstSamplerSteps?: number
  /**
   * ВСЕГО шагов в расписании BasicScheduler для pass 1.
   * undefined = firstSteps — «6 из 6» по умолчанию.
   */
  firstSamplerTotalSteps?: number
  /** Pass 2 sigma variant: '3step' | '4step' | '5step' | '6step' | '7step'. */
  sigmaVariant?: string
  /** (правка 69) Pass 2 sampler (default 'euler'). */
  pass2Sampler?: string
  /** (правка 70) Pass 1 sampler (default 'euler'). */
  pass1Sampler?: string
  /** (правка 70) Pass 1 scheduler (default 'simple'). */
  pass1Scheduler?: string
  /** (правка 168) Разреженное внимание (Sol-Attn) — ускоряет длинные последовательности. Default true. */
  sparseAttention?: boolean
  /** (правка 466) Sol-Attn: порог tau (default 1.3). */
  sparseTau?: number
  /** (правка 466) Sol-Attn: start_percent (default 0.2). */
  sparseStartPercent?: number
  /** (правка 466) Sol-Attn: end_percent (default 1.0). */
  sparseEndPercent?: number
  /** (правка 466) Sol-Attn: min_tokens (default 12288). */
  sparseMinTokens?: number
  /** (правка 466) Sol-Attn: extra_tokens (default 256). */
  sparseExtraTokens?: number
  /** (правка 301) Veda Sparse Attention — обученный предиктор. Default false. */
  vedaAttention?: boolean
  /** (правка 401) Veda: спарсити генерации, 'N%' (default '90%'). */
  vedaGeneratedSparsity?: string
  /** (правка 401) Veda: спарсити референсов, 'N%' (default '90%'; 0% = полное внимание). */
  vedaReferenceSparsity?: string
  /** (правка 401) Veda: блоки DiT с полным вниманием («0, 1, 47-49»; '' = все sparse). */
  vedaFullAttentionLayers?: string
  /** (правка 401) Veda: шаги сэмплера с полным вниманием («0, 1»; '' = нет). */
  vedaFullAttentionSteps?: string
  /** (правка 401) Veda: подробный лог (default false). */
  vedaVerbose?: boolean
  /** Enable MiniMaxLowVRAMAttention (head-chunked attention, saves VRAM). */
  lowVramAttention?: boolean
  /** Enable MiniMaxChunkFeedForward (chunked FFN for long sequences). */
  chunkFeedForward?: boolean
  /** ChunkFF: number of feed-forward chunks (default 2). */
  chunkFFChunks?: number
  /** ChunkFF: sequence length threshold above which chunking kicks in (default 4096). */
  chunkFFThreshold?: number

  /* ── misc ── */
  textEncoder?: string
  negativePrompt?: string
  guidance?: number
  audioGuidance?: number
  [key: string]: unknown
}
