/**
 * Generation state store (Zustand, persisted to localStorage).
 *
 * Holds the active video generation state so that:
 *   - Switching between tabs doesn't lose the generation progress
 *   - The component can unmount and remount and still find its state
 *   - Progress (from WebSocket) can be updated from anywhere
 *   - A page reload restores the tracked prompt (polling re-attaches in
 *     useVideoGen from the persisted queue items)
 *
 * Generated videos are NOT stored here — they come from
 * ComfyUI's output directory via /api/comfy/files.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/* ──────────────────── Types ──────────────────── */

export type GenPhase = 'idle' | 'submitting' | 'queued' | 'running' | 'done' | 'error'

/** (правка 696) Тип stageKind, зафиксированный на момент старта генерации.
 *  Соответствует пропсу stageKind в generation-status.tsx. */
export type GenStageKind = 'passes' | 'clips' | 'clips2' | 'chunks' | 'single' | 'tile' | 'controlnet'

export interface GenerationState {
  phase: GenPhase
  error: string | null
  /** ComfyUI prompt_id for the active generation. */
  promptId: string | null
  /** Real sampler progress from WebSocket. */
  progressValue: number
  progressMax: number
  /** Which ComfyUI node is currently executing. */
  executingNode: string | null
  /** Timestamp when generation started. */
  startedAt: number | null
  /** Status message from the backend. */
  statusMessage: string | null
  /** (правка 696) Зафиксированный на момент старта генерации stageKind.
      Не меняется при переключении «Драфт/Полное» во время генерации —
      шаблон подписи остаётся тем, что был на момент отправки. */
  frozenStageKind?: GenStageKind
}

const IDLE_STATE: GenerationState = {
  phase: 'idle',
  error: null,
  promptId: null,
  progressValue: 0,
  progressMax: 0,
  executingNode: null,
  startedAt: null,
  statusMessage: null,
  frozenStageKind: undefined,
}

/* ──────────────────── Store ──────────────────── */

interface GenStore {
  video: GenerationState

  /** (правка 696) Зафиксировать stageKind на момент старта генерации.
      Вызывается вкладкой до/после отправки, чтобы подпись прогресса не
      менялась при переключении «Драфт/Полное» во время генерации. */
  setVideoFrozenStageKind: (kind: GenStageKind | undefined) => void
  setVideoPhase: (phase: GenPhase) => void
  /** Новая отправка задачи: карточка немедленно показывает «Отправка…»,
   *  БЕЗ остатков прошлой задачи (её promptId/прогресс/таймер). Если
   *  карточка уже следит за АКТИВНОЙ (queued/running) задачей — не трогаем
   *  её: параллельная отправка не должна красть карточку у исполняемой. */
  beginVideoSubmit: () => void
  setVideoError: (error: string | null) => void
  setVideoPromptId: (id: string | null) => void
  setVideoProgress: (value: number, max: number) => void
  setVideoExecutingNode: (node: string | null) => void
  setVideoStatusMessage: (msg: string | null) => void
  /** Set which prompt the shared card/preview tracks.
   *  Without `force`, an already-tracked ACTIVE prompt is kept — a newly
   *  submitted job must not steal the card (previews are keyed to the
   *  EXECUTING prompt, so a card tracking a merely-queued prompt would show
   *  "Ожидание preview…" forever). pollUntilDone passes force=true when its
   *  prompt actually starts running. */
  startVideoGen: (promptId: string, force?: boolean) => void
  resetVideoGen: () => void
}

export const useGenProgress = create<GenStore>()(
  persist(
    (set) => ({
      video: { ...IDLE_STATE },

  // ──── Video Gen ────

  // (правка 696) Явный фикс stageKind — не сбрасывается на 'running'.
  setVideoFrozenStageKind: (kind) =>
    set((s) => ({ video: { ...s.video, frozenStageKind: kind } })),

  setVideoPhase: (phase) =>
    set((s) => ({
      video: {
        ...s.video,
        phase,
        // (правка 716) Ошибка очищается при переходе в активную фазу:
        // раньше она оставалась в состоянии и показывалась при следующей
        // генерации, уже успешной.
        ...(phase === 'running' || phase === 'done' ? { error: null } : {}),
        // Reset elapsed timer when a new generation starts running
        ...(phase === 'running' && s.video.phase !== 'running' ? { startedAt: Date.now() } : {}),
      },
    })),

  beginVideoSubmit: () =>
    set((s) => {
      const trackedActive =
        s.video.promptId && ['queued', 'running'].includes(s.video.phase)
      if (trackedActive) return s
      return {
        video: {
          ...IDLE_STATE,
          phase: 'submitting',
          startedAt: Date.now(),
          // (правка 696) Сохраняем текущий frozenStageKind — вкладка уже
          // успела вызвать setVideoFrozenStageKind до beginVideoSubmit.
          frozenStageKind: s.video.frozenStageKind,
        },
      }
    }),

  setVideoError: (error) =>
    set((s) => ({ video: { ...s.video, error } })),

  setVideoPromptId: (id) =>
    set((s) => ({ video: { ...s.video, promptId: id } })),

  setVideoProgress: (value, max) =>
    set((s) => ({ video: { ...s.video, progressValue: value, progressMax: max } })),

  setVideoExecutingNode: (node) =>
    set((s) => ({ video: { ...s.video, executingNode: node } })),

  setVideoStatusMessage: (msg) =>
    set((s) => ({ video: { ...s.video, statusMessage: msg } })),

  startVideoGen: (promptId, force) =>
    set((s) => {
      // Don't steal the card from a job it's already tracking (queued or
      // running) — the card switches via pollUntilDone's forced takeover
      // when a prompt actually starts EXECUTING.
      if (
        !force &&
        s.video.promptId &&
        ['submitting', 'queued', 'running'].includes(s.video.phase)
      ) {
        return s
      }
      return {
        video: {
          ...IDLE_STATE,
          phase: 'queued',
          promptId,
          startedAt: Date.now(),
        },
      }
    }),

  resetVideoGen: () =>
    set({ video: { ...IDLE_STATE } }),
    }),
    {
      name: 'h3-gen-progress',
      version: 1,
      // Persist the current video state; on rehydrate keep only an ACTIVE
      // generation — finished/idle states must not resurrect on reload.
      partialize: (state) => ({ video: state.video }),
      merge: (persisted, current) => {
        const video = (persisted as GenStore | null)?.video
        const safe =
          video && ['submitting', 'queued', 'running'].includes(video.phase) && video.promptId
            ? video
            : { ...IDLE_STATE }
        return { ...current, video: safe }
      },
    }
  )
)
