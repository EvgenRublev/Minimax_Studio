# (fix 790) In-app updater: swaps app files AFTER the app has fully stopped.
#
# Spawned by electron/main.js (h3:apply-update) right before quit. It is NOT
# detached on purpose (fix 797): powershell 5.1 spawned with detached:true
# exits with code 0 in ~50 ms without running the script at all. On Windows a
# plain child survives its parent's exit anyway, and before-quit's killTree
# only touches the children list, which does not include this updater.
# Sequence:
#   1. wait for app PIDs to exit (up to 90 s), then force-kill leftovers;
#   2. verify .update\staging (package.json version, .next\BUILD_ID, and since
#      fix 924 the aggregate 'sha256-lines-v1' manifest recorded in armed.json);
#   3. back up every file we are about to replace into .update\backup;
#   4. copy staging files (everything except .next) over the app root;
#   5. swap .next by rename (same volume, atomic-ish): old -> .update\next_old,
#      staging .next -> root .next;
#   6. on any failure: roll back from backup + put next_old back;
#   7. relaunch the app (wscript start_hidden.vbs) or, if package-lock.json
#      changed, the dependency installer window (install\install_gui.vbs).
#
# User data is preserved: .env and config\config.ini are copied ONLY when
# missing. install\cache, models, data, node_modules, ComfyUI are never touched.
#
# Usage: powershell -File apply_update.ps1 -Root <dir> -Version <ver>
#        -DepsChanged True|False -WaitPids 123,456,789
#
# Keep this file ASCII-only: Windows PowerShell 5.1 misreads BOM-less UTF-8.

param(
    [string]$Root = '',
    [string]$Version = '',
    [string]$DepsChanged = 'False',
    [string]$WaitPids = ''
)

$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }

$upd      = Join-Path $Root '.update'
$staging  = Join-Path $upd 'staging'
$backup   = Join-Path $upd 'backup'
$nextOld  = Join-Path $upd 'next_old'
$logFile  = Join-Path $upd 'apply_update.log'

function Log($msg) {
    $line = ('{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg)
    try { Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8 } catch {}
    Write-Output $line
}

function Copy-WithRetry($src, $dst, $label) {
    for ($i = 0; $i -lt 5; $i++) {
        try {
            $dir = Split-Path -Parent $dst
            if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
            Copy-Item -LiteralPath $src -Destination $dst -Force
            return
        } catch {
            if ($i -eq 4) { throw ('copy failed (try {0}): {1}' -f $i, $label) }
            Start-Sleep -Milliseconds (400 * ($i + 1))
        }
    }
}

function Move-Dir-WithRetry($src, $dst, $label) {
    for ($i = 0; $i -lt 8; $i++) {
        try {
            if (Test-Path -LiteralPath $dst) { Remove-Item -LiteralPath $dst -Recurse -Force }
            [System.IO.Directory]::Move($src, $dst)
            return
        } catch {
            if ($i -eq 7) { throw ('dir move failed: {0}' -f $label) }
            Start-Sleep -Milliseconds (500 * ($i + 1))
        }
    }
}

function Remove-IfExists($path) {
    try { if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force } } catch {}
}

function Relaunch($scriptRel) {
    try {
        $target = Join-Path $Root $scriptRel
        if (-not (Test-Path -LiteralPath $target)) { Log "relaunch: $scriptRel not found"; return }
        $si = New-Object System.Diagnostics.ProcessStartInfo
        $si.FileName = 'wscript.exe'
        $si.Arguments = '"' + $target + '"'
        $si.WorkingDirectory = $Root
        $si.UseShellExecute = $true
        [System.Diagnostics.Process]::Start($si) | Out-Null
        Log "relaunched: $scriptRel"
    } catch {
        Log ('relaunch failed: ' + $_.Exception.Message)
    }
}

# User files that must never be overwritten when they already exist.
$protectIfMissing = @('.env', 'config\config.ini')

function Is-Protected($relPath) {
    foreach ($p in $protectIfMissing) {
        if ($relPath -ieq $p) { return $true }
    }
    return $false
}

# (fix 925) Aggregate hash of the staging tree. Must match stagingAggregateHash()
# in src/lib/app-update.ts exactly: for every file a line "relpath:sha256hex"
# (relpath with forward slashes, hash lowercase), lines sorted ordinal (UTF-16
# code units), each terminated by LF, whole text UTF-8 without BOM, then sha256.
function Get-StagingAggregateHash($base) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $enc = New-Object System.Text.UTF8Encoding($false)
    $prefix = $base.Length + 1
    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($f in (Get-ChildItem -LiteralPath $base -Recurse -File)) {
        $rel = $f.FullName.Substring($prefix).Replace('\', '/')
        $fs = [System.IO.File]::OpenRead($f.FullName)
        try { $fh = $sha.ComputeHash($fs) } finally { $fs.Dispose() }
        $hex = -join ($fh | ForEach-Object { $_.ToString('x2') })
        $lines.Add($rel + ':' + $hex)
    }
    $lines.Sort([System.StringComparer]::Ordinal)
    $sb = New-Object System.Text.StringBuilder
    foreach ($l in $lines) { [void]$sb.Append($l).Append("`n") }
    $agg = $sha.ComputeHash($enc.GetBytes($sb.ToString()))
    return (-join ($agg | ForEach-Object { $_.ToString('x2') }))
}

# (fix 925) Compare the manifest saved by the app when the update was armed
# with the staging tree as it exists now. Tampering between arming and the
# restart-for-apply is detected here, BEFORE any file is copied. An armed.json
# without a manifest (armed by an older version) skips the check.
function Test-StagingManifest {
    $armedPath = Join-Path $upd 'armed.json'
    if (-not (Test-Path -LiteralPath $armedPath)) { Log 'armed.json missing - skip integrity check'; return $true }
    $armedObj = $null
    try { $armedObj = Get-Content -LiteralPath $armedPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { Log 'armed.json unreadable - skip integrity check'; return $true }
    if (-not ($armedObj.manifest -and $armedObj.manifest.algo -eq 'sha256-lines-v1' -and $armedObj.manifest.hash)) {
        Log 'armed.json has no manifest (older version armed it) - skip integrity check'
        return $true
    }
    $actual = Get-StagingAggregateHash $staging
    if ($actual -ne $armedObj.manifest.hash) {
        Log ('STAGING TAMPERED: expected ' + $armedObj.manifest.hash + ' got ' + $actual)
        return $false
    }
    Log 'staging integrity check ok'
    return $true
}

Log ('=== apply_update start: version=' + $Version + ' depsChanged=' + $DepsChanged + ' waitPids=' + $WaitPids + ' ===')

# ------------------------------------------- 1. wait for the app to stop ---
$pids = @()
foreach ($s in ($WaitPids -split ',')) {
    $n = 0
    if ([int]::TryParse($s.Trim(), [ref]$n) -and $n -gt 0) { $pids += $n }
}
$deadline = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $deadline) {
    $alive = @($pids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
    if ($alive.Count -eq 0) { break }
    Start-Sleep -Milliseconds 500
}
foreach ($n in $pids) {
    if (Get-Process -Id $n -ErrorAction SilentlyContinue) {
        Log "pid $n still alive after 90 s - force killing"
        try { & taskkill /T /F /PID $n 2>&1 | Out-Null } catch {}
    }
}
Start-Sleep -Seconds 2

# ------------------------------------------------- 2. verify the staging ---
$ok = $false
$stagedPkg = Join-Path $staging 'package.json'
if (-not (Test-Path -LiteralPath $stagedPkg)) {
    Log 'staging/package.json missing - abort'
} else {
    try {
        $pkgVer = ($stagedPkg | Get-Content -Raw -Encoding UTF8 | ConvertFrom-Json).version
    } catch { $pkgVer = $null }
    if ($Version -and $pkgVer -and ($pkgVer -ne $Version)) {
        Log "staging version $pkgVer != requested $Version - abort"
    } elseif (-not (Test-Path -LiteralPath (Join-Path $staging '.next\BUILD_ID'))) {
        Log 'staging/.next/BUILD_ID missing - abort'
    } elseif (-not (Test-StagingManifest)) {
        # (fix 925) abort before ANY change: nothing has been copied yet at this point
        Log 'staging integrity check failed - abort'
    } else {
        $ok = $true
    }
}
if (-not $ok) {
    Relaunch 'start_hidden.vbs'
    exit 1
}

# ------------------------------------------------- 3. fresh dependency? ---
# Recompute from hashes (authoritative); fall back to the passed flag.
$deps = ($DepsChanged -ieq 'true')
try {
    $a = (Get-FileHash -LiteralPath (Join-Path $Root 'package-lock.json') -Algorithm SHA256).Hash
    $b = (Get-FileHash -LiteralPath (Join-Path $staging 'package-lock.json') -Algorithm SHA256).Hash
    $deps = ($a -ne $b)
} catch { }
Log ('deps changed: ' + $deps)

# (fix 958) A changed lock hash does not always mean the dependency installer is
# needed: build-only packages (i18next) may be missing while the app starts fine,
# and npm ci wipes node_modules. Probe the staged package.json against
# node_modules with the bundled node; when every package resolves, skip the
# installer and relaunch the app immediately.
if ($deps) {
    $probeNode = Join-Path $Root 'runtime\node.exe'
    if (Test-Path -LiteralPath $probeNode) {
        try {
            $stagedDeps = (Get-Content -LiteralPath (Join-Path $staging 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).dependencies
            $names = @($stagedDeps.PSObject.Properties | ForEach-Object { $_.Name })
            if ($names.Count -gt 0) {
                $namesJson = '["' + ($names -join '","') + '"]'
                $probe = 'var n=' + $namesJson + ';var m=[];for(var i=0;i<n.length;i++){try{require.resolve(n[i])}catch(e){m.push(n[i])}}process.stdout.write(m.join(","))'
                Push-Location $Root
                try { $missing = (& $probeNode -e $probe 2>$null) -join '' } finally { Pop-Location }
                if (-not $missing) {
                    $deps = $false
                    Log 'all staged dependencies resolve - dependency installer skipped'
                } else {
                    Log ('missing staged dependencies: ' + $missing)
                }
            }
        } catch { Log ('dependency probe failed: ' + $_.Exception.Message) }
    }
}

# ------------------------------- 3b. undo leftovers of an interrupted run ---
if (Test-Path -LiteralPath $backup) {
    Log 'previous backup found - restoring it first (interrupted update)'
    Get-ChildItem -LiteralPath $backup -Recurse -File | ForEach-Object {
        $rel = $_.FullName.Substring($backup.Length + 1)
        try { Copy-WithRetry $_.FullName (Join-Path $Root $rel) "rollback $rel" } catch { Log "rollback failed: $rel" }
    }
    Remove-IfExists $backup
}
if (Test-Path -LiteralPath $nextOld) {
    if (-not (Test-Path -LiteralPath (Join-Path $Root '.next'))) {
        try { Move-Dir-WithRetry $nextOld (Join-Path $Root '.next') 'restore next_old' } catch { Log 'restore next_old failed' }
    } else {
        Remove-IfExists $nextOld
    }
}

# ------------------------------------------------ 4+5. backup and replace ---
$swappedNext = $false
try {
    Remove-IfExists $backup
    New-Item -ItemType Directory -Path $backup -Force | Out-Null

    $stagingPrefix = $staging.Length + 1
    $files = Get-ChildItem -LiteralPath $staging -Recurse -File | Where-Object {
        $_.FullName.Substring($stagingPrefix) -notlike '.next\*'
    }
    Log ('replacing ' + $files.Count + ' files (excluding .next)')

    # 4a. backup current copies of everything we will replace
    foreach ($f in $files) {
        $rel = $f.FullName.Substring($stagingPrefix)
        $cur = Join-Path $Root $rel
        if (Test-Path -LiteralPath $cur) {
            Copy-WithRetry $cur (Join-Path $backup $rel) "backup $rel"
        }
    }

    # 4b. copy new files in
    foreach ($f in $files) {
        $rel = $f.FullName.Substring($stagingPrefix)
        $dst = Join-Path $Root $rel
        if ((Test-Path -LiteralPath $dst) -and (Is-Protected $rel)) {
            continue  # user .env / config.ini: keep the user's file
        }
        if (-not (Test-Path -LiteralPath $dst) -and (Is-Protected $rel)) {
            Copy-WithRetry $f.FullName $dst "protected-new $rel"  # missing -> ship default
            continue
        }
        Copy-WithRetry $f.FullName $dst $rel
    }

    # 5. swap .next by directory rename (staging and root share the volume)
    $rootNext = Join-Path $Root '.next'
    if (Test-Path -LiteralPath $rootNext) {
        Move-Dir-WithRetry $rootNext $nextOld 'move old .next out'
    }
    Move-Dir-WithRetry (Join-Path $staging '.next') $rootNext 'move new .next in'
    $swappedNext = $true

    # ------------------------------------------------------- 6. success ---
    Remove-IfExists $backup
    Remove-IfExists $nextOld
    Remove-IfExists $staging
    foreach ($junk in @('armed.json', 'update_zip.json', 'update_download.json', 'update.zip', 'update.zip.part')) {
        Remove-IfExists (Join-Path $upd $junk)
    }
    Log ('=== update to ' + $Version + ' applied OK ===')
    if ($deps) {
        Relaunch 'install\install_gui.vbs'   # dependencies changed: reinstall first
    } else {
        Relaunch 'start_hidden.vbs'
    }
    exit 0
} catch {
    Log ('FAILED: ' + $_.Exception.Message)

    # --------------------------------------------------- 6b. roll back ---
    try {
        if (Test-Path -LiteralPath $backup) {
            Get-ChildItem -LiteralPath $backup -Recurse -File | ForEach-Object {
                $rel = $_.FullName.Substring($backup.Length + 1)
                try { Copy-WithRetry $_.FullName (Join-Path $Root $rel) "rollback $rel" } catch { Log "rollback failed: $rel" }
            }
        }
    } catch { Log ('rollback error: ' + $_.Exception.Message) }
    if ($swappedNext -or -not (Test-Path -LiteralPath (Join-Path $Root '.next'))) {
        if (Test-Path -LiteralPath $nextOld) {
            try {
                Remove-IfExists (Join-Path $Root '.next')
                Move-Dir-WithRetry $nextOld (Join-Path $Root '.next') 'restore next_old'
            } catch { Log 'restore next_old failed' }
        }
    }
    Remove-IfExists $backup
    Log '=== update failed - rolled back, relaunching old version ==='
    Relaunch 'start_hidden.vbs'
    exit 2
}
