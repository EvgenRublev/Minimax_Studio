# (pravka 941) Regression test for the setup-status heartbeat.
#
# It pulls the REAL functions out of install\install.ps1 (Write-StatusJsonAtomic,
# Write-SetupStatus, Start/Stop-StatusHeartbeat), runs them in a child
# powershell.exe and checks that during a silent long step:
#   - setup_status.json stays "running" with the same step/total/hint/log,
#   - "ts" keeps advancing (the splash screen treats a status older than 12 min
#     as a dead installer),
#   - "detail" gets the elapsed marker.
#
# No downloads, no GPU, no admin rights. Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\installer-heartbeat-test.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root 'install\install.ps1'
if (-not (Test-Path -LiteralPath $src)) { Write-Host "FAIL: $src not found"; exit 1 }
$txt = [IO.File]::ReadAllText($src, [Text.Encoding]::UTF8)

$names = @('Write-StatusJsonAtomic', 'Write-SetupStatus', 'Set-Speed', 'Start-StatusHeartbeat', 'Stop-StatusHeartbeat')
$chunks = @()
foreach ($n in $names) {
  $m = [regex]::Match($txt, "(?m)^function $n \{[\s\S]*?\r?\n\}")
  if (-not $m.Success) { Write-Host "FAIL: install.ps1: function $n not found"; exit 1 }
  $chunks += $m.Value
}

$tmp = Join-Path $env:TEMP 'opencode\mms-heartbeat-test'
Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$statusFile = Join-Path $tmp 'setup_status.json'
$logFile = Join-Path $tmp 'install.log'

$body = @"
`$StatusFile = '$statusFile'
`$LogFile = '$logFile'
`$script:StatusStep = 0
`$script:StatusTitle = ''
`$script:StatusState = 'idle'
`$script:StatusHint = ''
`$script:SpeedMBs = 0
`$script:SpeedDetail = ''
`$script:StatusStartedAt = (Get-Date).AddMinutes(-7)
`$script:Heartbeat = `$null
$($chunks -join [Environment]::NewLine)
Write-SetupStatus 'running' 5 9 'python libs' 'the step hint'
Start-StatusHeartbeat
Start-Sleep -Seconds 90
"@
$runner = Join-Path $tmp 'harness.ps1'
[IO.File]::WriteAllText($runner, $body, (New-Object System.Text.UTF8Encoding($false)))

$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$child = Start-Process -FilePath $ps -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $runner) -PassThru -WindowStyle Hidden
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath $statusFile)) { Start-Sleep -Milliseconds 300 }

$pass = 0; $fail = 0
function T([bool]$cond, [string]$msg) { if ($cond) { $script:pass++; Write-Host "PASS: $msg" } else { $script:fail++; Write-Host "FAIL: $msg" } }

if (-not (Test-Path -LiteralPath $statusFile)) {
  Write-Host 'FAIL: harness never wrote setup_status.json'
  try { Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue } catch { }
  exit 1
}
$before = Get-Content -LiteralPath $statusFile -Raw | ConvertFrom-Json
$ts0 = [DateTime]::Parse($before.ts)
$d0 = [string]$before.detail

Start-Sleep -Seconds 25
$after = Get-Content -LiteralPath $statusFile -Raw | ConvertFrom-Json
$ts1 = [DateTime]::Parse($after.ts)
$d1 = [string]$after.detail

T ($after.state -eq 'running') 'state stays running'
T ($after.step -eq 5 -and $after.total -eq 9) 'step/total preserved'
T (([string]$after.hint) -eq 'the step hint') 'hint preserved by heartbeat'
T (([string]$after.log) -eq $logFile) 'log path preserved by heartbeat'
T (($ts1 - $ts0).TotalSeconds -ge 15) ('ts advanced while step was silent: ' + [int]($ts1 - $ts0).TotalSeconds + 's')
T ($d1 -ne $d0 -and $d1 -match '\d+') 'detail carries the elapsed marker'
T ($after.speed -eq 0) 'speed field survives the heartbeat rewrite'

# heartbeat writes must be atomic: a reader must never see half of the JSON
$raw = Get-Content -LiteralPath $statusFile -Raw
$broken = 0
for ($i = 0; $i -lt 40; $i++) {
  try { [void](Get-Content -LiteralPath $statusFile -Raw | ConvertFrom-Json) } catch { $broken++ }
  Start-Sleep -Milliseconds 200
}
T ($broken -eq 0) "status file always parsed cleanly (40 reads, broken=$broken)"
T (-not (Test-Path -LiteralPath ($statusFile + '.tmp'))) 'no leftover .tmp next to the status file'

try { Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue } catch { }
Write-Host ''
Write-Host "PASS=$pass FAIL=$fail"
exit $(if ($fail -gt 0) { 1 } else { 0 })
