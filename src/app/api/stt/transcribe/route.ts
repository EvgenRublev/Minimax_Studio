import { NextResponse } from 'next/server'
import { ensureStt, STT_PORT } from '@/lib/stt-runner'

/**
 * (правка 65) POST /api/stt/transcribe
 * Body: сырой WAV (16-bit PCM mono, собран в браузере).
 * Автозапускает сервис при необходимости и проксирует на tools/stt_server.py.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(request: Request) {
  let started: { ok: boolean; error?: string }
  try {
    started = await ensureStt()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
  if (!started.ok) {
    return NextResponse.json(
      { ok: false, error: started.error ?? 'STT-сервис не запущен' },
      { status: 503 },
    )
  }

  try {
    // (правка 716) ВЕРХНИЙ лимит тела. Раньше проверялся только минимум
    // (64 байта), а arrayBuffer() буферизовал тело целиком и затем
    // Buffer.from(body) делал ВТОРУЮ копию — многогигабайтное тело
    // (или просто ошибка клиента) съедало память процесса Next.js. Лимит
    // совпадает с MAX_BODY_BYTES в tools/stt_server.py (48 МБ).
    const MAX_UPLOAD_BYTES = 48 * 1024 * 1024
    const declared = Number(request.headers.get('content-length') || 0)
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { ok: false, error: 'Аудиофайл слишком большой (максимум 48 МБ)' },
        { status: 413 },
      )
    }
    const body = await request.arrayBuffer()
    if (!body || body.byteLength < 64) {
      return NextResponse.json(
        { ok: false, error: 'Пустая аудиозапись — ничего не распознано' },
        { status: 400 },
      )
    }
    if (body.byteLength > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { ok: false, error: 'Аудиофайл слишком большой (максимум 48 МБ)' },
        { status: 413 },
      )
    }
    const r = await fetch(`http://127.0.0.1:${STT_PORT}/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from(body),
      // CPU-распознавание: 30 секунд записи на whisper small ≈ до минуты.
      signal: AbortSignal.timeout(180_000),
    })
    const data = await r.json().catch(() => ({ ok: false, error: 'Некорректный ответ STT-сервера' }))
    return NextResponse.json(data, { status: r.status })
  } catch (err) {
    const msg =
      err instanceof Error && err.name === 'TimeoutError'
        ? 'Распознавание заняло слишком долго — попробуйте более короткую фразу'
        : err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
