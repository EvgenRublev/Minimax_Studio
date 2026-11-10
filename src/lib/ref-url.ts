/**
 * (правка 909) URL референса для ПОЛНОЭКРАННОГО просмотра.
 *
 * Проблема: превью в сетках рисуются миниатюрами `/api/comfy/file?...&width=200`
 * (сервер отдаёт JPEG нужной ширины, см. src/app/api/comfy/file/route.ts), и
 * вкладки ControlNet/Refine кладут ЭТОТ ЖЕ адрес в `previewUrl` референса.
 * Просмотрщик (`RefViewerDialog`) брал `data.url` как есть — поэтому во весь
 * экран открывалась картинка шириной 200 px, растянутая по центру чёрного
 * фона, хотя исходник мог быть 4000×3000. Та же беда была у рамки кропа:
 * `cropOriginalSrc()` без `originalPath` возвращал `previewUrl`, и первый кроп
 * резал миниатюру, а не оригинал.
 *
 * Решение — один чистый помощник: из адреса нашего эндпоинта убирается только
 * параметр `width` (без него роут стримит файл целиком). Всё остальное
 * (blob:, http-адреса галереи, адреса без `width`) возвращается без изменений.
 *
 * Модуль без импортов — покрыт scratchpad/ref-url-check.mjs.
 */

/** Оставить в адресе файла только полноразмерную версию (убрать `width`). */
export function fullSizeRefUrl(url: string | null | undefined): string {
  if (!url) return ''
  // Превью по `width` умеет отдавать только наш файловый эндпоинт.
  if (!url.includes('/api/comfy/file')) return url
  if (!url.includes('width=')) return url
  try {
    const parsed = new URL(url, 'http://ref.local')
    if (!parsed.searchParams.has('width')) return url
    parsed.searchParams.delete('width')
    // Возвращаем относительный адрес — как он и приходил в приложение.
    return `${parsed.pathname}${parsed.search}`
  } catch {
    return url
  }
}
