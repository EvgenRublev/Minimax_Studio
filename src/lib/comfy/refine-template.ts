import { vhsEncodeInputs, type VideoFormatSettings } from '../video-format' // (правка 386)
import { chainLatentCut } from './latent-cut' // (правка 392)
import { clampVedaSparsity, sanitizeVedaIndexList, buildCustomLoraNodes, getLastLoraOutput } from './minimax-h3-template' // (правка 399; хелперы LoRA — правка 483)
// (правка 723) Лестница сигм/пресет Pass 2 вынесены в отдельный модуль без импортов,
// чтобы вкладка Refine могла их импортировать, не таща в клиентский бандл весь шаблон.
import { refineSigmaLadder } from './refine-sigmas'
/**
 * Refine — генеративный v2v-апскейл готового видео (латентная схема Pass 2).
 *
 * Вместо тяжёлого LMS-рецепта (guide на весь клип → denoise 1.0 на 8 шагов,
 * ~27k токенов внимания и ~1.5 ч на 3.9 с в 1080p) исходник кодируется
 * video-VAE в СВОЁМ разрешении и становится затравкой сэмплера — той же
 * ролью, что выход Pass 1 во вкладке «Генерация»:
 *
 *   VHS_LoadVideo (24 fps) ─IMAGE→ align 17k+5 → Resize(/32) → VAEEncode
 *                           └AUDIO→ VHS_VideoCombine (звук без re-encode)
 *   Encoded latent ──→ MinimaxH3LatentUpscaler3D (target genW×genH, узел
 *                      '46:26' вкладки «Генерация»)
 *   Empty AV latent ─→ Separate → audio-латент нужной длины
 *   Concat(upscaled video, empty audio) ──→ SamplerCustomAdvanced
 *   (RandomNoise, euler, ManualSigmas = лестницы Pass 2: 0.9035…) →
 *   Separate → VAEDecode (только видео) → [ImageCrop до номинала] → VHS
 *
 * (правка 376) Lossless-ветка: если у исходника есть сохранённый латент
 * генерации (.latent-файл, поле latent_file в мете; см. правку 375),
 * затравка строится из НЕГО (MiniMaxStudioLoadAVLatent) — h264-декод,
 * Resize и VAEEncode всего клипа пропускаются, аудио-часть тоже родная.
 * mp4 грузится только первым кадром (якорь conditioning). Дальше конвейер
 * тот же: апскейлер → лестница Pass 2 → decode. Fallback на mp4-путь —
 * автоматический (latent-файл отсутствует/изменён/VAE не совпал).
 *
 * Почему так:
 *  • Sequence = только целевое разрешение (~15k токенов на 3.9 с в 1080p
 *    против ~27k у guide-схемы) — цена шага = цене шага Pass 2 генерации.
 *  • 3–5 шагов по лестницам Pass 2 вместо 8 полных.
 *  • Первый кадр исходника — референс ВСЕГДА, но (правка 315) слот зависит
 *    от наличия картинок-референсов из меты исходника: с ними МЕТА-РЕФЫ
 *    занимают <Picture 1..k> (исходный порядок оригинальной генерации —
 *    как режим 'ref' вкладки «Генерация», чтобы сохранённые в промпте
 *    теги <Picture N> указывали на те же изображения), а первый кадр
 *    идёт ПОСЛЕДНИМ (<Picture k+1>); без мета-рефов первый кадр =
 *    <Picture 1>, как раньше. Якорит палитру/идентичность/материалы при
 *    ре-рендере; 'match' не апскейлит — ~900 токенов.
 *  • Временная сетка: VAEEncode и EmptyMiniMaxH3LatentAV дают ОДИНАКОВЫЙ
 *    latent_t только на сетке 17k+5 (клипы < 5 кадров → 1 кадр) — поэтому
 *    кадры обрезаются in-graph до n ≡ 5 (mod 17) (паттерн кропа AddGuide),
 *    и та же величина идёт в length Empty-латента.
 *  • (правка 313) Звук перегенерируется как во 2-м проходе генерации:
 *    дорожка исходника → VAEEncodeAudio → в AV-латент → сэмплер →
 *    VAEDecodeAudio → выход. У беззвучного исходника
 *    MiniMaxH3AudioOrSilent подставляет тихую дорожку (иначе VHS_LoadVideo
 *    роняет VAEEncodeAudio). В режиме «Частями» аудио куска цепляется
 *    как видео (хвост куска k−1 ⊕ новое окно, noise mask чёрная на хвосте),
 *    а при сшивке склеивается по кускам.
 *  • Сигма-лестницы — эталон Pass 2 (SIGMA_VARIANTS вкладки «Генерация»);
 *    мягкий вход (σ_start 0.63, правка 199) пересглаживал — не используем.
 *
 * Модельная цепочка = цепочка вкладки «Генерация»:
 *   UNET → [LowVRAM] → [ChunkFF] → Turbo LoRA → SigmaShift
 *   → [SparseAttn] → AttentionBackend (+ KJ live preview)
 */
import { computeFinalDimensions, type FinalDimensions } from './minimax-h3-template'

/** Caption по умолчанию (из докa LMS-рецепта; нейтральный enhance). */
export const DEFAULT_REFINE_PROMPT =
  'Enhance this video with sharp, crisp details while preserving a natural photorealistic appearance.'

/** (правка 316) Подпись слота мета-рефа: с ролью imageIntent из меты —
 *  осмысленная, без роли — generic (как правка 305/309). */
function metaRefCaption(slot: number, role: string): string {
  const r = role.trim()
  return r
    ? `<Picture ${slot}> is the reference image of ${r}. Keep this subject's appearance exactly.`
    : `<Picture ${slot}> is a reference image for style, subjects and appearance consistency.`
}

/** (правка 315) Текст-якорь первого кадра: палитра/свет/стиль исходника. */
function firstFrameCaption(slot: number): string {
  return `<Picture ${slot}> is the first frame of this same video. Reproduce its subjects, colors, materials, lighting and style exactly; keep the original appearance unchanged, only refine fine detail.`
}

// (правка 723) SIGMA_LADDERS и refineSigmaLadder переехали в ./refine-sigmas
// (клиентская вкладка Refine импортирует их оттуда же).

export interface RefineParams {
  /** Имя файла исходника в ComfyUI input/ (уже скопирован роутом /api/comfy/refine). */
  sourceVideo: string
  /** (правка 376) Путь к сохранённому AV-латенту исходника, относительно
   *  output/ ComfyUI (поле latent_file в .meta.json, файл ноды
   *  MiniMaxStudioSaveAVLatent правки 372). Задан (роут уже проверил
   *  валидность: существование, шапку safetensors, совпадение VAE/кадров/
   *  разрешения с mp4) → затравка сэмплера строится из латента напрямую,
   *  без h264-декода + Resize + VAEEncode всего клипа (lossless-путь).
   *  mp4 остаётся источником только ПЕРВОГО КАДРА для conditioning. */
  sourceLatent?: string
  /** (правка 376) Кадры исходника (ffprobe, 24 fps). В latent-ветке длина
   *  conditioning/превью считается на сервере по этой величине — mp4
   *  целиком в граф не грузится. Обязателен при заданном sourceLatent. */
  sourceFrames?: number
  /** Размеры исходника в пикселях (ffprobe на сервере) — для расчёта цели. */
  sourceWidth: number
  sourceHeight: number
  /** Целевая короткая сторона: 'same' = разрешение исходника (только шарп),
   *  'x2' = удвоение разрешения (латентный ×2-рецепт), либо 720 / 1080. */
  targetShortSide: 'same' | 'x2' | number
  /** Caption (default: enhance-промпт). */
  prompt?: string
  /** Seed (-1 = random). */
  seed?: number
  /** Сигма-лестница Pass 2: 3 (default) | 4 | 5 шагов. */
  steps?: number
  /** σ_start лестницы (0.1–0.95): «сколько шума убирать». undefined = эталон. */
  sigmaStart?: number
  /** (режим «Частями») Пропустить первые N кадров исходника — старт куска. */
  skipFrames?: number
  /** (режим «Частями») Загрузить не более N кадров — длина куска. 0 = всё. */
  frameCap?: number
  /** (режим «Частями») Джоб одного куска: без аудио в выходе (звук кладёт
   *  сшивка из целого исходника) и с префиксом Minimax_Studio_refinepart. */
  chunkJob?: boolean
  /** Diffusion model filename (default — как во вкладке «Генерация»). */
  diffusionModel?: string
  /** Подпапка вывода (папка проекта галереи; '' = общая). */
  outputSubfolder?: string
  /** MiniMaxLowVRAMAttention (default true). */
  lowVramAttention?: boolean
  /** MiniMaxChunkFeedForward (default true). */
  chunkFeedForward?: boolean
  /** MiniMaxSparseAttention / Sol-Attn (default true). */
  sparseAttention?: boolean
  /** (правка 466) Sol-Attn: настройки ноды (см. MiniMaxH3Params). */
  sparseTau?: number
  sparseStartPercent?: number
  sparseEndPercent?: number
  sparseMinTokens?: number
  sparseExtraTokens?: number
  /** (правка 301) Veda Sparse Attention (default false). */
  vedaAttention?: boolean
  /** (правка 399) Veda: настройки ноды (см. MiniMaxH3Params). */
  vedaGeneratedSparsity?: string
  vedaReferenceSparsity?: string
  vedaFullAttentionLayers?: string
  vedaFullAttentionSteps?: string
  vedaVerbose?: boolean
  /** (правка 309, тип — правка 311) Картинки-референсы из меты исходника
   *  (ComfyUI input/ filenames + роль imageIntent, может быть '').
   *  (правка 315) Подаются как <Picture 1..k> в исходном порядке оригинальной
   *  генерации, первый кадр видео — последним (<Picture k+1>). */
  refImages?: Array<{ path: string; role: string }>
  /** (правка 323) Режим размера референсов (ref_image_size ноды
   *  MiniMaxH3ReferenceToVideo): 'match' — не апскейлит референс
   *  (дешевле), 'max' — полное разрешение (точнее идентичность).
   *  Дефолт 'max' (требование пользователя). */
  refImageSize?: 'match' | 'max'
  /** (правка 386) Формат/качество видео-выхода ([video] config.ini). */
  videoFormat?: VideoFormatSettings
  /** (правка 483) Пользовательские LoRA из настроек — цепочкой после
   *  турбо-лоры ('46:36'), как во вкладке «Генерация» (правка 44). */
  customLoras?: Array<{ name: string; strength: number }>
  /** (правка 483) Суффикс промпта (триггерные слова включённых LoRA) —
   *  дописывается в самый конец conditioning-промпта, после подписей
   *  референсов. В мету не попадает (роут хранит чистый промпт). */
  promptSuffix?: string
  /** (правка 492) Не перегенерировать звук: на выход муксится ОРИГИНАЛЬНАЯ
   *  дорожка исходника вместо декода аудио-латента сэмплера. mp4-путь —
   *  'r_asafe' (VHS_LoadVideo целиком, тишина при отсутствии дорожки);
   *  latent-путь — декод родного аудио-латента из .latent ('r_lsep', 1),
   *  т.е. первозданный звук без aac/re-encode потерь. На sampling не влияет:
   *  аудио-латент в затравке остаётся прежним. */
  keepOriginalAudio?: boolean
}

/**
 * Целевая геометрия: масштаб исходника до короткой стороны target,
 * gen = ceil32(номинала) под латент, финал — центрированный кроп до
 * номинала (паттерн правки 124 вкладки «Генерация»).
 */
export function refineDimensions(
  srcW: number,
  srcH: number,
  targetShortSide: 'same' | 'x2' | number,
): FinalDimensions & { nominalW: number; nominalH: number } {
  const even = (n: number) => 2 * Math.round(n / 2)
  let nominalW: number
  let nominalH: number
  if (targetShortSide === 'same') {
    nominalW = even(srcW)
    nominalH = even(srcH)
  } else if (targetShortSide === 'x2') {
    nominalW = even(srcW * 2)
    nominalH = even(srcH * 2)
  } else {
    const short = Math.min(srcW, srcH)
    const scale = targetShortSide / short
    nominalW = even(srcW * scale)
    nominalH = even(srcH * scale)
  }
  const final = computeFinalDimensions(nominalW, nominalH)
  return { ...final, nominalW, nominalH }
}

/**
 * Собрать ComfyUI API-format workflow для Refine (v2v латентная схема).
 */
export function buildRefineWorkflow(p: RefineParams): Record<string, unknown> {
  const seed = !p.seed || p.seed < 0 ? Math.floor(Math.random() * 2 ** 31) : p.seed
  const vhsEnc = vhsEncodeInputs(p.videoFormat) // (правка 386)
  // (рецепт «лёгкий ×2», по мотивам MMH3UltimateUpscale): steps=2 → вместо
  // лестницы ManualSigmas берём BasicScheduler(2 шага, denoise 0.2) — шум
  // стартует с ~20% расписания, модель только дорисовывает детали; сэмплер
  // res_multistep. Полный ×2-рецепт: цель 'x2' + steps=2.
  const light = p.steps === 2
  const ladder = refineSigmaLadder(p.steps ?? 3, p.sigmaStart)
  const basePrompt = (p.prompt ?? '').trim() || DEFAULT_REFINE_PROMPT
  // (правка 315) Слоты сохраняют нумерацию оригинальной генерации: мета-рефы
  // идут ПЕРВЫМИ — ref_image_0..k-1 → <Picture 1..k> (порядок массива =
  // порядок references в use-video-gen.ts metaReferences, где refImages[i]
  // мапился на ref_image_i → <Picture i+1>; фильтр type==='image' в
  // readMetaImageRefs сохраняет относительный порядок). Первый кадр видео —
  // ПОСЛЕДНИЙ слот ref_image_k → <Picture k+1>. Так теги <Picture N>,
  // сохранённые sanitizeDraftPrompt (правка 310), указывают на те же
  // изображения, что в оригинале. Без мета-рефов: первый кадр = <Picture 1>.
  const metaRefs = (p.refImages ?? []).slice(0, 8) // max 8 внешних + 1 первый кадр = 9 всего
  let prompt = basePrompt
  if (metaRefs.length > 0) {
    prompt += `\n\n` + metaRefs.map((r, i) => metaRefCaption(i + 1, r.role)).join(' ')
    prompt += `\n\n` + firstFrameCaption(metaRefs.length + 1)
  } else {
    prompt += `\n\n` + firstFrameCaption(1)
  }
  // (правка 483) Триггерные слова пользовательских LoRA — в конец промпта
  const pSuffix = p.promptSuffix?.trim()
  if (pSuffix) prompt += ` ${pSuffix}`
  const condNodeId = '46:11r'
  const final = refineDimensions(p.sourceWidth, p.sourceHeight, p.targetShortSide)
  const needsCrop = final.genW !== final.outW || final.genH !== final.outH
  const sub = p.outputSubfolder ? `${p.outputSubfolder}/` : ''

  // Кодируем исходник в СВОЁМ разрешении (дёшево), до /32-сетки — латент
  // без апскейлера должен напрямую ложиться в сетку DiT (patch 2×2).
  const ceil32 = (n: number) => Math.max(32, Math.ceil(n / 32) * 32)
  // Латентный 3D-апскейлер поддерживает только УВЕЛИЧЕНИЕ (scale >= 1.0):
  // при цели меньше исходника (напр. 1080p → 720p) кодируем исходник сразу
  // в сетке цели — пиксельный ресайз до VAEEncode ('r_res' уже в цепочке),
  // апскейлер не подключается.
  const downscale = final.genW < ceil32(p.sourceWidth) || final.genH < ceil32(p.sourceHeight)
  const encW = downscale ? final.genW : ceil32(p.sourceWidth)
  const encH = downscale ? final.genH : ceil32(p.sourceHeight)
  // Апскейлер не нужен, когда ген уже равен кодируемому размеру ('same').
  const needsUpscale = final.genW !== encW || final.genH !== encH

  // (правка 376) Lossless-ветка: затравка из сохранённого AV-латента.
  const latentMode = !!p.sourceLatent
  // Сетка 17k+5 от фактических кадров исходника (эквивалент 'r_cap'), но
  // на сервере: в latent-ветке mp4 целиком в граф не грузится. Формула та
  // же, что у ComfyMathExpression 'r_cap': max(5, a - ((a - 5) % 17)).
  const srcFrames = Math.max(0, Math.round(p.sourceFrames ?? 0))
  const framesGrid = Math.max(5, srcFrames - ((srcFrames - 5) % 17))

  // ─── Model optimization chain: UNET → [LowVRAM] → [ChunkFF] ───
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
      inputs: { chunks: 2, seq_threshold: 4096, model: modelSrc },
      class_type: 'MiniMaxChunkFeedForward',
      _meta: { title: 'Chunk FeedForward' },
    }
    modelSrc = ['46:40', 0]
  }

  return {
    // ═══════════════════════════════════════════════
    //  MODEL LOADING + CHAIN (как вкладка «Генерация»)
    // ═══════════════════════════════════════════════
    '46:30': {
      inputs: {
        unet_name:
          p.diffusionModel || 'minimax_h3_fastvideo_vsa_datafree_1300step_4step_int8_convrot.safetensors', // (правка 293)
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

    ...modelNodes,

    // (правка 578) Турбо-лора убрана — кастомные LoRA подключаются прямо к modelSrc
    ...buildCustomLoraNodes(p.customLoras, modelSrc),
    '46:38': {
      inputs: { shift_video: 12, shift_audio: 3, model: getLastLoraOutput(p.customLoras, modelSrc) },
      class_type: 'MiniMaxH3SigmaShift',
      _meta: { title: 'Sigma Shift' },
    },
    // (правка 301) Veda или Sol-Attn
    ...(p.vedaAttention ? {
      '46:44': {
        inputs: {
          model: ['46:38', 0],
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
          model: ['46:38', 0],
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
        model: (p.vedaAttention || p.sparseAttention === true) ? ['46:44', 0] : ['46:38', 0],
      },
      class_type: 'ModelAttentionBackend',
      _meta: { title: 'Attention Backend' },
    },

    // ═══════════════════════════════════════════════
    //  SOURCE → ЗАТРАВКА ЛАТЕНТА (роль Pass 1)
    //  (правка 376) Два пути:
    //   • latentMode — lossless: первозданный AV-латент генерации из
    //     .latent-файла (MiniMaxStudioLoadAVLatent). Полный h264-декод +
    //     Resize + VAEEncode всего клипа пропускаются; аудио-часть затравки
    //     = аудио-латент той же генерации (тоже без потерь). Апскейлер и
    //     дальше по конвейеру — без изменений (маски/швы не в этом режиме).
    //   • обычный путь (латента нет / mp4 изменён / чужое видео) — как было.
    // ═══════════════════════════════════════════════
    ...(latentMode ? {
      'r_lat': {
        inputs: { latent: p.sourceLatent },
        class_type: 'MiniMaxStudioLoadAVLatent',
        _meta: { title: 'AV-латент исходника (lossless, правка 376)' },
      },
      // Первый кадр mp4 — единственное, что берём из пиксельного пути:
      // conditioning-якорь палитры/идентичности (правка 315). Загрузка
      // ОДНОГО кадра (frame_load_cap: 1); копия исходника в input/ уже
      // сделана роутом. Без апскейлера ('same') затравка = сам 'r_lat'.
      'r_f0src': {
        inputs: {
          video: p.sourceVideo,
          force_rate: 24,
          custom_width: 0,
          custom_height: 0,
          frame_load_cap: 1,
          skip_first_frames: 0,
          select_every_nth: 1,
        },
        class_type: 'VHS_LoadVideo',
        _meta: { title: 'Исходник: первый кадр (якорь conditioning)' },
      },
      // (правка 492) r_lsep нужен и БЕЗ апскейлера (цель 'same'): из
      // аудио-половины латента берётся оригинальный звук (keepOriginalAudio).
      ...((needsUpscale || p.keepOriginalAudio) && {
        'r_lsep': {
          inputs: { av_latent: ['r_lat', 0] },
          class_type: 'LTXVSeparateAVLatent',
          _meta: { title: 'Separate AV Latent (загруженный)' },
        },
      }),
      ...(needsUpscale && {
        // Тот же узел/параметры, что Pass 1→2 вкладки «Генерация» ('46:26').
        'r_up': {
          inputs: {
            model_name: 'minimax_h3_latent_upscaler_3d_fp16.safetensors',
            mode: 'target dimensions',
            'mode.width': final.genW,
            'mode.height': final.genH,
            align: 32,
            enable_chunking: true,
            device: 'cuda',
            precision: 'fp16',
            latent: ['r_lsep', 0],
          },
          class_type: 'MinimaxH3LatentUpscaler3D',
          _meta: { title: `Latent Upscaler (3D) → ${final.genW}×${final.genH}` },
        },
        'r_cat': {
          inputs: {
            video_latent: ['r_up', 0],
            // аудио-латент генерации из того же .latent-файла
            audio_latent: ['r_lsep', 1],
          },
          class_type: 'LTXVConcatAVLatent',
          _meta: { title: 'AV-латент (апскейл загруженного латента)' },
        },
      }),
      // (правка 492) Оригинальный звук без перегенерации: декод родного
      // аудио-латента из .latent исходника (первозданный, без aac-потерь mp4).
      ...(p.keepOriginalAudio && {
        'r_aorig': {
          inputs: { samples: ['r_lsep', 1], vae: ['46:4', 0] },
          class_type: 'VAEDecodeAudio',
          _meta: { title: 'Оригинальный звук (аудио-латент исходника)' },
        },
      }),
    } : {
      // force_rate 24: таймбаза модели; исходники H3 и так 24 fps —
      // нормализация для импортных 25/30 fps (паттерн правки 211).
      // (правка 322) VHS force_rate дропает/дублирует кадры СОХРАНЯЯ
      // длительность, а его аудио-выход — оригинальная дорожка целиком:
      // VAEEncodeAudio кодирует звук той же длительности, что и видео →
      // A/V sync сохраняется, trim_to_audio на выходе не нужен.
      // (режим «Частями») skipFrames/frameCap вырезают окно куска.
      'r_src': {
        inputs: {
          video: p.sourceVideo,
          force_rate: 24,
          custom_width: 0,
          custom_height: 0,
          frame_load_cap: p.frameCap ?? 0,
          skip_first_frames: p.skipFrames ?? 0,
          select_every_nth: 1,
        },
        class_type: 'VHS_LoadVideo',
        _meta: { title: `Исходник (24 fps${p.skipFrames ? `, с ${p.skipFrames} кадра` : ''})` },
      },
      'r_cnt': {
        inputs: { image: ['r_src', 0] },
        class_type: 'GetImageSizeAndCount',
        _meta: { title: 'Кадров в исходнике' },
      },
      // Выравнивание ВНИЗ до сетки модели 17k+5 (паттерн кропа AddGuide):
      // только на ней VAEEncode и EmptyMiniMaxH3LatentAV дают одинаковый
      // latent_t — иначе конкат видео+аудио латентов рассогласуется.
      'r_cap': {
        inputs: {
          expression: 'max(5, a - ((a - 5) % 17))',
          'values.a': ['r_cnt', 3],
        },
        class_type: 'ComfyMathExpression',
        _meta: { title: 'Кадры до сетки 17k+5' },
      },
      'r_img': {
        inputs: { image: ['r_src', 0], batch_index: 0, length: ['r_cap', 1] },
        class_type: 'ImageFromBatch',
        _meta: { title: 'Кадры по сетке' },
      },
      // Ресайз до /32-сетки кодирования (паттерн 'extv_tres' вкладки Extend).
      'r_res': {
        inputs: {
          image: ['r_img', 0],
          width: encW,
          height: encH,
          upscale_method: 'lanczos',
          keep_proportion: 'stretch',
          pad_color: '0, 0, 0',
          crop_position: 'center',
          divisible_by: 16,
          device: 'cpu',
        },
        class_type: 'ImageResizeKJv2',
        _meta: { title: `Исходник → ${encW}×${encH} (кодирование)` },
      },
      'r_enc': {
        inputs: { pixels: ['r_res', 0], vae: ['46:3', 0] },
        class_type: 'VAEEncode',
        _meta: { title: 'VAE-кодирование исходника' },
      },
      // (правка 313) Аудио перегенерируется: дорожка исходника защищена
      // MiniMaxH3AudioOrSilent (у беззвучного видео обращение к waveform из
      // VHS_LoadVideo бросает исключение и роняло бы VAEEncodeAudio — раньше
      // VHS_VideoCombine просто пропускал mux, теперь подставляем тишину)
      // → VAEEncodeAudio → в AV-латент ниже.
      'r_asafe': {
        inputs: { audio: ['r_src', 2], fallback_seconds: 5.0 },
        class_type: 'MiniMaxH3AudioOrSilent',
        _meta: { title: 'Аудио исходника (или тишина)' },
      },
      'r_aenc': {
        inputs: { audio: ['r_asafe', 0], vae: ['46:4', 0] },
        class_type: 'VAEEncodeAudio',
        _meta: { title: 'Аудио → латент (правка 313)' },
      },
      // (правка 313: узлы r_len/r_spl удалены — аудио-латент больше не пустой)
      ...(needsUpscale && {
        // Тот же узел/параметры, что Pass 1→2 вкладки «Генерация» ('46:26').
        'r_up': {
          inputs: {
            model_name: 'minimax_h3_latent_upscaler_3d_fp16.safetensors',
            mode: 'target dimensions',
            'mode.width': final.genW,
            'mode.height': final.genH,
            align: 32,
            enable_chunking: true,
            device: 'cuda',
            precision: 'fp16',
            latent: ['r_enc', 0],
          },
          class_type: 'MinimaxH3LatentUpscaler3D',
          _meta: { title: `Latent Upscaler (3D) → ${final.genW}×${final.genH}` },
        },
      }),
      'r_cat': {
        inputs: {
          video_latent: [needsUpscale ? 'r_up' : 'r_enc', 0],
          // (правка 313) реальное аудио исходника, закодированное audio-VAE
          audio_latent: ['r_aenc', 0],
        },
        class_type: 'LTXVConcatAVLatent',
        _meta: { title: 'AV-латент (затравка сэмплера)' },
      },
    }),
    // ─── Conditioning: мета-рефы (<Picture 1..k>) + ПЕРВЫЙ КАДР видео
    // ПОСЛЕДНИМ слотом (<Picture k+1>; без мета-рефов — <Picture 1>) —
    // якорь внешнего вида (правка 315). Нода та же, что в режиме 'ref'
    // вкладки «Генерация» ('46:11'): латент-выход не используется, только
    // conditioning. (правка 323) Режим размера референсов — параметр
    // refImageSize ('match' НЕ апскейлит референс, дефолт 'max'). ───
    '46:4': {
      inputs: { vae_name: 'minimax_h3_audio_vae_fp32.safetensors' },
      class_type: 'VAELoader',
      _meta: { title: 'VAE (audio)' },
    },
    'r_f0': {
      inputs: {
        // (правка 376) latent-ветка: кадр берём из однокадровой загрузки
        // 'r_f0src' (mp4 целиком не грузится); mp4-ветка — из 'r_img'.
        image: latentMode ? ['r_f0src', 0] : ['r_img', 0],
        batch_index: 0,
        length: 1,
      },
      class_type: 'ImageFromBatch',
      _meta: { title: `Первый кадр → <Picture ${metaRefs.length + 1}>` },
    },
    // (правка 309, слоты — правка 315) LoadImage ноды для рефов из меты:
    // <Picture 1..k> — исходная нумерация оригинальной генерации
    ...Object.fromEntries(
      metaRefs.map((r, i) => [`r_ref_${i}`, {
        inputs: { image: r.path },
        class_type: 'LoadImage',
        _meta: { title: `Reference ${i + 1} (из меты)` },
      }]),
    ),
    '46:11r': {
      inputs: {
        prompt,
        width: final.genW,
        height: final.genH,
        // (правка 376) latent-ветка: длина от сервера (кадры mp4 уже на
        // сетке 17k+5 — совпадает с T загруженного латента); mp4-ветка —
        // из графа ('r_cap').
        length: latentMode ? framesGrid : ['r_cap', 1],
        ref_image_size: p.refImageSize ?? 'max', // (правка 323)
        clip: ['46:15', 0],
        vae: ['46:3', 0],
        audio_vae: ['46:4', 0],
        // (правка 315) Мета-рефы первыми (ref_image_0..k-1 = <Picture 1..k>),
        // первый кадр — последним (ref_image_k = <Picture k+1>).
        // (правка 587) В латент-цепи якорь первого кадра НЕ включается
        // (тест: убрать влияние на мягкость/резкость refine-результата).
        ...Object.fromEntries(
          metaRefs.map((_, i) => [`ref_images.ref_image_${i}`, [`r_ref_${i}`, 0]]),
        ),
        ...(!latentMode && { [`ref_images.ref_image_${metaRefs.length}`]: ['r_f0', 0] }),
      },
      class_type: 'MiniMaxH3ReferenceToVideo',
      _meta: { title: latentMode
        ? `Conditioning (${metaRefs.length} мета-рефов, без якоря кадра)`
        : `Conditioning (${1 + metaRefs.length} рефов: меты + кадр)` },
    },

    // ═══════════════════════════════════════════════
    //  SAMPLER (RandomNoise, euler, ManualSigmas = Pass 2)
    // ═══════════════════════════════════════════════
    '46:31': {
      inputs: { noise_seed: seed },
      class_type: 'RandomNoise',
      _meta: { title: 'Случайный шум' },
    },
    '46:18': {
      inputs: { sampler_name: light ? 'res_multistep' : 'euler' },
      class_type: 'KSamplerSelect',
      _meta: { title: `KSampler (${light ? 'res_multistep' : 'euler'})` },
    },
    '46:33': light
      ? {
          inputs: { scheduler: 'simple', steps: 2, denoise: 0.2, model: ['46:37', 0] },
          class_type: 'BasicScheduler',
          _meta: { title: 'Лёгкий проход: 2 шага, denoise 0.2' },
        }
      : {
          inputs: { sigmas: ladder },
          class_type: 'ManualSigmas',
          _meta: { title: `Pass 2 Sigmas (${ladder.split(',').length - 1} шагов)` },
        },
    '12': {
      inputs: {
        model: ['46:37', 0],
        vae: ['46:3', 0],
        tiny_vae: 'taeh3.safetensors',
        max_resolution: 1024,
        jpeg_quality: 80,
        suppress_default_preview: true,
        // Как на вкладке «Генерация» ('46:19'): превью покрывает всё видео
        // (кадры по сетке 17k+5; (правка 376) в latent-ветке — от сервера),
        // playback 6 fps.
        preview_frames: latentMode ? framesGrid : ['r_cap', 1],
        preview_fps: 6,
      },
      class_type: 'ModelPreviewOverrideKJ',
      _meta: { title: 'Model Preview Override' },
    },
    '46:29': {
      inputs: { model: ['12', 0], conditioning: [condNodeId, 0] },
      class_type: 'BasicGuider',
      _meta: { title: 'Guider' },
    },
    '46:21': {
      inputs: {
        noise: ['46:31', 0],
        guider: ['46:29', 0],
        sampler: ['46:18', 0],
        sigmas: ['46:33', 0],
        // (правка 376) Затравка: latent-ветка без апскейлера ('same') — сам
        // загруженный AV-латент ('r_lat'); с апскейлером — 'r_cat' (апскейл
        // видео-части + родное аудио). mp4-ветка — 'r_cat', как раньше.
        latent_image: latentMode
          ? (needsUpscale ? ['r_cat', 0] : ['r_lat', 0])
          : ['r_cat', 0],
      },
      class_type: 'SamplerCustomAdvanced',
      _meta: { title: 'Refine Sampler (Pass 2)' },
    },

    // (правка 471) Сохраняем AV-латент результата — повторный рефайн и
    // тайловый апскейл этого видео стартует с первозданного латента
    // (lossless), как у обычной генерации ('46:49'). Финализация меты
    // подхватит .latent из outputs и запишет latent_file в сайдкар.
    // В legacy chunkJob (покусочные refinepart) латент — лишь окно,
    // не сохраняем.
    ...(!p.chunkJob && {
      'r_savelat': {
        inputs: {
          samples: ['46:21', 0],
          filename_prefix: `${sub}latents/Minimax_Studio_refine`,
          vae_name: 'minimax_h3_video_vae_int8_convrot.safetensors',
        },
        class_type: 'MiniMaxStudioSaveAVLatent',
        _meta: { title: 'Save AV Latent (для lossless-рефайна)' },
      },
    }),

    // ═══════════════════════════════════════════════
    //  DECODE (только видео) + ТОЧНЫЙ КРОП
    // ═══════════════════════════════════════════════
    '46:35': {
      inputs: { av_latent: ['46:21', 0] },
      class_type: 'LTXVSeparateAVLatent',
      _meta: { title: 'Separate AV Latent' },
    },
    '46:25': {
      inputs: { samples: ['46:35', 0], vae: ['46:3', 0] },
      class_type: 'VAEDecode',
      _meta: { title: 'Decode Video' },
    },
    // (правка 313) Декод аудио-латента сэмплера — как '46:14' во 2-м
    // проходе генерации (minimax-h3-template.ts).
    'r_adec': {
      inputs: { samples: ['46:35', 1], vae: ['46:4', 0] },
      class_type: 'VAEDecodeAudio',
      _meta: { title: 'Decode Audio (правка 313)' },
    },
    ...(needsCrop && {
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

    // ═══════════════════════════════════════════════
    //  OUTPUT: видео + звук. (правка 313) В целом режиме звук =
    //  перегенерированный сэмплером (r_adec), как во 2-м проходе
    //  генерации. В legacy-пути chunkJob звук кладёт сшивка из
    //  оригинала (у таких кусков аудио не генерится).
    // ═══════════════════════════════════════════════
    '45': {
      inputs: {
        frame_rate: 24,
        loop_count: 0,
        filename_prefix: `${sub}${p.chunkJob ? 'Minimax_Studio_refinepart' : 'Minimax_Studio_refine'}`,
        // (правка 386) формат/качество — из [video] настроек студии
        ...vhsEnc,
        save_metadata: false,
        pingpong: false,
        save_output: true,
        images: needsCrop ? ['46:48', 0] : ['46:25', 0],
        // (правка 313) перегенерированный звук вместо дорожки исходника.
        // (правка 492) keepOriginalAudio — мукс ОРИГИНАЛЬНОЙ дорожки: mp4-путь
        // — 'r_asafe' (VHS_LoadVideo грузит исходник целиком, frame_load_cap=0
        // — дорожка не режется; у беззвучного — тишина), latent-путь — декод
        // родного аудио-латента ('r_aorig').
        ...(p.chunkJob
          ? {}
          : { audio: p.keepOriginalAudio ? [latentMode ? 'r_aorig' : 'r_asafe', 0] : ['r_adec', 0] }),
      },
      class_type: 'VHS_VideoCombine',
      _meta: { title: p.chunkJob ? 'Video Combine (кусок)' : 'Video Combine (refine)' },
    },
  }
}

/* ═══════════════════════════════════════════════════════════
 *  Режим «Частями» v2 (правка 253) — латент-маскирующая цепочка.
 *
 *  Один воркфлоу на всё видео (как продление правки 252): кусок 0 —
 *  обычный v2v-рефайн окна [0, T); кусок k>0 = [preserved-хвост выхода
 *  сэмплера k−1 (O кадров, маска 0)] ⊕ [кодированное окно исходника
 *  без первых O кадров (маска 1)]. Стык живёт ВНУТРИ одного латента —
 *  пиксельной склейки между кусками нет, файлы кусков соединяются
 *  жёсткой конкатенацией; звук — из целого оригинала (сшивка).
 *
 *  Геометрия: O = 39 (сетка 17k+5, 12 токенов); окно T = сетка около
 *  chunkSeconds×24; новое содержимое куска = T − O кадров (у куска 0 — T).
 *  Токены: tok(F) = ((F−5)/17)·5+2; аудио-шаги = round(F·5/3).
 *
 *  (правка 314) Латентная склейка + сегментный декод — ОДИН файл на выходе.
 *  Раньше каждое окно декодировалось в свой refinepart_<k> (h264), а клиент
 *  склеивал их ffmpeg'ом с ПОВТОРНЫМ кодированием — двойной lossy-проход.
 *  Теперь: выходы сэмплеров css_k склеиваются LatentConcat'ом по времени
 *  (голова окна k>0 срезается по фактическому перекрытию overlap_k токенов —
 *  швы непрерывны благодаря латент-цепочке), полный латент режется на
 *  сегменты по SEG_DECODE_TOK токенов (экономия VRAM), каждый декодируется
 *  своим VAEDecode, кадры склеиваются ImageBatchMulti, и ОДИН
 *  VHS_VideoCombine кодирует h264 один раз. Аудио зеркально: склейка
 *  аудио-латентов → один VAEDecodeAudio → звук в тот же combine.
 *  ffmpeg-стейдж (/api/comfy/refine/stitch) новым воркфлоу не вызывается.
 */
export interface ChunkedRefineParams {
  sourceVideo: string
  /** (правка 382) Путь к сохранённому AV-латенту исходника (относительно
   *  output/, поле latent_file меты; роут валидировал и передал
   *  sourceWidth/sourceHeight = канву ЛАТЕНТА). Окна режутся ТОКЕНАМИ из
   *  загруженного латента (LatentCut) вместо пиксельных срезов + VAEEncode:
   *  без h264-декода и повторного кодирования. Аудио окна — срезы
   *  аудио-латента генерации (dim 'x'). mp4 грузится одним кадром
   *  (якорь conditioning). Токен-границы латента считаются ТОЧНО по
   *  позиционному паттерну VAE (правка 468); off-grid skip (back-ветка
   *  плана) округляется вниз на ≤17 кадров — срезы аудио и стыковочная
   *  арифметика считаются от тех же эффективных границ. */
  sourceLatent?: string
  sourceWidth: number
  sourceHeight: number
  /** Всего кадров исходника (ffprobe, 24 fps) — план окон; в latent-ветке
   *  (правка 382) ещё и число токенов полного латента. */
  sourceFrames: number
  targetShortSide: 'same' | 'x2' | number
  /** Желаемая длина окна куска в секундах (3 | 5 | 8, default 5). */
  chunkSeconds?: number
  /** Caption — подаётся ТОЛЬКО окну 0 (первый промпт цепочки, описывает
   *  начало видео); окна 1+ получают лишь якорные подписи референсов,
   *  без сюжетного текста — чтобы описания поздних сцен не путали модель.
   *  Теги <Picture N> из меты сохраняются
   *  sanitizeDraftPrompt (правка 310) и валидны благодаря правке 315:
   *  <Picture 1..k> = рефы из меты (исходный порядок), <Picture k+1> =
   *  первый кадр видео. */
  prompt?: string
  seed?: number
  steps?: number
  /** σ_start лестницы (0.1–0.95): «сколько шума убирать». undefined = эталон. */
  sigmaStart?: number
  diffusionModel?: string
  outputSubfolder?: string
  lowVramAttention?: boolean
  chunkFeedForward?: boolean
  sparseAttention?: boolean
  // (правка 466) Sol-Attn: настройки ноды (см. MiniMaxH3Params)
  sparseTau?: number
  sparseStartPercent?: number
  sparseEndPercent?: number
  sparseMinTokens?: number
  sparseExtraTokens?: number
  vedaAttention?: boolean // (правка 301)
  // (правка 399) Veda: настройки ноды (см. MiniMaxH3Params)
  vedaGeneratedSparsity?: string
  vedaReferenceSparsity?: string
  vedaFullAttentionLayers?: string
  vedaFullAttentionSteps?: string
  vedaVerbose?: boolean
  /** (правка 305, тип — правка 311) Картинки-референсы из меты исходника
   *  (ComfyUI input/ filenames + роль imageIntent, может быть '').
   *  (правка 315) Подаются как <Picture 1..k> (исходный порядок оригинальной
   *  генерации) на всех окнах, первый кадр — <Picture k+1>. */
  refImages?: Array<{ path: string; role: string }>
  /** (правка 323) Режим размера референсов (ref_image_size), как в
   *  RefineParams: 'match' (дешевле) | 'max' (точнее). Дефолт 'max'. */
  refImageSize?: 'match' | 'max'
  /** (правка 386) Формат/качество видео-выхода ([video] config.ini). */
  videoFormat?: VideoFormatSettings
  /** (правка 483) Пользовательские LoRA из настроек — цепочкой после
   *  турбо-лоры ('46:36'), как в buildRefineWorkflow. */
  customLoras?: Array<{ name: string; strength: number }>
  /** (правка 483) Суффикс промпта (триггеры LoRA) — дописывается в промпт
   *  КАЖДОГО окна цепочки (и сюжетный окна 0, и якорные окон 1+), иначе
   *  поздние окна рефинились бы без стиля LoRA. В мету не попадает. */
  promptSuffix?: string
  /** (правка 492) Оригинальный звук вместо перегенерированного: на финальный
   *  combine муксится дорожка исходника (mp4 — 'r_src' pin 2 через
   *  MiniMaxH3AudioOrSilent; latent — декод аудио-латента 'r_lsep'). */
  keepOriginalAudio?: boolean
}

/** Перекрытие цепочки (сетка 17k+5): preserved-голова куска k>0. */
export const CHAIN_OVERLAP = 39

/**
 * (правка 255) Сэмплер-узлы по стадиям для прогресс-трекера:
 * «Частями» → cs_0…cs_{n−1} по окнам плана (те же planChunkWindows-
 * параметры, что у билдера; окно всегда одноимённое, даже если оно одно).
 */
export function refineChunkStages(sourceFrames: number, chunkSeconds?: number): string[][] {
  const windows = planChunkWindows(sourceFrames, chunkSeconds ?? 5)
  return windows.map((_, k) => [`cs_${k}`])
}

const snapUpGrid = (n: number) => {
  let x = Math.max(5, Math.round(n))
  while ((x - 5) % 17 !== 0) x += 1
  return x
}
const alignDownG = (n: number) => (n < 5 ? Math.max(1, n) : 5 + 17 * Math.floor((n - 5) / 17))
const tokOf = (frames: number) => Math.round(((frames - 5) / 17) * 5 + 2)

/** План окон: [{skip, cap}] — все cap на сетке; покрытие до N−16 максимум. */
export function planChunkWindows(
  totalFrames: number,
  chunkSeconds: number,
): Array<{ skip: number; cap: number }> {
  const target = Math.max(3, Math.min(15, chunkSeconds)) * 24
  const T = snapUpGrid(target)
  if (totalFrames <= T + 56) return [{ skip: 0, cap: alignDownG(totalFrames) }]
  const windows: Array<{ skip: number; cap: number }> = []
  let s = 0
  while (true) {
    const remaining = totalFrames - s
    if (remaining <= T + 56) {
      const cap = alignDownG(remaining)
      if (cap < 22) {
        const back = Math.max(0, totalFrames - T)
        windows.push({ skip: back, cap: Math.min(T, alignDownG(totalFrames - back)) })
      } else {
        windows.push({ skip: s, cap })
      }
      break
    }
    windows.push({ skip: s, cap: T })
    s += T - CHAIN_OVERLAP
  }
  return windows
}

export function buildChunkedRefineWorkflow(p: ChunkedRefineParams): Record<string, unknown> {
  const seed = !p.seed || p.seed < 0 ? Math.floor(Math.random() * 2 ** 31) : p.seed
  const vhsEnc = vhsEncodeInputs(p.videoFormat) // (правка 386)
  // (правка 272) SIGMA_LADDERS (σ_start 0.9035) — как в D-версии (рабочая).
  // Latent-цепочка + хвост предыдущего рендера обеспечивает непрерывность;
  // высокий σ даёт модели свободу для детализации.
  const light = p.steps === 2
  const ladder = refineSigmaLadder(p.steps ?? 3, p.sigmaStart)
  const basePrompt = (p.prompt ?? '').trim() || DEFAULT_REFINE_PROMPT
  // (правка 315, заменяет раскладку правки 305) Якорь идентичности на ВСЕХ
  // окнах: слоты сохраняют нумерацию оригинальной генерации — мета-рефы
  // ПЕРВЫМИ (ref_image_0..k-1 → <Picture 1..k>, порядок массива = порядок
  // references оригинальной генерации, см. комментарий в buildRefineWorkflow),
  // ПЕРВЫЙ КАДР видео — последним (<Picture k+1>; без мета-рефов —
  // <Picture 1>). Conditioning каждого окна строит MiniMaxH3ReferenceToVideo
  // (та же нода, что режим 'ref' вкладки «Генерация» и refine «Целиком»).
  // Без якоря модель при σ_start 0.9035 вспоминала персонажа только по тексту
  // и «переигрывала» его от куска к куску. Теги <Picture N> из промпта меты
  // сохранены sanitizeDraftPrompt (правка 310) и указывают на те же
  // изображения, что в оригинале; подписи слотов добавляем здесь (правка 316).
  const metaRefs = (p.refImages ?? []).slice(0, 8) // max 8 внешних + 1 первый кадр = 9 всего
  const captions =
    (metaRefs.length > 0
      ? metaRefs.map((r, i) => metaRefCaption(i + 1, r.role)).join(' ') + '\n\n'
      : '') + firstFrameCaption(metaRefs.length + 1)
  // (правка 483) Триггерные слова пользовательских LoRA — суффикс промптов окон
  const pSuffix = p.promptSuffix?.trim() ? ` ${p.promptSuffix!.trim()}` : ''
  const promptFirst = basePrompt + `\n\n` + captions + pSuffix
  // Сюжетный промпт — только окну 0 (оно покрывает начало видео, которое
  // первый промпт цепочки и описывает). Окна 1+ получают ТОЛЬКО якорные
  // подписи референсов: промпт цепочки описывает сцены, которых в этих
  // окнах нет, и путал модель несоответствиями. Латент-затравка + якорь
  // первого кадра удерживают контент без текстового гида.
  // (правка 483) Триггеры LoRA (pSuffix) — на ВСЕХ окнах, иначе окна 1+
  // рефинились бы без стиля активной LoRA.
  const promptRest = captions + pSuffix
  const windows = planChunkWindows(p.sourceFrames, p.chunkSeconds ?? 5)
  const sub = p.outputSubfolder ? `${p.outputSubfolder}/` : ''

  const final = refineDimensions(p.sourceWidth, p.sourceHeight, p.targetShortSide)
  const needsCrop = final.genW !== final.outW || final.genH !== final.outH
  const ceil32 = (n: number) => Math.max(32, Math.ceil(n / 32) * 32)
  // Апскейлер только увеличивает (scale >= 1.0): при цели меньше исходника
  // кодируем окна сразу в сетке цели, апскейлер не подключается.
  const downscale = final.genW < ceil32(p.sourceWidth) || final.genH < ceil32(p.sourceHeight)
  const encW = downscale ? final.genW : ceil32(p.sourceWidth)
  const encH = downscale ? final.genH : ceil32(p.sourceHeight)
  const needsUpscale = final.genW !== encW || final.genH !== encH
  const lw = Math.max(1, Math.round(final.genW / 16))
  const lh = Math.max(1, Math.round(final.genH / 16))
  /**
   * (правка 263) Длина сохранённой ГОЛОВЫ окна в токенах.
   *
   * До 263: oTok = tokOf(CHAIN_OVERLAP) = 12 токенов — фиксированное число,
   * а срез декодированного выхода делался по CHAIN_OVERLAP = 39 КАДРОВ.
   * Эти величины не связаны: 12 токенов ≈ 39 кадров (по framesFromTok), но
   * т.к. sTok = tokOf(40) = 12 и tTok − sTok = 24−12 = 12, новый контент
   * = 12 токенов = 39 кадров, а не ожидаемые 40. При T=124: sTok = 26,
   * новый = 37−26 = 11 токенов = 36 кадров, а не 85.
   *
   * Теперь: oTok = tokOf(CHAIN_OVERLAP) (голова = CHAIN_OVERLAP кадров),
   * новый контент = tTok − oTok токенов (весь остальной window), срез декода
   * = framesFromTok(oTok) кадров. Кодированное окно НЕ режется — маска
   * чёрная на голове, белая на новом. Сэмплер рефинит всё окно, голова
   * остаётся как есть (контекст), новый контент — рефинится.
   * Никаких дублей на стыке.
   */
  const oTok = Math.max(1, tokOf(CHAIN_OVERLAP))

  /**
   * (правка 314) Позиционный паттерн кадров H3 video-VAE:
   * FRAME_PER_TOKEN = (1, 4, 4, 4, 4) (comfy.ldm.minimax.model, см.
   * MMH3_Split_Upscale в Comfyui_Minimax_h3_latent_Upscaler): токен k
   * покрывает FPT[k%5] кадров, 5 токенов = 17 кадров. Все границы срезов/
   * сегментов ниже кратны 5 токенам от начала латента → кадры сегментов
   * суммируются ТОЧНО (без дрейфа длительности).
   */
  const FPT = [1, 4, 4, 4, 4]
  const framesForTok = (t: number) => {
    let s = 0
    for (let i = 0; i < t; i++) s += FPT[i % 5]
    return s
  }
  /** (правка 468) Наименьшее число токенов, покрывающее f кадров. */
  const tokCover = (f: number) => {
    let t = 0
    while (framesForTok(t) < f) t++
    return t
  }
  /** Наибольшее число токенов головы, покрывающее НЕ БОЛЕЕ f кадров
   *  (консервативно: лучше ≤3 дублирующих кадра preserved-головы — это
   *  бит-в-бит контент хвоста предыдущего рендера, — чем дыра в новых). */
  const tokHeadAtMost = (f: number) => {
    let t = 0
    while (framesForTok(t + 1) <= f) t++
    return Math.max(1, t)
  }
  /** (правка 314) Размер сегмента сегментного декода, токенов (кратно 5).
   *  25 токенов ≈ 85 кадров: раньше покусочно декодировались окна до
   *  tokOf(T)=37 токенов (chunkSeconds=5 → T=124) — работало; 25 консервативно
   *  ниже, а кратность 5 держит позиционный паттерн FPT (см. выше): каждый
   *  сегмент начинается с k%5==0, кадры суммируются без дрейфа. */
  const SEG_DECODE_TOK = 25

  // ─── (правка 382) Lossless-ветка: окна из сохранённого латента ───
  const latentMode = !!p.sourceLatent
  // (правка 468) Токены полного латента — точно по FPT: tokOf — линейная
  // аппроксимация, на несеточных длинах ошибается на ±1 токен.
  const totalTok = Math.max(1, tokCover(Math.max(5, p.sourceFrames ?? 0)))
  /** Токен-индекс начала окна — ТОЧНЫЙ перебор по FPT (правка 468).
   *  tokOf(skip) — аппроксимация: плановые skip 85/170/… (шаг T−39) не на
   *  сетке 17k+5, и tokOf(85) давал 26 вместо точных 25 — окно стартовало
   *  на кадр позже, а его токены вставали в финальный латент со сдвигом
   *  фазы позиционного паттерна VAE (1,4,4,4,4) → мерцание окон 1+ в
   *  latent-ветке (в mp4-ветке срезы пиксельные, сдвига фазы нет — потому
   *  там чисто). Берём наибольший t с framesForTok(t) ≤ skip (off-grid skip
   *  округляется ВНИЗ — overlap только растёт, дыр не бывает). */
  const tokOfSkip = (skip: number) =>
    skip <= 0 ? 0 : Math.min(tokHeadAtMost(skip), Math.max(0, totalTok - 1))
  /** Геометрия окна k: эффективные (фактические) кадры старта/длины, число
   *  токенов и аудио-шагов. mp4-путь: effSkip/effCap = план (точные кадры);
   *  latent-путь: выравнивание по токен-границам полного латента. */
  const winGeo = windows.map((w) => {
    if (!latentMode) {
      return {
        effSkip: w.skip,
        effCap: w.cap,
        tTok: tokOf(w.cap),
        aTotal: Math.round((w.cap * 5) / 3),
        sTok: 0,
        aStart: 0,
      }
    }
    const sTok = tokOfSkip(w.skip)
    const tTok = Math.max(1, Math.min(tokOf(w.cap), totalTok - sTok))
    const effSkip = framesForTok(sTok)
    const effCap = framesForTok(tTok)
    return {
      effSkip,
      effCap,
      tTok,
      aTotal: Math.round((effCap * 5) / 3),
      sTok,
      aStart: Math.round((effSkip * 5) / 3),
    }
  })

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
      inputs: { chunks: 2, seq_threshold: 4096, model: modelSrc },
      class_type: 'MiniMaxChunkFeedForward',
      _meta: { title: 'Chunk FeedForward' },
    }
    modelSrc = ['46:40', 0]
  }

  return {
    '46:30': {
      inputs: {
        unet_name:
          p.diffusionModel || 'minimax_h3_fastvideo_vsa_datafree_1300step_4step_int8_convrot.safetensors', // (правка 293)
        weight_dtype: 'default',
      },
      class_type: 'UNETLoader',
      _meta: { title: 'Загрузить модель диффузии' },
    },
    '46:15': {
      inputs: { clip_name: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', type: 'minimax', device: 'default' },
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
    ...modelNodes,
    // (правка 578) Турбо-лора убрана — кастомные LoRA подключаются прямо к modelSrc
    ...buildCustomLoraNodes(p.customLoras, modelSrc),
    '46:38': {
      inputs: { shift_video: 12, shift_audio: 3, model: getLastLoraOutput(p.customLoras, modelSrc) },
      class_type: 'MiniMaxH3SigmaShift',
      _meta: { title: 'Sigma Shift' },
    },
    // (правка 301) Veda или Sol-Attn — pass 2
    ...(p.vedaAttention ? {
      '46:44': {
        inputs: { model: ['46:38', 0], predictor: 'minimax_h3_t2va_veda_8nfe_600step_preview_fp8.safetensors', generated_sparsity: clampVedaSparsity(p.vedaGeneratedSparsity, 90), reference_sparsity: clampVedaSparsity(p.vedaReferenceSparsity, 90), full_attention_layers: sanitizeVedaIndexList(p.vedaFullAttentionLayers), full_attention_steps: sanitizeVedaIndexList(p.vedaFullAttentionSteps), verbose: p.vedaVerbose === true }, // (правка 399) параметры из настроек
        class_type: 'VedaSparseAttention',
        _meta: { title: 'Veda Sparse Attention' },
      },
    } : p.sparseAttention === true ? { // (правка 387) Sol-Attn по умолчанию OFF
      '46:44': {
        inputs: { model: ['46:38', 0], tau: p.sparseTau ?? 1.3, start_percent: p.sparseStartPercent ?? 0.2, end_percent: p.sparseEndPercent ?? 1.0, min_tokens: p.sparseMinTokens ?? 12288, extra_tokens: p.sparseExtraTokens ?? 256 }, // (правка 466) параметры из настроек
        class_type: 'MiniMaxSparseAttention',
        _meta: { title: 'Sparse Attention (Sol-Attn)' },
      },
    } : {}),
    '46:37': {
      inputs: { attention: 'comfy kitchen attention', model: (p.vedaAttention || p.sparseAttention === true) ? ['46:44', 0] : ['46:38', 0] },
      class_type: 'ModelAttentionBackend',
      _meta: { title: 'Attention Backend' },
    },
    '46:18': {
      inputs: { sampler_name: light ? 'res_multistep' : 'euler' },
      class_type: 'KSamplerSelect',
      _meta: { title: `KSampler (${light ? 'res_multistep' : 'euler'})` },
    },
    '46:33': light
      ? {
          inputs: { scheduler: 'simple', steps: 2, denoise: 0.2, model: ['46:37', 0] },
          class_type: 'BasicScheduler',
          _meta: { title: 'Лёгкий проход: 2 шага, denoise 0.2' },
        }
      : {
          inputs: { sigmas: ladder },
          class_type: 'ManualSigmas',
          _meta: { title: `Pass 2 Sigmas (${ladder.split(',').length - 1} шагов)` },
        },
    '12': {
      inputs: {
        model: ['46:37', 0],
        vae: ['46:3', 0],
        tiny_vae: 'taeh3.safetensors',
        max_resolution: 1024,
        jpeg_quality: 80,
        suppress_default_preview: true,
        // Как на вкладке «Генерация»: превью покрывает весь кусок (у более
        // коротких окон лишний лимит безвреден — сабсэмплинга нет), 6 fps.
        // (правка 382) latent-ветка: от эффективных длин окон.
        preview_frames: Math.max(...winGeo.map((g) => g.effCap)),
        preview_fps: 6,
      },
      class_type: 'ModelPreviewOverrideKJ',
      _meta: { title: 'Model Preview Override' },
    },
    // ─── (правка 315, заменяет раскладку правки 305) Якорь идентичности:
    // мета-рефы (<Picture 1..k>, исходная нумерация оригинальной генерации) +
    // первый кадр ПОСЛЕДНИМ (<Picture k+1>; без меты — <Picture 1>) —
    // общие на все окна. Conditioning строится per-window нодой
    // MiniMaxH3ReferenceToVideo (в цикле ниже): length у окон различается
    // (последнее окно короче). ───
    'r_f0c': {
      inputs: { image: [latentMode ? 'r_f0src' : 'r_src', 0], batch_index: 0, length: 1 },
      class_type: 'ImageFromBatch',
      _meta: { title: `Первый кадр → <Picture ${metaRefs.length + 1}>` },
    },
    ...Object.fromEntries(
      metaRefs.map((r, i) => [`c_ref_${i}`, {
        inputs: { image: r.path },
        class_type: 'LoadImage',
        _meta: { title: `Reference ${i + 1} (из меты)` },
      }]),
    ),

    // ─── Источник (один загрузчик на все окна) ───
    // (правка 382) latent-ветка: первозданный AV-латент + разделение на
    // видео/аудио потоки; mp4 грузится ОДНИМ кадром для якоря conditioning.
    // Окна режутся в цикле ниже (LatentCut по токенам/аудио-шагам).
    ...(latentMode ? {
      'r_lat': {
        inputs: { latent: p.sourceLatent },
        class_type: 'MiniMaxStudioLoadAVLatent',
        _meta: { title: 'AV-латент исходника (lossless, правка 382)' },
      },
      'r_lsep': {
        inputs: { av_latent: ['r_lat', 0] },
        class_type: 'LTXVSeparateAVLatent',
        _meta: { title: 'Separate AV Latent (загруженный)' },
      },
      'r_f0src': {
        inputs: {
          video: p.sourceVideo,
          force_rate: 24,
          custom_width: 0,
          custom_height: 0,
          frame_load_cap: 1,
          skip_first_frames: 0,
          select_every_nth: 1,
        },
        class_type: 'VHS_LoadVideo',
        _meta: { title: 'Исходник: первый кадр (якорь conditioning)' },
      },
    } : {
      'r_src': {
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
    }),

    // ─── Цепочка кусков ───
    ...(() => {
      const nodes: Record<string, unknown> = {}
      windows.forEach((w, k) => {
        const chained = k > 0
        const geo = winGeo[k]
        const { tTok, aTotal, effSkip, effCap } = geo
        // (правка 313) Аудио-эквивалент оверлапа в латентном времени аудио:
        // аудио-латент идёт с шагом 5/3 от видео-кадров (та же формула,
        // что в EmptyMiniMaxH3LatentAV). = 65 для CHAIN_OVERLAP = 39.
        const aOver = chained ? Math.round((CHAIN_OVERLAP * 5) / 3) : 0

        // Видео-латент окна (правка 382 — два пути):
        //  • mp4: пиксельный срез [skip, skip+cap) → resize → VAEEncode;
        //  • latent: срез полного латента ГЕНЕРАЦИИ по токенам
        //    [sTok, sTok+tTok) — без h264-декода и кодирований.
        // Дальше оба пути едины: [апскейл до gen-канвы] → латент окна.
        let encLatent: [string, number]
        if (latentMode) {
          // (правка 395) sTok/tTok при длинном источнике (>~39 мин видео)
          // превышают MAX_RESOLUTION=16384 — дробим chainLatentCut'ом.
          encLatent = chainLatentCut(
            nodes, `cl_${k}`,
            ['r_lsep', 0],
            't', geo.sTok, tTok,
            `Окно ${k + 1}: токены [${geo.sTok}, ${geo.sTok + tTok}) ≈ кадры [${effSkip}, ${effSkip + effCap})`,
          )
        } else {
          nodes[`cw_${k}`] = {
            inputs: { image: ['r_src', 0], batch_index: w.skip, length: w.cap },
            class_type: 'ImageFromBatch',
            _meta: { title: `Окно ${k + 1}: [${w.skip}, ${w.skip + w.cap})` },
          }
          nodes[`cr_${k}`] = {
            inputs: {
              image: [`cw_${k}`, 0],
              width: encW,
              height: encH,
              upscale_method: 'lanczos',
              keep_proportion: 'stretch',
              pad_color: '0, 0, 0',
              crop_position: 'center',
              divisible_by: 16,
              device: 'cpu',
            },
            class_type: 'ImageResizeKJv2',
            _meta: { title: `Окно ${k + 1} → ${encW}×${encH}` },
          }
          nodes[`ce_${k}`] = {
            inputs: { pixels: [`cr_${k}`, 0], vae: ['46:3', 0] },
            class_type: 'VAEEncode',
            _meta: { title: `VAE-кодирование окна ${k + 1}` },
          }
          encLatent = [`ce_${k}`, 0]
        }
        const genLatent: [string, number] = needsUpscale
          ? (() => {
              nodes[`cu_${k}`] = {
                inputs: {
                  model_name: 'minimax_h3_latent_upscaler_3d_fp16.safetensors',
                  mode: 'target dimensions',
                  'mode.width': final.genW,
                  'mode.height': final.genH,
                  align: 32,
                  enable_chunking: true,
                  device: 'cuda',
                  precision: 'fp16',
                  latent: encLatent,
                },
                class_type: 'MinimaxH3LatentUpscaler3D',
                _meta: { title: `Latent Upscaler окна ${k + 1}` },
              }
              return [`cu_${k}`, 0]
            })()
          : encLatent

        // Аудио-латент окна:
        //  • mp4 (правка 313): дорожка исходника (MiniMaxH3AudioOrSilent — у
        //    беззвучного видео VHS_LoadVideo роняет VAEEncodeAudio) → срез
        //    окна в секундах → VAEEncodeAudio;
        //  • latent (правка 382): срез АУДИО-латента генерации по шагам
        //    [aStart, aStart+aTotal) — родной звук без повторного кодирования.
        let audioEnc: [string, number]
        if (latentMode) {
          // (правка 395) aStart = effSkip·5/3 при источнике >~6,8 мин
          // превышает MAX_RESOLUTION=16384 → 400 на submit; дробим.
          audioEnc = chainLatentCut(
            nodes, `cla_${k}`,
            ['r_lsep', 1],
            'x', geo.aStart, aTotal,
            `Аудио окна ${k + 1}: шаги [${geo.aStart}, ${geo.aStart + aTotal})`,
          )
        } else {
          nodes[`cask_${k}`] = {
            inputs: { audio: ['r_src', 2], fallback_seconds: Number(((w.cap / 24) + 0.5).toFixed(2)) },
            class_type: 'MiniMaxH3AudioOrSilent',
            _meta: { title: `Аудио окна ${k + 1} (или тишина)` },
          }
          nodes[`caw_${k}`] = {
            inputs: {
              audio: [`cask_${k}`, 0],
              start_seconds: Number((w.skip / 24).toFixed(4)),
            },
            class_type: 'MiniMaxH3AudioSliceFrom',
            _meta: { title: `Окно аудио ${k + 1} от ${w.skip} кадра` },
          }
          nodes[`caenc_${k}`] = {
            inputs: { audio: [`caw_${k}`, 0], vae: ['46:4', 0] },
            class_type: 'VAEEncodeAudio',
            _meta: { title: `Аудио → латент (окно ${k + 1})` },
          }
          audioEnc = [`caenc_${k}`, 0]
        }

        // Видео-латент куска (правка 272, схема D-версии — рабочая):
        // k=0: окно целиком (маска не нужна).
        // k>0: LatentCut + LatentConcat — срез головы O токенов у кодированного
        // окна + preserved-хвост предыдущего рендера (css_{k-1}). Т.е.
        // латентная цепочка: выход куска k-1 → хвост → concat с новым
        // контентом куска k. Noise mask: чёрная на хвосте (не рефинится),
        // белая на новом (рефинится). Это доказанная рабочая схема —
        // стыки непрерывны по построению (хвост куска k-1 = голова куска k),
        // жёсткая concat без скачка.
        let videoForJoin: [string, number]
        if (!chained) {
          videoForJoin = genLatent
        } else {
          // Срез головы: убрать первые oTok токенов (они = хвост предыдущего рендера)
          nodes[`cvc_${k}`] = {
            inputs: { samples: genLatent, dim: 't', index: oTok, amount: tTok - oTok },
            class_type: 'LatentCut',
            _meta: { title: `Окно без головы (${oTok} ток.)` },
          }
          // Preserved-хвост предыдущего рендера: последние oTok токенов
          nodes[`cpt_${k}`] = {
            inputs: { samples: [`css_${k - 1}`, 0], dim: 't', index: -oTok, amount: oTok },
            class_type: 'LatentCut',
            _meta: { title: `Preserved-хвост куска ${k}` },
          }
          // Concat: хвост + новый контент = полное окно
          nodes[`ccc_${k}`] = {
            inputs: { samples1: [`cpt_${k}`, 0], samples2: [`cvc_${k}`, 0], dim: 't' },
            class_type: 'LatentConcat',
            _meta: { title: `Concat окна ${k + 1} (${tTok} ток.)` },
          }
          // Noise mask: чёрная на хвосте (oTok), белая на новом (tTok−oTok)
          nodes[`cmb_${k}`] = {
            inputs: { width: lw, height: lh, batch_size: oTok, color: 0 },
            class_type: 'EmptyImage',
            _meta: { title: `Маска: чёрная ${oTok}` },
          }
          nodes[`cmw_${k}`] = {
            inputs: { width: lw, height: lh, batch_size: tTok - oTok, color: 16777215 },
            class_type: 'EmptyImage',
            _meta: { title: `Маска: белая ${tTok - oTok}` },
          }
          nodes[`cmba_${k}`] = {
            inputs: { inputcount: 2, image_1: [`cmb_${k}`, 0], image_2: [`cmw_${k}`, 0] },
            class_type: 'ImageBatchMulti',
            _meta: { title: `Маска видео ${k + 1}` },
          }
          nodes[`cmk_${k}`] = {
            inputs: { image: [`cmba_${k}`, 0], channel: 'red' },
            class_type: 'ImageToMask',
            _meta: { title: `ImageToMask ${k + 1}` },
          }
          nodes[`cms_${k}`] = {
            inputs: { samples: [`ccc_${k}`, 0], mask: [`cmk_${k}`, 0] },
            class_type: 'SetLatentNoiseMask',
            _meta: { title: `Noise mask окна ${k + 1}` },
          }
          videoForJoin = [`cms_${k}`, 0]
        }
        // (правка 313) Аудио-латент окна: новое содержимое или цепочка
        // (хвост куска k−1 ⊕ новое окно − голова), зеркало видео-цепочки.
        // (правка 382) источник — аудио окна (mp4: caenc / latent: cla).
        let audioForJoin: [string, number]
        // Обрезка до длины окна (LatentCut clamp'ится, если аудио короче;
        // срез окна идёт до конца дорожки/латента, а окно k короче — см. aTotal).
        nodes[`cane_${k}`] = {
          inputs: { samples: audioEnc, dim: 'x', index: chained ? aOver : 0, amount: chained ? aTotal - aOver : aTotal },
          class_type: 'LatentCut',
          _meta: { title: chained ? `Аудио окна без головы (${aOver})` : `Аудио окна → ${aTotal}` },
        }
        if (!chained) {
          audioForJoin = [`cane_${k}`, 0]
        } else {
          // Preserved-хвост аудио предыдущего рендера: последние aOver
          nodes[`caold_${k}`] = {
            inputs: { samples: [`css_${k - 1}`, 1], dim: 'x', index: -aOver, amount: aOver },
            class_type: 'LatentCut',
            _meta: { title: `Аудио-хвост куска ${k}` },
          }
          // Concat: хвост + новое = полное окно
          nodes[`cacc_${k}`] = {
            inputs: { samples1: [`caold_${k}`, 0], samples2: [`cane_${k}`, 0], dim: 'x' },
            class_type: 'LatentConcat',
            _meta: { title: `Аудио-цепочка окна ${k + 1}` },
          }
          // Noise mask: чёрная на хвосте (aOver), белая на новом (aTotal−aOver)
          nodes[`camb_${k}`] = {
            inputs: { value: 0, width: aTotal, height: 2 },
            class_type: 'SolidMask',
            _meta: { title: `Аудио-маска: чёрная ${aOver}` },
          }
          nodes[`camw_${k}`] = {
            inputs: { value: 1, width: aTotal - aOver, height: 2 },
            class_type: 'SolidMask',
            _meta: { title: `Аудио-маска: белая ${aTotal - aOver}` },
          }
          nodes[`camas_${k}`] = {
            inputs: { destination: [`camb_${k}`, 0], source: [`camw_${k}`, 0], x: aOver, y: 0, operation: 'add' },
            class_type: 'MaskComposite',
            _meta: { title: `Аудио-маска окна ${k + 1}` },
          }
          nodes[`caaset_${k}`] = {
            inputs: { samples: [`cacc_${k}`, 0], mask: [`camas_${k}`, 0] },
            class_type: 'SetLatentNoiseMask',
            _meta: { title: `Аудио noise mask окна ${k + 1}` },
          }
          audioForJoin = [`caaset_${k}`, 0]
        }
        nodes[`cj_${k}`] = {
          inputs: { video_latent: videoForJoin, audio_latent: audioForJoin },
          class_type: 'LTXVConcatAVLatent',
          _meta: { title: `AV-латент окна ${k + 1}` },
        }
        // Conditioning окна (правка 315): MiniMaxH3ReferenceToVideo с
        // якорем идентичности — мета-рефы (<Picture 1..k>) + первый кадр
        // ПОСЛЕДНИМ (<Picture k+1>; без меты — <Picture 1>). length = длина
        // именно этого окна (последнее короче). Латент-выход ноды не
        // используется — только conditioning.
        nodes[`ccond_${k}`] = {
          inputs: {
            // Окно 0 — сюжетный промпт (первый промпт цепочки, от роута);
            // окна 1+ — только якорные подписи референсов (см. выше).
            prompt: k === 0 ? promptFirst : promptRest,
            width: final.genW,
            height: final.genH,
            // (правка 382) длина окна: mp4 — план; latent — фактические кадры
            // токен-среза (последнее окно может быть короче из-за клампа)
            length: effCap,
            ref_image_size: p.refImageSize ?? 'max', // (правка 324) режим размера рефов, как в whole (правка 323)
            clip: ['46:15', 0],
            vae: ['46:3', 0],
            audio_vae: ['46:4', 0],
            ...Object.fromEntries(
              metaRefs.map((_, i) => [`ref_images.ref_image_${i}`, [`c_ref_${i}`, 0]]),
            ),
            // (правка 587) В латент-цепи якорь первого кадра НЕ включается
            ...(!latentMode && { [`ref_images.ref_image_${metaRefs.length}`]: ['r_f0c', 0] }),
          },
          class_type: 'MiniMaxH3ReferenceToVideo',
          _meta: { title: latentMode
            ? `Conditioning окна ${k + 1} (${metaRefs.length} мета-рефов, без якоря кадра)`
            : `Conditioning окна ${k + 1} (${1 + metaRefs.length} рефов)` },
        }
        nodes[`cg_${k}`] = {
          inputs: { model: ['12', 0], conditioning: [`ccond_${k}`, 0] },
          class_type: 'BasicGuider',
          _meta: { title: `Guider окна ${k + 1}` },
        }
        // (правка 305) Один и тот же шум на всех окнах: детали регенерируются
        // согласованно, на стыках нет смены «характера» текстуры.
        nodes[`cn_${k}`] = {
          inputs: { noise_seed: seed },
          class_type: 'RandomNoise',
          _meta: { title: `Шум окна ${k + 1}` },
        }
        nodes[`cs_${k}`] = {
          inputs: {
            noise: [`cn_${k}`, 0],
            guider: [`cg_${k}`, 0],
            sampler: ['46:18', 0],
            sigmas: ['46:33', 0],
            latent_image: [`cj_${k}`, 0],
          },
          class_type: 'SamplerCustomAdvanced',
          _meta: { title: `Сэмплер окна ${k + 1}${chained ? ' (latent masking)' : ''}` },
        }
        nodes[`css_${k}`] = {
          inputs: { av_latent: [`cs_${k}`, 0] },
          class_type: 'LTXVSeparateAVLatent',
          _meta: { title: `Separate выхода ${k + 1}` },
        }
      })

      // ─── (правка 314) Латентная склейка окон + сегментный декод ───
      // Полный видео-латент: css_0 ⊕ для k>0 LatentCut(css_k, голова =
      // cutTok_k токенов). cutTok_k — по ФАКТИЧЕСКОМУ перекрытию окна с уже
      // покрытым таймлайном: overlap_k = (effSkip_{k−1}+effCap_{k−1}) − effSkip_k.
      // Для обычных окон overlap_k = CHAIN_OVERLAP = 39 → cutTok_k = 12
      // (= oTok, ноль дублей). Для «отскока» последнего окна
      // (planChunkWindows back-ветка) и latent-сдвигов окон (правка 382:
      // off-grid skip выравнивается по токенам) перекрытие считается от
      // ЭФФЕКТИВСКИХ границ — режется оно, а не фиксированные 39 кадров.
      let fullVideo: [string, number] = [`css_0`, 0]
      let fullAudio: [string, number] = [`css_0`, 1]
      let tTokTotal = winGeo[0].tTok
      for (let k = 1; k < windows.length; k++) {
        const g = winGeo[k]
        const prevG = winGeo[k - 1]
        const overlap = Math.max(CHAIN_OVERLAP, prevG.effSkip + prevG.effCap - g.effSkip)
        const cutTok = tokHeadAtMost(overlap)
        const tTok = g.tTok
        const aTotal = g.aTotal
        // Аудио-эквивалент перекрытия (та же формула, что aOver правки 313)
        const aCut = Math.round((overlap * 5) / 3)
        nodes[`cfj_${k}`] = {
          inputs: { samples: [`css_${k}`, 0], dim: 't', index: cutTok, amount: tTok - cutTok },
          class_type: 'LatentCut',
          _meta: { title: `Выход окна ${k + 1} без головы (${cutTok} ток. ≈ ${overlap} кадр.)` },
        }
        nodes[`cfull_${k}`] = {
          inputs: { samples1: fullVideo, samples2: [`cfj_${k}`, 0], dim: 't' },
          class_type: 'LatentConcat',
          _meta: { title: `Полный латент после окна ${k + 1}` },
        }
        fullVideo = [`cfull_${k}`, 0]
        tTokTotal += tTok - cutTok
        nodes[`caf_${k}`] = {
          inputs: { samples: [`css_${k}`, 1], dim: 'x', index: aCut, amount: aTotal - aCut },
          class_type: 'LatentCut',
          _meta: { title: `Аудио окна ${k + 1} без головы (${aCut} шаг.)` },
        }
        nodes[`cafl_${k}`] = {
          inputs: { samples1: fullAudio, samples2: [`caf_${k}`, 0], dim: 'x' },
          class_type: 'LatentConcat',
          _meta: { title: `Полный аудио-латент после окна ${k + 1}` },
        }
        fullAudio = [`cafl_${k}`, 0]
      }

      // (правка 471) Сохраняем полный сшитый AV-латент результата —
      // повторный рефайн/апскейл стартует с него lossless (как '46:49'
      // генерации). Финализация меты подхватит .latent из outputs.
      nodes['cfullav'] = {
        inputs: { video_latent: fullVideo, audio_latent: fullAudio },
        class_type: 'LTXVConcatAVLatent',
        _meta: { title: 'Полный AV-латент (для сохранения)' },
      }
      nodes['csavelat'] = {
        inputs: {
          samples: ['cfullav', 0],
          filename_prefix: `${sub}latents/Minimax_Studio_refine`,
          vae_name: 'minimax_h3_video_vae_int8_convrot.safetensors',
        },
        class_type: 'MiniMaxStudioSaveAVLatent',
        _meta: { title: 'Save AV Latent (для lossless-рефайна)' },
      }

      // Сегментный декод: полный латент режется на сегменты по SEG_DECODE_TOK
      // токенов (VRAM: пик декода ограничен сегментом, а не всем роликом),
      // каждый декодируется своим VAEDecode, кадры склеиваются по порядку
      // одним ImageBatchMulti (KJNodes — уже используется выше для масок).
      // (правка 412) ПЕРЕКРЫТИЕ 5 токенов (=17 кадров, границы кратны 5 —
      // паттерн FPT сохраняется): temporal VAE нелокален на краях, декод
      // сегментов «встык» давал разрыв картинки на каждой границе (~85
      // кадров) — «куски не склеиваются». Сегмент i>0 захватывает хвост
      // предыдущего, дублирующиеся 17 кадров после декода отбрасываются.
      const OVL_TOK = 5
      const OVL_FRAMES = framesForTok(OVL_TOK) // 17
      const segCount = Math.max(1, Math.ceil(tTokTotal / SEG_DECODE_TOK))
      const segDec: string[] = []
      for (let i = 0; i < segCount; i++) {
        const index = i > 0 ? i * SEG_DECODE_TOK - OVL_TOK : 0
        const amount = Math.min(SEG_DECODE_TOK + (i > 0 ? OVL_TOK : 0), tTokTotal - index)
        // (правка 395) index при ролике >~39 мин > MAX_RESOLUTION — дробим.
        const segRef = chainLatentCut(
          nodes, `cds_${i}`,
          fullVideo,
          't', index, amount,
          `Сегмент декода ${i + 1}/${segCount} (${amount} ток.)`,
        )
        nodes[`cdd_${i}`] = {
          inputs: { samples: segRef, vae: ['46:3', 0] },
          class_type: 'VAEDecode',
          _meta: { title: `Decode сегмента ${i + 1}/${segCount}` },
        }
        if (i > 0) {
          nodes[`cdt_${i}`] = {
            inputs: { image: [`cdd_${i}`, 0], batch_index: OVL_FRAMES, length: 4096 },
            class_type: 'ImageFromBatch',
            _meta: { title: `Сегмент ${i + 1}: без ${OVL_FRAMES} кадров перекрытия` },
          }
          segDec.push(`cdt_${i}`)
        } else {
          segDec.push(`cdd_${i}`)
        }
      }
      let framesAll: [string, number] = [segDec[0], 0]
      if (segDec.length > 1) {
        nodes[`cbatch`] = {
          inputs: {
            inputcount: segDec.length,
            ...Object.fromEntries(segDec.map((id, i) => [`image_${i + 1}`, [id, 0]])),
          },
          class_type: 'ImageBatchMulti',
          _meta: { title: `Склейка кадров (${segDec.length} сегм.)` },
        }
        framesAll = [`cbatch`, 0]
      }
      // Кроп до номинала — ОДИН раз на полном батче (раньше ccrop_k покусочно)
      if (needsCrop) {
        nodes[`ccrop`] = {
          inputs: { image: framesAll, width: final.outW, height: final.outH, x: final.cropX, y: final.cropY },
          class_type: 'ImageCrop',
          _meta: { title: `Кроп → ${final.outW}×${final.outH}` },
        }
        framesAll = [`ccrop`, 0]
      }
      // Аудио-латент мал — сегментировать не нужно, один декод на весь ролик
      nodes[`cadec`] = {
        inputs: { samples: fullAudio, vae: ['46:4', 0] },
        class_type: 'VAEDecodeAudio',
        _meta: { title: 'Decode Audio (полный)' },
      }
      // (правка 492) keepOriginalAudio: вместо перегенерированного звука
      // муксится ОРИГИНАЛЬНАЯ дорожка исходника — mp4-путь: 'r_src' pin 2
      // (загрузка целиком, дорожка не режется; беззвучный → тишина длиной
      // ролика), latent-путь: декод родного аудио-латента из .latent.
      let outAudio: [string, number] = [`cadec`, 0]
      if (p.keepOriginalAudio) {
        if (latentMode) {
          nodes['corigdec'] = {
            inputs: { samples: ['r_lsep', 1], vae: ['46:4', 0] },
            class_type: 'VAEDecodeAudio',
            _meta: { title: 'Оригинальный звук (аудио-латент исходника)' },
          }
          outAudio = ['corigdec', 0]
        } else {
          nodes['corigs'] = {
            inputs: {
              audio: ['r_src', 2],
              fallback_seconds: Number((p.sourceFrames / 24).toFixed(2)),
            },
            class_type: 'MiniMaxH3AudioOrSilent',
            _meta: { title: 'Оригинальный звук исходника (или тишина)' },
          }
          outAudio = ['corigs', 0]
        }
      }
      // ОДИН VHS_VideoCombine: единственное h264-кодирование (было: encode
      // каждого refinepart + повторный encode при ffmpeg-сшивке).
      nodes[`co`] = {
        inputs: {
          frame_rate: 24,
          loop_count: 0,
          filename_prefix: `${sub}Minimax_Studio_refine`,
          // (правка 386) формат/качество — из [video] настроек студии
          ...vhsEnc,
          save_metadata: false,
          pingpong: false,
          save_output: true,
          images: framesAll,
          audio: outAudio,
        },
        class_type: 'VHS_VideoCombine',
        _meta: { title: 'Video Combine (refine, частями)' },
      }
      return nodes
    })(),
  }
}
