; ============================================================================
; СБОРКА setup.exe (рецепт; правка 833) — файл лежит в install\installer.nsi
; ============================================================================
;
; Установщик собирается НЕ из репозитория напрямую: ему нужна папка payload
; src\ РЯДОМ с этим .nsi (File /r "src\*.*").
;
; 1) Payload. Скопируйте installer.nsi в отдельную папку сборки и положите
;    рядом src\ — рабочую копию студии:
;      • всё, что в git (код, electron\, config\, start.bat, install\ и т.д.);
;      • install\cache\ — офлайн-архивы зависимостей (node, electron, ComfyUI,
;        python-embed, uv, get-pip.py). В git их нет (>100 МБ на файл);
;      • upscale\bin\ — runtime DLSS (~1.1 ГБ, тоже вне git).
;    Лишние локальные папки (node_modules, ComfyUI, models, data,
;    .next-кэш сборки) в payload НЕ кладём — их ставит install.bat/install_gui.
;
; 2) NSIS 3.x: winget install --id NSIS.NSIS -e    (нужен только makensis.exe).
;    Из папки сборки:  makensis installer.nsi
;    (правка 961) Копию .nsi для сборки переносить только побайтово
;    (Copy-Item, robocopy) и сохранять UTF-8 BOM: Set-Content/Get-Content,
;    редакторы и архиваторы BOM теряют, а проверка scripts/check-installer.mjs
;    этого не пропустит. Сборки без BOM уже давали кракозябры в setup.exe.
;
; 3) Компрессор — SetCompressor lzma БЕЗ /SOLID (важно, см. ниже): солидный
;    блок на 1.63 ГБ NSIS 3.13 не распаковывает — установка падает с
;    «Извлечение: ошибка записи файла … node-v22.20.0-win-x64.zip» на ~55-м
;    файле. Пофайловый LZMA стабилен (так собран и setup.exe 7.1).
;
; 4) Если на C: мало места, уведите TMP/TEMP на другой диск, иначе
;    «Internal compiler error #12345: error creating mmap»:
;      $env:TMP='D:\nsis-tmp'; $env:TEMP='D:\nsis-tmp'; makensis installer.nsi
;
; Результат — Minimax_H3_Studio_7.1.24_setup.exe: ~450 МБ без офлайн-кэша
; зависимостей (install\cache\ пуст) и ~835 МБ с заполненным кэшем. В git он не
; входит (лимит GitHub — 100 МБ на файл), поэтому собирается локально и
; выкладывается отдельно от репозитория.
;
; MiniMax H3 Studio - installer (NSIS 3, Unicode)
; Payload: GitHub source + upscale\bin (DLSS runtime). Dependencies
; (node_modules, ComfyUI, python, models) are installed afterwards by
; install.bat, offered on the finish page.

!include "MUI2.nsh"
!include "LogicLib.nsh"
; (правка 961) StrStr нужен, чтобы отличить «путь с версией в имени» от
; нормального пути из реестра.
!include "StrFunc.nsh"
${StrStr}

; (правка 833) Версия УБРАНА из имени программы/папки установки: раньше было
; "Minimax_Studio_7.1", теперь просто "Minimax Studio". Версия живёт только в
; имени файла-архива (OutFile) и в package.json — переезжать из-за релиза на
; новую папку юзеру незачем (8+ ГБ зависимостей лежат внутри).
Name "MiniMax H3 Studio"
OutFile "Minimax_H3_Studio_7.1.27_setup.exe"
Unicode True

; (правка 833) LZMA без /SOLID: солидный блок на 1.63 ГБ ломается при
; распаковке (NSIS 3.13: «ошибка записи файла» на файле ~55-м по счёту).
; Пофайловый LZMA — как в собранном setup.exe 7.1 (997 МБ), стабильно.
SetCompressor lzma

; No admin needed: the app must stay user-writable (config, .next, data).
RequestExecutionLevel user

; (правка 961) Дефолтная папка — БЕЗ версии в имени, и имя папки дописывается
; к выбранному пути автоматически.
;
; Как это работает (Reference/InstallDir): компонент InstallDir ПОСЛЕ последней
; "\" страница выбора папки приклеивает к той папке, которую выбрал юзер:
;   • выбрал D:\             -> D:\Minimax Studio (папка создастся сама);
;   • выбрал D:\Games        -> D:\Games\Minimax Studio;
;   • выбрал уже готовую ...\Minimax Studio -> задвоение отсекает
;     NormalizeInstDir, в поле остаётся один компонент.
; Хвостовой "\" в InstallDir НЕ ставим: именно он отключал автодополнение
; (правка 833), и юзеру приходилось вписывать имя папки руками.
InstallDir "$PROFILE\Minimax Studio"

; (правка 961) InstallDirRegKey больше не используем: он подставлял путь из
; реестра как есть, а у обновившихся юзеров там старая папка с версией в
; названии (C:\...\Minimax_Studio_7.1). Установщик снова ставил в неё, и
; версия в имени папки «застревала». Путь из реестра читает .onInit — и
; только если в нём нет версии в имени.

!define MUI_ABORTWARNING
; (правка 748) Иконка программы — и для setup.exe, и для ярлыков ниже.
!define MUI_ICON "src\electron\icons\icon.ico"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES

; (правка 764) пункт «Запустить программу» с этой страницы убран: запуск
; спрашивается в окне установки зависимостей (после «Готово»). Текст пункта
; короткий - в одну строку, чтобы не обрезался.
!define MUI_PAGE_CUSTOMFUNCTION_SHOW FinishShow
!define MUI_FINISHPAGE_TEXT "Установка файлов завершена.$\r$\n$\r$\nТеперь нужно установить зависимости (нужен интернет, ~8 ГБ, ~10 минут). Отметьте пункт ниже и нажмите «Готово» - откроется окно установки."
!define MUI_FINISHPAGE_SHOWREADME ""
!define MUI_FINISHPAGE_SHOWREADME_TEXT "Установить зависимости сейчас (нужен интернет)"
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION RunInstall
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "Russian"
!insertmacro MUI_LANGUAGE "English"

; (правка 914) версия в свойствах exe: раньше FileVersion и ProductVersion были
; пустыми — Explorer, «Программы и компоненты» и антивирусы видели файл без
; версии. VIProductVersion даёт числовую версию (её читает Windows),
; VIAddVersionKey — текстовые поля во вкладке «Подробно».
; При выпуске новой версии менять APP_VERSION здесь и OutFile выше.
!define APP_VERSION "7.1.27"
!define APP_VERSION4 "7.1.27.0"
VIProductVersion "${APP_VERSION4}"
VIFileVersion "${APP_VERSION4}"
VIAddVersionKey /LANG=${LANG_RUSSIAN} "ProductName" "MiniMax H3 Studio"
VIAddVersionKey /LANG=${LANG_RUSSIAN} "FileDescription" "MiniMax H3 Studio — установщик"
VIAddVersionKey /LANG=${LANG_RUSSIAN} "CompanyName" "MiniMax H3 Studio"
VIAddVersionKey /LANG=${LANG_RUSSIAN} "LegalCopyright" "GNU GPL v3"
VIAddVersionKey /LANG=${LANG_RUSSIAN} "FileVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=${LANG_RUSSIAN} "ProductVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=${LANG_RUSSIAN} "Comments" "ComfyUI 0.44.0, Python 3.12.10, Electron 44.9.0; офлайн-кэш зависимостей"

; (правка 961) Приведение $INSTDIR к «одному компоненту». Функция
; идемпотентна: зовётся из .onVerifyInstDir и ещё раз перед распаковкой файлов.
Function NormalizeInstDir
  ; 1) срезать хвостовой "\" ("D:\Games\" -> "D:\Games"); корень диска
  ;    ("D:\" = 3 символа) не трогаем - его закрывает шаг 4.
  StrCpy $R1 "$INSTDIR" "" -1
  StrCmp $R1 "\" 0 nd_dedupe
  StrLen $R2 "$INSTDIR"
  StrCmp $R2 3 nd_dedupe
  StrCpy $INSTDIR "$INSTDIR" -1
nd_dedupe:
  ; 2) "...\Minimax Studio\Minimax Studio" -> "...\Minimax Studio"
  ;    (страница выбора папки дописывает компонент к уже готовой папке)
  StrCpy $R1 "$INSTDIR" "" -30
  StrCmp $R1 "\Minimax Studio\Minimax Studio" 0 nd_legacy
  StrCpy $INSTDIR "$INSTDIR" -15
nd_legacy:
  ; 3) задвоение от старых версий: "...\Minimax_Studio_7.1\Minimax_Studio_7.1"
  StrCpy $R1 "$INSTDIR" "" -38
  StrCmp $R1 "\Minimax_Studio_7.1\Minimax_Studio_7.1" 0 nd_root
  StrCpy $INSTDIR "$INSTDIR" -19
nd_root:
  ; 4) корень диска не принимаем. Важно: NSIS хранит его как "C:" — при
  ;    записи в $INSTDIR хвостовой "\" срезается сам. Иначе файлы вывалились
  ;    бы прямо в корень диска.
  StrLen $R2 "$INSTDIR"
  StrCmp $R2 2 0 nd_done
  StrCpy $R1 "$INSTDIR" "" -1
  StrCmp $R1 ":" 0 nd_done
  StrCpy $INSTDIR "$INSTDIR\Minimax Studio"
nd_done:
FunctionEnd

Function .onVerifyInstDir
  Call NormalizeInstDir
FunctionEnd

; (правка 961) Путь из реестра подставляем, только если в имени папки нет
; версии сборки. У обновившихся юзеров там старая папка (..._7.1 или
; "MiniMax H3 Studio 7") - установщик снова ставил в неё, и версия в названии
; папки «застревала» навсегда. В таком случае берём дефолт.
Function .onInit
  ReadRegStr $R0 HKCU "Software\MiniMaxH3Studio" "InstallDir"
  StrCmp $R0 "" oi_done
  ${StrStr} $R1 "$R0" "_7."
  StrCmp $R1 "" 0 oi_done
  ${StrStr} $R1 "$R0" "Studio 7"
  StrCmp $R1 "" 0 oi_done
  StrCpy $INSTDIR "$R0"
  Call NormalizeInstDir
oi_done:
FunctionEnd

Function FinishShow
  ; (правка 764) пункт «установить зависимости» - сразу отмечен,
  ; чтобы «Готово» продолжал установку одним нажатием
  SendMessage $mui.FinishPage.ShowReadme ${BM_SETCHECK} ${BST_CHECKED} 0
FunctionEnd

Function RunInstall
  ; (правка 755) Тематический загрузчик без мелькания консоли (wscript).
  SetOutPath "$INSTDIR"
  Exec '"$SYSDIR\wscript.exe" "$INSTDIR\install\install_gui.vbs"'
FunctionEnd

Section "Программа" SecMain
  SectionIn RO
  ; (правка 961) Последняя страховка: нормализуем путь ещё раз прямо перед
  ; распаковкой — даже если страница выбора папки не зовёт .onVerifyInstDir
  ; (юзер вписал путь руками и сразу нажал «Установить»).
  Call NormalizeInstDir
  SetOutPath "$INSTDIR"
  File /r "src\*.*"

  ; Shortcuts (hidden-window launch via start_hidden.vbs).
  ; (правка 748) Порядок аргументов NSIS: target [parameters [icon_file
  ; [icon_index]]] — у CreateShortCut НЕТ отдельного аргумента «рабочая
  ; папка». Раньше "$INSTDIR\start.bat" попадал в slot icon_file — отсюда
  ; «системная» иконка ярлыка. Рабочая папка — по умолчанию папка цели.
  ; (правка 833) Имя группы/ярлыков без версии: "MiniMax Studio".
  CreateDirectory "$SMPROGRAMS\MiniMax Studio"
  CreateShortCut "$SMPROGRAMS\MiniMax Studio\MiniMax Studio.lnk" \
    "$INSTDIR\start_hidden.vbs" "" "$INSTDIR\electron\icons\icon.ico" 0
  ; (правка 755) Ярлык установки зависимостей - тематическое окно без консоли.
  CreateShortCut "$SMPROGRAMS\MiniMax Studio\Установка зависимостей.lnk" \
    "$SYSDIR\wscript.exe" \
    "$\"$INSTDIR\install\install_gui.vbs$\"" \
    "$INSTDIR\electron\icons\icon.ico" 0
  CreateShortCut "$DESKTOP\MiniMax Studio.lnk" \
    "$INSTDIR\start_hidden.vbs" "" "$INSTDIR\electron\icons\icon.ico" 0

  WriteRegStr HKCU "Software\MiniMaxH3Studio" "InstallDir" "$INSTDIR"
SectionEnd

Section -Post
  WriteUninstaller "$INSTDIR\unins000.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MiniMaxH3Studio" \
    "DisplayName" "MiniMax H3 Studio"
  ; (правка 833) InstallLocation — его читает «Параметры → Приложения»
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MiniMaxH3Studio" \
    "InstallLocation" "$INSTDIR"
  ; (правка 914) версия в списке «Программы и компоненты» (раньше её не было).
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MiniMaxH3Studio" \
    "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MiniMaxH3Studio" \
    "UninstallString" "$INSTDIR\unins000.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MiniMaxH3Studio" \
    "DisplayIcon" "$INSTDIR\electron\icons\icon.ico"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MiniMaxH3Studio" \
    "EstimatedSize" "1260000"
SectionEnd

Function un.onUninstSuccess
  HideWindow
  ; (правка 833) в тихом режиме (/S) MessageBox вешает деинсталлятор намертво —
  ; диалог показываем только в обычном режиме.
  ${ifNot} ${Silent}
    MessageBox MB_ICONINFORMATION|MB_OK "MiniMax H3 Studio удалена из $INSTDIR. Модели и настройки в папке models\ были удалены вместе с программой."
  ${endif}
FunctionEnd

Section "Uninstall"
  ; Full wipe of the install folder (it is a self-contained app folder).
  ; (правка 833) Сносим и новые ярлыки, и старые «... Studio 7» — они могли
  ; остаться от установок 7.0/7.1.
  Delete "$DESKTOP\MiniMax Studio.lnk"
  Delete "$SMPROGRAMS\MiniMax Studio\MiniMax Studio.lnk"
  Delete "$SMPROGRAMS\MiniMax Studio\Установка зависимостей.lnk"
  RMDir "$SMPROGRAMS\MiniMax Studio"
  Delete "$DESKTOP\MiniMax H3 Studio 7.lnk"
  Delete "$SMPROGRAMS\MiniMax H3 Studio 7\MiniMax H3 Studio 7.lnk"
  Delete "$SMPROGRAMS\MiniMax H3 Studio 7\Установка зависимостей.lnk"
  RMDir "$SMPROGRAMS\MiniMax H3 Studio 7"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MiniMaxH3Studio"
  DeleteRegKey HKCU "Software\MiniMaxH3Studio"
SectionEnd
