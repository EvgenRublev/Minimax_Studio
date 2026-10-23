import { NextResponse } from 'next/server'
import { spawn } from 'child_process'
import path from 'path'

export const dynamic = 'force-dynamic'

/**
 * POST /api/dialog/folder
 * Body: { title?: string, initialDir?: string }
 *
 * Opens a native Windows folder picker (PowerShell + WinForms) and returns
 * the selected folder path, or null if cancelled.
 *
 * FOREGROUND HANDLING — history:
 *  * originally: ShowDialog() on the main thread → the dialog worked but
 *    opened BEHIND the browser (Node-spawned processes have no foreground
 *    rights); the user had to minimize the browser to find it;
 *  * правка 63: moved ShowDialog() to a background STA thread so the main
 *    thread could call SetForegroundWindow. BROKEN: PowerShell 5.1 on the
 *    target machine hard-crashes (silent exit 2) whenever a thread started
 *    with a script-block delegate runs — verified by bisection (a thread
 *    doing only Start-Sleep already kills the process). The dialog stopped
 *    appearing at all, and the UI swallowed the 500 as a plain "cancelled";
 *  * правка 66 (current): NO THREADS. The dialog runs on the main thread
 *    (the proven pattern). A separate helper process —
 *    tools/folder_dialog_focus.ps1, main thread only — finds the dialog
 *    window (class #32770 + the dialog process pid, since the caption is a
 *    localized fixed string) and forces it to the front: SetWindowPos
 *    TOPMOST + SetForegroundWindow with an ALT-press fallback.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}))
    const title: string = body.title || 'Выберите папку'
    const initialDir: string = body.initialDir || ''

    // Dialog script — main thread, the pattern that worked before правка 63.
    const psScript = [
      'Add-Type -AssemblyName System.Windows.Forms',
      `$dialog = New-Object System.Windows.Forms.FolderBrowserDialog`,
      `$dialog.Description = '${title.replace(/'/g, "''")}'`,
      // SelectedPath открывает диалог сразу в нужной папке (RootFolder при
      // этом должен позволять её видеть — MyComputer покрывает все диски)
      initialDir
        ? `$dialog.SelectedPath = '${initialDir.replace(/'/g, "''")}'; $dialog.RootFolder = [System.Environment+SpecialFolder]::MyComputer`
        : '',
      `if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {`,
      '  Write-Output $dialog.SelectedPath',
      '} else {',
      '  Write-Output "CANCELLED"',
      '}',
    ].filter(Boolean).join('\n')

    // (правка 66) Start the DIALOG first so we know its pid, then start the
    // focus helper (fire-and-forget) with that pid. The helper polls for
    // the dialog window and forces it to the front. If the helper fails to
    // start, the dialog still opens (possibly behind the browser — the
    // original pre-правка-63 behaviour, acceptable degradation).
    const dialog = spawn(
      'powershell',
      ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
      { windowsHide: true },
    )

    // (правка 66) IMPORTANT: this environment mangles backslash paths in
    // `powershell -File` arguments (they get stripped, e.g. C:\Users\PC ->
    // C:UsersPC...), while forward slashes work. Convert to POSIX form —
    // verified on the target machine (absolute forward-slash path OK).
    const toPosix = (p: string) => p.split(path.sep).join('/')
    const focusScript = toPosix(path.join(process.cwd(), 'tools', 'folder_dialog_focus.ps1'))
    if (dialog.pid) {
      try {
        const helper = spawn(
          'powershell',
          [
            '-NoProfile',
            '-WindowStyle', 'Hidden',
            '-ExecutionPolicy', 'Bypass',
            '-File', focusScript,
            '-DialogPid', String(dialog.pid),
          ],
          { stdio: 'ignore', windowsHide: true, cwd: toPosix(process.cwd()) },
        )
        helper.on('error', () => { /* helper is best-effort */ })
        helper.unref()
      } catch {
        /* best-effort */
      }
    }

    // Await the dialog process with a 120 s timeout.
    const DIALOG_TIMEOUT_MS = 120_000
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      let stdout = ''
      let stderr = ''
      let settled = false
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          try { dialog.kill() } catch { /* ignore */ }
          resolve({ code: null, stdout, stderr: stderr + ' (timeout)' })
        }
      }, DIALOG_TIMEOUT_MS)
      dialog.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8') })
      dialog.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8') })
      dialog.on('error', (err: Error) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          resolve({ code: null, stdout, stderr: err.message })
        }
      })
      dialog.on('close', (code: number | null) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          resolve({ code, stdout, stderr })
        }
      })
    })

    if (result.code !== 0) {
      return NextResponse.json(
        { error: `Не удалось открыть диалог выбора папки: ${result.stderr.trim() || `код ${result.code}`}` },
        { status: 500 },
      )
    }

    const output = result.stdout.trim()
    if (output === 'CANCELLED' || !output) {
      return NextResponse.json({ path: null })
    }

    return NextResponse.json({ path: output })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json(
      { error: `Не удалось открыть диалог выбора папки: ${msg}` },
      { status: 500 },
    )
  }
}
