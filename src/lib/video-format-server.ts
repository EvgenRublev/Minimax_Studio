/**
 * video-format-server (правка 386) — серверная половина настроек формата
 * видео: читает config.ini → [video]. Импортировать ТОЛЬКО из серверного
 * кода (роуты, minimax-h3-client) — модуль тянет fs через app-config.
 * Сам шаблонный ввод/аргументы — чистые функции в video-format.ts.
 */
import { getAppConfig } from './app-config'
import { normalizeVideoFormat, type VideoFormatSettings } from './video-format'

/** Текущие настройки формата из config.ini (с безопасными дефолтами). */
export function getVideoFormatSettings(): VideoFormatSettings {
  try {
    const cfg = getAppConfig() as {
      videoCodec?: unknown
      videoCrf?: unknown
      videoNvencBitrate?: unknown
    }
    return normalizeVideoFormat({
      codec: cfg.videoCodec,
      crf: cfg.videoCrf,
      nvencBitrate: cfg.videoNvencBitrate,
    })
  } catch {
    return { codec: 'h264', crf: 12, nvencBitrate: 16 }
  }
}
