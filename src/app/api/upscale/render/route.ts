import { NextRequest, NextResponse } from 'next/server'
import path from 'path'
import { ensureUpscale, fetchUpscaleHealth, bridgeUrl } from '@/lib/upscale-runner'
import { isPathInsideRoots } from '@/lib/local-file'
import { upscaleAllowedRoots } from '@/lib/upscale-paths'

/**
 * (правка 74) POST /api/upscale/render
 * Body: {feature: "nr-image"|"nr-video"|"vsr-image"|"vsr-video",
 *        input: "<absolute path>", options: {...}}
 * Запускает bridge (при необходимости), ждёт готовности рантайма
 * (подготовка GPU/DLL — до ~2 минут) и создаёт job.
 * 409 — GPU занята другим рендером.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as {
      feature?: string
      input?: string
      options?: Record<string, unknown>
    } | null
    const feature = body?.feature
    const input = body?.input
    const options = body?.options ?? {}
    if (!feature || !input) {
      return NextResponse.json({ error: 'Нужны feature и input' }, { status: 400 })
    }
    // (правка 716) feature проверяется по allow-list, input — по разрешённым
    // корням. Раньше произвольный абсолютный путь уходил в Python-мост, и
    // тот открывал/обрабатывал ЛЮБОЙ файл на диске (в отличие от
    // /api/upscale/file, который корни проверял).
    const ALLOWED_FEATURES = new Set(['nr-image', 'nr-video', 'vsr-image', 'vsr-video', 'fi-video'])
    if (!ALLOWED_FEATURES.has(feature)) {
      return NextResponse.json(
        { error: `Неизвестная функция: ${feature}. Доступно: ${[...ALLOWED_FEATURES].join(', ')}` },
        { status: 400 },
      )
    }
    if (!isPathInsideRoots(path.resolve(input), upscaleAllowedRoots())) {
      return NextResponse.json(
        { error: 'Путь вне разрешённых папок (выход и/или загрузка)' },
        { status: 400 },
      )
    }

    // 1) Сервис запущен?
    // (правка 346) Рендер — явное действие пользователя: force, иначе после
    // ручной остановки сервиса кнопка «Апскейл» молча отваливалась ошибкой
    // «остановлен пользователем».
    const start = await ensureUpscale({ force: true })
    if (!start.ok) {
      return NextResponse.json({ ok: false, error: start.error ?? 'Upscale-сервис не запустился' }, { status: 500 })
    }

    // 2) Рантайм готов (prepare_runtime + GPU)?
    const deadline = Date.now() + 120_000
    let health: Awaited<ReturnType<typeof fetchUpscaleHealth>> | null = null
    while (Date.now() < deadline) {
      try {
        health = await fetchUpscaleHealth(3000)
        if (health.ready) break
        if (health.error) break // перманентная ошибка (нет RTX-GPU и т.п.)
      } catch {
        /* bridge ещё поднимается — крутим дальше */
      }
      await new Promise((r) => setTimeout(r, 1000))
    }
    if (!health?.ready) {
      const err = health?.error || 'Рантайм DLSS не готов. Нужен NVIDIA RTX (20/30/40/50) с актуальным драйвером.'
      return NextResponse.json({ ok: false, error: err }, { status: 500 })
    }

    // 3) Создаём job.
    const r = await fetch(bridgeUrl('/render'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feature, input, options }),
      signal: AbortSignal.timeout(20_000),
    })
    const data = (await r.json().catch(() => ({}))) as { jobId?: string; error?: string }
    if (r.status === 409) {
      return NextResponse.json({ ok: false, busy: true, error: data.error ?? 'GPU занята' }, { status: 409 })
    }
    if (!r.ok) {
      return NextResponse.json({ ok: false, error: data.error ?? `bridge /render → ${r.status}` }, { status: 500 })
    }
    return NextResponse.json({ ok: true, jobId: data.jobId })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
