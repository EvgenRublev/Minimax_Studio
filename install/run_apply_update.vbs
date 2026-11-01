' (fix 798) Launcher for install\apply_update.ps1 that runs OUTSIDE Electron.
'
' WHY: Electron (Chromium) keeps its browser process inside a Windows Job
' Object with kill-on-close, and every child spawned directly joins that job.
' The in-app updater therefore died together with the app right after its
' first log line, before it could replace a single file. explorer.exe hands
' this script to the already-running shell, so PowerShell starts as a child
' of explorer.exe - outside the job - and survives the app shutdown.
'
' Input: ..\.update\apply_cmd.txt (UTF-16LE, one line = full PowerShell
' command line), written by electron/main.js right before this script starts.
' No window is shown (shell.Run ..., 0, False).
Option Explicit

Dim fso, shell, scriptDir, root, cmdFile, cmdLine, ts
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
root = fso.GetParentFolderName(scriptDir)
cmdFile = root & "\.update\apply_cmd.txt"

If Not fso.FileExists(cmdFile) Then
  WScript.Quit 1
End If

Set ts = fso.OpenTextFile(cmdFile, 1, False, -1)
cmdLine = Trim(ts.ReadAll)
ts.Close

If Len(cmdLine) = 0 Then
  WScript.Quit 2
End If

' 0 = hidden window, False = do not wait (this script must exit immediately).
shell.Run cmdLine, 0, False

WScript.Quit 0
