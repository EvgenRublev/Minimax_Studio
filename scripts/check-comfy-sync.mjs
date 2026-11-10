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

// 6. (правка 904) Ядро 0.44: core-патчи не нужны, ядро пиновано, ноды полные.
const legacyCore = [
  'comfy/ldm/minimax/model.py',
  'comfy/model_detection.py',
]
for (const rel of legacyCore) {
  expect(!existsSync(join(patchDir, rel)),
    `ядро 0.44: нет устаревшего патча ${rel} (в 0.44 он уже в upstream)`)
}
expect(/function\s+readComfyVersion\s*\(/.test(sync),
  'sync_custom_nodes.js: читает версию ядра (readComfyVersion)')
expect(/CORE_MIN_VERSION\s*=\s*['"]0\.44\.0['"]/.test(sync),
  'sync_custom_nodes.js: патчи применяются только к ядру 0.44+')

const installPs1 = read('install/install.ps1')
expect(/\$ComfyVersion\s*=\s*['"]0\.44\.0['"]/.test(installPs1),
  'install.ps1: ядро пиновано на 0.44.0')
expect(/v0\.44\.0\.zip/.test(installPs1), 'install.ps1: качает тег v0.44.0')
expect(/function\s+Get-ComfyCoreVersion\s*[({]/.test(installPs1),
  'install.ps1: умеет определять установленную версию ядра')
expect(/ComfyUI\.old/.test(installPs1),
  'install.ps1: при смене ядра сохраняет данные пользователя (ComfyUI.old)')

const lock = read('install/requirements.lock.txt')
expect(/^comfy-aimdo==0\.6\.0$/m.test(lock), 'requirements.lock.txt: comfy-aimdo 0.6.0')
expect(/^comfy-kitchen==0\.2\.40$/m.test(lock), 'requirements.lock.txt: comfy-kitchen 0.2.40')
expect(/^comfyui_frontend_package==1\.57\.6$/m.test(lock), 'requirements.lock.txt: фронтенд 1.57.6')
expect(/^comfyui_workflow_templates==0\.11\.101$/m.test(lock), 'requirements.lock.txt: шаблоны 0.11.101')

if (existsSync(nodePatch)) {
  const py = readFileSync(nodePatch, 'utf-8')
  expect(/node_id\s*=\s*["']MiniMaxH3AudioOrSilent["']/.test(py),
    'патч содержит MiniMaxH3AudioOrSilent (рефайн/продление на видео без звука)')
  expect(/node_id\s*=\s*["']MiniMaxH3AudioSliceFrom["']/.test(py),
    'патч содержит MiniMaxH3AudioSliceFrom (хвост аудио для продления)')
  expect(/_install_h3_flf_fix/.test(py), 'патч содержит flf-фикс (два прохода, правка 149)')
  expect(/_resize\(first_frame\[:1\],\s*width,\s*height,\s*"center"\)/.test(py),
    'first_frame ресайзится через center (без растяжения, правка 154)')
}

// 7. (правка 905) Плоская раскладка бэкенда: папка ComfyUI, ядро = корень.
expect(/function\s+resolveComfyCore\s*\(/.test(sync),
  'sync_custom_nodes.js: есть resolveComfyCore() (каталог ядра)')
expect(/resolveComfyCore\(comfyRoot\)/.test(sync),
  'sync_custom_nodes.js: ноды и патчи пишутся в каталог ядра, а не в <root>\\ComfyUI')
expect(/main\.py/.test(main) && /resolveComfyCore\(COMFY_ROOT\)/.test(main),
  'electron/main.js: main.py ищется через resolveComfyCore')
const appCfg = read('src/lib/app-config.ts')
expect(/export function resolveComfyCore\s*\(/.test(appCfg),
  'app-config.ts: есть resolveComfyCore()')
expect(/comfyCore,\s*\n/.test(appCfg) && /join\(comfyCore, 'output'\)/.test(appCfg),
  'app-config.ts: output/input строятся от comfyCore')
// нигде в коде не должно остаться жёсткого <comfyRoot>\ComfyUI\...
const srcFiles = ['src/lib', 'src/app', 'electron', 'scripts']
let scanned = 0
for (const dir of srcFiles) {
  const abs = join(ROOT, dir)
  if (!existsSync(abs)) continue
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(ts|tsx|js|mjs)$/.test(e.name)) {
        scanned++
        const txt = readFileSync(p, 'utf-8')
        if (/(?:cfg|config)\.comfyRoot,\s*['"]ComfyUI['"]/.test(txt)) problems.push(`${dir}: путь зашит как cfg.comfyRoot + 'ComfyUI' — нужен cfg.comfyCore (${e.name})`)
      }
    }
  }
  walk(abs)
}
expect(scanned > 0, `путь к ядрам не зашит как comfyRoot/ComfyUI (просмотрено ${scanned} файлов)`)
expect(/\$comfyRootNew = Join-Path \$Root 'ComfyUI'/.test(installPs1),
  'install.ps1: новая папка бэкенда называется ComfyUI')
expect(/ComfyUI-Easy-Install/.test(installPs1),
  'install.ps1: старая папка ComfyUI-Easy-Install по-прежнему распознаётся')
expect(/if \(\$flat\) \{ \$keep \+= 'python_embeded' \}/.test(installPs1),
  'install.ps1: при смене ядра python_embeded сохраняется')
expect(/coreRel = if \(\$flat\) \{ '\.\.' \}/.test(installPs1),
  'install.ps1: python312._pth настраивается под раскладку (.. или ..\\ComfyUI)')
expect(/set "COMFY_CORE=/.test(bat) && /"%COMFY_CORE%\\main\.py"/.test(bat),
  'start.bat: ядро ищется через COMFY_CORE и запускается %COMFY_CORE%\\main.py')
const startComfyBat = read('scripts/start_comfy.bat')
expect(/"%COMFY_CORE%\\main\.py"/.test(startComfyBat),
  'scripts/start_comfy.bat: запускает %COMFY_CORE%\\main.py')
expect(/^COMFY_ROOT=\.\/ComfyUI$/m.test(read('.env')),
  '.env: COMFY_ROOT=./ComfyUI')

// 9. (правка 911) Минимальная версия ядра — ОДНА на синхронизатор и на UI.
//    Синхронизатор по ней решает, класть ли патчи, а баннер — предупреждать
//    пользователя. Разъедутся — баннер будет молчать там, где патчи уже не
//    кладутся (или наоборот). Ловим это на verify релиза.
{
  const coreTs = read('src/lib/comfy/core-version.ts')
  const mTs = /CORE_MIN_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(coreTs)
  const mJs = /CORE_MIN_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(sync)
  expect(!!mTs, 'core-version.ts: объявлен CORE_MIN_VERSION')
  expect(!!mJs, 'sync_custom_nodes.js: объявлен CORE_MIN_VERSION')
  expect(!!mTs && !!mJs && mTs[1] === mJs[1],
    `CORE_MIN_VERSION совпадает в core-version.ts и sync_custom_nodes.js (${mTs?.[1] ?? '?'} / ${mJs?.[1] ?? '?'})`)
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
