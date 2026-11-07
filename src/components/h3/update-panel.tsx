'use client'

/**
 * (правка 790) UpdatePanel — обновление самой студии прямо в приложении.
 * Живёт вверху вкладки «О программе» в настройках.
 *
 * Состояния (одно из):
 *   • актуальная версия            — «Проверить обновления» + чейнджлог установленной версии;
 *   • доступно обновление          — «Скачать (N МБ)» + «Открыть релиз» + чейнджлог;
 *   • загрузка                     — прогресс, скорость, «Отменить»;
 *   • скачано/распаковано (armed) — «Перезапустить и установить» (кнопки «Скачать» больше нет);
 *   • ошибка                      — текст + «Повторить».
 *
 * (правка 891) Кнопка «Скачать» прячется, как только обновление уже скачано
 * (downloadedVersion === версии релиза): она оставалась рядом с «Установить»
 * и путала — второй раз качать то же самое незачем. Плюс под кнопками везде
 * показывается чейнджлог релиза (see release-notes.tsx); после установки он
 * остаётся как «чейнджлог установленной версии» — до прихода следующей обновы.
 *
 * «Перезапустить и установить» дергает POST /api/update/apply (на всякий
 * случай повторяет подготовку), затем window.h3desktop.applyUpdate():
 * Electron запускает install\apply_update.ps1 и закрывается — замена файлов
 * идёт ВНЕ приложения (web-сервер не может перезаписать сам себя).
 * В браузерном режиме (без Electron) кнопка замены недоступна — панель
 * объясняет, что ставить нужно из десктопной версии.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  DownloadIcon,
  ExternalLinkIcon,
  Loader2Icon,
  RefreshCwIcon,
  RocketIcon,
  XIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ReleaseNotes } from './release-notes' // (правка 891)

interface UpdateInfo {
  version: string
  sizeBytes: number
  htmlUrl: string
  notes: string
}
interface ArmedUpdate {
  version: string
  ts: string
  depsChanged: boolean
}
interface DlState {
  status: 'downloading' | 'done' | 'error' | 'cancelled'
  version: string
  bytesReceived: number
  totalBytes: number | null
  speed: number
  error?: string
}
interface CheckResult {
  ok: boolean
  current: string
  error?: string
  update?: UpdateInfo
  armed?: ArmedUpdate
  downloadedVersion?: string
  /** (правка 891) последний релиз всегда — чейнджлог установленной версии */
  latest?: UpdateInfo
  download?: DlState | null
}

function fmtSize(n: number): string {
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + ' ГБ'
  if (n >= 1024 ** 2) return Math.round(n / 1024 ** 2) + ' МБ'
  return Math.round(n / 1024) + ' КБ'
}

export function UpdatePanel() {
  const [data, setData] = useState<CheckResult | null>(null)
  const [busy, setBusy] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const refresh = useCallback(async (force = false) => {
    try {
      const res = await fetch(`/api/update${force ? '?force=1' : ''}`)
      const j = (await res.json()) as CheckResult
      setData(j)
      return j
    } catch {
      return null
    }
  }, [])

  // Первый показ + фоновый опрос, пока идёт загрузка.
  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    const downloading = data?.download?.status === 'downloading'
    if (downloading && !pollRef.current) {
      pollRef.current = setInterval(async () => {
        try {
          const res = await fetch('/api/update/progress')
          const j = await res.json()
          const dl: DlState | null = j.download ?? null
          setData((prev) => (prev ? { ...prev, download: dl } : prev))
          if (dl && dl.status !== 'downloading') {
            // загрузка завершилась (done/error/cancelled) — за нами следит
            // автоподготовка сервера, обновляем общий статус
            void refresh()
          }
        } catch { /* сервер моргнёт — следующий тик догонит */ }
      }, 1000)
    }
    if (!downloading && pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
  }, [data?.download?.status, refresh])

  const startDownload = useCallback(async () => {
    setBusy(true)
    try {
      const res = await fetch('/api/update/download', { method: 'POST' })
      const j = await res.json()
      if (!j.ok) toast.error(j.error || 'Не удалось начать загрузку')
      await refresh()
    } catch {
      toast.error('Ошибка запроса к серверу')
    } finally {
      setBusy(false)
    }
  }, [refresh])

  const cancelDownload = useCallback(async () => {
    try {
      await fetch('/api/update/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel' }),
      })
    } catch { /* ignore */ }
    await refresh()
  }, [refresh])

  const discard = useCallback(async () => {
    try {
      await fetch('/api/update/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'discard' }),
      })
      toast.success('Обновление удалено')
    } catch { /* ignore */ }
    await refresh(true)
  }, [refresh])

  const install = useCallback(async () => {
    setBusy(true)
    try {
      // На всякий случай повторяем prepare: если staging потерялся
      // (discard, ручная чистка) — узнаём об этом до закрытия приложения.
      const res = await fetch('/api/update/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'prepare' }),
      })
      const j = await res.json()
      if (!j.ok) {
        toast.error(j.error || 'Не удалось подготовить обновление')
        await refresh()
        return
      }
      if (!window.h3desktop?.applyUpdate) {
        toast.error('Установка возможна только в десктопной версии приложения')
        return
      }
      const r = await window.h3desktop.applyUpdate()
      if (!r.ok) toast.error(r.error || 'Не удалось запустить установку')
      // При успехе приложение сейчас закроется и откроется само обновлённым.
    } catch {
      toast.error('Ошибка запроса к серверу')
    } finally {
      setBusy(false)
    }
  }, [refresh])

  if (!data) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
        <Loader2Icon className="w-3.5 h-3.5 animate-spin" />
        Проверка обновлений...
      </div>
    )
  }

  const dl = data.download
  const dlActive = dl?.status === 'downloading'
  const desktop = typeof window !== 'undefined' && !!window.h3desktop?.applyUpdate

  // (правка 891) Кнопка «Скачать» лишена смысла, если этот релиз уже скачан
  // (панель тогда предлагает «Установить»). Раньше обе кнопки висели рядом.
  const alreadyDownloaded = !!data.downloadedVersion &&
    (!data.update || data.downloadedVersion === data.update.version)

  // (правка 891) Чейнджлог показываем в любом состоянии: для доступного или
  // скачанного обновления — его релистные заметки; при актуальной версии —
  // заметки установленного релиза (они остаются до прихода следующей обновы).
  const pendingVersion = data.armed?.version ?? data.downloadedVersion ?? data.update?.version ?? null
  const notesSource = pendingVersion
    ? (data.update?.version === pendingVersion
        ? data.update
        : data.latest?.version === pendingVersion ? data.latest : undefined)
    : (data.latest?.version === data.current ? data.latest : undefined)
  const notes = notesSource?.notes?.trim() ?? ''
  const notesTitle = !pendingVersion
    ? `Что нового в v${data.current}`
    : data.armed || data.downloadedVersion
      ? `Скачано v${pendingVersion} — что внутри`
      : `Доступно v${pendingVersion} — что внутри`

  // Приложения «взведено» — ждём только перезапуска.
  if (data.armed && !dlActive) {
    return (
      <div className="space-y-2 rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3">
        <div className="text-xs">
          <span className="font-medium text-emerald-400">
            Обновлено скачано: v{data.armed.version}
          </span>
          {data.armed.depsChanged && (
            <div className="text-[11px] text-muted-foreground mt-1">
              Изменились зависимости — после перезапуска откроется окно установки
              компонентов, дождитесь его завершения.
            </div>
          )}
          {!desktop && (
            <div className="text-[11px] text-muted-foreground mt-1">
              Установка доступна в десктопной версии приложения.
            </div>
          )}
        </div>
        <div className="flex gap-2">
          {desktop && (
            <Button size="sm" onClick={() => void install()} disabled={busy} className="gap-1.5">
              <RocketIcon className="w-3.5 h-3.5" />
              Перезапустить и установить
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => void discard()} className="gap-1.5">
            <XIcon className="w-3.5 h-3.5" />
            Отменить
          </Button>
        </div>
        {notes && (
          <div className="space-y-1 pt-1">
            <div className="text-[11px] font-medium text-muted-foreground">{notesTitle}</div>
            <ReleaseNotes notes={notes} />
          </div>
        )}
      </div>
    )
  }

  // Загрузка в процессе.
  if (dlActive && dl) {
    const pct = dl.totalBytes ? Math.min(100, (dl.bytesReceived / dl.totalBytes) * 100) : 0
    return (
      <div className="space-y-2 rounded-md border border-border/60 p-3">
        <div className="flex items-center justify-between text-xs">
          <span>Загрузка v{dl.version}...</span>
          <span className="text-muted-foreground">
            {fmtSize(dl.bytesReceived)}
            {dl.totalBytes ? ` / ${fmtSize(dl.totalBytes)}` : ''}
            {dl.speed > 0 ? ` · ${fmtSize(dl.speed)}/с` : ''}
          </span>
        </div>
        <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
          <div
            className="h-full bg-violet-500 transition-[width] duration-500"
            style={{ width: `${pct}%` }}
          />
        </div>
        <Button size="sm" variant="outline" onClick={() => void cancelDownload()} className="gap-1.5">
          <XIcon className="w-3.5 h-3.5" />
          Отменить загрузку
        </Button>
        {notes && (
          <div className="space-y-1 pt-1">
            <div className="text-[11px] font-medium text-muted-foreground">{notesTitle}</div>
            <ReleaseNotes notes={notes} />
          </div>
        )}
      </div>
    )
  }

  const failedDl = dl && (dl.status === 'error' || dl.status === 'cancelled') ? dl : null

  return (
    <div className="space-y-2 rounded-md border border-border/60 p-3">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">
          Обновления студии
          {alreadyDownloaded && data.downloadedVersion ? (
            <span className="text-emerald-400"> — v{data.downloadedVersion} скачано, ждёт установки</span>
          ) : data.update ? (
            <span className="text-violet-400 font-medium"> — доступно v{data.update.version}</span>
          ) : data.ok ? (
            <span className="text-emerald-400"> — актуальная версия</span>
          ) : (
            <span className="text-muted-foreground/70"> — {data.error || 'сервис недоступен'}</span>
          )}
        </span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void refresh(true)}
          className="h-6 gap-1 text-[11px] px-2"
        >
          <RefreshCwIcon className="w-3 h-3" />
          Проверить
        </Button>
      </div>

      {failedDl && (
        <div className="text-[11px] text-red-400">
          {failedDl.status === 'cancelled'
            ? 'Загрузка остановлена — начните заново (прогресс сохранён).'
            : `Ошибка загрузки: ${failedDl.error || 'неизвестная'}`}
        </div>
      )}

      {data.update && !failedDl && (
        <div className="flex flex-wrap gap-2">
          {/* (правка 891) после скачивания кнопка «Скачать» убирается: второй раз
              качать тот же релиз незачем, остаётся «Установить» ниже. */}
          {!alreadyDownloaded && (
            <Button size="sm" onClick={() => void startDownload()} disabled={busy} className="gap-1.5">
              <DownloadIcon className="w-3.5 h-3.5" />
              Скачать {data.update.sizeBytes ? `(${fmtSize(data.update.sizeBytes)})` : ''}
            </Button>
          )}
          {data.update.htmlUrl && (
            <Button
              size="sm"
              variant="outline"
              asChild
              className="gap-1.5"
            >
              <a href={data.update.htmlUrl} target="_blank" rel="noreferrer">
                <ExternalLinkIcon className="w-3.5 h-3.5" />
                Открыть релиз
              </a>
            </Button>
          )}
        </div>
      )}

      {data.downloadedVersion && !dlActive && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => void install()} disabled={busy} className="gap-1.5">
            <RocketIcon className="w-3.5 h-3.5" />
            Установить v{data.downloadedVersion}
          </Button>
          <Button size="sm" variant="outline" onClick={() => void discard()} className="gap-1.5">
            <XIcon className="w-3.5 h-3.5" />
            Удалить
          </Button>
        </div>
      )}

      {/* (правка 891) чейнджлог: заметки доступного/скачанного релиза, а при
          актуальной версии — заметки установленной (до следующей обновы). */}
      {notes && (
        <div className="space-y-1 pt-1">
          <div className="text-[11px] font-medium text-muted-foreground">{notesTitle}</div>
          <ReleaseNotes notes={notes} />
        </div>
      )}
    </div>
  )
}
