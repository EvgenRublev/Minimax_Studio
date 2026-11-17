#!/usr/bin/env node
/**
 * (правка 1042) Сборка ПОЛНОГО setup.exe.
 *
 * Делает payload заново из git HEAD и ОБЯЗАТЕЛЬНО добавляет:
 *   - install/cache/  — офлайн-архивы зависимостей;
 *   - upscale/bin/    — вендорный runtime, включая DLSS.
 *
 * После сборки проверяет, что ключевые DLSS-файлы есть и в payload, и
 * (если найден 7z) в самом setup.exe. Это правило, а не ручная памятка:
 * без DLSS полный релиз собирать нельзя.
 *
 * Запуск:
 *   node scripts/build-setup.mjs
 *   node scripts/build-setup.mjs --verify-only  — не собирать, только проверить
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { checkDlssRuntime, REQUIRED_DLSS_RUNTIME } from './dlss-runtime.mjs'

const ROOT = resolve(process.cwd())
const BUILD = join(ROOT, '.setup-build')
const SRC = join(BUILD, 'src')
const TMP = join(BUILD, 'tmp')
const VERIFY_ONLY = process.argv.includes('--verify-only')

function fail(msg) {
  console.error(`[setup] ОШИБКА: ${msg}`)
  process.exit(1)
}

function run(label, cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts })
  if (r.error) fail(`${label}: ${r.error.message}`)
  if (r.status !== 0) fail(`${label}: exit ${r.status}`)
}

function findTool(envName, candidates) {
  const fromEnv = process.env[envName]
  if (fromEnv && existsSync(fromEnv)) return fromEnv
  for (const p of candidates) if (existsSync(p)) return p
  return null
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const version = String(pkg.version)
const nsiSrc = join(ROOT, 'install', 'installer.nsi')
const nsiText = readFileSync(nsiSrc, 'utf8')
if (!nsiText.includes(`!define APP_VERSION "${version}"`)) {
  fail(`install/installer.nsi: APP_VERSION != package.json (${version})`)
}
if (!nsiText.includes(`!define APP_VERSION4 "${version}.0"`)) {
  fail(`install/installer.nsi: APP_VERSION4 != ${version}.0`)
}
const outMatch = /^OutFile\s+"([^"]+)"/m.exec(nsiText)
if (!outMatch) fail('install/installer.nsi: нет OutFile')
const outName = outMatch[1]
if (!outName.includes(version)) fail(`install/installer.nsi: имя setup.exe не содержит ${version}`)

const setupPath = join(BUILD, outName)

if (!VERIFY_ONLY) {
  if (!existsSync(join(ROOT, 'install', 'cache'))) fail('нет install/cache (офлайн-архивы)')
  if (!existsSync(join(ROOT, 'upscale', 'bin'))) fail('нет upscale/bin (runtime/DLSS)')

  rmSync(BUILD, { recursive: true, force: true })
  mkdirSync(SRC, { recursive: true })
  mkdirSync(TMP, { recursive: true })

  const tree = join(BUILD, 'tree.tar')
  run('git archive', 'git', ['archive', '--format=tar', '-o', tree, 'HEAD'])
  const tar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
  run('extract tree', tar, ['-xf', tree, '-C', SRC])
  rmSync(tree, { force: true })

  console.log('[setup] копирую install/cache...')
  cpSync(join(ROOT, 'install', 'cache'), join(SRC, 'install', 'cache'), { recursive: true })
  console.log('[setup] копирую upscale/bin (DLSS runtime)...')
  cpSync(join(ROOT, 'upscale', 'bin'), join(SRC, 'upscale', 'bin'), { recursive: true })
  if (existsSync(join(ROOT, '.env'))) cpSync(join(ROOT, '.env'), join(SRC, '.env'))
  cpSync(nsiSrc, join(BUILD, 'installer.nsi'))

  const missing = checkDlssRuntime(SRC)
  if (missing.length) fail(`в payload нет DLSS-файлов: ${missing.join(', ')}`)
  console.log(`[setup] payload готов: ${(dirSize(SRC) / 1024 / 1024 / 1024).toFixed(2)} ГБ`)
}

const makensis = findTool('MAKENSIS', [
  'C:\\Program Files (x86)\\NSIS\\makensis.exe',
  'C:\\Program Files\\NSIS\\makensis.exe',
])
if (!makensis) fail('не найден makensis.exe (установите NSIS 3)')

if (!VERIFY_ONLY) {
  // makensis может писать временные файлы в TMP/TEMP; держим их рядом с payload.
  mkdirSync(TMP, { recursive: true })
  const env = { ...process.env, TMP, TEMP: TMP }
  console.log('[setup] запускаю makensis...')
  const r = spawnSync(makensis, [join(BUILD, 'installer.nsi')], { cwd: BUILD, env, stdio: 'inherit' })
  if (r.error) fail(`makensis: ${r.error.message}`)
  if (r.status !== 0) fail(`makensis: exit ${r.status}`)
}

if (!existsSync(setupPath)) fail(`нет результата ${setupPath}`)
const sizeMb = statSync(setupPath).size / 1024 / 1024
console.log(`[setup] OK: ${setupPath} (${sizeMb.toFixed(1)} МБ), версия ${version}`)

// Проверяем, что DLSS реально попал в NSIS-архив, а не остался только в payload.
const seven = findTool('SEVEN_ZIP', [
  'C:\\Program Files\\7-Zip\\7z.exe',
  'C:\\Program Files (x86)\\7-Zip\\7z.exe',
])
if (seven) {
  // Листинг NSIS-архива большой (тысячи файлов) — дефолтный maxBuffer
  // Node (~1 МБ) даёт ENOBUFS и ложное «7z не открыл setup».
  const list = spawnSync(seven, ['l', setupPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (list.error || list.status !== 0) {
    fail(`7z не смог открыть ${setupPath}: ${list.error?.message || `exit ${list.status}`}`)
  }
  const listing = String(list.stdout || '').replace(/\//g, '\\')
  const missing = REQUIRED_DLSS_RUNTIME.filter((rel) => !listing.includes(rel.replace(/\//g, '\\')))
  if (missing.length) fail(`в setup.exe нет DLSS-файлов: ${missing.join(', ')}`)
  console.log(`[setup] DLSS в setup.exe проверен: ${REQUIRED_DLSS_RUNTIME.length} ключевых файлов.`)
} else {
  console.warn('[setup] ВНИМАНИЕ: 7z не найден — проверены только payload и makensis. Для релиза установите 7-Zip.')
}

function dirSize(dir) {
  let total = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    total += e.isDirectory() ? dirSize(p) : statSync(p).size
  }
  return total
}
