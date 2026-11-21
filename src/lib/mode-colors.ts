/**
 * (правка 1069) Единый источник цветов режимов.
 *
 * Раньше цвета жили в двух независимых копиях: `navItems` в сайдбаре и
 * `TYPE_ACCENT` в gen-queue-store. Копии разъехались — в очереди задач
 * ControlNet был темнее, Tile Upscale — янтарный вместо розового, Face Refine
 * — розовый вместо жёлтого, DLSS — фиолетовый вместо розового, Refine — на
 * оттенок светлее. Теперь сайдбар, очередь и мок-сайдбар в «Обучении» берут
 * цвет из одного места, и рассинхрон невозможен по построению.
 *
 * Ключи совпадают с `TabType` сайдбара (кроме music/sound — это типы задач
 * очереди, у них своих вкладок нет).
 */
export const MODE_COLOR = {
  generate: '#06B6D4',
  extend: '#06B6D4',
  refine: '#10B981',
  controlnet: '#FB923C',
  'tile-upscale': '#EC4899',
  fps: '#22D3EE',
  'face-refine': '#FACC15',
  upscale: '#F472B6',
  gallery: '#8B5CF6',
  montage: '#A78BFA',
  learn: '#10B981',
} as const

export type ModeColorKey = keyof typeof MODE_COLOR
