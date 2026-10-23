/**
 * Model download manager — streams files from HuggingFace to disk,
 * tracks progress, and supports status queries.
 */
import { createWriteStream, existsSync, mkdirSync, unlinkSync, statSync, statfsSync } from 'fs'
import { dirname, join } from 'path'
import { Readable } from 'stream'
import { MODELS, type ModelDef } from './models-config'
import { getAppConfig } from './app-config'

export interface DownloadState {
  modelId: string
  status: 'downloading' | 'done' | 'error' | 'cancelled'
  bytesReceived: number
  totalBytes: number | null
  speed: number // bytes/sec
  error?: string
  startedAt: number
}

const activeDownloads = new Map<string, DownloadState>()
const abortControllers = new Map<string, AbortController>()

/* (правка 136) Параллельное скачивание с ограничением.
 *
 * Было: все модели скачивались одновременно (быстро, но диск и сеть
 * захлёбывались, риск обрывов рос).
 * Потом: по очереди (стабильно, но медленно).
 * Теперь: до MAX_CONCURRENT одновременных скачиваний (быстро + стабильно).
 *
 * MAX_CONCURRENT = 3 — оптимум для большинства соединений и дисков.
 * Если сеть/диск слабые — можно уменьшить до 2, если мощные — до 5. */
const MAX_CONCURRENT = 3
let activeCount = 0
let queue: Array<() => Promise<void>> = []

function enqueueDownload(run: () => Promise<void>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const task = async () => {
      try {
        await run()
        resolve()
      } catch (e) {
        reject(e)
      } finally {
        activeCount--
        // Запускаем следующую задачу из очереди, если есть
        if (queue.length > 0 && activeCount < MAX_CONCURRENT) {
          const next = queue.shift()!
          activeCount++
          next()
        }
      }
    }
    
    if (activeCount < MAX_CONCURRENT) {
      activeCount++
      task()
    } else {
      queue.push(task)
    }
  })
}

/** Resolve absolute path for a model file */
function modelAbsPath(model: ModelDef): string {
  const cfg = getAppConfig()
  // (правка 138) Bonsai-файлы живут в своей папке сборки (<bonsai_dir>),
  // не в models ComfyUI. relPath у движка — каталог ('llama.cpp/').
  if (model.target === 'bonsai') {
    return join(cfg.llmBonsaiDir, model.relPath)
  }
  // (правка 269) Кастомный корневой каталог — для моделей кастомных нод,
  // которые ищут файлы НЕ в ComfyUI/models (например, VFI: ckpts/ в папке
  // ComfyUI-Frame-Interpolation). baseDir может быть абсолютным или
  // относительным от cwd (папка проекта).
  if (model.target === 'custom' && model.baseDir) {
    // (правка 269) baseDir: абсолютный (E:\...) или относительный от
    // comfyRoot (ComfyUI-Easy-Install/...) или от cwd (проект).
    const isAbsolute = model.baseDir.startsWith('/')
      || model.baseDir.startsWith('\\')
      || /^[a-zA-Z]:[\\/]/.test(model.baseDir)
    // (правка 507) Если папки нет ни там ни там (первое скачивание — нода
    // ещё не создала свой ckpts), резолвим от comfyRoot, а НЕ от cwd:
    // иначе качалка создавала лишнюю папку <проект>/ComfyUI/... рядом с
    // настоящей ComfyUI-Easy-Install и клала модель туда.
    const base = isAbsolute
      ? model.baseDir
      : (existsSync(join(cfg.comfyRoot, model.baseDir))
          ? join(cfg.comfyRoot, model.baseDir)
          : existsSync(join(process.cwd(), model.baseDir))
            ? join(process.cwd(), model.baseDir)
            : join(cfg.comfyRoot, model.baseDir))
    return join(base, model.relPath)
  }
  return join(cfg.comfyRoot, 'ComfyUI', 'models', model.relPath)
}

/** (правка 505) Проверка размера: файл близок к ожидаемому (±10%) */
function sizeOk(abs: string, expected: number): boolean {
  try {
    const stat = statSync(abs)
    const tolerance = Math.max(1_000_000, expected * 0.1)
    return stat.size >= expected - tolerance && stat.size <= expected + tolerance
  } catch {
    return false
  }
}

/** Check if a model file already exists (and has reasonable size) */
export function modelExists(modelId: string): boolean {
  const model = MODELS.find(m => m.id === modelId)
  if (!model) return false
  try {
    // (правка 138) zip-записи (движок Bonsai): «готово» = все нужные файлы
    // извлечены; проверка размера zip здесь неприменима.
    if (model.extractFiles) {
      const dir = modelAbsPath(model)
      return model.extractFiles.every(f => existsSync(join(dir, f)))
    }
    const abs = modelAbsPath(model)
    if (existsSync(abs) && sizeOk(abs, model.sizeBytes)) return true
    // (правка 505) Проверяем внешние папки моделей (extra paths) — если
    // пользователь указал свою папку с моделями, файл может лежать там.
    // relPath вида 'vae/xxx.safetensors' → категория='vae', файл='xxx.safetensors'.
    // (релиз) Сохраняем ПОДПУТЬ внутри категории: у моделей с подпапкой
    // ('llm/qwen3.5-9b/xxx.gguf') файл во внешней папке лежит как
    // 'qwen3.5-9b/xxx.gguf' — искали только по имени файла и не находили.
    const parts = model.relPath.split('/')
    if (parts.length >= 2) {
      const categoryDir = parts[0]
      const fileName = parts[parts.length - 1]
      const subPath = parts.slice(1).join('/')
      const cfg = getAppConfig()
      const externalDirs = (cfg.modelExtraPaths || [])
        .filter(e => e.category === categoryDir)
        .map(e => e.path)
      for (const extDir of externalDirs) {
        // Сначала полный подпуть (как его видит ComfyUI), затем — только имя.
        for (const candidate of subPath !== fileName ? [subPath, fileName] : [fileName]) {
          const extPath = join(extDir, ...candidate.split('/'))
          if (existsSync(extPath) && sizeOk(extPath, model.sizeBytes)) return true
        }
      }
    }
    return false
  } catch {
    return false
  }
}

/**
 * (правка 138) Распаковать ИЗБРАННЫЕ файлы из zip (движок Bonsai с GitHub).
 * Распаковка через PowerShell Expand-Archive во временную папку + рекурсивный
 * поиск нужных файлов — не зависит от внутренней структуры архива.
 */
async function extractZipFiles(zipPath: string, targetDir: string, fileNames: string[]): Promise<void> {
  const { mkdtempSync, readdirSync, copyFileSync, rmSync } = await import('fs')
  const { execFile } = await import('child_process')
  const { promisify } = await import('util')
  const execFileAsync = promisify(execFile)
  const tmpDir = mkdtempSync(join(dirname(zipPath), 'unzip_'))
  try {
    const psZip = zipPath.replace(/'/g, "''")
    const psDir = tmpDir.replace(/'/g, "''")
    await execFileAsync(
      'powershell',
      ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${psZip}' -DestinationPath '${psDir}' -Force`],
      { timeout: 600_000, windowsHide: true },
    )
    const found = new Map<string, string>()
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if ((fileNames as string[]).includes(e.name) && !found.has(e.name)) found.set(e.name, p)
      }
    }
    walk(tmpDir)
    const missing = fileNames.filter(f => !found.has(f))
    if (missing.length > 0) {
      throw new Error(`В архиве отсутствуют файлы: ${missing.join(', ')}`)
    }
    mkdirSync(targetDir, { recursive: true })
    for (const f of fileNames) copyFileSync(found.get(f)!, join(targetDir, f))
    // zip удаляется ТОЛЬКО после успешной распаковки (в вызывающем коде):
    // при сбое Extract-Archive сохранённый zip позволяет докачать/повторить,
    // а не начинать сотни мегабайт заново.
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

/** Get status for all models */
export function getAllModelsStatus() {
  return MODELS.map(model => {
    // (правка 162) optional: true — модель не обязательна (баннер не требует)
    const optional = model.optional === true
    const active = activeDownloads.get(model.id)
    if (active && active.status === 'downloading') {
      return {
        id: model.id,
        label: model.label,
        relPath: model.relPath,
        sizeLabel: model.sizeLabel,
        category: model.category,
        status: 'downloading' as const,
        bytesReceived: active.bytesReceived,
        totalBytes: active.totalBytes,
        speed: active.speed,
        optional,
      }
    }
    const exists = modelExists(model.id)
    if (exists) {
      return {
        id: model.id,
        label: model.label,
        relPath: model.relPath,
        sizeLabel: model.sizeLabel,
        category: model.category,
        status: 'ready' as const,
        optional,
      }
    }
    if (active?.status === 'error') {
      return {
        id: model.id,
        label: model.label,
        relPath: model.relPath,
        sizeLabel: model.sizeLabel,
        category: model.category,
        status: 'error' as const,
        error: active.error,
        optional,
      }
    }
    if (active?.status === 'cancelled') {
      activeDownloads.delete(model.id)
    }
    return {
      id: model.id,
      label: model.label,
      relPath: model.relPath,
      sizeLabel: model.sizeLabel,
      category: model.category,
      status: 'missing' as const,
      optional,
    }
  })
}

const BONSAI_DOWNLOAD_BUNDLES: Record<string, readonly string[]> = {
  llm_assistant_bonsai: ['bonsai_engine_bin', 'bonsai_engine_cudart', 'bonsai_model', 'bonsai_mmproj'],
  llm_assistant_bonsai_light: ['bonsai_engine_bin', 'bonsai_engine_cudart', 'bonsai_model_light', 'bonsai_mmproj'],
}

/** Start downloading a model. Returns immediately; progress via getAllModelsStatus(). */
export async function startDownload(modelId: string): Promise<{ ok: boolean; error?: string }> {
  const bundle = BONSAI_DOWNLOAD_BUNDLES[modelId]
  if (bundle) {
    for (const bundledId of bundle) {
      const result = await startDownload(bundledId)
      const alreadyHandled = result.error === 'Download already in progress' || result.error === 'File already exists'
      if (!result.ok && !alreadyHandled) return result
    }
    return { ok: true }
  }

  const model = MODELS.find(m => m.id === modelId)
  if (!model) return { ok: false, error: 'Unknown model' }

  // Already downloading?
  const existing = activeDownloads.get(modelId)
  if (existing?.status === 'downloading') {
    return { ok: false, error: 'Download already in progress' }
  }

  // Already exists?
  if (modelExists(modelId)) {
    return { ok: false, error: 'File already exists' }
  }

  const absPath = modelAbsPath(model)
  // Zip-записи в одной папке получают разные временные имена: параллельные
  // архивы движка и CUDA не должны перезаписывать и распаковывать друг друга.
  // Суффикс .zip обязателен для PowerShell Expand-Archive.
  const tmpPath = absPath + (model.extractFiles ? `_${model.id}_tmp.zip` : '.downloading')

  // (факт-чек) Проверка свободного места ДО старта: раньше 21-гигабайтная
  // модель падала_generic write error в конце, вместо внятной ошибки.
  try {
    const dir = dirname(tmpPath)
    mkdirSync(dir, { recursive: true })
    // statfsSync может отсутствовать в старых рантаймах — обёрнуто в try
    const fsStat = statfsSync(dir)
    const free = BigInt(fsStat.bavail) * BigInt(fsStat.bsize)
    const needed = BigInt(Math.ceil(model.sizeBytes))
    if (free < needed) {
      return {
        ok: false,
        error: `Недостаточно места на диске: свободно ${(Number(free) / 1024 ** 3).toFixed(1)} ГБ, нужно ~${(model.sizeBytes / 1024 ** 3).toFixed(1)} ГБ`,
      }
    }
  } catch {
    /* statfs недоступен — не блокируем загрузку */
  }

  // Частичный файл НЕ удаляем: докачка (Range) вместо старта с нуля —
  // для 21 ГБ модели обрыв связи раньше означал начинать заново.
  let resumeBytes = 0
  try {
    if (existsSync(tmpPath)) resumeBytes = statSync(tmpPath).size
  } catch { /* ignore */ }

  // Create target directory
  try { mkdirSync(dirname(tmpPath), { recursive: true }) } catch (e) {
    return { ok: false, error: `Cannot create directory: ${e instanceof Error ? e.message : String(e)}` }
  }

  // Initialize state
  const state: DownloadState = {
    modelId,
    status: 'downloading',
    bytesReceived: resumeBytes,
    totalBytes: null,
    speed: 0,
    startedAt: Date.now(),
  }
  activeDownloads.set(modelId, state)

  // Create abort controller for cancellation
  const controller = new AbortController()
  abortControllers.set(modelId, controller)

  // Run download in background (don't await), сериализованно
  // (фикс) используем doDownloadWithRetry — автоматические ретраи при
  // сетевых сбоях (2 попытки с экспоненциальной задержкой)
  // (правка 337) .catch обязателен: doDownload теперь перевыбрасывает ошибку
  // (иначе ретраи не работали), и финальный reject без обработчика давал бы
  // unhandledRejection. Текст ошибки уже записан в state — здесь просто глушим.
  void enqueueDownload(() => doDownloadWithRetry(model, tmpPath, absPath, state, controller, resumeBytes))
    .catch(() => { /* ошибка уже в state.error */ })

  return { ok: true }
}

/**
 * (фикс) Ретраи при сетевых сбоях. Раньше один обрыв сети = пользователь
 * должен был вручную нажать «Скачать» снова. Теперь автоматически
 * повторяем 2 раза с экспоненциальной задержкой (1с, 2с).
 */
async function doDownloadWithRetry(
  model: ModelDef,
  tmpPath: string,
  finalPath: string,
  state: DownloadState,
  controller: AbortController,
  resumeBytes: number,
  maxRetries = 2,
): Promise<void> {
  let lastError: Error | null = null

  // (правка 337) Контроллер отмены живёт до конца ВСЕХ ретраев.
  try {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        // Экспоненциальная задержка: 1с, 2с
        const delay = Math.pow(2, attempt - 1) * 1000
        await new Promise(r => setTimeout(r, delay))
        // Обновляем resumeBytes — файл мог вырасти
        try {
          resumeBytes = statSync(tmpPath).size
        } catch {
          resumeBytes = 0
        }
        // (правка 587) Ребазим прогресс на фактический размер файла: в сорванной
        // попытке state.bytesReceived считает сетевые чанки и мог убежать вперёд
        // недописанного на диск файла — без сброса прогресс улетал за 100%.
        // lastBytes в doDownload стартует от state.bytesReceived (правка 350).
        state.bytesReceived = resumeBytes
      }
      
      await doDownload(model, tmpPath, finalPath, state, controller, resumeBytes)
      return // Успех — выходим
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e))
      
      // Отмена пользователем — не ретраим
      if (lastError.message === 'cancelled' || lastError.name === 'AbortError') {
        throw lastError
      }
      
      // 404 — модель не найдена, ретраи бесполезны
      if (lastError.message.includes('404')) {
        throw lastError
      }
      
      // Если это последний ретрай — бросаем ошибку
      if (attempt === maxRetries) {
        throw lastError
      }

      // (правка 337) Между ретраями возвращаем статус 'downloading':
      // doDownload уже выставил 'error' в state, но попытка не последняя —
      // UI не должен показывать фейл до исчерпания всех ретраев.
      state.status = 'downloading'
      delete state.error

      // Иначе — пробуем снова
    }
  }

  throw lastError || new Error('Unknown error')
  } finally {
    abortControllers.delete(model.id)
  }
}

async function doDownload(
  model: ModelDef,
  tmpPath: string,
  finalPath: string,
  state: DownloadState,
  controller: AbortController,
  resumeBytes: number,
) {
  const { renameSync } = await import('fs')
  
  // (фикс) Логирование — раньше при ошибке не было понятно, на каком этапе
  // упало скачивание. Теперь ключевые этапы пишутся в консоль.
  console.log(`[download] START: ${model.label} (${model.sizeLabel})`)
  if (resumeBytes > 0) {
    console.log(`[download] Resume: ${(resumeBytes / 1024 ** 3).toFixed(2)} ГБ already downloaded`)
  }
  
  try {
    // Range-докачка, если есть частичный файл (HuggingFace поддерживает)
    // (фикс) При 416 Range Not Satisfiable — сервер говорит, что такой
    // позиции в файле нет (файл обновился, URL изменился, хеш другой).
    // Удаляем частичный файл и начинаем с нуля — иначе зациклимся.
    const headers: Record<string, string> = { 'User-Agent': 'MiniMaxH3Studio/1.0' }
    let skip = 0
    if (resumeBytes > 0) {
      headers['Range'] = `bytes=${resumeBytes}-`
      skip = resumeBytes
    }
    
    let res = await fetch(model.url, { headers, signal: controller.signal })
    
    // (фикс) 404 — модель удалена или URL изменился. Отдельное сообщение,
    // чтобы пользователь понял, что это не сетевой сбой.
    if (res.status === 404) {
      throw new Error('Модель не найдена на HuggingFace (404). URL мог измениться или модель удалена. Проверьте models-config.ts.')
    }
    
    // (правка 142) 416 Range Not Satisfiable — частичный файл не соответствует
    // текущему файлу на сервере. Или сервер не поддерживает Range.
    // Раньше: пробовали докачать. Теперь: удаляем и начинаем с нуля — надёжнее.
    if (res.status === 416 && resumeBytes > 0) {
      console.log(`[download] 416: deleting partial file and starting fresh`)
      try {
        unlinkSync(tmpPath)
      } catch { /* ignore */ }
      resumeBytes = 0
      skip = 0
      delete headers['Range']
      state.bytesReceived = 0
      // Повторяем запрос без Range
      res = await fetch(model.url, { headers, signal: controller.signal })
    }
    
    if (!res.ok && !(res.status === 206 && resumeBytes > 0)) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`)
    }
    // Сервер проигнорировал Range (200 вместо 206) — пишем с нуля
    if (resumeBytes > 0 && res.status !== 206) {
      skip = 0
      state.bytesReceived = 0
    }

    // Get total size
    const contentLength = res.headers.get('content-length')
    if (contentLength) {
      state.totalBytes = parseInt(contentLength, 10) + skip
    }

    const body = res.body
    if (!body) throw new Error('No response body')

    // Read from web stream, write to file (append при докачке)
    const nodeStream = Readable.fromWeb(body as any)
    const fileStream = createWriteStream(tmpPath, { flags: skip > 0 ? 'a' : 'w' })

    let lastTime = Date.now()
    // (правка 350) При докачке (resume) lastBytes должен стартовать с уже
    // скачанного объёма: иначе первый расчёт скорости делил весь resumeFrom
    // на 0.5 с и показывал гигантский скачок скорости.
    let lastBytes = state.bytesReceived

    nodeStream.on('data', (chunk: Buffer) => {
      state.bytesReceived += chunk.length
      // Calculate speed every ~500ms
      const now = Date.now()
      if (now - lastTime >= 500) {
        // bytesReceived уже включает текущий чанк (строкой выше) — не считаем его дважды
        state.speed = (state.bytesReceived - lastBytes) / ((now - lastTime) / 1000)
        lastBytes = state.bytesReceived
        lastTime = now
      }
    })

    await new Promise<void>((resolve, reject) => {
      nodeStream.pipe(fileStream)
      fileStream.on('finish', () => {
        console.log(`[download] File stream finished: ${model.label}`)
        resolve()
      })
      // (фикс) ENOSPC — диск заполнился во время скачивания. Раньше ошибка
      // была общей, и пользователь не понимал, что нужно освободить место.
      fileStream.on('error', (err: any) => {
        console.error(`[download] File stream error: ${model.label}`, err.message)
        if (err.code === 'ENOSPC') {
          reject(new Error('Диск заполнился во время скачивания. Освободите место и нажмите «Скачать» снова — докачка продолжится с места обрыва.'))
        } else {
          reject(err)
        }
      })
      nodeStream.on('error', (err: any) => {
        console.error(`[download] Node stream error: ${model.label}`, err.message)
        reject(err)
      })
      // If aborted, destroy the file stream
      controller.signal.addEventListener('abort', () => {
        console.log(`[download] Aborted: ${model.label}`)
        fileStream.destroy()
        nodeStream.destroy()
        reject(new Error('cancelled'))
      })
    })

    // Финальная валидация размера: обрезанный файл (>1 МБ, но не полный)
    // раньше считался «готовым» и валился уже ComfyUI при загрузке.
    // (правка 351) Порог унифицирован с modelExists (~строка 111): файл валиден,
    // если скачано ≥ 90% ожидаемого размера (HuggingFace иногда обрывает
    // соединение в конце, последние мегабайты не доходят, но файл практически
    // полный). Раньше здесь был свой порог (1% + отдельная проверка 90%) —
    // два разных критерия «готовности» для одного и того же файла.
    try {
      const finalSize = statSync(tmpPath).size
      const completion = model.sizeBytes > 0 ? finalSize / model.sizeBytes : 1
      if (model.sizeBytes > 1_000_000 && completion < 0.9) {
        throw new Error(
          `Файл скачан не полностью (${(finalSize / 1024 ** 3).toFixed(2)} ГБ из ${(model.sizeBytes / 1024 ** 3).toFixed(2)} ГБ) — нажмите «Скачать» ещё раз`,
        )
      }
      if (completion < 1) {
        console.log(`[download] File ${Math.round(completion * 100)}% complete — accepting as valid`)
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes('не полностью')) throw e
      /* stat упал — не блокируем */
    }

    // Move tmp → final
    // (фикс) renameSync может упасть (права, переполнение inode) — раньше
    // ошибка не обрабатывалась, и state.status оставался 'downloading' forever.
    // (правка 138) zip-записи (движок Bonsai): вместо rename — распаковка
    // избранных файлов в целевой каталог, zip удаляется.
    if (model.extractFiles) {
      console.log(`[download] Extracting ${model.extractFiles.length} files from zip: ${model.label}`)
      mkdirSync(dirname(finalPath), { recursive: true })
      await extractZipFiles(tmpPath, finalPath, model.extractFiles)
      try { unlinkSync(tmpPath) } catch { /* уже удалён */ }
    } else {
      console.log(`[download] Renaming: ${tmpPath} → ${finalPath}`)
      try {
        renameSync(tmpPath, finalPath)
      } catch (e) {
        throw new Error(`Не удалось переименовать файл: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    state.status = 'done'
    state.speed = 0
    console.log(`[download] DONE: ${model.label}`)
    // «done»-записи никто не читает (статус берётся с диска) — удаляем,
    // иначе карта растёт всю сессию.
    activeDownloads.delete(model.id)
  } catch (e) {
    const isCancel = e instanceof Error && (e.message === 'cancelled' || e.name === 'AbortError')
    state.status = isCancel ? 'cancelled' : 'error'
    state.error = isCancel ? 'Отменено пользователем' : (e instanceof Error ? e.message : String(e))
    state.speed = 0
    // (фикс) Логирование ошибок — раньше при сбое не было понятно, что произошло
    console.error(`[download] ${isCancel ? 'CANCELLED' : 'ERROR'}: ${model.label}`)
    if (!isCancel) {
      console.error(`[download] Error: ${state.error}`)
    }
    // Частичный файл СОХРАНЯЕМ: повторная загрузка докачает с места обрыва,
    // а не начнёт 21 ГБ заново. Полный файл после валидации уже переименован.
    // (правка 337) Ошибку ПЕРЕВЫБРАСЫВАЕМ: раньше catch глотал её, и
    // doDownloadWithRetry считал попытку успешной — ретраи были мёртвым кодом.
    // Статус/ошибка в state уже выставлены выше; doDownloadWithRetry решит,
    // ретраить ли (и вернёт статус 'downloading') или это финальный фейл.
    throw e
  } finally {
    // (правка 337) Контроллер удаляет doDownloadWithRetry (после ВСЕХ попыток):
    // иначе после первого неудачного ретрая отмена пользователем переставала
    // работать — abortControllers уже пуст.
  }
}

/** Cancel an active download. */
export function cancelDownload(modelId: string): { ok: boolean; error?: string } {
  const controller = abortControllers.get(modelId)
  if (!controller) {
    return { ok: false, error: 'Нет активного скачивания' }
  }
  // Abort действует и на задачу, ещё стоящую в очереди: doDownload увидит
  // уже отменённый signal на первом же fetch и завершится как «cancelled».
  controller.abort()
  return { ok: true }
}

/**
 * (правка 139) Удалить скачанные файлы модели (освобождение места, когда
 * модель больше не нужна — например, выбрана альтернатива). Стирает и хвосты
 * незавершённых загрузок (.downloading / _tmp.zip). Гварда «не удалять активную
 * модель ассистента» живёт в роуте /api/models/delete — там виден конфиг.
 */
export function deleteModel(modelId: string): { ok: boolean; error?: string } {
  const model = MODELS.find(m => m.id === modelId)
  if (!model) return { ok: false, error: 'Unknown model' }
  const active = activeDownloads.get(modelId)
  if (active?.status === 'downloading') {
    return { ok: false, error: 'Скачивание ещё идёт — сначала отмените его' }
  }
  const absPath = modelAbsPath(model)
  try {
    if (model.extractFiles) {
      // zip-записи (движок Bonsai): удаляем извлечённые файлы по списку
      let removed = 0
      for (const f of model.extractFiles) {
        try { unlinkSync(join(absPath, f)); removed++ } catch { /* файла нет — ок */ }
      }
      console.log(`[download] Deleted ${removed}/${model.extractFiles.length} files: ${model.label}`)
    } else {
      if (existsSync(absPath)) unlinkSync(absPath)
      console.log(`[download] Deleted: ${model.label}`)
    }
    // Хвосты незавершённых загрузок, включая общий ZIP от старых версий.
    for (const tail of [absPath + '.downloading', absPath + `_${modelId}_tmp.zip`, absPath + '_tmp.zip']) {
      try { unlinkSync(tail) } catch { /* нет — ок */ }
    }
    // (правка 352) Чистим застрявший error/cancelled-статус: после удаления
    // модели запись в activeDownloads бессмысленна, а getAllModelsStatus
    // показывал бы «ошибку» для уже удалённого файла до перезапуска.
    activeDownloads.delete(modelId)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: `Не удалось удалить файл: ${e instanceof Error ? e.message : String(e)}` }
  }
}


