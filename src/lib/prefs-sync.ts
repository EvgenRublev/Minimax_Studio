/**
 * (правка 804) Зеркало простых пользовательских предпочтений (не zustand-сторы).
 *
 * Тема, масштаб UI, выделение текста, громкость лайтбокса, флаг «welcome seen»
 * лежат в localStorage отдельными ключами и раньше не пережили ни жёсткое
 * убийство процесса на выходе, ни смену origin (Electron 127.0.0.1 ↔ браузер
 * localhost), ни чистку профиля. Здесь они собираются ОДНИМ снимком
 * (ключ зеркала 'h3-simple-prefs') и дублируются на сервер, как и остальное.
 *
 * Схема: любое изменение prefs вызывает pushPrefs() — он помечает локальную
 * копию свежей и дебаунсом отправляет снимок. На старте pullPrefs() сравнивает
 * метки и, если серверная копия новее, пишет её в localStorage и применяет
 * к DOM (компонент PrefsSync вызывает это вместе с setTheme).
 */
import { pickNewer } from '@/lib/settings-storage'

/** Ключ зеркала; сами prefs — обычные ключи localStorage (см. PREF_KEYS). */
export const PREFS_MIRROR_KEY = 'h3-simple-prefs'

/** Всё, что пользователь может настроить «кликом» вне основных сторов. */
const PREF_KEYS = [
  'theme', // next-themes
  'h3-ui-scale', // масштаб UI (правка 445/451)
  'h3-ui-lang', // язык интерфейса (правка 955)
  'h3-selectable-text', // выделение текста (правка 739)
  'minimax.lightbox.volume', // громкость в лайтбоксе
  'h3_welcome_seen_v1', // окно приветствия показано
] as const

/** Локальная метка времени — та же схема, что у createMirrorStorage. */
const AT_KEY = 'h3-mirror-at:' + PREFS_MIRROR_KEY

const PUSH_DEBOUNCE_MS = 800
const FETCH_TIMEOUT_MS = 1500

type PrefsSnapshot = Record<string, string>

function ls(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

function collectPrefs(): PrefsSnapshot {
  const store = ls()
  const out: PrefsSnapshot = {}
  if (!store) return out
  for (const key of PREF_KEYS) {
    const v = store.getItem(key)
    if (v !== null) out[key] = v
  }
  return out
}

let pushTimer: ReturnType<typeof setTimeout> | null = null

function pushNow(): void {
  if (pushTimer) {
    clearTimeout(pushTimer)
    pushTimer = null
  }
  const store = ls()
  if (!store) return
  const body = JSON.stringify({ key: PREFS_MIRROR_KEY, data: collectPrefs() })
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon('/api/settings', new Blob([body], { type: 'application/json' }))
      return
    }
  } catch { /* fallthrough */ }
  void fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => { /* сервер недоступен — остаётся localStorage */ })
}

/**
 * Вызывается после каждой записи prefs в localStorage (свитчи, темы, громкость).
 * Метка пишется сразу — на случай, если вкладку закроют до отправки.
 */
export function pushPrefs(): void {
  const store = ls()
  if (!store) return
  try {
    store.setItem(AT_KEY, String(Date.now()))
  } catch { /* приватный режим */ }
  if (pushTimer) return
  pushTimer = setTimeout(pushNow, PUSH_DEBOUNCE_MS)
}

/**
 * Немедленно отправляет снимок сервера (без дебаунса). Нужен там, где сервер
 * должен узнать настройку СРАЗУ: язык интерфейса читают API-роуты (i18n/server.ts),
 * и отвечать они должны уже на новом языке.
 */
export function flushPrefs(): void {
  pushNow()
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', pushNow)
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') pushNow()
  })
}

/**
 * Стартовая синхронизация: если серверный снимок новее локального — применяем
 * его (localStorage + DOM + setTheme). Иначе доводим зеркало до актуального.
 * onTheme — setTheme из ThemeProvider (тема через DOM-классы, нужен провайдер).
 * Возвращает true, если были применены серверные значения.
 */
export async function pullPrefs(onTheme: (theme: string) => void): Promise<boolean> {
  const store = ls()
  if (!store) return false
  let server: { key: string; updatedAt: number; data: PrefsSnapshot } | null = null
  try {
    const res = await fetch(`/api/settings?key=${PREFS_MIRROR_KEY}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (res.ok) {
      const json = (await res.json()) as { snapshot?: { updatedAt?: number; data?: unknown } | null }
      const snap = json?.snapshot
      if (snap && typeof snap.updatedAt === 'number' && snap.data && typeof snap.data === 'object') {
        server = { key: PREFS_MIRROR_KEY, updatedAt: snap.updatedAt, data: snap.data as PrefsSnapshot }
      }
    }
  } catch { /* сервер ещё не поднялся — работаем на localStorage */ }

  const localMarkerRaw = store.getItem(AT_KEY)
  const localMarker = localMarkerRaw ? Number.parseInt(localMarkerRaw, 10) : 0
  const hasLocal = Object.keys(collectPrefs()).length > 0
  const localRaw = hasLocal ? store.getItem(PREFS_MIRROR_KEY) ?? '{}' : null
  const choice = pickNewer(localRaw, Number.isFinite(localMarker) ? localMarker : 0, server)

  if (choice === 'server' && server) {
    for (const key of PREF_KEYS) {
      const v = server.data[key]
      try {
        if (typeof v === 'string') store.setItem(key, v)
        else store.removeItem(key)
      } catch { /* приватный режим */ }
    }
    try {
      store.setItem(AT_KEY, String(server.updatedAt))
    } catch { /* приватный режим */ }
    // применяем к DOM то, что обычно делает инлайн-скрипт layout.tsx
    const scale = parseInt(server.data['h3-ui-scale'] ?? '80', 10)
    if (!Number.isNaN(scale)) document.documentElement.style.fontSize = scale === 100 ? '' : `${scale}%`
    if (server.data['h3-selectable-text'] === '1') document.documentElement.setAttribute('data-select-text', '1')
    else document.documentElement.removeAttribute('data-select-text')
    if (typeof server.data['theme'] === 'string') onTheme(server.data['theme'])
    return true
  }
  if (choice === 'none' || !hasLocal) return false
  // локальная новее (или зеркала нет) — обновляем его
  pushNow()
  return false
}
