import { NextRequest, NextResponse } from 'next/server'
import { promises as fs } from 'fs'
import { existsSync } from 'fs'
import path from 'path'
import { submitWorkflowJson } from '@/lib/comfy/minimax-h3-client'
import { setActivePrompt } from '@/lib/comfy/progress-tracker'
import { getAppConfig } from '@/lib/app-config'
import { sanitizeFolderPath } from '@/lib/gallery-folders' // (правка 495)
import { runGeneration, assertGenerationAllowed } from '@/lib/vram-arbiter'
import { buildFpsWorkflow } from '@/lib/comfy/fps-template'
import { recordPendingMetaRaw } from '@/lib/pending-meta'
import { readPromptChain, readMetaImageRefs } from '@/lib/refine-meta'
import { probeVideoFile } from '@/lib/video-probe'
import { getVideoFormatSettings } from '@/lib/video-format-server' // (правка 386)

/**
 * POST /api/comfy/fps — frame interpolation (VFI): RIFE VFI / FILM VFI. (правка 268)
 *
 * Body:
 *   sourceFilename  — имя файла в папке output ComfyUI (или inputSource)
 *   sourceSubfolder — подпапка output
 *   mode?           — 'rife' | 'film'. Default 'rife'.
 *   multiplier?     — множитель FPS (2–1000). Default 2.
 *   (правка 269) rifeModel/filmModel не принимаются: по одной модели на
 *   режим, зафиксированы в fps-template.ts (rife49.pth / film_net_fp32.pt).
 *   rifeBatchSize?  — RIFE batch_size (1–64). Default 4.
 *   rifeScale?      — RIFE scale_factor (0.25|0.5|1|2|4). Default 1.
 *   rifeDtype?      — RIFE dtype (float32|float16|bfloat16). Default 'float16'.
 *   rifeFastMode?   — RIFE fast_mode. Default false.
 *   rifeEnsemble?   — RIFE ensemble. Default true.
 *   clearCacheAfterNFrames? — анти-OOM (1–1000). Default 4.
 *   inputSource?    — имя файла уже в ComfyUI input/ (файл с диска).
 *
 * Pipeline: копия output → input (или реюз), ffprobe (width/height/frames/fps),
 * сборка workflow (buildFpsWorkflow) и отправка через общий VRAM-арбитр.
 */
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      sourceFilename?: string
      sourceSubfolder?: string
      mode?: 'rife' | 'film'
      multiplier?: number
      rifeBatchSize?: number
      rifeScale?: number
      rifeDtype?: string
      rifeFastMode?: boolean
      rifeEnsemble?: boolean
      clearCacheAfterNFrames?: number
      inputSource?: string
    }

    if (!body?.sourceFilename && !body?.inputSource) {
      return NextResponse.json({ error: 'sourceFilename (или inputSource) обязателен' }, { status: 400 })
    }

    const quickBlock = assertGenerationAllowed()
    if (quickBlock) {
      return NextResponse.json({ error: quickBlock }, { status: 409 })
    }

    const cfg = getAppConfig()

    // ─── Копия output → input ───
    // (правка 495) Вложенные папки: subfolder — многоуровневый относительный
    // путь ('a/b'); сегменты '.'/'..' отбрасываются (правка 317).
    const sub = sanitizeFolderPath(body.sourceSubfolder || '')
    const safeName = path.basename(body.sourceFilename ?? '')

    const workflowParams = {
      mode: body.mode,
      multiplier: body.multiplier,
      // (правка 269) Модели RIFE/FILM зафиксированы в fps-template.ts.
      rifeBatchSize: body.rifeBatchSize,
      rifeScale: body.rifeScale,
      rifeDtype: body.rifeDtype,
      rifeFastMode: body.rifeFastMode,
      rifeEnsemble: body.rifeEnsemble,
      clearCacheAfterNFrames: body.clearCacheAfterNFrames,
      outputSubfolder: '',
    }

    // (правка 722) Общие поля сайдкара FPS. Раньше в метаданных вставки
    // кадров не было НИ пайплайна, НИ seed, НИ самих настроек RIFE — по
    // сайдкару результата нельзя было понять, как именно он получен.
    // Итоговую геометрию (кадры/разрешение/длительность) дописывает
    // finalizePendingMeta — пробой самого файла (у FPS кадров в ×multiplier
    // больше, чем в исходнике, плановые цифры не годились).
    const fpsCommonMeta = {
      pipeline: 'full',
      ...(body.mode === 'rife' && {
        rife_batch_size: body.rifeBatchSize ?? null,
        rife_scale: body.rifeScale ?? null,
        rife_dtype: body.rifeDtype ?? null,
        rife_fast_mode: body.rifeFastMode === true,
        rife_ensemble: body.rifeEnsemble === true,
      }),
      ...(body.clearCacheAfterNFrames != null && {
        clear_cache_after_n_frames: body.clearCacheAfterNFrames,
      }),
    }

    // ─── Файл с диска (inputSource) ───
    if (body.inputSource) {
      const inName = path.basename(body.inputSource)
      const inPath = path.join(cfg.inputDir, inName)
      if (!existsSync(inPath)) {
        return NextResponse.json({ error: `Файл не найден в input: ${inName}` }, { status: 404 })
      }
      let probe: { width: number; height: number; frames: number; durationSec: number; fps?: number }
      try {
        probe = await probeVideoFile(inPath)
      } catch (e) {
        return NextResponse.json(
          { error: `Не удалось прочитать видео: ${e instanceof Error ? e.message : String(e)}` },
          { status: 400 },
        )
      }

      // (правка 268) fps из r_frame_rate (probe.fps), fallback — frames/duration.
      const srcFps = probe.fps ?? Math.max(1, Math.min(120, Math.round((probe.frames / Math.max(probe.durationSec, 0.01)) * 100) / 100))
      const run = await runGeneration(() =>
        submitWorkflowJson(
          buildFpsWorkflow({ sourceVideo: inName, sourceFps: srcFps, ...workflowParams, videoFormat: getVideoFormatSettings() }),
        ),
      )
      if (!run.ok) {
        return NextResponse.json({ error: run.error }, { status: run.status })
      }
      if (run.result.prompt_id) {
        setActivePrompt(run.result.prompt_id)
        recordPendingMetaRaw(run.result.prompt_id, {
          model_type: 'minimax_h3_fps',
          workflow: 'fps-RIFE-VFI|FILM-VFI',
          generation_mode: 'fps',
          fps_mode: body.mode ?? 'rife',
          fps_multiplier: body.multiplier ?? 2,
          source_video: { filename: inName, subfolder: 'input' },
          source: { width: probe.width, height: probe.height, frames: probe.frames, fps: srcFps },
          input_source: true,
          ...fpsCommonMeta, // (правка 722)
        })
      }
      return NextResponse.json({
        ...run.result,
        inputName: inName,
        inputSource: true,
        source: { width: probe.width, height: probe.height, frames: probe.frames, fps: srcFps },
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
        // (правка 362) Старый паттерн пропускал _fps1 и давал коллизии без номера.
        destName = `${stem}_fps${n++}${ext}`
        destPath = path.join(cfg.inputDir, destName)
        if (n > 100) return NextResponse.json({ error: 'Too many duplicates' }, { status: 500 })
      }
    }

    let probe: { width: number; height: number; frames: number; durationSec: number; fps?: number }
    try {
      probe = await probeVideoFile(destPath)
    } catch (e) {
      await fs.unlink(destPath).catch(() => {})
      return NextResponse.json(
        { error: `Не удалось прочитать видео: ${e instanceof Error ? e.message : String(e)}` },
        { status: 400 },
      )
    }

    // (правка 319) Наследование из сайдкара исходника: цепочка промптов
    // (для extend-combined — вся цепочка «исходник → клипы») и image-референсы.
    // Нет меты / пусто — поля не добавляем.
    const fpsPrompt = readPromptChain(sub, safeName)
    const fpsMetaRefs = readMetaImageRefs(sub, safeName)

    // (правка 268) fps из r_frame_rate (probe.fps), fallback — frames/duration.
    const srcFps = probe.fps ?? Math.max(1, Math.min(120, Math.round((probe.frames / Math.max(probe.durationSec, 0.01)) * 100) / 100))
    const run = await runGeneration(() =>
      submitWorkflowJson(
        buildFpsWorkflow({ sourceVideo: destName, sourceFps: srcFps, ...workflowParams, outputSubfolder: sub, videoFormat: getVideoFormatSettings() }), // (правка 367) результат — в папку оригинала
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
        model_type: 'minimax_h3_fps',
        workflow: 'fps-RIFE-VFI|FILM-VFI',
        generation_mode: 'fps',
        fps_mode: body.mode ?? 'rife',
        fps_multiplier: body.multiplier ?? 2,
        source_video: { filename: safeName, subfolder: sub },
        source: { width: probe.width, height: probe.height, frames: probe.frames, fps: srcFps },
        ...fpsCommonMeta, // (правка 722)
        // (правка 319) наследуем промпт-цепочку и референсы исходника
        ...(fpsPrompt && { prompt: fpsPrompt }),
        ...(fpsMetaRefs.length > 0 && {
          references: fpsMetaRefs.map((r) => ({ type: 'image', path: r.path, role: r.role })),
        }),
      })
    }
    return NextResponse.json({
      ...run.result,
      source: { width: probe.width, height: probe.height, frames: probe.frames, fps: srcFps },
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}
