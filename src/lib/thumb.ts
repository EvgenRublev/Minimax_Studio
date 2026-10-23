/**
 * Server-side thumbnail pipeline shared by the file-serving routes.
 *
 * - images → sharp resize (mozjpeg)
 * - videos → ffmpeg poster frame (~1 s), scaled to width
 * - disk cache: <outputDir>/.thumbs/<width>/<sha1>.jpg, invalidated by
 *   the source file's mtime
 * - in-flight dedupe so parallel grid requests generate each thumb once
 */
import { promises as fs, existsSync } from 'fs'
import path from 'path'
import { getAppConfig } from './app-config'
import { execFile } from 'child_process'
import { promisify } from 'util'
import crypto from 'crypto'
import sharp from 'sharp'

const execFileAsync = promisify(execFile)

export const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.avif'])
export const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.avi', '.mkv', '.m4v'])

export function thumbKind(ext: string): 'image' | 'video' | null {
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (VIDEO_EXTS.has(ext)) return 'video'
  return null
}

/** Resolve the on-disk output directory (runtime-configurable backend folder). */
export function outputDir(): string {
  return getAppConfig().outputDir
}

/** Safe local path for an output file, or null when it escapes the dir. */
export function safeOutputPath(filename: string): string | null {
  const root = outputDir()
  const resolved = path.resolve(root, filename)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null
  return resolved
}

const inflight = new Map<string, Promise<Buffer>>()

/** Cached ffmpeg path: null = unchecked, else binary. «Не найден» не
 *  кэшируется — повторяем поиск при следующем обращении (правка 355). */
let ffmpegBin: string | null = null

/**
 * ffmpeg shipped in the project's portable runtime/ folder (static build,
 * ffmpeg+ffprobe pair). Preferred over PATH so video prep and the MTMD
 * video helper (which needs the same pair) always use the same binaries.
 */
function runtimeFfmpeg(): string {
  for (const d of [
    path.join(process.cwd(), 'runtime', 'ffmpeg'),
    path.join(getAppConfig().comfyRoot, '..', 'runtime', 'ffmpeg'),
  ]) {
    const bin = path.join(d, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
    if (existsSync(bin)) return bin
  }
  return ''
}

/**
 * ffmpeg shipped inside the portable ComfyUI bundle (imageio_ffmpeg).
 * Keeps video posters working on machines WITHOUT ffmpeg in PATH.
 */
async function bundledFfmpeg(): Promise<string> {
  try {
    const dir = path.join(
      getAppConfig().comfyRoot,
      'python_embeded', 'Lib', 'site-packages', 'imageio_ffmpeg', 'binaries',
    )
    const names = await fs.readdir(dir)
    const hit = names.find((n) => /^ffmpeg-.*\.exe$/i.test(n))
    return hit ? path.join(dir, hit) : ''
  } catch {
    return ''
  }
}

async function resolveFfmpeg(): Promise<string> {
  if (ffmpegBin !== null) return ffmpegBin
  const candidates = [
    process.env.FFMPEG_PATH,
    runtimeFfmpeg(),
    'ffmpeg',
    await bundledFfmpeg(),
  ].filter(Boolean) as string[]
  for (const bin of candidates) {
    try {
      await execFileAsync(bin, ['-version'], { timeout: 10_000 })
      ffmpegBin = bin
      return bin
    } catch {
      /* try next */
    }
  }
  // (правка 355) «Не найден» НЕ кэшируем навсегда: ffmpeg могли доустановить
  // (или подложить в runtime/) после первой проверки — повторяем поиск при
  // каждом обращении. Кэшируется только УСПЕШНЫЙ путь.
  return ''
}

export { resolveFfmpeg }

function cachePath(width: number, key: string): string {
  const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 20)
  return path.join(outputDir(), '.thumbs', String(width), `${hash}.jpg`)
}

/**
 * (правка 355) Удалить кэшированные превью файла из .thumbs по его cacheKey
 * (как строит /api/comfy/file: `output_[<sub>_]<basename>` или `input_<name>`).
 * Хэш зависит и от ширины, поэтому сканируем все <width>-подпапки.
 */
export async function deleteThumbsFor(cacheKey: string): Promise<void> {
  try {
    const root = path.join(outputDir(), '.thumbs')
    const widthDirs = await fs.readdir(root, { withFileTypes: true })
    await Promise.all(widthDirs.map(async (d) => {
      if (!d.isDirectory()) return
      const width = Number(d.name)
      if (!Number.isFinite(width)) return
      const target = cachePath(width, `${cacheKey}|${width}`)
      await fs.unlink(target).catch(() => {})
    }))
  } catch { /* нет кэша — не критично */ }
}

/** Extract a poster frame from a video with ffmpeg, scaled to `width`. */
async function videoPoster(source: string, width: number): Promise<Buffer> {
  const bin = await resolveFfmpeg()
  if (!bin) throw new Error('ffmpeg-not-available')
  const scale = `scale=${width}:-2`
  // Try a frame at 1s first; fall back to the very first frame for short clips.
  for (const seek of ['1', '0']) {
    try {
      const { stdout } = await execFileAsync(
        bin,
        ['-hide_banner', '-loglevel', 'error', '-ss', seek, '-i', source,
         '-frames:v', '1', '-vf', scale, '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '4', '-'],
        { timeout: 30_000, maxBuffer: 32 * 1024 * 1024, encoding: 'buffer' },
      ) as unknown as { stdout: Buffer }
      if (stdout?.length) return stdout
    } catch {
      /* try next seek */
    }
  }
  throw new Error('poster-extraction-failed')
}

/** Resize an image with sharp. */
async function imageThumb(source: string, width: number): Promise<Buffer> {
  return sharp(source).resize({ width, withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true }).toBuffer()
}

/**
 * Get a thumbnail buffer for an output file (cached on disk + in-flight).
 * Returns null when generation fails (caller should fall back to the full file).
 */
export async function getThumb(
  source: string,
  cacheKey: string,
  kind: 'image' | 'video',
  width: number,
): Promise<Buffer | null> {
  const key = `${cacheKey}|${width}`
  const cache = cachePath(width, key)

  // Serve from disk cache when fresh (source mtime not newer than cache mtime).
  try {
    const [srcStat, cacheStat] = await Promise.all([
      fs.stat(source), fs.stat(cache),
    ])
    if (cacheStat.mtimeMs >= srcStat.mtimeMs) {
      return fs.readFile(cache)
    }
  } catch {
    /* no cache yet — generate below */
  }

  let job = inflight.get(key)
  if (!job) {
    job = (async () => {
      const buf = kind === 'image'
        ? await imageThumb(source, width)
        : await videoPoster(source, width)
      await fs.mkdir(path.dirname(cache), { recursive: true })
      await fs.writeFile(cache, buf)
      return buf
    })()
    inflight.set(key, job)
    job.finally(() => inflight.delete(key)).catch(() => {})
  }
  try {
    return await job
  } catch {
    return null
  }
}
