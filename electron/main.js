/**
 * Electron main process — десктоп-обёртка MiniMax H3 Studio 7 (правка 561).
 *
 * Приложение остаётся веб-приложением (Next.js production server на :3000),
 * но живёт в СОБСТВЕННОМ окне без браузерного хрома: своя иконка и имя в
 * таскбаре, закрывается как обычная программа.
 *
 * Оркестрация (аналог прежнего start.bat-флоу, см. правку 551):
 *   1. single-instance lock — вторая копия фокусирует существующее окно;
 *   2. убить висящие слушатели :3000 и :8188 (осиротевшие прошлые сессии);
 *   3. поднять web-сервер (server.js) дочерним процессом — на Node самого
 *      Electron (ELECTRON_RUN_AS_NODE=1), системный Node для рантайма не нужен;
 *   4. поднять ComfyUI (python_embeded) с флагами VRAM из config/config.ini;
 *   5. дождаться ответа :3000 и открыть окно на /splash — заставка сама
 *      ждёт готовности ComfyUI (/api/comfy/health) и входит в студию;
 *   6. закрытие окна = выход из приложения = taskkill /T /F деревьев
 *      server.js и ComfyUI (вместе с их дочерними LLM/upscale-процессами).
 *
 * Запуск: node_modules\.bin\electron electron\main.js (скрипт `npm run desktop`,
 * либо автоматически из start.bat — там же фолбэк на старый браузерный режим).
 */
const { app, BrowserWindow, Menu, dialog, shell, ipcMain } = require('electron')
const { spawn, spawnSync } = require('node:child_process')
const { existsSync, readFileSync, mkdirSync, writeFileSync } = require('node:fs')
const fsPromises = require('node:fs').promises
const path = require('node:path')
const util = require('node:util')

const APP_ROOT = path.resolve(__dirname, '..')
const PORT = 3000
const COMFY_PORT = 8188
const CONFIG_INI = path.join(APP_ROOT, 'config', 'config.ini')
const COMFY_ROOT = resolveComfyRoot()
const COMFY_PY = path.join(COMFY_ROOT, 'python_embeded', 'python.exe')
const ICON = path.join(__dirname, 'icons', 'icon.ico')

/* (правка 748) Файл машиночитаемого статуса установки зависимостей:
 * пишет install.ps1 (шаги 1-9) и мы сами (done/error). Заставка читает
 * его через /api/setup-status и показывает «шаг N/9» вместо вечного
 * «Идёт загрузка ComfyUI…». */
const SETUP_STATUS = path.join(APP_ROOT, '.install-cache', 'setup_status.json')

function resolveComfyRoot() {
  let configured = ''
  try {
    if (existsSync(CONFIG_INI)) {
      let section = ''
      for (const line of readFileSync(CONFIG_INI, 'utf8').split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue
        const sectionMatch = /^\[([^\]]+)\]$/.exec(trimmed)
        if (sectionMatch) {
          section = sectionMatch[1].toLowerCase()
          continue
        }
        const eq = trimmed.indexOf('=')
        if (section === 'comfy' && eq > 0 && trimmed.slice(0, eq).trim().toLowerCase() === 'comfy_dir') {
          configured = trimmed.slice(eq + 1).trim().replace(/"/g, '')
          break
        }
      }
    }
  } catch { /* использовать env/default */ }
  const raw = configured || (process.env.COMFY_ROOT || '').trim() || 'ComfyUI-Easy-Install'
  return path.resolve(APP_ROOT, raw)
}

/* ── (правка 567) Захват консоли ────────────────────────────────
 * Весь вывод server.js, ComfyUI и самого Electron копится в кольцевой
 * буфер (для панели «Консоль» в UI) И дублируется в реальную консоль
 * (свёрнутое окно start.bat) — ничего не теряется.
 * Кэп: 2 МБ текста, обрезаем по границе строки.
 *
 * (правка 588) Протокол ОПЕРАЦИЙ вместо сырого текста: ComfyUI/tqdm
 * печатает прогресс генерации ОДНИМ \r (возврат каретки без \n) — настоящая
 * консоль при этом ПЕРЕЗАПИСЫВАЕТ строку на месте. Раньше каждый шаг
 * добавлялся новой строкой — стена «0%|…| 1/6», «0%|…| 2/6»… нечитаема.
 * Теперь вывод детей проходит через терминальный ассемблер (см.
 * makeConsoleWriter): \n → операция 'a' (дописать), одиночный \r → 'r'
 * (записать текст с НАЧАЛА последней строки, затирая старое — ровно как
 * в консоли Windows; tqdm сам дописывает пробелы, чтобы затирать хвост).
 * Буфер и UI применяют операции одинаково → «Сохранить лог» тоже чистый. */
const CONSOLE_MAX = 2_000_000
let consoleBuf = ''
/** Очередь операций для UI: ['a'|'r', text][]. */
let consolePend = []
let consoleTimer = null

/**
 * (правка 716) Флаг штатного выхода. Объявлен ВВЕРХУ файла: раньше он
 * объявлялся ниже по модулю (let quitting = false), и обработчик
 * server.on('exit') ссылался на него в TDZ-зоне. Работало только потому,
 * что обработчик регистрировался после достижения объявления, — любой
 * рефакторинг (или exit во время инициализации модуля) давал
 * ReferenceError ВНУТРИ обработчика: без диалога и без app.quit() —
 * зависший процесс Electron без окна.
 */
let quitting = false

function consoleBroadcast() {
  if (consoleTimer) return
  consoleTimer = setTimeout(() => {
    consoleTimer = null
    if (!consolePend.length || !win || win.isDestroyed()) { consolePend = []; return }
    const ops = consolePend
    consolePend = []
    win.webContents.send('h3:console-append', ops)
  }, 400)
}

/** Применить операцию к текстовому буферу (consoleBuf и UI применяют одно и то же). */
function applyConsoleOp(buf, op, text) {
  if (op === 'r') {
    const nl = buf.lastIndexOf('\n')
    const oldLine = buf.slice(nl + 1)
    // Хвост старой строки затираем пробелами (EL, clear-to-line-end): если
    // новая строка короче, остатки прошлого состояния не «просвечивают».
    const pad = oldLine.length > text.length ? ' '.repeat(oldLine.length - text.length) : ''
    return buf.slice(0, nl + 1) + text + pad
  }
  return buf + text
}

function pushConsoleOp(op, str) {
  consoleBuf = applyConsoleOp(consoleBuf, op, str)
  if (consoleBuf.length > CONSOLE_MAX) {
    const nl = consoleBuf.indexOf('\n', consoleBuf.length - CONSOLE_MAX)
    consoleBuf = nl >= 0 ? consoleBuf.slice(nl + 1) : consoleBuf.slice(-CONSOLE_MAX)
  }
  consolePend.push([op, str])
  consoleBroadcast()
}

function appendConsole(str, tee = true) {
  // tee=false — строка уже выведена в реальную консоль другим путём
  // (патч console.log ниже пишет через orig.log сам) — не дублируем.
  // (правка 573) ПОЛНОСТЬЮ отключаем запись в process.stdout — при скрытом
  // запуске (start_hidden.vbs) stdout — это pipe, и запись в него вызывает
  // EPIPE (broken pipe). Логи сохраняются только в буфер для UI.
  // if (tee && process.stdout.isTTY) {
  //   try { process.stdout.write(str) } catch { /* ignore */ }
  // }
  pushConsoleOp('a', str)
}

/* (правка 588) Терминальный ассемблер строк одного потока ребёнка:
 * копит неполный хвост между чанками, режет поток по \n и \r и эмитит
 * операции. Семантика — как курсор в консоли: одиночный \r означает, что
 * СЛЕДУЮЩИЙ сегмент пишется с начала строки (операция 'r' — перезапись
 * с затиранием хвоста). Одиночный \r в САМОМ конце чанка придерживается
 * (до следующего чанка неизвестно, \r\n это или перезапись строки). */
function makeConsoleWriter() {
  let carry = ''
  let atLineStart = false
  const flush = (seg, withNewline) => {
    if (atLineStart) {
      pushConsoleOp('r', seg)
      atLineStart = false
    } else {
      pushConsoleOp('a', seg)
    }
    if (withNewline) pushConsoleOp('a', '\n')
  }
  return (chunkStr) => {
    carry += chunkStr
    let i = 0
    while (i < carry.length) {
      const nl = carry.indexOf('\n', i)
      const cr = carry.indexOf('\r', i)
      if (nl === -1 && cr === -1) break // неполная строка — ждём продолжения
      if (cr !== -1 && (nl === -1 || cr < nl)) {
        if (cr + 1 >= carry.length) break // \r в конце чанка: ждём следующий
        if (carry[cr + 1] === '\n') {
          flush(carry.slice(i, cr), true) // \r\n — обычный конец строки
          i = cr + 2
        } else {
          flush(carry.slice(i, cr), false) // одиночный \r: дальше — с начала строки
          atLineStart = true
          i = cr + 1
        }
      } else {
        flush(carry.slice(i, nl), true) // \n без \r
        i = nl + 1
      }
    }
    carry = carry.slice(i)
  }
}

/* Свои логи ([desktop] …) — тоже в буфер: «вообще вся информация».
 * orig.log выводит в реальную консоль, appendConsole — без tee (без дубля). */
{
  const fmt = (a) => a.map((x) => (typeof x === 'string' ? x : util.inspect(x))).join(' ')
  // (правка 571) Не вызываем оригинальный console.log/warn/error — он пишет
  // в process.stdout, который при скрытом запуске (start_hidden.vbs) может
  // быть «broken pipe» (EPIPE). appendConsole сам пишет в буфер и в UI.
  console.log = (...a) => { appendConsole(fmt(a) + '\n', false) }
  console.warn = (...a) => { appendConsole('[warn] ' + fmt(a) + '\n', false) }
  console.error = (...a) => { appendConsole('[error] ' + fmt(a) + '\n', false) }
}
appendConsole(`[desktop] MiniMax H3 Studio — захват консоли запущен (${new Date().toISOString()})\n`)

/* ── Дочерние процессы (убиваются при выходе) ── */
const children = new Set()

/* (правка 587) ComfyUI/python на Windows часто пишет в консоль в OEM-кодировке
 * (cp866) — toString('utf8') даёт кракозябры в панели «Консоль». Если
 * UTF-декодировка содержит U+FFFD (битые последовательности), пробуем IBM866
 * (TextDecoder с полным ICU, Node 22+ / Electron 44). */
let ibm866Decoder = null
function decodeChildOutput(d) {
  const s = d.toString('utf8')
  if (!s.includes('\uFFFD')) return s
  try {
    if (!ibm866Decoder) ibm866Decoder = new TextDecoder('ibm866')
    return ibm866Decoder.decode(d)
  } catch { return s }
}

function spawnChild(cmd, args, opts = {}) {
  const c = spawn(cmd, args, {
    cwd: APP_ROOT,
    // (правка 567) pipe + захват в буфер «Консоли» (appendConsole сам
    // дублирует в реальную консоль) — inherit рендереру недоступен.
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    ...opts,
  })
  // (правка 587) Асинхронная ошибка spawn (ENOENT и т.п.) без обработчика
  // 'error' роняла весь main-процесс вместо понятного сообщения.
  c.on('error', (err) => {
    appendConsole(`[desktop] не удалось запустить процесс (${cmd}): ${err.message}\n`)
    children.delete(c)
  })
  // (правка 588) Каждый поток — со СВОИМ ассемблером строк (неполный хвост
  // одного потока не должен склеиваться с чужим чанком).
  const writeOut = makeConsoleWriter()
  const writeErr = makeConsoleWriter()
  c.stdout.on('data', (d) => writeOut(decodeChildOutput(d)))
  c.stderr.on('data', (d) => writeErr(decodeChildOutput(d)))
  children.add(c)
  c.on('exit', () => children.delete(c))
  return c
}

/** Убить дерево процесса (сам процесс + все дочерние — LLM/upscale и т.п.).
 *  taskkill /T /F — как в llm-runner: надёжнее child.kill() на Windows. */
function killTree(pid) {
  if (!pid) return
  try {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
  } catch { /* уже мёртв */ }
}

/** Имя образа процесса по PID («node.exe» / «python.exe» / …), '' если не нашли.
 *  (правка 587) Проверка владельца перед taskkill порта. */
function processImageName(pid) {
  try {
    const out = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8', windowsHide: true,
    }).stdout || ''
    const m = /^"([^"]+\.exe)"/i.exec(out.trim())
    return m ? m[1].toLowerCase() : ''
  } catch { return '' }
}

/** Убить слушателей TCP-порта (осиротевшие прошлые сессии).
 *  (правка 561) Порт из start.bat: ДВА литеральных фильтра подряд —
 *  `:port ` в начале поля адреса И «LISTENING». Одиночный findstr-матч
 *  по подстроке ловил бы ESTABLISHED-соединения браузера/node и taskkill
 *  убивал бы чужие процессы. taskkill по PID пулинг-сокетов не трогает.
 *  (правка 587) Владелец-фильтр: убиваем только node/python/electron —
 *  постороннее приложение, случаем занявшее порт 3000/8188 (IIS, свой
 *  сервис, браузер), больше не убивается молча. */
const KILLABLE_IMAGES = new Set(['node.exe', 'python.exe', 'pythonw.exe', 'electron.exe'])
function killPortListeners(port) {
  let out = ''
  try {
    out = spawnSync('netstat', ['-aon'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).stdout || ''
  } catch { return }
  const needle = `:${port}`
  const pids = new Set()
  for (const line of out.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/)
    if (parts.length >= 5 && parts[3] === 'LISTENING') {
      const local = parts[1] || ''
      // локальный адрес вида 0.0.0.0:3000 / [::]:3000 / 127.0.0.1:3000
      if (local.endsWith(needle)) pids.add(parts[4])
    }
  }
  for (const pid of pids) {
    if (Number(pid) === process.pid) continue // себя не убиваем
    const image = processImageName(pid)
    // (правка 716) Fail-SAFE, а не fail-open. Раньше проверка была
    // `if (image && !KILLABLE_IMAGES.has(image))` — при ПУСТОМ image
    // (процесс уже завершился: tasklist печатает локализованное
    // «INFO: No tasks are running…», которое не подпадает под regex;
    // либо tasklist не сработал) защита пропускалась и PID убивался
    // БЕЗУСЛОВНО — ровно тот случай, который комментарий выше обещает
    // не трогать (чужое приложение, случайно занявшее порт).
    if (!image) {
      console.log(`[desktop] слушатель порта ${port} (PID ${pid}) — владелец не определён, не убиваем`)
      continue
    }
    if (!KILLABLE_IMAGES.has(image)) {
      console.log(`[desktop] слушатель порта ${port} (PID ${pid}, ${image}) — не наш процесс, не трогаем`)
      continue
    }
    try {
      spawnSync('taskkill', ['/PID', pid, '/F'], { windowsHide: true })
      console.log(`[desktop] убит слушатель порта ${port}: PID ${pid} (${image})`)
    } catch { /* ignore */ }
  }
}

/* ── config.ini → флаги ComfyUI (порт правки 551 из start.bat) ── */
function parseIniVram() {
  const v = { reserveGb: '3', dynamicVram: '1', asyncOffload: '0', vramHeadroom: '0' }
  if (!existsSync(CONFIG_INI)) return v
  let text = ''
  try {
    text = readFileSync(CONFIG_INI, 'utf8')
  } catch { return v }
  const grab = (key) => {
    for (const line of text.split(/\r?\n/)) {
      if (line.trim().toLowerCase().startsWith(key + '=')) {
        return line.slice(line.indexOf('=') + 1).trim().replace(/"/g, '')
      }
    }
    return undefined
  }
  // первый матч выигрывает (дубли ключей от старых конфигов), /b-семантика bat
  const num = (raw, dflt, re) => (raw !== undefined && re.test(raw) ? raw : dflt)
  v.reserveGb = num(grab('reserve_gb'), '3', /^[0-9][0-9.]*$/)
  v.dynamicVram = num(grab('dynamic_vram'), '1', /^[01]$/)
  v.asyncOffload = num(grab('async_offload'), '0', /^[01]$/)
  v.vramHeadroom = num(grab('vram_headroom'), '2', /^[0-9][0-9.]*$/)
  return v
}

function startComfy() {
  if (!existsSync(COMFY_PY)) {
    console.log('[desktop] ComfyUI не найден — режим frontend-only (генерация недоступна)')
    return null
  }
  const v = parseIniVram()
  const args = [
    '-I', path.join(COMFY_ROOT, 'ComfyUI', 'main.py'),
    '--windows-standalone-build',
    '--use-ck-attention',
    '--disable-auto-launch',
    '--reserve-vram', v.reserveGb,
  ]
  if (v.dynamicVram === '0') args.push('--disable-dynamic-vram')
  if (v.asyncOffload !== '1') args.push('--disable-async-offload', '--disable-pinned-memory')
  if (v.vramHeadroom !== '0') args.push('--vram-headroom', v.vramHeadroom)
  console.log(`[desktop] ComfyUI: ${args.join(' ')}`)
  return spawnChild(COMFY_PY, args)
}

/* ── (правка 748) Первый запуск: зависимости не установлены ──────
 * Если python_embeded нет (пользователь снял галку «установить
 * зависимости» в инсталляторе или скачивание оборвалось), приложение
 * само запускает install.ps1 СКРЫТО (windowsHide — без консоли) и ждёт.
 * install.ps1 пишет каждый шаг в .install-cache\setup_status.json,
 * заставка показывает «Установка компонентов: [N/9] …». ComfyUI
 * поднимается только после успешного завершения установки.
 * Если установщик уже запущен снаружи (install.bat из ПУСКа или прошлый
 * запуск) — второй не поднимаем, просто следим за статус-файлом. */
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

function readSetupStatus() {
  try {
    return JSON.parse(readFileSync(SETUP_STATUS, 'utf8'))
  } catch {
    return null
  }
}

function writeSetupStatus(state, step, total, title) {
  try {
    mkdirSync(path.dirname(SETUP_STATUS), { recursive: true })
    writeFileSync(SETUP_STATUS, JSON.stringify({
      state, step, total, title, pid: process.pid,
      ts: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    }), 'utf8')
  } catch (err) {
    console.log(`[desktop] не удалось записать статус установки: ${err && err.message ? err.message : err}`)
  }
}

/** Статус «установка идёт» актуален? (устаревший = упавший установщик) */
function statusIsLive(st) {
  if (!st || st.state !== 'running') return false
  const ts = Date.parse(st.ts || '')
  return Number.isFinite(ts) && Date.now() - ts < 12 * 60 * 1000
}

async function runSetupIfNeeded() {
  if (existsSync(COMFY_PY)) return true
  const ps1 = path.join(APP_ROOT, 'install', 'install.ps1')

  const st = readSetupStatus()
  if (statusIsLive(st)) {
    appendConsole(`[desktop] установка уже идёт (PID ${st.pid}) — жду её завершения\n`)
    return await waitForExternalSetup()
  }
  if (!existsSync(ps1)) {
    writeSetupStatus('error', 0, 9, 'Не найден install\\install.ps1')
    return false
  }

  appendConsole('[desktop] зависимости не установлены — запускаю установку (скрыто)\n')
  writeSetupStatus('running', 0, 9, 'Запуск установки зависимостей…')
  const inst = spawnChild(POWERSHELL, [
    '-NoProfile', '-NoLogo', '-ExecutionPolicy', 'Bypass',
    '-File', ps1, '-Root', APP_ROOT, '-NoPause',
  ])
  const code = await new Promise((resolve) => inst.on('exit', (c) => resolve(c)))
  if (quitting) return false
  if (code === 0 && existsSync(COMFY_PY)) {
    writeSetupStatus('done', 9, 9, 'Установка завершена')
    return true
  }
  writeSetupStatus('error', 0, 9, `Установка завершилась с ошибкой (код ${code})`)
  return false
}

/** Ждём внешнего установщика: пока статус «running» и живой — ждём. */
async function waitForExternalSetup() {
  while (!quitting) {
    await new Promise((r) => setTimeout(r, 5000))
    const st = readSetupStatus()
    if (statusIsLive(st)) continue
    if (st && st.state === 'done') return existsSync(COMFY_PY)
    return false
  }
  return false
}

function startWebServer() {
  // Node самого Electron: ELECTRON_RUN_AS_NODE превращает electron.exe в
  // обычный node — системный Node для рантайма не нужен (нужен только для
  // npm install/build, что делает start.bat до запуска окна).
  return spawnChild(process.execPath, [path.join(APP_ROOT, 'server.js')], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      // (правка 587) Родитель-страж: server.js проверяет этот PID каждые 5 с
      // и сам завершается (со своими питон-детьми через exit-хуки раннеров),
      // если Electron умер и его before-quit-очистка не выполнилась.
      MINIMAX_PARENT_PID: String(process.pid),
    },
  })
}

/** Ждать ответа HTTP от web-сервера (splash отдаётся сразу после старта). */
async function waitHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
      if (res.ok) return true
    } catch { /* ещё не поднялся */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

/* ── Окно ── */
let win = null

/* (правка 563) Кнопки окна из рендерера (preload → IPC): свои HTML-кнопки
 * в DesktopTitleBar вместо нативных. */
ipcMain.on('h3:window-minimize', () => win?.minimize())
ipcMain.on('h3:window-maximize-toggle', () => {
  if (!win) return
  if (win.isMaximized()) win.unmaximize()
  else win.maximize()
})
ipcMain.on('h3:window-close', () => win?.close())

/* (правка 567) Панель «Консоль»: полный буфер + сохранение в файл
 * через нативный диалог выбора места. */
ipcMain.handle('h3:console-get', () => consoleBuf)
ipcMain.handle('h3:console-save', async (_e, text) => {
  if (typeof text !== 'string' || !text.length) return { ok: false, error: 'Пустой лог' }
  try {
    const r = await dialog.showSaveDialog(win, {
      title: 'Сохранить лог консоли',
      defaultPath: `h3-studio-console-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`,
      filters: [{ name: 'Текстовый файл', extensions: ['txt'] }],
    })
    if (r.canceled || !r.filePath) return { ok: false, canceled: true }
    await fsPromises.writeFile(r.filePath, text, 'utf8')
    console.log(`[desktop] лог консоли сохранён: ${r.filePath}`)
    return { ok: true, path: r.filePath }
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) }
  }
})

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 1200,
    minHeight: 700,
    backgroundColor: '#1c1c20', // фон до загрузки — без белой вспышки
    icon: ICON,
    title: 'MiniMax H3 Studio 7',
    autoHideMenuBar: true,
    show: false,
    // (правка 562/563) Свой окно-хром: нативный заголовок спрятан. Кнопки
    // свернуть/развернуть/закрыть рисует САМО приложение (DesktopTitleBar)
    // через preload-IPC — без фоновой плашки нативного titleBarOverlay,
    // на заставке только закрытие, в приложении все три.
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })
  // Настоящее десктоп-ощущение: без меню-бара (Alt показывать не нужно).
  Menu.setApplicationMenu(null)

  // Заставка открывается в обычном размере (правка 565 — НЕ максимизируем
  // при показе). Окно разворачивается на весь экран только при входе в САМО
  // приложение (splash → /), т.е. когда ComfyUI готов и заставка ушла.
  win.once('ready-to-show', () => win.show())

  // (правка 565) Переход splash → '/': Next.js App Router ходит через
  // History API → событие did-navigate-in-page; полный переход (перезагрузка
  // уже в приложении) — did-navigate. Ловим оба, максимизируем один раз.
  let maximizedForApp = false
  const maximizeWhenApp = (_e, url) => {
    if (maximizedForApp || !win) return
    let pathname = ''
    try {
      pathname = new URL(url).pathname
    } catch { return }
    if (!pathname.startsWith('/splash')) {
      maximizedForApp = true
      win.maximize()
    }
  }
  win.webContents.on('did-navigate', maximizeWhenApp)
  win.webContents.on('did-navigate-in-page', maximizeWhenApp)

  // Внешние ссылки — в системный браузер; новых окон приложения не плодим.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !url.includes(`127.0.0.1:${PORT}`) && !url.includes(`localhost:${PORT}`)) {
      // (правка 716) .catch обязателен: openExternal отклоняется, если ОС не
      // знает обработчика (нет браузера). Без обработчика это unhandled
      // rejection → падение main-процесса → осиротевший ComfyUI.
      void shell.openExternal(url).catch((err) => {
        console.log(`[desktop] не удалось открыть внешнюю ссылку: ${err && err.message ? err.message : err}`)
      })
    }
    return { action: 'deny' }
  })

  // (правка 716) Запрет навигации на посторонние origin. setWindowOpenHandler
  // покрывает только window.open()/target="_blank"; навигация основного фрейма
  // (location.href, <a href>, отправка формы, XSS) шла без ограничений, и
  // удалённая страница наследовала preload-мост (console.get() с локальными
  // путями, console.save(), управление окном). Плюс Electron по умолчанию
  // АВТООДОБРЯЕТ запросы на микрофон, а приложение его использует.
  win.webContents.on('will-navigate', (event, url) => {
    if (!isLocalAppUrl(url)) {
      event.preventDefault()
      console.log(`[desktop] навигация на посторонний origin заблокирована: ${url}`)
    }
  })
  win.webContents.on('will-redirect', (event, url) => {
    if (!isLocalAppUrl(url)) {
      event.preventDefault()
      console.log(`[desktop] редирект на посторонний origin заблокирован: ${url}`)
    }
  })
  // Микрофон и буфер обмена — только для локального origin приложения.
  // Chromium запрашивает clipboard-sanitized-write для navigator.clipboard.writeText()
  // (кнопка «Скопировать всё» в консоли, копирование промптов/путей).
  // Раньше разрешение выдавалось только для media, поэтому копирование в
  // Electron стабильно падало с «запрос разрешения отклонён».
  const CLIPBOARD_PERMISSIONS = new Set([
    'clipboard-read',
    'clipboard-write',
    'clipboard-sanitized-write',
  ])
  win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    const local = isLocalAppUrl(win && win.webContents.getURL())
    const allowed = local && (permission === 'media' || CLIPBOARD_PERMISSIONS.has(permission))
    if (!allowed) console.log(`[desktop] запрос разрешения отклонён: ${permission}`)
    callback(allowed)
  })

  // F12 — DevTools (диагностика локального приложения)
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      win.webContents.toggleDevTools()
      e.preventDefault()
    }
  })

  win.on('closed', () => { win = null })
  // (правка 716) .catch обязателен: loadURL отклоняется при ERR_CONNECTION_REFUSED
  // (сервер не поднялся) или ERR_ABORTED. Без обработчика — unhandled
  // rejection → падение main-процесса → осиротевшие ComfyUI/python-процессы
  // (before-quit не выполнится, killTree() не вызовется).
  void win.loadURL(`http://127.0.0.1:${PORT}/splash`).catch((err) => {
    console.error(`[desktop] не удалось загрузить окно: ${err && err.message ? err.message : err}`)
    try {
      dialog.showErrorBox(
        'MiniMax H3 Studio — ошибка загрузки',
        `Не удалось открыть интерфейс:\n${err && err.message ? err.message : String(err)}\n` +
          'Приложение будет закрыто.',
      )
    } catch { /* ignore */ }
    app.quit()
  })
}

/** (правка 716) URL принадлежит локальному приложению? */
function isLocalAppUrl(url) {
  if (!url) return false
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'file:') return false
    if (u.protocol === 'file:') return true
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1'
  } catch {
    return false
  }
}

/* ── Жизненный цикл ── */

// (правка 716) before-quit регистрируется ДО проверки single-instance lock.
// Раньше app.quit() в ветке «вторая копия» вызывался до регистрации
// обработчика, и скрытая консоль cmd.exe, созданная start_hidden.vbs для
// ЭТОГО запуска, оставалась висеть навсегда (невидимый осиротевший процесс).
app.on('before-quit', () => {
  quitting = true
  for (const c of children) killTree(c.pid)
  children.clear()
  // (правка 748) Установщик, запущенный НАМИ (spawnChild), уже убит выше.
  // Если установка шла СНАРУЖИ (install.bat из меню ПУСК или прошлый запуск,
  // статус-файл с чужим pid) — прикрываем и её: «закрыть» = стоп всё.
  try {
    const st = readSetupStatus()
    if (st && st.state === 'running' && st.pid && Number(st.pid) !== process.pid) {
      killTree(Number(st.pid))
    }
  } catch { /* ignore */ }
  // (правка 570/587) Убить родительский cmd-процесс (скрытая консоль от
  // start_hidden.vbs / start.bat). process.ppid — НЕ cmd: в штатной цепочке
  // запуска (start.bat → node electron\cli.js → electron.exe) родителем
  // Electron является node.exe (cli.js), а cmd.exe — его родитель. Старая
  // проверка «ppid — это cmd.exe» всегда проваливалась, и скрытая консоль
  // оставалась висеть. Поднимаемся по дереву предков (до 6 уровней) и убиваем
  // ближайший cmd.exe деревом (/T /F).
  killAncestorCmd()
})

// Вторая копия — фокусирует существующее окно вместо нового процесса.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  void (async () => {
    // Ждём готовности app (ready); в packaged-режиме путь к иконке/ресурсам
    // не меняется — запускаемся только из папки проекта.
    await app.whenReady()

    // (релиз) Идентичность приложения в Windows. Без неё иконка в таскбаре
    // и группировка окон идут под именем «Electron» (оно берётся из
    // productName = name в package.json) и после переустановки/обновления
    // Windows может «размножить» ярлыки. Явный AppUserModelID привязывает
    // окно к нашему приложению.
    try {
      app.setAppUserModelId('com.minimax.h3studio')
    } catch {
      /* старые Windows — не критично */
    }

    // (правка 586) Оставляем только безопасную очистку слушателей портов 3000/8188.
    killPortListeners(PORT)
    killPortListeners(COMFY_PORT)

    const server = startWebServer()
    if (existsSync(COMFY_PY)) {
      startComfy()
    } else {
      // (правка 748) Первый запуск: окно и заставка открываются СРАЗУ,
      // установка зависимостей идёт скрыто на фоне, заставка показывает
      // шаги; ComfyUI стартует после успешного завершения установки.
      void runSetupIfNeeded().then((ok) => {
        if (ok && !quitting) startComfy()
      })
    }

    // Крах сервера (не our quit) — честно сообщаем и выходим.
    server.on('exit', (code) => {
      if (quitting) return
      dialog.showErrorBox(
        'MiniMax H3 Studio — сервер остановлен',
        `Веб-сервер завершился с кодом ${code}.\n` +
          'Подробности — в консоли запуска (start.bat).\n' +
          'Приложение будет закрыто.',
      )
      app.quit()
    })

    const up = await waitHttp(`http://127.0.0.1:${PORT}/splash`, 120_000)
    if (!up) {
      dialog.showErrorBox(
        'MiniMax H3 Studio — сервер не поднялся',
        `Веб-сервер не ответил за 120 с (порт ${PORT}).\n` +
          'Возможно, идёт первая сборка — перезапустите start.bat.',
      )
      app.quit()
      return
    }
    createWindow()
  })().catch((err) => {
    // (правка 716) Раньше IIFE был «void» без обработчика: любое исключение
    // (например, new BrowserWindow() не удался) давало unhandled rejection →
    // падение main-процесса → app.on('before-quit') НЕ выполнялся →
    // killTree() не вызывался → ComfyUI/python оставались жить (порт 8188,
    // VRAM) до следующего запуска.
    console.error(`[desktop] критическая ошибка запуска: ${err && err.stack ? err.stack : err}`)
    try {
      dialog.showErrorBox(
        'MiniMax H3 Studio — ошибка запуска',
        `Не удалось запустить приложение:\n${err && err.message ? err.message : String(err)}`,
      )
    } catch { /* ignore */ }
    app.quit()
  })
}

// (правка 716) Обработчики необработанных ошибок: без них Node завершает
// процесс, а падение main-процесса оставляет ВСЕ дочерние процессы
// (ComfyUI, LLM, STT, upscale-мост) сиротами — они держат порты и VRAM.
process.on('unhandledRejection', (reason) => {
  console.error(`[desktop] unhandledRejection: ${reason && reason.stack ? reason.stack : reason}`)
  try { app.quit() } catch { /* ignore */ }
})
process.on('uncaughtException', (err) => {
  console.error(`[desktop] uncaughtException: ${err && err.stack ? err.stack : err}`)
  try { app.quit() } catch { /* ignore */ }
})

// (правка 716) Обработчик before-quit зарегистрирован ВЫШЕ — до проверки
// single-instance lock (иначе app.quit() в ветке «вторая копия» оставлял
// скрытую консоль cmd.exe висеть).

/** (правка 587) Найти среди предков текущего процесса cmd.exe и убить его. */
function killAncestorCmd() {
  let pid = process.ppid
  for (let hop = 0; pid && pid > 0 && hop < 6; hop++) {
    let name = ''
    let ppid = 0
    try {
      const out = spawnSync(
        'powershell', ['-NoProfile', '-Command',
          `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').Name;` +
          `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').ParentProcessId`],
        { encoding: 'utf8', windowsHide: true },
      ).stdout || ''
      const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      if (lines.length >= 2) {
        name = (lines[0] || '').toLowerCase()
        ppid = parseInt(lines[1], 10) || 0
      }
    } catch { /* PowerShell недоступен — выходим из цикла */ }
    if (!name) {
      console.log(`[desktop] предок PID ${pid} не найден (уже завершён) — остановка поиска cmd`)
      return
    }
    if (name === 'cmd.exe') {
      try {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
        console.log(`[desktop] родительский cmd-процесс (PID ${pid}) завершён`)
      } catch {
        console.log(`[desktop] родительский cmd-процесс (PID ${pid}) уже завершён`)
      }
      return
    }
    pid = ppid
  }
  console.log('[desktop] cmd.exe среди ближайших предков не найден — родителя не трогаем')
}
app.on('window-all-closed', () => app.quit())
