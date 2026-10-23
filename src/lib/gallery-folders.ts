/**
 * Папки галереи (правка 91) — подпапки каталога вывода ComfyUI.
 *
 * «Общая» папка = корень output (subfolder ''), она есть всегда.
 * Проектные папки — подпапки output; генерацию можно направить в них
 * (VHS filename_prefix «folder/Minimax_Studio»), а вкладка «Галерея»
 * показывает все папки сразу.
 *
 * (правка 495) Вложенные папки: subfolder — ОТНОСИТЕЛЬНЫЙ путь из
 * санитизированных сегментов ('проект/сцены', разделитель '/'), глубина
 * до MAX_DEPTH. Сегменты '.'/'..' отбрасываются, служебное имя 'latents'
 * (хранилище .latent пайплайна «драфт → рефайн») зарезервировано.
 */
import { promises as fs } from 'fs'
import path from 'path'
import { getAppConfig } from './app-config'

/** Максимальная длина имени папки (защита от экзотики в URL/файловой системе). */
const MAX_NAME_LEN = 60
/** (правка 495) Глубина вложенности и суммарная длина относительного пути. */
const MAX_DEPTH = 5
const MAX_PATH_LEN = 240

/** Санитизировать имя папки: один сегмент, без недопустимых символов. */
export function sanitizeFolderName(name: string): string {
  return path
    .basename(String(name ?? ''))
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    // Windows не принимает имена с точкой/пробелом на конце ('dir.' ≡ 'dir').
    .replace(/[. ]+$/, '')
    .slice(0, MAX_NAME_LEN)
}

/**
 * (правка 495) Санитизировать ОТНОСИТЕЛЬНЫЙ путь папки ('a/b/c'): каждый
 * сегмент — sanitizeFolderName, сегменты '.'/'..' отбрасываются (защита от
 * path traversal), разделитель нормализован к '/'. '' = корень (общая папка).
 */
export function sanitizeFolderPath(input: string): string {
  const segs = String(input ?? '')
    .split(/[\\/]+/)
    .map((s) => sanitizeFolderName(s))
    .filter((s) => s && s !== '.' && s !== '..')
    .slice(0, MAX_DEPTH)
  let out = ''
  for (const seg of segs) {
    if (out && out.length + 1 + seg.length > MAX_PATH_LEN) break
    out = out ? `${out}/${seg}` : seg
  }
  return out
}

/** Путь к папке внутри output ('' = корень). */
export function folderPath(folder: string): string {
  const safe = sanitizeFolderPath(folder)
  return safe ? path.join(getAppConfig().outputDir, ...safe.split('/')) : getAppConfig().outputDir
}

/**
 * Список папок проекта (все уровни вложенности, относительные пути с '/').
 * Отсортирован; родитель всегда идёт раньше своих детей (префиксная
 * сортировка). Служебные каталоги ('latents', dot-папки) не входят.
 */
export async function listGalleryFolders(): Promise<string[]> {
  const root = getAppConfig().outputDir
  const out: string[] = []
  const walk = async (dirAbs: string, rel: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) return
    let entries
    try {
      entries = await fs.readdir(dirAbs, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue
      // (правка 378) 'latents' — служебное хранилище .latent-файлов,
      // не проектная папка (на любом уровне вложенности).
      if (e.name.toLowerCase() === 'latents') continue
      const childRel = rel ? `${rel}/${e.name}` : e.name
      out.push(childRel)
      await walk(path.join(dirAbs, e.name), childRel, depth + 1)
    }
  }
  await walk(root, '', 1)
  return out.sort((a, b) => a.localeCompare(b, 'ru'))
}

/** Создать папку (вложенный путь 'a/b' создаёт всю цепочку). */
export async function createGalleryFolder(name: string): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  const safe = sanitizeFolderPath(name)
  if (!safe) return { ok: false, error: 'Введите имя папки' }
  if (safe.split('/').some((s) => s.toLowerCase() === 'latents')) {
    return { ok: false, error: 'Имя «latents» зарезервировано (служебная папка)' }
  }
  const dir = folderPath(safe)
  try {
    await fs.access(dir)
    return { ok: false, error: `Папка «${safe}» уже существует` }
  } catch { /* не существует — создаём */ }
  try {
    await fs.mkdir(dir, { recursive: true })
    return { ok: true, name: safe }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** (правка 122) Переименовать папку. Файлы и .meta.json сайдкары
 *  остаются в папке (она просто сменит имя на диске).
 *  (правка 495) newName без слэша = новое имя листа (родитель сохраняется);
 *  со слэшем = полный новый путь (перенос между уровнями). Дети и вложенные
 *  папки переезжают вместе с родителем. */
export async function renameGalleryFolder(
  oldName: string,
  newName: string,
): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  const fromSafe = sanitizeFolderPath(oldName)
  if (!fromSafe) return { ok: false, error: 'Неверное имя папки' }
  let toSafe = sanitizeFolderPath(newName)
  if (!toSafe) return { ok: false, error: 'Введите новое имя папки' }
  if (!toSafe.includes('/')) {
    const parent = fromSafe.includes('/') ? fromSafe.slice(0, fromSafe.lastIndexOf('/')) : ''
    toSafe = parent ? `${parent}/${toSafe}` : toSafe
  }
  if (fromSafe === toSafe) return { ok: true, name: toSafe }
  if (toSafe.startsWith(fromSafe + '/')) {
    return { ok: false, error: 'Нельзя перенести папку внутрь самой себя' }
  }
  if (toSafe.split('/').some((s) => s.toLowerCase() === 'latents')) {
    return { ok: false, error: 'Имя «latents» зарезервировано (служебная папка)' }
  }
  const srcDir = folderPath(fromSafe)
  const dstDir = folderPath(toSafe)
  try {
    await fs.access(dstDir)
    return { ok: false, error: `Папка «${toSafe}» уже существует` }
  } catch { /* целевой папки нет — ок */ }
  try {
    await fs.mkdir(path.dirname(dstDir), { recursive: true })
    await fs.rename(srcDir, dstDir)
    return { ok: true, name: toSafe }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { ok: false, error: `Папка «${fromSafe}» не найдена` }
    if (code === 'ENOTEMPTY' || code === 'EEXIST' || code === 'EPERM') {
      return { ok: false, error: `Папка «${toSafe}» уже существует` }
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Удалить папку (только пустую — видео и подпапки не теряются молча). */
export async function deleteGalleryFolder(name: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const safe = sanitizeFolderPath(name)
  if (!safe) return { ok: false, error: 'Неверное имя папки' }
  const dir = folderPath(safe)
  try {
    const entries = await fs.readdir(dir)
    // Осиротевшие .meta.json-сайдкары (видео удалено внешне) не считаем
    // содержимым — папку с одними сайдкарами можно удалить. Подпапки —
    // считаем: сначала удалите/переместите их.
    const visible = entries.filter((e) => !e.startsWith('.') && !e.endsWith('.meta.json'))
    if (visible.length > 0) {
      return { ok: false, error: `Папка «${safe}» не пуста (${visible.length} файлов/папок). Переместите или удалите их.` }
    }
    await fs.rm(dir, { recursive: true })
    return { ok: true }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { ok: true }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Переместить файл вывода (вместе с .meta.json сайдкаром)
 * между папками. from/to — относительные пути папок ('' = общая).
 */
export async function moveOutputFile(
  filename: string,
  from: string,
  to: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const safeName = path.basename(String(filename ?? ''))
  if (!safeName || safeName.startsWith('.')) return { ok: false, error: 'Неверное имя файла' }
  const fromSafe = sanitizeFolderPath(from)
  const toSafe = sanitizeFolderPath(to)
  if (fromSafe === toSafe) return { ok: true }

  const srcDir = folderPath(fromSafe)
  const dstDir = folderPath(toSafe)
  try {
    await fs.mkdir(dstDir, { recursive: true })
    for (const candidate of [safeName, `${safeName}.meta.json`]) {
      const src = path.join(srcDir, candidate)
      const dst = path.join(dstDir, candidate)
      try {
        await fs.rename(src, dst)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== 'ENOENT') throw err // meta может отсутствовать — ок
      }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
