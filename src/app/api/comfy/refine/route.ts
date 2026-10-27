import { NextRequest, NextResponse } from 'next/server'
import { promises as fs } from 'fs'
import { existsSync } from 'fs'
import path from 'path'
import { submitRefine, submitWorkflowJson } from '@/lib/comfy/minimax-h3-client'
import { setActivePrompt } from '@/lib/comfy/progress-tracker'
import { getAppConfig } from '@/lib/app-config'
import { sanitizeFolderPath } from '@/lib/gallery-folders' // (правка 495)
import { runGeneration, assertGenerationAllowed } from '@/lib/vram-arbiter'
import { refineDimensions, buildChunkedRefineWorkflow, planChunkWindows, refineChunkStages } from '@/lib/comfy/refine-template'
import { recordPendingMetaRaw } from '@/lib/pending-meta'
import { readPromptChain, readPromptChainParts, readMetaImageRefs, resolveSourceLatent } from '@/lib/refine-meta'
import { probeVideoFile } from '@/lib/video-probe'
import { getVideoFormatSettings } from '@/lib/video-format-server' // (правка 386)
import { enabledCustomLoras, loraTriggerSuffix } from '@/lib/loras-config' // (правка 483)

/**
 * POST /api/comfy/refine — генеративный v2v-апскейл готового видео
 * (латентная схема Pass 2: VAEEncode исходника → LatentUpscaler3D →
 * короткий проход по сигма-лестнице Pass 2).
 *
 * Body:
 *   sourceFilename  — имя файла в папке output ComfyUI (общая галерея)
 *   sourceSubfolder — подпапка output ('' = корень)
 *   target          — 'same' | 'x2' | 720 | 1080 (короткая сторона цели;
 *                     'x2' = удвоение разрешения — латентный ×2-рецепт)
 *   prompt?         — caption (default: enhance-промпт)
 *   seed?           — (-1/undefined = random)
 *   steps?          — сигма-лестница: 3 (default) | 4 | 5 | 6 | 7 шагов
 *   sigmaStart?     — σ_start лестницы (0.1–0.95, «сколько шума убирать»;
 *                     undefined = эталонная лестница)
 *   (режим «Частями», параметры куска):
 *   skipFrames?     — пропустить первые N кадров (старт куска)
 *   frameCap?       — загрузить N кадров (длина куска)
 *   chunkJob?       — джоб куска: выход без аудио, префикс refinepart
 *   inputName?      — реюз уже скопированного в input файла (со 2-го куска)
 *   sourceWidth?/sourceHeight? — размеры при реюже inputName (без ffprobe)
 *
 * Пайплайн: копия output → input (или реюз), ffprobe (W/H), сборка workflow
 * (buildRefineWorkflow) и отправка через общий VRAM-арбитр.
 */
export const dynamic = 'force-dynamic'

/** (правка 318) references в сайдкар — в том же формате, что пишет генерация
 *  (pending-meta.ts bodyToMetaParams): [{ type: 'image', path, role }]. */
function metaRefsForSidecar(refs: Array<{ path: string; role: string }>) {
  return refs.map((r) => ({ type: 'image', path: r.path, role: r.role }))
}

/** (правка 494) Мегапиксели → короткая сторона (чётная), с сохранением
 *  пропорций источника. Потолок 2160 = короткая сторона 4K. */
function targetFromMp(srcW: number, srcH: number, mp: number): number {
  const clampMp = Math.min(8.3, Math.max(0.05, mp))
  const scale = Math.sqrt((clampMp * 1e6) / (srcW * srcH))
  const short = Math.min(srcW, srcH) * scale
  return Math.min(2160, Math.max(144, 2 * Math.round(short / 2)))
}

/** (правка 494) Эффективная цель: targetMp перебивает target. */
function effectiveTarget(
  body: { target?: 'same' | 'x2' | number; targetMp?: number },
  srcW: number,
  srcH: number,
): 'same' | 'x2' | number {
  if (typeof body.targetMp === 'number' && Number.isFinite(body.targetMp) && body.targetMp > 0) {
    return targetFromMp(srcW, srcH, body.targetMp)
  }
  return body.target === 'same' || body.target === 'x2' || typeof body.target === 'number'
    ? body.target
    : 'same'
}

export async function POST(req: NextRequest) {
  // (правка 716) copiedPath вынесен из try — внешний catch должен иметь
  // возможность удалить свежую копию в input/, если что-то упало ДО отправки
  // задачи в ComfyUI. Раньше переменная жила внутри try, и осиротевшие копии
  // (а каждый прогон рефайна копирует исходник в input/) накапливались.
  let copiedPath: string | null = null
  let submitted = false
  try {
    const body = await req.json() as {
      sourceFilename?: string
      sourceSubfolder?: string
      target?: 'same' | 'x2' | number
      prompt?: string
      seed?: number
      steps?: number
      /** σ_start лестницы (0.1–0.95) — ползунок «сколько шума убирать». */
      sigmaStart?: number
      skipFrames?: number
      frameCap?: number
      chunkJob?: boolean
      inputName?: string
      sourceWidth?: number
      sourceHeight?: number
      /** (правка 253) 'chunks' — единый латент-маскированный воркфлоу. */
      mode?: 'whole' | 'chunks'
      chunkSeconds?: number
      /** (правка 265) Имя файла, уже лежащего в ComfyUI input/ (файл с диска,
          загруженный через /api/comfy/upload). Источником считается этот файл,
          а не копия из output. */
      inputSource?: string
      /** (правка 317) Режим размера референсов ('match' | 'max', дефолт 'max'). */
      refImageSize?: 'match' | 'max'
      /** (правка 408) Veda Sparse Attention + настройки ноды. */
      vedaAttention?: boolean
      vedaGeneratedSparsity?: string
      vedaReferenceSparsity?: string
      vedaFullAttentionLayers?: string
      vedaFullAttentionSteps?: string
      vedaVerbose?: boolean
      /** (правка 466) Sol-Attn + настройки ноды (тоггл из настроек программы). */
      sparseAttention?: boolean
      sparseTau?: number
      sparseStartPercent?: number
      sparseEndPercent?: number
      sparseMinTokens?: number
      sparseExtraTokens?: number
      /** (правка 494) «Свободное разрешение»: цель в мегапикселях (до 4K =
       *  8.3 Мп). Перебивает target — конвертация в короткую сторону здесь,
       *  по реальным размерам источника (канва латента в lossless-ветке). */
      targetMp?: number
      /** (правка 509) Картинки-референсы от пользователя (имена файлов в
       *  input/, до 8) — для источников с диска (inputSource), у которых
       *  нет .meta.json с референсами. Занимают слоты <Picture 1..N>,
       *  первый кадр исходника добавляется последним, как обычно. */
      refImages?: string[]
    }

    if (!body?.sourceFilename && !body?.inputSource) {
      return NextResponse.json({ error: 'sourceFilename (или inputSource) обязателен' }, { status: 400 })
    }

    // Fast-path 409 (как в /api/comfy/generate): ассистент занят — не тратим
    // время на копирование и пробу файла.
    const quickBlock = assertGenerationAllowed()
    if (quickBlock) {
      return NextResponse.json({ error: quickBlock }, { status: 409 })
    }

    const cfg = getAppConfig()

    // (правка 483) LoRA из настроек — как в /api/comfy/generate: модель
    // получает их цепочкой customLoras (турбо-лора — обычная запись, ON по
    // умолчанию), триггерные слова — суффиксом conditioning-промпта (promptSuffix).
    // В мету промпт пишется БЕЗ триггеров — «Повторить» добавит их заново
    // по актуальному списку, иначе бы они накапливались (правка 89).
    const customLoraEntries = enabledCustomLoras()
    const customLoras = customLoraEntries.length > 0
      ? customLoraEntries.map((e) => ({ name: e.name, strength: e.strength }))
      : undefined
    const loraSuffix = loraTriggerSuffix(customLoraEntries)
    const loraParams = {
      ...(customLoras ? { customLoras } : {}),
      ...(loraSuffix ? { promptSuffix: loraSuffix } : {}),
    }

    // (правка 317) Режим размера референсов: валидация, дефолт 'max'
    // (требование пользователя — точнее идентичность).
    const refImageSize: 'match' | 'max' = body.refImageSize === 'match' ? 'match' : 'max'

    // (правка 408) Veda Sparse Attention: тоггл + параметры ноды (валидация
    // формата — в refine-template через clampVedaSparsity/sanitizeVedaIndexList).
    const veda = body.vedaAttention === true
      ? {
          vedaAttention: true as const,
          vedaGeneratedSparsity: body.vedaGeneratedSparsity,
          vedaReferenceSparsity: body.vedaReferenceSparsity,
          vedaFullAttentionLayers: body.vedaFullAttentionLayers,
          vedaFullAttentionSteps: body.vedaFullAttentionSteps,
          vedaVerbose: body.vedaVerbose === true,
        }
      : {}
    // То же — в сайдкар-мету, чтобы «Повторить» восстанавливал настройки.
    const vedaMeta = body.vedaAttention === true
      ? {
          veda_attention: true,
          veda_generated_sparsity: body.vedaGeneratedSparsity ?? '90%',
          veda_reference_sparsity: body.vedaReferenceSparsity ?? '90%',
          veda_full_attention_layers: body.vedaFullAttentionLayers ?? '',
          veda_full_attention_steps: body.vedaFullAttentionSteps ?? '',
          veda_verbose: body.vedaVerbose === true,
        }
      : {}

    // (правка 466) Sol-Attn: тоггл + параметры ноды (раньше в refine воркфлоу
    // Sol-Attn вообще не доходил — роут не пробрасывал sparseAttention).
    const sparse = body.sparseAttention === true
      ? {
          sparseAttention: true as const,
          sparseTau: body.sparseTau,
          sparseStartPercent: body.sparseStartPercent,
          sparseEndPercent: body.sparseEndPercent,
          sparseMinTokens: body.sparseMinTokens,
          sparseExtraTokens: body.sparseExtraTokens,
        }
      : {}

    // (правка 722) Sol-Attn — в сайдкар. Раньше настройки Sol-Attn уходили
    // только в воркфлоу, а в метаданные попадал лишь veda_* — «Повторить»
    // терял половину настроек внимания, а по метаданным нельзя было понять,
    // как именно считался ролик.
    const sparseMeta = body.sparseAttention === true
      ? {
          sparse_attention: true,
          sparse_tau: body.sparseTau ?? 1.3,
          sparse_start_percent: body.sparseStartPercent ?? 0.2,
          sparse_end_percent: body.sparseEndPercent ?? 1.0,
          sparse_min_tokens: body.sparseMinTokens ?? 12288,
          sparse_extra_tokens: body.sparseExtraTokens ?? 256,
        }
      : {}
    // (правка 722) Реально применённые кастомные LoRA — как в /api/comfy/generate
    // (там это делает bodyToMetaParams). Здесь роут сам знает список.
    const loraMeta = customLoras
      ? { lora: customLoras.map((l) => l.name).join(', ') }
      : {}
    // (правка 722) Общие поля сайдкара рефайна. Раньше в метаданных рефайна
    // НЕ БЫЛО пайплайна, шагов, сэмплера и настроек внимания — по сайдкару
    // нельзя было понять, чем именно считался ролик. Значения — как в
    // refine-template.ts: сэмплер euler (res_multistep на «лёгком» 2-шаговом
    // проходе), LowVRAMAttention + ChunkFeedForward всегда включены.
    const refineCommonMeta = {
      pipeline: 'full',
      pass1_steps: body.steps ?? 3,
      pass1_sampler: body.steps === 2 ? 'res_multistep' : 'euler',
      pass1_scheduler: body.steps === 2 ? 'simple' : 'manual-sigmas',
      low_vram_attention: true,
      chunk_feed_forward: true,
      // (правка 736, 737) Audio Guide по дорожке исходника теперь всегда
      // в графе рефайна — фиксируем в сайдкаре, как у Generate-ref.
      audio_guide: true,
      // (правка 737) И на выход всегда муксится оригинальная дорожка
      // исходника (вместо перегенерированного звука) — тоже всегда.
      keep_original_audio: true,
      ...sparseMeta,
      ...loraMeta,
    }

    // ─── Копия output → input (без перезаписи чужих файлов — суффикс при коллизии) ───
    // (правка 495) Вложенные папки: subfolder — многоуровневый относительный
    // путь ('a/b'); сегменты '.'/'..' отбрасываются (правки 317/338).
    const sub = sanitizeFolderPath(body.sourceSubfolder || '')
    const safeName = path.basename(body.sourceFilename ?? '')

    // (правка 265) Источник уже в ComfyUI input/ (файл с диска, загруженный
    // через /api/comfy/upload) — работаем с ним напрямую, без копий из output.
    // Промпт берём только из пользовательского (сайдкара у диска-файла нет).
    if (body.inputSource) {
      const inName = path.basename(body.inputSource)
      const inPath = path.join(cfg.inputDir, inName)
      if (!existsSync(inPath)) {
        return NextResponse.json({ error: `Файл не найден в input: ${inName}` }, { status: 404 })
      }
      const userPrompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
      // (правка 509) Референсы от пользователя: у файла с диска нет
      // .meta.json — картинки заливаются клиентом в input/ и подаются в
      // conditioning (слоты <Picture 1..N>, первый кадр — последним).
      const userRefImages: Array<{ path: string; role: string }> = []
      for (const raw of (body.refImages ?? []).slice(0, 8)) {
        const name = path.basename(String(raw ?? ''))
        if (!name) continue
        if (!existsSync(path.join(cfg.inputDir, name))) {
          return NextResponse.json({ error: `Референс не найден в input: ${name}` }, { status: 404 })
        }
        userRefImages.push({ path: name, role: '' })
      }
      // (правка 265, фикс) Файл уже в input/ — пробуем размеры/кадры и
      // дальше по общему пути (whole / chunks) с реальными dims.
      let probe: { width: number; height: number; frames: number }
      try {
        probe = await probeVideoFile(inPath)
      } catch (e) {
        return NextResponse.json(
          { error: `Не удалось прочитать видео: ${e instanceof Error ? e.message : String(e)}` },
          { status: 400 },
        )
      }
      // (правка 265) Дальше идёт общий путь: destName = inName, копий не делаем.
      // (правка 494) Цель: число/пресет из body.target, либо Мп (targetMp)
      // (правка 587) Валидация числового target — та же, что у галерейной
      // ветки ниже: мусор (5 / 99999) строил воркфлоу с бессмысленной канвой.
      if (
        typeof body.target === 'number' &&
        (!Number.isFinite(body.target) || body.target < 144 || body.target > 2160)
      ) {
        return NextResponse.json({ error: 'Недопустимое целевое разрешение' }, { status: 400 })
      }
      const target: 'same' | 'x2' | number = effectiveTarget(body, probe.width, probe.height)
      const dims = refineDimensions(probe.width, probe.height, target)
      const srcW = probe.width
      const srcH = probe.height
      // (правка 318) Best-effort: файл с диска может быть копией из галереи —
      // ищем сайдкар по его имени в корне output и наследуем image-референсы
      // в мету результата (якоря для повторного рефайна). В conditioning ветка
      // inputSource рефы не подаёт (поведение не меняем).
      const inMetaRefs = readMetaImageRefs('', inName).filter((r) => existsSync(path.join(cfg.inputDir, r.path)))

      // Режим «Частями» — тот же воркфлоу, что и у галерейного пути.
      if (body.mode === 'chunks') {
        const windows = planChunkWindows(probe.frames, Number(body.chunkSeconds) || 5)
        const run = await runGeneration(() =>
          submitWorkflowJson(
            buildChunkedRefineWorkflow({
              sourceVideo: inName,
              diffusionModel: cfg.diffusionModel || undefined,
              sourceWidth: srcW,
              sourceHeight: srcH,
              sourceFrames: probe.frames,
              targetShortSide: target,
              chunkSeconds: Number(body.chunkSeconds) || 5,
              prompt: userPrompt,
              seed: body.seed,
              steps: body.steps,
              sigmaStart: body.sigmaStart,
              refImageSize, // (правка 317)
              outputSubfolder: '',
              ...veda, // (правка 408)
              ...sparse, // (правка 466)
              ...loraParams, // (правка 483)
              // (правка 509) Референсы от пользователя (файл с диска)
              ...(userRefImages.length > 0 && { refImages: userRefImages }),
            }),
            refineChunkStages(probe.frames, Number(body.chunkSeconds) || 5),
          ),
        )
        if (!run.ok) {
          return NextResponse.json({ error: run.error }, { status: run.status })
        }
        if (run.result.prompt_id) {
          setActivePrompt(run.result.prompt_id)
          recordPendingMetaRaw(run.result.prompt_id, {
            prompt: userPrompt,
            model_type: 'minimax_h3_ref2va',
            workflow: 'refine-chunks-latent-chain',
            generation_mode: 'refine',
            refine_mode: 'chunks',
            source_video: { filename: inName, subfolder: 'input' },
            source: { width: srcW, height: srcH, frames: probe.frames },
            target: target === 'same' ? 'same' : target,
            steps: body.steps ?? 3,
            sigma_start: body.sigmaStart,
            seed: body.seed ?? -1,
            chunks: windows.length,
            chunk_seconds: Number(body.chunkSeconds) || 5,
            prompt_source: 'user',
            input_source: true,
            minimax_h3_reference_detail: refImageSize, // (правка 317)
            ...refineCommonMeta, // (правка 722) пайплайн/шаги/сэмплер/LoRA/внимание
            ...vedaMeta, // (правка 408)
            // (правка 318) референсы исходника — якоря повторного рефайна;
            // (правка 509) приоритет — референсы, поданные пользователем.
            ...(userRefImages.length > 0
              ? { references: metaRefsForSidecar(userRefImages) }
              : inMetaRefs.length > 0 && { references: metaRefsForSidecar(inMetaRefs) }),
          })
        }
        return NextResponse.json({
          ...run.result,
          inputName: inName,
          inputSource: true,
          chunks: windows.length,
          source: { width: srcW, height: srcH, frames: probe.frames },
          targetDims: { genW: dims.genW, genH: dims.genH, outW: dims.outW, outH: dims.outH },
          promptSource: 'user',
        })
      }

      // Режим «Целый»
      const run = await runGeneration(() =>
        submitRefine({
          sourceVideo: inName,
          diffusionModel: cfg.diffusionModel || undefined,
          sourceWidth: srcW,
          sourceHeight: srcH,
          targetShortSide: target,
          prompt: userPrompt,
          seed: body.seed,
          steps: body.steps,
          sigmaStart: body.sigmaStart,
          refImageSize, // (правка 317)
          ...veda, // (правка 408)
          ...sparse, // (правка 466)
          ...loraParams, // (правка 483)
          // (правка 509) Референсы от пользователя (файл с диска)
          ...(userRefImages.length > 0 && { refImages: userRefImages }),
        }),
      )
      if (!run.ok) {
        return NextResponse.json({ error: run.error }, { status: run.status })
      }
      if (run.result.prompt_id) {
        setActivePrompt(run.result.prompt_id)
        recordPendingMetaRaw(run.result.prompt_id, {
          prompt: userPrompt,
          model_type: 'minimax_h3_ref2va',
          workflow: 'refine-v2v-latent-upscaler',
          generation_mode: 'refine',
          refine_mode: 'whole',
          source_video: { filename: inName, subfolder: 'input' },
          source: { width: srcW, height: srcH, frames: probe.frames },
          target: target === 'same' ? 'same' : target,
          steps: body.steps ?? 3,
          sigma_start: body.sigmaStart,
          seed: body.seed ?? -1,
          first_frame_ref: true,
          prompt_source: 'user',
          input_source: true,
          minimax_h3_reference_detail: refImageSize, // (правка 317)
          ...refineCommonMeta, // (правка 722) пайплайн/шаги/сэмплер/LoRA/внимание
          ...vedaMeta, // (правка 408)
          // (правка 318) референсы исходника — якоря повторного рефайна;
          // (правка 509) приоритет — референсы, поданные пользователем.
          ...(userRefImages.length > 0
            ? { references: metaRefsForSidecar(userRefImages) }
            : inMetaRefs.length > 0 && { references: metaRefsForSidecar(inMetaRefs) }),
        })
      }
      return NextResponse.json({
        ...run.result,
        inputName: inName,
        inputSource: true,
        source: { width: srcW, height: srcH, frames: probe.frames },
        targetDims: { genW: dims.genW, genH: dims.genH, outW: dims.outW, outH: dims.outH },
        promptSource: 'user',
      })
    }

    const sourcePath = path.join(cfg.outputDir, sub, safeName)
    if (!existsSync(sourcePath)) {
      return NextResponse.json({ error: `Файл не найден: ${safeName}` }, { status: 404 })
    }

    // ─── Копия output → input (без перезаписи чужих файлов — суффикс при
    // коллизии). Режим «Частями» со 2-го куска реюзит уже скопированный
    // файл (inputName + размеры из плана) — без повторной копии и пробы. ───
    const reuseName =
      body.inputName && existsSync(path.join(cfg.inputDir, path.basename(body.inputName)))
        ? path.basename(body.inputName)
        : null
    let destName: string
    let probe: { width: number; height: number; frames: number }
    // Путь свежескопированного файла (для отката при ошибке); null при реюзе.
    // (правка 716) Объявлен выше — во внешней области, чтобы внешний catch
    // мог удалить копию при падении до отправки задачи.
    // copiedPath = null
    if (reuseName && body.sourceWidth && body.sourceHeight) {
      // (правка 345) Реюз-ветка доверяла клиентским размерам вслепую:
      // 0/NaN/отрицательные уходили в refineDimensions/план кусков.
      const sw = Number(body.sourceWidth)
      const sh = Number(body.sourceHeight)
      if (!Number.isFinite(sw) || !Number.isFinite(sh) || sw <= 0 || sh <= 0) {
        return NextResponse.json({ error: 'Invalid sourceWidth/sourceHeight' }, { status: 400 })
      }
      // (правка 345) Режим «Частями» планируется по кадрам — при реюзе их
      // число неизвестно (probe.frames = 0) → план был бы пустым/битым.
      if (body.mode === 'chunks') {
        return NextResponse.json(
          { error: 'Режим «Частями» с реюзом inputName требует свежей копии (нет числа кадров)' },
          { status: 400 },
        )
      }
      destName = reuseName
      probe = { width: sw, height: sh, frames: 0 }
    } else {
      await fs.mkdir(cfg.inputDir, { recursive: true })
      destName = safeName
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
          // (правка 362) Старый `${n++ > 1 ? n : ''}` давал первой коллизии
          // имя без номера и пропускал _refine1 → _refine3.
          destName = `${stem}_refine${n++}${ext}`
          destPath = path.join(cfg.inputDir, destName)
          if (n > 100) return NextResponse.json({ error: 'Too many duplicates' }, { status: 500 })
        }
      }
      copiedPath = destPath

      // ─── Проба исходника ───
      try {
        probe = await probeVideoFile(destPath)
      } catch (e) {
        await fs.unlink(destPath).catch(() => {})
        return NextResponse.json(
          { error: `Не удалось прочитать видео: ${e instanceof Error ? e.message : String(e)}` },
          { status: 400 },
        )
      }
    }

    // ─── Цель ───
    const target: 'same' | 'x2' | number =
      body.target === 'same' || body.target === 'x2' || typeof body.target === 'number'
        ? body.target
        : 'same'
    if (typeof target === 'number' && (!Number.isFinite(target) || target < 144 || target > 2160)) {
      if (copiedPath) await fs.unlink(copiedPath).catch(() => {})
      return NextResponse.json({ error: 'Недопустимое целевое разрешение' }, { status: 400 })
    }

    // ─── Промпт: пользовательский > цепочка из меты исходника > дефолт ───
    // (правка 310, заменяет раскладку правки 309) Референсы: картинки из меты
    // исходника занимают <Picture 1..k> (исходный порядок оригинальной
    // генерации), первый кадр — последним (<Picture k+1>; см. правка 315 в
    // refine-template.ts). Без мета-рефов первый кадр = <Picture 1>.
    // (правка 318) readPromptChain вместо readDraftPrompt: для extend-combined
    // наследуем ВСЮ цепочку «исходник → клипы», для обычной меты — как раньше.
    const userPrompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
    const draftPrompt = userPrompt ? null : readPromptChain(sub, safeName)
    const resolvedPrompt = userPrompt || draftPrompt || undefined
    const promptSource: string = userPrompt ? 'user' : draftPrompt ? 'draft-meta' : 'default'
    // (правка 311) Картинки-референсы из .meta.json исходника с ролями
    // (imageIntent) → <Picture 1..k>.
    // Graceful fallback: только те файлы, которые реально есть в input/.
    const allMetaRefs = readMetaImageRefs(sub, safeName)
    const metaRefImages = allMetaRefs.filter((r) => existsSync(path.join(cfg.inputDir, r.path)))
    if (allMetaRefs.length !== metaRefImages.length) {
      console.warn(`[refine] ${allMetaRefs.length - metaRefImages.length} реф(ов) из меты отсутствует(ют) в input/ — пропускаем`)
    }

    // ─── (правки 376→382) Lossless-ветка: латент исходника из меты ───
    // Работает для ОБОИХ режимов («Целый» и «Частями», правка 382). Не works:
    // legacy-кусок (chunkJob/skipFrames/frameCap) и реюз без свежей пробы.
    // Геометрия цели считается от КАКНВЫ ЛАТЕНТА (≥ mp4 из-за кропа генерации,
    // всегда /32): conditioning и латент-затравка гарантированно совпадают
    // (ceil32 от mp4 мог отличаться от канвы свободного-MП генератора).
    // Цель меньше канвы → внутренний апскейлер получил бы уменьшение
    // (запрещено) → fallback на mp4-путь (он ресайзит пиксели до encode).
    const latentEligible =
      !body.chunkJob && !body.skipFrames && !body.frameCap && probe.frames > 0
    let sourceLatent: string | undefined
    let srcW = probe.width
    let srcH = probe.height
    if (latentEligible) {
      const resolved = resolveSourceLatent(sub, safeName, probe, (reason) =>
        console.warn(`[refine] mp4-путь (${safeName}): латент не подхвачен — ${reason}`),
      )
      if (resolved) {
        // (правка 587) Guard проверяет ЭФФЕКТИВНУЮ цель (с учётом targetMp):
        // раньше сравнивали с body.target, а в воркфлоу уходил targetEff из
        // targetMp — маленький targetMp проходил guard и просил латентный
        // апскейлер УМЕНЬШИТЬ канву (запрещённый случай, падающий джоб).
        const dLat = refineDimensions(
          resolved.width,
          resolved.height,
          effectiveTarget(body, resolved.width, resolved.height),
        )
        if (dLat.genW < resolved.width || dLat.genH < resolved.height) {
          console.warn(
            `[refine] mp4-путь (${safeName}): латент не подхвачен — цель меньше канвы латента ` +
            `${resolved.width}×${resolved.height}`,
          )
        } else {
          sourceLatent = resolved.file
          srcW = resolved.width
          srcH = resolved.height
          // (правка 421) Явная отметка в консоли сервера: какая ветка работает
          console.log(`[refine] ЛАТЕНТ ✓ (${safeName}): ${resolved.file} — lossless-ветка, без VAEEncode исходника`)
        }
      }
    }
    // (правка 494) Свободное разрешение (Мп) — от РЕАЛЬНОЙ канвы: в
    // lossless-ветке это канва латента (srcW/srcH уже подменены выше).
    const targetEff = typeof body.targetMp === 'number' && Number.isFinite(body.targetMp) && body.targetMp > 0
      ? targetFromMp(srcW, srcH, body.targetMp)
      : target
    const dims = refineDimensions(srcW, srcH, targetEff)

    // ─── (правка 253) Режим «Частями»: ОДИН воркфлоу с цепочкой кусков
    // (latent masking) — план на сервере, клиент ждёт один джоб и
    // сшивает жёсткой конкатенацией. (правка 315) Картинки-рефы из меты
    // подаются якорем идентичности на все окна (<Picture 1..k>). ───
    if (body.mode === 'chunks') {
      const windows = planChunkWindows(probe.frames, Number(body.chunkSeconds) || 5)
      // Сюжетный промпт — только первый элемент цепочки (промпт исходника):
      // билдер даёт его окну 0, окна 1+ идут с якорными подписью рефов без
      // сюжетного текста — промпт цепочки описывает сцены, которых в поздних
      // окнах нет, и путал модель. В мету результата пишется полная цепочка.
      const chainParts = userPrompt ? null : readPromptChainParts(sub, safeName)
      const firstChainPrompt = userPrompt || chainParts?.[0] || undefined
      const run = await runGeneration(() =>
        submitWorkflowJson(
          buildChunkedRefineWorkflow({
            sourceVideo: destName,
            diffusionModel: cfg.diffusionModel || undefined,
            videoFormat: getVideoFormatSettings(), // (правка 386)
            // (правка 382) lossless-ветка «Частями»: окна режутся токенами
            // из сохранённого латента; размеры = канва латента
            ...(sourceLatent && { sourceLatent }),
            sourceWidth: srcW,
            sourceHeight: srcH,
            sourceFrames: probe.frames,
            targetShortSide: targetEff,
            chunkSeconds: Number(body.chunkSeconds) || 5,
            // Теги <Picture N> промпта меты сохранены sanitizeDraftPrompt
            // (правка 310) и валидны: билдер (правка 315) держит исходную
            // нумерацию; подписи слотов добавляет билдер (правка 316).
            prompt: firstChainPrompt,
            seed: body.seed,
            steps: body.steps,
            sigmaStart: body.sigmaStart,
            outputSubfolder: sub,
            refImageSize, // (правка 317)
            ...veda, // (правка 408)
            ...sparse, // (правка 466)
            ...loraParams, // (правка 483)
            // (правка 311) Картинки-рефы из меты исходника (с ролями)
            ...(metaRefImages.length > 0 && { refImages: metaRefImages }),
          }),
          // (правка 255) стадии = окна цепочки → прогресс 0–100 по кускам
          refineChunkStages(probe.frames, Number(body.chunkSeconds) || 5),
        ),
      )
      if (!run.ok) {
        // (правка 344) Откат свежей копии в input/ — иначе осиротевший файл.
        if (copiedPath) await fs.unlink(copiedPath).catch(() => {})
        return NextResponse.json({ error: run.error }, { status: run.status })
      }
      if (run.result.prompt_id) {
        setActivePrompt(run.result.prompt_id)
        // (правка 260) Метаданные кусков: /api/comfy/status на 'done'
        // финализирует сайдкары даже без браузера. Исходник — оригинал из
        // галереи, из которого сделан рефайн.
        recordPendingMetaRaw(run.result.prompt_id, {
          prompt: resolvedPrompt ?? '',
          model_type: 'minimax_h3_ref2va',
          workflow: 'refine-chunks-latent-chain',
          generation_mode: 'refine',
          refine_mode: 'chunks',
          source_video: { filename: safeName, subfolder: sub },
          source: { width: probe.width, height: probe.height, frames: probe.frames },
          target: targetEff === 'same' ? 'same' : targetEff,
          steps: body.steps ?? 3,
          sigma_start: body.sigmaStart,
          seed: body.seed ?? -1,
          chunks: windows.length,
          chunk_seconds: Number(body.chunkSeconds) || 5,
          prompt_source: promptSource,
          minimax_h3_reference_detail: refImageSize, // (правка 317)
          ...refineCommonMeta, // (правка 722) пайплайн/шаги/сэмплер/LoRA/внимание
          ...vedaMeta, // (правка 408)
          // (правка 305) число картинок-рефов из меты
          ...(metaRefImages.length > 0 && { meta_ref_count: metaRefImages.length }),
          // (правка 318) и сами референсы — якоря повторного рефайна
          ...(metaRefImages.length > 0 && { references: metaRefsForSidecar(metaRefImages) }),
          // (правка 382) lossless-режим «Частями»
          ...(sourceLatent && { latent_source: sourceLatent }),
        })
      }
      return NextResponse.json({
        ...run.result,
        inputName: destName,
        chunks: windows.length,
        source: { width: probe.width, height: probe.height, frames: probe.frames },
        targetDims: { genW: dims.genW, genH: dims.genH, outW: dims.outW, outH: dims.outH },
        promptSource,
        promptUsed: resolvedPrompt ?? '',
        lossless: !!sourceLatent, // (правка 382)
      })
    }

    // ─── Сборка + отправка ───
    const run = await runGeneration(() =>
      submitRefine({
        sourceVideo: destName,
        diffusionModel: cfg.diffusionModel || undefined,
        // (правка 376) lossless-ветка: первозданный латент генерации;
        // (правка 382) размеры = канва латента (геометрия всей ветки от неё)
        ...(sourceLatent && { sourceLatent, sourceFrames: probe.frames }),
        sourceWidth: srcW,
        sourceHeight: srcH,
        targetShortSide: targetEff,
        prompt: resolvedPrompt,
        seed: body.seed,
        steps: body.steps,
        sigmaStart: body.sigmaStart,
        skipFrames: body.skipFrames,
        frameCap: body.frameCap,
        chunkJob: body.chunkJob,
        refImageSize, // (правка 317)
        ...veda, // (правка 408)
        ...sparse, // (правка 466)
        ...loraParams, // (правка 483)
        // (правка 366) Результат — в папку оригинала (как у режима «Частями»);
        // источник из корня output → sub='' → общая папка, как раньше.
        outputSubfolder: sub,
        // (правка 311) Картинки-рефы из меты исходника (с ролями)
        ...(metaRefImages.length > 0 && { refImages: metaRefImages }),
      }),
    )
    if (!run.ok) {
      // (правка 344) Откат свежей копии в input/ — иначе осиротевший файл.
      if (copiedPath) await fs.unlink(copiedPath).catch(() => {})
      copiedPath = null
      return NextResponse.json({ error: run.error }, { status: run.status })
    }
    // (правка 716) Задача ушла в ComfyUI — копия больше не «осиротевшая».
    submitted = true
    if (run.result.prompt_id) {
      setActivePrompt(run.result.prompt_id)
      // (правка 260) Метаданные рефайна «Целый»: финализируются статусным
      // роутом на 'done' (работает и с закрытым браузером).
      recordPendingMetaRaw(run.result.prompt_id, {
        prompt: resolvedPrompt ?? '',
        model_type: 'minimax_h3_ref2va',
        workflow: 'refine-v2v-latent-upscaler',
        generation_mode: 'refine',
        refine_mode: 'whole',
        source_video: { filename: safeName, subfolder: sub },
        source: { width: probe.width, height: probe.height, frames: probe.frames },
        target: targetEff === 'same' ? 'same' : targetEff,
        steps: body.steps ?? 3,
        sigma_start: body.sigmaStart,
        seed: body.seed ?? -1,
        first_frame_ref: true,
        // (правка 309) число картинок-рефов из меты
        ...(metaRefImages.length > 0 && { meta_ref_count: metaRefImages.length }),
        // (правка 318) и сами референсы — якоря повторного рефайна
        ...(metaRefImages.length > 0 && { references: metaRefsForSidecar(metaRefImages) }),
        // (правка 376) lossless-режим: рефайн стартовал с латента генерации
        ...(sourceLatent && { latent_source: sourceLatent }),
        prompt_source: promptSource,
        minimax_h3_reference_detail: refImageSize, // (правка 317)
        ...refineCommonMeta, // (правка 722) пайплайн/шаги/сэмплер/LoRA/внимание
        ...vedaMeta, // (правка 408)
      })
    }

    return NextResponse.json({
      ...run.result,
      inputName: destName,
      source: { width: probe.width, height: probe.height, frames: probe.frames },
      targetDims: { genW: dims.genW, genH: dims.genH, outW: dims.outW, outH: dims.outH },
      promptSource,
      promptUsed: resolvedPrompt ?? '',
      lossless: !!sourceLatent, // (правка 376)
    })
  } catch (err) {
    // (правка 716) Убираем осиротевшую копию в input/, если задача так и не
    // была отправлена в ComfyUI.
    if (copiedPath && !submitted) {
      await fs.unlink(copiedPath).catch(() => {})
      copiedPath = null
    }
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
