import { NextResponse } from 'next/server'
import { readMirror, readAllMirrors, writeMirror, deleteMirror, clearAllMirrors } from '@/lib/settings-mirror'

export const dynamic = 'force-dynamic'

/**
 * (правка 804) /api/settings — серверное зеркало пользовательских настроек.
 *
 *   GET    /api/settings               → { snapshots: { key: {...} } } (все)
 *   GET    /api/settings?key=h3-gen-store → { snapshot: {...} | null }
 *   POST   { key, data }               → { ok, updatedAt }
 *   DELETE /api/settings?key=...       → { ok, removed }
 *   DELETE /api/settings?all=1         → { ok, removed }  (заводской сброс)
 *
 * Зеркало нужно, чтобы настройки пережили: жёсткое убийство процесса при
 * выходе (незаписанный localStorage), смену origin (Electron 127.0.0.1 ↔
 * браузер localhost), чистку профиля. Удаляется только явным сбросом.
 */

/** Ключ в валидном формате (тот же фильтр, что в settings-mirror). */
function validKey(key: unknown): key is string {
  return typeof key === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(key)
}

export async function GET(req: Request) {
  const url = new URL(req.url)
  const single = url.searchParams.get('key')
  if (single !== null) {
    if (!validKey(single)) {
      return NextResponse.json({ ok: false, error: 'Некорректный ключ настроек' }, { status: 400 })
    }
    return NextResponse.json({ ok: true, snapshot: readMirror(single) })
  }
  return NextResponse.json({ ok: true, snapshots: readAllMirrors() })
}

export async function POST(req: Request) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Ожидался JSON' }, { status: 400 })
  }
  const { key, data } = (body ?? {}) as { key?: unknown; data?: unknown }
  if (!validKey(key)) {
    return NextResponse.json({ ok: false, error: 'Некорректный ключ настроек' }, { status: 400 })
  }
  if (data === undefined || data === null) {
    return NextResponse.json({ ok: false, error: 'Нет данных настроек' }, { status: 400 })
  }
  const written = writeMirror(key, data)
  if (!written) {
    return NextResponse.json({ ok: false, error: 'Настройки слишком большие для зеркала' }, { status: 413 })
  }
  return NextResponse.json({ ok: true, updatedAt: written.updatedAt })
}

export async function DELETE(req: Request) {
  const url = new URL(req.url)
  if (url.searchParams.get('all') === '1') {
    return NextResponse.json({ ok: true, removed: clearAllMirrors() })
  }
  const key = url.searchParams.get('key')
  if (!validKey(key)) {
    return NextResponse.json({ ok: false, error: 'Некорректный ключ настроек' }, { status: 400 })
  }
  return NextResponse.json({ ok: true, removed: deleteMirror(key) ? 1 : 0 })
}
