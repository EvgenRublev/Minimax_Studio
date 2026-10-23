/**
 * Tracks generation durations (persisted to localStorage).
 * Each entry records the completion timestamp and the elapsed time.
 * The gallery matches the N-th newest file to the N-th newest entry.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface GenDurationEntry {
  /** Completion timestamp (ms). */
  ts: number
  /** Elapsed generation time in milliseconds. */
  durationMs: number
  /** Type of generation (for display). */
  type: 'video' | 'image' | 'music' | 'sound'
  /** Output filename (for reliable matching). */
  filename?: string
}

interface GenDurationState {
  entries: GenDurationEntry[]
  /** Record a completed generation. durationMs = null → don't record (unknown). */
  record: (durationMs: number | null, type: GenDurationEntry['type'], filename?: string) => void
  /** Clear all entries. */
  clear: () => void
}

export const useGenDurations = create<GenDurationState>()(
  persist(
    (set) => ({
      entries: [],
      record: (durationMs, type, filename) => {
        // (правка 716) Нечисловое значение отбрасываем: раньше NaN попадал в
        // историю, и formatSeconds(NaN) давал «NaN сек» в бейдже.
        if (durationMs === null || !Number.isFinite(durationMs)) return
        set((s) => ({
          entries: [...s.entries.slice(-199), { ts: Date.now(), durationMs, type, filename }],
        }))
      },
      clear: () => set({ entries: [] }),
    }),
    { name: 'cb-gen-durations' },
  ),
)

/** Format whole seconds into a human-readable string: "45 сек" / "2 мин 15 сек".
 *  Used for the generation-time badge when the value comes from the sidecar
 *  (field `generation_time`, already in seconds). */
export function formatSeconds(totalSec: number): string {
  // (правка 716) Нечисловые значения (NaN/Infinity) не должны попадать в UI.
  if (!Number.isFinite(totalSec)) return '—'
  const s = Math.max(0, Math.round(totalSec))
  if (s < 60) return `${s} сек`
  const min = Math.floor(s / 60)
  const sec = s % 60
  return sec > 0 ? `${min} мин ${sec} сек` : `${min} мин`
}

/** Format milliseconds into a human-readable string like "45 сек" or "2 мин 15 сек". */
export function formatDuration(ms: number): string {
  return formatSeconds(ms / 1000)
}
