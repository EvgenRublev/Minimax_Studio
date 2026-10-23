import { NextResponse } from 'next/server'
import { stopLlm, llmStatus } from '@/lib/llm-runner'

export const dynamic = 'force-dynamic'

/** POST /api/llm/stop — kill the local LLM server (frees RAM/VRAM). */
export async function POST() {
  await stopLlm()
  return NextResponse.json({ ok: true, ...llmStatus() })
}
