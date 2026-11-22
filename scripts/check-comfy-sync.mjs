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
expect(/join\(\s*appRoot,\s*'install',\s*set\.dir\s*\)/.test(sync) && /dir:\s*'comfy-patches'/.test(sync),
  "sync_custom_nodes.js: патчи берутся из install/comfy-patches (через CORE_PATCH_SETS)")
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
  // (правка 1013) Патч FaceRefine: точка и identity_reference должны работать
  // вместе. Проверяем, что бандл не откатился на upstream-версию без патча.
  const faceNode = join(cnDir, 'ComfyUI-H3-FaceRefine', 'nodes.py')
  if (existsSync(faceNode)) {
    const faceSrc = readFileSync(faceNode, 'utf8')
    expect(faceSrc.includes('point_seg') && faceSrc.includes('point_here'),
      'FaceRefine: точка + референс совмещены (патч 1013)')
  }
}

// 4b. (правка 924) Frame-Interpolation не импортируется без config.yaml:
//    ComfyUI отвечает HTTP 400 missing_node_type, и вкладка «FPS» мертва.
//    Файл обязан быть в бандле, а синхронизатор - восстанавливать его, не
//    затирая пользовательскую копию.
{
  const fiDir = join(cnDir, 'ComfyUI-Frame-Interpolation')
  const fiConfig = join(fiDir, 'config.yaml')
  expect(existsSync(fiConfig), 'нода ComfyUI-Frame-Interpolation: config.yaml есть в бандле')
  if (existsSync(fiConfig)) {
    const yml = readFileSync(fiConfig, 'utf-8')
    expect(/^ckpts_path:/m.test(yml), 'Frame-Interpolation config.yaml: задан ckpts_path')
    expect(/^ops_backend:/m.test(yml), 'Frame-Interpolation config.yaml: задан ops_backend')
  }
  expect(/SEED_ONLY/.test(sync) && /ComfyUI-Frame-Interpolation\/config\.yaml/.test(sync),
    'sync_custom_nodes.js: config.yaml кладётся только если его нет (SEED_ONLY)')
  const vfiUtils = read('custom nodes/ComfyUI-Frame-Interpolation/vfi_utils.py')
  expect(/DEFAULT_CONFIG\s*=/.test(vfiUtils) && !/raise Exception\(["']config\.yaml/.test(vfiUtils),
    'vfi_utils.py: без config.yaml не падает, а создаёт файл с дефолтами')
}

// 5. Патчи ядра на месте (файл с MiniMaxH3AddGuide — ключевой для аудио-гайда).
const patchDir = join(ROOT, 'install', 'comfy-patches')
expect(existsSync(patchDir), 'есть папка install/comfy-patches')
const nodePatch = join(patchDir, 'comfy_extras', 'nodes_minimax_h3.py')
expect(existsSync(nodePatch), 'патч comfy_extras/nodes_minimax_h3.py на месте')
// (правка 967) без патча main.py ползунок «Запас свободной VRAM» мёртв:
// ядро 0.44 парсит --vram-headroom, но в comfy-aimdo передаёт только reserve.
const mainPatch = join(patchDir, 'main.py')
expect(existsSync(mainPatch), 'патч main.py (vram-headroom) на месте')
if (existsSync(mainPatch)) {
  const py = readFileSync(mainPatch, 'utf-8')
  expect(/vram_headroom/.test(py) && /_keep_free_gb/.test(py),
    'main.py передаёт reserve+headroom в comfy-aimdo')
}
if (existsSync(nodePatch)) {
  const py = readFileSync(nodePatch, 'utf-8')
  expect(/node_id\s*=\s*["']MiniMaxH3AddGuide["']/.test(py), 'патч содержит MiniMaxH3AddGuide')
  expect(/io\.Latent\.Output\(display_name=["']latent["']\)/.test(py),
    'MiniMaxH3AddGuide отдаёт выход latent (иначе аудио-гайд падает на av_latent)')
}

// 6. (правки 904, 951) Ядро 0.44 пиновано. Режим «Изображение» удалён вместе с
//    его патчами ядра — в патчах снова не должно быть подмены comfy/*.py.
const legacyCore = [
  'comfy/ldm/minimax/model.py',
  'comfy/ldm/minimax/vae.py',
  'comfy/model_base.py',
  'comfy/model_detection.py',
  'comfy/supported_models.py',
  'comfy/sd.py',
]
for (const rel of legacyCore) {
  expect(!existsSync(join(patchDir, rel)),
    `ядро 0.44: нет патча ${rel} (образ «Изображение» удалён — правка 951)`)
}
expect(/function\s+readComfyVersion\s*\(/.test(sync),
  'sync_custom_nodes.js: читает версию ядра (readComfyVersion)')

// (правка 1080) Студия поддерживает два поколения ядра, и у каждого свой набор
// патчей. Класс ошибок 866/901: апдейтер ComfyUI не трогает, поэтому оба набора
// обязаны лежать в поставке и выбираться по версии ядра.
expect(/const CORE_PATCH_SETS = \[/.test(sync),
  'sync_custom_nodes.js: есть таблица CORE_PATCH_SETS (наборы патчей по версиям)')
expect(/function\s+pickCorePatchSet\s*\(/.test(sync),
  'sync_custom_nodes.js: есть pickCorePatchSet()')
{
  const sets = [
    ['install/comfy-patches', 'ядро 0.44+'],
    ['install/comfy-patches-0.33', 'откатное ядро 0.33.x'],
  ]
  for (const [dir, label] of sets) {
    const d = join(ROOT, ...dir.split('/'))
    expect(existsSync(d), `${label}: набор ${dir} на месте`)
  }
  const rb = join(ROOT, 'install', 'comfy-patches-0.33')
  if (existsSync(rb)) {
    for (const rel of ['main.py', 'comfy/audio.py', 'comfy/model_prefetch.py',
      'comfy_extras/nodes_minimax_h3.py', 'comfy_extras/nodes_context_windows.py']) {
      expect(existsSync(join(rb, ...rel.split('/'))),
        `набор comfy-patches-0.33: нет ${rel} (без него патч-ноды H3 на 0.33 не импортируются)`)
    }
    const mp = readFileSync(join(rb, 'comfy', 'model_prefetch.py'), 'utf-8')
    expect(/def pause_malloc_graph/.test(mp),
      'comfy-patches-0.33: model_prefetch.py содержит shim pause_malloc_graph')
    const main033 = readFileSync(join(rb, 'main.py'), 'utf-8')
    expect(/_keep_free_gb = _reserve_gb \+ _headroom_gb/.test(main033),
      'comfy-patches-0.33: main.py несёт патч 967 (headroom применяется)',)
  }
}
// версия из core-version.ts (баннер) обязана совпадать с таблицей наборов
{
  const mRollback = /CORE_ROLLBACK_MIN\s*=\s*['"]([^'"]+)['"]/.exec(read('src/lib/comfy/core-version.ts') || '')
  const mCur = /CORE_CURRENT_MIN\s*=\s*['"]([^'"]+)['"]/.exec(read('src/lib/comfy/core-version.ts') || '')
  expect(!!mRollback && !!mCur, 'core-version.ts: есть CORE_ROLLBACK_MIN и CORE_CURRENT_MIN')
  const syncSrc = sync
  const setRollback = /dir:\s*'comfy-patches-0\.33',\s*min:\s*'([\d.]+)'/.exec(syncSrc)
  const setCur = /dir:\s*'comfy-patches',\s*min:\s*'([\d.]+)'/.exec(syncSrc)
  if (mRollback && setRollback) {
    expect(mRollback[1] === setRollback[1],
      `CORE_ROLLBACK_MIN (${mRollback[1]}) != нижняя граница набора 0.33 (${setRollback[1]})`)
  }
  if (mCur && setCur) {
    expect(mCur[1] === setCur[1],
      `CORE_CURRENT_MIN (${mCur[1]}) != нижняя граница основного набора (${setCur[1]})`)
  }
}
// electron и start.bat: у ядра 0.33 нет флага --disable-fast-disk, argparse
// падает на неизвестном аргументе и ComfyUI не стартует
expect(/require\(['"]\.\.\/scripts\/comfy-launch-args['"]\)/.test(main),
  'electron/main.js: флаги собирает scripts/comfy-launch-args.js')
expect(/--disable-fast-disk/.test(bat) && /compareVersions\(v,'0\.34\.0'\)/.test(bat),
  'start.bat: --disable-fast-disk убирается для ядра 0.33')
// (правка 1081) сборку аргументов именно ИСПОЛНЯЕМ: inline-реализация в
// electron/main.js уже уронила приложение на старте («branch is not defined»),
// а node --check такую опечатку не видит
{
  const { comfyFlags, comfyCoreVersion } = (await import('./comfy-launch-args.js')).default
  const { readComfyVersion } = (await import('./sync_custom_nodes.js')).default
  const v = {
    reserveGb: '1', dynamicVram: '1', asyncOffload: '0', pinnedMemory: '1',
    nvmlPressure: '1', vramHeadroom: '1', fastDisk: '0',
  }
  const f33 = comfyFlags(v, '0.33.0')
  const f44 = comfyFlags(v, '0.44.0')
  const has = (r, f) => r.flags.includes(f)
  expect(!has(f33, '--disable-fast-disk') && f33.skipped.includes('--disable-fast-disk'),
    'comfy-launch-args: ядро 0.33.0 не получает --disable-fast-disk (argparse упал бы на нём)')
  expect(has(f44, '--disable-fast-disk') && !f44.skipped.length,
    'comfy-launch-args: ядро 0.44.0 получает весь набор флагов')
  for (const [ver, r] of [['0.33.0', f33], ['0.44.0', f44]]) {
    for (const f of ['--windows-standalone-build', '--use-ck-attention', '--disable-auto-launch',
      '--reserve-vram', '--disable-async-offload', '--vram-headroom']) {
      expect(has(r, f), `comfy-launch-args: ядро ${ver} теряет нужный флаг ${f}`)
    }
  }
  const fUnknown = comfyFlags(v, '')
  expect(has(fUnknown, '--disable-fast-disk'),
    'comfy-launch-args: неизвестная версия ядра ничего не обрезает (прежнее поведение)')
  const off = comfyFlags({ ...v, vramHeadroom: '0', nvmlPressure: '0', pinnedMemory: '0', dynamicVram: '0', fastDisk: '1' }, '0.44.0')
  expect(!has(off, '--vram-headroom') && has(off, '--disable-nvml-pressure') &&
    has(off, '--disable-pinned-memory') && has(off, '--disable-dynamic-vram') && has(off, '--fast-disk'),
    'comfy-launch-args: ключи config.ini переводятся во флаги правильно')
  expect(comfyCoreVersion(join(ROOT, 'ComfyUI')) === readComfyVersion(join(ROOT, 'ComfyUI')),
    'comfy-launch-args: версию ядра читает тот же модуль, что выбирает наборы патчей')
}
// (правка 1080) смена поколения ядра из интерфейса: renderer → preload → main,
// а саму работу делает установщик (он умеет переносить данные и откатываться)
expect(/ipcMain\.handle\('h3:core-switch'/.test(main), "electron/main.js: есть обработчик 'h3:core-switch'")
expect(/-SkipApp/.test(main) && /'-CoreRollback'/.test(main) && /'-CoreCurrent'/.test(main),
  'electron/main.js: смена ядра запускает install.ps1 с -SkipApp и ключом поколения')
expect(/killTree\(old\.pid\)/.test(main), 'electron/main.js: перед сменой ядра останавливается ComfyUI')
expect(/comfy_core_channel\.txt/.test(main), 'electron/main.js: канал ядра пишется до запуска установщика')
const preload = read('electron/preload.js')
expect(/switchCore: \(to\) => ipcRenderer\.invoke\('h3:core-switch'/.test(preload),
  'electron/preload.js: мост h3desktop.comfy.switchCore')

// (правка 1040) «Refine частями» использует встроенную ноду ядра
// MiniMaxH3ContextWindows. Её нет в старых ядрах, поэтому релиз должен
// собираться только с ядром, где она действительно есть.
{
  const ctxCore = join(ROOT, 'ComfyUI', 'comfy_extras', 'nodes_context_windows.py')
  expect(existsSync(ctxCore), 'ядро 0.44: nodes_context_windows.py на месте')
  if (existsSync(ctxCore)) {
    const ctxSrc = readFileSync(ctxCore, 'utf-8')
    expect(/class\s+MiniMaxH3ContextWindowsNode\b/.test(ctxSrc),
      'ядро 0.44: есть MiniMaxH3ContextWindows (нужна для Refine «частями»)')
  }
}

// (правка 1052) Патч ноды контекстных окон: у MiniMaxH3 свой «фазовый»
// статический график окон (выравнивание по концу клипа + сдвиг на 5 токенов
// каждый шаг). Без него хвост длинного Refine «частями» мерцает. Патч
// доезжает через install/comfy-patches при каждом запуске ComfyUI.
{
  const ctxPatch = join(patchDir, 'comfy_extras', 'nodes_context_windows.py')
  expect(existsSync(ctxPatch), 'патч comfy_extras/nodes_context_windows.py на месте')
  if (existsSync(ctxPatch)) {
    const py = readFileSync(ctxPatch, 'utf-8')
    expect(/_h3_static_phased_windows/.test(py) && /h3_static_phased/.test(py),
      'nodes_context_windows.py: MiniMaxH3 использует фазовый график окон (правка 1052)')
  }
}

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

// 9. (правка 911 → 1080) Диапазоны поддерживаемых ядер — ОДНИ на синхронизатор
//    и на UI. Синхронизатор по ним выбирает набор патчей, а баннер —
//    предупреждает пользователя. Разъедутся — баннер будет молчать там, где
//    патчи уже не кладутся (или наоборот). Ловим это на verify релиза.
{
  const coreTs = read('src/lib/comfy/core-version.ts')
  for (const name of ['CORE_MIN_VERSION', 'CORE_CURRENT_MIN', 'CORE_ROLLBACK_MIN', 'CORE_ROLLBACK_MAX']) {
    expect(new RegExp(`export const ${name}\\b`).test(coreTs), `core-version.ts: объявлен ${name}`)
    expect(new RegExp(`const ${name}\\b`).test(sync), `sync_custom_nodes.js: объявлен ${name}`)
  }
  expect(/const CORE_MIN_VERSION = CORE_ROLLBACK_MIN/.test(sync),
    'sync_custom_nodes.js: CORE_MIN_VERSION привязан к CORE_ROLLBACK_MIN')
  expect(/export const CORE_MIN_VERSION = CORE_ROLLBACK_MIN/.test(coreTs),
    'core-version.ts: CORE_MIN_VERSION привязан к CORE_ROLLBACK_MIN')
  const maxTs = /CORE_ROLLBACK_MAX\s*=\s*['"]([^'"]+)['"]/.exec(coreTs)?.[1]
  const maxJs = /max:\s*'([\d.]+)'/.exec(sync)?.[1]
  expect(!!maxTs && !!maxJs && maxTs === maxJs,
    `верхняя граница откатного ядра совпадает (${maxTs ?? '?'} / ${maxJs ?? '?'})`)
}

// 10. (правка 917) Патч VideoHelperSuite: доезжает и через установщик, и через
//     запуск ComfyUI. manifest знает эталонную версию файла, чтобы не затирать
//     чужой VHS.
{
  expect(/function\s+syncVhsPatches\s*\(/.test(sync), 'sync_custom_nodes.js: функция syncVhsPatches()')
  expect(/module\.exports\s*=\s*\{[^}]*syncVhsPatches/.test(sync),
    'sync_custom_nodes.js: syncVhsPatches экспортируется')
  expect(/const vhs = syncVhsPatches\(appRoot, comfyRoot\)/.test(sync),
    'sync_custom_nodes.js: CLI-вызов syncVhsPatches')
  expect(/require\(['"]\.\.\/scripts\/sync_custom_nodes['"]\)/.test(main) &&
    /syncVhsPatches[,}]/.test(main), 'electron/main.js: импортирует syncVhsPatches')
  if (/function startComfy\s*\(/.test(main)) {
    const body = main.slice(main.indexOf('function startComfy('), main.indexOf('function startComfy(') + 8000)
    expect(body.includes('syncVhsPatches(APP_ROOT, COMFY_ROOT)'),
      'electron/main.js: syncVhsPatches вызывается внутри startComfy')
  }
  const vhsManifest = read('install/vhs-patches/manifest.json')
  let vhsMan = null
  try { vhsMan = JSON.parse(vhsManifest) } catch { /* ниже сообщим */ }
  expect(!!vhsMan, 'install/vhs-patches/manifest.json читается')
  expect(!!vhsMan && typeof vhsMan.node_dir === 'string',
    'install/vhs-patches/manifest.json: задан node_dir')
  const utilsKey = vhsMan && vhsMan.upstream ? vhsMan.upstream['videohelpersuite/utils.py'] : null
  expect(!!utilsKey && /^[0-9a-f]{64}$/.test(utilsKey),
    'install/vhs-patches/manifest.json: эталонный sha256 для videohelpersuite/utils.py')
  const vhsUtils = read('install/vhs-patches/videohelpersuite/utils.py')
  expect(vhsUtils.includes('[H3-STUDIO PATCH 917]'),
    'install/vhs-patches: utils.py содержит маркер патча 917')
  expect(/def\s+_load\(self\)\s*:/.test(vhsUtils) && /except Exception/.test(vhsUtils) &&
    /self\._dict = \{\}/.test(vhsUtils),
    'install/vhs-patches: LazyAudioMap не бросает исключение, а кэширует пусто')
  expect(/vhs-patches/.test(read('install/install.ps1')),
    'install/install.ps1: применяет install\\vhs-patches')
}

// 11. (правка 920) Старый Visual C++ redist — причина WinError 1114 у torch.
//     Проверка обязана быть на шаге 1 и не прерывать установку при неудаче.
{
  const ps = read('install/install.ps1')
  expect(/function\s+Ensure-VcRedist\s*\{/.test(ps), 'install/install.ps1: функция Ensure-VcRedist()')
  expect(/function\s+Get-VcRuntimeVersion\s*\{/.test(ps),
    'install/install.ps1: функция Get-VcRuntimeVersion()')
  expect(/msvcp140\.dll/.test(ps) && /vcruntime140_1\.dll/.test(ps),
    'install/install.ps1: VC-проверка смотрит msvcp140.dll и vcruntime140_1.dll')
  expect(/aka\.ms\/vs\/17\/release\/vc_redist\.x64\.exe/.test(ps),
    'install/install.ps1: качает официальный vc_redist.x64.exe')
  expect(/Ensure-VcRedist/.test(ps) && /Start-Process[^\n]*vc_redist|ArgumentList\s+'\/install'/.test(ps),
    'install/install.ps1: ставит redist тихо (/install /quiet /norestart)')
  expect(/try\s*\{\s*Ensure-VcRedist\s*\}\s*catch/.test(ps),
    'install/install.ps1: ошибка VC-проверки не прерывает установку')
}

// 12. (правка 951) Режим «Изображение» удалён полностью: нет вкладки, роутов,
//     сторов, шаблона и пунктов моделей. Держим регресс, чтобы он не вернулся
//     случайно (качество официальной image-модели не устроило).
{
  const gone = [
    'src/components/h3/image-view.tsx',
    'src/components/h3/image-results-grid.tsx',
    'src/lib/image-store.ts',
    'src/lib/image-job-store.ts',
    'src/lib/comfy/image-template.ts',
    'src/lib/comfy/image-pe.ts',
    'src/app/api/comfy/image/route.ts',
    'src/app/api/comfy/image-assets/route.ts',
  ]
  for (const rel of gone) expect(!existsSync(join(ROOT, rel)), `удалён файл режима «Изображение»: ${rel}`)
  const sidebar = read('src/components/h3/sidebar.tsx')
  expect(!/label: 'Изображение'/.test(sidebar), 'sidebar: вкладки «Изображение» нет')
  const models = read('src/lib/models-config.ts')
  expect(!/id: 'image_model'/.test(models), 'models-config: нет image_model')
  expect(!/id: 'image_vae'/.test(models), 'models-config: нет image_vae')
  expect(!/id: 'image_prompt_enhancer'/.test(models), 'models-config: нет image_prompt_enhancer')
  const queue = read('src/lib/gen-queue-store.ts')
  expect(!/\|\s*'image'/.test(queue), 'очередь: тип image удалён')
}

// 13. (правка 1055) Нода-сброс VRAM обязана доезжать до ComfyUI
//     (custom nodes/minimax_studio_vram_reset) и использоваться в H3-шаблонах:
//     генерация/продление/refine. Шаблоны без ноды или нода без шаблонов —
//     тот же класс рассинхрона, что правка 866 (missing_node_type у юзера).
{
  const reset = read('custom nodes/minimax_studio_vram_reset/__init__.py')
  expect(/"MiniMaxStudioVRAMReset"\s*:\s*MiniMaxStudioVRAMReset/.test(reset),
    'minimax_studio_vram_reset: нода зарегистрирована в NODE_CLASS_MAPPINGS')
  for (const t of ['src/lib/comfy/minimax-h3-template.ts', 'src/lib/comfy/refine-template.ts']) {
    expect(/class_type: 'MiniMaxStudioVRAMReset'/.test(read(t)),
      `${t}: шаблон использует MiniMaxStudioVRAMReset`)
  }
  // (правка 1061) Нода обязана воспроизводить finally-блок ядра: именно
  // cleanup_prefetch_queues доказанно снимает пин VBAR-страниц (comfy-aimdo#117).
  expect(/cleanup_prefetch_queues/.test(reset) && /reset_cast_buffers/.test(reset) &&
    /vbars_reset_watermark_limits/.test(reset),
    'minimax_studio_vram_reset: есть тройная очистка prefetch/cast-buffers/watermark')
  // Refine обязан ставить сброс ПЕРЕД тяжёлым прогоном (иначе re-fault после
  // генерации вешает прогон на 0% «Model Initializing»).
  const refineTpl = read('src/lib/comfy/refine-template.ts')
  expect(/'r_rst_pre':\s*\{/.test(refineTpl),
    'refine-template: узел сброса r_rst_pre (перед сэмплером) на месте')
  expect(refineTpl.includes("latent_image: ['r_rst_pre', 0]") &&
    refineTpl.includes("latent: ['r_rst_pre', 0]"),
    'refine-template: сэмплер и TesseraRefine запитаны от r_rst_pre')
}

// 13b. (правка 1057) Тайловый тракт Refine «Частями» (Tessera): пак забандлен
//      в custom nodes/, регистрирует нужные ноды и шаблоны их вызывают.
{
  const tessera = read('custom nodes/ComfyUI-Tessera/tessera/nodes.py')
  for (const c of ['TesseraEncode', 'TesseraRefine', 'TesseraPlan', 'TesseraDecode']) {
    expect(tessera.includes('class ' + c), `ComfyUI-Tessera: нода ${c} на месте`)
  }
  const rt = read('src/lib/comfy/refine-template.ts')
  for (const c of ['TesseraEncode', 'TesseraRefine', 'TesseraPlan']) {
    expect(rt.includes(`class_type: '${c}'`), `refine-template: тракт использует ${c}`)
  }
}

// 13c. (правка 1089) Bounded attention (правка 1088) обязана стоять во всех
//      H3-цепочках: «Генерация» и «Продление» (один файл — два билдера), Refine
//      «Целым»/«Частями», Tile Upscale, Face Refine; ControlNet прокидывает
//      флаг в стандартный билдер. Плюс настройка auto/on/off доходит до роутов.
{
  const node = read('custom nodes/minimax_studio_bounded_attn/__init__.py')
  expect(/"MiniMaxStudioBoundedAttention"\s*:\s*MiniMaxStudioBoundedAttention/.test(node),
    'minimax_studio_bounded_attn: нода зарегистрирована в NODE_CLASS_MAPPINGS')
  for (const t of [
    'src/lib/comfy/minimax-h3-template.ts',
    'src/lib/comfy/refine-template.ts',
    'src/lib/comfy/tile-upscale-template.ts',
    'src/lib/comfy/face-refine-template.ts',
  ]) {
    expect(read(t).includes("class_type: 'MiniMaxStudioBoundedAttention'"),
      `${t}: model-цепочка использует MiniMaxStudioBoundedAttention`)
  }
  // Две независимые цепочки в одном файле: основной билдер + buildExtendWorkflow.
  expect((read('src/lib/comfy/minimax-h3-template.ts').match(/class_type: 'MiniMaxStudioBoundedAttention'/g) || []).length >= 2,
    'minimax-h3-template: bounded стоит и в «Генерации», и в «Продлении»')
  const cn = read('src/lib/comfy/controlnet-template.ts')
  expect(cn.includes('boundedAttention: p.boundedAttention'),
    'controlnet-template: boundedAttention прокидывается в стандартные параметры')
  for (const r of [
    'src/app/api/comfy/generate/route.ts',
    'src/app/api/comfy/refine/route.ts',
    'src/app/api/comfy/controlnet/route.ts',
    'src/app/api/comfy/face-refine/route.ts',
    'src/app/api/comfy/tile-upscale/route.ts',
  ]) {
    expect(read(r).includes('resolveBoundedAttention('),
      `${r}: роут решает bounded через общий хелпер (настройка auto/on/off работает везде)`)
  }
}

// 13d. (правка 1095) Sol-Attn: на ядре 0.44+ наша нода делегирует родному
//      узлу ядра (BlockSparseAttention) — только он защищает строки кондёра
//      (sink_conditioning) и совместим с MiniMaxLowVRAMAttention. Порт остаётся
//      запасным путём для откатного ядра 0.33, где узла ядра нет.
{
  const sparse = read('custom nodes/MiniMaxSparseAttn/__init__.py')
  expect(/from comfy_extras\.nodes_sparse_attention import apply_block_sparse_attention/.test(sparse),
    'MiniMaxSparseAttn: делегирование узлу ядра (sink_conditioning + sol_take_forward)')
  expect(/except ImportError/.test(sparse) && /_core_sparse = None/.test(sparse),
    'MiniMaxSparseAttn: путь для откатного ядра 0.33 сохранён')
  // Размеры кусков больше не зашиты: head_chunks/token_chunk берутся из настроек
  // (или авторазмера), иначе настройка в «Оптимизации» ничего бы не меняла.
  const gen = read('src/lib/comfy/minimax-h3-template.ts')
  const refine = read('src/lib/comfy/refine-template.ts')
  for (const [f, src] of [['minimax-h3-template', gen], ['refine-template', refine]]) {
    expect((src.match(/head_chunks: headChunks/g) || []).length >= 2,
      `${f}: head_chunks из настройки в обеих model-цепочках (без зашитого 4)`)
    expect((src.match(/token_chunk: tokenChunk/g) || []).length >= 2,
      `${f}: token_chunk из настройки/авторазмера в обеих model-цепочках`)
  }
  // Настройка должна доходить из хука и очередей Refine до шаблонов.
  expect(read('src/hooks/use-video-gen.ts').includes('lowVramHeadChunks: params.lowVramHeadChunks'),
    'use-video-gen: head_chunks уходит в /api/comfy/generate')
  const rq = read('src/lib/refine-queue.ts')
  expect(rq.includes('lowVramHeadChunks: task.lowVramHeadChunks') && rq.includes('boundedTokenChunk: task.boundedTokenChunk'),
    'refine-queue: размеры кусков прокидываются в очередь Refine')
  const store = read('src/lib/gen-store.ts')
  expect(store.includes('lowVramHeadChunks: 4') && store.includes('boundedTokenChunk: 0'),
    'gen-store: дефолты новых настроек (4 головы / авто-кусок)')
  // (правка 1095) auto на малых картах больше не ставит узел вслепую: роуты
  // передают длину последовательности, а порог живёт в gpu-vram.ts.
  const gv = read('src/lib/comfy/gpu-vram.ts')
  expect(/BOUNDED_ATTN_MIN_SEQ_TOKENS/.test(gv) && /seqTokens\?: number/.test(gv),
    'gpu-vram: авто-решение bounded учитывает длину последовательности')
  for (const r of [
    'src/app/api/comfy/generate/route.ts',
    'src/app/api/comfy/refine/route.ts',
    'src/app/api/comfy/controlnet/route.ts',
  ]) {
    expect(read(r).includes('seqTokens:'),
      `${r}: роут считает seqTokens для авто-решения bounded (иначе на 480p узел тормозит впустую)`)
  }
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
