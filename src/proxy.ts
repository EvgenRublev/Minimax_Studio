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
import { localRequestGuard } from '@/lib/local-request-guard'

/**
 * (правка 1043) Host/origin guard вынесен в localRequestGuard: те же проверки
 * нужны upload-роутам, которые исключены из matcher'а, чтобы Next не
 * буферизовал их тела с лимитом 10 МБ.
 */
export function proxy(request: NextRequest) {
  const blocked = localRequestGuard(request)
  if (blocked) return blocked

  const res = NextResponse.next()
  res.headers.set('X-Frame-Options', 'DENY')
  res.headers.set('Content-Security-Policy', "frame-ancestors 'none'")
  return res
}

export const config = {
  // Всё, кроме статики и тяжёлых upload-роутов. Для upload'ов guard вызывается
  // внутри самих роутов: proxy буферизует тело и обрезает его по 10 МБ (Next 16).
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|api/(?:loras|comfy/upload|comfy/diffusion-models|upscale/upload|montage/video|montage/audio|assistant/attachment|stt/transcribe)).*)',
  ],
}
