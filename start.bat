@echo off
REM (правка 587) chcp 65001 УДАЛЁН: cmd.exe под кодовой страницей 65001
REM неверно отслеживает позицию чтения батника с многобайтовыми UTF-8
REM символами (кириллица в комментариях) — после 8-килобайтного блока
REM парсер «спотыкался» в середине слова, выполнял огрызок комментария
REM как команду и молча пропускал строки ниже (в т.ч. запуск Electron).
REM Кириллица остаётся только в REM-строках — без 65001 парсер ходит по
REM байтам корректно; echo-строки переведены в ASCII (cp866-консоль).
setlocal EnableExtensions

REM (правка 570) Скрытый запуск: вместо свёрнутого окна — полностью скрытая
REM консоль. VBS-скрипт запускает bat через WshShell.Run с HideWindow=0
REM (скрытое окно), и при закрытии Electron-окна Electron сам убивает
REM родительский cmd-процесс (taskkill по PID родителя из main.js).
REM Аргумент :hidden — защита от бесконечного цикла (VBS уже запустил нас).
if /i "%~1"==":hidden" goto main

REM Если VBS-скрипт доступен — запускаем через него (полностью скрытое окно).
REM Если cscript/VBS заблокированы антивирусом или политикой — не выходим
REM молча, а откатываемся на свёрнутое консольное окно.
if exist "%~dp0start_hidden.vbs" (
    where cscript >nul 2>&1
    if not errorlevel 1 (
        cscript //nologo "%~dp0start_hidden.vbs"
        if not errorlevel 1 exit /b 0
        echo [WARN] start_hidden.vbs failed - falling back to minimized console.
    ) else (
        echo [WARN] cscript not found - falling back to minimized console.
    )
)

REM Fallback: VBS нет или он заблокирован — свёрнутое окно (старое поведение)
start "" /min "%~f0" :hidden
exit /b

:main
title MiniMax H3 Studio
cd /d "%~dp0"
REM (fix 754) ffmpeg/ffprobe: refine, extend (VHS_LoadVideo) and thumbnails
REM call ffprobe by name - put runtime\ffmpeg on PATH so children find it.
if exist "%~dp0runtime\ffmpeg\ffprobe.exe" set "PATH=%~dp0runtime\ffmpeg;%PATH%"
REM (правка 587) Скрытый режим: pause/set /p невозможны (окно скрыто) —
REM ошибки пишутся в start_error.log, интерактивные вопросы получают
REM безопасный ответ по умолчанию.
set "HIDDEN="
if /i "%~1"==":hidden" set "HIDDEN=1"

set PORT=3000
set COMFY_PORT=8188
REM Приоритет: [comfy] comfy_dir → COMFY_ROOT из окружения → bundled-путь.
set "COMFY_ROOT_CONFIG="
if exist config\config.ini (
    for /f "tokens=1,* delims==" %%a in ('findstr /i /b /c:"comfy_dir" config\config.ini 2^>nul') do if not defined COMFY_ROOT_CONFIG set "COMFY_ROOT_CONFIG=%%b"
)
if defined COMFY_ROOT_CONFIG set "COMFY_ROOT_CONFIG=%COMFY_ROOT_CONFIG:"=%"
if defined COMFY_ROOT_CONFIG set "COMFY_ROOT=%COMFY_ROOT_CONFIG%"
if not defined COMFY_ROOT set "COMFY_ROOT=ComfyUI-Easy-Install"

echo.
echo  ============================================
echo    MiniMax H3 Studio
echo  ============================================
echo.

REM ============================================================
REM  [CHECK 1/5] Node.js — bundled runtime\node.exe first, then PATH
REM ============================================================
set "NODE_CMD="
if exist "%~dp0runtime\node.exe" (
    set "NODE_CMD=%~dp0runtime\node.exe"
    echo  [OK] Using bundled runtime\node.exe
)
if not defined NODE_CMD (
    where node >nul 2>&1
    if not errorlevel 1 (
        set "NODE_CMD=node"
        echo  [OK] Node.js found in PATH
    )
)
if not defined NODE_CMD (
    echo.
    echo  [ERROR] Node.js not found: neither runtime\node.exe nor in PATH.
    echo          Copy node.exe into the runtime\ folder next to start.bat.
    echo.
    REM (fix 749) First run on a clean machine (shortcut, hidden mode):
    REM instead of a silent dead end, open a visible console that installs
    REM all dependencies (install.bat -> install.ps1). Then start the app again.
    if defined HIDDEN (
        echo [%date% %time%] First run: node missing - launching visible dependency install>> "%~dp0start_error.log"
        start "MiniMax H3 Studio - dependency install" "%SystemRoot%\System32\cmd.exe" /c call "%~dp0install.bat"
        exit /b 0
    )
    call :pause_or_log "[ERROR] Node.js not found: runtime\node.exe and PATH missing"
    exit /b 1
)
for /f "tokens=*" %%v in ('"%NODE_CMD%" --version') do set NODE_VER=%%v
echo  [OK] Node.js %NODE_VER%

REM ============================================================
REM  [CHECK 2/5] ComfyUI folder
REM ============================================================
REM (правка 551) Проверка через goto, а не блок ( ... ): set /p и чтение
REM %CONTINUE% внутри ОДНОГО блока не работают — переменная разворачивалась
REM при ПАРСИНГЕ блока (до ввода ответа), всегда была пуста, а метка :web_ui,
REM на которую шёл goto, вообще не существовала. Fallback «frontend only»
REM был мёртв — при отсутствии папки ComfyUI скрипт всегда просто выходил.
if exist "%COMFY_ROOT%\python_embeded\python.exe" goto comfy_ok
echo.
echo  [WARN] ComfyUI not found at: %COMFY_ROOT%
echo         Expected folder: %~dp0%COMFY_ROOT%\python_embeded\python.exe
echo         Place the ComfyUI-Easy-Install folder next to this project.
echo.
REM (правка 587) Скрытое окно не может спросить пользователя — по умолчанию Y
REM (frontend-only), причина пишется в start_error.log.
if defined HIDDEN (
    echo [%date% %time%] WARN: ComfyUI not found at %COMFY_ROOT% - frontend-only mode, hidden>> "%~dp0start_error.log"
    set "CONTINUE=Y"
) else (
    set /p CONTINUE=         Start Web UI anyway, frontend only [Y/N]:
)
if /i "%CONTINUE%"=="Y" goto frontend_only
call :pause_or_log "[ERROR] ComfyUI not found, user declined frontend-only start"
exit /b 0
:frontend_only
REM (правка 551) Frontend-only: Web UI поднимем, ComfyUI-бэкенд — нет.
set "FRONTEND_ONLY=1"
echo  [WARN] Frontend-only mode: generation will not work without ComfyUI.
goto comfy_check_done
:comfy_ok
echo  [OK] ComfyUI found: %COMFY_ROOT%
:comfy_check_done

REM ============================================================
REM  [CHECK 3/5] node_modules (auto-install; needs real npm)
REM ============================================================
if exist "node_modules" (
    echo  [OK] Dependencies present.
) else (
    where npm >nul 2>&1
    if errorlevel 1 (
        echo.
        echo  [ERROR] node_modules not found and npm is unavailable.
        echo          Copy the project together with node_modules\ from the
        echo          source PC - same Windows x64 - or install full Node.js
        echo          18+ from https://nodejs.org first.
        echo.
        call :pause_or_log "[ERROR] node_modules not found and npm is unavailable"
        exit /b 1
    )
    echo  [INSTALL] node_modules not found - running npm install...
    call npm install
    if errorlevel 1 (
        echo  [ERROR] npm install failed.
        call :pause_or_log "[ERROR] npm install failed"
        exit /b 1
    )
    echo  [OK] Dependencies installed.
)

REM ============================================================
REM  [CHECK 4/5] Production build (auto-build; needs real npm)
REM ============================================================
if exist ".next\BUILD_ID" (
    echo  [OK] Build present.
) else (
    where npm >nul 2>&1
    if errorlevel 1 (
        echo.
        echo  [ERROR] .next build not found and npm is unavailable.
        echo          Copy the project together with the .next\ folder from
        echo          the source PC, or install full Node.js 18+ first.
        echo.
        call :pause_or_log "[ERROR] .next build not found and npm is unavailable"
        exit /b 1
    )
    echo  [BUILD] .next build not found - running npm run build...
    call npm run build
    if errorlevel 1 (
        echo  [ERROR] Build failed.
        call :pause_or_log "[ERROR] npm run build failed"
        exit /b 1
    )
    echo  [OK] Production build complete.
)

REM ============================================================
REM  (правка 561) DESKTOP MODE — окно приложения (Electron)
REM  Electron сам: убьёт висшие порты, поднимет server.js (на своём
REM  Node) и ComfyUI (с флагами VRAM из config.ini), откроет окно на
REM  /splash и прибьёт оба дерева при закрытии окна. Консоль остаётся
REM  свёрнутым лог-хостом; выход из окна завершит и её.
REM  Нет Electron (node_modules не полный) — прежний браузерный режим.
REM ============================================================
if exist "node_modules\electron\dist\electron.exe" goto desktop_mode
REM Electron 44+ downloads its binary lazily on first require('electron'),
REM so cli.js is enough here: it fetches dist\ and starts the window.
if exist "node_modules\electron\cli.js" goto desktop_mode
echo  [WARN] Electron not found in node_modules - browser mode.
goto web_mode

:desktop_mode
echo.
REM (правка 586) Авто-очистка осиротевших процессов по пути проекта УДАЛЕНА:
REM она могла зацепить чужие процессы (включая Bionic/LM Studio), если их
REM командная строка случайно содержала путь проекта. Оставляем только
REM killPortListeners(3000/8188) внутри electron/main.js.
echo  Starting desktop app (Electron window)...
echo  Close the app window to stop everything (web server + ComfyUI).
echo.

REM (релиз) Имя процесса в диспетчере задач. Штатный electron.exe в списке
REM процессов неотличим от любого другого Electron-приложения — пользователю
REM нечем понять, какой процесс прибивать. prepare-electron создаёт рядом
REM копию MinimaxH3Studio.exe (с правильными свойствами файла), и её мы и
REM запускаем. Если копии нет — работает обычный electron.exe, приложение
REM запускается как раньше.
if exist "node_modules\electron\dist\MinimaxH3Studio.exe" goto desktop_mode_named
"%NODE_CMD%" scripts\prepare-electron.mjs
if exist "node_modules\electron\dist\MinimaxH3Studio.exe" goto desktop_mode_named
echo  [WARN] Could not create MinimaxH3Studio.exe - process name stays "electron".
goto desktop_mode_launch

:desktop_mode_named
echo  Process name: MinimaxH3Studio (visible in Task Manager).
goto desktop_mode_launch

:desktop_mode_launch

REM (правка 582) Пред-проверка синтаксиса main.js: раньше SyntaxError мог
REM уйти в скрытое окно и start.bat молча выходил, не показав причину.
"%NODE_CMD%" --check electron\main.js
if errorlevel 1 (
    echo.
    echo  [ERROR] electron\main.js failed the syntax check.
    echo          Fix the errors in that file, then run start.bat again.
    call :pause_or_log "[ERROR] electron\main.js failed node --check"
    exit /b 1
)

REM (релиз) launch-electron.mjs — то же, что делал cli.js (проксирует stdio
REM electron.exe, чтобы логи сервера/ComfyUI шли в эту консоль), но для
REM переименованной копии MinimaxH3Studio.exe. Если копии нет — откат на
REM штатный electron/cli.js.
if exist "node_modules\electron\dist\MinimaxH3Studio.exe" goto launch_named
"%NODE_CMD%" node_modules\electron\cli.js electron\main.js
goto launch_done

:launch_named
"%NODE_CMD%" scripts\launch-electron.mjs electron\main.js

:launch_done
set EL_EXIT=%errorlevel%
echo.
echo  Desktop app closed (code %EL_EXIT%). Closing...
%SystemRoot%\System32\timeout.exe /t 3 /nobreak >nul
exit /b %EL_EXIT%

REM ============================================================
REM  (правка 561) LEGACY: браузерный режим — фолбэк без Electron
REM ============================================================
:web_mode

REM ============================================================
REM  [ правка 97] Start Web UI FIRST — браузер с экраном-заставкой
REM  открывается сразу, не дожидаясь загрузки ComfyUI (30-90 с).
REM  Заставка (/splash) сама опрашивает /api/comfy/health и переходит
REM  в приложение, когда бэкенд готов.
REM ============================================================
echo.
echo  Starting web UI...

REM Kill any existing process on web port (только LISTENING — см. выше)
for /f "tokens=5" %%p in ('netstat -aon ^| findstr /C:":%PORT% " ^| findstr /C:"LISTENING" 2^>nul') do (
    taskkill /F /PID %%p >nul 2>&1
)
%SystemRoot%\System32\timeout.exe /t 1 /nobreak >nul

set NODE_ENV=production

REM Веб-сервер — в фоне: он нужен ПРЯМО СЕЙЧАС, чтобы отдать заставку.
start /b "" "%NODE_CMD%" server.js

REM Ждём, пока веб-сервер начнёт отвечать (обычно 1-3 с)
echo       Starting web server...
set /a wt=0
:wait_web
set /a wt+=1
if %wt% gtr 30 (
    echo  [ERROR] Web server did not start within 60s.
    call :pause_or_log "[ERROR] Web server did not start within 60s"
    exit /b 1
)
powershell -NoProfile -Command "try { [void](Invoke-WebRequest -Uri 'http://127.0.0.1:%PORT%/splash' -TimeoutSec 3 -UseBasicParsing); exit 0 } catch { exit 1 }" >nul 2>&1
if %errorlevel% equ 0 goto web_ready
%SystemRoot%\System32\timeout.exe /t 2 /nobreak >nul
goto wait_web

:web_ready
echo  [OK] Web UI is up.

echo.
echo  ============================================
echo    Web UI:   http://localhost:%PORT%
echo    ComfyUI:  http://127.0.0.1:%COMFY_PORT%
echo    Backend:  %COMFY_ROOT%
echo  ============================================
echo.
echo  Opening browser (splash screen)...
echo.

REM (правка 128) Открываем браузер поверх всех окон (не в фоне).
REM explorer.exe — простой вариант, но Windows foreground-lock может не дать
REM взять фокус. (правка 129b) Надёжный способ — PowerShell + SetForegroundWindow.
call :open_browser_foreground http://localhost:%PORT%/splash

REM ============================================================
REM  Start ComfyUI backend
REM ============================================================
REM (правка 551) Frontend-only (папки ComfyUI нет, пользователь ответил Y):
REM бэкенд не поднимаем — сразу к keepalive (Web UI уже работает, заставка
REM честно ждёт /api/comfy/health).
if defined FRONTEND_ONLY (
    echo  [WARN] Frontend-only mode: ComfyUI backend NOT started.
    goto keepalive
)
echo.
echo  Starting ComfyUI backend...

REM Kill any existing process on ComfyUI port
REM ВАЖНО: два findstr /C: подряд. Одиночный findstr ":port .*LISTENING"
REM в литеральном режиме делит шаблон по пробелам на ИЛИ-альтернативы и
REM матчит ЛЮБУЮ строку с ":port" (включая ESTABLISHED-соединения браузера
REM и node) — taskkill /F убивал бы весь браузер пользователя.
for /f "tokens=5" %%p in ('netstat -aon ^| findstr /C:":%COMFY_PORT% " ^| findstr /C:"LISTENING" 2^>nul') do (
    taskkill /F /PID %%p >nul 2>&1
)
%SystemRoot%\System32\timeout.exe /t 2 /nobreak >nul

REM Start ComfyUI in background (правка 140) — запускаем python.exe напрямую
REM (правка 551) Чтение настроек из config\config.ini — СНАЧАЛА парсинг
REM (переменные ПУСТЫЕ), ПОТОМ дефолты. Раньше дефолты выставлялись ДО
REM парсинга, guard «if not defined» всегда был ложен и всё, что пользователь
REM менял в «Настройках» (reserve_gb, vram_headroom, async_offload), молча
REM игнорировалось — ComfyUI всегда стартовал с захардкоженными дефолтами.
REM Паттерн и валидация — как в scripts\start_comfy.bat (правки 357/490):
REM findstr /b /c: матчит только строки, НАЧИНАЮЩИЕСЯ с ключа (не комментарии),
REM первый матч выигрывает, мусорные значения → безопасный дефолт.
set "RESERVE_VRAM="
set "DYNAMIC_VRAM="
set "ASYNC_OFFLOAD="
set "VRAM_HEADROOM="
if exist config\config.ini (
    for /f "tokens=2 delims==" %%a in ('findstr /i /b /c:"reserve_gb" config\config.ini 2^>nul') do if not defined RESERVE_VRAM set "RESERVE_VRAM=%%a"
    for /f "tokens=2 delims==" %%a in ('findstr /i /b /c:"dynamic_vram" config\config.ini 2^>nul') do if not defined DYNAMIC_VRAM set "DYNAMIC_VRAM=%%a"
    for /f "tokens=2 delims==" %%a in ('findstr /i /b /c:"async_offload" config\config.ini 2^>nul') do if not defined ASYNC_OFFLOAD set "ASYNC_OFFLOAD=%%a"
    REM (правка 521) vram_headroom — доп. запас свободной VRAM для DynamicVRAM
    for /f "tokens=2 delims==" %%a in ('findstr /i /b /c:"vram_headroom" config\config.ini 2^>nul') do if not defined VRAM_HEADROOM set "VRAM_HEADROOM=%%a"
)
if not defined RESERVE_VRAM set "RESERVE_VRAM=3"
if not defined DYNAMIC_VRAM set "DYNAMIC_VRAM=1"
if not defined ASYNC_OFFLOAD set "ASYNC_OFFLOAD=0"
if not defined VRAM_HEADROOM set "VRAM_HEADROOM=2"
set "RESERVE_VRAM=%RESERVE_VRAM:"=%"
set "DYNAMIC_VRAM=%DYNAMIC_VRAM:"=%"
set "ASYNC_OFFLOAD=%ASYNC_OFFLOAD:"=%"
set "VRAM_HEADROOM=%VRAM_HEADROOM:"=%"
echo %RESERVE_VRAM%| findstr /r "^[0-9][0-9.]*$" >nul || set "RESERVE_VRAM=3"
echo %DYNAMIC_VRAM%| findstr /r "^[01]$" >nul || set "DYNAMIC_VRAM=1"
echo %ASYNC_OFFLOAD%| findstr /r "^[01]$" >nul || set "ASYNC_OFFLOAD=0"
echo %VRAM_HEADROOM%| findstr /r "^[0-9][0-9.]*$" >nul || set "VRAM_HEADROOM=2"
set "EXTRA_FLAGS="
if not "%ASYNC_OFFLOAD%"=="1" set "EXTRA_FLAGS=--disable-async-offload --disable-pinned-memory"
REM (правка 521) --vram-headroom: DynamicVRAM (aimdo) непрерывно держит
REM столько ГБ реально свободными (по NVML, включая чужие приложения).
REM 0 = флаг не передаём (поведение как раньше).
set "HEADROOM_FLAG="
if not "%VRAM_HEADROOM%"=="0" set "HEADROOM_FLAG=--vram-headroom %VRAM_HEADROOM%"
REM (правка 551) dynamic_vram=0 → --disable-dynamic-vram (как в start_comfy.bat;
REM раньше этот флаг из start.bat не передавался вовсе).
set "DYN_FLAG="
if "%DYNAMIC_VRAM%"=="0" set "DYN_FLAG=--disable-dynamic-vram"

REM Запускаем ComfyUI напрямую
start /b "" "%COMFY_ROOT%\python_embeded\python.exe" -I "%COMFY_ROOT%\ComfyUI\main.py" --windows-standalone-build --use-ck-attention --disable-auto-launch --reserve-vram %RESERVE_VRAM% %DYN_FLAG% %EXTRA_FLAGS% %HEADROOM_FLAG%

REM Wait for ComfyUI to be ready (заставка в браузере покажет это сама)
echo       Waiting for ComfyUI (first start can take 30-90s)...
set /a tries=0
:wait_comfy
set /a tries+=1
if %tries% gtr 120 (
    echo.
    echo  [WARN] ComfyUI did not start within 240s.
    echo  Splash screen keeps waiting - check the output above.
    echo.
    goto keepalive
)
powershell -NoProfile -Command "try { [void](Invoke-WebRequest -Uri 'http://127.0.0.1:%COMFY_PORT%/' -TimeoutSec 3 -UseBasicParsing); exit 0 } catch { exit 1 }" >nul 2>&1
if %errorlevel% equ 0 goto comfy_ready
%SystemRoot%\System32\timeout.exe /t 2 /nobreak >nul
goto wait_comfy

:comfy_ready
echo  [OK] ComfyUI is ready. Browser will enter the studio automatically.

REM ============================================================
REM  Keepalive: консоль держит фоновые процессы (веб + ComfyUI).
REM  Закрытие окна = остановка всего (как и раньше).
REM ============================================================
:keepalive
echo.
echo  To STOP: close this window.
echo.
:keepalive_loop
%SystemRoot%\System32\timeout.exe /t 30 /nobreak >nul
goto keepalive_loop

REM ============================================================
REM (правка 129b) Субрутина: открыть URL в браузере ПОВЕРХ всех окон.
REM
REM Windows foreground-lock не даёт скрипту напрямую взять фокус.
REM Рабочий обход: Start-Process открывает браузер, а через 500 мс
REM PowerShell через Win32 P/Invoke SetForegroundWindow принудительно
REM поднимает окно браузера на первый план (это работает, т.к. вызов
REM идёт из процесса, запущенного через Start-Process — у него есть
REM разрешение на SetForegroundWindow).
REM ============================================================
:open_browser_foreground
setlocal
set "_URL=%~1"

REM 1) Открываем URL в браузере по умолчанию (Start-Process даёт новый
REM    процесс, у которого Windows разрешает SetForegroundWindow).
powershell -NoProfile -Command "Start-Process -FilePath '%_URL%'" >nul 2>&1

REM 2) Через 500 мс принудительно поднимаем окно браузера на передний план.
REM    (Если браузер ещё не создал окно — SetForegroundWindow молча
REM    пройдёт мимо; если окно уже есть — оно возьмёт фокус.)
REM (правка 130) Убрали `^`-продолжения: cmd их убирает, но PowerShell
REM    видит как аргумент → Add-Type падал с "positional parameter '")".
REM    Теперь одна строка, без продолжений.
%SystemRoot%\System32\timeout.exe /t 1 /nobreak >nul
powershell -NoProfile -Command "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class FG { [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd); [DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr hWnd, int n); [DllImport(\"user32.dll\")] public static extern bool IsZoomed(IntPtr hWnd); public static void BringToFront() { IntPtr fg = GetForegroundWindow(); if (fg != IntPtr.Zero) { if (!IsZoomed(fg)) { ShowWindow(fg, 3); } SetForegroundWindow(fg); } } }' ; [FG]::BringToFront()" >nul 2>&1

endlocal
goto :eof

REM ============================================================
REM (правка 587) Субрутина для аварийных путей: в видимом окне — pause
REM (как раньше), в скрытом (запуск через start_hidden.vbs) — пауза
REM невозможна (нет UI, ввода нет) и висела бы вечно. Вместо этого
REM сообщение дописывается в start_error.log рядом со start.bat.
REM Реализация через goto (НЕ через блоки в скобках): сообщения могут
REM содержать скобки, которые внутри ( ... ) прервали бы блок.
REM ============================================================
:pause_or_log
if defined HIDDEN goto :plog_hidden
echo  %~1
pause
goto :eof
:plog_hidden
echo [%date% %time%] %~1>> "%~dp0start_error.log" 2>&1
goto :eof
