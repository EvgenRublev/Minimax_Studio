'use client'

/**
 * (правка 955) Переключатель языка интерфейса: Русский / English.
 *
 * Работает без перезапуска окна: setLang() меняет язык в i18next, а все
 * компоненты с useTranslation() перерисовываются. Выбор кладётся в localStorage
 * ('h3-ui-lang') и сразу уходит на сервер снимком простых предпочтений — сервер
 * читает его, чтобы ошибки и статусы API приходили на том же языке
 * (см. src/lib/i18n/server.ts).
 *
 * Название языка не переводится: «Русский» и «English» подписаны на своём
 * языке, чтобы переключатель оставался понятен в любом интерфейсе.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { LANGS, LANG_NAMES, type Lang } from '@/lib/i18n/config'
import { getLang, setLang } from '@/lib/i18n'
import { flushPrefs, pushPrefs } from '@/lib/prefs-sync'

export function LanguageSwitcher() {
  const { t } = useTranslation()
  // Стартовый язык серверного рендера — заводской; сохранённый применяется
  // после гидратации (I18nBridge), здесь до монтирования кнопку не показываем,
  // чтобы не мелькнул неверный вариант подсветки.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  if (!mounted) return <div className="h-8 w-[220px]" />

  const current = getLang()

  const apply = (lang: Lang) => {
    if (lang === current) return
    void setLang(lang)
    // язык нужен серверу немедленно: снимок prefs улетает без дебаунса
    pushPrefs()
    flushPrefs()
  }

  return (
    <div className="grid w-[220px] shrink-0 grid-cols-2 gap-1.5" aria-label={t('Язык интерфейса')}>
      {LANGS.map((lang) => (
        <button
          key={lang}
          type="button"
          onClick={() => apply(lang)}
          className={cn(
            'h-8 rounded-md border text-xs font-medium transition-colors',
            current === lang
              ? 'border-cyan-500/50 bg-cyan-500/15 text-cyan-300'
              : 'border-border bg-[var(--surface-1)] text-muted-foreground hover:border-cyan-500/30 hover:text-foreground',
          )}
        >
          {LANG_NAMES[lang]}
        </button>
      ))}
    </div>
  )
}
