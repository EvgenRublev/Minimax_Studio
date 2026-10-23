/**
 * (правка 493) «Сжать видео» для видео-референсов вкладки «Генерация».
 *
 * Референс-видео грузится в conditioning целиком — в исходном разрешении
 * это лишние токены и VRAM, а для якоря движения/сцены 480p почти всегда
 * достаточно. По флагу compress роут /api/comfy/generate прогоняет файл
 * через ffmpeg: короткая сторона → 480 px (пропорции сохраняются, чётность
 * через -2), звук перекодируется в aac (дорожка нужна, если стоит
 * «использовать звук видео»).
 *
 * Кэш: имя выхода ref480_<stem>_<hash8>.mp4, hash = путь|размер|mtime —
 * повторные генерации с тем же референсом не перекодируют. Исходники
 * ≤480p по короткой стороне возвращаются как есть (апскейл не делаем).
 */
import { promises as fs } from 'fs'
import { existsSync } from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { getAppConfig } from './app-config'
import { resolveFfmpeg } from './thumb'
import { probeVideoFile } from './video-probe'

const execFileAsync = promisify(execFile)

/** Возвращает имя файла в ComfyUI input/ (сжатая копия или исходник). */
export async function compressRefVideo480(fileName: string): Promise<string> {
  const cfg = getAppConfig()
  const base = path.basename(fileName)
  const srcPath = path.join(cfg.inputDir, base)
  if (!existsSync(srcPath)) {
    throw new Error(`файл не найден в input: ${base}`)
  }
  const probe = await probeVideoFile(srcPath)
  const shortSide = Math.min(probe.width, probe.height)
  if (shortSide > 0 && shortSide <= 480) {
    return base // уже ≤480p — перекодирование только потеряет качество
  }
  const st = await fs.stat(srcPath)
  const hash = createHash('sha1')
    .update(`${srcPath}|${st.size}|${Math.round(st.mtimeMs)}`)
    .digest('hex')
    .slice(0, 8)
  const stem = path.basename(base, path.extname(base)).replace(/[^\w.-]+/g, '_').slice(0, 40)
  const outName = `ref480_${stem}_${hash}.mp4`
  const outPath = path.join(cfg.inputDir, outName)
  if (existsSync(outPath)) return outName // кэш — тот же источник уже сжат
  const ffmpeg = await resolveFfmpeg()
  if (!ffmpeg) throw new Error('FFmpeg недоступен')
  // Ландшафт: высота 480, ширина авто (-2 = чётная). Портрет — наоборот.
  const scale = probe.width >= probe.height ? '-2:480' : '480:-2'
  await execFileAsync(
    ffmpeg,
    [
      '-hide_banner', '-loglevel', 'error', '-i', srcPath,
      '-map', '0:v:0', '-map', '0:a?',
      '-vf', `scale=${scale}`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart', '-y', outPath,
    ],
    { timeout: 300_000, maxBuffer: 8 * 1024 * 1024 },
  )
  return outName
}
