import { NextRequest, NextResponse } from 'next/server'
import { promises as fs } from 'fs'
import { existsSync } from 'fs'
import path from 'path'
import { getAppConfig } from '@/lib/app-config'
import { sanitizeFolderPath } from '@/lib/gallery-folders'
import { ensureUpscaleMeta } from '@/lib/upscale-meta'

/**
 * (правка 727) POST /api/upscale/place
 * Body: { path: "<output_path>", subfolder: "проект/сцены",
 *        job_id?: "<id>", source_name?: "<имя исходника>" }
 *
 * DLSS-мост всегда публикует результат в КОРЕНЬ output (UPSCALE_OUTPUT_DIR),
 * поэтому переиспользованный ролик из папки раньше терял свою папку. Роут
 * переносит готовый файл (и его .meta.json) в выбранную подпапку; при
 * совпадении имени добавляет суффикс. Возвращает новый путь — очередь
 * дописывает в него generation_time.
 *
 * Сама мета: если сайдкара ещё нет (ensureUpscaleMeta в /api/upscale/job
 * работает fire-and-forget и мог не успеть), создаём его уже на новом месте —
 * с наследованием промпта из сайдкара исходника (source_name + подпапка).
 */
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as
      | { path?: unknown; subfolder?: unknown; job_id?: unknown; source_name?: unknown }
      | null
    const rawPath = typeof body?.path === 'string' ? body.path : ''
    const sub = sanitizeFolderPath(typeof body?.subfolder === 'string' ? body.subfolder : '')
    if (!rawPath) {
      return NextResponse.json({ error: 'Нужен path' }, { status: 400 })
    }

    const OUTPUT_DIR = path.resolve(getAppConfig().outputDir)
    const src = path.resolve(rawPath)
    if (src !== OUTPUT_DIR && !src.startsWith(OUTPUT_DIR + path.sep)) {
      return NextResponse.json({ error: 'Файл вне папки output' }, { status: 400 })
    }
    if (!existsSync(src)) {
      return NextResponse.json({ error: 'Файл результата не найден' }, { status: 404 })
    }
    // '' — общая папка: результат уже на месте, двигать некуда.
    if (!sub) {
      return NextResponse.json({ ok: true, path: src, subfolder: '' })
    }

    const dir = path.join(OUTPUT_DIR, ...sub.split('/').filter(Boolean))
    await fs.mkdir(dir, { recursive: true })

    const ext = path.extname(src)
    const stem = path.basename(src, ext)
    let dest = path.join(dir, path.basename(src))
    let counter = 1
    while (existsSync(dest)) {
      dest = path.join(dir, `${stem}_${counter++}${ext}`)
      if (counter > 1000) {
        return NextResponse.json({ error: 'Слишком много совпадений имён' }, { status: 500 })
      }
    }

    // Перенос в пределах одного диска — rename; иначе копия + удаление.
    try {
      await fs.rename(src, dest)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
      await fs.copyFile(src, dest)
      await fs.unlink(src)
    }

    // Сайдкар едет вместе с видео (если сервер статуса уже успел его создать).
    const srcMeta = `${src}.meta.json`
    const destMeta = `${dest}.meta.json`
    if (existsSync(srcMeta)) {
      try {
        await fs.rename(srcMeta, destMeta)
      } catch {
        await fs.copyFile(srcMeta, destMeta).catch(() => {})
        await fs.unlink(srcMeta).catch(() => {})
      }
    }

    // Гарантируем мету на новом месте (иначе finalize молча ничего не допишет).
    if (!existsSync(destMeta)) {
      const jobId = typeof body?.job_id === 'string' && body.job_id ? body.job_id : `place_${Date.now().toString(36)}`
      const sourceName = typeof body?.source_name === 'string' ? path.basename(body.source_name) : ''
      // Абсолютный путь исходника → ensureUpscaleMeta найдёт его сайдкар даже
      // во вложенной папке и унаследует промпт/референсы.
      const sourceHint = sourceName ? path.join(dir, sourceName) : undefined
      await ensureUpscaleMeta(dest, jobId, sourceHint).catch(() => {})
    }

    // source_video в сайдкаре — реальный исходник (мост в поле input кладёт
    // временную копию из data/upscale-input, её имя в галерее бесполезно).
    if (existsSync(destMeta)) {
      try {
        const meta = JSON.parse(await fs.readFile(destMeta, 'utf-8')) as Record<string, unknown>
        const sourceName = typeof body?.source_name === 'string' ? path.basename(body.source_name) : ''
        if (sourceName) {
          meta.source_video = { filename: sourceName, subfolder: sub }
          meta.source_file = sourceName
        } else if (meta.source_video && typeof meta.source_video === 'object') {
          ;(meta.source_video as { subfolder?: string }).subfolder = sub
        }
        await fs.writeFile(destMeta, JSON.stringify(meta, null, 2), 'utf-8')
      } catch { /* битый сайдкар — оставляем как есть */ }
    }

    return NextResponse.json({
      ok: true,
      path: dest,
      filename: path.basename(dest),
      subfolder: sub,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
