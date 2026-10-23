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
