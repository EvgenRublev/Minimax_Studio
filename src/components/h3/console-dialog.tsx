'use client'

/**
 * ConsoleDialog — панель «Консоль» (правка 567): весь вывод реальной консоли
 * приложения внутри UI: логи server.js, ComfyUI и самого Electron-процесса.
 *
 * Источник — кольцевой буфер главного процесса (electron/main.js, захват
 * через pipe) → preload window.h3desktop.console: полный текст по запросу +
 * живые дополнения (батч 400 мс). Реальная консоль start.bat при этом
 * продолжает получать всё то же самое.
 *
 * Кнопки: «Скопировать всё» (буфер обмена) и «Сохранить в файл» (нативный
 * диалог выбора места; в браузерном фолбэке — скачивание .txt).
 * В браузерном режиме (без Electron) консоль недоступна — честная заглушка.
 */
import { useEffect, useRef, useState } from 'react'
import { CopyIcon, SaveIcon, Loader2Icon } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

const RENDERER_CAP = 1_500_000

export function ConsoleDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [text, setText] = useState('')
  const [available, setAvailable] = useState<boolean | null>(null)
  const [saving, setSaving] = useState(false)
  const preRef = useRef<HTMLPreElement>(null)
  const stickRef = useRef(true)

  useEffect(() => {
    const api = window.h3desktop?.console
    setAvailable(!!api)
    if (!api || !open) return
    let alive = true
    setText('')
    stickRef.current = true
    void api.get().then((t) => { if (alive) setText(t) })
    const off = api.onAppend((ops) => {
      setText((prev) => {
        // (правка 588) Применяем операции батча по порядку — та же семантика,
        // что у кольцевого буфера в main-процессе: 'a' — дописать, 'r' —
        // записать с начала последней строки (перезапись \r, как в консоли:
        // старый хвост длиннее — остаётся видимым, tqdm добивает пробелами).
        let next = prev
        for (const [op, text] of ops) {
          if (op === 'r') {
            const nl = next.lastIndexOf('\n')
            const oldLine = next.slice(nl + 1)
            // Хвост старой строки затираем пробелами (как clear-to-line-end):
            // короткая новая строка не оставляет «призраки» прошлой.
            const pad = oldLine.length > text.length ? ' '.repeat(oldLine.length - text.length) : ''
            next = next.slice(0, nl + 1) + text + pad
          } else {
            next += text
          }
        }
        return next.length > RENDERER_CAP ? next.slice(-1_400_000) : next
      })
    })
    return () => { alive = false; off() }
  }, [open])

  // Автоскролл к хвосту, пока пользователь у низа (как лента ассистента).
  useEffect(() => {
    const el = preRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [text])

  const lineCount = text ? text.split('\n').length : 0

  const copyAll = async () => {
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      toast.success(`Скопировано: ${lineCount} строк лога`)
    } catch {
      toast.error('Не удалось скопировать в буфер обмена')
    }
  }

  const saveToFile = async () => {
    if (!text || saving) return
    setSaving(true)
    try {
      const api = window.h3desktop?.console
      if (api) {
        const r = await api.save(text)
        if (r.ok) toast.success(`Лог сохранён: ${r.path}`)
        else if (!r.canceled) toast.error(r.error || 'Не удалось сохранить файл')
      } else {
        // Браузерный фолбэк — скачать .txt (консоль там недоступна, но на
        // случай будущих источников оставляем рабочий путь).
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `h3-studio-console-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`
        a.click()
        URL.revokeObjectURL(url)
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* (правка 568/570) Ширина: ОБЯЗАТЕЛЬНО sm:max-w — базовый DialogContent
          тащит sm:max-w-lg (512px), который перебивает max-w без sm:-префикса
          (разные варианты для tailwind-merge) — из-за этого окно было узким.
          Паттерн как у диалога настроек: w + max-w + sm:max-w. */}
      <DialogContent
        className="w-[95vw] max-w-[95vw] sm:max-w-[1200px] h-[82vh] flex flex-col p-0 gap-0 overflow-hidden"
      >
        <DialogHeader className="shrink-0 flex-row items-center justify-between gap-3 border-b border-border px-4 py-2 pr-12 text-left">
          <div className="flex min-w-0 flex-1 items-baseline gap-3">
            <DialogTitle className="shrink-0 text-base font-semibold">Консоль</DialogTitle>
            <DialogDescription className="min-w-0 truncate text-xs">
              Весь вывод приложения: веб-сервер, ComfyUI и процесс окна
              {lineCount > 0 && ` · ${lineCount.toLocaleString('ru-RU')} строк`}
            </DialogDescription>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void copyAll()}
              disabled={!text}
              className="gap-1.5 text-xs"
            >
              <CopyIcon className="w-3.5 h-3.5" />
              Скопировать всё
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void saveToFile()}
              disabled={!text || saving}
              className="gap-1.5 text-xs"
            >
              {saving ? <Loader2Icon className="w-3.5 h-3.5 animate-spin" /> : <SaveIcon className="w-3.5 h-3.5" />}
              Сохранить в файл…
            </Button>
          </div>
        </DialogHeader>

        {available === false ? (
          <div className="flex-1 flex items-center justify-center p-6">
            <div className="max-w-md text-center space-y-2">
              <p className="text-sm text-muted-foreground">
                Консоль доступна в оконном режиме приложения (Electron).
              </p>
              <p className="text-xs text-muted-foreground/70">
                В браузерном фолбэке логи смотрите в консоли запуска (start.bat).
              </p>
            </div>
          </div>
        ) : (
          <pre
            ref={preRef}
            onScroll={(e) => {
              const el = e.currentTarget
              stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
            }}
            className={cn(
              'select-text flex-1 min-h-0 min-w-0 max-w-full overflow-y-auto overflow-x-hidden px-4 py-3 m-0',
              'text-[11px] leading-[1.45] font-mono text-foreground/85 bg-[#0d0d10]',
              'whitespace-pre-wrap wrap-anywhere',
            )}
          >
            {text || '…'}
          </pre>
        )}
      </DialogContent>
    </Dialog>
  )
}
