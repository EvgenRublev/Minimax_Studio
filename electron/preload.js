/**
 * Preload — мост кнопок окна (правка 563).
 *
 * contextIsolation включён, nodeIntegration выключен: рендерер получает
 * ТОЛЬКО три метода управления окном через contextBridge, никакого доступа
 * к Node/IPC напрямую.
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('h3desktop', {
  minimize: () => ipcRenderer.send('h3:window-minimize'),
  maximizeToggle: () => ipcRenderer.send('h3:window-maximize-toggle'),
  close: () => ipcRenderer.send('h3:window-close'),
  // (правка 567) Панель «Консоль»: буфер вывода всех процессов приложения.
  console: {
    /** Полный накопленный лог (кольцевой буфер ~2 МБ). */
    get: () => ipcRenderer.invoke('h3:console-get'),
    /** Подписка на дополнения; возвращает отписку.
     *  (правка 588) Батч — список ОПЕРАЦИЙ ['a'|'r', text]: 'a' — дописать
     *  текст, 'r' — записать text с начала последней строки (терминальная
     *  эмуляция \r для прогресс-баров ComfyUI/tqdm). Порядок важен. */
    onAppend: (cb) => {
      const handler = (_e, ops) => cb(ops)
      ipcRenderer.on('h3:console-append', handler)
      return () => ipcRenderer.removeListener('h3:console-append', handler)
    },
    /** Нативный диалог «Сохранить как» → файл .txt. */
    save: (text) => ipcRenderer.invoke('h3:console-save', text),
  },
})
