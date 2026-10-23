"use client"

import { useTheme } from "next-themes"
import { Toaster as Sonner, ToasterProps } from "sonner"

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()
  /* все тёмные темы (dark, dark-gray) → тёмный тостер */
  const sonnerTheme: ToasterProps["theme"] = theme === "light" ? "light" : "dark"

  return (
    <Sonner
      theme={sonnerTheme}
      className="toaster group"
      style={
        {
          /* (правка 717) Серая НЕПРОЗРАЧНАЯ плашка по теме приложения.
             Раньше фон задавался через color-mix(... , transparent) — тосты
             были полупрозрачными и просвечивали интерфейс. Теперь фон —
             сплошной --toast-surface (своя переменная каждой темы: светлая,
             тёмная, серая, «Студия»), рамка — --border, текст — --foreground.
             Тип тоста (ошибка/успех/…) читается по ЦВЕТУ ИКОНКИ — она
             красится через [data-sonner-toast][data-type=…] в globals.css.
             Плашка и кнопка закрытия описаны там же (см. [data-sonner-toast]). */
          "--normal-bg": "var(--toast-surface)",
          "--normal-text": "var(--foreground)",
          "--normal-border": "var(--border)",
          "--success-bg": "var(--toast-surface)",
          "--success-text": "var(--foreground)",
          "--success-border": "var(--border)",
          "--error-bg": "var(--toast-surface)",
          "--error-text": "var(--foreground)",
          "--error-border": "var(--border)",
          "--warning-bg": "var(--toast-surface)",
          "--warning-text": "var(--foreground)",
          "--warning-border": "var(--border)",
          "--info-bg": "var(--toast-surface)",
          "--info-text": "var(--foreground)",
          "--info-border": "var(--border)",
        } as React.CSSProperties
      }
      /* (правка 717) Компактный размер тоста. Размеры/скругление/фон/рамку/
         тень/кнопку закрытия переопределяет globals.css ([data-sonner-toast]).
         Tailwind-классы "!border !shadow-sm" убраны: они конфликтовали с
         нашими правилами по !important (порядок каскада не гарантирован). */
      toastOptions={{
        style: {
          fontSize: "12px",
          maxWidth: "300px",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
