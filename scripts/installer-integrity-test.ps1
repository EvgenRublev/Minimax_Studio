# (pravka 939) Local test of the installer integrity helpers. No network, no GPU.
# It extracts the real code from install\install.ps1 (pins loading + helper
# functions) and runs it against synthetic files: a good zip, a truncated zip,
# an HTML page named .zip, stale .part/segment leftovers.
#
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\installer-integrity-test.ps1
$ErrorActionPreference = 'Stop'
$root = 'E:\Minimax_Studio_V7_main'
$src = Join-Path $root 'install\install.ps1'

$txt = Get-Content -LiteralPath $src -Raw -Encoding UTF8
$lines = $txt -split "`r`n"

function Find-Line([string]$pattern) {
  for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match $pattern) { return $i } }
  return -1
}

$iPins = Find-Line '^\$script:Pins = @\{\}$'
$iFirstFn = Find-Line '^function Get-CacheRel \{'
$iBundle = Find-Line '^\$bundle = Join-Path \$InstallDir'
if ($iPins -lt 0 -or $iFirstFn -lt 0 -or $iBundle -lt 0) {
  Write-Host "FAIL: anchors not found (pins=$iPins fn=$iFirstFn bundle=$iBundle)"
  exit 1
}
if (-not ($iPins -lt $iFirstFn -and $iFirstFn -lt $iBundle)) {
  Write-Host 'FAIL: unexpected order of blocks in install.ps1'
  exit 1
}

$pinsBlock = ($lines[$iPins..($iFirstFn - 1)] -join "`r`n")
$helpersBlock = ($lines[$iFirstFn..($iBundle - 1)] -join "`r`n")

function Get-Fn([string]$startPattern) {
  $i = Find-Line $startPattern
  if ($i -lt 0) { throw "function not found: $startPattern" }
  for ($j = $i + 1; $j -lt $lines.Count; $j++) { if ($lines[$j] -eq '}') { return ($lines[$i..$j] -join "`r`n") } }
  throw "unterminated function: $startPattern"
}

# --- stubs the helpers rely on ---------------------------------------------
$Cache = Join-Path $env:TEMP ('mms-int-test-' + [Guid]::NewGuid().ToString('N'))
$InstallDir = Join-Path $root 'install'
New-Item -ItemType Directory -Force -Path $Cache | Out-Null
function Write-Log { param([string]$m, [string]$Level = 'info') }
function Info { param([string]$m) }
function Warn { param([string]$m) }

Invoke-Expression $pinsBlock
Invoke-Expression $helpersBlock
# expand-* helpers live further down install.ps1 (primitives section) - take them separately
Invoke-Expression (Get-Fn '^function Expand-ZipSafe \{')
Invoke-Expression (Get-Fn '^function Expand-TarGz \{')

$pass = 0
$fails = @()
function Ok([bool]$cond, [string]$msg) {
  if ($cond) { $script:pass++ } else { $script:fails += $msg }
}

# --- fixtures ---------------------------------------------------------------
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zipPath = Join-Path $Cache 'good.zip'
$z = [IO.Compression.ZipFile]::Open($zipPath, 'Create')
try {
  $entry = $z.CreateEntry('hello.txt')
  $w = New-Object IO.StreamWriter $entry.Open()
  $w.Write('hello world'); $w.Dispose()
} finally { $z.Dispose() }

$htmlPath = Join-Path $Cache 'python-3.12.10-embed-amd64.zip'
[IO.File]::WriteAllBytes($htmlPath, [Text.Encoding]::UTF8.GetBytes('<html><body>proxy portal</body></html>' + ('x' * 5000)))

$truncPath = Join-Path $Cache 'node-v22.20.0-win-x64.zip'
$head = [IO.File]::OpenRead($zipPath)
try { $buf = New-Object byte[] 4096; $n = $head.Read($buf, 0, 4096) } finally { $head.Dispose() }
[IO.File]::WriteAllBytes($truncPath, $buf[0..($n - 1)])

$gzipPath = Join-Path $Cache 'stt.tar.gz'
[IO.File]::WriteAllBytes($gzipPath, [byte[]](0x1F, 0x8B, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00))

# 1) magic-byte classification
Ok (Test-ArchiveFile $zipPath) 'good zip must pass'
Ok (-not (Test-ArchiveFile $htmlPath)) 'html named .zip must fail'
Ok ($script:IntegrityError -match 'ne arhiv|proxy|archive' -or $script:IntegrityError.Length -gt 0) 'integrity error text must be set'
Ok (Test-ArchiveFile $gzipPath -Kind 'gzip') 'gzip magic must pass'
Ok (-not (Test-ArchiveFile $gzipPath -Kind 'zip')) 'gzip must fail when zip expected'
Ok (-not (Test-ArchiveFile (Join-Path $Cache 'missing.zip'))) 'missing file must fail'

# 2) pins: the fake python/electron/node names are pinned in checksums.json,
#    so their size/sha must be enforced
Ok ($script:Pins.Count -gt 0) 'checksums.json must be loaded'
$pinPython = Get-PinFor $htmlPath
$pinNode = Get-PinFor $truncPath
Ok ($null -ne $pinPython) 'pin for python-3.12.10-embed-amd64.zip expected'
Ok ($null -ne $pinNode) 'pin for node-v22.20.0-win-x64.zip expected'
Ok (-not (Test-ArchiveFile $truncPath -CheckPin)) 'truncated pinned zip must fail pin check'
Ok ($script:IntegrityError -match ('sha256|size|' + [regex]::Unescape('\u0440\u0430\u0437\u043c\u0435\u0440'))) ('truncated pinned zip: reason should mention sha/size, got: ' + $script:IntegrityError)

# real bundle file must verify against its own pin
$realNode = Join-Path $InstallDir 'cache\node-v22.20.0-win-x64.zip'
if (Test-Path -LiteralPath $realNode) {
  $rel = 'node-v22.20.0-win-x64.zip'
  Ok (Test-ArchiveFile $realNode -Rel $rel -CheckPin) 'bundle node zip must match its checksums.json entry'
}

# GitHub ref zips are NOT pinned: magic only
$comfy = Join-Path $Cache 'ComfyUI-v0.44.0.zip'
Copy-Item $zipPath $comfy -Force
Ok (Test-ArchiveFile $comfy -CheckPin) 'unpinned archive should pass with valid magic even if sha differs'

# 3) case-insensitive pin lookup
Ok ($null -ne (Get-PinFor (Join-Path $Cache 'NODE-V22.20.0-WIN-X64.ZIP'))) 'pin lookup must be case-insensitive'

# 4) stale cache purge (file + .part + segments)
$stale = Join-Path $Cache 'stale.zip'
foreach ($p in @($stale, ($stale + '.part'), ($stale + '.0'), ($stale + '.1.new'), ($stale + '.keeper'))) {
  [IO.File]::WriteAllBytes($p, [byte[]](1, 2, 3))
}
Remove-StaleCacheFile $stale
Ok (-not (Test-Path $stale)) 'stale.zip must be removed'
Ok (-not (Test-Path ($stale + '.part'))) 'stale.zip.part must be removed'
Ok (-not (Test-Path ($stale + '.0'))) 'segment stale.zip.0 must be removed'
Ok (-not (Test-Path ($stale + '.1.new'))) 'segment stale.zip.1.new must be removed'
Ok (Test-Path ($stale + '.keeper')) 'unrelated stale.zip.keeper must survive'

# 5) Clear-CorruptCache keeps good files, drops bad ones
Clear-CorruptCache
Ok (Test-Path $zipPath) 'Clear-CorruptCache must keep a valid zip'
Ok (Test-Path $gzipPath) 'Clear-CorruptCache must keep a valid tar.gz'
Ok (-not (Test-Path $htmlPath)) 'Clear-CorruptCache must drop the html stub'
Ok (-not (Test-Path $truncPath)) 'Clear-CorruptCache must drop the truncated zip'
Ok (Test-Path $comfy) 'Clear-CorruptCache must keep an unpinned (GitHub ref) zip that has valid magic'

# 5b) (правка 944) get-pip.py - не архив: проверяем содержимое, а не магию,
#     и .part-докачку Clear-CorruptCache больше не трогает
$pipBadDir = Join-Path $Cache 'pyscript-bad'
New-Item -ItemType Directory -Force -Path $pipBadDir | Out-Null
$pipBad = Join-Path $pipBadDir 'get-pip.py'
[IO.File]::WriteAllBytes($pipBad, [Text.Encoding]::UTF8.GetBytes('<html><body>proxy portal</body></html>' + ('x' * 3000)))
Ok ((Get-ExpectedKind 'get-pip.py') -eq 'pyscript') 'get-pip.py must be classified as pyscript'
Ok (-not (Test-ArchiveFile $pipBad)) 'html named get-pip.py must fail'
Ok ($script:IntegrityError -match 'HTML') ('html get-pip.py: reason should mention HTML, got: ' + $script:IntegrityError)

$pipOkDir = Join-Path $Cache 'pyscript-ok'
New-Item -ItemType Directory -Force -Path $pipOkDir | Out-Null
$pipOk = Join-Path $pipOkDir 'get-pip.py'
$pipBody = "#!/usr/bin/env python`nimport sys`n" + (('# filler line' + "`n") * 200)
[IO.File]::WriteAllText($pipOk, $pipBody, (New-Object Text.UTF8Encoding($false)))
Ok (Test-ArchiveFile $pipOk) 'a real python get-pip.py must pass'

$bundlePip = Join-Path $InstallDir 'cache\get-pip.py'
if (Test-Path -LiteralPath $bundlePip) {
  Ok (Test-ArchiveFile $bundlePip -Rel 'get-pip.py' -CheckPin) 'bundle get-pip.py must pass its own check'
}

$resume = Join-Path $Cache 'torch-2.11.0+cu130-cp312-cp312-win_amd64.whl.part'
[IO.File]::WriteAllBytes($resume, [byte[]](0x50, 0x4B, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00))
Clear-CorruptCache
Ok (-not (Test-Path $pipBad)) 'Clear-CorruptCache must drop an html get-pip.py'
Ok (Test-Path $pipOk) 'Clear-CorruptCache must keep a valid get-pip.py'
Ok (Test-Path $resume) 'Clear-CorruptCache must keep .part (download resume)'

# 6) Expand-ZipSafe: html stub must be rejected before tar.exe runs, and purged
$bad = Join-Path $Cache 'expand-bad.zip'
[IO.File]::WriteAllBytes($bad, [Text.Encoding]::UTF8.GetBytes('<!DOCTYPE html>' + ('y' * 4000)))
$threw = $false
try { Expand-ZipSafe $bad (Join-Path $Cache 'expand-dest') } catch { $threw = $true }
Ok $threw 'Expand-ZipSafe must throw on a non-archive'
Ok (-not (Test-Path $bad)) 'Expand-ZipSafe must purge the broken archive from cache'

# valid zip unpacks
$threw = $false
try { Expand-ZipSafe $zipPath (Join-Path $Cache 'expand-ok') } catch { $threw = $true; Write-Host ('  expand error: ' + $_.Exception.Message) }
Ok (-not $threw) 'Expand-ZipSafe must unpack a valid zip'
Ok (Test-Path (Join-Path $Cache 'expand-ok\hello.txt')) 'unpacked content must exist'

# 7) -BundleSha: a file named like a bundle entry must match its recorded sha,
#    even when the artifact is not pinned (GitHub ref zips may differ per rebuild)
Ok (Test-ArchiveFile $comfy -CheckPin) 'unpinned valid zip: -CheckPin must pass'
Ok (-not (Test-ArchiveFile $comfy -BundleSha)) ('-BundleSha must reject a bundle-named archive with a wrong sha, got: ' + $script:IntegrityError)

Remove-Item -LiteralPath $Cache -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host ("PASS=" + $pass + " FAIL=" + $fails.Count)
foreach ($f in $fails) { Write-Host ('FAIL: ' + $f) }
if ($fails.Count -gt 0) { exit 1 } else { exit 0 }
