/**
 * Local staging for reference files when ComfyUI is not running.
 *
 * Uploads that can't reach ComfyUI land in .local-input/ and are
 * transferred to ComfyUI's input/ directory automatically at generation
 * time (see /api/comfy/generate). The staging directory is also served
 * by /api/comfy/file?type=input as a fallback, so reference previews
 * work offline.
 */
import { promises as fs } from 'fs'
import path from 'path'

const STAGE_DIR = path.resolve(process.env.LOCAL_INPUT_DIR || './.local-input')

/** Characters that are unsafe in a filename on any of our target platforms. */
const UNSAFE_CHARS = /[<>:"/\\|?*\x00-\x1f]/g

/**
 * Save a file to the staging directory.
 * Returns the unique staged filename (timestamp + random prefix).
 */
export async function stageFile(buf: Buffer, filename: string): Promise<string> {
  await fs.mkdir(STAGE_DIR, { recursive: true })
  const safe = path.basename(filename).replace(UNSAFE_CHARS, '_') || 'ref'
  const unique = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}-${safe}`
  await fs.writeFile(path.join(STAGE_DIR, unique), buf)
  return unique
}

/**
 * Resolve a staged filename to its absolute path (traversal-safe).
 * Returns null when the file is not staged.
 */
export async function stagedPath(filename: string): Promise<string | null> {
  const target = path.resolve(path.join(STAGE_DIR, path.basename(filename)))
  // Defense in depth: basename() already prevents traversal
  if (!target.startsWith(STAGE_DIR + path.sep)) return null
  try {
    const st = await fs.stat(target)
    if (!st.isFile()) return null
  } catch {
    return null
  }
  return target
}

/**
 * (правка 347) Move an already-on-disk file into the staging directory
 * (rename, fallback — copy+unlink across volumes). Без буферизации в heap,
 * в отличие от stageFile(buf).
 */
export async function stageFileFromPath(srcPath: string, filename: string): Promise<string> {
  await fs.mkdir(STAGE_DIR, { recursive: true })
  const safe = path.basename(filename).replace(UNSAFE_CHARS, '_') || 'ref'
  const unique = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}-${safe}`
  const dest = path.join(STAGE_DIR, unique)
  try {
    await fs.rename(srcPath, dest)
  } catch {
    await fs.copyFile(srcPath, dest)
    await fs.unlink(srcPath).catch(() => {})
  }
  return unique
}

/** Read a staged file, or null when it does not exist. */
export async function readStaged(filename: string): Promise<Buffer | null> {
  const target = await stagedPath(filename)
  if (!target) return null
  try {
    return await fs.readFile(target)
  } catch {
    return null
  }
}

/** Delete a staged file after it was transferred to ComfyUI input/.
 *  Without this, .local-input/ grew unboundedly across sessions and the
 *  stale local copy kept shadowing previews (/api/comfy/file checks staging
 *  before ComfyUI's input dir). */
export async function deleteStaged(filename: string): Promise<void> {
  const target = path.resolve(path.join(STAGE_DIR, path.basename(filename)))
  if (!target.startsWith(STAGE_DIR + path.sep)) return
  try {
    await fs.unlink(target)
  } catch {
    /* already gone — fine */
  }
}
