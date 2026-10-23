import { NextRequest, NextResponse } from 'next/server'
import { promises as fs } from 'fs'
import path from 'path'
import { getAppConfig } from '@/lib/app-config'
import { listGalleryFolders } from '@/lib/gallery-folders'

/**
 * GET /api/comfy/files?type=all|video|image
 * Lists output files from the ComfyUI output directory.
 *
 * - (правка 91) Файлы из папок проектов идут с subfolder = путь папки;
 *   сами папки — в `folders`.
 * - (правка 495) Вложенные папки: листинг рекурсивный (до MAX_DEPTH в
 *   gallery-folders), subfolder — относительный путь 'a/b'; служебные
 *   каталоги 'latents' пропускаются.
 * - `.meta.json` sidecars and dotfiles are never listed.
 * - Files written within the last HOT_SKIP_SECONDS are skipped: VHS creates
 *   the output mp4 at the start of muxing and writes it progressively, so a
 *   "fresh" file is usually still incomplete (serving it would poison the
 *   browser cache for the plain file URL).
 * - URLs carry `&_t=<mtime>` so a new version of a file is always a new URL –
 *   a mid-write fetch can never shadow the finished file in the HTTP cache.
 */
const VIDEO_EXTS = ['.mp4', '.webm', '.mov', '.avi', '.mkv', '.m4v']
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif']
const HOT_SKIP_SECONDS = 4

async function listDir(
  dirAbs: string,
  subfolder: string,
  typeFilter: string,
  includeHot: boolean,
): Promise<Array<{ url: string; filename: string; subfolder: string; mtime: number; size: number; type: string; hasMeta: boolean; generationTime: number | null; pipeline: string | null }>> {
  const files: Array<{ url: string; filename: string; subfolder: string; mtime: number; size: number; type: string; hasMeta: boolean; generationTime: number | null; pipeline: string | null }> = []
  const entries = await fs.readdir(dirAbs, { withFileTypes: true })

  // (правка 354) stat + чтение сайдкаров — ПАРАЛЛЕЛЬНО по файлам:
  // последовательный await на каждый файл делал листинг больших папок
  // линейно-медленным (дисковые RTT суммировались).
  const probed = await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile()) return null
    if (entry.name.startsWith('.')) return null
    if (entry.name.endsWith('.meta.json')) return null
    const ext = path.extname(entry.name).toLowerCase()

    const isVideo = VIDEO_EXTS.includes(ext)
    const isImage = IMAGE_EXTS.includes(ext)
    if (typeFilter === 'video' && !isVideo) return null
    if (typeFilter === 'image' && !isImage) return null
    if (!isVideo && !isImage) return null

    let mtime = 0
    // (правка 260) Размер файла — fast-track галереи ждёт стабилизации size,
    // чтобы понять, что муксинг mp4 завершён и файл можно показывать.
    let size = 0
    let hasMeta = false
    let generationTime: number | null = null
    let pipeline: string | null = null
    try {
      const filePath = path.join(dirAbs, entry.name)
      const metaPath = filePath + '.meta.json'
      const [stats, metaRaw] = await Promise.all([
        fs.stat(filePath),
        fs.readFile(metaPath, 'utf-8').catch(() => null),
      ])
      mtime = Math.floor(stats.mtimeMs / 1000)
      size = stats.size
      hasMeta = metaRaw !== null
      // Время генерации из метаданных (sidecar .meta.json → generation_time) —
      // тот же источник, что показывает диалог метаданных. Бейдж превью теперь
      // берёт значение ОТСЮДА, а не из клиентской оценки useGenDurations
      // (откуда и было расхождение «много/мало»).
      if (metaRaw !== null) {
        try {
          const meta = JSON.parse(metaRaw) as { generation_time?: unknown; pipeline?: unknown; params?: { generation_time?: unknown } }
          const top = typeof meta.generation_time === 'number' ? meta.generation_time : null
          const nested = typeof meta.params?.generation_time === 'number' ? meta.params.generation_time : null
          const gt = top ?? nested
          if (typeof gt === 'number' && Number.isFinite(gt) && gt > 0) generationTime = gt
          // (правка 261) pipeline ('draft'|'full') — красный бейдж «Draft» на
          // превью галереи для однопроходных генераций.
          if (meta.pipeline === 'draft' || meta.pipeline === 'full') pipeline = meta.pipeline
        } catch { /* sidecar malformed / mid-write — оставим null */ }
      }
    } catch { /* ignore */ }

    return { entry, mtime, size, hasMeta, generationTime, pipeline, isVideo }
  }))

  for (const item of probed) {
    if (!item) continue
    const { entry, mtime, size, hasMeta, generationTime, pipeline, isVideo } = item
    // Still being written — skip until it goes "cold". include_hot=1 (used by
    // the post-completion extend discovery, where the task is already done and
    // all files are final) bypasses this filter.
    if (!includeHot && Date.now() / 1000 - mtime < HOT_SKIP_SECONDS) continue

    files.push({
      url: `/api/comfy/file?filename=${encodeURIComponent(entry.name)}&subfolder=${encodeURIComponent(subfolder)}&type=output&_t=${mtime}`,
      filename: entry.name,
      subfolder,
      mtime,
      size,
      type: isVideo ? 'video' : 'image',
      hasMeta,
      generationTime,
      pipeline,
    })
  }
  return files
}

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const typeFilter = searchParams.get('type') || 'all'
  const includeHot = searchParams.get('include_hot') === '1'
  const OUTPUT_DIR = getAppConfig().outputDir

  // (правка 259) Никакого кэширования списка: URL всегда один и тот же
  // (?type=all), и без явного запрета браузер имел право отдавать устаревший
  // ответ — новое видео «не появлялось» до ручного обновления страницы.
  const NO_STORE = {
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    Pragma: 'no-cache',
  } as const

  if (!OUTPUT_DIR) {
    return NextResponse.json({ files: [], folders: [] }, { headers: NO_STORE })
  }

  try {
    // (правка 495) Папки проекта — все уровни вложенности (listGalleryFolders
    // уже исключает dot-папки и служебные 'latents', сортирует).
    const folders = await listGalleryFolders()

    // (правка 354) Папки проектов листаем параллельно.
    const nested = await Promise.all(
      folders.map((folder) => listDir(path.join(OUTPUT_DIR, ...folder.split('/')), folder, typeFilter, includeHot)
        .catch(() => [])),
    )
    let files = await listDir(OUTPUT_DIR, '', typeFilter, includeHot)
    for (const sub of nested) {
      files = files.concat(sub)
    }

    // Sort by mtime descending (newest first)
    files.sort((a, b) => b.mtime - a.mtime)

    return NextResponse.json({ files, folders }, { headers: NO_STORE })
  } catch (err) {
    // (правка 716) Ошибка больше не маскируется под «пустую галерею»:
    // раньше UI показывал пустую галерею, и пользователь не понимал, что
    // папка output недоступна. Отдаём 500 с текстом ошибки.
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: `Не удалось прочитать галерею: ${msg}`, files: [], folders: [] }, { status: 500, headers: NO_STORE })
  }
}
