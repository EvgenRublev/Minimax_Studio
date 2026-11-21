@echo off
REM (правка 587) chcp 65001 УДАЛЁН: под кодовой страницей 65001 cmd.exe
REM неверно отслеживает позицию чтения батника с кириллицей в UTF-8
REM комментариях — парсер мог «споткнуться» и исказить/пропустить строку
REM запуска ComfyUI. Кириллица здесь только в REM-строках: без 65001
REM парсер ходит по байтам корректно.
setlocal EnableExtensions
cd /d "%~dp0.."

set "COMFY_ROOT=ComfyUI"
REM (правка 905) Папка бэкенда — ComfyUI (официальное ядро + python_embeded).
REM Старая раскладка ComfyUI-Easy-Install\ComfyUI тоже поддерживается.
if not exist "%COMFY_ROOT%\python_embeded\python.exe" if exist "ComfyUI-Easy-Install\python_embeded\python.exe" set "COMFY_ROOT=ComfyUI-Easy-Install"
set "COMFY_CORE=%COMFY_ROOT%"
if not exist "%COMFY_ROOT%\main.py" if exist "%COMFY_ROOT%\ComfyUI\main.py" set "COMFY_CORE=%COMFY_ROOT%\ComfyUI"

REM Read VRAM config from config.ini (optional, defaults: reserve=1, dynamic=1)
REM (правка 803) Дефолты снижены: reserve 3→1, headroom 2→1.
REM First matching line wins — immune to stray duplicate keys from old configs.
set "RESERVE_VRAM="
set "DYNAMIC_VRAM="
set "ASYNC_OFFLOAD="
set "PINNED_MEMORY="
set "NVML_PRESSURE="
set "VRAM_HEADROOM="
if exist config\config.ini (
    REM (правка 357) /b /c:"key" — матч только строк, НАЧИНАЮЩИХСЯ с ключа:
    REM раньше findstr ловил и комментарии вида "REM reserve_gb=99".
    for /f "tokens=2 delims==" %%a in ('findstr /i /b /c:"reserve_gb" config\config.ini 2^>nul') do if not defined RESERVE_VRAM set "RESERVE_VRAM=%%a"
    for /f "tokens=2 delims==" %%a in ('findstr /i /b /c:"dynamic_vram" config\config.ini 2^>nul') do if not defined DYNAMIC_VRAM set "DYNAMIC_VRAM=%%a"
    for /f "tokens=2 delims==" %%a in ('findstr /i /b /c:"async_offload" config\config.ini 2^>nul') do if not defined ASYNC_OFFLOAD set "ASYNC_OFFLOAD=%%a"
    REM (правка 1073) pinned_memory=1|0 - host-кэш весов для DynamicVRAM.
    REM 0 = аварийный выключатель, если с pinned включённым загрузка модели
    REM падает ошибкой 1450/1453 - см. комментарий у EXTRA_FLAGS ниже.
    for /f "tokens=2 delims==" %%a in ('findstr /i /b /c:"pinned_memory" config\config.ini 2^>nul') do if not defined PINNED_MEMORY set "PINNED_MEMORY=%%a"
    REM (правка 1077) nvml_pressure=1|0 - учитывать ли aimdo чужие процессы за VRAM.
    for /f "tokens=2 delims==" %%a in ('findstr /i /b /c:"nvml_pressure" config\config.ini 2^>nul') do if not defined NVML_PRESSURE set "NVML_PRESSURE=%%a"
    REM (правка 490) vram_headroom — доп. запас свободной VRAM для DynamicVRAM
    for /f "tokens=2 delims==" %%a in ('findstr /i /b /c:"vram_headroom" config\config.ini 2^>nul') do if not defined VRAM_HEADROOM set "VRAM_HEADROOM=%%a"
)
if not defined RESERVE_VRAM set "RESERVE_VRAM=1"
if not defined DYNAMIC_VRAM set "DYNAMIC_VRAM=1"
if not defined VRAM_HEADROOM set "VRAM_HEADROOM=1"
REM (правка) async_offload по умолчанию = 0 (выключен). comfy-aimdo 0.4.13
REM на Windows+NVIDIA падает при загрузке больших моделей (~20 ГБ):
REM   hostbuf_file_reader_read failed / HostBuffer.read_file_slice failed,
REM   GetOverlappedResult error=1450/1453 (нехватка системных ресурсов).
REM Причина — async weight offloading (2 потока) + pinned memory. Выключаем их,
REM и модель грузится синхронно и стабильно. Включить обратно (быстрее
REM загрузка, но на RTX 50xx может падать): async_offload=1 в config\config.ini.
if not defined ASYNC_OFFLOAD set "ASYNC_OFFLOAD=0"
REM (правка 1073) pinned_memory по умолчанию = 1: host-кэш весов нужен
REM DynamicVRAM, иначе на картах меньше 15 ГБ H3 странизуется с диска.
if not defined PINNED_MEMORY set "PINNED_MEMORY=1"
REM (правка 1077) nvml_pressure по умолчанию = 1 (как в ядре).
if not defined NVML_PRESSURE set "NVML_PRESSURE=1"
set "RESERVE_VRAM=%RESERVE_VRAM:"=%"
set "DYNAMIC_VRAM=%DYNAMIC_VRAM:"=%"
set "ASYNC_OFFLOAD=%ASYNC_OFFLOAD:"=%"
set "PINNED_MEMORY=%PINNED_MEMORY:"=%"
set "NVML_PRESSURE=%NVML_PRESSURE:"=%"
set "VRAM_HEADROOM=%VRAM_HEADROOM:"=%"
REM (правка 357) Валидация: значение из config.ini подставляется в команды
REM запуска — мусор (пробелы, текст, единицы "GB") ломал бы всю строку.
REM Нечисловое значение → безопасный дефолт.
echo %RESERVE_VRAM%| findstr /r "^[0-9][0-9.]*$" >nul || set "RESERVE_VRAM=1"
echo %DYNAMIC_VRAM%| findstr /r "^[01]$" >nul || set "DYNAMIC_VRAM=1"
echo %ASYNC_OFFLOAD%| findstr /r "^[01]$" >nul || set "ASYNC_OFFLOAD=0"
echo %PINNED_MEMORY%| findstr /r "^[01]$" >nul || set "PINNED_MEMORY=1"
echo %NVML_PRESSURE%| findstr /r "^[01]$" >nul || set "NVML_PRESSURE=1"
echo %VRAM_HEADROOM%| findstr /r "^[0-9][0-9.]*$" >nul || set "VRAM_HEADROOM=1"
set "EXTRA_FLAGS="
REM (правка 1073) Флаги разделены. async_offload=0 снимает только async-конвейер
REM ComfyUI - именно он вместе с pinned давал падения aimdo ошибкой 1450/1453
REM на моделях ~20 ГБ. pinned-память теперь остаётся включённой: без неё
REM pinned_hostbuf_size() возвращает 0, host-кэша весов нет, и H3 на 12-16 ГБ
REM перечитывается с диска на каждом шаге.
if not "%ASYNC_OFFLOAD%"=="1" set "EXTRA_FLAGS=%EXTRA_FLAGS% --disable-async-offload"
if "%PINNED_MEMORY%"=="0" set "EXTRA_FLAGS=%EXTRA_FLAGS% --disable-pinned-memory"
REM (правка 1077) nvml_pressure=0 - aimdo не учитывает чужие процессы за VRAM.
if "%NVML_PRESSURE%"=="0" set "EXTRA_FLAGS=%EXTRA_FLAGS% --disable-nvml-pressure"
REM (правка 490) --vram-headroom: DynamicVRAM (aimdo) непрерывно держит
REM столько ГБ реально свободными (по NVML, включая чужие приложения) —
REM защита от всплесков активаций, перепрыгивающих --reserve-vram.
REM 0 = флаг не передаём (поведение как раньше).
set "HEADROOM_FLAG="
if not "%VRAM_HEADROOM%"=="0" set "HEADROOM_FLAG=--vram-headroom %VRAM_HEADROOM%"

REM ============================================================
REM  [CHECK] Block auto-update if .no-auto-update flag exists
REM ============================================================
REM (правка 132) Ядро ComfyUI может автоматически обновляться и подтянуть
REM  версию, несовместимую со структурой студии. Папка .no-auto-update —
REM  флаг: если она существует, обновления запрещены.
if exist "%COMFY_ROOT%\.no-auto-update" (
    echo  [OK] Auto-update blocked (.no-auto-update flag present).
    echo       ComfyUI will NOT update itself.
) else (
    echo  [WARN] Auto-update NOT blocked.
    echo         The ComfyUI backend may update itself and break.
    echo         To block: mkdir %COMFY_ROOT%\.no-auto-update
)

REM ============================================================
REM  [CHECK] Verify ComfyUI version compatibility
REM ============================================================
REM (правка 131) Ядро ComfyUI может автоматически обновиться до версии,
REM  несовместимой со структурой студии (comfy.ldm убрали, но execution.py
REM  всё ещё импортирует). Проверяем, что comfy.ldm существует - иначе
REM  ComfyUI упадёт с ModuleNotFoundError.
if not exist "%COMFY_CORE%\comfy\ldm\models\autoencoder.py" (
    echo.
    echo  [ERROR] Incompatible ComfyUI version detected.
    echo          The 'comfy.ldm' module is missing, but execution.py
    echo          still imports it. This happens when the backend
    echo          auto-updates to a new version.
    echo.
    echo  Solution: re-run the studio installer (install.bat) - it puts
    echo          the pinned ComfyUI core back in place.
    echo.
    pause
    exit /b 1
)
echo  [OK] ComfyUI version compatible.

REM Launch ComfyUI
if "%DYNAMIC_VRAM%"=="0" (
    "%COMFY_ROOT%\python_embeded\python.exe" -I "%COMFY_CORE%\main.py" --windows-standalone-build --use-ck-attention --disable-auto-launch --reserve-vram %RESERVE_VRAM% --disable-dynamic-vram %EXTRA_FLAGS% %HEADROOM_FLAG%
    exit /b %errorlevel%
) else (
    "%COMFY_ROOT%\python_embeded\python.exe" -I "%COMFY_CORE%\main.py" --windows-standalone-build --use-ck-attention --disable-auto-launch --reserve-vram %RESERVE_VRAM% %EXTRA_FLAGS% %HEADROOM_FLAG%
    exit /b %errorlevel%
)
