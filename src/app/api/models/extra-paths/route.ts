import { NextRequest, NextResponse } from 'next/server'
import { statSync } from 'fs'
import { detectExtraEntries } from '@/lib/extra-model-paths'

export const dynamic = 'force-dynamic'

/**
 * POST /api/models/extra-paths — подготовка папки к добавлению в «Свои папки
 * моделей» (правка 257). Проверяет существование и раскладывает корень со
 * стандартной структурой ComfyUI по категориям (см. detectExtraEntries).
 *
 * Body: { path: string } — абсолютный путь к папке.
 * Ответ: { ok, entries: [{path, category}] }.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { path?: string }
    const p = (body?.path ?? '').trim()
    if (!p) {
      return NextResponse.json({ error: 'Укажите путь к папке' }, { status: 400 })
    }
    let isDir = false
    try {
      isDir = statSync(p).isDirectory()
    } catch {
      return NextResponse.json({ error: `Папка не найдена: ${p}` }, { status: 404 })
    }
    if (!isDir) {
      return NextResponse.json({ error: 'Это файл, нужна папка' }, { status: 400 })
    }
    return NextResponse.json({ ok: true, entries: detectExtraEntries(p) })
  } catch {
    return NextResponse.json({ error: 'Не удалось проверить папку' }, { status: 500 })
  }
}
