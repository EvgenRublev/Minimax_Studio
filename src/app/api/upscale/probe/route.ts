import { NextRequest, NextResponse } from 'next/server'
import path from 'path'
import { bridgeUrl, ensureUpscale } from '@/lib/upscale-runner'
import { isPathInsideRoots } from '@/lib/local-file'
import { upscaleAllowedRoots } from '@/lib/upscale-paths'

/**
 * (правка 74) POST /api/upscale/probe
 * Body: {input: "<absolute path>"}
 * Метаданные медиа (разрешение, FPS, длительность, HDR, кодек) для карточки
 * загруженного файла. Запускает bridge при необходимости.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as { input?: string } | null
    const input = body?.input
    if (!input) {
      return NextResponse.json({ error: 'Не указан файл (input)' }, { status: 400 })
    }
    // (правка 716) Путь проверяется по разрешённым корням: иначе /probe
    // раскрывал метаданные (размер, разрешение, кодек, длительность) любого
    // локального файла по произвольному пути.
    if (!isPathInsideRoots(path.resolve(input), upscaleAllowedRoots())) {
      return NextResponse.json(
        { error: 'Путь вне разрешённых папок (выход и/или загрузка)' },
        { status: 400 },
      )
    }

    // (правка 346) Probe — явное действие пользователя (загрузил файл):
    // force, как и render.
    const start = await ensureUpscale({ force: true })
    if (!start.ok) {
      return NextResponse.json({ ok: false, error: start.error ?? 'Upscale-сервис не запустился' }, { status: 500 })
    }
    const r = await fetch(bridgeUrl('/probe'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input }),
      signal: AbortSignal.timeout(30_000),
    })
    const data = (await r.json().catch(() => ({}))) as { error?: string } & Record<string, unknown>
    if (!r.ok) {
      return NextResponse.json({ error: data.error ?? `probe → ${r.status}` }, { status: r.status >= 400 && r.status < 500 ? r.status : 500 })
    }
    return NextResponse.json(data)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
