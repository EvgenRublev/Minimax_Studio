import { NextResponse } from 'next/server'
import { getAllModelsStatus } from '@/lib/model-downloader'

export const dynamic = 'force-dynamic'

export async function GET() {
  const models = getAllModelsStatus()
  return NextResponse.json({ models })
}
