// Проверка инварианта «ноды ComfyUI доезжают до пользователя».
//
// Внутрипрограммный апдейт (install/apply_update.ps1) заменяет только файлы
// студии и НЕ трогает ComfyUI. Поэтому install/comfy-patches и custom nodes
// должны синхронизироваться при каждом запуске ComfyUI. Если эту связку
// случайно уберут из electron/main.js или start.bat, у обновившихся
// пользователей снова начнутся HTTP 400 missing_node_type / IndexError.
//
// Скрипт запускается из scripts/release.mjs на шаге verify и валит релиз,
// если связка нарушена. Ничего не пишет, только читает файлы.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(process.cwd())
const problems = []
const ok = []

function read(rel) {
  const p = join(ROOT, rel)
  if (!existsSync(p)) {
    problems.push(`нет файла ${rel}`)
    return ''
  }
  return readFileSync(p, 'utf-8')
}

function expect(cond, label) {
  if (cond) ok.push(label)
  else problems.push(label)
}

// 1. Синхронизатор умеет и custom nodes, и патчи ядра.
const sync = read('scripts/sync_custom_nodes.js')
expect(/function\s+syncStudioNodes\s*\(/.test(sync), 'sync_custom_nodes.js: есть syncStudioNodes()')
expect(/function\s+syncCorePatches\s*\(/.test(sync), 'sync_custom_nodes.js: есть syncCorePatches()')
expect(/install['"],\s*['"]comfy-patches/.test(sync), 'sync_custom_nodes.js: патчи берутся из install/comfy-patches')
expect(/['"]custom nodes['"]/.test(sync), 'sync_custom_nodes.js: custom nodes берутся из папки «custom nodes»')
expect(/module\.exports\s*=\s*\{[^}]*syncStudioNodes[^}]*syncCorePatches/.test(sync),
  'sync_custom_nodes.js: экспортирует обе функции')

// 2. Electron вызывает синхронизацию ДО старта Python.
const main = read('electron/main.js')
expect(/require\(['"]\.\.\/scripts\/sync_custom_nodes['"]\)/.test(main), 'electron/main.js: импортирует sync_custom_nodes')
expect(/syncStudioNodes\s*\(\s*APP_ROOT\s*,\s*COMFY_ROOT\s*\)/.test(main), 'electron/main.js: вызывает syncStudioNodes(APP_ROOT, COMFY_ROOT)')
expect(/syncCorePatches\s*\(\s*APP_ROOT\s*,\s*COMFY_ROOT\s*\)/.test(main), 'electron/main.js: вызывает syncCorePatches(APP_ROOT, COMFY_ROOT)')
expect(/function\s+startComfy\s*\(/.test(main), 'electron/main.js: есть startComfy()')
if (/function\s+startComfy\s*\(/.test(main)) {
  const start = main.indexOf('function startComfy(')
  const body = main.slice(start, start + 6000)
  expect(body.includes('syncStudioNodes(APP_ROOT, COMFY_ROOT)'), 'electron/main.js: syncStudioNodes вызывается внутри startComfy')
  expect(body.includes('syncCorePatches(APP_ROOT, COMFY_ROOT)'), 'electron/main.js: syncCorePatches вызывается внутри startComfy')
}

// 3. CLI-запуск (start.bat) тоже синхронизирует.
const bat = read('start.bat')
expect(/scripts\\sync_custom_nodes\.js/.test(bat), 'start.bat: вызывает scripts\\sync_custom_nodes.js')

// 4. В бандле custom nodes каждая папка — валидный python-пакет.
const cnDir = join(ROOT, 'custom nodes')
expect(existsSync(cnDir), 'есть папка «custom nodes»')
if (existsSync(cnDir)) {
  const dirs = readdirSync(cnDir).filter((n) => statSync(join(cnDir, n)).isDirectory())
  expect(dirs.length > 0, 'в «custom nodes» есть хотя бы одна нода')
  for (const d of dirs) {
    expect(existsSync(join(cnDir, d, '__init__.py')), `нода ${d}: есть __init__.py`)
  }
}

// 5. Патчи ядра на месте (файл с MiniMaxH3AddGuide — ключевой для аудио-гайда).
const patchDir = join(ROOT, 'install', 'comfy-patches')
expect(existsSync(patchDir), 'есть папка install/comfy-patches')
const nodePatch = join(patchDir, 'comfy_extras', 'nodes_minimax_h3.py')
expect(existsSync(nodePatch), 'патч comfy_extras/nodes_minimax_h3.py на месте')
if (existsSync(nodePatch)) {
  const py = readFileSync(nodePatch, 'utf-8')
  expect(/node_id\s*=\s*["']MiniMaxH3AddGuide["']/.test(py), 'патч содержит MiniMaxH3AddGuide')
  expect(/io\.Latent\.Output\(display_name=["']latent["']\)/.test(py),
    'MiniMaxH3AddGuide отдаёт выход latent (иначе аудио-гайд падает на av_latent)')
}

if (problems.length) {
  console.error('\n[comfy-sync] ПРОВАЛ — связка обновления нод нарушена:')
  for (const p of problems) console.error('  FAIL  ' + p)
  console.error('\nПравило: любое изменение custom nodes или install/comfy-patches обязано')
  console.error('доезжать до ComfyUI при запуске (электрон и start.bat). Подробности —')
  console.error('в AGENTS.md, раздел «Обновления и ноды ComfyUI».')
  process.exit(1)
}

console.log(`[comfy-sync] OK — проверено ${ok.length} пунктов связки нод и патчей.`)
