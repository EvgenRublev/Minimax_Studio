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
 *
 * (правка 935) Опционально граф достраивается вторым проходом:
 *
 *   …VAEDecode(pass 1) → [ImageScale → итог] → H3InjectVideoLatent(нулевой AV-латент
 *   нужного размера из PH3ImageConditioning) → BasicGuider + BasicScheduler(simple,
 *   steps/denoise второго прохода) → SamplerCustomAdvanced → VAEDecode → SaveImage
 *
 * Размер из `width`/`height` при этом трактуется как ИТОГОВЫЙ: база считается из
 * `baseScale`, поэтому двухпроходный режим не ломает точность разрешений (правка 930).
 */

/** Дефолтные файлы image-обвязки (PrunaAI/P-H3-Image-Comfy). */
export const DEFAULT_IMAGE_LORA = 'p-h3-image_lora_bf16.safetensors'
export const DEFAULT_IMAGE_TEXT_ENCODER = 'p-h3-image_text_encoder_w4a8.safetensors'
export const DEFAULT_IMAGE_VAE = 'p-h3-image_vae_int8_convrot.safetensors'

/**
 * (правка 934) Prompt upsampler. В официальных воркфлоу PrunaAI он есть во
 * всех четырёх графах, а в карточке модели прямо сказано: «P-H3-Image чувствительна
 * к промптам, короткие запросы без апсемплера дают слабые результаты». Это тот же
 * Qwen3.5-9B, что и в нашем ассистенте, но дообученный под задачу, и исполняется он
 * внутри ComfyUI (CLIPLoader + TextGenerate) — ядро само выгружает его из VRAM перед
 * P-H3-Image. Наш LLM-ассистент для этого не годится: /api/llm/chat перед стартом
 * вызывает evictComfyVerified(), то есть высаживает ComfyUI.
 */
export const DEFAULT_IMAGE_PROMPT_UPSAMPLER = 'p-h3-image_prompt_upsampler_w4a8.safetensors'
export const IMAGE_PROMPT_UPSAMPLER_CANDIDATES = [
  'p-h3-image_prompt_upsampler_w4a8.safetensors',
  'p-h3-image_prompt_upsampler_int8_convrot.safetensors',
  'p-h3-image_prompt_upsampler_bf16.safetensors',
] as const
export const isImagePromptUpsampler = (name: string): boolean =>
  /prompt_upsampler|prompt-upsampler/i.test(name)

/**
 * (правка 934) Официальная база для image-LoRA — трансформер FL2VA (в карточке:
 * «Load minimax_h3_fl2va_bf16 … the pruned and quantized FL2VA files work too»).
 * Community-мержи видео-модели (у нас стоит Singularity_x_10Eros-Max_PRISM) тоже
 * технически работают с LoRA, но это чужие веса после видеодобычи — от них лицо и
 * «плывёт». Поэтому при невыбранной модели предпочитает FL2VA.
 */
export const isFl2vaImageBase = (name: string): boolean => /fl2va/i.test(name)
export function pickImageBaseModel(available: string[]): string {
  const fl2va = available.filter(isFl2vaImageBase)
  if (fl2va.length > 0) return fl2va.sort((a, b) => a.localeCompare(b))[0]
  return ''
}

/** Формат входа апсемплера — дословно как в эталонном StringFormat. */
export function imageUpsamplerInput(aspect: string, request: string): string {
  return `Aspect ratio: ${aspect}\nRequest: ${request}`
}

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
 *
 * (правка 933) Диапазон расширен до 0.5…8 МП для подбора качества. Строки
 * 4 и 8 МП — дословно официальная таблица PrunaAI (её и надо сравнивать с
 * остальными), остальные считаются: сторона кратна 32, пропорция — минимальное
 * отклонение, затем — площадь к цели. Официальная рекомендация: текст в 8 МП,
 * правки в 4 или 8 МП; ниже 2 МП лицо начинает «плыть» уже по разрешению.
 */
export const IMAGE_ASPECTS = ['1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16'] as const

/** Мегапиксельные ступени (ключи — строки, они же в сторе и в UI). */
export const IMAGE_MEGAPIXELS = ['0.5', '1', '1.5', '2', '2.5', '3', '4', '5', '6', '7', '8'] as const

/** Официальные строки таблицы PrunaAI — их не пересчитываем. */
const IMAGE_SIZES_OFFICIAL: Record<string, Record<string, [number, number]>> = {
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

const MULTIPLE = 32

/** Сторона обязана остаться в том же диапазоне, что проверяет API-роут. */
const SIDE_MIN = 256
const SIDE_MAX = 4096

function aspectParts(aspect: string): [number, number] {
  const [w, h] = aspect.split(':').map((n) => Number(n))
  if (!w || !h) return [1, 1]
  return [w, h]
}

/**
 * Подбор пары (w, h), кратной 32, для цели mp*1e6 при данной пропорции.
 * Перебор соседей вокруг теоретического размера: сначала минимизируем ошибку
 * пропорции, при равенстве — ошибку площади.
 */
function sizeForMegapixels(mp: number, aspect: string): [number, number] {
  const [aw, ah] = aspectParts(aspect)
  const ratio = aw / ah
  const targetPx = mp * 1_000_000
  const hIdeal = Math.sqrt(targetPx / ratio)
  const wIdeal = hIdeal * ratio
  const snap = (v: number) => Math.max(SIDE_MIN, Math.min(SIDE_MAX, Math.round(v / MULTIPLE) * MULTIPLE))
  const w0 = snap(wIdeal)
  const h0 = snap(hIdeal)
  let best: [number, number] = [w0, h0]
  let bestErr = Number.POSITIVE_INFINITY
  for (let dh = -1; dh <= 1; dh++) {
    for (let dw = -1; dw <= 1; dw++) {
      const w = Math.max(SIDE_MIN, Math.min(SIDE_MAX, w0 + dw * MULTIPLE))
      const h = Math.max(SIDE_MIN, Math.min(SIDE_MAX, h0 + dh * MULTIPLE))
      if (h === 0 || w === 0) continue
      const ratioErr = Math.abs(w / h - ratio) / ratio
      const pxErr = Math.abs(w * h - targetPx) / targetPx
      const err = ratioErr * 1000 + pxErr
      if (err < bestErr) {
        bestErr = err
        best = [w, h]
      }
    }
  }
  return best
}

function buildImageSizes(): Record<string, Record<string, [number, number]>> {
  const out: Record<string, Record<string, [number, number]>> = {}
  for (const mp of IMAGE_MEGAPIXELS) {
    const official = IMAGE_SIZES_OFFICIAL[mp]
    if (official) {
      out[mp] = { ...official }
      continue
    }
    const row: Record<string, [number, number]> = {}
    for (const a of IMAGE_ASPECTS) row[a] = sizeForMegapixels(Number(mp), a)
    out[mp] = row
  }
  return out
}

export const IMAGE_SIZES: Record<string, Record<string, [number, number]>> = buildImageSizes()

/** Подпись ступени в селекторе: «2 МП — 2016×1008». */
export function imageQualityLabel(mp: string, aspect: string): string {
  const [w, h] = IMAGE_SIZES[mp]?.[aspect] ?? [0, 0]
  return `${mp} МП — ${w}×${h}`
}

/** Ключ ступени разрешения: '0.5' | '1' | … | '8'. */
export type ImageQualityKey = (typeof IMAGE_MEGAPIXELS)[number]

/** Действующая ступень: сохранённое значение могло быть удалено из списка. */
export function normalizeImageQuality(q: string | undefined): ImageQualityKey {
  return q && IMAGE_SIZES[q] ? (q as ImageQualityKey) : '4'
}

export const IMAGE_MP_HINT: Record<string, string> = {
  '0.5': 'тест пропорций/композиции, очень быстро',
  '1': 'эскиз',
  '2': 'низкое: лицо начинает «плыть»',
  '3': 'низкое-среднее',
  '4': 'официальный режим правок (4 МП)',
  '5': 'средне-высокое',
  '6': 'высокое',
  '7': 'высокое',
  '8': 'официальный режим текста (8 МП), лучшее качество',
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
  /**
   * (правка 934) Апсемплер промпта: имя CLIP-файла p-h3-image_prompt_upsampler_*;
   * '' или null — выключен (запрос уходит модели как есть).
   */
  promptUpsampler?: string | null
  /** Соотношение сторон для формата входа апсемплера ('1:1', '16:9', …). */
  aspect?: string
  /**
   * (правка 935) 'off' | 'detail' | 'upscale' — см. IMAGE_TWO_PASS_MODES.
   * width/height при этом означают ИТОГОВЫЙ размер; база считается из baseScale.
   */
  twoPass?: ImageTwoPassMode
  /** Сколько раз стороны базового прохода меньше итоговых (1 = тот же размер). */
  baseScale?: number
  /** Сила второго прохода (0…1): 0.2 — почти только зерно, 0.6 — переписывает лицо. */
  denoise2?: number
  /** Шагов второго прохода. */
  steps2?: number
  /**
   * Дополнительная формулировка для второго прохода: к запросу добавляется
   * вторая строка, апсемплер при этом не перезапускается. '' — второй проход
   * использует тот же текст, что и первый.
   */
  prompt2?: string
}

/**
 * (правка 935) Нормализация параметров двухпроходного режима: всё, что присылает
 * фронт и что попадает в воркфлоу, проходит через эту функцию.
 */
export function imageTwoPassParams(p: {
  twoPass?: unknown
  denoise2?: unknown
  steps2?: unknown
  baseScale?: unknown
}): { mode: ImageTwoPassMode; denoise2: number; steps2: number; baseScale: number } {
  const mode = (IMAGE_TWO_PASS_MODES as readonly string[]).includes(String(p.twoPass))
    ? (p.twoPass as ImageTwoPassMode)
    : 'off'
  if (mode === 'off') return { mode, denoise2: 1, steps2: 0, baseScale: 1 }
  const { min: dmin, max: dmax } = IMAGE_DENOISE2_RANGE
  const { min: smin, max: smax } = IMAGE_STEPS2_RANGE
  const rawDenoise = Number(p.denoise2 ?? DEFAULT_IMAGE_TWO_PASS.denoise)
  const denoise2 = Number.isFinite(rawDenoise) ? Math.min(dmax, Math.max(dmin, rawDenoise)) : DEFAULT_IMAGE_TWO_PASS.denoise
  const rawSteps = Math.round(Number(p.steps2 ?? DEFAULT_IMAGE_TWO_PASS.steps))
  const steps2 = Number.isFinite(rawSteps) ? Math.min(smax, Math.max(smin, rawSteps)) : DEFAULT_IMAGE_TWO_PASS.steps
  const rawScale = Number(p.baseScale ?? DEFAULT_IMAGE_TWO_PASS.baseScale)
  const baseScale = Number.isFinite(rawScale) ? Math.max(1, Math.min(4, rawScale)) : DEFAULT_IMAGE_TWO_PASS.baseScale
  return { mode, denoise2, steps2, baseScale }
}

/**
 * (правка 935) Два прохода. H3 всегда строит нулевой латент, поэтому «второй
 * проход» собирается так же, как в видео-режимах: результат первого прохода
 * декодируется, при необходимости растягивается до целевого размера, кодируется
 * image-VAE и внедряется в видео-поток AV-латента (`H3InjectVideoLatent` из
 * пака ComfyUI-H3-FaceRefine, он же в install/nodes.json), а сэмплер доходит
 * его снизу сетки сигм — то есть есть обычный img2img.
 *
 *  • 'detail' — обе проходки в одном разрешении: композиция зафиксирована,
 *    второй проход только дорисовывает детали (глаза, текстуры, руки).
 *  • 'upscale' — первый проход в уменьшенном базовом разрешении (там модель
 *    устойчивее и быстрее), второй — в выбранном целевом.
 *
 * Сила второго прохода — `denoise` + число шагов через `BasicScheduler`
 * ('simple'), как в tile-upscale и Face Refine: он берёт нижний хвост полной
 * сетки, поэтому шаги и сила независимы (в отличие от обрезки ManualSigmas —
 * см. docstring H3InjectVideoLatent).
 */
export const IMAGE_TWO_PASS_MODES = ['off', 'detail', 'upscale'] as const
export type ImageTwoPassMode = (typeof IMAGE_TWO_PASS_MODES)[number]
export const IMAGE_TWO_PASS_LABELS: Record<string, string> = {
  off: 'Один проход',
  detail: 'Два прохода — детали поверх основы',
  upscale: 'Два прохода — база меньше, итог крупнее',
}
/** Во сколько раз стороны второго прохода больше базовых (площадь — в квадрат). */
export const IMAGE_BASE_SCALES = [1.5, 2, 3] as const
export const DEFAULT_IMAGE_TWO_PASS = {
  denoise: 0.35,
  steps: 4,
  baseScale: 2,
} as const
/** Диапазоны, которые принимает и UI, и роут. */
export const IMAGE_DENOISE2_RANGE = { min: 0.05, max: 0.8 }
export const IMAGE_STEPS2_RANGE = { min: 1, max: 12 }

/** id ноды апсемплера — по нему из history можно прочитать расширенный промпт. */
export const IMAGE_UPSAMPLER_NODE_ID = '7:16'

/** id ноды-сэмплера — на него вешается прогресс (progress-tracker). */
export const IMAGE_SAMPLER_NODE_ID = '7:12'

/** id нод второго прохода (правки 935); sampler2 — вторая стадия прогресса. */
export const IMAGE_COND2_NODE_ID = '7:8b'
export const IMAGE_PASS2_SCALE_NODE_ID = '7:18'
export const IMAGE_PASS2_INJECT_NODE_ID = '7:19'
export const IMAGE_PASS2_SIGMAS_NODE_ID = '7:20'
export const IMAGE_PASS2_GUIDER_NODE_ID = '7:21'
export const IMAGE_PASS2_DECODE_NODE_ID = '7:26'
export const IMAGE_SAMPLER2_NODE_ID = '7:24'

function snap(v: number): number {
  const n = Math.round(v / MULTIPLE) * MULTIPLE
  return Math.max(SIDE_MIN, Math.min(SIDE_MAX, n))
}

/** Размер базового прохода: округляем вниз, чтобы база не вышла за итог. */
function snapDown(v: number): number {
  const n = Math.floor(v / MULTIPLE) * MULTIPLE
  return Math.max(SIDE_MIN, Math.min(SIDE_MAX, n))
}

/**
 * (правка 935) Размер первого прохода для данных итоговых размеров. Нужен и
 * билдеру, и вкладке (подпись «база 1456×1456 → итог 2912×2912»), поэтому
 * считается в одном месте.
 */
export function imageBaseDims(
  finalW: number,
  finalH: number,
  mode: ImageTwoPassMode,
  baseScale: number,
): [number, number] {
  const w = snap(finalW)
  const h = snap(finalH)
  if (mode !== 'upscale') return [w, h]
  return [snapDown(w / baseScale), snapDown(h / baseScale)]
}

export function buildImageWorkflow(p: ImageGenParams): Record<string, unknown> {
  if (!p.prompt || !p.prompt.trim()) throw new Error('Пустой промпт')

  // (правка 935) width/height — ИТОГОВЫЙ размер: он и уходит в SaveImage, чтобы
  // вкладка отдавала ровно номинал пресета. При 'upscale' базовый проход
  // считается из baseScale и округляется вниз.
  const finalW = snap(p.width)
  const finalH = snap(p.height)
  const { mode, denoise2, steps2, baseScale } = imageTwoPassParams(p)
  const [width, height] = imageBaseDims(finalW, finalH, mode, baseScale)
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

  // (правка 934) Апсемплер промпта — как в эталоне: CLIPLoader(type minimax) +
  // TextGenerate (greedy: sampling_mode 'off', thinking on) с входом
  // «Aspect ratio: X\nRequest: …», а уже его текст уходит в conditioning.
  // Только для генерации по тексту: в эталонном edit-графе апсемплер получает
  // ещё и картинки блоками <Picture N> — это отдельная работа.
  const upsampler = (p.promptUpsampler ?? '').trim()
  const useUpsampler = Boolean(upsampler) && refs.length === 0
  if (useUpsampler) {
    modelChain['7:17'] = {
      inputs: { clip_name: upsampler, type: 'minimax', device: 'default' },
      class_type: 'CLIPLoader',
      _meta: { title: 'Prompt upsampler (CLIP)' },
    }
    modelChain[IMAGE_UPSAMPLER_NODE_ID] = {
      inputs: {
        clip: ['7:17', 0],
        prompt: imageUpsamplerInput(p.aspect || '1:1', p.prompt.trim()),
        max_length: 2048,
        sampling_mode: 'off',
        thinking: true,
        use_default_template: true,
        mtp: 'auto',
        seed: p.seed ?? 0,
      },
      class_type: 'TextGenerate',
      _meta: { title: 'Апсемплер промпта' },
    }
  }
  const pass1Prompt: unknown = useUpsampler ? [IMAGE_UPSAMPLER_NODE_ID, 0] : p.prompt

  const refLinks: [string, number][] = []
  if (refs.length > 0) {
    refs.forEach((name, i) => {
      const loadId = `7:r${i + 1}`
      modelChain[loadId] = {
        inputs: { image: name },
        class_type: 'LoadImage',
        _meta: { title: i === 0 ? 'Что правим (image_1)' : `Референс ${i}` },
      }
      refLinks.push([loadId, 0])
    })
  }

  // autogrow-вход images (names image_1…image_9) в API-формате — «images.image_N»,
  // тот же паттерн, что ref_images.ref_image_0 в H3. VAE ноде нужен и для
  // кодирования референсов, и для латента результата.
  const condInputs = (promptSrc: unknown, w: number, h: number): Record<string, unknown> => {
    const inputs: Record<string, unknown> = { clip: ['7:6', 0], prompt: promptSrc, width: w, height: h }
    if (refLinks.length > 0) {
      inputs.vae = ['7:7', 0]
      refLinks.forEach((link, i) => {
        inputs[`images.image_${i + 1}`] = link
      })
    }
    return inputs
  }

  // ─── (правка 935) второй проход ───
  // Вторая conditioning-нода нужна, когда итоговое разрешение отличается от
  // базового ('upscale') или когда для второго прохода задана своя формулировка:
  // её выход — и текст, и нулевой AV-латент нужного размера (1 кадр + 2 аудио).
  const suffix = (p.prompt2 || '').trim()
  const needCond2 = mode !== 'off' && (width !== finalW || height !== finalH || suffix !== '')
  const cond2Id = needCond2 ? IMAGE_COND2_NODE_ID : '7:8'
  const pass2Prompt: unknown =
    suffix && needCond2 ? `${p.prompt.trim()}\n${suffix}` : pass1Prompt

  // Масштабирование базы нужно только при различии размеров; метод lanczos —
  // как в cn_prescale: он не добавляет ringing, который второй проход усилил бы.
  const needScale = mode !== 'off' && (width !== finalW || height !== finalH)
  const pass2Nodes: Record<string, unknown> = {}
  if (mode !== 'off') {
    if (needCond2) {
      pass2Nodes[IMAGE_COND2_NODE_ID] = {
        inputs: condInputs(pass2Prompt, finalW, finalH),
        class_type: 'PH3ImageConditioning',
        _meta: { title: 'p-h3-image Conditioning (проход 2)' },
      }
    }
    let baseImages: [string, number] = ['7:14', 0]
    if (needScale) {
      pass2Nodes[IMAGE_PASS2_SCALE_NODE_ID] = {
        inputs: { image: ['7:14', 0], upscale_method: 'lanczos', width: finalW, height: finalH, crop: 'disabled' },
        class_type: 'ImageScale',
        _meta: { title: `База → ${finalW}×${finalH}` },
      }
      baseImages = [IMAGE_PASS2_SCALE_NODE_ID, 0]
    }
    pass2Nodes[IMAGE_PASS2_INJECT_NODE_ID] = {
      inputs: { av_latent: [cond2Id, 1], images: baseImages, vae: ['7:7', 0] },
      class_type: 'H3InjectVideoLatent',
      _meta: { title: 'База в AV-латент (img2img)' },
    }
    pass2Nodes[IMAGE_PASS2_SIGMAS_NODE_ID] = {
      inputs: { model: ['7:5', 0], scheduler: 'simple', steps: steps2, denoise: denoise2 },
      class_type: 'BasicScheduler',
      _meta: { title: `Сигмы прохода 2 (${steps2} шаг(ов), denoise ${denoise2})` },
    }
    pass2Nodes[IMAGE_PASS2_GUIDER_NODE_ID] = {
      inputs: { model: ['7:5', 0], conditioning: [cond2Id, 0] },
      class_type: 'BasicGuider',
      _meta: { title: 'Guider (проход 2)' },
    }
    pass2Nodes['7:22'] = {
      inputs: { sampler_name: 'euler' },
      class_type: 'KSamplerSelect',
      _meta: { title: 'Sampler: euler (проход 2)' },
    }
    pass2Nodes['7:23'] = {
      inputs: { noise_seed: p.seed ?? 0 },
      class_type: 'RandomNoise',
      _meta: { title: 'Шум прохода 2' },
    }
    pass2Nodes[IMAGE_SAMPLER2_NODE_ID] = {
      inputs: {
        noise: ['7:23', 0],
        guider: [IMAGE_PASS2_GUIDER_NODE_ID, 0],
        sampler: ['7:22', 0],
        sigmas: [IMAGE_PASS2_SIGMAS_NODE_ID, 0],
        latent_image: [IMAGE_PASS2_INJECT_NODE_ID, 0],
      },
      class_type: 'SamplerCustomAdvanced',
      _meta: { title: 'Сэмплер (проход 2)' },
    }
    pass2Nodes['7:25'] = {
      inputs: { av_latent: [IMAGE_SAMPLER2_NODE_ID, 0] },
      class_type: 'LTXVSeparateAVLatent',
      _meta: { title: 'Separate AV Latent (проход 2)' },
    }
    pass2Nodes[IMAGE_PASS2_DECODE_NODE_ID] = {
      inputs: { samples: ['7:25', 0], vae: ['7:7', 0] },
      class_type: 'VAEDecode',
      _meta: { title: 'Decode (проход 2)' },
    }
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
      inputs: condInputs(pass1Prompt, width, height),
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
        // (правка 935) в двухпроходном режиме сохраняется результат второго
        // прохода — он ровно в итоговом размере, отдельный кроп не нужен.
        images: mode !== 'off' ? [IMAGE_PASS2_DECODE_NODE_ID, 0] : ['7:14', 0],
        filename_prefix: p.filenamePrefix || 'Minimax_Studio_image',
      },
      class_type: 'SaveImage',
      _meta: { title: 'Сохранить изображение' },
    },
    ...pass2Nodes,
  }

  return workflow
}

/**
 * Стадии для progress-tracker. (правка 935) Во втором проходе своя нода-сэмплер,
 * поэтому стадий две — как в видео-режимах с pass-2: прогресс не «откатывается».
 */
export function imageSamplerStages(twoPass?: unknown): string[][] {
  const { mode } = imageTwoPassParams({ twoPass })
  return mode === 'off' ? [[IMAGE_SAMPLER_NODE_ID]] : [[IMAGE_SAMPLER_NODE_ID], [IMAGE_SAMPLER2_NODE_ID]]
}
