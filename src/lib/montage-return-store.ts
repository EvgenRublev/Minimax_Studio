'use client'

/**
 * (правка 857) MontageReturnStore — «возврат чистовика из Refine в монтажку».
 *
 * Механика: с клипа монтажки жмут «В Refine» — пара (ключ шота → исходник-
 * драфт) кладётся в `pending`. Раннер очереди рефайна (refine-queue.ts, он
 * переживает переключение вкладок) на done пишет готовый файл в `arrivals`
 * с указанием, из какого исходника он сделан. MontageView при монтировании
 * и при обновлении галереи сверяет arrivals с pending и подменяет шот:
 * filename/url меняются, подрезки/громкость/фейды/скорость/эффекты/переход
 * остаются.
 *
 * Обе карты живут в localStorage: вкладка монтажки при переходе в Refine
 * РАЗМОНТИРОВАНА (page.tsx рендерит вкладки с key={activeTab}), а генерация
 * идёт минуты — событие «на лету» было бы потеряно.
 */
import { create } from 'zustand'

export interface PendingReturn {
  /** Ключ шота на таймлайне, который ждёт замену. */
  shotKey: string
  /** Исходник (драфт), из которого клип ушёл в Refine. */
  filename: string
  subfolder: string
  /** Когда отправляли (для порядка обработки). */
  ts: number
}

/** Готовый чистовик из Refine: source_* — исходник, из которого он сделан. */
export interface RefineArrival {
  filename: string
  subfolder: string
  sourceFilename: string
  sourceSubfolder: string
  ts: number
}

const LS_KEY = 'h3_montage_return_v1'
/** Чистовики помним немного: только чтобы дождаться несмонтированной монтажки
 *  (дальше файл и так виден в галерее). */
const ARRIVALS_MAX = 30

interface SavedShape {
  pending: Record<string, PendingReturn>
  arrivals: RefineArrival[]
}

interface MontageReturnState {
  pending: Record<string, PendingReturn>
  add: (p: Omit<PendingReturn, 'ts'>) => void
  drop: (shotKey: string) => void
  arrivals: RefineArrival[]
  noteArrival: (a: Omit<RefineArrival, 'ts'>) => void
  dropArrival: (filename: string) => void
}

const EMPTY: SavedShape = { pending: {}, arrivals: [] }

const load = (): SavedShape => {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return EMPTY
    const parsed = JSON.parse(raw) as Partial<SavedShape>
    return {
      pending: parsed.pending && typeof parsed.pending === 'object' ? parsed.pending : {},
      arrivals: Array.isArray(parsed.arrivals) ? parsed.arrivals : [],
    }
  } catch {
    return EMPTY
  }
}

const persist = (s: Pick<MontageReturnState, 'pending' | 'arrivals'>) => {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ pending: s.pending, arrivals: s.arrivals }))
  } catch { /* приватный режим / квота */ }
}

const saved = typeof window === 'undefined' ? EMPTY : load()

export const useMontageReturn = create<MontageReturnState>((set) => ({
  pending: saved.pending,
  arrivals: saved.arrivals,
  add: (p) =>
    set((s) => {
      const next = { ...s.pending, [p.shotKey]: { ...p, ts: Date.now() } }
      persist({ pending: next, arrivals: s.arrivals })
      return { pending: next }
    }),
  drop: (shotKey) =>
    set((s) => {
      if (!(shotKey in s.pending)) return s
      const next = { ...s.pending }
      delete next[shotKey]
      persist({ pending: next, arrivals: s.arrivals })
      return { pending: next }
    }),
  noteArrival: (a) =>
    set((s) => {
      if (s.arrivals.some((x) => x.filename === a.filename)) return s
      const next = [...s.arrivals, { ...a, ts: Date.now() }].slice(-ARRIVALS_MAX)
      persist({ pending: s.pending, arrivals: next })
      return { arrivals: next }
    }),
  dropArrival: (filename) =>
    set((s) => {
      const next = s.arrivals.filter((x) => x.filename !== filename)
      if (next.length === s.arrivals.length) return s
      persist({ pending: s.pending, arrivals: next })
      return { arrivals: next }
    }),
}))
