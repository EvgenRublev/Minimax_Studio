# (правка 1157) Локальный регресс-тест установщика: пины comfy-aimdo не должны
# вызываться раньше, чем появится переносной Python. Чистая установка: ядро
# распаковано на шаге [4/9], python_embeded появляется только на [5/9]; пины
# дёргались сразу после ядра, звали & $script:Python, которого ещё нет, и
# PowerShell ронял установщик («НЕПРЕДВЗЯТАЯ ОШИБКА: Имя
# "...\python_embeded\python.exe" не распознано как имя командлета», exit 1).
# Тестируется НАСТОЯЩИЙ код из install\install.ps1: функции вырезаются построчно
# и подмешиваются в текущий сессионный runspace поверх стабов. Без сети, без ГПУ,
# без администратора.
#
# Запуск: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\installer-core-pins-test.ps1
# Копию изменённого установщика прогоняем так: -Installer <путь-к-install.ps1>
param([string]$Installer = 'E:\Minimax_Studio_V7_main\install\install.ps1')
$ErrorActionPreference = 'Stop'
$lines = (Get-Content -LiteralPath $Installer -Raw -Encoding UTF8) -split "`r`n"

function Get-FnBody([string]$startPattern) {
  $i = -1
  for ($k = 0; $k -lt $lines.Count; $k++) { if ($lines[$k] -match $startPattern) { $i = $k; break } }
  if ($i -lt 0) { throw "функция не найдена: $startPattern" }
  # закрывающая скобка функции - строка, где '}' стоит в первой колонке
  for ($j = $i + 1; $j -lt $lines.Count; $j++) { if ($lines[$j] -match '^\}') { return ($lines[$i..$j] -join "`r`n") } }
  throw "не найден конец функции: $startPattern"
}

# --- стаб-окружение: временный «корень студии» и фейковое ядро ---------------
$Cache = Join-Path $env:TEMP ('mms-pins-' + [Guid]::NewGuid().ToString('N'))
$Root = $Cache
$App = Join-Path $Cache 'ComfyUI'
New-Item -ItemType Directory -Force -Path $App | Out-Null
# requirements.txt ядра: точные пины + комментарий + голое имя (его брать нельзя)
Set-Content -LiteralPath (Join-Path $App 'requirements.txt') -Encoding UTF8 -Value @(
  '# пины ядра',
  'comfy-aimdo==0.6.0',
  'torch',
  'comfyui-frontend-package==1.27.14'
)

$script:UvExe = $null          # uv недоступен -> путь pip
$script:CoreRollback = $false
$script:Failures = New-Object System.Collections.ArrayList
$script:Warnings = New-Object System.Collections.ArrayList
$script:Infos = New-Object System.Collections.ArrayList
$script:Oks = New-Object System.Collections.ArrayList
function Write-Log { param([string]$m, [string]$Level = 'info') }
function Info { param([string]$m) [void]$script:Infos.Add($m) }
function Ok   { param([string]$m) [void]$script:Oks.Add($m) }
function Warn { param([string]$m) [void]$script:Warnings.Add($m) }
function Fail { param([string]$m) [void]$script:Failures.Add($m) }
# если pip/uv полезут в Python до его появления - тест это поймает
function Invoke-Uv { param($uargs) throw 'Invoke-Uv вызван раньше python_embeded' }
# фейк comfy-aimdo: версия берётся из заглушки (пусто = пакет не найден)
$script:AimdoStub = ''
function Get-InstalledAimdoVersion { param($R, $A) return $script:AimdoStub }

Invoke-Expression (Get-FnBody '^function Test-VersionAtLeast \{')
Invoke-Expression (Get-FnBody '^function Install-ComfyCorePins \{')
Invoke-Expression (Get-FnBody '^function Confirm-ComfyAimdoPins \{')

$pass = 0
$fails = New-Object System.Collections.ArrayList
function Ok-Check { param($cond, [string]$msg) if ($cond) { $script:pass++ } else { [void]$script:fails.Add($msg) } }

$pinsFile = Join-Path $Cache 'core-pins.txt'

# 0) $script:Python вообще не задан ($null) — Test-Path от $null сам по себе
#    terminating error, guard обязан проверять и это.
$script:Python = $null
$threw = ''
try { $r0 = Install-ComfyCorePins $App } catch { $threw = $_.Exception.Message }
Ok-Check ($threw -eq '') ('Install-ComfyCorePins при $script:Python = null бросает: ' + $threw)
$threw = ''
try { $c0 = Confirm-ComfyAimdoPins -App $App -CoreVersion '0.44.0' } catch { $threw = $_.Exception.Message }
Ok-Check ($threw -eq '') ('Confirm-ComfyAimdoPins при $script:Python = null бросает: ' + $threw)
Ok-Check (($r0 -eq $false) -and ($c0 -eq $true)) 'при null Python пины должны откладываться, а проверка aimdo - не считаться ошибкой'
$script:Infos.Clear(); $script:Failures.Clear()

# 1) Python ещё не установлен (так выглядит шаг [4/9] чистой установки) —
#    главный регресс: раньше здесь установщик умирал навсегда.
$script:Python = Join-Path $Cache 'python_embeded\python.exe'
$threw = ''
try { $r = Install-ComfyCorePins $App } catch { $threw = $_.Exception.Message }
Ok-Check ($threw -eq '') ('Install-ComfyCorePins без python_embeded бросает: ' + $threw)
Ok-Check ($r -eq $false) 'Install-ComfyCorePins без Python должен возвращать false'
Ok-Check (-not (Test-Path -LiteralPath $pinsFile)) 'пыны пишутся, когда Python ещё не установлен'
Ok-Check (@($script:Infos | Where-Object { $_ -match 'python_embeded ещё не установлен' }).Count -ge 1) 'нет объяснения, что пины поставит шаг Python'

$threw = ''
try { $c = Confirm-ComfyAimdoPins -App $App -CoreVersion '0.44.0' } catch { $threw = $_.Exception.Message }
Ok-Check ($threw -eq '') ('Confirm-ComfyAimdoPins без python_embeded бросает: ' + $threw)
Ok-Check ($c -eq $true) 'Confirm-ComfyAimdoPins без Python не должен считаться ошибкой'
Ok-Check ($script:Failures.Count -eq 0) ('без Python поставлен ложный Fail: ' + ($script:Failures -join '; '))

# 2) Python есть, comfy-aimdo не найден → пины реально пробуются, о несовпадении
#    сообщается как об ошибке (молча «успешная» установка = битый канал пинов).
$pyDir = Join-Path $Cache 'python_embeded'
New-Item -ItemType Directory -Force -Path $pyDir | Out-Null
# не-питон вместо питона: pip заведомо упадёт, выход по коду, без сети не нужно
Copy-Item -LiteralPath "$env:SystemRoot\System32\cmd.exe" -Destination (Join-Path $pyDir 'python.exe') -Force
$script:Failures.Clear(); $script:Warnings.Clear(); $script:Infos.Clear(); $script:Oks.Clear()
$threw = ''
try { $c = Confirm-ComfyAimdoPins -App $App -CoreVersion '0.44.0' } catch { $threw = $_.Exception.Message }
Ok-Check ($threw -eq '') ('Confirm-ComfyAimdoPins с Python бросает: ' + $threw)
Ok-Check (Test-Path -LiteralPath $pinsFile) 'comfy-aimdo нет, но пины ядра даже не пробуются'
Ok-Check ($c -eq $false) 'при отсутствующем comfy-aimdo проверка должна вернуть false'
Ok-Check (@($script:Failures | Where-Object { $_ -match 'comfy-aimdo' }).Count -ge 1) 'нет Fail про несовместимый comfy-aimdo'
Ok-Check (@($script:Warnings | Where-Object { $_ -match 'не соответствует ядру' }).Count -ge 1) 'нет Warn перед попыткой починить пины'

# 3) aimdo 0.6.0 соответствует ядру 0.44 → Ok, без Fail
$script:AimdoStub = '0.6.0'
$script:Failures.Clear(); $script:Oks.Clear(); $script:Warnings.Clear()
$c = Confirm-ComfyAimdoPins -App $App -CoreVersion '0.44.0'
Ok-Check ($c -eq $true) 'aimdo 0.6.0 при ядре 0.44 должен проходить'
Ok-Check ($script:Failures.Count -eq 0) ('ложный Fail при совместимом aimdo: ' + ($script:Failures -join '; '))
Ok-Check (@($script:Oks | Where-Object { $_ -match 'comfy-aimdo 0.6.0' }).Count -ge 1) 'нет Ok про соответствующий comfy-aimdo'

# 4) откатное ядро: aimdo 0.6.0 к 0.33 не подходит → false (пороги не перепутаны)
$script:CoreRollback = $true
$script:Failures.Clear(); $script:Oks.Clear(); $script:Warnings.Clear()
$c = Confirm-ComfyAimdoPins -App $App -CoreVersion '0.33.0'
Ok-Check ($c -eq $false) 'aimdo 0.6.0 при откатном ядре 0.33 обязан считаться несовместимым'
# а 0.4.13 на откатном ядре проходит
$script:AimdoStub = '0.4.13'
$script:Failures.Clear(); $script:Oks.Clear(); $script:Warnings.Clear()
$c = Confirm-ComfyAimdoPins -App $App -CoreVersion '0.33.0'
Ok-Check ($c -eq $true) 'aimdo 0.4.13 при ядре 0.33 должен проходить'

Remove-Item -LiteralPath $Cache -Recurse -Force -ErrorAction SilentlyContinue
Write-Host ''
Write-Host "PASS=$pass FAIL=$($fails.Count)"
foreach ($f in $fails) { Write-Host "  FAIL  $f" }
if ($fails.Count) { exit 1 }
exit 0
