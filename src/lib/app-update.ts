/**
 * (правка 790) Автосредство обновления самой студии — «уровень 2»:
 * приложение САМО проверяет релизы на GitHub, скачивает update.zip,
 * проверяет SHA256, распаковывает в staging, а замену файлов делает
 * внешний скрипт install\apply_update.ps1 (его запускает Electron перед
 * выходом — web-сервер не может убить сам себя, см. h3:apply-update).
 *
 * Схема:
 *   • фид — GitHub Releases API (releases/latest), переопределяется
 *     переменной UPDATE_FEED_URL в .env (для тестовых релизов);
 *   • актив — строго имя ASSET_NAME; digest из API = «sha256:...»;
 *   • загрузка — .update\update.zip.part с Range-докачкой (паттерн
 *     model-downloader: обрыв связи ≠ начать с нуля);
 *   • распаковка — системный tar.exe (Windows 10+, умеет zip) в .update\staging;
 *   • «взведённое» обновление (.update\armed.json) переживает перезапуск:
 *     кнопка «Перезапустить и установить» появляется сразу после старта.
 *
 * Обновляемый состав (см. scripts/make-update-zip.mjs): дерево git-файлов +
 * сжатая production-сборка .next. node_modules, ComfyUI, модели, офлайн-кэш
 * апдейтер НЕ трогает. Если package-lock.json изменился, apply_update.ps1
 * после замены сам запускает окно установки зависимостей.
 */
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'

const ROOT = process.cwd()
const UPDATE_DIR = join(ROOT, '.update')
const ZIP_PATH = join(UPDATE_DIR, 'update.zip')
const PART = join(UPDATE_DIR, 'update.zip.part')
const STAGING = join(UPDATE_DIR, 'staging')
const ARMED = join(UPDATE_DIR, 'armed.json')
const ZIP_META = join(UPDATE_DIR, 'update_zip.json')
const DL_META = join(UPDATE_DIR, 'update_download.json')

export const FEED_URL_DEFAULT = 'https://api.github.com/repos/EvgenRublev/Minimax_Studio/releases/latest'
export const ASSET_NAME = 'Minimax_Studio_update.zip'

/* ── типы ─────────────────────────────────────────────────────────────── */

export interface UpdateInfo {
  version: string
  url: string
  sizeBytes: number
  /** hex sha256 из asset.digest GitHub; пустая строка — фид не дал digest */
  sha256: string
  /** страница релиза (кнопка «Открыть релиз») */
  htmlUrl: string
  /** текст body релиза (список изменений) */
  notes: string
}

export interface DownloadState {
  status: 'downloading' | 'done' | 'error' | 'cancelled'
  version: string
  bytesReceived: number
  totalBytes: number | null
  speed: number
  error?: string
  startedAt: number
}

export interface ArmedUpdate {
  version: string
  ts: string
  depsChanged: boolean
}

interface ZipMeta {
  version: string
  sha256: string
  sizeBytes: number
  ts: string
}

/* ── мелкие хелперы ───────────────────────────────────────────────────── */

export function getAppVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    return String(pkg.version ?? '0.0.0')
  } catch {
    return '0.0.0'
  }
}

/** Семвер-сравнение по числовым сегментам: >0 если a новее b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0)
  const pb = b.replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d !== 0) return d
  }
  return 0
}

function readJsonSafe<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

function writeJson(file: string, obj: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(obj, null, 2))
}

/** SHA256 файла (стримом — zip может быть десятки мегабайт). */
function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const rs = createReadStream(file)
    rs.on('data', (d: string | Buffer) => hash.update(d))
    rs.on('end', () => resolve(hash.digest('hex')))
    rs.on('error', reject)
  })
}

/* ── проверка фида (кэш 10 минут — GitHub API лимит 60 запросов/ч на IP) ── */

interface FeedCache {
  ts: number
  info: UpdateInfo | null
  error?: string
}
let feedCache: FeedCache | null = null
const FEED_TTL_MS = 10 * 60_000

function feedUrl(): string {
  const custom = process.env.UPDATE_FEED_URL?.trim()
  return custom && custom.startsWith('http') ? custom : FEED_URL_DEFAULT
}

interface GhAsset {
  name: string
  browser_download_url: string
  size?: number
  digest?: string
}
interface GhRelease {
  tag_name?: string
  body?: string
  html_url?: string
  assets?: GhAsset[]
}

async function fetchFeed(): Promise<FeedCache> {
  if (feedCache && Date.now() - feedCache.ts < FEED_TTL_MS) return feedCache
  const cache: FeedCache = { ts: Date.now(), info: null }
  try {
    const res = await fetch(feedUrl(), {
      headers: {
        'User-Agent': 'MiniMaxH3Studio',
        Accept: 'application/vnd.github+json',
      },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      cache.error = `GitHub API ответил ${res.status}`
    } else {
      const rel = (await res.json()) as GhRelease
      const asset = (rel.assets ?? []).find((a) => a.name === ASSET_NAME)
      if (!rel.tag_name || !asset?.browser_download_url) {
        cache.error = `В релизе нет файла ${ASSET_NAME}`
      } else {
        cache.info = {
          version: String(rel.tag_name).replace(/^v/i, ''),
          url: asset.browser_download_url,
          sizeBytes: Number(asset.size ?? 0),
          sha256: (asset.digest ?? '').replace(/^sha256:/i, ''),
          htmlUrl: rel.html_url ?? '',
          notes: typeof rel.body === 'string' ? rel.body : '',
        }
      }
    }
  } catch (e) {
    cache.error = e instanceof Error ? e.message : String(e)
  }
  feedCache = cache
  return cache
}

export interface CheckResult {
  ok: boolean
  current: string
  error?: string
  update?: UpdateInfo
  /** есть ли уже скачанное/взведённое обновление (кнопка «Перезапустить и установить») */
  armed?: ArmedUpdate
  downloadedVersion?: string
}

export async function checkForUpdate(force = false): Promise<CheckResult> {
  const current = getAppVersion()
  const armed = readJsonSafe<ArmedUpdate>(ARMED)
  const zip = readJsonSafe<ZipMeta>(ZIP_META)
  const base: CheckResult = { ok: true, current }
  if (armed) base.armed = armed
  if (zip) base.downloadedVersion = zip.version

  if (force) feedCache = null
  const feed = await fetchFeed()
  if (!feed.info) {
    return { ...base, ok: false, error: feed.error ?? 'Не удалось получить данные релиза' }
  }
  if (compareVersions(feed.info.version, current) > 0) base.update = feed.info
  return base
}

/* ── загрузка zip (Range-докачка, прогресс, отмена — как model-downloader) ── */

let dlState: DownloadState | null = null
let dlController: AbortController | null = null

export function getDownloadState(): DownloadState | null {
  return dlState
}

export function cancelDownload(): { ok: boolean } {
  if (dlController) dlController.abort()
  return { ok: true }
}

export async function startUpdateDownload(info: UpdateInfo): Promise<{ ok: boolean; error?: string }> {
  if (dlState?.status === 'downloading') return { ok: false, error: 'Загрузка уже идёт' }

  mkdirSync(UPDATE_DIR, { recursive: true })

  // (правка 790) Проверка места: zip + распакованный staging + backup.
  try {
    const fsStat = statfsSync(UPDATE_DIR)
    const free = BigInt(fsStat.bavail) * BigInt(fsStat.bsize)
    const needed = BigInt(Math.max(1, info.sizeBytes)) * BigInt(3) + BigInt(200000000)
    if (free < needed) {
      return {
        ok: false,
        error: `Недостаточно места на диске: свободно ${(Number(free) / 1024 ** 3).toFixed(1)} ГБ, нужно ~${(Number(needed) / 1024 ** 3).toFixed(1)} ГБ`,
      }
    }
  } catch { /* statfs недоступен — не блокируем */ }

  // Мета частицы: при смене версии/размера старый .part не наш — удаляем.
  const meta: ZipMeta = {
    version: info.version,
    sha256: info.sha256,
    sizeBytes: info.sizeBytes,
    ts: new Date().toISOString(),
  }
  let resumeBytes = 0
  if (existsSync(PART)) {
    const oldMeta = readJsonSafe<ZipMeta>(DL_META)
    const partSize = statSync(PART).size
    if (oldMeta && oldMeta.version === info.version && (!oldMeta.sizeBytes || partSize <= oldMeta.sizeBytes)) {
      resumeBytes = partSize
    } else {
      try { unlinkSync(PART) } catch { /* ignore */ }
    }
  }
  writeJson(DL_META, meta)

  dlState = {
    status: 'downloading',
    version: info.version,
    bytesReceived: resumeBytes,
    totalBytes: info.sizeBytes || null,
    speed: 0,
    startedAt: Date.now(),
  }
  dlController = new AbortController()

  void doUpdateDownload(info, resumeBytes).catch(() => { /* ошибка уже в dlState */ })
  return { ok: true }
}

async function doUpdateDownload(info: UpdateInfo, resumeBytes: number): Promise<void> {
  const state = dlState!
  const controller = dlController!
  const headers: Record<string, string> = { 'User-Agent': 'MiniMaxH3Studio' }
  let skip = 0
  if (resumeBytes > 0) {
    headers['Range'] = `bytes=${resumeBytes}-`
    skip = resumeBytes
  }

  try {
    let res = await fetch(info.url, { headers, signal: controller.signal })

    // 416 — частица не соответствует текущему файлу на сервере: качаем с нуля.
    if (res.status === 416 && resumeBytes > 0) {
      try { unlinkSync(PART) } catch { /* ignore */ }
      resumeBytes = 0
      skip = 0
      delete headers['Range']
      state.bytesReceived = 0
      res = await fetch(info.url, { headers, signal: controller.signal })
    }
    if (!res.ok && !(res.status === 206 && resumeBytes > 0)) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`)
    }
    // Сервер проигнорировал Range (200 вместо 206) — пишем с нуля.
    if (resumeBytes > 0 && res.status !== 206) {
      skip = 0
      state.bytesReceived = 0
    }

    const contentLength = res.headers.get('content-length')
    if (contentLength) state.totalBytes = parseInt(contentLength, 10) + skip

    const body = res.body
    if (!body) throw new Error('No response body')

    const nodeStream = Readable.fromWeb(body as import('node:stream/web').ReadableStream)
    const fileStream = createWriteStream(PART, { flags: skip > 0 ? 'a' : 'w' })

    let lastTime = Date.now()
    let lastBytes = state.bytesReceived
    nodeStream.on('data', (chunk: Buffer) => {
      state.bytesReceived += chunk.length
      const now = Date.now()
      if (now - lastTime >= 500) {
        state.speed = (state.bytesReceived - lastBytes) / ((now - lastTime) / 1000)
        lastBytes = state.bytesReceived
        lastTime = now
      }
    })

    await new Promise<void>((resolve, reject) => {
      nodeStream.pipe(fileStream)
      // 'close', а не 'finish': fd закрывается асинхронно ПОСЛЕ finish,
      // и rename сразу после finish падал с EPERM на Windows (правка 731).
      fileStream.on('close', () => resolve())
      fileStream.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOSPC') reject(new Error('Диск заполнился во время скачивания — освободите место'))
        else reject(err)
      })
      nodeStream.on('error', reject)
      controller.signal.addEventListener('abort', () => {
        fileStream.destroy()
        nodeStream.destroy()
        reject(new Error('cancelled'))
      })
    })

    // Финальная проверка размера.
    const finalSize = statSync(PART).size
    if (info.sizeBytes > 0 && finalSize !== info.sizeBytes) {
      throw new Error(`Размер файла не совпадает: ${finalSize} из ${info.sizeBytes} байт — попробуйте скачать снова`)
    }

    // SHA256: сравниваем с digest из фида (если фид его дал) или с сохранённым.
    if (info.sha256) {
      state.status = 'downloading' // фаза проверки тоже идёт в прогрессе UI
      const actual = await sha256File(PART)
      if (actual !== info.sha256) {
        try { unlinkSync(PART) } catch { /* ignore */ }
        throw new Error('Контрольная сумма файла не совпала (sha256) — файл повреждён при скачивании, попробуйте снова')
      }
    }

    // Финализация: renameSync может пасть (EPERM антивирус) — ретраим.
    if (existsSync(ZIP_PATH)) {
      try { unlinkSync(ZIP_PATH) } catch { /* ignore */ }
    }
    renameWithRetry(PART, ZIP_PATH)
    writeJson(ZIP_META, {
      version: info.version,
      sha256: info.sha256,
      sizeBytes: info.sizeBytes || finalSize,
      ts: new Date().toISOString(),
    })
    try { unlinkSync(DL_META) } catch { /* ignore */ }
    state.status = 'done'
    state.speed = 0
    console.log(`[update] zip скачан и проверен: v${info.version}`)

    // (правка 790) Автоподготовка: сразу раскладываем staging и пишем
    // armed.json — пользователю остаётся только «Перезапустить и установить».
    // Ошибка автоподготовки не отменяет скачивание: кнопка «Установить»
    // в панели повторит prepare вручную.
    void prepareApply().then((r) => {
      if (!r.ok) console.error('[update] автоподготовка не удалась:', r.error)
    }).catch((e) => console.error('[update] автоподготовка:', e))
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg === 'cancelled' || (e instanceof Error && e.name === 'AbortError')) {
      state.status = 'cancelled' // .part остаётся — следующая загрузка продолжит
    } else {
      state.status = 'error'
      state.error = msg
      console.error('[update] ошибка загрузки:', msg)
    }
  } finally {
    dlController = null
  }
}

function renameWithRetry(from: string, to: string): void {
  let lastErr: unknown = null
  for (let i = 0; i < 5; i++) {
    try {
      renameSync(from, to)
      return
    } catch (e) {
      lastErr = e
      const t = Date.now() + 500 * (i + 1)
      while (Date.now() < t) { /* короткое ожидание без таймеров в синк-пути */ }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/* ── распаковка и «взведение» обновления ─────────────────────────────────── */

export function getArmed(): ArmedUpdate | null {
  return readJsonSafe<ArmedUpdate>(ARMED)
}

function clearDir(dir: string): void {
  try {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  } catch { /* ignore */ }
  mkdirSync(dir, { recursive: true })
}

/** Системный tar.exe (Windows 10+, libarchive) умеет читать zip. */
function extractZip(zip: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    const proc = spawn(existsSync(tar) ? tar : 'tar', ['-xf', zip, '-C', dest], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('error', (e) => reject(new Error(`не удалось запустить tar.exe: ${e.message}`)))
    proc.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`tar.exe завершился с кодом ${code}: ${stderr.slice(0, 300)}`))
    })
  })
}

/**
 * Проверить скачанный zip, распаковать в .update\staging и записать armed.json.
 * Сама замена файлов — дело install\apply_update.ps1 (его запускает Electron).
 */
export async function prepareApply(): Promise<{ ok: boolean; error?: string; armed?: ArmedUpdate; depsChanged?: boolean }> {
  // (правка 791) Идемпотентность: автоподготовка после скачивания уже раскладывала
  // staging и записала armed.json, а zip с мета удалила (экономия места). Повторный
  // вызов кнопки «Перезапустить и установить» не должен требовать zip — иначе
  // взведённое обновление нельзя установить (баг теста 7.1.3).
  const armedNow = readJsonSafe<ArmedUpdate>(ARMED)
  if (armedNow) {
    if (existsSync(join(STAGING, 'package.json')) && existsSync(join(STAGING, '.next', 'BUILD_ID'))) {
      return { ok: true, armed: armedNow, depsChanged: armedNow.depsChanged }
    }
    // Staging потерян (ручная чистка и т.п.). Без zip раскладывать нечего.
    try { unlinkSync(ARMED) } catch { /* ignore */ }
    if (!existsSync(ZIP_PATH)) {
      return { ok: false, error: 'Подготовленные файлы обновления потеряны — скачайте обновление заново' }
    }
  }

  const meta = readJsonSafe<ZipMeta>(ZIP_META)
  if (!meta || !existsSync(ZIP_PATH)) {
    return { ok: false, error: 'Обновление ещё не скачано — сначала нажмите «Скачать»' }
  }

  // (правка 790) Тотальная проверка перед взведением: digest из фида, если
  // фид его даёт (вдруг актив заменили между скачиванием и применением),
  // иначе — хэш, зафиксированный при скачивании.
  const feed = await fetchFeed()
  const expected = feed.info?.sha256 || meta.sha256
  const actual = await sha256File(ZIP_PATH)
  if (expected && actual !== expected) {
    try { unlinkSync(ZIP_PATH) } catch { /* ignore */ }
    try { unlinkSync(ZIP_META) } catch { /* ignore */ }
    return { ok: false, error: 'Контрольная сумма скачанного файла не совпала — удалите обновление и скачайте заново' }
  }

  clearDir(STAGING)
  await extractZip(ZIP_PATH, STAGING)

  // Sanity-проверка состава: staging должен выглядеть как корень проекта.
  const pkg = readJsonSafe<{ version?: string }>(join(STAGING, 'package.json'))
  if (!pkg?.version) {
    clearDir(STAGING)
    return { ok: false, error: 'В архиве нет package.json — архив повреждён, скачайте обновление заново' }
  }
  if (pkg.version !== meta.version) {
    clearDir(STAGING)
    return { ok: false, error: `Версия в архиве (${pkg.version}) не совпадает с релизом (${meta.version})` }
  }
  if (!existsSync(join(STAGING, '.next', 'BUILD_ID'))) {
    clearDir(STAGING)
    return { ok: false, error: 'В архиве нет готовой сборки .next — архив неполный' }
  }

  // Зависимости меняются? Хэш package-lock в архиве vs у пользователя.
  let depsChanged = true
  try {
    const a = createHash('sha256').update(readFileSync(join(ROOT, 'package-lock.json'))).digest('hex')
    const b = createHash('sha256').update(readFileSync(join(STAGING, 'package-lock.json'))).digest('hex')
    depsChanged = a !== b
  } catch { depsChanged = true }

  const armed: ArmedUpdate = {
    version: meta.version,
    ts: new Date().toISOString(),
    depsChanged,
  }
  writeJson(ARMED, armed)
  // zip больше не нужен (staging уже разложен), экономим место.
  try { unlinkSync(ZIP_PATH) } catch { /* ignore */ }
  try { unlinkSync(ZIP_META) } catch { /* ignore */ }
  console.log(`[update] обновление v${armed.version} разложено в staging (depsChanged=${depsChanged})`)
  return { ok: true, armed, depsChanged }
}

/** Отказ от взведённого/скачанного обновления (удаляет всё в .update, кроме логов). */
export function discardUpdate(): { ok: boolean } {
  try { unlinkSync(ARMED) } catch { /* ignore */ }
  try { unlinkSync(ZIP_META) } catch { /* ignore */ }
  try { unlinkSync(DL_META) } catch { /* ignore */ }
  try { unlinkSync(ZIP_PATH) } catch { /* ignore */ }
  try { rmSync(STAGING, { recursive: true, force: true }) } catch { /* ignore */ }
  // Бэкап НЕ трогаем: его создаёт и удаляет apply_update.ps1 в момент замены.
  return { ok: true }
}
