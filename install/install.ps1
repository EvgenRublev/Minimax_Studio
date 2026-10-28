#Requires -Version 5.1
<#
.SYNOPSIS
    MiniMax H3 Studio - автоматическая установка зависимостей.

.DESCRIPTION
    Восстанавливает окружение проекта на чистой машине Windows x64:
      * Node.js 22 (портативный, если в системе нет 18+)
      * node_modules + production-сборку .next
      * ComfyUI 0.33.0 + Python 3.12.10 + torch 2.11.0+cu130 + 288 пакетов
      * 22 кастомные ноды по зафиксированным коммитам + 4 локальные ноды
      * STT-рантайм transcribe.cpp v0.1.3 (голосовой ввод; CPU-only)
      * папки моделей, extra_model_paths.yaml, .no-auto-update

    Модели НЕ скачиваются - они загружаются через UI студии.
    Папка upscale/bin в репозиторий не входит и установщиком не
    восстанавливается (проприетарный DLSS-рантайм NVIDIA).

.PARAMETER Root
    Папка проекта. По умолчанию - родительская для папки install.

.PARAMETER Force
    Переустановить всё заново (удаляет node_modules, ComfyUI, ноды, кэш).

.PARAMETER SkipApp
    Не трогать Node.js, node_modules и сборку приложения.

.PARAMETER SkipComfy
    Не трогать ComfyUI-часть (Python, пакеты, ноды).

.PARAMETER KeepCache
    Оставить скачанные архивы и pip-кэш (ускоряет повторную установку).

.PARAMETER NoPause
    Не ждать нажатия клавиши в конце.
#>
[CmdletBinding()]
param(
    [string]$Root,
    [switch]$Force,
    [switch]$SkipApp,
    [switch]$SkipComfy,
    [switch]$KeepCache,
    [switch]$NoPause
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
$Root = [IO.Path]::GetFullPath($Root)
$InstallDir = $PSScriptRoot
$Cache = Join-Path $Root '.install-cache'
$LogFile = Join-Path $Root 'install.log'
$StatusFile = Join-Path $Cache 'setup_status.json'

$script:Failures = New-Object System.Collections.Generic.List[string]
$script:Warnings = New-Object System.Collections.Generic.List[string]
$script:Python = $null

if ($Force -and (Test-Path $Cache)) {
    Remove-Item $Cache -Recurse -Force -ErrorAction SilentlyContinue
}

# pip-кэш в AppData иногда блокируется антивирусом (Permission denied при
# сохранении собранных wheel) — уводим кэш в локальный каталог установки.
$env:PIP_CACHE_DIR = Join-Path $Cache 'pip'

# (правка 752) остальные кэши - тоже внутрь папки проекта: npm/npx используют
# npm_config_cache, а загрузчик Electron (@electron/get) - ELECTRON_CACHE.
# Вся папка .install-cache удаляется в конце установки (см. очистку ниже).
$env:npm_config_cache = Join-Path $Cache 'npm'
$env:ELECTRON_CACHE = Join-Path $Cache 'electron'
$env:electron_config_cache = Join-Path $Cache 'electron'

# (правка 761) кэш uv - тоже внутрь папки проекта (удаляется вместе с .install-cache).
# uv качает и распаковывает пакеты параллельно, pip - по одному файлу.
$env:UV_CACHE_DIR = Join-Path $Cache 'uv'
$env:UV_HTTP_TIMEOUT = '120'
$env:UV_PYTHON_DOWNLOADS = 'never'

# ---------------------------------------------------------------- logging ---

function Write-Log {
    param([string]$Message, [string]$Level = 'info')
    $line = '[{0:HH:mm:ss}] {1}' -f (Get-Date), $Message
    $color = 'Gray'
    switch ($Level) {
        'ok'   { $color = 'Green' }
        'warn' { $color = 'Yellow' }
        'err'  { $color = 'Red' }
        'step' { $color = 'Cyan' }
    }
    Write-Host $Message -ForegroundColor $color
    try { Add-Content -Path $LogFile -Value $line -Encoding UTF8 } catch { }
}

function Step { param([int]$N, [int]$Total, [string]$Text) Write-SetupStatus 'running' $N $Total $Text; Write-Log '' ; Write-Log ("[{0}/{1}] {2}" -f $N, $Total, $Text) 'step' }
function Info { param([string]$M) Write-Log ("  " + $M) }
function Ok   { param([string]$M) Write-Log ("  [OK] " + $M) 'ok' }
function Warn { param([string]$M) $script:Warnings.Add($M); Write-Log ("  [WARN] " + $M) 'warn' }
function Fail { param([string]$M) $script:Failures.Add($M); Write-Log ("  [ERROR] " + $M) 'err' }

# (правка 748) Машиночитаемый статус установки для заставки:
# Electron (первый запуск без зависимостей) и страница /splash читают этот
# JSON и показывают «шаг N/9». pid — чтобы приложение могло убить
# установщик кнопкой «закрыть» (в т.ч. запущенный снаружи install.bat).
$script:StatusStep = 0
function Write-SetupStatus {
    param([string]$State, [int]$StepN = $script:StatusStep, [int]$TotalN = 9, [string]$Title = '')
    if ($StepN -gt 0) { $script:StatusStep = $StepN }
    $obj = [ordered]@{
        state = $State
        step  = $StepN
        total = $TotalN
        title = $Title
        pid   = $PID
        ts    = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    }
    try { Write-TextFileNoBom $StatusFile (ConvertTo-Json $obj -Compress) } catch { }
}

# ------------------------------------------------------------- primitives ---

$script:Curl = Join-Path $env:SystemRoot 'System32\curl.exe'
if (-not (Test-Path $script:Curl)) { $script:Curl = $null }
$script:UvExe = $null

# (правка 761) Быстрые загрузки.
# Один поток curl на файл 1.8 ГБ (torch) или 1 ГБ (ComfyUI) часто получает от
# сервера лишь часть полосы. Режем файл на 6 диапазонов и качаем параллельно;
# если сервер не умеет Range или что-то пошло не так - молча падаем на обычный
# однопоточный curl, ничего не ломая.
function Start-CurlProc {
    param([string]$ArgStr)
    try {
        return (Start-Process -FilePath $script:Curl -ArgumentList $ArgStr -NoNewWindow -PassThru -ErrorAction Stop)
    } catch {
        return (Start-Process -FilePath $script:Curl -ArgumentList $ArgStr -WindowStyle Hidden -PassThru)
    }
}

function Get-DownloadSegmented {
    param([string]$Url, [string]$Dest, [int]$Threads = 6, [int64]$MinSize = 16MB)
    if (-not $script:Curl) { return $false }
    $head = @()
    try { $head = @(& $script:Curl -sIL --fail --max-time 40 $Url 2>$null) } catch { return $false }
    if ($head.Count -eq 0) { return $false }
    $size = [int64]0
    $ranges = $false
    foreach ($line in $head) {
        if ($line -match '(?i)^content-length:\s*(\d+)') { $size = [int64]$Matches[1] }
        if ($line -match '(?i)^accept-ranges:\s*bytes') { $ranges = $true }
    }
    if (-not $ranges -or $size -lt $MinSize) { return $false }

    $n = [int][Math]::Min($Threads, 8)
    $chunk = [int64][Math]::Ceiling($size / $n)
    $parts = New-Object System.Collections.ArrayList
    $procs = New-Object System.Collections.ArrayList
    for ($i = 0; $i -lt $n; $i++) {
        $from = [int64]($i * $chunk)
        $to = [int64][Math]::Min($size - 1, ($from + $chunk - 1))
        if ($from -gt $to) { break }
        $p = $Dest + '.' + $i
        if (Test-Path $p) { Remove-Item $p -Force -ErrorAction SilentlyContinue }
        [void]$parts.Add($p)
        $argStr = '-sL --fail --retry 3 --retry-delay 2 --connect-timeout 30 -r ' + $from + '-' + $to + ' -o "' + $p + '" "' + $Url + '"'
        [void]$procs.Add((Start-CurlProc $argStr))
    }
    if ($procs.Count -lt 2) {
        foreach ($p in $parts) { Remove-Item $p -Force -ErrorAction SilentlyContinue }
        return $false
    }

    # ждём и раз в ~12 секунд пишем в лог, сколько уже скачано (видно в окне)
    $lastLog = Get-Date
    while ($true) {
        $alive = 0
        foreach ($pr in $procs) {
            try { if (-not $pr.HasExited) { $alive++ } } catch { }
        }
        if ($alive -eq 0) { break }
        if (((Get-Date) - $lastLog).TotalSeconds -ge 12) {
            $lastLog = Get-Date
            $got = [int64]0
            foreach ($p in $parts) { if (Test-Path $p) { $got += (Get-Item $p).Length } }
            Info ('  загружено ' + [Math]::Round($got / 1MB, 0) + ' из ' + [Math]::Round($size / 1MB, 0) + ' МБ')
        }
        Start-Sleep -Milliseconds 500
    }

    $got = [int64]0
    $bad = $false
    foreach ($p in $parts) {
        if (Test-Path $p) { $got += (Get-Item $p).Length } else { $bad = $true }
    }
    foreach ($pr in $procs) {
        # у процессов, запущенных через Start-Process -PassThru, ExitCode бывает
        # пустым - тогда верим только размеру (сумма частей = Content-Length)
        try {
            $code = $pr.ExitCode
            if ($null -ne $code -and $code -ne 0) { $bad = $true }
        } catch { }
    }
    if ($got -ne $size) { $bad = $true }
    if ($bad) {
        foreach ($p in $parts) { Remove-Item $p -Force -ErrorAction SilentlyContinue }
        Info '  параллельная загрузка не удалась - качаю обычным способом'
        return $false
    }

    try {
        $out = [IO.File]::Open($Dest, 'Create', 'Write')
        try {
            foreach ($p in $parts) {
                $in = [IO.File]::OpenRead($p)
                try { $in.CopyTo($out) } finally { $in.Dispose() }
            }
        } finally { $out.Dispose() }
    } catch {
        foreach ($p in $parts) { Remove-Item $p -Force -ErrorAction SilentlyContinue }
        return $false
    }
    foreach ($p in $parts) { Remove-Item $p -Force -ErrorAction SilentlyContinue }
    return $true
}

function Get-Download {
    param([string]$Url, [string]$Dest)
    if ((Test-Path $Dest) -and (Get-Item $Dest).Length -gt 0) {
        Info ("уже скачано: " + (Split-Path $Dest -Leaf))
        return
    }
    $dir = Split-Path -Parent $Dest
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $part = $Dest + '.part'
    if (Test-Path $part) { Remove-Item $part -Force -ErrorAction SilentlyContinue }
    Info ("скачивание: " + $Url)
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $ok = $false
    if ($script:Curl) {
        if (Get-DownloadSegmented -Url $Url -Dest $part) { $ok = $true }
    }
    if (-not $ok) {
        if ($script:Curl) {
            & $script:Curl -L --fail --retry 5 --retry-delay 3 --connect-timeout 30 --progress-bar -o $part $Url
            if ($LASTEXITCODE -eq 0 -and (Test-Path $part) -and (Get-Item $part).Length -gt 0) {
                $ok = $true
            } else {
                if (Test-Path $part) { Remove-Item $part -Force -ErrorAction SilentlyContinue }
            }
        } else {
            try {
                Invoke-WebRequest -Uri $Url -OutFile $part -UseBasicParsing
                $ok = $true
            } catch {
                $ok = $false
            }
        }
    }
    $sw.Stop()
    if (-not $ok) { throw ('не удалось скачать: ' + $Url) }
    Move-Item -Force $part $Dest
    $mb = (Get-Item $Dest).Length / 1MB
    $sec = [Math]::Max(0.5, $sw.Elapsed.TotalSeconds)
    Info ("скачано " + [Math]::Round($mb, 1) + " МБ за " + [Math]::Round($sec, 1) + " с (" + [Math]::Round($mb / $sec, 1) + " МБ/с)")
}

# (правка 761) Много мелких файлов параллельно (архивы кастомных нод с GitHub).
function Get-DownloadMany {
    param([object[]]$Jobs, [int]$Max = 6)
    if (-not $script:Curl) {
        foreach ($j in $Jobs) { try { Get-Download $j.Url $j.Dest } catch { } }
        return
    }
    $queue = New-Object System.Collections.Queue
    foreach ($j in $Jobs) { $queue.Enqueue($j) }
    $running = New-Object System.Collections.ArrayList
    while ($queue.Count -gt 0 -or $running.Count -gt 0) {
        while ($running.Count -lt $Max -and $queue.Count -gt 0) {
            $j = $queue.Dequeue()
            $dir = Split-Path -Parent $j.Dest
            if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
            $argStr = '-sL --fail --retry 3 --retry-delay 2 --connect-timeout 30 -o "' + $j.Dest + '" "' + $j.Url + '"'
            try {
                [void]$running.Add([pscustomobject]@{ P = (Start-CurlProc $argStr); Job = $j })
            } catch {
                Info ('  пропуск: ' + (Split-Path $j.Dest -Leaf))
            }
        }
        Start-Sleep -Milliseconds 250
        $finished = @($running | Where-Object { try { $_.P.HasExited } catch { $true } })
        foreach ($f in $finished) {
            $ok = (Test-Path $f.Job.Dest) -and ((Get-Item $f.Job.Dest).Length -gt 0)
            if ($ok) {
                try {
                    $code = $f.P.ExitCode
                    if ($null -ne $code -and $code -ne 0) { $ok = $false }
                } catch { }
            }
            if (-not $ok) {
                Remove-Item $f.Job.Dest -Force -ErrorAction SilentlyContinue
                Info ('  не скачалось: ' + (Split-Path $f.Job.Dest -Leaf))
            }
            [void]$running.Remove($f)
        }
    }
}


# (правка 744) Проверка доступности хоста: сначала curl.exe, потом
# Invoke-WebRequest. На части машин IWR падает на TLS (ложное «нет интернета»),
# хотя pip и GitHub работают — из-за этого установка обрывалась на шаге 1.
function Test-Host {
    param([string]$Url)
    $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
    if (Test-Path $curl) {
        & $curl -s -I -L --fail --max-time 25 $Url 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) { return $true }
    }
    try {
        $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 20 -Method Head
        return ($r.StatusCode -ge 200)
    } catch { return $false }
}

function Expand-ZipSafe {
    param([string]$Zip, [string]$Dest)
    if (-not (Test-Path $Dest)) { New-Item -ItemType Directory -Force -Path $Dest | Out-Null }
    $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
    if (Test-Path $tar) {
        & $tar -xf $Zip -C $Dest
        if ($LASTEXITCODE -ne 0) { throw ('не удалось распаковать архив: ' + $Zip) }
    } else {
        Expand-Archive -Path $Zip -DestinationPath $Dest -Force
    }
}

function Expand-TarGz {
    param([string]$Archive, [string]$Dest)
    if (-not (Test-Path $Dest)) { New-Item -ItemType Directory -Force -Path $Dest | Out-Null }
    $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
    if (-not (Test-Path $tar)) {
        throw 'tar.exe не найден: нужна Windows 10 1803+ (или распакуйте .tar.gz вручную).'
    }
    & $tar -xzf $Archive -C $Dest
    if ($LASTEXITCODE -ne 0) { throw ('не удалось распаковать архив: ' + $Archive) }
}

function Invoke-Pip {
    param([string[]]$PipArgs, [string]$Title)
    Info ('pip: ' + $Title)
    & $script:Python @PipArgs
    if ($LASTEXITCODE -ne 0) {
        Info 'повторяю без pip-кэша (возможна блокировка антивирусом)...'
        & $script:Python @PipArgs '--no-cache-dir'
        if ($LASTEXITCODE -ne 0) { throw ('pip завершился с ошибкой: ' + $Title) }
    }
}

# (правка 761) uv - быстрый установщик пакетов: качает до 50 файлов
# параллельно и распаковывает их тоже параллельно (pip - строго по одному).
# Если uv не скачался или упал - установка продолжается на pip как раньше.
function Install-Uv {
    if ($script:UvExe) { return $script:UvExe }
    $dir = Join-Path $Root 'runtime\uv'
    $exe = Join-Path $dir 'uv.exe'
    if (-not (Test-Path $exe)) {
        try {
            $zip = Join-Path $Cache 'uv-x86_64-pc-windows-msvc.zip'
            Get-Download 'https://github.com/astral-sh/uv/releases/download/0.13.6/uv-x86_64-pc-windows-msvc.zip' $zip
            Expand-ZipSafe $zip $dir
        } catch {
            Warn ('uv не скачался (' + $_.Exception.Message + ') - ставлю пакеты через pip, это медленнее')
        }
    }
    if (Test-Path $exe) {
        $script:UvExe = $exe
        Ok 'uv готов (параллельная установка пакетов)'
    } else {
        $script:UvExe = $null
    }
    return $script:UvExe
}

function Invoke-Uv {
    param([string[]]$UvArgs)
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $script:UvExe @UvArgs
    } finally {
        $ErrorActionPreference = $old
    }
    return $LASTEXITCODE
}

# Колесо torch для Windows ищется на индексе pytorch: точное имя + sha256.
function Get-WheelMeta {
    param([string]$IndexUrl, [string]$Package, [string]$Version)
    if (-not $script:Curl) { return $null }
    $page = $IndexUrl.TrimEnd('/') + '/' + $Package + '/'
    $html = @(& $script:Curl -sL --fail --max-time 60 $page 2>$null) -join "`n"
    if (-not $html) { return $null }
    $want = $Package + '-' + $Version + '+cu130-cp312-cp312-win_amd64.whl'
    foreach ($m in [regex]::Matches($html, 'href="([^"]+\.whl[^"]*)"')) {
        $href = $m.Groups[1].Value
        $sha = ''
        if ($href -match '#sha256=([0-9a-fA-F]+)') { $sha = $Matches[1].ToLower() }
        $clean = ($href -split '#')[0]
        $name = [uri]::UnescapeDataString($clean.Substring($clean.LastIndexOf('/') + 1))
        if ($name -eq $want) {
            return [pscustomobject]@{ Url = $clean; Name = $name; Sha256 = $sha }
        }
    }
    return $null
}

# torch/torchvision/torchaudio: качаем колёса сами в 6 соединений (1.8 ГБ одним
# потоком идёт очень долго), проверяем sha256 и ставим локально без сети.
# При любой проблеме возвращаем $false - вызывающий поставит через pip как раньше.
function Install-TorchWheels {
    $index = 'https://download.pytorch.org/whl/cu130'
    $wanted = @(
        @{ Name = 'torch'; Version = '2.11.0' },
        @{ Name = 'torchvision'; Version = '0.26.0' },
        @{ Name = 'torchaudio'; Version = '2.11.0' }
    )
    $files = @()
    foreach ($w in $wanted) {
        $meta = Get-WheelMeta $index $w.Name $w.Version
        if (-not $meta) { throw ('на индексе нет колеса ' + $w.Name + ' ' + $w.Version) }
        $dst = Join-Path $Cache ('wheels\' + $meta.Name)
        Get-Download $meta.Url $dst
        if ($meta.Sha256) {
            $h = (Get-FileHash $dst -Algorithm SHA256).Hash.ToLower()
            if ($h -ne $meta.Sha256) {
                Remove-Item $dst -Force -ErrorAction SilentlyContinue
                throw ('контрольная сумма не совпала: ' + $meta.Name)
            }
            Ok ('sha256 ок: ' + $meta.Name)
        }
        $files += $dst
    }
    if ($script:UvExe) {
        Info ('установка torch из локальных колёс (uv)')
        $uvArgs = @('pip', 'install', '--python', $script:Python, '--no-deps', '--no-progress') + $files
        if ((Invoke-Uv $uvArgs) -eq 0) {
            return $true
        }
        Warn 'uv не поставил torch - пробую pip'
    }
    Info 'установка torch из локальных колёс (pip)'
    & $script:Python -m pip install --no-deps --no-warn-script-location --disable-pip-version-check @files
    return ($LASTEXITCODE -eq 0)
}

# 288 пакетов из requirements.lock.txt ставим пачками через uv: так видно
# прогресс в окне и параллельно качается/распаковывается всё сразу.
function Install-RequirementsUv {
    param([string]$File, [int]$Batch = 60)
    if (-not $script:UvExe) { return $false }
    $lines = @(Get-Content $File | ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not $_.StartsWith('#') })
    if ($lines.Count -eq 0) { return $false }
    $i = 0
    while ($i -lt $lines.Count) {
        $last = [Math]::Min($i + $Batch - 1, $lines.Count - 1)
        $chunk = @($lines[$i..$last])
        $bf = Join-Path $Cache 'uv-batch.txt'
        [IO.File]::WriteAllLines($bf, $chunk, (New-Object Text.ASCIIEncoding))
        Info ('пакеты ' + ($i + 1) + '-' + ($last + 1) + ' из ' + $lines.Count)
        if ((Invoke-Uv @('pip', 'install', '--python', $script:Python, '--no-deps', '--no-progress', '-r', $bf)) -ne 0) {
            Warn ('uv не осилил пакеты ' + ($i + 1) + '-' + ($last + 1) + ' - доустанавливаю через pip')
            return $false
        }
        $i = $last + 1
    }
    return $true
}


function Write-TextFileNoBom {
    param([string]$Path, [string]$Content)
    $dir = Split-Path -Parent $Path
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    [IO.File]::WriteAllText($Path, $Content, (New-Object Text.UTF8Encoding($false)))
}

function Get-Tail {
    param([string]$Path, [int]$Lines = 15)
    if (-not (Test-Path $Path)) { return @() }
    return @(Get-Content $Path -Tail $Lines -ErrorAction SilentlyContinue)
}

# ------------------------------------------------------------------ banner ---

Write-Log ''
Write-Log '  ============================================================'
Write-Log '    MiniMax H3 Studio 7 - установка зависимостей'
Write-Log '  ============================================================'
Write-Log ''
Write-Log ('  Папка проекта: ' + $Root)
Write-Log ('  Лог:           ' + $LogFile)
if ($Force)     { Write-Log '  Режим:         полная переустановка (-Force)' }
if ($SkipApp)   { Write-Log '  Режим:         без Node.js и сборки (-SkipApp)' }
if ($SkipComfy) { Write-Log '  Режим:         без ComfyUI (-SkipComfy)' }
Write-Log ''

# ------------------------------------------------------- 1. проверки системы ---

Step 1 9 'Проверка системы'

if (-not [Environment]::Is64BitOperatingSystem) {
    throw 'Нужна 64-битная Windows (x64). 32-битные системы не поддерживаются.'
}
Ok 'Windows x64'

$freeGB = $null
try {
    $drive = (Get-Item $Root).PSDrive
    if ($drive) { $freeGB = [math]::Round($drive.Free / 1GB, 1) }
} catch { }

if ($null -ne $freeGB) {
    Info ("свободно на диске " + $drive.Name + ": " + $freeGB + " ГБ")
    if ($freeGB -lt 12) {
        throw ("Недостаточно места: нужно минимум 12 ГБ, свободно " + $freeGB + " ГБ.")
    }
    if ($freeGB -lt 25) {
        Warn ("свободно " + $freeGB + " ГБ. Рекомендуется 25+ ГБ: окружение занимает ~12 ГБ, плюс место под модели.")
    } else {
        Ok 'места достаточно'
    }
} else {
    Warn 'не удалось определить свободное место на диске'
}

# (правка 744) Проверяем не только pypi, но и GitHub (ComfyUI, ноды, STT):
# раньше установка обрывалась позже и с непонятной ошибкой, если GitHub закрыт.
if (-not (Test-Host 'https://pypi.org/simple/')) {
    throw 'Нет доступа к pypi.org. Проверьте подключение, VPN/прокси и запустите установку снова.'
}
Ok 'pypi.org доступен'

if (-not (Test-Host 'https://github.com')) {
    throw 'Нет доступа к github.com — без него не скачать ComfyUI, кастомные ноды и STT-рантайм. Проверьте VPN/прокси.'
}
Ok 'github.com доступен'

if (-not (Test-Host 'https://download.pytorch.org/whl/cu130/')) {
    Warn 'download.pytorch.org недоступен — шаг установки torch может не пройти (VPN/прокси).'
}

$nvidia = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if ($nvidia) {
    try {
        $gpu = (& nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>$null | Select-Object -First 1)
        Ok ('GPU: ' + $gpu)
    } catch {
        Warn 'nvidia-smi найден, но видеокарта не ответила'
    }
} else {
    Warn 'nvidia-smi не найден: не установлен драйвер NVIDIA. Студия сможет запуститься, но генерация без GPU невозможна.'
}

# ------------------------------------------------------------- 2. Node.js ---

if (-not $SkipApp) {
    Step 2 9 'Node.js'

    $nodeExe = 'node'
    $runtimeDir = Join-Path $Root 'runtime'
    $nodeOk = $false

    $sysNode = Get-Command node -ErrorAction SilentlyContinue
    if ($sysNode) {
        $verText = (& node --version 2>$null)
        if ($verText -match 'v(\d+)\.') {
            $major = [int]$Matches[1]
            if ($major -ge 18) {
                $nodeOk = $true
                $nodeExe = 'node'
                Ok ('Node.js в системе: ' + $verText)
            } else {
                Warn ('в системе Node.js ' + $verText + ' - слишком старый, ставлю портативный')
            }
        }
    } elseif (Test-Path (Join-Path $runtimeDir 'node.exe')) {
        $nodeOk = $true
        $nodeExe = Join-Path $runtimeDir 'node.exe'
        Ok 'найден портативный runtime\node.exe'
    }

    if (-not $nodeOk) {
        $nodeVersion = '22.20.0'
        $zip = Join-Path $Cache ('node-v' + $nodeVersion + '-win-x64.zip')
        Get-Download ('https://nodejs.org/dist/v' + $nodeVersion + '/node-v' + $nodeVersion + '-win-x64.zip') $zip
        $tmp = Join-Path $Cache 'node-extract'
        if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
        Expand-ZipSafe $zip $tmp
        $inner = Get-ChildItem $tmp -Directory | Select-Object -First 1
        if (Test-Path $runtimeDir) { Remove-Item $runtimeDir -Recurse -Force }
        New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
        Get-ChildItem $inner.FullName -Force | Move-Item -Destination $runtimeDir -Force
        Remove-Item $tmp -Recurse -Force
        $nodeExe = 'node'
        Ok ('Node.js ' + $nodeVersion + ' установлен в runtime\')
    }

    $env:PATH = $runtimeDir + ';' + $env:PATH
    $checkVer = (& node --version 2>$null)
    if (-not $checkVer) { throw 'Node.js не запускается после установки.' }

    $npmVersion = (& npm.cmd --version 2>$null)
    if (-not $npmVersion) {
        Warn 'npm не найден рядом с Node.js'
        throw 'npm недоступен. Установите Node.js 18+ с https://nodejs.org и запустите установщик снова.'
    }
    Ok ('npm ' + $npmVersion)
} else {
    Info 'пропущено (-SkipApp)'
}

# ------------------------------------------- 3. node_modules и сборка .next ---

if (-not $SkipApp) {
    Step 3 9 'Node-зависимости и production-сборка'

    Push-Location $Root
    try {
        if ($Force -and (Test-Path 'node_modules')) {
            Info 'удаляю node_modules (-Force)'
            Remove-Item 'node_modules' -Recurse -Force
        }

        # (правки 750/751) node_modules может быть битым: папки есть, а файлы
        # пакетов не читаются (обрыв установки, перенос копированием).
        # Проверяем, что ключевые пакеты реально разрешаются самим Node.js.
        $nmOk = $false
        if (Test-Path 'node_modules') {
            Push-Location $Root
            try {
                & $nodeExe -e "for (const p of ['next', 'electron', '@electron/get']) require.resolve(p)" 2>$null
                if ($LASTEXITCODE -eq 0) { $nmOk = $true }
            } finally { Pop-Location }
            if ($nmOk) {
                Ok 'node_modules уже на месте'
            } else {
                Warn 'node_modules поврежден (пакеты не читаются) - переустанавливаю'
                & cmd.exe /c "rmdir /s /q `"$(Join-Path $Root 'node_modules')`""
            }
        }
        if (-not $nmOk) {
            Info 'npm ci - скачивается ~1.2 ГБ, займёт 5-15 минут'
            & npm.cmd ci --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) {
                Warn 'npm ci не удался, пробую npm install'
                & npm.cmd install --no-audit --no-fund
                if ($LASTEXITCODE -ne 0) { throw 'не удалось установить node-зависимости (npm).' }
            }
            Push-Location $Root
            try {
                & $nodeExe -e "for (const p of ['next', 'electron', '@electron/get']) require.resolve(p)" 2>$null
                $nmVerified = ($LASTEXITCODE -eq 0)
            } finally { Pop-Location }
            if (-not $nmVerified) {
                throw 'npm отработал, но ключевые пакеты (next/electron) так и не читаются. Закройте все окна с install.bat, отключите антивирус на время установки и запустите install.bat ещё раз.'
            }
            Ok 'node_modules установлены'
        }

        # Electron 44+ больше не качает бинарник при npm ci: он скачивается
        # лениво при первом require('electron'). start.bat проверяет
        # node_modules\electron\dist\electron.exe и без него уходит в браузер,
        # поэтому качаем бинарник сразу, на этапе установки.
        $elDir = Join-Path $Root 'node_modules\electron'
        if (Test-Path $elDir) {
            if (Test-Path (Join-Path $elDir 'dist\electron.exe')) {
                Ok 'Electron уже скачан (окно приложения)'
            } else {
                Info 'скачиваю бинарник Electron (~110 МБ, один раз)...'
                Push-Location $Root
                try {
                    & $nodeExe (Join-Path $elDir 'install.js')
                } finally {
                    Pop-Location
                }
                if (Test-Path (Join-Path $elDir 'dist\electron.exe')) {
                    Ok 'Electron скачан: приложение откроется в отдельном окне'
                } else {
                    Warn 'Electron не скачался: start.bat откроет приложение в браузере. Запустите install.bat ещё раз.'
                }
            }
        }

        if ($Force -and (Test-Path '.next')) {
            Info 'удаляю старую сборку .next (-Force)'
            Remove-Item '.next' -Recurse -Force
        }

        if (-not (Test-Path '.next\BUILD_ID')) {
            Info 'npm run build - сборка Next.js, займёт 2-5 минут'
            & npm.cmd run build
            if ($LASTEXITCODE -ne 0) { throw 'сборка приложения (npm run build) завершилась ошибкой.' }
            Ok 'сборка .next готова'
        } else {
            Ok 'сборка .next уже есть'
        }

        # (правка 754) ffmpeg + ffprobe: refine («spawn ffprobe.exe ENOENT»),
        # продление (VHS_LoadVideo «Invalid video file»), превью — всем нужна
        # пара в runtime\ffmpeg. В офлайн-инсталляторе её нет: качаем статику.
        $ffDir = Join-Path $Root 'runtime\ffmpeg'
        if ((Test-Path (Join-Path $ffDir 'ffmpeg.exe')) -and (Test-Path (Join-Path $ffDir 'ffprobe.exe'))) {
            Ok 'ffmpeg + ffprobe уже на месте'
        } else {
            Info 'скачиваю ffmpeg + ffprobe (~130 МБ, один раз)...'
            $ffZip = Join-Path $Cache 'ffmpeg-win64-gpl.zip'
            Get-Download 'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip' $ffZip
            $ffTmp = Join-Path $Cache 'ffmpeg-extract'
            if (Test-Path $ffTmp) { Remove-Item $ffTmp -Recurse -Force -ErrorAction SilentlyContinue }
            Expand-ZipSafe $ffZip $ffTmp
            $ffExe = Get-ChildItem $ffTmp -Recurse -Filter 'ffmpeg.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
            if (-not $ffExe) { throw 'в архиве ffmpeg не найден ffmpeg.exe.' }
            $fpExe = Join-Path $ffExe.DirectoryName 'ffprobe.exe'
            if (-not (Test-Path $fpExe)) { throw 'в архиве ffmpeg не найден ffprobe.exe.' }
            New-Item -ItemType Directory -Force -Path $ffDir | Out-Null
            Copy-Item $ffExe.FullName (Join-Path $ffDir 'ffmpeg.exe') -Force
            Copy-Item $fpExe (Join-Path $ffDir 'ffprobe.exe') -Force
            Remove-Item $ffTmp -Recurse -Force -ErrorAction SilentlyContinue
            Ok 'ffmpeg + ffprobe установлены в runtime\ffmpeg'
        }
    } finally {
        Pop-Location
    }
} else {
    Info 'пропущено (-SkipApp)'
}

# ---------------------------------------------------- 4. ComfyUI и Python ---

$comfyRoot = Join-Path $Root 'ComfyUI-Easy-Install'
$comfyApp = Join-Path $comfyRoot 'ComfyUI'
$pythonDir = Join-Path $comfyRoot 'python_embeded'
$python = Join-Path $pythonDir 'python.exe'
$script:Python = $python

if (-not $SkipComfy) {
    Step 4 9 'ComfyUI (сборка 5f0c4e1)'

    if ($Force -and (Test-Path $comfyApp)) {
        Info 'удаляю ComfyUI (-Force)'
        Remove-Item $comfyApp -Recurse -Force
    }

    if (-not (Test-Path (Join-Path $comfyApp 'main.py'))) {
        if (Test-Path $comfyApp) { Remove-Item $comfyApp -Recurse -Force }
        $zip = Join-Path $Cache 'ComfyUI-5f0c4e1.zip'
        Get-Download 'https://github.com/comfyanonymous/ComfyUI/archive/5f0c4e18cb7e98f0e7c46c2c7ce928d641351e67.zip' $zip
        $tmp = Join-Path $Cache 'comfy-extract'
        if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
        Expand-ZipSafe $zip $tmp
        $inner = Get-ChildItem $tmp -Directory | Select-Object -First 1
        if (-not (Test-Path $comfyRoot)) { New-Item -ItemType Directory -Force -Path $comfyRoot | Out-Null }
        Move-Item $inner.FullName $comfyApp
        Remove-Item $tmp -Recurse -Force
        Ok 'ComfyUI распакован'
    } else {
        Ok 'ComfyUI уже на месте'
    }

    # Патчи проекта поверх ядра ComfyUI. Применяются при каждом запуске установщика,
    # поэтому повторный запуск чинит и уже испорченную установку.
    # Без них не работает часть узлов MiniMax H3:
    #   comfy/ldm/minimax/model.py      - слой to_gate_compress для VSA-весов,
    #                                     minimax_h3_layout и block_index для Veda;
    #   comfy/model_detection.py        - определение gate_compress в чекпоинтах VSA;
    #   comfy_extras/nodes_minimax_h3.py - правки keyframe-latent (правки 146/149);
    #   utils/extra_config.py           - списки путей в extra_model_paths.yaml
    #                                     (студия пишет их именно списками).
    $patchDir = Join-Path $InstallDir 'comfy-patches'
    if (Test-Path $patchDir) {
        $patched = 0
        Get-ChildItem $patchDir -Recurse -File | ForEach-Object {
            $rel = $_.FullName.Substring($patchDir.Length).TrimStart('\')
            $dest = Join-Path $comfyApp $rel
            $destDir = Split-Path $dest -Parent
            if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Force -Path $destDir | Out-Null }
            Copy-Item $_.FullName $dest -Force
            $patched++
        }
        Ok ('патчи проекта применены: ' + $patched + ' файл(а) ядра')
    } else {
        Warn 'папка install\comfy-patches не найдена: ядро ComfyUI останется без патчей проекта, узлы H3/VSA могут не работать.'
    }

    if ($Force -and (Test-Path $pythonDir)) {
        Info 'удаляю Python-окружение (-Force)'
        Remove-Item $pythonDir -Recurse -Force
    }

    if (-not (Test-Path $python)) {
        if (Test-Path $pythonDir) { Remove-Item $pythonDir -Recurse -Force }
        $zip = Join-Path $Cache 'python-3.12.10-embed-amd64.zip'
        Get-Download 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip' $zip
        Expand-ZipSafe $zip $pythonDir

        $getpip = Join-Path $Cache 'get-pip.py'
        Get-Download 'https://bootstrap.pypa.io/get-pip.py' $getpip
        & $python $getpip --no-warn-script-location
        if ($LASTEXITCODE -ne 0) { throw 'не удалось установить pip в портативный Python.' }
        Ok 'Python 3.12.10 установлен'
    } else {
        Ok 'Python уже на месте'
    }

    # Патчим python312._pth при каждом запуске (а не только при первой установке).
    # Строка ../ComfyUI обязательна: start.bat запускает python с ключом -I,
    # который отключает добавление папки скрипта в sys.path, и без неё
    # main.py падает с ModuleNotFoundError: No module named 'comfy'.
    $pth = Get-ChildItem $pythonDir -Filter 'python*._pth' | Select-Object -First 1
    if ($pth) {
        $lines = @(Get-Content $pth.FullName)
        $lines = @($lines | ForEach-Object { $_ -replace '^#\s*import site', 'import site' })
        if (-not ($lines | Where-Object { $_ -match '^Lib[\\/]site-packages' })) {
            $lines = @('Lib\site-packages') + $lines
        }
        if (-not ($lines | Where-Object { $_ -match '^\.\.[\\/]ComfyUI\s*$' })) {
            $lines = @('../ComfyUI') + $lines
        }
        if ($lines -match '^\.\./ComfyUI\s*$') {
            Ok 'python312._pth настроен (../ComfyUI + Lib\site-packages)'
        } else {
            Warn 'не удалось проверить python312._pth'
        }
        [IO.File]::WriteAllLines($pth.FullName, $lines, (New-Object Text.ASCIIEncoding))
    }

    # --- 5. библиотеки ---
    Step 5 9 'Библиотеки Python (~7 ГБ, самый долгий шаг)'

    # (правка 740) setuptools фиксируем на версии из requirements.lock.txt:
    # `--upgrade setuptools` без версии ставит новейшую (84.2.1+), а ComfyUI
    # требует setuptools<82 — на чистой машине установка падала (issue #4).
    Invoke-Pip @('-m', 'pip', 'install', '--upgrade', 'pip', 'setuptools==78.1.0', 'wheel', '--no-warn-script-location', '--disable-pip-version-check') 'обновление pip'

    # (правка 761) uv ставит пакеты параллельно - это в разы быстрее pip
    # на 288 пакетах. Не получилось - работаем на pip, как раньше.
    Install-Uv | Out-Null

    $torchOk = $false
    try {
        $torchOk = Install-TorchWheels
    } catch {
        Warn ('быстрая установка torch не удалась: ' + $_.Exception.Message)
    }
    if (-not $torchOk) {
        Invoke-Pip @('-m', 'pip', 'install',
            'torch==2.11.0+cu130', 'torchvision==0.26.0+cu130', 'torchaudio==2.11.0+cu130',
            '--index-url', 'https://download.pytorch.org/whl/cu130',
            '--no-warn-script-location', '--disable-pip-version-check') 'torch 2.11.0+cu130 (~3.5 ГБ)'
    }
    Ok 'torch установлен'

    $lockFile = Join-Path $InstallDir 'requirements.lock.txt'
    $lockDone = $false
    if ($script:UvExe) {
        $lockDone = Install-RequirementsUv $lockFile
    }
    if (-not $lockDone) {
        Invoke-Pip @('-m', 'pip', 'install', '--no-deps', '--no-warn-script-location', '--disable-pip-version-check',
            '-r', $lockFile) 'основные пакеты (288)'
    }
    Ok 'основные пакеты установлены'

    Invoke-Pip @('-m', 'pip', 'install', '--no-deps', '--no-build-isolation', '--no-warn-script-location', '--disable-pip-version-check',
        '-r', (Join-Path $InstallDir 'requirements.sdist.txt')) 'пакеты без готовых колёс (8)'
    Ok 'сборка из исходников завершена'

    $optionalFile = Join-Path $InstallDir 'requirements.optional.txt'
    if (Test-Path $optionalFile) {
        try {
            Invoke-Pip @('-m', 'pip', 'install', '--no-deps', '--no-build-isolation', '--no-warn-script-location', '--disable-pip-version-check', '-r', $optionalFile) 'необязательные пакеты'
            Ok 'необязательные пакеты установлены'
        } catch {
            Warn 'kornia_rs не собрался (нужен Rust). Это не критично: kornia работает без него, только чуть медленнее.'
        }
    }

    # --- 6. кастомные ноды ---
    Step 6 9 'Кастомные ноды (22 из GitHub + 4 локальные)'

    $nodesDir = Join-Path $comfyApp 'custom_nodes'
    if (-not (Test-Path $nodesDir)) { New-Item -ItemType Directory -Force -Path $nodesDir | Out-Null }

    $nodes = Get-Content (Join-Path $InstallDir 'nodes.json') -Raw | ConvertFrom-Json

    # (правка 761) 22 архива с GitHub качаем параллельно (6 потоков), а не
    # по одному: каждый мелкий запрос ждал TLS-рукопожатие.
    $pending = New-Object System.Collections.ArrayList
    foreach ($node in $nodes) {
        $zip = Join-Path $Cache ('nodes\' + $node.name + '.zip')
        if (-not (Test-Path $zip) -or (Get-Item $zip).Length -eq 0) {
            [void]$pending.Add([pscustomobject]@{
                Url  = ('https://codeload.github.com/' + $node.repo + '/zip/' + $node.sha)
                Dest = $zip
            })
        }
    }
    if ($pending.Count -gt 0) {
        Info ('параллельная загрузка нод: ' + $pending.Count)
        $swN = [Diagnostics.Stopwatch]::StartNew()
        Get-DownloadMany -Jobs $pending -Max 6
        $swN.Stop()
        $gotN = 0
        foreach ($j in $pending) { if (Test-Path $j.Dest) { $gotN += (Get-Item $j.Dest).Length } }
        Info ('ноды: ' + [Math]::Round($gotN / 1MB, 1) + ' МБ за ' + [Math]::Round($swN.Elapsed.TotalSeconds, 1) + ' с')
    }

    $idx = 0
    foreach ($node in $nodes) {
        $idx++
        $target = Join-Path $nodesDir $node.name
        Write-Progress -Activity 'Кастомные ноды' -Status $node.name -PercentComplete (($idx / $nodes.Count) * 100)

        if (Test-Path $target) {
            if (-not $Force) { Info ($node.name + ': уже установлена'); continue }
            Remove-Item $target -Recurse -Force
        }

        try {
            $zip = Join-Path $Cache ('nodes\' + $node.name + '.zip')
            Get-Download ('https://codeload.github.com/' + $node.repo + '/zip/' + $node.sha) $zip
            $tmp = Join-Path $Cache ('nodes\tmp-' + $node.name)
            if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
            Expand-ZipSafe $zip $tmp
            $inner = Get-ChildItem $tmp -Directory | Select-Object -First 1
            Move-Item $inner.FullName $target
            Remove-Item $tmp -Recurse -Force
            Ok ($node.name + ' @ ' + $node.sha.Substring(0, 7))
        } catch {
            Fail ($node.name + ': ' + $_.Exception.Message)
        }
    }
    Write-Progress -Activity 'Кастомные ноды' -Completed

    $localNodes = Join-Path $Root 'custom nodes'
    if (Test-Path $localNodes) {
        foreach ($dir in Get-ChildItem $localNodes -Directory) {
            $dest = Join-Path $nodesDir $dir.Name
            Copy-Item $dir.FullName $dest -Recurse -Force
            Ok ('локальная нода ' + $dir.Name)
        }
    } else {
        Warn 'папка "custom nodes" не найдена - собственные ноды студии не установлены'
    }
} else {
    Info 'пропущено (-SkipComfy)'
}

# --------------------------------------- 7. конфигурация и папки моделей ---

if (-not $SkipComfy) {
    Step 7 9 'Конфигурация и папки моделей'

    $flag = Join-Path $comfyRoot '.no-auto-update'
    if (-not (Test-Path $flag)) { New-Item -ItemType Directory -Force -Path $flag | Out-Null }
    Ok 'автообновление ComfyUI заблокировано (.no-auto-update)'

    $yaml = Join-Path $comfyApp 'extra_model_paths.yaml'
    if (-not (Test-Path $yaml)) {
        $yamlText = @(
            '# MiniMax Studio: дополнительные пути моделей.',
            '# Этот файл перезаписывается студией при изменении настроек моделей.',
            'minimax_studio_detectors:',
            '    ultralytics:',
            '        - "models/ultralytics"',
            ''
        ) -join "`r`n"
        Write-TextFileNoBom $yaml $yamlText
        Ok 'extra_model_paths.yaml создан'
    } else {
        Ok 'extra_model_paths.yaml уже есть'
    }

    $modelDirs = @(
        'diffusion_models', 'text_encoders', 'vae', 'vae_approx', 'latent_upscale_models',
        'loras', 'veda', 'ultralytics', 'llm', 'checkpoints', 'clip', 'clip_vision',
        'controlnet', 'embeddings', 'upscale_models', 'unet', 'style_models', 'audio_encoders',
        'gligen', 'hypernetworks', 'ipadapter', 'photomaker', 'sams', 'sam2', 'sam3',
        'insightface', 'facerestore_models', 'onnx', 'diffusers', 'model_patches',
        'configs', 't5', 'pulid', 'instantid', 't2i_adapter'
    )
    $modelsRoot = Join-Path $comfyApp 'models'
    foreach ($d in $modelDirs) {
        $p = Join-Path $modelsRoot $d
        if (-not (Test-Path $p)) { New-Item -ItemType Directory -Force -Path $p | Out-Null }
    }
    foreach ($d in @('input', 'output', 'temp')) {
        $p = Join-Path $comfyApp $d
        if (-not (Test-Path $p)) { New-Item -ItemType Directory -Force -Path $p | Out-Null }
    }
    Ok ('создано папок моделей: ' + $modelDirs.Count)

    if (-not (Test-Path (Join-Path $Root 'upscale\bin'))) {
        Warn 'вкладка Upscale не заработает: папки upscale\bin нет (это проприетарный DLSS-рантайм NVIDIA, в репозиторий он не входит).'
    }
}

# ------------------------------------------ 8. STT-рантайм (голосовой ввод) ---

if (-not $SkipApp) {
    Step 8 9 'Голосовой ввод (STT-рантайм transcribe.cpp)'

    $sttDir = Join-Path $Root 'stt'
    $sttDll = Join-Path $sttDir 'transcribe.dll'
    $sttModels = Join-Path $sttDir 'models'
    if (-not (Test-Path $sttModels)) { New-Item -ItemType Directory -Force -Path $sttModels | Out-Null }

    if (Test-Path $sttDll) {
        Ok 'STT-рантайм уже на месте'
    } else {
        # (правка 744) Раньше папка stt/ не восстанавливалась, поэтому голосовой
        # ввод не работал ни у кого после чистой установки. transcribe.cpp —
        # MIT, официальные Windows-сборки лежат на GitHub. Версия v0.1.3:
        # именно с ней сверен ABI в tools/stt_server.py.
        $sttVersion = '0.1.3'
        $sttAsset = 'transcribe-native-0.1.3-windows-x86_64-cpu-vulkan.tar.gz'
        $sttSha = '9f536cb0fb839bd305e6d92fb214fd417c7718a416a6c7646a9911fbd56fdad5'
        try {
            $sttArchive = Join-Path $Cache $sttAsset
            Get-Download ('https://github.com/handy-computer/transcribe.cpp/releases/download/v' + $sttVersion + '/' + $sttAsset) $sttArchive
            $hash = (Get-FileHash $sttArchive -Algorithm SHA256).Hash.ToLower()
            if ($hash -ne $sttSha) { throw 'контрольная сумма архива не совпала' }

            $tmp = Join-Path $Cache 'stt-extract'
            if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
            Expand-TarGz $sttArchive $tmp
            $inner = Get-ChildItem $tmp -Directory | Select-Object -First 1
            if (-not $inner) { throw 'архив STT пуст' }

            New-Item -ItemType Directory -Force -Path $sttDir | Out-Null
            # Студия просит backend CPU, поэтому ggml-vulkan.dll (74 МБ) не нужен.
            Get-ChildItem $inner.FullName -Filter *.dll |
                Where-Object { $_.Name -ne 'ggml-vulkan.dll' } |
                ForEach-Object { Copy-Item $_.FullName (Join-Path $sttDir $_.Name) -Force }
            $contract = Join-Path $inner.FullName 'contract.json'
            if (Test-Path $contract) { Copy-Item $contract (Join-Path $sttDir 'contract.json') -Force }
            $licenses = Join-Path $inner.FullName 'licenses'
            if (Test-Path $licenses) { Copy-Item $licenses (Join-Path $sttDir 'licenses') -Recurse -Force }
            Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue

            if (Test-Path $sttDll) {
                Ok ('STT-рантайм ' + $sttVersion + ' установлен (CPU, MIT)')
            } else {
                throw 'transcribe.dll не появился после распаковки'
            }
        } catch {
            Warn ('голосовой ввод не заработает: ' + $_.Exception.Message + ' Папку stt можно скопировать с рабочей машины.')
        }
    }

    $modelFiles = @(Get-ChildItem $sttModels -File -ErrorAction SilentlyContinue)
    if ($modelFiles.Count -eq 0) {
        Info 'модель распознавания не входит в установку: Настройки -> Голос -> скачать модель (ggml-small ~466 МБ)'
    } else {
        Ok ('модель распознавания: ' + $modelFiles[0].Name)
    }
} else {
    Info 'пропущено (-SkipApp)'
}

# -------------------------------------------------------- 9. проверка ---

if (-not $SkipComfy) {
    Step 9 9 'Проверка установки'

    Info 'проверяю импорт torch...'
    & $python -c "import torch, torchvision, torchaudio; print('      torch', torch.__version__, '| cuda:', torch.cuda.is_available())"
    if ($LASTEXITCODE -ne 0) { Fail 'torch не импортируется' } else { Ok 'torch работает' }

    Info 'проверяю ключевые библиотеки...'
    & $python -c "import cv2, numpy, scipy, transformers, safetensors, comfy_kitchen; print('      cv2', cv2.__version__, '| numpy', numpy.__version__)"
    if ($LASTEXITCODE -ne 0) { Fail 'часть библиотек не импортируется' } else { Ok 'ключевые библиотеки работают' }

    Info 'проверяю импорт ComfyUI и всех нод (пробный запуск, 1-3 минуты)...'
    $outLog = Join-Path $Cache 'smoke-out.log'
    $errLog = Join-Path $Cache 'smoke-err.log'
    if (Test-Path $outLog) { Remove-Item $outLog -Force }
    if (Test-Path $errLog) { Remove-Item $errLog -Force }
    $proc = $null
    try {
        $proc = Start-Process -FilePath $python -WorkingDirectory $comfyApp -PassThru -NoNewWindow `
            -ArgumentList @('-I', 'main.py', '--windows-standalone-build', '--cpu', '--disable-auto-launch', '--port', '8199') `
            -RedirectStandardOutput $outLog -RedirectStandardError $errLog

        $ready = $false
        for ($i = 0; $i -lt 90; $i++) {
            Start-Sleep -Seconds 2
            if ($proc.HasExited) { break }
            try {
                $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8199/system_stats' -UseBasicParsing -TimeoutSec 3
                if ($r.StatusCode -eq 200) { $ready = $true; break }
            } catch { }
        }

        if ($ready) {
            Ok 'ComfyUI стартует, сервер отвечает'
        } else {
            Fail 'ComfyUI не поднялся за 180 секунд - смотрите install.log'
            foreach ($l in Get-Tail $outLog 20) { Write-Log ('      ' + $l) }
            foreach ($l in Get-Tail $errLog 20) { Write-Log ('      ' + $l) }
        }

        $importErrors = @()
        if (Test-Path $outLog) {
            $importErrors = @(Get-Content $outLog -ErrorAction SilentlyContinue | Where-Object { $_ -match 'IMPORT FAILED|Cannot import|ModuleNotFoundError' })
        }
        if ($importErrors.Count -gt 0) {
            Warn ('ноды с ошибками импорта: ' + $importErrors.Count)
            foreach ($l in ($importErrors | Select-Object -First 10)) { Write-Log ('      ' + $l.Trim()) }
        } elseif ($ready) {
            Ok 'все кастомные ноды загрузились без ошибок'
        }
    } catch {
        Warn ('пробный запуск не удался: ' + $_.Exception.Message)
    } finally {
        if ($proc -and -not $proc.HasExited) {
            Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 2
        }
        try {
            Get-CimInstance Win32_Process -Filter "ParentProcessId=$($proc.Id)" -ErrorAction SilentlyContinue |
                ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        } catch { }
    }
}

# ------------------------------------------------------------ очистка ---

if (-not $KeepCache) {
    if (Test-Path $Cache) {
        Info 'удаляю временные архивы и кэши (pip, npm, electron)...'
        Remove-Item $Cache -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# ------------------------------------------------------------ итог ---

Write-Log ''
Write-Log '  ============================================================'
if ($script:Failures.Count -eq 0) {
    Write-Log '   УСТАНОВКА ЗАВЕРШЕНА' 'ok'
} else {
    Write-Log ('   УСТАНОВКА ЗАВЕРШЕНА С ОШИБКАМИ: ' + $script:Failures.Count) 'err'
    foreach ($f in $script:Failures) { Write-Log ('   - ' + $f) 'err' }
}
Write-Log '  ============================================================'

if ($script:Warnings.Count -gt 0) {
    Write-Log ''
    Write-Log '  Предупреждения:' 'warn'
    foreach ($w in $script:Warnings) { Write-Log ('   - ' + $w) 'warn' }
}

Write-Log ''
Write-Log '  Дальше:'
Write-Log '    1. Запустите start.bat'
Write-Log '    2. Откройте Настройки -> Модели и скачайте нужные модели'
Write-Log '       (они большие: diffusion ~23 ГБ, text encoder ~16 ГБ и т.д.)'
Write-Log '    3. После скачивания моделей можно генерировать'
Write-Log ''
Write-Log ('  Полный лог: ' + $LogFile)
Write-Log ''

$exitCode = 0
if ($script:Failures.Count -gt 0) { $exitCode = 1 }

# финальный статус — ПОСЛЕ очистки кэша (Write-TextFileNoBom сам создаёт
# папку): Electron дожидается done/error и только затем поднимает ComfyUI.
if ($exitCode -eq 0) {
    Write-SetupStatus 'done' 9 9 'Установка завершена'
} else {
    Write-SetupStatus 'error' $script:StatusStep 9 ('Установка завершилась с ошибками (шаг ' + $script:StatusStep + ')')
}

if (-not $NoPause) {
    Write-Host '  Нажмите Enter, чтобы закрыть окно...' -ForegroundColor DarkGray
    try { [void](Read-Host) } catch { }
}

exit $exitCode
