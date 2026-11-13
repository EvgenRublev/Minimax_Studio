/**
 * (правка 955) Клиентский i18n: инициализация, смена языка, доступ к переводу.
 *
 * Схема ключей — «естественный язык»: ключом является исходный русский текст,
 * поэтому:
 *   • ресурс для 'ru' пустой — i18next возвращает сам ключ, то есть незакрытая
 *     переводом строка показывается по-русски (заводское поведение: пропуск
 *     перевода не ломает интерфейс);
 *   • английский каталог — словарь «русский текст → английский текст».
 *
 * Разделители ключа/пространства имён выключены: в русском тексте есть точки,
 * двоеточия и переносы, и они не должны читаться как путь в объекте.
 *
 * Стартовый язык — ВСЕГДА заводской (русский), а сохранённый применяется уже
 * после гидратации (applyStoredLang в <I18nBridge>). Иначе первый клиентский
 * рендер отличался бы от SSR-разметки (она собирается с русским), и React
 * ругался бы на несовпадение гидратации на каждой строке интерфейса.
 *
 * Инициализация синхронная: словари импортируются прямо в бандл, бэкендов
 * подгрузки нет, поэтому перевод готов сразу после init(). Модуль импортируется
 * и компонентами, и модулями сторов, а dev-сервер перечитывает модули при
 * хот-релоаде — флаг на globalThis защищает от повторного init.
 */
import i18n from 'i18next'
import type { TOptions } from 'i18next'
import { initReactI18next } from 'react-i18next'
import { DEFAULT_LANG, LANG_KEY, getServerRenderLang, normalizeLang, type Lang } from './config'
import { enMessages } from './messages/en'

const GUARD = '__h3i18nInit' as const

function stored(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null // приватный режим — localStorage бросает исключение
  }
}

/**
 * Язык стартового рендера. Порядок:
 *   1) window.__h3lang — значение, подставленное инлайн-скриптом layout.tsx
 *      (оно же использовалось при SSR из зеркала настроек) — тогда клиентский
 *      первый рендер совпадает с серверной разметкой, гидратация чистая;
 *   2) localStorage — быстрый путь, когда сервер ещё не ответил;
 *   3) заводской язык.
 */
declare global {
  interface Window {
    __h3lang?: string
  }
}
export function readStoredLang(): Lang {
  // localStorage — первее: это прямой выбор пользователя в этом браузере.
  // window.__h3lang (из зеркала, вшитого сервером) — фолбэк, когда локального
  // значения ещё нет. Важно для статически отрендеренной «/»: в её HTML язык
  // зафиксирован на сборке и может устареть.
  const local = stored()?.getItem(LANG_KEY)
  if (local) return normalizeLang(local)
  if (typeof window !== 'undefined' && typeof window.__h3lang === 'string') {
    return normalizeLang(window.__h3lang)
  }
  return DEFAULT_LANG
}

/** Синхронная инициализация; безопасна при повторных вызовах (hot reload). */
export function ensureI18n(): typeof i18n {
  if (!(globalThis as Record<string, unknown>)[GUARD]) {
    void i18n.use(initReactI18next).init({
      // SSR клиентских компонентов: язык из зеркала (его задал layout.tsx),
      // в браузере: подставленный инлайн-скриптом / localStorage. Иначе
      // серверная разметка русская, клиентская английская — рассинхрон гидратации.
      lng: typeof window === 'undefined' ? getServerRenderLang() : readStoredLang(),
      fallbackLng: DEFAULT_LANG,
      supportedLngs: ['ru', 'en'],
      resources: {
        ru: { translation: {} },
        en: { translation: enMessages },
      },
      keySeparator: false,
      nsSeparator: false,
      // пусто́е значение в каталоге не должно «перекрывать» ключ
      returnEmptyString: false,
      interpolation: {
        // React сам экранирует подстановки — двойное экранирование испортило бы текст
        escapeValue: false,
      },
    })
    ;(globalThis as Record<string, unknown>)[GUARD] = true
  }
  return i18n
}

ensureI18n()

/** Текущий язык интерфейса. */
export function getLang(): Lang {
  return normalizeLang(i18n.resolvedLanguage ?? i18n.language)
}

/**
 * Перевод вне React (сторы, хуки, императивные тосты).
 * Компоненты используют useTranslation() — он перерисовывает их при смене языка.
 */
export function t(key: string | null | undefined, options: TOptions = {}): string {
  // null/undefined бывает у необязательных подписей из таблиц — показываем пусто
  if (!key) return ''
  return i18n.t(key, options)
}

/** Меняет язык «на лету», без перезагрузки окна; пишет выбор в localStorage. */
export async function setLang(lang: Lang): Promise<void> {
  const next = normalizeLang(lang)
  try {
    stored()?.setItem(LANG_KEY, next)
  } catch { /* приватный режим — язык поменяется только в этой сессии */ }
  if (typeof document !== 'undefined') document.documentElement.setAttribute('lang', next)
  await ensureI18n().changeLanguage(next)
}

/**
 * Применяет сохранённый язык после гидратации (вызывает <I18nBridge>).
 * Возвращает true, если язык действительно пришлось сменить.
 */
export async function applyStoredLang(): Promise<boolean> {
  const want = readStoredLang()
  if (want === getLang()) return false
  await setLang(want)
  return true
}

export default i18n
