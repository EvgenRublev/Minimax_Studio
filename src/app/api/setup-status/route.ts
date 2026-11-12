import { NextResponse } from 'next/server'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

export const dynamic = 'force-dynamic'

/**
 * GET /api/setup-status  (правка 748)
 *
 * Статус установки зависимостей для первого запуска. Пишут:
 *  - install.ps1 — каждый шаг: { state:'running', step, total, title, pid, ts };
 *  - electron/main.js — финальные done/error.
 * Заставка (/splash) опрашивает этот эндпоинт и показывает «шаг N/9»
 * вместо бессрочного «Идёт загрузка ComfyUI…».
 *
 * «running» со устаревшим ts (> 12 мин — установщик упал) наружу не
 * отдаётся: показываем null, приложение поднимет установку заново.
 *
 * (правка 941) install.ps1 держит ts живым сам — heartbeat раз в 10 с, — а
 * кроме шага отдаёт `hint` (что делать пользователю) и `log` (путь к
 * install.log), чтобы заставка и окно установки показывали причину целиком.
 */
const STATUS_FILE = path.resolve(process.cwd(), '.install-cache', 'setup_status.json')
const LIVE_MS = 12 * 60_000

interface SetupStatus {
  state: 'running' | 'done' | 'error'
  step?: number
  total?: number
  title?: string
  hint?: string
  log?: string
  speed?: number
  detail?: string
  pid?: number
  ts?: string
}

export async function GET() {
  try {
    if (!existsSync(STATUS_FILE)) return NextResponse.json({ ok: true, status: null })
    const st = JSON.parse(readFileSync(STATUS_FILE, 'utf8')) as SetupStatus
    const ts = Date.parse(st.ts || '')
    if (st.state === 'running' && (!Number.isFinite(ts) || Date.now() - ts > LIVE_MS)) {
      return NextResponse.json({ ok: true, status: null })
    }
    return NextResponse.json({ ok: true, status: st })
  } catch {
    return NextResponse.json({ ok: true, status: null })
  }
}
