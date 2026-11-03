'use client'

/**
 * (правка 804) Невидимый компонент: на старте сравнивает локальные простые
 * prefs (тема/масштаб/выделение/громкость/welcome) с серверным зеркалом и
 * применяет более свежую копию. Тема применяется через ThemeProvider,
 * остальное — прямым действием на <html> (как инлайн-скрипт в layout.tsx).
 */
import { useEffect } from 'react'
import { useTheme } from 'next-themes'
import { pullPrefs } from '@/lib/prefs-sync'

export function PrefsSync() {
  const { setTheme } = useTheme()

  useEffect(() => {
    // один раз на загрузку страницы; setTheme стабилен у next-themes
    void pullPrefs((t) => setTheme(t))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return null
}
