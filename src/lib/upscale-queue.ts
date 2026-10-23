/**
 * Очередь Upscale — (правка 262).
 *
 * Сервер DLSS-моста поддерживает только ОДИН активный рендер (409 busy).
 * Раньше кнопка «Запустить» блокировалась, пока идёт задача — вторую
 * поставить было нельзя. Теперь upscale-задачи ставятся в очередь:
 * раннер сериализует их и подаёт в useUpscaleService.run() по одной,
 * как только GPU освобождается.
 *
 * Интеграция с общей очередью (useGenQueue, type 'upscale') — статус
 * виден в плавающем QueueIndicator и карточке статуса на вкладке.
 */
import { useGenQueue, type QueueItem } from './gen-queue-store'
import { useUpscaleService, isUpscaleJobActive } from './upscale-service'
import { toast } from 'sonner'
import { useGalleryRefresh } from './gallery-refresh-store'

export interface UpscaleTask {
  feature: string
  input: string
  options: Record<string, unknown>
  /** (правка 264) Источник файла: имя из галереи/загрузки — попадает в сайдкар. */
  sourceName?: string
  /** (правка 727) Папка исходника в галерее — туда переносится результат. */
  subfolder?: string
}

/** Задачи, ожидающие своей очереди (module-level — переживает вкладки). */
const tasks = new Map<string, UpscaleTask>()
let running = false
/**
 * (правка 716) id элемента очереди, который раннер обрабатывает ПРЯМО СЕЙЧАС.
 * Нужен sweep'у, чтобы отличить живую задачу от сироты после перезагрузки
 * страницы: элемент в очереди (tasks) и элемент «в работе» (activeItemId)
 * — живые; всё остальное — сирота.
 */
let activeItemId: string | null = null

/** Поставить upscale в общую очередь. Возвращает id элемента очереди. */
export function enqueueUpscale(task: UpscaleTask): string {
  const label = `Upscale: ${task.input.split('/').pop() || task.feature}`
  const id = useGenQueue.getState().enqueue('upscale', label)
  tasks.set(id, task)
  kick()
  return id
}

/** Активные upscale-элементы очереди. */
export function activeUpscaleItems(items: QueueItem[]): QueueItem[] {
  return items.filter(
    (i) => i.type === 'upscale' && (i.status === 'submitting' || i.status === 'queued' || i.status === 'running'),
  )
}

/** Отменить все активные upscale. */
export async function cancelActiveUpscales(): Promise<void> {
  const { setStatus } = useGenQueue.getState()
  for (const item of activeUpscaleItems(useGenQueue.getState().items)) {
    setStatus(item.id, 'cancelled')
    // (правка 334) Ожидающая своей очереди задача — из Map тоже: иначе
    // запись-сирота оставалась навсегда (раннер её не возьмёт — элемент
    // уже cancelled, а Map чистится только при взятии задачи).
    tasks.delete(item.id)
    // Если задача ещё не запущена (нет активного job) — просто отменяем.
    // Если job активен — cancel через сервис.
    const job = useUpscaleService.getState().job
    if (job && isUpscaleJobActive(job)) {
      await useUpscaleService.getState().cancel()
    }
  }
}

/**
 * (правка 329) Отмена ОДНОГО upscale из QueueIndicator.
 * Раньше cancelQueueItem для upscale шёл по ветке !promptId (upscale-очередь
 * promptId никогда не ставит) → просто remove(item.id), а серверный DLSS-
 * рендер продолжал работать зомби. Теперь: статус cancelled + задача из Map
 * + реальная отмена активного рендера на мосту (тот же cancel, что у кнопки
 * вкладки Upscale). Сервер держит ОДИН активный рендер, а раннер
 * сериализует задачи — активный job соответствует running-элементу; если
 * отменяют queued-элемент, а рендер другой задачи ещё идёт, cancel на мосту
 * не шлём.
 */
export async function cancelUpscaleItem(id: string): Promise<void> {
  const { setStatus } = useGenQueue.getState()
  const item = useGenQueue.getState().items.find((i) => i.id === id)
  tasks.delete(id) // (правка 334) чистим ожидающую задачу
  setStatus(id, 'cancelled')
  if (item?.status === 'running') {
    const job = useUpscaleService.getState().job
    if (job && isUpscaleJobActive(job)) {
      await useUpscaleService.getState().cancel()
    }
  }
}

/** Чистка orphan-задач после перезагрузки страницы. */
export function sweepOrphanUpscaleItems(): void {
  const { items, setStatus } = useGenQueue.getState()
  for (const it of items) {
    if (it.type !== 'upscale') continue
    if (it.status !== 'submitting' && it.status !== 'queued' && it.status !== 'running') continue
    // (правка 716) У upscale-задач НЕТ ComfyUI prompt_id — DLSS-мост работает
    // по своему API. Прежняя проверка `if (!it.promptId)` была истинна
    // ВСЕГДА, поэтому sweep помечал ошибкой живые задачи при каждом
    // переключении вкладки (вкладка размонтируется → sweep → элемент
    // 'running' становился 'error'; store потом блокировал error→running).
    // Теперь живыми считаются: элемент в очереди (tasks) и элемент, который
    // раннер обрабатывает прямо сейчас (activeItemId), а также случай, когда
    // на мосту действительно идёт рендер.
    if (tasks.has(it.id) || it.id === activeItemId) continue
    const job = useUpscaleService.getState().job
    if (job && isUpscaleJobActive(job)) continue
    setStatus(it.id, 'error', 'Страница перезагружена — задача не была отправлена. Запустите заново.')
  }
}

function kick() {
  if (running) return
  running = true
  void runLoop().finally(() => {
    running = false
    if (activeUpscaleItems(useGenQueue.getState().items).some((i) => tasks.has(i.id))) kick()
  })
}

const isCancelled = (id: string) =>
  useGenQueue.getState().items.find((i) => i.id === id)?.status === 'cancelled'

/**
 * (правка 716) Опрос job'а моста ПО ЕГО ID.
 *
 * Раньше очередь следила за глобальным слотом useUpscaleService.job, который
 * перезаписывает ручная вкладка Upscale: поллер уезжал на чужой job и
 * завершался с безликим «Задача потеряна». Теперь очередь спрашивает свой
 * job напрямую и не зависит от глобального состояния.
 */
interface BridgeJob {
  id: string
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled'
  progress: number
  message?: string
  error?: string | null
  output?: { output_path?: string } | null
}

async function fetchUpscaleJob(jobId: string): Promise<BridgeJob | null> {
  try {
    const r = await fetch(`/api/upscale/job?id=${encodeURIComponent(jobId)}`, {
      signal: AbortSignal.timeout(15000),
    })
    if (!r.ok) return null
    const d = (await r.json().catch(() => null)) as BridgeJob | null
    if (!d || d.id !== jobId) return null
    return d
  } catch {
    return null
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function runLoop(): Promise<void> {
  for (;;) {
    // Находим следующую задачу (submitting или queued)
    const item = useGenQueue
      .getState()
      .items.find(
        (i) =>
          i.type === 'upscale' &&
          (i.status === 'submitting' || i.status === 'queued') &&
          tasks.has(i.id),
      )
    if (!item) return

    const task = tasks.get(item.id)!
    tasks.delete(item.id)

    try {
      // (правка 716) Помечаем элемент как «в работе» — sweep не должен
      // считать его сиротой.
      activeItemId = item.id
      await runTask(item.id, task)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      useGenQueue.getState().setStatus(item.id, 'error', msg)
    } finally {
      if (activeItemId === item.id) activeItemId = null
    }
  }
}

async function runTask(id: string, task: UpscaleTask): Promise<void> {
  const q = () => useGenQueue.getState()
  const svc = () => useUpscaleService.getState()

  q().setStatus(id, 'submitting')

  // (правка 716) Старт отсчёта времени генерации (submit → done).
  const t0 = Date.now()
  // Выходной путь собственного job'а (не глобального слота сервиса).
  let lastOutput: { output_path?: string } | null = null

  // Ждём, пока GPU освободится (активный job завершится)
  // Сервер вернёт 409, если занят — ждём и повторяем.
  let attempts = 0
  const MAX_WAIT = 3600 // 1 час максимум ожидания

  while (true) {
    if (isCancelled(id)) return
    if (attempts * 3 > MAX_WAIT) {
      throw new Error('Слишком долго ждали освобождения GPU')
    }

    // Если есть активный job — ждём его завершения
    const job = svc().job
    if (job && isUpscaleJobActive(job)) {
      // (правка 716) setStatus(id, status, error?) — третий аргумент это
      // ОШИБКА, а не сообщение. Раньше сюда клали «Ожидание освобождения
      // GPU…», и поле error залипало (error ?? item.error) — успешный
      // апскейл показывал красную строку. Сообщение — только через setMessage.
      q().setStatus(id, 'queued')
      q().setMessage(id, 'Ожидание освобождения GPU…')
      await sleep(3000)
      attempts++
      continue
    }

    // GPU свободна — запускаем
    // (правка 716) Результат run() теперь возвращает ok/jobId/error: раньше
    // run() НИЧЕГО не возвращал и не бросал, поэтому очередь не могла
    // отличить «сервер не принял (GPU занята)» от «успешно запущено» и
    // подставляла безликое «Задача потеряна».
    const started = await svc().run(task.feature, task.input, task.options)
    if (!started.ok || !started.jobId) {
      throw new Error(started.error || 'Сервер не принял задачу (GPU занята)')
    }
    // Свой job id: дальше очередь опрашивает ИМЕННО его (а не глобальный
    // слот useUpscaleService.job, который перезаписывает ручная вкладка
    // Upscale). Раньше поллер следовал за ЧУЖИМ job'ом и завершался с
    // «Задача потеряна».
    const jobId = started.jobId
    q().setStatus(id, 'running')

    // Ждём завершения job через polling
    for (;;) {
      if (isCancelled(id)) return
      await sleep(2500)
      const cur = await fetchUpscaleJob(jobId)
      if (!cur) {
        throw new Error('Задача потеряна')
      }
      if (cur.status === 'done') {
        lastOutput = cur.output ?? null
        break
      }
      if (cur.status === 'error') {
        throw new Error(cur.error || 'Ошибка обработки')
      }
      if (cur.status === 'cancelled') {
        throw new Error('Отменено')
      }
      // Обновляем прогресс в очереди
      if (cur.progress > 0) {
        q().setProgress(id, Math.round(cur.progress * 100), 100)
      }
    }

    // (правка 727) DLSS-мост всегда пишет в корень output. Если ролик взят
    // из папки галереи — переносим готовый файл (и сайдкар) туда же, ДО
    // обновления галереи, чтобы результат сразу был на месте.
    let outPath = lastOutput?.output_path
    if (typeof outPath === 'string' && outPath && task.subfolder) {
      try {
        const placed = await fetch('/api/upscale/place', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: outPath,
            subfolder: task.subfolder,
            job_id: jobId,
            source_name: task.sourceName,
          }),
        })
        const pd = (await placed.json().catch(() => ({}))) as { ok?: boolean; path?: string }
        if (placed.ok && pd.ok && typeof pd.path === 'string') outPath = pd.path
      } catch { /* не перенесли — файл остался в корне, результат не теряется */ }
    }

    // Успешное завершение
    q().setStatus(id, 'done')
    q().setProgress(id, 100, 100)
    useGalleryRefresh.getState().bump()
    toast.success(task.subfolder
      ? `Upscale готов — видео в папке «${task.subfolder}»`
      : 'Upscale готов — видео в галерее')

    // (правка 264) Время генерации + DLSS-настройки → сайдкар результата.
    // ensureUpscaleMeta создала .meta.json на первом 'done'-полле; finalize
    // дописывает generation_time + feature + options (идемпотентно).
    // (правка 716) Путь берём из СВОЕГО job'а (lastOutput), а не из
    // svc().job — глобальный слот мог уже перезаписать ручная вкладка.
    if (typeof outPath === 'string' && outPath) {
      const genSec = Math.max(1, Math.round((Date.now() - t0) / 1000))
      void fetch('/api/upscale/finalize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: outPath,
          generation_time: genSec,
          feature: task.feature,
          options: task.options,
        }),
      }).catch(() => { /* метаданные не критичны для результата */ })
    }
    return
  }
}
