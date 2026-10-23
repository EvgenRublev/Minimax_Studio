import { NextRequest, NextResponse } from 'next/server'
import { setUpscaleMetaGenerationTime } from '@/lib/upscale-meta'

/**
 * (правка 264) POST /api/upscale/finalize
 * Body: { path: "<output_path>", generation_time: <seconds>,
 *        feature?: "<feature>", options?: {...} }
 *
 * Дописывает generation_time + DLSS-настройки (feature, options) в сайдкар
 * .meta.json результата апскейла. Идемпотентно — существующие поля не
 * перезаписываются. Время меряется на клиенте (upscale-queue: submit → done).
 */
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as
      | { path?: unknown; generation_time?: unknown; feature?: unknown; options?: unknown }
      | null
    const p = typeof body?.path === 'string' ? body.path : ''
    const gt = typeof body?.generation_time === 'number' ? body.generation_time : NaN
    if (!p || !Number.isFinite(gt) || gt <= 0) {
      return NextResponse.json(
        { error: 'Нужны path и generation_time (> 0)' },
        { status: 400 },
      )
    }
    const feature = typeof body?.feature === 'string' ? body.feature : undefined
    const options =
      body?.options && typeof body.options === 'object' && !Array.isArray(body.options)
        ? (body.options as Record<string, unknown>)
        : undefined
    const ok = setUpscaleMetaGenerationTime(p, gt, feature, options)
    return NextResponse.json({ ok })
  } catch {
    return NextResponse.json({ ok: false, error: 'Не удалось дописать метаданные' }, { status: 500 })
  }
}