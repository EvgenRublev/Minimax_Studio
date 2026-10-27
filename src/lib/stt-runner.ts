/**
 * STT runner (правка 65) — lazy spawn/stop of the bundled speech-to-text
 * service (whisper / transcribe.cpp).
 *
 * The service runs inside the ComfyUI embedded python (tools/stt_server.py,
 * ctypes → <project>/stt/transcribe.dll — self-contained, portable) on
 * 127.0.0.1:8091. CPU-only by design.
 *
 * The module only manages spawn/stop/health — VRAM arbitration is NOT
 * involved (STT never touches the GPU).
 */
import { spawn, execFile, type ChildProcess } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import { getAppConfig } from './app-config'

const execFileAsync = promisify(execFile)

export const STT_PORT = 8091

export interface SttStartResult {
  ok: boolean
  error?: string
}

export interface SttStatus {
  running: boolean
  starting: boolean
  error: string | null
  startedAt: number
}

let child: ChildProcess | null = null
let starting: Promise<SttStartResult> | null = null
let lastError: string | null = null
let startedAt = 0
/**
 * (правка 345) pendingStop — пользователь нажал «Остановить», пока сервер
 * ещё стартует (starting-промис активен, child может ещё не существовать).
 * Раньше такой stop терялся: stopStt видел child=null и выходил, а спавн
 * продолжался. Теперь starting-ветка проверяет флаг после spawn и в healthUp.
 */
let pendingStop = false
/**
 * (правка 743) Хвост вывода дочернего STT-сервера (stdout + stderr). По нему
 * показываем РЕАЛЬНУЮ причину сбоя («transcribe.dll не найдена: …», ошибка
 * загрузки модели), а не общую догадку «нет модели или DLL». Раньше
 * пользователь видел один и тот же текст независимо от настоящей ошибки.
 * Важно: stt_server.py печатает и ошибки, и обычный лог в stdout через log().
 */
let childTail = ''

// (правка 348) Сироты: при выходе Node-процесса (закрытие студии) дочерний
// STT-сервер оставался жить на порту 8091 до своего idle-таймаута (15 мин).
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

export function sttStatus(): SttStatus {
  return {
    // exitCode/signalCode — процесс мог выйти, а exit-событие ещё не обработано
    running: !!child && !child.killed && child.exitCode === null && child.signalCode === null,
    starting: !!starting,
    error: lastError,
    startedAt,
  }
}

/**
 * (правка 743) Последняя содержательная строка вывода → причина сбоя.
 * Python печатает `[stt] ОШИБКА: …` или `RuntimeError: …` — убираем префиксы
 * и оставляем человеческий текст.
 */
function childFailureReason(): string | null {
  const lines = childTail.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (!lines.length) return null
  const pick = [...lines].reverse().find((l) => /error|ошибка|exception|не найден|не удалось|failed/iu.test(l)) ?? lines[lines.length - 1]
  const msg = pick
    .replace(/^\[stt\]\s*/i, '')
    .replace(/^(?:ОШИБКА|ERROR|FAILED)\s*:\s*/iu, '')
    .replace(/^(?:[A-Za-z_.]*Error|Exception):\s*/, '')
    .trim()
  return msg ? msg.slice(0, 300) : null
}

async function healthUp(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  const proc = child
  while (Date.now() < deadline) {
    // Процесс умер (упал на старте) — не поллим мёртвый порт до таймаута
    if (!proc || proc.killed || proc.exitCode !== null || proc.signalCode !== null) return false
    if (!child) return false
    // (правка 345) Пользователь нажал «Остановить» во время загрузки модели.
    if (pendingStop) return false
    try {
      const r = await fetch(`http://127.0.0.1:${STT_PORT}/health`, {
        signal: AbortSignal.timeout(2000),
      })
      if (r.ok) return true
    } catch {
      /* not up yet — model still loading */
    }
    await new Promise((r) => setTimeout(r, 750))
  }
  return false
}

/** Start the STT service (idempotent). Resolves when /health answers. */
export async function ensureStt(): Promise<SttStartResult> {
  if (child && !child.killed) {
    // (правка 339) Процесс ВЫШЕЛ, а exit-событие ещё не обработано — это
    // мёртвый child: чистим ссылку и проваливаемся в холодный спавн ниже,
    // вместо 5 с поллинга заведомо мёртвого порта.
    if (child.exitCode !== null || child.signalCode !== null) {
      child = null
    } else {
      const ok = await healthUp(5000)
      if (ok) {
        lastError = null
        return { ok: true }
      }
      // (правка 339) Полумёртвый STT: процесс ЖИВ, но /health молчит (деадлок
      // в whisper/transcribe.dll). Это НАШ отслеживаемый child (PID известен)
      // — убиваем и перезапускаем ниже, по образцу llm-runner (правка 259).
      // Раньше возвращали ошибку, и КАЖДЫЙ следующий запрос платил те же 5 с
      // без всякой попытки реанимации.
      if (child && child.pid) {
        console.warn('[stt] (правка 339) процесс жив, но /health молчит 5 с — убиваю и перезапускаю')
        await stopStt()
      } else {
        lastError = 'STT-сервер не отвечает'
        return { ok: false, error: lastError }
      }
    }
  }
  if (starting) return starting
  // (правка 345) Новый (пере)запуск — сбрасываем флаг остановки, выставленный
  // либо пользователем во время прошлого старта, либо внутренним stopStt выше.
  pendingStop = false

  starting = (async () => {
    let proc: ChildProcess | null = null
    try {
      const cfg = getAppConfig()
      if (!cfg.sttEnabled) {
        return { ok: false, error: 'Голосовой ввод отключён в настройках' }
      }

      // (правка 72) STT-рантайм встроен в проект: стт-папка рядом с tools/ (stt/).
      // Передаём явнo, чтобы не полагаться на дефолт сервера.
      const args = [
        path.join(process.cwd(), 'tools', 'stt_server.py'),
        '--stt-dir', cfg.sttDir,
        '--port', String(STT_PORT),
        '--language', cfg.sttLanguage,
        '--threads', String(cfg.sttThreads),
        '--idle-sec', '900',
      ]
      // Empty sttModel = let the server auto-pick the first model it finds.
      if (cfg.sttModel) args.push('--model', cfg.sttModel)

      proc = spawn(cfg.pythonExe, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      child = proc
      startedAt = Date.now()
      childTail = ''
      proc.stdout?.on('data', (d: Buffer) => {
        process.stdout.write(`[stt] ${d}`)
        // (правка 743) stt_server.py пишет и лог, и текст ошибки в stdout.
        childTail = (childTail + d.toString()).slice(-4000)
      })
      proc.stderr?.on('data', (d: Buffer) => {
        process.stderr.write(`[stt] ${d}`)
        childTail = (childTail + d.toString()).slice(-4000)
      })
      proc.on('exit', () => {
        if (child === proc) {
          child = null
        }
      })

      // (правка 345) Stop пришёл, пока шёл spawn (child был null) — убиваем
      // только что созданный процесс, а не продолжаем загрузку модели.
      if (pendingStop) {
        try { proc.kill() } catch { /* ignore */ }
        if (child === proc) child = null
        return { ok: false, error: 'Остановлено пользователем' }
      }

      // Model load is the slow part (CPU, hundreds of MB) — allow 2 minutes.
      const up = await healthUp(120_000)
      if (!up) {
        // (правка 345) Stop во время загрузки модели — не ошибка запуска.
        if (pendingStop) {
          try { proc.kill() } catch { /* ignore */ }
          if (child === proc) child = null
          return { ok: false, error: 'Остановлено пользователем' }
        }
        // (правка 743) Показываем настоящую причину из stderr дочернего
        // процесса (например, «transcribe.dll не найдена: <путь>»), а не
        // общую догадку. Общий текст — только если процесс молчал.
        const reason = childFailureReason()
        const err = reason
          ? `STT-сервер не запустился: ${reason}`
          : 'STT-сервер не запустился: нет модели STT или не найдена transcribe.dll (см. консоль и настройки «Голосовой ввод»)'
        lastError = err
        if (child === proc) {
          try { proc.kill() } catch { /* уже мёртв */ }
          child = null
        }
        return { ok: false, error: err }
      }
      lastError = null
      return { ok: true }
    } catch (err) {
      if (proc && child === proc) {
        try { proc.kill() } catch { /* ignore */ }
        child = null
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

/**
 * Stop the STT service: graceful POST /shutdown → wait for exit →
 * kill() → taskkill /F /T escalation (same contract as stopLlm).
 */
export async function stopStt(): Promise<void> {
  // (правка 345) Флаг выставляем ДО проверки child: во время старта child
  // может ещё не существовать, и starting-ветка увидит флаг после spawn.
  pendingStop = true
  const proc = child
  if (!proc) {
    child = null
    // (правка 355) Сбрасываем следы прошлого запуска: иначе статус после
    // остановки показывал протухший startedAt и старую ошибку.
    lastError = null
    startedAt = 0
    return
  }
  try {
    await fetch(`http://127.0.0.1:${STT_PORT}/shutdown`, {
      method: 'POST',
      signal: AbortSignal.timeout(3000),
    })
  } catch {
    /* сервер не отвечает — эскалация */
  }
  let exited = await waitForExit(proc, 8_000)
  if (!exited) {
    proc.kill()
    exited = await waitForExit(proc, 5_000)
  }
  if (!exited && proc.pid) {
    try {
      await execFileAsync('taskkill', ['/F', '/T', '/PID', String(proc.pid)])
    } catch {
      /* процесс мог уже выйти */
    }
    await waitForExit(proc, 5_000)
  }
  if (child === proc) {
    child = null
  }
  // (правка 355) См. выше: не оставляем протухшие error/startedAt.
  lastError = null
  startedAt = 0
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
