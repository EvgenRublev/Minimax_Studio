/**
 * (правка 955) Серверная половина i18n — для текстов, которые рождаются на
 * сервере (ошибки и статусы API-роутов, сообщения Electron-обёртки), чтобы они
 * совпадали с языком интерфейса.
 *
 * Язык берётся из зеркала настроек (data/settings/h3-simple-prefs.json, см.
 * settings-mirror.ts и prefs-sync.ts): клиент пишет туда 'h3-ui-lang' при
 * смене языка, поэтому сервер видит выбор без запроса и без состояния в памяти.
 *
 * Важно: единственный экземпляр i18next на сервере НИКОГДА не переключается
 * через changeLanguage — язык передаётся в каждый вызов t({ lng }), иначе
 * параллельные запросы показывали бы тексты чужого языка.
 */
import i18n from 'i18next'
import type { TOptions } from 'i18next'
import { readMirror } from '@/lib/settings-mirror'
import { DEFAULT_LANG, LANG_KEY, normalizeLang, type Lang } from './config'
import { enMessages } from './messages/en'

/** Ключ зеркала простых предпочтений — синхронизирован с prefs-sync.ts. */
const PREFS_MIRROR_KEY = 'h3-simple-prefs'

let inited = false
function ensureServerI18n(): void {
  if (inited) return
  i18n.init({
    lng: DEFAULT_LANG,
    fallbackLng: DEFAULT_LANG,
    supportedLngs: ['ru', 'en'],
    resources: {
      ru: { translation: {} },
      en: { translation: enMessages },
    },
    keySeparator: false,
    nsSeparator: false,
    returnEmptyString: false,
  })
  inited = true
}

/** Язык, выбранный пользователем (из зеркала); DEFAULT_LANG — если зеркала нет. */
export function serverLang(): Lang {
  try {
    const snap = readMirror(PREFS_MIRROR_KEY)
    const data = snap?.data as Record<string, unknown> | undefined
    const v = data?.[LANG_KEY]
    if (typeof v === 'string' && normalizeLang(v) === 'en') return 'en'
  } catch { /* нет файла/битое зеркало — заводской язык */ }
  return DEFAULT_LANG
}

/** Перевод серверного текста на язык пользователя. */
export function st(key: string, options: TOptions = {}): string {
  ensureServerI18n()
  return i18n.t(key, { ...options, lng: serverLang() })
}

/** Перевод с явным языком (когда язык уже известен из запроса/контекста). */
export function stLang(lang: Lang, key: string, options: TOptions = {}): string {
  ensureServerI18n()
  return i18n.t(key, { ...options, lng: normalizeLang(lang) })
}
