' ============================================================
' (правка 570) Скрытый запуск start.bat
'
' WshShell.Run: не блокирующий запуск процесса.
' 0 = HideWindow (окно не появляется ни в таскбаре, ни на экране)
' False = не ждать завершения (VBS сразу завершается, cmd живёт в фоне)
'
' При закрытии Electron-окна — electron/main.js убивает родительский
' cmd-процесс через taskkill (PID родителя = process.ppid в Node.js).
'
' Запуск: cscript //nologo start_hidden.vbs
' ============================================================

Option Explicit

' (правка 580) Диалог ошибок VBS при запуске — иначе ошибка скрывается
' и пользователь видит только пустой вывод start.bat.
On Error Resume Next

Dim shell
Set shell = CreateObject("WScript.Shell")
' (правка 587) Echo-строки — ASCII: файл в UTF-8, а cscript читает VBS
' как ANSI, кириллица в Echo стала бы кракозябрами.
If Err.Number <> 0 Then
  WScript.Echo "[start_hidden.vbs] Failed to create WshShell: " & Err.Description
  Err.Clear
  WScript.Quit 1
End If

' Путь к start.bat — в той же папке, что и этот VBS-скрипт
' (правка 574) WScript.ScriptFolder не работает в cscript — используем FSO
' (правка 716) Ошибки создания FSO/получения папки ПРОВЕРЯЮТСЯ. Раньше
' On Error Resume Next глушил их, и скрипт завершался с кодом 0, ничего не
' запустив (пользователь не видел ничего).
Dim fso, scriptDir, batPath
Set fso = CreateObject("Scripting.FileSystemObject")
If Err.Number <> 0 Then
  WScript.Echo "[start_hidden.vbs] Failed to create FileSystemObject: " & Err.Description
  Err.Clear
  WScript.Quit 1
End If
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
If Err.Number <> 0 Then
  WScript.Echo "[start_hidden.vbs] Failed to resolve script folder: " & Err.Description
  Err.Clear
  WScript.Quit 1
End If
If Len(scriptDir) = 0 Then
  WScript.Echo "[start_hidden.vbs] Failed to resolve script folder (empty path)"
  WScript.Quit 1
End If
batPath = scriptDir & "\start.bat"

' Запуск: 0 = скрытое окно, False = не блокировать
' (правка 570) cmd /c call "...\start.bat" :hidden — bat получит :hidden как $1.
' Кавычки через Chr(34) сохраняют пути с пробелами; VBS завершается сразу.
shell.Run "cmd /c call " & Chr(34) & batPath & Chr(34) & " :hidden", 0, False
If Err.Number <> 0 Then
  WScript.Echo "[start_hidden.vbs] Failed to run start.bat: " & Err.Description
  Err.Clear
  WScript.Quit 1
End If

' VBS завершается — cmd (скрытое окно) живёт дальше, Electron внутри него.
' При закрытии Electron-окна main.js убьёт родителя (cmd.exe) через taskkill.
WScript.Quit 0
