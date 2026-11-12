import { NextResponse } from 'next/server'
import { join } from 'path'
import { getAppConfig } from '@/lib/app-config'
import { listModelFiles } from '@/lib/comfy/model-scan'
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_IMAGE_TEXT_ENCODER,
  DEFAULT_IMAGE_VAE,
  DEFAULT_IMAGE_PROMPT_ENHANCER,
  IMAGE_MODEL_CANDIDATES,
  IMAGE_PE_CANDIDATES,
  isImageDiT,
  isImageTextEncoder,
  isImageVae,
  isImagePromptEnhancer,
} from '@/lib/comfy/image-template'

/**
 * (правки 929, 938) GET /api/comfy/image-assets
 *
 * Список файлов, нужных режиму «Изображение», прямо с диска (ComfyUI трогать не
 * нужно): официальные image-DiT (minimax_h3_image_pruned_*), общий с видео 32B
 * текстовый энкодер (qwen3vl_32b_minimax_h3_*), image-ный VAE и энхансер
 * промпта (qwen3.5_9b_*). Плюс флаг `ready` и `missing` — чего не хватает.
 */
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const cfg = getAppConfig()
    const modelsRoot = join(cfg.comfyCore, 'models')
    const textEncoders = listModelFiles(modelsRoot, 'text_encoders')
    const vaes = listModelFiles(modelsRoot, 'vae')
    const diffusionModels = listModelFiles(modelsRoot, 'diffusion_models')

    const imageTextEncoders = textEncoders.filter(isImageTextEncoder)
    const imageVaes = vaes.filter(isImageVae)
    const imageModels = diffusionModels.filter(isImageDiT)
    // (правка 938) энхансер лежит в text_encoders и именуется по своему ключу,
    // поэтому в imageTextEncoders не попадает — выделяем отдельно.
    const promptEnhancers = textEncoders.filter(isImagePromptEnhancer)

    const has = (list: string[], name: string) => list.includes(name)
    const missing: string[] = []
    if (!imageModels.some((m) => (IMAGE_MODEL_CANDIDATES as readonly string[]).includes(m))) {
      missing.push(`diffusion_models/${DEFAULT_IMAGE_MODEL}`)
    }
    if (!has(imageTextEncoders, DEFAULT_IMAGE_TEXT_ENCODER) && imageTextEncoders.length === 0) {
      missing.push('текстовый энкодер qwen3vl_32b_minimax_h3_*')
    }
    if (!has(vaes, DEFAULT_IMAGE_VAE) && imageVaes.length === 0) {
      missing.push(`vae/${DEFAULT_IMAGE_VAE}`)
    }

    const enhancerDefault =
      IMAGE_PE_CANDIDATES.find((c) => promptEnhancers.includes(c)) ?? promptEnhancers[0] ?? ''

    const modelDefault =
      IMAGE_MODEL_CANDIDATES.find((c) => imageModels.includes(c)) ?? imageModels[0] ?? DEFAULT_IMAGE_MODEL

    return NextResponse.json({
      ok: true,
      ready: missing.length === 0,
      missing,
      textEncoders: imageTextEncoders,
      vaes: imageVaes,
      imageModels,
      diffusionModels,
      promptEnhancers,
      defaults: {
        diffusionModel: modelDefault,
        textEncoder: DEFAULT_IMAGE_TEXT_ENCODER,
        vae: DEFAULT_IMAGE_VAE,
        promptEnhancer: enhancerDefault || DEFAULT_IMAGE_PROMPT_ENHANCER,
      },
      // Энхансер не обязателен для запуска, но официальная карточка требует его
      // в графе: без него короткие промпты дают слабые результаты.
      enhancerMissing: promptEnhancers.length === 0,
    })
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}
