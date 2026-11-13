/**
 * (правка 567) Типы preload-моста Electron (window.h3desktop из
 * electron/preload.js). В браузерном фолбэке моста нет — все поля optional.
 */
/** (правка 588) Операция консоли: 'a' — дописать текст, 'r' — записать text
 *  с начала последней строки (эмуляция \r: прогресс-бары ComfyUI/tqdm). */
export type ConsoleOp = ['a' | 'r', string]

export interface H3DesktopBridge {
  minimize: () => void
  maximizeToggle: () => void
  close: () => void
  /** (правка 790) «Перезапустить и установить»: запуск apply_update.ps1 и выход. */
  applyUpdate?: () => Promise<{ ok: boolean; error?: string }>
  /** (правка 868) полноэкранный режим окна (просмотр «Монтажа», F). */
  fullscreen?: (on: boolean) => void
  /** (правка 868) подписка на смену фулскрина (внешний вход/выход); отписка в return. */
  onFullscreenChange?: (cb: (on: boolean) => void) => () => void
  /** (правка 950) «Перезапустить ComfyUI» из «Консоли» (только Electron). */
  comfy?: {
    restart: () => Promise<{ ok: boolean; error?: string }>
  }
  console: {
    /** Полный накопленный лог (кольцевой буфер ~2 МБ). */
    get: () => Promise<string>
    /** Подписка на батч операций; возвращает функцию отписки. */
    onAppend: (cb: (ops: ConsoleOp[]) => void) => () => void
    /** Нативный диалог «Сохранить как» → .txt. */
    save: (text: string) => Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>
  }
}

declare global {
  interface Window {
    h3desktop?: H3DesktopBridge
  }
}
