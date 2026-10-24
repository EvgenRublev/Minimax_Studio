import { NextRequest, NextResponse } from 'next/server'
import { promises as fs } from 'fs'
import { existsSync } from 'fs'
import path from 'path'
import { submitWorkflowJson } from '@/lib/comfy/minimax-h3-client'
import { setActivePrompt } from '@/lib/comfy/progress-tracker'
import { getAppConfig } from '@/lib/app-config'
import { sanitizeFolderPath } from '@/lib/gallery-folders' // (правка 495)
import { runGeneration, assertGenerationAllowed } from '@/lib/vram-arbiter'
import { buildTileUpscaleWorkflow, computeTileGeometry, DEFAULT_TILE_UPSCALE_PROMPT } from '@/lib/comfy/tile-upscale-template'
import { recordPendingMetaRaw } from '@/lib/pending-meta'
import { readPromptChain, readMetaImageRefs, resolveSourceLatent } from '@/lib/refine-meta'
import { probeVideoFile } from '@/lib/video-probe'
import { getVideoFormatSettings } from '@/lib/video-format-server' // (правка 386)
import { enabledCustomLoras, loraTriggerSuffix } from '@/lib/loras-config' // (правка 483)

/**
 * POST /api/comfy/tile-upscale — tiled latent upscale (MMH3UltimateUpscale).
 *
 * Body:
 *   sourceFilename  — имя файла в папке output ComfyUI (или inputSource)
 *   sourceSubfolder — подпапка output
 *   prompt?         — caption (default: enhance-промпт)
 *   seed?           — (-1/undefined = random)
 *   tileSize?       — размер тайла, px (multiple of 32). Default 768.
 *                     Количество тайлов считается автоматически (specific_size).
 *   overlap?        — пространственное перекрытие, px. Default 128.
 *   fade?           — ширина фейда, px. Default 64.
 *   chunkFrames?    — длина временного куска, кадры (multiple of 17). Default 136.
 *   temporalOverlap?— временное перекрытие, кадры. Default 17.
 *   anchorStrength?— 0–1. Default 0.999.
 *   inputSource?    — имя файла уже в ComfyUI input/ (файл с диска).
 *
 * Pipeline: копия output → input (или реюз), ffprobe, сборка workflow
 * (buildTileUpscaleWorkflow) и отправка через общий VRAM-арбитр.
 */
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      sourceFilename?: string
      sourceSubfolder?: string
      prompt?: string
      seed?: number
      tileSize?: number
      overlap?: number
      fade?: number
      chunkFrames?: number
      temporalOverlap?: number
      anchorStrength?: number
      inputSource?: string
      targetResolution?: number
      denoise?: number
      steps?: number
      syncTiles?: boolean
    }

    if (!body?.sourceFilename && !body?.inputSource) {
      return NextResponse.json({ error: 'sourceFilename (или inputSource) обязателен' }, { status: 400 })
    }

    const quickBlock = assertGenerationAllowed()
    if (quickBlock) {
      return NextResponse.json({ error: quickBlock }, { status: 409 })
    }

    const cfg = getAppConfig()

    // (правка 483) LoRA из настроек — как в /api/comfy/generate: модель
    // получает их цепочкой customLoras (турбо-лора — обычная запись, ON по
    // умолчанию), триггерные слова дописываются в conditioning-промпт.
    // В мету промпт пишется БЕЗ триггеров — «Повторить» добавит их заново по актуальному
    // списку, иначе бы они накапливались (правка 89).
    const customLoraEntries = enabledCustomLoras()
    const customLoras = customLoraEntries.length > 0
      ? customLoraEntries.map((e) => ({ name: e.name, strength: e.strength }))
      : undefined
    const loraSuffix = loraTriggerSuffix(customLoraEntries)
    // Промпт для генерации: чистый промпт + триггеры; если промпта нет
    // вовсе, а триггеры есть — базой служит дефолтный enhance-промпт.
    const promptWithTriggers = (p: string | undefined): string | undefined => {
      if (!loraSuffix) return p
      const base = (p ?? '').trim() || DEFAULT_TILE_UPSCALE_PROMPT
      return `${base} ${loraSuffix}`
    }

    // ─── Копия output → input ───
    // (правка 495) Вложенные папки: subfolder — многоуровневый относительный
    // путь ('a/b'); сегменты '.'/'..' отбрасываются (правка 317).
    const sub = sanitizeFolderPath(body.sourceSubfolder || '')
    const safeName = path.basename(body.sourceFilename ?? '')

    // (правка 722) Параметры тайлового апскейла — в сайдкар. Раньше в
    // метаданных не было НИ ОДНОГО из них (ни размера тайла, ни перекрытий,
    // ни denoise/steps): по сайдкару результата нельзя было понять, как он
    // собран. Значения — дефолты из tile-upscale-template.ts.
    const tileCommonMeta = {
      pipeline: 'full',
      tile_size: body.tileSize ?? 768,
      tile_overlap: body.overlap ?? 128,
      tile_fade: body.fade ?? 64,
      chunk_frames: body.chunkFrames ?? 136,
      temporal_overlap: body.temporalOverlap ?? 17,
      anchor_strength: body.anchorStrength ?? 0.999,
      target_resolution: body.targetResolution ?? 1080,
      denoise: body.denoise ?? 0.2,
      // pass1_steps — единый контракт для строки «Шаги» MetaDialog (как у
      // refine/face-refine). Поле steps оставлено: его пишут старые сайдкары.
      pass1_steps: body.steps ?? 2,
      steps: body.steps ?? 2,
      ...(body.syncTiles === true && { sync_tiles: true }),
      ...(customLoras ? { lora: customLoras.map((l) => l.name).join(', ') } : {}),
    }

    // ─── Файл с диска (inputSource) ───
    if (body.inputSource) {
      const inName = path.basename(body.inputSource)
      const inPath = path.join(cfg.inputDir, inName)
      if (!existsSync(inPath)) {
        return NextResponse.json({ error: `Файл не найден в input: ${inName}` }, { status: 404 })
      }
      const userPrompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
      let probe: { width: number; height: number; frames: number }
      try {
        probe = await probeVideoFile(inPath)
      } catch (e) {
        return NextResponse.json(
          { error: `Не удалось прочитать видео: ${e instanceof Error ? e.message : String(e)}` },
          { status: 400 },
        )
      }

      // (правка 479) tile-геометрия для монотонного прогресса
      const tuGeom = computeTileGeometry({
        sourceWidth: probe.width,
        sourceHeight: probe.height,
        targetResolution: body.targetResolution,
        tileSize: body.tileSize,
        overlap: body.overlap,
        chunkFrames: body.chunkFrames,
        temporalOverlap: body.temporalOverlap,
        steps: body.steps,
        sourceFrames: probe.frames,
      })
      const run = await runGeneration(() =>
        submitWorkflowJson(
          buildTileUpscaleWorkflow({
            sourceVideo: inName,
            sourceAudioPath: inPath, // (правка 488) аудио для latent-ветки
            sourceWidth: probe.width,
            sourceHeight: probe.height,
            prompt: promptWithTriggers(userPrompt), // (правка 483) триггеры LoRA
            seed: body.seed,
            tileSize: body.tileSize,
            overlap: body.overlap,
            fade: body.fade,
            chunkFrames: body.chunkFrames,
            temporalOverlap: body.temporalOverlap,
            anchorStrength: body.anchorStrength,
            outputSubfolder: '',
            targetResolution: body.targetResolution,
            denoise: body.denoise,
            steps: body.steps,
            syncTiles: body.syncTiles,
            ...(customLoras ? { customLoras } : {}), // (правка 483)
          }),
          [['tu_upscale']],
          tuGeom,
        ),
      )
      if (!run.ok) {
        return NextResponse.json({ error: run.error }, { status: run.status })
      }
      if (run.result.prompt_id) {
        setActivePrompt(run.result.prompt_id)
        recordPendingMetaRaw(run.result.prompt_id, {
          prompt: userPrompt,
          model_type: 'minimax_h3_tileupscale',
          workflow: 'tile-upscale-MMH3UltimateUpscale',
          generation_mode: 'tileupscale',
          source_video: { filename: inName, subfolder: 'input' },
          source: { width: probe.width, height: probe.height, frames: probe.frames },
          seed: body.seed ?? -1,
          prompt_source: 'user',
          input_source: true,
          ...tileCommonMeta, // (правка 722) параметры тайлов + LoRA
        })
      }
      return NextResponse.json({
        ...run.result,
        inputName: inName,
        inputSource: true,
        source: { width: probe.width, height: probe.height, frames: probe.frames },
        tileInfo: tuGeom ?? undefined, // (правка 479)
      })
    }

    // ─── Файл из галереи (output) ───
    const sourcePath = path.join(cfg.outputDir, sub, safeName)
    // (правка 318) Страховка: итоговый путь обязан остаться внутри outputDir.
    const outputRoot = path.resolve(cfg.outputDir)
    if (!path.resolve(sourcePath).startsWith(outputRoot + path.sep)) {
      return NextResponse.json({ error: 'Invalid path' }, { status: 400 })
    }
    if (!existsSync(sourcePath)) {
      return NextResponse.json({ error: `Файл не найден: ${safeName}` }, { status: 404 })
    }

    await fs.mkdir(cfg.inputDir, { recursive: true })
    let destName = safeName
    let destPath = path.join(cfg.inputDir, destName)
    let n = 1
    while (true) {
      try {
        // (правка 346) COPYFILE_EXCL — атомарно, без unlink-окна;
        // ловим ТОЛЬКО EEXIST, остальные ошибки пробрасываем.
        await fs.copyFile(sourcePath, destPath, fs.constants.COPYFILE_EXCL)
        break
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
        const ext = path.extname(safeName)
        const stem = safeName.slice(0, safeName.length - ext.length)
        // (правка 362) Старый паттерн пропускал _tileup1.
        destName = `${stem}_tileup${n++}${ext}`
        destPath = path.join(cfg.inputDir, destName)
        if (n > 100) return NextResponse.json({ error: 'Too many duplicates' }, { status: 500 })
      }
    }

    let probe: { width: number; height: number; frames: number }
    try {
      probe = await probeVideoFile(destPath)
    } catch (e) {
      await fs.unlink(destPath).catch(() => {})
      return NextResponse.json(
        { error: `Не удалось прочитать видео: ${e instanceof Error ? e.message : String(e)}` },
        { status: 400 },
      )
    }

    // Промпт: пользовательский > цепочка из меты > дефолт
    // (правка 319) readPromptChain вместо readDraftPrompt: для extend-combined
    // наследуем ВСЮ цепочку «исходник → клипы».
    const userPrompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
    const draftPrompt = userPrompt ? null : readPromptChain(sub, safeName)
    const resolvedPrompt = userPrompt || draftPrompt || undefined
    const promptSource = userPrompt ? 'user' : draftPrompt ? 'draft-meta' : 'default'
    // (правка 319) Image-референсы исходника — в мету результата (как у
    // генерации: [{ type: 'image', path, role }]); пустые не пишем.
    const tuMetaRefs = readMetaImageRefs(sub, safeName)

    // ─── (правка 381) Lossless-ветка: латент исходника из меты ───
    // Геометрия цели считается от КАКНВЫ ЛАТЕНТА (она ≥ mp4 из-за кропа
    // генерации): цель «короткая сторона = targetResolution» должна быть
    // не меньше канвы, иначе внутренний латент-апскейлер получил бы
    // уменьшение (запрещено) → fallback на mp4-путь.
    const tileTarget = Number(body.targetResolution) || 1080
    let sourceLatent: string | undefined
    let latentW = probe.width
    let latentH = probe.height
    if (tileTarget >= Math.min(latentW, latentH)) {
      const resolved = resolveSourceLatent(sub, safeName, probe, (reason) =>
        console.warn(`[tile-upscale] lossless-ветка отключена (${safeName}): ${reason}`),
      )
      if (resolved && tileTarget >= Math.min(resolved.width, resolved.height)) {
        sourceLatent = resolved.file
        latentW = resolved.width
        latentH = resolved.height
      }
    }

    // (правка 479) tile-геометрия для монотонного прогресса
    // Размеры: в latent-ветке — канва латента, иначе — пиксели mp4
    const tuSrcW = sourceLatent ? latentW : probe.width
    const tuSrcH = sourceLatent ? latentH : probe.height
    const tuGeom = computeTileGeometry({
      sourceWidth: tuSrcW,
      sourceHeight: tuSrcH,
      targetResolution: body.targetResolution,
      tileSize: body.tileSize,
      overlap: body.overlap,
      chunkFrames: body.chunkFrames,
      temporalOverlap: body.temporalOverlap,
      steps: body.steps,
      sourceFrames: probe.frames,
    })
    const run = await runGeneration(() =>
      submitWorkflowJson(
        buildTileUpscaleWorkflow({
          sourceVideo: destName,
          sourceAudioPath: destPath, // (правка 488) аудио для latent-ветки
          videoFormat: getVideoFormatSettings(), // (правка 386)
          // (правка 381) lossless-ветка: размеры = канва латента, mp4 грузится
          // только первым кадром + аудио; иначе — как раньше (пиксельный путь)
          ...(sourceLatent && { sourceLatent, sourceFrames: probe.frames }),
          sourceWidth: tuSrcW,
          sourceHeight: tuSrcH,
          prompt: promptWithTriggers(resolvedPrompt), // (правка 483) триггеры LoRA
          seed: body.seed,
          tileSize: body.tileSize,
          overlap: body.overlap,
          fade: body.fade,
          chunkFrames: body.chunkFrames,
          temporalOverlap: body.temporalOverlap,
          anchorStrength: body.anchorStrength,
          outputSubfolder: sub,
          targetResolution: body.targetResolution,
          denoise: body.denoise,
          steps: body.steps,
          syncTiles: body.syncTiles,
          ...(customLoras ? { customLoras } : {}), // (правка 483)
        }),
        [['tu_upscale']],
        tuGeom, // (правка 479)
      ),
    )
    if (!run.ok) {
      // (правка 344) Откат копии в input/ — иначе осиротевший файл.
      await fs.unlink(destPath).catch(() => {})
      return NextResponse.json({ error: run.error }, { status: run.status })
    }
    if (run.result.prompt_id) {
      setActivePrompt(run.result.prompt_id)
      recordPendingMetaRaw(run.result.prompt_id, {
        prompt: resolvedPrompt ?? '',
        model_type: 'minimax_h3_tileupscale',
        workflow: 'tile-upscale-MMH3UltimateUpscale',
        generation_mode: 'tileupscale',
        source_video: { filename: safeName, subfolder: sub },
        source: { width: probe.width, height: probe.height, frames: probe.frames },
        seed: body.seed ?? -1,
        prompt_source: promptSource,
        ...tileCommonMeta, // (правка 722) параметры тайлов + LoRA
        // (правка 381) lossless-режим: апскейл стартовал с латента генерации
        ...(sourceLatent && { latent_source: sourceLatent }),
        // (правка 319) наследуем референсы исходника
        ...(tuMetaRefs.length > 0 && {
          references: tuMetaRefs.map((r) => ({ type: 'image', path: r.path, role: r.role })),
        }),
      })
    }

    return NextResponse.json({
      ...run.result,
      inputName: destName,
      source: { width: probe.width, height: probe.height, frames: probe.frames },
      promptSource,
      promptUsed: resolvedPrompt ?? '',
      lossless: !!sourceLatent, // (правка 381)
      tileInfo: tuGeom ?? undefined, // (правка 479)
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
