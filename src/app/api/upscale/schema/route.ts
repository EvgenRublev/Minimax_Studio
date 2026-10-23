import { NextResponse } from 'next/server'
import { bridgeUrl } from '@/lib/upscale-runner'

/**
 * (правка 74) GET /api/upscale/schema
 * Прокси каталога функций DLSS-моста (defaults + choices) для нативного UI.
 */
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const r = await fetch(bridgeUrl('/schema'), { signal: AbortSignal.timeout(8000) })
    if (!r.ok) {
      const data = (await r.json().catch(() => ({}))) as { error?: string }
      return NextResponse.json({ error: data.error ?? `bridge /schema → ${r.status}` }, { status: 502 })
    }
    return NextResponse.json(await r.json())
  } catch {
    return NextResponse.json({ error: 'Upscale-сервис не отвечает (мост не запущен)' }, { status: 503 })
  }
}
