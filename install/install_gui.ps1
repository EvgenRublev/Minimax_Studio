# (правки 753/755) Тематический загрузчик установки зависимостей.
#
# Окно без стандартной рамки Windows: свой заголовок (иконка + название +
# «✕»), перетаскивание за шапку, 1px рамка. Внутри: одна строка статуса
# "[N/9] <шаг>", градиентный прогресс-бар и ЖИВОЙ ЛОГ (хвост install.log),
# чтобы было видно всё, что делает установщик, а не только шаги.
#
# Одиночный экземпляр: второй запуск (инсталлятор + start.bat) молча
# выходит, окно всегда одно.
#
# install.ps1 запускается СКРЫТО (Start-Process -WindowStyle Hidden) и пишет
# шаги в .install-cache\setup_status.json и строки в install.log.
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
# Инсталлятор (галочка) и start.bat могут запустить загрузчик одновременно.
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
'@ -ErrorAction SilentlyContinue

if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
$Root = [IO.Path]::GetFullPath($Root)
# Без хвостового слэша: "C:\path\" ломает кавычки при передаче -Root дальше.
if ($Root.Length -gt 3 -and $Root.EndsWith('\')) { $Root = $Root.Substring(0, $Root.Length - 1) }

$Cache = Join-Path $Root '.install-cache'
$StatusFile = Join-Path $Cache 'setup_status.json'
$InstallPs = Join-Path $Root 'install\install.ps1'
$LogFile = Join-Path $Root 'install.log'
$IconFile = Join-Path $Root 'electron\icons\icon.ico'
$PsExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

$script:pct = 0
$script:child = $null
$script:doneAt = $null
$script:state = 'idle'
$script:monitorOnly = $false
$script:closing = $false

# ------------------------------------------------------------ log tail ---
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
            if ($chunk.Length -gt 0 -and $chunk[0] -eq [char]0xFEFF) { $chunk = $chunk.Substring(1) }
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

# --------------------------------------------------------------- colors ---

$C_BG = [System.Drawing.ColorTranslator]::FromHtml('#0A0C11')
$C_HEAD = [System.Drawing.ColorTranslator]::FromHtml('#0D1117')
$C_LOG = [System.Drawing.ColorTranslator]::FromHtml('#0B0F15')
$C_PANEL = [System.Drawing.ColorTranslator]::FromHtml('#10141C')
$C_TRACK = [System.Drawing.ColorTranslator]::FromHtml('#1B2029')
$C_TEXT = [System.Drawing.ColorTranslator]::FromHtml('#F3F4F8')
$C_MUTED = [System.Drawing.ColorTranslator]::FromHtml('#8A91A0')
$C_SOFT = [System.Drawing.ColorTranslator]::FromHtml('#D6DAE3')
$C_ERR = [System.Drawing.ColorTranslator]::FromHtml('#EF4444')
$C_OK = [System.Drawing.ColorTranslator]::FromHtml('#22C55E')
$C_A = [System.Drawing.ColorTranslator]::FromHtml('#F59E0B')
$C_B = [System.Drawing.ColorTranslator]::FromHtml('#8B5CF6')
$C_BORDER = [System.Drawing.ColorTranslator]::FromHtml('#262C38')

# --------------------------------------------------------------- window ---

$form = New-Object System.Windows.Forms.Form
$form.Text = 'MiniMax H3 Studio 7 - установка зависимостей'
$form.ClientSize = New-Object System.Drawing.Size(668, 452)
$form.BackColor = $C_BG
$form.ForeColor = $C_TEXT
$form.FormBorderStyle = 'None'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true
$form.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$script:ico = $null
if (Test-Path $IconFile) {
    try {
        $script:ico = New-Object System.Drawing.Icon($IconFile, 16, 16)
        $form.Icon = $script:ico
    } catch { }
}
$form.Add_Paint({
    param($s, $e)
    try {
        $pen = New-Object System.Drawing.Pen($C_BORDER, 1)
        $e.Graphics.DrawRectangle($pen, 0, 0, ($s.Width - 1), ($s.Height - 1))
        $pen.Dispose()
    } catch { }
})

# Заголовок (своя панель вместо системной рамки)
$header = New-Object System.Windows.Forms.Panel
$header.Dock = 'Top'
$header.Height = 38
$header.BackColor = $C_HEAD
$header.Add_Paint({
    param($s, $e)
    try {
        $pen = New-Object System.Drawing.Pen($C_BORDER, 1)
        $e.Graphics.DrawLine($pen, 0, ($s.Height - 1), $s.Width, ($s.Height - 1))
        $pen.Dispose()
    } catch { }
})
$form.Controls.Add($header)

$iconBox = New-Object System.Windows.Forms.PictureBox
$iconBox.Size = New-Object System.Drawing.Size(16, 16)
$iconBox.Location = New-Object System.Drawing.Point(14, 11)
$iconBox.BackColor = [System.Drawing.Color]::Transparent
if ($script:ico) { try { $iconBox.Image = $script:ico.ToBitmap() } catch { } }
$header.Controls.Add($iconBox)

$headerTitle = New-Object System.Windows.Forms.Label
$headerTitle.Text = 'MiniMax H3 Studio 7  -  установка зависимостей'
$headerTitle.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$headerTitle.ForeColor = $C_MUTED
$headerTitle.AutoSize = $true
$headerTitle.BackColor = [System.Drawing.Color]::Transparent
$headerTitle.Location = New-Object System.Drawing.Point(38, 11)
$header.Controls.Add($headerTitle)

$headerX = New-Object System.Windows.Forms.Button
$headerX.Text = '✕'
$headerX.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$headerX.FlatStyle = 'Flat'
$headerX.FlatAppearance.BorderSize = 0
$headerX.FlatAppearance.MouseOverBackColor = [System.Drawing.ColorTranslator]::FromHtml('#3A1216')
$headerX.FlatAppearance.MouseDownBackColor = [System.Drawing.ColorTranslator]::FromHtml('#4A161B')
$headerX.BackColor = $C_HEAD
$headerX.ForeColor = $C_MUTED
$headerX.Location = New-Object System.Drawing.Point(628, 4)
$headerX.Size = New-Object System.Drawing.Size(32, 30)
$header.Controls.Add($headerX)

# Перетаскивание окна за шапку
function Begin-Drag {
    try {
        [void][Gui.Win32Ui]::ReleaseCapture()
        [void][Gui.Win32Ui]::SendMessage($form.Handle, 0xA1, [IntPtr]2, [IntPtr]::Zero)
    } catch { }
}
$header.Add_MouseDown({ Begin-Drag })
$headerTitle.Add_MouseDown({ Begin-Drag })
$iconBox.Add_MouseDown({ Begin-Drag })

# Основной контент
$title = New-Object System.Windows.Forms.Label
$title.Text = 'MiniMax H3 Studio 7'
$title.Font = New-Object System.Drawing.Font('Segoe UI', 16, [System.Drawing.FontStyle]::Bold)
$title.ForeColor = $C_TEXT
$title.AutoSize = $true
$title.Location = New-Object System.Drawing.Point(26, 54)
$form.Controls.Add($title)

$subtitle = New-Object System.Windows.Forms.Label
$subtitle.Text = 'Установка компонентов - первый запуск (один раз)'
$subtitle.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$subtitle.ForeColor = $C_MUTED
$subtitle.AutoSize = $true
$subtitle.Location = New-Object System.Drawing.Point(28, 92)
$form.Controls.Add($subtitle)

$status = New-Object System.Windows.Forms.Label
$status.Text = 'Подготовка...'
$status.Font = New-Object System.Drawing.Font('Segoe UI', 10.5)
$status.ForeColor = $C_SOFT
$status.AutoSize = $false
$status.AutoEllipsis = $true
$status.UseMnemonic = $false
$status.Location = New-Object System.Drawing.Point(26, 122)
$status.Size = New-Object System.Drawing.Size(616, 24)
$form.Controls.Add($status)

$bar = New-Object System.Windows.Forms.Panel
$bar.Location = New-Object System.Drawing.Point(26, 154)
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
$stepText.ForeColor = $C_MUTED
$stepText.AutoSize = $true
$stepText.Location = New-Object System.Drawing.Point(26, 172)
$form.Controls.Add($stepText)

$pctText = New-Object System.Windows.Forms.Label
$pctText.Text = '0%'
$pctText.Font = New-Object System.Drawing.Font('Segoe UI', 8.5)
$pctText.ForeColor = $C_MUTED
$pctText.AutoSize = $false
$pctText.TextAlign = 'MiddleRight'
$pctText.Location = New-Object System.Drawing.Point(546, 170)
$pctText.Size = New-Object System.Drawing.Size(96, 20)
$form.Controls.Add($pctText)

# Живой лог установки (хвост install.log)
$logBox = New-Object System.Windows.Forms.TextBox
$logBox.Multiline = $true
$logBox.ReadOnly = $true
$logBox.ScrollBars = 'Vertical'
$logBox.WordWrap = $false
$logBox.BorderStyle = 'None'
$logBox.BackColor = $C_LOG
$logBox.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#9AA3B2')
$logBox.Font = New-Object System.Drawing.Font('Consolas', 8.25)
$logBox.Location = New-Object System.Drawing.Point(26, 200)
$logBox.Size = New-Object System.Drawing.Size(616, 168)
$form.Controls.Add($logBox)

$hint = New-Object System.Windows.Forms.Label
$hint.Text = 'Установка идёт в фоне - окно можно свернуть, но не закрывать'
$hint.Font = New-Object System.Drawing.Font('Segoe UI', 8)
$hint.ForeColor = $C_MUTED
$hint.AutoSize = $true
$hint.Location = New-Object System.Drawing.Point(26, 384)
$form.Controls.Add($hint)

$closeBtn = New-Object System.Windows.Forms.Button
$closeBtn.Text = 'Закрыть ✕'
$closeBtn.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$closeBtn.FlatStyle = 'Flat'
$closeBtn.FlatAppearance.BorderColor = $C_BORDER
$closeBtn.FlatAppearance.MouseOverBackColor = $C_PANEL
$closeBtn.FlatAppearance.MouseDownBackColor = $C_TRACK
$closeBtn.BackColor = $C_PANEL
$closeBtn.ForeColor = $C_SOFT
$closeBtn.Location = New-Object System.Drawing.Point(538, 400)
$closeBtn.Size = New-Object System.Drawing.Size(104, 32)
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
            # wscript (GUI-подсистема) - без мелькания консоли
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
        $status.Text = 'Установка уже идёт - показываю прогресс...'
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
    $txt = $script:logBuf.ToString()
    if ($txt.Length -gt 24000) {
        $txt = $txt.Substring($txt.Length - 24000)
        [void]$script:logBuf.Clear()
        [void]$script:logBuf.Append($txt)
    }
    if ($txt -ne $script:logShown) {
        $script:logShown = $txt
        $logBox.Text = $txt
        $logBox.SelectionStart = $logBox.TextLength
        $logBox.ScrollToCaret()
    }

    if ($script:state -eq 'done' -or $script:state -eq 'error') { return }
    $st = Get-Status
    if (-not $st) {
        if (-not $script:monitorOnly -and $script:child -and $script:child.HasExited) {
            $script:state = 'error'
            $status.Text = 'Установка завершилась без отчёта - смотрите лог ниже и install.log'
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

$form.Add_Shown({ Force-Visible; Start-Install })

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
