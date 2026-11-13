'use client'

/**
 * Единый FIFO-шлюз для всех задач, которые исполняет ComfyUI.
 *
 * Очередь `useGenQueue` остаётся трекером/UI, а этот модуль гарантирует,
 * что в ComfyUI одновременно находится не больше одной задачи приложения.
 * Задачи получают ход в порядке `createdAt` (то есть в порядке постановки
 * в общую очередь), независимо от режима: Generate/Extend/Refine/
 * ControlNet/FPS/Tile Upscale/Face Refine.
 *
 * DLSS Upscale (type `upscale`) сюда НЕ входит: он выполняется на отдельном
 * мосту, не в ComfyUI, и должен по-прежнему работать параллельно.
 *
 * Ход удерживается до терминального статуса элемента очереди
 * (`done` / `error` / `cancelled`). Это позволяет не трогать поллеры и
 * обработчики завершения каждого режима: шлюз сам отпускает ход, когда
 * элемент очереди завершился.
 */

import {
  useGenQueue,
  type QueueItem,
  type QueueItemType,
} from './gen-queue-store'

/** Режимы, которые исполняет ComfyUI и которые обязаны идти строго по одному. */
export const COMFY_GATED_TYPES: ReadonlySet<QueueItemType> = new Set<QueueItemType>([
  'video',
  'refine',
  'controlnet',
  'fps',
  'tile-upscale',
  'face-refine',
])

type TurnWaiter = {
  id: string
  createdAt: number
  order: number
  resolve: (granted: boolean) => void
}

let holderId: string | null = null
let waiters: TurnWaiter[] = []
let waiterOrder = 0
let unsubscribe: (() => void) | null = null
let pumping = false
let holderTimer: ReturnType<typeof setTimeout> | null = null
let cancelledReleaseTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Элементы очереди, созданные до загрузки этой страницы, пришли из
 * localStorage прошлого запуска. Если такой элемент с prompt_id держит ход,
 * при первой новой задаче быстро сверяем его с ComfyUI: после перезапуска
 * ComfyUI старые prompt_id уже не существуют и не должны блокировать очередь
 * на минуты, пока локальный/глобальный поллер сам дойдёт до ошибки.
 */
const SESSION_STARTED_AT = Date.now()
let verifyingHolderId: string | null = null

/**
 * (правка 950) Сторож хода: раньше это был ЖЁСТКИЙ таймаут 6 часов от выдачи
 * хода — одна залипшая карточка блокировала очередь до перезапуска, а долгая
 * легитимная генерация не отличалась от зависшей. Теперь таймер
 * ПРОГРЕСС-зависимый: любое обновление прогресса/сообщения задачи
 * перезапускает отсчёт. 3 часа без единого шага — задача снимается с
 * очереди (сама генерация в ComfyUI при этом не отменяется).
 *
 * (правка 962) 30 минут → 3 часа: долгие легитимные задачи (4K-рефайн
 * частями, длинные montage/extend) стояли в одной точке дольше порога —
 * сторож снимал ход и в очереди начинали расти ошибки, хотя ComfyUI
 * продолжал считать.
 */
const HOLDER_STALL_MS = 3 * 60 * 60 * 1000

/**
 * Длительность сторожа словами — для сообщений и лога («3 часа», «30 минут»),
 * чтобы текст не расходился с константой при её правке.
 */
export function stallLabel(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000))
  const plural = (n: number, one: string, few: string, many: string) =>
    n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many
  if (min % 60 !== 0) return `${min} ${plural(min, 'минуту', 'минуты', 'минут')}`
  const h = min / 60
  return `${h} ${plural(h, 'час', 'часа', 'часов')}`
}

function itemById(id: string): QueueItem | undefined {
  return useGenQueue.getState().items.find((item) => item.id === id)
}

function isActive(item: QueueItem | undefined): boolean {
  return (
    !!item &&
    (item.status === 'submitting' || item.status === 'queued' || item.status === 'running')
  )
}

function isGated(item: QueueItem | undefined): boolean {
  return !!item && COMFY_GATED_TYPES.has(item.type)
}

function verifyRestoredHolder() {
  if (!holderId || verifyingHolderId === holderId) return
  const item = itemById(holderId)
  if (!item || !item.promptId) return
  // Живые задачи текущей сессии не трогаем — их судьбу решают их поллеры.
  if (item.createdAt >= SESSION_STARTED_AT) return

  const promptId = item.promptId
  const heldId = item.id
  verifyingHolderId = heldId
  void fetch(`/api/comfy/active?check=${encodeURIComponent(promptId)}`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(8000),
  })
    .then((res) => (res.ok ? res.json() : null))
    .then((data: { ok?: boolean; states?: Record<string, 'alive' | 'done' | 'gone'> } | null) => {
      if (!data || data.ok !== true) return
      if (holderId !== heldId) return
      if (data.states?.[promptId] !== 'gone') return
      console.log(`[comfy-turn] старая задача ${promptId} не найдена в ComfyUI — снимаю ход`)
      useGenQueue
        .getState()
        .setStatus(heldId, 'error', 'Задача из прошлого запуска не найдена в ComfyUI — снимаю из очереди.')
    })
    .catch(() => { /* ComfyUI ещё поднимается — оставляем как есть */ })
    .finally(() => {
      if (verifyingHolderId === heldId) verifyingHolderId = null
    })
}

function clearHolderTimer() {
  if (holderTimer) clearTimeout(holderTimer)
  holderTimer = null
  if (cancelledReleaseTimer) clearTimeout(cancelledReleaseTimer)
  cancelledReleaseTimer = null
}

/** (правка 950) Ключ «признаков жизни» держателя: изменился → перезапуск сторожа. */
let lastHolderKey = ''

function holderProgressKey(item: QueueItem | undefined): string {
  if (!item) return ''
  return `${item.progressValue}/${item.progressMax}/${item.startedAt ?? ''}/${item.message ?? ''}`
}

function armHolderTimer() {
  clearHolderTimer()
  holderTimer = setTimeout(() => {
    if (!holderId) return
    const stalled = holderId
    const item = itemById(stalled)
    // Снимаем ход, но НЕ отменяем задачу и не рушим её карточку: ComfyUI мог
    // ещё работать. Следующая задача встанет за ней в очередь ComfyUI.
    console.warn(`[comfy-turn] нет прогресса ${stallLabel(HOLDER_STALL_MS)} — снимаю ход ${stalled}`)
    releaseHolder('stalled')
    if (item) {
      useGenQueue
        .getState()
        .setMessage(
          stalled,
          `Нет прогресса ${stallLabel(HOLDER_STALL_MS)} — задача снята с очереди ` +
          '(в ComfyUI генерация могла ещё идти, подробности — в «Консоли»)',
        )
    }
  }, HOLDER_STALL_MS)
}

/**
 * После перезагрузки страницы ожидающие промисы потеряны, но задача с
 * `promptId` могла остаться живой в ComfyUI. Восстанавливаем для неё ход,
 * чтобы новая генерация не запустилась параллельно.
 */
function ensureHolderFromQueue(): boolean {
  if (holderId) return true

  const activeWithPrompt = useGenQueue
    .getState()
    .items.filter((item) => isGated(item) && !!item.promptId && isActive(item))
    .sort((a, b) => a.createdAt - b.createdAt)

  if (activeWithPrompt.length === 0) return false

  holderId = activeWithPrompt[0].id
  lastHolderKey = holderProgressKey(activeWithPrompt[0])
  armHolderTimer()
  console.log(`[comfy-turn] восстановлен активный ход ${holderId}`)
  return true
}

/**
 * При отмене QueueIndicator сначала ставит `cancelled`, а уже потом шлёт
 * `/api/comfy/cancel`. Не отпускаем ход мгновенно, иначе следующая задача
 * может стартовать, пока ComfyUI ещё дожигает отменяемую. Небольшой грейс
 * закрывает эту гонку, не блокируя очередь при зависшем cancel-запросе.
 */
function scheduleCancelledRelease() {
  if (cancelledReleaseTimer) return
  cancelledReleaseTimer = setTimeout(() => {
    cancelledReleaseTimer = null
    if (!holderId) return
    const item = itemById(holderId)
    if (!item || item.status === 'cancelled') releaseHolder('cancelled')
  }, 1500)
}

function releaseHolder(reason: string) {
  if (!holderId) return
  const released = holderId
  holderId = null
  lastHolderKey = ''
  clearHolderTimer()
  console.log(`[comfy-turn] ход освобождён ${released} (${reason})`)
  pump()
}

function ensureSubscription() {
  if (unsubscribe) return
  unsubscribe = useGenQueue.subscribe((state) => {
    if (holderId) {
      const item = state.items.find((candidate) => candidate.id === holderId)
      if (!item) {
        releaseHolder('removed')
        return
      }
      if (!isActive(item)) {
        if (item.status === 'cancelled') scheduleCancelledRelease()
        else releaseHolder(`status ${item.status}`)
        return
      }
      // (правка 950) прогресс/статус-сообщение обновились — сторож заново.
      // Так долгая, но ЖИВАЯ генерация не снимается с очереди, а зависшая
      // без единого шага за 3 часа (правка 962) — снимается.
      const key = holderProgressKey(item)
      if (key !== lastHolderKey) {
        lastHolderKey = key
        armHolderTimer()
      }
    }
    // Элемент могли отменить/удалить, пока он ждал ход. `pump` вычистит
    // такие ожидания и разрешит их с granted=false.
    pump()
  })
}

function pump() {
  if (pumping || holderId) return
  pumping = true
  try {
    // Задача, пережившая reload, имеет приоритет: она уже в ComfyUI.
    if (ensureHolderFromQueue()) return

    // Выкидываем отменённые/удалённые/уже завершённые ожидания.
    waiters = waiters.filter((waiter) => {
      const item = itemById(waiter.id)
      if (!isGated(item) || !isActive(item)) {
        waiter.resolve(false)
        return false
      }
      return true
    })

    if (waiters.length === 0) return

    waiters.sort((a, b) => a.createdAt - b.createdAt || a.order - b.order)
    const next = waiters.shift()
    if (!next) return

    const item = itemById(next.id)
    if (!item || !isGated(item) || !isActive(item)) {
      next.resolve(false)
      return
    }

    holderId = next.id
    lastHolderKey = holderProgressKey(item)
    armHolderTimer()
    console.log(`[comfy-turn] ход выдан ${next.id} (${item.type})`)

    // В ожидании элемент показывался как «В очереди»; теперь он реально
    // отправляется. setStatus синхронно вызовет подписку — `pumping` не даст
    // рекурсии.
    useGenQueue.getState().setStatus(next.id, 'submitting')
    next.resolve(true)
  } finally {
    pumping = false
  }
}

/**
 * Запросить ход для элемента очереди.
 *
 * Возвращает `false`, если элемент отменили/удалили до получения хода —
 * вызывающий код должен просто выйти, не отправляя запрос в ComfyUI.
 */
export function acquireComfyTurn(id: string): Promise<boolean> {
  ensureSubscription()

  const item = itemById(id)
  if (!item || !isGated(item) || !isActive(item)) return Promise.resolve(false)
  if (holderId === id) return Promise.resolve(true)

  const holderBusy = ensureHolderFromQueue() || holderId !== null
  if (holderBusy) {
    useGenQueue.getState().setStatus(id, 'queued')
    // Если ход держит старая persisted-задача, не ждём её «естественной»
    // ошибки несколько минут — быстро проверяем prompt_id в ComfyUI.
    verifyRestoredHolder()
  }

  return new Promise<boolean>((resolve) => {
    waiters.push({
      id,
      createdAt: item.createdAt,
      order: waiterOrder++,
      resolve,
    })
    pump()
  })
}

/**
 * Досрочно отпустить ход. Обычно не нужен: ход отпускается автоматически по
 * терминальному статусу элемента. Оставлен для аварийных веток.
 */
export function releaseComfyTurn(id: string): void {
  if (holderId === id) releaseHolder('manual')
}

/** Элемент ещё существует и не отменён/не завершён. Проверять после await
 *  acquire: пользователь мог удалить задачу ровно между выдачей хода и
 *  продолжением submit(). */
export function isComfyTurnActive(id: string): boolean {
  const item = itemById(id)
  return !!item && isGated(item) && isActive(item)
}

/** Инициализация на старте приложения: восстановить ход у живой задачи. */
export function initComfyTurn(): void {
  ensureSubscription()
  if (ensureHolderFromQueue()) return
  pump()
}
