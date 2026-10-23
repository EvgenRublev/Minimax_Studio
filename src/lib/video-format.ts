/**
 * video-format (правка 386) — ЕДИНЫЕ настройки кодирования видео-выходов
 * студии (config.ini → [video]). Применяются во ВСЕХ режимах:
 * генерация (draft/full), рефайн «Целый»/«Частями», продление
 * (комбинированный вывод и безыходные клипы), тайловый апскейл, FPS и
 * ffmpeg-пути (обрезка, склейка, сшивка).
 *
 * Кодеки (форматы VHS VideoHelperSuite, ffmpeg — те же энкодеры):
 *  • h264       — libx264, максимум совместимости (default)
 *  • h265       — libx265, файлы на ~30–50% меньше при том же CRF
 *  • nvenc_h264 — h264_nvenc, аппаратный энкодер NVIDIA (быстро, качество
 *                 задаётся битрейтом, не CRF)
 *  • nvenc_h265 — hevc_nvenc, то же + компактность
 *
 * Качество: CRF 0–30 (меньше = лучше; дефолт 12 — как было в студии).
 * Для nvenc — битрейт в Мбит/с (дефолт 16).
 *
 * МОДУЛЬ ЧИСТЫЙ (без fs/config): импортируется и клиентскими модулями
 * (шаблоны воркфлоу тянутся в use-video-gen ради framesForDuration).
 * Чтение config.ini — в video-format-server.ts (только сервер): роуты и
 * minimax-h3-client передают готовые настройки параметром videoFormat.
 */
export type VideoCodec = 'h264' | 'h265' | 'nvenc_h264' | 'nvenc_h265'

export const VIDEO_CODECS: VideoCodec[] = ['h264', 'h265', 'nvenc_h264', 'nvenc_h265']

export interface VideoFormatSettings {
  codec: VideoCodec
  /** CRF для программных кодеков (h264/h265), 0–30. */
  crf: number
  /** Битрейт для NVENC, Мбит/с (4–40). */
  nvencBitrate: number
}

export function normalizeVideoFormat(raw: {
  codec?: unknown
  crf?: unknown
  nvencBitrate?: unknown
}): VideoFormatSettings {
  const codec = VIDEO_CODECS.includes(raw.codec as VideoCodec)
    ? (raw.codec as VideoCodec)
    : 'h264'
  // (правка 587) crf=0 валиден (правка 556): дефолт 12 — только если значения
  // нет (undefined/null/пустая строка/NaN); || 12 молча превращал честный 0 в 12
  // (Number('') и Number(null) тоже 0, поэтому проверяем до преобразования).
  const emptyCrf = raw.crf === undefined || raw.crf === null ||
    (typeof raw.crf === 'string' && raw.crf.trim() === '')
  const crfNum = emptyCrf ? NaN : Number(raw.crf)
  const crf = Math.max(0, Math.min(30, Math.round(Number.isFinite(crfNum) ? crfNum : 12)))
  const nvencBitrate = Math.max(4, Math.min(40, Math.round(Number(raw.nvencBitrate) || 16)))
  return { codec, crf, nvencBitrate }
}

/**
 * Входы ноды VHS_VideoCombine для выбранного кодека/качества — спредом в
 * inputs воркфлоу (заменяют format/pix_fmt/crf/trim_to_audio).
 * Нюанс: trim_to_audio есть только у форматов, где он объявлен в JSON
 * (h264); h265/nvenc его не имеют — лишний вход роняет валидацию ноды.
 */
/** Дефолт (без настроек): прежнее поведение студии — h264 / CRF 12. */
export const DEFAULT_VIDEO_FORMAT: VideoFormatSettings = { codec: 'h264', crf: 12, nvencBitrate: 16 }

export function vhsEncodeInputs(fmt?: VideoFormatSettings): Record<string, unknown> {
  const f = fmt ?? DEFAULT_VIDEO_FORMAT
  switch (f.codec) {
    case 'h265':
      return { format: 'video/h265-mp4', pix_fmt: 'yuv420p', crf: f.crf }
    case 'nvenc_h264':
      return { format: 'video/nvenc_h264-mp4', pix_fmt: 'yuv420p', bitrate: f.nvencBitrate, megabit: true }
    case 'nvenc_h265':
      return { format: 'video/nvenc_h265-mp4', pix_fmt: 'yuv420p', bitrate: f.nvencBitrate, megabit: true }
    default:
      return { format: 'video/h264-mp4', pix_fmt: 'yuv420p', crf: f.crf, trim_to_audio: false }
  }
}

/**
 * Аргументы ffmpeg для кодирования видео (роуты trim/concat/stitch).
 * Вызывающий добавляет свой -preset и специфичные флаги (pix_fmt и т.п.).
 */
export function ffmpegVideoArgs(fmt?: VideoFormatSettings): string[] {
  const f = fmt ?? DEFAULT_VIDEO_FORMAT
  switch (f.codec) {
    case 'h265':
      return ['-c:v', 'libx265', '-crf', String(f.crf), '-tag:v', 'hvc1']
    case 'nvenc_h264':
      return ['-c:v', 'h264_nvenc', '-b:v', `${f.nvencBitrate}M`]
    case 'nvenc_h265':
      return ['-c:v', 'hevc_nvenc', '-b:v', `${f.nvencBitrate}M`, '-tag:v', 'hvc1']
    default:
      return ['-c:v', 'libx264', '-crf', String(f.crf)]
  }
}
