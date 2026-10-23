/**
 * Media preparation for the LLM (Gemma 4 / Qwen3.5 omni via llama.cpp mtmd).
 *
 * The multimodal runtime accepts WHOLE videos (animation is understood
 * correctly) and audio tracks, but they must be cheap enough for the
 * context window:
 *   - video → downscaled MP4 (≤512px wide, fps capped) — every frame
 *     costs vision tokens, so fps is reduced while keeping motion readable;
 *   - audio → 16 kHz mono WAV (mtmd accepts wav/mp3 only).
 *
 * All outputs are temp files owned by the caller (route.ts cleans them up).
 */
import { execFile } from 'child_process'
import { promisify } from 'util'
import { promises as fs } from 'fs'
import path from 'path'
import { resolveFfmpeg } from './thumb'

const execFileAsync = promisify(execFile)

const FFMPEG_OPTS = { timeout: 180_000, maxBuffer: 64 * 1024 * 1024 } as const

export interface LlmVideoMedia {
  /** Downscaled, fps-capped, video-only MP4 (for the `video` content part). */
  videoPath: string
  /** 16 kHz mono WAV when the source has an audio track, else null. */
  audioPath: string | null
}

/**
 * Transcode a reference video for LLM vision input:
 * scale ≤ `width` px wide (no upscale), cap fps at `fps`.
 * Returns null when ffmpeg is unavailable or the transcode fails
 * (caller falls back to a text-only mention).
 */
export async function prepVideoForLlm(
  source: string,
  videoOut: string,
  audioOut: string,
  width = 512,
  fps = 8,
  // Ограничение длительности: 10-минутный реф на 8 fps = ~4800 кадров,
  // каждый стоит vision-токенов — токенизация шла бы часами и переполняла
  // контекст. 60 сек достаточно, чтобы понять содержание/динамику видео.
  maxDurationSec = 60,
): Promise<LlmVideoMedia | null> {
  const bin = await resolveFfmpeg()
  if (!bin) return null

  try {
    await execFileAsync(bin, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', source,
      '-an',
      '-vf', `scale=min(${width}\\,iw):-2,fps=${fps}`,
      '-t', String(maxDurationSec),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-pix_fmt', 'yuv420p',
      videoOut,
    ], FFMPEG_OPTS)
    await fs.access(videoOut)
  } catch {
    return null
  }

  // Optional audio track (`-map 0:a:0?` never fails on silent videos);
  // a header-only WAV (< ~100 bytes) means there was no audio.
  // Длительность ограничиваем той же границей, что и видео.
  let audioPath: string | null = null
  try {
    await execFileAsync(bin, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', source,
      '-map', '0:a:0?', '-vn',
      '-t', String(maxDurationSec),
      '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
      audioOut,
    ], FFMPEG_OPTS)
    const st = await fs.stat(audioOut).catch(() => null)
    if (st && st.size > 100) audioPath = audioOut
  } catch {
    /* no audio — fine */
  }

  return { videoPath: videoOut, audioPath }
}

/**
 * (правка 162) Извлечь кадры из видео для Bonsai (OpenAI-бэкенд не принимает
 * целые видео — только картинки). Возвращает массив путей к JPEG-кадрам.
 * (правка 163) 8 fps, 256px, до 48 кадров — модель видит движение и сцену,
 * а не только первый кадр.
 */
export async function extractVideoFrames(
  source: string,
  outDir: string,
  maxFrames = 48,   // 8 fps × 6 сек = 48 кадров — разумный лимит для LLM-контекста
  width = 256,      // небольшое разрешение — экономия памяти и токенов
  fps = 8,          // 8 кадров в секунду — модель понимает динамику
  maxDurationSec = 60,
): Promise<string[] | null> {
  const bin = await resolveFfmpeg()
  if (!bin) return null

  try {
    await fs.mkdir(outDir, { recursive: true })
    const pattern = path.join(outDir, 'frame_%03d.jpg')
    await execFileAsync(bin, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', source,
      '-t', String(maxDurationSec),
      '-vf', `scale=min(${width}\\,iw):-2,fps=${fps}`,
      '-frames:v', String(maxFrames),
      '-q:v', '4',
      pattern,
    ], FFMPEG_OPTS)
    // Собираем созданные кадры
    const files = await fs.readdir(outDir)
    const frames = files
      .filter((f) => /^frame_\d+\.jpg$/.test(f))
      .sort()
      .map((f) => path.join(outDir, f))
    return frames.length > 0 ? frames : null
  } catch {
    return null
  }
}

/* Транскодирование аудио-референса в 16 кГц моно WAV выполняется внутри
 * prepVideoForLlm — отдельного экспорта для этого не требуется. */

