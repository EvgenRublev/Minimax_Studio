/**
 * Upscale runner (правка 74) — lazy spawn/stop of the bundled
 * DLSS 5 Visual Enhancer bridge (upscale/bridge.py, native JSON API).
 *
 * The bridge runs on the embedded Python (upscale/bin/python-3.13.15-embed-amd64)
 * and exposes the DLSS pipelines (Neural Rendering / RTX VSR / Frame
 * Interpolation) over localhost HTTP. The browser talks to the Next.js
 * /api/upscale/* routes only; this module manages spawn/stop/health.
 *
 * Spawning contract:
 *   - UPSCALE_BRIDGE_PORT pinned (health must hit a predictable URL)
 *   - UPSCALE_OUTPUT_DIR — rendered files are published to the common
 *     ComfyUI output folder (app-config outputDir), so they show up in the
 *     shared gallery, the Gallery tab and are cleaned by «Удалить контент»
 *   - PYTHONNOUSERSITE=1, PYTHONDONTWRITEBYTECODE=1, PYTHONIOENCODING=utf-8
 */
import { spawn, execFile, type ChildProcess } from 'child_process'
import { promisify } from 'util'
import { existsSync, mkdirSync } from 'fs'
import path from 'path'
import { getAppConfig } from './app-config'

const execFileAsync = promisify(execFile)

export interface UpscaleStartResult {
  ok: boolean
  error?: string
}

export interface UpscaleStatus {
  running: boolean
  starting: boolean
  error: string | null
  startedAt: number
}

export interface UpscaleHealth {
  ok: boolean
  ready: boolean
  error: string | null
  gpus: Array<{ uuid: string; label: string; ai_compatible: boolean; memory_gb: number }>
  output_dir: string
  features: string[]
  log_tail: string[]
}

export function upscaleDir(): string {
  return path.join(process.cwd(), 'upscale')
}

export function upscalePort(): number {
  return getAppConfig().upscalePort
}

export function bridgeUrl(base = '/'): string {
  return `http://127.0.0.1:${upscalePort()}${base}`
}

let child: ChildProcess | null = null
let starting: Promise<UpscaleStartResult> | null = null
let lastError: string | null = null
let startedAt = 0
/** Tail of the service stderr — quoted in error messages on early death. */
let stderrTail = ''
/**
 * (правка 77) adopted — на порту уже слушает ЗДОРОВЫЙ bridge (выжил после
 * перезапуска приложения/сессии), но это не наш child-процесс. Дубль не
 * спавним: «забираем» чужой — running=true, а при stop убиваем по PID из
 * netstat. Это и есть «быстрый запуск» после рестарта приложения, и это
 * убирает «призрачное» состояние (мёртвый child + сирота на порту → UI
 * вечно «не запущен», а health отвечает).
 */
let adopted = false
/**
 * (правка 77) manualStop — пользователь явно нажал «Остановить».
 * Автозапуск (tick клиента) не должен поднимать сервис обратно, пока
 * пользователь сам не нажмёт «Запустить» (force).
 */
let manualStop = false

// (правка 348) Сироты: при выходе Node-процесса (закрытие студии) дочерний
// bridge оставался жить на порту. Синхронный kill в обработчиках exit/сигналов.
const killChildSync = () => {
  if (child && child.pid && child.exitCode === null && child.signalCode === null) {
    try { child.kill() } catch { /* уже мёртв */ }
  }
}
process.once('exit', killChildSync)
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    killChildSync()
    process.exit(130)
  })
}

export function upscaleStatus(): UpscaleStatus {
  return {
    // (правка 716) Проверяем и signalCode: убитый сигналом процесс не должен
    // считаться «работающим» (llm-runner.ts и stt-runner.ts проверяют так же).
    running: (!!child && !child.killed && child.exitCode === null && child.signalCode === null) || adopted,
    starting: !!starting,
    error: lastError,
    startedAt,
  }
}

/** GET /health from the bridge. Fast; `ready` is polled by the UI. */
export async function fetchUpscaleHealth(timeoutMs = 3000): Promise<UpscaleHealth> {
  const r = await fetch(bridgeUrl('/health'), { signal: AbortSignal.timeout(timeoutMs) })
  if (!r.ok) throw new Error(`bridge /health → ${r.status}`)
  const data = (await r.json()) as UpscaleHealth
  return data
}

async function healthUp(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child && (child.killed || child.exitCode !== null || child.signalCode !== null)) {
      return false
    }
    // (правка 344) Пользователь нажал «Остановить» во время подъёма.
    if (manualStop) return false
    try {
      const r = await fetch(bridgeUrl('/health'), { signal: AbortSignal.timeout(2500) })
      if (r.ok) return true
    } catch {
      /* not up yet — heavy imports / runtime prep */
    }
    await new Promise((r) => setTimeout(r, 700))
  }
  return false
}

/** Kill the process tree (bridge has no children, but keep the pattern). */
function killTree(pid?: number) {
  if (process.platform === 'win32' && pid) {
    // taskkill почти всегда не нулевой exit, если PID уже умер — глотаем
    void execFileAsync('taskkill', ['/F', '/T', '/PID', String(pid)]).catch(() => {})
  }
}

function cleanChild(proc: ChildProcess) {
  if (child === proc) child = null
  try { proc.kill() } catch { /* уже мёртв */ }
}

function appendStderr(data: Buffer) {
  stderrTail = (stderrTail + data.toString('utf8')).slice(-8000)
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * (правка 77) PID-ы процессов, держащих порт (Windows, netstat -ano).
 * Best effort: пустой список, если netstat недоступен или слушателей нет.
 * Колонка состояния не проверяется (локализация); TIME_WAIT (PID «-»)
 * regex не ловит и игнорируется.
 */
async function findPortPids(port: number): Promise<number[]> {
  if (process.platform !== 'win32') return []
  try {
    const { stdout } = await execFileAsync('netstat', ['-ano'])
    const pids = new Set<number>()
    for (const line of stdout.split(/\r?\n/)) {
      // netstat -ano печатает строки с ведущими пробелами — trim обязателен.
      // (правка 340) Маркер LISTENING-сокета — foreign-адрес «все нули»:
      // на Windows netstat печатает '0.0.0.0:0' или '[::]:0', а Linux-формат
      // '*:*' здесь не встречается. Раньше проверялся только '*:*' → regex
      // не матчил НИ ОДНУ строку, и killPortHolders никого не убивал.
      const m = line.trim().match(/^tcp\s+(\S+):(\d+)\s+(\S+)\s+\S+\s+(\d+)/i)
      if (m && Number(m[2]) === port && (m[3] === '*:*' || m[3] === '0.0.0.0:0' || m[3] === '[::]:0')) {
        const pid = Number(m[4])
        if (Number.isFinite(pid) && pid > 0) pids.add(pid)
      }
    }
    return [...pids]
  } catch {
    return []
  }
}

/** (правка 77) Убить всех, кто держит порт (сиротный/зомби bridge). Best effort. */
async function killPortHolders(port: number): Promise<void> {
  const pids = await findPortPids(port)
  for (const pid of pids) killTree(pid)
}

/**
 * Start the Upscale bridge (idempotent). Resolves when /health answers.
 * First start can take ~30–60 s (imports + runtime validation + GPU detect).
 *
 * (правка 77) `opts.force` — явный «Запустить» из UI: сбрасывает manualStop.
 * Без force (автозапуск) — уважаем явную остановку пользователем.
 */
export async function ensureUpscale(opts: { force?: boolean } = {}): Promise<UpscaleStartResult> {
  // (правка 716) force обрабатывается ДО проверки starting. Раньше
  // `if (starting) return starting` стоял первым, и явное действие
  // пользователя («Запустить») терялось: force не доходил до сброса
  // manualStop, и в полёте оставался автостарт, который тут же
  // прерывался с «Остановлено пользователем».
  if (opts.force) manualStop = false
  if (starting) return starting
  // (правка 344) manualStop сбрасываем ТОЛЬКО здесь, при явном force из UI.
  // Раньше starting-промис безусловно обнулял флаг (manualStop = false после
  // spawn) — stopUpscale, пришедший ВО ВРЕМЯ старта, терялся: процесс всё
  // равно поднимался, хотя пользователь только что нажал «Остановить».
  if (manualStop && !opts.force) {
    return { ok: false, error: 'Сервис остановлен пользователем — нажмите «Запустить»' }
  }
  if (child && !child.killed && child.exitCode === null && child.signalCode === null) {
    const ok = await healthUp(8000)
    if (ok) {
      lastError = null
      return { ok: true }
    }
    // (фикс «полумёртвого» child) процесс жив, но /health не отвечает:
    // убиваем дерево и пересоздаём ниже — иначе статус вечно running=true,
    // health=null и UI зависает на «подготовка рантайма…» без автозапуска.
    killTree(child.pid)
    cleanChild(child)
  }
  if (adopted) {
    // (правка 77) уже «забрали» чужой здоровый bridge — проверяем, жив ли он.
    try {
      const h = await fetchUpscaleHealth(2500)
      if (h) {
        lastError = null
        return { ok: true }
      }
    } catch {
      /* bridge умер — пересоздаём ниже */
    }
    adopted = false
  }

  starting = (async () => {
    let proc: ChildProcess | null = null
    try {
      const cfg = getAppConfig()
      if (!cfg.upscaleEnabled) {
        return { ok: false, error: 'Вкладка Upscale отключена: config.ini → [upscale] enabled=1' }
      }

      const dir = upscaleDir()
      const pythonExe = path.join(dir, 'bin', 'python-3.13.15-embed-amd64', 'python.exe')
      const entry = path.join(dir, 'bridge.py')

      if (!existsSync(pythonExe)) {
        const msg = 'Не найден встроенный рантайм Upscale (upscale/bin/…). Папка upscale/ должна лежать рядом с start.bat.'
        lastError = msg
        return { ok: false, error: msg }
      }
      if (!existsSync(entry)) {
        const msg = `Не найден входной файл: ${entry}`
        lastError = msg
        return { ok: false, error: msg }
      }

      stderrTail = ''
      const port = upscalePort()
      // (правка 344) manualStop здесь НЕ сбрасываем — см. ensureUpscale выше.

      // (правка 77) Если на порту уже слушает ЗДОРОВЫЙ bridge (выжил после
      // перезапуска приложения), забираем его вместо спавна дубля: новый
      // процесс умер бы на bind, а healthUp «видел» бы сироту — призрачное
      // состояние «running=false, а service работает». Adoption = мгновенно.
      try {
        const h = await fetchUpscaleHealth(2500)
        if (h) {
          adopted = true
          startedAt = Date.now()
          lastError = null
          return { ok: true }
        }
      } catch {
        /* на порту нет здорового bridge — поднимем свой */
      }

      // (правка 77) Порт занят мёртвым процессом (зомби-слушатель) — освобождаем,
      // иначе наш bridge упадёт на bind и healthUp будет ждать до 3 минут.
      try {
        await killPortHolders(port)
        await sleep(600)
      } catch {
        /* best effort */
      }

      // Гарантируем, что общая папка output существует (бэкенд мог её не создать).
      try {
        mkdirSync(cfg.outputDir, { recursive: true })
      } catch {
        /* best effort — bridge создаст сам или отвалится с понятной ошибкой */
      }

      const env = {
        ...process.env,
        PYTHONNOUSERSITE: '1',
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONIOENCODING: 'utf-8',
        UPSCALE_BRIDGE_PORT: String(port),
        // (правка 74.2) результаты — в общую папку output ComfyUI, чтобы они
        // виделись в общей галерее и вкладке «Галерея».
        UPSCALE_OUTPUT_DIR: cfg.outputDir,
      }

      proc = spawn(pythonExe, [entry], {
        cwd: dir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      child = proc
      startedAt = Date.now()
      /* Мост пишет в stdout access-лог каждого HTTP-запроса, а клиентский
         синглтон пингует /health каждые 2.5 с — консоль студии заливало
         строками «GET /health 200». Фильтруем успешные health-пинги;
         всё остальное (рендер, ошибки, не-200 ответы) проходит как было. */
      proc.stdout?.on('data', (d: Buffer) => {
        for (const line of d.toString('utf8').split(/\r?\n/)) {
          if (!line) continue
          // формат моста: `HTTP "GET /health HTTP/1.1" 200 -`
          if (line.includes('GET /health') && /\s200\b/.test(line)) continue
          process.stdout.write(`[upscale] ${line}\n`)
        }
      })
      proc.stderr?.on('data', (d: Buffer) => {
        appendStderr(d)
        process.stderr.write(`[upscale] ${d}`)
      })
      proc.on('exit', () => {
        if (child === proc) {
          child = null
        }
      })

      // (правка 344) Stop пришёл, пока шёл spawn / adoption-проверки —
      // убиваем только что созданный процесс, а не продолжаем подъём.
      if (manualStop) {
        killTree(proc.pid)
        cleanChild(proc)
        return { ok: false, error: 'Остановлено пользователем' }
      }

      // Imports + runtime prep + GPU detection: allow 3 minutes.
      const up = await healthUp(180_000)
      if (!up) {
        // (правка 344) Stop во время prepare_runtime — не ошибка запуска.
        if (manualStop) {
          killTree(proc.pid)
          cleanChild(proc)
          return { ok: false, error: 'Остановлено пользователем' }
        }
        const tail = stderrTail.trim().split(/\r?\n/).slice(-3).join(' | ').slice(0, 400)
        const err = `Upscale не запустился: порт ${port} занят или процесс завершился. ${tail ? `Лог: ${tail}` : 'См. консоль'}`
        lastError = err
        if (child === proc) {
          killTree(proc.pid)
          cleanChild(proc)
        }
        return { ok: false, error: err }
      }
      lastError = null
      return { ok: true }
    } catch (err) {
      if (proc && child === proc) {
        killTree(proc.pid)
        cleanChild(proc)
      }
      const msg = err instanceof Error ? err.message : String(err)
      lastError = msg
      return { ok: false, error: msg }
    } finally {
      starting = null
    }
  })()

  return starting
}

/** Stop the Upscale bridge (no graceful endpoint — kill the process). */
export async function stopUpscale(): Promise<void> {
  // (правка 77) adopted-bridge — не наш child: убиваем по PID с порта.
  if (adopted) {
    const port = upscalePort()
    adopted = false
    manualStop = true
    try {
      await killPortHolders(port)
      await sleep(300)
    } catch {
      /* best effort */
    }
    lastError = null
    return
  }
  const proc = child
  if (!proc) {
    child = null
    manualStop = true
    return
  }
  manualStop = true
  killTree(proc.pid)
  const exited = await waitForExit(proc, 6_000)
  if (!exited) {
    // (фикс) процесс не умер за 6 с — force-убиваем и гарантированно чистим
    // child-ссылку. Раньше при неудачном втором waitForExit child оставался
    // «зависшим» в переменной, и ensureUpscale видел его как живого.
    cleanChild(proc)
    await waitForExit(proc, 4_000)
  }
  // (фикс) в любом исходе — если child всё ещё наш proc, сбрасываем.
  if (child === proc) child = null
  lastError = null
}

function waitForExit(p: ChildProcess, ms: number): Promise<boolean> {
  if (p.exitCode !== null || p.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms)
    p.once('exit', () => {
      clearTimeout(t)
      resolve(true)
    })
  })
}


