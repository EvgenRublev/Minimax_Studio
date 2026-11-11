/**
 * (правка 929) Билдер воркфлоу «Изображение» — MiniMax H3 в режиме картинки.
 *
 * Граф собирается в API-формате (как minimax-h3-template.ts) и состоит из
 * одной цепи:
 *
 *   UNETLoader → [LowVRAM] → [ChunkFF] → [LoRA p-h3-image] → MiniMaxH3SigmaShift(1/1)
 *   CLIPLoader(type=minimax, p-h3-image TE) + VAELoader(p-h3-image VAE)
 *        → PH3ImageConditioning(prompt, width, height, image_1..image_N)
 *        → BasicGuider + ManualSigmas + KSamplerSelect(euler) → SamplerCustomAdvanced
 *        → LTXVSeparateAVLatent → VAEDecode → SaveImage
 *
 * Почему так:
 *  • `PH3ImageConditioning` (display_name «p-h3-image Conditioning») — единственная
 *    image-нода в ядре 0.44 (comfy_extras/nodes_minimax_h3.py). Её выход-латент —
 *    обычный AV-латент H3 (видео-часть = один кадр), поэтому декод идёт через
 *    LTXVSeparateAVLatent + VAEDecode, как в видео-пайплайне.
 *  • Sigma Shift для картинки = 1.0/1.0 (не 12/3, как в видео) — требует сама нода.
 *  • Текстовый энкодер и VAE ОБЯЗАТЕЛЬНО image-ные: у картинки свой текстовый
 *    коннектор (Qwen3-VL + text_connector) и свой single-frame VAE. Видео-TE
 *    (qwen3vl_32b_minimax_h3_*) с image-DiT несовместим.
 *  • DiT можно взять либо официальный image-файл (minimax_h3_image_pruned_*),
 *    либо НАШУ видео-модель + LoRA `p-h3-image_lora_bf16` (2 ГБ) — структуры
 *    совпадают (50 блоков, те же 208 целевых модулей), поэтому LoRA ложится
 *    поверх без отдельной 21-гигабайтной модели.
 */

/** Дефолтные файлы image-обвязки (PrunaAI/P-H3-Image-Comfy). */
export const DEFAULT_IMAGE_LORA = 'p-h3-image_lora_bf16.safetensors'
export const DEFAULT_IMAGE_TEXT_ENCODER = 'p-h3-image_text_encoder_w4a8.safetensors'
export const DEFAULT_IMAGE_VAE = 'p-h3-image_vae_int8_convrot.safetensors'

/** Максимум картинок в PH3ImageConditioning: image_1 (что правим) + 7 референсов. */
export const IMAGE_MAX_REFERENCES = 8

/**
 * Сетки сигм. `image8` — официальная 8-шаговая сетка image-моделей (из
 * воркфлоу PrunaAI). `fast4` — наша 4-шаговая лестница (те же значения, что
 * pass-2 `3step`-вариант в minimax-h3-template.ts, но с полным стартом от 1.0):
 * подходит, когда база — дистиллированная 4-шаговая модель.
 */
export const IMAGE_SIGMA_SCHEDULES: Record<string, string> = {
  image8: '1.0, 0.984753, 0.967905, 0.951688, 0.925372, 0.881923, 0.810083, 0.528718, 0.0',
  fast4: '1.0, 0.9035, 0.6316, 0.3158, 0.0000',
}
export const IMAGE_SCHEDULE_LABELS: Record<string, string> = {
  image8: '8 шагов (официальная сетка)',
  fast4: '4 шага (дистиллированная модель)',
}

/**
 * Пресеты размеров. Кратность 32 обязательна (CANVAS_MULTIPLE в image-ноде),
 * поэтому значения взяты из официальной таблицы разрешений, а не «круглые».
 */
export const IMAGE_ASPECTS = ['1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16'] as const
export const IMAGE_SIZES: Record<'4' | '8', Record<string, [number, number]>> = {
  // 4 МП — рекомендуемый режим для правок по референсам
  '4': {
    '1:1': [2048, 2048],
    '4:3': [2368, 1760],
    '3:4': [1760, 2368],
    '3:2': [2496, 1664],
    '2:3': [1664, 2496],
    '16:9': [2720, 1536],
    '9:16': [1536, 2720],
  },
  // 8 МП — рекомендуемый режим для генерации по тексту (качество выше)
  '8': {
    '1:1': [2912, 2912],
    '4:3': [3360, 2496],
    '3:4': [2496, 3360],
    '3:2': [3552, 2368],
    '2:3': [2368, 3552],
    '16:9': [3872, 2176],
    '9:16': [2176, 3872],
  },
}

export interface ImageGenParams {
  prompt: string
  /** Side of the canvas; must be a multiple of 32 (округляем сами). */
  width: number
  height: number
  /** Ключ из IMAGE_SIGMA_SCHEDULES; по умолчанию image8. */
  schedule?: string
  /** Прямая замена сетки сигм (для экспериментов), перекрывает schedule. */
  sigmas?: string
  seed?: number
  /** DiT: наша видео-модель или image-файл minimax_h3_image_pruned_*. */
  diffusionModel?: string
  /** LoRA поверх DiT; '' или null — без LoRA (тогда нужен image-DiT). */
  imageLora?: string | null
  loraStrength?: number
  textEncoder?: string
  vae?: string
  /** Файлы в ComfyUI/input/. image_1 — редактируемое изображение. */
  references?: string[]
  /** MiniMaxLowVRAMAttention / MiniMaxChunkFeedForward — как в видео-шаблоне. */
  lowVramAttention?: boolean
  chunkFeedForward?: boolean
  chunkFFChunks?: number
  chunkFFThreshold?: number
  filenamePrefix?: string
}

/** id ноды-сэмплера — на него вешается прогресс (progress-tracker). */
export const IMAGE_SAMPLER_NODE_ID = '7:12'

const MULTIPLE = 32

function snap(v: number): number {
  const n = Math.round(v / MULTIPLE) * MULTIPLE
  return Math.max(MULTIPLE, n)
}

export function buildImageWorkflow(p: ImageGenParams): Record<string, unknown> {
  if (!p.prompt || !p.prompt.trim()) throw new Error('Пустой промпт')

  const width = snap(p.width)
  const height = snap(p.height)
  const sigmas = p.sigmas?.trim() || IMAGE_SIGMA_SCHEDULES[p.schedule || 'image8'] || IMAGE_SIGMA_SCHEDULES.image8
  const refs = (p.references || []).filter(Boolean).slice(0, IMAGE_MAX_REFERENCES)
  if ((p.references || []).length > IMAGE_MAX_REFERENCES) {
    throw new Error(`Референсов больше ${IMAGE_MAX_REFERENCES}: image_1 — то, что правим, плюс до ${IMAGE_MAX_REFERENCES - 1} картинок-источников`)
  }

  const modelChain: Record<string, unknown> = {}
  let modelSrc: [string, number] = ['7:1', 0]

  modelChain['7:1'] = {
    inputs: { unet_name: p.diffusionModel || '', weight_dtype: 'default' },
    class_type: 'UNETLoader',
    _meta: { title: 'Модель диффузии' },
  }

  // Те же энергосберегающие патчи, что и в видео: картинка — 4–8 МП, то есть
  // последовательность не короче видеокадра, VRAM экономится так же.
  if (p.lowVramAttention !== false) {
    modelChain['7:2'] = {
      inputs: { head_chunks: 4, model: modelSrc },
      class_type: 'MiniMaxLowVRAMAttention',
      _meta: { title: 'Low VRAM Attention' },
    }
    modelSrc = ['7:2', 0]
  }
  if (p.chunkFeedForward !== false) {
    modelChain['7:3'] = {
      inputs: {
        chunks: Math.max(1, Math.round(p.chunkFFChunks ?? 2)),
        seq_threshold: Math.max(0, Math.round(p.chunkFFThreshold ?? 4096)),
        model: modelSrc,
      },
      class_type: 'MiniMaxChunkFeedForward',
      _meta: { title: 'Chunk FeedForward' },
    }
    modelSrc = ['7:3', 0]
  }
  if (p.imageLora) {
    modelChain['7:4'] = {
      inputs: {
        model: modelSrc,
        lora_name: p.imageLora,
        strength_model: p.loraStrength ?? 1.0,
      },
      class_type: 'LoraLoaderModelOnly',
      _meta: { title: `LoRA p-h3-image (${p.loraStrength ?? 1})` },
    }
    modelSrc = ['7:4', 0]
  }
  // Картинка — без sparse-attention: она обучена на плотном внимании,
  // разреживание ломает композицию на одном кадре.
  modelChain['7:5'] = {
    inputs: { model: modelSrc, shift_video: 1.0, shift_audio: 1.0 },
    class_type: 'MiniMaxH3SigmaShift',
    _meta: { title: 'Sigma Shift 1.0/1.0' },
  }

  const condInputs: Record<string, unknown> = {
    clip: ['7:6', 0],
    prompt: p.prompt,
    width,
    height,
  }
  if (refs.length > 0) {
    // ВAE нужен ноде и для кодирования референсов, и для латента результата
    condInputs.vae = ['7:7', 0]
    refs.forEach((name, i) => {
      const loadId = `7:r${i + 1}`
      modelChain[loadId] = {
        inputs: { image: name },
        class_type: 'LoadImage',
        _meta: { title: i === 0 ? 'Что правим (image_1)' : `Референс ${i}` },
      }
      // autogrow-вход images (names image_1…image_9) в API-формате —
      // «images.image_N», тот же паттерн, что ref_images.ref_image_0 в H3.
      condInputs[`images.image_${i + 1}`] = [loadId, 0]
    })
  }

  const workflow: Record<string, unknown> = {
    ...modelChain,
    '7:6': {
      inputs: { clip_name: p.textEncoder || DEFAULT_IMAGE_TEXT_ENCODER, type: 'minimax', device: 'default' },
      class_type: 'CLIPLoader',
      _meta: { title: 'Text Encoder (image)' },
    },
    '7:7': {
      inputs: { vae_name: p.vae || DEFAULT_IMAGE_VAE },
      class_type: 'VAELoader',
      _meta: { title: 'VAE (image)' },
    },
    '7:8': {
      inputs: condInputs,
      class_type: 'PH3ImageConditioning',
      _meta: { title: 'p-h3-image Conditioning' },
    },
    '7:9': {
      inputs: { noise_seed: p.seed ?? 0 },
      class_type: 'RandomNoise',
      _meta: { title: 'Случайный шум' },
    },
    '7:10': {
      inputs: { model: ['7:5', 0], conditioning: ['7:8', 0] },
      class_type: 'BasicGuider',
      _meta: { title: 'Guider' },
    },
    '7:11': {
      inputs: { sampler_name: 'euler' },
      class_type: 'KSamplerSelect',
      _meta: { title: 'Sampler: euler' },
    },
    '7:11s': {
      inputs: { sigmas },
      class_type: 'ManualSigmas',
      _meta: { title: `Сигмы (${(p.schedule || 'image8')})` },
    },
    [IMAGE_SAMPLER_NODE_ID]: {
      inputs: {
        noise: ['7:9', 0],
        guider: ['7:10', 0],
        sampler: ['7:11', 0],
        sigmas: ['7:11s', 0],
        latent_image: ['7:8', 1],
      },
      class_type: 'SamplerCustomAdvanced',
      _meta: { title: 'Сэмплер' },
    },
    '7:13': {
      inputs: { av_latent: [IMAGE_SAMPLER_NODE_ID, 0] },
      class_type: 'LTXVSeparateAVLatent',
      _meta: { title: 'Separate AV Latent' },
    },
    '7:14': {
      inputs: { samples: ['7:13', 0], vae: ['7:7', 0] },
      class_type: 'VAEDecode',
      _meta: { title: 'Decode' },
    },
    '7:15': {
      inputs: {
        images: ['7:14', 0],
        filename_prefix: p.filenamePrefix || 'Minimax_Studio_image',
      },
      class_type: 'SaveImage',
      _meta: { title: 'Сохранить изображение' },
    },
  }

  return workflow
}

/** Стадии для progress-tracker: один проход сэмплирования. */
export function imageSamplerStages(): string[][] {
  return [[IMAGE_SAMPLER_NODE_ID]]
}
