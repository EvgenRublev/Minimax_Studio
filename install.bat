@echo off
REM MiniMax H3 Studio - dependency installer launcher.
REM ASCII only on purpose: cmd.exe misparses UTF-8 Cyrillic in .bat files
REM (see the comment at the top of start.bat). All Russian text lives in
REM install.ps1, which is UTF-8 with BOM.

setlocal EnableExtensions
cd /d "%~dp0"

if not exist "%~dp0install\install.ps1" (
    echo [ERROR] install\install.ps1 not found next to this file.
    pause
    exit /b 1
)

where powershell >nul 2>&1
if errorlevel 1 (
    echo [ERROR] PowerShell not found. Windows 10/11 is required.
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install\install.ps1" %*
set "RC=%errorlevel%"

if not "%RC%"=="0" (
    echo.
    echo  Installation finished with errors. See install.log for details.
    pause
)

exit /b %RC%
