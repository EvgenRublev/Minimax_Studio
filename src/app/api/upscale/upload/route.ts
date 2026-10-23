import { NextRequest, NextResponse } from 'next/server'
import { createWriteStream, mkdirSync, renameSync, unlinkSync } from 'fs'
import path from 'path'
import crypto from 'crypto'

/**
 * (правка 74) POST /api/upscale/upload
 * FormData field `file` → стрим в data/upscale-input/<ts>-<name>.
 * Видео/фото для вкладки Upscale (DLSS-мост). Лимит 32 ГБ.
 *
 * ВАЖНО: req.formData() буферизует ВЕСЬ файл в памяти (undici собирает
 * multipart в Blob в RAM) — для гигабайтных видео это OOM всего сервера.
 * Поэтому тело запроса разбираем потоково: файл пишем на диск чанками,
 * лимит размера проверяем на лету.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 600

const MAX_UPLOAD_BYTES = 32 * 1024 ** 3

const IMAGE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.avif', '.avifs', '.tiff', '.tif',
  '.heic', '.heif', '.bmp', '.gif',
])
const VIDEO_EXTS = new Set([
  '.mp4', '.m4v', '.mov', '.mkv', '.avi', '.webm', '.m2ts', '.mts', '.ts',
  '.mxf', '.vob', '.wmv', '.flv', '.mpg', '.mpeg', '.mpe', '.ogv', '.3gp',
  '.3g2', '.asf', '.divx', '.f4v',
])

function sanitizeName(name: string): string {
  const base = path.basename(name).replace(/[\\/:*?"<>|]+/g, '_').trim()
  return base.length > 1 ? base : 'file'
}

/** boundary из Content-Type: multipart/form-data; boundary=... */
function getBoundary(contentType: string | null): string | null {
  if (!contentType) return null
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
  const b = (m?.[1] ?? m?.[2] ?? '').trim()
  return b || null
}

/** filename из content-disposition part-заголовков. */
function parseFileName(headers: string): string | null {
  const cd = headers
    .split(/\r?\n/)
    .find((l) => /^content-disposition\s*:/i.test(l))
  if (!cd) return null
  const m = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(cd)
  if (!m) return null
  const name = m[1].replace(/\\(.)/g, '$1').trim()
  return name || null
}

interface UploadedFile {
  fileName: string
  size: number
}

/** Ошибка валидации (клиентская) — отдавать как 400, а не 500. */
class UploadError extends Error {}

/**
 * Потоковый разбор multipart/form-data: находит part с filename и пишет его
 * тело в `dest` через переданный фабрикой write stream, не удерживая тело
 * запроса в памяти. Остальные part'ы (поля без filename) пропускаются.
 * Бросает ошибку при превышении MAX_UPLOAD_BYTES — файл удаляется вызывающим.
 */
async function streamMultipartFile(
  req: NextRequest,
  dest: string,
): Promise<UploadedFile> {
  const boundary = getBoundary(req.headers.get('content-type'))
  if (!boundary) throw new Error('Ожидается multipart/form-data с boundary')
  if (!req.body) throw new Error('Пустое тело запроса')

  const delim = Buffer.from(`\r\n--${boundary}`)
  // Виртуальный ведущий CRLF: самый первый «--boundary» в начале тела
  // матчится тем же разделителем, что и все последующие.
  let carry = Buffer.from('\r\n')
  let phase: 'preamble' | 'headers' | 'body' | 'done' = 'preamble'
  let fileName: string | null = null
  let fileBytes = 0
  let sawFile = false

  const out = createWriteStream(dest)
  // (правка 587) 'error'-listener на write-стриме обязателен: ENOSPC/EPERM
  // посреди записи эмитил 'error' с НУЛЁМ слушателей → uncaught exception
  // валил весь сервер (колбэки out.write() слушателями не считаются).
  // Ошибка запоминается в streamError и проваливает ближайший flush/end,
  // а частичный файл чистит существующий путь отката (out.destroy + unlink).
  let streamError: Error | null = null
  out.on('error', (err: Error) => {
    streamError = err
  })
  const reader = req.body.getReader()
  const flush = (chunk: Buffer) =>
    new Promise<void>((resolve, reject) => {
      if (streamError) return reject(streamError)
      out.write(chunk, (err) => (err ? reject(err) : resolve()))
    })

  try {
    readLoop: for (;;) {
      // ── разбор накопленного буфера по фазам ──
      // («done» сюда не доходит: присвоение фазы done всегда сопровождается
      // break readLoop ниже)
      for (;;) {
        if (phase === 'preamble') {
          const i = carry.indexOf(delim)
          if (i < 0) {
            // оставляем хвост длиной delim-1: разделитель может быть разрезан границей чанков
            if (carry.length > delim.length - 1) {
              carry = carry.subarray(carry.length - (delim.length - 1))
            }
            break
          }
          carry = carry.subarray(i + delim.length)
          // после разделителя: «--» = финальный, иначе «\r\n» + заголовки part'а
          if (carry.subarray(0, 2).toString() === '--') {
            phase = 'done'
            break readLoop
          }
          if (carry.subarray(0, 2).toString() === '\r\n') carry = carry.subarray(2)
          phase = 'headers'
        }

        if (phase === 'headers') {
          const i = carry.indexOf('\r\n\r\n')
          if (i < 0) break // ждём ещё данных
          const headers = carry.subarray(0, i).toString('utf8')
          carry = carry.subarray(i + 4)
          fileName = parseFileName(headers)
          phase = 'body'
        }

        if (phase === 'body') {
          const i = carry.indexOf(delim)
          if (i < 0) {
            // разделителя нет: всё, кроме потенциального хвоста, — тело part'а
            const keep = delim.length - 1
            if (carry.length > keep) {
              const chunk = carry.subarray(0, carry.length - keep)
              if (fileName) {
                fileBytes += chunk.length
                if (fileBytes > MAX_UPLOAD_BYTES) {
                  throw new UploadError('Файл больше 32 ГБ — слишком большой для обработки')
                }
                await flush(chunk)
              }
              carry = carry.subarray(carry.length - keep)
            }
            break
          }
          const chunk = carry.subarray(0, i)
          if (fileName) {
            fileBytes += chunk.length
            if (fileBytes > MAX_UPLOAD_BYTES) {
              throw new UploadError('Файл больше 32 ГБ — слишком большой для обработки')
            }
            await flush(chunk)
            sawFile = true
          }
          carry = carry.subarray(i + delim.length)
          if (carry.subarray(0, 2).toString() === '--') {
            phase = 'done'
            break readLoop
          }
          if (carry.subarray(0, 2).toString() === '\r\n') carry = carry.subarray(2)
          phase = 'headers'
        }
      }

      const { done, value } = await reader.read()
      if (done) break
      carry = Buffer.concat([carry, Buffer.from(value)])
    }

    if (!sawFile || !fileName) {
      throw new UploadError('Файл не передан (ожидается поле "file")')
    }
    // (правка 587) Ошибка стрима могла прилететь между записями (не в
    // колбэке write) — проверяем флаг и перед end.
    if (streamError) throw streamError
    await new Promise<void>((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())))
    return { fileName, size: fileBytes }
  } catch (err) {
    out.destroy()
    void reader.cancel().catch(() => {})
    throw err
  }
}

export async function POST(req: NextRequest) {
  let destPath = ''
  try {
    const dir = path.join(process.cwd(), 'data', 'upscale-input')
    mkdirSync(dir, { recursive: true })
    destPath = path.join(dir, `part-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`)

    const uploaded = await streamMultipartFile(req, destPath)

    const ext = path.extname(uploaded.fileName).toLowerCase()
    if (!IMAGE_EXTS.has(ext) && !VIDEO_EXTS.has(ext)) {
      throw new UploadError(
        `Формат ${ext || '(без расширения)'} не поддерживается. Поддерживаются изображения (PNG, JPEG, WebP, AVIF, RAW…) и видео (MP4, MOV, MKV, AVI…).`,
      )
    }
    if (uploaded.size > MAX_UPLOAD_BYTES) {
      throw new UploadError('Файл больше 32 ГБ — слишком большой для обработки')
    }

    const finalName = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${sanitizeName(uploaded.fileName)}`
    const finalPath = path.join(dir, finalName)
    renameSync(destPath, finalPath)
    destPath = finalPath

    return NextResponse.json({
      ok: true,
      path: finalPath,
      name: uploaded.fileName,
      size: uploaded.size,
      kind: IMAGE_EXTS.has(ext) ? 'image' : 'video',
    })
  } catch (err) {
    if (destPath) {
      try { unlinkSync(destPath) } catch { /* ignore */ }
    }
    const msg = err instanceof Error ? err.message : String(err)
    const status = err instanceof UploadError ? 400 : 500
    return NextResponse.json({ error: `Ошибка загрузки: ${msg}` }, { status })
  }
}
