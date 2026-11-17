/**
 * (правка 1043) Локальный сетевой guard для роутов с большими телами.
 *
 * Next 16 при наличии proxy.ts буферизует тело запроса в памяти с лимитом
 * `experimental.proxyClientMaxBodySize` (по умолчанию 10 МБ). Для загрузки
 * LoRA/моделей/видео это режет файл: клиент видит 100 %, а на диск попадают
 * только первые 10 МБ (реальная ошибка 7.1.31: «вес LoRA 60–1500 МБ, в
 * списке 10 МБ, safetensors corrupt»).
 *
 * Поэтому большие upload-роуты исключены из proxy matcher'а и получают
 * origin/host-проверку здесь — без буферизации тела.
 */
import { NextResponse } from 'next/server'

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

function isLocalHostname(name: string): boolean {
  const n = name.toLowerCase()
  if (n === 'localhost' || n === '127.0.0.1' || n === '[::1]') return true
  if (n.startsWith('[') && n.endsWith(']')) return true
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(n)) return true
  return false
}

/**
 * Возвращает готовый 403-ответ, если запрос пришёл не с localhost/same-origin.
 * Для не-браузерных клиентов без Origin/Sec-Fetch-Site защита не мешает.
 */
export function localRequestGuard(request: Request): NextResponse | null {
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
  return null
}
