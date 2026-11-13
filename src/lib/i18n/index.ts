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
import { DEFAULT_LANG, LANG_KEY, normalizeLang, type Lang } from './config'
import { enMessages } from './messages/en'

const GUARD = '__h3i18nInit' as const

function stored(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null // приватный режим — localStorage бросает исключение
  }
}

/** Язык, который выбрал пользователь (localStorage); DEFAULT_LANG — если его нет. */
export function readStoredLang(): Lang {
  return normalizeLang(stored()?.getItem(LANG_KEY))
}

/** Синхронная инициализация; безопасна при повторных вызовах (hot reload). */
export function ensureI18n(): typeof i18n {
  if (!(globalThis as Record<string, unknown>)[GUARD]) {
    void i18n.use(initReactI18next).init({
      lng: DEFAULT_LANG,
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
