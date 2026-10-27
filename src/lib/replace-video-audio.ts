/**
 * Замена аудиодорожки сгенерированного видео на оригинальную.
 *
 * FLF всегда подставляет оригинальную дорожку, если есть аудио-реф;
 * ref-режим — только по галочке «сохранить оригинальный звук и вести по
 * нему» (флаг keep_original_audio). По завершении генерации подставляем
 * дорожку из ComfyUI input/, ОБРЕЗАННУЮ по trim_start/trim_end рефа
 * (ffmpeg -ss/-t) и по длительности видео (ffmpeg -t).
 *
 * Используется в finalizePendingMeta (pending-meta.ts).
 */
import { promisify } from 'util'
import { execFile } from 'child_process'
import fs from 'fs'
import path from 'path'
import { resolveFfmpeg } from '@/lib/thumb'
import { probeVideoFile } from '@/lib/video-probe'
import { getAppConfig } from '@/lib/app-config'

const execFileAsync = promisify(execFile)

/** Обрезка аудио-рефа, секунды (end null/0 = до конца файла). */
export interface AudioSwapTrim {
  start?: number
  end?: number | null
}

/**
 * Replace the audio track of `videoPath` with `audioPath`, applying the
 * reference's trim window (`trim`) and cutting the result to the video's
 * duration. In-place (atomic via temp file + rename).
 *
 * Returns true on success, false on failure (caller should not block on it).
 * The video file is only overwritten if the new mux succeeds.
 */
export async function replaceVideoAudio(
  videoPath: string,
  audioPath: string,
  trim?: AudioSwapTrim,
): Promise<boolean> {
  try {
    // 1) Probe the video's duration — this is our -t target.
    const probe = await probeVideoFile(videoPath)
    const videoDur = probe.durationSec
    if (!Number.isFinite(videoDur) || videoDur <= 0) {
      console.warn('[replace-audio] video duration probe failed, skipping')
      return false
    }

    // 2) Verify the audio file exists and is non-empty.
    const audioStat = fs.statSync(audioPath)
    if (audioStat.size === 0) {
      console.warn('[replace-audio] audio file is empty, skipping')
      return false
    }

    // 2b) (правка 728) Окно обрезки рефа: start>0 → ffmpeg -ss; end>start →
    // ограничиваем длительность окна. end null/0/<=start = до конца файла
    // (та же семантика, что у MiniMaxStudioAudioTrim).
    const trimStart = Number.isFinite(trim?.start) && (trim?.start ?? 0) > 0 ? trim!.start! : 0
    const trimEnd =
      Number.isFinite(trim?.end) && (trim!.end as number) > trimStart ? (trim!.end as number) : null
    const windowSec = trimEnd !== null ? trimEnd - trimStart : null
    const outDur = windowSec !== null ? Math.min(videoDur, windowSec) : videoDur
    if (outDur <= 0) {
      console.warn('[replace-audio] trim window is beyond video duration, skipping')
      return false
    }

    // 3) Build the ffmpeg command:
    //    -i video  [-ss <trimStart>] -i audio   (-ss ДО -i — seek на входе)
    //    -map 0:v:0  (video stream from input 0, copy)
    //    -map 1:a:0  (audio stream from input 1)
    //    -c:v copy   (don't re-encode video)
    //    -c:a aac -b:a 192k  (re-encode audio to AAC 192k — safe container)
    //    -t <min(videoDur, окно)>  (trim audio; applied to output)
    //    -movflags +faststart  (web-friendly)
    //    -y  (overwrite)
    //    <tmpPath>
    const ffmpeg = await resolveFfmpeg()
    if (!ffmpeg) {
      console.warn('[replace-audio] ffmpeg not found, skipping')
      return false
    }

    const dir = path.dirname(videoPath)
    const base = path.basename(videoPath)
    const ext = path.extname(base)
    const tmpPath = path.join(dir, `__replace_audio_${Date.now().toString(36)}${ext}`)

    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-i', videoPath,
      ...(trimStart > 0 ? ['-ss', String(Number(trimStart.toFixed(3)))] : []),
      '-i', audioPath,
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-c:v', 'copy',
      '-c:a', 'aac', '-b:a', '192k',
      '-t', String(Number(outDur.toFixed(3))),
      '-movflags', '+faststart',
      '-shortest',  // safety: stop when the shorter stream ends
      '-y',
      tmpPath,
    ]

    await execFileAsync(ffmpeg, args, {
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    })

    // 4) Atomic swap: rename tmp over the original.
    fs.renameSync(tmpPath, videoPath)
    return true
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string }
    const stderr = e?.stderr || e?.message || String(err)
    console.error('[replace-audio] FAILED:', stderr.slice(0, 800))
    return false
  }
}

/**
 * Given a pending-meta entry's params, decide whether to swap in the
 * original audio. Returns the audio path + trim window to use, or null if
 * no swap is needed.
 *
 * FLF historically swapped automatically whenever an audio ref was present.
 * Ref-режим делает это только при явном keep_original_audio (галочка
 * «аудио-гайд + оригинальный звук»).
 */
export interface OriginalAudioReplacement {
  path: string
  trimStart?: number
  trimEnd?: number | null
}

export function resolveOriginalAudioReplacement(
  params: Record<string, unknown>,
): OriginalAudioReplacement | null {
  if (params.generation_mode !== 'flf' && params.keep_original_audio !== true) return null
  const references = params.references as
    | Array<{ type?: string; path?: string; trim_start?: number; trim_end?: number | null }>
    | undefined
  if (!Array.isArray(references)) return null
  // Pick the FIRST audio reference (the user's original audio).
  const audioRef = references.find((r) => r?.type === 'audio' && typeof r?.path === 'string' && r.path.length > 0)
  if (!audioRef?.path) return null

  // Resolve to a concrete file on disk.
  const cfg = getAppConfig()
  const inputDir = cfg.inputDir
  if (!inputDir) return null
  const candidate = path.join(inputDir, path.basename(audioRef.path))
  if (!fs.existsSync(candidate)) {
    console.warn(`[replace-audio] audio ref not found: ${candidate}`)
    return null
  }
  // (правка 728) Обрезка рефа из меты — её подаём в мукс, иначе в финальный
  // файл ляжет весь оригинал с нуля, несмотря на выставленный трим.
  return {
    path: candidate,
    ...(typeof audioRef.trim_start === 'number' && { trimStart: audioRef.trim_start }),
    ...(typeof audioRef.trim_end === 'number' && { trimEnd: audioRef.trim_end }),
  }
}
