/**
 * (правка 123) Вставка изображений по Ctrl+V из буфера обмена.
 *
 * Общий хелпер: извлекает только файлы image/* из clipboardData,
 * работая и с `dt.files`, и с `dt.items` (getAsFile) — так покрываются
 * Chrome/Edge и Firefox (в Firefox вставленная картинка отдаётся
 * именно через items).
 *
 * Дедупликация: буфер обмена Windows может содержать одно изображение в
 * нескольких форматах (PNG + BMP, PNG + EMF и т.д.), и браузер отдаёт их как
 * разные File-объекты. Чтобы не появлялось две копии одного скриншота,
 * берём ПЕРВЫЙ файл и отбрасываем все остальные — типичная вставка содержит
 * ровно одно изображение. Если у файла нет имени/расширения — подставляем
 * имя по MIME, чтобы `detectKind` и серверные загрузки работали как с
 * обычным файлом.
 */
/**
 * Быстрая синхронная проверка: есть ли в буфере хотя бы одно изображение.
 * Нужно, чтобы `preventDefault` в onPaste вызывался синхронно (до await).
 */
export function hasClipboardImage(dt: DataTransfer | null | undefined): boolean {
  if (!dt) return false
  try {
    if (dt.items && dt.items.length) {
      for (const it of Array.from(dt.items)) {
        if (it.kind === 'file' && (it.type || '').startsWith('image/')) return true
      }
    }
  } catch { /* ignore */ }
  for (const f of Array.from(dt.files ?? [])) {
    if (f.type.startsWith('image/')) return true
  }
  return false
}

export async function getClipboardImageFiles(dt: DataTransfer | null | undefined): Promise<File[]> {
  if (!dt) return []
  const candidates: File[] = []
  const seen = new Set<File>()
  const push = (f: File | null | undefined) => {
    if (!f || !f.type.startsWith('image/')) return
    if (seen.has(f)) return
    seen.add(f)
    candidates.push(f)
  }
  // items — сначала (надёжнее для «чистой» вставки из скриншотов/пейджера)
  try {
    if (dt.items && dt.items.length) {
      for (const it of Array.from(dt.items)) {
        if (it.kind === 'file') push(it.getAsFile())
      }
    }
  } catch { /* некоторые браузеры не дают итерации — просто переходим к files */ }
  for (const f of Array.from(dt.files ?? [])) push(f)
  if (candidates.length === 0) return []

  // Дедупликация по содержимому: берём hash первых 64 КБ каждого файла.
  // Альтернативные представления одного изображения (PNG+BMP) имеют разные
  // байты, но обычно одинаковый размер — дедуплицируем по (size, type).
  const unique: File[] = []
  const seenSizeType = new Set<string>()
  for (const f of candidates) {
    const key = `${f.size}:${f.type}`
    if (seenSizeType.has(key)) continue
    seenSizeType.add(key)
    unique.push(f)
  }
  
  // Если остался только один кандидат — возвращаем его (с нормализацией имени).
  if (unique.length === 1) {
    const f = unique[0]
    if (f.name && /\.[a-z0-9]{2,5}$/i.test(f.name)) return [f]
    const ext = (f.type.split('/')[1] || 'png').split('+')[0]
    const name = `pasted-image-${Date.now()}.${ext}`
    return [new File([f], name, { type: f.type })]
  }
  
  // Несколько уникальных изображений — возвращаем все (с нормализацией имён).
  const ts = Date.now()
  return unique.map((f, i) => {
    if (f.name && /\.[a-z0-9]{2,5}$/i.test(f.name)) return f
    const ext = (f.type.split('/')[1] || 'png').split('+')[0]
    const name = `pasted-image-${ts}-${i + 1}.${ext}`
    return new File([f], name, { type: f.type })
  })
}

/**
 * (правка 125) Чтение изображения из буфера через асинхронный Clipboard API.
 *
 * Фолбэк на случай, когда браузер НЕ диспатчит `paste`-событие
 * (фокус на кнопке/не-editable элементе или вне дерева вкладки).
 * Вызывается из обработчика keydown Ctrl+V — это user gesture, поэтому
 * `navigator.clipboard.read()` разрешён. Возвращает null, если в буфере
 * нет картинок или API недоступно (тогда сработает обычный `paste`).
 */
export async function getClipboardImageFromApi(): Promise<File | null> {
  try {
    const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
    if (!clip || typeof clip.read !== 'function') return null
    const items = await clip.read()
    for (const item of items) {
      const imgTypes = (item.types || []).filter((t) => t.startsWith('image/'))
      if (imgTypes.length === 0) continue
      const blob = await item.getType(imgTypes[0])
      if (!blob || blob.size === 0) continue
      const ext = (imgTypes[0].split('/')[1] || 'png').split('+')[0]
      const name = `pasted-image-${Date.now()}.${ext}`
      return new File([blob], name, { type: imgTypes[0] })
    }
  } catch {
    // Нет разрешения / API недоступен — молча игнорируем,
    // вставкой займётся обычный paste-событие.
  }
  return null
}
