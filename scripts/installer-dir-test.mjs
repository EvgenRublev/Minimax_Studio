#!/usr/bin/env node
/**
 * (правка 961) Тест логики пути установки на РЕАЛЬНОМ install/installer.nsi.
 *
 * Зачем: страница выбора папки дописывает «Minimax Studio» к выбранному пути,
 * а NormalizeInstDir должен убирать задвоение и не пускать установку в корень
 * диска. Это уже ломалось дважды (правки 833 и 961), поэтому проверяем не
 * копию логики, а сам файл: из него вырезаются разделы распаковки/ярлыков/
 * реестра, в Section «Программа» подставляется тестовый $INSTDIR, и результат
 * нормализации пишется в файл.
 *
 * Запуск: node scripts/installer-dir-test.mjs
 * Требует makensis (NSIS 3.x); без него — SKIP (код 0).
 */
import { execFileSync } from 'node:child_process'
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

// Шаблон: в Section «Программа» подставляем путь и пишем результат
// нормализации. Маркер @@PATH@@ заменяется на конкретный кейс.
const template = keep
  .join('\n')
  .replace(/OutFile "[^"]*"/, 'OutFile "dir-test.exe"')
  // путь из реестра не должен влиять на тест: .onInit подставляет InstallDir
  // из HKCU, поэтому чтение отключаем
  .replace(/^\s*ReadRegStr \$R0 HKCU .*$/m, '  StrCpy $R0 ""')
  .replace(
    /(Section "Программа" SecMain[\s\S]*?)Call NormalizeInstDir\s*\r?\n/,
    '$1StrCpy $INSTDIR "@@PATH@@"\n  Call NormalizeInstDir\n' +
      '  FileOpen $9 "$TEMP\\\\instdir-probe.txt" w\n  FileWrite $9 "$INSTDIR"\n  FileClose $9\n'
  )

const dir = mkdtempSync(join(tmpdir(), 'instdir-'))
const nsi = join(dir, 'dir-test.nsi')
const exe = join(dir, 'dir-test.exe')
const probe = join(tmpdir(), 'instdir-probe.txt')

const base = join(tmpdir(), 'instdir-cases')
const cases = [
  // [что в поле пути, ожидаемый $INSTDIR]
  [`${base}\\`, base, 'хвостовой "\\" срезается'],
  [base, base, 'обычный путь не меняется'],
  [`${base}\\Minimax Studio\\Minimax Studio`, `${base}\\Minimax Studio`, 'задвоение от страницы выбора папки'],
  [`${base}\\Minimax Studio\\`, `${base}\\Minimax Studio`, 'задвоение + хвостовой "\\"'],
  ['C:\\', 'C:\\Minimax Studio', 'корень диска не принимаем'],
]

let pass = 0
const fails = []
for (const [input, expected, title] of cases) {
  // BOM обязателен: без него makensis читает файл как ANSI, и русский текст в
  // собранном установщике превращается в кракозябры (правка 957).
  writeFileSync(nsi, '\ufeff' + template.replace('@@PATH@@', input), 'utf8')
  try {
    execFileSync(MAKENSIS, ['/V1', nsi], { cwd: dir, stdio: 'pipe' })
  } catch (e) {
    console.error('FAIL: makensis не собрал тестовый установщик для пути ' + input)
    console.error(String(e.stdout || '').slice(-800), String(e.stderr || '').slice(-800))
    process.exit(1)
  }
  if (existsSync(probe)) rmSync(probe)
  try {
    execFileSync(exe, ['/S'], { stdio: 'pipe', timeout: 60000 })
  } catch {
    /* инсталлятор может вернуть ненулевой код — важен записанный путь */
  }
  const got = existsSync(probe) ? readFileSync(probe, 'utf8').replace(/\uFEFF/, '').trim() : '(файл не записан)'
  if (got === expected) {
    pass++
    console.log(`  ok   ${title}: ${input} -> ${got}`)
  } else {
    fails.push(`${title}: ${input} -> ожидалось "${expected}", получено "${got}"`)
    console.log(`  FAIL ${title}: ${input} -> ${got} (ожидалось "${expected}")`)
  }
}

rmSync(dir, { recursive: true, force: true })
if (existsSync(probe)) rmSync(probe)

for (const f of fails) console.error('FAIL ' + f)
console.log(`PASS=${pass} FAIL=${fails.length}`)
process.exit(fails.length ? 1 : 0)
