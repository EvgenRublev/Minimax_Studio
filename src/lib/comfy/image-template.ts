/**
 * (правки 929, 938) Билдер воркфлоу «Изображение» — официальная MiniMax H3 Image
 * (Comfy-Org/MiniMax-H3-Image).
 *
 * Граф собирается в API-формате (как minimax-h3-template.ts):
 *
 *   UNETLoader(minimax_h3_image_pruned_*) → [LowVRAM] → [ChunkFF] → MiniMaxH3SigmaShift(1/1)
 *   CLIPLoader(type=minimax, qwen3vl_32b_minimax_h3_*) + VAELoader(minimax_h3_image_vae_fp16)
 *   [enhancer] CLIPLoader(qwen3.5_9b_w4a8_gptq) → TextGenerateV2 → JsonExtractString
 *        → PH3ImageConditioning(prompt, width, height, image_1..image_N)
 *        → BasicGuider + BasicScheduler(simple) + KSamplerSelect(euler) → SamplerCustomAdvanced
 *        → LTXVSeparateAVLatent → VAEDecode → SaveImage
 *
 * Почему так:
 *  • `PH3ImageConditioning` — image-нода ядра 0.44 (в свежем ядре её переименовали
 *    в `MiniMaxH3ImageConditioning`, как в эталонном шаблоне Comfy-Org; в
 *    API-формате входы задаются по именам, поэтому граф переносится один в один).
 *    Её выход-латент — обычный AV-латент H3 (видео-часть = один кадр), поэтому
 *    декод идёт через LTXVSeparateAVLatent + VAEDecode, как в видео-пайплайне.
 *  • Sigma Shift для картинки = 1.0/1.0 (не 12/3, как в видео) — требует сама нода.
 *  • DiT — отдельная image-модель (`minimax_h3_image_pruned_*`). Путь «видео-модель
 *    + LoRA p-h3-image» отключён (правка 938): официальная модель легче (w4a8 —
 *    12.5 ГБ против 14.8 + 1.9 за LoRA) и это те же веса, из которых PrunaAI делала
 *    свой LoRA-репакет.
 *  • Текстовый энкодер — общий с видео `qwen3vl_32b_minimax_h3_*`: именно он стоит
 *    в официальном image-шаблоне (32B Qwen3-VL + свой text_connector у модели внутри
 *    DiT). VAE — свой, image-ный.
 *  • Сэмплирование — `BasicScheduler(scheduler: simple)` + euler, 6 шагов по
 *    умолчанию: в эталоне это `KSampler(euler, simple, 6 шагов, cfg 1)`, а cfg 1 у нас
 *    и так означает «без CFG» (BasicGuider без negative).
 *  • Prompt enhancer — по карточке модели обязателен: H3 Image чувствительна к
 *    формулировкам. Работает внутри ComfyUI (CLIPLoader + TextGenerateV2 +
 *    JsonExtractString), промпты взяты дословно из эталонных шаблонов (image-pe.ts).
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

/**
 * (правка 938) Файлы официальной MiniMax H3 Image (Comfy-Org/MiniMax-H3-Image).
 * w4a8 — самая лёгкая из трёх квантизаций (12.5 ГБ): на 24 ГБ карте она в приорете.
 */
import {
  IMAGE_PE_JSON_KEY,
  IMAGE_PE_SAMPLING,
  IMAGE_PE_SYSTEM_PROMPT,
  imagePePrompt,
} from './image-pe'

export const DEFAULT_IMAGE_MODEL = 'minimax_h3_image_pruned_w4a8.safetensors'
export const IMAGE_MODEL_CANDIDATES = [
  'minimax_h3_image_pruned_w4a8.safetensors',
  'minimax_h3_image_pruned_int8_convrot.safetensors',
  'minimax_h3_image_pruned_bf16.safetensors',
] as const

/**
 * Текстовый энкодер в официальном image-воркфлоу — тот же 32B Qwen3-VL, что и в
 * видео (nvfp4_awq у нас уже скачан под видео, int8_convrot — целее, но 27 ГБ).
 */
export const DEFAULT_IMAGE_TEXT_ENCODER = 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'
export const IMAGE_TEXT_ENCODER_CANDIDATES = [
  'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
  'qwen3vl_32b_minimax_h3_int8_convrot.safetensors',
] as const

/** Image-ный VAE: fp16, всего 1.17 ГБ — дешевле PrunaAI-варианта. */
export const DEFAULT_IMAGE_VAE = 'minimax_h3_image_vae_fp16.safetensors'

/**
 * (правка 938) Prompt enhancer — официальная рекомендация карточки: qwen3.5_9b
 * c TextGenerateV2. Через нашего LLM-ассистента нельзя: /api/llm/chat перед
 * стартом зовёт evictComfyVerified() и высаживает ComfyUI.
 */
export const DEFAULT_IMAGE_PROMPT_ENHANCER = 'qwen3.5_9b_w4a8_gptq.safetensors'
export const IMAGE_PE_CANDIDATES = ['qwen3.5_9b_w4a8_gptq.safetensors', 'qwen3.5_9b_w4a8.safetensors'] as const

export const isImageDiT = (name: string): boolean => /minimax_h3_image/i.test(name)
export const isImageTextEncoder = (name: string): boolean => /qwen3vl_32b_minimax_h3/i.test(name)
export const isImageVae = (name: string): boolean => /h3_image_vae|h3-image-vae/i.test(name)
export const isImagePromptEnhancer = (name: string): boolean => /qwen3(\.5)?_9b/i.test(name)

/** Максимум картинок в PH3ImageConditioning: image_1 (что правим) + 7 референсов. */
export const IMAGE_MAX_REFERENCES = 8

/**
 * (правка 938) Число шагов первого прохода. В эталонном шаблоне Comfy-Org стоит
 * `KSampler(euler, simple, 6 шагов, cfg 1)` — то есть сетку считает планировщик по
 * собственной таблице сигм модели, а не вручную. Ручная сетка PrunaAI (8 точек)
 * ушла вместе с LoRA-путём.
 */
export const IMAGE_STEPS = [4, 6, 8, 10, 12] as const
export const DEFAULT_IMAGE_STEPS = 6
export const IMAGE_STEPS_LABELS: Record<string, string> = {
  '4': '4 шага — быстрый прогон',
  '6': '6 шагов — как в официальном шаблоне',
  '8': '8 шагов',
  '10': '10 шагов',
  '12': '12 шагов — максимум деталей',
}
/** Зажим для значения извне (UI/роут): 1…20, по умолчанию официальный 6. */
export function normalizeImageSteps(v: unknown): number {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.min(20, Math.max(1, n)) : DEFAULT_IMAGE_STEPS
}

/**
 * Пресеты размеров. Кратность 32 обязательна (CANVAS_MULTIPLE в image-ноде),
 * поэтому значения взяты из официальной таблицы разрешений, а не «круглые».
 *
 * (правка 938) Карточка MiniMax-H3-Image: рабочая область модели 4…20 МП, лучше
 * всего ~16 МП. Строка 16 МП — дословно официальная таблица Comfy-Org, строки
 * 4 и 8 МП — таблица PrunaAI (они же у нас прижились как «быстрые»), остальные
 * считаются: сторона кратна 32, минимум отклонения пропорции, затем площади.
 * Ниже 2 МП лицо «плывёт» уже из-за разрешения.
 */
export const IMAGE_ASPECTS = ['1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16', '21:9'] as const

/** Мегапиксельные ступени (ключи — строки, они же в сторе и в UI). */
export const IMAGE_MEGAPIXELS = [
  '0.5', '1', '1.5', '2', '2.5', '3', '4', '5', '6', '7', '8', '10', '12', '16',
] as const

/** Официальные строки таблиц Comfy-Org (16 МП) и PrunaAI (4/8 МП) — не пересчитываем. */
const IMAGE_SIZES_OFFICIAL: Record<string, Record<string, [number, number]>> = {
  // 4 МП — дефолт официального шаблона и рекомендуемый режим для правок
  '4': {
    '1:1': [2048, 2048],
    '4:3': [2368, 1760],
    '3:4': [1760, 2368],
    '3:2': [2496, 1664],
    '2:3': [1664, 2496],
    '16:9': [2720, 1536],
    '9:16': [1536, 2720],
  },
  // 8 МП — оптимум по скорости на 24 ГБ
  '8': {
    '1:1': [2912, 2912],
    '4:3': [3360, 2496],
    '3:4': [2496, 3360],
    '3:2': [3552, 2368],
    '2:3': [2368, 3552],
    '16:9': [3872, 2176],
    '9:16': [2176, 3872],
  },
  // 16 МП — рекомендованный режим качества (таблица из карточки Comfy-Org)
  '16': {
    '1:1': [4096, 4096],
    '4:3': [4736, 3552],
    '3:4': [3552, 4736],
    '3:2': [5024, 3360],
    '2:3': [3360, 5024],
    '16:9': [5472, 3072],
    '9:16': [3072, 5472],
    '21:9': [6272, 2688],
  },
}

const MULTIPLE = 32

/**
 * Диапазон стороны: нижняя — чтобы латент не схлопнулся, верхняя — под официальную
 * 16-мегапиксельную таблицу (там 6272 по длинной стороне). Ядро разрешает до
 * MAX_RESOLUTION=16384, валидация API-роута обязана совпадать с этим значением.
 */
const SIDE_MIN = 256
const SIDE_MAX = 8192

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
    const row: Record<string, [number, number]> = {}
    for (const a of IMAGE_ASPECTS) row[a] = sizeForMegapixels(Number(mp), a)
    // Официальные строки не пересчитываем; чего в них нет (например 21:9 в
    // таблице PrunaAI) — считается общим правилом.
    const official = IMAGE_SIZES_OFFICIAL[mp]
    if (official) {
      for (const [a, dims] of Object.entries(official)) {
        if (row[a]) row[a] = dims
      }
    }
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
  '4': 'дефолт официального шаблона',
  '5': 'средне-высокое',
  '6': 'высокое',
  '7': 'высокое',
  '8': 'официальный режим правок и быстрый текст',
  '10': 'высокое, ближе к оптимуму модели',
  '12': 'очень высокое',
  '16': 'рекомендованное качество официальной карточки (4…20 МП)',
}


export interface ImageGenParams {
  prompt: string
  /** Side of the canvas; must be a multiple of 32 (округляем сами). */
  width: number
  height: number
  /** (правка 938) Шагов первого прохода; сетку считает BasicScheduler(simple). */
  steps?: number
  seed?: number
  /** DiT: официальная image-модель minimax_h3_image_pruned_*. */
  diffusionModel?: string
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
   * (правка 938) Prompt enhancer: CLIP-файл qwen3.5_9b_*; '' или null — выключен
   * (запрос уходит модели как есть).
   */
  promptEnhancer?: string | null
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

/**
 * (правка 938) id нод энхансера промпта: CLIPLoader + TextGenerateV2 (текст модели)
 * + JsonExtractString (expanded_caption). Сеть ленивая: энхансер исполняется до
 * conditioning, а его результат уходит в `prompt` вместо сырого запроса.
 */
export const IMAGE_ENHANCER_CLIP_NODE_ID = '7:17'
export const IMAGE_ENHANCER_NODE_ID = '7:16'
export const IMAGE_ENHANCER_JSON_NODE_ID = '7:16j'
/** (правка 938) склейка «поднятый промпт + уточнение» для второго прохода. */
export const IMAGE_SUFFIX_NODE_ID = '7:16c'

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
  const steps = normalizeImageSteps(p.steps)
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
  // Картинка — без sparse-attention: она обучена на плотном внимании,
  // разреживание ломает композицию на одном кадре.
  modelChain['7:5'] = {
    inputs: { model: modelSrc, shift_video: 1.0, shift_audio: 1.0 },
    class_type: 'MiniMaxH3SigmaShift',
    _meta: { title: 'Sigma Shift 1.0/1.0' },
  }

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

  // (правка 938) Prompt enhancer — официальный: CLIPLoader(type minimax) на
  // qwen3.5_9b + TextGenerateV2 (thinking on) + JsonExtractString. Тексты
  // system/task-промптов и параметры генерации сгенерированы побайтово из
  // эталонных шаблонов (image-pe.ts).
  //
  // Для правок повторяем edit-шаблон: картинки идут в автогров `images`, а
  // размеры приводятся к кратности 32 через ResizeImageMaskNode — иначе
  // визуальные токены энкодера разъезжаются с латентом.
  //
  // API-формат TextGenerateV2/ResizeImageMaskNode: sampling_mode и resize_type —
  // DynamicCombo, поэтому их вложенные поля задаются ключами с точкой
  // (`sampling_mode.temperature`), как их видит ядро в get_finalized_class_inputs.
  const enhancer = (p.promptEnhancer ?? '').trim()
  const useEnhancer = Boolean(enhancer)
  if (useEnhancer) {
    const s = IMAGE_PE_SAMPLING
    const isEdit = refLinks.length > 0
    const enhancerInputs: Record<string, unknown> = {
      clip: [IMAGE_ENHANCER_CLIP_NODE_ID, 0],
      prompt: imagePePrompt(p.prompt, isEdit),
      system_prompt: IMAGE_PE_SYSTEM_PROMPT,
      max_length: s.max_length,
      sampling_mode: s.sampling_mode,
      'sampling_mode.temperature': s.temperature,
      'sampling_mode.top_k': s.top_k,
      'sampling_mode.top_p': s.top_p,
      'sampling_mode.min_p': s.min_p,
      'sampling_mode.repetition_penalty': s.repetition_penalty,
      'sampling_mode.presence_penalty': s.presence_penalty,
      'sampling_mode.seed': p.seed ?? 0,
      thinking: s.thinking,
      use_default_template: s.use_default_template,
      mtp: s.mtp,
    }
    if (isEdit) {
      refLinks.forEach((link, i) => {
        const resizeId = `7:pe${i + 1}`
        modelChain[resizeId] = {
          inputs: { input: link, resize_type: 'scale to multiple', 'resize_type.multiple': 32, scale_method: 'area' },
          class_type: 'ResizeImageMaskNode',
          _meta: { title: `Референс ${i + 1} для энхансера` },
        }
        enhancerInputs[`images.image${i + 1}`] = [resizeId, 0]
      })
    }
    modelChain[IMAGE_ENHANCER_CLIP_NODE_ID] = {
      inputs: { clip_name: enhancer, type: 'minimax', device: 'default' },
      class_type: 'CLIPLoader',
      _meta: { title: 'Prompt enhancer (CLIP)' },
    }
    modelChain[IMAGE_ENHANCER_NODE_ID] = {
      inputs: enhancerInputs,
      class_type: 'TextGenerateV2',
      _meta: { title: 'Prompt enhancer' },
    }
    modelChain[IMAGE_ENHANCER_JSON_NODE_ID] = {
      inputs: { json_string: [IMAGE_ENHANCER_NODE_ID, 0], key: IMAGE_PE_JSON_KEY },
      class_type: 'JsonExtractString',
      _meta: { title: 'expanded_caption из JSON' },
    }
  }
  const pass1Prompt: unknown = useEnhancer ? [IMAGE_ENHANCER_JSON_NODE_ID, 0] : p.prompt

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
  const pass2Nodes: Record<string, unknown> = {}
  // (правка 938) Уточнение второго прохода приклеивается к уже поднятому
  // энхансером промпту (StringConcatenate), иначе короткий уточняющий текст
  // затирал бы подробное описание первого прохода.
  let pass2Prompt: unknown = pass1Prompt
  if (mode !== 'off' && needCond2) {
    if (suffix && useEnhancer) {
      pass2Nodes[IMAGE_SUFFIX_NODE_ID] = {
        inputs: { string_a: [IMAGE_ENHANCER_JSON_NODE_ID, 0], string_b: suffix, delimiter: '\n' },
        class_type: 'StringConcatenate',
        _meta: { title: 'Промпт 2-го прохода' },
      }
      pass2Prompt = [IMAGE_SUFFIX_NODE_ID, 0]
    } else if (suffix) {
      pass2Prompt = `${p.prompt.trim()}\n${suffix}`
    }
  }

  // Масштабирование базы нужно только при различии размеров; метод lanczos —
  // как в cn_prescale: он не добавляет ringing, который второй проход усилил бы.
  const needScale = mode !== 'off' && (width !== finalW || height !== finalH)
  if (mode !== 'off') {
    if (needCond2) {
      pass2Nodes[IMAGE_COND2_NODE_ID] = {
        inputs: condInputs(pass2Prompt, finalW, finalH),
        class_type: 'PH3ImageConditioning',
        _meta: { title: 'MiniMax H3 Image Conditioning (проход 2)' },
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
      _meta: { title: 'MiniMax H3 Image Conditioning' },
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
      // (правка 938) Как в официальном шаблоне: сетку сигм считает BasicScheduler
      // по собственной таблице модели. Ручной ManualSigmas ушёл вместе с LoRA-путём.
      inputs: { model: ['7:5', 0], scheduler: 'simple', steps, denoise: 1.0 },
      class_type: 'BasicScheduler',
      _meta: { title: `Сигмы (${steps} шаг(ов), simple)` },
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
