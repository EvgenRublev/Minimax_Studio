import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import { getAppConfig } from '@/lib/app-config'
import { ensureUpscaleMeta } from '@/lib/upscale-meta'

/**
 * GET /api/comfy/meta?path=subfolder/filename.ext
 * Reads the .meta.json sidecar file from the ComfyUI output directory.
 *
 * (правка 94) Ленивый бэкфилл: у апскейл-видео (DLSS5 / RTXVIDEO по имени
 * файла) сайдкаров исторически нет — генерируем его на лету из ffprobe
 * (разрешение/длительность/fps/размер), после чего отдаём как обычный.
 */
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const filePath = searchParams.get('path')
  const OUTPUT_DIR = getAppConfig().outputDir

  if (!filePath) {
    return NextResponse.json({ error: 'path is required' }, { status: 400 })
  }

  // (правка 340) Санитизация по паттерну safeOutputPath (src/lib/thumb.ts):
  // старая схема (стрип leading-слэшей + удаление '../') не резала '..\'
  // (Windows) и сравнивала startsWith БЕЗ path.sep — соседняя папка с общим
  // префиксом проходила за «внутри output».
  const cleaned = filePath.replace(/^[\\/]+/, '')
  const outputRoot = path.resolve(OUTPUT_DIR)
  const metaFile = path.resolve(outputRoot, cleaned + '.meta.json')
  if (metaFile !== outputRoot && !metaFile.startsWith(outputRoot + path.sep)) {
    return NextResponse.json({ error: 'Invalid path' }, { status: 400 })
  }
  const safePath = path.relative(outputRoot, metaFile).slice(0, -'.meta.json'.length)

  try {
    if (!fs.existsSync(metaFile)) {
      // (правка 94) Нет сайдкара, но файл — результат апскейла? Сгенерировать.
      const base = path.basename(safePath)
      const isUpscale = /_(?:DLSS5|RTXVIDEO(?:_PREVIEW)?)_\d{8}-\d{6}/i.test(base)
      if (isUpscale) {
        const ok = await ensureUpscaleMeta(
          path.join(OUTPUT_DIR, path.dirname(safePath), base),
          `backfill_${base}`,
        )
        if (ok && fs.existsSync(metaFile)) {
          return NextResponse.json(JSON.parse(fs.readFileSync(metaFile, 'utf-8')))
        }
      }
      return NextResponse.json({ error: 'Metadata file not found' }, { status: 404 })
    }
    const raw = fs.readFileSync(metaFile, 'utf-8')
    const data = JSON.parse(raw)
    // (правка 377) Наличие латента для бейджа refine-view: путь сохранённого
    // AV-латента в мете + файл на месте (внутри output/). Вычисляемое поле —
    // в сайдкар не пишется.
    const latentFile = typeof (data as { latent_file?: unknown }).latent_file === 'string'
      ? (data as { latent_file: string }).latent_file
      : null
    let latentAvailable = false
    if (latentFile) {
      try {
        const latentPath = path.resolve(outputRoot, latentFile)
        latentAvailable =
          latentPath !== outputRoot && latentPath.startsWith(outputRoot + path.sep)
            ? fs.existsSync(latentPath)
            : false
      } catch { /* вне output/ — считаем отсутствующим */ }
    }
    return NextResponse.json({ ...data, latent_available: latentAvailable })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to read metadata' },
      { status: 500 },
    )
  }
}
