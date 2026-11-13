#!/usr/bin/env node
/**
 * (правка 961) Тест логики пути установки на РЕАЛЬНОМ install/installer.nsi.
 *
 * Зачем: страница выбора папки дописывает «Minimax Studio» к выбранному пути,
 * NormalizeInstDir убирает задвоение и не пускает установку в корень диска, а
 * путь из реестра с версией в имени игнорируется. Всё это уже ломалось
 * (правки 833 и 961), поэтому проверяем не копию логики, а сам файл: из него
 * вырезаются разделы распаковки/ярлыков/реестра, в Section «Программа»
 * подставляется тестовый $INSTDIR, результат пишется в файл.
 *
 * Запуск: node scripts/installer-dir-test.mjs
 * Требует makensis (NSIS 3.x); без него — SKIP (код 0).
 * Тест записи в реестр восстанавливает прежнее значение HKCU в finally.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MAKENSIS = ['C:\\Program Files (x86)\\NSIS\\makensis.exe', 'C:\\Program Files\\NSIS\\makensis.exe'].find((p) => existsSync(p))
if (!MAKENSIS) {
  console.log('SKIP: makensis не найден, тест пути установки пропущен')
  process.exit(0)
}

const ROOT = process.cwd()
const src = readFileSync(join(ROOT, 'install', 'installer.nsi'), 'utf8').replace(/^\uFEFF/, '')

// Вырезаем всё, что при выполнении трогает систему: файлы, ярлыки, реестр,
// деинсталлятор, SetOutPath (создаёт папки). Остаётся только работа с $INSTDIR.
const lines = src.split(/\r?\n/)
const keep = []
let skipping = false
let continuation = false
for (const line of lines) {
  // продолжение вырезанной строки (NSIS: строка кончается на "\")
  if (continuation) {
    if (!line.trimEnd().endsWith('\\')) continuation = false
    continue
  }
  if (/^Section .Uninstall/.test(line)) { skipping = true; continue }
  if (skipping) { if (/^SectionEnd/.test(line)) skipping = false; continue }
  if (/^\s*(File \/r|SetOutPath|CreateDirectory|CreateShortCut|WriteRegStr|WriteUninstaller)\b/.test(line)) {
    if (line.trimEnd().endsWith('\\')) continuation = true
    continue
  }
  // иконка берётся из payload-раскладки (src\electron\...), в репозитории её
  // нет — для проверки пути она не нужна
  if (/^!define MUI_ICON\b/.test(line)) continue
  keep.push(line)
}

const base = keep.join('\n').replace(/OutFile "[^"]*"/, 'OutFile "dir-test.exe"')
const PROBE = '  FileOpen $9 "$TEMP\\\\instdir-probe.txt" w\n  FileWrite $9 "$INSTDIR"\n  FileClose $9\n'
const SEC_MAIN = /(Section "Программа" SecMain[\s\S]*?)Call NormalizeInstDir\s*\r?\n/

// Шаблон 1: путь задаётся тестом, пишем результат ПОСЛЕ NormalizeInstDir.
// Чтение реестра отключаем — иначе .onInit перебьёт тестовый путь.
const templatePath = base
  .replace(/^\s*ReadRegStr \$R0 HKCU .*$/m, '  StrCpy $R0 ""')
  .replace(SEC_MAIN, '$1StrCpy $INSTDIR "@@PATH@@"\n  Call NormalizeInstDir\n' + PROBE)

// Шаблон 2: реестр настоящий, пишем $INSTDIR ДО нормализации — так видно, что
// именно подставил .onInit (страховка от «версия в имени папки»).
const templateReg = base.replace(SEC_MAIN, '$1' + PROBE + '  Call NormalizeInstDir\n')

const dir = mkdtempSync(join(tmpdir(), 'instdir-'))
const nsi = join(dir, 'dir-test.nsi')
const exe = join(dir, 'dir-test.exe')
const probe = join(tmpdir(), 'instdir-probe.txt')

function buildAndRun(template, input) {
  // BOM обязателен: без него makensis читает файл как ANSI, и русский текст в
  // собранном установщике превращается в кракозябры (правка 957).
  writeFileSync(nsi, '\ufeff' + template.replace('@@PATH@@', input), 'utf8')
  try {
    execFileSync(MAKENSIS, ['/V1', nsi], { cwd: dir, stdio: 'pipe' })
  } catch (e) {
    console.error('FAIL: makensis не собрал тестовый установщик (путь: ' + input + ')')
    console.error(String(e.stdout || '').slice(-800), String(e.stderr || '').slice(-800))
    process.exit(1)
  }
  if (existsSync(probe)) rmSync(probe)
  try {
    execFileSync(exe, ['/S'], { stdio: 'pipe', timeout: 60000 })
  } catch {
    /* инсталлятор может вернуть ненулевой код — важен записанный путь */
  }
  return existsSync(probe) ? readFileSync(probe, 'utf8').replace(/\uFEFF/, '').trim() : '(файл не записан)'
}

let pass = 0
const fails = []
function check(title, input, expected, template = templatePath) {
  const got = buildAndRun(template, input)
  if (got === expected) {
    pass++
    console.log(`  ok   ${title}: ${input || '(пусто)'} -> ${got}`)
  } else {
    fails.push(`${title}: ожидалось "${expected}", получено "${got}"`)
    console.log(`  FAIL ${title}: ${input || '(пусто)'} -> ${got} (ожидалось "${expected}")`)
  }
}

const cases = join(tmpdir(), 'instdir-cases')
check('хвостовой "\\" срезается', `${cases}\\`, cases)
check('обычный путь не меняется', cases, cases)
check('задвоение от страницы выбора папки', `${cases}\\Minimax Studio\\Minimax Studio`, `${cases}\\Minimax Studio`)
check('задвоение + хвостовой "\\"', `${cases}\\Minimax Studio\\`, `${cases}\\Minimax Studio`)
check('корень диска не принимаем', 'C:\\', 'C:\\Minimax Studio')

// ─── реестр: путь с версией в имени игнорируется ────────────────────────────
const REG_KEY = 'HKCU\\Software\\MiniMaxH3Studio'
const defaultDir = join(process.env.USERPROFILE || 'C:\\Users\\PC', 'Minimax Studio')

function regQuery() {
  const r = spawnSync('reg.exe', ['query', REG_KEY, '/v', 'InstallDir'], { encoding: 'utf8' })
  if (r.status !== 0) return null
  const m = /InstallDir\s+REG_SZ\s+(.*)/.exec(r.stdout || '')
  return m ? m[1].trim() : null
}
function regSet(value) {
  spawnSync('reg.exe', ['add', REG_KEY, '/v', 'InstallDir', '/t', 'REG_SZ', '/d', value, '/f'], { encoding: 'utf8' })
}
function regRestore(prev) {
  if (prev === null) spawnSync('reg.exe', ['delete', REG_KEY, '/v', 'InstallDir', '/f'], { encoding: 'utf8' })
  else regSet(prev)
}

const prevDir = regQuery()
try {
  regSet('C:\\Old\\Minimax_Studio_7.1')
  check('путь с версией из реестра игнорируется', '', defaultDir, templateReg)
  regSet('C:\\Old\\MiniMax H3 Studio 7')
  check('старый путь "… Studio 7" игнорируется', '', defaultDir, templateReg)
  regSet('D:\\MyApps\\Studio')
  check('нормальный путь из реестра используется', '', 'D:\\MyApps\\Studio', templateReg)
} finally {
  regRestore(prevDir)
}

rmSync(dir, { recursive: true, force: true })
if (existsSync(probe)) rmSync(probe)

for (const f of fails) console.error('FAIL ' + f)
console.log(`PASS=${pass} FAIL=${fails.length}`)
process.exit(fails.length ? 1 : 0)
