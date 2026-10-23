import { NextRequest, NextResponse } from 'next/server'
import { getPreview, getStageInfo } from '@/lib/comfy/progress-tracker'

const NO_STORE = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-cache, no-store, must-revalidate',
  Pragma: 'no-cache',
  Expires: '0',
} as const

/**
 * GET /api/comfy/preview?prompt_id=X
 * Returns the latest preview image (base64) from ComfyUI denoising,
 * plus STAGE info (which of the 2 passes is running and its step/total)
 * for the preview overlay label.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const promptId = searchParams.get('prompt_id')
  if (!promptId) {
    return NextResponse.json({ preview: null }, { status: 400 })
  }

  const preview = getPreview(promptId)
  const stage = getStageInfo(promptId)

  if (!preview) {
    return new NextResponse(JSON.stringify({ preview: null, stage }), {
      status: 200,
      headers: NO_STORE,
    })
  }

  // (правка 204) Превью показывается на ОБОИХ проходах без цензуры —
  // пользователь сам оценивает процесс. Скрываем только «нулевой» кадр
  // (boundary-0): это затравка из чистого шума до начала денойза, картинки
  // там ещё нет. Стандартные preview-события (latent_preview в
  // MMH3UltimateUpscale) приходят с step=0 но реальной картинкой — их
  // показываем. KJ-превью с step=0 — нулевой кадр, скрываем.
  const hasImage = preview.image && preview.image.length > 0
  if (!hasImage || ((preview.step || 0) === 0 && preview.total > 0)) {
    return new NextResponse(JSON.stringify({ preview: null, stage }), {
      status: 200,
      headers: NO_STORE,
    })
  }

  return new NextResponse(JSON.stringify({
    preview: {
      image: `data:${preview.mime};base64,${preview.image}`,
      mime: preview.mime,
      width: preview.width,
      height: preview.height,
      step: preview.step,
      total: preview.total,
      timestamp: preview.timestamp,
    },
    stage,
  }), {
    status: 200,
    headers: NO_STORE,
  })
}
