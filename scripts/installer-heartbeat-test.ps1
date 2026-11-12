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
`$script:HeartbeatMaxBytes = 200000
$($chunks -join [Environment]::NewLine)
# Cyrillic hint built from code points (this test file stays ASCII on purpose):
# it is the round-trip that used to break - the heartbeat read the status file
# back with the wrong encoding and mangled it.
`$cyr = -join ([char[]]@(0x43F, 0x440, 0x438, 0x432, 0x435, 0x442, 0x20, 0x43C, 0x438, 0x440))
Write-SetupStatus 'running' 5 9 'python libs' `$cyr
# detail+speed are what Set-Speed writes during downloads; the heartbeat must
# leave them exactly as they were (this is the field that exploded in 942)
Set-Speed 12.3 `$cyr
Start-StatusHeartbeat
Start-Sleep -Seconds 90
"@
$runner = Join-Path $tmp 'harness.ps1'
# BOM is required here: harness.ps1 embeds functions taken from install.ps1,
# which contain Cyrillic in comments; without a BOM PowerShell 5.1 would read
# this file as ANSI and mangle them.
[IO.File]::WriteAllText($runner, $body, (New-Object System.Text.UTF8Encoding($true)))

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
function Read-Status {
  # read explicitly as UTF-8: PowerShell 5.1 reads UTF-8 without BOM as ANSI,
  # which is what started the 942 bug
  return ([IO.File]::ReadAllText($statusFile, [Text.Encoding]::UTF8) | ConvertFrom-Json)
}
$cyr = -join ([char[]]@(0x43F, 0x440, 0x438, 0x432, 0x435, 0x442, 0x20, 0x43C, 0x438, 0x440))
# wait until the harness made both writes (Write-SetupStatus + Set-Speed),
# otherwise $before could be captured between them
$deadline2 = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline2) {
  try { $probe = Read-Status; if ($probe.speed -gt 0 -and [string]$probe.hint -eq $cyr) { break } } catch { }
  Start-Sleep -Milliseconds 200
}
$before = Read-Status
$ts0 = [DateTime]::Parse($before.ts)
$d0 = [string]$before.detail

T (([string]$before.hint) -eq $cyr) 'cyrillic hint survives the initial write'
T (([string]$before.detail) -eq $cyr) 'cyrillic detail survives the initial write'

Start-Sleep -Seconds 25
$after = Read-Status
$ts1 = [DateTime]::Parse($after.ts)
$d1 = [string]$after.detail

T ($after.state -eq 'running') 'state stays running'
T ($after.step -eq 5 -and $after.total -eq 9) 'step/total preserved'
T (([string]$after.hint) -eq $cyr) 'hint preserved by heartbeat (also through UTF-8 round-trip)'
T (([string]$after.log) -eq $logFile) 'log path preserved by heartbeat'
T (($ts1 - $ts0).TotalSeconds -ge 15) ('ts advanced while step was silent: ' + [int]($ts1 - $ts0).TotalSeconds + 's')
# (pravka 942) heartbeat must NOT touch text fields: in the live install run it
# appended its own text to "detail" every tick, and because the status file was
# read back with the wrong encoding the marker never matched and "detail" doubled
# per tick - the status file grew to 1.6 GB.
T (([string]$after.detail) -eq $d0) ('detail is untouched by heartbeat: "' + [string]$after.detail + '"')
T ([int]$after.elapsed_min -ge 7) ('elapsed_min counts up: ' + [int]$after.elapsed_min)
T ([Math]::Abs([double]$after.speed - 12.3) -lt 0.01) ('speed preserved by heartbeat: ' + [string]$after.speed)
$len1 = (Get-Item -LiteralPath $statusFile).Length
T ($len1 -lt 4096) ("status file stays small: $len1 bytes")
# encoding round-trip: non-ASCII bytes must not multiply between reads
$bytes1 = [IO.File]::ReadAllBytes($statusFile)
$hi1 = @($bytes1 | Where-Object { $_ -gt 127 }).Count
Start-Sleep -Seconds 12
$bytes2 = [IO.File]::ReadAllBytes($statusFile)
$hi2 = @($bytes2 | Where-Object { $_ -gt 127 }).Count
T ($hi2 -eq $hi1 -and $hi1 -gt 0) "cyrillic bytes unchanged across heartbeat ticks (high bytes $hi1 -> $hi2)"
T (([string](Read-Status).hint) -eq $cyr) 'cyrillic hint still intact after further ticks'
T ((Get-Item -LiteralPath $statusFile).Length -lt 4096) 'status file still small after another tick'

# heartbeat writes must be atomic: a reader must never see half of the JSON
$broken = 0
for ($i = 0; $i -lt 40; $i++) {
  try { [void](Read-Status) } catch { $broken++ }
  Start-Sleep -Milliseconds 200
}
T ($broken -eq 0) "status file always parsed cleanly (40 reads, broken=$broken)"
T (-not (Test-Path -LiteralPath ($statusFile + '.tmp'))) 'no leftover .tmp next to the status file'

try { Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue } catch { }
Write-Host ''
Write-Host "PASS=$pass FAIL=$fail"
exit $(if ($fail -gt 0) { 1 } else { 0 })
