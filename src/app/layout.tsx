import type { Metadata, Viewport } from "next";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/sonner";
// (правка 562) тонкая шапка окна в Electron-режиме (в браузере не рендерится)
import { DesktopTitleBar } from "@/components/h3/desktop-titlebar";
import "./globals.css";

export const metadata: Metadata = {
  title: "MiniMax H3 Studio 7",
  description:
    "Генерация видео со звуком через MiniMax H3 на локальном ComfyUI",
  icons: [{ rel: "icon", url: "/logo.svg", type: "image/svg+xml" }],
};

export const viewport: Viewport = {
  themeColor: "#1c1c20",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru" suppressHydrationWarning>
      <body className="antialiased bg-background text-foreground flex flex-col">
        {/* (правка 562) Electron: шапка окна + контент колонкой. В браузере
            шапка не рендерится, обёртка flex-1 занимает всю высоту как раньше. */}
        <DesktopTitleBar />
        <div className="flex-1 min-h-0 flex flex-col">
          <ThemeProvider attribute="class" defaultTheme="dark-gray" enableSystem={false} themes={["dark", "dark-gray", "dark-calm"]}>
          {/* (правка 61) тема «Аврора» удалена; (правка 98) светлая тоже —
              если одна из них сохранена в браузере, миграция на дефолтную
              серую тему до первого рендера — иначе next-themes наложит
              несуществующий класс и страница откроется без темы.
              (правка 741) масштаб UI: 80% — только когда значения ещё нет
              (первый запуск). Раньше условие `s==='100'` подменяло осознанно
              выбранные 100% на 80%, и после перезапуска масштаб откатывался. */}
          <script
            suppressHydrationWarning
            dangerouslySetInnerHTML={{
              __html: `(function(){try{var k='theme';var t=localStorage.getItem(k);if(t==='aurora'||t==='light'){localStorage.setItem(k,'dark-gray');var d=document.documentElement;d.classList.remove('aurora','light');d.classList.add('dark-gray');}}catch(e){}try{var s=localStorage.getItem('h3-ui-scale');var v=(s==null)?'80':s;var p=parseInt(v,10);if(!isNaN(p))document.documentElement.style.fontSize=(p===100?'':p+'%');}catch(e){}try{if(localStorage.getItem('h3-selectable-text')==='1')document.documentElement.setAttribute('data-select-text','1');}catch(e){}})();`,
            }}
          />
          {children}
          </ThemeProvider>
          <Toaster position="bottom-center" richColors closeButton />
        </div>
      </body>
    </html>
  );
}
