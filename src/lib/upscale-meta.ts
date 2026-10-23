/**
 * Метаданные результатов апскейла (правка 94).
 *
 * Видео, созданные DLSS-мостом (нейрорендеринг «…_DLSS5_…») и настоящим
 * апскейлом (RTX Video SDK «…_RTXVIDEO_…»), падают в общий output ComfyUI
 * напрямую из bridge — сайдкар .meta.json для них никто не пишет, поэтому
 * в галерее у них нет «инфо о файле» (диалог метаданных пуст).
 *
 * Здесь: ffprobe (тот же бинарник, что и для превью) достаёт разрешение,
 * длительность, fps и размер — и пишет плоский сайдкар рядом с файлом,
 * в той же схеме, что читает MetaDialog.
 *
 * (правка 265) Если известен исходник (sourceHint от bridge) и рядом с ним
 * в output есть сайдкар — наследуем цепочку промптов (prompt, включая
 * extend-цепочки через promptChainFromMeta) и image-референсы (references).
 */
import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs'
import path from 'path'
import { getAppConfig } from './app-config'
import { promptChainFromMeta } from './refine-meta'

const execFileAsync = promisify(execFile)

/** Определить «инструмент» по имени файла (маркеры те же, что в галерее). */
export function upscaleToolFor(filename: string): string {
  if (/_RTXVIDEO(?:_PREVIEW)?_\d{8}-\d{6}/i.test(filename)) {
    return 'RTX Video Super Resolution (апскейл)'
  }
  if (/_DLSS5_\d{8}-\d{6}/i.test(filename)) {
    return 'DLSS 5 Visual Enhancer (нейрорендеринг)'
  }
  return 'Upscale (DLSS-мост)'
}

/* ── ffprobe: тот же порядок поиска, что у ffmpeg в thumb.ts ── */

let ffprobeBin: string | null = null

function resolveFfprobeSync(): string {
  const ext = process.platform === 'win32' ? '.exe' : ''
  const runtimeDir = path.join(process.cwd(), 'runtime', 'ffmpeg')
  const candidates = [
    process.env.FFPROBE_PATH,
    path.join(runtimeDir, `ffprobe${ext}`),
    'ffprobe',
  ].filter(Boolean) as string[]
  for (const bin of candidates) {
    if (existsSync(bin) || !bin.includes(path.sep)) return bin
  }
  return ''
}

async function resolveFfprobe(): Promise<string> {
  if (ffprobeBin !== null) return ffprobeBin
  const bin = resolveFfprobeSync()
  if (!bin) {
    // (правка 587) «не найден» НЕ кэшируем (как resolveFfmpeg, правка 355):
    // ffprobe могли подложить в runtime/ позже — повторяем поиск.
    return ''
  }
  try {
    await execFileAsync(bin, ['-version'], { timeout: 10_000 })
    ffprobeBin = bin
    return bin
  } catch {
    return '' // (правка 587) неудача не кэшируется
  }
}

interface ProbeResult {
  width?: number
  height?: number
  fps?: number
  duration?: number
  /** (правка 722) Число кадров — из nb_frames (fallback: fps × duration). */
  frames?: number
}

async function probeVideo(file: string): Promise<ProbeResult> {
  const bin = await resolveFfprobe()
  if (!bin) return {}
  try {
    const { stdout } = await execFileAsync(
      bin,
      [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height,avg_frame_rate,nb_frames',
        '-show_entries', 'format=duration',
        '-of', 'json',
        file,
      ],
      { timeout: 15_000 },
    )
    const j = JSON.parse(stdout) as {
      streams?: Array<{ width?: number; height?: number; avg_frame_rate?: string; nb_frames?: string }>
      format?: { duration?: string }
    }
    const s = j.streams?.[0]
    const out: ProbeResult = {}
    if (s?.width && s?.height) {
      out.width = s.width
      out.height = s.height
    }
    if (s?.avg_frame_rate && s.avg_frame_rate.includes('/')) {
      const [num, den] = s.avg_frame_rate.split('/').map(Number)
      if (Number.isFinite(num) && Number.isFinite(den) && den > 0) {
        out.fps = Math.round((num / den) * 100) / 100
      }
    }
    const dur = Number(j.format?.duration)
    if (Number.isFinite(dur) && dur > 0) out.duration = Math.round(dur * 100) / 100
    // (правка 722) Число кадров: nb_frames (точнее) → fps × duration.
    const nb = Number(s?.nb_frames)
    if (Number.isFinite(nb) && nb > 0) {
      out.frames = Math.round(nb)
    } else if (out.fps && out.duration) {
      out.frames = Math.max(1, Math.round(out.fps * out.duration))
    }
    return out
  } catch {
    return {}
  }
}

/**
 * Написать .meta.json для результата апскейла, если его ещё нет.
 * Идемпотентно: bridge может отдавать 'done' несколько поллов подряд.
 * Возвращает true, если сайдкар записан (или уже существовал).
 */
export async function ensureUpscaleMeta(
  outputPath: string,
  jobId: string,
  sourceHint?: unknown,
): Promise<boolean> {
  try {
    const OUTPUT_DIR = path.resolve(getAppConfig().outputDir)
    const file = path.resolve(outputPath)
    // (правка 587) как правка 348 (latent-file.ts): на win32 сравнение
    // регистронезависимое — мост (python) может отдать путь в другом регистре.
    const normPath = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p)
    if (!normPath(file).startsWith(normPath(OUTPUT_DIR) + path.sep)) return false // чужой путь
    if (!existsSync(file)) return false

    const metaFile = file + '.meta.json'
    if (existsSync(metaFile)) return true

    const name = path.basename(file)
    let size = 0
    let mtime = 0
    try {
      const st = statSync(file)
      size = st.size
      mtime = Math.floor(st.mtimeMs / 1000)
    } catch { /* ignore */ }

    const probe = await probeVideo(file)

    // Исходник: bridge кладёт в output разные поля — берём любое строковое
    // поле с путём, кроме самого результата (best effort).
    let sourceFile: string | null = null
    if (typeof sourceHint === 'string' && sourceHint && sourceHint !== outputPath) {
      sourceFile = path.basename(sourceHint)
    }

    // (правка 265) Наследование от сайдкара исходника: цепочка промптов
    // (promptChainFromMeta: source_prompt → prompt → extend_prompts — та же
    // логика, что у рефайна; refine-meta импортирует только app-config,
    // циклической зависимости нет) и image-референсы. sourceHint — полный
    // путь или имя; сайдкар ищем строго внутри outputDir: сначала по пути
    // относительно корня, затем basename в корне и подпапках 1-го уровня.
    let srcMeta: Record<string, unknown> | null = null
    if (typeof sourceHint === 'string' && sourceHint) {
      const candidates: string[] = []
      const resolvedHint = path.resolve(sourceHint)
      if (resolvedHint.startsWith(OUTPUT_DIR + path.sep)) {
        candidates.push(resolvedHint + '.meta.json')
      }
      const base = path.basename(sourceHint)
      candidates.push(path.join(OUTPUT_DIR, base + '.meta.json'))
      try {
        for (const entry of readdirSync(OUTPUT_DIR, { withFileTypes: true })) {
          if (entry.isDirectory()) candidates.push(path.join(OUTPUT_DIR, entry.name, base + '.meta.json'))
        }
      } catch { /* ignore */ }
      for (const c of candidates) {
        if (!existsSync(c)) continue
        try {
          srcMeta = JSON.parse(readFileSync(c, 'utf-8')) as Record<string, unknown>
        } catch { /* битый сайдкар — без наследования */ }
        break
      }
    }
    const inheritedPrompt = srcMeta ? promptChainFromMeta(srcMeta) : null
    const srcRefsRaw = srcMeta
      ? (Array.isArray(srcMeta.references) ? srcMeta.references
        : Array.isArray(srcMeta.minimax_h3_references) ? srcMeta.minimax_h3_references
        : [])
      : []
    const inheritedRefs = (srcRefsRaw as Array<{ type?: string; path?: string; role?: string }>)
      .filter((r) => r && r.type === 'image' && typeof r.path === 'string' && r.path.length > 0)
      .map((r) => ({ type: 'image', path: r.path as string, role: typeof r.role === 'string' ? r.role : '' }))

    const meta: Record<string, unknown> = {
      job_id: jobId,
      tool: upscaleToolFor(name),
      // (правка 722) Единая схема сайдкара: как у всех остальных режимов
      // студии. Раньше здесь были только tool/generation_mode/created_at/
      // file_size — из-за этого в диалоге метаданных апскейла половина полей
      // пустая, а режим не опознавался ни одним общим полем.
      workflow: 'upscale-dlss5',
      model_type: 'minimax_h3_upscale',
      generation_mode: 'upscale',
      pipeline: 'full',
      created_at: mtime || Math.floor(Date.now() / 1000),
      file_size: size,
    }
    if (probe.width && probe.height) meta.resolution = `${probe.width}x${probe.height}`
    if (probe.duration !== undefined) meta.duration_seconds = probe.duration
    if (probe.fps !== undefined) meta.fps = probe.fps
    // (правка 722) Число кадров — как у всех прочих режимов.
    if (probe.frames !== undefined) meta.video_length = probe.frames
    if (sourceFile) meta.source_file = sourceFile
    // (правка 722) Исходник — объектом { filename, subfolder }, как в
    // остальных режимах (у рефайна/FPS/Tile/ControlNet).
    if (sourceFile) meta.source_video = { filename: sourceFile, subfolder: '' }
    // (правка 265) наследованные поля — только если реально нашлись
    if (inheritedPrompt) meta.prompt = inheritedPrompt
    if (inheritedRefs.length > 0) meta.references = inheritedRefs

    writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf-8')
    return true
  } catch {
    return false
  }
}

/**
 * (правка 264) Дописать generation_time + настройки DLSS в существующий
 * сайдкар апскейла. Идемпотентно: поля, которые уже стоят, не перезаписываются.
 */
export function setUpscaleMetaGenerationTime(
  outputPath: string,
  generationTimeSec: number,
  feature?: string,
  options?: Record<string, unknown>,
): boolean {
  try {
    if (!Number.isFinite(generationTimeSec) || generationTimeSec <= 0) return false
    const OUTPUT_DIR = path.resolve(getAppConfig().outputDir)
    const file = path.resolve(outputPath)
    // (правка 587) как правка 348: регистронезависимое сравнение на win32.
    const normPath = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p)
    if (!normPath(file).startsWith(normPath(OUTPUT_DIR) + path.sep)) return false // чужой путь

    const metaFile = file + '.meta.json'
    if (!existsSync(metaFile)) return false // нет ещё — пусть его создаст ensureUpscaleMeta

    const meta = JSON.parse(readFileSync(metaFile, 'utf-8')) as Record<string, unknown>
    let changed = false

    if (typeof meta.generation_time !== 'number' || meta.generation_time <= 0) {
      meta.generation_time = Math.round(generationTimeSec)
      changed = true
    }
    // (правка 550) generation_mode + DLSS-настройки — если ещё не записаны
    if (!meta.generation_mode) {
      meta.generation_mode = 'upscale'
      changed = true
    }
    if (feature && !meta.upscale_feature) {
      meta.upscale_feature = feature
      changed = true
    }
    if (options && typeof options === 'object' && !meta.upscale_options) {
      meta.upscale_options = options
      changed = true
    }

    if (changed) {
      writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf-8')
    }
    return true
  } catch {
    return false
  }
}
