import { NextRequest, NextResponse } from 'next/server'
import { promises as fs } from 'fs'
import { existsSync } from 'fs'
import path, { join } from 'path'
import { submitWorkflowJson } from '@/lib/comfy/minimax-h3-client'
import { setActivePrompt } from '@/lib/comfy/progress-tracker'
import { getAppConfig } from '@/lib/app-config'
import { sanitizeFolderPath } from '@/lib/gallery-folders'
import { runGeneration, assertGenerationAllowed } from '@/lib/vram-arbiter'
import {
  buildImageWorkflow,
  imageSamplerStages,
  IMAGE_MAX_REFERENCES,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_IMAGE_TEXT_ENCODER,
  DEFAULT_IMAGE_VAE,
  IMAGE_PE_CANDIDATES,
  isImageDiT,
  normalizeImageSteps,
  imageTwoPassParams,
} from '@/lib/comfy/image-template'
import { listModelFiles } from '@/lib/comfy/model-scan'
import { recordPendingMetaRaw } from '@/lib/pending-meta'

/**
 * (правки 929, 938) POST /api/comfy/image — генерация изображения официальной
 * MiniMax H3 Image (Comfy-Org/MiniMax-H3-Image): по тексту и правка по референсам.
 *
 * Body:
 *   prompt          — обязательный
 *   width, height   — сторона канваса (кратность 32 делает билдер)
 *   steps?          — 4/6/8/10/12 (6 — как в официальном шаблоне)
 *   seed?           — 0 = случайный
 *   diffusionModel? — DiT minimax_h3_image_pruned_* (по умолчанию w4a8)
 *   textEncoder?    — qwen3vl_32b_minimax_h3_* (общий с видео)
 *   vae?            — minimax_h3_image_vae_fp16
 *   promptEnhancer? — qwen3.5_9b_* ('' — выключить); по умолчанию первый с диска
 *   references?     — массив референсов:
 *                       { name }                    — файл уже в ComfyUI/input/
 *                       { filename, subfolder }     — картинка из галереи (копируется в input/)
 *                     image_1 = то, что правим; дальше — картинки-источники.
 *
 * Ответ — как у остальных вкладок: { prompt_id, ... }.
 */
export const dynamic = 'force-dynamic'

const IMAGE_EXT_OK = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp'])

interface RefInput {
  name?: string
  filename?: string
  subfolder?: string
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      prompt?: string
      width?: number
      height?: number
      steps?: number
      seed?: number
      diffusionModel?: string
      textEncoder?: string
      vae?: string
      references?: RefInput[]
      lowVramAttention?: boolean
      chunkFeedForward?: boolean
      /** (правка 938) '' = выключен; undefined — первый доступный с диска. */
      promptEnhancer?: string | null
      /** (правка 935) 'off' | 'detail' | 'upscale'; width/height = итоговый размер. */
      twoPass?: string
      baseScale?: number
      denoise2?: number
      steps2?: number
      /** (правка 935) добавка к промпту для второго прохода. */
      prompt2?: string
    }

    const prompt = (body.prompt || '').trim()
    if (!prompt) {
      return NextResponse.json({ error: 'Промпт обязателен' }, { status: 400 })
    }
    const width = Number(body.width) || 2048
    const height = Number(body.height) || 2048
    // (правка 938) Верхняя граница — официальная 16-мегапиксельная таблица
    // (6272 по длинной стороне); ядро разрешает до MAX_RESOLUTION=16384.
    if (!(width >= 256 && width <= 8192 && height >= 256 && height <= 8192)) {
      return NextResponse.json({ error: 'Размер стороны должен быть от 256 до 8192 пикселей' }, { status: 400 })
    }

    const block = assertGenerationAllowed()
    if (block) {
      return NextResponse.json({ error: block }, { status: 409 })
    }

    const cfg = getAppConfig()
    const inputDir = cfg.inputDir

    // ─── Референсы: имя в input/ или копия из галереи ───
    const refsRaw = Array.isArray(body.references) ? body.references : []
    if (refsRaw.length > IMAGE_MAX_REFERENCES) {
      return NextResponse.json(
        { error: `Референсов не больше ${IMAGE_MAX_REFERENCES} (image_1 + ${IMAGE_MAX_REFERENCES - 1} источников)` },
        { status: 400 },
      )
    }
    const references: string[] = []
    const copied: string[] = []
    for (const ref of refsRaw) {
      if (ref?.name) {
        const safe = path.basename(ref.name)
        if (!existsSync(path.join(inputDir, safe))) {
          return NextResponse.json({ error: `Референс не найден в input: ${safe}` }, { status: 404 })
        }
        references.push(safe)
        continue
      }
      if (ref?.filename) {
        const sub = sanitizeFolderPath(ref.subfolder || '')
        const safe = path.basename(ref.filename)
        const ext = path.extname(safe).toLowerCase()
        if (!IMAGE_EXT_OK.has(ext)) {
          return NextResponse.json({ error: `Референс из галереи — только изображение: ${safe}` }, { status: 400 })
        }
        const src = path.join(cfg.outputDir, sub, safe)
        // Страховка от traversal: итоговый путь обязан остаться внутри outputDir.
        if (!path.resolve(src).startsWith(path.resolve(cfg.outputDir) + path.sep)) {
          return NextResponse.json({ error: 'Invalid path' }, { status: 400 })
        }
        if (!existsSync(src)) {
          return NextResponse.json({ error: `Файл не найден: ${safe}` }, { status: 404 })
        }
        await fs.mkdir(inputDir, { recursive: true })
        const stem = safe.slice(0, safe.length - ext.length)
        let destName = `${stem}_imgref${references.length ? `_${references.length}` : ''}${ext}`
        let destPath = path.join(inputDir, destName)
        let n = 1
        while (existsSync(destPath)) {
          destName = `${stem}_imgref_${n++}${ext}`
          destPath = path.join(inputDir, destName)
          if (n > 100) return NextResponse.json({ error: 'Too many duplicates' }, { status: 500 })
        }
        // COPYFILE_EXCL — атомарно, без окна unlink (паттерн правки 346)
        await fs.copyFile(src, destPath, fs.constants.COPYFILE_EXCL)
        copied.push(destPath)
        references.push(destName)
        continue
      }
      return NextResponse.json({ error: 'Референс без name/filename' }, { status: 400 })
    }

    // (правка 938) DiT — только официальная image-модель. Основную модель из
    // Настроек здесь брать нельзя: это видео-веса, с image-нодой они несовместимы.
    // Старое значение из localStorage (видео-модель) молча отбрасываем — в UI
    // такого выбора больше нет.
    const requestedModel = (body.diffusionModel || '').trim()
    const diffusionModel = requestedModel && isImageDiT(requestedModel) ? requestedModel : DEFAULT_IMAGE_MODEL

    // (правка 938) Энхансер промпта: undefined — первый доступный с диска
    // (w4a8_gptq → w4a8), '' или null — выключить.
    const enhancerFiles = listModelFiles(join(cfg.comfyCore, 'models'), 'text_encoders')
    const promptEnhancer =
      body.promptEnhancer === undefined
        ? IMAGE_PE_CANDIDATES.find((c) => enhancerFiles.includes(c)) ?? ''
        : (body.promptEnhancer || '').trim()
    const steps = normalizeImageSteps(body.steps)

    // (правка 935) Два прохода: диапазоны нормализует билдер, здесь те же
    // значения нужны для стадий прогресса и сайдкара. width/height — итог,
    // базовый размер билдер считает из baseScale.
    const tp = imageTwoPassParams(body)

    const run = await runGeneration(() =>
      submitWorkflowJson(
        buildImageWorkflow({
          prompt,
          width,
          height,
          steps,
          seed: body.seed,
          diffusionModel,
          textEncoder: body.textEncoder || DEFAULT_IMAGE_TEXT_ENCODER,
          vae: body.vae || DEFAULT_IMAGE_VAE,
          references,
          lowVramAttention: body.lowVramAttention,
          chunkFeedForward: body.chunkFeedForward,
          promptEnhancer: promptEnhancer || null,
          twoPass: tp.mode,
          baseScale: tp.baseScale,
          denoise2: tp.denoise2,
          steps2: tp.steps2,
          prompt2: (body.prompt2 || '').trim(),
        }),
        imageSamplerStages(tp.mode),
      ),
    )

    if (!run.ok) {
      // Ошибка до/при отправке — убираем свежескопированные референсы,
      // иначе в input/ осиротевшие копии (паттерн правки 344).
      for (const p of copied) await fs.unlink(p).catch(() => {})
      return NextResponse.json({ error: run.error }, { status: run.status })
    }

    if (run.result.prompt_id) {
      setActivePrompt(run.result.prompt_id)
      recordPendingMetaRaw(run.result.prompt_id, {
        model_type: 'minimax_h3_image',
        workflow: 'p-h3-image',
        generation_mode: 'image',
        prompt,
        image_mode: references.length > 0 ? 'edit' : 't2i',
        image_steps: steps,
        image_size: `${width}x${height}`,
        image_model: diffusionModel,
        image_text_encoder: body.textEncoder || DEFAULT_IMAGE_TEXT_ENCODER,
        image_vae: body.vae || DEFAULT_IMAGE_VAE,
        // (правка 938) чем поднимали промпт — чтобы сайдкар позволял повторить
        // чужой результат дословно.
        image_enhancer: promptEnhancer || null,
        // (правка 935) режим проходов и сила второго — то же для повтора.
        image_two_pass: tp.mode,
        ...(tp.mode !== 'off' && {
          image_denoise2: tp.denoise2,
          image_steps2: tp.steps2,
          image_base_scale: tp.baseScale,
          ...(body.prompt2 ? { image_prompt2: String(body.prompt2).trim() } : {}),
        }),
        seed: body.seed ?? null,
        ...(references.length > 0 && {
          references: references.map((r) => ({ type: 'image', path: r })),
        }),
      })
    }
    return NextResponse.json(run.result)
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}
