import { NextResponse } from 'next/server'
import { startDownload } from '@/lib/model-downloader'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const body = await req.json().catch(() => null)
  const modelId = body?.modelId as string | undefined

  if (!modelId) {
    return NextResponse.json({ ok: false, error: 'modelId is required' }, { status: 400 })
  }

  const result = await startDownload(modelId)
  return NextResponse.json(result)
}
