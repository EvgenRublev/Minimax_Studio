/**
 * (правка 955) Язык интерфейса: константы, общие для клиента и сервера.
 *
 * Значение живёт в localStorage под ключом LANG_KEY и дублируется на сервер
 * общим снимком «простых предпочтений» (prefs-sync.ts, ключ h3-simple-prefs) —
 * той же механикой, что тема и масштаб UI. Серверным роутам язык нужен, чтобы
 * их тексты (ошибки, статусы) совпадали с языком интерфейса.
 *
 * Заводской язык — русский: при отсутствии значения (первый запуск, SSR,
 * приватный режим) везде возвращается DEFAULT_LANG.
 */
export const LANGS = ['ru', 'en'] as const
export type Lang = (typeof LANGS)[number]

/** Заводской язык интерфейса. */
export const DEFAULT_LANG: Lang = 'ru'

/** Ключ localStorage (и поле в снимке h3-simple-prefs). */
export const LANG_KEY = 'h3-ui-lang'

/** Любое значение (из localStorage, из зеркала, из шапки) → валидный Lang. */
export function normalizeLang(v: unknown): Lang {
  if (typeof v !== 'string') return DEFAULT_LANG
  const s = v.trim().toLowerCase()
  if (s === 'en' || s.startsWith('en-')) return 'en'
  if (s === 'ru' || s.startsWith('ru-')) return 'ru'
  return DEFAULT_LANG
}

/** Название языка для переключателя — всегда на своём языке, не переводится. */
export const LANG_NAMES: Record<Lang, string> = {
  ru: 'Русский',
  en: 'English',
}
