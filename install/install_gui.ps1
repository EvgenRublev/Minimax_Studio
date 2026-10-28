# (правки 753/756) Тематический загрузчик установки зависимостей.
#
# Окно повторяет «хром» приложения (тёмно-серая тема .dark-gray):
#   - шапка 36px #1c1c20, логотип 16px, название 11px #8b8b94,
#     кнопки «свернуть» и «закрыть» как в DesktopTitleBar (hover, красный крестик)
#   - фон #1c1c20, панели #2b2b31, текст #e8e8ec, приглушённый #9a9aa4
#   - прогресс: градиент заставки #f59e0b -> #a78bfa
#   - лог: тёмная панель #17171a с ТОНКОЙ своей полосой прокрутки (нативная скрыта)
#
# Один экземпляр: второй запуск (инсталлятор + start.bat) молча выходит.
# install.ps1 запускается скрыто и пишет шаги в setup_status.json + install.log.
# После успеха окно само запускает приложение (start_hidden.vbs).
#
# Параметры:
#   -Root <dir>   папка программы (по умолчанию — родитель install\)
#   -NoAutoStart  не запускать приложение после установки

param(
    [string]$Root = '',
    [switch]$NoAutoStart
)

# ------------------------------------------------------ single instance ---
$mutex = New-Object System.Threading.Mutex($false, 'Local\MinimaxH3StudioSetupGui')
$haveMutex = $false
try {
    $haveMutex = $mutex.WaitOne(0)
} catch [System.Threading.AbandonedMutexException] {
    $haveMutex = $true
} catch {
    $haveMutex = $false
}
if (-not $haveMutex) { exit 0 }

$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

Add-Type -Name Win32Ui -Namespace Gui -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ReleaseCapture();
[DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, int Msg, IntPtr wParam, IntPtr lParam);
[DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, int Msg, IntPtr wParam, ref RECT lParam);
[DllImport("user32.dll")] public static extern bool GetScrollInfo(IntPtr hWnd, int nBar, ref SCROLLINFO si);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
[StructLayout(LayoutKind.Sequential)] public struct SCROLLINFO { public uint cbSize; public uint fMask; public int nMin; public int nMax; public uint nPage; public int nPos; public int nTrackPos; }
'@ -ErrorAction SilentlyContinue

if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
$Root = [IO.Path]::GetFullPath($Root)
if ($Root.Length -gt 3 -and $Root.EndsWith('\')) { $Root = $Root.Substring(0, $Root.Length - 1) }

$Cache = Join-Path $Root '.install-cache'
$StatusFile = Join-Path $Cache 'setup_status.json'
$InstallPs = Join-Path $Root 'install\install.ps1'
$LogFile = Join-Path $Root 'install.log'
$IconIco = Join-Path $Root 'electron\icons\icon.ico'
$IconPng = Join-Path $Root 'electron\icons\icon-128.png'
$PsExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

$script:pct = 0
$script:child = $null
$script:doneAt = $null
$script:state = 'idle'
$script:monitorOnly = $false
$script:closing = $false
$script:barTrackH = 100

# --------------------------------------------------------------- palette ---
# Тёмно-серая тема приложения (.dark-gray), см. src/app/globals.css
$C_BG = [System.Drawing.ColorTranslator]::FromHtml('#1c1c20')
$C_HEAD = [System.Drawing.ColorTranslator]::FromHtml('#1c1c20')
$C_HEAD_LINE = [System.Drawing.ColorTranslator]::FromHtml('#101012')
$C_BORDER = [System.Drawing.ColorTranslator]::FromHtml('#34343a')
$C_TEXT = [System.Drawing.ColorTranslator]::FromHtml('#e8e8ec')
$C_MUTED = [System.Drawing.ColorTranslator]::FromHtml('#9a9aa4')
$C_HEAD_TEXT = [System.Drawing.ColorTranslator]::FromHtml('#8b8b94')
$C_SOFT = [System.Drawing.ColorTranslator]::FromHtml('#d8d8de')
$C_TRACK = [System.Drawing.ColorTranslator]::FromHtml('#2f2f36')
$C_BTN = [System.Drawing.ColorTranslator]::FromHtml('#2b2b31')
$C_BTN_HOVER = [System.Drawing.ColorTranslator]::FromHtml('#33333a')
$C_LOG_BG = [System.Drawing.ColorTranslator]::FromHtml('#17171a')
$C_LOG_BORDER = [System.Drawing.ColorTranslator]::FromHtml('#2a2a30')
$C_LOG_TEXT = [System.Drawing.ColorTranslator]::FromHtml('#a8a8b3')
$C_ERR = [System.Drawing.ColorTranslator]::FromHtml('#ef4444')
$C_OK = [System.Drawing.ColorTranslator]::FromHtml('#34d399')
$C_A = [System.Drawing.ColorTranslator]::FromHtml('#f59e0b')
$C_B = [System.Drawing.ColorTranslator]::FromHtml('#a78bfa')
$C_SB_TRACK = [System.Drawing.ColorTranslator]::FromHtml('#232328')
$C_SB_THUMB = [System.Drawing.ColorTranslator]::FromHtml('#4a4a52')
$C_SB_HOVER = [System.Drawing.ColorTranslator]::FromHtml('#5c5c66')

# ------------------------------------------------------------ log buffer ---
$script:logFrom = 0
$script:logBuf = New-Object System.Text.StringBuilder
$script:logShown = ''
try { if (Test-Path $LogFile) { $script:logFrom = (Get-Item $LogFile).Length } } catch { }

function Read-NewLog {
    try {
        if (-not (Test-Path $LogFile)) { return }
        $chunk = ''
        $fs = [IO.File]::Open($LogFile, 'Open', 'Read', 'ReadWrite')
        try {
            if ($fs.Length -lt $script:logFrom) {
                $script:logFrom = 0
                [void]$script:logBuf.Clear()
            }
            [void]$fs.Seek($script:logFrom, 'Begin')
            $sr = New-Object IO.StreamReader($fs, [Text.Encoding]::UTF8)
            $chunk = $sr.ReadToEnd()
            $script:logFrom = $fs.Position
            $sr.Dispose()
        } finally { $fs.Dispose() }
        if ($chunk) {
            if ($chunk[0] -eq [char]0xFEFF) { $chunk = $chunk.Substring(1) }
            [void]$script:logBuf.Append($chunk)
        }
    } catch { return }
}

function Get-Status {
    try {
        if (-not (Test-Path $StatusFile)) { return $null }
        return (Get-Content -Path $StatusFile -Raw -Encoding UTF8 | ConvertFrom-Json)
    } catch { return $null }
}

function Write-StatusError([string]$Title) {
    try {
        New-Item -ItemType Directory -Force -Path $Cache | Out-Null
        $o = [ordered]@{
            state = 'error'; step = 0; total = 9
            title = $Title; pid = 0
            ts    = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        }
        $json = ($o | ConvertTo-Json -Compress)
        [IO.File]::WriteAllText($StatusFile, $json, (New-Object System.Text.UTF8Encoding($false)))
    } catch { }
}

function Test-PidAlive([int]$ProcessId) {
    if ($ProcessId -le 0) { return $false }
    return ($null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue))
}

# --------------------------------------------------------------- window ---

$form = New-Object System.Windows.Forms.Form
$form.Text = 'MiniMax H3 Studio 7 - установка зависимостей'
$form.ClientSize = New-Object System.Drawing.Size(668, 442)
$form.BackColor = $C_BG
$form.ForeColor = $C_TEXT
$form.FormBorderStyle = 'None'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true
$form.Font = New-Object System.Drawing.Font('Segoe UI', 9)
if (Test-Path $IconIco) {
    try { $form.Icon = New-Object System.Drawing.Icon($IconIco) } catch { }
}
$form.Add_Paint({
    param($s, $e)
    try {
        $pen = New-Object System.Drawing.Pen($C_BORDER, 1)
        $e.Graphics.DrawRectangle($pen, 0, 0, ($s.Width - 1), ($s.Height - 1))
        $pen.Dispose()
    } catch { }
})

# --- шапка как в приложении (DesktopTitleBar): 36px, лого 16px, тонкий текст
$header = New-Object System.Windows.Forms.Panel
$header.Dock = 'Top'
$header.Height = 36
$header.BackColor = $C_HEAD
$header.Add_Paint({
    param($s, $e)
    try {
        $pen = New-Object System.Drawing.Pen($C_HEAD_LINE, 1)
        $e.Graphics.DrawLine($pen, 0, ($s.Height - 1), $s.Width, ($s.Height - 1))
        $pen.Dispose()
    } catch { }
})
$form.Controls.Add($header)

# Логотип: уменьшаем крупный PNG качественно (иначе 16px-кадр .ico рябит)
$logo = $null
try {
    if (Test-Path $IconPng) {
        $src = [System.Drawing.Image]::FromFile($IconPng)
        $logo = New-Object System.Drawing.Bitmap(16, 16)
        $lg = [System.Drawing.Graphics]::FromImage($logo)
        $lg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $lg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $lg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $lg.DrawImage($src, 0, 0, 16, 16)
        $lg.Dispose()
        $src.Dispose()
    }
} catch { $logo = $null }

$iconBox = New-Object System.Windows.Forms.PictureBox
$iconBox.Size = New-Object System.Drawing.Size(16, 16)
$iconBox.Location = New-Object System.Drawing.Point(12, 10)
$iconBox.BackColor = [System.Drawing.Color]::Transparent
if ($logo) { $iconBox.Image = $logo }
$header.Controls.Add($iconBox)

$headerTitle = New-Object System.Windows.Forms.Label
$headerTitle.Text = 'MiniMax H3 Studio 7'
$headerTitle.Font = New-Object System.Drawing.Font('Segoe UI', 8.5)
$headerTitle.ForeColor = $C_HEAD_TEXT
$headerTitle.AutoSize = $true
$headerTitle.BackColor = [System.Drawing.Color]::Transparent
$headerTitle.Location = New-Object System.Drawing.Point(36, 10)
$header.Controls.Add($headerTitle)

$headerMin = New-Object System.Windows.Forms.Button
$headerMin.Text = '–'
$headerMin.Font = New-Object System.Drawing.Font('Segoe UI', 10)
$headerMin.FlatStyle = 'Flat'
$headerMin.FlatAppearance.BorderSize = 0
$headerMin.FlatAppearance.MouseOverBackColor = [System.Drawing.ColorTranslator]::FromHtml('#2c2c31')
$headerMin.FlatAppearance.MouseDownBackColor = [System.Drawing.ColorTranslator]::FromHtml('#36363c')
$headerMin.BackColor = $C_HEAD
$headerMin.ForeColor = $C_HEAD_TEXT
$headerMin.Location = New-Object System.Drawing.Point(588, 0)
$headerMin.Size = New-Object System.Drawing.Size(40, 36)
$headerMin.TabStop = $false
$header.Controls.Add($headerMin)

$headerX = New-Object System.Windows.Forms.Button
$headerX.Text = '✕'
$headerX.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$headerX.FlatStyle = 'Flat'
$headerX.FlatAppearance.BorderSize = 0
$headerX.FlatAppearance.MouseOverBackColor = $C_ERR
$headerX.FlatAppearance.MouseDownBackColor = [System.Drawing.ColorTranslator]::FromHtml('#dc2626')
$headerX.BackColor = $C_HEAD
$headerX.ForeColor = $C_HEAD_TEXT
$headerX.Location = New-Object System.Drawing.Point(628, 0)
$headerX.Size = New-Object System.Drawing.Size(40, 36)
$headerX.TabStop = $false
$header.Controls.Add($headerX)

$headerMin.Add_MouseEnter({ $headerMin.ForeColor = $C_TEXT })
$headerMin.Add_MouseLeave({ $headerMin.ForeColor = $C_HEAD_TEXT })
$headerX.Add_MouseEnter({ $headerX.ForeColor = [System.Drawing.Color]::White })
$headerX.Add_MouseLeave({ $headerX.ForeColor = $C_HEAD_TEXT })

function Begin-Drag {
    try {
        [void][Gui.Win32Ui]::ReleaseCapture()
        [void][Gui.Win32Ui]::SendMessage($form.Handle, 0xA1, [IntPtr]2, [IntPtr]::Zero)
    } catch { }
}
$header.Add_MouseDown({ Begin-Drag })
$headerTitle.Add_MouseDown({ Begin-Drag })
$iconBox.Add_MouseDown({ Begin-Drag })

# --- контент
$title = New-Object System.Windows.Forms.Label
$title.Text = 'MiniMax H3 Studio 7'
$title.Font = New-Object System.Drawing.Font('Segoe UI', 16, [System.Drawing.FontStyle]::Bold)
$title.ForeColor = $C_TEXT
$title.AutoSize = $true
$title.Location = New-Object System.Drawing.Point(26, 50)
$form.Controls.Add($title)

$subtitle = New-Object System.Windows.Forms.Label
$subtitle.Text = 'Установка компонентов — первый запуск (один раз)'
$subtitle.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$subtitle.ForeColor = $C_MUTED
$subtitle.AutoSize = $true
$subtitle.Location = New-Object System.Drawing.Point(28, 88)
$form.Controls.Add($subtitle)

$status = New-Object System.Windows.Forms.Label
$status.Text = 'Подготовка...'
$status.Font = New-Object System.Drawing.Font('Segoe UI', 10.5)
$status.ForeColor = $C_SOFT
$status.AutoSize = $false
$status.AutoEllipsis = $true
$status.UseMnemonic = $false
$status.Location = New-Object System.Drawing.Point(26, 118)
$status.Size = New-Object System.Drawing.Size(616, 24)
$form.Controls.Add($status)

$bar = New-Object System.Windows.Forms.Panel
$bar.Location = New-Object System.Drawing.Point(26, 150)
$bar.Size = New-Object System.Drawing.Size(616, 12)
$bar.BackColor = $C_BG
$bar.Add_Paint({
    param($s, $e)
    try {
        $g = $e.Graphics
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $w = $s.Width - 1; $h = $s.Height - 1; $r = 5
        $path = New-Object System.Drawing.Drawing2D.GraphicsPath
        $path.AddArc(0, 0, 2 * $r, 2 * $r, 180, 90)
        $path.AddArc($w - 2 * $r, 0, 2 * $r, 2 * $r, 270, 90)
        $path.AddArc($w - 2 * $r, $h - 2 * $r, 2 * $r, 2 * $r, 0, 90)
        $path.AddArc(0, $h - 2 * $r, 2 * $r, 2 * $r, 90, 90)
        $path.CloseFigure()
        $track = New-Object System.Drawing.SolidBrush($C_TRACK)
        $g.FillPath($track, $path)
        $fill = [int](($w + 1) * $script:pct / 100)
        if ($fill -gt 3) {
            $g.SetClip($path)
            $lg = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
                (New-Object System.Drawing.Point(0, 0)),
                (New-Object System.Drawing.Point($w, 0)), $C_A, $C_B)
            $g.FillRectangle($lg, 0, 0, $fill, $h + 1)
            $g.ResetClip()
            $lg.Dispose()
        }
        $track.Dispose()
        $path.Dispose()
    } catch { }
})
$form.Controls.Add($bar)

$stepText = New-Object System.Windows.Forms.Label
$stepText.Text = ''
$stepText.Font = New-Object System.Drawing.Font('Segoe UI', 8.5)
$stepText.ForeColor = $C_HEAD_TEXT
$stepText.AutoSize = $true
$stepText.Location = New-Object System.Drawing.Point(26, 168)
$form.Controls.Add($stepText)

$pctText = New-Object System.Windows.Forms.Label
$pctText.Text = '0%'
$pctText.Font = New-Object System.Drawing.Font('Segoe UI', 8.5)
$pctText.ForeColor = $C_HEAD_TEXT
$pctText.AutoSize = $false
$pctText.TextAlign = 'MiddleRight'
$pctText.Location = New-Object System.Drawing.Point(546, 166)
$pctText.Size = New-Object System.Drawing.Size(96, 20)
$form.Controls.Add($pctText)

# --- лог: тёмная панель + своя тонкая полоса прокрутки
$logWrap = New-Object System.Windows.Forms.Panel
$logWrap.Location = New-Object System.Drawing.Point(26, 196)
$logWrap.Size = New-Object System.Drawing.Size(616, 170)
$logWrap.BackColor = $C_LOG_BG
$logWrap.Add_Paint({
    param($s, $e)
    try {
        $pen = New-Object System.Drawing.Pen($C_LOG_BORDER, 1)
        $e.Graphics.DrawRectangle($pen, 0, 0, ($s.Width - 1), ($s.Height - 1))
        $pen.Dispose()
    } catch { }
})
$form.Controls.Add($logWrap)

# TextBox шире панели: нативная белая полоса прокрутки уходит за границу и
# обрезается панелью. Своя полоса рисуется справа поверх.
$logBox = New-Object System.Windows.Forms.TextBox
$logBox.Multiline = $true
$logBox.ReadOnly = $true
$logBox.ScrollBars = 'Vertical'
$logBox.WordWrap = $false
$logBox.BorderStyle = 'None'
$logBox.BackColor = $C_LOG_BG
$logBox.ForeColor = $C_LOG_TEXT
$logBox.Font = New-Object System.Drawing.Font('Consolas', 8.25)
$logBox.Location = New-Object System.Drawing.Point(1, 2)
$logBox.Size = New-Object System.Drawing.Size(640, 166)
$logBox.TabStop = $false
$logWrap.Controls.Add($logBox)
$logBox.Add_MouseEnter({ try { $logBox.Focus() } catch { } })

$logBar = New-Object System.Windows.Forms.Panel
$logBar.Location = New-Object System.Drawing.Point(605, 6)
$logBar.Size = New-Object System.Drawing.Size(6, 158)
$logBar.BackColor = $C_LOG_BG
$logWrap.Controls.Add($logBar)
$logBar.BringToFront()

function Fill-Round($g, $brush, $x, $y, $w, $h, $r) {
    if ($w -le 0 -or $h -le 0) { return }
    $max = [int]([math]::Floor([math]::Min($w, $h) / 2))
    if ($r -gt $max) { $r = $max }
    if ($r -lt 1) { $g.FillRectangle($brush, $x, $y, $w, $h); return }
    $d = 2 * $r
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc($x, $y, $d, $d, 180, 90)
    $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    $g.FillPath($brush, $path)
    $path.Dispose()
}

function Get-ScrollGeom {
    $si = New-Object Gui.Win32Ui+SCROLLINFO
    $si.cbSize = [uint32][System.Runtime.InteropServices.Marshal]::SizeOf([type]([Gui.Win32Ui+SCROLLINFO]))
    $si.fMask = 0x17
    if ($logBox.IsHandleCreated) {
        [void][Gui.Win32Ui]::GetScrollInfo($logBox.Handle, 1, [ref]$si)
    }
    $trackH = [int]$script:barTrackH
    $range = [int][math]::Max(1, ($si.nMax - $si.nMin + 1))
    $page = [int][math]::Max(1, $si.nPage)
    $ratio = [math]::Min(1.0, $page / $range)
    $thumbH = [int][math]::Max(16, [int]($trackH * $ratio))
    if ($thumbH -gt $trackH) { $thumbH = $trackH }
    $maxTop = [int][math]::Max(0, $trackH - $thumbH)
    $denom = [int][math]::Max(1, $range - $page)
    $frac = ($si.nPos - $si.nMin) / $denom
    if ($frac -lt 0) { $frac = 0 }
    if ($frac -gt 1) { $frac = 1 }
    [pscustomobject]@{
        si = $si; range = $range; page = $page
        thumbH = $thumbH; maxTop = $maxTop; denom = $denom
        thumbTop = [int]($maxTop * $frac)
    }
}

function Scroll-ToPos([int]$Pos) {
    if (-not $logBox.IsHandleCreated) { return }
    $g = Get-ScrollGeom
    $delta = $Pos - $g.si.nPos
    if ($delta -ne 0) {
        [void][Gui.Win32Ui]::SendMessage($logBox.Handle, 0xB6, [IntPtr]::Zero, [IntPtr]$delta)
    }
}

$logBar.Add_Paint({
    param($s, $e)
    try {
        $g = $e.Graphics
        $g.SmoothingMode = 'AntiAlias'
        $pad = 4
        $trkY = $pad
        $trkH = $s.Height - $pad * 2
        $script:barTrackH = $trkH
        $tb = New-Object System.Drawing.SolidBrush($C_SB_TRACK)
        Fill-Round $g $tb 0 $trkY $s.Width $trkH 3
        $tb.Dispose()
        $geom = Get-ScrollGeom
        if ($geom.range -gt $geom.page) {
            $col = $C_SB_THUMB
            if ($script:barHover) { $col = $C_SB_HOVER }
            $brush = New-Object System.Drawing.SolidBrush($col)
            Fill-Round $g $brush 0 ($trkY + $geom.thumbTop) $s.Width $geom.thumbH 3
            $brush.Dispose()
        }
    } catch { }
})
$logBar.Add_MouseEnter({ $script:barHover = $true; $logBar.Invalidate() })
$logBar.Add_MouseLeave({ $script:barHover = $false; $logBar.Invalidate() })
$logBar.Add_MouseDown({
    param($s, $e)
    try {
        $geom = Get-ScrollGeom
        $scale = $script:barTrackH / [double]([math]::Max(1, $geom.si.nMax - $geom.si.nMin + 1))
        $thumbAbs = 4 + $geom.thumbTop
        if ($e.Y -ge ($thumbAbs - 2) -and $e.Y -le ($thumbAbs + $geom.thumbH + 2)) {
            $script:dragFrom = $e.Y
            $script:dragPos = $geom.si.nPos
            $script:dragging = $true
            $logBar.Capture = $true
        } else {
            $dir = 2
            if ($e.Y -gt $thumbAbs) { $dir = 3 }
            [void][Gui.Win32Ui]::SendMessage($logBox.Handle, 0x115, [IntPtr]$dir, [IntPtr]::Zero)
            $logBar.Invalidate()
        }
    } catch { }
})
$logBar.Add_MouseMove({
    param($s, $e)
    if (-not $script:dragging) { return }
    try {
        $geom = Get-ScrollGeom
        $dy = $e.Y - $script:dragFrom
        if ($geom.maxTop -gt 0) {
            $dPos = [int][math]::Round(($dy / [double]$geom.maxTop) * $geom.denom)
            Scroll-ToPos ($script:dragPos + $dPos)
            $logBar.Invalidate()
        }
    } catch { }
})
$logBar.Add_MouseUp({ $script:dragging = $false; $logBar.Capture = $false; $logBar.Invalidate() })

function Update-LogBox {
    $txt = $script:logBuf.ToString()
    if ($txt.Length -gt 24000) {
        $txt = $txt.Substring($txt.Length - 24000)
        [void]$script:logBuf.Clear()
        [void]$script:logBuf.Append($txt)
    }
    if ($txt -eq $script:logShown) {
        $logBar.Invalidate()
        return
    }
    $follow = $true
    $firstVisible = 0
    if ($logBox.IsHandleCreated) {
        $geom = Get-ScrollGeom
        $follow = (($geom.si.nPos + $geom.page) -ge ($geom.range - 1))
        if (-not $follow) {
            $firstVisible = [Gui.Win32Ui]::SendMessage($logBox.Handle, 0xCE, [IntPtr]::Zero, [IntPtr]::Zero).ToInt32()
        }
    }
    $logBox.Text = $txt
    if ($follow) {
        $logBox.SelectionStart = $logBox.TextLength
        $logBox.SelectionLength = 0
        $logBox.ScrollToCaret()
    } elseif ($logBox.IsHandleCreated) {
        $cur = [Gui.Win32Ui]::SendMessage($logBox.Handle, 0xCE, [IntPtr]::Zero, [IntPtr]::Zero).ToInt32()
        [void][Gui.Win32Ui]::SendMessage($logBox.Handle, 0xB6, [IntPtr]::Zero, [IntPtr]($firstVisible - $cur))
    }
    $script:logShown = $txt
    $logBar.Invalidate()
}

$hint = New-Object System.Windows.Forms.Label
$hint.Text = 'Установка идёт в фоне — окно можно свернуть, но не закрывать'
$hint.Font = New-Object System.Drawing.Font('Segoe UI', 8)
$hint.ForeColor = $C_HEAD_TEXT
$hint.AutoSize = $true
$hint.Location = New-Object System.Drawing.Point(26, 382)
$form.Controls.Add($hint)

$closeBtn = New-Object System.Windows.Forms.Button
$closeBtn.Text = 'Закрыть'
$closeBtn.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$closeBtn.FlatStyle = 'Flat'
$closeBtn.FlatAppearance.BorderColor = $C_BORDER
$closeBtn.FlatAppearance.MouseOverBackColor = $C_BTN_HOVER
$closeBtn.FlatAppearance.MouseDownBackColor = $C_TRACK
$closeBtn.BackColor = $C_BTN
$closeBtn.ForeColor = $C_SOFT
$closeBtn.Location = New-Object System.Drawing.Point(538, 398)
$closeBtn.Size = New-Object System.Drawing.Size(104, 32)
$closeBtn.TabStop = $false
$form.Controls.Add($closeBtn)

# ------------------------------------------------------------------- flow ---

function Stop-Install {
    if ($script:child -and -not $script:child.HasExited) {
        try { & "$env:SystemRoot\System32\taskkill.exe" /T /F /PID $script:child.Id 2>$null | Out-Null } catch { }
        try { $script:child.Kill() } catch { }
    }
    Write-StatusError 'Установка прервана пользователем'
}

function Start-App {
    if ($NoAutoStart) { return }
    try {
        $vbs = Join-Path $Root 'start_hidden.vbs'
        if (Test-Path $vbs) {
            Start-Process -FilePath "$env:SystemRoot\System32\wscript.exe" -ArgumentList ('"' + $vbs + '"') -WorkingDirectory $Root | Out-Null
        } else {
            $bat = Join-Path $Root 'start.bat'
            Start-Process -FilePath "$env:SystemRoot\System32\cmd.exe" -ArgumentList ('/c start "" /min "' + $bat + '" :hidden') -WorkingDirectory $Root -WindowStyle Hidden | Out-Null
        }
    } catch { }
}

function Start-Install {
    $st = Get-Status
    if ($st -and $st.state -eq 'running' -and (Test-PidAlive ([int]$st.pid))) {
        $script:monitorOnly = $true
        $script:state = 'running'
        $status.Text = 'Установка уже идёт — показываю прогресс...'
        return
    }
    if (-not (Test-Path $InstallPs)) {
        $status.Text = 'Не найден файл install\install.ps1'
        $status.ForeColor = $C_ERR
        $script:state = 'error'
        return
    }
    try {
        $argLine = '-NoProfile -NoLogo -ExecutionPolicy Bypass -File "' + $InstallPs + '" -Root "' + $Root + '" -NoPause'
        $script:child = Start-Process -FilePath $PsExe -ArgumentList $argLine -WorkingDirectory $Root -WindowStyle Hidden -PassThru
        $script:state = 'running'
        $status.Text = 'Запуск установки...'
    } catch {
        $status.Text = ('Не удалось запустить установку: ' + $_.Exception.Message)
        $status.ForeColor = $C_ERR
        $script:state = 'error'
    }
}

function Update-Ui {
    Read-NewLog
    Update-LogBox

    if ($script:state -eq 'done' -or $script:state -eq 'error') { return }
    $st = Get-Status
    if (-not $st) {
        if (-not $script:monitorOnly -and $script:child -and $script:child.HasExited) {
            $script:state = 'error'
            $status.Text = 'Установка завершилась без отчёта — смотрите лог и install.log'
            $status.ForeColor = $C_ERR
            $script:child = $null
        }
        return
    }

    switch ($st.state) {
        'running' {
            $total = [int]$st.total
            if ($total -le 0) { $total = 9 }
            $step = [int]$st.step
            $script:pct = [int][math]::Min(100, [math]::Round(100 * $step / $total))
            $status.Text = ('[' + $step + '/' + $total + ']  ' + $st.title)
            $stepText.Text = ('шаг ' + $step + ' из ' + $total)
            $pctText.Text = ('' + $script:pct + '%')
            $bar.Invalidate()
        }
        'done' {
            $script:pct = 100
            $status.Text = 'Готово. Запускаю приложение...'
            $status.ForeColor = $C_OK
            $stepText.Text = 'шаг 9 из 9'
            $pctText.Text = '100%'
            $bar.Invalidate()
            $script:state = 'done'
            $script:doneAt = Get-Date
        }
        'error' {
            $script:state = 'error'
            $status.Text = ('Ошибка: ' + $st.title)
            $status.ForeColor = $C_ERR
        }
    }
}

function Get-CloseConfirmed {
    $running = ($script:state -eq 'running')
    if (-not $running) {
        $st = Get-Status
        $running = ($st -and $st.state -eq 'running')
    }
    if (-not $running) { return $true }
    $r = [System.Windows.Forms.MessageBox]::Show(
        'Прервать установку зависимостей? Уже скачанные файлы останутся, при следующем запуске установка продолжится.',
        'MiniMax H3 Studio 7', 'YesNo', 'Warning')
    return ($r -eq 'Yes')
}

$requestClose = {
    if (-not (Get-CloseConfirmed)) { return }
    Stop-Install
    $form.Close()
}

$headerX.Add_Click($requestClose)
$closeBtn.Add_Click($requestClose)
$headerMin.Add_Click({ try { $form.WindowState = 'Minimized' } catch { } })

$form.Add_FormClosing({
    param($s, $e)
    if ($script:closing) { return }
    if (-not (Get-CloseConfirmed)) { $e.Cancel = $true; return }
    if ($script:state -eq 'running' -or $script:monitorOnly) { Stop-Install }
    $script:closing = $true
})

function Force-Visible {
    try {
        [void][Gui.Win32Ui]::ShowWindow($form.Handle, 1)
        [void][Gui.Win32Ui]::SetForegroundWindow($form.Handle)
        $form.Activate()
    } catch { }
}

# Текст лога не заезжает под свою полосу прокрутки: ограничиваем область
# форматирования (EM_SETRECT) правым отступом.
function Set-LogRect {
    try {
        if (-not $logBox.IsHandleCreated) { return }
        $r = New-Object Gui.Win32Ui+RECT
        $r.Left = 2
        $r.Top = 2
        $r.Right = 601
        $r.Bottom = 163
        [void][Gui.Win32Ui]::SendMessage($logBox.Handle, 0xB3, [IntPtr]::Zero, [ref]$r)
    } catch { }
}

$form.Add_Shown({ Force-Visible; Set-LogRect; Start-Install })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 800
$timer.Add_Tick({
    Update-Ui
    if ($script:state -eq 'done' -and $script:doneAt -and ((Get-Date) - $script:doneAt).TotalMilliseconds -gt 1800) {
        $timer.Stop()
        Start-App
        $form.Close()
    }
})
$timer.Start()

[void]$form.ShowDialog()
$timer.Stop()
$timer.Dispose()
try { $mutex.ReleaseMutex(); $mutex.Dispose() } catch { }
