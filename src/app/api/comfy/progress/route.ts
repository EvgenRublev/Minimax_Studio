import { NextRequest, NextResponse } from 'next/server'
import { getProgress, getOverallProgress } from '@/lib/comfy/progress-tracker'

/**
 * GET /api/comfy/progress?prompt_id=X
 * Returns the OVERALL progress percentage (0–100) across all sampler passes.
 * The H3 workflow runs 2 passes (low-res then high-res); the flat per-sampler
 * value would bounce 0→100→0→100, so we aggregate to a single 0→100 curve.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const promptId = searchParams.get('prompt_id')
  if (!promptId) {
    // (правка 360) Отсутствие prompt_id — отличимый ответ: error-поле,
    // а не {progress:null}, который клиент принимал за «нет данных».
    return NextResponse.json({ error: 'prompt_id required', progress: null }, { status: 400 })
  }

  const overall = getOverallProgress(promptId) // 0..1 or null
  if (overall === null) {
    return NextResponse.json({ progress: null })
  }

  // Percent across ALL passes (0–100), plus raw per-node data for debugging.
  const entry = getProgress(promptId)
  return NextResponse.json({
    progress: {
      percent: Math.round(overall * 100),
      // Raw per-node map (kept for diagnostics; the UI only uses `percent`).
      nodes: entry ? Object.fromEntries(Object.entries(entry.byNode)) : {},
      done: entry?.done ?? false,
    },
  })
}
