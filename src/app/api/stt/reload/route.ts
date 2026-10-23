import { NextResponse } from 'next/server'
import { getAppConfig } from '@/lib/app-config'
import { sttStatus, ensureStt, stopStt, STT_PORT } from '@/lib/stt-runner'

/**
 * (правка 65) POST /api/stt/reload
 * Body: { model?, language?, threads? } — применить новые параметры:
 *  * если сервис уже работает — Python-сервер сам перегружает модель;
 *  * если запущен со старыми параметрами (язык/потоки отличаются) — полный
 *    перезапуск процесса;
 *  * если не запущен — просто старт.
 */
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  try {
    const req = await request.json().catch(() => ({}))
    const cfg = getAppConfig()
    const model: string = typeof req.model === 'string' ? req.model : cfg.sttModel
    const language: string = typeof req.language === 'string' ? req.language : cfg.sttLanguage
    const threads: number = typeof req.threads === 'number' ? req.threads : cfg.sttThreads

    const st = sttStatus()
    if (st.running) {
      // Try in-place reload first (fast path).
      try {
        const r = await fetch(`http://127.0.0.1:${STT_PORT}/reload`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, language, threads }),
          signal: AbortSignal.timeout(150_000),
        })
        const data = await r.json()
        if (r.ok && data.ok) {
          return NextResponse.json({ ok: true, reloaded: true, ...data })
        }
      } catch {
        /* service died — fall through to full restart */
      }
      await stopStt()
    }

    const res = await ensureStt()
    return NextResponse.json(
      res.ok
        ? { ok: true, reloaded: !st.running }
        : { ok: false, error: res.error ?? 'STT-сервер не запустился' },
      { status: res.ok ? 200 : 500 },
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
