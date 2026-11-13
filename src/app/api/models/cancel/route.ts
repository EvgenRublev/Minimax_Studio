import { NextResponse } from 'next/server'
import { cancelDownload } from '@/lib/model-downloader'
import { st } from '@/lib/i18n/server'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {

  try {
    const body = await request.json().catch(() => ({}))
    const modelId: string = body.modelId || ''

    if (!modelId) {
      return NextResponse.json({ error: st("Укажите modelId") }, { status: 400 })
    }

    const result = cancelDownload(modelId)
    if (!result.ok) {
      return NextResponse.json(result, { status: 404 })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
