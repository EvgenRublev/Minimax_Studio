#Requires -Version 5.1
<#
.SYNOPSIS
    MiniMax H3 Studio - автоматическая установка зависимостей.

.DESCRIPTION
    Восстанавливает окружение проекта на чистой машине Windows x64:
      * Node.js 22 (портативный, если в системе нет 18+)
      * node_modules + production-сборку .next
      * ComfyUI 0.44.0 + Python 3.12.10 + torch 2.11.0+cu130 + 288 пакетов
      * 22 кастомные ноды по зафиксированным коммитам + 5 локальных нод
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

.PARAMETER SelfCheck
    Только проверка уже установленной студии: Node, node_modules, сборка,
    ядро ComfyUI, Python+torch, кастом-ноды, патчи ядра, пути моделей. Ничего
    не устанавливает и не скачивает - нужно, когда «вчера работало, сегодня нет».

.PARAMETER Deep
    В связке с -SelfCheck: дополнительно сверить sha256 архивов в .install-cache
    и офлайн-бандла install\\cache (медленнее, зато видно битые файлы).
#>
[CmdletBinding()]
param(
    [string]$Root,
    [switch]$Force,
    [switch]$SkipApp,
    [switch]$SkipComfy,
    [switch]$KeepCache,
    [switch]$NoPause,
    [switch]$SelfCheck,
    [switch]$Deep
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

$script:SelfCheckMode = [bool]($SelfCheck -or $Deep)
$script:Failures = New-Object System.Collections.Generic.List[string]
$script:Warnings = New-Object System.Collections.Generic.List[string]
$script:Python = $null

if ($Force -and (Test-Path $Cache)) {
    Remove-Item $Cache -Recurse -Force -ErrorAction SilentlyContinue
}

# pip-кэш в AppData иногда блокируется антивирусом (Permission denied при
# сохранении собранных wheel) — уводим кэш в локальный каталог установки.
$env:PIP_CACHE_DIR = Join-Path $Cache 'pip'

# (правка 776) pip по умолчанию ждёт ответа 15 с: на медленном/нестабильном
# канале один «тугой» пакет роняет установку или заставляет pip перекачивать
# его заново. Даём терпеливый таймаут и явные повторы.
$env:PIP_DEFAULT_TIMEOUT = '60'
$env:PIP_RETRIES = '5'

# (правка 752) остальные кэши - тоже внутрь папки проекта: npm/npx используют
# npm_config_cache, а загрузчик Electron (@electron/get) - ELECTRON_CACHE.
# Вся папка .install-cache удаляется в конце установки (см. очистку ниже).
$env:npm_config_cache = Join-Path $Cache 'npm'

# (правка 776) npm по умолчанию делает всего 2 попытки на каждый запрос в registry:
# на нестабильном канале 5xx с npm-реестра роняет всё npm ci после минут ожидания.
$env:npm_config_fetch_retries = '5'
$env:npm_config_fetch_retry_maxtimeout = '120000'
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

function Info { param([string]$M) Write-Log ("  " + $M) }
function Ok   { param([string]$M) Write-Log ("  [OK] " + $M) 'ok' }
function Warn { param([string]$M) $script:Warnings.Add($M); Write-Log ("  [WARN] " + $M) 'warn' }
function Fail { param([string]$M) $script:Failures.Add($M); Write-Log ("  [ERROR] " + $M) 'err' }

# (правка 748) Машиночитаемый статус установки для заставки:
# Electron (первый запуск без зависимостей) и страница /splash читают этот
# JSON и показывают «шаг N/9». pid — чтобы приложение могло убить
# установщик кнопкой «закрыть» (в т.ч. запущенный снаружи install.bat).
$script:StatusStep = 0
$script:StatusTitle = ''
$script:StatusState = 'idle'
$script:StatusHint = ''
$script:SpeedMBs = 0
$script:SpeedDetail = ''
# (правка 943) точка отсчёта «сколько идёт установка» определяется здесь, а не в
# блоке heartbeat: Write-SetupStatus тоже пишет elapsed_min, и trap может вызвать
# её раньше heartbeat.
$script:StatusStartedAt = Get-Date
# (правка 941) Статус читают чужие процессы (Electron, заставка, окно
# установки), поэтому пишем атомарно: временный файл + Replace. Иначе читатель
# может поймать половину JSON посреди записи - в том числе когда рядом пишет
# heartbeat.
function Write-StatusJsonAtomic {
    param([string]$Json)
    $d = Split-Path -Parent $StatusFile
    if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
    $tmp = $StatusFile + '.tmp'
    $enc = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($tmp, $Json, $enc)
    try {
        if (Test-Path -LiteralPath $StatusFile) { [IO.File]::Replace($tmp, $StatusFile) }
        else { [IO.File]::Move($tmp, $StatusFile) }
    } catch {
        try { [IO.File]::Copy($tmp, $StatusFile, $true); [IO.File]::Delete($tmp) } catch { }
    }
}
function Write-SetupStatus {
    # (правка 942) $Hint сознательно БЕЗ [string]: в PowerShell объявление
    # [string]$Hint = $null приводит значение по умолчанию к пустой строке, и
    # проверка ($null -ne $Hint) всегда истина - каждый вызов Set-Speed/Step без
    # -Hint стирал подсказку (в прогоне на D: hint был пустой уже на шаге 5).
    param([string]$State, [int]$StepN = $script:StatusStep, [int]$TotalN = 9, [string]$Title = '', $Hint = $null)
    if ($StepN -gt 0) { $script:StatusStep = $StepN }
    $script:StatusState = $State
    if ($Title) { $script:StatusTitle = $Title }
    # (правка 941) hint - что делать пользователю, log - где смотреть подробности.
    # Раньше причина влезала в одну строку окна установки и обрезалась, а путь к
    # логу юзер искал сам.
    if ($null -ne $Hint) { $script:StatusHint = [string]$Hint }
    $obj = [ordered]@{
        state  = $State
        step   = $StepN
        total  = $TotalN
        title  = $script:StatusTitle
        hint   = $script:StatusHint
        log    = $LogFile
        speed  = $script:SpeedMBs
        detail = $script:SpeedDetail
        # (правка 942) отдельное поле для heartbeat: текстовые поля трогает только
        # установщик, heartbeat пишет сюда целое число минут. (правка 943) его пишет
        # и Write-SetupStatus - иначе между записью шага и ближайшим тиком heartbeat
        # счётчик «идёт N мин» обнуляется.
        elapsed_min = $(if ($script:StatusStartedAt) { [int][Math]::Floor(((Get-Date) - $script:StatusStartedAt).TotalMinutes) } else { 0 })
        pid    = $PID
        ts     = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    }
    try { Write-StatusJsonAtomic (ConvertTo-Json $obj -Compress) } catch { }
}

function Step {
    param([int]$N, [int]$Total, [string]$Text, [string]$Hint = '')
    $script:SpeedMBs = 0; $script:SpeedDetail = ''
    Write-SetupStatus 'running' $N $Total $Text $Hint
    Write-Log ''
    Write-Log ("[{0}/{1}] {2}" -f $N, $Total, $Text) 'step'
}

# (правка 762) текущая скорость загрузки (МБ/с) + пояснение «загружено X из Y»
# для окна установки: видно, качается или процесс встал.
function Set-Speed {
    param([double]$MBps, [string]$Detail = '')
    if ($MBps -lt 0) { $MBps = 0 }
    $script:SpeedMBs = [Math]::Round($MBps, 1)
    if ($Detail) { $script:SpeedDetail = $Detail }
    Write-SetupStatus $script:StatusState
}

# (правка 941) Heartbeat статуса. Долгие шаги (пакеты Python ~15 ГБ, сборка,
# smoke-запуск ComfyUI) раньше молчали десятками минут: заставка считает статус
# неживым, если ts старше 12 минут, и показывала «установка не идёт». Раз в 10 с
# освежаем ts и пишем elapsed_min - сколько минут шаг идёт. Пишется из отдельного
# runspace'а, основного потока не блокирует.
#
# (правка 942) Две защиты, обе из живого прогона установки:
#   • файл статуса читаем байтами как UTF-8. Get-Content без -Encoding в PowerShell
#     5.1 читает UTF-8 без BOM как ANSI, кириллица превращается в кракозябры, и
#     любая работа с текстом detail ломается (в прогоне на D: detail удваивался за
#     тик и файл разросся до 1,6 ГБ);
#   • detail heartbeat НЕ трогает вообще - только числовое elapsed_min, причём
#     перед записью проверяем размер файла. Текстовые поля добавляет установщик.
$script:Heartbeat = $null
$script:HeartbeatMaxBytes = 200000
function Start-StatusHeartbeat {
    if ($script:Heartbeat) { return }
    if (-not $script:HeartbeatMaxBytes) { $script:HeartbeatMaxBytes = 200000 }
    try {
        $rs = [System.Management.Automation.Runspaces.RunspaceFactory]::CreateRunspace()
        $rs.Open()
        $ps = [System.Management.Automation.PowerShell]::Create()
        $ps.Runspace = $rs
        [void]$ps.AddScript({
            param([string]$file, [string]$startedIso, [int]$everySec, [int]$maxBytes)
            while ($true) {
                Start-Sleep -Seconds $everySec
                try {
                    $fi = New-Object System.IO.FileInfo($file)
                    if (-not $fi.Exists) { continue }
                    if ($fi.Length -gt $maxBytes) { continue }
                    # UTF-8 явно: PS 5.1 по умолчанию читает без BOM как ANSI
                    $j = ([System.IO.File]::ReadAllText($file, [System.Text.Encoding]::UTF8)) | ConvertFrom-Json
                    if ($j.state -ne 'running') { break }
                    $started = [DateTime]::Parse($startedIso)
                    $j.ts = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
                    $j | Add-Member -NotePropertyName elapsed_min -NotePropertyValue ([int][Math]::Floor(((Get-Date) - $started).TotalMinutes)) -Force
                    $tmp = $file + '.tmp'
                    [System.IO.File]::WriteAllText($tmp, ($j | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
                    try { [System.IO.File]::Replace($tmp, $file) } catch { [System.IO.File]::Copy($tmp, $file, $true); [System.IO.File]::Delete($tmp) }
                } catch { }
            }
        }).AddArgument($StatusFile).AddArgument($script:StatusStartedAt.ToString('o')).AddArgument(10).AddArgument($script:HeartbeatMaxBytes)
        $script:Heartbeat = [pscustomobject]@{ PS = $ps; Rs = $rs; Async = $ps.BeginInvoke() }
    } catch {
        $script:Heartbeat = $null
    }
}
function Stop-StatusHeartbeat {
    if (-not $script:Heartbeat) { return }
    try { $script:Heartbeat.PS.Stop() } catch { }
    try { $script:Heartbeat.PS.Dispose() } catch { }
    try { $script:Heartbeat.Rs.Dispose() } catch { }
    $script:Heartbeat = $null
}

# (правка 789) Глобальная страховка: ErrorActionPreference='Stop', и любая
# непойманная ошибка (например, скачивание, окончательно упавшее после всех
# повторов) раньше просто обрывала скрипт: окно установки показывало
# «завершилась без отчёта», а причину искали вручную в install.log. Теперь
# ошибка пишется в лог и в статус (state=error) — окно сразу видит причину.
trap {
    $where = ''
    if ($_.InvocationInfo -and $_.InvocationInfo.PositionMessage) {
        $where = ' (' + ($_.InvocationInfo.PositionMessage -replace '\s+', ' ') + ')'
    }
    try { Write-Log ('НЕПРЕДВЗЯТАЯ ОШИБКА: ' + $_.Exception.Message + $where) 'err' } catch { }
    # (правка 941) heartbeat пишет статус из своего потока - глушим его до записи
    # итогового state=error, иначе он перезатрёт ошибку.
    try { if (Get-Command Stop-StatusHeartbeat -ErrorAction SilentlyContinue) { Stop-StatusHeartbeat } } catch { }
    # (правка 944) В режиме самодиагностики (diagnostics.bat -SelfCheck) не трогаем
    # ни кэш, ни статус установки: раньше trap на любом непойманном исключении
    # сносил файлы из .install-cache и писал state=error поверх статуса «done».
    if (-not $script:SelfCheckMode) {
        # (правка 939) Испортилось что-то одно - не тащим это через все повторные
        # запуски: выкидываем из кэша файлы, которые не являются ожидаемыми архивами.
        # Функция объявлена ниже по файлу, поэтому проверяем, что она уже существует.
        try {
            if (Get-Command Clear-CorruptCache -ErrorAction SilentlyContinue) { Clear-CorruptCache }
        } catch { }
        try {
            $hint = 'Подробности - в файле install.log (путь в этой строке). Повторный запуск продолжает установку с того же места; битые архивы из кэша удалены автоматически.'
            Write-SetupStatus 'error' $script:StatusStep 9 ('Установка прервана: ' + $_.Exception.Message) $hint
        } catch { }
    }
    exit 1
}

# ------------------------------------------------------------- primitives ---

$script:Curl = Join-Path $env:SystemRoot 'System32\curl.exe'
if (-not (Test-Path $script:Curl)) { $script:Curl = $null }
$script:UvExe = $null

# (правка 939) Целостность скачанного. Самый частый отказ у юзеров: в
# .install-cache остаётся оборванный архив или HTML-страница прокси/портала
# вместо архива. Прежний Get-Download считал такой файл «уже скачано» (файл
# есть, байт > 0), и каждый следующий запуск умирал на «не удалось распаковать
# архив» ровно в той же точке на 0%. Теперь:
#   • любой архив (из сети, из бандла и из кэша прошлого запуска) проверяется
#     по магическим байтам - «это вообще тот тип архива, который мы ждём»;
#   • install\checksums.json (scripts/make-installer-cache.mjs) даёт sha256 и
#     размер для артефактов, которые неизменяемы: nodejs.org, python.org,
#     релизные ассеты GitHub (electron, uv). Для них сверяется и сеть, и бандл;
#   • архивы тегов GitHub (ComfyUI, зипи кастом-нод через codeload) GitHub
#     пересобирает не байт-в-байт, поэтому для скачанного из сети проверяется
#     только «это архив?», а sha - только у бандла установщика;
#   • битый файл удаляется вместе с .part и сегментами докачки, иначе следующий
#     запуск склеит те же битые байты.
$script:Pins = @{}
$script:IntegrityError = ''
$pinFile = Join-Path $InstallDir 'checksums.json'
if (Test-Path -LiteralPath $pinFile) {
    try {
        $pinJson = (Get-Content -LiteralPath $pinFile -Raw -Encoding UTF8 | ConvertFrom-Json)
        if ($pinJson -and $pinJson.files) {
            foreach ($prop in $pinJson.files.PSObject.Properties) {
                $key = ([string]$prop.Name).ToLowerInvariant().Replace('\', '/')
                $script:Pins[$key] = [pscustomobject]@{
                    Rel    = [string]$prop.Name
                    Sha256 = ([string]$prop.Value.sha256).ToLowerInvariant()
                    Size   = [int64]$prop.Value.size
                    Kind   = [string]$prop.Value.kind
                    Pinned = [bool]$prop.Value.pinned
                }
            }
            Info (('сведений о контрольных суммах: {0} файл(ов)' -f $script:Pins.Count))
        }
    } catch { }
}

# Путь внутри .install-cache относительно кэша ('nodes/foo.zip'); '' - вне кэша.
function Get-CacheRel {
    param([string]$Path)
    try {
        $full = [IO.Path]::GetFullPath($Path)
        $base = [IO.Path]::GetFullPath($Cache)
        if (-not $full.StartsWith($base, [StringComparison]::OrdinalIgnoreCase)) { return '' }
        return (($full.Substring($base.Length).TrimStart('\', '/')) -replace '\\', '/')
    } catch { return '' }
}

function Get-PinFor {
    param([string]$Path, [string]$Rel = '')
    if (-not $Rel) { $Rel = Get-CacheRel $Path }
    if (-not $Rel) { return $null }
    $key = $Rel.ToLowerInvariant().Replace('\', '/')
    if ($script:Pins.ContainsKey($key)) { return $script:Pins[$key] }
    return $null
}

# Какой архив мы ждём по имени файла ('' - не архив, проверять нечего).
function Get-ExpectedKind {
    param([string]$Path)
    $p = $Path.ToLowerInvariant()
    if ($p.EndsWith('.zip') -or $p.EndsWith('.whl')) { return 'zip' }
    if ($p.EndsWith('.tar.gz') -or $p.EndsWith('.tgz')) { return 'gzip' }
    if ($p.EndsWith('.exe')) { return 'exe' }
    # (правка 944) get-pip.py - единственный не-архив, который мы качаем с сети.
    # Магических байтов у него нет, поэтому HTML-страница прокси/портала проходила
    # все проверки 939 и навсегда оставалась в кэше: pip не ставился ни разу,
    # каждый запуск падал на «не удалось установить pip». Проверяем содержимое.
    # Условие по имени, а не по расширению: в pip/uv-кэше тоже есть .py.
    if ((Split-Path -Leaf $Path) -ieq 'get-pip.py') { return 'pyscript' }
    return ''
}

function Read-HeadBytes {
    param([string]$Path, [int]$Count = 4)
    try {
        $fs = [IO.File]::OpenRead($Path)
        try {
            $buf = New-Object byte[] $Count
            $n = $fs.Read($buf, 0, $Count)
            if ($n -le 0) { return $null }
            if ($n -lt $Count) { return $buf[0..($n - 1)] }
            return $buf
        } finally { $fs.Dispose() }
    } catch { return $null }
}

function Get-HeadKind {
    param([byte[]]$Head)
    if (-not $Head -or $Head.Length -lt 2) { return '' }
    if ($Head[0] -eq 0x50 -and $Head[1] -eq 0x4B) { return 'zip' }
    if ($Head[0] -eq 0x1F -and $Head[1] -eq 0x8B) { return 'gzip' }
    if ($Head[0] -eq 0x4D -and $Head[1] -eq 0x5A) { return 'exe' }
    return ''
}

# (правка 944) Проверка get-pip.py: это python-скрипт, а не архив. Признаки
# подмены (страница прокси, «портал», обрезанный файл) видны по началу файла:
# у скрипта первые килобайты - shebang/докстринг/import, у HTML - '<'.
function Test-TextScript {
    param([string]$Path)
    try {
        $len = (Get-Item -LiteralPath $Path).Length
        if ($len -lt 1024) {
            $script:IntegrityError = ('слишком маленький файл для python-скрипта: ' + $len + ' байт')
            return $false
        }
        $take = [int][Math]::Min(4096, $len)
        $text = ''
        $fs = [IO.File]::OpenRead($Path)
        try {
            $buf = New-Object byte[] $take
            $n = $fs.Read($buf, 0, $take)
            if ($n -gt 0) { $text = [Text.Encoding]::UTF8.GetString($buf, 0, $n) }
        } finally { $fs.Dispose() }
        $head = $text.TrimStart()
        if (-not $head) { $script:IntegrityError = 'файл пустой'; return $false }
        if ($head.StartsWith('<')) {
            $script:IntegrityError = 'это HTML-страница (прокси/портал), а не python-скрипт'
            return $false
        }
        if ($head -notmatch '(?m)^\s*(import\s|from\s+\S+\s+import\s|#!)') {
            $script:IntegrityError = 'в начале файла нет python-кода'
            return $false
        }
        return $true
    } catch {
        $script:IntegrityError = 'файл не читается'
        return $false
    }
}

# Годен ли файл как архив ожидаемого типа. Причина отказа - в
# $script:IntegrityError. -CheckPin сверяет sha256/размер для неизменяемых
# артефактов (pin.pinned), -BundleSha - для файлов самого установщика: они
# заморожены, поэтому сумма обязана совпадать даже у архивов тегов GitHub.
function Test-ArchiveFile {
    param([string]$Path, [string]$Rel = '', [string]$Kind = '', [switch]$CheckPin, [switch]$BundleSha)
    $script:IntegrityError = ''
    if (-not (Test-Path -LiteralPath $Path)) { $script:IntegrityError = 'файла нет'; return $false }
    $len = [int64]0
    try { $len = (Get-Item -LiteralPath $Path).Length } catch { $script:IntegrityError = 'размер не читается'; return $false }
    if ($len -le 0) { $script:IntegrityError = 'файл пустой'; return $false }
    $pin = Get-PinFor $Path -Rel $Rel
    # (правка 939) внимание: в PowerShell имена переменных нечувствительны к
    # регистру, поэтому локальная переменная не должна совпадать с параметром
    # $Kind - иначе ожидаемый тип затирается и проверка всегда проходит.
    $expectKind = if ($Kind) { $Kind } else { Get-ExpectedKind $Path }
    if ($pin -and $pin.Kind) { $expectKind = $pin.Kind }
    if ($expectKind -eq 'pyscript') {
        # (правка 944) get-pip.py: магических байтов нет - смотрим содержимое
        if (-not (Test-TextScript $Path)) { return $false }
    } elseif ($expectKind) {
        $got = Get-HeadKind (Read-HeadBytes $Path 4)
        if ($got -ne $expectKind) {
            $what = if ($got) { $got } else { 'не архив (страница прокси/портала или обрезанная закачка)' }
            $script:IntegrityError = ('это ' + $what + ', ожидался ' + $expectKind)
            return $false
        }
    }
    if (-not $CheckPin -and -not $BundleSha) { return $true }
    if (-not $pin) { return $true }
    if (-not $pin.Pinned -and -not $BundleSha) { return $true }
    if ($pin.Size -gt 0 -and $len -ne $pin.Size) {
        $script:IntegrityError = ('размер ' + $len + ' байт, ожидался ' + $pin.Size)
        return $false
    }
    if ($pin.Sha256) {
        try { $h = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() } catch { $script:IntegrityError = 'sha256 не посчитать'; return $false }
        if ($h -ne $pin.Sha256) { $script:IntegrityError = 'sha256 не совпал с контрольной суммой установщика'; return $false }
    }
    return $true
}

# Файл + его докачки (.part, сегменты .0/.1/... и .new).
function Remove-StaleCacheFile {
    param([string]$Path)
    foreach ($p in @($Path, ($Path + '.part'))) {
        Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
    }
    try {
        $dir = Split-Path -Parent $Path
        $leaf = Split-Path -Leaf $Path
        if (-not $dir -or -not $leaf) { return }
        Get-ChildItem -LiteralPath $dir -Filter ($leaf + '*') -Force -ErrorAction SilentlyContinue | ForEach-Object {
            $n = $_.Name
            if ($n -ne $leaf -and $n.Length -gt $leaf.Length -and $n.Substring($leaf.Length) -match '^\.\d+(\.new)?$') {
                Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
            }
        }
    } catch { }
}

# (правка 939) Вызывается при выходе по ошибке: убирает из кэша всё, что не
# является ожидаемым архивом, чтобы повторный запуск качал заново, а не падал на
# распаковке того же мусора.
function Clear-CorruptCache {
    try {
        if (-not (Test-Path -LiteralPath $Cache)) { return }
        Get-ChildItem -LiteralPath $Cache -Recurse -File -Force -ErrorAction SilentlyContinue | ForEach-Object {
            # (правка 944) .part больше НЕ удаляем: Get-Download продолжает закачку
            # с места обрыва (-C -), а trap срабатывает в тот самый момент, когда
            # связь оборвалась. Раньше вычищались все незавершённые загрузки - и
            # подсказка «продолжит с того же места» была неправдой (torch ~1,8 ГБ
            # качался заново). Начисто .part убирает только сама закачка (3-я
            # попытка) либо Remove-StaleCacheFile, когда файл уже негоден.
            if (-not (Get-ExpectedKind $_.Name)) { return }
            if (-not (Test-ArchiveFile $_.FullName -CheckPin)) {
                Remove-StaleCacheFile $_.FullName
                Write-Log ('  снесён повреждённый файл кэша: ' + $_.FullName + ' (' + $script:IntegrityError + ')') 'warn'
            }
        }
    } catch { }
}

# (правка 777) мелкие, но медленно качающиеся архивы (uv, node, python, get-pip,
# ComfyUI, кастомные ноды, бинарник Electron) приложены прямо к установщику в
# install\cache - раскладываем их в .install-cache и не качаем с сети вовсе.
$bundle = Join-Path $InstallDir 'cache'
# (правка 941) в режиме самодиагностики ничего не раскладываем и не чиним -
# только читаем. Битые архивы бандла и кэша покажет -Deep.
if ((Test-Path $bundle) -and -not $script:SelfCheckMode) {
    $seeded = 0
    Get-ChildItem $bundle -Recurse -File | ForEach-Object {
        $src = $_.FullName
        $rel = $_.FullName.Substring($bundle.Length).TrimStart('\', '/')
        $dst = Join-Path $Cache $rel
        # (правка 939) сперва проверяем сам бандл: битый архив в установщике
        # раньше молча раскладывался в кэш, и установка падала на распаковке
        $pin = Get-PinFor $src -Rel $rel
        $hasPin = ($null -ne $pin)
        if (-not (Test-ArchiveFile $src -Rel $rel -CheckPin:$hasPin -BundleSha:$hasPin)) {
            Warn ('архив в составе установщика повреждён: ' + $rel + ' (' + $script:IntegrityError + ') - буду скачивать его из сети')
        } elseif (-not (Test-Path $dst) -or (Get-Item $dst).Length -le 0) {
            $d = Split-Path -Parent $dst
            if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
            try { Copy-Item $src $dst -Force; $seeded++ } catch { }
        } elseif (-not (Test-ArchiveFile $dst -CheckPin:$hasPin)) {
            # кэш прошлого запуска битый, а в установщике архив целый - чиним на месте
            Warn ('кэш прошлого запуска повреждён: ' + $rel + ' (' + $script:IntegrityError + ') - кладу архив из установщика')
            try { Copy-Item $src $dst -Force } catch { Remove-StaleCacheFile $dst }
        }
    }
    # (правка 792) $seeded - число, а int + 'строка' в PowerShell пытается привести
    # строку к Int32 и падает. Интерполяция "$seeded ..." безопасна.
    if ($seeded -gt 0) { Info ("$seeded архивов взято из установщика (без скачивания)") }
}

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

# (правка 762) HEAD один раз: размер файла и поддержка Range.
function Get-RemoteMeta {
    param([string]$Url)
    $res = [pscustomobject]@{ Size = [int64]0; Ranges = $false }
    if (-not $script:Curl) { return $res }
    $head = @()
    try { $head = @(& $script:Curl -sIL --fail --max-time 40 $Url 2>$null) } catch { return $res }
    foreach ($line in $head) {
        if ($line -match '(?i)^content-length:\s*(\d+)') { $res.Size = [int64]$Matches[1] }
        if ($line -match '(?i)^accept-ranges:\s*bytes') { $res.Ranges = $true }
    }
    return $res
}

# (правка 763) npm ci / npm run build ничего не пишут в окно установщика и
# молчат минутами - выглядит как зависание. Запускаем таким процессом и
# каждые 45 с пишем в лог, что работа идёт.
function Run-AppStep {
    param([string]$CmdLine, [string]$Title)
    $psi = [Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = 'cmd.exe'
    $psi.Arguments = '/c ' + $CmdLine
    $psi.WorkingDirectory = (Get-Location).Path
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $p = $null
    try { $p = [Diagnostics.Process]::Start($psi) } catch { $p = $null }
    if (-not $p) {
        & cmd.exe /c $CmdLine
        return $LASTEXITCODE
    }
    $t0 = Get-Date
    while ($true) {
        $exited = $true
        try { $exited = $p.WaitForExit(45000) } catch { }
        if ($exited) { break }
        $sec = [int]((Get-Date) - $t0).TotalSeconds
        Info ($Title + ' - идёт работа, прошло ' + [int]($sec / 60) + ' мин ' + ($sec % 60) + ' с')
    }
    try { return $p.ExitCode } catch { return 1 }
}

function Get-DownloadSegmented {
    param([string]$Url, [string]$Dest, [int64]$Size = 0, [int]$Threads = 6, [int64]$MinSize = 16MB)
    if (-not $script:Curl) { return $false }
    if ($Size -lt $MinSize) { return $false }
    $start = Get-Date

    $n = [int][Math]::Min($Threads, 8)
    $chunk = [int64][Math]::Ceiling($size / $n)
    $totalMb = [Math]::Round($size / 1MB, 0)
    $segs = New-Object System.Collections.ArrayList
    for ($i = 0; $i -lt $n; $i++) {
        $from = [int64]($i * $chunk)
        $to = [int64][Math]::Min($size - 1, ($from + $chunk - 1))
        if ($from -gt $to) { break }
        $p = $Dest + '.' + $i
        $len = $to - $from + 1
        $have = 0
        if (Test-Path $p) {
            try { $have = (Get-Item $p).Length } catch { }
            if ($have -le 0 -or $have -gt $len) {
                Remove-Item $p -Force -ErrorAction SilentlyContinue
                $have = 0
            }
        }
        [void]$segs.Add([pscustomobject]@{ Path = $p; From = $from; To = $to; Len = $len; Have = [int64]$have })
    }
    if ($segs.Count -lt 2) { return $false }
    # (правка 775) готовые сегменты прошлого запуска бережём, отставшие
    # докачиваем range'ом со сдвигом начала, до 3 заходов
    $round = 0
    while ($true) {
        $todo = @($segs | Where-Object { $_.Have -lt $_.Len })
        if ($todo.Count -eq 0 -or $round -ge 3) { break }
        $round++
        if ($round -gt 1) { Info ('  докачиваю ' + $todo.Count + ' отставших сегментов') }
        $procs = New-Object System.Collections.ArrayList
        foreach ($s in $todo) {
            $np = $s.Path + '.new'
            if (Test-Path $np) { Remove-Item $np -Force -ErrorAction SilentlyContinue }
            $f = $s.From + $s.Have
            $argStr = '-sL --fail --retry 3 --retry-delay 2 --connect-timeout 30 -r ' + $f + '-' + $s.To + ' -o "' + $np + '" "' + $Url + '"'
            [void]$procs.Add((Start-CurlProc $argStr))
        }

        # ждём: раз в 3 с пишем в статус живую скорость (видно в окне установки,
        # зависло или качается), раз в 15 с - строку в лог
        $lastLog = Get-Date
        $lastUpd = (Get-Date).AddSeconds(-2)
        while ($true) {
            $alive = 0
            foreach ($pr in $procs) {
                try { if (-not $pr.HasExited) { $alive++ } } catch { }
            }
            if ($alive -eq 0) { break }
            if (((Get-Date) - $lastUpd).TotalSeconds -ge 3) {
                $lastUpd = Get-Date
                $got = [int64]0
                foreach ($s in $segs) {
                    $got += $s.Have
                    $np = $s.Path + '.new'
                    if (Test-Path $np) { try { $got += (Get-Item $np).Length } catch { } }
                }
                $sec = [Math]::Max(0.6, ((Get-Date) - $start).TotalSeconds)
                $detail = 'загружено ' + [Math]::Round($got / 1MB, 0) + ' из ' + $totalMb + ' МБ'
                Set-Speed (($got / 1MB) / $sec) $detail
            }
            if (((Get-Date) - $lastLog).TotalSeconds -ge 15) {
                $lastLog = Get-Date
                $got = [int64]0
                foreach ($s in $segs) {
                    $got += $s.Have
                    $np = $s.Path + '.new'
                    if (Test-Path $np) { try { $got += (Get-Item $np).Length } catch { } }
                }
                Info ('  загружено ' + [Math]::Round($got / 1MB, 0) + ' из ' + $totalMb + ' МБ')
            }
            Start-Sleep -Milliseconds 500
        }

        foreach ($s in $todo) {
            # сшиваем докачанное (.new) с тем, что уже было в сегменте
            $np = $s.Path + '.new'
            $nl = [int64]0
            if (Test-Path $np) { try { $nl = (Get-Item $np).Length } catch { } }
            if ($nl -gt 0 -and ($s.Have + $nl) -eq $s.Len) {
                try {
                    $out = [IO.File]::Open($s.Path, 'Append', 'Write')
                    try {
                        $in = [IO.File]::OpenRead($np)
                        try { $in.CopyTo($out) } finally { $in.Dispose() }
                    } finally { $out.Dispose() }
                    $s.Have = $s.Len
                } catch { }
            }
            Remove-Item $np -Force -ErrorAction SilentlyContinue
        }
    }
    $bad = $false
    foreach ($s in $segs) { if ($s.Have -ne $s.Len) { $bad = $true } }
    if ($bad) {
        Info '  параллельная загрузка не удалась - качаю обычным способом'
        return $false
    }

    try {
        $out = [IO.File]::Open($Dest, 'Create', 'Write')
        try {
            foreach ($s in $segs) {
                $in = [IO.File]::OpenRead($s.Path)
                try { $in.CopyTo($out) } finally { $in.Dispose() }
            }
        } finally { $out.Dispose() }
    } catch {
        return $false
    }
    foreach ($s in $segs) { Remove-Item $s.Path -Force -ErrorAction SilentlyContinue }
    return $true
}

function Get-Download {
    param([string]$Url, [string]$Dest)
    # (правка 939) «уже скачано» теперь означает «это действительно архив, и,
    # если на него есть контрольная сумма, она совпала». Прежняя проверка
    # «файл есть и байт > 0» делала битый кэш вечным: его сносила только ручная
    # чистка .install-cache.
    if (Test-Path -LiteralPath $Dest) {
        if (Test-ArchiveFile $Dest -CheckPin) {
            Info ("уже скачано: " + (Split-Path $Dest -Leaf))
            return
        }
        Info ('кэш прошлого запуска не прошёл проверку (' + $script:IntegrityError + '), качаю заново: ' + (Split-Path $Dest -Leaf))
        Remove-StaleCacheFile $Dest
    }
    $dir = Split-Path -Parent $Dest
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $part = $Dest + '.part'
    Info ("скачивание: " + $Url)
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $ok = $false
    $meta = Get-RemoteMeta $Url
    # (правка 774) оборванное качание не начинаем с нуля: .part и сегменты
    # остаются в кэше, повторные попытки и следующий запуск продолжают качать
    # с места обрыва; начисто стартует только третья попытка
    for ($attempt = 1; $attempt -le 3 -and -not $ok; $attempt++) {
        if ($attempt -eq 1 -and $meta.Ranges -and $meta.Size -ge 16MB) {
            if (Get-DownloadSegmented -Url $Url -Dest $part -Size $meta.Size) { $ok = $true }
        }
    if (-not $ok) {
        if ($script:Curl) {
            # (правка 762) качаем процессом и опрашиваем размер .part - так видно
            # живую скорость и прогресс, а не просто «ждём непонятно чего»
            $size = $meta.Size
            if ($attempt -ge 3) { Remove-Item $part -Force -ErrorAction SilentlyContinue }
            $have = [int64]0
            if (Test-Path $part) { try { $have = (Get-Item $part).Length } catch { } }
            $resume = ''
            if ($have -gt 0 -and ($size -le 0 -or $have -lt $size)) {
                $resume = '-C - '
                if ($attempt -ge 2) { Info ('  продолжаю с ' + [Math]::Round($have / 1MB, 1) + ' МБ') }
            }
            $proc = $null
            try {
                $proc = Start-CurlProc ($resume + '-L --fail --retry 5 --retry-delay 3 --connect-timeout 30 -o "' + $part + '" "' + $Url + '"')
            } catch { $proc = $null }
            if ($proc) {
                $t0 = Get-Date
                $lastUpd = (Get-Date).AddSeconds(-2)
                while ($true) {
                    $alive = $false
                    try { $alive = -not $proc.HasExited } catch { }
                    if (-not $alive) { break }
                    if (((Get-Date) - $lastUpd).TotalSeconds -ge 3) {
                        $lastUpd = Get-Date
                        $got = [int64]0
                        if (Test-Path $part) { try { $got = (Get-Item $part).Length } catch { } }
                        $sec = [Math]::Max(0.6, ((Get-Date) - $t0).TotalSeconds)
                        if ($size -gt 0) {
                            Set-Speed (($got / 1MB) / $sec) ('загружено ' + [Math]::Round($got / 1MB, 0) + ' из ' + [Math]::Round($size / 1MB, 0) + ' МБ')
                        } elseif ($got -gt 0) {
                            Set-Speed (($got / 1MB) / $sec) ('загружено ' + [Math]::Round($got / 1MB, 0) + ' МБ')
                        }
                    }
                    Start-Sleep -Milliseconds 400
                }
                # (правка 944) код возврата curl раньше игнорировался: обрыв связи
                # (curl 18/56) оставлял в .part ненулевой хвост, и файл считался
                # скачанным. На codeload это особенно опасно: GitHub не отдаёт
                # Content-Length, сверить размер нечем, а магические байты у
                # обрезанного zip те же - «готовый» битый архив уезжал в кэш.
                $curlCode = 1
                try { $proc.WaitForExit(); $curlCode = $proc.ExitCode } catch { }
                if ($curlCode -ne 0) {
                    Info ('  curl завершился с кодом ' + $curlCode + ' - загрузка не закончена')
                } elseif ((Test-Path $part) -and (Get-Item $part).Length -gt 0) {
                    $gotLen = (Get-Item $part).Length
                    if ($size -gt 0 -and $gotLen -ne $size) {
                        Info ('  размер не совпал: ' + $gotLen + ' из ' + $size + ' байт')
                    } else {
                        $ok = $true
                    }
                }
            } else {
                & $script:Curl -L --fail --retry 5 --retry-delay 3 --connect-timeout 30 -o $part $Url
                if ($LASTEXITCODE -eq 0 -and (Test-Path $part) -and (Get-Item $part).Length -gt 0) {
                    $ok = $true
                } else {
                    if (Test-Path $part) { Remove-Item $part -Force -ErrorAction SilentlyContinue }
                }
            }
        } else {
            try {
                Invoke-WebRequest -Uri $Url -OutFile $part -UseBasicParsing
                $ok = $true
            } catch {
                $ok = $false
            }
        }
        # (правка 939) проверяем ДО того, как файл станет кэшированным: страница
        # прокси/портала вместо архива или склеенные сегменты выглядят как успех
        # (байты есть, размер совпал), но распаковка падает позже - и потом уже
        # навсегда, потому что кэш «уже скачан».
        if ($ok -and -not (Test-ArchiveFile $part -Rel (Get-CacheRel $Dest) -Kind (Get-ExpectedKind $Dest) -CheckPin)) {
            Info ('  скачанное не прошло проверку: ' + $script:IntegrityError)
            $ok = $false
            Remove-StaleCacheFile $part
        }
    }
    }
    $sw.Stop()
    if (-not $ok) {
        Info 'скачивание прервано - продолжу с этого места при следующем запуске'
        throw ('не удалось скачать: ' + $Url)
    }
    Move-Item -Force $part $Dest
    $mb = (Get-Item $Dest).Length / 1MB
    $sec = [Math]::Max(0.5, $sw.Elapsed.TotalSeconds)
    Info ("скачано " + [Math]::Round($mb, 1) + " МБ за " + [Math]::Round($sec, 1) + " с (" + [Math]::Round($mb / $sec, 1) + " МБ/с)")
}

# (правка 900) Один файл с нескольких зеркал: GitHub-releases периодически
# отвечает 404 на валидную ссылку (release-assets CDN), а curl --retry такой
# ответ не повторяет — установка обрывалась на ffmpeg. Пробуем ссылки по
# очереди; перед сменой зеркала чистим недокачанный .part и сегменты, чтобы
# не склеить байты разных сборок.
function Get-DownloadAny {
    param([string[]]$Urls, [string]$Dest)
    $lastErr = ''
    for ($i = 0; $i -lt $Urls.Count; $i++) {
        $u = $Urls[$i]
        if ($i -gt 0) {
            Info ('  пробую другое зеркало: ' + $u)
            Remove-Item $Dest -Force -ErrorAction SilentlyContinue
            $leaf = Split-Path -Leaf $Dest
            Get-ChildItem (Split-Path -Parent $Dest) -Filter ($leaf + '.*') -ErrorAction SilentlyContinue |
                Remove-Item -Force -ErrorAction SilentlyContinue
        }
        try {
            Get-Download $u $Dest
            if ((Test-Path $Dest) -and (Get-Item $Dest).Length -gt 0) { return }
        } catch {
            $lastErr = $_.Exception.Message
            Info ('  зеркало не ответило: ' + $lastErr)
        }
    }
    if ($lastErr) { throw $lastErr }
    throw ('не удалось скачать: ' + ($Urls -join ' | '))
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
            } elseif (-not (Test-ArchiveFile $f.Job.Dest -Kind (Get-ExpectedKind $f.Job.Dest))) {
                # (правка 939) codeload отдаёт HTML на rate-limit - размер при этом
                # ненулевой, а распаковка падает. Проверяем, что пришёл архив.
                Remove-Item $f.Job.Dest -Force -ErrorAction SilentlyContinue
                Info ('  не архив: ' + (Split-Path $f.Job.Dest -Leaf) + ' (' + $script:IntegrityError + ')')
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

# (правка 920) Visual C++ 2015-2022 x64 (VC redist).
# torch\lib\c10.dll грузит msvcp140.dll / vcruntime140*.dll из System32.
# На ноутбуке со старым redist `import torch` падал с «WinError 1114: Сбой
# инициализации DLL... c10.dll or one of its dependencies», и установка
# завершалась тремя ошибками шага 9 (torch, библиотеки, ComfyUI не поднялся) -
# хотя колёса качались верно. Обновление redist руками всё вылечило. Теперь
# версия проверяется на шаге 1, а старый redist ставится попутно и тихо.
$script:VcRedistMin = [version]'14.40.0.0'
$script:VcRedistUrl = 'https://aka.ms/vs/17/release/vc_redist.x64.exe'

function Get-VcRuntimeVersion {
    # Версию берём у msvcp140.dll (её и не хватало): если файла нет или он
    # старше VcRedistMin - redist нужно поставить/обновить. vcruntime140_1.dll
    # на некоторых OEM-сборках отсутствует отдельно - это тоже повод обновить.
    $need = @('msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll')
    $min = $null
    foreach ($n in $need) {
        $p = Join-Path $env:SystemRoot ('System32\' + $n)
        if (-not (Test-Path $p)) { return $null }
        $v = $null
        try { $v = (Get-Item $p).VersionInfo.FileVersionRaw } catch { }
        if (-not $v) {
            try { $v = [version]((Get-Item $p).VersionInfo.FileVersion) } catch { }
        }
        if (-not $v) { return $null }
        if (-not $min -or $v -lt $min) { $min = $v }
    }
    return $min
}

function Ensure-VcRedist {
    $cur = Get-VcRuntimeVersion
    if ($cur -and $cur -ge $script:VcRedistMin) {
        Ok ('Visual C++ 2015-2022 x64: ' + $cur)
        return
    }
    $shown = if ($cur) { 'версия ' + $cur } else { 'не установлен' }
    Info ('Visual C++ 2015-2022 x64: ' + $shown + ', нужен ' + $script:VcRedistMin + '+ - обновляю (без него torch не грузит c10.dll)')
    # (правка 940) с этого момента redist считаем проблемным, пока не убедимся в
    # обратном: любая ветка выхода ниже означает, что torch может упасть с 1114
    $script:VcRedistBroken = $true
    $exe = Join-Path $Cache 'vc_redist.x64.exe'
    if (-not ((Test-Path $exe) -and (Get-Item $exe).Length -gt 0)) {
        try {
            Get-Download $script:VcRedistUrl $exe
        } catch {
            Warn ('не удалось скачать VC++ redist: ' + $_.Exception.Message + '. Скачайте и поставьте вручную: ' + $script:VcRedistUrl)
            return
        }
    }
    if (-not ((Test-Path $exe) -and (Get-Item $exe).Length -gt 0)) {
        Warn ('VC++ redist не скачался. Скачайте и поставьте вручную: ' + $script:VcRedistUrl)
        return
    }
    Info 'установка Visual C++ redist (тихо, 1-2 минуты)...'
    $code = $null
    try {
        $proc = Start-Process -FilePath $exe -ArgumentList '/install','/quiet','/norestart' -Wait -PassThru
        $code = $proc.ExitCode
    } catch {
        Warn ('не удалось запустить VC++ redist: ' + $_.Exception.Message + '. Запустите вручную: ' + $exe)
        return
    }
    # 0 - успех; 1638 - уже стоит более новая; 3010 - успех, нужна перезагрузка.
    if ($code -eq 3010) {
        Warn 'VC++ redist обновлён, но Windows просит перезагрузку - до неё torch может не заработать'
    } elseif ($code -ne 0 -and $code -ne 1638) {
        # (правка 940) 1602/1603 - отказ в повышении прав: на пер-запуске от
        # обычного пользователя redist не встанет, и потом torch падает с
        # WinError 1114. Говорим это прямо, а не «код N».
        $hint = if ($code -eq 1602 -or $code -eq 1603 -or $code -eq 5) {
            ' (прав администратора не хватило: запустите install.bat от администратора)'
        } else { '' }
        $script:VcRedistBroken = $true
        Warn ('VC++ redist вернул код ' + $code + $hint + '. Скачайте и поставьте вручную (от администратора): ' + $script:VcRedistUrl)
        return
    }
    $after = Get-VcRuntimeVersion
    if ($after -and $after -ge $script:VcRedistMin) {
        $script:VcRedistBroken = $false
        Ok ('Visual C++ 2015-2022 x64 обновлён: ' + $after)
    } elseif ($code -eq 3010) {
        # Версия обновится после перезагрузки - не пугаем повтором.
    } else {
        $script:VcRedistBroken = $true
        Warn ('Visual C++ redist установлен, но System32 всё ещё показывает ' + $(if ($after) { $after } else { 'старую версию' }) + '. Перезагрузите Windows и запустите install.bat снова; если не поможет - поставьте вручную: ' + $script:VcRedistUrl)
    }
}

function Expand-ZipSafe {
    param([string]$Zip, [string]$Dest)
    # (правка 939) Сначала проверяем, что это вообще zip: «tar.exe» на HTML-
    # странице или на оборванном архиве выдаёт невнятный код ошибки, а битый файл
    # при этом оставался в кэше и ронял каждую следующую попытку установки.
    if (-not (Test-ArchiveFile $Zip -Kind 'zip')) {
        $why = $script:IntegrityError
        Remove-StaleCacheFile $Zip
        throw ('архив повреждён: ' + $Zip + ' (' + $why + ') - удалил его из кэша, запустите установщик снова')
    }
    if (-not (Test-Path -LiteralPath $Dest)) { New-Item -ItemType Directory -Force -Path $Dest | Out-Null }
    $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
    if (Test-Path -LiteralPath $tar) {
        & $tar -xf $Zip -C $Dest
        if ($LASTEXITCODE -ne 0) {
            # (правка 939) tar/libarchive пасует на части zip-особенностей
            # (data descriptor, очень длинные пути). Expand-Archive их читает -
            # пробуем второй движок, прежде чем объявлять архив битым.
            Info ('  tar.exe не распаковал (код ' + $LASTEXITCODE + '), пробую Expand-Archive')
            try {
                Expand-Archive -LiteralPath $Zip -DestinationPath $Dest -Force -ErrorAction Stop
            } catch {
                $why = $_.Exception.Message
                Remove-StaleCacheFile $Zip
                throw ('не удалось распаковать архив: ' + $Zip + ' (' + $why + ') - архив удалён из кэша, запустите установщик снова')
            }
        }
    } else {
        # Windows 10 до 1803: tar.exe нет, остаёмся на Expand-Archive
        Expand-Archive -LiteralPath $Zip -DestinationPath $Dest -Force
    }
}

function Expand-TarGz {
    param([string]$Archive, [string]$Dest)
    if (-not (Test-ArchiveFile $Archive -Kind 'gzip')) {
        $why = $script:IntegrityError
        Remove-StaleCacheFile $Archive
        throw ('архив повреждён: ' + $Archive + ' (' + $why + ') - удалил его из кэша, запустите установщик снова')
    }
    if (-not (Test-Path -LiteralPath $Dest)) { New-Item -ItemType Directory -Force -Path $Dest | Out-Null }
    $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
    if (-not (Test-Path -LiteralPath $tar)) {
        throw 'tar.exe не найден: нужна Windows 10 1803+ (или распакуйте .tar.gz вручную).'
    }
    & $tar -xzf $Archive -C $Dest
    if ($LASTEXITCODE -ne 0) {
        $why = 'код tar ' + $LASTEXITCODE
        Remove-StaleCacheFile $Archive
        throw ('не удалось распаковать архив: ' + $Archive + ' (' + $why + ') - архив удалён из кэша, запустите установщик снова')
    }
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
            Warn ('uv не скачался с github (' + $_.Exception.Message + ') - ставлю колесо uv с pypi')
        }
        # (правка 773) запасной канал: колесо uv лежит и на pypi (тот же бинарник),
        # а доступность pypi.org установщик проверяет ещё на шаге 1. при задубевшем
        # GitHub установка остаётся быстрой (uv), а не деградирует в построчный pip.
        if (-not (Test-Path $exe) -and $script:Python) {
            try {
                & $script:Python -m pip install --quiet uv --no-warn-script-location --disable-pip-version-check
            } catch { }
            $shim = Join-Path (Split-Path $script:Python -Parent) 'Scripts\uv.exe'
            if (Test-Path $shim) { $exe = $shim }
        }
    }
    if (Test-Path $exe) {
        $script:UvExe = $exe
        Ok 'uv готов (параллельная установка пакетов)'
    } else {
        $script:UvExe = $null
        Warn 'uv недоступен ни с github, ни с pypi - ставлю пакеты через pip, это медленнее'
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

# (правка 762) размер папки - чтобы мерить скорость скачивания пакетов uv
# по росту его кэша (uv сначала качает в кэш, потом ставит из него).
function Get-PathSize {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return [int64]0 }
    $sum = [int64]0
    try {
        foreach ($f in [IO.Directory]::EnumerateFiles($Path, '*', [IO.SearchOption]::AllDirectories)) {
            try { $sum += (New-Object IO.FileInfo $f).Length } catch { }
        }
    } catch { }
    return $sum
}

# 288 пакетов из requirements.lock.txt ставим пачками через uv: так видно
# прогресс в окне и параллельно качается/распаковывается всё сразу.
function Install-RequirementsUv {
    param([string]$File, [int]$Batch = 32)
    if (-not $script:UvExe) { return $false }
    $lines = @(Get-Content $File | ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not $_.StartsWith('#') })
    if ($lines.Count -eq 0) { return $false }
    $uvCache = Join-Path $Cache 'uv'
    $i = 0
    while ($i -lt $lines.Count) {
        $last = [Math]::Min($i + $Batch - 1, $lines.Count - 1)
        $chunk = @($lines[$i..$last])
        $bf = Join-Path $Cache 'uv-batch.txt'
        [IO.File]::WriteAllLines($bf, $chunk, (New-Object Text.ASCIIEncoding))
        Info ('пакеты ' + ($i + 1) + '-' + ($last + 1) + ' из ' + $lines.Count)
        # (правка 765) статус в окне показывал пачку, которая УЖЕ закончилась
        # (detail обновлялся только после замера), а в логе шла текущая —
        # два разных значения одновременно. Теперь detail ставится до запуска
        # uv: окно и лог всегда показывают одну и ту же текущую пачку.
        # Скорость до замера новой пачки остаётся от предыдущей.
        $batchRange = 'пакеты ' + ($i + 1) + '-' + ($last + 1) + ' из ' + $lines.Count
        Set-Speed $script:SpeedMBs $batchRange
        $before = Get-PathSize $uvCache
        $t0 = Get-Date
        $rc = (Invoke-Uv @('pip', 'install', '--python', $script:Python, '--no-deps', '--no-progress', '-r', $bf))
        $sec = [Math]::Max(0.1, ((Get-Date) - $t0).TotalSeconds)
        $after = Get-PathSize $uvCache
        $mb = ($after - $before) / 1MB
        if ($rc -ne 0) {
            Warn ('uv не осилил пакеты ' + ($i + 1) + '-' + ($last + 1) + ' - доустанавливаю через pip')
            return $false
        }
        if ($mb -gt 0.5 -and $sec -gt 1) {
            $rate = $mb / $sec
            Info ('  ' + [Math]::Round($mb, 0) + ' МБ за ' + [Math]::Round($sec, 1) + ' с (' + [Math]::Round($rate, 1) + ' МБ/с)')
            Set-Speed $rate $batchRange
        } else {
            Info ('  готово за ' + [Math]::Round($sec, 1) + ' с')
            Set-Speed 0 $batchRange
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
if ($script:SelfCheckMode) { Write-Log '  Режим:         самодиагностика (-SelfCheck): ничего не скачивается и не меняется' }
Write-Log ''

# ------------------------------------------ самодиагностика (правка 941) ---

# -SelfCheck (и -Deep): студию НЕ трогаем, только читаем. Это ответ на
# «вчера работало, сегодня нет»: по одному запуску видно, какой именно кусок
# отвалился - Node, зависимости, сборка, ядро ComfyUI, Python+torch, кастомные
# ноды, патчи ядра, пути моделей - и что с этим делать. Ничего не скачивается,
# не собирается и не грузится на ГПУ (torch только импортируется).
function Get-SelfCheckComfyPaths {
    param([string]$Base)
    # та же раскладка, что в шаге 4: новая плоская (ComfyUI\main.py) и старая
    # (ComfyUI-Easy-Install\ComfyUI + python_embeded рядом)
    $new = Join-Path $Base 'ComfyUI'
    $old = Join-Path $Base 'ComfyUI-Easy-Install'
    if (Test-Path -LiteralPath (Join-Path $new 'main.py')) {
        return [pscustomobject]@{ Root = $new; Core = $new }
    }
    if (Test-Path -LiteralPath (Join-Path $old 'ComfyUI\main.py')) {
        return [pscustomobject]@{ Root = $old; Core = (Join-Path $old 'ComfyUI') }
    }
    if (Test-Path -LiteralPath (Join-Path $old 'main.py')) {
        return [pscustomobject]@{ Root = $old; Core = $old }
    }
    return [pscustomobject]@{ Root = $new; Core = $new }
}

function Invoke-SelfCheck {
    param([switch]$DeepCheck)
    Write-Log '   САМОДИАГНОСТИКА: установка не запускается, файлы не меняются' 'step'
    Write-Log ''

    # ---- приложение: portable Node, node_modules, production-сборка ----
    Write-Log '  Приложение:' 'step'
    $nodeExe = Join-Path $Root 'runtime\node.exe'
    if (Test-Path -LiteralPath $nodeExe) {
        $nv = ''
        try { $nv = ((& $nodeExe -v 2>&1) | Out-String).Trim() } catch { }
        if ($nv) { Ok ('portable Node.js: ' + $nv) }
        else { Fail 'runtime\node.exe есть, но не запускается - позови скрипт: install.bat (шаг 2)' }
    } else {
        Fail 'нет runtime\node.exe - студия не запустится. Починка: install.bat (шаг 2)'
    }

    foreach ($d in @('next', 'react', 'react-dom', 'zustand')) {
        if (Test-Path -LiteralPath (Join-Path $Root ('node_modules\' + $d))) { Ok ('зависимость: ' + $d) }
        else { Fail ('нет node_modules\' + $d + '. Починка: install.bat (шаг 3)') }
    }
    # (правка 943) Electron 44+ в npm-пакете лежит в node_modules\electron\dist\
    # (path.txt указывает electron.exe внутри dist); сам установщик проверяет
    # именно dist\electron.exe - проверка должна совпадать, иначе ложная жалоба.
    $elExe = @((Join-Path $Root 'node_modules\electron\dist\electron.exe'), (Join-Path $Root 'node_modules\electron\electron.exe')) |
        Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if ($elExe) { Ok ('электрон (окно студии) на месте: ' + (Split-Path -Leaf $elExe)) }
    else {
        Warn 'нет node_modules\electron\dist\electron.exe - окно студии не запустится (лечится install.bat, шаг 3)'
    }
    $buildId = Join-Path $Root '.next\BUILD_ID'
    if (Test-Path -LiteralPath $buildId) {
        Ok ('production-сборка есть (BUILD_ID ' + ((Get-Content -LiteralPath $buildId -Raw -Encoding UTF8).Trim()) + ')')
    } else {
        Fail 'нет .next\BUILD_ID - интерфейс не собран. Починка: install.bat (шаг 3)'
    }
    if (Test-Path -LiteralPath (Join-Path $Root 'electron\main.js')) { Ok 'electron\main.js на месте' }
    else { Fail 'нет electron\main.js - файл программы потерян (обнови студию или переустанови)' }

    # ---- бэкенд ComfyUI: раскладка, ядро, python_embeded, torch ----
    Write-Log ''
    Write-Log '  ComfyUI:' 'step'
    $cp = Get-SelfCheckComfyPaths $Root
    if (Test-Path -LiteralPath (Join-Path $cp.Core 'main.py')) {
        Ok ('ядро ComfyUI: ' + $cp.Core)
        $ver = ''
        $vf = Join-Path $cp.Core 'comfyui_version.py'
        $pf = Join-Path $cp.Core 'pyproject.toml'
        if (Test-Path -LiteralPath $vf) {
            $t = Get-Content -LiteralPath $vf -Raw -Encoding UTF8
            if ($t -match "version\s*=\s*['""]([^'""]+)['""]") { $ver = $Matches[1] }
        }
        if (-not $ver -and (Test-Path -LiteralPath $pf)) {
            $t = Get-Content -LiteralPath $pf -Raw -Encoding UTF8
            if ($t -match '(?m)^\s*version\s*=\s*["'']([^"'']+)["'']') { $ver = $Matches[1] }
        }
        if ($ver) { Ok ('версия ядра: ' + $ver) } else { Warn 'версия ядра не читается (comfyui_version.py / pyproject.toml)' }
    } else {
        Fail ('нет папки ядра ComfyUI (main.py) рядом с ' + $Root + '. Починка: install.bat (шаг 4)')
    }

    $py = Join-Path $cp.Root 'python_embeded\python.exe'
    if (Test-Path -LiteralPath $py) {
        Ok ('портативный Python: ' + $py)
        # torch проверяем импортом без CUDA - саму модель не запускаем
        $tout = ''
        try { $tout = ((& $py -c 'import torch; print(torch.__version__)' 2>&1) | Out-String).Trim() } catch { $tout = $_.Exception.Message }
        if ($LASTEXITCODE -eq 0 -and $tout) { Ok ('torch импортируется: ' + ($tout -split "`n")[0]) }
        else {
            $msg = if ($tout) { ($tout -split "`r?`n" | Where-Object { $_ } | Select-Object -Last 2) -join ' | ' } else { 'без вывода' }
            if ($msg -match '1114|DLL load failed|c10') {
                Fail ('torch не грузится (' + $msg + ') - нужен Visual C++ 2015-2022 x64: ' + $script:VcRedistUrl + ', затем install.bat от администратора')
            } else {
                Fail ('torch не импортируется (' + $msg + '). Починка: install.bat (шаг 5)')
            }
        }
    } else {
        Fail ('нет ' + $py + ' - Python-окружение не установлено. Починка: install.bat (шаг 5)')
    }

    # ---- кастомные ноды: внешние из install\nodes.json + наши из custom nodes\ ----
    Write-Log ''
    Write-Log '  Кастомные ноды:' 'step'
    $cnDir = Join-Path $cp.Core 'custom_nodes'
    if (-not (Test-Path -LiteralPath $cnDir)) {
        Fail ('нет папки custom_nodes в ядре (' + $cnDir + '). Починка: install.bat (шаг 6)')
    } else {
        $nodesFile = Join-Path $InstallDir 'nodes.json'
        $missing = @()
        if (Test-Path -LiteralPath $nodesFile) {
            try {
                foreach ($n in (Get-Content -LiteralPath $nodesFile -Raw -Encoding UTF8 | ConvertFrom-Json)) {
                    if (-not (Test-Path -LiteralPath (Join-Path $cnDir ([string]$n.name)))) { $missing += [string]$n.name }
                }
            } catch { Warn ('nodes.json не читается: ' + $_.Exception.Message) }
        } else {
            Warn 'нет install\nodes.json - список внешних нод не проверен'
        }
        if ($missing.Count -eq 0) { Ok ('внешние ноды на месте (' + (Get-ChildItem -LiteralPath $cnDir -Directory -EA SilentlyContinue).Count + ' папок)') }
        else { Warn ('нет ' + $missing.Count + ' внешней(ых) нод(ы): ' + (($missing | Select-Object -First 6) -join ', ') + '. Лечится install.bat (шаг 6) или запуском студии (синк нод при старте)') }

        # наши собственные ноды - их отсутствие ломает воркфлоу с missing_node_type
        $ours = @()
        $oursSrc = Join-Path $Root 'custom nodes'
        if (Test-Path -LiteralPath $oursSrc) {
            foreach ($d in (Get-ChildItem -LiteralPath $oursSrc -Directory)) {
                $t = Join-Path $cnDir $d.Name
                if (-not (Test-Path -LiteralPath $t)) { $ours += ($d.Name + ' (нет папки)') }
                elseif (-not (Test-Path -LiteralPath (Join-Path $t '__init__.py'))) { $ours += ($d.Name + ' (нет __init__.py)') }
            }
        } else {
            Warn 'нет папки custom nodes в самой студии - наши ноды неоткуда брать (виноват апдейт-зип)'
        }
        if ($ours.Count -eq 0) { Ok 'наши ноды студии на месте' }
        else { Fail ('нет наших нод: ' + ($ours -join '; ') + '. Перезапусти студию - синк нод чинит это при старте (AGENTS.md, инвариант ComfyUI)') }
    }

    # ---- патчи ядра: файлы из install\comfy-patches должны лежать в ядре ----
    Write-Log ''
    Write-Log '  Патчи ядра:' 'step'
    $patchSrc = Join-Path $InstallDir 'comfy-patches'
    if (-not (Test-Path -LiteralPath $patchSrc)) {
        Warn 'нет install\comfy-patches - проверить патчи ядра нечем'
    } else {
        $bad = @()
        Get-ChildItem -LiteralPath $patchSrc -Recurse -File | Where-Object { $_.FullName -notmatch '__pycache__' } | ForEach-Object {
            $rel = $_.FullName.Substring($patchSrc.Length).TrimStart('\', '/')
            $dst = Join-Path $cp.Core ($rel -replace '/', '\')
            if (-not (Test-Path -LiteralPath $dst)) { $bad += ($rel + ' (файла нет в ядре)') }
            else {
                try {
                    $a = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
                    $b = (Get-FileHash -LiteralPath $dst -Algorithm SHA256).Hash
                    if ($a -ne $b) { $bad += ($rel + ' (версия устарела)') }
                } catch { $bad += ($rel + ' (не читается)') }
            }
        }
        if ($bad.Count -eq 0) { Ok 'патчи ядра совпадают с установщиком' }
        else { Warn ('патчи ядра расходятся: ' + ($bad -join '; ') + '. Перезапусти студию - патчи накатываются при старте') }
        $mh3 = Join-Path $cp.Core 'comfy_extras\nodes_minimax_h3.py'
        if (Test-Path -LiteralPath $mh3) {
            $t = Get-Content -LiteralPath $mh3 -Raw -Encoding UTF8 -EA SilentlyContinue
            if ($t -and $t.Contains('PH3ImageConditioning')) { Ok 'нода PH3ImageConditioning в ядре есть' }
            else { Fail 'в ядре нет PH3ImageConditioning - вкладка «Изображение» не работает. Перезапусти студию (патчи накатываются при старте)' }
        }
    }

    # ---- конфигурация путей к моделям ----
    Write-Log ''
    Write-Log '  Модели и пути:' 'step'
    if (Test-Path -LiteralPath (Join-Path $cp.Core 'extra_model_paths.yaml')) { Ok 'extra_model_paths.yaml есть' }
    else { Warn 'нет extra_model_paths.yaml - часть моделей не найдётся. Починка: install.bat (шаг 7)' }
    foreach ($d in @('models\diffusion_models', 'models\text_encoders', 'models\vae', 'input', 'output')) {
        if (Test-Path -LiteralPath (Join-Path $cp.Core $d)) { Ok ('папка: ' + $d) }
        else { Warn ('нет папки ' + $d + '. Починка: install.bat (шаг 7)') }
    }

    # ---- -Deep: sha256 офлайн-бандла и кэша прошлых запусков ----
    if ($DeepCheck) {
        Write-Log ''
        Write-Log '  Контрольные суммы (-Deep):' 'step'
        if ($script:Pins.Count -eq 0) { Warn 'install\checksums.json пуст или отсутствует - сверять нечем' }
        foreach ($base in @((Join-Path $InstallDir 'cache'), $Cache)) {
            if (-not (Test-Path -LiteralPath $base)) { continue }
            # (правка 944) sha бандла сверяем только у самого бандла. Для кэша
            # прошлых запусков - магические байты (и sha только у неизменяемых
            # артефактов): архивы тегов GitHub пересобираются, и скачанный из
            # сети файл никогда не совпадёт с суммой бандла - было ложное
            # «битый файл: nodes/...zip (sha256 не совпал)».
            $isBundle = ($base -eq (Join-Path $InstallDir 'cache'))
            $n = 0
            $badDeep = @()
            Get-ChildItem -LiteralPath $base -Recurse -File -Force -EA SilentlyContinue | ForEach-Object {
                $rel = Get-CacheRel $_.FullName
                if (-not $rel) {
                    $rel = $_.FullName.Substring($base.Length).TrimStart('\', '/')
                }
                if (-not (Get-PinFor $_.FullName -Rel $rel) -and -not (Get-ExpectedKind $_.Name)) { return }
                $okArc = Test-ArchiveFile $_.FullName -Rel $rel -CheckPin -BundleSha:$isBundle
                if ($okArc) { $n++ } else { $badDeep += ($rel + ' (' + $script:IntegrityError + ')') }
            }
            Write-Log ('   проверено целых: ' + $n + ' - ' + $base)
            foreach ($b in $badDeep) { Warn ('битый файл: ' + $b + ' (' + $base + ') - удали его или запусти install.bat: битые файлы кэша сносятся сами') }
        }
    }

    Write-Log ''
    Write-Log '  ============================================================'
    if ($script:Failures.Count -eq 0) {
        Write-Log '   САМОДИАГНОСТИКА: критичных проблем не найдено' $(if ($script:Warnings.Count) { 'warn' } else { 'ok' })
    } else {
        Write-Log ('   САМОДИАГНОСТИКА: проблем - ' + $script:Failures.Count) 'err'
        foreach ($f in $script:Failures) { Write-Log ('   - ' + $f) 'err' }
    }
    if ($script:Warnings.Count -gt 0) {
        Write-Log ('   Предупреждений: ' + $script:Warnings.Count) 'warn'
        foreach ($w in $script:Warnings) { Write-Log ('   - ' + $w) 'warn' }
    }
    Write-Log ('  Полный лог: ' + $LogFile)
    Write-Log '  ============================================================'
    return $(if ($script:Failures.Count -gt 0) { 1 } else { 0 })
}

if ($SelfCheck -or $Deep) {
    exit (Invoke-SelfCheck -DeepCheck:$Deep)
}

# ------------------------------------------------------- 1. проверки системы ---

Step 1 9 'Проверка системы' 'Проверяем Windows, диск, путь установки и доступ в сеть'
# (правка 941) дальше статус обновляет heartbeat: даже если шаг молчит 20 минут,
# заставка видит, что установка жива.
Start-StatusHeartbeat

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

# (правка 940) Условия окружения, которые раньше не проверялись, а потом
# выглядели как «установка упала без причины». Всё это - предупреждения:
# студия ставится в папку пользователя, права администратора ей не обязательны.

$script:IsAdmin = $false
try {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $script:IsAdmin = ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
} catch { }
Info ('права администратора: ' + $(if ($script:IsAdmin) { 'есть' } else { 'нет (это нормально)' }))

# Длинные пути: node_modules и ComfyUI легко дают > 260 символов, и без
# LongPathsEnabled распаковка/удаление папок падает невнятной ошибкой.
$longPaths = $null
try {
    $lp = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -Name LongPathsEnabled -ErrorAction SilentlyContinue
    if ($lp) { $longPaths = $lp.LongPathsEnabled }
} catch { }
if ($longPaths -eq 1) {
    Ok 'длинные пути включены (LongPathsEnabled)'
} elseif ($script:IsAdmin) {
    try {
        New-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -Name LongPathsEnabled -PropertyType DWord -Value 1 -Force | Out-Null
        Ok 'включили LongPathsEnabled (длинные пути в node_modules и ComfyUI)'
    } catch {
        Warn 'не удалось включить LongPathsEnabled в реестре; если распаковка упадёт - включите вручную: HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System, LongPathsEnabled = 1'
    }
} else {
    Warn 'длинные пути выключены (LongPathsEnabled=0): на глубоких папках распаковка и удаление могут падать. Лечится запуском install.bat от администратора (мы включим сам) либо вручную в реестре: HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System, LongPathsEnabled = 1'
}

if ($Root.Length -gt 90) {
    Warn ('путь очень длинный сам по себе (' + $Root.Length + ' симв.), а node_modules и ComfyUI добавляют ещё больше: если будут сбои распаковки, перенесите студию ближе к корню диска')
}
if ($Root -match '[^\x00-\x7F]') {
    Warn 'в пути есть символы не-ASCII (кириллица): обычно работает, но при странных сбоях распаковки или удаления папок попробуйте путь только из латинских букв'
}
if ($Root -match '(?i)onedrive') {
    Warn 'папка внутри OneDrive: синхронизация перехватывает файлы во время установки - перенесите студию вне OneDrive'
}
try {
    $dtype = (Get-Item $Root).PSDrive.DriveType
    if ($dtype -eq 'Network' -or $dtype -eq 'Removable') {
        $dn = if ($drive) { $drive.Name } else { $Root }
        Warn ('диск ' + $dn + ' - ' + $dtype + ': по сети и на съёмных носителях установка идёт заметно дольше, а tar.exe и антивирус чаще срываются')
    }
} catch { }

if (Test-Path (Join-Path $env:SystemRoot 'System32\tar.exe')) {
    Ok 'tar.exe доступен (распаковка архивов)'
} else {
    Warn 'в Windows нет System32\tar.exe (нужна Windows 10 1803+): zip распакуется Expand-Archive, но STT-архив (.tar.gz) распаковать будет нечем'
}
if (-not $script:Curl) {
    Warn 'curl.exe не найден: качаем через Invoke-WebRequest - без докачки с места обрыва и без живой скорости'
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

# (правка 920) VC++ 2015-2022 x64 нужен torch: c10.dll грузит msvcp140.dll из
# System32, и на старом redist import torch падает с WinError 1114 (три ошибки
# шага 9 на ровном месте). Ставим/обновляем попутно - ошибка redist установку
# не прерывает, только предупреждение с прямой ссылкой.
if (-not $SkipComfy) {
    try { Ensure-VcRedist } catch { Warn ('проверка VC++ redist не удалась: ' + $_.Exception.Message) }
}

if (-not (Test-Host 'https://download.pytorch.org/whl/cu130/')) {
    Warn 'download.pytorch.org недоступен — шаг установки torch может не пройти (VPN/прокси).'
}

# (правка 778) антивирус проверяет каждый скачанный и распакованный файл;
# на медленном диске это превращает шаг пакетов в часы. подсказываем про
# исключение один раз, в самом начале установки.
try {
    $mp = Get-MpComputerStatus -ErrorAction SilentlyContinue
    if ($mp -and $mp.RealTimeProtectionEnabled) {
        Info ('защитник Windows включён - если установка будет очень медленной, добавьте папку в исключения:')
        Info ('  Безопасность Windows -> Защита от вирусов -> Исключения -> ' + $Root)
    }
} catch { }

# (правка 791) nvidia-smi лежит в System32 и может не находиться по PATH:
# у лаунчера бывает усечённый PATH, а 32-битный процесс видит SysWOW64, где
# nvidia-smi нет вовсе. Поэтому сначала Get-Command, затем известные пути,
# и только в крайнем случае — предупреждение.
$nvidiaExe = $null
$nvidia = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if ($nvidia) { $nvidiaExe = $nvidia.Source }
if (-not $nvidiaExe) {
    $candidates = @(
        (Join-Path $env:SystemRoot 'System32\nvidia-smi.exe'),
        (Join-Path $env:SystemRoot 'Sysnative\nvidia-smi.exe'),
        (Join-Path $env:ProgramFiles 'NVIDIA Corporation\NVSMI\nvidia-smi.exe')
    )
    if (${env:ProgramFiles(x86)}) {
        $candidates += (Join-Path ${env:ProgramFiles(x86)} 'NVIDIA Corporation\NVSMI\nvidia-smi.exe')
    }
    foreach ($p in $candidates) {
        if (Test-Path $p) { $nvidiaExe = $p; break }
    }
}
if ($nvidiaExe) {
    try {
        $gpu = (& $nvidiaExe --query-gpu=name,memory.total --format=csv,noheader 2>$null | Select-Object -First 1)
        if ($gpu) {
            Ok ('GPU: ' + $gpu)
        } else {
            Warn 'nvidia-smi найден, но видеокарта не ответила'
        }
    } catch {
        Warn 'nvidia-smi найден, но видеокарта не ответила'
    }
} else {
    # Последний шанс: драйвер может быть установлен, а nvidia-smi отсутствовать
    # (OEM/ноутбучные сборки). Спрашиваем у WMI, а не пугаем пользователя.
    $gpuName = $null
    try {
        $vc = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match 'NVIDIA' } | Select-Object -First 1
        if ($vc) { $gpuName = $vc.Name }
    } catch { }
    if ($gpuName) {
        Ok ('GPU: ' + $gpuName + ' (nvidia-smi недоступен)')
    } else {
        Warn 'nvidia-smi не найден: не установлен драйвер NVIDIA. Студия сможет запуститься, но генерация без GPU невозможна.'
    }
}

# ------------------------------------------------------------- 2. Node.js ---

if (-not $SkipApp) {
    Step 2 9 'Node.js' 'Portable-Node (~30 МБ): обычно меньше минуты'

    # (правка 822) Установщик ВСЕГДА использует собственный портативный Node.js
    # в runtime\ и больше не ищет Node в системе. Прежняя логика верила любому
    # найденному по PATH `node`: у пользователей с Node через nvm/volta/scoop
    # node в PATH есть, а npm.cmd рядом нет - установка падала с «The term
    # 'npm.cmd' is not recognized» (PowerShell считает вызов несуществующей
    # команды фатальной, ветка «npm не найден» ниже не доходила).
    $runtimeDir = Join-Path $Root 'runtime'

    if (Test-Path (Join-Path $runtimeDir 'node.exe')) {
        Ok 'найден портативный runtime\node.exe'
    } else {
        $nodeVersion = '22.20.0'
        $zip = Join-Path $Cache ('node-v' + $nodeVersion + '-win-x64.zip')
        Get-Download ('https://nodejs.org/dist/v' + $nodeVersion + '/node-v' + $nodeVersion + '-win-x64.zip') $zip
        $tmp = Join-Path $Cache 'node-extract'
        if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
        Expand-ZipSafe $zip $tmp
        $inner = Get-ChildItem $tmp -Directory | Select-Object -First 1
        if (-not $inner) { throw 'в архиве node-v' + $nodeVersion + '-win-x64.zip нет папки с Node.js - архив повреждён, удалите .install-cache и запустите снова.' }
        if (Test-Path $runtimeDir) { Remove-Item $runtimeDir -Recurse -Force }
        New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
        Get-ChildItem $inner.FullName -Force | Move-Item -Destination $runtimeDir -Force
        Remove-Item $tmp -Recurse -Force
        Ok ('Node.js ' + $nodeVersion + ' установлен в runtime\')
    }

    $nodeExe = Join-Path $runtimeDir 'node.exe'
    # (правка 822) PATH поправляем ДО проверок и всегда указываем полные пути:
    # node/npm должны находиться именно в runtime\, а не в системе.
    $env:PATH = $runtimeDir + ';' + $env:PATH
    $checkVer = (& $nodeExe --version 2>$null)
    if (-not $checkVer) { throw 'Node.js из runtime\ не запускается.' }

    $npmCmd = Join-Path $runtimeDir 'npm.cmd'
    if (-not (Test-Path $npmCmd)) {
        throw 'npm не найден в runtime\ - папка runtime повреждена. Удалите runtime\ и .install-cache и запустите установщик снова.'
    }
    $npmVersion = ''
    try { $npmVersion = (& $npmCmd --version 2>$null) } catch { }
    if (-not $npmVersion) {
        throw 'npm из runtime\ не запускается. Удалите runtime\ и .install-cache и запустите установщик снова.'
    }
    Ok ('Node.js ' + $checkVer + ' (портативный), npm ' + $npmVersion)
} else {
    Info 'пропущено (-SkipApp)'
}

# ------------------------------------------- 3. node_modules и сборка .next ---

if (-not $SkipApp) {
    Step 3 9 'Node-зависимости и production-сборка' 'npm-зависимости и сборка интерфейса: 3-20 минут в зависимости от диска и сети'

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
            $rc = Run-AppStep 'npm ci --no-audit --no-fund' 'npm ci'
            if ($rc -ne 0) {
                Warn 'npm ci не удался, пробую npm install'
                $rc = Run-AppStep 'npm install --no-audit --no-fund' 'npm install'
                if ($rc -ne 0) { throw 'не удалось установить node-зависимости (npm).' }
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
                # (правка 763) штатный install.js качает бинарник с GitHub в одно
                # соединение и молча - на медленных каналах это выглядит как
                # зависание («нет данных» минутами). Качаем тот же zip своим
                # загрузчиком: параллельные сегменты + скорость в окне.
                $elVer = $null
                try { $elVer = (Get-Content (Join-Path $elDir 'package.json') -Raw | ConvertFrom-Json).version } catch { }
                $elReady = $false
                if ($elVer -and $elVer -match '^\d+\.\d+\.\d+$') {
                    Info ("скачиваю бинарник Electron v" + $elVer + " (~150 МБ, один раз)...")
                    $elZip = Join-Path $Cache ("electron-v" + $elVer + "-win32-x64.zip")
                    try {
                        Get-Download ('https://github.com/electron/electron/releases/download/v' + $elVer + '/electron-v' + $elVer + '-win32-x64.zip') $elZip
                        Info 'распаковываю Electron...'
                        $dist = Join-Path $elDir 'dist'
                        if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
                        New-Item -ItemType Directory -Force -Path $dist | Out-Null
                        # (правка 939) тот же контроль целостности и второй движок
                        # распаковки, что у остальных архивов (был прямой
                        # ZipFile::ExtractToDirectory без какой-либо проверки)
                        Expand-ZipSafe $elZip $dist
                        Set-Content -LiteralPath (Join-Path $elDir 'path.txt') -Value 'electron.exe' -NoNewline
                        $elReady = Test-Path (Join-Path $dist 'electron.exe')
                    } catch {
                        Warn ('быстрая загрузка Electron не удалась: ' + $_.Exception.Message)
                    }
                }
                if (-not $elReady) {
                    Info 'пробую штатный установщик Electron...'
                    Push-Location $Root
                    try {
                        & $nodeExe (Join-Path $elDir 'install.js')
                    } finally {
                        Pop-Location
                    }
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

        # (правка 770) Раньше сборка переиспользовалась, если .next\BUILD_ID просто
        # есть. При обновлении поверх старой установки установщик кладёт свежие
        # исходники, а старый .next остаётся нетронутым — и юзер продолжает
        # запускать ПРЕЖНИЙ фронтенд: исправления (например, 741 про масштаб) до
        # него так и не доходят. Теперь сборка считается свежей только если её
        # версия совпадает с версией из package.json; после успешной сборки
        # версия пишется в .next\H3_APP_VERSION.
        $appVer = $null
        try { $appVer = (Get-Content 'package.json' -Raw | ConvertFrom-Json).version } catch { }
        $buildVer = $null
        try { $buildVer = ((Get-Content '.next\H3_APP_VERSION' -Raw) -as [string]).Trim() } catch { }
        $buildFresh = ((Test-Path '.next\BUILD_ID') -and $appVer -and ($buildVer -eq $appVer))
        if (-not $buildFresh) {
            if (Test-Path '.next') {
                # (правка 792) без скобок вокруг всей строки Info получал кучу
                # отдельных аргументов и падал на повторном ремонте установки.
                Info ('сборка .next устарела (в ней ' + $(if ($buildVer) { $buildVer } else { 'нет штампа' }) + ', нужно ' + $appVer + ') - пересобираю')
                # rmdir через cmd: Remove-Item падает на длинных путях .next
                & cmd.exe /c "rmdir /s /q `"$(Join-Path $Root '.next')`""
            }
            Info 'npm run build - сборка Next.js, займёт 2-5 минут'
            $rc = Run-AppStep 'npm run build' 'сборка Next.js'
            if ($rc -ne 0) { throw 'сборка приложения (npm run build) завершилась ошибкой.' }
            if ($appVer) { Set-Content -Path '.next\H3_APP_VERSION' -Value $appVer -NoNewline }
            Ok ('сборка .next готова (версия ' + $appVer + ')')
        } else {
            Ok ('сборка .next уже есть, версия ' + $buildVer)
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
            # (правка 900) несколько зеркал: прямой адрес новой организации,
            # старый BtbN-редирект, зеркало yt-dlp и сборка gyan.dev (все
            # содержат ffmpeg.exe + ffprobe.exe в подпапке bin).
            Get-DownloadAny @(
                'https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
                'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip',
                'https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip',
                'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
            ) $ffZip
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

# (правка 905) Папка бэкенда называется ComfyUI: это официальное ядро
# ComfyUI + портативный Python, а не сборка Pixaroma. Раскладка плоская:
#   <Root>\ComfyUI\main.py, ...\models, ...\custom_nodes, ...\python_embeded.
# Старые установки (ComfyUI-Easy-Install\ComfyUI + python_embeded рядом)
# определяются сами и продолжают обновляться на месте - переименование
# папки пользователь делает сам, если хочет.
$comfyRootNew = Join-Path $Root 'ComfyUI'
$comfyRootOld = Join-Path $Root 'ComfyUI-Easy-Install'
if (Test-Path (Join-Path $comfyRootNew 'main.py')) {
    $comfyRoot = $comfyRootNew
    $comfyApp = $comfyRootNew
} elseif (Test-Path (Join-Path $comfyRootOld 'ComfyUI\main.py')) {
    $comfyRoot = $comfyRootOld
    $comfyApp = Join-Path $comfyRootOld 'ComfyUI'
} elseif (Test-Path (Join-Path $comfyRootOld 'main.py')) {
    $comfyRoot = $comfyRootOld
    $comfyApp = $comfyRootOld
} else {
    $comfyRoot = $comfyRootNew
    $comfyApp = $comfyRootNew
}
# $flat: ядро лежит прямо в корне бэкенда (тогда python_embeded - тоже там)
$flat = ($comfyApp -eq $comfyRoot)
$pythonDir = Join-Path $comfyRoot 'python_embeded'
$python = Join-Path $pythonDir 'python.exe'
$script:Python = $python

# (правка 904) Ядро ComfyUI 0.44.0. В нём уже есть то, что мы раньше патчили
# (gate_compress, minimax_h3_layout, block_index), плюс новые ноды H3 и PDD.
$ComfyVersion = '0.44.0'
$ComfyZipName = 'ComfyUI-v0.44.0.zip'
$ComfyUrl = 'https://github.com/comfyanonymous/ComfyUI/archive/refs/tags/v0.44.0.zip'

# Версия ядра: сначала comfyui_version.py (его пишет сборка ComfyUI), затем
# pyproject.toml. Пустая строка - версию определить не удалось.
function Get-ComfyCoreVersion {
    param([string]$App)
    $vf = Join-Path $App 'comfyui_version.py'
    if (Test-Path $vf) {
        $m = Select-String -Path $vf -Pattern '__version__\s*=\s*"([^"]+)"' | Select-Object -First 1
        if ($m) { return $m.Matches[0].Groups[1].Value }
    }
    $pf = Join-Path $App 'pyproject.toml'
    if (Test-Path $pf) {
        $m = Select-String -Path $pf -Pattern '^version\s*=\s*"([^"]+)"' | Select-Object -First 1
        if ($m) { return $m.Matches[0].Groups[1].Value }
    }
    return ''
}

if (-not $SkipComfy) {
    Step 4 9 ('ComfyUI ' + $ComfyVersion) 'Ядро ComfyUI (~200 МБ с GitHub): 1-5 минут; при скачивании показываем скорость'

    if ($Force -and (Test-Path $comfyApp)) {
        Info 'удаляю ComfyUI (-Force)'
        Remove-Item $comfyApp -Recurse -Force
    }

    $hasCore = Test-Path (Join-Path $comfyApp 'main.py')
    $installedComfy = ''
    if ($hasCore) { $installedComfy = Get-ComfyCoreVersion $comfyApp }

    if ($hasCore -and $installedComfy -eq $ComfyVersion) {
        Ok ('ComfyUI уже на месте (' + $ComfyVersion + ')')
    } else {
        if ($installedComfy) {
            Info ('обновляю ядро ComfyUI ' + $installedComfy + ' -> ' + $ComfyVersion)
        } elseif ($hasCore) {
            Info 'версия ядра не определилась - переустанавливаю ядро'
        } else {
            Info ('ставлю ядро ComfyUI ' + $ComfyVersion)
        }

        $zip = Join-Path $Cache $ComfyZipName
        Get-Download $ComfyUrl $zip
        $tmp = Join-Path $Cache 'comfy-extract'
        if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
        Expand-ZipSafe $zip $tmp
        $inner = Get-ChildItem $tmp -Directory | Select-Object -First 1
        if (-not $inner) { throw 'архив ComfyUI распаковался пустым' }
        # (правка 915) в архиве ядро лежит в подпапке ComfyUI-<версия>; без main.py
        # дальше раскладывать нечего (битый или чужой архив).
        if (-not (Test-Path (Join-Path $inner.FullName 'main.py'))) {
            throw 'в архиве ComfyUI нет main.py'
        }
        # (правка 915) заранее НЕ создаём $comfyRoot: в плоской раскладке он совпадает
        # с $comfyApp, и Move-Item клал ядро ВНУТРЬ уже готовой папки
        # (ComfyUI\ComfyUI-0.44.0\main.py), а на повторной попытке падал
        # «Невозможно создать файл, так как он уже существует». Создаём только
        # родителя — в старой раскладке это ComfyUI-Easy-Install.
        $comfyParent = Split-Path -Parent $comfyApp
        if ($comfyParent -and -not (Test-Path $comfyParent)) {
            New-Item -ItemType Directory -Force -Path $comfyParent | Out-Null
        }

        # Данные пользователя, которые переносятся в новое ядро: модели, ноды,
        # настройки, готовые видео и подключённые внешние папки моделей.
        $keep = @('models', 'custom_nodes', 'user', 'output', 'input', 'temp', 'extra_model_paths.yaml', 'comfy.settings.json')
        # (правка 905) В плоской раскладке python_embeded лежит ВНУТРИ папки
        # ядра, поэтому его тоже уносим и возвращаем: пересобирать 7 ГБ
        # пакетов при смене ядра незачем.
        if ($flat) { $keep += 'python_embeded' }
        # Резервная копия и временная папка - СНАРУЖИ ядра: в плоской
        # раскладке comfyApp это comfyRoot, и перенос «внутрь себя» упал бы.
        $stage = Join-Path $Root 'ComfyUI.keep'
        $backup = Join-Path $Root 'ComfyUI.old'
        $movedOld = $false
        try {
            # (правка 915) уводим в backup ЛЮБУЮ существующую папку ядра, даже без
            # main.py: остаток прерванной попытки (например ComfyUI\ComfyUI-0.44.0)
            # иначе не даёт положить новое ядро — Move-Item падает «файл уже существует».
            if (Test-Path $comfyApp) {
                if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
                New-Item -ItemType Directory -Force -Path $stage | Out-Null
                foreach ($k in $keep) {
                    $src = Join-Path $comfyApp $k
                    if (-not (Test-Path $src)) { continue }
                    Move-Item $src (Join-Path $stage $k)
                }
                if (Test-Path $backup) { Remove-Item $backup -Recurse -Force }
                Move-Item $comfyApp $backup
                $movedOld = $true
            }
            Move-Item $inner.FullName $comfyApp
        } catch {
            # Откат: вернуть старое ядро и данные, чтобы не оставить
            # пользователя без ComfyUI.
            if ($movedOld -and -not (Test-Path $comfyApp) -and (Test-Path $backup)) {
                Move-Item $backup $comfyApp
            }
            if (Test-Path $stage) {
                foreach ($k in $keep) {
                    $src = Join-Path $stage $k
                    if (-not (Test-Path $src)) { continue }
                    $dst = Join-Path $comfyApp $k
                    if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
                    Move-Item $src $dst -ErrorAction SilentlyContinue
                }
            }
            throw ('не удалось развернуть ядро ComfyUI: ' + $_.Exception.Message)
        }

        if ($movedOld) {
            foreach ($k in $keep) {
                $src = Join-Path $stage $k
                if (-not (Test-Path $src)) { continue }
                $dst = Join-Path $comfyApp $k
                if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
                Move-Item $src $dst
            }
        }
        if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
        if (Test-Path $backup) { Remove-Item $backup -Recurse -Force }
        Remove-Item $tmp -Recurse -Force
        Ok ('ComfyUI ' + $ComfyVersion + ' распакован')
    }

    # Патчи проекта поверх ядра ComfyUI. Применяются при каждом запуске установщика,
    # поэтому повторный запуск чинит и уже испорченную установку.
    # На 0.44 патчим только два файла:
    #   comfy_extras/nodes_minimax_h3.py - наши ноды и правки H3 (второй выход
    #                                     AddGuide, audio-ноды, flf-фикс, ref-aspect);
    #   utils/extra_config.py           - списки путей в extra_model_paths.yaml
    #                                     (студия пишет их именно списками).
    # model.py и model_detection.py больше НЕ патчим: gate_compress и Veda-хуки
    # уже есть в ядре 0.44, а наши старые копии удаляли PDD/FLUX.3/Ming/ID-V2V.
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
    # Строка с каталогом ядра обязательна: start.bat запускает python с ключом -I,
    # который отключает добавление папки скрипта в sys.path, и без неё
    # main.py падает с ModuleNotFoundError: No module named 'comfy'.
    # (правка 905) Путь зависит от раскладки: плоская (python_embeded внутри
    # ядра) - '..', старая (python_embeded рядом с ядром) - '../ComfyUI'.
    $pth = Get-ChildItem $pythonDir -Filter 'python*._pth' | Select-Object -First 1
    if ($pth) {
        $coreRel = if ($flat) { '..' } else { '..\ComfyUI' }
        $lines = @(Get-Content $pth.FullName)
        $lines = @($lines | ForEach-Object { $_ -replace '^#\s*import site', 'import site' })
        if (-not ($lines | Where-Object { $_ -match '^Lib[\\/]site-packages' })) {
            $lines = @('Lib\site-packages') + $lines
        }
        # убираем любую прежнюю запись о ядре ('..' или '..\ComfyUI') и ставим актуальную
        $lines = @($lines | Where-Object { $_ -notmatch '^\.\.([\\/]+ComfyUI)?\s*$' })
        $lines = @($coreRel) + $lines
        if ($lines[0] -eq $coreRel) {
            Ok ('python312._pth настроен (' + $coreRel + ' + Lib\site-packages)')
        } else {
            Warn 'не удалось проверить python312._pth'
        }
        [IO.File]::WriteAllLines($pth.FullName, $lines, (New-Object Text.ASCIIEncoding))
    }

    # --- 5. библиотеки ---
    Step 5 9 'Библиотеки Python (~7 ГБ, самый долгий шаг)' 'torch и библиотеки: 10-40 минут на быстром канале; окно можно свернуть, не закрывайте его'

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
    Step 6 9 'Кастомные ноды (22 из GitHub + 5 локальных)' '22 архива с GitHub: 2-10 минут. Если отдельная нода не импортируется - студия всё равно работает, список ошибок будет в конце'

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
        $secN = [Math]::Max(0.5, $swN.Elapsed.TotalSeconds)
        Set-Speed (($gotN / 1MB) / $secN) ('ноды: ' + $pending.Count + ' архивов')
    }

    $idx = 0
    foreach ($node in $nodes) {
        $idx++
        $target = Join-Path $nodesDir $node.name
        Write-Progress -Activity 'Кастомные ноды' -Status $node.name -PercentComplete (($idx / $nodes.Count) * 100)

        # (правка 944) «уже установлена» = папка есть И в ней __init__.py: папка,
        # оставшаяся от неудачного Move-Item/распаковки, раньше считалась готовой
        # нодой НАВСЕГДА (пока не запустят с -Force), ComfyUI молча терял ноду, а
        # установка завершалась без ошибок. Ту же проверку делает самодиагностика.
        $nodeReady = (Test-Path $target) -and (Test-Path (Join-Path $target '__init__.py'))
        if ($nodeReady -and -not $Force) { Info ($node.name + ': уже установлена'); continue }
        if (Test-Path $target) {
            if (-not $nodeReady) { Info ($node.name + ': папка неполная - переустанавливаю') }
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

    # (правка 917) Патч VideoHelperSuite: видео без аудиодорожки не должно ронять
    # задание. В 0.44 ядро обходит все выходы ноды через PromptModelTracker.add(),
    # тот зовёт .values() на любом Mapping - и ленивое аудио VHS (LazyAudioMap)
    # бросает «VHS failed to extract audio» прямо на ноде-загрузчике, ещё до того
    # как его успеет прочитать наш guard. Патч меняет исключение на «звука нет».
    # Кладётся ПОСЛЕ распаковки нод: иначе архив ноды затрёт пропатченный файл.
    $vhsPatchDir = Join-Path $InstallDir 'vhs-patches'
    $vhsDir = Join-Path $nodesDir 'comfyui-videohelpersuite'
    if (-not (Test-Path $vhsDir)) { $vhsDir = Join-Path $nodesDir 'ComfyUI-VideoHelperSuite' }
    if ((Test-Path $vhsPatchDir) -and (Test-Path $vhsDir)) {
        $vPatched = 0
        Get-ChildItem $vhsPatchDir -Recurse -File | ForEach-Object {
            $rel = $_.FullName.Substring($vhsPatchDir.Length).TrimStart('\')
            $dest = Join-Path $vhsDir $rel
            $destDir = Split-Path $dest -Parent
            if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Force -Path $destDir | Out-Null }
            Copy-Item $_.FullName $dest -Force
            $vPatched++
        }
        Ok ('патч VideoHelperSuite применён: ' + $vPatched + ' файл(а)')
    } elseif (Test-Path $vhsPatchDir) {
        Warn 'custom_nodes\comfyui-videohelpersuite нет - патч VHS (правка 917) не применён'
    }
} else {
    Info 'пропущено (-SkipComfy)'
}

# --------------------------------------- 7. конфигурация и папки моделей ---

if (-not $SkipComfy) {
    Step 7 9 'Конфигурация и папки моделей' 'Создаём папки моделей и пути к ним: несколько секунд'

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
    Step 8 9 'Голосовой ввод (STT-рантайм transcribe.cpp)' 'STT (~200 МБ, необязательно): без него недоступен только голосовой ввод'

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
            if ($hash -ne $sttSha) {
                # (правка 944) битый архив не оставляем в кэше: Get-Download считал
                # его «уже скачанным» (gzip-заголовок на месте), и голосовой ввод
                # не починился бы уже никогда - только руками чистить кэш.
                Remove-StaleCacheFile $sttArchive
                throw 'контрольная сумма архива не совпала (архив удалён из кэша - запустите установку снова)'
            }

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
    Step 9 9 'Проверка установки' 'Запускаем ComfyUI и проверяем импорты: до 3 минут'

    # (правка 915) быстрый контроль раскладки: main.py должен лежать прямо в
    # $comfyApp — иначе трёхминутный smoke-тест ниже просто не поднимет сервер
    # («ComfyUI не поднялся за 180 секунд») без внятной причины.
    if (-not (Test-Path (Join-Path $comfyApp 'main.py'))) {
        Fail ('ядро ComfyUI лежит не там, где ожидается: нет ' + (Join-Path $comfyApp 'main.py'))
    } else {
        Ok ('ядро ComfyUI на месте: ' + $comfyApp)
    }

    Info 'проверяю импорт torch...'
    & $python -c "import torch, torchvision, torchaudio; print('      torch', torch.__version__, '| cuda:', torch.cuda.is_available())"
    if ($LASTEXITCODE -ne 0) {
    # (правка 940) на свежей машине самая частая причина именно этой ошибки -
    # старый VC++ redist: c10.dll не грузится, import torch падает с WinError 1114
    $extra = if ($script:VcRedistBroken) { ' - VC++ 2015-2022 x64 не обновился: поставьте его от администратора (' + $script:VcRedistUrl + '), затем запустите install.bat снова' } else { '' }
    Fail ('torch не импортируется' + $extra)
} else { Ok 'torch работает' }

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
# (правка 941) heartbeat останавливаем до записи: он пишет тот же файл и
# мог бы перезатереть done/error своим running.
Stop-StatusHeartbeat
if ($exitCode -eq 0) {
    Write-SetupStatus 'done' 9 9 'Установка завершена' 'Запусти start.bat и скачай модели в Настройках -> Модели'
} else {
    Write-SetupStatus 'error' $script:StatusStep 9 ('Установка завершилась с ошибками (шаг ' + $script:StatusStep + ')') ('Открой install.log и найди строку [ERROR]: там причина. Повторный запуск продолжает установку с того же места.')
}

if (-not $NoPause) {
    Write-Host '  Нажмите Enter, чтобы закрыть окно...' -ForegroundColor DarkGray
    try { [void](Read-Host) } catch { }
}

exit $exitCode
