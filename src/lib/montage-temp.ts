/**
 * (правка 966) Общая математика цветовых эффектов монтажа.
 *
 * Превью рисуется SVG-фильтром (feComponentTransfer), финал — ffmpeg. Раньше
 * температура считалась в двух местах по-разному: превью `temp/380` с
 * синусоидальным сдвигом, рендер — `colorbalance` с `temp/250` и раздельными
 * тенями/средними/светами. Из-за этого «на превью тепло, в файле иначе».
 * Теперь и там, и там одна и та же кривая (bell, сохраняет чёрный/белый).
 */

export const TEMP_SCALE = 380

/** Сдвиги каналов для температуры −100..100 (тёплое > 0). */
export function tempShifts(temp?: number | null): { r: number; g: number; b: number } {
  const v = typeof temp === 'number' && Number.isFinite(temp) ? temp : 0
  const r = Math.abs(v) >= 1 ? v / TEMP_SCALE : 0
  return { r, g: r * 0.18, b: -r }
}

/**
 * ffmpeg-выражение для lutrgb, повторяющее `buildChannelTable` превью:
 *   v' = clamp(v + shift·(0.35 + 0.65·sin(π·v)), 0, 1)
 * `val` в lutrgb — 0..255.
 */
export function tempLutExpr(shift: number): string {
  const s = Number(shift.toFixed(6))
  return `clip(val + 255*${s}*(0.35+0.65*sin(3.141592653589793*val/255)),0,255)`
}
