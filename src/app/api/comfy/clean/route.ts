import { NextResponse } from 'next/server'
import { promises as fs } from 'fs'
import path from 'path'
import { getAppConfig } from '@/lib/app-config'

/**
 * POST /api/comfy/clean
 * Body: { target: 'input' | 'output' | 'upscale' }
 *
 * Удаляет ВСЕ файлы и подкаталоги в указанной директории.
 * Сама директория сохраняется (удаляется только её содержимое).
 *
 * - target='input'   → очищает ComfyUI/input  (референсы, кадры, загрузки)
 * - target='output'  → очищает ComfyUI/output (сгенерированные видео + .meta.json)
 * - target='upscale' → (правка 167) очищает data/upscale-input, data/upscale-output,
 *   upscale/outputs — все файлы апскейла (входные и выходные)
 */

/** Рекурсивно очищает содержимое одной директории. Возвращает число удалённых элементов. */
async function cleanDirectory(dir: string): Promise<number> {
  try {
    await fs.stat(dir)
  } catch {
    return 0 // Директории нет — считаем, что она уже пуста
  }

  const entries = await fs.readdir(dir, { withFileTypes: true })
  let deleted = 0
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    try {
      if (entry.isDirectory()) {
        await fs.rm(fullPath, { recursive: true, force: true })
      } else {
        await fs.unlink(fullPath)
      }
      deleted++
    } catch {
      // Файл мог быть занят — пропускаем
    }
  }
  return deleted
}

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const target: unknown = body.target

    if (target !== 'input' && target !== 'output' && target !== 'upscale') {
      return NextResponse.json(
        { error: 'target must be "input", "output" or "upscale"' },
        { status: 400 },
      )
    }

    // (правка 167) Upscale: чистим ВСЕ директории апскейла (входные + выходные)
    if (target === 'upscale') {
      const cwd = process.cwd()
      const dirs = [
        path.join(cwd, 'data', 'upscale-input'),
        path.join(cwd, 'data', 'upscale-output'),
        path.join(cwd, 'upscale', 'outputs'),
      ]
      let total = 0
      for (const d of dirs) {
        total += await cleanDirectory(d)
      }
      return NextResponse.json({ ok: true, deleted: total })
    }

    const config = getAppConfig()
    const dir = target === 'input' ? config.inputDir : config.outputDir

    if (!dir) {
      return NextResponse.json({ error: 'Директория не настроена' }, { status: 400 })
    }

    const deleted = await cleanDirectory(dir)
    return NextResponse.json({ ok: true, deleted })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Не удалось очистить директорию'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
