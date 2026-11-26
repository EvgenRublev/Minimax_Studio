/**
 * (правка 1153) Refiner-LoRA Open-Regenerate 2K — общий констант-модуль.
 *
 * Файл лежит в `ComfyUI/models/loras` (обязательная модель реестра,
 * правка 1151), но НЕ включается как обычная LoRA из loras.json: он применяется
 * только там, где нужен: Refine (целиком и «Частями») и Pass 2 двухпроходной
 * генерации. Сила — ползунок «Детализация».
 *
 * Модуль без импортов, чтобы его могли тянуть и клиент, и шаблоны воркфлоу.
 */
export const REFINER_LORA_NAME = 'minimax_h3_open_regenerate_2k_refiner_rank_16_bf16.safetensors'

/** Максимум силы ползунка «Детализация» (200%). */
export const REFINER_LORA_STRENGTH_MAX = 2

/** Сила LoRA по умолчанию (100%). */
export const REFINER_LORA_STRENGTH_DEFAULT = 1

/** Клампим в 0..2 с шагом 0.01; не число → 0 (эффект выключен). */
export function clampRefinerStrength(raw: unknown): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0
  return Math.max(0, Math.min(REFINER_LORA_STRENGTH_MAX, Math.round(n * 100) / 100))
}
