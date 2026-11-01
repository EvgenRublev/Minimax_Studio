# (fix 790) In-app updater: swaps app files AFTER the app has fully stopped.
#
# Spawned by electron/main.js (h3:apply-update) right before quit. It is NOT
# detached on purpose (fix 797): powershell 5.1 spawned with detached:true
# exits with code 0 in ~50 ms without running the script at all. On Windows a
# plain child survives its parent's exit anyway, and before-quit's killTree
# only touches the children list, which does not include this updater.
# Sequence:
#   1. wait for app PIDs to exit (up to 90 s), then force-kill leftovers;
#   2. verify .update\staging (package.json version, .next\BUILD_ID);
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
