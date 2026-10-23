import { NextRequest, NextResponse } from 'next/server'
import { promises as fs } from 'fs'
import { createReadStream, createWriteStream, unlinkSync } from 'fs'
import { pipeline } from 'stream/promises'
import path from 'path'
import crypto from 'crypto'
import { getAppConfig } from '@/lib/app-config'
import { sanitizeFolderPath } from '@/lib/gallery-folders' // (правка 495)
import { probeVideoFile } from '@/lib/video-probe'

/**
 * POST /api/extend/import
 * Тело: { filename, subfolder? }
 *
 * Копирует видео ИЗ ОБЩЕЙ ПАПКИ OUTPUT COMFYUI в ComfyUI input/ прямо на
 * сервере (стриминг, без браузера в цикле) — для сценария «перетащить
 * превьюшку из галереи в исходник продления».
 *
 * ВАЖНО: нода продления (VHS_LoadVideo) и проба размеров/кадров в
 * /api/comfy/generate ищут источник ПО ИМЕНИ В Папке input/, поэтому
 * ответ отдаёт basename — ровно как uploadImage() для файлов с диска.
 * (Отдельный роут, а не /api/upscale/import: тот пишет в data/upscale-input —
 * путь, который LoadVideo не видит.)
 *
 * Ответ: { ok, name, size, kind }.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 600

const MAX_BYTES = 32 * 1024 ** 3

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

    const cfg = getAppConfig()
    if (!cfg.outputDir) {
      return NextResponse.json(
        { error: 'Папка output ComfyUI не найдена (config.ini → [comfy] comfy_dir)' },
        { status: 500 },
      )
    }

    // Безопасность: basename имени + санитизированный относительный путь
    // папки (правка 495), источник обязан остаться внутри output.
    const outRoot = path.resolve(cfg.outputDir)
    const safeName = path.basename(filename)
    const safeSub = subfolder ? sanitizeFolderPath(subfolder) : ''
    const src = path.resolve(outRoot, safeSub ? path.join(safeSub, safeName) : safeName)
    if (src !== outRoot && !src.startsWith(outRoot + path.sep)) {
      return NextResponse.json({ error: 'Некорректный путь к файлу' }, { status: 400 })
    }

    const ext = path.extname(safeName).toLowerCase()
    if (!VIDEO_EXTS.has(ext)) {
      return NextResponse.json(
        { error: `Формат ${ext || '(без расширения)'} не поддерживается для продления видео` },
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

    const dir = path.resolve(cfg.inputDir)
    await fs.mkdir(dir, { recursive: true })

    // Уникальное имя без перезаписи (как в /api/comfy/refine).
    // (правка 716) extName/stem были вычислены, но не использовались —
    // мёртвый код. Имя формируется через base.
    const base = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${sanitizeName(safeName)}`
    let destName: string
    destPath = path.join(dir, base)
    await pipeline(createReadStream(src), createWriteStream(destPath))
    destName = base

    // (правка 291) Длительность исходника — ffprobe на сервере, чтобы клиент
    // сразу видел «итого ~X с» в badges/карточках клипов без отдельного API.
    // Ошибка пробы не критична: UI обработает durationSec=0/отсутствующее.
    let durationSec: number | undefined
    try {
      const pr = await probeVideoFile(destPath)
      if (Number.isFinite(pr.durationSec) && pr.durationSec > 0) {
        durationSec = Math.round(pr.durationSec * 10) / 10
      }
    } catch { /* ffprobe недоступен/видео нестандартное — не блокируем импорт */ }

    return NextResponse.json({
      ok: true,
      name: destName, // basename — его ждёт VHS_LoadVideo и проба в /api/comfy/generate
      size: st.size,
      kind: 'video',
      ...(durationSec !== undefined ? { durationSec } : {}),
    })
  } catch (err) {
    if (destPath) {
      try { unlinkSync(destPath) } catch { /* ignore */ }
    }
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: `Ошибка импорта из галереи: ${msg}` }, { status: 500 })
  }
}
