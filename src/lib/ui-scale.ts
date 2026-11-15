/**
 * (правка 1003) Единый масштаб интерфейса.
 *
 * В Electron используем нативный Chromium zoom: он масштабирует ВСЁ —
 * панели, отступы, px-ширины, шрифт. Старый root font-size увеличивал только
 * rem-значения, поэтому панели и кнопки визуально не менялись.
 *
 * В браузере (веб-превью) webFrame нет — там остаётся шрифтовой fallback,
 * чтобы настройка не ломала страницу.
 */
export const UI_SCALE_KEY = 'h3-ui-scale'
export const UI_SCALE_DEFAULT = 80

export function applyUiScale(pct: number): void {
  if (!Number.isFinite(pct) || pct <= 0) return
  const factor = pct / 100
  const bridge = typeof window !== 'undefined' ? window.h3desktop : undefined
  if (bridge?.setZoom) {
    bridge.setZoom(factor)
    // Убираем старый шрифтовой масштаб, иначе он сложится с zoom.
    document.documentElement.style.fontSize = ''
    document.documentElement.style.zoom = ''
    return
  }
  // Fallback для браузера: CSS zoom масштабирует и блоки, и текст.
  try {
    document.documentElement.style.zoom = pct === 100 ? '' : String(factor)
    document.documentElement.style.fontSize = ''
  } catch {
    document.documentElement.style.fontSize = pct === 100 ? '' : `${pct}%`
  }
}
