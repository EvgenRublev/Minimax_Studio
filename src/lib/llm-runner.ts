/**
 * LLM runner (правка 24) — lazy spawn/stop of the local assistant model.
 *
 * The model runs inside the ComfyUI embedded python (llama-cpp-python is
 * already installed there) via tools/llm_server.py on 127.0.0.1:8090.
 *
 * VRAM arbitration lives in vram-arbiter.ts (диспетчер LLM ↔ MiniMax):
 * этот модуль — только спавн/стоп LLM-сервера и его статус.
 */
import { spawn, execFile, type ChildProcess } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import { existsSync, statSync } from 'fs'
import { getAppConfig } from './app-config'
import { MODELS } from './models-config'
import { resolveModelFilePath } from './model-downloader'

const execFileAsync = promisify(execFile)

export const LLM_PORT = 8090
/** Модель ассистента по умолчанию — Qwen3.5 9B (Q4_K_M, vision).
 *  Bonsai 2 27B остаётся необязательным backend при явном выборе. */
export const LLM_MODEL_ID = 'llm_assistant_qwen'

/* ── (правка 136 / Bonsai) Второй бэкенд ассистента ──
 * Ternary Bonsai 2 27B (Qwen-семейство, тернарный квант PQ2_0, зрение через
 * mmproj) работает ТОЛЬКО на форке llama.cpp (PrismML) — тернарные кванты
 * обычный llama.cpp/llama-cpp-python не читает. Поэтому для неё спавнится
 * llama-server.exe из внешней портативной папки (config [llm] bonsai_dir) с
 * OpenAI-протоколом, вместо tools/llm_server.py на llama-cpp-python.
 * VRAM-арбитраж не меняется: процесс — наш child (llmPid/stopLlm работают). */
export type LlmBackend = 'standard' | 'bonsai' | 'custom'

/** Маркер в config [llm] model, включающий Bonsai-бэкенд. */
export const LLM_MODEL_BONSAI = 'bonsai'
/** (правка 168) Маркер для лёгкого кванта Bonsai PTQ1_0. */
export const LLM_MODEL_BONSAI_LIGHT = 'bonsai_light'
/** (правка 467) Маркер своей GGUF-модели: появляется пунктом в селекторе
 *  модели ассистента, когда задан [llm] custom_model. */
export const LLM_MODEL_CUSTOM = 'llm_custom'

export function llmBackend(): LlmBackend {
  try {
    const cfg = getAppConfig()
    // (правка 257) Своя модель (.gguf по абсолютному пути): движок тот же
    // (llm_server.py), файл — пользовательский.
    // (правка 467) Раньше непустой custom_model перекрывал выбор селектора
    // БЕЗУСЛОВНО — селектор «врал» (показывал Bonsai, работала своя), и свой
    // путь нельзя было отличить в списке. Теперь custom активен, когда путь
    // задан И селектор на нём (model='llm_custom') ИЛИ model ещё пуст
    // (легаси: путь задан до появления пункта в списке). Явный выбор
    // встроенной модели в селекторе переключает обратно, путь при этом
    // сохраняется в настройках.
    if (cfg.llmCustomModel && (cfg.llmModel === '' || cfg.llmModel === LLM_MODEL_CUSTOM)) return 'custom'
    const m = cfg.llmModel
    // Bonsai включается только явным маркером. Пустое значение, 'llm_custom'
    // без пути и любое имя файла используют standard backend; дефолт — Qwen.
    return (m === LLM_MODEL_BONSAI || m === LLM_MODEL_BONSAI_LIGHT) ? 'bonsai' : 'standard'
  } catch {
    return 'standard' // При недоступном config — стандартный дефолт Qwen.
  }
}

/** Файлы внешней сборки Bonsai (движок + модель + mmproj). */
export function llmBonsaiPaths(): {
  exe: string
  model: string
  mmproj: string | null
} {
  const cfg = getAppConfig()
  const dir = cfg.llmBonsaiDir
  const modelsDir = path.join(dir, 'models')
  const mmproj = path.join(modelsDir, 'Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf')
  const pq = path.join(modelsDir, 'Ternary-Bonsai-2-27B-PQ2_0.gguf')
  const ptq = path.join(modelsDir, 'Ternary-Bonsai-2-27B-PTQ1_0.gguf')

  // (правка 168) Если выбран 'bonsai_light' — берём PTQ1_0 (если есть), иначе PQ2_0.
  // Иначе (дефолт / 'bonsai') — PQ2_0 приоритет, PTQ1_0 как fallback.
  let model: string
  if (cfg.llmModel === LLM_MODEL_BONSAI_LIGHT) {
    model = existsSync(ptq) ? ptq : pq
  } else {
    model = existsSync(pq) ? pq : existsSync(ptq) ? ptq : pq
  }

  return {
    exe: path.join(dir, 'llama.cpp', 'llama-server.exe'),
    model,
    mmproj: existsSync(mmproj) ? mmproj : null,
  }
}

/**
 * (правка 138) Автодокачка Bonsai: если файлов нет — запускаем скачивание
 * движка (2 zip с GitHub) + модели и mmproj (HuggingFace) через штатный
 * загрузчик и возвращаем человекочитаемый статус для сообщения чату.
 */
const BONSAI_DOWNLOAD_IDS = ['bonsai_engine_bin', 'bonsai_engine_cudart', 'bonsai_model', 'bonsai_mmproj'] as const

async function autoDownloadBonsai(): Promise<string> {
  const { startDownload, getAllModelsStatus } = await import('./model-downloader')
  const statuses = getAllModelsStatus().filter(s => (BONSAI_DOWNLOAD_IDS as readonly string[]).includes(s.id))
  const missing = statuses.filter(s => s.status === 'missing' || s.status === 'error')
  for (const m of missing) {
    const r = await startDownload(m.id)
    if (r.ok) console.log(`[llm] Bonsai автодокачка: ${m.id} запущена`)
    else if (r.error !== 'Download already in progress') console.warn(`[llm] Bonsai автодокачка ${m.id}: ${r.error}`)
  }
  const parts = statuses.map(s =>
    s.status === 'downloading'
      ? `${s.id} — ${(s.bytesReceived / 1024 ** 2).toFixed(0)} из ${s.totalBytes ? `${(s.totalBytes / 1024 ** 2).toFixed(0)} МБ` : '?'}`
      : `${s.id} — ${s.status === 'ready' ? 'готово' : s.status === 'error' ? `ошибка: ${s.error}` : 'ожидает'}`,
  )
  return 'Модель ассистента Bonsai ещё не скачана — загрузка запущена автоматически ' +
    `(${parts.join('; ')}). Это разовая загрузка (~8 ГБ, движок + модель + зрение); ` +
    'прогресс виден в Настройках → Модели. Отправьте сообщение снова через несколько минут.'
}

/**
 * Resolve the currently active LLM model ID from config.
 * If the user selected a specific quantization (e.g. Q3_K_M), return
 * the matching MODELS ID (e.g. 'llm_assistant_q3'); otherwise fall back
 * to the default 'llm_assistant_qwen' (правка 99).
 * (правка 136) 'bonsai' в config → виртуальный ID 'llm_assistant_bonsai'.
 */
export function activeLlmModelId(): string {
  const be = llmBackend()
  if (be === 'bonsai') return 'llm_assistant_bonsai'
  // (правка 257) виртуальный ID своей модели — вне MODELS, статус/баннер
  // обрабатывают его отдельно.
  if (be === 'custom') return 'llm_custom'
  try {
    const cfg = getAppConfig()
    if (cfg.llmModel) {
      const found = MODELS.find((m) => {
        if (!m.id.startsWith('llm_assistant') || isLlmMmprojId(m.id)) return false
        return m.relPath.endsWith(cfg.llmModel)
      })
      if (found) return found.id
    }
  } catch { /* config unavailable */ }
  return LLM_MODEL_ID
}

/** ID mmproj-файла (vision) — не сама модель, а сопутствующий файл. */
function isLlmMmprojId(id: string): boolean {
  return id === 'llm_assistant_mmproj' || id === 'llm_assistant_qwen_mmproj'
}

/** LLM context window size (tokens) — read from config at call-time. */
export function llmContextSize(): number {
  try {
    return getAppConfig().llmContextSize
  } catch {
    // (правка 119) дефолт 25K токенов
    return 25600
  }
}

let child: ChildProcess | null = null
let starting: Promise<{ ok: boolean; error?: string }> | null = null
let gpuMode: 'gpu' | 'cpu' | null = null
let startedAt = 0
/** Actual context size the running server was started with (set at spawn time). */
let actualCtx: number | null = null

/**
 * (правка: рассинхрон после сброса/смены модели) Сигнатура конфигурации, с
 * которой заспавнен ТЕКУЩИЙ сервер. Раньше ensureLlm считал «живой процесс =
 * подходящий сервер»: после «Сброса настроек» или смены модели/контекста в
 * настройках работающий сервер продолжал обслуживать СТАРУЮ модель, а чат-роут
 * уже читал НОВЫЙ конфиг — протокол (/chat у llm_server.py vs
 * /v1/chat/completions у llama-server), чат-шаблон и сэмплинг расходились с
 * реально загруженной моделью → «странные» ответы на первых сообщениях, пока
 * сервер не перезапускался по idle-таймауту. Теперь живой, но чужой по
 * конфигу сервер перезапускается (см. ensureLlm). null = сервер не наш
 * (подхвачен чужой с порта) — проверка пропускается.
 */
let spawnSig: string | null = null

/* ── (правка 730) Бюджет холодного старта модели ──
 * Раньше healthUp ждал ровно 180 с и в любом случае отвечал «Модель не
 * загрузилась за 3 минуты». При этом процесс НЕ убивался и часто поднимался
 * позже, а следующая попытка через 90 с его УБИВАЛА (правка 259), выбрасывая
 * уже почти сделанную загрузку — отсюда «иногда ошибка, иногда нет».
 * Первый запуск (GGUF ~8 ГБ с HDD, mmproj, проверка антивирусом, выгрузка
 * ComfyUI) законно занимает больше трёх минут. Клиентский таймаут заголовков
 * чата — 10 минут (assistant-stream, правка 267), так что ждать дольше
 * безопасно. */
const COLD_START_TIMEOUT_MS = 360_000
/** Запас сверх бюджета: процесс жив, но /health молчит. Только после него
 *  считаем загрузку зависшей и перезапускаем (правка 259). */
const STARTUP_GRACE_MS = 120_000
/** Общий текст для «модель ещё грузится»: это не поломка, загрузка идёт
 *  в фоне, повторное сообщение просто дожидается её конца. */
const STILL_LOADING_ERROR =
  'Модель ассистента ещё загружается — первый запуск может занимать несколько минут. Подождите минуту и отправьте сообщение снова: загрузка уже идёт, заново ничего не начнётся.'

/** Сигнатура ЖЕЛАЕМОЙ конфигурации по текущему config.ini. */
function desiredSpawnSig(): string {
  try {
    const cfg = getAppConfig()
    return JSON.stringify({
      b: llmBackend(),
      m: llmModelPath(),
      p: llmMmprojPath(),
      c: llmContextSize(),
      kv: cfg.llmKvCache,
      d: cfg.llmDevice,
    })
  } catch {
    return 'unknown'
  }
}

// (правка 348) Сироты: при выходе Node-процесса (закрытие студии) дочерний
// llm_server.py / llama-server оставался жить на порту 8090 и держал VRAM.
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

/** The ACTUAL context window of the running server (matches --ctx arg).
 *  Falls back to config value if server hasn't started yet. */
export function actualLlmContextSize(): number {
  return actualCtx ?? llmContextSize()
}

export function llmModelPath(): string {
  const cfg = getAppConfig()
  // (правка 257) Своя модель: абсолютный путь из config, как есть.
  if (llmBackend() === 'custom') return cfg.llmCustomModel
  // (правка 162) Bonsai: модель во внешней папке сборки, не в ComfyUI/models
  if (llmBackend() === 'bonsai') return llmBonsaiPaths().model
  // Резолвим через MODELS + активную модель (правка 52): так корректно
  // работают и кванты Gemma в llm/, и Qwen3.5 9B в подпапке llm/qwen3.5-9b/.
  const def = MODELS.find((m) => m.id === activeLlmModelId())
  const raw = path.join(cfg.comfyRoot, 'ComfyUI', 'models', def?.relPath ?? 'llm')
  // (правка 732) Модель могла быть положена папкой с именем файла — отдаём
  // путь к самому файлу, иначе llama-server получал каталог и падал.
  return resolveModelFilePath(raw) ?? raw
}

/** Path to the multimodal projector (vision) file, or null if not present.
 *  (правка 52) mmproj зависит от выбранной модели: у Qwen3.5 9B свой файл.
 *  (правка 162) Bonsai: свой mmproj в папке сборки.
 *  (правка 257) custom: mmproj из config (опционально — без него только текст). */
function llmMmprojPath(): string | null {
  // (правка 257) Своя модель: mmproj из config, если указан и существует.
  if (llmBackend() === 'custom') {
    const cfg = getAppConfig()
    // (правка 732) ...и даже если он лежит папкой с тем же именем.
    return resolveModelFilePath(cfg.llmCustomMmproj)
  }
  // (правка 162) Bonsai: свой mmproj в папке сборки, не в ComfyUI/models
  if (llmBackend() === 'bonsai') {
    const b = llmBonsaiPaths()
    return b.mmproj // уже existsSync-проверен в llmBonsaiPaths
  }
  const cfg = getAppConfig()
  const mmId = activeLlmModelId() === 'llm_assistant_qwen'
    ? 'llm_assistant_qwen_mmproj'
    : 'llm_assistant_mmproj'
  const def = MODELS.find((m) => m.id === mmId)
  if (!def) return null
  const p = path.join(cfg.comfyRoot, 'ComfyUI', 'models', def.relPath)
  // (правка 732) Каталог с именем файла (пользователь так разложил модель)
  // разворачиваем в сам файл — см. resolveModelFilePath.
  return resolveModelFilePath(p)
}

export function llmModelExists(): boolean {
  try {
    // (правка 257) Своя модель: файл пользователя — порог всего 1 МБ
    // (кванты бывают маленькими; 100 МБ отсекали бы лёгкие модели).
    if (llmBackend() === 'custom') {
      return statSync(llmModelPath()).size > 1_000_000
    }
    // (правка 136) Bonsai: проверяем файлы внешней сборки (exe + GGUF).
    if (llmBackend() === 'bonsai') {
      const b = llmBonsaiPaths()
      return existsSync(b.exe) && statSync(b.model).size > 100_000_000
    }
    const st = statSync(llmModelPath())
    return st.size > 100_000_000
  } catch {
    return false
  }
}

async function healthUp(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  const proc = child
  while (Date.now() < deadline) {
    // Процесс умер (упал на старте) — не поллим мёртвый порт до таймаута
    if (!proc || proc.killed || proc.exitCode !== null || proc.signalCode !== null) return false
    if (!child) return false
    try {
      const r = await fetch(`http://127.0.0.1:${LLM_PORT}/health`, {
        signal: AbortSignal.timeout(2000),
      })
      if (r.ok) return true
    } catch {
      /* not up yet — model loading */
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  return false
}

export interface LlmStatus {
  running: boolean
  starting: boolean
  gpuMode: 'gpu' | 'cpu' | null
  modelExists: boolean
  startedAt: number
  ctxSize: number
}

export function llmStatus(): LlmStatus {
  return {
    // exitCode/signalCode: процесс мог уже умереть, а exit-событие ещё не
    // обработано — иначе ensureLlm увидит «running» и потратит до 90 c
    // на health-поллинг мёртвого PID.
    running: !!child && !child.killed && child.exitCode === null && child.signalCode === null,
    starting: !!starting,
    gpuMode,
    modelExists: llmModelExists(),
    startedAt,
    ctxSize: actualLlmContextSize(),
  }
}

/** PID процесса LLM-сервера (null, когда не запущен/уже вышел). */
export function llmPid(): number | null {
  return child?.pid ?? null
}

/* ── (правка 136 / Bonsai) Idle-автостоп ──
 * llm_server.py останавливает сам себя по --idle-sec 600; у llama-server
 * такой функции нет — сторожим из раннера: 10 минут без запросов к чату
 * → stopLlm() (VRAM освобождается для MiniMax/системы). */
let lastLlmActivity = 0
let bonsaiIdleTimer: ReturnType<typeof setInterval> | null = null

/** Отметить обращение к ассистенту (вызывается чат-роутом на каждый запрос). */
export function noteLlmActivity(): void {
  lastLlmActivity = Date.now()
}

function startBonsaiIdleWatchdog(): void {
  lastLlmActivity = Date.now()
  if (bonsaiIdleTimer) return
  bonsaiIdleTimer = setInterval(() => {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      stopBonsaiIdleWatchdog()
      return
    }
    if (Date.now() - lastLlmActivity > 600_000) {
      console.log('[llm] Bonsai: 10 мин без запросов — выгружаю (idle)')
      // (правка 716) .catch обязателен: stopLlm — async, и его отклонение
      // без обработчика стало бы unhandled rejection (Node по умолчанию
      // завершает процесс).
      void stopLlm().catch((err) => {
        console.warn('[llm] idle-выгрузка не удалась:', err instanceof Error ? err.message : String(err))
      })
    }
  }, 60_000)
  // Держим event-loop живым честно: таймер периодический, интервал не мешает.
  bonsaiIdleTimer.unref?.()
}

function stopBonsaiIdleWatchdog(): void {
  if (bonsaiIdleTimer) {
    clearInterval(bonsaiIdleTimer)
    bonsaiIdleTimer = null
  }
}

/**
 * Дождаться завершения текущего запуска LLM, если он идёт (для арбитра):
 * пока модель грузится, stopLlm бесполезен — процесса ещё нет или он
 * вот-вот появится. После завершения загрузки её можно корректно остановить.
 */
export async function awaitLlmStartup(): Promise<void> {
  while (starting) {
    const p = starting
    await p.catch(() => {})
    if (p === starting) break // старт завершился и новый не начался
  }
}

/** Ждать события exit процесса до `ms` мс. true = процесс завершился. */
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

/** Start the LLM server (idempotent). Resolves when /health answers. */
export async function ensureLlm(): Promise<{ ok: boolean; error?: string }> {
  if (child && !child.killed) {
    // Процесс ВЫШЕЛ, а exit-событие ещё не обработано — это мёртвый child:
    // раньше healthUp честно поллил его до 90 c и фейлил запрос. Чистим
    // ссылку и стартуем заново.
    if (child.exitCode !== null || child.signalCode !== null) {
      child = null
      gpuMode = null
      actualCtx = null
      spawnSig = null
    } else {
      // Already running — but confirm health (model may still be loading)
      const ok = await healthUp(90_000)
      if (ok && spawnSig !== null && spawnSig !== desiredSpawnSig()) {
        // Живой сервер обслуживает СТАРУЮ конфигурацию (сброс настроек / смена
        // модели / контекста / KV после его запуска): чат-роут уже шлёт
        // протокол, чат-шаблон и сэмплинг НОВОЙ модели — с загруженной они
        // несовместимы (/chat у llm_server.py vs /v1/chat/completions у
        // llama-server). Перезапускаем с актуальными параметрами, иначе первые
        // ответы «глючат», пока сервер не упрётся в idle-автостоп.
        console.warn('[llm] конфиг LLM изменился после запуска сервера — перезапускаю с актуальными параметрами')
        await stopLlm()
      } else if (ok) {
        return { ok: true }
      } else if (child && child.pid) {
        // (правка 259) Процесс ЖИВ, но не отвечает (деадлок в llama.cpp):
        // раньше возвращали ошибку, и КАЖДЫЙ следующий запрос платил те же
        // 90 с без всякой попытки реанимации. Это НАШ отслеживаемый child
        // (PID известен) — убиваем и проваливаемся в ветку холодного спавна
        // ниже (рестарт ровно один раз за вызов). Если бы PID был неизвестен
        // (чужой/осиротевший процесс на порту) — вслепую не убиваем.
        //
        // (правка 730) Но пока процесс в окне холодного старта, «молчит 90 с»
        // — это НЕ деадлок, а идущая загрузка: kill выбрасывал уже сделанную
        // работу и запускал всё заново (второй источник «Модель не загрузилась
        // за 3 минуты»). В этом окне просто сообщаем, что модель грузится, —
        // сам процесс продолжает загрузку и у следующей попытки будет готов.
        const startupAge = startedAt ? Date.now() - startedAt : Number.POSITIVE_INFINITY
        if (startupAge < COLD_START_TIMEOUT_MS + STARTUP_GRACE_MS) {
          console.log(`[llm] (правка 730) процесс жив, /health молчит 90 с, но загрузка идёт ${Math.round(startupAge / 1000)} с — не перезапускаю`)
          return { ok: false, error: STILL_LOADING_ERROR }
        }
        console.warn('[llm] (правка 259/730) процесс жив, но /health молчит 90 с — убиваю и перезапускаю')
        await stopLlm()
      } else {
        return { ok: false, error: 'LLM сервер не отвечает' }
      }
    }
  }
  if (starting) return starting

  // (правка 343) Порт 8090 мог остаться занят сиротой (llm_server.py пережил
  // рестарт студии) — раньше новый процесс падал на bind с traceback'ом, а
  // healthUp 3 минуты ждал ответа. Теперь: живой сервер на порту
  // переиспользуем через /health (быстрый старт после рестарта приложения),
  // а занятый молчаливый порт — понятная ошибка вместо долгого ожидания.
  try {
    const r = await fetch(`http://127.0.0.1:${LLM_PORT}/health`, {
      signal: AbortSignal.timeout(2000),
    })
    if (r.ok) {
      // Подхватываем чужой (осиротевший) сервер — сперва проверяем, что на
      // порту ТА модель, которую ждёт текущий конфиг. Иначе чат-роут пошлёт
      // ей чужой протокол/чат-шаблон/сэмплинг (та же болезнь, что лечит
      // spawnSig для собственного child), а убить сироту мы не можем
      // (PID неизвестен) — поэтому честная ошибка вместо тихих «глюков».
      // llm_server.py отдаёт модель прямо в /health; llama-server (bonsai) —
      // через /v1/models.
      let foreignModel: string | null = null
      try {
        const j = (await r.json()) as { model?: unknown }
        if (typeof j.model === 'string' && j.model) foreignModel = j.model
      } catch { /* тело не JSON — вероятно, llama-server */ }
      if (!foreignModel) {
        try {
          const mr = await fetch(`http://127.0.0.1:${LLM_PORT}/v1/models`, {
            signal: AbortSignal.timeout(2000),
          })
          if (mr.ok) {
            const mj = (await mr.json()) as { data?: Array<{ id?: unknown }> }
            const id = mj.data?.[0]?.id
            if (typeof id === 'string' && id) foreignModel = id
          }
        } catch { /* определить не удалось — доверяем, как раньше */ }
      }
      if (foreignModel) {
        const base = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p
        let desired = ''
        try { desired = llmModelPath() } catch { /* конфиг недоступен */ }
        if (desired && base(foreignModel) !== base(desired)) {
          return {
            ok: false,
            error: `Порт ${LLM_PORT} занят LLM-сервером с другой моделью (${base(foreignModel)} вместо ${base(desired)}) — процесс остался от прошлого запуска. Завершите python.exe / llama-server.exe в Диспетчере задач и отправьте сообщение снова.`,
          }
        }
      }
      spawnSig = null // сервер не заспавнен нами — сигнатурную проверку пропускаем
      console.log(`[llm] (правка 343) порт ${LLM_PORT} уже слушает живой сервер — переиспользую его`)
      if (!startedAt) startedAt = Date.now()
      return { ok: true }
    }
  } catch (e) {
    // ECONNREFUSED — порт свободен, спавним свой. Таймаут — порт занят
    // процессом, который не отвечает как LLM (подвисшая сирота?).
    if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      return {
        ok: false,
        error: `Порт ${LLM_PORT} занят процессом, не отвечающим как LLM-сервер (возможно, зависшая сирота от прошлого запуска). Завершите его в Диспетчере задач (python.exe / llama-server.exe) и попробуйте снова.`,
      }
    }
  }

  if (!llmModelExists()) {
    // (правка 138) Bonsai: файлов нет — автодокачка недостающего (движок/
    // модель/mmproj) вместо сухой ошибки. Ответ содержит статус с прогрессом.
    if (llmBackend() === 'bonsai') {
      return { ok: false, error: await autoDownloadBonsai() }
    }
    return { ok: false, error: 'Модель ассистента не скачана' }
  }

  starting = (async () => {
    let proc: ChildProcess | null = null
    try {
      const cfg = getAppConfig()
      // Device selection: manual override via Settings ([llm] device in
      // config.ini) wins; 'auto' falls back to the free-VRAM heuristic.
      // When GPU is wanted but VRAM is occupied by ComfyUI's post-generation
      // model cache — and nothing is generating — evict that cache first
      // (правка 29) so the assistant gets the GPU.
      const device = cfg.llmDevice
      const wantsGpu = device !== 'cpu'
      let gpuLayers = 0
      if (wantsGpu) {
        // Выгрузку ComfyUI выполняет vram-arbiter (startChat в роуте чата)
        // ДО вызова ensureLlm — здесь модель просто грузится в свободный VRAM.
        // n_gpu_layers = -1: llm_server.py сам рассчитает максимум слоёв на GPU,
        // укладывающихся в 90% общей VRAM (--max-vram-percent 90, правка 60: back to the original 90%).
        // Остальные слои автоматически остаются на CPU — система не лагает.
        gpuLayers = -1
      }
      const useGpu = gpuLayers !== 0
      gpuMode = useGpu ? 'gpu' : 'cpu'
      startedAt = Date.now()

      // llama-cpp-python's load_shared_library checks CUDA_PATH and adds
      // $CUDA_PATH/lib to the DLL search path. We point it at the PyTorch
      // directory (which contains lib/ with CUDA runtime DLLs) so that
      // ggml-cuda.dll can find cublas/cudart. Portable: no system CUDA
      // toolkit install needed — uses DLLs bundled with PyTorch.
      const torchDir = path.join(
        cfg.comfyRoot, 'python_embeded', 'Lib', 'site-packages', 'torch',
      )
      const env = { ...process.env }
      if (existsSync(torchDir)) {
        env.CUDA_PATH = torchDir
      }

      // Whole-video support: the MTMD video helper (patched into
      // llama_multimodal.py) spawns ffmpeg+ffprobe from one directory. The
      // portable static build lives in <project>/runtime/ffmpeg — point the
      // helper there so nothing external is required.
      const ffmpegDir = [path.join(process.cwd(), 'runtime', 'ffmpeg'), path.join(cfg.comfyRoot, '..', 'runtime', 'ffmpeg')].find(
        (d) => existsSync(path.join(d, 'ffmpeg.exe')) && existsSync(path.join(d, 'ffprobe.exe')),
      )
      if (ffmpegDir) {
        env.LLM_FFMPEG_DIR = path.resolve(ffmpegDir)
      }

      const mmproj = llmMmprojPath()
      const ctx = llmContextSize()
      actualCtx = ctx

      if (llmBackend() === 'bonsai') {
        // (правка 136) Bonsai: prism llama-server с OpenAI-протоколом.
        // Флаги — из проверенных лаунчеров сборки (Start-Bonsai.bat).
        // «Думание» выключается НЕ флагом запуска (--reasoning-budget 0 у
        // форка не работает), а параметром шаблона в каждом запросе:
        // chat_template_kwargs.enable_thinking=false (см. чат-роут).
        const b = llmBonsaiPaths()
        if (!existsSync(b.exe) || !existsSync(b.model)) {
          // (правка 138) Автодокачка: движок/модель отсутствуют — качаем
          // автоматически, пользователь получит статус с прогрессом.
          return { ok: false, error: await autoDownloadBonsai() }
        }
        const bArgs = [
          '-m', b.model,
          '-c', String(ctx),
          '-ngl', wantsGpu ? '99' : '0',
          '-fa', 'on',
          // (фикс) Один слот: у форка n_slots=4 с unified-KV — между слотами
          // подтекал чужой контекст (ответы не по системному промпту).
          // Студия всё равно шлёт один чат за раз.
          '-np', '1',
          // (фикс) Context checkpoints форка (fuzzy LCP-реюз KV между ЗАДАЧАМИ)
          // восстанавливал «похожий» чужой префикс — ответы уезжали на темы
          // прошлых запросов и игнорировали системный промпт. Выключаем:
          // 0 чекпоинтов + не сохранять idle-слоты в кэш. Точный префикс-реюз
          // (общий system-промпт) остаётся — он корректен.
          '-ctxcp', '0',
          '--no-cache-idle-slots',
          '--jinja',
          // instruct-рекомендации авторов (думание выключено); точные
          // значения приходят per-request из llm-sampling.ts
          '--temp', '0.7',
          '--top-p', '0.8',
          '--top-k', '20',
          '--presence-penalty', '1.5',
          '--host', '127.0.0.1',
          '--port', String(LLM_PORT),
        ]
        // (правка 136b) Квантизация KV-кэша — та же настройка, что и у
        // стандартного бэкенда ([llm] kv_cache): у Bonsai KV крошечный
        // (гибридное внимание: кэш только у ~16 слоёв из 128; 25.6K ctx =
        // 1.7 ГБ f16 / 850 МБ q8_0 / 425 МБ q4_0), но на малых картах и это
        // заметно. '-fa on' уже включён — обязательное условие квантованного KV.
        if (cfg.llmKvCache !== 'off') {
          bArgs.push('-ctk', cfg.llmKvCache, '-ctv', cfg.llmKvCache)
        }
        if (b.mmproj) bArgs.push('--mmproj', b.mmproj)
        noteLlmActivity()
        proc = spawn(b.exe, bArgs, {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          env: process.env,
        })
        startBonsaiIdleWatchdog()
      } else {
        const args = [
          path.join(process.cwd(), 'tools', 'llm_server.py'),
          '--model', llmModelPath(),
          '--port', String(LLM_PORT),
          '--gpu-layers', String(gpuLayers),
          '--max-vram-percent', '90',
          '--ctx', String(ctx),
          // (правка 109) квантизация KV-кэша: off (fp16) / q8_0 / q5_1 / q4_0
          '--kv-cache', cfg.llmKvCache,
          '--threads', '6',
          '--idle-sec', '600',
        ]
        if (mmproj) args.push('--mmproj', mmproj)

        proc = spawn(
          path.join(cfg.comfyRoot, 'python_embeded', 'python.exe'),
          args,
          { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env },
        )
      }
      child = proc
      spawnSig = desiredSpawnSig()
      proc.stdout?.on('data', (d: Buffer) => process.stdout.write(`[llm] ${d}`))
      proc.stderr?.on('data', (d: Buffer) => process.stderr.write(`[llm] ${d}`))
      // Чистим ссылку только если это ВСЁ ЕЩЁ текущий процесс: за время
      // остановки старого мог успеть стартовать новый LLM-сервер.
      proc.on('exit', () => {
        if (child === proc) {
          child = null
          gpuMode = null
          actualCtx = null
          spawnSig = null
        }
        stopBonsaiIdleWatchdog()
      })

      const up = await healthUp(COLD_START_TIMEOUT_MS)
      if (up) return { ok: true }
      // (правка 730) Различаем «процесс умер» и «ещё грузится»: раньше в обоих
      // случаях отдавали «Модель не загрузилась за 3 минуты (см. лог сервера)»,
      // и пользователь не понимал, ждать ему или чинить. Процесс при таймауте
      // НЕ убиваем: загрузка продолжится, повторное сообщение подхватит её
      // (см. окно старта в ветке «already running» выше).
      const dead = !proc || proc.exitCode !== null || proc.signalCode !== null
      return {
        ok: false,
        error: dead
          ? 'Модель ассистента не запустилась: процесс завершился при загрузке (не хватило VRAM/RAM или повреждён файл модели). Подробности — в логе сервера.'
          : STILL_LOADING_ERROR,
      }
    } catch (err) {
      // Чистим ссылку только на процесс, созданный ЭТИМ запуском:
      // до spawn мог оставаться старый (kill'нутый, ещё умирающий) процесс.
      if (proc && child === proc) {
        // (правка 716) Процесс УБИВАЕМ, а не просто забываем ссылку.
        // Раньше child = null — и дочерний llama-server оставался жить
        // (~10 ГБ VRAM + порт 8090), обработчик 'exit' его уже не чистил
        // (он проверяет child === proc), а stopLlm() при child === null
        // выходил сразу. Сирота жил до собственного --idle-sec таймаута.
        try {
          proc.kill()
        } catch { /* уже мёртв */ }
        if (proc.pid) {
          try {
            await execFileAsync('taskkill', ['/F', '/T', '/PID', String(proc.pid)])
          } catch {
            /* процесс мог уже выйти */
          }
        }
        child = null
        gpuMode = null
        actualCtx = null
        spawnSig = null
      }
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      starting = null
    }
  })()

  return starting
}

/**
 * Остановить LLM-сервер с гарантией фактического выхода процесса:
 *  1) graceful POST /shutdown (сервер сам освобождает CUDA-контекст: del llm → os._exit);
 *  2) ожидание события exit (не снов!) до 10 с;
 *  3) эскалация: kill() → ждать exit 5 с → taskkill /F /T → ждать exit 5 с.
 * Возвращает управление только когда процесс мёртв (или исчерпаны все попытки).
 */
export async function stopLlm(): Promise<void> {
  const proc = child
  if (!proc) {
    child = null
    gpuMode = null
    spawnSig = null
    return
  }
  // 1) Graceful shutdown — сервер освобождает CUDA-контекст сам.
  // (правка 258) Эндпоинт /shutdown есть ТОЛЬКО у standard-бэкенда
  // (tools/llm_server.py); у prism llama-server (bonsai) его нет → 404, и
  // waitForExit ниже сгорал на все 10 с при КАЖДОМ останове. Для bonsai
  // graceful-шаг пропускаем — сразу terminate/kill.
  let exited = false
  if (llmBackend() !== 'bonsai') {
    try {
      await fetch(`http://127.0.0.1:${LLM_PORT}/shutdown`, {
        method: 'POST',
        signal: AbortSignal.timeout(3000),
      })
    } catch {
      /* сервер не отвечает — переходим к принудительной эскалации */
    }
    // 2) Ждём фактического выхода
    exited = await waitForExit(proc, 10_000)
  }
  // 3) Эскалация: мягкий kill, затем taskkill /F /T (дерево процессов)
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
  // Обнуляем только если не успел стартовать новый сервер (см. ensureLlm).
  // actualCtx сбрасываем и здесь: если exit-событие ещё не дошло, его guard
  // child === proc не сработает и контекст мёртвого сервера «протечёт»
  // в планирование следующей сессии.
  if (child === proc) {
    child = null
    gpuMode = null
    actualCtx = null
    spawnSig = null
  }
}
