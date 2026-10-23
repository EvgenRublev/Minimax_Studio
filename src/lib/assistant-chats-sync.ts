/**
 * assistant-chats-sync — синхронизация чатов ассистента с файлом проекта.
 *
 * Источники (приоритет):
 *   1. Сервер (data/assistant-chats.json) — переносимое хранилище
 *   2. localStorage браузера — кэш / фолбэк если сервер недоступен
 *
 * При каждом изменении стора — debounce-запись на сервер.
 * При старте — загрузка с сервера, если есть данные — перезапись стора.
 */
import { useAssistantChats, type AssistantChat } from './assistant-chats-store'

let initialized = false
let saveTimer: ReturnType<typeof setTimeout> | null = null
let prevChats: AssistantChat[] = []
/** (правка 108) true, пока PUT синхронизации в полёте — flush не дублирует его. */
let saving = false
/** Flush пришёл, пока PUT был в полёте — перезапустить сохранение по завершении. */
let pendingFlush = false
/** true после первой загрузки с сервера или первого изменения стора:
 *  только тогда допустимо слать ПУСТОЙ список (иначе закрытие вкладки до
 *  завершения loadFromServer затирало бы серверные чаты пустым массивом). */
let storeTouched = false
const SAVE_DEBOUNCE_MS = 1500

/** (правка 108) Захватить состояние чатов для передачи в тело запроса.
 *  Пустой список — ВАЛИДНОЕ состояние (пользователь удалил все чаты):
 *  возвращаем его как есть, иначе flush при закрытии вкладки ничего не
 *  слал и удалённые чаты «воскресали» из файла на сервере при следующем
 *  запуске. null — только если стор ещё не загружен/недоступен. */
function capturePayload(): string | null {
  try {
    const { chats, activeChatId } = useAssistantChats.getState()
    if (!Array.isArray(chats)) return null
    if (chats.length === 0 && !storeTouched) return null
    return JSON.stringify({ chats, activeChatId })
  } catch {
    return null
  }
}

/** (правка 337) Единая точка beacon-отправки: проверяем возврат sendBeacon.
 *  false (очередь браузера переполнена / API отклонил) — данные остаются в
 *  localStorage-кэше стора, а флаг ретрая гарантирует повторный PUT при
 *  следующем визите (см. initAssistantChatsSync). */
function tryBeacon(payload: string): boolean {
  try {
    if (navigator.sendBeacon) {
      return navigator.sendBeacon('/api/assistant/chats', new Blob([payload], { type: 'application/json' }))
    }
  } catch { /* beacon недоступен */ }
  return false
}

function markRetryNeeded() {
  try { localStorage.setItem('assistantChatsSyncRetry', '1') } catch { /* приватный режим */ }
}

function takeRetryNeeded(): boolean {
  try {
    if (localStorage.getItem('assistantChatsSyncRetry') === '1') {
      localStorage.removeItem('assistantChatsSyncRetry')
      return true
    }
  } catch { /* приватный режим */ }
  return false
}

/** (правка 108, 337) Синхронный flush: завершает незапущенный debounce-tick и,
 *  если PUT ещё не в полёте, отправляет его с keepalive — доживёт до
 *  доставки даже при закрытии вкладки. sendBeacon — фолбэк, если fetch
 *  недоступен/отклонён (некоторые браузеры не умеют beacon с JSON-телом).
 *  (правка 337) keepalive-PUT идёт через общий мьютекс saveToServer —
 *  два параллельных PUT с разными снапшотами исключены, старый снапшот
 *  не может приземлиться поверх свежего. */
function flushSave() {
  if (typeof window === 'undefined') return
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  if (saving) {
    // PUT уже в полёте — не дублируем, но помечаем: изменения, сделанные
    // ПОСЛЕ захвата его тела, надо сохранить ещё раз по завершении,
    // иначе они молча теряются (debounce-таймер уже очищен).
    // Повтор тоже уйдёт с keepalive (см. saveToServer finally).
    pendingFlush = true
    return
  }
  const payload = capturePayload()
  if (!payload) return
  // (правка 109) keepalive-fetch ограничен ~64 КБ тела: при превышении fetch
  // отклоняется АСИНХРОННО, а done уже выставлен в true синхронно — beacon-
  // фолбэк не срабатывал и большие чаты терялись при закрытии вкладки.
  // PUT /api/assistant/chats принимает только полный снапшот, поэтому для
  // больших тел сразу sendBeacon с полным payload (keepalive-ветку пропускаем).
  // (правка 587) Лимит — ~64КБ БАЙТ, а payload.length считает UTF-16 юниты:
  // кириллица (~2 байта/символ) проходила проверку, но роняла оба транспорта.
  if (new Blob([payload]).size > 60_000) {
    if (!tryBeacon(payload)) markRetryNeeded()
    return
  }
  void saveToServer(payload, true)
}

/**
 * Инициализирует синхронизацию. Вызывается один раз при маунте приложения.
 * 1. Загружает чаты с сервера (если есть) → в стор.
 * 2. Подписывается на изменения стора → debounce-save на сервер.
 */
export function initAssistantChatsSync() {
  if (initialized) return
  initialized = true

  // 1. Load from server
  // (правка 337) Если прошлый beacon-PUT не ушёл (sendBeacon вернул false),
  // после загрузки/мержа повторяем сохранение локальной копии.
  void loadFromServer().finally(() => {
    if (takeRetryNeeded()) void saveToServer()
  })

  // 2. Subscribe to changes → debounced save
  prevChats = useAssistantChats.getState().chats

  useAssistantChats.subscribe((state) => {
    // Only save if chats actually changed (not just activeChatId)
    if (state.chats === prevChats) return
    prevChats = state.chats
    storeTouched = true

    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      void saveToServer()
    }, SAVE_DEBOUNCE_MS)
  })

  // (правка 108) Стабильность синхронизации: при закрытии/скрытии вкладки
  // незапущенный debounce-тикс (1.5 с) раньше терялся — чат пропадал с диска.
  // Теперь flush с keepalive (живёт до доставки) + sendBeacon-фолбэк.
  window.addEventListener('pagehide', flushSave)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSave()
  })
}

/**
 * (правка 74) Перезагрузить чаты из файла проекта (data/assistant-chats.json).
 * Вызывается после переноса чатов из старой версии программы.
 */
export async function reloadAssistantChats(): Promise<void> {
  await loadFromServer()
}

async function loadFromServer() {
  try {
    const res = await fetch('/api/assistant/chats')
    if (!res.ok) return
    const data = await res.json()
    if (!data.found || !Array.isArray(data.chats) || data.chats.length === 0) {
      // Server has no data — keep whatever is in localStorage
      return
    }
    // Merge: per-chat by updatedAt. Раньше серверная копия затирала локальную
    // ВСЕГДА — если прошлый PUT потерялся (крах до debounce/flush), сообщения
    // из потерянного окна исчезали при следующем запуске. Теперь побеждает
    // более свежая копия; чаты только-локальные и только-серверные входят как есть.
    const store = useAssistantChats.getState()
    storeTouched = true
    const localById = new Map(store.chats.map((c) => [c.id, c]))
    const merged = data.chats.map((c: AssistantChat) => {
      const local = localById.get(c.id)
      if (!local) return c
      // нет updatedAt (старые записи) — считаем серверную копию актуальной
      if (typeof local.updatedAt !== 'number' || typeof c.updatedAt !== 'number') return c
      return local.updatedAt > c.updatedAt ? local : c
    })
    const serverIds = new Set(merged.map((c: AssistantChat) => c.id))
    const localOnly = store.chats.filter((c) => !serverIds.has(c.id))
    merged.push(...localOnly)
    // (правка 427) Старые серверные чаты без mode — это чаты «Генерации»
    // (extend-режима не существовало); нормализуем, как merge-гард стора.
    // (правка 502) Whitelist из трёх режимов (добавлен 'controlnet').
    const normalized = merged.map((c: AssistantChat) => ({
      ...c,
      mode: (c.mode === 'extend' || c.mode === 'controlnet' ? c.mode : 'generate') as AssistantChat['mode'],
    }))
    const activeChatId =
      typeof data.activeChatId === 'string' && normalized.some((c) => c.id === data.activeChatId)
        ? data.activeChatId
        : (normalized[0]?.id ?? null)

    // Update store without triggering save loop
    useAssistantChats.setState({ chats: normalized, activeChatId })
    prevChats = normalized

    // Immediately persist to server (in case localStorage had more)
    void saveToServer()
  } catch {
    // Server unavailable — silently fall back to localStorage
  }
}

async function saveToServer(payload?: string, keepalive = false) {
  // (правка 108, 337) saving=true — единый мьютекс для ВСЕХ PUT (debounce-
  // сохранение и keepalive-flush): параллельных PUT не бывает, и более
  // ранний снапшот не приземлится после более позднего.
  if (saving) {
    pendingFlush = true
    return
  }
  saving = true
  let body = payload ?? ''
  try {
    if (!body) {
      const { chats, activeChatId } = useAssistantChats.getState()
      body = JSON.stringify({ chats, activeChatId })
    }
    const res = await fetch('/api/assistant/chats', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive,
    })
    if (!res.ok) {
      // Non-critical: log but don't crash
      console.warn('[assistant-chats-sync] save failed:', res.status)
    }
  } catch (err) {
    // Server unavailable — data stays in localStorage cache
    console.warn('[assistant-chats-sync] save error:', err)
    // (правка 337) keepalive-fetch отклонён (закрытие вкладки) — beacon-фолбэк.
    if (keepalive && typeof window !== 'undefined') {
      if (!tryBeacon(body)) markRetryNeeded()
    }
  } finally {
    saving = false
    if (pendingFlush) {
      pendingFlush = false
      // (правка 337) Повтор по pendingFlush — тоже с keepalive: flush чаще
      // всего приходит на pagehide, обычный fetch при закрытии вкладки умрёт.
      void saveToServer(undefined, true)
    }
  }
}
