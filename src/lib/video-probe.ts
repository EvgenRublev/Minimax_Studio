/**
 * video-probe — ffprobe обёртка + планировщик кусков для refine «Частями».
 */
import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import path from 'path'
import { resolveFfmpeg } from '@/lib/thumb'

const execFileAsync = promisify(execFile)

/** ffprobe рядом с ffmpeg из resolveFfmpeg (runtime/ffmpeg — статическая пара). */
export async function resolveFfprobe(): Promise<string> {
  const ffmpeg = await resolveFfmpeg()
  if (ffmpeg) {
    const probe = path.join(path.dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
    if (existsSync(probe)) return probe
  }
  return process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
}

export interface VideoProbe {
  width: number
  height: number
  frames: number
  durationSec: number
  /** (правка 268) fps из r_frame_rate (default 24). */
  fps?: number
}

/**
 * (правка 783) Есть ли в файле аудиопоток. Возвращает null, если определить
 * не удалось (ffprobe недоступен/файл повреждён) — вызывающий должен считать
 * это «неизвестно» и сохранять прежнее поведение, а не «звука нет».
 * Нужен для видео-референсов H3: LoadAudio на видео без дорожки роняет
 * задачу уже в очереди ComfyUI (жалоба из чата).
 */
export async function probeHasAudio(file: string): Promise<boolean | null> {
  try {
    const ffprobe = await resolveFfprobe()
    const { stdout } = await execFileAsync(
      ffprobe,
      ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'json', file],
      { timeout: 15_000 },
    )
    const data = JSON.parse(stdout) as { streams?: unknown[] }
    return Array.isArray(data.streams) ? data.streams.length > 0 : false
  } catch {
    return null
  }
}

export async function probeVideoFile(file: string): Promise<VideoProbe> {
  const ffprobe = await resolveFfprobe()
  const { stdout } = await execFileAsync(
    ffprobe,
    [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,nb_frames,r_frame_rate,duration',
      '-of', 'json',
      file,
    ],
    { timeout: 20_000 },
  )
  const data = JSON.parse(stdout) as {
    streams?: Array<{
      width?: number
      height?: number
      nb_frames?: string
      r_frame_rate?: string
      duration?: string
    }>
  }
  const s = data.streams?.[0]
  if (!s?.width || !s?.height) {
    throw new Error('ffprobe не смог определить размеры видео')
  }
  let frames = parseInt(s.nb_frames ?? '', 10)
  if (!Number.isFinite(frames) || frames <= 0) {
    const fps = s.r_frame_rate ? parseInt(s.r_frame_rate.split('/')[0], 10) : 24
    const dur = parseFloat(s.duration ?? '')
    frames = Number.isFinite(dur) ? Math.round(dur * (fps || 24)) : 0
  }
  const durationSec = parseFloat(s.duration ?? '') || frames / 24
  // (правка 268) fps из r_frame_rate — нужен вкладке FPS (VFI), чтобы
  // вычислить целевой fps = исходный × multiplier. Default 24.
  let fps = 24
  if (s.r_frame_rate) {
    const [num, den] = s.r_frame_rate.split('/')
    const n = parseInt(num, 10)
    const d = parseInt(den, 10) || 1
    if (Number.isFinite(n) && n > 0) fps = n / d
  }
  return { width: s.width, height: s.height, frames, durationSec, fps: Math.max(1, Math.round(fps * 100) / 100) }
}

/* Планировщик кусков для refine «Частями» живёт в
 * src/lib/comfy/refine-template.ts (planChunkWindows) — здесь осталась
 * только обёртка над ffprobe. */
