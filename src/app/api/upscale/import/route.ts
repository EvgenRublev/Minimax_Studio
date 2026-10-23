import { NextRequest, NextResponse } from 'next/server'
import { createReadStream, createWriteStream, mkdirSync, unlinkSync } from 'fs'
import { promises as fs } from 'fs'
import { pipeline } from 'stream/promises'
import path from 'path'
import crypto from 'crypto'
import { getAppConfig } from '@/lib/app-config'
import { sanitizeFolderPath } from '@/lib/gallery-folders' // (правка 495)

/**
 * POST /api/upscale/import
 * Тело: { filename, subfolder? }
 *
 * Копирует видео ИЗ ОБЩЕЙ ПАПКИ OUTPUT COMFYUI в data/upscale-input
 * прямо на сервере (стриминг, без браузера в цикле) — для сценария
 * «отправить превьюшку из галереи на апскейл». Видео может быть
 * гигабайтами — гонять его через fetch/blob в браузере нельзя.
 *
 * Ответ — тот же формат, что и /api/upscale/upload:
 * { ok, path, name, size, kind }.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 600

const MAX_BYTES = 32 * 1024 ** 3

// (правка 349) Изображения разрешены, как в /api/upscale/upload — у моста
// есть nr-image/vsr-image, иначе картинку из галереи нельзя было отправить
// на апскейл (только через ручной upload).
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

export async function POST(req: NextRequest) {
  let destPath = ''
  try {
    const body = (await req.json().catch(() => null)) as
      | { filename?: unknown; subfolder?: unknown }
      | null
    const filename = typeof body?.filename === 'string' ? body.filename.trim() : ''
    const subfolder = typeof body?.subfolder === 'string' ? body.subfolder.trim() : ''
    if (!filename) {
      return NextResponse.json(
        { error: 'Не передано имя файла (ожидается { filename, subfolder? })' },
        { status: 400 },
      )
    }

    const OUTPUT_DIR = getAppConfig().outputDir
    if (!OUTPUT_DIR) {
      return NextResponse.json(
        { error: 'Папка output ComfyUI не найдена (config.ini → [comfy] comfy_dir)' },
        { status: 500 },
      )
    }

    // Безопасность: basename имени + санитизированный относительный путь
    // папки (правка 495), результат обязан остаться внутри output.
    const outRoot = path.resolve(OUTPUT_DIR)
    const safeName = path.basename(filename)
    const safeSub = subfolder ? sanitizeFolderPath(subfolder) : ''
    const src = path.resolve(outRoot, safeSub ? path.join(safeSub, safeName) : safeName)
    if (src !== outRoot && !src.startsWith(outRoot + path.sep)) {
      return NextResponse.json({ error: 'Некорректный путь к файлу' }, { status: 400 })
    }

    const ext = path.extname(safeName).toLowerCase()
    const isImage = IMAGE_EXTS.has(ext)
    if (!VIDEO_EXTS.has(ext) && !isImage) {
      return NextResponse.json(
        { error: `Формат ${ext || '(без расширения)'} не поддерживается для апскейла` },
        { status: 400 },
      )
    }

    let st
    try {
      st = await fs.stat(src)
    } catch {
      return NextResponse.json(
        { error: 'Файл не найден в общей папке output (возможно, он уже удалён)' },
        { status: 404 },
      )
    }
    if (!st.isFile()) {
      return NextResponse.json({ error: 'Это не файл' }, { status: 400 })
    }
    if (st.size > MAX_BYTES) {
      return NextResponse.json({ error: `Файл больше 32 ГБ — слишком большой для обработки` }, { status: 400 })
    }

    const dir = path.join(process.cwd(), 'data', 'upscale-input')
    mkdirSync(dir, { recursive: true })
    const name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${sanitizeName(safeName)}`
    destPath = path.join(dir, name)

    // Стриминг по диску — память не трогаем.
    await pipeline(createReadStream(src), createWriteStream(destPath))

    return NextResponse.json({
      ok: true,
      path: destPath,
      name: safeName,
      size: st.size,
      kind: isImage ? 'image' : 'video',
      // (правка 727) Папка исходника в галерее — результат апскейла
      // сохранится туда же, а не в корень output.
      subfolder: safeSub,
    })
  } catch (err) {
    if (destPath) {
      try { unlinkSync(destPath) } catch { /* ignore */ }
    }
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: `Ошибка импорта из галереи: ${msg}` }, { status: 500 })
  }
}
