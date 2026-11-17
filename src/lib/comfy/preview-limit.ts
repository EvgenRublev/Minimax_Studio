/**
 * (правка 1045) Предел preview_frames у KJNodes ModelPreviewOverrideKJ.
 *
 * Нода принимает INT 1..1024. Раньше Refine/Generation передавали туда
 * фактическое число кадров ролика; на длинном видео ComfyUI отклонял ВЕСЬ
 * воркфлоу:
 *   Value 2436 bigger than max of 1024 (preview_frames)
 *
 * Генерация при этом может быть любой длины — ограничение относится только
 * к анимированному превью. Считаем min(фактические кадры, лимит ноды).
 * 1024 кадра при 24 fps — максимум, который узел физически принимает;
 * генерация длиннее 5 минут от этого не ограничивается.
 */
export const PREVIEW_MAX_FRAMES = 1024

export function clampPreviewFrames(frames: number): number {
  return Math.max(1, Math.min(PREVIEW_MAX_FRAMES, Math.round(frames)))
}
