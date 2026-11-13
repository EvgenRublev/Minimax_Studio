/**
 * (правка 874) /api/montage/audio — импорт звуковых файлов в монтажку.
 *
 * POST (multipart, поле 'file'): файл с диска пользователя сохраняется в
 * папку .montage-audio/ (env MONTAGE_AUDIO_DIR, по образцу .local-input из
 * lib/staging.ts) — вне output ComfyUI, чтобы не сорить в галерею. Имя
 * становится уникальным (timestamp+random, как stageFile). Ответ:
 * { file, name, duration, url } — длительность считает ffprobe на сервере.
 *
 * GET ?f=<имя>: отдаёт файл потоком с поддержкой Range — это обязательно,
 * иначе <audio> не сможет делать seek по звуковой дорожке превью.
 */
import { NextRequest, NextResponse } from 'next/server'
import path from 'path'
import fsSync, { createReadStream, createWriteStream, promises as fs, existsSync } from 'fs'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  readFirstMultipartPart,
  MultipartParseError,
  type MultipartFilePart,
} from '@/lib/multipart-stream'
import { resolveFfprobe } from '@/lib/video-probe'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { st as stT } from '@/lib/i18n/server'

const execFileAsync = promisify(execFile)

const AUDIO_DIR = path.resolve(process.env.MONTAGE_AUDIO_DIR || './.montage-audio')
const UNSAFE_CHARS = /[<>:"/\\|?*\x00-\x1f]/g
/** звук монтажки — файлы скромнее видео; 512 МБ за глаза для саундтрека */
const MAX_AUDIO_BYTES = 512 * 1024 * 1024

const AUDIO_EXT = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.oga', '.flac', '.opus', '.wma', '.mka', '.mp2', '.mid', '.amr'])

const MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.flac': 'audio/flac',
  '.opus': 'audio/opus',
  '.wma': 'audio/x-ms-wma',
  '.mka': 'audio/x-matroska',
  '.mp2': 'audio/mpeg',
  '.mid': 'audio/midi',
  '.amr': 'audio/amr',
}

/** (правка 874) ffprobe длительности любого медиафайла (format=duration). */
async function probeAudioDuration(file: string): Promise<number> {
  try {
    const ffprobe = await resolveFfprobe()
    const { stdout } = await execFileAsync(
      ffprobe,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', file],
      { timeout: 20_000 },
    )
    const d = parseFloat((JSON.parse(stdout)?.format?.duration ?? '').toString())
    return Number.isFinite(d) && d > 0 ? Math.round(d * 1000) / 1000 : 0
  } catch {
    return 0 // ffprobe недоступен — клиент сам возьмёт длительность из <audio>
  }
}

export async function POST(req: NextRequest) {

  let part: MultipartFilePart | null = null
  let destPath: string | null = null
  try {
    const webBody = req.body
    if (!webBody) {
      return NextResponse.json({ error: stT("Пустой запрос") }, { status: 400 })
    }
    part = await readFirstMultipartPart(webBody, req.headers.get('content-type'))
    if (!part.filename) {
      part.cancel()
      return NextResponse.json({ error: stT("Файл не передан") }, { status: 400 })
    }
    const safeName = (path.basename(part.filename).replace(UNSAFE_CHARS, '_') || 'audio').slice(0, 200)
    const ext = path.extname(safeName).toLowerCase()
    if (!AUDIO_EXT.has(ext)) {
      part.cancel()
      return NextResponse.json(
        { error: stT("Не звуковой формат: {{p1}}. Поддержаны mp3, wav, m4a, ogg, flac, opus", { p1: ext || 'без расширения' }) },
        { status: 400 },
      )
    }

    await fs.mkdir(AUDIO_DIR, { recursive: true })
    const unique = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}-${safeName}`
    destPath = path.join(AUDIO_DIR, unique)

    // потоковая запись с лимитом (по образцу /api/comfy/upload)
    let received = 0
    let tooLarge = false
    const limiter = new Transform({
      transform(chunk, _enc, cb) {
        received += (chunk as Buffer).length
        if (received > MAX_AUDIO_BYTES) {
          tooLarge = true
          cb(new Error('audio-too-large'))
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
        return NextResponse.json({ error: stT("Файл слишком большой (лимит 512 МБ)") }, { status: 413 })
      }
      throw e
    }
    part = null // стрим закрыт pipeline'ом

    const duration = await probeAudioDuration(destPath)
    return NextResponse.json({
      file: unique,
      name: safeName.replace(/\.[^.]+$/, ''),
      duration,
      url: `/api/montage/audio?f=${encodeURIComponent(unique)}`,
    })
  } catch (err) {
    if (part) part.cancel()
    if (destPath) await fs.unlink(destPath).catch(() => {})
    const msg = err instanceof Error ? err.message : String(err)
    const status = err instanceof MultipartParseError ? 400 : 500
    return NextResponse.json({ error: msg }, { status })
  }
}

/** (правка 874) GET с Range — <audio> в превью требует seek по звуку. */
export async function GET(req: NextRequest) {

  const f = req.nextUrl.searchParams.get('f') || ''
  if (!f) return NextResponse.json({ error: stT("Не указано f") }, { status: 400 })
  const target = path.resolve(path.join(AUDIO_DIR, path.basename(f)))
  if (!target.startsWith(AUDIO_DIR + path.sep) || !existsSync(target)) {
    return NextResponse.json({ error: stT("Файл не найден") }, { status: 404 })
  }
  const st = fsSync.statSync(target)
  if (!st.isFile()) return NextResponse.json({ error: stT("Файл не найден") }, { status: 404 })

  const ext = path.extname(target).toLowerCase()
  const mime = MIME[ext] || 'application/octet-stream'
  const range = req.headers.get('range')
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null
  if (m && (m[1] || m[2])) {
    let start = m[1] ? parseInt(m[1], 10) : 0
    let end = m[2] ? Math.min(parseInt(m[2], 10), st.size - 1) : st.size - 1
    if (!Number.isFinite(start) || start < 0) start = 0
    if (!Number.isFinite(end) || end >= st.size) end = st.size - 1
    if (start > end) {
      return new NextResponse(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${st.size}` },
      })
    }
    return new NextResponse(createReadStream(target, { start, end }) as unknown as ReadableStream, {
      status: 206,
      headers: {
        'Content-Type': mime,
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${st.size}`,
        'Accept-Ranges': 'bytes',
      },
    })
  }
  return new NextResponse(createReadStream(target) as unknown as ReadableStream, {
    status: 200,
    headers: { 'Content-Type': mime, 'Content-Length': String(st.size), 'Accept-Ranges': 'bytes' },
  })
}
