/**
 * (правка 722) Детекторы Face Refine — значения комбо спрашиваем у ComfyUI.
 *
 * H3FaceTrackCrop объявляет `detector` и `fallback_detector` как combo из
 * категорий folder_paths `ultralytics_bbox` / `ultralytics`. Impact Pack, который
 * обычно их регистрирует, в этой сборке не стоит — папку детекторов студия
 * регистрирует сама (extra_model_paths.yaml → models/ultralytics), и тогда
 * ComfyUI отдаёт имена с подпапкой: `bbox\face_yolov8m.pt`,
 * `segm\person_yolov8m-seg.pt`.
 *
 * Значение вне списка ComfyUI отклоняет при валидации промпта, поэтому хардкод
 * имени не годится: до регистрации папки (или до перезапуска бэкенда) список —
 * один `face_yolov8m.pt`, после — имена с подпапкой. Подбираем то, что реально
 * есть, по /object_info; кэш короткий, чтобы поднявшийся бэкенд подхватился сам.
 */
import { COMFY_URL } from './minimax-h3-client'
import { DEFAULT_FACE_DETECTOR } from './face-refine-template'

export interface FaceDetectors {
  /** Детектор лиц — значение для H3FaceTrackCrop.detector. */
  detector: string
  /** Детектор человека для кадров без лица или null, если модели нет. */
  fallbackDetector: string | null
}

const OK_TTL_MS = 60_000
const FAIL_TTL_MS = 10_000

let cache: { at: number; value: FaceDetectors } | null = null

/** Обе формы combo: legacy `[["a","b"], {...}]` и `["COMBO", {options}]`. */
function comboOptions(spec: unknown): string[] {
  if (!Array.isArray(spec)) return []
  const raw = Array.isArray(spec[0])
    ? spec[0]
    : (spec[1] as { options?: unknown } | undefined)?.options
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []
}

export async function resolveFaceDetectors(): Promise<FaceDetectors> {
  if (cache) {
    const ttl = cache.value.fallbackDetector ? OK_TTL_MS : FAIL_TTL_MS
    if (Date.now() - cache.at < ttl) return cache.value
  }

  let options: string[] = []
  try {
    const res = await fetch(`${COMFY_URL}/object_info/H3FaceTrackCrop`, {
      signal: AbortSignal.timeout(5000),
    })
    if (res.ok) {
      const info = (await res.json()) as {
        H3FaceTrackCrop?: { input?: { required?: Record<string, unknown> } }
      }
      options = comboOptions(info.H3FaceTrackCrop?.input?.required?.detector)
    }
  } catch {
    // ComfyUI не отвечает — вернём дефолт, отправка промпта всё равно упадёт.
  }

  const detector =
    options.find((o) => /face_yolov8/i.test(o)) ??
    options.find((o) => /face/i.test(o)) ??
    options[0] ??
    DEFAULT_FACE_DETECTOR
  // Модель человека — обычно person_yolov8m-seg; годится любая с «person».
  const fallbackDetector = options.find((o) => /person/i.test(o)) ?? null

  const value: FaceDetectors = { detector, fallbackDetector }
  cache = { at: Date.now(), value }
  return value
}
