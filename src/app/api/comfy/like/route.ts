import { NextRequest, NextResponse } from 'next/server'
import { promises as fs } from 'fs'
import path from 'path'
import { getAppConfig } from '@/lib/app-config'
import { sanitizeFolderPath } from '@/lib/gallery-folders'

/**
 * POST /api/comfy/like  (правка 793)
 * Body: { filename: string, subfolder?: string, liked: boolean }
 *
 * Ставит/снимает флаг «избранное» в сайдкаре .meta.json рядом с файлом
 * (тот же сайдкар, что читает галерея и диалог метаданных). Флаг живёт
 * вместе с файлом: переезжает с ним при переносе в папку и удаляется
 * вместе с файлом.
 *
 * Чтение-модификация-запись напрямую (по образцу upscale-meta), БЕЗ
 * writeMetaSidecar: у неё guard по job_id, а у лайка задачи нет — и
 * merge-режим не нужен, меняем ровно одно поле.
 *
 * Сайкар создаётся только при liked=true (снимать нечего — файла меты
 * просто нет). Битый JSON не чиним и не затираем: читаем, если парсится,
 * иначе пишем новый объект (других полей всё равно не сохранить).
 */
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const filename = typeof body.filename === 'string' ? body.filename : ''
    const liked = body.liked === true
    if (!filename) {
      return NextResponse.json({ error: 'filename required' }, { status: 400 })
    }

    // (правка 793) Та же защита от path traversal, что у /api/comfy/delete.
    const safeName = path.basename(filename)
    const subfolder = body.subfolder ? sanitizeFolderPath(String(body.subfolder)) : ''
    const outputRoot = path.resolve(getAppConfig().outputDir || '')
    if (!outputRoot) {
      return NextResponse.json({ error: 'Output dir is not configured' }, { status: 500 })
    }
    const target = path.resolve(path.join(outputRoot, subfolder, safeName))
    if (!target.startsWith(outputRoot + path.sep)) {
      return NextResponse.json({ error: 'Invalid path' }, { status: 400 })
    }
    // Лайкаем только существующий файл — не создаём мету-призрака.
    try {
      await fs.stat(target)
    } catch {
      return NextResponse.json({ error: 'File not found' }, { status: 404 })
    }

    const metaFile = target + '.meta.json'
    let meta: Record<string, unknown> = {}
    try {
      const raw = await fs.readFile(metaFile, 'utf-8')
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        meta = parsed as Record<string, unknown>
      }
    } catch { /* сайдкара нет или битый — стартуем с пустого объекта */ }

    if (liked) meta.liked = true
    else delete meta.liked

    // Запись через temp + rename — атомарная (полустёртый сайдкар невозможен).
    const tmp = metaFile + '.tmp'
    await fs.writeFile(tmp, JSON.stringify(meta, null, 2), 'utf-8')
    await fs.rename(tmp, metaFile)

    return NextResponse.json({ ok: true, liked })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
