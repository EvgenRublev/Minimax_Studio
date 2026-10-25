# Сборка portable-версии MiniMax H3 Studio

Это инструкция для агента: как собрать готовую к запуску переносимую версию
без пользовательских данных, истории промптов и весов моделей.

Целевой результат:

```text
E:\Minimax_Studio_V7_Portable\       — папка portable-сборки (~9 ГБ)
E:\Minimax_Studio_V7_Portable.zip    — zip64-архив (~5.2 ГБ)
```

Модели H3, VAE, LoRA, LLM и остальные веса **не входят** в сборку. Их
скачивает сам пользователь через «Настройки → Модели» после первого запуска.
Настройки — заводские, `vram_headroom=2`.

---

## 1. Критические грабли

### 1.1. Не исключайте `data` и `models` по имени

`robocopy /XD data` или `/XD models` исключает **все** каталоги с таким именем,
включая:

- `node_modules/caniuse-lite/data` → падает `next build`;
- `python_embeded/.../torchvision/models` → падает импорт ComfyUI;
- `custom_nodes/.../models` → ломаются custom nodes.

Исключайте только **точные полные пути**:

```powershell
$comfySrc = Join-Path $src 'ComfyUI-Easy-Install'
# ...
(Join-Path $comfySrc 'ComfyUI\models')
(Join-Path $comfySrc 'ComfyUI\user')
```

### 1.2. `.next` лучше собирать уже в portable-папке

Next.js пишет в `.next/server/...` абсолютный `resolvedPagePath`. Если собрать
в `E:\Minimax_Studio_V7` и скопировать `.next`, путь будет указывать на
исходную папку. Поэтому:

1. скопируйте проект и `node_modules`;
2. соберите `npm run build` **внутри** portable-папки;
3. выполните `scripts/prune-build.mjs`.

### 1.3. `--quick-test-for-ci` создаёт пользовательские данные

После проверки ComfyUI появляются `ComfyUI/user/...`, логи, `comfyui.db`.
Перед упаковкой обязательно очистите `ComfyUI/user`, `input`, `output`, `temp`
и корневую `data`.

### 1.4. Не используйте `Compress-Archive` для архива >2 ГБ

`Compress-Archive` в PowerShell 5 может упасть на больших файлах. Используйте
встроенный `tar.exe` (bsdtar, поддерживает zip64):

```powershell
tar.exe -a -c -f $zip -C (Split-Path $dst -Parent) (Split-Path $dst -Leaf)
```

---

## 2. Пошаговая сборка (PowerShell)

Запускать из PowerShell. Node/npm в проекте лежат в `runtime\`, их нужно
добавить в `PATH`.

Перед копированием желательно закрыть запущенные Electron/ComfyUI: Windows
может держать `electron.exe`, `python.exe` и DLL. Если robocopy сообщает о
занятых файлах — закройте студию и повторите копирование.

```powershell
$src = 'E:\Minimax_Studio_V7'
$dst = 'E:\Minimax_Studio_V7_Portable'
$zip = 'E:\Minimax_Studio_V7_Portable.zip'

if (Test-Path $dst) { throw "Удалите/переименуйте $dst перед сборкой" }
New-Item -ItemType Directory -Path $dst | Out-Null

# ── 1. Корень проекта (без ComfyUI, data, кэшей и логов) ──────────────
$rootExcl = @(
  (Join-Path $src '.git'),
  (Join-Path $src '.install-cache'),
  (Join-Path $src '.local-input'),
  (Join-Path $src 'data'),
  (Join-Path $src 'ComfyUI-Easy-Install'),
  (Join-Path $src '.next\cache')
)
$rcArgs = @(
  $src, $dst, '/E', '/COPY:DAT', '/DCOPY:DAT', '/R:1', '/W:1', '/NFL', '/NDL', '/NP',
  '/XD'
) + $rootExcl + @('.git', '__pycache__', '/XF', '*.log', '*.pyc')
& robocopy @rcArgs
if ($LASTEXITCODE -ge 8) { throw "robocopy root: $LASTEXITCODE" }

# ── 2. Заводские config.ini и .env из HEAD (не копируйте пользовательские) ──
foreach ($f in @('config/config.ini', '.env')) {
  $factory = & git -C $src show "HEAD:$f"
  if ($LASTEXITCODE -ne 0) { throw "git show $f failed" }
  $out = Join-Path $dst $f
  New-Item -ItemType Directory -Force -Path (Split-Path $out -Parent) | Out-Null
  [IO.File]::WriteAllLines($out, $factory, [Text.UTF8Encoding]::new($false))
}

# ── 3. ComfyUI-Easy-Install (кроме моделей и пользовательских папок) ──
$comfySrc = Join-Path $src 'ComfyUI-Easy-Install'
$comfyDst = Join-Path $dst 'ComfyUI-Easy-Install'
$comfyExcl = @(
  (Join-Path $comfySrc 'ComfyUI\models'),
  (Join-Path $comfySrc 'ComfyUI\user'),
  (Join-Path $comfySrc 'ComfyUI\input'),
  (Join-Path $comfySrc 'ComfyUI\output'),
  (Join-Path $comfySrc 'ComfyUI\temp'),
  (Join-Path $comfySrc 'ComfyUI\tests'),
  (Join-Path $comfySrc 'ComfyUI\tests-unit'),
  (Join-Path $comfySrc 'ComfyUI\.ci'),
  (Join-Path $comfySrc 'ComfyUI\.github')
)
$rcArgs = @(
  $comfySrc, $comfyDst, '/E', '/COPY:DAT', '/DCOPY:DAT', '/R:1', '/W:1', '/NFL', '/NDL', '/NP',
  '/XD'
) + $comfyExcl + @('.git', '__pycache__', '/XF', '*.log', '*.pyc')
& robocopy @rcArgs
if ($LASTEXITCODE -ge 8) { throw "robocopy comfy: $LASTEXITCODE" }

# ── 4. Структура models без весов ─────────────────────────────────────
$modelsSrc = Join-Path $comfySrc 'ComfyUI\models'
$modelsDst = Join-Path $comfyDst 'ComfyUI\models'
$rcArgs = @(
  $modelsSrc, $modelsDst, '/E', '/COPY:DAT', '/DCOPY:DAT', '/R:1', '/W:1', '/NFL', '/NDL', '/NP',
  '/XD', '__pycache__', '.git',
  '/XF', '*.safetensors', '*.ckpt', '*.pt', '*.pth', '*.onnx', '*.bin', '*.gguf',
  '*.sft', '*.engine', '*.pkl', '*.npz', '*.npy', '*.h5', '*.msgpack', '*.log', '*.pyc'
)
& robocopy @rcArgs
if ($LASTEXITCODE -ge 8) { throw "robocopy models: $LASTEXITCODE" }

# ── 5. Пустые пользовательские каталоги ───────────────────────────────
$dirs = @(
  'data',
  'data\chat-attachments',
  'data\upscale-input',
  'data\upscale-output',
  'ComfyUI-Easy-Install\ComfyUI\input',
  'ComfyUI-Easy-Install\ComfyUI\output',
  'ComfyUI-Easy-Install\ComfyUI\temp',
  'ComfyUI-Easy-Install\ComfyUI\user',
  'upscale\logs',
  'upscale\jobs'
)
foreach ($d in $dirs) { New-Item -ItemType Directory -Force -Path (Join-Path $dst $d) | Out-Null }

# ── 6. Сборка внутри portable-папки ───────────────────────────────────
$node = Join-Path $dst 'runtime\node.exe'
$npm  = Join-Path $dst 'runtime\npm.cmd'
$env:PATH = (Join-Path $dst 'runtime') + ';' + $env:PATH
Push-Location $dst
try {
  & $npm run build
  if ($LASTEXITCODE -ne 0) { throw 'npm run build failed' }
  & $node scripts\prune-build.mjs
  if ($LASTEXITCODE -ne 0) { throw 'prune-build failed' }
} finally {
  Pop-Location
}
```

### Проверка после копирования и сборки

```powershell
$src = 'E:\Minimax_Studio_V7'
$dst = 'E:\Minimax_Studio_V7_Portable'
$py  = Join-Path $dst 'ComfyUI-Easy-Install\python_embeded\python.exe'
$node = Join-Path $dst 'runtime\node.exe'

# 1) Ключевые файлы
$must = @(
  'start.bat',
  'server.js',
  '.next\BUILD_ID',
  'node_modules\electron\dist\MinimaxH3Studio.exe',
  'node_modules\caniuse-lite\data\browsers.js',
  'ComfyUI-Easy-Install\python_embeded\python.exe',
  'ComfyUI-Easy-Install\python_embeded\Lib\site-packages\torchvision\models\__init__.py',
  'ComfyUI-Easy-Install\ComfyUI\main.py',
  'config\config.ini',
  '.env'
)
foreach ($f in $must) {
  if (!(Test-Path (Join-Path $dst $f))) { throw "Нет файла: $f" }
}

# 2) Python-зависимости
& $py -c "import torch, cv2, torchvision; from torchvision import models; print('torchvision ok')"
if ($LASTEXITCODE -ne 0) { throw 'python imports failed' }

# 3) ComfyUI загружает все custom nodes
& $py -I (Join-Path $dst 'ComfyUI-Easy-Install\ComfyUI\main.py') --quick-test-for-ci
if ($LASTEXITCODE -ne 0) { throw 'ComfyUI quick test failed' }

# 4) Тест создал user-данные — чистим
$comfy = Join-Path $dst 'ComfyUI-Easy-Install\ComfyUI'
foreach ($d in @('user', 'input', 'output', 'temp')) {
  Get-ChildItem (Join-Path $comfy $d) -Force -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force
}
Get-ChildItem (Join-Path $dst 'data') -Force -ErrorAction SilentlyContinue |
  Remove-Item -Recurse -Force
```

### Smoke-тест web-сервера (без запуска Electron и второго ComfyUI)

```powershell
$dst = 'E:\Minimax_Studio_V7_Portable'
$env:PORT = '3002'
$p = Start-Process -FilePath (Join-Path $dst 'runtime\node.exe') `
  -ArgumentList 'server.js' -WorkingDirectory $dst -WindowStyle Hidden -PassThru
try {
  Start-Sleep -Seconds 4
  $cfg = Invoke-RestMethod 'http://127.0.0.1:3002/api/config'
  if ($cfg.vram_headroom -ne 2) { throw "vram_headroom=$($cfg.vram_headroom), ожидалось 2" }

  $loras = Invoke-RestMethod 'http://127.0.0.1:3002/api/loras'
  if ($null -eq $loras.loras) { throw '/api/loras не вернул loras' }

  $root = Invoke-WebRequest 'http://127.0.0.1:3002/' -UseBasicParsing
  if ($root.StatusCode -ne 200) { throw "root HTTP $($root.StatusCode)" }

  try {
    Invoke-WebRequest 'http://127.0.0.1:3002/api/comfy/inpaint' -UseBasicParsing | Out-Null
    throw 'Inpaint-маршрут всё ещё существует'
  } catch {
    if ($_.Exception.Response.StatusCode.value__ -ne 404) { throw }
  }
} finally {
  Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
}
Remove-Item Env:PORT -ErrorAction SilentlyContinue
```

После smoke-теста ещё раз очистите пользовательские каталоги (сервер мог
создать `data`, `ComfyUI/user` и служебные файлы):

```powershell
$dst = 'E:\Minimax_Studio_V7_Portable'
$comfy = Join-Path $dst 'ComfyUI-Easy-Install\ComfyUI'
foreach ($d in @('user', 'input', 'output', 'temp')) {
  Get-ChildItem (Join-Path $comfy $d) -Force -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force
}
Get-ChildItem (Join-Path $dst 'data') -Force -ErrorAction SilentlyContinue |
  Remove-Item -Recurse -Force
Remove-Item (Join-Path $dst '.next\cache') -Recurse -Force -ErrorAction SilentlyContinue
```

---

## 3. Проверка «чистоты» сборки

Перед упаковкой убедитесь, что нет пользовательских данных и весов,
которые должен скачать пользователь:

```powershell
$dst = 'E:\Minimax_Studio_V7_Portable'
$models = Join-Path $dst 'ComfyUI-Easy-Install\ComfyUI\models'
$comfy  = Join-Path $dst 'ComfyUI-Easy-Install\ComfyUI'

# Не должно быть весов в models/ (кроме insightface/buffalo_l.zip —
# это небольшой bundle, которого нет в менеджере моделей приложения).
Get-ChildItem $models -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Extension -in '.safetensors','.ckpt','.pt','.pth','.onnx','.bin','.gguf','.sft','.engine' } |
  Select-Object FullName, Length

# Не должно быть пользовательских файлов
Get-ChildItem (Join-Path $dst 'data') -Recurse -File -ErrorAction SilentlyContinue
Get-ChildItem (Join-Path $comfy 'user') -Recurse -File -ErrorAction SilentlyContinue
Get-ChildItem (Join-Path $comfy 'input') -Recurse -File -ErrorAction SilentlyContinue
Get-ChildItem (Join-Path $comfy 'output') -Recurse -File -ErrorAction SilentlyContinue
```

Ожидаемо: пусто. Исключения:

- `models/insightface/models/buffalo_l.zip` — можно оставить, если нужен FaceRefine;
- веса внутри `ComfyUI/custom_nodes/...` (RIFE, FILM, depth) — можно оставить,
  чтобы FPS/ControlNet работали без дополнительных загрузок;
- `models/configs/*.yaml`, `models/fonts/*` — это не веса, оставляем.

Также проверьте заводские настройки:

```powershell
Get-Content (Join-Path $dst 'config\config.ini') | Select-String 'vram_headroom|comfy_dir|extra_paths'
```

Должно быть `vram_headroom=2`, `comfy_dir` пустой/отсутствует,
`extra_paths=[]`.

---

## 4. Упаковка

```powershell
$dst = 'E:\Minimax_Studio_V7_Portable'
$zip = 'E:\Minimax_Studio_V7_Portable.zip'
Remove-Item $zip -Force -ErrorAction SilentlyContinue

tar.exe -a -c -f $zip -C (Split-Path $dst -Parent) (Split-Path $dst -Leaf)
if ($LASTEXITCODE -ne 0) { throw "tar failed: $LASTEXITCODE" }
```

Проверка архива:

```powershell
$zip = 'E:\Minimax_Studio_V7_Portable.zip'
& tar.exe -tf $zip | Select-String @(
  'Minimax_Studio_V7_Portable/start\.bat$',
  'Minimax_Studio_V7_Portable/server\.js$',
  'Minimax_Studio_V7_Portable/\.next/BUILD_ID$',
  'Minimax_Studio_V7_Portable/node_modules/electron/dist/MinimaxH3Studio\.exe$',
  'Minimax_Studio_V7_Portable/node_modules/caniuse-lite/data/browsers\.js$',
  'Minimax_Studio_V7_Portable/ComfyUI-Easy-Install/python_embeded/Lib/site-packages/torchvision/models/__init__\.py$'
)
```

В архиве **не должно быть**:

- `ComfyUI-Easy-Install/ComfyUI/user/...` с файлами;
- `ComfyUI-Easy-Install/ComfyUI/input|output|temp` с файлами;
- `data/assistant-chats.json`, `data/inflight-generate.json`, `data/loras.json`;
- `ComfyUI-Easy-Install/ComfyUI/models/**/*.safetensors` и других весов H3.

Размеры-ориентиры:

```text
папка  ~8.9 ГБ
zip    ~5.25 ГБ
```

Если облако не принимает файл >5 ГБ — заливайте папку или делите zip на части.

---

## 5. Что не входит и почему

- **Веса H3, VAE, LoRA, LLM** — скачиваются через «Настройки → Модели».
- **`upscale/bin`** — проприетарный DLSS-рантайм NVIDIA; в открытой сборке его
  нет. Если в исходнике папка отсутствует, в portable её тоже не будет.
- **Пользовательские данные**: чаты, история/избранное промптов, `data/loras.json`,
  `ComfyUI/user`, `input`, `output`, логи — не копируются.
- **`prompts/`** — это системные промпты приложения, их оставляем.

---

## 6. Финальный чек-лист

- [ ] `npm run build` выполнен **внутри** `_Portable`.
- [ ] `scripts/prune-build.mjs` выполнен.
- [ ] `node_modules/caniuse-lite/data/browsers.js` есть.
- [ ] `python_embeded/.../torchvision/models/__init__.py` есть.
- [ ] `python -c "import torch, cv2, torchvision; from torchvision import models"` проходит.
- [ ] `ComfyUI main.py --quick-test-for-ci` проходит.
- [ ] После quick-test очищены `ComfyUI/user`, `input`, `output`, `temp`, `data`.
- [ ] Web-сервер на свободном порту отдаёт `/` 200, `/api/config` с `vram_headroom=2`.
- [ ] `/api/comfy/inpaint` отдаёт 404.
- [ ] В `ComfyUI/models` нет весов H3.
- [ ] `config/config.ini` заводской, `vram_headroom=2`.
- [ ] Zip создан через `tar.exe`, а не `Compress-Archive`.
- [ ] Portable-папка и zip **не** добавлены в git.
