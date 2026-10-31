import { NextResponse } from 'next/server'
import { getDownloadState } from '@/lib/app-update'

export const dynamic = 'force-dynamic'

/** GET /api/update/progress  (правка 790) — опрашивается раз в секунду во время загрузки. */
export async function GET() {
  return NextResponse.json({ download: getDownloadState() })
}
