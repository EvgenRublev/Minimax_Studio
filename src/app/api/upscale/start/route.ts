import { NextResponse } from 'next/server'
import { ensureUpscale } from '@/lib/upscale-runner'

/**
 * (правка 74) POST /api/upscale/start
 * Запустить встроенный DLSS 5 Visual Enhancer (upscale/bridge.py) и дождаться,
 * пока он ответит на порту. Может занять до ~3 минут при первом старте.
 *
 * (правка 77) `?auto=1` — автозапуск из фоновой проверки состояния (не
 * нажатие кнопки). В этом случае уважаем явную остановку пользователем
 * (manualStop); явный «Запустить» (без параметра) — force=true.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 240

export async function POST(req: Request) {
  try {
    let auto = false
    try {
      auto = new URL(req.url).searchParams.get('auto') === '1'
    } catch {
      /* редирект/странный url — считаем явным стартом */
    }
    const res = await ensureUpscale({ force: !auto })
    return NextResponse.json(
      res.ok ? { ok: true } : { ok: false, error: res.error ?? 'Upscale-сервис не запустился' },
      { status: res.ok ? 200 : 500 },
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
