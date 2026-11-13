'use client'

/**
 * (правка 955) Перемонтирует контент при смене языка интерфейса.
 *
 * Компоненты с useTranslation() перерисовываются сами, но тексты, полученные
 * импортированным t() (сторы, утилиты форматирования), живут до ближайшей
 * перерисовки — без этого ключа после переключения языка половина экрана
 * оставалась на старом языке, пока пользователь куда-нибудь не нажмёт.
 * key={lang} — React пересоздаёт поддерево, и каждый t() выполняется заново.
 * Цена — сброс локального состояния вкладок при смене языка (операция редкая).
 */
import { useTranslation } from 'react-i18next'

export function AppLangKey({ children }: { children: React.ReactNode }) {
  const { i18n } = useTranslation()
  return <div className="flex flex-col flex-1 min-h-0" key={i18n.resolvedLanguage ?? i18n.language}>{children}</div>
}
