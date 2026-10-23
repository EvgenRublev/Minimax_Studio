import { NextRequest, NextResponse } from 'next/server'
import { promises as fs, createWriteStream } from 'fs'
import { basename, extname, join, resolve } from 'path'
import { Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { serveLocalFile } from '@/lib/local-file'
import {
  readFirstMultipartPart,
  MultipartParseError,
  type MultipartFilePart,
} from '@/lib/multipart-stream'

/**
 * (правка 108) Вложения чата ассистента — ИЗОЛИРОВАННОЕ хранилище.
 *
 * Картинки/видео, прикреплённые в чате, существуют ТОЛЬКО в чате и нужны
 * ТОЛЬКО для генерации описания (мультимодальный LLM). Они НЕ должны:
 *   • лежать в ComfyUI/input/ (общая папка референсов генерации);
 *   • попадать в референсы генерации (<Picture N>/<Video N>);
 *   • появляться в галерее / upscale / «чистке input».
 *
 * Поэтому они живут в отдельной папке проекта <project>/data/chat-attachments/
 * (переносима вместе с data/assistant-chats.json) и обслуживаются этим роутом.
 *
 *   POST   /api/assistant/attachment          — загрузка (FormData: file)
 *   GET    /api/assistant/attachment?filename — подача (Range-совместимо)
 *   DELETE /api/assistant/attachment?filename — удаление (при удалении чата)
 */
export const dynamic = 'force-dynamic'

const ATTACH_DIR = resolve(process.cwd(), 'data', 'chat-attachments')

// Лимит вложения: раньше файл буферизовался целиком без ограничения, и
// гигабайтное видео могло уронить весь Node-процесс (вместе с генерациями).
// 1 ГБ достаточно для любых референсов LLM.
const MAX_ATTACH_BYTES = 1024 * 1024 * 1024

/** Unsafe filename characters — replace with '_' (any OS). */
const UNSAFE = /[<>:"/\\|?*\x00-\x1f]/g

/** Keep only image/video extensions (everything else is meaningless for the LLM). */
function allowedExt(ext: string): string | null {
  const e = ext.toLowerCase()
  if (
    e === '.png' || e === '.jpg' || e === '.jpeg' || e === '.webp' ||
    e === '.gif' || e === '.bmp' || e === '.avif' ||
    e === '.mp4' || e === '.m4v' || e === '.webm' || e === '.mov' || e === '.mkv'
  ) return e
  return null
}

/** Traversal-safe resolution inside ATTACH_DIR. null = invalid/missing. */
async function safeAttachPath(filename: string): Promise<string | null> {
  const name = basename(filename)
  if (!name || name === '.' || name === '..') return null
  const target = resolve(ATTACH_DIR, name)
  if (!target.startsWith(ATTACH_DIR)) return null
  try {
    const st = await fs.stat(target)
    if (!st.isFile()) return null
  } catch {
    return null
  }
  return target
}

/* ─── POST: upload ─── */
export async function POST(req: NextRequest) {
  let part: MultipartFilePart | null = null
  try {
    const webBody = req.body
    if (!webBody) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    }
    // (правка 587) Стриминговый разбор multipart (как /api/loras): req.formData()
    // буферизовал ВСЁ тело в heap до проверок — гигабайтное вложение раздувало
    // память до отдачи 413. Имя файла приходит в заголовках части ДО байтов.
    part = await readFirstMultipartPart(webBody, req.headers.get('content-type'))
    if (!part.filename) {
      part.cancel()
      return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    }
    const ext = allowedExt(extname(part.filename))
    if (!ext) {
      part.cancel()
      return NextResponse.json(
        { error: 'Поддерживаются только изображения и видео (png, jpg, webp, gif, mp4, webm, mov…)' },
        { status: 400 },
      )
    }
    await fs.mkdir(ATTACH_DIR, { recursive: true })
    const safeBase = basename(part.filename).replace(UNSAFE, '_') || 'attachment'
    const unique = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${safeBase}`
    const dest = join(ATTACH_DIR, unique)
    // (правка 350) Потоковая запись вместо Buffer.from(arrayBuffer): файл
    // до 1 ГБ раньше буферизовался целиком в кучу Node (давил и без того
    // тесную память рядом с ComfyUI). (правка 587) Лимит enforced ТОЛЬКО
    // здесь, на лету (file.size из formData больше недоступен) — при
    // превышении поток обрывается, частичный файл удаляется.
    let bytes = 0
    let tooLarge = false
    const guard = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytes += chunk.length
        if (bytes > MAX_ATTACH_BYTES) {
          tooLarge = true
          cb(new Error('attachment too large'))
        } else cb(null, chunk)
      },
    })
    try {
      await pipeline(part.stream, guard, createWriteStream(dest))
    } catch (pipeErr) {
      part.cancel()
      await fs.unlink(dest).catch(() => {})
      if (tooLarge) {
        return NextResponse.json(
          { error: 'Файл слишком большой (лимит 1 ГБ). Уменьшите видео перед вложением.' },
          { status: 413 },
        )
      }
      throw pipeErr
    }
    return NextResponse.json({ name: unique })
  } catch (err) {
    if (part) part.cancel()
    const msg = err instanceof Error ? err.message : String(err)
    const status = err instanceof MultipartParseError ? 400 : 500
    return NextResponse.json({ error: `Upload failed: ${msg}` }, { status })
  }
}

/* ─── GET: serve (Range-capable for video seeking) ─── */
export async function GET(req: NextRequest) {
  const filename = req.nextUrl.searchParams.get('filename')
  if (!filename) {
    return new Response('Missing filename', { status: 400 })
  }
  const source = await safeAttachPath(filename)
  if (!source) {
    return new Response('Attachment not found', { status: 404 })
  }
  const local = await serveLocalFile(req, filename, source)
  if (local) return local
  return new Response('Failed to serve attachment', { status: 500 })
}

/* ─── DELETE: remove (best-effort, called when a chat is deleted) ─── */
export async function DELETE(req: NextRequest) {
  const filename = req.nextUrl.searchParams.get('filename')
  if (!filename) {
    return NextResponse.json({ error: 'Missing filename' }, { status: 400 })
  }
  const source = await safeAttachPath(filename)
  if (!source) {
    return NextResponse.json({ deleted: false, reason: 'not found' })
  }
  try {
    await fs.unlink(source)
    return NextResponse.json({ deleted: true })
  } catch {
    return NextResponse.json({ deleted: false })
  }
}
