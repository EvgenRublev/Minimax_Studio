'use client'

/**
 * (правка 955) Применяет сохранённый язык интерфейса после гидратации.
 *
 * Стартовый рендер всегда русский (как и SSR-разметка) — иначе React ругался бы
 * на несовпадение текста при гидратации. Этот компонент монтируется первым и
 * переключает язык на тот, что выбран в настройках; react-i18next перерисовывает
 * все компоненты, использующие useTranslation().
 */
import { useEffect } from 'react'
import { applyStoredLang } from '@/lib/i18n'

export function I18nBridge() {
  useEffect(() => {
    void applyStoredLang()
  }, [])
  return null
}
