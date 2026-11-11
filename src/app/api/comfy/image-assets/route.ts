import { NextResponse } from 'next/server'
import { readdirSync, existsSync, statSync } from 'fs'
import { join } from 'path'
import { getAppConfig } from '@/lib/app-config'
import { listExternalModels } from '@/lib/extra-model-paths'
import {
  DEFAULT_IMAGE_LORA,
  DEFAULT_IMAGE_TEXT_ENCODER,
  DEFAULT_IMAGE_VAE,
} from '@/lib/comfy/image-template'

/**
 * (правка 929) GET /api/comfy/image-assets
 *
 * Список файлов, нужных режиму «Изображение», прямо с диска (ComfyUI трогать
 * не нужно): LoRA p-h3-image, image-ный текстовый энкодер, image-ный VAE и все
 * DiT из diffusion_models/. Плюс флаг `ready` — есть ли на диске вся троица
 * image-обвязки, и `missing` — чего не хватает (подсказка во вкладке).
 */
export const dynamic = 'force-dynamic'

function listDir(dir: string, category: string): string[] {
  const names = new Set<string>()
  try {
    if (existsSync(dir) && statSync(dir).isDirectory()) {
      for (const f of readdirSync(dir)) {
        if (f.toLowerCase().endsWith('.safetensors')) names.add(f)
      }
    }
  } catch { /* нет доступа к папке — пустой список */ }
  try {
    for (const f of listExternalModels(category)) {
      const base = f.split(/[\\/]/).pop()
      if (base && base.toLowerCase().endsWith('.safetensors')) names.add(base)
    }
  } catch { /* extra_model_paths не читаются — не критично */ }
  return [...names].sort((a, b) => a.localeCompare(b))
}

const isImageAsset = (name: string) => /p-h3-image|h3_image|h3-image/i.test(name)

export async function GET() {
  try {
    const cfg = getAppConfig()
    const modelsRoot = join(cfg.comfyCore, 'models')
    const loras = listDir(join(modelsRoot, 'loras'), 'loras')
    const textEncoders = listDir(join(modelsRoot, 'text_encoders'), 'text_encoders')
    const vaes = listDir(join(modelsRoot, 'vae'), 'vae')
    const diffusionModels = listDir(join(modelsRoot, 'diffusion_models'), 'diffusion_models')

    const imageTextEncoders = textEncoders.filter(isImageAsset)
    const imageVaes = vaes.filter(isImageAsset)
    const imageLoras = loras.filter(isImageAsset)
    const imageModels = diffusionModels.filter(isImageAsset)

    const has = (list: string[], name: string) => list.includes(name)
    const missing: string[] = []
    if (!has(loras, DEFAULT_IMAGE_LORA)) missing.push(`loras/${DEFAULT_IMAGE_LORA}`)
    if (!has(imageTextEncoders, DEFAULT_IMAGE_TEXT_ENCODER) && imageTextEncoders.length === 0) {
      missing.push('image-текстовый энкодер (p-h3-image_text_encoder_*)')
    }
    if (!has(vaes, DEFAULT_IMAGE_VAE) && imageVaes.length === 0) {
      missing.push('image-VAE (p-h3-image_vae_*)')
    }

    return NextResponse.json({
      ok: true,
      ready: missing.length === 0,
      missing,
      loras: imageLoras,
      textEncoders: imageTextEncoders,
      vaes: imageVaes,
      imageModels,
      diffusionModels,
      defaults: {
        imageLora: DEFAULT_IMAGE_LORA,
        textEncoder: DEFAULT_IMAGE_TEXT_ENCODER,
        vae: DEFAULT_IMAGE_VAE,
      },
    })
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}
