import { NextResponse } from 'next/server'
import { stopUpscale } from '@/lib/upscale-runner'

/**
 * (правка 74) POST /api/upscale/stop — остановить сервис Upscale
 * (python + Node SSR-прокси, всё дерево процессов).
 */
export const dynamic = 'force-dynamic'

export async function POST() {
  try {
    await stopUpscale()
    return NextResponse.json({ ok: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
