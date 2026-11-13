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

/**
 * Язык для SSR-рендера клиентских компонентов (задаёт layout.tsx из зеркала
 * настроек; читает i18n-инициализация при работе на сервере). Без этого SSR
 * отдавал бы русскую разметку при сохранённом английском — рассинхрон гидратации.
 * Хранится на globalThis, чтобы config.ts не тянул fs-модули в браузерный бандл.
 */
export function setServerRenderLang(lang: Lang): void {
  ;(globalThis as Record<string, unknown>)[GSRK] = lang
}
export function getServerRenderLang(): Lang {
  const v = (globalThis as Record<string, unknown>)[GSRK]
  return typeof v === 'string' ? normalizeLang(v) : DEFAULT_LANG
}
const GSRK = '__h3serverLang'

/** Название языка для переключателя — всегда на своём языке, не переводится. */
export const LANG_NAMES: Record<Lang, string> = {
  ru: 'Русский',
  en: 'English',
}
