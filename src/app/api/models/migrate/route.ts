/**
 * POST /api/models/migrate
 * (правка 47 + правка 64)
 *
 * Перенос данных со старой версии программы:
 *   - МОДЕЛИ: рекурсивный поиск папки "models" (до 3 уровней) внутри выбранной
 *     папки → все файлы перемещаются в текущую папку моделей ComfyUI;
 *   - КОНТЕНТ (правка 64): папка "output" (сгенерированные видео + .meta.json)
 *     → перемещается в текущий каталог выходов. Кэш превью (.thumbs/) и
 *     устаревший pending-стейт (.pending-meta.json) не переносимся;
 *   - ЧАТЫ (правка 74): файл "assistant-chats.json" (поиск до 3 уровней)
 *     → сливается в текущий data/assistant-chats.json (существующие чаты
 *     имеют приоритет, новые добавляются). После успешного слияния исходный
 *     файл удаляется (перенос, а не копия).
 *
 * Body: { sourceDir: string, items?: { models?, content?, chats?: boolean } }
 * Все категории включены по умолчанию → совместимо со старым телом { sourceDir }.
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
  /** (правка 74) Путь к исходному ФАЙЛУ (для категории «чаты»). */
  file?: string | null
  moved: number
  skipped: number
  errors: string[]
}

interface MigrateResult {
  models: CategoryResult
  content: CategoryResult
  chats: CategoryResult
}

const DISABLED: CategoryResult = {
  enabled: false,
  found: false,
  dir: null,
  moved: 0,
  skipped: 0,
  errors: [],
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

    if (maxDepth > 1) {
      const found = findDirByName(fullPath, name, maxDepth - 1)
      if (found) return found
    }
  }
  return null
}

/**
 * (правка 283) Найти ВСЕ папки с названием `name` (до maxDepth уровней).
 * Возвращает массив путей (от ближайших к дальним). Используется для
 * моделей: может быть несколько папок models (корневая с бонсай +
 * ComfyUI/models с основными моделями) — нужно объединить обе.
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

    if (maxDepth > 1) {
      const found = findAllDirByName(fullPath, name, maxDepth - 1)
      results.push(...found)
    }
  }
  return results
}

/**
 * (правка 64) Найти папку сгенерированного контента старой установки:
 * приоритет — <...>/ComfyUI/output (стандартная раскладка
 * ComfyUI-Easy-Install/ComfyUI/output), затем любая папка "output" (до 3 уровней).
 */
function findContentDir(startDir: string): string | null {
  const comfyDir = findDirByName(startDir, 'comfyui', 3)
  if (comfyDir) {
    const out = join(comfyDir, 'output')
    try {
      if (existsSync(out) && statSync(out).isDirectory()) return out
    } catch {
      /* не читаемая — идём к fallback */
    }
  }
  return findDirByName(startDir, 'output', 3)
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
  // пути буквы НЕТ (UNC \\server\share или мусор) — считаем кросс-томом:
  // старая проверка split('\\')[0] для UNC давала '' с обеих сторон, ветка
  // копирования пропускалась, renameSync падал с EXDEV и каждый файл
  // улетал в errors, хотя copy+delete сработал бы.
  const driveOf = (p: string) => (/^([a-zA-Z]):/.exec(p)?.[1] || '').toLowerCase()
  const srcDrive = driveOf(src)
  const destDrive = driveOf(dest)

  if (srcDrive !== destDrive || !srcDrive) {
    // Cross-drive: copy then delete source
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(src, dest)
    try {
      unlinkSync(src)
    } catch (err) {
      throw new Error(`Кросс-том: файл скопирован, но не удалён (занят другим процессом?): ${err instanceof Error ? err.message : String(err)}`)
    }
  } else {
    // Same drive: rename (atomic on NTFS)
    mkdirSync(dirname(dest), { recursive: true })
    renameSync(src, dest)
  }
}

/** (правка 64) Что НЕ переносить из старого output. */
function isExcludedContent(rel: string): boolean {
  const norm = rel.split('\\').join('/')
  return norm.startsWith('.thumbs/') || norm === '.pending-meta.json'
}

/**
 * (правка 64) Общий перенос одной категории: файлы из foundDir → targetRoot
 * с сохранением структуры. Существующие на месте файлы пропускаются.
 */
function runMigrate(
  targetRoot: string,
  foundDir: string | null,
  notFoundMsg: string,
  emptyMsg: string,
  exclude?: (rel: string) => boolean,
): CategoryResult {
  if (!foundDir) {
    return { enabled: true, found: false, dir: null, moved: 0, skipped: 0, errors: [notFoundMsg] }
  }

  let files = collectFiles(foundDir)
  if (exclude) files = files.filter((f) => !exclude(f))

  if (files.length === 0) {
    return { enabled: true, found: true, dir: foundDir, moved: 0, skipped: 0, errors: [emptyMsg] }
  }

  let moved = 0
  let skipped = 0
  const errors: string[] = []

  for (const relPath of files) {
    const srcFile = join(foundDir, relPath)
    const destFile = join(targetRoot, relPath)

    try {
      if (existsSync(destFile)) {
        // Already exists — skip
        skipped++
        continue
      }
      moveFile(srcFile, destFile)
      moved++
    } catch (err) {
      errors.push(`Ошибка при переносе ${relPath}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return { enabled: true, found: true, dir: foundDir, moved, skipped, errors }
}

/**
 * (правка 283) Перенос из НЕСКОЛЬКИХ папок (модели: корневая + ComfyUI/models).
 * Файлы из всех папок объединяются и переносятся в targetRoot.
 */
function runMigrateMulti(
  targetRoot: string,
  foundDirs: string[],
  emptyMsg: string,
): CategoryResult {
  let totalMoved = 0
  let totalSkipped = 0
  const errors: string[] = []
  let totalFiles = 0

  for (const foundDir of foundDirs) {
    const files = collectFiles(foundDir)
    totalFiles += files.length

    for (const relPath of files) {
      const srcFile = join(foundDir, relPath)
      const destFile = join(targetRoot, relPath)

      try {
        if (existsSync(destFile)) {
          totalSkipped++
          continue
        }
        moveFile(srcFile, destFile)
        totalMoved++
      } catch (err) {
        errors.push(`Ошибка при переносе ${relPath} (из ${foundDir}): ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  if (totalFiles === 0) {
    return { enabled: true, found: true, dir: foundDirs[0] ?? null, moved: 0, skipped: 0, errors: [emptyMsg] }
  }

  return { enabled: true, found: true, dir: foundDirs[0] ?? null, moved: totalMoved, skipped: totalSkipped, errors }
}

/* ─── (правка 74) Чаты ассистента: перенос из файла старой версии ─── */

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
 * (правка 74) Найти файл чатов ассистента в старой установке:
 * "assistant-chats.json" (без учёта регистра, до 3 уровней глубины).
 */
function findChatsFile(startDir: string, maxDepth = 3): string | null {
  if (!existsSync(startDir)) return null
  let rootSt
  try {
    rootSt = statSync(startDir)
  } catch {
    return null
  }
  if (!rootSt.isDirectory()) return null

  let entries: string[]
  try {
    entries = readdirSync(startDir)
  } catch {
    return null
  }
  for (const entry of entries) {
    const fullPath = join(startDir, entry)
    let entrySt
    try {
      entrySt = statSync(fullPath)
    } catch {
      continue
    }
    if (entrySt.isFile() && entry.toLowerCase() === 'assistant-chats.json') {
      return fullPath
    }
    if (entrySt.isDirectory() && maxDepth > 1) {
      const found = findChatsFile(fullPath, maxDepth - 1)
      if (found) return found
    }
  }
  return null
}

/**
 * (правка 74) Слить файл чатов старой версии в текущий data/assistant-chats.json:
 * существующие чаты (по id) имеют приоритет, новые добавляются. После успешного
 * слияния исходный файл удаляется (перенос, а не копия).
 */
function migrateChats(srcFile: string): CategoryResult {
  const dest = currentChatsFile()
  // (правка 338) Жёсткий гвард: источник = текущий файл чатов. POST уже
  // отклоняет такие sourceDir, но findChatsFile ищет рекурсивно (3 уровня) —
  // при sourceDir-предке проекта (например, сама папка новой версии) мог
  // найтись ИМЕННО текущий data/assistant-chats.json, и unlinkSync ниже
  // удалил бы живые чаты после «слияния файла самого в себя».
  if (resolve(srcFile).toLowerCase() === resolve(dest).toLowerCase()) {
    return {
      enabled: true, found: false, dir: null, file: srcFile,
      moved: 0, skipped: 0,
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
        moved: 0, skipped: 0,
        errors: ['Файл не содержит списка чатов.'],
      }
    }
    const validSrc = srcChats.filter(isValidChat)

    // Текущие чаты (если есть)
    let curChats: ChatLike[] = []
    let curActive: string | null = null
    if (existsSync(dest)) {
      try {
        const cur = JSON.parse(readFileSync(dest, 'utf-8'))
        if (cur && Array.isArray(cur.chats)) curChats = cur.chats.filter(isValidChat)
        if (cur && typeof cur.activeChatId === 'string') curActive = cur.activeChatId
      } catch {
        /* повреждённый файл — начинаем заново (старые чаты останутся в кэше браузера) */
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

    // Перенос = move: удаляем исходный файл после успешной записи
    // (правка 279) Если unlinkSync упадёт (файл занят), пишем в errors —
    // данные перенесены, но исходный файл остался (копия, а не перенос).
    try {
      unlinkSync(srcFile)
    } catch (err) {
      return {
        enabled: true, found: true, dir: null, file: srcFile,
        moved: added.length,
        skipped: validSrc.length - added.length,
        errors: [`Чаты перенесены, но исходный файл не удалён (занят другим процессом?): ${err instanceof Error ? err.message : String(err)}`],
      }
    }

    return {
      enabled: true, found: true, dir: null, file: srcFile,
      moved: added.length,
      skipped: validSrc.length - added.length,
      errors: [],
    }
  } catch (err) {
    return {
      enabled: true, found: true, dir: null, file: srcFile,
      moved: 0, skipped: 0,
      errors: [`Ошибка чтения/переноса чатов: ${err instanceof Error ? err.message : String(err)}`],
    }
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      sourceDir?: string
      items?: { models?: boolean; content?: boolean; chats?: boolean }
    }
    const sourceDir = (body.sourceDir || '').trim()

    if (!sourceDir) {
      return NextResponse.json(
        { error: 'Укажите путь к папке старой версии программы.' },
        { status: 400 }
      )
    }

    // (правка 135) Проверяем, что это именно папка, а не файл.
    // Раньше если user указал файл — existsSync вернул true, и код
    // пытался искать в нём подпапки → странное поведение.
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

    // (правка 135) Защита от переноса папки в саму себя.
    // Если sourceDir совпадает с любым из target'ов — ошибка.
    // (правка 279) Добавлена проверка файла чатов — если sourceDir содержит
    // текущий data/assistant-chats.json, migrateChats удалит его после
    // слияния → потеря данных.
    const cfg = getAppConfig()
    const modelsTarget = join(cfg.comfyRoot, 'ComfyUI', 'models')
    const contentTarget = cfg.outputDir
    const chatsTarget = currentChatsFile()
    const targets = [modelsTarget, contentTarget].map((p) => p.toLowerCase().replace(/\\/g, '/'))
    const srcLower = sourceDir.toLowerCase().replace(/\\/g, '/')
    for (const t of targets) {
      if (srcLower === t || srcLower.startsWith(t + '/')) {
        return NextResponse.json(
          { error: `Невозможно перенести папку в саму себя: ${sourceDir}` },
          { status: 400 }
        )
      }
    }
    // (правка 279) Защита от удаления текущего файла чатов
    const chatsLower = chatsTarget.toLowerCase().replace(/\\/g, '/')
    if (srcLower === dirname(chatsLower) || srcLower.startsWith(dirname(chatsLower) + '/')) {
      return NextResponse.json(
        { error: `Невозможно перенести папку, содержащую текущий файл чатов: ${sourceDir}` },
        { status: 400 }
      )
    }
    // (правка 338) И наоборот: sourceDir — ПРЕДОК текущего data/ (пользователь
    // указал папку самой новой версии или её родителя). Рекурсивный
    // findChatsFile нашёл бы внутри живой assistant-chats.json, и migrateChats
    // удалил бы его после слияния «самого в себя» → потеря всех чатов.
    if (chatsLower === srcLower + '/assistant-chats.json' || chatsLower.startsWith(srcLower + '/')) {
      return NextResponse.json(
        { error: `Невозможно перенести данные из папки текущей версии программы: ${sourceDir}` },
        { status: 400 }
      )
    }
    // (релиз) sourceDir — ПРЕДОК живой папки моделей.
    //
    // findAllDirByName(sourceDir, 'models', 3) ищет ЛЮБУЮ папку с именем
    // 'models' на 3 уровня вниз. Если пользователь указал корень проекта
    // (или его родителя), туда попадает НАСТОЯЩАЯ папка моделей текущей
    // версии — и перенос начинает работать с живыми файлами вместо копии
    // старой версии. Проверка «sourceDir == target или внутри него» это не
    // ловит: запрещён только сам target и его подпапки, а не предки.
    //
    // Последствие — живые модели уезжают из ComfyUI\models, и студия
    // остаётся без весов. Поэтому предка живой папки моделей отклоняем
    // явно и с внятным текстом.
    if (modelsTarget.toLowerCase().replace(/\\/g, '/').startsWith(srcLower + '/')) {
      return NextResponse.json(
        {
          error:
            `Указана папка, внутри которой лежит текущая папка моделей (${modelsTarget}). ` +
            `Перенос оттуда увёл бы живые модели из программы. Укажите папку со СТАРОЙ версией.`,
        },
        { status: 400 }
      )
    }

    // Категории включены по умолчанию — старый клиент,
    // шлющий только { sourceDir }, переносит и модели, и контент, и чаты.
    const wantModels = body.items?.models !== false
    const wantContent = body.items?.content !== false
    const wantChats = body.items?.chats !== false

    // (правка 283) Модели: может быть несколько папок models (корневая +
    // ComfyUI/models). Ищем все и объединяем их содержимое.
    const modelsDirs = findAllDirByName(sourceDir, 'models', 3)
    const models: CategoryResult = wantModels
      ? modelsDirs.length > 0
        ? runMigrateMulti(modelsTarget, modelsDirs,
            'Папки "models" найдены, но не содержат файлов.')
        : { enabled: true, found: false, dir: null, moved: 0, skipped: 0, errors: ['Папка "models" (модели) не найдена в указанной директории (поиск на 3 уровня глубины).'] }
      : DISABLED

    const content: CategoryResult = wantContent
      ? runMigrate(
          contentTarget,
          findContentDir(sourceDir),
          'Папка "output" (сгенерированные видео) не найдена в указанной директории (поиск на 3 уровня глубины).',
          'Папка "output" найдена, но не содержит файлов.',
          isExcludedContent,
        )
      : DISABLED

    const chatsFile = wantChats ? findChatsFile(sourceDir) : null
    const chats: CategoryResult = wantChats
      ? chatsFile
        ? migrateChats(chatsFile)
        : {
            enabled: true,
            found: false,
            dir: null,
            moved: 0,
            skipped: 0,
            errors: ['Файл "assistant-chats.json" (чаты ассистента) не найден в указанной директории (поиск на 3 уровня глубины).'],
          }
      : DISABLED

    const result: MigrateResult = { models, content, chats }
    return NextResponse.json(result)
  } catch (err) {
    return NextResponse.json(
      { error: `Внутренняя ошибка: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    )
  }
}
