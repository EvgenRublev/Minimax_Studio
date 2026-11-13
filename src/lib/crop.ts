/**
 * (правка 908) Общий кроп картинок-референсов.
 *
 * Рамку кропа рисует просмотрщик (`src/components/h3/ref-viewer-dialog.tsx`),
 * он же режет картинку в canvas и отдаёт Blob. Здесь — вторая половина: загрузка
 * обрезанного PNG в ComfyUI input/ и набор полей, которыми надо обновить реф,
 * чтобы повторный кроп снова начинался с оригинала.
 *
 * Одинаковые поля (`crop` / `originalPath` / `originalName`) носят референсы
 * «Генерации» (правка 895), кадров «Кадры», референсы «Продления», ControlNet,
 * Refine и фото человека в Face Refine.
 */
import { toast } from 'sonner'
import { uploadInputFile } from './upload'
import { t } from '@/lib/i18n' // (правка 955)

/** Нормализованный кроп-прямоугольник (0..1 от размера картинки). */
export interface CropRect {
  x: number
  y: number
  w: number
  h: number
}

/** Кроп «вся картинка» — рамка при первом открытии режима кропа. */
export const FULL_CROP: CropRect = { x: 0, y: 0, w: 1, h: 1 }

/** Минимум знаний о референсе, нужных для применения кропа. */
export interface CropableRef {
  /** файл в ComfyUI input/ (или staged-копия) */
  path?: string
  /** имя для подписи (не меняется при кропе) */
  name?: string
  /** файл в input/ ДО первого кропа */
  originalPath?: string
  /** исходное имя файла */
  originalName?: string
  /** локальное blob-превью (пусто = берём из input/) */
  previewUrl?: string
  /** текущий кроп (0..1 от оригинала) — рамка при повторном открытии */
  crop?: CropRect
}

/** Что положить в стор референса после кропа. */
export interface CropPatch {
  /** новый файл: обрезанная копия в input/ */
  path: string
  /** оригинал до кропа — с него начинается повторный кроп */
  originalPath: string
  originalName: string
  crop: CropRect
  /** превью сбрасываем: картинку берём из input/ по новому path */
  previewUrl: string
}

/**
 * Грузит обрезанный PNG в input/ и возвращает поля для обновления референса.
 * Бросает ошибку, если загрузка не удалась (вызывающий показывает тост).
 */
export async function applyRefCrop(
  ref: CropableRef,
  rect: CropRect,
  blob: Blob,
): Promise<CropPatch> {
  const base = (ref.originalName || ref.name || 'ref').replace(/\.[^.]+$/, '')
  const file = new File([blob], `${base}-crop-${Date.now()}.png`, { type: 'image/png' })
  const { path } = await uploadInputFile(file)
  return {
    path,
    originalPath: ref.originalPath ?? ref.path ?? '',
    originalName: ref.originalName ?? ref.name ?? file.name,
    crop: rect,
    previewUrl: '',
  }
}

/**
 * URL КАРТИНКИ ДО КРОПА — просмотрщик в режиме кропа всегда показывает
 * оригинал, иначе второй кроп резал бы уже обрезанное.
 */
export function cropOriginalSrc(ref: CropableRef): string | undefined {
  if (ref.originalPath) return comfyInputUrl(ref.originalPath)
  return ref.previewUrl || undefined
}

/** Есть ли у референса незакрытый след кропа (для подсказки в UI). */
export function isCropped(ref: CropableRef): boolean {
  return Boolean(ref.originalPath)
}

/** URL миниатюры/полноразмерного файла из ComfyUI input/. */
export function comfyInputUrl(filename: string, width?: number): string {
  const q = `filename=${encodeURIComponent(filename)}&type=input`
  return `/api/comfy/file?${q}${width ? `&width=${width}` : ''}`
}

/**
 * Размеры изображения из Blob (правка 152: кадры flf задают aspect ratio по
 * ширине/высоте первого кадра — после кропа их надо пересчитать).
 * null — если декодировать не удалось.
 */
export function readImageDims(blob: Blob): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve({ w: img.naturalWidth, h: img.naturalHeight })
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      resolve(null)
    }
    img.src = url
  })
}

/**
 * Полный цикл «пользователь подтвердил кроп»: загрузка PNG + обновление рефа
 * + тосты. Ошибку не бросаем — показываем тост (все вкладки одинаковые).
 *
 * @param onPatch чем обновить референс (patch из стора: updateRef/patchRefImage/…)
 */
export async function applyCropToRef(
  ref: CropableRef,
  rect: CropRect,
  blob: Blob,
  onPatch: (patch: CropPatch) => void,
): Promise<void> {
  try {
    onPatch(await applyRefCrop(ref, rect, blob))
    toast.success(t("Кроп применён"))
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t("Не удалось применить кроп"))
  }
}
