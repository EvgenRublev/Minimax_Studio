' (fix 755) Launch the setup GUI without any console window flash.
' wscript.exe is a GUI subsystem app, and Run(..., 0, False) starts
' powershell with SW_HIDE, so no black console appears at all.
Option Explicit
Dim sh, fso, here, root, cmd
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
root = fso.GetParentFolderName(here)
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & here & "\install_gui.ps1"" -Root """ & root & """"
sh.Run cmd, 0, False
