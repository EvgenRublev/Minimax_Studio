import { NextResponse } from 'next/server'
import { stopStt } from '@/lib/stt-runner'

/**
 * (правка 65) POST /api/stt/stop — остановить STT-сервис (освободить память).
 */
export const dynamic = 'force-dynamic'

export async function POST() {
  try {
    await stopStt()
    return NextResponse.json({ ok: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
