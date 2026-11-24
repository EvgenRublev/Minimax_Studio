import { NextRequest, NextResponse } from 'next/server'
import { promises as fs } from 'fs'
import { existsSync } from 'fs'
import path from 'path'
import { submitWorkflowJson } from '@/lib/comfy/minimax-h3-client'
import { setActivePrompt } from '@/lib/comfy/progress-tracker'
import { getAppConfig } from '@/lib/app-config'
import { sanitizeFolderPath } from '@/lib/gallery-folders'
import { runGeneration, assertGenerationAllowed } from '@/lib/vram-arbiter'
import {
  buildFaceRefineWorkflow,
  DEFAULT_FACE_DENOISE,
  DEFAULT_FACE_STEPS,
  type FaceIdentityModel,
  type FacePasteRegion,
  type FaceSelectMode,
  type FaceUndetected,
} from '@/lib/comfy/face-refine-template'
import { recordPendingMetaRaw } from '@/lib/pending-meta'
import { readMetaImageRefs, readPromptChain } from '@/lib/refine-meta'
import { probeVideoFile } from '@/lib/video-probe'
import { getVideoFormatSettings } from '@/lib/video-format-server'
import { resolveFaceDetectors } from '@/lib/comfy/face-detectors'
import { gpuVramTotalGb, resolveBoundedAttention, normalizeBoundedAttentionMode } from '@/lib/comfy/gpu-vram' // (правка 1089)
import { enabledCustomLoras, TURBO_LORA_NAME } from '@/lib/loras-config'
import { st } from '@/lib/i18n/server'
import { promisify } from 'util'
import { execFile } from 'child_process'
import { resolveFfmpeg } from '@/lib/thumb'

const execFileAsync = promisify(execFile)

/**
 * POST /api/comfy/face-refine — перерисовка мелких лиц в готовом видео
 * (набор нод ComfyUI-H3-FaceRefine).
 *
 * Body:
 *   sourceFilename/sourceSubfolder — ролик из галереи (или inputSource — файл
 *                                    с диска, уже в ComfyUI input/)
 *   prompt?            — caption; по умолчанию берётся цепочка промптов из
 *                        сайдкара исходника (сцена и персонажи те же)
 *   seed?              — (-1 = random)
 *   canvas?            — канва H3, px (512 дешевле 768 в 2.25×). Default 512
 *   denoise?           — базовый denoise. Default 0.35
 *   steps?             — шаги (должны совпадать с турбо-лорой). Default 4
 *   select?            — правило выбора субъекта
 *   selectIndex?       — номер лица в рейтинге правила
 *   facePoint?         — (правка 723) {x, y, frame}: клик по лицу в превью
 *                        исходника; правило при этом игнорируется
 *   identityReference? — файл в input/: «перерисуй ЭТОГО человека»
 *   identityModel?     — insightface | clip_vision | ccip
 *   refImages?         — картинки-референсы персонажа (файлы в input/)
 */
export const dynamic = 'force-dynamic'

/**
 * (правка 722) GET — какие детекторы реально доступны. Значения комбо у
 * ComfyUI зависят от регистрации models/ultralytics, поэтому хардкод имени
 * face_yolov8m.pt после регистрации перестаёт быть валидным (появляется
 * bbox\face_yolov8m.pt). Вкладка спрашивает список, чтобы показать чекбокс
 * «далёкие планы» только когда модель человека есть.
 *
 * (правка 723) Ещё отдаёт параметры исходника (width/height/fps/frames), если
 * передать файл: ?input=<имя в input/> или ?filename=&subfolder= (output).
 * Вкладке нужен fps, чтобы превратить таймкод клика по превью в номер кадра:
 * X/Y в ноде — пиксели КАДРА, а frame_index — кадр, на котором мерить.
 */
export async function GET(req: NextRequest) {
  const { detector, fallbackDetector } = await resolveFaceDetectors()
  const q = req.nextUrl.searchParams
  const inputName = q.get('input')
  const filename = q.get('filename')
  if (!inputName && !filename) return NextResponse.json({ detector, fallbackDetector })

  const cfg = getAppConfig()
  let file: string
  if (inputName) {
    file = path.join(cfg.inputDir, path.basename(inputName))
  } else {
    const sub = sanitizeFolderPath(q.get('subfolder') || '')
    file = path.join(cfg.outputDir, sub, path.basename(filename as string))
    const outputRoot = path.resolve(cfg.outputDir)
    if (!path.resolve(file).startsWith(outputRoot + path.sep)) {
      return NextResponse.json({ error: 'Invalid path' }, { status: 400 })
    }
  }
  if (!existsSync(file)) return NextResponse.json({ detector, fallbackDetector, probe: null })
  try {
    return NextResponse.json({ detector, fallbackDetector, probe: await probeVideoFile(file) })
  } catch {
    // Превью всё равно откроется: клик по нему посчитается по fps=24.
    return NextResponse.json({ detector, fallbackDetector, probe: null })
  }
}

export async function POST(req: NextRequest) {

  try {
    const body = await req.json() as {
      sourceFilename?: string
      sourceSubfolder?: string
      outputSubfolder?: string
      inputSource?: string
      prompt?: string
      seed?: number
      canvas?: number
      denoise?: number
      steps?: number
      sampler?: string
      select?: FaceSelectMode
      selectIndex?: number
      identityReference?: string
      identityModel?: FaceIdentityModel
      identityThreshold?: number
      identityTrack?: boolean
      cropFactor?: number
      confidence?: number
      pasteRegion?: FacePasteRegion
      feather?: number
      colourMatch?: number
      blend?: number
      undetectedFrames?: FaceUndetected
      denoiseSmall?: number
      denoiseLarge?: number
      refImages?: string[]
      refImageSize?: 'match' | 'max'
      /** (правка 889) Аудио-гайд мимики: дорожка исходника → MiniMaxH3AddGuide. */
      audioGuide?: boolean
      /** (правка 722) Детектор человека на кадрах, где лица не видно. */
      fallback?: boolean
      /** (правка 723) Клик по лицу в превью: пиксели кадра + его номер. */
      facePoint?: { x?: number; y?: number; frame?: number }
      /** (правка 1089) «Bounded Attention» из настроек: 'auto' | 'on' | 'off'. */
      boundedAttentionMode?: unknown
      /** (правка 1095) token_chunk bounded attention (0 = 4096). */
      boundedTokenChunk?: number
    }

    if (!body?.sourceFilename && !body?.inputSource) {
      return NextResponse.json({ error: st("sourceFilename (или inputSource) обязателен") }, { status: 400 })
    }

    const quickBlock = assertGenerationAllowed()
    if (quickBlock) {
      return NextResponse.json({ error: quickBlock }, { status: 409 })
    }

    const cfg = getAppConfig()

    // ─── Источник: файл с диска (input/) или копия из галереи ───
    const sub = sanitizeFolderPath(body.sourceSubfolder || '')
    const outSub = sanitizeFolderPath(typeof body.outputSubfolder === 'string' ? body.outputSubfolder : sub)
    // (правка 1048) sourceFilename — только строка (см. fps/route.ts)
    const safeName = path.basename(typeof body.sourceFilename === 'string' ? body.sourceFilename : '')
    let inName: string
    let probe: { width: number; height: number; frames: number; durationSec: number; fps?: number }
    let promptSource: 'user' | 'draft-meta' | 'default' = 'user'
    let metaRefs: Array<{ path: string; role: string }> = []
    /** (правка 1125) сколько кадров оставить в итоге (вход добит клоном до сетки) */
    let trimFrames: number | undefined

    if (typeof body.inputSource === 'string' && body.inputSource) {
      inName = path.basename(body.inputSource)
      const inPath = path.join(cfg.inputDir, inName)
      if (!existsSync(inPath)) {
        return NextResponse.json({ error: st("Файл не найден в input: {{p1}}", { p1: inName }) }, { status: 404 })
      }
      try {
        probe = await probeVideoFile(inPath)
      } catch (e) {
        return NextResponse.json(
          { error: st("Не удалось прочитать видео: {{p1}}", { p1: e instanceof Error ? e.message : String(e) }) },
          { status: 400 },
        )
      }
    } else {
      const sourcePath = path.join(cfg.outputDir, sub, safeName)
      const outputRoot = path.resolve(cfg.outputDir)
      if (!path.resolve(sourcePath).startsWith(outputRoot + path.sep)) {
        return NextResponse.json({ error: 'Invalid path' }, { status: 400 })
      }
      if (!existsSync(sourcePath)) {
        return NextResponse.json({ error: st("Файл не найден: {{p1}}", { p1: safeName }) }, { status: 404 })
      }
      // Копия output → input (без перезаписи чужих файлов — суффикс при коллизии).
      await fs.mkdir(cfg.inputDir, { recursive: true })
      inName = safeName
      let destPath = path.join(cfg.inputDir, inName)
      let n = 1
      while (true) {
        try {
          await fs.copyFile(sourcePath, destPath, fs.constants.COPYFILE_EXCL)
          break
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
          const ext = path.extname(safeName)
          const stem = safeName.slice(0, safeName.length - ext.length)
          inName = `${stem}_facerefine${n++}${ext}`
          destPath = path.join(cfg.inputDir, inName)
          if (n > 100) return NextResponse.json({ error: 'Too many duplicates' }, { status: 500 })
        }
      }
      try {
        probe = await probeVideoFile(destPath)
      } catch (e) {
        await fs.unlink(destPath).catch(() => {})
        return NextResponse.json(
          { error: st("Не удалось прочитать видео: {{p1}}", { p1: e instanceof Error ? e.message : String(e) }) },
          { status: 400 },
        )
      }

      // (правка 1125) Сетка H3 — 17k+5 кадров. Если исходник не по сетке, H3
      // округляет длину ВВЕРХ и добивает хвост референсным контентом; после
      // stitch это давало шумный квадрат на лице в последних кадрах (особенно
      // после «Обрезать», где длина почти никогда не попадает на сетку).
      // Паддим ВХОД клоном последнего кадра до сетки — модель видит реальные
      // кадры, без подмены контентом, — а в графе режем итог обратно до
      // исходной длины (GetImageRangeFromBatch). Звук VHS подрезает по -shortest.
      if (probe.frames > 0 && (((probe.frames - 5) % 17) + 17) % 17 !== 0) {
        let aligned = probe.frames
        while ((((aligned - 5) % 17) + 17) % 17 !== 0) aligned++
        const pad = aligned - probe.frames
        if (pad > 0 && pad <= 16) {
          try {
            const bin = await resolveFfmpeg()
            const ext = path.extname(inName)
            const paddedName = `${inName.slice(0, inName.length - ext.length)}_gridpad${ext}`
            const paddedPath = path.join(cfg.inputDir, paddedName)
            const fps = probe.fps && probe.fps > 0 ? probe.fps : 24
            await execFileAsync(bin, [
              '-hide_banner', '-loglevel', 'error',
              '-i', destPath,
              '-vf', `tpad=stop_mode=clone:stop_duration=${(pad / fps).toFixed(4)}`,
              '-frames:v', String(aligned),
              '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '10',
              '-pix_fmt', 'yuv420p', '-an', '-y', paddedPath,
            ])
            const pp = await probeVideoFile(paddedPath)
            if (pp.frames >= probe.frames + pad) {
              console.log(`[face-refine] сетка H3: ${probe.frames} → ${aligned} кадров (клон хвоста), итог обрежется до ${probe.frames}`)
              inName = paddedName
              trimFrames = probe.frames
            } else {
              await fs.unlink(paddedPath).catch(() => {})
              console.warn(`[face-refine] паддинг не дал нужную длину (${pp.frames}), работаю без него`)
            }
          } catch (e) {
            console.warn(`[face-refine] паддинг до сетки не удался: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
      }
      // Промпт и референсы — из сайдкара исходника: Face Refine перерисовывает
      // ЛИЦО, сцена и персонажи должны остаться теми же.
      const chain = readPromptChain(sub, safeName)
      if (chain && !body.prompt?.trim()) promptSource = 'draft-meta'
      metaRefs = readMetaImageRefs(sub, safeName)
    }

    // ─── Промпт: пользовательский > цепочка из меты исходника ───
    const userPrompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
    const chainPrompt = body.inputSource ? null : readPromptChain(sub, safeName)
    const prompt = userPrompt || chainPrompt || ''
    if (!userPrompt) promptSource = chainPrompt ? 'draft-meta' : 'default'

    // ─── Референсы персонажа: заданные > из меты исходника ───
    const refImages = (body.refImages ?? []).filter((n) => typeof n === 'string' && n.length > 0)
    const usedRefs = refImages.length > 0
      ? refImages
      : metaRefs.map((r) => r.path)

    // (правка 723) Точка клика: клампим к реальному кадру — ComfyUI отклонит
    // промпт, только если значение выйдет за max виджета (16384), а промах
    // на десяток пикселей из-за масштаба превью безвреден.
    const fp = body.facePoint
    const facePoint = fp && Number.isFinite(fp.x) && Number.isFinite(fp.y)
      ? {
          x: Math.max(0, Math.min(Math.max(1, probe.width) - 1, Math.round(fp.x as number))),
          y: Math.max(0, Math.min(Math.max(1, probe.height) - 1, Math.round(fp.y as number))),
          frame: Math.max(0, Math.min(Math.max(0, probe.frames - 1), Math.round(fp.frame ?? 0))),
        }
      : undefined

    // Референс лица «этого человека» должен лежать в input/.
    //
    // (правка 1013) Точка выбирает конкретное лицо на кадре (X/Y),
    // identity_reference помогает удерживать этого человека дальше.
    // Раньше при точке референс вообще не подавался в workflow — теперь оба
    // параметра идут вместе.
    const identityReference = body.identityReference
      ? path.basename(body.identityReference)
      : undefined
    // (правка 1013) Точка и референс теперь работают вместе: точка выбирает
    // конкретное лицо на кадре, референс дальше помогает удержать именно его.
    const identityReferenceForRun = identityReference
    if (identityReferenceForRun && !existsSync(path.join(cfg.inputDir, identityReferenceForRun))) {
      return NextResponse.json(
        { error: st("Референс лица не найден в input: {{p1}}", { p1: identityReferenceForRun }) },
        { status: 404 },
      )
    }

    const steps = Math.max(1, Math.min(64, Math.round(body.steps ?? DEFAULT_FACE_STEPS)))
    const denoise = Math.max(0.01, Math.min(1, body.denoise ?? DEFAULT_FACE_DENOISE))
    const canvas = Math.max(128, Math.min(1344, Math.round((body.canvas ?? 512) / 32) * 32))
    // RandomNoise требует неотрицательный сид: -1 ComfyUI не принимает.
    // Конкретный сид разрешаем сами (как вкладка «Генерация») и пишем его в
    // метаданные — иначе повтор не воспроизвести.
    const seed = (body.seed ?? -1) < 0 ? Math.floor(Math.random() * 2 ** 31) : (body.seed ?? -1)

    // (правка 1089) Bounded attention — общее авторешение по VRAM + настройка
    // auto/on/off (Face Refine не использует Veda, поэтому исключение не нужно).
    const boundedAttention = resolveBoundedAttention(
      normalizeBoundedAttentionMode(body.boundedAttentionMode),
      await gpuVramTotalGb(),
    )

    // (правка 722) Детекторы берём из комбо живого ComfyUI: после регистрации
    // папки models/ultralytics имена приходят с подпапкой (bbox\face_yolov8m.pt),
    // и старое значение без подпапки валидация промпта отклонила бы.
    const detectors = await resolveFaceDetectors()
    const fallbackDetector =
      body.fallback === true && detectors.fallbackDetector ? detectors.fallbackDetector : 'none'
    const fallbackUnavailable = body.fallback === true && !detectors.fallbackDetector

    // Встроенная турбо-лора — ON по умолчанию, как и в остальных режимах.
    // Шаги face-refine по умолчанию 4 — ровно под эту 4-шаговую лору.
    const turboLoraEntry = enabledCustomLoras().find((e) => e.name === TURBO_LORA_NAME)
    const turboLora = turboLoraEntry?.name

    const workflow = buildFaceRefineWorkflow({
      sourceVideo: inName,
      diffusionModel: cfg.diffusionModel || undefined,
      boundedAttention, // (правка 1089)
      // (правка 1095) token_chunk из настроек (0 = 4096)
      boundedTokenChunk: body.boundedTokenChunk,
      prompt,
      seed,
      canvas,
      denoise,
      steps,
      lora: turboLora,
      loraStrength: turboLoraEntry?.strength,
      sampler: body.sampler,
      select: body.select,
      selectIndex: body.selectIndex,
      facePoint,
      identityReference: identityReferenceForRun,
      identityModel: body.identityModel,
      identityThreshold: body.identityThreshold,
      identityTrack: body.identityTrack,
      cropFactor: body.cropFactor,
      confidence: body.confidence,
      detector: detectors.detector,
      fallbackDetector,
      pasteRegion: body.pasteRegion,
      feather: body.feather,
      colourMatch: body.colourMatch,
      blend: body.blend,
      undetectedFrames: body.undetectedFrames,
      denoiseSmall: body.denoiseSmall,
      denoiseLarge: body.denoiseLarge,
      refImages: usedRefs,
      refImageSize: body.refImageSize,
      // (правка 889) аудио-гайд: дорожка исходника как гайд мимики (см. шаблон).
      audioGuide: body.audioGuide === true,
      // Размеры/длина исходника — для .latent-сайдкара итога (ceil32-канва,
      // тишина нужной длины у беззвучных): повторный рефайн этого видео
      // пойдёт по lossless-латентному пути.
      width: probe.width,
      height: probe.height,
      frames: probe.frames,
      // (правка 1125) сколько кадров оставить после stitch: вход мог быть
      // добит клоном хвоста до сетки H3, лишнее отрезаем в графе
      trimFrames,
      outputSubfolder: outSub,
      videoFormat: getVideoFormatSettings(),
    })

    const run = await runGeneration(() =>
      submitWorkflowJson(workflow, [['fr_sample']]))
    if (!run.ok) {
      return NextResponse.json({ error: run.error }, { status: run.status })
    }

    if (run.result.prompt_id) {
      setActivePrompt(run.result.prompt_id)
      recordPendingMetaRaw(run.result.prompt_id, {
        prompt,
        model_type: 'minimax_h3_ref2va',
        workflow: 'face-refine-track-crop-stitch',
        generation_mode: 'facerefine',
        source_video: { filename: safeName || inName, subfolder: sub },
        source: { width: probe.width, height: probe.height, frames: probe.frames },
        seed,
        prompt_source: promptSource,
        canvas,
        denoise,
        // Шаги — в поле pass1_steps (единый контракт сайдкаров: его читает
        // строка «Шаги» в MetaDialog; так же пишет refine-роут). Старые
        // сайдкары с полем steps диалог понимает через fallback.
        pass1_steps: steps,
        ...(turboLora && { lora: turboLora }),
        sampler: body.sampler || 'euler',
        select: facePoint ? 'closest_to_xy' : (body.select || 'largest_face'),
        select_index: body.selectIndex ?? 0,
        ...(facePoint && {
          face_point: { x: facePoint.x, y: facePoint.y, frame: facePoint.frame },
        }),
        ...(identityReferenceForRun && { identity_reference: identityReferenceForRun }),
        ...(body.identityModel && { identity_model: body.identityModel }),
        // (правка 889) галочка «Использовать аудио» — в сайдкар для повторов.
        audio_guide: body.audioGuide === true,
        crop_factor: body.cropFactor ?? 2.5,
        confidence: body.confidence ?? 0.35,
        detector: detectors.detector,
        ...(fallbackDetector !== 'none' && { fallback_detector: fallbackDetector }),
        paste_region: body.pasteRegion || 'face_only',
        feather: body.feather ?? 6,
        colour_match: body.colourMatch ?? 1,
        blend: body.blend ?? 1,
        undetected_frames: body.undetectedFrames || 'fade_out',
        denoise_multiplier_small_face: body.denoiseSmall ?? 1.0,
        denoise_multiplier_large_face: body.denoiseLarge ?? 0.35,
        ...(usedRefs.length > 0 && {
          references: usedRefs.map((p) => ({
            type: 'image',
            path: p,
            role: metaRefs.find((r) => r.path === p)?.role || '',
          })),
        }),
      })
    }

    return NextResponse.json({
      ...run.result,
      inputName: inName,
      source: { width: probe.width, height: probe.height, frames: probe.frames },
      promptSource,
      detector: detectors.detector,
      fallbackDetector,
      fallbackUnavailable,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[face-refine] ERROR:', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
