# (правка 66) Helper process for the native folder picker.
#
# WHY THIS FILE EXISTS:
# The dialog (FolderBrowserDialog) runs in its own powershell.exe process
# (see src/app/api/dialog/folder/route.ts). A process spawned by Node is NOT
# in the foreground, so Windows opens the dialog BEHIND the browser window
# and the user never sees it.
#
# правка 63 tried to fix this by showing the dialog on a BACKGROUND THREAD
# and calling SetForegroundWindow from the main thread. That broke the
# dialog completely: PowerShell 5.1 on this machine HARD-CRASHES (silent
# exit code 2) whenever a thread started with a script-block delegate runs -
# even a thread that only does Start-Sleep. Verified by bisection on the
# target machine (t3/t4/t5 diagnostics).
#
# THIS APPROACH (правка 66) uses NO THREADS AT ALL:
#   * dialog process - main thread, ShowDialog() (the pattern that worked
#                      before правка 63);
#   * helper process - THIS file, main thread only. It enumerates top-level
#                      windows of class #32770 (the standard Win32 dialog
#                      class; the FolderBrowserDialog caption is a fixed
#                      localized string and differs per OS language, so we
#                      deliberately do NOT match by title) and picks the
#                      window whose process id matches the dialog process
#                      (-DialogPid, passed by Node). Then it forces the
#                      dialog to the front:
#                        1) SetWindowPos(HWND_TOPMOST) - the dialog stays
#                           above the browser even without focus (the part
#                           that reliably fixes "dialog behind the app");
#                        2) SetForegroundWindow, with the standard simulated
#                           ALT-press fallback if Windows denies it (focus).
# Both processes use only their main threads, so the PS 5.1 crash pattern
# cannot trigger.
#
# Invocation (from the route, fire-and-forget):
#   powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File <this> -DialogPid 1234

param([Parameter(Mandatory = $true)][int]$DialogPid)

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Win32h {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool GetWindowThreadProcessId(IntPtr hWnd, out int processId);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@

$script:target = [IntPtr]::Zero
$script:dialogPid = [int]$DialogPid

$enumProc = [Win32h+EnumWindowsProc]{
  param($hwnd, $l)
  if ([Win32h]::IsWindowVisible($hwnd)) {
    $cb = New-Object System.Text.StringBuilder 256
    [void][Win32h]::GetClassName($hwnd, $cb, 256)
    if ($cb.ToString() -eq '#32770') {
      $winPid = 0
      [void][Win32h]::GetWindowThreadProcessId($hwnd, [ref]$winPid)
      if ($winPid -eq $script:dialogPid) { $script:target = $hwnd }
    }
  }
  return $true
}

# The dialog process takes ~1.5-2 s to boot; poll for its window for up to
# 30 s (covers a slow machine / AV scan on first run).
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
  $script:target = [IntPtr]::Zero
  [void][Win32h]::EnumWindows($enumProc, [IntPtr]::Zero)
  if ($script:target -ne [IntPtr]::Zero) {
    # HWND_TOPMOST (-1); SWP_NOSIZE (0x1) | SWP_NOMOVE (0x2) | SWP_NOACTIVATE (0x10)
    # NOTE: [IntPtr]::MinusOne evaluates to $null in PowerShell 5.1 (silent
    # failure -> SetWindowPos throws, TOPMOST never set). Use the constructor.
    [void][Win32h]::SetWindowPos($script:target, [IntPtr](-1), 0, 0, 0, 0, 0x13)

    # Try to take focus directly first.
    $gotFocus = [Win32h]::SetForegroundWindow($script:target)

    if (-not $gotFocus) {
      # Standard "foreground rights" workaround: a simulated ALT key press
      # counts as user input for the process that injected it.
      [void][Win32h]::keybd_event(16, 0, 0, [UIntPtr]::Zero)
      [void][Win32h]::keybd_event(16, 0, 2, [UIntPtr]::Zero)
      [void][Win32h]::SetForegroundWindow($script:target)
    }

    # Re-assert TOPMOST a couple of seconds later (in case the browser
    # regains focus and the Z-order shifts back).
    Start-Sleep -Seconds 2
    [void][Win32h]::SetWindowPos($script:target, [IntPtr](-1), 0, 0, 0, 0, 0x13)
    break
  }
  Start-Sleep -Milliseconds 150
}
exit 0
