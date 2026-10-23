import { NextRequest, NextResponse } from 'next/server'
import { promises as fs } from 'fs'
import path from 'path'
import { getAppConfig } from '@/lib/app-config'
import { sanitizeFolderPath } from '@/lib/gallery-folders' // (правка 495)
import { deleteThumbsFor } from '@/lib/thumb'

/**
 * POST /api/comfy/delete
 * Body: { filename: string, subfolder?: string }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const filename = body.filename as string
    const OUTPUT_DIR = getAppConfig().outputDir
    if (!filename) {
      return NextResponse.json({ error: 'filename required' }, { status: 400 })
    }

    // Sanitize: prevent path traversal
    // (правка 495) subfolder — многоуровневый относительный путь ('a/b').
    const safeName = path.basename(filename)
    const subfolder = body.subfolder ? sanitizeFolderPath(String(body.subfolder)) : ''
    // (правка 350) OUTPUT_DIR нормализуем resolve'ом ДО сравнения — иначе
    // относительный/ненормализованный outputDir ломал startsWith-проверку.
    const outputRoot = path.resolve(OUTPUT_DIR)
    const target = path.resolve(path.join(outputRoot, subfolder, safeName))

    // Ensure target is within OUTPUT_DIR
    if (!target.startsWith(outputRoot + path.sep)) {
      return NextResponse.json({ error: 'Invalid path' }, { status: 400 })
    }

    await fs.unlink(target)
    // (правки 378/391) Латент-пайплайн: сохранённый AV-латент (.latent из
    // поля latent_file меты) живёт, пока жив его mp4 — удаляем вместе с
    // ним, иначе файлы-сироты копятся в output/<sub>/latents/. Путь строго
    // внутри output/ (resolve + нижний регистр на win32, паттерн правки 348).
    // (правка 391) Мету читаем ДО удаления сайдкара — правка 378 удаляла
    // его первым, чтение всегда давало ENOENT и .latент не удалялся никогда.
    // latent_file хранится относительно output/ ('<sub>/latents/<file>' —
    // так пишет pending-meta finalizePendingMeta), как у resolveSourceLatent.
    let latentFile: string | null = null
    try {
      const metaRaw = await fs.readFile(target + '.meta.json', 'utf-8')
      const meta = JSON.parse(metaRaw) as { latent_file?: unknown }
      if (typeof meta.latent_file === 'string' && meta.latent_file) {
        latentFile = meta.latent_file
      }
    } catch { /* нет меты / битая — латент просто не трогаем */ }
    // Also delete .meta.json sidecar if present
    await fs.unlink(target + '.meta.json').catch(() => {})
    if (latentFile) {
      const latentPath = path.resolve(outputRoot, latentFile)
      const norm = (x: string) => (process.platform === 'win32' ? x.toLowerCase() : x)
      if (
        norm(latentPath) !== norm(outputRoot) &&
        norm(latentPath).startsWith(norm(outputRoot) + path.sep)
      ) {
        await fs.unlink(latentPath).catch(() => {})
      }
    }
    // (правка 355) Чистим дисковый кэш превью (.thumbs) удалённого файла.
    await deleteThumbsFor(`output_${subfolder ? subfolder + '_' : ''}${safeName}`)
    return NextResponse.json({ ok: true })
  } catch (err) {
    if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return NextResponse.json({ error: 'File not found' }, { status: 404 })
    }
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
