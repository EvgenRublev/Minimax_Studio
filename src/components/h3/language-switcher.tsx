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
import { LanguagesIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { LANGS, LANG_NAMES, type Lang } from '@/lib/i18n/config'
import { getLang, setLang } from '@/lib/i18n'
import { flushPrefs, pushPrefs } from '@/lib/prefs-sync'

const btnBase = 'flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg border text-sm transition-all'
const btnActive = 'border-cyan-500/50 bg-cyan-500/10 text-foreground'
const btnIdle = 'border-border text-muted-foreground hover:border-border/80'

export function LanguageSwitcher({ first = false }: { first?: boolean }) {
  const { t } = useTranslation()
  // Стартовый язык серверного рендера — заводской; сохранённый применяется
  // после гидратации (I18nBridge), здесь до монтирования кнопку не показываем,
  // чтобы не мелькнул неверный вариант подсветки.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  if (!mounted) return <div className="h-10" />

  const current = getLang()

  const apply = (lang: Lang) => {
    if (lang === current) return
    void setLang(lang)
    // язык нужен серверу немедленно: снимок prefs улетает без дебаунса
    pushPrefs()
    flushPrefs()
  }

  return (
    <div className={cn('space-y-2', !first && 'pt-2 border-t border-border')}>
      <div className="flex items-center gap-2">
        <LanguagesIcon className="w-4 h-4 text-cyan-400" />
        <span className="text-sm font-medium">{t('Язык интерфейса')}</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {LANGS.map((lang) => (
          <button
            key={lang}
            type="button"
            onClick={() => apply(lang)}
            className={cn(btnBase, current === lang ? btnActive : btnIdle)}
          >
            {LANG_NAMES[lang]}
          </button>
        ))}
      </div>
      <p className="text-[10px] text-muted-foreground/60 leading-relaxed">
        {t('Применяется сразу, без перезапуска. Переведены интерфейс, уведомления и сообщения сервера; тексты раздела «Обучение», справочник промптов и ответы Ассистента остаются на русском.')}
      </p>
    </div>
  )
}
