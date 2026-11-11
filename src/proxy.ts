/*
 * (правка 926) Единый сетевой guard приложения. Next 16: вместо middleware.ts
 * используется proxy.ts (функционально тот же).
 *
 * Приложение — локальное, авторизации нет; раньше сервер был «слеп» к источнику
 * запроса: любая веб-страница могла послать POST на http://127.0.0.1:3000/api/...
 * (simple-request CSRF: preflight нет, а все роуты парсят тело независимо от
 * content-type) — вплоть до /api/reset/full (удаление данных) и /api/config.
 * Плюс DNS-rebinding: страница с домена, который резолвится на 127.0.0.1, получает
 * полноценный доступ — у него Origin и Host «совпадают», и одна origin-проверка
 * это не ловит. Поэтому три правила:
 *
 *  1. Host обязан быть loopback-именем или IP-литералом — блокирует rebinding
 *     (браузер не делает DNS для IP-литералов). LAN-режим (BIND_HOST) ходит по
 *     IP — разрешён; доступ по имени машины — нет (осознанно: иначе rebinding).
 *  2. Методы, меняющие состояние (POST/PUT/PATCH/DELETE): если Origin есть — он
 *     обязан совпасть с Host (same-origin как у штатного UI). Если Origin нет
 *     (curl/локальные тулзы), но есть Sec-Fetch-Site от браузера — только
 *     same-origin/same-site. Без обоих заголовков — не браузер, пропускаем.
 *  3. Страницы нельзя встроить в iframe (clickjacking на «Сброс»/«Удалить»).
 *
 * GET/HEAD остаются без origin-правила (чтение same-origin ограничено CORS,
 * а заголовки ACAO:* сняты — см. правку 926).
 */
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** Loopback-имя или IP-литерал (IPv4/IPv6)? Домены — нет (rebinding). */
function isLocalHostname(name: string): boolean {
  const n = name.toLowerCase()
  if (n === 'localhost' || n === '127.0.0.1' || n === '[::1]') return true
  if (n.startsWith('[') && n.endsWith(']')) return true // IPv6-литерал
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(n)) return true // IPv4-литерал
  return false
}

export function proxy(request: NextRequest) {
  const host = (request.headers.get('host') || '').toLowerCase()
  const m = /^(\[[^\]]+\]|[^:]+?)(?::\d+)?$/.exec(host)
  const hostname = m ? m[1] : host
  if (!isLocalHostname(hostname)) {
    return NextResponse.json({ error: 'Forbidden host' }, { status: 403 })
  }

  if (MUTATING.has(request.method)) {
    const origin = request.headers.get('origin')
    if (origin) {
      let originHost = ''
      try {
        originHost = new URL(origin).host.toLowerCase()
      } catch {
        originHost = ''
      }
      if (!originHost || originHost !== host) {
        return NextResponse.json({ error: 'Forbidden origin' }, { status: 403 })
      }
    } else {
      const site = (request.headers.get('sec-fetch-site') || '').toLowerCase()
      if (site && site !== 'same-origin' && site !== 'same-site') {
        return NextResponse.json({ error: 'Forbidden cross-site request' }, { status: 403 })
      }
    }
  }

  const res = NextResponse.next()
  res.headers.set('X-Frame-Options', 'DENY')
  res.headers.set('Content-Security-Policy', "frame-ancestors 'none'")
  return res
}

export const config = {
  // Всё, кроме статики: страницы + /api/* (в т.ч. проверка Host для GET).
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
