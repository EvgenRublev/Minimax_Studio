# (релиз) Вписывает ресурс версии (RT_VERSION) в PE-файл.
#
# Сделано через Win32 API (BeginUpdateResource/UpdateResource/
# EndUpdateResource): Windows сам пересобирает раздел ресурсов, поэтому
# новый блок может быть БОЛЬШЕ старого — ручная правка PE не справилась бы
# (в строках VS_VERSIONINFO нет запаса, а менять длину строки нельзя без
# пересборки всей структуры).
#
# Использование:
#   powershell -NoProfile -ExecutionPolicy Bypass -File set-version-resource.ps1 `
#     -ExePath "C:\...\app.exe" -ResFile "C:\...\version.bin" -LangId 1033 -NameId 1

param(
  [Parameter(Mandatory = $true)][string]$ExePath,
  [Parameter(Mandatory = $true)][string]$ResFile,
  [int]$LangId = 1033,
  [int]$NameId = 1
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class Win32Res {
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern IntPtr BeginUpdateResource(string pFileName, bool bDeleteExistingResources);

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool UpdateResource(IntPtr hUpdate, IntPtr lpType, IntPtr lpName, ushort wLanguage, byte[] lpData, uint cbData);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool EndUpdateResource(IntPtr hUpdate, bool fDiscard);

  [DllImport("kernel32.dll")]
  public static extern uint GetLastError();
}
'@

if (-not (Test-Path -LiteralPath $ExePath)) { throw "Нет файла: $ExePath" }
if (-not (Test-Path -LiteralPath $ResFile)) { throw "Нет файла ресурса: $ResFile" }

$data = [System.IO.File]::ReadAllBytes($ResFile)

$h = [Win32Res]::BeginUpdateResource($ExePath, $false)
if ($h -eq [IntPtr]::Zero) {
  throw "BeginUpdateResource failed: $([Win32Res]::GetLastError())"
}

$ok = [Win32Res]::UpdateResource($h, [IntPtr]16, [IntPtr]$NameId, [uint16]$LangId, $data, [uint32]$data.Length)
if (-not $ok) {
  $err = [Win32Res]::GetLastError()
  [void][Win32Res]::EndUpdateResource($h, $true)
  throw "UpdateResource failed: $err"
}

if (-not [Win32Res]::EndUpdateResource($h, $false)) {
  throw "EndUpdateResource failed: $([Win32Res]::GetLastError())"
}

Write-Output "ok"
