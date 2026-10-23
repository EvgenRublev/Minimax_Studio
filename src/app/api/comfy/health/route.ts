import { NextResponse } from 'next/server'
import { COMFY_URL } from '@/lib/comfy/minimax-h3-client'

/**
 * GET /api/comfy/health
 * Pings ComfyUI /system_stats to check connectivity and return system info.
 */
export async function GET() {
  try {
    // (правка 54) 12 s вместо 5 s: во время активной генерации event-loop
    // ComfyUI заблокирован долгими GPU-операциями (шаги диффузии,
    // выгрузка/загрузка моделей при dynamic VRAM), и /system_stats может
    // отвечать медленно. 5 s давали ложные 502 посреди работающей генерации.
    const res = await fetch(`${COMFY_URL}/system_stats`, {
      signal: AbortSignal.timeout(12_000),
    })
    if (!res.ok) {
      return NextResponse.json({ ok: false, error: `HTTP ${res.status}` }, { status: 502 })
    }
    const data = await res.json()
    return NextResponse.json({ ok: true, ...data })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: msg }, { status: 502 })
  }
}
