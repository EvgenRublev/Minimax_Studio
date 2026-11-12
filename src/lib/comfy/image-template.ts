/**
 * (РїСЂР°РІРєРё 929, 938) Р‘РёР»РґРµСЂ РІРѕСЂРєС„Р»РѕСѓ В«РР·РѕР±СЂР°Р¶РµРЅРёРµВ» вЂ” РѕС„РёС†РёР°Р»СЊРЅР°СЏ MiniMax H3 Image
 * (Comfy-Org/MiniMax-H3-Image).
 *
 * Р“СЂР°С„ СЃРѕР±РёСЂР°РµС‚СЃСЏ РІ API-С„РѕСЂРјР°С‚Рµ (РєР°Рє minimax-h3-template.ts):
 *
 *   UNETLoader(minimax_h3_image_pruned_*) в†’ [LowVRAM] в†’ [ChunkFF] в†’ MiniMaxH3SigmaShift(1/1)
 *   CLIPLoader(type=minimax, qwen3vl_32b_minimax_h3_*) + VAELoader(minimax_h3_image_vae_fp16)
 *   [enhancer] CLIPLoader(qwen3.5_9b_w4a8_gptq) в†’ TextGenerateV2 в†’ JsonExtractString
 *        в†’ PH3ImageConditioning(prompt, width, height, image_1..image_N)
 *        в†’ BasicGuider + BasicScheduler(simple) + KSamplerSelect(euler) в†’ SamplerCustomAdvanced
 *        в†’ LTXVSeparateAVLatent в†’ VAEDecode в†’ SaveImage
 *
 * РџРѕС‡РµРјСѓ С‚Р°Рє:
 *  вЂў `PH3ImageConditioning` вЂ” image-РЅРѕРґР° СЏРґСЂР° 0.44 (РІ СЃРІРµР¶РµРј СЏРґСЂРµ РµС‘ РїРµСЂРµРёРјРµРЅРѕРІР°Р»Рё
 *    РІ `MiniMaxH3ImageConditioning`, РєР°Рє РІ СЌС‚Р°Р»РѕРЅРЅРѕРј С€Р°Р±Р»РѕРЅРµ Comfy-Org; РІ
 *    API-С„РѕСЂРјР°С‚Рµ РІС…РѕРґС‹ Р·Р°РґР°СЋС‚СЃСЏ РїРѕ РёРјРµРЅР°Рј, РїРѕСЌС‚РѕРјСѓ РіСЂР°С„ РїРµСЂРµРЅРѕСЃРёС‚СЃСЏ РѕРґРёРЅ РІ РѕРґРёРЅ).
 *    Р•С‘ РІС‹С…РѕРґ-Р»Р°С‚РµРЅС‚ вЂ” РѕР±С‹С‡РЅС‹Р№ AV-Р»Р°С‚РµРЅС‚ H3 (РІРёРґРµРѕ-С‡Р°СЃС‚СЊ = РѕРґРёРЅ РєР°РґСЂ), РїРѕСЌС‚РѕРјСѓ
 *    РґРµРєРѕРґ РёРґС‘С‚ С‡РµСЂРµР· LTXVSeparateAVLatent + VAEDecode, РєР°Рє РІ РІРёРґРµРѕ-РїР°Р№РїР»Р°Р№РЅРµ.
 *  вЂў Sigma Shift РґР»СЏ РєР°СЂС‚РёРЅРєРё = 1.0/1.0 (РЅРµ 12/3, РєР°Рє РІ РІРёРґРµРѕ) вЂ” С‚СЂРµР±СѓРµС‚ СЃР°РјР° РЅРѕРґР°.
 *  вЂў DiT вЂ” РѕС‚РґРµР»СЊРЅР°СЏ image-РјРѕРґРµР»СЊ (`minimax_h3_image_pruned_*`). РџСѓС‚СЊ В«РІРёРґРµРѕ-РјРѕРґРµР»СЊ
 *    + LoRA p-h3-imageВ» РѕС‚РєР»СЋС‡С‘РЅ (РїСЂР°РІРєР° 938): РѕС„РёС†РёР°Р»СЊРЅР°СЏ РјРѕРґРµР»СЊ Р»РµРіС‡Рµ (w4a8 вЂ”
 *    12.5 Р“Р‘ РїСЂРѕС‚РёРІ 14.8 + 1.9 Р·Р° LoRA) Рё СЌС‚Рѕ С‚Рµ Р¶Рµ РІРµСЃР°, РёР· РєРѕС‚РѕСЂС‹С… PrunaAI РґРµР»Р°Р»Р°
 *    СЃРІРѕР№ LoRA-СЂРµРїР°РєРµС‚.
 *  вЂў РўРµРєСЃС‚РѕРІС‹Р№ СЌРЅРєРѕРґРµСЂ вЂ” РѕР±С‰РёР№ СЃ РІРёРґРµРѕ `qwen3vl_32b_minimax_h3_*`: РёРјРµРЅРЅРѕ РѕРЅ СЃС‚РѕРёС‚
 *    РІ РѕС„РёС†РёР°Р»СЊРЅРѕРј image-С€Р°Р±Р»РѕРЅРµ (32B Qwen3-VL + СЃРІРѕР№ text_connector Сѓ РјРѕРґРµР»Рё РІРЅСѓС‚СЂРё
 *    DiT). VAE вЂ” СЃРІРѕР№, image-РЅС‹Р№.
 *  вЂў РЎСЌРјРїР»РёСЂРѕРІР°РЅРёРµ вЂ” `BasicScheduler(scheduler: simple)` + euler, 6 С€Р°РіРѕРІ РїРѕ
 *    СѓРјРѕР»С‡Р°РЅРёСЋ: РІ СЌС‚Р°Р»РѕРЅРµ СЌС‚Рѕ `KSampler(euler, simple, 6 С€Р°РіРѕРІ, cfg 1)`, Р° cfg 1 Сѓ РЅР°СЃ
 *    Рё С‚Р°Рє РѕР·РЅР°С‡Р°РµС‚ В«Р±РµР· CFGВ» (BasicGuider Р±РµР· negative).
 *  вЂў Prompt enhancer вЂ” РїРѕ РєР°СЂС‚РѕС‡РєРµ РјРѕРґРµР»Рё РѕР±СЏР·Р°С‚РµР»РµРЅ: H3 Image С‡СѓРІСЃС‚РІРёС‚РµР»СЊРЅР° Рє
 *    С„РѕСЂРјСѓР»РёСЂРѕРІРєР°Рј. Р Р°Р±РѕС‚Р°РµС‚ РІРЅСѓС‚СЂРё ComfyUI (CLIPLoader + TextGenerateV2 +
 *    JsonExtractString), РїСЂРѕРјРїС‚С‹ РІР·СЏС‚С‹ РґРѕСЃР»РѕРІРЅРѕ РёР· СЌС‚Р°Р»РѕРЅРЅС‹С… С€Р°Р±Р»РѕРЅРѕРІ (image-pe.ts).
 *
 * (РїСЂР°РІРєР° 935) РћРїС†РёРѕРЅР°Р»СЊРЅРѕ РіСЂР°С„ РґРѕСЃС‚СЂР°РёРІР°РµС‚СЃСЏ РІС‚РѕСЂС‹Рј РїСЂРѕС…РѕРґРѕРј:
 *
 *   вЂ¦VAEDecode(pass 1) в†’ [ImageScale в†’ РёС‚РѕРі] в†’ H3InjectVideoLatent(РЅСѓР»РµРІРѕР№ AV-Р»Р°С‚РµРЅС‚
 *   РЅСѓР¶РЅРѕРіРѕ СЂР°Р·РјРµСЂР° РёР· PH3ImageConditioning) в†’ BasicGuider + BasicScheduler(simple,
 *   steps/denoise РІС‚РѕСЂРѕРіРѕ РїСЂРѕС…РѕРґР°) в†’ SamplerCustomAdvanced в†’ VAEDecode в†’ SaveImage
 *
 * Р Р°Р·РјРµСЂ РёР· `width`/`height` РїСЂРё СЌС‚РѕРј С‚СЂР°РєС‚СѓРµС‚СЃСЏ РєР°Рє РРўРћР“РћР’Р«Р™: Р±Р°Р·Р° СЃС‡РёС‚Р°РµС‚СЃСЏ РёР·
 * `baseScale`, РїРѕСЌС‚РѕРјСѓ РґРІСѓС…РїСЂРѕС…РѕРґРЅС‹Р№ СЂРµР¶РёРј РЅРµ Р»РѕРјР°РµС‚ С‚РѕС‡РЅРѕСЃС‚СЊ СЂР°Р·СЂРµС€РµРЅРёР№ (РїСЂР°РІРєР° 930).
 */

/**
 * (РїСЂР°РІРєР° 938) Р¤Р°Р№Р»С‹ РѕС„РёС†РёР°Р»СЊРЅРѕР№ MiniMax H3 Image (Comfy-Org/MiniMax-H3-Image).
 * w4a8 вЂ” СЃР°РјР°СЏ Р»С‘РіРєР°СЏ РёР· С‚СЂС‘С… РєРІР°РЅС‚РёР·Р°С†РёР№ (12.5 Р“Р‘): РЅР° 24 Р“Р‘ РєР°СЂС‚Рµ РѕРЅР° РІ РїСЂРёРѕСЂРµС‚Рµ.
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
 * РўРµРєСЃС‚РѕРІС‹Р№ СЌРЅРєРѕРґРµСЂ РІ РѕС„РёС†РёР°Р»СЊРЅРѕРј image-РІРѕСЂРєС„Р»РѕСѓ вЂ” С‚РѕС‚ Р¶Рµ 32B Qwen3-VL, С‡С‚Рѕ Рё РІ
 * РІРёРґРµРѕ (nvfp4_awq Сѓ РЅР°СЃ СѓР¶Рµ СЃРєР°С‡Р°РЅ РїРѕРґ РІРёРґРµРѕ, int8_convrot вЂ” С†РµР»РµРµ, РЅРѕ 27 Р“Р‘).
 */
export const DEFAULT_IMAGE_TEXT_ENCODER = 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'
export const IMAGE_TEXT_ENCODER_CANDIDATES = [
  'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
  'qwen3vl_32b_minimax_h3_int8_convrot.safetensors',
] as const

/** Image-РЅС‹Р№ VAE: fp16, РІСЃРµРіРѕ 1.17 Р“Р‘ вЂ” РґРµС€РµРІР»Рµ PrunaAI-РІР°СЂРёР°РЅС‚Р°. */
export const DEFAULT_IMAGE_VAE = 'minimax_h3_image_vae_fp16.safetensors'

/**
 * (РїСЂР°РІРєР° 938) Prompt enhancer вЂ” РѕС„РёС†РёР°Р»СЊРЅР°СЏ СЂРµРєРѕРјРµРЅРґР°С†РёСЏ РєР°СЂС‚РѕС‡РєРё: qwen3.5_9b
 * c TextGenerateV2. Р§РµСЂРµР· РЅР°С€РµРіРѕ LLM-Р°СЃСЃРёСЃС‚РµРЅС‚Р° РЅРµР»СЊР·СЏ: /api/llm/chat РїРµСЂРµРґ
 * СЃС‚Р°СЂС‚РѕРј Р·РѕРІС‘С‚ evictComfyVerified() Рё РІС‹СЃР°Р¶РёРІР°РµС‚ ComfyUI.
 */
export const DEFAULT_IMAGE_PROMPT_ENHANCER = 'qwen3.5_9b_w4a8_gptq.safetensors'
export const IMAGE_PE_CANDIDATES = ['qwen3.5_9b_w4a8_gptq.safetensors', 'qwen3.5_9b_w4a8.safetensors'] as const

export const isImageDiT = (name: string): boolean => /minimax_h3_image/i.test(name)
export const isImageTextEncoder = (name: string): boolean => /qwen3vl_32b_minimax_h3/i.test(name)
export const isImageVae = (name: string): boolean => /h3_image_vae|h3-image-vae/i.test(name)
export const isImagePromptEnhancer = (name: string): boolean => /qwen3(\.5)?_9b/i.test(name)

/** РњР°РєСЃРёРјСѓРј РєР°СЂС‚РёРЅРѕРє РІ PH3ImageConditioning: image_1 (С‡С‚Рѕ РїСЂР°РІРёРј) + 7 СЂРµС„РµСЂРµРЅСЃРѕРІ. */
export const IMAGE_MAX_REFERENCES = 8

/**
 * (РїСЂР°РІРєР° 938) Р§РёСЃР»Рѕ С€Р°РіРѕРІ РїРµСЂРІРѕРіРѕ РїСЂРѕС…РѕРґР°. Р’ СЌС‚Р°Р»РѕРЅРЅРѕРј С€Р°Р±Р»РѕРЅРµ Comfy-Org СЃС‚РѕРёС‚
 * `KSampler(euler, simple, 6 С€Р°РіРѕРІ, cfg 1)` вЂ” С‚Рѕ РµСЃС‚СЊ СЃРµС‚РєСѓ СЃС‡РёС‚Р°РµС‚ РїР»Р°РЅРёСЂРѕРІС‰РёРє РїРѕ
 * СЃРѕР±СЃС‚РІРµРЅРЅРѕР№ С‚Р°Р±Р»РёС†Рµ СЃРёРіРј РјРѕРґРµР»Рё, Р° РЅРµ РІСЂСѓС‡РЅСѓСЋ. Р СѓС‡РЅР°СЏ СЃРµС‚РєР° PrunaAI (8 С‚РѕС‡РµРє)
 * СѓС€Р»Р° РІРјРµСЃС‚Рµ СЃ LoRA-РїСѓС‚С‘Рј.
 */
export const IMAGE_STEPS = [4, 6, 8, 10, 12] as const
export const DEFAULT_IMAGE_STEPS = 6
export const IMAGE_STEPS_LABELS: Record<string, string> = {
  '4': '4 С€Р°РіР° вЂ” Р±С‹СЃС‚СЂС‹Р№ РїСЂРѕРіРѕРЅ',
  '6': '6 С€Р°РіРѕРІ вЂ” РєР°Рє РІ РѕС„РёС†РёР°Р»СЊРЅРѕРј С€Р°Р±Р»РѕРЅРµ',
  '8': '8 С€Р°РіРѕРІ',
  '10': '10 С€Р°РіРѕРІ',
  '12': '12 С€Р°РіРѕРІ вЂ” РјР°РєСЃРёРјСѓРј РґРµС‚Р°Р»РµР№',
}
/** Р—Р°Р¶РёРј РґР»СЏ Р·РЅР°С‡РµРЅРёСЏ РёР·РІРЅРµ (UI/СЂРѕСѓС‚): 1вЂ¦20, РїРѕ СѓРјРѕР»С‡Р°РЅРёСЋ РѕС„РёС†РёР°Р»СЊРЅС‹Р№ 6. */
export function normalizeImageSteps(v: unknown): number {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.min(20, Math.max(1, n)) : DEFAULT_IMAGE_STEPS
}

/**
 * РџСЂРµСЃРµС‚С‹ СЂР°Р·РјРµСЂРѕРІ. РљСЂР°С‚РЅРѕСЃС‚СЊ 32 РѕР±СЏР·Р°С‚РµР»СЊРЅР° (CANVAS_MULTIPLE РІ image-РЅРѕРґРµ),
 * РїРѕСЌС‚РѕРјСѓ Р·РЅР°С‡РµРЅРёСЏ РІР·СЏС‚С‹ РёР· РѕС„РёС†РёР°Р»СЊРЅРѕР№ С‚Р°Р±Р»РёС†С‹ СЂР°Р·СЂРµС€РµРЅРёР№, Р° РЅРµ В«РєСЂСѓРіР»С‹РµВ».
 *
 * (РїСЂР°РІРєР° 938) РљР°СЂС‚РѕС‡РєР° MiniMax-H3-Image: СЂР°Р±РѕС‡Р°СЏ РѕР±Р»Р°СЃС‚СЊ РјРѕРґРµР»Рё 4вЂ¦20 РњРџ, Р»СѓС‡С€Рµ
 * РІСЃРµРіРѕ ~16 РњРџ. РЎС‚СЂРѕРєР° 16 РњРџ вЂ” РґРѕСЃР»РѕРІРЅРѕ РѕС„РёС†РёР°Р»СЊРЅР°СЏ С‚Р°Р±Р»РёС†Р° Comfy-Org, СЃС‚СЂРѕРєРё
 * 4 Рё 8 РњРџ вЂ” С‚Р°Р±Р»РёС†Р° PrunaAI (РѕРЅРё Р¶Рµ Сѓ РЅР°СЃ РїСЂРёР¶РёР»РёСЃСЊ РєР°Рє В«Р±С‹СЃС‚СЂС‹РµВ»), РѕСЃС‚Р°Р»СЊРЅС‹Рµ
 * СЃС‡РёС‚Р°СЋС‚СЃСЏ: СЃС‚РѕСЂРѕРЅР° РєСЂР°С‚РЅР° 32, РјРёРЅРёРјСѓРј РѕС‚РєР»РѕРЅРµРЅРёСЏ РїСЂРѕРїРѕСЂС†РёРё, Р·Р°С‚РµРј РїР»РѕС‰Р°РґРё.
 * РќРёР¶Рµ 2 РњРџ Р»РёС†Рѕ В«РїР»С‹РІС‘С‚В» СѓР¶Рµ РёР·-Р·Р° СЂР°Р·СЂРµС€РµРЅРёСЏ.
 */
export const IMAGE_ASPECTS = ['1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16', '21:9'] as const

/** РњРµРіР°РїРёРєСЃРµР»СЊРЅС‹Рµ СЃС‚СѓРїРµРЅРё (РєР»СЋС‡Рё вЂ” СЃС‚СЂРѕРєРё, РѕРЅРё Р¶Рµ РІ СЃС‚РѕСЂРµ Рё РІ UI). */
export const IMAGE_MEGAPIXELS = [
  '0.5', '1', '1.5', '2', '2.5', '3', '4', '5', '6', '7', '8', '10', '12', '16',
] as const

/** РћС„РёС†РёР°Р»СЊРЅС‹Рµ СЃС‚СЂРѕРєРё С‚Р°Р±Р»РёС† Comfy-Org (16 РњРџ) Рё PrunaAI (4/8 РњРџ) вЂ” РЅРµ РїРµСЂРµСЃС‡РёС‚С‹РІР°РµРј. */
const IMAGE_SIZES_OFFICIAL: Record<string, Record<string, [number, number]>> = {
  // 4 РњРџ вЂ” РґРµС„РѕР»С‚ РѕС„РёС†РёР°Р»СЊРЅРѕРіРѕ С€Р°Р±Р»РѕРЅР° Рё СЂРµРєРѕРјРµРЅРґСѓРµРјС‹Р№ СЂРµР¶РёРј РґР»СЏ РїСЂР°РІРѕРє
  '4': {
    '1:1': [2048, 2048],
    '4:3': [2368, 1760],
    '3:4': [1760, 2368],
    '3:2': [2496, 1664],
    '2:3': [1664, 2496],
    '16:9': [2720, 1536],
    '9:16': [1536, 2720],
  },
  // 8 РњРџ вЂ” РѕРїС‚РёРјСѓРј РїРѕ СЃРєРѕСЂРѕСЃС‚Рё РЅР° 24 Р“Р‘
  '8': {
    '1:1': [2912, 2912],
    '4:3': [3360, 2496],
    '3:4': [2496, 3360],
    '3:2': [3552, 2368],
    '2:3': [2368, 3552],
    '16:9': [3872, 2176],
    '9:16': [2176, 3872],
  },
  // 16 РњРџ вЂ” СЂРµРєРѕРјРµРЅРґРѕРІР°РЅРЅС‹Р№ СЂРµР¶РёРј РєР°С‡РµСЃС‚РІР° (С‚Р°Р±Р»РёС†Р° РёР· РєР°СЂС‚РѕС‡РєРё Comfy-Org)
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
 * Р”РёР°РїР°Р·РѕРЅ СЃС‚РѕСЂРѕРЅС‹: РЅРёР¶РЅСЏСЏ вЂ” С‡С‚РѕР±С‹ Р»Р°С‚РµРЅС‚ РЅРµ СЃС…Р»РѕРїРЅСѓР»СЃСЏ, РІРµСЂС…РЅСЏСЏ вЂ” РїРѕРґ РѕС„РёС†РёР°Р»СЊРЅСѓСЋ
 * 16-РјРµРіР°РїРёРєСЃРµР»СЊРЅСѓСЋ С‚Р°Р±Р»РёС†Сѓ (С‚Р°Рј 6272 РїРѕ РґР»РёРЅРЅРѕР№ СЃС‚РѕСЂРѕРЅРµ). РЇРґСЂРѕ СЂР°Р·СЂРµС€Р°РµС‚ РґРѕ
 * MAX_RESOLUTION=16384, РІР°Р»РёРґР°С†РёСЏ API-СЂРѕСѓС‚Р° РѕР±СЏР·Р°РЅР° СЃРѕРІРїР°РґР°С‚СЊ СЃ СЌС‚РёРј Р·РЅР°С‡РµРЅРёРµРј.
 */
const SIDE_MIN = 256
const SIDE_MAX = 8192

function aspectParts(aspect: string): [number, number] {
  const [w, h] = aspect.split(':').map((n) => Number(n))
  if (!w || !h) return [1, 1]
  return [w, h]
}

/**
 * РџРѕРґР±РѕСЂ РїР°СЂС‹ (w, h), РєСЂР°С‚РЅРѕР№ 32, РґР»СЏ С†РµР»Рё mp*1e6 РїСЂРё РґР°РЅРЅРѕР№ РїСЂРѕРїРѕСЂС†РёРё.
 * РџРµСЂРµР±РѕСЂ СЃРѕСЃРµРґРµР№ РІРѕРєСЂСѓРі С‚РµРѕСЂРµС‚РёС‡РµСЃРєРѕРіРѕ СЂР°Р·РјРµСЂР°: СЃРЅР°С‡Р°Р»Р° РјРёРЅРёРјРёР·РёСЂСѓРµРј РѕС€РёР±РєСѓ
 * РїСЂРѕРїРѕСЂС†РёРё, РїСЂРё СЂР°РІРµРЅСЃС‚РІРµ вЂ” РѕС€РёР±РєСѓ РїР»РѕС‰Р°РґРё.
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
    // РћС„РёС†РёР°Р»СЊРЅС‹Рµ СЃС‚СЂРѕРєРё РЅРµ РїРµСЂРµСЃС‡РёС‚С‹РІР°РµРј; С‡РµРіРѕ РІ РЅРёС… РЅРµС‚ (РЅР°РїСЂРёРјРµСЂ 21:9 РІ
    // С‚Р°Р±Р»РёС†Рµ PrunaAI) вЂ” СЃС‡РёС‚Р°РµС‚СЃСЏ РѕР±С‰РёРј РїСЂР°РІРёР»РѕРј.
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

/** РџРѕРґРїРёСЃСЊ СЃС‚СѓРїРµРЅРё РІ СЃРµР»РµРєС‚РѕСЂРµ: В«2 РњРџ вЂ” 2016Г—1008В». */
export function imageQualityLabel(mp: string, aspect: string): string {
  const [w, h] = IMAGE_SIZES[mp]?.[aspect] ?? [0, 0]
  return `${mp} РњРџ вЂ” ${w}Г—${h}`
}

/** РљР»СЋС‡ СЃС‚СѓРїРµРЅРё СЂР°Р·СЂРµС€РµРЅРёСЏ: '0.5' | '1' | вЂ¦ | '8'. */
export type ImageQualityKey = (typeof IMAGE_MEGAPIXELS)[number]

/** Р”РµР№СЃС‚РІСѓСЋС‰Р°СЏ СЃС‚СѓРїРµРЅСЊ: СЃРѕС…СЂР°РЅС‘РЅРЅРѕРµ Р·РЅР°С‡РµРЅРёРµ РјРѕРіР»Рѕ Р±С‹С‚СЊ СѓРґР°Р»РµРЅРѕ РёР· СЃРїРёСЃРєР°. */
export function normalizeImageQuality(q: string | undefined): ImageQualityKey {
  return q && IMAGE_SIZES[q] ? (q as ImageQualityKey) : '4'
}

export const IMAGE_MP_HINT: Record<string, string> = {
  '0.5': 'С‚РµСЃС‚ РїСЂРѕРїРѕСЂС†РёР№/РєРѕРјРїРѕР·РёС†РёРё, РѕС‡РµРЅСЊ Р±С‹СЃС‚СЂРѕ',
  '1': 'СЌСЃРєРёР·',
  '2': 'РЅРёР·РєРѕРµ: Р»РёС†Рѕ РЅР°С‡РёРЅР°РµС‚ В«РїР»С‹С‚СЊВ»',
  '3': 'РЅРёР·РєРѕРµ-СЃСЂРµРґРЅРµРµ',
  '4': 'РґРµС„РѕР»С‚ РѕС„РёС†РёР°Р»СЊРЅРѕРіРѕ С€Р°Р±Р»РѕРЅР°',
  '5': 'СЃСЂРµРґРЅРµ-РІС‹СЃРѕРєРѕРµ',
  '6': 'РІС‹СЃРѕРєРѕРµ',
  '7': 'РІС‹СЃРѕРєРѕРµ',
  '8': 'РѕС„РёС†РёР°Р»СЊРЅС‹Р№ СЂРµР¶РёРј РїСЂР°РІРѕРє Рё Р±С‹СЃС‚СЂС‹Р№ С‚РµРєСЃС‚',
  '10': 'РІС‹СЃРѕРєРѕРµ, Р±Р»РёР¶Рµ Рє РѕРїС‚РёРјСѓРјСѓ РјРѕРґРµР»Рё',
  '12': 'РѕС‡РµРЅСЊ РІС‹СЃРѕРєРѕРµ',
  '16': 'СЂРµРєРѕРјРµРЅРґРѕРІР°РЅРЅРѕРµ РєР°С‡РµСЃС‚РІРѕ РѕС„РёС†РёР°Р»СЊРЅРѕР№ РєР°СЂС‚РѕС‡РєРё (4вЂ¦20 РњРџ)',
}


export interface ImageGenParams {
  prompt: string
  /** Side of the canvas; must be a multiple of 32 (РѕРєСЂСѓРіР»СЏРµРј СЃР°РјРё). */
  width: number
  height: number
  /** (РїСЂР°РІРєР° 938) РЁР°РіРѕРІ РїРµСЂРІРѕРіРѕ РїСЂРѕС…РѕРґР°; СЃРµС‚РєСѓ СЃС‡РёС‚Р°РµС‚ BasicScheduler(simple). */
  steps?: number
  seed?: number
  /** DiT: РѕС„РёС†РёР°Р»СЊРЅР°СЏ image-РјРѕРґРµР»СЊ minimax_h3_image_pruned_*. */
  diffusionModel?: string
  textEncoder?: string
  vae?: string
  /** Р¤Р°Р№Р»С‹ РІ ComfyUI/input/. image_1 вЂ” СЂРµРґР°РєС‚РёСЂСѓРµРјРѕРµ РёР·РѕР±СЂР°Р¶РµРЅРёРµ. */
  references?: string[]
  /** MiniMaxLowVRAMAttention / MiniMaxChunkFeedForward вЂ” РєР°Рє РІ РІРёРґРµРѕ-С€Р°Р±Р»РѕРЅРµ. */
  lowVramAttention?: boolean
  chunkFeedForward?: boolean
  chunkFFChunks?: number
  chunkFFThreshold?: number
  filenamePrefix?: string
  /**
   * (РїСЂР°РІРєР° 938) Prompt enhancer: CLIP-С„Р°Р№Р» qwen3.5_9b_*; '' РёР»Рё null вЂ” РІС‹РєР»СЋС‡РµРЅ
   * (Р·Р°РїСЂРѕСЃ СѓС…РѕРґРёС‚ РјРѕРґРµР»Рё РєР°Рє РµСЃС‚СЊ).
   */
  promptEnhancer?: string | null
  /**
   * (РїСЂР°РІРєР° 935) 'off' | 'detail' | 'upscale' вЂ” СЃРј. IMAGE_TWO_PASS_MODES.
   * width/height РїСЂРё СЌС‚РѕРј РѕР·РЅР°С‡Р°СЋС‚ РРўРћР“РћР’Р«Р™ СЂР°Р·РјРµСЂ; Р±Р°Р·Р° СЃС‡РёС‚Р°РµС‚СЃСЏ РёР· baseScale.
   */
  twoPass?: ImageTwoPassMode
  /** РЎРєРѕР»СЊРєРѕ СЂР°Р· СЃС‚РѕСЂРѕРЅС‹ Р±Р°Р·РѕРІРѕРіРѕ РїСЂРѕС…РѕРґР° РјРµРЅСЊС€Рµ РёС‚РѕРіРѕРІС‹С… (1 = С‚РѕС‚ Р¶Рµ СЂР°Р·РјРµСЂ). */
  baseScale?: number
  /** РЎРёР»Р° РІС‚РѕСЂРѕРіРѕ РїСЂРѕС…РѕРґР° (0вЂ¦1): 0.2 вЂ” РїРѕС‡С‚Рё С‚РѕР»СЊРєРѕ Р·РµСЂРЅРѕ, 0.6 вЂ” РїРµСЂРµРїРёСЃС‹РІР°РµС‚ Р»РёС†Рѕ. */
  denoise2?: number
  /** РЁР°РіРѕРІ РІС‚РѕСЂРѕРіРѕ РїСЂРѕС…РѕРґР°. */
  steps2?: number
  /**
   * Р”РѕРїРѕР»РЅРёС‚РµР»СЊРЅР°СЏ С„РѕСЂРјСѓР»РёСЂРѕРІРєР° РґР»СЏ РІС‚РѕСЂРѕРіРѕ РїСЂРѕС…РѕРґР°: Рє Р·Р°РїСЂРѕСЃСѓ РґРѕР±Р°РІР»СЏРµС‚СЃСЏ
   * РІС‚РѕСЂР°СЏ СЃС‚СЂРѕРєР°, Р°РїСЃРµРјРїР»РµСЂ РїСЂРё СЌС‚РѕРј РЅРµ РїРµСЂРµР·Р°РїСѓСЃРєР°РµС‚СЃСЏ. '' вЂ” РІС‚РѕСЂРѕР№ РїСЂРѕС…РѕРґ
   * РёСЃРїРѕР»СЊР·СѓРµС‚ С‚РѕС‚ Р¶Рµ С‚РµРєСЃС‚, С‡С‚Рѕ Рё РїРµСЂРІС‹Р№.
   */
  prompt2?: string
}

/**
 * (РїСЂР°РІРєР° 935) РќРѕСЂРјР°Р»РёР·Р°С†РёСЏ РїР°СЂР°РјРµС‚СЂРѕРІ РґРІСѓС…РїСЂРѕС…РѕРґРЅРѕРіРѕ СЂРµР¶РёРјР°: РІСЃС‘, С‡С‚Рѕ РїСЂРёСЃС‹Р»Р°РµС‚
 * С„СЂРѕРЅС‚ Рё С‡С‚Рѕ РїРѕРїР°РґР°РµС‚ РІ РІРѕСЂРєС„Р»РѕСѓ, РїСЂРѕС…РѕРґРёС‚ С‡РµСЂРµР· СЌС‚Сѓ С„СѓРЅРєС†РёСЋ.
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
 * (РїСЂР°РІРєР° 935) Р”РІР° РїСЂРѕС…РѕРґР°. H3 РІСЃРµРіРґР° СЃС‚СЂРѕРёС‚ РЅСѓР»РµРІРѕР№ Р»Р°С‚РµРЅС‚, РїРѕСЌС‚РѕРјСѓ В«РІС‚РѕСЂРѕР№
 * РїСЂРѕС…РѕРґВ» СЃРѕР±РёСЂР°РµС‚СЃСЏ С‚Р°Рє Р¶Рµ, РєР°Рє РІ РІРёРґРµРѕ-СЂРµР¶РёРјР°С…: СЂРµР·СѓР»СЊС‚Р°С‚ РїРµСЂРІРѕРіРѕ РїСЂРѕС…РѕРґР°
 * РґРµРєРѕРґРёСЂСѓРµС‚СЃСЏ, РїСЂРё РЅРµРѕР±С…РѕРґРёРјРѕСЃС‚Рё СЂР°СЃС‚СЏРіРёРІР°РµС‚СЃСЏ РґРѕ С†РµР»РµРІРѕРіРѕ СЂР°Р·РјРµСЂР°, РєРѕРґРёСЂСѓРµС‚СЃСЏ
 * image-VAE Рё РІРЅРµРґСЂСЏРµС‚СЃСЏ РІ РІРёРґРµРѕ-РїРѕС‚РѕРє AV-Р»Р°С‚РµРЅС‚Р° (`H3InjectVideoLatent` РёР·
 * РїР°РєР° ComfyUI-H3-FaceRefine, РѕРЅ Р¶Рµ РІ install/nodes.json), Р° СЃСЌРјРїР»РµСЂ РґРѕС…РѕРґРёС‚
 * РµРіРѕ СЃРЅРёР·Сѓ СЃРµС‚РєРё СЃРёРіРј вЂ” С‚Рѕ РµСЃС‚СЊ РµСЃС‚СЊ РѕР±С‹С‡РЅС‹Р№ img2img.
 *
 *  вЂў 'detail' вЂ” РѕР±Рµ РїСЂРѕС…РѕРґРєРё РІ РѕРґРЅРѕРј СЂР°Р·СЂРµС€РµРЅРёРё: РєРѕРјРїРѕР·РёС†РёСЏ Р·Р°С„РёРєСЃРёСЂРѕРІР°РЅР°,
 *    РІС‚РѕСЂРѕР№ РїСЂРѕС…РѕРґ С‚РѕР»СЊРєРѕ РґРѕСЂРёСЃРѕРІС‹РІР°РµС‚ РґРµС‚Р°Р»Рё (РіР»Р°Р·Р°, С‚РµРєСЃС‚СѓСЂС‹, СЂСѓРєРё).
 *  вЂў 'upscale' вЂ” РїРµСЂРІС‹Р№ РїСЂРѕС…РѕРґ РІ СѓРјРµРЅСЊС€РµРЅРЅРѕРј Р±Р°Р·РѕРІРѕРј СЂР°Р·СЂРµС€РµРЅРёРё (С‚Р°Рј РјРѕРґРµР»СЊ
 *    СѓСЃС‚РѕР№С‡РёРІРµРµ Рё Р±С‹СЃС‚СЂРµРµ), РІС‚РѕСЂРѕР№ вЂ” РІ РІС‹Р±СЂР°РЅРЅРѕРј С†РµР»РµРІРѕРј.
 *
 * РЎРёР»Р° РІС‚РѕСЂРѕРіРѕ РїСЂРѕС…РѕРґР° вЂ” `denoise` + С‡РёСЃР»Рѕ С€Р°РіРѕРІ С‡РµСЂРµР· `BasicScheduler`
 * ('simple'), РєР°Рє РІ tile-upscale Рё Face Refine: РѕРЅ Р±РµСЂС‘С‚ РЅРёР¶РЅРёР№ С…РІРѕСЃС‚ РїРѕР»РЅРѕР№
 * СЃРµС‚РєРё, РїРѕСЌС‚РѕРјСѓ С€Р°РіРё Рё СЃРёР»Р° РЅРµР·Р°РІРёСЃРёРјС‹ (РІ РѕС‚Р»РёС‡РёРµ РѕС‚ РѕР±СЂРµР·РєРё ManualSigmas вЂ”
 * СЃРј. docstring H3InjectVideoLatent).
 */
export const IMAGE_TWO_PASS_MODES = ['off', 'detail', 'upscale'] as const
export type ImageTwoPassMode = (typeof IMAGE_TWO_PASS_MODES)[number]
export const IMAGE_TWO_PASS_LABELS: Record<string, string> = {
  off: 'РћРґРёРЅ РїСЂРѕС…РѕРґ',
  detail: 'Р”РІР° РїСЂРѕС…РѕРґР° вЂ” РґРµС‚Р°Р»Рё РїРѕРІРµСЂС… РѕСЃРЅРѕРІС‹',
  upscale: 'Р”РІР° РїСЂРѕС…РѕРґР° вЂ” Р±Р°Р·Р° РјРµРЅСЊС€Рµ, РёС‚РѕРі РєСЂСѓРїРЅРµРµ',
}
/** Р’Рѕ СЃРєРѕР»СЊРєРѕ СЂР°Р· СЃС‚РѕСЂРѕРЅС‹ РІС‚РѕСЂРѕРіРѕ РїСЂРѕС…РѕРґР° Р±РѕР»СЊС€Рµ Р±Р°Р·РѕРІС‹С… (РїР»РѕС‰Р°РґСЊ вЂ” РІ РєРІР°РґСЂР°С‚). */
export const IMAGE_BASE_SCALES = [1.5, 2, 3] as const
export const DEFAULT_IMAGE_TWO_PASS = {
  denoise: 0.35,
  steps: 4,
  baseScale: 2,
} as const
/** Р”РёР°РїР°Р·РѕРЅС‹, РєРѕС‚РѕСЂС‹Рµ РїСЂРёРЅРёРјР°РµС‚ Рё UI, Рё СЂРѕСѓС‚. */
export const IMAGE_DENOISE2_RANGE = { min: 0.05, max: 0.8 }
export const IMAGE_STEPS2_RANGE = { min: 1, max: 12 }

/**
 * (РїСЂР°РІРєР° 938) id РЅРѕРґ СЌРЅС…Р°РЅСЃРµСЂР° РїСЂРѕРјРїС‚Р°: CLIPLoader + TextGenerateV2 (С‚РµРєСЃС‚ РјРѕРґРµР»Рё)
 * + JsonExtractString (expanded_caption). РЎРµС‚СЊ Р»РµРЅРёРІР°СЏ: СЌРЅС…Р°РЅСЃРµСЂ РёСЃРїРѕР»РЅСЏРµС‚СЃСЏ РґРѕ
 * conditioning, Р° РµРіРѕ СЂРµР·СѓР»СЊС‚Р°С‚ СѓС…РѕРґРёС‚ РІ `prompt` РІРјРµСЃС‚Рѕ СЃС‹СЂРѕРіРѕ Р·Р°РїСЂРѕСЃР°.
 */
export const IMAGE_ENHANCER_CLIP_NODE_ID = '7:17'
export const IMAGE_ENHANCER_NODE_ID = '7:16'
export const IMAGE_ENHANCER_JSON_NODE_ID = '7:16j'
/** (РїСЂР°РІРєР° 938) СЃРєР»РµР№РєР° В«РїРѕРґРЅСЏС‚С‹Р№ РїСЂРѕРјРїС‚ + СѓС‚РѕС‡РЅРµРЅРёРµВ» РґР»СЏ РІС‚РѕСЂРѕРіРѕ РїСЂРѕС…РѕРґР°. */
export const IMAGE_SUFFIX_NODE_ID = '7:16c'

/** id РЅРѕРґС‹-СЃСЌРјРїР»РµСЂР° вЂ” РЅР° РЅРµРіРѕ РІРµС€Р°РµС‚СЃСЏ РїСЂРѕРіСЂРµСЃСЃ (progress-tracker). */
export const IMAGE_SAMPLER_NODE_ID = '7:12'

/** id РЅРѕРґ РІС‚РѕСЂРѕРіРѕ РїСЂРѕС…РѕРґР° (РїСЂР°РІРєРё 935); sampler2 вЂ” РІС‚РѕСЂР°СЏ СЃС‚Р°РґРёСЏ РїСЂРѕРіСЂРµСЃСЃР°. */
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

/** Р Р°Р·РјРµСЂ Р±Р°Р·РѕРІРѕРіРѕ РїСЂРѕС…РѕРґР°: РѕРєСЂСѓРіР»СЏРµРј РІРЅРёР·, С‡С‚РѕР±С‹ Р±Р°Р·Р° РЅРµ РІС‹С€Р»Р° Р·Р° РёС‚РѕРі. */
function snapDown(v: number): number {
  const n = Math.floor(v / MULTIPLE) * MULTIPLE
  return Math.max(SIDE_MIN, Math.min(SIDE_MAX, n))
}

/**
 * (РїСЂР°РІРєР° 935) Р Р°Р·РјРµСЂ РїРµСЂРІРѕРіРѕ РїСЂРѕС…РѕРґР° РґР»СЏ РґР°РЅРЅС‹С… РёС‚РѕРіРѕРІС‹С… СЂР°Р·РјРµСЂРѕРІ. РќСѓР¶РµРЅ Рё
 * Р±РёР»РґРµСЂСѓ, Рё РІРєР»Р°РґРєРµ (РїРѕРґРїРёСЃСЊ В«Р±Р°Р·Р° 1456Г—1456 в†’ РёС‚РѕРі 2912Г—2912В»), РїРѕСЌС‚РѕРјСѓ
 * СЃС‡РёС‚Р°РµС‚СЃСЏ РІ РѕРґРЅРѕРј РјРµСЃС‚Рµ.
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
  if (!p.prompt || !p.prompt.trim()) throw new Error('РџСѓСЃС‚РѕР№ РїСЂРѕРјРїС‚')

  // (РїСЂР°РІРєР° 935) width/height вЂ” РРўРћР“РћР’Р«Р™ СЂР°Р·РјРµСЂ: РѕРЅ Рё СѓС…РѕРґРёС‚ РІ SaveImage, С‡С‚РѕР±С‹
  // РІРєР»Р°РґРєР° РѕС‚РґР°РІР°Р»Р° СЂРѕРІРЅРѕ РЅРѕРјРёРЅР°Р» РїСЂРµСЃРµС‚Р°. РџСЂРё 'upscale' Р±Р°Р·РѕРІС‹Р№ РїСЂРѕС…РѕРґ
  // СЃС‡РёС‚Р°РµС‚СЃСЏ РёР· baseScale Рё РѕРєСЂСѓРіР»СЏРµС‚СЃСЏ РІРЅРёР·.
  const finalW = snap(p.width)
  const finalH = snap(p.height)
  const { mode, denoise2, steps2, baseScale } = imageTwoPassParams(p)
  const [width, height] = imageBaseDims(finalW, finalH, mode, baseScale)
  const steps = normalizeImageSteps(p.steps)
  const refs = (p.references || []).filter(Boolean).slice(0, IMAGE_MAX_REFERENCES)
  if ((p.references || []).length > IMAGE_MAX_REFERENCES) {
    throw new Error(`Р РµС„РµСЂРµРЅСЃРѕРІ Р±РѕР»СЊС€Рµ ${IMAGE_MAX_REFERENCES}: image_1 вЂ” С‚Рѕ, С‡С‚Рѕ РїСЂР°РІРёРј, РїР»СЋСЃ РґРѕ ${IMAGE_MAX_REFERENCES - 1} РєР°СЂС‚РёРЅРѕРє-РёСЃС‚РѕС‡РЅРёРєРѕРІ`)
  }

  const modelChain: Record<string, unknown> = {}
  let modelSrc: [string, number] = ['7:1', 0]

  modelChain['7:1'] = {
    inputs: { unet_name: p.diffusionModel || '', weight_dtype: 'default' },
    class_type: 'UNETLoader',
    _meta: { title: 'РњРѕРґРµР»СЊ РґРёС„С„СѓР·РёРё' },
  }

  // РўРµ Р¶Рµ СЌРЅРµСЂРіРѕСЃР±РµСЂРµРіР°СЋС‰РёРµ РїР°С‚С‡Рё, С‡С‚Рѕ Рё РІ РІРёРґРµРѕ: РєР°СЂС‚РёРЅРєР° вЂ” 4вЂ“8 РњРџ, С‚Рѕ РµСЃС‚СЊ
  // РїРѕСЃР»РµРґРѕРІР°С‚РµР»СЊРЅРѕСЃС‚СЊ РЅРµ РєРѕСЂРѕС‡Рµ РІРёРґРµРѕРєР°РґСЂР°, VRAM СЌРєРѕРЅРѕРјРёС‚СЃСЏ С‚Р°Рє Р¶Рµ.
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
  // РљР°СЂС‚РёРЅРєР° вЂ” Р±РµР· sparse-attention: РѕРЅР° РѕР±СѓС‡РµРЅР° РЅР° РїР»РѕС‚РЅРѕРј РІРЅРёРјР°РЅРёРё,
  // СЂР°Р·СЂРµР¶РёРІР°РЅРёРµ Р»РѕРјР°РµС‚ РєРѕРјРїРѕР·РёС†РёСЋ РЅР° РѕРґРЅРѕРј РєР°РґСЂРµ.
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
        _meta: { title: i === 0 ? 'Р§С‚Рѕ РїСЂР°РІРёРј (image_1)' : `Р РµС„РµСЂРµРЅСЃ ${i}` },
      }
      refLinks.push([loadId, 0])
    })
  }

  // (РїСЂР°РІРєР° 938) Prompt enhancer вЂ” РѕС„РёС†РёР°Р»СЊРЅС‹Р№: CLIPLoader(type minimax) РЅР°
  // qwen3.5_9b + TextGenerateV2 (thinking on) + JsonExtractString. РўРµРєСЃС‚С‹
  // system/task-РїСЂРѕРјРїС‚РѕРІ Рё РїР°СЂР°РјРµС‚СЂС‹ РіРµРЅРµСЂР°С†РёРё СЃРіРµРЅРµСЂРёСЂРѕРІР°РЅС‹ РїРѕР±Р°Р№С‚РѕРІРѕ РёР·
  // СЌС‚Р°Р»РѕРЅРЅС‹С… С€Р°Р±Р»РѕРЅРѕРІ (image-pe.ts).
  //
  // Р”Р»СЏ РїСЂР°РІРѕРє РїРѕРІС‚РѕСЂСЏРµРј edit-С€Р°Р±Р»РѕРЅ: РєР°СЂС‚РёРЅРєРё РёРґСѓС‚ РІ Р°РІС‚РѕРіСЂРѕРІ `images`, Р°
  // СЂР°Р·РјРµСЂС‹ РїСЂРёРІРѕРґСЏС‚СЃСЏ Рє РєСЂР°С‚РЅРѕСЃС‚Рё 32 С‡РµСЂРµР· ResizeImageMaskNode вЂ” РёРЅР°С‡Рµ
  // РІРёР·СѓР°Р»СЊРЅС‹Рµ С‚РѕРєРµРЅС‹ СЌРЅРєРѕРґРµСЂР° СЂР°Р·СЉРµР·Р¶Р°СЋС‚СЃСЏ СЃ Р»Р°С‚РµРЅС‚РѕРј.
  //
  // API-С„РѕСЂРјР°С‚ TextGenerateV2/ResizeImageMaskNode: sampling_mode Рё resize_type вЂ”
  // DynamicCombo, РїРѕСЌС‚РѕРјСѓ РёС… РІР»РѕР¶РµРЅРЅС‹Рµ РїРѕР»СЏ Р·Р°РґР°СЋС‚СЃСЏ РєР»СЋС‡Р°РјРё СЃ С‚РѕС‡РєРѕР№
  // (`sampling_mode.temperature`), РєР°Рє РёС… РІРёРґРёС‚ СЏРґСЂРѕ РІ get_finalized_class_inputs.
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
          _meta: { title: `Р РµС„РµСЂРµРЅСЃ ${i + 1} РґР»СЏ СЌРЅС…Р°РЅСЃРµСЂР°` },
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
      _meta: { title: 'expanded_caption РёР· JSON' },
    }
  }
  const pass1Prompt: unknown = useEnhancer ? [IMAGE_ENHANCER_JSON_NODE_ID, 0] : p.prompt

  // autogrow-РІС…РѕРґ images (names image_1вЂ¦image_9) РІ API-С„РѕСЂРјР°С‚Рµ вЂ” В«images.image_NВ»,
  // С‚РѕС‚ Р¶Рµ РїР°С‚С‚РµСЂРЅ, С‡С‚Рѕ ref_images.ref_image_0 РІ H3. VAE РЅРѕРґРµ РЅСѓР¶РµРЅ Рё РґР»СЏ
  // РєРѕРґРёСЂРѕРІР°РЅРёСЏ СЂРµС„РµСЂРµРЅСЃРѕРІ, Рё РґР»СЏ Р»Р°С‚РµРЅС‚Р° СЂРµР·СѓР»СЊС‚Р°С‚Р°.
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

  // в”Ђв”Ђв”Ђ (РїСЂР°РІРєР° 935) РІС‚РѕСЂРѕР№ РїСЂРѕС…РѕРґ в”Ђв”Ђв”Ђ
  // Р’С‚РѕСЂР°СЏ conditioning-РЅРѕРґР° РЅСѓР¶РЅР°, РєРѕРіРґР° РёС‚РѕРіРѕРІРѕРµ СЂР°Р·СЂРµС€РµРЅРёРµ РѕС‚Р»РёС‡Р°РµС‚СЃСЏ РѕС‚
  // Р±Р°Р·РѕРІРѕРіРѕ ('upscale') РёР»Рё РєРѕРіРґР° РґР»СЏ РІС‚РѕСЂРѕРіРѕ РїСЂРѕС…РѕРґР° Р·Р°РґР°РЅР° СЃРІРѕСЏ С„РѕСЂРјСѓР»РёСЂРѕРІРєР°:
  // РµС‘ РІС‹С…РѕРґ вЂ” Рё С‚РµРєСЃС‚, Рё РЅСѓР»РµРІРѕР№ AV-Р»Р°С‚РµРЅС‚ РЅСѓР¶РЅРѕРіРѕ СЂР°Р·РјРµСЂР° (1 РєР°РґСЂ + 2 Р°СѓРґРёРѕ).
  const suffix = (p.prompt2 || '').trim()
  const needCond2 = mode !== 'off' && (width !== finalW || height !== finalH || suffix !== '')
  const cond2Id = needCond2 ? IMAGE_COND2_NODE_ID : '7:8'
  const pass2Nodes: Record<string, unknown> = {}
  // (РїСЂР°РІРєР° 938) РЈС‚РѕС‡РЅРµРЅРёРµ РІС‚РѕСЂРѕРіРѕ РїСЂРѕС…РѕРґР° РїСЂРёРєР»РµРёРІР°РµС‚СЃСЏ Рє СѓР¶Рµ РїРѕРґРЅСЏС‚РѕРјСѓ
  // СЌРЅС…Р°РЅСЃРµСЂРѕРј РїСЂРѕРјРїС‚Сѓ (StringConcatenate), РёРЅР°С‡Рµ РєРѕСЂРѕС‚РєРёР№ СѓС‚РѕС‡РЅСЏСЋС‰РёР№ С‚РµРєСЃС‚
  // Р·Р°С‚РёСЂР°Р» Р±С‹ РїРѕРґСЂРѕР±РЅРѕРµ РѕРїРёСЃР°РЅРёРµ РїРµСЂРІРѕРіРѕ РїСЂРѕС…РѕРґР°.
  let pass2Prompt: unknown = pass1Prompt
  if (mode !== 'off' && needCond2) {
    if (suffix && useEnhancer) {
      pass2Nodes[IMAGE_SUFFIX_NODE_ID] = {
        inputs: { string_a: [IMAGE_ENHANCER_JSON_NODE_ID, 0], string_b: suffix, delimiter: '\n' },
        class_type: 'StringConcatenate',
        _meta: { title: 'РџСЂРѕРјРїС‚ 2-РіРѕ РїСЂРѕС…РѕРґР°' },
      }
      pass2Prompt = [IMAGE_SUFFIX_NODE_ID, 0]
    } else if (suffix) {
      pass2Prompt = `${p.prompt.trim()}\n${suffix}`
    }
  }

  // РњР°СЃС€С‚Р°Р±РёСЂРѕРІР°РЅРёРµ Р±Р°Р·С‹ РЅСѓР¶РЅРѕ С‚РѕР»СЊРєРѕ РїСЂРё СЂР°Р·Р»РёС‡РёРё СЂР°Р·РјРµСЂРѕРІ; РјРµС‚РѕРґ lanczos вЂ”
  // РєР°Рє РІ cn_prescale: РѕРЅ РЅРµ РґРѕР±Р°РІР»СЏРµС‚ ringing, РєРѕС‚РѕСЂС‹Р№ РІС‚РѕСЂРѕР№ РїСЂРѕС…РѕРґ СѓСЃРёР»РёР» Р±С‹.
  const needScale = mode !== 'off' && (width !== finalW || height !== finalH)
  if (mode !== 'off') {
    if (needCond2) {
      pass2Nodes[IMAGE_COND2_NODE_ID] = {
        inputs: condInputs(pass2Prompt, finalW, finalH),
        class_type: 'PH3ImageConditioning',
        _meta: { title: 'MiniMax H3 Image Conditioning (РїСЂРѕС…РѕРґ 2)' },
      }
    }
    let baseImages: [string, number] = ['7:14', 0]
    if (needScale) {
      pass2Nodes[IMAGE_PASS2_SCALE_NODE_ID] = {
        inputs: { image: ['7:14', 0], upscale_method: 'lanczos', width: finalW, height: finalH, crop: 'disabled' },
        class_type: 'ImageScale',
        _meta: { title: `Р‘Р°Р·Р° в†’ ${finalW}Г—${finalH}` },
      }
      baseImages = [IMAGE_PASS2_SCALE_NODE_ID, 0]
    }
    pass2Nodes[IMAGE_PASS2_INJECT_NODE_ID] = {
      inputs: { av_latent: [cond2Id, 1], images: baseImages, vae: ['7:7', 0] },
      class_type: 'H3InjectVideoLatent',
      _meta: { title: 'Р‘Р°Р·Р° РІ AV-Р»Р°С‚РµРЅС‚ (img2img)' },
    }
    pass2Nodes[IMAGE_PASS2_SIGMAS_NODE_ID] = {
      inputs: { model: ['7:5', 0], scheduler: 'simple', steps: steps2, denoise: denoise2 },
      class_type: 'BasicScheduler',
      _meta: { title: `РЎРёРіРјС‹ РїСЂРѕС…РѕРґР° 2 (${steps2} С€Р°Рі(РѕРІ), denoise ${denoise2})` },
    }
    pass2Nodes[IMAGE_PASS2_GUIDER_NODE_ID] = {
      inputs: { model: ['7:5', 0], conditioning: [cond2Id, 0] },
      class_type: 'BasicGuider',
      _meta: { title: 'Guider (РїСЂРѕС…РѕРґ 2)' },
    }
    pass2Nodes['7:22'] = {
      inputs: { sampler_name: 'euler' },
      class_type: 'KSamplerSelect',
      _meta: { title: 'Sampler: euler (РїСЂРѕС…РѕРґ 2)' },
    }
    pass2Nodes['7:23'] = {
      inputs: { noise_seed: p.seed ?? 0 },
      class_type: 'RandomNoise',
      _meta: { title: 'РЁСѓРј РїСЂРѕС…РѕРґР° 2' },
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
      _meta: { title: 'РЎСЌРјРїР»РµСЂ (РїСЂРѕС…РѕРґ 2)' },
    }
    pass2Nodes['7:25'] = {
      inputs: { av_latent: [IMAGE_SAMPLER2_NODE_ID, 0] },
      class_type: 'LTXVSeparateAVLatent',
      _meta: { title: 'Separate AV Latent (РїСЂРѕС…РѕРґ 2)' },
    }
    pass2Nodes[IMAGE_PASS2_DECODE_NODE_ID] = {
      inputs: { samples: ['7:25', 0], vae: ['7:7', 0] },
      class_type: 'VAEDecode',
      _meta: { title: 'Decode (РїСЂРѕС…РѕРґ 2)' },
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
      _meta: { title: 'РЎР»СѓС‡Р°Р№РЅС‹Р№ С€СѓРј' },
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
      // (РїСЂР°РІРєР° 938) РљР°Рє РІ РѕС„РёС†РёР°Р»СЊРЅРѕРј С€Р°Р±Р»РѕРЅРµ: СЃРµС‚РєСѓ СЃРёРіРј СЃС‡РёС‚Р°РµС‚ BasicScheduler
      // РїРѕ СЃРѕР±СЃС‚РІРµРЅРЅРѕР№ С‚Р°Р±Р»РёС†Рµ РјРѕРґРµР»Рё. Р СѓС‡РЅРѕР№ ManualSigmas СѓС€С‘Р» РІРјРµСЃС‚Рµ СЃ LoRA-РїСѓС‚С‘Рј.
      inputs: { model: ['7:5', 0], scheduler: 'simple', steps, denoise: 1.0 },
      class_type: 'BasicScheduler',
      _meta: { title: `РЎРёРіРјС‹ (${steps} С€Р°Рі(РѕРІ), simple)` },
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
      _meta: { title: 'РЎСЌРјРїР»РµСЂ' },
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
        // (РїСЂР°РІРєР° 935) РІ РґРІСѓС…РїСЂРѕС…РѕРґРЅРѕРј СЂРµР¶РёРјРµ СЃРѕС…СЂР°РЅСЏРµС‚СЃСЏ СЂРµР·СѓР»СЊС‚Р°С‚ РІС‚РѕСЂРѕРіРѕ
        // РїСЂРѕС…РѕРґР° вЂ” РѕРЅ СЂРѕРІРЅРѕ РІ РёС‚РѕРіРѕРІРѕРј СЂР°Р·РјРµСЂРµ, РѕС‚РґРµР»СЊРЅС‹Р№ РєСЂРѕРї РЅРµ РЅСѓР¶РµРЅ.
        images: mode !== 'off' ? [IMAGE_PASS2_DECODE_NODE_ID, 0] : ['7:14', 0],
        filename_prefix: p.filenamePrefix || 'Minimax_Studio_image',
      },
      class_type: 'SaveImage',
      _meta: { title: 'РЎРѕС…СЂР°РЅРёС‚СЊ РёР·РѕР±СЂР°Р¶РµРЅРёРµ' },
    },
    ...pass2Nodes,
  }

  return workflow
}

/**
 * РЎС‚Р°РґРёРё РґР»СЏ progress-tracker. (РїСЂР°РІРєР° 935) Р’Рѕ РІС‚РѕСЂРѕРј РїСЂРѕС…РѕРґРµ СЃРІРѕСЏ РЅРѕРґР°-СЃСЌРјРїР»РµСЂ,
 * РїРѕСЌС‚РѕРјСѓ СЃС‚Р°РґРёР№ РґРІРµ вЂ” РєР°Рє РІ РІРёРґРµРѕ-СЂРµР¶РёРјР°С… СЃ pass-2: РїСЂРѕРіСЂРµСЃСЃ РЅРµ В«РѕС‚РєР°С‚С‹РІР°РµС‚СЃСЏВ».
 */
export function imageSamplerStages(twoPass?: unknown): string[][] {
  const { mode } = imageTwoPassParams({ twoPass })
  return mode === 'off' ? [[IMAGE_SAMPLER_NODE_ID]] : [[IMAGE_SAMPLER_NODE_ID], [IMAGE_SAMPLER2_NODE_ID]]
}
