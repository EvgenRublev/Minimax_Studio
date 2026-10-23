/**
 * latent-file (правка 375/376) — работа с .latent-файлами пайплайна
 * «драфт → рефайн» (нода MiniMaxStudioSaveAVLatent, правка 372).
 *
 * Формат: safetensors с тензорами video_samples/audio_samples и JSON-шапкой
 * в metadata → {"minimax_av_latent": "{\"fps\":24,\"vae\":…,\"version\":1}"}.
 * Шапку читаем БЕЗ загрузки тензоров: safetensors кладёт длину JSON-хедера
 * в первые 8 байт (u64 LE), сам хедер — сразу за ними.
 *
 * Латент валиден только с тем же video-VAE: при смене VAE старые файлы
 * инвалидируются — проверяем имя в шапке против текущего VAELoader
 * (видео-VAE в проекте один: minimax_h3_video_vae_int8_convrot).
 */
import fs from 'fs'
import path from 'path'
import { getAppConfig } from '@/lib/app-config'

/** Имя video-VAE, которым собирает воркфлоу студия ('46:3' VAELoader). */
export const VIDEO_VAE_NAME = 'minimax_h3_video_vae_int8_convrot.safetensors'

export interface LatentHeader {
  fps: number
  vae: string
  version: number
}

export interface LatentCheck {
  ok: boolean
  reason?: string
  header?: LatentHeader
  /** Пиксельная канва латента (latent × 16, VAE_DOWNSAMPLE в узле
   *  апскейлера), число видео-токенов и аудио-шагов — из shape тензоров
   *  video_samples/audio_samples в шапке safetensors, без их загрузки. */
  dims?: { width: number; height: number; tokens: number; audioSteps: number }
}

/**
 * Проверить .latent-файл (путь относительно output/ ComfyUI) перед подачей
 * в refine: существует, внутри output/, safetensors-хедер распарсен, оба
 * тензора на месте, версия формата и VAE совпадают с текущими.
 * Тензоры НЕ читаем — это дешёвая проверка перед постановкой джоба.
 */
export function validateLatentFile(relPath: string): LatentCheck {
  const OUTPUT_DIR = getAppConfig().outputDir
  if (!OUTPUT_DIR || !relPath) return { ok: false, reason: 'не задан путь латента' }

  // (паттерн правки 348) resolve + нижний регистр на win32 — иначе
  // startsWith-проверка пропускала '..\' или чужой префикс с другим регистром.
  const root = path.resolve(OUTPUT_DIR)
  const full = path.resolve(root, relPath)
  const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p)
  if (norm(full) !== norm(root) && !norm(full).startsWith(norm(root) + path.sep)) {
    return { ok: false, reason: 'путь вне output/' }
  }

  let st: fs.Stats
  try {
    st = fs.statSync(full)
  } catch {
    return { ok: false, reason: 'файл латента не найден' }
  }
  if (!st.isFile() || st.size < 16) return { ok: false, reason: 'файл латента пуст/битый' }

  const fd = fs.openSync(full, 'r')
  try {
    const lenBuf = Buffer.alloc(8)
    fs.readSync(fd, lenBuf, 0, 8, 0)
    const headerLen = Number(lenBuf.readBigUInt64LE(0))
    if (!Number.isFinite(headerLen) || headerLen <= 0 || headerLen > 16 * 1024 * 1024) {
      return { ok: false, reason: 'битая шапка safetensors' }
    }
    const headBuf = Buffer.alloc(headerLen)
    fs.readSync(fd, headBuf, 0, headerLen, 8)
    const header = JSON.parse(headBuf.toString('utf-8')) as {
      video_samples?: { shape?: number[] }
      audio_samples?: { shape?: number[] }
      __metadata__?: Record<string, string>
    }
    if (!header.video_samples || !header.audio_samples) {
      return { ok: false, reason: 'в файле нет пары video/audio тензоров' }
    }
    // (правки 381/382) Пиксельная канва из shape: последние две размерности
    // видео-латента = (H_lat, W_lat), пиксели = латент × 16 (VAE_DOWNSAMPLE
    // узла MinimaxH3LatentUpscaler3D: VAE 8× + patch 2×). tokens = shape[-3],
    // аудио-шаги = последняя размерность аудио-латента (кадры × 5/3).
    const vShape = header.video_samples.shape
    const aShape = header.audio_samples.shape
    const dims =
      Array.isArray(vShape) && vShape.length >= 3 &&
      Number.isFinite(vShape[vShape.length - 1]) && Number.isFinite(vShape[vShape.length - 2])
        ? {
            width: Math.max(32, Math.round(vShape[vShape.length - 1] * 16)),
            height: Math.max(32, Math.round(vShape[vShape.length - 2] * 16)),
            tokens: Math.max(1, Math.round(vShape[vShape.length - 3] ?? 1)),
            audioSteps: Array.isArray(aShape) && aShape.length >= 1 && Number.isFinite(aShape[aShape.length - 1])
              ? Math.max(1, Math.round(aShape[aShape.length - 1]))
              : 0,
          }
        : undefined
    const raw = header.__metadata__?.minimax_av_latent
    if (typeof raw !== 'string') return { ok: false, reason: 'нет шапки minimax_av_latent' }
    const info = JSON.parse(raw) as LatentHeader
    if (info.version !== 1) return { ok: false, reason: `версия формата ${info.version} ≠ 1` }
    if (info.vae !== VIDEO_VAE_NAME) {
      return { ok: false, reason: `VAE латента (${info.vae}) не совпадает с текущим` }
    }
    return { ok: true, header: info, dims }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  } finally {
    fs.closeSync(fd)
  }
}
