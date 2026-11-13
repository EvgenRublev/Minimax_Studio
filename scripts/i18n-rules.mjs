/**
 * (правка 955) Общие правила выемки строк для i18n-инструментов.
 *
 * Ключ — сам русский текст («естественные ключи»): ru-словарь пуст, i18next
 * возвращает ключ, поэтому пропущенный перевод = заводское поведение, а не
 * битая строка. Английский каталог — словарь «русский текст → перевод».
 */
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
export const ts = require('typescript')

export const CY = /[А-Яа-яЁё]/

/** Ключ нормализуем: переносы строк и кратные пробелы → один пробел. */
export function normKey(s) {
  return s.replace(/\s+/g, ' ').trim()
}

/** Атрибуты JSX, значение которых показывается пользователю. */
export const DISPLAY_ATTRS = new Set([
  'title', 'placeholder', 'alt', 'aria-label', 'label', 'tooltip',
  'description', 'message', 'error', 'hint', 'confirmLabel', 'cancelLabel',
  'okLabel', 'okText', 'cancelText', 'heading', 'caption', 'note', 'warning',
  'buttonText', 'emptyText', 'helpText', 'errorText', 'helperText',
])

/** Свойства объектов с показным текстом (конфиги вкладок, пунктов, статусов). */
export const DISPLAY_PROPS = new Set([
  'title', 'label', 'sub', 'subtitle', 'description', 'text', 'hint', 'message',
  'error', 'tooltip', 'placeholder', 'confirmLabel', 'cancelLabel', 'okLabel',
  'heading', 'caption', 'body', 'note', 'warning', 'summary', 'emptyText',
  'helpText', 'errorText', 'buttonText', 'actionLabel', 'titleAttr',
])

/** Вызовы, первый аргумент которых — пользовательский текст. */
export const DISPLAY_CALLS = new Set(['toast', 'alert'])
export const DISPLAY_TOAST_METHODS = new Set(['success', 'error', 'warning', 'info', 'message', 'custom'])

/** Строки-исключения: никогда не являются текстом для показа. */
export const SKIP_CALLS = new Set(['log', 'warn', 'error', 'debug', 'info', 'trace'])
