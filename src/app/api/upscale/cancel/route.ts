import { NextRequest, NextResponse } from 'next/server'
import { bridgeUrl } from '@/lib/upscale-runner'

/**
 * (правка 74) POST /api/upscale/cancel?id=<jobId>
 * Отмена активного рендера (мост шлёт запрос в JobController пайплайна).
 */
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const id = new URL(req.url).searchParams.get('id')
  if (!id) {
    return NextResponse.json({ error: 'Не указан id' }, { status: 400 })
  }
  try {
    const r = await fetch(bridgeUrl(`/jobs/${encodeURIComponent(id)}/cancel`), {
      method: 'POST',
      signal: AbortSignal.timeout(8000),
    })
    const data = (await r.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string }
    if (!r.ok) {
      return NextResponse.json({ error: data.error ?? 'Не удалось отправить отмену' }, { status: 500 })
    }
    return NextResponse.json({ ok: true, message: data.message ?? 'Отмена отправлена' })
  } catch {
    return NextResponse.json({ error: 'Upscale-сервис не отвечает' }, { status: 503 })
  }
}
