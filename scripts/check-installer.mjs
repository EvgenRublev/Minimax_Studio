#!/usr/bin/env node
/**
 * (правка 939) Статическая проверка надёжности установки. ГПУ/сеть не трогаем,
 * ставим только локальные файлы. Проверяем:
 *
 *   1) install/checksums.json покрывает ВЕСЬ офлайн-бандл install/cache, и
 *      sha256/размер в нём совпадают с реальными файлами (битый архив внутри
 *      setup.exe — это тот же класс отказа, что и битый кэш у юзера);
 *   2) флаги pinned расходятся с правилами (сеть сверяется только для
 *      неизменяемых артефактов);
 *   3) версии в install.ps1 / package.json совпадают с именами файлов бандла
 *      (перевели electron на 45.0 и забыли пересобрать бандл — ловится здесь);
 *   4) в install.ps1 на месте вся механика целостности: проверка магических
 *      байтов, контрольsha для загрузки, чистка битого кэша в trap, второй
 *      движок распаковки (Expand-Archive) и Remove-StaleCacheFile;
 *   5) кодировки: install.ps1 и install_gui.ps1 — UTF-8 с BOM (PowerShell 5.1
 *      без BOM читает UTF-8 как ANSI и русские сообщения превращает в кракозябры),
 *      installer.nsi — UTF-8 с BOM (makensis без BOM читает скрипт как ANSI и
 *      печатает кракозябры уже в готовом setup.exe — правка 957),
 *      apply_update.ps1 — только ASCII (его гоняет апдейтер из любого места);
 *   6) во всех .ps1 нет одиночных LF (git/Windows-смешание переносов).
 *
 * Запуск: node scripts/check-installer.mjs
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CACHE_DIR = join(ROOT, 'install', 'cache')
const SUMS = join(ROOT, 'install', 'checksums.json')

const PINNED = [
  /^node-v\d+\.\d+\.\d+-win-x64\.zip$/,
  /^python-\d+\.\d+\.\d+-embed-amd64\.zip$/,
  /^electron-v\d+\.\d+\.\d+-win32-x64\.zip$/,
  /^uv-[a-z0-9_.-]+\.zip$/,
]
const isPinned = (rel) => PINNED.some((re) => re.test(basename(rel)))

let pass = 0
const fails = []
const ok = (cond, msg) => {
  if (cond) pass++
  else fails.push(msg)
}

function walk(dir, prefix = '') {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    const full = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(full, rel))
    else if (e.isFile()) out.push({ rel, full })
  }
  return out
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

// ─── 1..2) бандл и суммы ────────────────────────────────────────────────────
if (!existsSync(SUMS)) {
  fails.push('нет install/checksums.json — сгенерируй: node scripts/make-installer-cache.mjs')
} else if (!existsSync(CACHE_DIR)) {
  fails.push('нет папки install/cache (офлайн-бандл установщика)')
} else {
  const sums = JSON.parse(readFileSync(SUMS, 'utf8'))
  const files = walk(CACHE_DIR)
  ok(files.length > 0, 'install/cache пуст')
  for (const f of files) {
    const entry = sums.files?.[f.rel]
    if (!entry) {
      fails.push(`в checksums.json нет записи для ${f.rel} (пересобрать суммы)`)
      continue
    }
    const size = statSync(f.full).size
    ok(entry.size === size, `${f.rel}: размер в checksums.json ${entry.size}, на диске ${size}`)
    const got = sha256(f.full)
    ok(entry.sha256 === got, `${f.rel}: sha256 не совпал — бандл повреждён (${got})`)
    ok(typeof entry.sha256 === 'string' && /^[0-9a-f]{64}$/.test(entry.sha256), `${f.rel}: sha256 в checksums.json не похож на sha256`)
    ok(typeof entry.kind === 'string' && ['', 'zip', 'gzip', 'exe'].includes(entry.kind), `${f.rel}: kind должен быть zip/gzip/exe или '' (не архив)`)
    ok(entry.pinned === isPinned(f.rel), `${f.rel}: pinned=${entry.pinned} против правил (ожидался ${isPinned(f.rel)})`)
  }
  const extra = Object.keys(sums.files || {}).filter((k) => !files.some((f) => f.rel === k))
  ok(extra.length === 0, `в checksums.json есть лишние записи: ${extra.join(', ')}`)
  // без сверки по сети нельзя оставаться «вечным» кэшем
  const core = ['node', 'python', 'electron', 'uv']
  for (const name of core) {
    const has = Object.entries(sums.files || {}).some(([rel, v]) => v.pinned && rel.startsWith(name))
    ok(has, `в бандле нет pinned-архива для ${name} — нечего сверять при загрузке из сети`)
  }
}

// ─── 3) версии: install.ps1 / package.json ↔ имена файлов бандла ────────────
const instPath = join(ROOT, 'install', 'install.ps1')
const inst = existsSync(instPath) ? readFileSync(instPath, 'utf8') : ''
ok(inst.length > 0, 'не читается install/install.ps1')

function bundleHas(rel) {
  return existsSync(join(CACHE_DIR, rel))
}
const nodeVer = (inst.match(/\$nodeVersion\s*=\s*'([\d.]+)'/) || [])[1]
ok(!!nodeVer, 'install.ps1: не нашёл $nodeVersion')
if (nodeVer) ok(bundleHas(`node-v${nodeVer}-win-x64.zip`), `в бандле нет node-v${nodeVer}-win-x64.zip (версия из install.ps1)`)

const comfyVer = (inst.match(/\$ComfyVersion\s*=\s*'([\d.]+)'/) || [])[1]
const comfyZip = (inst.match(/\$ComfyZipName\s*=\s*'([^']+)'/) || [])[1]
const comfyUrl = (inst.match(/\$ComfyUrl\s*=\s*'([^']+)'/) || [])[1]
ok(!!comfyVer && !!comfyZip && !!comfyUrl, 'install.ps1: не нашёл $ComfyVersion/$ComfyZipName/$ComfyUrl')
if (comfyVer && comfyZip) ok(comfyZip === `ComfyUI-v${comfyVer}.zip`, `ComfyZipName=${comfyZip} не соответствует ComfyVersion=${comfyVer}`)
if (comfyVer && comfyUrl) ok(comfyUrl.includes(`/v${comfyVer}.zip`), `ComfyUrl (${comfyUrl}) не на тег v${comfyVer}`)
if (comfyZip) ok(bundleHas(comfyZip), `в бандле нет ${comfyZip}`)

const pyVer = (inst.match(/python-(\d+\.\d+\.\d+)-embed-amd64\.zip/) || [])[1]
ok(!!pyVer, 'install.ps1: не нашёл версию портативного Python')
if (pyVer) ok(bundleHas(`python-${pyVer}-embed-amd64.zip`), `в бандле нет python-${pyVer}-embed-amd64.zip`)

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const elVer = String(pkg.devDependencies?.electron || pkg.dependencies?.electron || '').replace(/^[\^~]/, '')
ok(!!elVer, 'package.json: нет версии electron')
if (elVer) ok(bundleHas(`electron-v${elVer}-win32-x64.zip`), `в бандле нет electron-v${elVer}-win32-x64.zip (версия electron из package.json)`)

const uvVer = (inst.match(/astral-sh\/uv\/releases\/download\/([\d.]+)\//) || [])[1]
ok(!!uvVer, 'install.ps1: не нашёл версию uv')
if (uvVer) ok(bundleHas('uv-x86_64-pc-windows-msvc.zip'), 'в бандле нет uv-x86_64-pc-windows-msvc.zip')

// ─── 4) механика целостности в install.ps1 ─────────────────────────────────
const need = [
  ['function Test-ArchiveFile', 'нет функции проверки архива Test-ArchiveFile'],
  ['function Clear-CorruptCache', 'нет Clear-CorruptCache'],
  ['function Remove-StaleCacheFile', 'нет Remove-StaleCacheFile'],
  ['function Get-HeadKind', 'нет разбора магических байтов (Get-HeadKind)'],
]
for (const [needle, msg] of need) ok(inst.includes(needle), `install.ps1: ${msg}`)

// вызовы, а не только объявления
const td = inst.match(/function Get-Download \{[\s\S]*?\n\}/)
ok(!!td && /Test-ArchiveFile/.test(td[0]), 'Get-Download не проверяет скачанный файл')
ok(!!td && /Remove-StaleCacheFile/.test(td[0]), 'Get-Download не чистит битый кэш')
const ez = inst.match(/function Expand-ZipSafe \{[\s\S]*?\n\}/)
ok(!!ez && /Test-ArchiveFile/.test(ez[0]), 'Expand-ZipSafe не проверяет архив перед распаковкой')
ok(!!ez && /Expand-Archive/.test(ez[0]), 'Expand-ZipSafe: нет запасного движка Expand-Archive')
const et = inst.match(/function Expand-TarGz \{[\s\S]*?\n\}/)
ok(!!et && /Test-ArchiveFile/.test(et[0]), 'Expand-TarGz не проверяет архив перед распаковкой')
const tr = inst.match(/trap \{[\s\S]*?\n\}/)
ok(!!tr && /Clear-CorruptCache/.test(tr[0]), 'trap не чистит битый кэш (повторный запуск упрётся в ту же ошибку)')
ok(/Get-ChildItem \$bundle -Recurse -File/.test(inst) && /Test-ArchiveFile \$src/.test(inst), 'посев бандла install/cache не проверяет его целостность')
ok(!/\[IO\.Compression\.ZipFile\]::ExtractToDirectory/.test(inst), 'в install.ps1 остался прямой ExtractToDirectory мимо проверки архива')

// (правка 940) проверки окружения: без них «не у всех» превращается в загадочные
// сбои распаковки и «torch не импортируется» без подсказки.
const envChecks = [
  ['LongPathsEnabled', 'нет проверки/включения LongPathsEnabled (длинные пути в node_modules и ComfyUI)'],
  ['WindowsBuiltInRole]::Administrator', 'нет определения прав администратора'],
  ["-eq 'Network'", 'нет предупреждения про сетевой диск'],
  ["-eq 'Removable'", 'нет предупреждения про съёмный диск'],
  ['onedrive', 'нет предупреждения про OneDrive'],
  ['[^\\x00-\\x7F]', 'нет предупреждения про не-ASCII в пути установки'],
  ['System32\\tar.exe', 'нет проверки наличия tar.exe (Windows 10 1803+)'],
  ['VcRedistBroken', 'нет отметки «VC++ redist не обновился» для подсказки на шаге 9'],
]
for (const [needle, msg] of envChecks) ok(inst.includes(needle), `install.ps1: ${msg}`)
ok(inst.includes('WinError 1114'), 'install.ps1: ошибка torch не связывается с VC++ redist (WinError 1114)')

// (правка 940) апдейтер обязан проверять место на диске до скачивания
const appUpPath = join(ROOT, 'src', 'lib', 'app-update.ts')
if (existsSync(appUpPath)) {
  const au = readFileSync(appUpPath, 'utf8')
  ok(au.includes('statfsSync'), 'app-update.ts: пропала проверка свободного места (statfsSync)')
  ok(au.includes('Недостаточно места на диске'), 'app-update.ts: проверка места не даёт понятной ошибки')
} else {
  fails.push('src/lib/app-update.ts не найден — проверка апдейтера пропущена')
}

// (правка 941) самодиагностика, подсказки и «живой» статус. Без этого долгий
// шаг выглядит как зависшая установка, а причина отказа обрезается в окне.
const guiPath = join(ROOT, 'install', 'install_gui.ps1')
const gui = existsSync(guiPath) ? readFileSync(guiPath, 'utf8') : ''
ok(inst.includes('[switch]$SelfCheck'), 'install.ps1: нет режима -SelfCheck')
ok(inst.includes('[switch]$Deep'), 'install.ps1: нет режима -Deep (сверка sha256)')
ok(/function Invoke-SelfCheck/.test(inst), 'install.ps1: нет функции самодиагностики')
ok(inst.includes('if ($SelfCheck -or $Deep)'), 'install.ps1: самодиагностика не вызывается')
ok(/nodes\.json/.test(inst.match(/function Invoke-SelfCheck[\s\S]*?\n\}/)?.[0] ?? ''),
  'самодиагностика не сверяет кастомные ноды с install/nodes.json')
ok(!(inst.match(/function Invoke-SelfCheck[\s\S]*?\n\}/)?.[0] ?? '').includes('PH3ImageConditioning'),
  'самодиагностика всё ещё проверяет удалённый режим «Изображение» (правка 951)')
ok(inst.match(/function Invoke-SelfCheck[\s\S]*?\n\}/)?.[0].includes('import torch'),
  'самодиагностика не проверяет импорт torch')
ok(inst.match(/function Invoke-SelfCheck[\s\S]*?\n\}/)?.[0].includes('comfy-patches'),
  'самодиагностика не сверяет патчи ядра с установщиком')
// (правка 943) путь к Electron в самодиагностике обязан совпадать с раскладкой
// npm-пакета: node_modules\electron\dist\electron.exe (иначе ложная жалоба).
ok((inst.match(/function Invoke-SelfCheck[\s\S]*?\n\}/)?.[0] ?? '').includes('electron\\dist\\electron.exe'),
  'самодиагностика ищет Electron не в node_modules\\electron\\dist')
ok(/SelfCheckMode/.test(inst), 'install.ps1: режим самодиагностики не отключает запись (посев бандла)')
// статус: hint+log наружу, heartbeat держит ts живым, финал пишется без heartbeat
ok(inst.includes('StatusHint'), 'install.ps1: статус не отдаёт hint')
ok(/log\s*=\s*\$LogFile/.test(inst), 'install.ps1: статус не отдаёт путь к логу')
ok(/function Step \{[\s\S]*?\[string\]\$Hint/.test(inst), 'install.ps1: Step не принимает -Hint')
ok(inst.includes('function Start-StatusHeartbeat') && inst.includes('function Stop-StatusHeartbeat'),
  'install.ps1: нет heartbeat статуса (заставка считает долгий шаг мёртвым)')
ok(/Step 1 9/.test(inst) && /Start-StatusHeartbeat/.test(inst), 'install.ps1: heartbeat не запускается после шага 1')
const trapBlk = inst.match(/trap \{[\s\S]*?\n\}/)?.[0] ?? ''
ok(trapBlk.includes('Stop-StatusHeartbeat'), 'install.ps1: trap не глушит heartbeat (перезатрёт state=error)')
ok(trapBlk.includes('Write-SetupStatus') && /\$hint/.test(trapBlk), 'install.ps1: trap не пишет hint в статус ошибки')
const tailBlk = inst.slice(inst.lastIndexOf("# финальный статус"))
ok(tailBlk.includes('Stop-StatusHeartbeat'), 'install.ps1: heartbeat не остановлен перед финальной записью статуса')
ok(inst.includes('function Write-StatusJsonAtomic'), 'install.ps1: статус пишется неатомарно (читатель ловит полJSON)')
// (правка 942) живой прогон установки на D: выявил две ошибки heartbeat:
// файл статуса читался без -Encoding UTF8 (PS 5.1 → кракозябры), и heartbeat
// дописывал текст в detail, из-за чего тот удваивался за тик (файл 1,6 ГБ).
const hb = inst.match(/function Start-StatusHeartbeat \{[\s\S]*?\n\}/)?.[0] ?? ''
ok(hb.length > 0, 'install.ps1: нет Start-StatusHeartbeat')
ok(/ReadAllText\(\$file, \[System\.Text\.Encoding\]::UTF8\)/.test(hb), 'install.ps1: heartbeat читает статус не как UTF-8 (PS 5.1 испортит кириллицу)')
ok(!/\$j\.detail\s*=/.test(hb), 'install.ps1: heartbeat правит текстовое поле detail — так detail растёт каждый тик')
ok(/elapsed_min/.test(hb) && /elapsed_min\s*=\s*\$\(if \(\$script:StatusStartedAt\)/.test(inst), 'install.ps1: elapsed_min не пишется и в Write-SetupStatus (обнуляется между тиками heartbeat)')
ok(!/^\$script:StatusStartedAt = Get-Date\s*$/m.test(inst.slice(inst.indexOf('function Start-StatusHeartbeat') - 900, inst.indexOf('function Start-StatusHeartbeat'))), 'install.ps1: heartbeat сбрасывает StatusStartedAt (счётчик «идёт N мин» начнётся заново)')
ok(/New-Object System\.IO\.FileInfo\(\$file\)/.test(hb) && /-gt \$maxBytes/.test(hb), 'install.ps1: heartbeat не ограничивает размер файла статуса')
// (правка 942) [string]$Hint = $null в PowerShell превращается в "", и проверка
// ($null -ne $Hint) всегда истина: каждый вызов без -Hint стирал подсказку.
const wss = inst.match(/function Write-SetupStatus \{[\s\S]*?\r?\n\}/)?.[0] ?? ''
const wssParams = wss.match(/param\(([^\n]*)\)/)?.[1] ?? ''
ok(wssParams.length > 0, 'install.ps1: не найден param Write-SetupStatus')
ok(!/\[string\]\$Hint/.test(wssParams), 'install.ps1: параметр $Hint объявлен как [string] — PowerShell приведёт $null к "" и сотрёт подсказку')
ok(/(?:,\s*)\$Hint = \$null/.test(wssParams), 'install.ps1: Write-SetupStatus должен принимать $Hint без типа (маркер «не менять подсказку»)')
const scBlk = inst.match(/function Invoke-SelfCheck \{[\s\S]*?\n\}/)?.[0] ?? ''
for (const line of scBlk.split(/\r?\n/).filter((l) => /Get-Content|ReadAllText/.test(l))) {
  ok(/-Encoding UTF8|Encoding::UTF8/.test(line), `install.ps1: самодиагностика читает файл без явной UTF-8: ${line.trim()}`)
}
for (const [needle, msg] of [
  ['elapsed_min', 'install_gui.ps1: окно не показывает elapsed_min из heartbeat'],
  ['идёт ', 'install_gui.ps1: окно не показывает, сколько минут идёт установка'],
]) ok(gui.includes(needle), msg)
const statusReads = [...gui.matchAll(/^.*(?:(?:Get-Content|ReadAllText)[^\n]*\$StatusFile|(?:\$StatusFile)[^\n]*(?:Get-Content|ReadAllText)).*$/gm)].map((m) => m[0])
ok(statusReads.length > 0, 'install_gui.ps1: не найден код чтения setup_status.json — проверка кодировки не выполнена')
for (const line of statusReads) ok(/-Encoding\s+UTF8|Encoding::UTF8/.test(line), `install_gui.ps1: статус читается без явной UTF-8 кодировки: ${line.trim()}`)
// (правка 942) раздутый статус-файл не должен попадать в интерфейс: все три
// читателя (окно установки, Electron, API заставки) ограничивают размер.
ok(gui.includes('262144'), 'install_gui.ps1: нет защиты от раздутого setup_status.json')
// окно установки: причину не обрезаем, подсказку и лог показываем
ok(/'\['  \+ \$step/.test(gui) || gui.includes('$st.hint'), 'install_gui.ps1: окно установки не показывает hint из статуса')
ok(gui.includes('$st.log'), 'install_gui.ps1: окно установки не показывает путь к логу')
ok(/error[\s\S]{0,400}AutoEllipsis = \$false/.test(gui), 'install_gui.ps1: в ветке error причину по-прежнему обрезает AutoEllipsis')
ok(/function Write-StatusError\(\[string\]\$Title, \[string\]\$Hint/.test(gui), 'install_gui.ps1: Write-StatusError не пишет hint')
// заставка и Electron: hint/log доезжают до интерфейса
const splashPath = join(ROOT, 'src', 'app', 'splash', 'page.tsx')
const splash = existsSync(splashPath) ? readFileSync(splashPath, 'utf8') : ''
ok(splash.includes('hint?: string'), 'splash: интерфейс статуса не знает про hint')
ok(splash.includes('setup.hint') && splash.includes('setup.log'), 'splash: hint/log установки не выводятся')
const mainJsPath = join(ROOT, 'electron', 'main.js')
const mainJs = existsSync(mainJsPath) ? readFileSync(mainJsPath, 'utf8') : ''
ok(mainJs.includes('function writeSetupStatus(state, step, total, title, hint)'), 'electron/main.js: writeSetupStatus не принимает hint')
ok(mainJs.includes('prev.hint'), 'electron/main.js: финальный статус теряет hint установщика')
ok(mainJs.includes("log: path.join(APP_ROOT, 'install.log')"), 'electron/main.js: финальный статус не указывает путь к логу')
// (правка 942) защита от раздутого статус-файла во всех трёх читателях
ok(/262_?144/.test(mainJs), 'electron/main.js: нет проверки размера setup_status.json (раздутый файл читается в UI вечно)')
const apiRoutePath = join(ROOT, 'src', 'app', 'api', 'setup-status', 'route.ts')
const apiRoute = existsSync(apiRoutePath) ? readFileSync(apiRoutePath, 'utf8') : ''
ok(/262_?144/.test(apiRoute), 'api/setup-status: нет проверки размера setup_status.json')
ok(apiRoute.includes('elapsed_min'), 'api/setup-status: интерфейс статуса не знает про elapsed_min')
ok(gui.includes('elapsed_min = 0'), 'install_gui.ps1: Write-StatusError не пишет elapsed_min')
// (правка 941) точка входа для юзера: двойной клик = самодиагностика
const diagPath = join(ROOT, 'diagnostics.bat')
if (existsSync(diagPath)) {
  const db = readFileSync(diagPath)
  ok(db.includes('-SelfCheck') && db.includes('-Deep'), 'diagnostics.bat: должен запускать -SelfCheck -Deep')
  const nonAscii = Array.from(db).filter((x) => x > 127).length
  ok(nonAscii === 0, `diagnostics.bat: ${nonAscii} не-ASCII байт — cmd.exe портит UTF-8 в .bat`)
  let crlf = 0
  let loneLF = 0
  for (let i = 0; i < db.length; i++) {
    if (db[i] !== 0x0a) continue
    if (i > 0 && db[i - 1] === 0x0d) crlf++
    else loneLF++
  }
  ok(crlf > 0 && loneLF === 0, `diagnostics.bat: должны быть CRLF (CRLF=${crlf}, LF=${loneLF})`)
} else {
  fails.push('diagnostics.bat не найден — у пользователя нет точки входа для самодиагностики')
}

// ─── 5) кодировки ──────────────────────────────────────────────────────────
function readBytes(p) {
  return existsSync(p) ? readFileSync(p) : null
}
for (const p of ['install/install.ps1', 'install/install_gui.ps1']) {
  const b = readBytes(join(ROOT, p))
  if (!b) { fails.push(`${p}: файл не найден`); continue }
  const bom = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf
  ok(bom, `${p}: нет UTF-8 BOM — PowerShell 5.1 прочитает кириллицу как ANSI`)
}
const au = readBytes(join(ROOT, 'install', 'apply_update.ps1'))
if (au) {
  const nonAscii = Array.from(au).filter((x) => x > 127).length
  ok(nonAscii === 0, `apply_update.ps1: ${nonAscii} не-ASCII байт (апдейтер должен работать на любой кодировке консоли)`)
} else {
  fails.push('install/apply_update.ps1: файл не найден')
}
// (правка 957) makensis в Unicode-режиме читает скрипт без BOM как системный ANSI:
// UTF-8 кириллица превращается в кракозябры ещё на этапе компиляции — в готовом
// setup.exe (так вышло в 7.1.22: BOM потерялся при правке версии).
const nsi = readBytes(join(ROOT, 'install', 'installer.nsi'))
if (!nsi) {
  fails.push('install/installer.nsi: файл не найден')
} else {
  ok(nsi[0] === 0xef && nsi[1] === 0xbb && nsi[2] === 0xbf,
    'install/installer.nsi: нет UTF-8 BOM — makensis прочитает кириллицу как ANSI, в setup.exe будут кракозябры')
  ok(!nsi.toString('utf8').includes('\ufffd'), 'install/installer.nsi: содержимое не является корректным UTF-8')

  // (правка 961) Путь установки: дефолт без версии в имени (иначе после
  // обновления из программы папка продолжает называться старой версией), и
  // без хвостового "\" — иначе страница выбора папки не дописывает
  // «Minimax Studio» к выбранному пути и юзеру приходится вписывать имя сам.
  const nsiText = nsi.toString('utf8')
  const instDir = /^InstallDir\s+"([^"]*)"\s*$/m.exec(nsiText)
  if (!instDir) {
    fails.push('install/installer.nsi: не найдена строка InstallDir')
  } else {
    const val = instDir[1]
    ok(!val.endsWith('\\'), 'install/installer.nsi: InstallDir кончается "\" — страница выбора папки не допишет «Minimax Studio» к выбранному пути')
    ok(!/7\.\d/.test(val) && !val.includes('${APP_VERSION}'), `install/installer.nsi: в InstallDir зашита версия (${val}) — папка будет называться старой версией после обновления`)
  }
  ok(!/^InstallDirRegKey/m.test(nsiText),
    'install/installer.nsi: InstallDirRegKey подставит старый путь из реестра (часто с версией в имени) — путь читает .onInit')
  ok(/^Function NormalizeInstDir$/m.test(nsiText) && /Section "Программа" SecMain[\s\S]{0,600}?Call NormalizeInstDir/.test(nsiText),
    'install/installer.nsi: нет NormalizeInstDir/его вызова — путь задвоится или файлы вывалятся в корень диска')
}

// ─── 6) переносы строк во всех .ps1 ────────────────────────────────────────
// .gitattributes нормализует *.ps1 к CRLF на checkout, так что в рабочем дереве
// бывает и чистый LF — это не ошибка. Опасен только МИКС: PowerShell 5.1 на
// смешанных переносах спотыкается о многострочные строки и here-строки.
for (const e of readdirSync(join(ROOT, 'install'), { withFileTypes: true })) {
  if (!e.isFile() || !e.name.endsWith('.ps1')) continue
  const b = readFileSync(join(ROOT, 'install', e.name))
  let crlf = 0
  let loneLF = 0
  for (let i = 0; i < b.length; i++) {
    if (b[i] !== 0x0a) continue
    if (i > 0 && b[i - 1] === 0x0d) crlf++
    else loneLF++
  }
  ok(!(crlf > 0 && loneLF > 0), `install/${e.name}: смешанные переносы строк (CRLF=${crlf}, LF=${loneLF})`)
}

// ─── 7) правка 944: доводка ревью установщика ──────────────────────────────
// Обрыв закачки, HTML вместо скрипта, «папка = нода», удаление докачки в trap,
// ложный sha бандла у кэша, двойной вопрос в окне установки.
const dlBlock = inst.match(/function Get-Download \{[\s\S]*?\n\}/)?.[0] ?? ''
ok(dlBlock.includes('ExitCode'), 'Get-Download игнорирует код возврата curl (обрыв закачки уедет в кэш как готовый)')
const cccBlock = inst.match(/function Clear-CorruptCache \{[\s\S]*?\n\}/)?.[0] ?? ''
ok(cccBlock.length > 0 && !/EndsWith\('\.part'\)/.test(cccBlock), 'Clear-CorruptCache удаляет .part (теряется докачка)')
ok(/function Test-TextScript/.test(inst) && /get-pip\.py/.test(inst), 'get-pip.py не проверяется (HTML прокси остаётся в кэше навсегда)')
ok(/expectKind -eq 'pyscript'/.test(inst), 'Test-ArchiveFile не проверяет pyscript (get-pip.py)')
const trapBlock = inst.match(/trap \{[\s\S]*?\n\}/)?.[0] ?? ''
ok(/SelfCheckMode/.test(trapBlock), 'trap меняет кэш и статус в режиме -SelfCheck')
const step6Block = inst.match(/Step 6 9[\s\S]*?Step 7 9/)?.[0] ?? ''
ok(/__init__\.py/.test(step6Block), 'шаг 6 считает ноду установленной по одной папке (без __init__.py)')
ok(/-BundleSha:\$isBundle/.test(inst), '-Deep требует sha бандла у файлов кэша (ложные «битый файл»)')
ok(/Remove-StaleCacheFile \$sttArchive/.test(inst), 'битый STT-архив остаётся в кэше (голосовой ввод не починится)')
const requestCloseBlock = gui.match(/\$requestClose = \{[\s\S]*?\n\}/)?.[0] ?? ''
ok(/closing = \$true/.test(requestCloseBlock), 'окно установки спрашивает «Прервать?» дважды (флаг closing не ставится до Close)')

// ─── 8) правка 945: обрыв замены ядра и недоступная нода ────────────────────
// ComfyUI.keep после обрыва должен восстанавливаться, а не удаляться вместе с
// моделями; недоступная внешняя нода не должна ронять установку (exit 1).
ok(/function Restore-ComfyKeepData/.test(inst) && /function Move-MergeInto/.test(inst), 'нет восстановления ComfyUI.keep (модели теряются после обрыва)')
const iBackupRecovery = inst.indexOf('if (Test-Path $backup) {')
const iHasCore = inst.indexOf('$hasCore = Test-Path')
ok(iBackupRecovery > 0 && iHasCore > 0 && iBackupRecovery < iHasCore, 'восстановление ComfyUI.old/keep идёт после проверки ядра (не выполнится)')
ok(/ComfyUI\.keep\.old-/.test(inst), 'непринятые данные из ComfyUI.keep удаляются (нет переноса в сторону)')
ok(/Restore-ComfyKeepData \$stage \$comfyApp \$keep/.test(inst), 'данные из ComfyUI.keep не возвращаются в ядро')
ok(!/if \(Test-Path \$stage\) \{ Remove-Item \$stage -Recurse -Force \}/.test(inst), 'ComfyUI.keep удаляется без восстановления данных')
const iCoreMove = inst.indexOf('Move-Item $inner.FullName $comfyApp')
const iPostRestore = inst.indexOf('Restore-ComfyKeepData $stage $comfyApp $keep', iCoreMove + 1)
const iBackupCleanup = inst.indexOf('if (Test-Path $backup) { Remove-Item $backup', iCoreMove + 1)
ok(iCoreMove > 0 && iPostRestore > iCoreMove && (iBackupCleanup < 0 || iPostRestore < iBackupCleanup), 'после раскладки нового ядра данные не возвращаются из ComfyUI.keep')
ok(!/Fail \(\$node\.name/.test(inst), 'недоступная нода по-прежнему Fail (exit 1, ComfyUI не запустится)')
ok(/\$nodesFailed\+\+/.test(inst), 'нет счётчика неустановленных внешних нод')
ok(/ни одна внешняя нода не установилась/.test(inst), 'нет подсказки «проверь сеть/прокси», если не встала ни одна нода')
ok(/остатки оборванной установки ядра/.test(inst) && /ComfyUI\.keep\.old-\*/.test(inst), 'самодиагностика не видит брошенные ComfyUI.keep/ComfyUI.old')

console.log(`\nPASS=${pass} FAIL=${fails.length}`)
for (const f of fails) console.log('FAIL:', f)
process.exit(fails.length ? 1 : 0)
