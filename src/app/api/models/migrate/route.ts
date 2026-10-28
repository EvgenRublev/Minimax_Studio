/**
 * POST /api/models/migrate
 * (правка 47 + 64 + 74 + 283 + 338 + ПРАВКА 765)
 *
 * Перенос данных со старой версии программы. (правка 765) Категории —
 * содержимое папок целиком:
 *   - MODELS: все найденные папки "models" (до 3 уровней) → текущая папка
 *     моделей ComfyUI;
 *   - INPUT (правка 765): все найденные папки "input" → текущий ComfyUI/input
 *     (файлы, которые пользователь «кидал» в программу);
 *   - OUTPUT (правка 765): ВСЕ найденные папки "output" (приоритет —
 *     ComfyUI/output) → текущий каталог выходов. Кэш превью (.thumbs/) и
 *     устаревший pending-стейт (.pending-meta.json) не переносимся;
 *   - DATA (правка 765): содержимое папки "data" (чаты ассистента, loras,
 *     кэш референсов) → текущий <проект>/data. assistant-chats.json
 *     сливается (существующие чаты имеют приоретет), inflight-generate.json
 *     не переносится (машинно-зависимый транзиентный стейт).
 *
 * (правка 765) Коллизии имен: раньше файл с таким же именем на месте
 * МОЛЧА пропускался — пользователь не понимал, почему «не перенесло».
 * Теперь: идентичные по размеру файлы считаются дубликатами (пропуск),
 * а отличающиеся по содержимому переносятся под новым именем
 * (_restored, _restored2, ...). Для контента сохраняются пары:
 * медиа + .meta.json-сайдкар едут вместе, а latent_file в сайдкаре
 * переписывается на перенесённый латент (если тот тоже переименован).
 *
 * Body: { sourceDir: string, items?: { models?, input?, output?, data? } }
 * Все категории включены по умолчанию → совместимо со старым телом
 * { sourceDir } (старые ключи content/chats принимаются как алиасы).
 */
import { NextResponse } from 'next/server'
import { existsSync, statSync, readdirSync, renameSync, copyFileSync, unlinkSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, relative, dirname, resolve } from 'path'
import { getAppConfig } from '@/lib/app-config'

export const dynamic = 'force-dynamic'

interface CategoryResult {
  enabled: boolean
  found: boolean
  dir: string | null
  /** (правка 74) Путь к исходному ФАЙЛУ (для категории чатов внутри data). */
  file?: string | null
  moved: number
  skipped: number
  /** (правка 765) Перенесено под новым именем (коллизия с другим содержимым). */
  renamed: number
  errors: string[]
}

interface MigrateResult {
  models: CategoryResult
  input: CategoryResult
  output: CategoryResult
  data: CategoryResult
}

const DISABLED: CategoryResult = {
  enabled: false,
  found: false,
  dir: null,
  moved: 0,
  skipped: 0,
  renamed: 0,
  errors: [],
}

/**
 * (правка 765) Папки-«мусор», внутрь которых НЕ заходим при поиске
 * models/input/output/data: иначе находим output внутри site-packages,
 * node_modules и т.п.
 */
const SKIP_DIR_NAMES = new Set([
  'node_modules', 'python_embeded', 'site-packages', '.git', '.next',
  'next', '__pycache__', 'custom_nodes', 'venv', 'venv312', 'dist',
])

function isSkippedDir(name: string): boolean {
  return SKIP_DIR_NAMES.has(name.toLowerCase())
}

/**
 * Recursively find a directory named `name` (case-insensitive) up to
 * `maxDepth` levels deep under `startDir`.
 */
function findDirByName(startDir: string, name: string, maxDepth = 3): string | null {
  if (!existsSync(startDir)) return null

  let entries: string[]
  try {
    entries = readdirSync(startDir)
  } catch {
    return null
  }

  for (const entry of entries) {
    const fullPath = join(startDir, entry)
    let st
    try {
      st = statSync(fullPath)
    } catch {
      continue
    }
    if (!st.isDirectory()) continue

    if (entry.toLowerCase() === name) {
      return fullPath
    }

    if (maxDepth > 1 && !isSkippedDir(entry)) {
      const found = findDirByName(fullPath, name, maxDepth - 1)
      if (found) return found
    }
  }
  return null
}

/**
 * (правка 283) Найти ВСЕ папки с названием `name` (до maxDepth уровней).
 * Возвращает массив путей (от ближайших к дальним). (правка 765) Используется
 * для всех категорий: models, input, output, data.
 */
function findAllDirByName(startDir: string, name: string, maxDepth = 3): string[] {
  const results: string[] = []
  if (!existsSync(startDir)) return results

  let entries: string[]
  try {
    entries = readdirSync(startDir)
  } catch {
    return results
  }

  for (const entry of entries) {
    const fullPath = join(startDir, entry)
    let st
    try {
      st = statSync(fullPath)
    } catch {
      continue
    }
    if (!st.isDirectory()) continue

    if (entry.toLowerCase() === name) {
      results.push(fullPath)
    }

    if (maxDepth > 1 && !isSkippedDir(entry)) {
      const found = findAllDirByName(fullPath, name, maxDepth - 1)
      results.push(...found)
    }
  }
  return results
}

/**
 * Recursively collect all file relative paths from a directory.
 */
function collectFiles(dir: string, baseDir: string = dir): string[] {
  const results: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return results
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry)
    let st
    try {
      st = statSync(fullPath)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      results.push(...collectFiles(fullPath, baseDir))
    } else if (st.isFile()) {
      results.push(relative(baseDir, fullPath))
    }
  }
  return results
}

/**
 * Move a file, handling cross-drive moves (copy + unlink).
 * (правка 279) Кросс-том: если unlinkSync упадёт (файл занят), бросаем
 * ошибку — файл скопирован, но не удалён. Вызывающий код запишет в errors.
 */
function moveFile(src: string, dest: string): void {
  // (правка 587) Букву диска берём регэкспом с обоих путей; если у какого-то
  // пути буквы НЕТ (UNC \\server\share или мусор) — считаем кросс-томом.
  const driveOf = (p: string) => (/^([a-zA-Z]):/.exec(p)?.[1] || '').toLowerCase()
  const srcDrive = driveOf(src)
  const destDrive = driveOf(dest)

  if (srcDrive !== destDrive || !srcDrive) {
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(src, dest)
    try {
      unlinkSync(src)
    } catch (err) {
      throw new Error(`Кросс-том: файл скопирован, но не удалён (занят другим процессом?): ${err instanceof Error ? err.message : String(err)}`)
    }
  } else {
    mkdirSync(dirname(dest), { recursive: true })
    renameSync(src, dest)
  }
}

/** (правка 64) Что НЕ переносить из старого output. */
function isExcludedContent(rel: string): boolean {
  const norm = rel.split('\\').join('/')
  return norm.startsWith('.thumbs/') || norm === '.pending-meta.json'
}
/* ─── (правка 765) Перенос с разрешением коллизий имен ─── */

/** Разделить имя файла на базу и «расширение» для вставки суффикса. */
function splitExt(rel: string): { base: string; ext: string } {
  if (rel.toLowerCase().endsWith('.meta.json')) {
    return { base: rel.slice(0, -10), ext: rel.slice(-10) }
  }
  const name = rel.slice(rel.lastIndexOf('\\') + 1)
  const dot = name.lastIndexOf('.')
  const sep = rel.length - name.length
  if (dot <= 0) return { base: rel, ext: '' }
  return { base: rel.slice(0, sep + dot), ext: rel.slice(sep + dot) }
}

/** Свободное имя вида base_restored.ext / base_restored2.ext ... */
function uniqueSuffixed(rel: string, taken: Set<string>, targetRoot: string): string {
  const { base, ext } = splitExt(rel)
  for (let k = 1; k < 1000; k++) {
    const cand = `${base}_restored${k === 1 ? '' : k}${ext}`
    if (!taken.has(cand.toLowerCase()) && !existsSync(join(targetRoot, cand))) return cand
  }
  return `${base}_restoredX${ext}`
}

type Disp = { kind: 'move' | 'skip' | 'rename'; newRel?: string }

/**
 * (правка 765) Перенос файлов foundDir → targetRoot с сохранением структуры.
 * Коллизии: одинаковый размер → дубликат (skip); разный размер → перенос
 * под суффиксом _restored. Пары медиа+сайдкар переименовываются согласованно,
 * latent_file в переименованном сайдкаре переписывается на новый путь латента.
 */
function runMigrate(
  targetRoot: string,
  foundDirs: string[],
  notFoundMsg: string,
  emptyMsg: string,
  exclude?: (rel: string) => boolean,
): CategoryResult {
  if (foundDirs.length === 0) {
    return { enabled: true, found: false, dir: null, moved: 0, skipped: 0, renamed: 0, errors: [notFoundMsg] }
  }

  type Item = { foundDir: string; rel: string; disp: Disp }
  const items: Item[] = []
  let totalFiles = 0
  for (const foundDir of foundDirs) {
    let files = collectFiles(foundDir)
    if (exclude) files = files.filter((f) => !exclude(f))
    totalFiles += files.length
    for (const rel of files) {
      const src = join(foundDir, rel)
      const dest = join(targetRoot, rel)
      let disp: Disp = { kind: 'move' }
      if (existsSync(dest)) {
        let sameSize = false
        try {
          sameSize = statSync(src).size === statSync(dest).size
        } catch {
          /* считаем не-дубликатом */
        }
        disp = sameSize ? { kind: 'skip' } : { kind: 'rename' }
      }
      items.push({ foundDir, rel, disp })
    }
  }

  if (totalFiles === 0) {
    return { enabled: true, found: true, dir: foundDirs[0], moved: 0, skipped: 0, renamed: 0, errors: [emptyMsg] }
  }

  // Проход 1: всем «rename» выдаём свободные новые имена.
  const taken = new Set(items.map((it) => it.rel.toLowerCase()))
  for (const it of items) {
    if (it.disp.kind === 'rename') {
      it.disp.newRel = uniqueSuffixed(it.rel, taken, targetRoot)
      taken.add(it.disp.newRel.toLowerCase())
    }
  }
  // Проход 2: сайдкар едет вместе со своим медиа (тот же суффикс).
  const byRel = new Map(items.map((it) => [it.rel.toLowerCase(), it]))
  for (const it of items) {
    if (it.disp.kind === 'rename' && !it.rel.toLowerCase().endsWith('.meta.json')) {
      const side = byRel.get((it.rel + '.meta.json').toLowerCase())
      if (side && side.disp.newRel !== it.disp.newRel + '.meta.json') {
        side.disp = { kind: 'rename', newRel: it.disp.newRel + '.meta.json' }
      }
    }
  }

  let moved = 0
  let skipped = 0
  let renamed = 0
  const errors: string[] = []

  for (const it of items) {
    const srcFile = join(it.foundDir, it.rel)
    const destRel = it.disp.newRel ?? it.rel
    const destFile = join(targetRoot, destRel)
    try {
      if (it.disp.kind === 'skip') {
        skipped++
        continue
      }
      if (it.disp.kind === 'rename' && it.rel.toLowerCase().endsWith('.meta.json')) {
        // Переименованный сайдкар: чиним latent_file, если латент тоже уехал.
        try {
          const meta = JSON.parse(readFileSync(srcFile, 'utf-8')) as { latent_file?: unknown }
          if (typeof meta.latent_file === 'string' && meta.latent_file) {
            const latRel = meta.latent_file.split('/').join('\\')
            const lat = byRel.get(latRel.toLowerCase())
            if (lat?.disp.kind === 'rename' && lat.disp.newRel) {
              meta.latent_file = lat.disp.newRel.split('\\').join('/')
              mkdirSync(dirname(destFile), { recursive: true })
              writeFileSync(destFile, JSON.stringify(meta, null, 2), 'utf-8')
              try {
                unlinkSync(srcFile)
              } catch {
                errors.push(`Сайдкар перенесён, но исходник не удалён (занят): ${it.rel}`)
              }
              renamed++
              continue
            }
          }
        } catch {
          /* не JSON или нет latent_file — обычный перенос */
        }
      }
      moveFile(srcFile, destFile)
      if (it.disp.kind === 'rename') renamed++
      else moved++
    } catch (err) {
      errors.push(`Ошибка при переносе ${it.rel}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return { enabled: true, found: true, dir: foundDirs[0], moved, skipped, renamed, errors }
}
/* ─── (правка 74/765) Чаты ассистента: слияние файла старой версии ─── */

interface ChatLike {
  id: string
  title?: string
  createdAt?: number
  updatedAt?: number
  messages?: Array<{ role: string; content: string }>
}

function isValidChat(c: unknown): c is ChatLike {
  if (!c || typeof c !== 'object') return false
  const chat = c as ChatLike
  return typeof chat.id === 'string' && chat.id.length > 0 && Array.isArray(chat.messages)
}

function currentChatsFile(): string {
  return join(process.cwd(), 'data', 'assistant-chats.json')
}

/**
 * (правка 74) Слить файл чатов старой версии в текущий data/assistant-chats.json:
 * существующие чаты (по id) имеют приоритет, новые добавляются. После успешного
 * слияния исходный файл удаляется (перенос, а не копия).
 */
function migrateChats(srcFile: string): CategoryResult {
  const dest = currentChatsFile()
  // (правка 338) Жёсткий гвард: источник = текущий файл чатов.
  if (resolve(srcFile).toLowerCase() === resolve(dest).toLowerCase()) {
    return {
      enabled: true, found: false, dir: null, file: srcFile,
      moved: 0, skipped: 0, renamed: 0,
      errors: ['Источник совпадает с текущим файлом чатов — перенос пропущен.'],
    }
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(srcFile, 'utf-8'))
    let srcChats: unknown[] | null
    if (Array.isArray(parsed)) {
      srcChats = parsed
    } else if (
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray((parsed as { chats?: unknown }).chats)
    ) {
      srcChats = (parsed as { chats: unknown[] }).chats
    } else {
      srcChats = null
    }
    if (!srcChats) {
      return {
        enabled: true, found: true, dir: null, file: srcFile,
        moved: 0, skipped: 0, renamed: 0,
        errors: ['Файл не содержит списка чатов.'],
      }
    }
    const validSrc = srcChats.filter(isValidChat)

    let curChats: ChatLike[] = []
    let curActive: string | null = null
    if (existsSync(dest)) {
      try {
        const cur = JSON.parse(readFileSync(dest, 'utf-8'))
        if (cur && Array.isArray(cur.chats)) curChats = cur.chats.filter(isValidChat)
        if (cur && typeof cur.activeChatId === 'string') curActive = cur.activeChatId
      } catch {
        /* повреждённый файл — начинаем заново */
      }
    }

    const curIds = new Set(curChats.map((c) => c.id))
    const added = validSrc.filter((c) => !curIds.has(c.id))
    const merged = [...curChats, ...added]
    const activeChatId =
      curActive && merged.some((c) => c.id === curActive) ? curActive : (merged[0]?.id ?? null)

    const dataDir = dirname(dest)
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
    writeFileSync(dest, JSON.stringify({ chats: merged, activeChatId }, null, 2), 'utf-8')

    try {
      unlinkSync(srcFile)
    } catch (err) {
      return {
        enabled: true, found: true, dir: null, file: srcFile,
        moved: added.length,
        skipped: validSrc.length - added.length,
        renamed: 0,
        errors: [`Чаты перенесены, но исходный файл не удалён (занят другим процессом?): ${err instanceof Error ? err.message : String(err)}`],
      }
    }

    return {
      enabled: true, found: true, dir: null, file: srcFile,
      moved: added.length,
      skipped: validSrc.length - added.length,
      renamed: 0,
      errors: [],
    }
  } catch (err) {
    return {
      enabled: true, found: true, dir: null, file: srcFile,
      moved: 0, skipped: 0, renamed: 0,
      errors: [`Ошибка чтения/переноса чатов: ${err instanceof Error ? err.message : String(err)}`],
    }
  }
}

/**
 * (правка 765) Категория DATA: содержимое старой папки "data" → текущий
 * <проект>/data. assistant-chats.json сливается specially, остальное —
 * перенос, если на месте нет такого же файла (текущая версия приоритетна);
 * inflight-generate.json не переносится.
 */
function migrateData(sourceDir: string): CategoryResult {
  const dataDirs = findAllDirByName(sourceDir, 'data', 3)
  const chatsFileRel = 'assistant-chats.json'
  const result: CategoryResult = {
    enabled: true, found: false, dir: null, moved: 0, skipped: 0, renamed: 0, errors: [],
  }
  if (dataDirs.length > 0) {
    result.found = true
    result.dir = dataDirs[0]
    const targetDataDir = dirname(currentChatsFile())
    for (const dir of dataDirs) {
      for (const rel of collectFiles(dir)) {
        const src = join(dir, rel)
        if (rel.toLowerCase() === chatsFileRel) {
          const ch = migrateChats(src)
          result.moved += ch.moved
          result.skipped += ch.skipped
          result.errors.push(...ch.errors)
          continue
        }
        if (rel.toLowerCase() === 'inflight-generate.json') continue
        const dest = join(targetDataDir, rel)
        try {
          if (existsSync(dest)) {
            result.skipped++
            continue
          }
          moveFile(src, dest)
          result.moved++
        } catch (err) {
          result.errors.push(`Ошибка при переносе ${rel} (из ${dir}): ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
    return result
  }
  result.errors.push('Папка "data" (данные программы) не найдена в указанной директории (поиск на 3 уровня глубины).')
  return result
}
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      sourceDir?: string
      items?: {
        models?: boolean
        input?: boolean
        output?: boolean
        data?: boolean
        // старые алиасы: content → output, chats → data
        content?: boolean
        chats?: boolean
      }
    }
    const sourceDir = (body.sourceDir || '').trim()

    if (!sourceDir) {
      return NextResponse.json(
        { error: 'Укажите путь к папке старой версии программы.' },
        { status: 400 }
      )
    }

    // (правка 135) Проверяем, что это именно папка, а не файл.
    if (!existsSync(sourceDir)) {
      return NextResponse.json(
        { error: `Папка не найдена: ${sourceDir}` },
        { status: 400 }
      )
    }
    if (!statSync(sourceDir).isDirectory()) {
      return NextResponse.json(
        { error: `Указан файл, а не папка: ${sourceDir}` },
        { status: 400 }
      )
    }

    // (правка 135/279/338 + 765) Защита от переноса «в себя» и из текущей
    // версии: sourceDir не должен совпадать с любой из целевых папок, лежать
    // внутри них ИЛИ быть их предком (иначе перенос ушёл бы по живым файлам
    // текущей установки).
    const cfg = getAppConfig()
    const modelsTarget = join(cfg.comfyRoot, 'ComfyUI', 'models')
    const inputTarget = cfg.inputDir
    const outputTarget = cfg.outputDir
    const dataTarget = dirname(currentChatsFile())
    const norm = (p: string) => p.toLowerCase().replace(/\\/g, '/')
    const targets = [modelsTarget, inputTarget, outputTarget, dataTarget].map(norm)
    const srcLower = norm(sourceDir)
    for (const t of targets) {
      if (srcLower === t || srcLower.startsWith(t + '/')) {
        return NextResponse.json(
          { error: `Невозможно перенести папку в саму себя: ${sourceDir}` },
          { status: 400 }
        )
      }
      if (t.startsWith(srcLower + '/')) {
        return NextResponse.json(
          {
            error:
              `Указана папка, внутри которой лежат данные текущей версии программы. ` +
              `Перенос оттуда работал бы с живыми файлами текущей установки. Укажите папку со СТАРОЙ версией.`,
          },
          { status: 400 }
        )
      }
    }

    // Категории включены по умолчанию — старый клиент, шлющий только
    // { sourceDir }, переносит всё. (правка 765) алиасы content/chats.
    const wantModels = body.items?.models !== false
    const wantInput = body.items?.input !== false
    const wantOutput = body.items?.output !== false && body.items?.content !== false
    const wantData = body.items?.data !== false && body.items?.chats !== false

    // (правка 283/765) Модели: может быть несколько папок models.
    const modelsDirs = findAllDirByName(sourceDir, 'models', 3)
    const models: CategoryResult = wantModels
      ? runMigrate(
          modelsTarget,
          modelsDirs,
          'Папка "models" (модели) не найдена в указанной директории (поиск на 3 уровня глубины).',
          'Папки "models" найдены, но не содержат файлов.',
        )
      : DISABLED

    // (правка 765) Input: «то, что кидал» — загруженные пользователем файлы.
    const inputDirs = findAllDirByName(sourceDir, 'input', 3)
    const input: CategoryResult = wantInput
      ? runMigrate(
          inputTarget,
          inputDirs,
          'Папка "input" (загруженные файлы) не найдена в указанной директории (поиск на 3 уровня глубины).',
          'Папки "input" найдены, но не содержат файлов.',
        )
      : DISABLED

    // (правка 765) Output: ВСЕ найденные папки output; приоритет — ComfyUI/output.
    let outputDirs = findAllDirByName(sourceDir, 'output', 3)
    const comfyDir = findDirByName(sourceDir, 'comfyui', 3)
    if (comfyDir) {
      const comfyOut = norm(join(comfyDir, 'output'))
      outputDirs = [
        ...outputDirs.filter((d) => norm(d) === comfyOut),
        ...outputDirs.filter((d) => norm(d) !== comfyOut),
      ]
    }
    const output: CategoryResult = wantOutput
      ? runMigrate(
          outputTarget,
          outputDirs,
          'Папка "output" (сгенерированные видео) не найдена в указанной директории (поиск на 3 уровня глубины).',
          'Папки "output" найдены, но не содержат файлов.',
          isExcludedContent,
        )
      : DISABLED

    // (правка 765) Data: чаты, loras, кэш референсов.
    const data: CategoryResult = wantData
      ? migrateData(sourceDir)
      : DISABLED

    const result: MigrateResult = { models, input, output, data }
    return NextResponse.json(result)
  } catch (err) {
    return NextResponse.json(
      { error: `Внутренняя ошибка: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    )
  }
}
