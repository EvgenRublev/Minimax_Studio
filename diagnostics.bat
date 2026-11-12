@echo off
REM MiniMax H3 Studio - read-only diagnostics (pravka 941).
REM ASCII only on purpose: cmd.exe misparses UTF-8 Cyrillic in .bat files.
REM All Russian text is produced by install\install.ps1 (-SelfCheck).
REM
REM Checks the installed studio without changing anything: portable Node,
REM node_modules, production build, ComfyUI core layout, python_embeded +
REM torch import, custom nodes, core patches, model folders, and the sha256
REM of the installer bundle / download cache. Nothing is downloaded, nothing
REM is installed, the GPU is not touched.

setlocal EnableExtensions
cd /d "%~dp0"

if not exist "%~dp0install\install.ps1" (
    echo [ERROR] install\install.ps1 not found next to this file.
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install\install.ps1" -Root "%~dp0." -SelfCheck -Deep -NoPause
set "RC=%errorlevel%"

echo.
if "%RC%"=="0" (
    echo  Diagnostics: no critical problems.
) else (
    echo  Diagnostics: problems found - see the list above and install.log.
)
pause
exit /b %RC%
