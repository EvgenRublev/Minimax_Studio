/**
 * Prompt history store (Zustand, persisted to localStorage).
 *
 * Every submitted prompt is remembered (deduped, capped). Favorites are
 * pinned to the top. Click on an entry to load it back into the editor.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface PromptHistoryEntry {
  id: string
  text: string
  ts: number
  favorite: boolean
}

const MAX_ENTRIES = 30
const MAX_FAVORITES = 20

interface PromptHistoryState {
  entries: PromptHistoryEntry[]
  /** Add (or re-bump) a prompt. Dedupes by exact text. */
  add: (text: string) => void
  toggleFavorite: (id: string) => void
  remove: (id: string) => void
  clear: () => void
}

function sortEntries(entries: PromptHistoryEntry[]): PromptHistoryEntry[] {
  return [...entries].sort((a, b) => {
    if (a.favorite !== b.favorite) return a.favorite ? -1 : 1
    return b.ts - a.ts
  })
}

export const usePromptHistory = create<PromptHistoryState>()(
  persist(
    (set) => ({
      entries: [],

      add: (text) => {
        const trimmed = text.trim()
        if (!trimmed) return
        set((s) => {
          const existing = s.entries.find((e) => e.text === trimmed)
          if (existing) {
            // Bump to the top (keep favorite flag)
            return {
              entries: sortEntries([
                { ...existing, ts: Date.now() },
                ...s.entries.filter((e) => e.id !== existing.id),
              ]),
            }
          }
          const entry: PromptHistoryEntry = {
            id: `ph_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
            text: trimmed,
            ts: Date.now(),
            favorite: false,
          }
          let next = [entry, ...s.entries]
          // Cap: keep favorites + the newest non-favorites
          const favorites = next.filter((e) => e.favorite).slice(0, MAX_FAVORITES)
          const regular = next.filter((e) => !e.favorite).slice(0, MAX_ENTRIES)
          next = sortEntries([...favorites, ...regular])
          return { entries: next }
        })
      },

      toggleFavorite: (id) =>
        set((s) => ({
          entries: sortEntries(
            s.entries.map((e) => (e.id === id ? { ...e, favorite: !e.favorite } : e)),
          ),
        })),

      remove: (id) =>
        set((s) => ({ entries: s.entries.filter((e) => e.id !== id) })),

      clear: () => set({ entries: [] }),
    }),
    {
      name: 'h3-prompt-history',
      version: 1,
      partialize: (state) => ({ entries: state.entries }),
      merge: (persisted, current) => {
        const raw = (persisted as PromptHistoryState | null)?.entries
        const entries = Array.isArray(raw)
          ? raw.filter((e) => e && typeof e.text === 'string' && typeof e.id === 'string')
          : []
        return { ...current, entries: sortEntries(entries) }
      },
    },
  ),
)
