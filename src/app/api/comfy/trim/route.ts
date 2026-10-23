import { NextRequest, NextResponse } from 'next/server'
import { promises as fs } from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { getAppConfig } from '@/lib/app-config'
import { sanitizeFolderPath } from '@/lib/gallery-folders' // (правка 495)
import { writeMetaSidecar } from '@/lib/pending-meta'
import { probeVideoFile } from '@/lib/video-probe' // (правка 722) — фактическая геометрия обрезки
import { resolveFfmpeg } from '@/lib/thumb'
import { ffmpegVideoArgs } from '@/lib/video-format'
import { getVideoFormatSettings } from '@/lib/video-format-server' // (правка 386)

const execFileAsync = promisify(execFile)

/**
 * POST /api/comfy/trim
 *
 * Body: { filename: string, subfolder?: string, start: number, end: number }
 *   - filename: имя файла в output/ (или subfolder/output/)
 *   - subfolder: подпапка в output/ (пусто для корня)
 *   - start: секунд с начала (>= 0)
 *   - end: секунд до конца (<= duration)
 *
 * Результат: новый файл `<base>_trim_<start>-<end>.mp4` в той же папке.
 * Ответ: { filename, subfolder, url, duration }
 * (правка 307) Результату пишется .meta.json сайдкар: наследуется сайдкар
 * исходника целиком + workflow:'trim', source_video, trim_start/end/duration.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      filename?: string
      subfolder?: string
      start?: number
      end?: number
    }

    const { filename, subfolder = '', start = 0, end } = body
    if (!filename || typeof start !== 'number' || typeof end !== 'number') {
      return NextResponse.json({ error: 'filename, start, end are required' }, { status: 400 })
    }
    // (правка 357) NaN/Infinity проходили typeof-проверку и уходили в
    // ffmpeg-аргументы/имя файла → 500 вместо понятного 400.
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      return NextResponse.json({ error: 'start/end must be finite numbers' }, { status: 400 })
    }
    if (start < 0 || end <= 0 || start >= end) {
      return NextResponse.json({ error: 'Invalid range: need 0 <= start < end' }, { status: 400 })
    }

    const { outputDir } = getAppConfig()

    // Resolve source path
    // (правка 495) subfolder — многоуровневый относительный путь ('a/b').
    const safeName = path.basename(filename)
    const safeSub = subfolder ? sanitizeFolderPath(subfolder) : ''
    const sourcePath = path.join(outputDir, safeSub, safeName)

    // (правка 587) Отсутствующий исходник — 404, а не 500: файл могли
    // удалить из галереи прямо перед обрезкой (обычная гонка клиента).
    try {
      await fs.access(sourcePath)
    } catch {
      return NextResponse.json(
        { error: `Файл не найден: ${safeSub ? safeSub + '/' : ''}${safeName}` },
        { status: 404 },
      )
    }

    // Build output filename: <base>_trim_<start>-<end>.<ext>
    const ext = path.extname(safeName) || '.mp4'
    const baseNoExt = path.basename(safeName, ext)
    // Round to 1 decimal for clean names
    const s = Math.round(start * 10) / 10
    const e = Math.round(end * 10) / 10
    const outName = `${baseNoExt}_trim_${s}-${e}${ext}`
    const outPath = path.join(outputDir, safeSub, outName)

    // If already exists, add a counter
    let finalOutPath = outPath
    let counter = 1
    while (true) {
      try {
        await fs.access(finalOutPath)
        // exists — increment
        finalOutPath = path.join(outputDir, safeSub, `${baseNoExt}_trim_${s}-${e}_${counter}${ext}`)
        counter++
      } catch {
        break // doesn't exist, good
      }
    }

    // Run ffmpeg trim (stream copy for speed — no re-encode)
    const bin = await resolveFfmpeg()
    if (!bin) throw new Error('ffmpeg-not-available')

    const duration = end - start

    // (правка 306) Re-encode trim: -c copy даёт застывший кадр (нет I-frame на точке разреза).
    // Re-encode с veryfast — для 20s видео ~1 сек, результат корректный и играется сразу.
    await execFileAsync(
      bin,
      [
        '-hide_banner', '-loglevel', 'error',
        '-ss', String(start),
        '-i', sourcePath,
        '-t', String(duration),
        // (правка 386) кодек/качество — из [video] настроек студии
        '-preset', 'veryfast', ...ffmpegVideoArgs(getVideoFormatSettings()),
        '-c:a', 'aac', '-b:a', '192k',
        '-movflags', '+faststart',
        '-y',
        finalOutPath,
      ],
      { timeout: 300_000 },
    )

    // Verify output exists
    const stat = await fs.stat(finalOutPath)
    if (stat.size === 0) throw new Error('Trim produced empty file')

    const finalName = path.basename(finalOutPath)

    // (правка 307) Сайдкар результата: наследуем сайдкар исходника ЦЕЛИКОМ
    // (промпт/цепочка, references, seed и пр.) и добавляем служебные поля
    // обрезки. Нет сайдкара у исходника — пишем минимальный (сам факт trim).
    //
    // (правка 722) Геометрия — ФАКТИЧЕСКАЯ, а не унаследованная. Раньше
    // обрезанный файл сохранял video_length/duration_seconds исходника
    // (107 кадров вместо, скажем, 48) → метаданные врали о самом файле, а
    // lossless-резолвер латента (resolveSourceLatent) сверял мету с пробой
    // mp4 и получал расхождение. Теперь: probe обрезанного файла → точные
    // кадры/длительность/разрешение.
    try {
      const outputRoot = path.resolve(outputDir)
      const srcMetaFile = path.resolve(path.join(outputDir, safeSub, safeName + '.meta.json'))
      let srcMeta: Record<string, unknown> = {}
      if (srcMetaFile.startsWith(outputRoot + path.sep)) {
        try {
          srcMeta = JSON.parse(await fs.readFile(srcMetaFile, 'utf-8')) as Record<string, unknown>
        } catch { /* битый сайдкар — пишем минимальный */ }
      }

      // Фактическая геометрия обрезанного файла.
      let probed: Record<string, unknown> = {}
      try {
        const pr = await probeVideoFile(finalOutPath)
        if (pr.width > 0 && pr.height > 0 && pr.frames > 0) {
          probed = {
            video_length: pr.frames,
            duration_seconds: Number(pr.durationSec.toFixed(2)),
            resolution: `${pr.width}x${pr.height}`,
            fps: pr.fps ?? 24,
          }
        }
      } catch { /* проба не критична — остаются унаследованные поля */ }

      // Латент исходника к обрезанному файлу НЕ относится: он описывает
      // полную длину и канву исходника. Оставлять его в сайдкаре — ложь
      // (и лишний путь, по которому lossless-рефайн попытается пойти).
      const { latent_file: _dropLatent, ...srcMetaNoLatent } = srcMeta

      writeMetaSidecar(finalName, safeSub, {
        ...srcMetaNoLatent,
        workflow: 'trim',
        // (правка 722) Метка «файл правили» — по ней галерея и любые
        // потребители метаданных отличают обрезку от исходной генерации.
        edited: true,
        source_video: { filename: safeName, subfolder: safeSub },
        trim_start: s,
        trim_end: e,
        trim_duration: Math.round(duration * 100) / 100,
        ...probed,
        job_id: `trim_${Date.now().toString(36)}`,
      })
    } catch { /* сайдкар не критичен для самой обрезки */ }

    const url = `/api/comfy/file?filename=${encodeURIComponent(finalName)}&subfolder=${encodeURIComponent(safeSub)}&type=output`

    return NextResponse.json({
      filename: finalName,
      subfolder: safeSub,
      url,
      duration: Math.round(duration * 100) / 100,
      size: stat.size,
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[trim] ERROR:', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
