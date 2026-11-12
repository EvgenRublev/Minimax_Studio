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
if (existsSync(nodePatch)) {
  const py = readFileSync(nodePatch, 'utf-8')
  expect(/node_id\s*=\s*["']MiniMaxH3AddGuide["']/.test(py), 'патч содержит MiniMaxH3AddGuide')
  expect(/io\.Latent\.Output\(display_name=["']latent["']\)/.test(py),
    'MiniMaxH3AddGuide отдаёт выход latent (иначе аудио-гайд падает на av_latent)')
}

// 6. (правки 904, 949) Ядро 0.44 пиновано, но официальная H3 Image появилась
//    в upstream позже, поэтому её модель и детекция теперь живут в патчах.
//    Никаких старых копий «на всякий случай»: только эти два файла.
{
  const mmPatch = join(patchDir, 'comfy', 'ldm', 'minimax', 'model.py')
  const detectPatch = join(patchDir, 'comfy', 'model_detection.py')
  expect(existsSync(mmPatch), 'патч comfy/ldm/minimax/model.py на месте (H3 Image)')
  expect(existsSync(detectPatch), 'патч comfy/model_detection.py на месте (H3 Image)')
  if (existsSync(mmPatch)) {
    const py = readFileSync(mmPatch, 'utf-8')
    expect(/class\s+MiniMaxH3ImageModel\(MiniMaxH3Model\)/.test(py),
      'model.py: есть MiniMaxH3ImageModel (один поток без аудио)')
    expect(/class\s+MiniMaxH3ImageModelSampling\(/.test(py),
      'model.py: сетка PDD-сигм для image-модели')
    expect(/audio_latents_dim is not None/.test(py),
      'model.py: аудио-поток стал необязательным (image-чекпоинт без audio_patch_proj)')
  }
  if (existsSync(detectPatch)) {
    const py = readFileSync(detectPatch, 'utf-8')
    expect(/minimax_h3_image/.test(py),
      'model_detection.py: image-чекпоинт определяется как minimax_h3_image')
    expect(/audio_patch_proj\.weight'.*in state_dict_keys/.test(py),
      'model_detection.py: наличие аудио-потока решает тип модели')
  }
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

// 12. (правка 946) Официальный image-VAE (Comfy-Org/MiniMax-H3-Image).
//     Ядро 0.44 собирало его как p-h3-image (32 головы, 3D-conv) и падало на
//     `Error(s) in loading state_dict for PH3ImageVAE: size mismatch`; нужный
//     класс живёт только в наших патчах ядра, поэтому проверяем сами файлы.
{
  const vaePatch = join(patchDir, 'comfy', 'ldm', 'minimax', 'vae.py')
  const sdPatch = join(patchDir, 'comfy', 'sd.py')
  expect(existsSync(vaePatch), 'патч ядра comfy/ldm/minimax/vae.py на месте')
  expect(existsSync(sdPatch), 'патч ядра comfy/sd.py на месте')
  if (existsSync(vaePatch)) {
    const py = readFileSync(vaePatch, 'utf-8')
    expect(/class\s+MiniMaxH3ImageVAE\(H3ImageVAE\)/.test(py),
      'vae.py: есть MiniMaxH3ImageVAE (официальный image-VAE)')
    expect(/rope_dim_ratio=0\.5,\s*rope_dims=2/.test(py),
      'vae.py: официальный декодер — 16 голов и 2D-rope')
    expect(/ops\.Conv2d\(24,\s*24,\s*1\)/.test(py),
      'vae.py: у официального image-VAE 2D post_quant_conv')
    expect(/class\s+PH3ImageVAE\(H3ImageVAE\)/.test(py),
      'vae.py: p-h3-image остался 3D-декодером на 32 головы')
  }
  if (existsSync(sdPatch)) {
    const py = readFileSync(sdPatch, 'utf-8')
    expect(/MiniMaxH3ImageVAE\(operations=minimax_ops/.test(py),
      'sd.py: официальный image-VAE выбирается при загрузке')
    expect(/decoder\.x_embedder\.weight"\]\.shape\[0\]\s*==\s*1024/.test(py),
      'sd.py: official и p-h3-image различаются по ширине декодера')
  }
  // (правка 947) подписи вкладки «Изображение» однажды сохранили двойной
  // кодировкой (UTF-8 → CP1251) и в UI поехали кракозябры. Маркеры ниже не
  // встречаются в нормальном русском тексте, только в такой порче.
  const imgTpl = read('src/lib/comfy/image-template.ts')
  expect(!/вЂ|Рї|РЎ/.test(imgTpl), 'image-template.ts: русский текст не в двойной кодировке')
  expect(/4 шага — быстрый прогон/.test(imgTpl), 'image-template.ts: подписи шагов читаются')
}

// 13. (правка 949) Официальная image-модель H3: один латент-поток без аудио.
//     Ей нужны класс в model_base и запись в supported_models, а граф студии
//     не должен подменять её PDD-сетку сигм и не должен скармливать AV-латент.
{
  const mbPatch = join(patchDir, 'comfy', 'model_base.py')
  const smPatch = join(patchDir, 'comfy', 'supported_models.py')
  expect(existsSync(mbPatch), 'патч ядра comfy/model_base.py на месте')
  expect(existsSync(smPatch), 'патч ядра comfy/supported_models.py на месте')
  if (existsSync(mbPatch)) {
    const py = readFileSync(mbPatch, 'utf-8')
    expect(/class\s+MiniMaxH3Image\(MiniMaxH3\)/.test(py),
      'model_base.py: есть MiniMaxH3Image (ModelType.FLOW + свой model_sampling)')
    expect(/MiniMaxH3ImageModelSampling\(model_config\)/.test(py),
      'model_base.py: image-модель берёт сетку PDD-сигм, а не ModelSamplingAV')
  }
  if (existsSync(smPatch)) {
    const py = readFileSync(smPatch, 'utf-8')
    expect(/"image_model":\s*"minimax_h3_image"/.test(py),
      'supported_models.py: объявлен MiniMaxH3Image')
    expect(/\n\s+MiniMaxH3Image,/.test(py),
      'supported_models.py: MiniMaxH3Image в списке models')
  }
  const imgTpl = read('src/lib/comfy/image-template.ts')
  expect(!/class_type:\s*'H3InjectVideoLatent'/.test(imgTpl),
    'image-template.ts: второй проход без AV-инъекции (image-модель однопоточная)')
  expect(/class_type:\s*'VAEEncode'/.test(imgTpl),
    'image-template.ts: база второго прохода входит через VAEEncode')
  expect(!/class_type:\s*'MiniMaxH3SigmaShift'/.test(imgTpl),
    'image-template.ts: не подменяет PDD-сетку image-модели на ModelSamplingAV')
  expect(/class_type:\s*'LTXVSeparateAVLatent'/.test(imgTpl),
    'image-template.ts: видео-часть AV-латента отделяется до сэмплера')
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
