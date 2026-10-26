import { vhsEncodeInputs, type VideoFormatSettings } from '../video-format' // (правка 386)
/**
 * MiniMax H3 Reference-to-Video — Two-Pass Latent Upscaler workflow.
 *
 * Architecture:
 *   Pass 1: Low-res generation (0.2 MP, 6 total steps → SplitSigmas → 6 effective, «6/6»)
 *   Upscale: MinimaxH3LatentUpscaler3D to target resolution (default 0.7 MP)
 *   Pass 2: High-res refinement (3 steps via ManualSigmas)
 *   Decode: Separate VAEDecode (video) + VAEDecodeAudio (audio)
 *
 * Model chain: UNET → [LowVRAM] → [ChunkFF] → [custom LoRAs, incl. turbo] → SigmaShift → AttentionBackend → Preview
 * (LowVRAM Attention and Chunk FeedForward are optional, default ON;
 *  SageAttn and SLA patches were removed in favour of --use-ck-attention)
 *
 * Defaults (overridable via MiniMaxH3Params):
 *   - LoRA: customLoras из loras.json; встроенная турбо-лора включена по умолчанию
 *   - Pass 1: сэмплер + планировщик на выбор (default euler / simple, правки 67, 70)
 *     BasicScheduler (steps) → SplitSigmas
 *   - Pass 2: сэмплер на выбор (default euler, правки 68–69) / ManualSigmas
 *   - Latent Upscaler: «target dimensions» (правка 124), enable_chunking: true (правка 68)
 *   - Pass 2: ManualSigmas (0.9035, 0.6316, 0.3158, 0.0000)
 *   - Low-res: 0.2 MP (default), диапазон 0.2–2 MP (правка 70)
 *   - Optimization nodes SigmaShift + Attention
 *
 *   (правка 124) Разрешение: генерация кратной 32, чуть больше номинала
 *   (16:9 1080p → 1920×1088), в конце — кроп чётко под номинал (1920×1080).
 */

/** (правки 69–70) Валидные к-сэмплеры для обоих проходов — подмножество
 *  KSAMPLER_NAMES установленной сборки ComfyUI (comfy/samplers.py).
 *  Default: euler. */
export const VALID_KSAMPLERS = [
  'er_sde',
  'euler',
  'dpmpp_2m',
  'dpmpp_3m_sde',
  'heun',
  'lcm',
  'res_multistep',
] as const

export const DEFAULT_PASS2_SAMPLER = 'euler'
export const DEFAULT_PASS1_SAMPLER = 'euler'
/** (правка 70) Валидные планировщики pass 1 — SCHEDULER_HANDLERS
 *  установленной сборки ComfyUI (comfy/samplers.py). Default: simple. */
export const PASS1_SCHEDULERS = [
  'sgm_uniform',
  'simple',
  'karras',
  'exponential',
  'ddim_uniform',
  'normal',
  'beta',
  'linear_quadratic',
  'kl_optimal',
] as const

export const DEFAULT_PASS1_SCHEDULER = 'simple'

/* ── (правка 399) Veda Sparse Attention — настройки ноды ── */

/**
 * Спарсити вида '90%' (или целое число тайлов) → строка `${n}%`, кламп 0..95.
 * Нечитаемое значение → `${def}%`.
 */
export function clampVedaSparsity(v: unknown, def: number): string {
  let n: number
  if (typeof v === 'number') n = v
  else if (typeof v === 'string') n = Number.parseFloat(v.replace('%', '').trim())
  else n = NaN
  if (!Number.isFinite(n)) n = def
  n = Math.min(95, Math.max(0, Math.round(n)))
  return `${n}%`
}

/**
 * Список «0, 1, 47-49» (0-based блоки/шаги): цифры, запятые, дефисы, пробелы.
 * Что-либо ещё → '' (нода использует свой дефолт).
 */
export function sanitizeVedaIndexList(v: unknown): string {
  if (typeof v !== 'string') return ''
  const t = v.trim()
  return /^[\d\s,\-]*$/.test(t) ? t : ''
}

export interface MiniMaxH3Params {
  prompt: string
  /** Uploaded image filenames in ComfyUI input/ (max 9). */
  refImages: string[]
  /** (правка 146) Режим генерации:
   *  • 'ref' — референсы (как раньше, default): refImages/refVideos/refAudios
   *    через MiniMaxH3ReferenceToVideo;
   *  • 't2v' — только текст: MiniMaxH3ImageToVideo без кадров;
   *  • 'flf' — первый/последний кадр: MiniMaxH3ImageToVideo + firstFrame/lastFrame;
   *  • 'extend' — продление видео: цепочка клипов через MiniMaxH3Extender
   *    (tritant) + MiniMaxH3MotionContextDiskFinalDecode.
   *  В t2v/flf аудио-референсы подаются через цепочку MiniMaxH3AddGuide
   *  (у самой ноды аудио-входов нет). */
  mode?: 'ref' | 't2v' | 'flf' | 'extend'
  /** (правка 161) extend: клипы для продления. Каждый клип — промпт + длительность + seed. */
  extendClips?: Array<{ prompt: string; duration: number; seed: number }>
  /** (правка 161) extend: имена файлов-рефов для метаданных («Повторить»).
   *  Для самой генерации используется extendRefDescriptors. */
  extendRefs?: string[]
  /** (правка 161) extend: descriptors картинок-рефов, загруженные в
   *  внутренний кэш Extender-ноды через /h3_extender/ref/upload.
   *  Каждый descriptor — {id: 64-hex, width, height, ...}. До 9 штук. */
  extendRefDescriptors?: Array<Record<string, unknown> & { id: string }>
  /** extend: имя исходного видео в ComfyUI input/ — подаётся через
   *  LoadVideo → GetVideoComponents → ref_video_1 (IMAGE frame batch).
   *  Нода использует его как reference video для продления. */
  extendSourceVideo?: string
  /** (правка 254) extend: фактическое число кадров исходника (ffprobe в
   *  роуте). План хвоста клампится к нему: LatentCut молча урезает латент
   *  короче плана, а маска считалась от плана → сдвиг preserved-зоны и
   *  «чистый шум» в начале клипа. */
  extendSourceFrames?: number
  /** (правка 385, ОТКАЧЕНА правкой 417) extend: путь к ЛАТЕНТУ исходника.
   *  Латент-пайплайн extend (сид/голова/комбайн из первозданного латента)
   *  откачен по результатам тестов (реплей исходника в белой зоне клипа);
   *  extend снова целиком mp4-based. Поля оставлены в интерфейсе для
   *  совместимости метаданных старых джобов — билдером НЕ используются. */
  extendSourceLatent?: string
  /** (правка 385, ОТКАЧЕНА правкой 417) Не используется, см. extendSourceLatent. */
  extendSourceTokens?: number
  /** (правка 385, ОТКАЧЕНА правкой 417) Не используется, см. extendSourceLatent. */
  extendSourceAudioSteps?: number
  /** (правка 420) extend: путь к .latent исходника (относительно output/) —
   *  НЕ для генерации (сид остаётся пиксельным, правка 409/419), а только
   *  для ПОСТ-СБОРКИ combined-латента ПОСЛЕ сэмплеров: латент итога
   *  склейки сохраняется одним файлом для lossless-рефайна/апскейла.
   *  Нет файла — исходник энкодится целиком один раз в графе. */
  extendSourceLatentFile?: string
  /** extend: число overlap-кадров между клипами (24 fps). Default 48 (2 sec). */
  extendOverlapFrames?: number
  /** (правка 423) extend: двухпроходный режим — клипы генерятся на low-res
   *  канве (lowResMP), затем каждый апскейлится LatentUpscaler3D до размера
   *  исходника и дорисовывается pass-2 сэмплером (ManualSigmas sigmaVariant).
   *  Default false = однопроходная схема (правка 247). */
  extendTwoPass?: boolean
  /** (правка 146) flf: имя файла первого кадра в ComfyUI input/. */
  firstFrame?: string
  /** (правка 146) flf: имя файла последнего кадра в ComfyUI input/ (опционально). */
  lastFrame?: string
  /** (правка 152) flf: ширина первого кадра в пикселях (для aspect ratio, чтобы не растягивать). */
  firstFrameWidth?: number
  /** (правка 152) flf: высота первого кадра в пикселях. */
  firstFrameHeight?: number
  /** Aspect ratio string for ResolutionSelector (e.g., "16:9", "21:9 (Ultrawide)"). */
  aspectRatio: string
  /** Duration in seconds */
  duration: number
  /** Seed (-1 = random) */
  seed: number
  /** Target megapixels for the latent upscaler output (default 0.7 ≈ 720p).
   *  (правка 124) Используется только в режиме свободного разрешения —
   *  при заданных targetDimensions приоритет у точных размеров. */
  finalResolution?: number
  /** Пайплайн: 'draft' — один проход на черновой low-res канве (быстрый отбор
   *  идей, апгрейд — вкладкой Refine); 'full' (default) — два прохода
   *  (low-res → LatentUpscaler3D → Pass 2), как раньше. */
  pipeline?: 'draft' | 'full'
  /** Шаги единственного прохода в пайплайне 'draft' (default 4 — turbo-эталон,
   *  минимум 2). */
  draftSteps?: number
  /** (правка 124) Точные номинальные (финальные) размеры видео, напр.
   *  1920×1080 для 16:9 1080p. Ставятся для пресетов качества: апскейлер
   *  работает в режиме «target dimensions» (gen = ceil32(nominal)), итог —
   *  центрированный кроп до nominalW×nominalH. */
  targetDimensions?: { width: number; height: number }
  /** Low-res pass 1 resolution in MP (default 0.2, диапазон 0.2–2, правка 70). */
  lowResMP?: number
  /** Pass 1 effective sampling steps (SplitSigmas split point, default 6, max 30). */
  firstSamplerSteps?: number
  /**
   * ВСЕГО шагов в расписании BasicScheduler для pass 1.
   *
   * Число шагов расписания задаётся независимо от точки сплита — это
   * позволяет, например, взять 6 сигм из 8-шаговой лестницы.
   *
   * undefined = столько же, сколько забирает сплит (firstSteps) — «6 из 6»
   * по умолчанию. Раньше здесь было firstSteps × 2 («6 из 12»).
   */
  firstSamplerTotalSteps?: number
  /**
   * (правка 719) Шаги клипа в режиме продления. В Extend это НЕ точка
   * сплита: там один BasicScheduler на клип (denoise = 1, сплита нет).
   * По умолчанию 4 — как в эталонном extend-воркфлоу.
   */
  extendClipSteps?: number
  /** Pass 2 sigma variant: '3step' | '4step' | '5step' | '6step' | '7step'. Default '3step'. */
  sigmaVariant?: string
  /** (правка 69) Pass 2 sampler (default 'euler'). Must be one of VALID_KSAMPLERS. */
  pass2Sampler?: string
  /** (правка 70) Pass 1 sampler (default 'euler'). Must be one of VALID_KSAMPLERS. */
  pass1Sampler?: string
  /** (правка 70) Pass 1 scheduler (default 'simple'). Must be one of PASS1_SCHEDULERS. */
  pass1Scheduler?: string
  /** @deprecated Турбо-лора идёт через customLoras; шаблон это поле не читает. */
  turboLoraStrength?: number
  /** @deprecated Турбо-лора идёт через customLoras; шаблон это поле не читает. */
  turboLoraName?: string
  /** @deprecated Турбо-лора идёт через customLoras; шаблон это поле не читает. */
  turboLoraEnabled?: boolean
  /** (правка 168) Разреженное внимание (Sol-Attn) — ускоряет длинные последовательности.
   *  Короткие (< min_tokens) остаются плотными автоматически. Default true. */
  sparseAttention?: boolean
  /** (правка 301) Veda Sparse Attention — обученный предиктор. Default false.
   *  Если true, заменяет Sol-Attn. */
  vedaAttention?: boolean
  /** (правка 399) Veda: спарсити генерации, строка 'N%' (50–95, default '90%'). */
  vedaGeneratedSparsity?: string
  /** (правка 399) Veda: спарсити референсов, 'N%' (0–95, default '90%'; 0% = полное внимание к референсам). */
  vedaReferenceSparsity?: string
  /** (правка 399) Veda: 0-based блоки DiT с полным вниманием («0, 1, 47-49»; '' = все sparse). */
  vedaFullAttentionLayers?: string
  /** (правка 399) Veda: 0-based шаги сэмплера с полным вниманием («0, 1»; '' = нет). */
  vedaFullAttentionSteps?: string
  /** (правка 399) Veda: подробный лог (default false). */
  vedaVerbose?: boolean
  /** (правка 168) Sol-Attn: порог разреженности (0–4, default 1.3). */
  sparseTau?: number
  /** (правка 466) Sol-Attn: start_percent (default 0.2). */
  sparseStartPercent?: number
  /** (правка 466) Sol-Attn: end_percent (default 1.0). */
  sparseEndPercent?: number
  /** (правка 466) Sol-Attn: min_tokens (default 12288). */
  sparseMinTokens?: number
  /** (правка 466) Sol-Attn: extra_tokens (default 256). */
  sparseExtraTokens?: number
  /** Enable MiniMaxLowVRAMAttention (head-chunked attention, saves VRAM). Default true. */
  lowVramAttention?: boolean
  /** Enable MiniMaxChunkFeedForward (chunked FFN, saves VRAM on long sequences). Default true. */
  chunkFeedForward?: boolean
  /** ChunkFF: number of feed-forward chunks (default 2). */
  chunkFFChunks?: number
  /** ChunkFF: sequence length threshold above which chunking kicks in (default 4096). */
  chunkFFThreshold?: number

  /* ── Video references (max 3) ── */
  /** Video filenames in ComfyUI input/. Each produces IMAGE frames for ref_video_N. */
  refVideos?: Array<{ path: string; includeAudio?: boolean; /** (правка 493) флаг «сжать до 480p» — обрабатывает роут /api/comfy/generate (подменяет path на сжатую копию), шаблон его не видит. */ compress?: boolean }>
  /* ── Standalone audio references (max 3) ── */
  /** Audio filenames in ComfyUI input/. Each maps to ref_audio_N. */
  refAudios?: string[]
  /** ref-режим: подать аудио-рефы как Audio Guide (якорь на кадре 0), а не
   *  только как ref_audios. Включается галочкой «сохранить оригинальный звук
   *  + вести по нему»; вместе с этим server-side заменяет итоговую дорожку. */
  audioGuide?: boolean
  /** Заменить итоговую аудиодорожку оригинальной (после done). */
  keepOriginalAudio?: boolean
  /** (правка 326) Обрезки аудио-рефов (параллельно refAudios): задано →
      между LoadAudio и потребителем вставляется MiniMaxStudioAudioTrim.
      Обрезка виртуальная (тензор), копии файлов не создаются. */
  refAudioTrims?: Array<{ start: number; end: number | null } | undefined>
  /** (правка 694) Громкость аудио-рефов (0–1, default 0.5): между AudioTrim и
      потребителем вставляется MiniMaxStudioAudioGain. Виртуальная, без копий файла. */
  refAudioVolumes?: Array<number | undefined>
  /* ── Custom LoRAs (chained after turbo LoRA) ── */
  /** Custom LoRAs to apply after the built-in turbo LoRA. */
  customLoras?: Array<{ name: string; strength: number }>
  /** Diffusion model filename (default: minimax_h3_fastvideo_vsa_datafree_1300step_4step_int8_convrot.safetensors). */
  diffusionModel?: string
  /** (правка 91) Подпапка вывода (папка проекта галереи; '' = общая).
   *  Уходит в filename_prefix ноды VHS_VideoCombine как «folder/Minimax_Studio». */
  outputSubfolder?: string
  /** (правка 58) Reference image sizing mode (node input ref_image_size):
   *  'match' — shrink refs to the generation pixel area (default, faster);
   *  'max' — 2048px short edge for best identity fidelity (slower). */
  refImageSize?: 'match' | 'max'
  /** (правка 386) Формат/качество видео-выхода ([video] config.ini; сервер
   *  передаёт при сборке джоба, undefined = дефолт h264/CRF 12). */
  videoFormat?: VideoFormatSettings
}

/** Node IDs for reference images (up to 9). */
const REF_IMAGE_NODE_IDS = ['101', '399', '401', '403', '405', '407', '409', '411', '413'] as const

/** Node IDs for reference videos (up to 3) — VHS_LoadVideo nodes. */
const REF_VIDEO_NODE_IDS = ['501', '502', '503'] as const

/** Node IDs for standalone audio references (up to 3) — LoadAudio nodes. */
const REF_AUDIO_NODE_IDS = ['510', '511', '512'] as const

/** (правка 146) flf: LoadImage-ноды первого/последнего кадра. */
const FIRST_FRAME_NODE_ID = '105'
const LAST_FRAME_NODE_ID = '107'

/** (правка 146) t2v/flf: цепочка MiniMaxH3AddGuide для аудио-референсов (до 3). */
const AUDIO_GUIDE_NODE_IDS = ['46:50', '46:51', '46:52'] as const

/**
 * Parse an aspect-ratio string "A:B" (decimals allowed, e.g. "2.35:1",
 * decorations like "(Ultrawide)" ignored) → [rw, rh].
 */
function parseAspect(s: string): [number, number] {
  const m = s.match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/)
  if (!m) return [16, 9]
  return [parseFloat(m[1]), parseFloat(m[2])]
}

/**
 * EXACT math of ComfyUI's ResolutionSelector node (comfy_extras/
 * nodes_resolution.py): megapixels are BINARY (MP × 1024 × 1024), results
 * aligned to `multiple`. Doing it here (instead of wiring the node) allows
 * ANY aspect ratio — including "2.35:1", which the node's combo does not
 * offer (it silently collapsed to 21:9 before).
 */
export function selectResolution(
  aspect: string,
  megapixels: number,
  multiple = 32,
): { w: number; h: number } {
  const [rw, rh] = parseAspect(aspect)
  const total = megapixels * 1024 * 1024
  const scale = Math.sqrt(total / (rw * rh))
  const w = Math.round((rw * scale) / multiple) * multiple
  const h = Math.round((rh * scale) / multiple) * multiple
  return { w: Math.max(multiple, w), h: Math.max(multiple, h) }
}

/* ─── (правка 124) Точные соотношения сторон + ТОЧНОЕ итоговое разрешение ───
 *
 * Логика по запросу юзера (правка 124): сначала — разрешение генерации,
 * кратное 32 и чуть больше номинала; потом — генерация; в конце — точная
 * подгонка под выбранное соотношение + качество:
 *   1) номинал = ТОЧНО выбранное соотношение + качество
 *      (16:9 + 1080p → 1920×1080; короткая сторона = число «p»);
 *   2) gen-разрешение = номинал, поднятый по каждой оси до кратного 32
 *      (1920×1080 → 1920×1088) — анти-бандинг/VAE сохраняются;
 *   3) апскейлер работает в режиме «target dimensions» — выдаёт ровно
 *      genW×genH независимо от пропорции pass 1 (megapixels-mode держал
 *      пропорцию pass 1 и округлял оси независимо — из-за этого 16:9
 *      давало 1952×1098 и т.п.);
 *   4) в конце центрированный кроп ImageCrop genW×genH → номинал
 *      (1920×1088 → 1920×1080). Итог: видео ЧЁТКО 16:9 1080p.
 *
 * Свободное разрешение (MP) идёт вторым путём (finalDimsFromMegapixels):
 * генерация — по бинарным MP узла (MP×1024×1024), итог — максимальный
 * вписанный прямоугольник с точным соотношением (чётные стороны, yuv420p).
 *
 * computeFinalDimensions / finalDimsFromMegapixels — ЕДИНЫЙ источник
 * истины: workflow (target dimensions + ImageCrop), метаданные
 * (pending-meta, use-video-gen) и UI-бейджи — везде один и тот же результат.
 */

function gcd(a: number, b: number): number {
  a = Math.abs(a); b = Math.abs(b)
  while (b) { const t = a % b; a = b; b = t }
  return a || 1
}

/** Приводит дробное соотношение ("2.35:1") к несократимой целочисленной
 *  паре (47:20) — нужно для точного расчёта кропа. (правка 121) */
export function aspectToInts(aspect: string): [number, number] {
  const [rw, rh] = parseAspect(aspect)
  const dec = (v: number) => {
    const s = String(v)
    const i = s.indexOf('.')
    return i < 0 ? 0 : Math.min(6, s.length - i - 1)
  }
  const f = Math.pow(10, Math.max(dec(rw), dec(rh)))
  const w = Math.round(rw * f)
  const h = Math.round(rh * f)
  const g = gcd(w, h)
  return [w / g, h / g]
}

/** Python round() = half-to-even (узел апскейлера на Python). (правка 121) */
function pyRound(x: number): number {
  const f = Math.floor(x)
  const frac = x - f
  if (frac > 0.5) return f + 1
  if (frac < 0.5) return f
  return f % 2 === 0 ? f : f + 1
}

/** Округление к чётному (yuv420p). (правка 124) */
function roundToEven(n: number): number {
  const r = Math.round(n)
  return r % 2 === 0 ? r : r + 1
}

/**
 * (правка 124) Номинальные (финальные) размеры: короткая сторона = shortSide,
 * длинная = короткая × (rw/rh), округлённая до чётной (yuv420p).
 * 16:9 + 1080 → 1920×1080; 21:9 + 480 → 1120×480. Соотношение ТОЧНОЕ.
 */
export function nominalDimensions(aspect: string, shortSide: number): { w: number; h: number } {
  const [rw, rh] = parseAspect(aspect)
  const ratio = rw / rh
  if (ratio >= 1) {
    return { w: roundToEven(shortSide * ratio), h: roundToEven(shortSide) }
  }
  return { w: roundToEven(shortSide), h: roundToEven(shortSide / ratio) }
}

/**
 * (правка 157) flf-номинал: короткая сторона = заданный p (480/720/1080),
 * длинная = p × (fw/fh) — ТОЧНАЯ пропорция первого кадра (без квантования
 * к стандартным 16:9/9:16/…). Короткая сторона округляется до чётной
 * (yuv420p), чтобы итог всегда был кратно 2.
 *
 * В отличие от nominalDimensions() (которая квантует к ближайшему
 * стандартному соотношению), здесь пропорция берётся напрямую из размеров
 * кадра — горизонтальный кадр всегда даёт горизонтальное видео и т.д.
 */
export function flfNominalDimensions(
  shortSide: number,
  frameW: number,
  frameH: number,
): { w: number; h: number } {
  if (frameW >= frameH) {
    const h = roundToEven(shortSide)
    return { w: roundToEven(shortSide * (frameW / frameH)), h }
  }
  const w = roundToEven(shortSide)
  return { w, h: roundToEven(shortSide * (frameH / frameW)) }
}

export interface FinalDimensions {
  /** Размеры, которые реально выдаст апскейлер (кратные 32, ≥ номинала). */
  genW: number
  genH: number
  /** Смещение центрального кропа (0 — кроп не нужен). */
  cropX: number
  cropY: number
  /** Итоговые размеры видео ПОСЛЕ кропа — точный номинал. */
  outW: number
  outH: number
}

/**
 * (правка 124) ЕДИНЫЙ источник истины для итоговых размеров видео.
 * Генерация = номинал, поднятый по каждой оси до кратного 32 (чуть больше
 * номинала, кратность 32 сохранена); итог = номинал через центрированный
 * кроп (ImageCrop). Используется workflow (upscaler «target dimensions» +
 * ImageCrop), метаданными (pending-meta, use-video-gen) и UI-бейджами —
 * везде один и тот же результат.
 */
export function computeFinalDimensions(
  nominalW: number,
  nominalH: number,
  multiple: number = 32,
): FinalDimensions {
  const genW = Math.max(multiple, Math.ceil(nominalW / multiple) * multiple)
  const genH = Math.max(multiple, Math.ceil(nominalH / multiple) * multiple)
  const outW = Math.min(Math.max(2, nominalW), genW)
  const outH = Math.min(Math.max(2, nominalH), genH)
  return {
    genW,
    genH,
    cropX: Math.floor((genW - outW) / 2),
    cropY: Math.floor((genH - outH) / 2),
    outW,
    outH,
  }
}

/**
 * (правка 124) Путь свободного разрешения (MP): размеры генерации —
 * та же формула, что у узла MinimaxH3LatentUpscaler3D (режим MEGAPIXELS:
 * бинарные MP × 1024×1024, Python round до кратного 32); итог —
 * максимальный вписанный прямоугольник с ТОЧНЫМ соотношением и чётными
 * сторонами (yuv420p). Узел получает эти gen-размеры в режиме
 * «target dimensions», поэтому его выход совпадает с расчётом 1:1.
 *
 * (правки 121, 124) Floor 0.2 MP: pass 1 фиксирован на 0.2 MP, а узел
 * апскейлера запрещает уменьшение (effective_scale < 1.0 и выход < вход
 * → ValueError). 0.2 MP — нижняя граница ползунка «Свободное разрешение»;
 * при floor = 0.2 gen всегда ≥ pass 1 (равенство → узел проходит early-return,
 * кроп всё равно даёт точное соотношение). Было Math.max(1, mp) — молча
 * поднимало любое <1 MP до 1 MP (бейдж «0.70 MP» генерил 1 MP — не так).
 */
export function finalDimsFromMegapixels(
  aspect: string,
  megapixels: number,
  multiple: number = 32,
): FinalDimensions {
  const [rw, rh] = parseAspect(aspect)
  const ratio = rw / rh
  const targetPixels = Math.max(0.2, megapixels) * 1024 * 1024
  const hT = Math.sqrt(targetPixels / ratio)
  const wT = hT * ratio
  const genW = Math.max(multiple, pyRound(wT / multiple) * multiple)
  const genH = Math.max(multiple, pyRound(hT / multiple) * multiple)
  const [aw, ah] = aspectToInts(aspect)
  let k = Math.min(Math.floor(genW / aw), Math.floor(genH / ah))
  if (aw % 2 !== 0 || ah % 2 !== 0) k = Math.floor(k / 2) * 2 // обе стороны чётные
  if (k < 1) k = 1
  const outW = aw * k
  const outH = ah * k
  return {
    genW,
    genH,
    cropX: Math.floor((genW - outW) / 2),
    cropY: Math.floor((genH - outH) / 2),
    outW,
    outH,
  }
}

/**
 * Replicate ComfyUI's frame-count calculation (workflow node 46:19) exactly:
 *   max(5, round(seconds*fps)) snapped UP to the 17n+5 grid.
 * Single source of truth for metadata, shared by the client (use-video-gen)
 * and the server (pending-meta), so .video_length matches the ACTUAL frames
 * the server produces (правка 55). JS-safe Python-style modulo via
 * ((x % m) + m) % m.
 */
export function framesForDuration(seconds: number, fps = 24): number {
  const frames = Math.max(5, Math.round(seconds * fps))
  return frames + (((5 - frames) % 17) + 17) % 17
}

/* ─── Custom LoRA chain helpers (правка 44) ─── */

function loraNodeId(index: number): string {
  return `46:36_${index + 1}`
}

// (правка 483) Экспортированы для refine-template: цепочка customLoras
// вставляется между modelSrc и SigmaShift теми же хелперами (id '46:36_N'
// в refine-воркфлоу не конфликтуют с другими нодами).
export function buildCustomLoraNodes(
  loras: Array<{ name: string; strength: number }> | undefined,
  source: [string, number],
): Record<string, unknown> {
  if (!loras || loras.length === 0) return {}
  const nodes: Record<string, unknown> = {}
  let modelSrc = source
  for (let i = 0; i < loras.length; i++) {
    const id = loraNodeId(i)
    nodes[id] = {
      inputs: {
        lora_name: loras[i].name,
        strength_model: loras[i].strength,
        model: modelSrc,
      },
      class_type: 'LoraLoaderModelOnly',
      _meta: { title: `Custom LoRA ${i + 1}: ${loras[i].name}` },
    }
    modelSrc = [id, 0]
  }
  return nodes
}

export function getLastLoraOutput(
  loras: Array<{ name: string; strength: number }> | undefined,
  fallback: [string, number],
): [string, number] {
  if (!loras || loras.length === 0) return fallback
  return [loraNodeId(loras.length - 1), 0]
}

/**
 * Build the ComfyUI API-format workflow JSON for MiniMax H3 Two-Pass Latent Upscaler.
 */
/** (правка 258) Pass 1 (low-res) не может быть больше min(2.0, finalRes).
 *  Единая функция для workflow И метаданных — иначе сайдкар (и «Повторить»
 *  из него) нёс бы незаклёмпленный слайдер, разойдясь с реальным рендером. */
export function clampLowResMP(lowResMP: number, finalRes: number): number {
  // (правка 258) потолок первого прохода поднят 0.5 → 2.0 МП (дефолт 0.2 не
  // тронут): инвариант «pass 1 ≤ финального разрешения» сохраняется.
  // (правка 327) …кроме гарантированного минимума 1.0 МП: при финале 0.7 Мп
  // черновик можно поднять до 1.0 (лучше детализация первого прохода ценой
  // скорости). Выше финала (>1.0) pass 1 по-прежнему не уходит.
  return Math.min(lowResMP, Math.min(2, Math.max(finalRes, 1)))
}

/**
 * (правка 255) Сэмплер-узлы по стадиям В ПОРЯДКЕ выполнения — для честного
 * 0→100% прогресса в трекере. Формируется из ТЕХ ЖЕ параметров, что и
 * workflow (дефолты зеркалят buildExtendWorkflow):
 *   - t2v/flf/ref: 'full' → [['46:21'], ['46:16']] (pass 1 + pass 2),
 *     'draft' → [['46:21']] (единственный проход);
 *   - extend → [['ext_samp_0'], ['ext_samp_1'], …] по клипам;
 *     (правка 423) extendTwoPass → после каждого клипа ещё его pass 2:
 *     [['ext_samp_0'], ['ext_samp2_0'], ['ext_samp_1'], ['ext_samp2_1'], …].
 */
export function videoSamplerStages(p: MiniMaxH3Params): string[][] {
  if (p.mode === 'extend') {
    const clips = p.extendClips && p.extendClips.length > 0
      ? p.extendClips
      : [{ prompt: p.prompt, duration: p.duration, seed: p.seed }]
    return clips.flatMap((_, i) =>
      p.extendTwoPass === true
        ? [[`ext_samp_${i}`], [`ext_samp2_${i}`]]
        : [[`ext_samp_${i}`]],
    )
  }
  return p.pipeline === 'draft' ? [['46:21']] : [['46:21'], ['46:16']]
}

// (правка 423) Sigma variants для pass 2 — в module scope: используются и
// основным билдером ('46:33'), и двухпроходным extend (ext_sig2_*).
const SIGMA_VARIANTS: Record<string, string> = {
  '3step': '0.9035, 0.6316, 0.3158, 0.0000',
  '4step': '0.9035, 0.8000, 0.6316, 0.3158, 0.0000',
  '5step': '0.9231, 0.8780, 0.8000, 0.6316, 0.3158, 0.0000',
  '6step': '0.9412, 0.9100, 0.8780, 0.8000, 0.6316, 0.3158, 0.0000',
  '7step': '0.9500, 0.9280, 0.9100, 0.8780, 0.8000, 0.6316, 0.3158, 0.0000',
}

export function buildMiniMaxH3Workflow(p: MiniMaxH3Params): Record<string, unknown> {
  const seed = p.seed < 0 ? Math.floor(Math.random() * 2 ** 31) : p.seed
  // (правка 386) входы VHS-вывода из настроек формата
  const vhsEnc = vhsEncodeInputs(p.videoFormat)
  const finalRes = p.finalResolution ?? 0.7
  const lowResMP = clampLowResMP(p.lowResMP ?? 0.2, finalRes)
  // Дефолт точки сплита = 6. Прежний дефолт был 4.
  const firstSteps = p.firstSamplerSteps ?? 6
  // Всего шагов в расписании pass 1. По умолчанию — столько же, сколько
  // забирает сплит («6 из 6»). Задаётся независимо → можно взять «6 из 8».
  const totalSteps = Math.max(
    2,
    Math.min(64, Math.round(p.firstSamplerTotalSteps ?? firstSteps)),
  )
  // Сплит не может превышать число доступных сигм (steps+1) — иначе нода
  // SplitSigmas получит несуществующий индекс.
  const splitStep = Math.max(1, Math.min(firstSteps, totalSteps))

  // (правка 258) Ограничение: pass 1 (low-res) максимум min(2.0, finalResolution).
  // Это черновик — не должен быть больше финального разрешения.
  // Кламп вынесен в clampLowResMP — метаданные используют ТО ЖЕ значение.
  // Sigma variants for pass 2 (правка 423: таблица в module scope — SIGMA_VARIANTS)
  const sigmaVariant = SIGMA_VARIANTS[p.sigmaVariant || '3step'] || SIGMA_VARIANTS['3step']
  // (правка 69) Pass 2 sampler — из доп. настроек, валидация по белому списку
  const pass2Sampler = (VALID_KSAMPLERS as readonly string[]).includes(p.pass2Sampler || '')
    ? (p.pass2Sampler as string)
    : DEFAULT_PASS2_SAMPLER
  // (правка 70) Pass 1: сэмплер + планировщик из доп. настроек
  const pass1Sampler = (VALID_KSAMPLERS as readonly string[]).includes(p.pass1Sampler || '')
    ? (p.pass1Sampler as string)
    : DEFAULT_PASS1_SAMPLER
  const pass1Scheduler = (PASS1_SCHEDULERS as readonly string[]).includes(p.pass1Scheduler || '')
    ? (p.pass1Scheduler as string)
    : DEFAULT_PASS1_SCHEDULER
  // Турбо-лора — обычная запись customLoras (ON по умолчанию), как и
  // пользовательские LoRA; порядок задаёт loras.json.

  // ─── (правка 146) Режим генерации ───
  const mode: 'ref' | 't2v' | 'flf' | 'extend' = p.mode === 't2v' || p.mode === 'flf' || p.mode === 'extend' ? p.mode : 'ref'

  // (правка 161) Режим продления — отдельный workflow через MiniMaxH3Extender
  if (mode === 'extend') {
    return buildExtendWorkflow(p)
  }

  // ─── Reference images (max 9) — только в режиме 'ref' ───
  // (правка 266) В режиме 'extend' картинки-рефы привязываются ВНУТРИ
  // buildExtendWorkflow к ext_cond_* узлам через ref_images.ref_image_N.
  const refCount = mode === 'ref' ? Math.min(p.refImages.length, 9) : 0
  const refImageNodes: Record<string, unknown> = {}
  const refImageLinks: Record<string, unknown> = {}

  for (let i = 0; i < refCount; i++) {
    const loadId = REF_IMAGE_NODE_IDS[i]
    refImageNodes[loadId] = {
      inputs: { image: p.refImages[i] },
      class_type: 'LoadImage',
      _meta: { title: `Reference ${i + 1}` },
    }
    refImageLinks[`ref_images.ref_image_${i}`] = [loadId, 0]
  }

  // ─── Reference videos (max 3) — VHS_LoadVideo → IMAGE frames + optional AUDIO — только 'ref' ───
  const refVideoCount = mode === 'ref' ? Math.min(p.refVideos?.length ?? 0, 3) : 0
  const refVideoNodes: Record<string, unknown> = {}
  const refVideoLinks: Record<string, unknown> = {}

  for (let i = 0; i < refVideoCount; i++) {
    const vid = p.refVideos![i]
    const nodeId = REF_VIDEO_NODE_IDS[i]
    refVideoNodes[nodeId] = {
      // (правка 320) force_rate 24: модель интерпретирует кадры как 1/24 с.
      // Было force_rate: 0 → реф 30 fps давал duration×30 кадров → референс
      // «проигрывался» моделью на 25% медленнее, а его аудио (оригинальной
      // длительности, VHS audio passthrough) не совпадало с кадрами.
      // force_rate дропает/дублирует кадры СОХРАНЯЯ длительность (VHS
      // cv/ffmpeg генераторы), поэтому аудио-реф остаётся синхронным.
      inputs: { video: vid.path, force_rate: 24, custom_width: 0, custom_height: 0, frame_load_cap: 0, skip_first_frames: 0, select_every_nth: 1 },
      class_type: 'VHS_LoadVideo',
      _meta: { title: `Video Ref ${i + 1}` },
    }
    // output[0] = IMAGE (frames) → ref_video_N
    refVideoLinks[`ref_videos.ref_video_${i}`] = [nodeId, 0]
    // If includeAudio, wire output[2] = AUDIO → ref_video_audio_N
    if (vid.includeAudio !== false) {
      refVideoLinks[`ref_video_audios.ref_video_audio_${i}`] = [nodeId, 2]
    }
  }

  // ─── Standalone audio references (max 3) — LoadAudio → AUDIO ───
  // (правка 146) в режимах ref они идут в ref_audio_N основной ноды,
  // в t2v/flf — в цепочку MiniMaxH3AddGuide (см. ниже). В ref с audioGuide
  // (опция «оригинальный звук + вести по нему») ref_audios НЕ подключаются:
  // те же аудио идут в Audio Guide, а дорожку потом подставляет сервер.
  const refAudioCount = Math.min(p.refAudios?.length ?? 0, 3)
  const refAudioNodes: Record<string, unknown> = {}
  const refAudioLinks: Record<string, unknown> = {}
  // (правка 326) Итоговые источники AUDIO с учётом обрезки — для ref-линков
  // и цепочки Audio Guide (t2v/flf).
  const refAudioSrcs: Record<number, [string, number]> = {}

  for (let i = 0; i < refAudioCount; i++) {
    const nodeId = REF_AUDIO_NODE_IDS[i]
    refAudioNodes[nodeId] = {
      inputs: { audio: p.refAudios![i] },
      class_type: 'LoadAudio',
      _meta: { title: `Audio Ref ${i + 1}` },
    }
    // (правка 326) Обрезка аудио-рефа: LoadAudio → MiniMaxStudioAudioTrim →
    // потребитель (ref_audio_N / Audio Guide). Виртуально, без копий файла.
    let audioSrc: [string, number] = [nodeId, 0]
    const trim = p.refAudioTrims?.[i]
    if (trim && (trim.start > 0 || (trim.end != null && trim.end > 0))) {
      const trimId = `${nodeId}_trim`
      refAudioNodes[trimId] = {
        inputs: {
          audio: [nodeId, 0],
          start_seconds: trim.start,
          end_seconds: trim.end ?? 0,
        },
        class_type: 'MiniMaxStudioAudioTrim',
        _meta: { title: `Audio Ref ${i + 1}: обрезка ${trim.start}с → ${trim.end ?? 'конец'}` },
      }
      audioSrc = [trimId, 0]
    }
    // (правка 694) Громкость аудио-рефа: AudioTrim/LoadAudio → AudioGain → потребитель.
    const vol = p.refAudioVolumes?.[i]
    if (vol != null && Math.abs(vol - 1.0) > 1e-6) {
      const gainId = `${nodeId}_gain`
      refAudioNodes[gainId] = {
        inputs: { audio: audioSrc, gain: vol },
        class_type: 'MiniMaxStudioAudioGain',
        _meta: { title: `Audio Ref ${i + 1}: громкость ${Math.round(vol * 100)}%` },
      }
      audioSrc = [gainId, 0]
    }
    if (mode === 'ref' && p.audioGuide !== true) {
      refAudioLinks[`ref_audios.ref_audio_${i}`] = audioSrc
    }
    // t2v/flf: источник для MiniMaxH3AddGuide (ниже) — с учётом обрезки и громкости.
    refAudioSrcs[i] = audioSrc
  }

  // ─── H3 node inputs ───
  // Resolution: pass 1 всегда lowResMP (кроме flf — там finalRes, правка 153)
  // (правка 152) В режиме flf с известными размерами кадра — используем их пропорцию
  let aspect = p.aspectRatio || '16:9 (Widescreen)'
  // (правка 152) Если есть размеры первого кадра — пересчитываем aspect ratio из них
  if (mode === 'flf' && p.firstFrameWidth && p.firstFrameHeight) {
    const ratio = p.firstFrameWidth / p.firstFrameHeight
    // Находим ближайший стандартный aspect ratio
    if (Math.abs(ratio - 21/9) < 0.2) aspect = '21:9 (Ultrawide)'
    else if (Math.abs(ratio - 16/9) < 0.15) aspect = '16:9 (Widescreen)'
    else if (Math.abs(ratio - 9/16) < 0.15) aspect = '9:16 (Portrait Widescreen)'
    else if (Math.abs(ratio - 1) < 0.1) aspect = '1:1 (Square)'
    else if (Math.abs(ratio - 4/3) < 0.15) aspect = '4:3 (Standard)'
    else if (Math.abs(ratio - 3/4) < 0.15) aspect = '3:4 (Portrait Standard)'
    else if (Math.abs(ratio - 3/2) < 0.15) aspect = '3:2 (Photo)'
    else if (Math.abs(ratio - 2/3) < 0.15) aspect = '2:3 (Portrait Photo)'
    else aspect = '16:9 (Widescreen)'
  }
  // (правка 525) Если targetDimensions задан (пресеты 480p/720p/1080p × aspect),
  // aspect ratio должен быть вычислен из него, чтобы lowRes (pass 1) имел ту же
  // пропорцию, что и final. Иначе апскейлер MinimaxH3LatentUpscaler3D в режиме
  // 'target dimensions' масштабирует lowRes → final с РАЗНЫМ коэффициентом по
  // осям → искажение (сплющивание). Пример: targetDimensions=640×480 (4:3), но
  // aspect='16:9' → lowRes=608×352 (пропорция 16:9) → upscale x1.05 y1.36.
  // (При singleCanvas — flf/draft — lowRes уже считается из targetDimensions,
  // так что aspect не важен, но пересчёт безвреден.)
  if (p.targetDimensions) {
    aspect = `${p.targetDimensions.width}:${p.targetDimensions.height}`
  }
  // (правка 153) В режиме flf pass 1 генерируется в ТОМ ЖЕ разрешении, что и pass 2.
  // Причина: keyframe кодируется ОДИН раз (vae.encode) под разрешение pass 1.
  // Если pass 1 ≠ pass 2, апскейлер масштабирует latent, но keyframe latent
  // остаётся "старым" (low-res) → фикс 149 перекодирует его под pass 2, но
  // vae.encode() под разными разрешениями даёт РАЗНЫЕ latent'ы → модель видит
  // "два разных кадра" → ghosting/двоение.
  //
  // Решение: в flf pass 1 = pass 2 разрешение. Тогда:
  //   1. Keyframe кодируется один раз под это разрешение
  //   2. Pass 1 работает в этом разрешении — keyframe latent совпадает
  //   3. Upscaler делает early-return (w_out == w_in && h_out == h_in)
  //   4. Pass 2 работает в том же разрешении — keyframe latent ИДЕНТИЧЕН pass 1
  //
  // Это устраняет "задвоение" в режиме кадров.
  //
  // ВАЖНО: selectResolution() и finalDimsFromMegapixels() используют РАЗНЫЕ
  // формулы (Math.round vs pyRound, разные расчёты scale), поэтому даже при
  // одном MP могут дать разные размеры. Чтобы гарантировать early-return
  // апскейлера, в flf мы: (а) считаем lowRes через selectResolution или из
  // targetDimensions, (б) передаём его как final — тогда final = computeFinalDimensions
  // даст genW = lowRes.w, genH = lowRes.h (ceil32 уже сделан).
  // (правка 155) В flf с пресетом (480p/720p/1080p) targetDimensions = номинал,
  // чтобы 480p и 720p давали разные разрешения (480×854 vs 720×1280 для 9:16).
  // Без пресета — finalRes MP (по умолчанию 0.7).
  const flfSinglePass = mode === 'flf'
  // Пайплайн «Драфт»: ОДИН проход по ПОЛНОМУ графику BasicScheduler
  // (шаги = draftSteps, без SplitSigmas — в 'full' сплит отрезает верхнюю
  // половину траектории под Pass 2, здесь Pass 2 нет). Без апскейлера и
  // второго прохода. Выход = черновик для отбора; апгрейд — вкладка Refine.
  const draft = p.pipeline === 'draft'
  const draftSteps = Math.min(30, Math.max(2, Math.round(p.draftSteps ?? 4)))
  // Канва одиночного прохода (flf и draft) берётся из ОСНОВНЫХ настроек
  // разрешения: пресет → targetDimensions (ceil32), свободное → finalRes MP.
  // lowResMP из доп. настроек управляет только канвой Pass 1 в 'full'.
  // (правка 156) В режиме flf single-pass: pass 1 должен генерироваться в ТОМ ЖЕ
  // разрешении, что и pass 2. Если есть targetDimensions — используем их для lowRes,
  // иначе finalRes MP. Это гарантирует, что lowRes == final и апскейлер делает
  // early-return (нет масштабирования → нет изменения пропорций).
  // ВАЖНО: ComfyUI требует кратность 32 для latent-размеров. targetDimensions из
  // пресетов (480×854, 720×1280) не кратны 32 — округляем до кратного 32 (ceil32).
  // (драфт) Канва одиночного прохода — как во flf: из ОСНОВНЫХ настроек.
  const singleCanvas = flfSinglePass || draft
  // (правка 124) Точное соотношение сторон + ТОЧНОЕ итоговое разрешение:
  //   • пресеты качества — номинальные размеры (targetDimensions),
  //     gen = ceil32(nominal), апскейлер «target dimensions», итог —
  //     кроп ровно до номинала (16:9 1080p → 1920×1088 → 1920×1080);
  //   • свободное разрешение — бинарные MP узла + вписанный кроп
  //     (finalDimsFromMegapixels).
  // (правка 153) В flf single-pass: final = computeFinalDimensions(lowRes)
  // — апскейлер делает early-return, keyframe latent остаётся идентичным.
  // (правка 155) В flf с targetDimensions — используем номинал (480p/720p/1080p),
  // без — lowRes (из finalRes MP).
  // computeFinalDimensions / finalDimsFromMegapixels — единый источник
  // истины для workflow (target dimensions + ImageCrop), метаданных
  // (pending-meta, use-video-gen) и UI-бейджей — везде один результат.
  // (правка 156) Одиночная канва (flf/draft): final = computeFinalDimensions
  // (ceil32) — апскейлер делает early-return / не нужен, кропа нет.
  // В других режимах — targetDimensions (номинал) или finalRes MP.
  const final = singleCanvas
    ? (p.targetDimensions
      ? computeFinalDimensions(
          Math.max(32, Math.ceil(p.targetDimensions.width / 32) * 32),
          Math.max(32, Math.ceil(p.targetDimensions.height / 32) * 32),
        )
      : computeFinalDimensions(
          ...(() => {
              const r = selectResolution(aspect, finalRes)
              return [r.w, r.h] as [number, number]
            })(),
        ))
    : p.targetDimensions
      ? computeFinalDimensions(p.targetDimensions.width, p.targetDimensions.height)
      : finalDimsFromMegapixels(aspect, finalRes)
  // (правка 525 REVISED) Канва pass 1: подбираем lowResMP так, чтобы
  // selectResolution(aspect, lowResMP) имел ту же пропорцию, что и final
  // (или как можно ближе). Тогда апскейл lowRes → final будет равномерным
  // (x_factor ≈ y_factor) — без искажения. Pass 1 будет МЕНЬШЕ final
  // (быстрее генерация), но с той же пропорцией.
  //
  // Алгоритм: ищем lowResMP в диапазоне [0.05, 0.5] (или ниже, если userMP < 0.05)
  // так, чтобы minimize |x_factor - y_factor|, где:
  //   x_factor = final.genW / lowRes.w
  //   y_factor = final.genH / lowRes.h
  //
  // Ограничения:
  //  - lowRes НИ ПО ОДНОЙ ОСИ не должен превышать final (иначе ValueError)
  //  - если x_factor и y_factor оба < 1.25 — pass 1 = final (правка 439 аналог)
  //
  // В singleCanvas (flf/draft) lowRes = ceil32(targetDimensions) или
  // selectResolution(aspect, finalRes) — апскейлер early-return.
  // В 'full' без targetDimensions (free-MP) — как раньше: selectResolution
  // (aspect, lowResMP); aspect и final имеют ОДНУ ПРОПОРЦИЮ → апскейл ~1×.
  const finalMP = (final.genW * final.genH) / (1024 * 1024)
  let lowRes: { w: number; h: number }
  if (singleCanvas) {
    // flf/draft: lowRes = ceil32(targetDimensions) или selectResolution(finalRes)
    lowRes = p.targetDimensions
      ? {
          w: Math.max(32, Math.ceil(p.targetDimensions.width / 32) * 32),
          h: Math.max(32, Math.ceil(p.targetDimensions.height / 32) * 32),
        }
      : selectResolution(aspect, finalRes)
  } else if (p.targetDimensions) {
    // 'full' с пресетом: подбираем lowResMP, чтобы пропорция lowRes ≈ пропорция final
    // (minimize |x_factor - y_factor|), при этом lowRes ≤ final по обеим осям.
    const userMP = clampLowResMP(p.lowResMP ?? 0.2, finalRes)
    // Диапазон поиска: от 0.05 до max(userMP, 0.5), но не выше finalMP
    const searchHi = Math.min(Math.max(userMP, 0.5), finalMP)
    const searchLo = 0.05
    let bestDistortion = Infinity
    let bestResult = selectResolution(aspect, userMP)
    // Итеративный поиск: пробуем разные значения MP и выбираем то, что даёт
    // минимальное |x_factor - y_factor| при условии lowRes ≤ final
    const numSteps = 50
    for (let i = 0; i <= numSteps; i++) {
      const mp = searchLo + (searchHi - searchLo) * (i / numSteps)
      const r = selectResolution(aspect, mp)
      // Проверяем, что lowRes ≤ final по обеим осям
      if (r.w > final.genW || r.h > final.genH) continue
      const xFactor = final.genW / r.w
      const yFactor = final.genH / r.h
      const distortion = Math.abs(xFactor - yFactor)
      // Проверяем, что апскейл не слишком мал (< 1.25× по обеим осям → бессмысленно)
      const isTrivial = xFactor < 1.25 && yFactor < 1.25
      if (isTrivial) continue // пропускаем, чтобы pass 1 был реально меньше final
      if (distortion < bestDistortion) {
        bestDistortion = distortion
        bestResult = r
      }
    }
    // (правка 439 аналог) Если не нашли подходящий lowRes (все либо > final,
    // либо апскейл < 1.25×) — pass 1 = final, апскейлер early-return.
    if (bestDistortion === Infinity) {
      lowRes = { w: final.genW, h: final.genH }
    } else {
      lowRes = bestResult
    }
  } else {
    // 'full' без targetDimensions (free-MP): как раньше
    lowRes = selectResolution(aspect, lowResMP)
  }
  const needsCrop = final.genW !== final.outW || final.genH !== final.outH
  // (правка 146) Главный H3-узел зависит от режима: референсы →
  // MiniMaxH3ReferenceToVideo (как раньше), t2v/flf → MiniMaxH3ImageToVideo
  // (+ LoadImage ноды кадров для flf). Выходы у обеих одинаковые
  // (conditioning + latent) — весь последующий конвейер не меняется.
  const flfNodes: Record<string, unknown> = {}
  let h3Class = 'MiniMaxH3ReferenceToVideo'
  let h3Title = 'MiniMax H3 Reference to Video'
  let h3Inputs: Record<string, unknown>
  if (mode === 'ref') {
    h3Inputs = {
      prompt: p.prompt,
      width: lowRes.w,
      height: lowRes.h,
      length: ['46:19', 1],
      ref_image_size: p.refImageSize || 'match', // (правка 58) match | max — из доп. настроек
      clip: ['46:15', 0],
      vae: ['46:3', 0],
      audio_vae: ['46:4', 0],
      ...refImageLinks,
      ...refVideoLinks,
      ...refAudioLinks,
    }
  } else {
    h3Class = 'MiniMaxH3ImageToVideo'
    h3Title = mode === 'flf'
      ? 'MiniMax H3 First/Last Frame to Video'
      : 'MiniMax H3 Text to Video'
    h3Inputs = {
      prompt: p.prompt,
      width: lowRes.w,
      height: lowRes.h,
      length: ['46:19', 1],
      clip: ['46:15', 0],
      vae: ['46:3', 0],
    }
    if (mode === 'flf') {
      if (!p.firstFrame) {
        throw new Error('Режим «первый/последний кадр»: не задан первый кадр')
      }
      flfNodes[FIRST_FRAME_NODE_ID] = {
        inputs: { image: p.firstFrame },
        class_type: 'LoadImage',
        _meta: { title: 'First frame' },
      }
      h3Inputs.first_frame = [FIRST_FRAME_NODE_ID, 0]
      if (p.lastFrame) {
        flfNodes[LAST_FRAME_NODE_ID] = {
          inputs: { image: p.lastFrame },
          class_type: 'LoadImage',
          _meta: { title: 'Last frame' },
        }
        h3Inputs.last_frame = [LAST_FRAME_NODE_ID, 0]
      }
    }
  }

  // (правка 146) t2v/flf: аудио-референсы подаются цепочкой MiniMaxH3AddGuide —
  // у MiniMaxH3ImageToVideo аудио-входов нет. Каждый гайд якорит свой аудио на
  // кадр 0 (озвучка всего клипа); conditioning следующих узлов идёт с хвоста
  // цепочки.
  const audioGuideNodes: Record<string, unknown> = {}
  let condSrc: [string, number] = ['46:11', 0]
  if ((mode !== 'ref' || p.audioGuide === true) && refAudioCount > 0) {
    for (let i = 0; i < refAudioCount; i++) {
      const gid = AUDIO_GUIDE_NODE_IDS[i]
      audioGuideNodes[gid] = {
        inputs: {
          positive: condSrc,
          latent: ['46:11', 1],
          frame_idx: 0,
          audio: refAudioSrcs[i] ?? [REF_AUDIO_NODE_IDS[i], 0], // (правка 326) с учётом обрезки
          audio_vae: ['46:4', 0],
        },
        class_type: 'MiniMaxH3AddGuide',
        _meta: { title: `Audio Guide ${i + 1}` },
      }
      condSrc = [gid, 0]
    }
  }

  // ─── Model optimization chain (optional nodes) ───
  // UNET → [LowVRAM] → [ChunkFF] → (LoRA input). `modelSrc` walks down
  // the chain as nodes get enabled, so the LoRA always receives the
  // last patch in the chain (or the raw UNET when both are off).
  const lowVram = p.lowVramAttention !== false
  const chunkFF = p.chunkFeedForward !== false
  const modelNodes: Record<string, unknown> = {}
  let modelSrc: [string, number] = ['46:30', 0]
  if (lowVram) {
    modelNodes['46:43'] = {
      inputs: { head_chunks: 4, model: modelSrc },
      class_type: 'MiniMaxLowVRAMAttention',
      _meta: { title: 'Low VRAM Attention' },
    }
    modelSrc = ['46:43', 0]
  }
  if (chunkFF) {
    modelNodes['46:40'] = {
      inputs: {
        chunks: Math.max(1, Math.round(p.chunkFFChunks ?? 2)),
        seq_threshold: Math.max(0, Math.round(p.chunkFFThreshold ?? 4096)),
        model: modelSrc,
      },
      class_type: 'MiniMaxChunkFeedForward',
      _meta: { title: 'Chunk FeedForward' },
    }
    modelSrc = ['46:40', 0]
  }

  const workflow: Record<string, unknown> = {
    // ═══════════════════════════════════════════════
    //  INPUTS
    // ═══════════════════════════════════════════════

    // Duration → Frames calculation
    '17': {
      inputs: { value: p.duration },
      class_type: 'PrimitiveFloat',
      _meta: { title: 'Duration (seconds)' },
    },
    '46:19': {
      inputs: {
        expression: 'max(5, round(a * 24)) + (5 - (max(5, round(a * 24)) % 17)) % 17',
        'values.a': ['17', 0],
      },
      class_type: 'ComfyMathExpression',
      _meta: { title: 'Frames Calculation' },
    },

    // Low-res resolution is computed server-side (selectResolution) and fed
    // to the H3 node as plain ints — no ResolutionSelector node needed
    // (it cannot express e.g. 2.35:1).

    // (правка 124) Нода '23' (PrimitiveFloat final MP) удалена: апскейлер
    // получает точные размеры напрямую (mode.width / mode.height).

    // ═══════════════════════════════════════════════
    //  MODEL LOADING
    // ═══════════════════════════════════════════════

    '46:30': {
      inputs: {
        // (правка 293) Дефолт — вернули основную модель (была лучше по качеству)
        unet_name: p.diffusionModel || 'minimax_h3_fastvideo_vsa_datafree_1300step_4step_int8_convrot.safetensors',
        weight_dtype: 'default',
      },
      class_type: 'UNETLoader',
      _meta: { title: 'Загрузить модель диффузии' },
    },
    '46:15': {
      inputs: {
        clip_name: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
        type: 'minimax',
        device: 'default',
      },
      class_type: 'CLIPLoader',
      _meta: { title: 'Загрузить CLIP' },
    },
    '46:3': {
      inputs: { vae_name: 'minimax_h3_video_vae_int8_convrot.safetensors' },
      class_type: 'VAELoader',
      _meta: { title: 'VAE (video)' },
    },
    '46:4': {
      inputs: { vae_name: 'minimax_h3_audio_vae_fp32.safetensors' },
      class_type: 'VAELoader',
      _meta: { title: 'VAE (audio)' },
    },

    // ═══════════════════════════════════════════════
    //  MODEL OPTIMIZATION CHAIN (optional nodes)
    //  UNET → [LowVRAM] → [ChunkFF] → LoRA → SigmaShift → Attention → Preview
    // ═══════════════════════════════════════════════

    ...modelNodes,

    // Турбо-лора — обычная запись customLoras (ON по умолчанию), как и
    // пользовательские LoRA; порядок задаёт loras.json.
    ...buildCustomLoraNodes(p.customLoras, modelSrc),
    // Sigma Shift (receives last node in the LoRA chain)
    '46:38': {
      inputs: {
        shift_video: 12,
        shift_audio: 3,
        model: getLastLoraOutput(p.customLoras, modelSrc),
      },
      class_type: 'MiniMaxH3SigmaShift',
      _meta: { title: 'Sigma Shift' },
    },
    // (правка 301) Sparse attention: Veda (если включена) или Sol-Attn (по умолчанию).
    // Veda: для длинных видео (10+ сек) и 8+ шагов. Sol-Attn: для коротких клипов.
    ...(p.vedaAttention ? {
      '46:44': {
        inputs: {
          // (правка 422) Veda ПОСЛЕ Attention Backend: обе ноды пишут
          // transformer_options['optimized_attention_override'], Veda
          // композитит поверх текущего, backend — перезаписывает. Если
          // backend идёт после Veda, хуки Veda затираются и она не работает.
          model: ['46:37', 0],
          predictor: 'minimax_h3_t2va_veda_8nfe_600step_preview_fp8.safetensors',
          // (правка 399) параметры ноды — из настроек программы
          generated_sparsity: clampVedaSparsity(p.vedaGeneratedSparsity, 90),
          reference_sparsity: clampVedaSparsity(p.vedaReferenceSparsity, 90),
          full_attention_layers: sanitizeVedaIndexList(p.vedaFullAttentionLayers),
          full_attention_steps: sanitizeVedaIndexList(p.vedaFullAttentionSteps),
          verbose: p.vedaVerbose === true,
        },
        class_type: 'VedaSparseAttention',
        _meta: { title: 'Veda Sparse Attention' },
      },
    } : p.sparseAttention === true ? { // (правка 387) Sol-Attn по умолчанию OFF
      '46:44': {
        inputs: {
          model: ['46:37', 0], // (правка 422) sparse — ПОСЛЕ Attention Backend, см. выше
          // (правка 466) Параметры — из Настроек → Оптимизация генерации
          tau: p.sparseTau ?? 1.3,
          start_percent: p.sparseStartPercent ?? 0.2,
          end_percent: p.sparseEndPercent ?? 1.0,
          min_tokens: p.sparseMinTokens ?? 12288,
          extra_tokens: p.sparseExtraTokens ?? 256,
        },
        class_type: 'MiniMaxSparseAttention',
        _meta: { title: 'Sparse Attention (Sol-Attn)' },
      },
    } : {}),
    // Attention Backend (подключается к SigmaShift или к sparse attention узлу)
    '46:37': {
      inputs: {
        attention: 'comfy kitchen attention',
        // (правка 422) Backend сразу после SigmaShift; sparse-нода ('46:44')
        // теперь идёт ПОСЛЕ него — последним патчем attention перед сэмплером.
        model: ['46:38', 0],
      },
      class_type: 'ModelAttentionBackend',
      _meta: { title: 'Attention Backend' },
    },
    // Live Preview (attached to pass 1 only)
    '12': {
      inputs: {
        // (правка 422) хвост цепочки: sparse-нода, если включена, иначе backend
        model: (p.vedaAttention || p.sparseAttention === true) ? ['46:44', 0] : ['46:37', 0],
        vae: ['46:3', 0],
        tiny_vae: 'taeh3.safetensors',
        max_resolution: 1024,
        jpeg_quality: 80,
        suppress_default_preview: true,
        preview_frames: ['46:19', 1],
        preview_fps: 6,
      },
      class_type: 'ModelPreviewOverrideKJ',
      _meta: { title: 'Model Preview Override' },
    },

    // ═══════════════════════════════════════════════
    //  MAIN H3 NODE (Reference to Video)
    // ═══════════════════════════════════════════════

    '46:11': {
      inputs: h3Inputs,
      class_type: h3Class,
      _meta: { title: h3Title },
    },

    // (правка 146) flf: LoadImage первого/последнего кадра
    ...flfNodes,
    // (правка 146) t2v/flf: цепочка аудио-гайдов
    ...audioGuideNodes,

    // ═══════════════════════════════════════════════
    //  SAMPLING COMMON
    // ═══════════════════════════════════════════════

    // (правки 67, 70) Pass 1: сэмплер + планировщик на выбор (default euler / simple).
    // (правки 68–69) Pass 2: сэмплер на выбор (default euler) —
    // сигмы остаются ManualSigmas.
    '46:18a': {
      inputs: { sampler_name: pass1Sampler },
      class_type: 'KSamplerSelect',
      _meta: { title: `KSampler Pass 1 (${pass1Sampler})` },
    },
    '46:18': {
      inputs: { sampler_name: pass2Sampler },
      class_type: 'KSamplerSelect',
      _meta: { title: `KSampler Pass 2 (${pass2Sampler})` },
    },
    '46:31': {
      inputs: { noise_seed: seed },
      class_type: 'RandomNoise',
      _meta: { title: 'Случайный шум' },
    },

    // ═══════════════════════════════════════════════
    //  PASS 1: Low-res (0.2 MP, totalSteps → SplitSigmas)
    // ═══════════════════════════════════════════════

    // BasicScheduler: 'full' — totalSteps (по умолчанию = точке сплита,
    // «6 из 6»), SplitSigmas отдаёт Pass 1 верхнюю часть; 'draft' — график
    // единственного прохода длиной draftSteps, полный, без сплита.
    '46:24': {
      inputs: {
        scheduler: pass1Scheduler,
        steps: draft ? draftSteps : totalSteps,
        denoise: 1,
        model: ['46:30', 0],
      },
      class_type: 'BasicScheduler',
      _meta: {
        title: `Pass 1 Scheduler (${draft ? `${draftSteps} steps (draft)` : `${totalSteps} steps`}, ${pass1Scheduler})`,
      },
    },
    // SplitSigmas: take first splitStep of the total — только 'full'
    ...(!draft && {
      '46:13': {
        inputs: {
          step: splitStep,
          sigmas: ['46:24', 0],
        },
        class_type: 'SplitSigmas',
        _meta: { title: `Split Sigmas (take ${splitStep} of ${totalSteps})` },
      },
    }),
    // BasicGuider (pass 1 — uses Preview model)
    '46:29': {
      inputs: {
        model: ['12', 0],
        conditioning: condSrc, // (правка 146) хвост цепочки аудио-гайдов в t2v/flf
      },
      class_type: 'BasicGuider',
      _meta: { title: 'Pass 1 Guider' },
    },
    // SamplerCustomAdvanced (pass 1). 'full': split-сигмы (верхняя ПОЛОВИНА
    // траектории — компоновка; хвост дорисует Pass 2). 'draft': полный
    // график BasicScheduler ('46:24') — единственный проход с нуля, выход
    // сразу в decode.
    '46:21': {
      inputs: {
        noise: ['46:31', 0],
        guider: ['46:29', 0],
        sampler: ['46:18a', 0],
        sigmas: draft ? ['46:24', 0] : ['46:13', 0],
        latent_image: ['46:11', 1],
      },
      class_type: 'SamplerCustomAdvanced',
      _meta: { title: draft ? 'Draft Sampler (single pass, full schedule)' : 'Pass 1 Sampler (low-res, split sigmas)' },
    },

    // ═══════════════════════════════════════════════
    //  LATENT UPSAMPLE (только 'full')
    // ═══════════════════════════════════════════════

    ...(!draft && {
      // Separate AV latent from pass 1
      '46:35': {
        inputs: { av_latent: ['46:21', 1] },
        class_type: 'LTXVSeparateAVLatent',
        _meta: { title: 'Separate AV Latent' },
      },
      // Upscale video latent to target resolution
      // (правка 124) Режим «target dimensions»: узел выдаёт ровно genW×genH,
      // независимо от пропорции pass 1 (megapixels-mode держал пропорцию
      // входа и округлял оси — из-за этого 16:9 не получалось точным).
      '46:26': {
        inputs: {
          model_name: 'minimax_h3_latent_upscaler_3d_fp16.safetensors',
          mode: 'target dimensions',
          'mode.width': final.genW,
          'mode.height': final.genH,
          align: 32,
          // enable_chunking — вход старых версий ноды; новые версии (pinned
          // 40316cf) переименовали его в enable_temporal_chunking и добавили
          // обязательный force_unload. ComfyUI игнорирует лишние входы, поэтому
          // отправляем оба имени — воркфлоу работает с любой версией ноды.
          enable_chunking: true, // (правка 68) было false — по запросу юзера
          enable_temporal_chunking: true,
          force_unload: true,
          device: 'cuda',
          precision: 'fp16',
          latent: ['46:35', 0],
        },
        class_type: 'MinimaxH3LatentUpscaler3D',
        _meta: { title: `Latent Upscaler (3D) → ${final.genW}×${final.genH}` },
      },
      // Re-combine upscaled video + audio latent
      '46:10': {
        inputs: {
          video_latent: ['46:26', 0],
          audio_latent: ['46:35', 1],
        },
        class_type: 'LTXVConcatAVLatent',
        _meta: { title: 'Concat AV Latent' },
      },
    }),

    // ═══════════════════════════════════════════════
    //  PASS 2: High-res refinement (3 steps) — только 'full'
    // ═══════════════════════════════════════════════

    ...(!draft && {
      // ManualSigmas лестницей Pass 2 (ре-рендер затравки от апскейлера)
      '46:33': {
        inputs: {
          sigmas: sigmaVariant,
        },
        class_type: 'ManualSigmas',
        _meta: { title: `Pass 2 Sigmas (${(p.sigmaVariant || '3step')})` },
      },
      // Live Preview (attached to pass 2)
      '13': {
        inputs: {
          // (правка 422) хвост цепочки: sparse-нода, если включена, иначе backend
          model: (p.vedaAttention || p.sparseAttention === true) ? ['46:44', 0] : ['46:37', 0],
          vae: ['46:3', 0],
          tiny_vae: 'taeh3.safetensors',
          max_resolution: 1024,
          jpeg_quality: 80,
          suppress_default_preview: true,
          preview_frames: ['46:19', 1],
          preview_fps: 6,
        },
        class_type: 'ModelPreviewOverrideKJ',
        _meta: { title: 'Model Preview Override (Pass 2)' },
      },
      // BasicGuider (pass 2 — uses Preview model)
      '46:32': {
        inputs: {
          model: ['13', 0],
          conditioning: condSrc, // (правка 146) хвост цепочки аудио-гайдов в t2v/flf
        },
        class_type: 'BasicGuider',
        _meta: { title: 'Pass 2 Guider' },
      },
      // SamplerCustomAdvanced (pass 2)
      '46:16': {
        inputs: {
          noise: ['46:31', 0],
          guider: ['46:32', 0],
          sampler: ['46:18', 0],
          sigmas: ['46:33', 0],
          latent_image: ['46:10', 0],
        },
        class_type: 'SamplerCustomAdvanced',
        _meta: { title: 'Pass 2 Sampler (high-res)' },
      },
    }),

    // ═══════════════════════════════════════════════
    //  DECODE (separate video + audio)
    // ═══════════════════════════════════════════════

    '46:25': {
      inputs: {
        // 'draft': единственный проход ('46:21'); 'full': Pass 2 ('46:16')
        samples: draft ? ['46:21', 0] : ['46:16', 0],
        vae: ['46:3', 0],
      },
      class_type: 'VAEDecode',
      _meta: { title: 'Decode Video' },
    },

    // (правка 124) Кроп gen-разрешения (кратное 32, чуть больше номинала)
    // до ТОЧНОГО номинала (например 16:9 1080p: 1920×1088 → 1920×1080).
    // Нода ставится только когда gen ≠ номинал — иначе цепочка без изменений.
    // ('draft' не кропается: канва selectResolution уже /32 = точный итог.)
    ...(needsCrop && !draft && {
      '46:48': {
        inputs: {
          image: ['46:25', 0],
          width: final.outW,
          height: final.outH,
          x: final.cropX,
          y: final.cropY,
        },
        class_type: 'ImageCrop',
        _meta: { title: `Точный кроп → ${final.outW}×${final.outH}` },
      },
    }),
    '46:14': {
      inputs: {
        samples: draft ? ['46:21', 0] : ['46:16', 0],
        vae: ['46:4', 0],
      },
      class_type: 'VAEDecodeAudio',
      _meta: { title: 'Decode Audio' },
    },

    // ═══════════════════════════════════════════════
    //  OUTPUT
    // ═══════════════════════════════════════════════

    '45': {
      inputs: {
        frame_rate: 24,
        loop_count: 0,
        // (правка 91) Подпапка = папка проекта: VHS пишет в output/<folder>/.
        // Имя уже санитизировано на сервере (generate-роут, один сегмент).
        filename_prefix: p.outputSubfolder ? `${p.outputSubfolder}/Minimax_Studio` : 'Minimax_Studio',
        // (правка 386) формат/качество — из [video] настроек студии
        ...vhsEnc,
        save_metadata: false,
        pingpong: false,
        save_output: true,
        // (правка 121) через кроп-ноду, если соотношению нужен точный кроп
        images: needsCrop && !draft ? ['46:48', 0] : ['46:25', 0],
        audio: ['46:14', 0],
      },
      class_type: 'VHS_VideoCombine',
      _meta: { title: 'Video Combine' },
    },

    // ═══════════════════════════════════════════════
    //  SAVE AV LATENT (правка 375) — латент-пайплайн «драфт → рефайн»
    // ═══════════════════════════════════════════════
    // Сохраняем ТОТ ЖЕ выход сэмплера, что уходит в decode/mp4 ('46:25'/'46:14'):
    // draft → единственный проход '46:21', full → Pass 2 '46:16' (выход 0 =
    // финальный латент полной лестницы, заканчивающейся на σ=0). Связка с mp4
    // — НЕ по совпадению счётчиков (они у нод независимые), а по фактическому
    // пути из ui.latents: status-роут при финализации меты пишет его в сайдкар
    // как latent_file (pending-meta.ts). Рефайн при наличии латента стартует
    // с него напрямую, минуя h264-декод + повторный VAEEncode (lossless-путь).
    // Файл: output/<подпапка>/latents/Minimax_Studio_XXXXX_.latent (~1–10 МБ).
    '46:49': {
      inputs: {
        samples: draft ? ['46:21', 0] : ['46:16', 0],
        filename_prefix: p.outputSubfolder
          ? `${p.outputSubfolder}/latents/Minimax_Studio`
          : 'latents/Minimax_Studio',
        vae_name: 'minimax_h3_video_vae_int8_convrot.safetensors',
      },
      class_type: 'MiniMaxStudioSaveAVLatent',
      _meta: { title: 'Save AV Latent (для lossless-рефайна)' },
    },

    // ─── Reference image nodes (правка 55: up to 9) ───
    ...refImageNodes,

    // ─── Reference video nodes (VHS_LoadVideo) ───
    ...refVideoNodes,

    // ─── Reference audio nodes (LoadAudio) ───
    ...refAudioNodes,
  }

  return workflow
}

/* ═══════════════════════════════════════════════════════════
 * Режим продления — ОДНОПРОХОДНЫЙ.
 * (правка 247) Второй проход (апскейл + мягкий рефайн) УДАЛЁН:
 * ре-рендер каждого клипа своими сигмами ломал непрерывность на
 * стыках (те же артефакты, что раньше). Extender работает один —
 * на канве РАЗРЕШЕНИЯ ИСХОДНИКА (final.genW×genH), его внутренний
 * сэмплер (steps/sampler/scheduler, denoise 1.0) — полный траекторий.
 * Апгрейд разрешения продлённого видео — потом, вкладкой Refine.
 *
 *   LoadVideo (24 fps) → хвост (сетка 17n+5) → Resize(gen) → VAEEncode
 *     → AV-латент хвоста → preserved-голова клипа 0 (латент-маскинг,
 *     правка 252)
 *   (правка 419, эталон «V2V Extend Any Video»): окно контекста исходника
 *     2 с (56 кадров), а не 5 с; ВЕСЬ клин подаётся в conditioning как
 *     ref_image (батч кадров, слот после картинок юзера), ref_videos не
 *     используется; перекрытие сегмент-к-сегменту = 56 кадров.
 *   На каждый клип i: один сэмплер (латент-маскинг) → VAEDecode
 *     (+ VAEDecodeAudio) → VHS_VideoCombine extclip_<i>
 *     (клип i>0 — со срезом 22-кадровой preserved-головы в воркфлоу;
 *     клип 0 пишется С головой-хвостом исходника: её перекрытие
 *     17 кадров глушит ffmpeg-склейка клиента — Trim 9 + xfade 8)
 *   Клиент склеивает [исходник, клип0, клип1, …] через
 *   /api/comfy/concat (правка 417 — ОТКАТ латент-пайплайна extend:
 *   комбинированный латент, сегментный декод и единый вывод правок
 *   383/384/385/416 удалены — с пиксельной/латентной головой модель
 *   реплела исходник с кадра 0 либо замораживала конец; старая схема
 *   «каждый клип — свой mp4 + ffmpeg-склейка» проверена пользователем).
 *
 *   Превью: extpv (ModelPreviewOverrideKJ) оборачивает модель
 *   ДЛЯ Extender'а — обёртка срабатывает только если сэмплер
 *   получает ВЫХОД preview-ноды.
 */
function buildExtendWorkflow(p: MiniMaxH3Params): Record<string, unknown> {
  const seed = p.seed < 0 ? Math.floor(Math.random() * 2 ** 31) : p.seed
  const vhsEnc = vhsEncodeInputs(p.videoFormat) // (правка 386)

  // Клипы: из extendClips или из одного промпта
  const clips = p.extendClips && p.extendClips.length > 0
    ? p.extendClips
    : [{ prompt: p.prompt, duration: p.duration, seed: p.seed }]

  // ─── Разрешение ───
  const finalRes = p.finalResolution ?? 0.7
  // (правки 227 → 247) Однопроходная схема: ЕДИНСТВЕННАЯ канва = исходник,
  // ceil32 до сетки латента (роут ставит targetDimensions из ffprobe
  // исходника). Семейство целых множителей (правка 227b) держало инвариант
  // «аспект pass 1 = аспект gen» МЕЖДУ проходами — проходов больше нет,
  // инвариант не нужен; канва совпадает с исходником с точностью до ≤31 px.
  // (правка 431) Кратность 32, НЕ 16: VAE 16× даёт латент W/16 — при канве,
  // кратной лишь 16, латент НЕЧЁТНЫЙ (1680×720 → 105×45), а модель паддит
  // его до чётного (106×46). Тогда пост-сборка combined-латента (правка 420)
  // падает на LatentConcat: энкод исходника 105×45 ≠ клипы 106×46
  // («Expected size 46 but got size 45»). При /32 латент всегда чётный.
  // Без targetDimensions (продление без исходника) — MP-путь.
  const final = p.targetDimensions
    ? (() => {
        const w = Math.max(32, Math.ceil(p.targetDimensions!.width / 32) * 32)
        const h = Math.max(32, Math.ceil(p.targetDimensions!.height / 32) * 32)
        return { genW: w, genH: h, outW: w, outH: h, cropX: 0, cropY: 0 }
      })()
    : finalDimsFromMegapixels(p.aspectRatio || '16:9 (Widescreen)', finalRes)
  const needsCrop = final.genW !== final.outW || final.genH !== final.outH

  // (правка 423) Двухпроходный extend (опция, default OFF): pass 1 клипов
  // работает на low-res канве (lowResMP, как «full»-пайплайн генерации),
  // затем каждый клип апскейлится LatentUpscaler3D до размера исходника
  // и дорисовывается pass-2 сэмплером (ManualSigmas sigmaVariant). Если
  // апскейл-фактор ниже 1.5×, pass 1 сразу идёт в разрешении final (guard
  // ниже): LatentUpscaler3D на таком масштабе мылит, а не детализирует.
  // При выключенном флаге поведение однопроходное (правка 247), passW = final.
  // Темпоральная геометрия (токены/срезы/маски по времени) в обоих проходах
  // ИДЕНТИЧНА — апскейлер меняет только пространственные оси.
  const twoPass = p.extendTwoPass === true
  const finalMP = (final.genW * final.genH) / (1024 * 1024)
  // (правка 424) Канва pass 1 НИ ПО ОДНОЙ ОСИ не должна превышать final:
  // MinimaxH3LatentUpscaler3D умеет только upscale (effective_scale >= 1.0,
  // иначе ValueError в ноде). clampLowResMP имеет пол max(final, 1.0 МП)
  // (правка 327, для вкладки «Генерация») — на мелком исходнике extend он
  // разрешал канву pass 1 БОЛЬШЕ исходника (1312×576 при final ~1280×544)
  // и ронял апскейлер. Дополнительно страхуемся от округления к 32 в
  // selectResolution: уменьшаем MP, пока обе оси не влезут в final
  // (равенство допустимо — нода делает early-return).
  const lowRes = (() => {
    if (!twoPass) return { w: final.genW, h: final.genH }
    const aspect = `${final.genW}:${final.genH}`
    let mp = Math.min(clampLowResMP(p.lowResMP ?? 0.2, finalMP), finalMP)
    let r = selectResolution(aspect, mp)
    let guard = 0
    while ((r.w > final.genW || r.h > final.genH) && guard++ < 20 && mp > 0.05) {
      mp *= 0.8
      r = selectResolution(aspect, mp)
    }
    // (правка 439) Апскейл-фактор ниже 1.5× бессмысленен и вреден:
    // генеративный LatentUpscaler3D обучен на крупные целевые размеры и при
    // 1.1–1.4× (напр. 864×480, lowResMP 0.2 → 38×22 латента) деталей не
    // добавляет, а мылит латент; 3-шаговый pass 2 это мыло не вытягивает →
    // мутные клипы и сильный шов с чётким оригиналом (ещё и голова клипа 0
    // несёт даунскейл→апскейл хвоста). Вместо этого pass 1 поднимаем до
    // канвы final: upscaler делает early-return (scale 1.0), а pass 2
    // работает чистым рефайном деталей на полном разрешении.
    // 1.5× — проверенный режим (1120×480 → 1680×720); ниже него апскейлер
    // уже даёт мыло (видно на 864×480: 1.39× хуже однопроходного).
    if (final.genW / r.w < 1.5 && final.genH / r.h < 1.5) {
      r = { w: final.genW, h: final.genH }
    }
    return r
  })()
  const passW = lowRes.w
  const passH = lowRes.h
  const sigmaVariant = SIGMA_VARIANTS[p.sigmaVariant || '3step'] || SIGMA_VARIANTS['3step']
  const pass2Sampler = p.pass2Sampler || 'euler'

  // Model chain: UNET → [LowVRAM] → [ChunkFF] → [custom LoRAs, incl. turbo] → SigmaShift → [Sparse] → Attention
  const lowVram = p.lowVramAttention !== false
  const chunkFF = p.chunkFeedForward !== false
  const modelNodes: Record<string, unknown> = {}
  let modelSrc: [string, number] = ['46:30', 0]

  if (lowVram) {
    modelNodes['46:43'] = {
      inputs: { head_chunks: 4, model: modelSrc },
      class_type: 'MiniMaxLowVRAMAttention',
      _meta: { title: 'Low VRAM Attention' },
    }
    modelSrc = ['46:43', 0]
  }
  if (chunkFF) {
    modelNodes['46:40'] = {
      inputs: {
        chunks: Math.max(1, Math.round(p.chunkFFChunks ?? 2)),
        seq_threshold: Math.max(0, Math.round(p.chunkFFThreshold ?? 4096)),
        model: modelSrc,
      },
      class_type: 'MiniMaxChunkFeedForward',
      _meta: { title: 'Chunk FeedForward' },
    }
    modelSrc = ['46:40', 0]
  }

  // (правка 207) Преамбула продолжения из эталонного V2V-Extend workflow.
  // Вшивается в clips_json для клипа 0, чтобы её видели ОБА прохода:
  // Extender (pass 1) и MiniMaxH3ExtenderPass2 (ребилдит кондишен из
  // clips_json). <Video 1> указывает на ref_video_1 (хвост исходника).
  const CONTINUATION_PREAMBLE =
    '[Video Continuation] A direct, seamless continuation of <Video 1> ' +
    'starting precisely from its final frame. The camera movement, subject ' +
    'position, clothing, and environment maintain identical continuity ' +
    'without cuts or jumps.\n\n' +
    '[Audio Continuation] The stereo sound design and ambient audio flow ' +
    'seamlessly forward, preserving the exact vocal timbre, speaking rhythm ' +
    'and background track dynamics without interruption or re-triggering. ' +
    'The character continues speaking and moving naturally as the timeline ' +
    'progresses.\n\n' +
    '[Shot 1]\nTarget video is a seamless continuation of <Video 1>. ' +
    'First frame of [Shot 1] is the last frame of <Video 1>.\n\n'

  // (правка 252) Латент-маскирующая цепочка: хелперы геометрии.
  // Токены видео-латента: T = ((F − 5)/17)*5 + 2 (сетка 17k+5);
  // аудио-шаги: round(F × 5/3) (F кадров × 40 Гц / 24).
  const tok = (frames: number) => Math.round(((frames - 5) / 17) * 5 + 2)
  const snapUp = (n: number) => {
    let x = Math.max(5, Math.round(n))
    while ((x - 5) % 17 !== 0) x += 1
    return x
  }
  // Перекрытие клипов i>0 (сетка 17k+5): preserved-голова латента.
  // (правка 419) Эталон «V2V Extend Any Video»: перекрытие сегмент-к-сегменту
  // = тому же 2-секундному окну контекста (56 кадров), что и стык с исходником.
  const CHAIN_OVERLAP_FRAMES = 56
  // Фраза непрерывности для клипов i>0: последний кадр
  // предыдущего клипа приходит <Picture N>-референсом (нода ext_lf_i ниже) —
  // якорь внешнего вида для ВСЕГО нового содержимого клипа, а не только шва.
  const continuityPhrase = (pic: number) =>
    `Continuity: <Picture ${pic}> is the last frame of the previous shot of this video; ` +
    `continue seamlessly from it and keep characters, faces, clothing, lighting and ` +
    `details consistent with <Picture ${pic}>.`
  // Промпт клипа: клип 0 — с преамбулой продолжения (правка 207); клипы i>0 —
  // с фразой непрерывности про последний кадр предыдущего (слот picSlot).
  const clipPrompt = (idx: number, picSlot: number) => {
    if (idx === 0) {
      return clips[idx].prompt.includes('[Video Continuation]')
        ? clips[idx].prompt
        : CONTINUATION_PREAMBLE + clips[idx].prompt
    }
    return continuityPhrase(picSlot) + '\n\n' + clips[idx].prompt
  }
  const clipSeed = (idx: number) => (clips[idx].seed < 0 ? seed + idx : clips[idx].seed)
  // Полная длина клипа idx в кадрах (сетка 17k+5) — та же формула, что в
  // цикле ниже: нужна заранее для ext_lf (последний кадр клипа idx).
  const clipTotalFrames = (idx: number) =>
    snapUp((idx === 0 ? tailFrames : CHAIN_OVERLAP_FRAMES) + framesForDuration(clips[idx].duration))

  // Длительность для ноды расчёта кадров превью (как '17'+'46:19' вкладки
  // «Генерация»): берём самый длинный клип — превью анимируется по максимуму.
  const maxClipDuration = clips.reduce((m, c) => Math.max(m, c.duration), 0) || 5
  // (правка 419) Окно контекста исходника = 2 с (56 кадров), как в эталоне
  // «V2V Extend Any Video (latent masking)» (нода OVERLAP/CONTEXT = 2 с).
  // Замена правилам 202/322 (хвост = самый длинный клип / минимум 5 с):
  // при 5-секундных исходниках 5-с окно скармливало модели ВЕСЬ клип — и в
  // затравку, и в референс — модель «до-рендерила» исходник заново вместо
  // продолжения (реплей с кадра 0). Эталон держит окно коротким (2 с):
  // затравка = последние 2 с, остальное модель знает только из референса.
  // (правка 254) Кламп к фактической длине исходника (ffprobe) со
  // выравниванием ВНИЗ по сетке 17n+5 — см. выше.
  const tailFrames = (() => {
    const planned = framesForDuration(2)
    const cap =
      p.extendSourceFrames && p.extendSourceFrames >= 5
        ? Math.min(planned, p.extendSourceFrames)
        : planned
    let x = Math.max(5, Math.round(cap))
    while ((x - 5) % 17 !== 0) x -= 1
    return Math.max(5, x)
  })()
  // (правка 251) Геометрия стыка «исходник → клип 0»: preserved-голова
  // клипа 0 дублирует хвост исходника (17 кадров — исторический Trim 9 +
  // Fade 8 ffmpeg-склейки; клип 0 пишется в файл extclip_0 С головой,
  // дублирование глушит ffmpeg-конкат клиента). (правка 414, ОТКАЧЕНА
  // правкой 417) срез клипа 0 от tailFrames в комбинированном латенте —
  // комбайн удалён.
  const hasSeed = !!p.extendSourceVideo
  // (правка 385, ОТКАЧЕНА правкой 417) Латент исходника в extend-графе
  // (ext_src_lat/ext_src_lsep, срезы для комбайна и головы клипа 0) —
  // удалён вместе со всем латент-пайплайном extend.
  // (правка 416, ОТКАЧЕНА правкой 417) Голова клипа 0 из среза
  // первозданного латента: заморозка/реплей лечились ею лишь частично
  // (n=1), а комбайн всё равно реплел; по решению пользователя extend
  // возвращён на проверенную mp4-схему — голова клипа 0 ВСЕГДА из
  // пиксельного encode хвоста (extv_ssep, правка 409).

  return {
    // ═══════════════════════════════════════════════
    //  MODEL LOADING
    // ═══════════════════════════════════════════════
    '46:30': {
      inputs: {
        // (правка 293) Дефолт — вернули основную модель
        unet_name: p.diffusionModel || 'minimax_h3_fastvideo_vsa_datafree_1300step_4step_int8_convrot.safetensors',
        weight_dtype: 'default',
      },
      class_type: 'UNETLoader',
      _meta: { title: 'Загрузить модель диффузии' },
    },
    '46:15': {
      inputs: {
        clip_name: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
        type: 'minimax',
        device: 'default',
      },
      class_type: 'CLIPLoader',
      _meta: { title: 'Загрузить CLIP' },
    },
    '46:3': {
      inputs: { vae_name: 'minimax_h3_video_vae_int8_convrot.safetensors' },
      class_type: 'VAELoader',
      _meta: { title: 'VAE (video)' },
    },
    '46:4': {
      inputs: { vae_name: 'minimax_h3_audio_vae_fp32.safetensors' },
      class_type: 'VAELoader',
      _meta: { title: 'VAE (audio)' },
    },

    // ═══════════════════════════════════════════════
    //  MODEL OPTIMIZATION CHAIN
    // ═══════════════════════════════════════════════
    ...modelNodes,

    ...buildCustomLoraNodes(p.customLoras, modelSrc),

    '46:38': {
      inputs: {
        shift_video: 12,
        shift_audio: 3,
        model: getLastLoraOutput(p.customLoras, modelSrc),
      },
      class_type: 'MiniMaxH3SigmaShift',
      _meta: { title: 'Sigma Shift' },
    },

    // (правка 301) Sparse attention: Veda или Sol-Attn — draft pass
    ...(p.vedaAttention ? {
      '46:44': {
        inputs: {
          // (правка 422) Veda ПОСЛЕ Attention Backend: обе ноды пишут
          // transformer_options['optimized_attention_override'], Veda
          // композитит поверх текущего, backend — перезаписывает. Если
          // backend идёт после Veda, хуки Veda затираются и она не работает.
          model: ['46:37', 0],
          predictor: 'minimax_h3_t2va_veda_8nfe_600step_preview_fp8.safetensors',
          // (правка 399) параметры ноды — из настроек программы
          generated_sparsity: clampVedaSparsity(p.vedaGeneratedSparsity, 90),
          reference_sparsity: clampVedaSparsity(p.vedaReferenceSparsity, 90),
          full_attention_layers: sanitizeVedaIndexList(p.vedaFullAttentionLayers),
          full_attention_steps: sanitizeVedaIndexList(p.vedaFullAttentionSteps),
          verbose: p.vedaVerbose === true,
        },
        class_type: 'VedaSparseAttention',
        _meta: { title: 'Veda Sparse Attention' },
      },
    } : p.sparseAttention === true ? { // (правка 387) Sol-Attn по умолчанию OFF
      '46:44': {
        inputs: {
          model: ['46:37', 0], // (правка 422) sparse — ПОСЛЕ Attention Backend, см. выше
          // (правка 466) Параметры — из Настроек → Оптимизация генерации
          tau: p.sparseTau ?? 1.3,
          start_percent: p.sparseStartPercent ?? 0.2,
          end_percent: p.sparseEndPercent ?? 1.0,
          min_tokens: p.sparseMinTokens ?? 12288,
          extra_tokens: p.sparseExtraTokens ?? 256,
        },
        class_type: 'MiniMaxSparseAttention',
        _meta: { title: 'Sparse Attention (Sol-Attn)' },
      },
    } : {}),

    '46:37': {
      inputs: {
        attention: 'comfy kitchen attention',
        // (правка 422) Backend сразу после SigmaShift; sparse-нода ('46:44')
        // теперь идёт ПОСЛЕ него — последним патчем attention перед сэмплером.
        model: ['46:38', 0],
      },
      class_type: 'ModelAttentionBackend',
      _meta: { title: 'Attention Backend' },
    },

    // (правка 252) Сэмплер клипов (pass1-сэмплер, как в основном билдере)
    '46:18a': {
      inputs: { sampler_name: p.pass1Sampler || 'euler' },
      class_type: 'KSamplerSelect',
      _meta: { title: `KSampler клипов (${p.pass1Sampler || 'euler'})` },
    },

    // (правка 423) Двухпроходный extend: pass-2 сэмплер + вторая превью-нода
    // (как '46:18'/'13' основного билдера). Только при extendTwoPass.
    ...(twoPass && {
      '46:18': {
        inputs: { sampler_name: pass2Sampler },
        class_type: 'KSamplerSelect',
        _meta: { title: `KSampler клипов Pass 2 (${pass2Sampler})` },
      },
      'extpv2': {
        inputs: {
          // (правка 422) хвост цепочки: sparse-нода, если включена, иначе backend
          model: (p.vedaAttention || p.sparseAttention === true) ? ['46:44', 0] : ['46:37', 0],
          vae: ['46:3', 0],
          tiny_vae: 'taeh3.safetensors',
          max_resolution: 1024,
          jpeg_quality: 80,
          suppress_default_preview: true,
          preview_frames: ['46:19', 1],
          preview_fps: 6,
        },
        class_type: 'ModelPreviewOverrideKJ',
        _meta: { title: 'Model Preview Override (Pass 2)' },
      },
    }),

    // ═══════════════════════════════════════════════
    //  Кадры для превью (как '17' + '46:19' вкладки «Генерация»)
    // ═══════════════════════════════════════════════
    '17': {
      inputs: { value: maxClipDuration },
      class_type: 'PrimitiveFloat',
      _meta: { title: 'Duration (seconds)' },
    },
    '46:19': {
      inputs: {
        expression: 'max(5, round(a * 24)) + (5 - (max(5, round(a * 24)) % 17)) % 17',
        'values.a': ['17', 0],
      },
      class_type: 'ComfyMathExpression',
      _meta: { title: 'Frames Calculation' },
    },

    // ═══════════════════════════════════════════════
    //  LIVE PREVIEW — настройки ноды '12' вкладки «Генерация».
    //  ВАЖНО: обёрнутая модель должна идти В сэмплер (Extender),
    //  иначе превью не срабатывает.
    // ═══════════════════════════════════════════════
    'extpv': {
      inputs: {
        // (правка 422) хвост цепочки: sparse-нода, если включена, иначе backend
        model: (p.vedaAttention || p.sparseAttention === true) ? ['46:44', 0] : ['46:37', 0],
        vae: ['46:3', 0],
        tiny_vae: 'taeh3.safetensors',
        max_resolution: 1024,
        jpeg_quality: 80,
        suppress_default_preview: true,
        preview_frames: ['46:19', 1],
        preview_fps: 6,
      },
      class_type: 'ModelPreviewOverrideKJ',
      _meta: { title: 'Model Preview Override' },
    },

    // ═══════════════════════════════════════════════
    //  SOURCE VIDEO CHAIN — выходы GetVideoComponents:
    //  [0]=images, [1]=audio, [2]=fps.
    //  (правка 202) Нода Extender (как и официальная MiniMaxH3ReferenceToVideo)
    //  режет видео-реф ПРЕФИКСОМ до длительности клипа. Для ПРОДОЛЖЕНИЯ нужен
    //  конец исходника: срезаем последние tailFrames кадров и подаём их —
    //  тогда префикс-кроп ноды берёт ровно хвост. ImageFromBatch безопасно
    //  клампит индекс/длину, если исходник короче.
    // ═══════════════════════════════════════════════
    ...((p.extendSourceVideo ? {
      // (правка 211) VHS_LoadVideo вместо LoadVideo: у него есть force_rate.
      // Хвост ДОЛЖЕН приходить в таймбазе 24 fps — модель обучена на 24;
      // исходник 25/30 fps без нормализации даёт скачок скорости на шве
      // (продолжение «замедляется») и подёргивание.
      'extv_load': {
        inputs: {
          video: p.extendSourceVideo,
          force_rate: 24,
          custom_width: 0,
          custom_height: 0,
          frame_load_cap: 0,
          skip_first_frames: 0,
          select_every_nth: 1,
        },
        class_type: 'VHS_LoadVideo',
        _meta: { title: 'Загрузить видео (источник, 24 fps)' },
      },
      // Кол-во кадров исходника
      'extv_cnt': {
        inputs: { image: ['extv_load', 0] },
        class_type: 'GetImageSizeAndCount',
        _meta: { title: 'Кадров в исходнике' },
      },
      // Нужная длина хвоста = кадры самого длинного клипа (сетка 17n+5)
      'extv_tailn': {
        inputs: { value: tailFrames },
        class_type: 'PrimitiveInt',
        _meta: { title: 'Хвост (кадры)' },
      },
      // batch_index = max(0, count - tail)
      'extv_tailidx': {
        inputs: {
          expression: 'max(0, a - b)',
          'values.a': ['extv_cnt', 3],
          'values.b': ['extv_tailn', 0],
        },
        class_type: 'ComfyMathExpression',
        _meta: { title: 'Индекс хвоста' },
      },
      // ХВОСТ исходника → ref_video_1
      'extv_tail': {
        inputs: {
          image: ['extv_load', 0],
          batch_index: ['extv_tailidx', 1],
          length: tailFrames,
        },
        class_type: 'ImageFromBatch',
        _meta: { title: 'Хвост исходника' },
      },
      // (правка 205) ЖЁСТКАЯ привязка: хвост → ресайз под геометрию pass 1 →
      // VAE-кодирование (видео + аудио) → AV-латент → seed_latent вход
      // Extender'а. Клип 1 продолжает ЛАТЕНТ хвоста через motion context —
      // семантика multitrackProject (их сегменты чейнются латентами), а не
      // мягкая Ref2VA-подача «оригинал → пустой латент».
      // (правка 385, ОТКАЧЕНА правкой 417) узлы ext_src_lat/ext_src_lsep
      // (латент исходника в extend-графе) удалены вместе с комбайном.
      // (правка 409) СИД-ХВОСТ — ВСЕГДА encode пикселей mp4-хвоста: тот же
      // контент/характер, что видит conditioning (ref_video_0 = extv_tail).
      // Это preserved-голова клипа 0 (extv_ssep ниже) и аудио-часть
      // AV-сид-латента; кондишнинг пиксельный и не зависит от этого энкода.
      'extv_tres': {
        inputs: {
          image: ['extv_tail', 0],
          // (правка 247) Хвост кодируется под канву Extender'а = разрешение
          // исходника (final) — low-res канвы в однопроходной схеме нет.
          // (правка 423) В двухпроходном режиме — под канву pass 1 (lowRes):
          // сид-латент должен совпадать по пространству с латентом клипа.
          width: passW,
          height: passH,
          upscale_method: 'lanczos',
          keep_proportion: 'stretch',
          pad_color: '0, 0, 0',
          crop_position: 'center',
          divisible_by: 16,
          device: 'cpu',
        },
        class_type: 'ImageResizeKJv2',
        _meta: { title: `Хвост → ${passW}×${passH} (канва Extender)` },
      },
      // (правка 419) Референс исходника для кондишнинга: ВЕСЬ клин (батч
      // кадров), поданный как ref_image (картинка) — как в эталоне
      // «V2V Extend Any Video»: там исходник идёт в ref_images.ref_image_0,
      // а не в ref_videos. Затравка (extv_tres/extv_tenc) при этом — только
      // короткий 2-с хвост: модель продолжает хвост, а весь клин знает из
      // этого референса.
      'extv_fres': {
        inputs: {
          image: ['extv_load', 0],
          width: final.genW,
          height: final.genH,
          upscale_method: 'lanczos',
          keep_proportion: 'stretch',
          pad_color: '0, 0, 0',
          crop_position: 'center',
          divisible_by: 16,
          device: 'cpu',
        },
        class_type: 'ImageResizeKJv2',
        _meta: { title: `Исходник-реф → ${final.genW}×${final.genH} (весь клин)` },
      },
      'extv_tenc': {
        inputs: {
          pixels: ['extv_tres', 0],
          vae: ['46:3', 0],
        },
        class_type: 'VAEEncode',
        _meta: { title: 'VAE-кодирование хвоста (видео)' },
      },
      'extv_asl_seed': {
        inputs: {
          audio: ['extv_load', 2],
          start_seconds: Number((-tailFrames / 24).toFixed(4)),
        },
        class_type: 'MiniMaxH3AudioSliceFrom',
        _meta: { title: `Аудио-хвост ${Number((tailFrames / 24).toFixed(2))} с` },
      },
      // аудио-энкод хвоста — часть AV-сид-латента extv_seed (голова
      // клипа 0). (правка 419) в conditioning больше не подаётся:
      // аудио-продолжение идёт из preserved-аудио-латента, как в эталоне.
      'extv_taenc': {
        inputs: {
          // (правка 221) Аудио-ХВОСТ той же длины, что и видео-хвост
          // (отрицательный start = с конца): аудио целого исходника при
          // видео-хвосте рассогласовывало seed-латент (якорь деградировал
          // → галюцинации на исходниках длиннее хвоста).
          audio: ['extv_asl_seed', 0],
          vae: ['46:4', 0],
        },
        class_type: 'VAEEncodeAudio',
        _meta: { title: 'VAE-кодирование аудио' },
      },
      'extv_seed': {
        inputs: {
          video_latent: ['extv_tenc', 0],
          audio_latent: ['extv_taenc', 0],
        },
        class_type: 'LTXVConcatAVLatent',
        _meta: { title: 'AV-латент хвоста (seed)' },
      },

      // ─── (правка 420) ЛАТЕНТ ИСХОДНИКА ДЛЯ ПОСТ-СБОРКИ ИТОГА ───
      // В генерацию НЕ подаётся (сид — пиксельный хвост выше, правки
      // 409/419): этот латент нужен только ПОСЛЕ сэмплеров, чтобы собрать
      // combined-латент таймлайна склейки для lossless-рефайна. Есть файл
      // (резолвер роута, первозданный) — грузим его; нет — один VAE-энкод
      // целого клина (extv_fres уже приведён к канве).
      ...(p.extendSourceLatentFile ? {
        'ext_srcload': {
          inputs: { latent: p.extendSourceLatentFile },
          class_type: 'MiniMaxStudioLoadAVLatent',
          _meta: { title: 'Латент исходника (первозданный)' },
        },
        'ext_srclsep': {
          inputs: { av_latent: ['ext_srcload', 0] },
          class_type: 'LTXVSeparateAVLatent',
          _meta: { title: 'Разделение латента исходника' },
        },
      } : {
        'extv_fenc': {
          inputs: {
            pixels: ['extv_fres', 0],
            vae: ['46:3', 0],
          },
          class_type: 'VAEEncode',
          _meta: { title: 'VAE-кодирование исходника целиком (пост-сборка)' },
        },
        'extv_aful': {
          inputs: {
            audio: ['extv_load', 2],
            vae: ['46:4', 0],
          },
          class_type: 'VAEEncodeAudio',
          _meta: { title: 'VAE-кодирование аудио исходника целиком' },
        },
      }),
    } : {})),

    // ═══════════════════════════════════════════════
    //  (правка 252) ЛАТЕНТ-МАСКИРУЮЩАЯ ЦЕПОЧКА КЛИПОВ
    //  По референсу «V2V Extend Any Video (latent masking)»:
    //  латент клипа = [preserved-хвост (маска 0 — сэмплер не трогает)]
    //  ⊕ [новая часть (маска 1 — генерация)]; LatentCut/Concat по токенам
    //  сетки; SetLatentNoiseMask; один сэмплер на клип; единый декод.
    //  Клип 0: preserved-голова = кодированный хвост исходника
    //  (extv_seed; пиксельный VAE-энкод, правка 409 — единственная схема
    //  после отката 417).
    //  Клип i>0: preserved-голова = хвост ВЫХОДА сэмплера клипа i−1.
    //  Каждый клип декодируется ОТДЕЛЬНО в свой файл extclip_<i>
    //  (правка 417): клип i>0 — со срезом 22-кадровой головы в воркфлоу,
    //  клип 0 — с головой-хвостом, её 17-кадровое дублирование глушит
    //  ffmpeg-склейка клиента (Trim 9 + xfade 8).
    // ═══════════════════════════════════════════════
    ...(hasSeed && {
      'extv_ssep': {
        inputs: { av_latent: ['extv_seed', 0] },
        class_type: 'LTXVSeparateAVLatent',
        _meta: { title: 'Разделение латента хвоста' },
      },
    }),
    ...(() => {
      const nodes: Record<string, unknown> = {}
      // (правка 423) Пространственный размер латента канвы pass 1
      // (однопроходный режим: passW = final.genW) — видео-маска pass 1
      // удалена (keyframes + лок), осталась только
      // геометрия pass 2 (lw2/lh2 ниже).
      // (правка 423) Двухпроходный: маски pass 2 — в геометрии final.
      const lw2 = Math.max(1, Math.round(final.genW / 16))
      const lh2 = Math.max(1, Math.round(final.genH / 16))
      // Аудио-длины клипов (aTotal на индекс) — для аудио-контекста keyframe
      // клипа i+1 (сколько звука доступно в клипе i до перекрытия).
      const audioTotals: number[] = []

      // (правка 266) Картинки-рефы: LoadImage-ноды + привязка к КАЖДОМУ
      // ext_cond_i через ref_images.ref_image_N (как в режиме 'ref').
      // Без этого рефы, загруженные пользователем, НЕ применялись к клипам.
      const extRefCount = Math.min(p.refImages.length, 9)
      const extRefLinks: Record<string, unknown> = {}
      for (let ri = 0; ri < extRefCount; ri++) {
        const loadId = REF_IMAGE_NODE_IDS[ri]
        nodes[loadId] = {
          inputs: { image: p.refImages[ri] },
          class_type: 'LoadImage',
          _meta: { title: `Reference ${ri + 1}` },
        }
        extRefLinks[`ref_images.ref_image_${ri}`] = [loadId, 0]
      }

      // (правка 325, уточнено правкой 434) Правка 324 (v2v-прогон хвоста)
      // ОТКАЧЕНА по решению пользователя: вместо латентных экспериментов
      // длительность клипов продления ограничена снизу (UI-кламп 3 с, было
      // 5 с — при 5-секундных клипах стык «исходник → клип 0» стабильно
      // чистый, проверено пользователем на одной и той же сцене).
      // Клип 0 берёт кодированный хвост (extv_ssep).
      for (let i = 0; i < clips.length; i++) {
        const clipFrames = framesForDuration(clips[i].duration)
        const overlapFrames = i === 0 ? tailFrames : CHAIN_OVERLAP_FRAMES
        const totalFrames = i === 0 ? snapUp(overlapFrames + clipFrames) : snapUp(CHAIN_OVERLAP_FRAMES + clipFrames)
        const oTok = tok(overlapFrames)
        const tTok = tok(totalFrames)
        const aOver = Math.round((overlapFrames * 5) / 3)
        const aTotal = Math.round((totalFrames * 5) / 3)
        // Длина аудио-ленты предыдущего клипа (для аудио-контекста keyframe).
        // Клип 0: хвост исходника (аудио кодируется ровно на tailFrames).
        const prevATotal = i === 0 ? Math.round((tailFrames * 5) / 3) : audioTotals[i - 1]
        audioTotals.push(aTotal)

        // Conditioning клипа + пустой латент totalFrames
        // (правка 423) Размеры кондишнинга/пустого латента — канва pass 1
        // (в однопроходном режиме passW = final.genW). Pass 2 переиспользует
        // тот же conditioning — как в основном билдере (там кондишнинг
        // строится на lowRes и идёт в оба прохода).
        // Клипы i>0 дополнительно получают ПОСЛЕДНИЙ
        // КАДР клипа i−1 как <Picture>-референс (ext_lf_i): якорь внешнего
        // вида для нового содержимого — раньше клип i>0 не имел вообще
        // никакого визуального якоря, и контент генерировался «вслепую»
        // (гостинг/двоения, накапливающиеся по цепочке).
        if (i > 0 && extRefCount + 1 < 9) {
          nodes[`ext_lf_${i}`] = {
            inputs: {
              images: [`ext_decv_${i - 1}`, 0],
              start_index: clipTotalFrames(i - 1) - 1,
              num_frames: 1,
            },
            class_type: 'GetImageRangeFromBatch',
            _meta: { title: `Последний кадр клипа ${i} (якорь <Picture>)` },
          }
        }
        nodes[`ext_cond_${i}`] = {
          inputs: {
            prompt: clipPrompt(i, extRefCount + 2),
            width: passW,
            height: passH,
            length: totalFrames,
            ref_image_size: p.refImageSize || 'match',
            clip: ['46:15', 0],
            vae: ['46:3', 0],
            audio_vae: ['46:4', 0],
            ...(Object.keys(extRefLinks).length > 0 ? extRefLinks : {}),
            // (правка 419) Исходник — как ref_image (батч кадров всего
            // клина, эталон V2V Extend), слотом ПОСЛЕ картинок юзера.
            // ref_videos/ref_video_audios упразднены: аудио-продолжение
            // идёт из preserved-аудио-латента.
            ...(hasSeed && extRefCount < 9 && {
              [`ref_images.ref_image_${extRefCount}`]: ['extv_fres', 0],
            }),
            // последний кадр клипа i−1 — слотом после
            // хвоста исходника; на него указывает фраза непрерывности.
            ...(i > 0 && extRefCount + 1 < 9 && {
              [`ref_images.ref_image_${extRefCount + 1}`]: [`ext_lf_${i}`, 0],
            }),
          },
          class_type: 'MiniMaxH3ReferenceToVideo',
          _meta: { title: `Conditioning клип ${i + 1} (${totalFrames} кадров)` },
        }
        nodes[`ext_empty_${i}`] = {
          inputs: { width: passW, height: passH, length: totalFrames },
          class_type: 'EmptyMiniMaxH3LatentAV',
          _meta: { title: `Пустой AV-латент клип ${i + 1}` },
        }
        nodes[`ext_esep_${i}`] = {
          inputs: { av_latent: [`ext_empty_${i}`, 0] },
          class_type: 'LTXVSeparateAVLatent',
          _meta: { title: `Separate пустого латента ${i + 1}` },
        }
        // Прошлый выход: клип 0 — хвост исходника; i>0 — выход сэмплера i−1.
        // Без исходника у клипа 0 preserved-головы нет — чистая генерация.
        const useOld = i > 0 || hasSeed
        // (правка 416, ОТКАЧЕНА правкой 417) Голова клипа 0 из среза
        // первозданного латента убрана вместе с латент-пайплайном extend:
        // голова клипа 0 ВСЕГДА из пиксельного encode хвоста (extv_ssep,
        // правка 409).
        // (правка 426) Двухпроходный режим: preserved-голова клипа i цепляется
        // за ФИНАЛЬНЫЙ (pass-2) выход клипа i−1, а не за его low-res черновик.
        // Иначе клип i продолжает «другую версию» видео: pass 2 рефайнит и
        // меняет хвост клипа i−1, а в файл уходит именно финал; стык i−1→i
        // в склейке жёсткий (fade=0) — расхождение видно как скачок.
        // Схема = как у стыка с исходником (правка 409, она чистая): хвост
        // уже декодированного финала клипа i−1 (ext_decv) → ресайз на канву
        // pass 1 → VAE-encode → seed-латент. Аудио — срез хвоста из
        // декодированного финала (ext_deca) → VAE-encode. Геометрия масок
        // (oTok/aOver) не меняется: энкод ровно CHAIN_OVERLAP_FRAMES кадров.
        let prevVideo: [string, number] = i === 0 ? ['extv_ssep', 0] : [`ext_ssep_${i - 1}`, 0]
        let prevAudio: [string, number] = i === 0 ? ['extv_ssep', 1] : [`ext_ssep_${i - 1}`, 1]
        if (twoPass && i > 0) {
          const prevCf = framesForDuration(clips[i - 1].duration)
          const prevTotal = (i - 1) === 0
            ? snapUp(tailFrames + prevCf)
            : snapUp(CHAIN_OVERLAP_FRAMES + prevCf)
          const aTailSec = Number((CHAIN_OVERLAP_FRAMES / 24).toFixed(4))
          Object.assign(nodes, {
            [`ext_p2tail_${i}`]: {
              inputs: {
                images: [`ext_decv_${i - 1}`, 0],
                start_index: prevTotal - CHAIN_OVERLAP_FRAMES,
                num_frames: CHAIN_OVERLAP_FRAMES,
              },
              class_type: 'GetImageRangeFromBatch',
              _meta: { title: `Хвост финала клипа ${i} (${CHAIN_OVERLAP_FRAMES} кадров)` },
            },
            [`ext_p2res_${i}`]: {
              inputs: {
                image: [`ext_p2tail_${i}`, 0],
                width: passW,
                height: passH,
                upscale_method: 'lanczos',
                keep_proportion: 'stretch',
                pad_color: '0, 0, 0',
                crop_position: 'center',
                divisible_by: 16,
                device: 'cpu',
              },
              class_type: 'ImageResizeKJv2',
              _meta: { title: `Хвост финала ${i} → ${passW}×${passH} (канва pass 1)` },
            },
            [`ext_p2venc_${i}`]: {
              inputs: { pixels: [`ext_p2res_${i}`, 0], vae: ['46:3', 0] },
              class_type: 'VAEEncode',
              _meta: { title: `VAE-кодирование хвоста финала ${i} (видео)` },
            },
            [`ext_p2asl_${i}`]: {
              inputs: { audio: [`ext_deca_${i - 1}`, 0], start_seconds: -aTailSec },
              class_type: 'MiniMaxH3AudioSliceFrom',
              _meta: { title: `Аудио-хвост финала клипа ${i} (${aTailSec} с)` },
            },
            [`ext_p2aenc_${i}`]: {
              inputs: { audio: [`ext_p2asl_${i}`, 0], vae: ['46:4', 0] },
              class_type: 'VAEEncodeAudio',
              _meta: { title: `VAE-кодирование аудио-хвоста финала ${i}` },
            },
          })
          prevVideo = [`ext_p2venc_${i}`, 0]
          prevAudio = [`ext_p2aenc_${i}`, 0]
        }

        // Хвост якорится ДВУМЯ механизмами вместо
        // видео-SetLatentNoiseMask (она лишь держала токены в траектории
        // сэмплера — DiT не видел хвост как контекст и генерировал новое
        // содержимое «вслепую», отсюда гостинг на клипах 2+):
        //   1. ext_kf_i — хвост в conditioning каналом minimax_keyframes:
        //      PackedLayout пакует его cond-строками (img_update=0), модель
        //      видит его чистым на каждом шаге. Аудио — с контекстом ДО
        //      перекрытия (модель «слышит» продолжение, а не шум).
        //   2. ext_lock_i — обёртка модели: предсказание x0 в залоченных
        //      позициях принудительно = чистый латент хвоста (дрейф
        //      невозможен физически). KJ-превью не конфликтует: оно на
        //      OUTER_SAMPLE-обёртке, лок — на function wrapper.
        // Аудио-маска (ext_amask/ext_aset ниже) ОСТАЁТСЯ: ядро превращает
        // её в audio_denoise_mask conds — модель знает чистый timestep.
        // Видео: прошлый хвост ⊕ пустой, обрезка до total токенов.
        if (useOld) {
          // Аудио-контекст keyframe: звук до перекрытия (≤1 с, кратно 5),
          // заканчивается на границе перекрытия; frame-индекс отрицательный
          // (5 аудио-шагов = 3 пиксельных кадра, FRAME_RESCALE 5/3).
          const audioCtx = Math.max(0, Math.min(40, prevATotal - aOver))
          const audioCtx5 = Math.floor(audioCtx / 5) * 5
          nodes[`ext_actx_${i}`] = {
            inputs: {
              samples: prevAudio,
              dim: 'x',
              index: -(aOver + audioCtx5),
              amount: aOver + audioCtx5,
            },
            class_type: 'LatentCut',
            _meta: { title: `Аудио-контекст клип ${i + 1}: перекрытие ${aOver} + ${audioCtx5} шагов до него` },
          }
          nodes[`ext_vold_${i}`] = {
            inputs: { samples: prevVideo, dim: 't', index: -oTok, amount: oTok },
            class_type: 'LatentCut',
            _meta: { title: `Хвост прошлого (видео) ${i + 1}: ${oTok} ток.` },
          }
          nodes[`ext_vcat_${i}`] = {
            inputs: { samples1: [`ext_vold_${i}`, 0], samples2: [`ext_esep_${i}`, 0], dim: 't' },
            class_type: 'LatentConcat',
            _meta: { title: `Concat видео ${i + 1}` },
          }
          nodes[`ext_aold_${i}`] = {
            inputs: { samples: prevAudio, dim: 'x', index: -aOver, amount: aOver },
            class_type: 'LatentCut',
            _meta: { title: `Хвост прошлого (аудио) ${i + 1}: ${aOver}` },
          }
          // Хвост клипа i в conditioning (нативный keyframe-канал H3).
          nodes[`ext_kf_${i}`] = {
            inputs: {
              conditioning: [`ext_cond_${i}`, 0],
              video_latent: [`ext_vold_${i}`, 0],
              video_frame: 0,
              audio_latent: [`ext_actx_${i}`, 0],
              audio_frame: -Math.floor((audioCtx5 * 3) / 5),
            },
            class_type: 'MiniMaxStudioExtendKeyframes',
            _meta: { title: `Keyframe-якорь хвоста клип ${i + 1}` },
          }
          // Жёсткий лок перекрытия (перезапись предсказания x0).
          // Лок-тензоры — ПОЛНЫЕ init-латенты клипа (хвост в начале,
          // дальше нули с весом 0), lock = video с
          // вписанным хвостом): размеры совпадают с выходом модели.
          nodes[`ext_lock_${i}`] = {
            inputs: {
              model: ['extpv', 0],
              lock_video: [`ext_vtrim_${i}`, 0],
              video_tokens_locked: oTok,
              video_tokens_total: tTok,
              lock_audio: [`ext_atrim_${i}`, 0],
              audio_steps_locked: aOver,
              audio_steps_total: aTotal,
            },
            class_type: 'MiniMaxStudioLatentLock',
            _meta: { title: `Лок перекрытия клип ${i + 1} (${oTok} ток. видео / ${aOver} аудио)` },
          }
        }
        nodes[`ext_vtrim_${i}`] = {
          inputs: {
            samples: useOld ? [`ext_vcat_${i}`, 0] : [`ext_esep_${i}`, 0],
            dim: 't',
            index: 0,
            amount: tTok,
          },
          class_type: 'LatentCut',
          _meta: { title: `Trim видео ${i + 1} → ${tTok} ток.` },
        }

        // Аудио: тот же паттерн вдоль x (аудио-шаги = кадры × 5/3).
        // ext_aold_i объявлен выше (useOld-блок) — он же вход лока.
        if (useOld) Object.assign(nodes, {
          [`ext_acat_${i}`]: {
            inputs: { samples1: [`ext_aold_${i}`, 0], samples2: [`ext_esep_${i}`, 1], dim: 'x' },
            class_type: 'LatentConcat',
            _meta: { title: `Concat аудио ${i + 1}` },
          },
          // (правка 254) Аудио-маска: канва = ЧЁРНАЯ на полную ширину aTotal,
          // белая (aTotal − aOver) вклеивается со сдвигом x = aOver —
          // MaskComposite не растит канву, при x=0 белая просто затирала
          // чёрную часть и аудио-хвост не сохранялся вовсе.
          [`ext_amb_${i}`]: {
            // (правка 324) Канва снова чёрная: аудио-хвост клипа 0 теперь
            // тоже model-consistent (кодированный хвост), смягчение не нужно.
            inputs: { value: 0, width: aTotal, height: 2 },
            class_type: 'SolidMask',
            _meta: { title: `Аудио-маска: чёрная канва ${aTotal}` },
          },
          [`ext_amw_${i}`]: {
            inputs: { value: 1, width: aTotal - aOver, height: 2 },
            class_type: 'SolidMask',
            _meta: { title: `Аудио-маска: белая ${aTotal - aOver}` },
          },
          [`ext_amask_${i}`]: {
            inputs: {
              destination: [`ext_amb_${i}`, 0],
              source: [`ext_amw_${i}`, 0],
              x: aOver,
              y: 0,
              operation: 'add',
            },
            class_type: 'MaskComposite',
            _meta: { title: `Аудио-маска ${i + 1}: ${aOver} чёрных + ${aTotal - aOver} белых` },
          },
          [`ext_aset_${i}`]: {
            inputs: { samples: [`ext_atrim_${i}`, 0], mask: [`ext_amask_${i}`, 0] },
            class_type: 'SetLatentNoiseMask',
            _meta: { title: `Noise mask аудио ${i + 1}` },
          },
        })
        nodes[`ext_atrim_${i}`] = {
          inputs: {
            samples: useOld ? [`ext_acat_${i}`, 0] : [`ext_esep_${i}`, 1],
            dim: 'x',
            index: 0,
            amount: aTotal,
          },
          class_type: 'LatentCut',
          _meta: { title: `Trim аудио ${i + 1} → ${aTotal}` },
        }

        // AV-латент клипа + сэмплер (полный график — генерация с нуля).
        // Видео без SetLatentNoiseMask (якорь — keyframes
        // в conditioning + жёсткий лок обёрткой ext_lock_i), аудио — со
        // своей маской: LTXVConcatAVLatent соберёт NestedTensor-маску
        // (видео = единицы, аудио = amask) — ровно эта схема.
        nodes[`ext_join_${i}`] = {
          inputs: {
            video_latent: [`ext_vtrim_${i}`, 0],
            audio_latent: useOld ? [`ext_aset_${i}`, 0] : [`ext_atrim_${i}`, 0],
          },
          class_type: 'LTXVConcatAVLatent',
          _meta: { title: `AV-латент клип ${i + 1}` },
        }
        nodes[`ext_sched_${i}`] = {
          inputs: {
            scheduler: p.pass1Scheduler || 'simple',
            // (правка 719) Шаги клипа — отдельное поле (extendClipSteps),
            // НЕ точка сплита генерации: в Extend сплита нет вообще.
            steps: p.extendClipSteps ?? p.firstSamplerSteps ?? 4,
            // (правка 291) denoise=1 + SetLatentNoiseMask (правка 252) — эталонная
            // схема из V2V Extend Any Video: шум добавляется только в зону маски
            // (белая = новое содержимое), зона маски=0 (чёрная = хвост предыдущего
            // клипа/исходника) восстанавливается из входного латента БЕЗ
            // перешумливания. При denoise<1 зона маски=0 тоже чуть шевелится,
            // но это НЕ решает проблему «задолбленности» начала клипа при 3+
            // клипах — причина там в накоплении ошибок в цепочке ext_ssep_{i-1}
            // (выход сэмплера i-1 → вход сэмплера i) и в том, что хвост i-1
            // уже содержит пересчитанный сэмплером хвост i-2 и т.д.
            // Держим denoise=1 (как в эталоне) — срез preserved-головы
            // (правка 252) убирает дублирование из файла клипа i, а
            // SetLatentNoiseMask гарантирует, что зона маски=0 не трогается.
            denoise: 1,
            model: ['46:30', 0],
          },
          class_type: 'BasicScheduler',
          _meta: { title: `Scheduler клип ${i + 1}` },
        }
        nodes[`ext_g_${i}`] = {
          // модель — через лок-обёртку (ext_lock_i,
          // над KJ-превью extpv), conditioning — через keyframe-якорь
          // (ext_kf_i добавляет minimax_keyframes к ext_cond_i).
          inputs: {
            model: useOld ? [`ext_lock_${i}`, 0] : ['extpv', 0],
            conditioning: useOld ? [`ext_kf_${i}`, 0] : [`ext_cond_${i}`, 0],
          },
          class_type: 'BasicGuider',
          _meta: { title: `Guider клип ${i + 1}` },
        }
        nodes[`ext_samp_${i}`] = {
          inputs: {
            noise: [`ext_noise_${i}`, 0],
            guider: [`ext_g_${i}`, 0],
            sampler: ['46:18a', 0],
            sigmas: [`ext_sched_${i}`, 0],
            latent_image: [`ext_join_${i}`, 0],
          },
          class_type: 'SamplerCustomAdvanced',
          _meta: { title: `Сэмплер клип ${i + 1} (latent masking)` },
        }
        nodes[`ext_noise_${i}`] = {
          inputs: { noise_seed: clipSeed(i) },
          class_type: 'RandomNoise',
          _meta: { title: `Шум клип ${i + 1}` },
        }
        nodes[`ext_ssep_${i}`] = {
          inputs: { av_latent: [`ext_samp_${i}`, 0] },
          class_type: 'LTXVSeparateAVLatent',
          _meta: { title: `Separate выхода ${i + 1}` },
        }

        // ─── (правка 423) PASS 2 клипа: апскейл до final + рефайн ───
        // Апскейлер меняет только пространство — темпоральная геометрия
        // (oTok/tTok/aOver/aTotal, срезы) в обоих проходах идентична.
        // Preserved-голова уже ВНУТРИ латента ext_ssep_i: апскейлится вместе
        // с клипом и защищается пересобранной под final-геометрию маской
        // (LatentCut/Concat pass 2 не нужны — латент уже полной длины).
        // Аудио пространства не имеет — passthrough с той же аудио-маской
        // (ext_amask_i от разрешения не зависит).
        if (twoPass) {
          nodes[`ext_ups_${i}`] = {
            inputs: {
              model_name: 'minimax_h3_latent_upscaler_3d_fp16.safetensors',
              mode: 'target dimensions',
              'mode.width': final.genW,
              'mode.height': final.genH,
              // align 16 достаточно: цель (канва final) кратна 32 (правка
              // 431) — выход апскейлера получает чётный латент
              align: 16,
              enable_chunking: true,
              enable_temporal_chunking: true,
              force_unload: true,
              device: 'cuda',
              precision: 'fp16',
              latent: [`ext_ssep_${i}`, 0],
            },
            class_type: 'MinimaxH3LatentUpscaler3D',
            _meta: { title: `Апскейл клип ${i + 1} → ${final.genW}×${final.genH}` },
          }
          if (useOld) Object.assign(nodes, {
            [`ext_mb2_${i}`]: {
              inputs: { width: lw2, height: lh2, batch_size: oTok, color: 0 },
              class_type: 'EmptyImage',
              _meta: { title: `Маска pass 2: чёрная ${oTok}` },
            },
            [`ext_mw2_${i}`]: {
              inputs: { width: lw2, height: lh2, batch_size: tTok - oTok, color: 16777215 },
              class_type: 'EmptyImage',
              _meta: { title: `Маска pass 2: белая ${tTok - oTok}` },
            },
            [`ext_mbat2_${i}`]: {
              inputs: { inputcount: 2, image_1: [`ext_mb2_${i}`, 0], image_2: [`ext_mw2_${i}`, 0] },
              class_type: 'ImageBatchMulti',
              _meta: { title: `Маска видео ${i + 1} (pass 2)` },
            },
            [`ext_vmask2_${i}`]: {
              inputs: { image: [`ext_mbat2_${i}`, 0], channel: 'red' },
              class_type: 'ImageToMask',
              _meta: { title: `ImageToMask ${i + 1} (pass 2)` },
            },
            [`ext_vset2_${i}`]: {
              inputs: { samples: [`ext_ups_${i}`, 0], mask: [`ext_vmask2_${i}`, 0] },
              class_type: 'SetLatentNoiseMask',
              _meta: { title: `Noise mask видео ${i + 1} (pass 2)` },
            },
            [`ext_aset2_${i}`]: {
              inputs: { samples: [`ext_ssep_${i}`, 1], mask: [`ext_amask_${i}`, 0] },
              class_type: 'SetLatentNoiseMask',
              _meta: { title: `Noise mask аудио ${i + 1} (pass 2)` },
            },
          })
          nodes[`ext_join2_${i}`] = {
            inputs: {
              video_latent: useOld ? [`ext_vset2_${i}`, 0] : [`ext_ups_${i}`, 0],
              audio_latent: useOld ? [`ext_aset2_${i}`, 0] : [`ext_ssep_${i}`, 1],
            },
            class_type: 'LTXVConcatAVLatent',
            _meta: { title: `AV-латент клип ${i + 1} (pass 2)` },
          }
          nodes[`ext_sig2_${i}`] = {
            inputs: { sigmas: sigmaVariant },
            class_type: 'ManualSigmas',
            _meta: { title: `Pass 2 Sigmas клип ${i + 1} (${p.sigmaVariant || '3step'})` },
          }
          nodes[`ext_g2_${i}`] = {
            inputs: { model: ['extpv2', 0], conditioning: [`ext_cond_${i}`, 0] },
            class_type: 'BasicGuider',
            _meta: { title: `Guider клип ${i + 1} (pass 2)` },
          }
          nodes[`ext_samp2_${i}`] = {
            inputs: {
              noise: [`ext_noise_${i}`, 0],
              guider: [`ext_g2_${i}`, 0],
              sampler: ['46:18', 0],
              sigmas: [`ext_sig2_${i}`, 0],
              latent_image: [`ext_join2_${i}`, 0],
            },
            class_type: 'SamplerCustomAdvanced',
            _meta: { title: `Сэмплер клип ${i + 1} (pass 2, рефайн)` },
          }
          nodes[`ext_ssep2_${i}`] = {
            inputs: { av_latent: [`ext_samp2_${i}`, 0] },
            class_type: 'LTXVSeparateAVLatent',
            _meta: { title: `Separate выхода ${i + 1} (pass 2)` },
          }
        }
        // (правка 423) Источник даунстрима (декод/пост-сборка): pass 2,
        // если он есть, иначе pass 1.
        const outSep = twoPass ? `ext_ssep2_${i}` : `ext_ssep_${i}`

        // ─── (правка 417) Вывод клипа — КАЖДЫЙ клип в СВОЙ файл ───
        // Откат правки 384: комбинированный латент и единый вывод удалены
        // (латент-пайплайн extend реплел исходник / замораживал конец —
        // см. заголовок buildExtendWorkflow). Каждый клип декодируется
        // отдельно → Minimax_Studio_extclip_<i> → ffmpeg-склейка клиента
        // (/api/comfy/concat). Клип 0 пишется С preserved-головой (хвост
        // исходника): её 17-кадровое дублирование глушится конкатом
        // (sourceTrim 9/24 + seamFade 8/24, правка 251). Клип i>0 —
        // со срезом 22-кадровой головы здесь, стык жёсткий (fade=0).
        // (правка 418) Срез головы клипа 0 до 17 кадров: правка 417
        // пересобрала этот блок и потеряла срез — файл клипа 0 нёс ВЕСЬ
        // хвост исходника, склейка показывала «исходник, ещё раз исходник,
        // потом продолжение». Восстановлено по до-383 коду (ext_sl_0/
        // ext_asl_0 со start = sliceStart = tailFrames − 17).
        {
          // (правки 216/251) sliceStart — за 17 кадров до конца хвоста;
          // хвост на сетке 17n+5 → срез тоже на сетке. Кламп для
          // вырожденно коротких исходников (< 22 кадров).
          const sliceStart = Math.max(0, tailFrames - 17)
          nodes[`ext_decv_${i}`] = {
            inputs: { samples: [outSep, 0], vae: ['46:3', 0] },
            class_type: 'VAEDecode',
            _meta: { title: `Decode Video (клип ${i + 1})` },
          }
          // Клип 0 (с исходником): окно «хвост⊕продолжение», срез за 17
          // кадров до конца хвоста — шов на перекрытии. Клипы i>0: срез
          // ВСЕЙ preserved-головы — файл клипа = чистое новое содержимое.
          if (i === 0 && hasSeed) {
            nodes['ext_sl_0'] = {
              inputs: { images: ['ext_decv_0', 0], start_index: sliceStart, num_frames: 4096 },
              class_type: 'GetImageRangeFromBatch',
              _meta: { title: `Срез окна: от ${sliceStart} (шов 17 кадров)` },
            }
          } else if (i > 0) {
            nodes[`ext_sl_${i}`] = {
              inputs: { images: [`ext_decv_${i}`, 0], start_index: overlapFrames, num_frames: 4096 },
              class_type: 'GetImageRangeFromBatch',
              _meta: { title: `Срез preserved-головы (${overlapFrames} кадров)` },
            }
          }
          let clipFramesSrc = i === 0 && hasSeed ? 'ext_sl_0' : i > 0 ? `ext_sl_${i}` : `ext_decv_${i}`
          if (needsCrop) {
            nodes[`ext_crop_${i}`] = {
              inputs: {
                image: [clipFramesSrc, 0],
                width: final.outW,
                height: final.outH,
                x: final.cropX,
                y: final.cropY,
              },
              class_type: 'ImageCrop',
              _meta: { title: `Точный кроп клип ${i + 1} → ${final.outW}×${final.outH}` },
            }
          }
          const clipToneSrc = needsCrop ? `ext_crop_${i}` : clipFramesSrc

          // Аудио клипа + срез головы тем же моментом
          nodes[`ext_deca_${i}`] = {
            inputs: { samples: [outSep, 1], vae: ['46:4', 0] },
            class_type: 'VAEDecodeAudio',
            _meta: { title: `Decode Audio (клип ${i + 1})` },
          }
          let clipAudioSrc = `ext_deca_${i}`
          // (правка 418) Аудио клипа 0 — срез тем же моментом, что видео:
          // от sliceStart (шов 17 кадров), синхронно с ext_sl_0.
          if (i === 0 && hasSeed) {
            nodes['ext_asl_0'] = {
              inputs: { audio: ['ext_deca_0', 0], start_seconds: Number((sliceStart / 24).toFixed(4)) },
              class_type: 'MiniMaxH3AudioSliceFrom',
              _meta: { title: `Аудио клипа: от ${(sliceStart / 24).toFixed(2)} с (шов)` },
            }
            clipAudioSrc = 'ext_asl_0'
          } else if (i > 0) {
            nodes[`ext_asl_${i}`] = {
              inputs: { audio: [`ext_deca_${i}`, 0], start_seconds: Number((overlapFrames / 24).toFixed(4)) },
              class_type: 'MiniMaxH3AudioSliceFrom',
              _meta: { title: `Аудио клипа: от ${(overlapFrames / 24).toFixed(2)} с` },
            }
            clipAudioSrc = `ext_asl_${i}`
          }

          // Сохранение клипа
          nodes[`ext_out_${i}`] = {
            inputs: {
              frame_rate: 24,
              loop_count: 0,
              filename_prefix: p.outputSubfolder
                ? `${p.outputSubfolder}/Minimax_Studio_extclip_${i}`
                : `Minimax_Studio_extclip_${i}`,
              // (правка 386) формат/качество — из [video] настроек студии
              ...vhsEnc,
              save_metadata: false,
              pingpong: false,
              save_output: true,
              images: [clipToneSrc, 0],
              audio: [clipAudioSrc, 0],
            },
            class_type: 'VHS_VideoCombine',
            _meta: { title: `Video Combine клип ${i + 1}` },
          }
        }
      }
      return nodes
    })(),

    // ═══════════════════════════════════════════════
    //  (правки 383/384/385/414/416 — ОТКАЧЕНЫ правкой 417)
    //  КОМБИНИРОВАННЫЙ ЛАТЕНТ ПРОДЛЕНИЯ УДАЛЁН.
    // ═══════════════════════════════════════════════
    // Здесь был латент-комбайн extend: срезы исходника (extcf_v/extcf_a,
    // в т.ч. из первозданного латента ext_src_lsep), срезы клипов
    // (extcc_*), конкат-цепочка (extcj_*, ext_comb), SaveAVLatent (46:49),
    // сегментный декод (ext_csep/ext_seg_*/ext_sdec_*/ext_strim_*/ext_sbatch)
    // и единый вывод Minimax_Studio_combined (ext_cout). Откат по решению
    // пользователя после серии тестов: с пиксельной головой (409) модель
    // реплела исходник с кадра 0, с латентной головой (416) — заморозка
    // конца; сегментный декод с перекрытием (411) давал стыковые попы.
    // Extend снова на проверенной схеме: клипы декодируются по отдельности
    // в extclip_<i>.mp4 и склеиваются ffmpeg-ом (/api/comfy/concat).
    // Латент-пайплайн остаётся у generate/refine/tile-upscale.
    //
    // ═══════════════════════════════════════════════
    //  (правка 420) ПОСТ-СБОРКА COMBINED-ЛАТЕНТА (без участия модели)
    // ═══════════════════════════════════════════════
    // Отличие от откаченного комбайна 383–416: латент НЕ подаётся в
    // сэмплер — он собирается ПОСЛЕ генерации чистыми срезами/конкатами и
    // пишется файлом для lossless-рефайна/тайлового апскейла итога.
    // Таймлайн = ровно таймлайн ffmpeg-склейки (перекрытие шва 17 кадров
    // съедается Trim 9 + xfade 8; клипы i>0 — срез головы 56):
    //   src[:F−17] ⊕ клип0[от tailFrames−17] ⊕ клипы i>0[от 56 кадра]
    // Проверка на реальном прогоне: mp4 260 кадров = 107+153 ✓.
    ...((hasSeed && clips.length >= 1) ? (() => {
      const nodes: Record<string, unknown> = {}
      const srcF = Math.max(5, p.extendSourceFrames ?? tailFrames)
      const srcCutTok = tok(Math.max(5, srcF - 17))
      const srcCutA = Math.round((Math.max(5, srcF - 17) * 5) / 3)
      const srcV: [string, number] = p.extendSourceLatentFile ? ['ext_srclsep', 0] : ['extv_fenc', 0]
      const srcA: [string, number] = p.extendSourceLatentFile ? ['ext_srclsep', 1] : ['extv_aful', 0]

      // Куски клипов: клип 0 — от среза шва (sliceStart), i>0 — от головы 56
      const clipCut = (i: number) =>
        i === 0 ? Math.max(0, tailFrames - 17) : CHAIN_OVERLAP_FRAMES
      const clipCutTok = (i: number) => tok(clipCut(i))
      const clipCutA = (i: number) => Math.round((clipCut(i) * 5) / 3)

      nodes['ext_ljsrc_v'] = {
        inputs: { samples: srcV, dim: 't', index: 0, amount: srcCutTok },
        class_type: 'LatentCut',
        _meta: { title: `Итог: исходник[:${srcF - 17}] (видео)` },
      }
      nodes['ext_ljsrc_a'] = {
        inputs: { samples: srcA, dim: 'x', index: 0, amount: srcCutA },
        class_type: 'LatentCut',
        _meta: { title: `Итог: исходник[:${srcF - 17}] (аудио)` },
      }
      let vCur = 'ext_ljsrc_v'
      let aCur = 'ext_ljsrc_a'
      for (let i = 0; i < clips.length; i++) {
        const cTok = clipCutTok(i)
        const cA = clipCutA(i)
        nodes[`ext_ljc_v_${i}`] = {
          inputs: { samples: [twoPass ? `ext_ssep2_${i}` : `ext_ssep_${i}`, 0], dim: 't', index: cTok, amount: 4096 },
          class_type: 'LatentCut',
          _meta: { title: `Итог: клип ${i + 1}[от ${clipCut(i)} кадра] (видео)` },
        }
        nodes[`ext_ljc_a_${i}`] = {
          inputs: { samples: [twoPass ? `ext_ssep2_${i}` : `ext_ssep_${i}`, 1], dim: 'x', index: cA, amount: 4096 },
          class_type: 'LatentCut',
          _meta: { title: `Итог: клип ${i + 1} (аудио)` },
        }
        nodes[`ext_lj_v_${i}`] = {
          inputs: { samples1: [vCur, 0], samples2: [`ext_ljc_v_${i}`, 0], dim: 't' },
          class_type: 'LatentConcat',
          _meta: { title: `Итог: конкат видео ← клип ${i + 1}` },
        }
        nodes[`ext_lj_a_${i}`] = {
          inputs: { samples1: [aCur, 0], samples2: [`ext_ljc_a_${i}`, 0], dim: 'x' },
          class_type: 'LatentConcat',
          _meta: { title: `Итог: конкат аудио ← клип ${i + 1}` },
        }
        vCur = `ext_lj_v_${i}`
        aCur = `ext_lj_a_${i}`
      }
      nodes['ext_ljoin'] = {
        inputs: { video_latent: [vCur, 0], audio_latent: [aCur, 0] },
        class_type: 'LTXVConcatAVLatent',
        _meta: { title: 'AV-латент итога продления' },
      }
      nodes['ext_lsave'] = {
        inputs: {
          samples: ['ext_ljoin', 0],
          filename_prefix: p.outputSubfolder
            ? `${p.outputSubfolder}/latents/Minimax_Studio_combined`
            : 'latents/Minimax_Studio_combined',
          vae_name: 'minimax_h3_video_vae_int8_convrot.safetensors',
        },
        class_type: 'MiniMaxStudioSaveAVLatent',
        _meta: { title: 'Save AV Latent (итог продления → lossless-рефайн)' },
      }
      return nodes
    })() : {}),
  }
}
