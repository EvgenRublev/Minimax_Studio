# (правка 1084) Замена дерева ядра ComfyUI без переноса папок пользователя.
#
# Прежний установщик уносил keep-папки (models, custom_nodes, user, output,
# input, temp, python_embeded) в ComfyUI.keep и только потом заменял ядро.
# Папку models на Windows может держать открытый хэндл (проводник,
# антивирус, индексатор): запись внутрь работает, а Rename/Move — нет, и
# смена ядра падала с «Отказано в доступе по пути ...\ComfyUI\models».
#
# Здесь пользовательские папки не трогаются вообще: в ComfyUI.old уходят
# только элементы самого ядра, затем туда кладётся новое ядро. При ошибке
# старые файлы ядра возвращаются, keep-папки остаются как были.

function Install-ComfyCoreTree {
    param(
        [Parameter(Mandatory)][string]$App,
        [Parameter(Mandatory)][string]$NewCore,
        [Parameter(Mandatory)][string]$Backup,
        [Parameter(Mandatory)][string[]]$Keep
    )

    if (-not (Test-Path -LiteralPath $App)) {
        New-Item -ItemType Directory -Force -Path $App | Out-Null
    }
    if (Test-Path -LiteralPath $Backup) {
        Remove-Item -LiteralPath $Backup -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $Backup | Out-Null

    $movedOld = New-Object System.Collections.Generic.List[string]
    $movedNew = New-Object System.Collections.Generic.List[string]
    $newItems = @(Get-ChildItem -LiteralPath $NewCore -Force)
    $currentName = $null

    try {
        # 1. Файлы старого ядра — в backup. Keep-папки не трогаем.
        foreach ($item in @(Get-ChildItem -LiteralPath $App -Force)) {
            if ($Keep -contains $item.Name) { continue }
            Move-Item -LiteralPath $item.FullName -Destination (Join-Path $Backup $item.Name)
            $movedOld.Add($item.Name)
        }

        # 2. Новое ядро — на место. Существующие keep-папки (models и т.п.)
        #    сохраняют данные пользователя и не заменяются заготовками из zip.
        foreach ($item in $newItems) {
            $currentName = $item.Name
            $dest = Join-Path $App $item.Name
            if ($Keep -contains $item.Name) {
                if (Test-Path -LiteralPath $dest) { $currentName = $null; continue }
                Move-Item -LiteralPath $item.FullName -Destination $dest
                $movedNew.Add($item.Name)
                $currentName = $null
                continue
            }
            if (Test-Path -LiteralPath $dest) {
                Remove-Item -LiteralPath $dest -Recurse -Force
            }
            Move-Item -LiteralPath $item.FullName -Destination $dest
            $movedNew.Add($item.Name)
            $currentName = $null
        }
    } catch {
        # Откат: убрать перенесённые новые элементы (включая недоехавший),
        # вернуть старые файлы ядра из backup. Старые элементы, которые не
        # успели уехать в backup, не трогаем — иначе потеряем файлы ядра.
        if ($currentName) {
            $p = Join-Path $App $currentName
            if (Test-Path -LiteralPath $p) {
                Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
        foreach ($name in $movedNew) {
            $p = Join-Path $App $name
            if (Test-Path -LiteralPath $p) {
                Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
        foreach ($name in $movedOld) {
            $src = Join-Path $Backup $name
            if (Test-Path -LiteralPath $src) {
                Move-Item -LiteralPath $src -Destination (Join-Path $App $name)
            }
        }
        throw $_
    }

    return @{ MovedOld = @($movedOld); MovedNew = @($movedNew) }
}

# (правка 1086) База user/comfyui.db от 0.44 несовместима с 0.33: alembic
# 0.33 не знает ревизию 0009 и при старте пишет «Failed to initialize
# database». При откате уводим её в сторону с версией в имени, при возврате на
# 0.44 — возвращаем последнюю сохранённую. Сами файлы не удаляем.
function Switch-ComfyUserDatabase {
    param(
        [Parameter(Mandatory)][string]$App,
        [string]$FromVersion = '',
        [string]$ToVersion = ''
    )

    $userDir = Join-Path $App 'user'
    if (-not (Test-Path -LiteralPath $userDir)) { return @{} }
    $db = Join-Path $userDir 'comfyui.db'
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

    if ($FromVersion -like '0.44*' -and $ToVersion -like '0.33*' -and (Test-Path -LiteralPath $db)) {
        $bak = "$db.0.44-$stamp"
        Move-Item -LiteralPath $db -Destination $bak
        foreach ($suffix in @('-wal', '-shm')) {
            $side = "$db$suffix"
            if (Test-Path -LiteralPath $side) {
                Move-Item -LiteralPath $side -Destination "$bak$suffix"
            }
        }
        return @{ MovedDb = $bak }
    }

    if ($FromVersion -like '0.33*' -and $ToVersion -like '0.44*') {
        $bak = Get-ChildItem -LiteralPath $userDir -Filter 'comfyui.db.0.44-*' -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -notmatch '-(wal|shm)$' } |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 1
        if ($bak) {
            if (Test-Path -LiteralPath $db) {
                $old = "$db.0.33-$stamp"
                Move-Item -LiteralPath $db -Destination $old
                foreach ($suffix in @('-wal', '-shm')) {
                    $side = "$db$suffix"
                    if (Test-Path -LiteralPath $side) {
                        Move-Item -LiteralPath $side -Destination "$old$suffix"
                    }
                }
            }
            Move-Item -LiteralPath $bak.FullName -Destination $db
            foreach ($suffix in @('-wal', '-shm')) {
                $side = "$($bak.FullName)$suffix"
                if (Test-Path -LiteralPath $side) {
                    Move-Item -LiteralPath $side -Destination "$db$suffix"
                }
            }
            return @{ RestoredDb = $bak.FullName }
        }
    }

    return @{}
}
