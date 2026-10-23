import { NextRequest, NextResponse } from 'next/server'
import { lookupInflight } from '@/lib/inflight-journal'

/**
 * (правка 331) GET /api/comfy/inflight?token=<clientToken>
 * Восстановление prompt_id после перезагрузки страницы во время POST
 * /api/comfy/generate: фронт прислал clientToken в теле POST, сервер
 * записал соответствие при постановке в ComfyUI. 404 — задача ещё не
 * поставлена (POST всё ещё в обработке) или токен неизвестен.
 */
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const token = searchParams.get('token')
  if (!token || token.length > 100) {
    return NextResponse.json({ error: 'token required' }, { status: 400 })
  }
  const promptId = lookupInflight(token)
  if (!promptId) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  return NextResponse.json({ prompt_id: promptId })
}
