'use client'

/**
 * (правка 911 → 1080) Баннер про поколение ядра ComfyUI.
 *
 * Внутрипрограммное обновление меняет только файлы студии и никогда не трогает
 * папку ComfyUI (install/apply_update.ps1). Поэтому обновившийся пользователь
 * может остаться на ядре, под которое нет набора патчей, — и до правки 911 он
 * узнавал об этом только из консоли.
 *
 * Компонент спрашивает /api/comfy/core-version и показывает:
 *   • красную полосу — если ядро не поддерживается ни одним набором патчей
 *     (0.34–0.43, либо старее 0.33), с кнопкой «Как обновить»;
 *   • жёлтую полосу — если работает откатное ядро 0.33.x (правка 1080, режим
 *     для слабых карт), с кнопкой «Вернуть ядро 0.44…».
 *
 * Важно: это ПРЕДУПРЕЖДЕНИЕ, а не блокировка. Пока шаблоны воркфлоу не
 * требуют нод конкретного поколения, генерация продолжается — пугать
 * пользователя запретом генерации нельзя.
 */
import { useEffect, useState } from 'react'
import { AlertTriangleIcon, XIcon, ArrowUpCircleIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useTranslation } from 'react-i18next' // (правка 955)

interface CoreVersionResp {
  ok?: boolean
  coreExists?: boolean
  version: string | null
  minVersion: string
  /** (правка 1080) 'current' | 'rollback' | 'unsupported' */
  support?: 'current' | 'rollback' | 'unsupported'
  currentMin?: string
  rollbackMin?: string
  rollbackMax?: string
  channel?: string
  outdated: boolean
  unknown?: boolean
}

export function CoreWarningBanner() {
  const { t: tt } = useTranslation() // (правка 955)

  const [info, setInfo] = useState<CoreVersionResp | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  // (правка 1080) ход «обратно на актуальное ядро» из откатного
  const [switching, setSwitching] = useState(false)
  const [switchMsg, setSwitchMsg] = useState('')

  useEffect(() => {
    let alive = true
    const check = () => {
      fetch('/api/comfy/core-version')
        .then((r) => r.json())
        .then((d: CoreVersionResp) => { if (alive) setInfo(d) })
        .catch(() => { /* эндпоинт недоступен — баннер не показываем */ })
    }
    check()
    // Ядро меняется только установщиком, то есть с перезапуском приложения,
    // но проверка дешёвая: обновляем состояние, чтобы после установки из
    // другого окна баннер гас без перезагрузки страницы.
    const t = setInterval(check, 60_000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  const backToCurrent = async () => {
    const bridge = typeof window !== 'undefined' ? window.h3desktop?.comfy?.switchCore : undefined
    if (!bridge || switching) return
    setSwitching(true)
    setSwitchMsg('')
    const res = await bridge('current').catch((e: unknown) => ({ ok: false, error: String((e as Error)?.message || e) }))
    setSwitching(false)
    if (!res?.ok) setSwitchMsg(res?.error || tt('Не удалось вернуть актуальное ядро'))
  }

  if (dismissed || !info?.version) return null

  // (правка 1080) Откатное ядро — не ошибка, а выбранный режим: показываем
  // спокойную полосу и кнопку возврата, чтобы пользователь не забыл, на чём он.
  if (info.support === 'rollback') {
    const title = tt('Работает откатное ядро ComfyUI') + `: ${info.version}`
    const detail = tt('Оно медленнее, но держит большие разрешения на картах 8-12 ГБ. Вернуться можно в любой момент — модели и ноды не трогаются.')
    return (
      <div className="flex items-center gap-3 px-4 py-2.5 bg-amber-500/10 border-b border-amber-500/20 shrink-0">
        <AlertTriangleIcon className="w-4 h-4 text-amber-400 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-xs text-amber-300 font-medium truncate" title={title}>{title}</p>
          <p className="text-[11px] text-amber-300/70 truncate" title={detail}>{switchMsg || detail}</p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs text-amber-300 border-amber-500/30 hover:bg-amber-500/10 hover:text-amber-200 shrink-0"
          disabled={switching || !window.h3desktop?.comfy?.switchCore}
          onClick={() => void backToCurrent()}
        >
          <ArrowUpCircleIcon className="w-3 h-3" />
          {' '}{switching ? tt('Возврат ядра…') : `${tt('Вернуть ядро')} ${info.currentMin || ''}`}
        </Button>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="p-1 rounded hover:bg-amber-500/20 text-amber-400/70 hover:text-amber-300 shrink-0"
          title={tt('Скрыть до перезапуска')}
        >
          <XIcon className="w-3.5 h-3.5" />
        </button>
      </div>
    )
  }

  if (!info.outdated) return null

  const ranges = `${info.rollbackMin}–${(info.rollbackMax || '').replace(/\.0$/, '')}.x, ${info.currentMin}+`
  const title = `Ядро ComfyUI не поддерживается: ${info.version} (нужно ${ranges})`
  const detail =
    'Обновление студии не трогает ComfyUI, поэтому ядро осталось прежним. ' +
    'Наши патчи и ноды есть только для ядер ' + ranges + '. Запустите install.bat один раз — ' +
    'модели, ноды и настройки сохранятся.'

  return (
    <>
      <div className="flex items-center gap-3 px-4 py-2.5 bg-red-500/10 border-b border-red-500/20 shrink-0">
        <AlertTriangleIcon className="w-4 h-4 text-red-400 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-xs text-red-300 font-medium truncate" title={title}>{title}</p>
          <p className="text-[11px] text-red-300/70 truncate" title={detail}>{detail}</p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs text-red-300 border-red-500/30 hover:bg-red-500/10 hover:text-red-200 shrink-0"
          onClick={() => setHelpOpen(true)}
        >
          <ArrowUpCircleIcon className="w-3 h-3" />
          {' '}{tt("Как обновить")}
        </Button>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="p-1 rounded hover:bg-red-500/20 text-red-400/70 hover:text-red-300 shrink-0"
          title={tt("Скрыть до перезапуска")}
        >
          <XIcon className="w-3.5 h-3.5" />
        </button>
      </div>

      <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{tt("Как обновить ядро ComfyUI")}</DialogTitle>
            <DialogDescription>
              {tt("Обновление внутри программы меняет только файлы студии. Ядро ComfyUI ставится установщиком и обновляется отдельно — один раз.")}
            </DialogDescription>
          </DialogHeader>

          <ol className="list-decimal pl-5 space-y-2 text-sm text-foreground/85">
            <li>
              {tt("Закройте студию (это окно) — установщик не сможет обновить ядро, пока ComfyUI запущен.")}
            </li>
            <li>
              {tt("В папке программы запустите")}{' '} <code className="px-1 rounded bg-[var(--surface-2)] font-mono text-xs">install.bat</code> {' '}{tt("и дождитесь окончания. Скачивается ~2 ГБ ядра, установка занимает 10–40 минут в зависимости от интернета.")}
            </li>
            <li>
              {tt("Запустите")}{' '} <code className="px-1 rounded bg-[var(--surface-2)] font-mono text-xs">start.bat</code>{tt(". Установщик сам перенесёт")}{' '} <span className="font-medium">models, custom_nodes, user, output, input, temp</span> {' '}{tt("и настройки в новое ядро; при сбое вернёт старое назад.")}
            </li>
          </ol>

          <p className="text-xs text-muted-foreground">
            {tt("Модели и кастомные ноды скачивать заново не нужно. Если вы не уверены, что установка прошла, — версия ядра показана в этом баннере и обновляется сама.")}
          </p>

          <DialogFooter>
            <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setHelpOpen(false)}>
              {tt("Понятно")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
