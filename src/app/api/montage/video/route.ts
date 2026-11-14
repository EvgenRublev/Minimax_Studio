/**
 * (правка 974) /api/montage/video — импорт видео с диска в монтажку.
 *
 * POST multipart (поле 'file'): файл сохраняется в output ComfyUI под своим
 * именем (с уникальным суффиксом при совпадении), чтобы его мог прочитать
 * /api/montage/render и увидеть «Галерея». Ответ: { filename, subfolder, url }.
 */
import { NextRequest, NextResponse } from 'next/server'
import path from 'path'
import { createWriteStream, promises as fs, existsSync } from 'fs'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  readFirstMultipartPart,
  MultipartParseError,
  type MultipartFilePart,
} from '@/lib/multipart-stream'
import { getAppConfig } from '@/lib/app-config'
import { st as stT } from '@/lib/i18n/server'

const MAX_VIDEO_BYTES = 4 * 1024 * 1024 * 1024
const UNSAFE_CHARS = /[<>:"/\\|?*\x00-\x1f]/g
const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v', '.wmv', '.flv', '.ts', '.mts', '.m2ts', '.3gp', '.mpg', '.mpeg'])

export async function POST(req: NextRequest) {
  let part: MultipartFilePart | null = null
  let destPath: string | null = null
  try {
    const body = req.body
    if (!body) return NextResponse.json({ error: stT("Пустой запрос") }, { status: 400 })
    part = await readFirstMultipartPart(body, req.headers.get('content-type'))
    if (!part.filename) {
      part.cancel()
      return NextResponse.json({ error: stT("Файл не передан") }, { status: 400 })
    }
    const safeName = (path.basename(part.filename).replace(UNSAFE_CHARS, '_') || 'video').slice(0, 200)
    const ext = path.extname(safeName).toLowerCase()
    if (!VIDEO_EXT.has(ext)) {
      part.cancel()
      return NextResponse.json(
        { error: stT("Не видеоформат: {{p1}}. Поддержаны mp4, mov, webm, mkv, avi", { p1: ext || 'без расширения' }) },
        { status: 400 },
      )
    }

    const cfg = getAppConfig()
    const outputDir = cfg.outputDir
    await fs.mkdir(outputDir, { recursive: true })

    // Имя сохраняем по возможности исходное (удобно в галерее), конфликт — суффикс.
    const stem = safeName.slice(0, safeName.length - ext.length)
    let filename = safeName
    let n = 1
    while (existsSync(path.join(outputDir, filename))) {
      filename = `${stem}_${n++}${ext}`
      if (n > 500) {
        part.cancel()
        return NextResponse.json({ error: stT("Слишком много файлов с таким именем") }, { status: 409 })
      }
    }
    destPath = path.join(outputDir, filename)

    let received = 0
    let tooLarge = false
    const limiter = new Transform({
      transform(chunk, _enc, cb) {
        received += (chunk as Buffer).length
        if (received > MAX_VIDEO_BYTES) {
          tooLarge = true
          cb(new Error('video-too-large'))
          return
        }
        cb(null, chunk)
      },
    })
    try {
      await pipeline(part.stream, limiter, createWriteStream(destPath))
    } catch (e) {
      await fs.unlink(destPath).catch(() => {})
      destPath = null
      if (tooLarge) {
        part.cancel()
        return NextResponse.json({ error: stT("Файл слишком большой (лимит 4 ГБ)") }, { status: 413 })
      }
      throw e
    }
    part = null

    return NextResponse.json({
      filename,
      subfolder: '',
      url: `/api/comfy/file?filename=${encodeURIComponent(filename)}&type=output`,
    })
  } catch (err) {
    if (part) part.cancel()
    if (destPath) await fs.unlink(destPath).catch(() => {})
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: err instanceof MultipartParseError ? 400 : 500 })
  }
}
