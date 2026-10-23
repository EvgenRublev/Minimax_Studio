import { vhsEncodeInputs, type VideoFormatSettings } from '../video-format'
import { buildMiniMaxH3Workflow, selectResolution, type MiniMaxH3Params } from './minimax-h3-template'

/**
 * ControlNet вкладка — препроцессинг (depth/canny) + стандартный
 * References-воркфлоу (MiniMaxH3ReferenceToVideo).
 *
 * Архитектура:
 *   Режим генерации (один workflow):
 *     cn_src (VHS_LoadVideo) → cn_pre (DepthAnythingV2 | Canny) →
 *     cn_prescale (ImageScale) → cn_preout (VHS_VideoCombine)
 *     → cn_fname (VHS_SelectFilename) → cn_refload (VHS_LoadVideoPath)
 *     → MiniMaxH3ReferenceToVideo (стандартная генерация)
 *
 *   Режим «Карта» (preprocessOnly):
 *     cn_src → cn_pre → cn_prescale → cn_out (VHS_VideoCombine)
 *     — только сохраняет depth/canny-видео, без генерации.
 *
 * Стандартная генерация полностью идентична вкладке «Генерация → Референсы»:
 * те же модели (diffusion, CLIP, VAE, turbo LoRA, upscaler), те же сэмплеры,
 * тот же pipeline (draft/full), те же опции (sparse attention, Veda, LoRAs).
 * Контрольное видео подаётся как обычное видео-референс (ref_video_0)
 * через VHS_LoadVideoPath — как и пользовательские видео-рефы.
 *
 * ВНИМАНИЕ: ComfyUI строит DAG — cn_refload зависит от cn_preout (через
 * VHS_FILENAMES), значит препроцессинг выполняется ПЕРЕД генерацией.
 */

export type ControlNetType = 'depth' | 'canny' | 'direct' | 'pose' // (правка 512) pose — DWPreprocessor

export interface ControlNetGenParams {
  /** Имя файла контрольного видео в ComfyUI input/. */
  sourceVideo: string
  /** Ширина контрольного видео (ffprobe). */
  sourceWidth: number
  /** Высота контрольного видео (ffprobe). */
  sourceHeight: number
  /** Кадров в контрольном видео (ffprobe). */
  sourceFrames: number
  /** Тип контроля: depth | canny | direct (прямой, без карт) | pose (правка 512). */
  controlType: ControlNetType
  /** Длительность генерации в секундах. */
  duration?: number
  /** Короткая сторона генерации, px. */
  targetShortSide?: number
  /** Промпт. */
  prompt?: string
  /** Seed (-1 = random). */
  seed?: number
  /** Картинки-референсы (имена файлов в input/). */
  refImages?: string[]
  /** Рефы: режим размера (match | max). */
  refImageSize?: 'match' | 'max'
  /** Пайплайн: draft | full. */
  pipeline?: 'draft' | 'full'
  /** Low-res MP (для full pipeline, Pass 1). */
  lowResMP?: number
  /** Pass 1 эффективные шаги (SplitSigmas split point, default 4, max 30). */
  firstSamplerSteps?: number
  /**
   * (правка 719) Всего шагов в расписании BasicScheduler для pass 1.
   * undefined = авто (firstSamplerSteps × 2) — «N из 2N».
   */
  firstSamplerTotalSteps?: number
  /** Custom LoRAs. */
  customLoras?: Array<{ name: string; strength: number }>
  /** Diffusion model. */
  diffusionModel?: string
  /** Подпапка вывода. */
  outputSubfolder?: string
  /**
   * (правка 716) Уникальный префикс временной карты референса (cn_preout).
   * Раньше префикс был фиксированным («Minimax_Studio_cnref» + счётчик
   * ComfyUI), и cleanup удалял ВСЕ такие карты — в том числе карты другой,
   * параллельно идущей ControlNet-задачи (контрольные карты параллельных
   * задач разрешены), из-за чего та падала внутри VHS_LoadVideoPath.
   */
  cnRefPrefix?: string
  /** Формат видео. */
  videoFormat?: VideoFormatSettings
  /** Спарсити-внимание. */
  sparseAttention?: boolean
  /** (правка 466) Sol-Attn: порог разреженности. */
  sparseTau?: number
  /** (правка 466) Sol-Attn: start_percent. */
  sparseStartPercent?: number
  /** (правка 466) Sol-Attn: end_percent. */
  sparseEndPercent?: number
  /** (правка 466) Sol-Attn: min_tokens. */
  sparseMinTokens?: number
  /** (правка 466) Sol-Attn: extra_tokens. */
  sparseExtraTokens?: number
  /** Veda attention. */
  vedaAttention?: boolean
  /** (правка 399) Veda: спарсити генерации, 'N%'. */
  vedaGeneratedSparsity?: string
  /** (правка 399) Veda: спарсити референсов, 'N%'. */
  vedaReferenceSparsity?: string
  /** (правка 399) Veda: 0-based блоки DiT с полным вниманием. */
  vedaFullAttentionLayers?: string
  /** (правка 399) Veda: 0-based шаги сэмплера с полным вниманием. */
  vedaFullAttentionSteps?: string
  /** (правка 399) Veda: подробный лог. */
  vedaVerbose?: boolean
  /** Low VRAM attention. */
  lowVramAttention?: boolean
  /** Chunk FF. */
  chunkFeedForward?: boolean
  /** ChunkFF: number of chunks. */
  chunkFFChunks?: number
  /** ChunkFF: sequence length threshold. */
  chunkFFThreshold?: number
  /** Sigma variant (pass 2). */
  sigmaVariant?: string
  /** Pass 1 sampler. */
  pass1Sampler?: string
  /** Pass 1 scheduler. */
  pass1Scheduler?: string
  /** Pass 2 sampler. */
  pass2Sampler?: string
  /** Draft steps. */
  draftSteps?: number
  /** Turbo LoRA strength. */
  turboLoraStrength?: number
  /** Turbo LoRA enabled. */
  turboLoraEnabled?: boolean
}

/** Снап к кратному 32. */
function snap32(n: number): number {
  return Math.max(32, Math.round(n / 32) * 32)
}

/**
 * Размеры генерации: короткая сторона = targetShortSide, длинная — по
 * пропорции контрольного видео; обе оси снапятся к 32.
 */
export function controlNetSize(
  sourceWidth: number,
  sourceHeight: number,
  targetShortSide: number,
): { width: number; height: number } {
  const shortSrc = Math.min(sourceWidth, sourceHeight)
  const scale = targetShortSide / shortSrc
  return {
    width: snap32(sourceWidth * scale),
    height: snap32(sourceHeight * scale),
  }
}

/**
 * Фактическое число кадров генерации: сетка 17n+5 от длительности,
 * кламп вниз к кадрам контрольного видео.
 */
export function controlNetFrames(duration: number, sourceFrames: number): number {
  const want = Math.max(5, Math.round(duration * 24))
  const snapped = want + (((5 - want) % 17) + 17) % 17
  const cap = Math.max(5, Math.round(sourceFrames))
  return Math.min(snapped, cap)
}

/**
 * Режим «Карта»: только препроцессинг → сохранить depth/canny-видео.
 */
export function buildControlNetPreprocessWorkflow(p: {
  sourceVideo: string
  sourceWidth: number
  sourceHeight: number
  sourceFrames: number
  controlType: ControlNetType
  duration?: number
  targetShortSide?: number
  outputSubfolder?: string
  videoFormat?: VideoFormatSettings
}): Record<string, unknown> {
  const vhsEnc = vhsEncodeInputs(p.videoFormat)
  const frames = Math.max(1, Math.min(Math.round((p.duration ?? 5) * 24), p.sourceFrames))
  const { width, height } = controlNetSize(p.sourceWidth, p.sourceHeight, p.targetShortSide ?? 720)
  const controlType = p.controlType === 'canny' ? 'canny' : (p.controlType === 'pose' ? 'pose' : 'depth') // (правка 512)
  const sub = p.outputSubfolder ? `${p.outputSubfolder}/` : ''

  return {
    'cn_src': {
      inputs: {
        video: p.sourceVideo,
        force_rate: 24,
        custom_width: width,
        custom_height: height,
        frame_load_cap: frames,
        skip_first_frames: 0,
        select_every_nth: 1,
      },
      class_type: 'VHS_LoadVideo',
      _meta: { title: `Контрольное видео → ${width}×${height}, ${frames} кадров` },
    },
    'cn_pre': controlType === 'canny'
      ? {
          inputs: {
            image: ['cn_src', 0],
            low_threshold: 100,
            high_threshold: 200,
            resolution: 1024,
          },
          class_type: 'CannyEdgePreprocessor',
          _meta: { title: 'Canny Edge' },
        }
      : controlType === 'pose'
        ? {
            inputs: {
              image: ['cn_src', 0],
              detect_hand: 'enable',
              detect_body: 'enable',
              detect_face: 'enable',
              resolution: 1024,
              bbox_detector: 'yolox_l.onnx',
              pose_estimator: 'dw-ll_ucoco_384.onnx',
            },
            class_type: 'DWPreprocessor',
            _meta: { title: 'DWPose' },
          }
        : {
            inputs: {
              image: ['cn_src', 0],
              ckpt_name: 'depth_anything_v2_vits.pth',
              resolution: 1024,
            },
            class_type: 'DepthAnythingV2Preprocessor',
            _meta: { title: 'Depth Anything V2' },
          },
    'cn_prescale': {
      inputs: {
        image: ['cn_pre', 0],
        upscale_method: 'bilinear',
        width,
        height,
        crop: 'disabled',
      },
      class_type: 'ImageScale',
      _meta: { title: `Контроль → точный размер ${width}×${height}` },
    },
    'cn_out': {
      inputs: {
        frame_rate: 24,
        loop_count: 0,
        filename_prefix: `${sub}Minimax_Studio_controlmap`,
        ...vhsEnc,
        save_metadata: false,
        pingpong: false,
        save_output: true,
        images: ['cn_prescale', 0],
      },
      class_type: 'VHS_VideoCombine',
      _meta: { title: `Video Combine (${controlType}-карта)` },
    },
  }
}

/**
 * Режим генерации: препроцессинг + стандартный References-воркфлоу.
 *
 * Один ComfyUI workflow, две ветки по controlType:
 *
 *   direct (правка 511):
 *     cn_src (VHS_LoadVideo) → ref_video_0
 *     — видео подаётся как обычный видео-референс, без карт.
 *
 *   depth | canny:
 *     1. cn_src → cn_pre → cn_prescale → cn_preout (сохраняет depth/canny mp4)
 *     2. cn_fname (VHS_SelectFilename) извлекает имя файла из cn_preout
 *     3. cn_refload (VHS_LoadVideoPath) загружает этот mp4 как IMAGE frames
 *     4. ref_video_0 = cn_refload
 *
 * ВНИМАНИЕ: ComfyUI строит DAG — cn_refload зависит от cn_preout,
 * значит препроцессинг выполняется ПЕРЕД генерацией.
 */
export function buildControlNetWorkflow(p: ControlNetGenParams): Record<string, unknown> {
  const { width, height } = controlNetSize(p.sourceWidth, p.sourceHeight, p.targetShortSide ?? 720)
  const frames = controlNetFrames(p.duration ?? 5, p.sourceFrames)
  const controlType: ControlNetType = p.controlType === 'canny' ? 'canny' : (p.controlType === 'direct' ? 'direct' : (p.controlType === 'pose' ? 'pose' : 'depth')) // (правка 512)
  const sub = p.outputSubfolder ? `${p.outputSubfolder}/` : ''
  const vhsEnc = vhsEncodeInputs(p.videoFormat)

  const isDirect = controlType === 'direct'

  // ─── Нода cn_src: VHS_LoadVideo — общая для обеих веток ───
  // direct: видео идёт как реф напрямую (как на вкладке «Генерация»).
  // depth/canny: исходник для препроцессинга.
  // В direct custom_width/height = 0 (как у стандартных видео-рефов: модель
  // сама работает с исходным разрешением), frame_load_cap = 0 (все кадры).
  // В depth/canny — точный размер + кламп кадров под генерацию.
  const cnSrcInputs = isDirect
    ? {
        video: p.sourceVideo,
        force_rate: 24,
        custom_width: 0,
        custom_height: 0,
        frame_load_cap: 0,
        skip_first_frames: 0,
        select_every_nth: 1,
      }
    : {
        video: p.sourceVideo,
        force_rate: 24,
        custom_width: width,
        custom_height: height,
        frame_load_cap: frames,
        skip_first_frames: 0,
        select_every_nth: 1,
      }

  const extraNodes: Record<string, unknown> = {
    'cn_src': {
      inputs: cnSrcInputs,
      class_type: 'VHS_LoadVideo',
      _meta: {
        title: isDirect
          ? 'Контрольное видео (прямой)'
          : `Контрольное видео → ${width}×${height}, ${frames} кадров`,
      },
    },
  }

  // ─── depth/canny: цепочка препроцессинга + загрузка карты как видео ───
  // direct: ничего — cn_src сразу подключается к ref_video_0.
  let refVideo0Src: [string, number] = ['cn_src', 0]

  if (!isDirect) {
    const mapType = controlType === 'canny' ? 'canny' : (controlType === 'pose' ? 'pose' : 'depth') // (правка 512)
    extraNodes['cn_pre'] = mapType === 'canny'
      ? {
          inputs: {
            image: ['cn_src', 0],
            low_threshold: 100,
            high_threshold: 200,
            resolution: 1024,
          },
          class_type: 'CannyEdgePreprocessor',
          _meta: { title: 'Canny Edge (контроль)' },
        }
      : mapType === 'pose'
        ? {
            inputs: {
              image: ['cn_src', 0],
              detect_hand: 'enable',
              detect_body: 'enable',
              detect_face: 'enable',
              resolution: 1024,
              bbox_detector: 'yolox_l.onnx',
              pose_estimator: 'dw-ll_ucoco_384.onnx',
            },
            class_type: 'DWPreprocessor',
            _meta: { title: 'DWPose (контроль)' },
          }
        : {
            inputs: {
              image: ['cn_src', 0],
              ckpt_name: 'depth_anything_v2_vits.pth',
              resolution: 1024,
            },
            class_type: 'DepthAnythingV2Preprocessor',
            _meta: { title: 'Depth Anything V2 (контроль)' },
          }
    extraNodes['cn_prescale'] = {
      inputs: {
        image: ['cn_pre', 0],
        upscale_method: 'bilinear',
        width,
        height,
        crop: 'disabled',
      },
      class_type: 'ImageScale',
      _meta: { title: `Контроль → точный размер ${width}×${height}` },
    }
    extraNodes['cn_preout'] = {
      inputs: {
        frame_rate: 24,
        loop_count: 0,
        // (правка 716) Префикс уникален для задачи — cleanup удаляет только
        // карты ЭТОГО джоба, а не карты параллельных ControlNet-задач.
        filename_prefix: `${sub}${p.cnRefPrefix ?? 'Minimax_Studio_cnref'}`,
        ...vhsEnc,
        save_metadata: false,
        pingpong: false,
        save_output: true,
        images: ['cn_prescale', 0],
      },
      class_type: 'VHS_VideoCombine',
      _meta: { title: `Сохранить ${mapType}-референс` },
    }
    // Извлекаем имя файла из VHS_FILENAMES вывода cn_preout
    extraNodes['cn_fname'] = {
      inputs: {
        filenames: ['cn_preout', 0],
        index: -1, // последний (самый полный) файл
      },
      class_type: 'VHS_SelectFilename',
      _meta: { title: 'Имя depth/canny карты' },
    }
    // Загружаем карту как видео (как и пользовательские видео-рефы)
    extraNodes['cn_refload'] = {
      inputs: {
        video: ['cn_fname', 0],
        force_rate: 24,
        custom_width: 0,
        custom_height: 0,
        frame_load_cap: 0,
        skip_first_frames: 0,
        select_every_nth: 1,
      },
      class_type: 'VHS_LoadVideoPath',
      _meta: { title: 'Загрузить depth/canny карту как видео-референс' },
    }
    refVideo0Src = ['cn_refload', 0]
  }

  // ─── Стандартный References-воркфлоу ───
  // (правка 523) Aspect ratio pass 1 — из целевого размера (width:height),
  // а не захардкоженный '16:9'. Иначе для вертикального видео (9:16) pass 1
  // генерился бы в горизонтальной канве (например 608×352), а апскейлер
  // MinimaxH3LatentUpscaler3D в режиме 'target dimensions' растягивал бы этот
  // горизонтальный latent в вертикальный 704×1280 → картинка сплющивалась
  // (upscale x1.16 y3.64 — 3× искажение по вертикали).
  //
  // Подбираем lowResMP так, чтобы selectResolution(aspect, lowResMP) дал
  // близко к targetDimensions (через бинарный поиск). Тогда lowRes ≈ final
  // и апскейлер масштабирует ~1× (без искажения пропорций).
  const aspectRatio = `${width}:${height}`
  const finalMP = (width * height) / (1024 * 1024)
  // (правка 523) Бинарный поиск lowResMP, чтобы lowRes был как можно ближе к target
  // (но не выше). selectResolution снапит к кратному 32, поэтому точное совпадение
  // возможно не всегда — но апскейлер масштабирует ~1×, пропорции сохраняются.
  let lowResMP: number
  {
    let lo = 0.05, hi = finalMP
    let best = { mp: lo, res: selectResolution(aspectRatio, lo) }
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2
      const res = selectResolution(aspectRatio, mid)
      if (res.w > width || res.h > height) {
        hi = mid
      } else {
        lo = mid
        // Запоминаем лучший (максимальный lowRes ≤ target)
        best = { mp: mid, res }
      }
    }
    lowResMP = best.mp
  }
  // (правка 523) lowRes кратный 32 (selectResolution уже даёт).
  // Если lowRes == target — апскейлер early-return (оптимально).
  // Если lowRes < target — апскейлер масштабирует ~1× (допустимо, без искажения).

  const stdParams: MiniMaxH3Params = {
    prompt: (p.prompt ?? '').trim(),
    refImages: (p.refImages ?? []).filter(Boolean).slice(0, 9),
    refVideos: [], // подменится ниже
    mode: 'ref',
    aspectRatio, // (правка 523) из target size, не '16:9'
    duration: p.duration ?? 5,
    seed: p.seed ?? -1,
    pipeline: p.pipeline === 'full' ? 'full' : 'draft',
    targetDimensions: { width, height },
    lowResMP, // (правка 523) подобранный под target
    firstSamplerSteps: p.firstSamplerSteps,
    // (правка 719) Всего шагов в расписании pass 1 (undefined = авто 2× сплита).
    firstSamplerTotalSteps: p.firstSamplerTotalSteps,
    refImageSize: p.refImageSize ?? 'max', // (правка 511) дефолт max
    outputSubfolder: p.outputSubfolder ?? '',
    videoFormat: p.videoFormat,
    customLoras: p.customLoras,
    diffusionModel: p.diffusionModel,
    sparseAttention: p.sparseAttention,
    sparseTau: p.sparseTau,
    sparseStartPercent: p.sparseStartPercent,
    sparseEndPercent: p.sparseEndPercent,
    sparseMinTokens: p.sparseMinTokens,
    sparseExtraTokens: p.sparseExtraTokens,
    vedaAttention: p.vedaAttention,
    vedaGeneratedSparsity: p.vedaGeneratedSparsity,
    vedaReferenceSparsity: p.vedaReferenceSparsity,
    vedaFullAttentionLayers: p.vedaFullAttentionLayers,
    vedaFullAttentionSteps: p.vedaFullAttentionSteps,
    vedaVerbose: p.vedaVerbose,
    lowVramAttention: p.lowVramAttention,
    chunkFeedForward: p.chunkFeedForward,
    chunkFFChunks: p.chunkFFChunks,
    chunkFFThreshold: p.chunkFFThreshold,
    sigmaVariant: p.sigmaVariant,
    pass1Sampler: p.pass1Sampler,
    pass1Scheduler: p.pass1Scheduler,
    pass2Sampler: p.pass2Sampler,
    draftSteps: p.draftSteps,
    turboLoraStrength: p.turboLoraStrength,
    turboLoraEnabled: p.turboLoraEnabled,
  }

  const stdWorkflow = buildMiniMaxH3Workflow(stdParams)

  // Подключаем контрольное видео как ref_video_0.
  // direct: cn_src (VHS_LoadVideo) — идентично стандартному паттерну
  //   (вкладка «Генерация»): видео + аудио (output[2]).
  // depth/canny: cn_refload (VHS_LoadVideoPath) — карта как видео, без аудио.
  if ('46:11' in stdWorkflow) {
    const refNode = stdWorkflow['46:11'] as Record<string, unknown>
    const inputs = refNode.inputs as Record<string, unknown>
    inputs['ref_videos.ref_video_0'] = refVideo0Src
    // direct: аудио из исходного видео (VHS_LoadVideo output[2] = AUDIO),
    // как на вкладке «Генерация» для видео-рефов.
    if (isDirect) {
      inputs['ref_video_audios.ref_video_audio_0'] = ['cn_src', 2]
    }
  }
  // Нода '501' (VHS_LoadVideo для ref video) не создаётся при refVideos:[] —
  // delete здесь harmless, оставляем на случай будущих изменений.
  delete stdWorkflow['501']

  // ─── Подмена filename_prefix на Minimax_Studio_controlnet ───
  // buildMiniMaxH3Workflow пишет «<subfolder>/Minimax_Studio» или «Minimax_Studio».
  // Галерея определяет бейдж «ControlNet» по /Minimax_Studio_controlnet/i в имени файла.
  // Перебираем все ноды с filename_prefix и подменяем хвост «Minimax_Studio».
  for (const val of Object.values(stdWorkflow)) {
    if (!val || typeof val !== 'object') continue
    const node = val as Record<string, unknown>
    if (node.class_type === 'VHS_VideoCombine' && node.inputs) {
      const inputs = node.inputs as Record<string, unknown>
      if (typeof inputs.filename_prefix === 'string') {
        // НЕ трогаем Minimax_Studio_cnref (это временная карта, не финальный вывод)
        if (!/Minimax_Studio_cnref/i.test(inputs.filename_prefix)) {
          inputs.filename_prefix = inputs.filename_prefix.replace(/Minimax_Studio$/, 'Minimax_Studio_controlnet')
        }
      }
    }
  }

  // Добавляем контрольные узлы
  const result: Record<string, unknown> = { ...stdWorkflow, ...extraNodes }

  return result
}