import { NextRequest, NextResponse } from 'next/server'
import { promises as fs } from 'fs'
import { existsSync } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import { writeMetaSidecar } from '@/lib/pending-meta'
import { getAppConfig } from '@/lib/app-config'
import { sanitizeFolderPath } from '@/lib/gallery-folders' // (правка 495)
import { resolveFfmpeg } from '@/lib/thumb'
import { probeVideoFile, type VideoProbe } from '@/lib/video-probe'
import { ffmpegVideoArgs } from '@/lib/video-format'
import { getVideoFormatSettings } from '@/lib/video-format-server' // (правка 386)

const execFileAsync = promisify(execFile)

/**
 * POST /api/comfy/refine/stitch — финальная сшивка кусков режима
 * refine «Частями».
 *
 * (правка 314) LEGACY-путь: актуальный воркфлоу «Частями» (правка 314 в
 * refine-template.ts) склеивает окна в латентном пространстве и отдаёт ОДИН
 * файл Minimax_Studio_refine_* — этот роут он НЕ вызывает (нет ни покусочных
 * refinepart_*, ни повторного h264-кодирования, мета пишется сервером через
 * recordPendingMetaRaw → /api/comfy/status). Роут сохранён для обратной
 * совместимости: клиент (refine-queue.ts) вызывает его, только если в outputs
 * джоба найдены refinepart_* (воркфлоу старого образца).
 *
 * Body:
 *   chunkFiles — [{filename, subfolder}] куски в output (без аудио)
 *   audioSource — {filename, subfolder} исходник в output (его аудио
 *                 ложится на весь склеенный таймлайн без re-encode)
 *   overlapsSec — [число] перекрытие каждого стыка в секундах (для xfade)
 *   outSubfolder — подпапка выхода ('' = корень)
 *
 * Математика xfade — как в /api/comfy/concat (правка 182): offset каждого
 * стыка считается от БЕГУЩЕЙ длительности промежуточного вывода. Куски
 * нарезаны по таймлайну исходника, поэтому склеенный видео-таймлайн
 * совпадает с исходным — аудио остаётся в синхроне без подрезок.
 */
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      chunkFiles?: Array<{ filename: string; subfolder?: string }>
      audioSource?: { filename: string; subfolder?: string }
      overlapsSec?: number[]
      outSubfolder?: string
      /** (правка 253) Латент-цепочка: куски без дублей — жёсткая склейка. */
      hard?: boolean
      /** (правка 260) Параметры метаданных итогового файла (с исходником). */
      meta?: Record<string, unknown>
    }
    if (!body?.chunkFiles?.length || !body?.audioSource?.filename) {
      return NextResponse.json({ error: 'chunkFiles и audioSource обязательны' }, { status: 400 })
    }

    const cfg = getAppConfig()
    const resolveOut = (f: { filename: string; subfolder?: string }) => {
      const safeName = path.basename(f.filename)
      // (правка 495) subfolder — многоуровневый относительный путь ('a/b').
      const sub = f.subfolder ? sanitizeFolderPath(f.subfolder) : ''
      const p = path.join(cfg.outputDir, ...(sub ? sub.split('/') : []), safeName)
      // (правка 716) Отсутствующий файл — 404, а не 500: тот же смысл, что
      // в соседнем /api/comfy/trim.
      if (!existsSync(p)) {
        const err = new Error(`Файл не найден: ${safeName}`) as Error & { status?: number }
        err.status = 404
        throw err
      }
      return p
    }

    const chunkPaths = body.chunkFiles.map(resolveOut)
    const audioPath = resolveOut(body.audioSource)
    const outSub = body.outSubfolder ? sanitizeFolderPath(body.outSubfolder) : ''
    const outName = `Minimax_Studio_refine_${Date.now().toString(36)}.mp4`
    const outPath = path.join(cfg.outputDir, outSub, outName)
    await fs.mkdir(path.dirname(outPath), { recursive: true })

    const ffmpeg = await resolveFfmpeg()
    if (!ffmpeg) {
      return NextResponse.json({ error: 'FFmpeg недоступен' }, { status: 500 })
    }

    // Пробы кусков: длительности для офсетов xfade, канва — из первого.
    const infos: VideoProbe[] = []
    for (const p of chunkPaths) {
      infos.push(await probeVideoFile(p))
    }
    const W = infos[0].width % 2 === 0 ? infos[0].width : infos[0].width + 1
    const H = infos[0].height % 2 === 0 ? infos[0].height : infos[0].height + 1

    // Видеоряд: приводим к канве и fps, затем цепочка xfade по стыкам.
    // ─── (правка 272) Жёсткая склейка (схема D-версии — рабочая):
    // латент-цепочка даёт куски без дублей (голова срезана),
    // стыки непрерывны по построению — xfade не нужен.
    // ─── (правка 313) Звук теперь у самих кусков (перегенерирован
    // сэмплером, как видео, и замуксен VHS_VideoCombine): склеиваем
    // аудио по кускам так же, как видео. Фолбэки: (1) звук из целого
    // оригинала — поведение до правки 313; (2) видео без звука.
    if (body.hard) {
      const runFfmpeg = (args: string[]) =>
        execFileAsync(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args], {
          timeout: 600_000,
          maxBuffer: 32 * 1024 * 1024,
        }).then(() => true).catch(() => false)

      // (правка 386) кодек/качество — из [video] настроек студии
      const videoEnc = ['-preset', 'fast', ...ffmpegVideoArgs(getVideoFormatSettings()), '-pix_fmt', 'yuv420p', '-movflags', '+faststart']
      const videoFilter = chunkPaths.map((_, i) => `[${i}:v]scale=${W}:${H},setsar=1,fps=24[v${i}]`).join(';')
      const concatV = chunkPaths.map((_, i) => `[v${i}]`).join('') + `concat=n=${chunkPaths.length}:v=1:a=0[vout]`

      // 1) Основной: видео и аудио из самих кусков (правки 313).
      const fullArgs = [
        ...chunkPaths.flatMap((q) => ['-i', q]),
        '-filter_complex',
        `${videoFilter};${chunkPaths.map((_, i) => `[${i}:a]aresample=44100[a${i}]`).join(';')};${chunkPaths.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${chunkPaths.length}:v=1:a=1[vout][aout]`,
        '-map', '[vout]', '-map', '[aout]',
        ...videoEnc, '-c:a', 'aac', '-b:a', '192k', '-shortest', '-y', outPath,
      ]
      // 2) Фолбэк (до правки 313): видео кусков + звук целого оригинала.
      const origArgs = [
        ...[...chunkPaths, audioPath].flatMap((q) => ['-i', q]),
        '-filter_complex',
        `${videoFilter};[${chunkPaths.length}:a]aresample=44100[aout];${concatV}`,
        '-map', '[vout]', '-map', '[aout]',
        ...videoEnc, '-c:a', 'aac', '-b:a', '192k', '-shortest', '-y', outPath,
      ]
      // 3) Последний: только видео (у исходника нет дорожки).
      const videoOnlyArgs = [
        ...[...chunkPaths, audioPath].flatMap((q) => ['-i', q]),
        '-filter_complex', `${videoFilter};${concatV}`,
        '-map', '[vout]', '-an', ...videoEnc, '-y', outPath,
      ]

      let ok = await runFfmpeg(fullArgs)
      if (!ok) ok = await runFfmpeg(origArgs)
      if (!ok) ok = await runFfmpeg(videoOnlyArgs)
      if (!ok) throw new Error('FFmpeg hard-stitch failed: ни один режим склейки не удался')
      // (правка 260) Сайдкар итога рефайна «Частями»: клиент передаёт мета
      // с исходником; сюда добавляем только служебное.
      // (правка 361) Пишем сайдкар итога ДО удаления кусков и удаляем
      // сайдкары кусков только если итоговый записался (или не запрошен) —
      // иначе при сбое записи терялась ВСЯ мета цепочки.
      let finalMetaOk = !body.meta || typeof body.meta !== 'object'
      if (body.meta && typeof body.meta === 'object') {
        try {
          writeMetaSidecar(outName, outSub, {
            ...(body.meta as Record<string, unknown>),
            combined_from: body.chunkFiles.map((c) => c.filename),
            created_at: Date.now() / 1000,
          })
          finalMetaOk = true
        } catch { /* не критично */ }
      }
      // (правка 260) Куски — промежуточные: удаляем вместе с их сайдкарами
      // (их пишет pending-meta статусного роута на 'done' джоба).
      for (const q of chunkPaths) {
        await fs.unlink(q).catch(() => {})
        if (finalMetaOk) await fs.unlink(q + '.meta.json').catch(() => {})
      }
      return NextResponse.json({ filename: outName, subfolder: outSub })
    }

    // ─── Расчёт стыков (правка 271) ───
    // Куски перекрываются на CHAIN_OVERLAP (39) кадров: файл каждого окна
    // k>0 включает голову-перекрытие (те же кадры исходника, что и хвост
    // окна k−1). На стыке два РАЗНЫХ ре-рендера ОДНИХ И ТЕХ ЖЕ кадров
    // (близкие, т.к. conditioning + latent-затравка одинаковы). Поэтому:
    //  • фейд короткий — FADE_SEC (3 кадра): смешиваются ближайшие кадры
    //    двух близких рендеров → плавный переход без двоения;
    //  • остаток перекрытия СРЕЗАЕТСЯ с головы следующего куска (trim) —
    //    таймлайн непрерывен: контент куска i+1 после среза начинается ровно
    //    за fade до конца куска i. Математика: trim + fade = overlap.
    const FADE_SEC = 3 / 24
    const seams = chunkPaths.slice(1).map((_, i) => {
      const overlap = body.overlapsSec?.[i] ?? 1
      const f = Math.min(
        overlap,
        FADE_SEC,
        Math.max(0.05, infos[i].durationSec / 2 - 0.01),
        Math.max(0.05, infos[i + 1].durationSec / 2 - 0.01),
      )
      return { fade: f, trim: Math.max(0, overlap - f) }
    })

    const filter: string[] = []
    // Кусок 0 — целиком; куски i≥1 — со срезом головы на (overlap − fade).
    filter.push(`[0:v]scale=${W}:${H},setsar=1,fps=24[v0]`)
    for (let i = 1; i < chunkPaths.length; i++) {
      const trim = seams[i - 1].trim
      const head = trim > 0.001 ? `trim=start=${trim.toFixed(4)},setpts=PTS-STARTPTS,` : ''
      filter.push(`[${i}:v]${head}scale=${W}:${H},setsar=1,fps=24[v${i}]`)
    }
    // Аудио — из ЦЕЛОГО исходника (последний вход), без перекрёстных фейдов.
    const audioIndex = chunkPaths.length
    filter.push(`[${audioIndex}:a]aresample=44100[aout]`)

    if (chunkPaths.length === 1) {
      filter.push(`[v0]copy[vout]`)
    } else {
      // Бегущая длительность: срезы голов уже учтены в фактической длине
      // кусков ПОСЛЕ trim — считаем её из проб.
      let running = infos[0].durationSec
      for (let i = 0; i < chunkPaths.length - 1; i++) {
        const f = seams[i].fade
        const nextDur = infos[i + 1].durationSec - seams[i].trim
        const offset = Math.max(0, running - f)
        filter.push(`[v${i}][v${i + 1}]xfade=transition=fade:duration=${f.toFixed(3)}:offset=${offset.toFixed(3)}[v${i + 1}]`)
        running += nextDur - f
      }
      filter.push(`[v${chunkPaths.length - 1}]null[vout]`)
    }

    const inputArgs: string[] = []
    for (const p of [...chunkPaths, audioPath]) inputArgs.push('-i', p)

    try {
      await execFileAsync(
        ffmpeg,
        [
          '-hide_banner', '-loglevel', 'error',
          ...inputArgs,
          '-filter_complex', filter.join(';'),
          '-map', '[vout]',
          '-map', '[aout]',
          // (правка 386) кодек/качество — из [video] настроек студии
          '-preset', 'fast', ...ffmpegVideoArgs(getVideoFormatSettings()),
          '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-b:a', '192k',
          '-movflags', '+faststart',
          '-shortest',
          '-y',
          outPath,
        ],
        { timeout: 600_000, maxBuffer: 32 * 1024 * 1024 },
      )
    } catch (err) {
      const e = err as { stderr?: string; message?: string }
      const stderr = e.stderr || e.message || String(err)
      // Фолбэк без аудио (у исходника может не быть дорожки).
      try {
        const videoOnly = filter.filter((s) => !s.startsWith(`[${audioIndex}:a`) && !s.includes('[aout]'))
        await execFileAsync(
          ffmpeg,
          [
            '-hide_banner', '-loglevel', 'error',
            ...inputArgs,
            '-filter_complex', videoOnly.join(';'),
            '-map', '[vout]',
            '-an',
            // (правка 386) кодек/качество — из [video] настроек студии
            '-preset', 'fast', ...ffmpegVideoArgs(getVideoFormatSettings()),
            '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart',
            '-y',
            outPath,
          ],
          { timeout: 600_000, maxBuffer: 32 * 1024 * 1024 },
        )
      } catch {
        throw new Error(`FFmpeg stitch failed: ${stderr.slice(0, 600)}`)
      }
    }

    // (правка 260) Сайдкар итога (xfade-ветка) — как в hard-ветке.
    // (правка 361) Сначала сайдкар итога, потом удаление кусков: сайдкары
    // кусков удаляем только при успешной записи итогового (или если мета
    // не запрошена) — не теряем всю мету цепочки при сбое записи.
    let finalMetaOk = !body.meta || typeof body.meta !== 'object'
    if (body.meta && typeof body.meta === 'object') {
      try {
        writeMetaSidecar(outName, outSub, {
          ...(body.meta as Record<string, unknown>),
          combined_from: body.chunkFiles.map((c) => c.filename),
          created_at: Date.now() / 1000,
        })
        finalMetaOk = true
      } catch { /* не критично */ }
    }

    // Куски — расходный материал: убираем после успешной склейки
    // (правка 260) вместе с их сайдкарами от pending-meta.
    for (const p of chunkPaths) {
      await fs.unlink(p).catch(() => {})
      if (finalMetaOk) await fs.unlink(p + '.meta.json').catch(() => {})
    }

    return NextResponse.json({ filename: outName, subfolder: outSub })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // (правка 716) Статус из ошибки (404 для «файл не найден»), иначе 500.
    const status = (err as { status?: number })?.status
    return NextResponse.json({ error: msg }, { status: typeof status === 'number' ? status : 500 })
  }
}
