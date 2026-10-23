'use client'

/**
 * DesktopTitleBar — тонкая шапка окна вместо нативного заголовка Windows
 * (правка 562; кнопки — правка 563). Работает ТОЛЬКО внутри Electron-окна:
 *   • electron/main.js ставит titleBarStyle:'hidden' — нативных кнопок нет;
 *   • свои HTML-кнопки управляют окном через preload-IPC (window.h3desktop):
 *     без фоновой плашки, в теме приложения, с hover-подсветкой;
 *   • на заставке (/splash) — ТОЛЬКО маленькая кнопка закрытия; в самом
 *     приложении — все три (свернуть/развернуть/закрыть);
 *   • вся полоса — область перетаскивания окна (-webkit-app-region: drag,
 *     класс .h3-titlebar в globals.css), двойной клик = максимизация;
 *   • в обычном браузере (фолбэк start.bat без Electron) не рендерится.
 *
 * Фон шапки — константа #1c1c20: единый «хром» окна во всех темах;
 * контент ниже живёт своей темой.
 */
import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { MinusIcon, SquareIcon, XIcon } from 'lucide-react'

const isElectron = () =>
  typeof navigator !== 'undefined' && /electron/i.test(navigator.userAgent)

/** Кнопка окна: без фона, тонкий глиф, мягкая hover-подсветка. */
function CaptionButton({
  onClick,
  title,
  children,
  danger,
}: {
  onClick: () => void
  title: string
  children: React.ReactNode
  danger?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={
        'h3-no-drag h-full w-11 flex items-center justify-center text-[#8b8b94] transition-colors ' +
        (danger
          ? 'hover:bg-red-500/80 hover:text-white'
          : 'hover:bg-white/10 hover:text-white')
      }
    >
      {children}
    </button>
  )
}

export function DesktopTitleBar() {
  // SSR/гидратация: userAgent на сервере не Electron → рендерим после mount.
  const [show, setShow] = useState(false)
  useEffect(() => setShow(isElectron()), [])
  const pathname = usePathname()
  if (!show) return null

  const api = (window as Window & typeof globalThis & {
    h3desktop?: { minimize: () => void; maximizeToggle: () => void; close: () => void }
  }).h3desktop
  if (!api) return null

  // (правка 563) Заставка ждёт бэкенд — только закрытие, маленькое.
  const isSplash = pathname === '/splash'

  return (
    <header
      className="h3-titlebar h-9 shrink-0 flex items-center gap-2.5 pl-3 bg-[#1c1c20] border-b border-black/40 select-none"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      onDoubleClick={() => api.maximizeToggle()}
    >
      <img src="/logo.svg" alt="" width={16} height={16} className="shrink-0" draggable={false} />
      <span className="text-[11px] font-medium tracking-wide text-[#8b8b94] select-none">
        MiniMax H3 Studio 7
      </span>
      <span className="flex-1" />

      {isSplash ? (
        /* Заставка: только маленький крестик. */
        <button
          type="button"
          onClick={() => api.close()}
          title="Закрыть"
          className="h3-no-drag h-7 w-8 mr-1 flex items-center justify-center rounded-md text-[#8b8b94] hover:bg-red-500/80 hover:text-white transition-colors"
        >
          <XIcon className="w-3.5 h-3.5" />
        </button>
      ) : (
        /* Приложение: свернуть / развернуть / закрыть. */
        <div className="h-full flex items-stretch">
          <CaptionButton onClick={() => api.minimize()} title="Свернуть">
            <MinusIcon className="w-3.5 h-3.5" />
          </CaptionButton>
          <CaptionButton onClick={() => api.maximizeToggle()} title="Развернуть / восстановить">
            <SquareIcon className="w-3 h-3" />
          </CaptionButton>
          <CaptionButton onClick={() => api.close()} title="Закрыть" danger>
            <XIcon className="w-4 h-4" />
          </CaptionButton>
        </div>
      )}
    </header>
  )
}
