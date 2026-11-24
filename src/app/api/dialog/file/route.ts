import { NextResponse } from 'next/server'
import { spawn } from 'child_process'
import { st } from '@/lib/i18n/server'

export const dynamic = 'force-dynamic'

/**
 * (правка 1121) POST /api/dialog/file — нативный выбор ФАЙЛА (OpenFileDialog).
 * Body: { title?: string, initialDir?: string, filter?: string }
 *   filter — как в WinForms: "Модели (*.gguf)|*.gguf|Все файлы (*.*)|*.*"
 * Ответ: { path: string | null }
 *
 * Нужен для «Своя модель ассистента»: раньше был только выбор ПАПКИ, и сервер
 * брал первый .gguf внутри — при нескольких моделях в папке выбор был случайным.
 * Фокус диалога — тот же приём, что в /api/dialog/folder (правка 66).
 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}))
    const title: string = body.title || st('Выберите файл')
    const initialDir: string = body.initialDir || ''
    const filter: string = body.filter || 'Все файлы (*.*)|*.*'

    const psScript = [
      'Add-Type -AssemblyName System.Windows.Forms',
      `$dialog = New-Object System.Windows.Forms.OpenFileDialog`,
      `$dialog.Title = '${title.replace(/'/g, "''")}'`,
      `$dialog.Filter = '${filter.replace(/'/g, "''")}'`,
      `$dialog.CheckFileExists = $true`,
      initialDir
        ? `$dialog.InitialDirectory = '${initialDir.replace(/'/g, "''")}'`
        : '',
      `if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {`,
      '  Write-Output $dialog.FileName',
      '} else {',
      '  Write-Output "CANCELLED"',
      '}',
    ].filter(Boolean).join('\n')

    const child = spawn('powershell.exe', [
      '-NoProfile', '-NoLogo', '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden', '-Command', psScript,
    ], { windowsHide: true })

    const result = await new Promise<string>((resolve, reject) => {
      let out = ''
      let err = ''
      child.stdout.on('data', (d) => { out += String(d) })
      child.stderr.on('data', (d) => { err += String(d) })
      child.on('close', (code) => {
        if (code !== 0) return reject(new Error(err || `exit ${code}`))
        resolve(out.trim())
      })
      child.on('error', reject)
    })

    if (!result || result === 'CANCELLED') return NextResponse.json({ path: null })
    return NextResponse.json({ path: result })
  } catch (e) {
    return NextResponse.json({ error: (e as Error)?.message || st('Не удалось открыть диалог выбора файла') }, { status: 500 })
  }
}
