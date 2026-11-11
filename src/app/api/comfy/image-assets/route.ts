import { NextResponse } from 'next/server'
import { join } from 'path'
import { getAppConfig } from '@/lib/app-config'
import { listModelFiles } from '@/lib/comfy/model-scan'
import {
  DEFAULT_IMAGE_LORA,
  DEFAULT_IMAGE_TEXT_ENCODER,
  DEFAULT_IMAGE_VAE,
  DEFAULT_IMAGE_PROMPT_UPSAMPLER,
  IMAGE_PROMPT_UPSAMPLER_CANDIDATES,
  isImagePromptUpsampler,
  isFl2vaImageBase,
} from '@/lib/comfy/image-template'

/**
 * (правка 929) GET /api/comfy/image-assets
 *
 * Список файлов, нужных режиму «Изображение», прямо с диска (ComfyUI трогать
 * не нужно): LoRA p-h3-image, image-ный текстовый энкодер, image-ный VAE и все
 * DiT из diffusion_models/. Плюс флаг `ready` — есть ли на диске вся троица
 * image-обвязки, и `missing` — чего не хватает (подсказка во вкладке).
 *
 * (правка 934) Добавлены: `promptUpsamplers` (файлы апсемплера промпта),
 * `imageBases` (DiT, которые официальная карточка считает базой для image-LoRA,
 * то есть FL2VA) и `defaults` — что вкладка подставит сама.
 */
export const dynamic = 'force-dynamic'

const isImageAsset = (name: string) => /p-h3-image|h3_image|h3-image/i.test(name)

export async function GET() {
  try {
    const cfg = getAppConfig()
    const modelsRoot = join(cfg.comfyCore, 'models')
    const loras = listModelFiles(modelsRoot, 'loras')
    const textEncoders = listModelFiles(modelsRoot, 'text_encoders')
    const vaes = listModelFiles(modelsRoot, 'vae')
    const diffusionModels = listModelFiles(modelsRoot, 'diffusion_models')

    const imageTextEncoders = textEncoders.filter(isImageAsset)
    const imageVaes = vaes.filter(isImageAsset)
    const imageLoras = loras.filter(isImageAsset)
    const imageModels = diffusionModels.filter(isImageAsset)
    // (правка 934) апсемплер лежит в text_encoders и именуется по своему ключу,
    // поэтому в imageTextEncoders не попадает — выделяем отдельно.
    const promptUpsamplers = textEncoders.filter(isImagePromptUpsampler)
    const imageBases = diffusionModels.filter(isFl2vaImageBase)

    const has = (list: string[], name: string) => list.includes(name)
    const missing: string[] = []
    if (!has(loras, DEFAULT_IMAGE_LORA)) missing.push(`loras/${DEFAULT_IMAGE_LORA}`)
    if (!has(imageTextEncoders, DEFAULT_IMAGE_TEXT_ENCODER) && imageTextEncoders.length === 0) {
      missing.push('image-текстовый энкодер (p-h3-image_text_encoder_*)')
    }
    if (!has(vaes, DEFAULT_IMAGE_VAE) && imageVaes.length === 0) {
      missing.push('image-VAE (p-h3-image_vae_*)')
    }

    const upsamplerDefault =
      IMAGE_PROMPT_UPSAMPLER_CANDIDATES.find((c) => promptUpsamplers.includes(c)) ??
      promptUpsamplers[0] ??
      ''

    const diffusionDefault =
      (cfg.diffusionModel && imageBases.includes(cfg.diffusionModel) ? cfg.diffusionModel : '') ||
      imageBases[0] ||
      cfg.diffusionModel ||
      ''

    return NextResponse.json({
      ok: true,
      ready: missing.length === 0,
      missing,
      loras: imageLoras,
      textEncoders: imageTextEncoders,
      vaes: imageVaes,
      imageModels,
      diffusionModels,
      promptUpsamplers,
      imageBases,
      defaults: {
        imageLora: DEFAULT_IMAGE_LORA,
        textEncoder: DEFAULT_IMAGE_TEXT_ENCODER,
        vae: DEFAULT_IMAGE_VAE,
        promptUpsampler: upsamplerDefault || DEFAULT_IMAGE_PROMPT_UPSAMPLER,
        diffusionModel: diffusionDefault,
      },
      // Апсемплер не обязателен для запуска, но официальная карточка требует
      // держать его в графе: без него короткие промпты дают слабые результаты.
      upsamplerMissing: promptUpsamplers.length === 0,
    })
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}
