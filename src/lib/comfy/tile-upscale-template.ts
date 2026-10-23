import { vhsEncodeInputs, type VideoFormatSettings } from '../video-format' // (правка 386)
/**
 * Tile Upscale — латентный tiled-апскейл готового видео
 * (MMH3UltimateUpscale — монолитная нода: temporal chunks → latent upscale →
 * spatial tiles → per-tile sampling → spatial stitch → temporal stitch).
 *
 * Архитектура (по воркфлоу "Minimax H3 Latent Upscale"):
 *   VHS_LoadVideo (24 fps) ──→ GetImageSize → ComfyMathExpression (×2)
 *   EmptyMiniMaxH3LatentAV (src size, length) ──→ H3InjectVideoLatent (replaces
 *     video stream with encoded source frames, keeps audio stream)
 *   MMH3UltimateUpscale:
 *     model (UNET → H3SLAAttention → LoRA → H3AdaLNLoRAFix → SigmaShift)
 *     conditioning (MiniMaxH3ImageToVideo, без first_frame — правка 482)
 *     latent_upscale_param (MMH3LatentUpscaleWithModelParams, target W×H)
 *     temporal_split_param (MMH3TemporalSplitParams)
 *     spatial_split_param (MMH3SpatialSplitParams)
 *     noise (RandomNoise), sampler (res_multistep), sigmas (BasicScheduler 2/denoise 0.2)
 *   VAEDecode → VHS_VideoCombine (24 fps, audio из исходника)
 *
 * Тайлы: пользователь задаёт только размер тайла (tileSize) — нода
 * MMH3SpatialSplitParams работает в режиме specific_size и сама считает,
 * сколько тайлов нужно по каждой оси из размеров целевого кадра и overlap.
 *
 * Модели (наши аналоги):
 *   VAE:      minimax_h3_video_vae_int8_convrot.safetensors
 *   CLIP:     qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors
 *   UNET:     minimax_h3_fastvideo_vsa_datafree_1300step_4step_int8_convrot.safetensors
 *   LoRA:     minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors
 *   Upscaler: minimax_h3_latent_upscaler_3d_fp16.safetensors
 */

export const DEFAULT_TILE_UPSCALE_PROMPT =
  'Enhance this video with sharp, crisp details while preserving a natural photorealistic appearance.'

export interface TileUpscaleParams {
  /** Имя файла в ComfyUI input/ (уже скопирован роутом). */
  sourceVideo: string
  /** (правка 381) Путь к сохранённому AV-латенту исходника (относительно
   *  output/, поле latent_file в мете; роут уже валидировал файл и передал
   *  sourceWidth/sourceHeight = пиксельную канву ЛАТЕНТА). Задан → латент
   *  грузится напрямую (MiniMaxStudioLoadAVLatent) вместо
   *  Empty+H3InjectVideoLatent: без h264-декода и повторного VAE-encode
   *  всего клипа. mp4 остаётся источником первого кадра и аудио-дорожки. */
  sourceLatent?: string
  /** (правка 381) Кадры исходника (ffprobe) — в latent-ветке длина
   *  conditioning считается на сервере (mp4 целиком не грузим). */
  sourceFrames?: number
  /** (правка 488) Абсолютный путь к копии исходника в ComfyUI input/ —
   *  источник аудио-дорожки в latent-ветке (VHS_LoadAudio требует реальный
   *  путь, именем файла через input-директорию не резолвит, в отличие от
   *  VHS_LoadVideo). */
  sourceAudioPath?: string
  /** Размеры исходника в пикселях (ffprobe; в latent-ветке роут подменяет
   *  их пиксельной канвой латента — цель ×N считается от неё). */
  sourceWidth: number
  /** Размеры исходника в пикселях (ffprobe / канва латента). */
  sourceHeight: number
  /** Caption (default: enhance-промпт). */
  prompt?: string
  /** Seed (-1 = random). */
  seed?: number
  /** Tile size in pixels (multiple of 32). Default 768. Количество тайлов
   *  считается автоматически из размеров целевого кадра (режим specific_size
   *  ноды MMH3SpatialSplitParams). Клампится к меньшей стороне цели. */
  tileSize?: number
  /** Пространственное перекрытие, px. Default 128. */
  overlap?: number
  /** Fade width in pixels. Default 64. */
  fade?: number
  /** Temporal chunk length in frames (multiple of 17). Default 136. */
  chunkFrames?: number
  /** Temporal overlap in frames (multiple of 17). Default 17. */
  temporalOverlap?: number
  /** Anchor strength 0–1. Default 0.999. */
  anchorStrength?: number
  /** Upscale model name. Default: minimax_h3_latent_upscaler_3d_fp16.safetensors */
  upscaleModel?: string
  /** Diffusion model name. */
  diffusionModel?: string
  /** Подпапка вывода. */
  outputSubfolder?: string
  /** Короткая сторона целевого разрешения в px (720|1080|1440|2160). Default 1080. (правка 265) */
  targetResolution?: number
  /** Уровень денойза 0–1. Default 0.2. */
  denoise?: number
  /** Количество шагов сэмплирования. Default 2. */
  steps?: number
  /** (правка 481) SyncTile: per-step синхронизация тайлов (MultiDiffusion) —
   *  тайлы блендятся в общий канвас после КАЖДОГО шага + общий шумовой канвас.
   *  Убирает швы/мерцание на стыках. В этом режиме нода игнорирует
   *  fade/overlap_mode/blend/brightness_match (overlap задаёт только
   *  геометрию рамп). Default true. */
  syncTiles?: boolean
  /** (правка 483) Пользовательские LoRA из настроек — цепочкой после
   *  турбо-лоры (tu_lora), до AdaLN-фикса и SigmaShift. */
  customLoras?: Array<{ name: string; strength: number }>
  /** (правка 386) Формат/качество видео-выхода ([video] config.ini). */
  videoFormat?: VideoFormatSettings
}

/**
 * Snap a value to the nearest multiple of 17 (H3 keyframe grid step).
 */
function snap17(n: number): number {
  return Math.max(17, Math.round(n / 17) * 17)
}

/**
 * Snap a pixel value to a multiple of 32 (H3 latent patch grid).
 */
function snap32(n: number): number {
  return Math.max(32, Math.round(n / 32) * 32)
}

/** (правка 489) Лимит стороны цели у MMH3LatentUpscaleWithModelParams
 *  (валидация ноды: width/height max 4096). */
const TILE_TARGET_MAX = 4096

/**
 * (правка 265/489) Целевые размеры: короткая сторона = targetResolution,
 * длинная — по пропорции исходника, но НЕ выше TILE_TARGET_MAX: у широких
 * роликов (21:9 и т.п.) 2160p по короткой стороне давал ширину >4096 и
 * ComfyUI отклонял воркфлоу (value_bigger_than_max). В этом случае вся
 * цель сжимается с сохранением пропорции, пока длинная сторона не влезет
 * в лимит ноды.
 */
function computeTileTarget(srcW: number, srcH: number, target: number): { targetW: number; targetH: number } {
  const shortSide = Math.min(srcW, srcH)
  const scale = target / shortSide
  let targetW = snap32(srcW * scale)
  let targetH = snap32(srcH * scale)
  const longSide = Math.max(targetW, targetH)
  if (longSide > TILE_TARGET_MAX) {
    const shrink = TILE_TARGET_MAX / longSide
    targetW = snap32(srcW * scale * shrink)
    targetH = snap32(srcH * scale * shrink)
    // snap32 округляет до ближайшего кратного 32 — страховка от выхода
    // за лимит при округлении вверх.
    targetW = Math.min(targetW, TILE_TARGET_MAX)
    targetH = Math.min(targetH, TILE_TARGET_MAX)
  }
  return { targetW, targetH }
}

/** (правка 479) Геометрия тайлов/чанков для прогресс-трекера. */
export interface TileGeometry {
  totalTiles: number
  tilesW: number
  tilesH: number
  totalChunks: number
  stepsPerUnit: number
  totalUnits: number
}

/**
 * (правка 479) Расчёт числа тайлов, временных чанков и единиц сэмплинга.
 * Формулы идентичны внутренним вычислениям ноды MMH3SpatialSplitParams
 * (specific_size) и MMH3TemporalSplitParams. Возвращает null, если входные
 * параметры не позволяют сделать расчёт (srcFrames = 0 в пиксельной ветке).
 */
export function computeTileGeometry(opts: {
  sourceWidth: number
  sourceHeight: number
  targetResolution?: number
  tileSize?: number
  overlap?: number
  chunkFrames?: number
  temporalOverlap?: number
  steps?: number
  sourceFrames?: number
}): TileGeometry | null {
  const srcW = opts.sourceWidth
  const srcH = opts.sourceHeight
  if (!srcW || !srcH) return null

  const target = opts.targetResolution ?? 1080
  // (правка 489) та же формула цели, что и в buildTileUpscaleWorkflow
  // (кламп длинной стороны к лимиту ноды) — иначе геометрия прогресса
  // расходилась бы с реальным воркфлоу.
  const { targetW, targetH } = computeTileTarget(srcW, srcH, target)

  const tileMax = Math.max(256, Math.floor(Math.min(targetW, targetH) / 32) * 32)
  const tileSize = Math.min(snap32(opts.tileSize ?? 768), tileMax)
  const spatialOverlap = Math.min(snap32(opts.overlap ?? 128), tileSize - 32)

  // Grid: ceil((dim - tile) / (tile - overlap)) + 1, min 1
  const tilesW = Math.max(1, Math.ceil((targetW - tileSize) / (tileSize - spatialOverlap)) + 1)
  const tilesH = Math.max(1, Math.ceil((targetH - tileSize) / (tileSize - spatialOverlap)) + 1)
  const totalTiles = tilesW * tilesH

  // Temporal chunks
  const chunkLen = snap17(opts.chunkFrames ?? 136)
  const tempOverlap = snap17(opts.temporalOverlap ?? 17)

  let srcFrames = Math.max(0, Math.round(opts.sourceFrames ?? 0))
  if (srcFrames === 0) return null // pixel branch: frames unknown at geometry time
  const framesGrid = Math.max(5, srcFrames - ((srcFrames - 5) % 17))
  const totalChunks = Math.max(1, Math.ceil((framesGrid - tempOverlap) / (chunkLen - tempOverlap)))

  const stepsPerUnit = opts.steps ?? 2
  const totalUnits = totalTiles * totalChunks

  return { totalTiles, tilesW, tilesH, totalChunks, stepsPerUnit, totalUnits }
}

export function buildTileUpscaleWorkflow(p: TileUpscaleParams): Record<string, unknown> {
  const seed = !p.seed || p.seed < 0 ? Math.floor(Math.random() * 2 ** 31) : p.seed
  const vhsEnc = vhsEncodeInputs(p.videoFormat) // (правка 386)
  const prompt = (p.prompt ?? '').trim()

  // (правка 381) Lossless-ветка: затравка из сохранённого латента.
  const latentMode = !!p.sourceLatent
  // Сетка 17k+5 от фактических кадров (эквивалент длины из tu_src[1]),
  // на сервере: в latent-ветке mp4 целиком в граф не грузится.
  const srcFrames = Math.max(0, Math.round(p.sourceFrames ?? 0))
  const framesGrid = Math.max(5, srcFrames - ((srcFrames - 5) % 17))

  // Target dimensions: короткая сторона = targetResolution (правка 265),
  // длинная клампится к лимиту ноды 4096 (правка 489)
  const srcW = p.sourceWidth
  const srcH = p.sourceHeight
  const target = p.targetResolution ?? 1080
  const { targetW, targetH } = computeTileTarget(srcW, srcH, target)

  // Temporal params (must be multiples of 17)
  const chunkLen = snap17(p.chunkFrames ?? 136)
  const tempOverlap = snap17(p.temporalOverlap ?? 17)
  const anchor = p.anchorStrength ?? 0.999

  // Spatial params: размер тайла задаёт пользователь, сетку (сколько тайлов
  // по осям) нода считает сама из размеров целевого кадра (режим
  // specific_size). Тайл клампится к меньшей стороне цели (иначе нода
  // откажет: upscale size >= tile size), fade — к перекрытию (fade > overlap
  // тоже ошибка ноды).
  const tileMax = Math.max(256, Math.floor(Math.min(targetW, targetH) / 32) * 32)
  const tileSize = Math.min(snap32(p.tileSize ?? 768), tileMax)
  // overlap строго меньше тайла (валидация ноды) — важно при клампе тайла вниз
  const spatialOverlap = Math.min(snap32(p.overlap ?? 128), tileSize - 32)
  const fadeWidth = Math.min(snap32(p.fade ?? 64), spatialOverlap)
  const minTile = snap32(256)

  // Model chain: UNET → [custom LoRAs] → SigmaShift
  // (правка 578) Турбо-лора убрана — кастомные LoRA подключаются прямо к modelSrc
  let modelSrc: [string, number] = ['tu_unet', 0]
  const modelNodes: Record<string, unknown> = {}

  // (правка 483) Пользовательские LoRA — ДО
  // AdaLN-фикса (H3AdaLNLoRAFix патчит adaLN-слои с учётом всех применённых
  // лор, поэтому кастомные должны войти в модель раньше него).
  const customLoras = (p.customLoras ?? []).filter((l) => l.name)
  customLoras.forEach((lora, i) => {
    const id = `tu_clora_${i}`
    modelNodes[id] = {
      inputs: {
        lora_name: lora.name,
        strength_model: lora.strength,
        model: modelSrc,
      },
      class_type: 'LoraLoaderModelOnly',
      _meta: { title: `Custom LoRA ${i + 1}: ${lora.name}` },
    }
    modelSrc = [id, 0]
  })

  modelNodes['tu_sigma'] = {
    inputs: { shift_video: 12, shift_audio: 3, model: modelSrc },
    class_type: 'MiniMaxH3SigmaShift',
    _meta: { title: 'Sigma Shift' },
  }
  modelSrc = ['tu_sigma', 0]

  // (правка 478) Live превью как на вкладках Refine/Генерация: KJ-нода
  // ModelPreviewOverrideKJ в конце model-цепочки шлёт собственные
  // kj_preview_override-события на каждый шаг внутреннего сэмплинга
  // MMH3UltimateUpscale (per-tile; обёртка OUTER_SAMPLE срабатывает в
  // CFGGuider.sample, который нода строит от переданной ей модели).
  // Стандартные превью в этой сборке мертвы (--preview-method NoPreviews
  // по умолчанию), без KJ-ноды превью-окошко получало бы вообще нечего.
  // Настройки идентичны вкладкам Refine/Генерация: vae-линк + preview_frames
  // на всё видео (latent-ветка — framesGrid от сервера, пиксельная — счётчик
  // кадров tu_src, как r_cap у refine). Превью каждого per-tile шага покрывает
  // весь его временной чанк (KJ берёт min(лимит, кадров в латенте) — для
  // коротких прогонов лишний лимит безвреден, сабсэмплинга нет); taeh3 —
  // taesd-декодер H3 (24 ch). Scheduler (tu_sigmas) модель берёт БЕЗ обёртки —
  // как в refine, обёртка нужна только пути сэмплинга.
  modelNodes['tu_preview'] = {
    inputs: {
      model: modelSrc,
      vae: ['tu_vae', 0],
      tiny_vae: 'taeh3.safetensors',
      max_resolution: 1024,
      jpeg_quality: 80,
      suppress_default_preview: true,
      preview_frames: latentMode ? framesGrid : ['tu_src', 1],
      preview_fps: 6,
    },
    class_type: 'ModelPreviewOverrideKJ',
    _meta: { title: 'Model Preview Override (правка 478)' },
  }
  const previewModel: [string, number] = ['tu_preview', 0]

  const sub = p.outputSubfolder ? `${p.outputSubfolder}/` : ''

  return {
    // ═══════════════════════════════════════════════
    //  MODEL LOADING + CHAIN
    // ═══════════════════════════════════════════════
    'tu_unet': {
      inputs: {
        unet_name:
          // (правка 293) вернули основную модель
          p.diffusionModel || 'minimax_h3_fastvideo_vsa_datafree_1300step_4step_int8_convrot.safetensors',
        weight_dtype: 'default',
      },
      class_type: 'UNETLoader',
      _meta: { title: 'Diffusion Model' },
    },
    'tu_clip': {
      inputs: {
        clip_name: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
        type: 'minimax',
        device: 'default',
      },
      class_type: 'CLIPLoader',
      _meta: { title: 'CLIP' },
    },
    'tu_vae': {
      inputs: { vae_name: 'minimax_h3_video_vae_int8_convrot.safetensors' },
      class_type: 'VAELoader',
      _meta: { title: 'VAE (video)' },
    },
    'tu_audvae': {
      inputs: { vae_name: 'minimax_h3_audio_vae_fp32.safetensors' },
      class_type: 'VAELoader',
      _meta: { title: 'VAE (audio)' },
    },
    ...modelNodes,

    // ═══════════════════════════════════════════════
    //  SOURCE VIDEO LOADING
    //  (правка 381) Два пути:
    //   • latentMode — lossless: первозданный AV-латент из .latent-файла.
    //     Полный h264-декод + Empty→H3InjectVideoLatent (повторный VAE-encode
    //     всего клипа) пропускаются. mp4 вообще не декодируется (правка 482 —
    //     first_frame убран); аудио-дорожку для mux'а дёргает VHS_LoadAudio
    //     напрямую через ffmpeg (правка 488).
    //   • обычный путь — как было.
    // ═══════════════════════════════════════════════
    ...(latentMode ? {
      'tu_lat': {
        inputs: { latent: p.sourceLatent },
        class_type: 'MiniMaxStudioLoadAVLatent',
        _meta: { title: 'AV-латент исходника (lossless, правка 381)' },
      },
      // (правка 488) Раньше аудио брали с VHS_LoadVideo (frame_load_cap=1) —
      // но VHS режет дорожку до frame_load_cap × frame_time (≈1 кадр), и
      // результат выходил БЕЗ звука. VHS_LoadAudio достаёт дорожку целиком
      // через ffmpeg, не трогая видеопоток (ни RAM под кадры, ни h264-декода).
      'tu_audio': {
        inputs: {
          audio_file: p.sourceAudioPath ?? p.sourceVideo,
          seek_seconds: 0,
          duration: 0, // 0 = вся дорожка
        },
        class_type: 'VHS_LoadAudio',
        _meta: { title: 'Исходник: аудио-дорожка (mux)' },
      },
    } : {
      'tu_src': {
        inputs: {
          video: p.sourceVideo,
          force_rate: 24,
          custom_width: 0,
          custom_height: 0,
          frame_load_cap: 0,
          skip_first_frames: 0,
          select_every_nth: 1,
        },
        class_type: 'VHS_LoadVideo',
        _meta: { title: 'Исходник (24 fps)' },
      },
      'tu_size': {
        inputs: { image: ['tu_src', 0] },
        class_type: 'GetImageSize',
        _meta: { title: 'Размеры кадра' },
      },
      // Target = source × 2 (already computed server-side; these are fixed numbers)
      // We use the pre-computed targetW/targetH as constants since we know them.

      // ═══════════════════════════════════════════════
      //  AV LATENT: Empty (source size) → Inject real frames
      // ═══════════════════════════════════════════════
      'tu_empty': {
        inputs: {
          width: srcW,
          height: srcH,
          // length comes from the video frame count — use VHS output (index 1)
          length: ['tu_src', 1],
        },
        class_type: 'EmptyMiniMaxH3LatentAV',
        _meta: { title: `Пустой AV-латент ${srcW}×${srcH}` },
      },
      'tu_inject': {
        inputs: {
          av_latent: ['tu_empty', 0],
          images: ['tu_src', 0],
          vae: ['tu_vae', 0],
        },
        class_type: 'H3InjectVideoLatent',
        _meta: { title: 'Inject real frames into AV latent' },
      },
    }),

    // ═══════════════════════════════════════════════
    //  CONDITIONING: MiniMaxH3ImageToVideo (t2v-стиль, БЕЗ first_frame)
    //  (правка 482) Ключевой кадр frame-0 убран: он кодировался из
    //  НИЗКОРАЗРЕШЕННОГО первого кадра исходника (простой resize до цели +
    //  VAE-encode), а в packed-последовательности H3 сидит рядом с t=0 и
    //  тянет первые токены к своей «мыльной» версии → первые ~5 кадров
    //  результата «плыли», дальше эффект затухал. Контент и так зафиксирован
    //  самим исходным латентом (denoise низкий), а стыки временных чанков
    //  нода анкерит своими keyframes из пересэмплированных кадров
    //  (anchor_conditioning создаёт список при отсутствии) — так автор
    //  ноды и делает в эталонном upscale-воркфлоу (ReferenceToVideo без
    //  frame-0 keyframe).
    // ═══════════════════════════════════════════════
    'tu_cond': {
      inputs: {
        prompt,
        width: targetW,
        height: targetH,
        // length from the source video; (правка 381) latent-ветка — от сервера
        length: latentMode ? framesGrid : ['tu_src', 1],
        clip: ['tu_clip', 0],
        vae: ['tu_vae', 0],
      },
      class_type: 'MiniMaxH3ImageToVideo',
      _meta: { title: 'Conditioning (без first_frame — правка 482)' },
    },

    // ═══════════════════════════════════════════════
    //  MMH3 ULTIMATE UPSCALE — main pipeline node
    // ═══════════════════════════════════════════════
    'tu_up_param': {
      inputs: {
        model_name: p.upscaleModel || 'minimax_h3_latent_upscaler_3d_fp16.safetensors',
        width: targetW,
        height: targetH,
        device: 'cuda',
        precision: 'fp16',
        offload_model: true,
      },
      class_type: 'MMH3LatentUpscaleWithModelParams',
      _meta: { title: `Latent Upscale Params → ${targetW}×${targetH}` },
    },
    'tu_temporal': {
      inputs: {
        chunk_length: chunkLen,
        temporal_overlap: tempOverlap,
        anchor_strength: anchor,
      },
      class_type: 'MMH3TemporalSplitParams',
      _meta: { title: `Temporal Split (${chunkLen}f, overlap ${tempOverlap}f)` },
    },
    'tu_spatial': {
      inputs: {
        upscale_width: targetW,
        upscale_height: targetH,
        // specific_size: размер тайла задан, сетка тайлов — автоматически
        // из upscale_width/height и overlap (нода сама нарежет осям).
        tile_size_mode: 'specific_size',
        tile_width: tileSize,
        tile_height: tileSize,
        grid_rows: 1,
        grid_cols: 1,
        spatial_w_overlap: spatialOverlap,
        spatial_h_overlap: spatialOverlap,
        fade_width: fadeWidth,
        fade_height: fadeWidth,
        min_tile_size: minTile,
        // (правка 469) overlap_mode 'earlier' — дефолт ноды и единственный
        // режим, согласованный с 'linear': вес нового тайла растёт 0→1 от
        // шва вглубь полосы (на шве — контент соседа, у тела тайла — новый).
        // Пара 'later'+'linear' переворачивала рампу: на внутреннем крае
        // полосы брался старый контент, а за ней — новый → жёсткая граница
        // через overlap px от каждого шва = видимая сетка тайлов.
        // Актуально только для legacy-режима: в sync_tiles (правка 481)
        // нода игнорирует fade/overlap_mode/blend — тайлы блендятся в общий
        // канвас после каждого шага.
        overlap_mode: 'earlier',
        overlap_blend: 'linear',
        masked_area_noise: 0,
        brightness_match: false,
        dynamic_fade: 'off',
        dynamic_fade_min: 32,
        // (правка 481) SyncTile (MultiDiffusion): per-step блендинг тайлов +
        // общий шумовой канвас. Дефолт студии — ВКЛ; legacy-режим остаётся
        // доступен для A/B (syncTiles: false).
        sync_tiles: p.syncTiles !== false,
      },
      class_type: 'MMH3SpatialSplitParams',
      _meta: { title: `Spatial Split (тайл ${tileSize}px, сетка авто)` },
    },
    'tu_noise': {
      inputs: { noise_seed: seed },
      class_type: 'RandomNoise',
      _meta: { title: 'Random Noise' },
    },
    'tu_sampler': {
      inputs: { sampler_name: 'res_multistep' },
      class_type: 'KSamplerSelect',
      _meta: { title: 'Sampler (res_multistep)' },
    },
    'tu_sigmas': {
      inputs: {
        scheduler: 'simple',
        steps: p.steps ?? 2,
        denoise: p.denoise ?? 0.2,
        model: modelSrc,
      },
      class_type: 'BasicScheduler',
      _meta: { title: `BasicScheduler (${p.steps ?? 2} steps, denoise ${p.denoise ?? 0.2})` },
    },
    'tu_upscale': {
      inputs: {
        // (правка 478) модель через KJ-превью — кадры каждого шага
        // per-tile сэмплинга внутри ноды попадают в превью-окошко вкладки
        model: previewModel,
        conditioning: ['tu_cond', 0],
        // (правка 381) latent-ветка: затравка — сам загруженный латент
        latent: [latentMode ? 'tu_lat' : 'tu_inject', 0],
        noise: ['tu_noise', 0],
        sampler: ['tu_sampler', 0],
        sigmas: ['tu_sigmas', 0],
        cfg: 1.0,
        latent_upscale_param: ['tu_up_param', 0],
        temporal_split_param: ['tu_temporal', 0],
        spatial_split_param: ['tu_spatial', 0],
      },
      class_type: 'MMH3UltimateUpscale',
      _meta: { title: 'MMH3 Ultimate Upscale' },
    },

    // ═══════════════════════════════════════════════
    //  DECODE + OUTPUT
    // ═══════════════════════════════════════════════
    'tu_decode': {
      inputs: {
        samples: ['tu_upscale', 0],
        vae: ['tu_vae', 0],
      },
      class_type: 'VAEDecode',
      _meta: { title: 'VAE Decode' },
    },
    'tu_out': {
      inputs: {
        frame_rate: 24,
        loop_count: 0,
        filename_prefix: `${sub}Minimax_Studio_tileupscale`,
        // (правка 386) формат/качество — из [video] настроек студии
        ...vhsEnc,
        save_metadata: false,
        // (правка 321) A/V sync: force_rate=24 на входе СОХРАНЯЕТ длительность
        // (VHS дропает/дублирует кадры), аудио-выход VHS_LoadVideo — оригинальная
        // дорожка целиком → длительности совпадают, trim_to_audio не нужен
        // (false → VHS допедит аудио apad до длины видео, -shortest = видео).
        pingpong: false,
        save_output: true,
        images: ['tu_decode', 0],
        // (правка 488) latent-ветка: дорожка целиком из VHS_LoadAudio;
        // обычная — аудио-выход VHS_LoadVideo (pin 2, не режется — там
        // frame_load_cap=0).
        audio: latentMode ? ['tu_audio', 0] : ['tu_src', 2],
      },
      class_type: 'VHS_VideoCombine',
      _meta: { title: 'Video Combine (tile upscale)' },
    },
  }
}
