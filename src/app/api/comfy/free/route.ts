import { NextResponse } from 'next/server'
import { st } from '@/lib/i18n/server'

const COMFY_URL = (process.env.COMFY_URL || 'http://127.0.0.1:8188').replace(/\/+$/, '')

/**
 * POST /api/comfy/free
 * Frees ComfyUI VRAM cache (unloads models from GPU).
 * This version of ComfyUI expects: { unload_models: true, free_memory: true }
 */
export async function POST() {

  try {
    const res = await fetch(`${COMFY_URL}/free`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return NextResponse.json({ error: `ComfyUI /free failed (${res.status}): ${text.slice(0, 200)}` }, { status: 502 })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: st("Не удалось связаться с ComfyUI: {{p1}}", { p1: msg }) }, { status: 502 })
  }
}