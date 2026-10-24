import { vhsEncodeInputs, type VideoFormatSettings } from '../video-format'

/**
 * Face Refine — перерисовка мелких лиц в готовом видео MiniMax H3.
 *
 * Набор нод ComfyUI-H3-FaceRefine (Carasibana, MIT) — «FaceDetailer для видео»:
 * детектим лицо покадрово → кропим так, чтобы голова занимала ~40 % холста →
 * отдаём кропы в H3 (MiniMaxH3ReferenceToVideo + H3InjectVideoLatent) →
 * перегенерируем их с низким denoise (H3PerFrameDenoise, denoise масштабируется
 * по размеру лица в кадре) → вклеиваем обратно ТОЛЬКО область лица
 * (H3FaceStitch, feather + колор-матч).
 *
 * Граф (по example_workflows пака, без NativeAudioLock — его пакета у нас нет,
 * звук берётся из исходника):
 *
 *   VHS_LoadVideo ─→ H3FaceTrackCrop ─┬─ crops ─→ H3InjectVideoLatent ─┐
 *                     │                │              (av_latent из H3) │
 *                     │                ├─ canvas_w/h ─┐                │
 *                     │                ├─ frame_count ┤                │
 *                     │                └─ transform ─┤                │
 *   UNETLoader → LoraLoader ──────────────── model ──┼─→ H3PerFrameDenoise
 *   CLIPLoader ────────────────────────────────────┐  │        │
 *   VAELoader(video) ───────────────────────┐      │  │  av_latent
 *   VAELoader(audio) ──────────────────┐   │      │  │
 *   LoadImage (референсы) ───────────┐ │   │      │  │
 *                                     ▼ ▼   ▼      ▼  ▼
 *                     MiniMaxH3ReferenceToVideo → positive/LATENT
 *                                             → BasicGuider / SamplerCustomAdvanced
 *                                             → VAEDecode → H3FaceStitch
 *                                             → VHS_VideoCombine
 *
 * Денойз НЕ переносится из SDXL-семейства: H3 — flow matching со сдвигом 12,
 * denoise 0.25 → эффективная sigma 0.800 (переписывает кадр). Базовое
 * значение 0.35–0.40 — по рекомендации пака.
 *
 * Число шагов обязано совпадать с турбо-лорой: у нас 4-шаговая, поэтому
 * steps по умолчанию 4 (в example-workflow пака — 8-шаговая лора и 8 шагов).
 */

export type FaceSelectMode =
  | 'largest_face'
  | 'smallest_face'
  | 'left_most'
  | 'right_most'
  | 'top_most'
  | 'bottom_most'
  | 'centre_most'
  | 'closest_to_xy'
  | 'detector_score'

export type FaceIdentityModel = 'insightface' | 'clip_vision' | 'ccip'
export type FacePasteRegion = 'face_only' | 'face_ellipse' | 'full_crop'
export type FaceUndetected = 'fade_out' | 'skip' | 'composite_anyway'

export interface FaceRefineParams {
  /** Имя файла в ComfyUI input/ (роут копирует туда исходник). */
  sourceVideo: string
  /** Caption — промпт исходного ролика (его сцены и персонажи). */
  prompt?: string
  /** Seed (-1 = random). */
  seed?: number
  /** Канва H3, px. 512 дешевле 768 в 2.25× по latent-токенам. Default 512. */
  canvas?: number
  /** Базовый denoise для BasicScheduler. Default 0.35. */
  denoise?: number
  /** Шаги сэмплирования. Default 4 (турбо-лора 4-шаговая). */
  steps?: number
  /** Сэмплер KSamplerSelect. Default 'euler'. */
  sampler?: string
  /** Правило выбора субъекта. */
  select?: FaceSelectMode
  /** Номер лица в рейтинге правила (0-based). */
  selectIndex?: number
  /**
   * (правка 723) Точка на лице, указанная кликом по кадру исходника: пиксели
   * самого видео + номер кадра. Задана — правило игнорируется, select
   * становится closest_to_xy, а нода берёт ближайшее к точке лицо и ведёт его
   * через весь ролик.
   */
  facePoint?: { x: number; y: number; frame: number }
  /** Имя файла картинки-референса в input/ — «этот конкретный человек». */
  identityReference?: string
  /** Чем сравнивать лица: insightface (фото) | clip_vision | ccip (аниме). */
  identityModel?: FaceIdentityModel
  /** Порог совпадения личности (0 = дефолт модели). */
  identityThreshold?: number
  /** Держать одного субъекта через толпу (identity_track). */
  identityTrack?: boolean
  /** Сторона кропа как кратное высоты лица. Default 2.5. */
  cropFactor?: number
  /** Порог детектора лиц. Default 0.35. */
  confidence?: number
  /** Модель детектора (значение комбо H3FaceTrackCrop, напр. 'bbox\\face_yolov8m.pt'). */
  detector?: string
  /**
   * (правка 722) Детектор «на случай, когда лица не видно» (спина, капюшон):
   * модель человека/тела — голова берётся от верха бокса. 'none' — без него.
   */
  fallbackDetector?: string
  /** (правка 722) Центр головы как доля высоты лица ниже верха бокса человека. */
  fallbackHeadFrac?: number
  /** Режим канвы: 'manual' — ровно canvas×canvas; 'auto_capped_768' — по кропу. */
  canvasMode?: 'manual' | 'auto_no_downscale' | 'auto_capped_768'
  /** Что вклеивать обратно. Default 'face_only'. */
  pasteRegion?: FacePasteRegion
  /** Расширение маски лица, px в канве. Default 16. */
  maskDilation?: number
  /** Размытие края вклейки, px исходника. Default 6. */
  feather?: number
  /** Колор-матч вклейки (0–1). Default 1. */
  colourMatch?: number
  /** Общая непрозрачность вклейки (0–1). Default 1. */
  blend?: number
  /** Что делать с кадрами без найденного лица. Default 'fade_out'. */
  undetectedFrames?: FaceUndetected
  /** Множитель denoise для самых мелких лиц. Default 1.0. */
  denoiseSmall?: number
  /** Множитель denoise для крупных лиц. Default 0.35. */
  denoiseLarge?: number
  /** Высота лица (px исходника), ниже которой — полный denoise. Default 30. */
  facePxSmall?: number
  /** Высота лица (px исходника), выше которой — множитель large. Default 120. */
  facePxLarge?: number
  /** Кривая интерполяции силы. Default 1.0. */
  gamma?: number
  /** Сглаживание кривой силы, кадры. Default 9. */
  smoothFrames?: number
  /** Картинки-референсы персонажа (имена файлов в input/). */
  refImages?: string[]
  /** Размер референсов: 'match' | 'max' (max — лучше идентичность). */
  refImageSize?: 'match' | 'max'
  /** Diffusion model name. */
  diffusionModel?: string
  /** Турбо-LoRA (шаги должны совпадать с ней). */
  lora?: string
  /** Сила турбо-LoRA (из loras.json; по умолчанию 1.0). */
  loraStrength?: number
  /**
   * Размеры/длина исходника (probe роута). Нужны для .latent-сайдкара:
   * итоговые кадры кодируются на канве ceil32 (латент обязан быть кратен
   * 32 — его проверяет validateLatentFile), а длина — для тишины, когда
   * исходник беззвучный. Не заданы — латент не сохраняется (старый behaviour).
   */
  width?: number
  height?: number
  frames?: number
  /** Подпапка вывода. */
  outputSubfolder?: string
  /** Формат/качество видео-выхода ([video] config.ini). */
  videoFormat?: VideoFormatSettings
}

export const DEFAULT_FACE_DETECTOR = 'face_yolov8m.pt'

/** Шаги по умолчанию — под нашу 4-шаговую турбо-лору. */
export const DEFAULT_FACE_STEPS = 4
/** Базовый denoise: 0.35–0.40 — рекомендованный диапазон пака. */
export const DEFAULT_FACE_DENOISE = 0.35

function pick<T extends string>(allowed: readonly T[], value: T | undefined, fallback: T): T {
  return value !== undefined && allowed.includes(value) ? value : fallback
}

export function buildFaceRefineWorkflow(p: FaceRefineParams): Record<string, unknown> {
  const canvas = Math.max(128, Math.min(1344, Math.round((p.canvas ?? 512) / 32) * 32))
  const steps = Math.max(1, Math.min(64, Math.round(p.steps ?? DEFAULT_FACE_STEPS)))
  const denoise = Math.max(0.01, Math.min(1, p.denoise ?? DEFAULT_FACE_DENOISE))
  const select = pick<FaceSelectMode>(
    ['largest_face', 'smallest_face', 'left_most', 'right_most', 'top_most', 'bottom_most', 'centre_most', 'closest_to_xy', 'detector_score'],
    p.select,
    'largest_face',
  )
  // (правка 723) Клик по лицу главнее правила: он и есть «кто именно». Без
  // точки closest_to_xy нечем мерить (X/Y = 0,0 — левый верхний угол), поэтому
  // в этом случае откатываемся на самое крупное лицо.
  const point = p.facePoint
  const selectMode: FaceSelectMode = point
    ? 'closest_to_xy'
    : select === 'closest_to_xy'
      ? 'largest_face'
      : select
  const pointX = Math.max(0, Math.round(point?.x ?? 0))
  const pointY = Math.max(0, Math.round(point?.y ?? 0))
  const pointFrame = Math.max(0, Math.round(point?.frame ?? 0))
  const identityModel = pick<FaceIdentityModel>(['insightface', 'clip_vision', 'ccip'], p.identityModel, 'insightface')
  const pasteRegion = pick<FacePasteRegion>(['face_only', 'face_ellipse', 'full_crop'], p.pasteRegion, 'face_only')
  const undetectedFrames = pick<FaceUndetected>(['fade_out', 'skip', 'composite_anyway'], p.undetectedFrames, 'fade_out')
  const canvasMode = pick<'manual' | 'auto_no_downscale' | 'auto_capped_768'>(['manual', 'auto_no_downscale', 'auto_capped_768'], p.canvasMode, 'manual')
  const sub = p.outputSubfolder ? `${p.outputSubfolder}/` : ''
  const vhsEnc = vhsEncodeInputs(p.videoFormat)

  // Модельная цепочка: UNET → [турбо-LoRA] → H3PerFrameDenoise.
  // Патченная модель уходит и в BasicGuider, и в BasicScheduler — иначе
  // пер-кадровая маска денойза не применится (нода не ругается, результат
  // просто будет «почти чистым»).
  let modelSrc: [string, number] = ['fr_unet', 0]

  const modelNodes: Record<string, unknown> = {
    fr_unet: {
      inputs: {
        unet_name: p.diffusionModel || 'minimax_h3_fastvideo_vsa_datafree_1300step_4step_int8_convrot.safetensors',
        weight_dtype: 'default',
      },
      class_type: 'UNETLoader',
      _meta: { title: 'Diffusion Model' },
    },
    fr_clip: {
      inputs: { clip_name: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', type: 'minimax', device: 'default' },
      class_type: 'CLIPLoader',
      _meta: { title: 'Text Encoder' },
    },
    fr_vae_video: {
      inputs: { vae_name: 'minimax_h3_video_vae_int8_convrot.safetensors' },
      class_type: 'VAELoader',
      _meta: { title: 'Video VAE' },
    },
    fr_vae_audio: {
      inputs: { vae_name: 'minimax_h3_audio_vae_fp32.safetensors' },
      class_type: 'VAELoader',
      _meta: { title: 'Audio VAE' },
    },
  }

  if (p.lora) {
    modelNodes['fr_lora'] = {
      inputs: { lora_name: p.lora, strength_model: p.loraStrength ?? 1.0, model: modelSrc },
      class_type: 'LoraLoaderModelOnly',
      _meta: { title: `Turbo LoRA (${p.lora})` },
    }
    modelSrc = ['fr_lora', 0]
  }

  const refImages = (p.refImages ?? []).filter(Boolean).slice(0, 9)
  refImages.forEach((name, i) => {
    modelNodes[`fr_ref_${i}`] = {
      inputs: { image: name },
      class_type: 'LoadImage',
      _meta: { title: `Референс ${i + 1}` },
    }
  })

  // (правка 722) Живое превью генерации — как на вкладках «Генерация»,
  // «Refine» и «Tile Upscale»: KJ-нода ModelPreviewOverrideKJ в конце
  // model-цепочки шлёт свои kj_preview_override-события на каждый шаг
  // сэмплинга; GenerationStatus забирает их через /api/comfy/preview.
  // Стандартные превью в этой сборке мертвы (--preview-method NoPreviews).
  // Модель берём у H3PerFrameDenoise (пер-кадровая маска denoise), а вот
  // расписание (fr_sigmas) берёт модель БЕЗ обёртки — как в Refine/Tile
  // Upscale: обёртка нужна только пути сэмплинга. preview_frames — счётчик
  // кадров трекера (тот же INT, что уходит в length у H3), taeh3 — taesd-
  // декодер H3.
  modelNodes['fr_preview'] = {
    inputs: {
      model: ['fr_denoise', 2],
      vae: ['fr_vae_video', 0],
      tiny_vae: 'taeh3.safetensors',
      max_resolution: 1024,
      jpeg_quality: 80,
      suppress_default_preview: true,
      preview_frames: ['fr_track', 6],
      preview_fps: 6,
    },
    class_type: 'ModelPreviewOverrideKJ',
    _meta: { title: 'Model Preview Override (правка 722)' },
  }

  return {
    // ═══════════════════════════════════════════════
    //  SOURCE
    // ═══════════════════════════════════════════════
    fr_src: {
      inputs: {
        video: p.sourceVideo,
        force_rate: 0,
        custom_width: 0,
        custom_height: 0,
        frame_load_cap: 0,
        skip_first_frames: 0,
        select_every_nth: 1,
      },
      class_type: 'VHS_LoadVideo',
      _meta: { title: 'Исходное видео' },
    },

    // ═══════════════════════════════════════════════
    //  FACE TRACKING + CROP
    // ═══════════════════════════════════════════════
    fr_track: {
      inputs: {
        images: ['fr_src', 0],
        detector: p.detector || DEFAULT_FACE_DETECTOR,
        confidence: Math.max(0.05, Math.min(0.95, p.confidence ?? 0.35)),
        crop_factor: Math.max(1.2, Math.min(8, p.cropFactor ?? 2.5)),
        canvas_width: canvas,
        canvas_height: canvas,
        canvas_mode: canvasMode,
        smooth_window: 21,
        size_smooth_window: 51,
        smooth_method: 'gaussian',
        size_mode: 'per_frame',
        // «Этот конкретный человек»: референс-картинка + сопоставление лиц.
        ...(p.identityReference
          ? { identity_reference: ['fr_identity', 0] }
          : {}),
        identity_track: p.identityTrack !== false,
        identity_threshold: p.identityThreshold ?? 0.28,
        select: selectMode,
        // (правка 723) Точка клика: X/Y — пиксели кадра исходника, frame_index —
        // кадр, на котором она поставлена. Нода меряет на нём и уходит вперёд
        // до первого кадра с лицами, дальше ведёт выбранное лицо непрерывностью.
        X: pointX,
        Y: pointY,
        frame_index: pointFrame,
        // (правка 722) «Далёкие планы»: если лицо не нашлось (человек спиной,
        // в капюшоне) — берём бокс человека и считаем головой его верх.
        // Значение обязано быть из списка комбо (его собирает роут по
        // /object_info), иначе ComfyUI отклонит промпт.
        fallback_detector: p.fallbackDetector || 'none',
        fallback_head_frac: Math.max(0, Math.min(1.5, p.fallbackHeadFrac ?? 0.5)),
        select_index: Math.max(0, p.selectIndex ?? 0),
        identity_model: identityModel,
        cut_detection: 'none',
        cut_threshold: 3,
        absent_shots: 'off',
      },
      class_type: 'H3FaceTrackCrop',
      _meta: { title: 'Face Track + Crop' },
    },

    // ═══════════════════════════════════════════════
    //  H3 CONDITIONING (референсы персонажа + промпт)
    // ═══════════════════════════════════════════════
    fr_h3: {
      inputs: {
        clip: ['fr_clip', 0],
        vae: ['fr_vae_video', 0],
        audio_vae: ['fr_vae_audio', 0],
        prompt: p.prompt || '',
        width: ['fr_track', 4],
        height: ['fr_track', 5],
        length: ['fr_track', 6],
        ref_image_size: p.refImageSize === 'match' ? 'match' : 'max',
        ...Object.fromEntries(refImages.map((_, i) => [`ref_images.ref_image_${i}`, ['fr_ref_' + i, 0]])),
      },
      class_type: 'MiniMaxH3ReferenceToVideo',
      _meta: { title: 'H3 (промпт + референсы)' },
    },

    // ═══════════════════════════════════════════════
    //  КРОПЫ → ВИДЕО-ПОТОК AV-ЛАТЕНТА
    // ═══════════════════════════════════════════════
    fr_inject: {
      inputs: {
        av_latent: ['fr_h3', 1],
        images: ['fr_track', 0],
        vae: ['fr_vae_video', 0],
      },
      class_type: 'H3InjectVideoLatent',
      _meta: { title: 'Inject Video Latent' },
    },

    // ═══════════════════════════════════════════════
    //  ПЕР-КАДРОВЫЙ ДЕНОЙЗ (сила ~ размеру лица)
    // ═══════════════════════════════════════════════
    fr_denoise: {
      inputs: {
        model: modelSrc,
        av_latent: ['fr_inject', 0],
        transform: ['fr_track', 1],
        denoise_multiplier_small_face: Math.max(0, Math.min(1, p.denoiseSmall ?? 1.0)),
        denoise_multiplier_large_face: Math.max(0, Math.min(1, p.denoiseLarge ?? 0.35)),
        scale_mode: 'absolute_px',
        face_px_small: Math.max(4, p.facePxSmall ?? 30),
        face_px_large: Math.max(8, p.facePxLarge ?? 120),
        gamma: Math.max(0.2, Math.min(4, p.gamma ?? 1.0)),
        smooth_frames: Math.max(1, Math.min(61, p.smoothFrames ?? 9)),
      },
      class_type: 'H3PerFrameDenoise',
      _meta: { title: 'Per-Frame Denoise' },
    },

    // ═══════════════════════════════════════════════
    //  SAMPLER
    // ═══════════════════════════════════════════════
    fr_sampler_sel: {
      inputs: { sampler_name: p.sampler || 'euler' },
      class_type: 'KSamplerSelect',
      _meta: { title: 'Сэмплер' },
    },
    fr_sigmas: {
      inputs: {
        model: ['fr_denoise', 2],
        scheduler: 'simple',
        steps,
        denoise,
      },
      class_type: 'BasicScheduler',
      _meta: { title: `Расписание (${steps} шагов, denoise ${denoise})` },
    },
    fr_noise: {
      inputs: { noise_seed: p.seed ?? -1 },
      class_type: 'RandomNoise',
      _meta: { title: 'Шум' },
    },
    fr_guider: {
      // (правка 722) модель с KJ-обёрткой превью; fr_sigmas — без неё.
      inputs: { model: ['fr_preview', 0], conditioning: ['fr_h3', 0] },
      class_type: 'BasicGuider',
      _meta: { title: 'Guider' },
    },
    fr_sample: {
      inputs: {
        noise: ['fr_noise', 0],
        guider: ['fr_guider', 0],
        sampler: ['fr_sampler_sel', 0],
        sigmas: ['fr_sigmas', 0],
        latent_image: ['fr_denoise', 0],
      },
      class_type: 'SamplerCustomAdvanced',
      _meta: { title: 'Сэмплирование' },
    },

    // ═══════════════════════════════════════════════
    //  DECODE + STITCH
    // ═══════════════════════════════════════════════
    fr_decode: {
      inputs: { samples: ['fr_sample', 0], vae: ['fr_vae_video', 0] },
      class_type: 'VAEDecode',
      _meta: { title: 'Decode' },
    },
    fr_stitch: {
      inputs: {
        base_images: ['fr_src', 0],
        refined_crops: ['fr_decode', 0],
        transform: ['fr_track', 1],
        paste_region: pasteRegion,
        mask_dilation: Math.max(0, Math.min(256, p.maskDilation ?? 16)),
        feather: Math.max(0, Math.min(256, p.feather ?? 6)),
        colour_match: Math.max(0, Math.min(1, p.colourMatch ?? 1.0)),
        blend: Math.max(0, Math.min(1, p.blend ?? 1.0)),
        undetected_frames: undetectedFrames,
      },
      class_type: 'H3FaceStitch',
      _meta: { title: 'Stitch Back' },
    },

    // ═══════════════════════════════════════════════
    //  OUTPUT (звук — из исходника)
    // ═══════════════════════════════════════════════
    fr_out: {
      inputs: {
        images: ['fr_stitch', 0],
        audio: ['fr_src', 2],
        frame_rate: 24,
        loop_count: 0,
        filename_prefix: `${sub}Minimax_Studio_facerefine`,
        ...vhsEnc,
        save_metadata: false,
        pingpong: false,
        save_output: true,
      },
      class_type: 'VHS_VideoCombine',
      _meta: { title: 'Video Combine' },
    },

    // ═══════════════════════════════════════════════
    //  SAVE AV LATENT — для lossless-переиспользования
    // ═══════════════════════════════════════════════
    // Латент сэмплера (fr_sample) — это латент КРОПОВ лиц, а не итога:
    // результатом face-refine служат исходные кадры с вклеенными лицами
    // (fr_stitch). Поэтому .latent-сайдкар строим отдельно — VAE-кодируем
    // именно итоговые кадры (тот же паттерн, что mp4-ветка рефайна:
    // ресайз на канву ceil32 ≥ исходника → VAEEncode) + аудио исходника
    // (AudioOrSilent защищает от беззвучных) → AV-латент → safetensors.
    // Финализация меты подхватит .latent из outputs и запишет latent_file
    // в сайдкар mp4 — следующий рефайн/апскейл этого видео пойдёт по
    // lossless-пути, минуя h264-декод и повторный VAEEncode.
    ...(p.width && p.height
      ? {
          fr_ls_res: {
            inputs: {
              image: ['fr_stitch', 0],
              width: Math.ceil(p.width / 32) * 32,
              height: Math.ceil(p.height / 32) * 32,
              upscale_method: 'lanczos',
              keep_proportion: 'stretch',
              pad_color: '0, 0, 0',
              crop_position: 'center',
              divisible_by: 16,
              device: 'cpu',
            },
            class_type: 'ImageResizeKJv2',
            _meta: { title: `Итог → ceil32-канва (кодирование)` },
          },
          fr_ls_enc: {
            inputs: { pixels: ['fr_ls_res', 0], vae: ['fr_vae_video', 0] },
            class_type: 'VAEEncode',
            _meta: { title: 'VAE-кодирование итога' },
          },
          fr_ls_asafe: {
            inputs: {
              audio: ['fr_src', 2],
              fallback_seconds: Number(((p.frames ?? 120) / 24).toFixed(2)),
            },
            class_type: 'MiniMaxH3AudioOrSilent',
            _meta: { title: 'Аудио исходника (или тишина)' },
          },
          fr_ls_aenc: {
            inputs: { audio: ['fr_ls_asafe', 0], vae: ['fr_vae_audio', 0] },
            class_type: 'VAEEncodeAudio',
            _meta: { title: 'Аудио → латент' },
          },
          fr_ls_cat: {
            inputs: { video_latent: ['fr_ls_enc', 0], audio_latent: ['fr_ls_aenc', 0] },
            class_type: 'LTXVConcatAVLatent',
            _meta: { title: 'AV-латент итога' },
          },
          fr_ls_save: {
            inputs: {
              samples: ['fr_ls_cat', 0],
              filename_prefix: `${sub}latents/Minimax_Studio_facerefine`,
              vae_name: 'minimax_h3_video_vae_int8_convrot.safetensors',
            },
            class_type: 'MiniMaxStudioSaveAVLatent',
            _meta: { title: 'Save AV Latent (для lossless-переиспользования)' },
          },
        }
      : {}),

    ...modelNodes,

    // Картинка-референс «этого человека» (для identity_reference).
    ...(p.identityReference
      ? {
          fr_identity: {
            inputs: { image: p.identityReference },
            class_type: 'LoadImage',
            _meta: { title: 'Кто именно (референс лица)' },
          },
        }
      : {}),
  }
}
