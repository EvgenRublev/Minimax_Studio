@echo off
REM (правка 1105) Быстрый запуск «слабой карты» без слабой карты: процесс
REM scripts\vram-hog.py забирает часть VRAM и держит, чтобы ComfyUI работал в
REM условиях реальной нехватки видеопамяти (проверка comfy-aimdo / DynamicVRAM).
REM
REM Запуск:  vram-hog.bat            - оставить свободными 8 ГБ (RTX 4060/4070)
REM          vram-hog.bat 6         - оставить 6 ГБ
REM          vram-hog.bat 8 4       - оставить 8 ГБ, занять не больше 4 ГБ
REM          vram-hog.bat 8 0 1800  - отпустить само через 30 минут
REM Остановка: Ctrl+C или закрытие окна - память освобождается сразу.
REM
REM Порядок важен: запускай хога ДО старта студии. Если ComfyUI уже поднялся и
REM загрузил H3 в 24 ГБ, он эти гигабайты не отдаст, и проверка покажет не
REM «слабую карту», а обычную работу.
REM
REM Что способ честен: нехватка VRAM как таковая - offload весов, pinned-хост
REM кэш, страничевание, malloc-graph comfy-aimdo. Чтобы aimdo видел чужой
REM процесс, в config\config.ini нужен nvml_pressure=1 (он и так по умолчанию).
REM Чего способ НЕ меняет: vram_total остаётся 24 ГБ, поэтому авто-ветки по
REM объёму карты (bounded attention, потолок тайлов Refine) не включатся - их
REM надо выставить руками в настройках.
REM
REM Кириллица только в REM-строках: под chcp 65001 парсер cmd.exe сбивается
REM (правка 587), поэтому echo/команды - только ASCII.
setlocal EnableExtensions
cd /d "%~dp0"

set "FREE_GB=%~1"
if not defined FREE_GB set "FREE_GB=8"
set "MAX_GB=%~2"
if not defined MAX_GB set "MAX_GB=0"
set "SECONDS=%~3"
if not defined SECONDS set "SECONDS=0"

REM Нечисловые значения из командной строки уходят в дефолт, иначе их подставит
REM в аргументы Python'а и запуск упадёт на разборе.
echo %FREE_GB%| findstr /r "^[0-9][0-9.]*$" >nul || set "FREE_GB=8"
echo %MAX_GB%| findstr /r "^[0-9][0-9.]*$" >nul || set "MAX_GB=0"
echo %SECONDS%| findstr /r "^[0-9]*$" >nul || set "SECONDS=0"

REM Раскладка бэкенда: плоская (ComfyUI\) или старая (ComfyUI-Easy-Install\).
set "COMFY_ROOT=ComfyUI"
if not exist "%COMFY_ROOT%\python_embeded\python.exe" if exist "ComfyUI-Easy-Install\python_embeded\python.exe" set "COMFY_ROOT=ComfyUI-Easy-Install"
if not exist "%COMFY_ROOT%\python_embeded\python.exe" (
    echo [ERROR] python_embeded not found next to %COMFY_ROOT%.
    echo         Install or repair the studio first ^(install.bat^).
    pause
    exit /b 1
)

echo [hog] keeping %FREE_GB% GB free on the GPU. Close this window or press Ctrl+C to release.
echo.
"%COMFY_ROOT%\python_embeded\python.exe" -I scripts\vram-hog.py --free-gb %FREE_GB% --max-gb %MAX_GB% --seconds %SECONDS%
echo.
echo [hog] exited, VRAM released.
pause
endlocal
