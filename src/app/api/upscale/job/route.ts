import { NextRequest, NextResponse } from 'next/server'
import path from 'path'
import { fetchUpscaleHealth, bridgeUrl } from '@/lib/upscale-runner'
import { ensureUpscaleMeta } from '@/lib/upscale-meta'

/**
 * (правка 74) GET /api/upscale/job?id=<jobId>
 * Статус job моста + downloadUrl для результата (если готов).
 *
 * (правка 94) При статусе 'done' пишем .meta.json-сайдкар рядом с
 * результатом (разрешение/длительность/fps/размер — через ffprobe),
 * чтобы в галерее у апскейл-видео тоже работало «инфо о файле».
 * Идемпотентно и fire-and-forget — опрос статуса не ждёт ffprobe.
 */
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const id = new URL(req.url).searchParams.get('id')
  if (!id) {
    return NextResponse.json({ error: 'Не указан id' }, { status: 400 })
  }
  try {
    const r = await fetch(bridgeUrl(`/jobs/${encodeURIComponent(id)}`), {
      signal: AbortSignal.timeout(8000),
    })
    const data = (await r.json().catch(() => ({}))) as {
      status?: string
      progress?: number
      message?: string
      error?: string
      output?: { output_path?: string }
    }
    if (!r.ok) {
      return NextResponse.json({ error: data.error ?? 'Job не найден (возможно, сервис был перезапущен)' }, { status: 404 })
    }
    const outPath = data.output?.output_path
    // (правка 94) Результат готов — обеспечиваем сайдкар метаданных.
    if (data.status === 'done' && outPath) {
      const sourceHint = (data.output as Record<string, unknown>)?.input ?? (data.output as Record<string, unknown>)?.input_path
      void ensureUpscaleMeta(outPath, id, sourceHint).catch(() => {})
    }
    const payload: Record<string, unknown> = {
      id,
      status: data.status,
      progress: data.progress ?? 0,
      message: data.message,
      error: data.error ?? null,
      output: data.output ?? null,
    }
    if (outPath) {
      payload.downloadUrl = `/api/upscale/file?path=${encodeURIComponent(outPath)}`
      payload.downloadName = path.basename(outPath)
    }
    return NextResponse.json(payload)
  } catch {
    // Bridge не отвечает — сервис мог умереть во время рендера.
    let hint = ''
    try {
      const h = await fetchUpscaleHealth(1500)
      if (!h.ready && h.error) hint = ` (${h.error})`
    } catch {
      hint = ' (Upscale-сервис не отвечает)'
    }
    return NextResponse.json({ error: `Не удалось получить статус job${hint}` }, { status: 503 })
  }
}
