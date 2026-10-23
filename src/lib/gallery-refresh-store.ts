/**
 * Gallery refresh signal (правка 134).
 *
 * Галерея (Generate / Upscale / Gallery вкладки) подхватывает новые видео
 * через useVideoGallery — она подписывается на phase генерации. Но при
 * «Заводском сбросе» / «Удалении контента» видео удаляются на бэкенде,
 * а галерея не знает об этом — она перерисовывается только при переключении
 * вкладок (компонент unmount → mount → load() заново).
 *
 * Решение: лёгкий zustand-стор-сигнал. settings-dialog шлёт
 * `bump()` после сброса/удаления; useVideoGallery подписывается на
 * `version` и при изменении вызывает `load(true)` (background, без skeleton).
 */
import { create } from 'zustand'

interface GalleryRefreshState {
  /** Уникальный счётчик: при каждом bump++ все подписчики перезаряжают галерею. */
  version: number
  bump: () => void
}

export const useGalleryRefresh = create<GalleryRefreshState>()((set) => ({
  version: 0,
  bump: () => set((s) => ({ version: s.version + 1 })),
}))