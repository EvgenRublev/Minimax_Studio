/**
 * (правка 804) Клиентское хранилище настроек с серверным зеркалом.
 *
 * Обычный zustand-persist пишет только в localStorage. Здесь каждая запись
 * идёт в ДВА места: localStorage (быстрый путь, как раньше) и файл на сервере
 * (/api/settings). При старте выбирается более свежая копия. Это закрывает
 * три реальных случая потери настроек (подробности — в settings-mirror.ts):
 *   • приложение жёстко убивает свой процесс на выходе — незаписанный
 *     localStorage теряет последние изменения (например, выключенный Sol-Attn);
 *   • Electron (127.0.0.1) и браузерный фолбэк (localhost) — разные origin,
 *     настройки не пересекаются;
 *   • чистка профиля браузера/Electron.
 *
 * Явный сброс (settings-dialog) удаляет и localStorage, и зеркало — иначе
 * «заводской сброс» на следующем старте был бы отменён восстановлением.
 */
import type { PersistStorage, StorageValue } from 'zustand/middleware'

/** Локальная метка времени последней записи — чтобы сравнить с серверной. */
const AT_PREFIX = 'h3-mirror-at:'

/** Сервер локальный, поэтому ждём недолго: таймаут не должен тормозить старт. */
const FETCH_TIMEOUT_MS = 1500

/** Дебаунс записи зеркала: настройки меняют пачками (слайдеры, тогглы). */
const PUSH_DEBOUNCE_MS = 800

interface ServerSnapshot {
  key: string
  updatedAt: number
  data: unknown
}

/**
 * Какую копию считать актуальной (чистая функция, чтобы можно было проверить).
 *  • локальной нет → сервер;
 *  • сервера нет (первый запуск, зеркало ещё не создано) → локальная;
 *  • сервер новее локальной записи → сервер (пережило жёсткий выход/смену origin);
 *  • иначе → локальная (пользователь изменил настройку в этой сессии).
 */
export function pickNewer(
  localRaw: string | null,
  localAt: number,
  server: ServerSnapshot | null,
): 'local' | 'server' | 'none' {
  if (!localRaw) return server ? 'server' : 'none'
  if (!server) return 'local'
  return server.updatedAt > localAt ? 'server' : 'local'
}

function ls(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null // приватный режим — localStorage бросает исключение
  }
}

function readLocalAt(store: Storage | null, key: string): number {
  if (!store) return 0
  const raw = store.getItem(AT_PREFIX + key)
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN
  return Number.isFinite(n) ? n : 0
}

function writeLocalAt(store: Storage | null, key: string, at: number): void {
  try {
    store?.setItem(AT_PREFIX + key, String(at))
  } catch { /* приватный режим */ }
}

/** Незаписанные на сервер значения; сбрасываются по таймеру и на pagehide. */
const pending = new Map<string, unknown>()
let pushTimer: ReturnType<typeof setTimeout> | null = null

function pushNow(): void {
  if (pending.size === 0) return
  const entries = [...pending.entries()]
  pending.clear()
  for (const [key, data] of entries) {
    const body = JSON.stringify({ key, data })
    try {
      // sendBeacon доставит запись, даже если вкладку/окно закрывают прямо сейчас
      if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
        navigator.sendBeacon('/api/settings', new Blob([body], { type: 'application/json' }))
        continue
      }
    } catch { /* fallthrough */ }
    void fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => { /* сервер недоступен — остаётся localStorage */ })
  }
}

function schedulePush(key: string, data: unknown): void {
  pending.set(key, data)
  if (pushTimer) return
  pushTimer = setTimeout(() => {
    pushTimer = null
    pushNow()
  }, PUSH_DEBOUNCE_MS)
}

if (typeof window !== 'undefined') {
  // Окно закрывают / перезагружают — отдаём накопленные настройки серверу.
  window.addEventListener('pagehide', pushNow)
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') pushNow()
  })
}

/** Получение снимка с сервера; null — если зеркала нет или запрос не удался. */
async function fetchMirror(key: string): Promise<ServerSnapshot | null> {
  try {
    const res = await fetch(`/api/settings?key=${encodeURIComponent(key)}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const json = (await res.json()) as { snapshot?: ServerSnapshot | null }
    const snap = json?.snapshot
    if (!snap || typeof snap.updatedAt !== 'number' || snap.data === undefined) return null
    return snap
  } catch {
    return null
  }
}

/**
 * Хранилище для persist()-сторов настроек. Ключ берётся из имени стора,
 * поэтому зеркало и localStorage называются одинаково.
 */
export function createMirrorStorage<S>(): PersistStorage<S> | undefined {
  const store = ls()
  if (!store) return undefined // SSR / приватный режим — как без persist

  return {
    getItem: async (name) => {
      const localRaw = store.getItem(name)
      const server = await fetchMirror(name)
      const choice = pickNewer(localRaw, readLocalAt(store, name), server)
      if (choice === 'server' && server) {
        const raw = JSON.stringify(server.data)
        try {
          store.setItem(name, raw)
        } catch { /* приватный режим */ }
        writeLocalAt(store, name, server.updatedAt)
        return server.data as StorageValue<S>
      }
      if (!localRaw) return null
      try {
        return JSON.parse(localRaw) as StorageValue<S>
      } catch {
        return null
      }
    },

    setItem: (name, value) => {
      try {
        store.setItem(name, JSON.stringify(value))
        writeLocalAt(store, name, Date.now())
      } catch { /* приватный режим — пытаемся писать только на сервер */ }
      schedulePush(name, value)
    },

    removeItem: (name) => {
      try {
        store.removeItem(name)
        store.removeItem(AT_PREFIX + name)
      } catch { /* приватный режим */ }
      void fetch(`/api/settings?key=${encodeURIComponent(name)}`, { method: 'DELETE' }).catch(() => { /* ignore */ })
    },
  }
}

/**
 * Снимает все незаписанные изменения на сервер (для путей, которые знают,
 * что пользователь вот-вот закроет приложение).
 */
export function flushMirror(): void {
  if (pushTimer) {
    clearTimeout(pushTimer)
    pushTimer = null
  }
  pushNow()
}
