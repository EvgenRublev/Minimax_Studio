'use client'

/**
 * (правка 869) Общий хук «настоящего» полноэкранного режима.
 *
 * CSS-оверлей на весь вьюпорт сам по себе таскбар не прячет: maximized-окно
 * Windows поверх таскбара не рисуется (на Win11 — особенно заметно). Поэтому
 * параллельно просим фулскрин у самого окружения:
 *  - Electron: preload-мост window.h3desktop.fullscreen (правка 868),
 *    внешний выход из фулскрина гасит флаг;
 *  - браузер: стандартный Fullscreen API документа; при отказе остаётся
 *    только CSS-оверлей (прежнее поведение).
 *
 * Используют: video-lightbox (Генерация/Галерея и др.) и «Монтаж» (F).
 */
import { useEffect } from 'react'
import { useCallback, useState } from 'react'

export function useFsFullscreen() {
  const [isFs, setIsFs] = useState(false)
  const toggleFs = useCallback(() => setIsFs((v) => !v), [])

  useEffect(() => {
    const d = window.h3desktop
    const setFs = d?.fullscreen
    if (setFs) {
      setFs(isFs)
      const off = d?.onFullscreenChange?.((on) => { if (!on) setIsFs(false) })
      return () => { if (isFs) setFs(false); off?.() }
    }
    if (isFs) {
      document.documentElement.requestFullscreen?.().catch(() => { /* CSS-оверлей и так работает */ })
    } else if (document.fullscreenElement) {
      document.exitFullscreen?.().catch(() => {})
    }
    const onFsChange = () => { if (!document.fullscreenElement) setIsFs(false) }
    document.addEventListener('fullscreenchange', onFsChange)
    return () => document.removeEventListener('fullscreenchange', onFsChange)
  }, [isFs])

  return { isFs, setIsFs, toggleFs }
}
