import { vhsEncodeInputs, type VideoFormatSettings } from '../video-format' // (правка 386)
/**
 * FPS — frame interpolation (VFI) workflow-шаблон. (правка 268)
 *
 * Вставка кадров между существующими: 24 fps → 48/72/96 fps.
 * Пакет нод: Fannovel16/ComfyUI-Frame-Interpolation.
 *
 * Цепочка:
 *   VHS_LoadVideo (24 fps) ──IMAGE→ RIFE VFI / FILM VFI (multiplier) ──IMAGE→
 *   VHS_VideoCombine (fps = исходный × multiplier, звук из исходника)
 *
 * RIFE VFI  (быстрый, мало VRAM) — параметры:
 *   ckpt_name (rife49.pth | rife47.pth | rife417.pth | rife426.pth |
 *              sudo_rife4_269.662_testV1_scale1.pth), frames (IMAGE),
 *   multiplier (INT), clear_cache_after_n_frames (INT 1–1000),
 *   fast_mode (BOOL), ensemble (BOOL), scale_factor (0.25|0.5|1|2|4),
 *   dtype (float32|float16|bfloat16), torch_compile (BOOL), batch_size (1–64).
 *
 * FILM VFI (крупные движения) — параметры:
 *   ckpt_name (film_net_fp32.pt), frames (IMAGE), multiplier (INT),
 *   clear_cache_after_n_frames (INT 1–1000).
 *
 * Заметки по VRAM:
 *   - clear_cache_after_n_frames — главный анти-OOM: меньше = меньше пик,
 *     медленнее. На слабой карте 2–4.
 *   - scale_factor (RIFE) — 0.25/0.5 = быстрее и меньше VRAM, 1.0 = качество.
 *   - dtype=float16 экономит ~50% VRAM относительно float32.
 */

export type FpsMode = 'rife' | 'film'

export interface FpsParams {
  /** (правка 386) Формат/качество видео-выхода ([video] config.ini). */
  videoFormat?: VideoFormatSettings
  /** Имя файла в ComfyUI input/ (уже скопирован роутом). */
  sourceVideo: string
  /** Исходный FPS видео (ffprobe r_frame_rate). Default 24. */
  sourceFps: number
  /** Режим VFI: 'rife' | 'film'. Default 'rife'. */
  mode?: FpsMode
  /** Множитель FPS: 2 | 3 | 4. Default 2. */
  multiplier?: number
  // (правка 269) rifeModel/filmModel удалены: по одной модели на режим,
  // зафиксированы ниже (RIFE_MODEL / FILM_MODEL). Скачиваются в
  // Настройках → Модели (models-config.ts, category 'fps').
  /** RIFE batch_size (1–64). Default 4. */
  rifeBatchSize?: number
  /** RIFE scale_factor. Default 1. */
  rifeScale?: number
  /** RIFE dtype. Default 'float16'. */
  rifeDtype?: string
  /** RIFE fast_mode. Default false. */
  rifeFastMode?: boolean
  /** RIFE ensemble. Default true. */
  rifeEnsemble?: boolean
  /** Анти-OOM: кадров между очисткой кэша. Default 4. */
  clearCacheAfterNFrames?: number
  /** Подпапка вывода. */
  outputSubfolder?: string
}

// (правка 269) По одной модели на режим (решение пользователя):
// RIFE → rife49.pth, FILM → film_net_fp32.pt.
const RIFE_MODEL = 'rife49.pth'
const FILM_MODEL = 'film_net_fp32.pt'

/**
 * Clamp value to a known allowed list (for COMBO inputs). Falls back to first
 * option if the value isn't in the list — this avoids ComfyUI rejecting the
 * workflow with an "invalid value" error.
 */
function pickOption<T extends string>(allowed: readonly T[], value: T | undefined, fallback: T): T {
  if (value && (allowed as readonly string[]).includes(value)) return value
  return fallback
}

/** Round fps to a safe positive number (ComfyUI VHS_VideoCombine). */
function safeFps(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 24
  return Math.max(1, Math.min(240, Math.round(n * 100) / 100))
}

export function buildFpsWorkflow(p: FpsParams): Record<string, unknown> {
  const vhsEnc = vhsEncodeInputs(p.videoFormat) // (правка 386)
  const mode: FpsMode = p.mode === 'film' ? 'film' : 'rife'
  const multiplier = Math.max(2, Math.min(1000, Math.floor(p.multiplier ?? 2)))
  const srcFps = safeFps(p.sourceFps)
  const outFps = safeFps(srcFps * multiplier)

  // (правка 269) Модели зафиксированы — не принимаются из параметров.
  const rifeModel = RIFE_MODEL
  const filmModel = FILM_MODEL
  const rifeBatchSize = Math.max(1, Math.min(64, Math.floor(p.rifeBatchSize ?? 4)))
  // (правка 268, фикс) scale_factor — ЧИСЛО (0.25/0.5/1.0/2.0/4.0), не строка.
  const RIFE_SCALE_OPTIONS = [0.25, 0.5, 1.0, 2.0, 4.0]
  const rifeScaleNum = p.rifeScale ?? 1.0
  const rifeScale = RIFE_SCALE_OPTIONS.includes(rifeScaleNum) ? rifeScaleNum : 1.0
  const rifeDtype = pickOption(['float32', 'float16', 'bfloat16'] as const, p.rifeDtype, 'float16')
  const rifeFastMode = p.rifeFastMode === true
  const rifeEnsemble = p.rifeEnsemble !== false
  const clearCache = Math.max(1, Math.min(1000, Math.floor(p.clearCacheAfterNFrames ?? 4)))

  const sub = p.outputSubfolder ? `${p.outputSubfolder}/` : ''

  return {
    // ═══════════════════════════════════════════════
    //  SOURCE VIDEO LOADING
    // ═══════════════════════════════════════════════
    'fps_src': {
      inputs: {
        video: p.sourceVideo,
        // Не форсируем 24 fps — используем fps из исходника (VHS force_rate=0).
        // multiplier умножит этот fps и даст целевой fps.
        force_rate: 0,
        custom_width: 0,
        custom_height: 0,
        frame_load_cap: 0,
        skip_first_frames: 0,
        select_every_nth: 1,
      },
      class_type: 'VHS_LoadVideo',
      _meta: { title: `Исходник (${srcFps} fps)` },
    },

    // ═══════════════════════════════════════════════
    //  FRAME INTERPOLATION (RIFE / FILM)
    // ═══════════════════════════════════════════════
    ...(mode === 'rife'
      ? {
          'fps_vfi': {
            inputs: {
              ckpt_name: rifeModel,
              frames: ['fps_src', 0],
              multiplier,
              clear_cache_after_n_frames: clearCache,
              fast_mode: rifeFastMode,
              ensemble: rifeEnsemble,
              scale_factor: rifeScale,
              dtype: rifeDtype,
              torch_compile: false,
              batch_size: rifeBatchSize,
            },
            class_type: 'RIFE VFI',
            _meta: { title: `RIFE VFI (×${multiplier})` },
          },
        }
      : {
          'fps_vfi': {
            inputs: {
              ckpt_name: filmModel,
              frames: ['fps_src', 0],
              multiplier,
              clear_cache_after_n_frames: clearCache,
            },
            class_type: 'FILM VFI',
            _meta: { title: `FILM VFI (×${multiplier})` },
          },
        }),

    // ═══════════════════════════════════════════════
    //  OUTPUT COMBINE (fps × multiplier, звук из исходника)
    // ═══════════════════════════════════════════════
    'fps_out': {
      inputs: {
        frame_rate: outFps,
        loop_count: 0,
        filename_prefix: `${sub}Minimax_Studio_fps`,
        // (правка 386) формат/качество — из [video] настроек студии
        ...vhsEnc,
        save_metadata: false,
        // (правка 323) A/V sync: VFI ИНТЕРПОЛИРУЕТ кадры (N → N×multiplier),
        // out frame_rate = srcFps×multiplier → длительность видео =
        // длительности исходника. Звук — оригинальная дорожка из VHS
        // passthrough той же длительности → рассинхрона нет; false допедит
        // аудио apad до длины видео. Это смысл fps-режима — не трогать.
        pingpong: false,
        save_output: true,
        images: ['fps_vfi', 0],
        audio: ['fps_src', 2],
      },
      class_type: 'VHS_VideoCombine',
      _meta: { title: `Video Combine (${outFps} fps)` },
    },
  }
}
