import { NextRequest, NextResponse } from 'next/server'
import { cancelPrompt } from '@/lib/comfy/minimax-h3-client'

/**
 * POST /api/comfy/cancel
 * Body: { prompt_id: string }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const promptId = body.prompt_id as string
    if (!promptId) {
      return NextResponse.json({ error: 'prompt_id required' }, { status: 400 })
    }
    await cancelPrompt(promptId)
    return NextResponse.json({ ok: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // (правка 356) ok:false явно — при недоступном /queue клиент не должен
    // считать отмену успешной.
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
