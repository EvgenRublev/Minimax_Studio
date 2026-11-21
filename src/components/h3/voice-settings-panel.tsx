'use client'

/**
 * (правка 72) Панель «Голосовой ввод» — настройки встроенного whisper STT.
 *
 *   • вкл/выкл голосовой ввод в UI
 *   • модель STT (скачивание из каталога или выбор из локальных)
 *   • язык, потоки CPU
 *   • статус сервиса + старт/перезапуск/остановка
 *   • живой тест: запись → распознанный текст
 *
 * Распознавание работает ТОЛЬКО на CPU (требование: не трогать VRAM).
 * Рантайм (transcribe.dll) встроен в проект — папку выбирать не нужно.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Loader2Icon,
  CheckCircleIcon,
  AlertCircleIcon,
  RefreshCwIcon,
  PowerIcon,
  PlayIcon,
  DownloadIcon,
  XIcon,
  MicIcon,
  SlidersHorizontalIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { VoiceInputButton } from './voice-input-button'
import { SettingsCard, SettingsRow, SettingsField, SettingsToggle, SettingsNote } from './settings-ui'
import { setSttMicDevice, getSttMicDevice } from '@/lib/use-voice-dictation'
import { useTranslation } from 'react-i18next' // (правка 955)

interface SttStatusResp {
  enabled: boolean
  sttDir: string
  model: string
  models: string[]
  modelDirs: Array<{ dir: string; files: string[] }>
  /** (правка 743) Путь к transcribe.dll и признак его наличия. */
  runtimePath?: string
  runtimeFound?: boolean
  language: string
  threads: number
  service: { running: boolean; starting: boolean; error: string | null; startedAt: number }
  health: Record<string, unknown> | null
}

interface DownloadProgress {
  name: string
  /** (правка 73) Скачивание реально идёт на сервере (для восстановления при реоткрытии панели). */
  active?: boolean
  downloaded: number
  total: number
  done: boolean
  error: string | null
  cancelled: boolean
}

const MODEL_CATALOG: Array<{ name: string; file: string; sizeLabel: string; quality: string }> = [
  { name: 'tiny',     file: 'ggml-tiny.bin',     sizeLabel: '~75 МБ',  quality: 'быстро, качество низкое' },
  { name: 'base',     file: 'ggml-base.bin',     sizeLabel: '~142 МБ', quality: 'среднее качество' },
  { name: 'small',    file: 'ggml-small.bin',    sizeLabel: '~466 МБ', quality: 'хорошее (рекомендуется)' },
  { name: 'medium',   file: 'ggml-medium.bin',   sizeLabel: '~1.5 ГБ', quality: 'отличное' },
  { name: 'large-v3', file: 'ggml-large-v3.bin', sizeLabel: '~3.1 ГБ', quality: 'лучшее, медленно' },
]

export function VoiceSettingsPanel() {
  const { t: tt } = useTranslation() // (правка 955)

  const [st, setSt] = useState<SttStatusResp | null>(null)
  const [enabled, setEnabled] = useState(true)
  const [model, setModel] = useState('')
  const [language, setLanguage] = useState('ru')
  const [threads, setThreads] = useState(0)

  const [saving, setSaving] = useState(false)
  const [testText, setTestText] = useState('')
  const [loading, setLoading] = useState(true)

  // (правка 85) Выбор микрофона
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([])
  const [selectedMic, setSelectedMic] = useState<string>('')
  const [micLoading, setMicLoading] = useState(false)

  // Download state
  // (правка 73) Прогресс храним в ref-зеркале: замыкание setInterval на state
  // «застывает» на моменте создания интервала, и первый же тик видел пустое
  // состояние, отключал поллинг — прогресс в UI больше не двигался.
  const [downloading, setDownloading] = useState<Record<string, DownloadProgress | null>>({})
  const downloadingRef = useRef<Record<string, DownloadProgress | null>>({})
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const toastShownRef = useRef<Set<string>>(new Set())
  const refreshRef = useRef<() => Promise<void>>(async () => {})

  const setProg = (name: string, p: DownloadProgress) => {
    downloadingRef.current = { ...downloadingRef.current, [name]: p }
    setDownloading(downloadingRef.current)
  }

  const resetToasts = (name: string) => {
    toastShownRef.current.delete(`ok:${name}`)
    toastShownRef.current.delete(`err:${name}`)
    toastShownRef.current.delete(`cxl:${name}`)
  }

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/stt/status')
      const d = (await r.json()) as SttStatusResp
      setSt(d)
      setEnabled(d.enabled)
      setModel(d.model)
      setLanguage(d.language)
      setThreads(d.threads)
    } catch {
      setSt(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refreshRef.current = refresh
  }, [refresh])

  /* Один тик поллинга. Читает только ref'ы — безопасно из любого замыкания. */
  const tick = () => {
    void (async () => {
      const activeNames = Object.keys(downloadingRef.current).filter((n) => {
        const p = downloadingRef.current[n]
        return p && !p.done && !p.error && !p.cancelled
      })
      if (activeNames.length === 0) {
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
        return
      }
      for (const name of activeNames) {
        try {
          const r = await fetch(`/api/stt/models/download?name=${name}`)
          if (!r.ok) continue
          const d = (await r.json()) as DownloadProgress
          setProg(name, d)
          if (d.done && !toastShownRef.current.has(`ok:${name}`)) {
            toastShownRef.current.add(`ok:${name}`)
            toast.success(tt("Модель {{p1}} скачана!", { p1: name }))
            await refreshRef.current()
          } else if (d.error && !toastShownRef.current.has(`err:${name}`)) {
            toastShownRef.current.add(`err:${name}`)
            toast.error(tt("Скачивание {{p1}}: {{p2}}", { p1: name, p2: d.error }))
          } else if (d.cancelled && !toastShownRef.current.has(`cxl:${name}`)) {
            toastShownRef.current.add(`cxl:${name}`)
            toast.info(tt("Скачивание {{p1}} отменено", { p1: name }))
          }
        } catch { /* network blip — retry next tick */ }
      }
    })()
  }

  const ensurePolling = () => {
    if (pollRef.current) return
    pollRef.current = setInterval(tick, 1500)
  }

  // (правка 85) Перечислить доступные микрофоны.
  // Для получения labels браузер должен один раз выдать доступ к микрофону.
  const refreshMics = useCallback(async () => {
    setMicLoading(true)
    try {
      // Если labels ещё не разблокированы — запрашиваем кратковременный доступ
      try {
        const tmp = await navigator.mediaDevices.getUserMedia({ audio: true })
        tmp.getTracks().forEach((t) => t.stop())
      } catch { /* нет доступа — labels будут "Microphone N" */ }
      const devices = await navigator.mediaDevices.enumerateDevices()
      const mics = devices.filter((d) => d.kind === 'audioinput')
      setMicDevices(mics)
      // Подставить сохранённый выбор (если есть), иначе — системный дефолт
      const saved = getSttMicDevice()
      if (saved) {
        const match = mics.find((m) => m.deviceId === saved)
        setSelectedMic(match ? saved : '') // сохранённый не найден → дефолт
      } else {
        setSelectedMic('')
      }
    } catch {
      setMicDevices([])
      setSelectedMic('')
    } finally {
      setMicLoading(false)
    }
  }, [])

  const handleMicChange = (id: string) => {
    setSelectedMic(id)
    setSttMicDevice(id === '__default__' ? null : id)
  }

  useEffect(() => {
    void refresh()
    void refreshMics()
    // (правка 73) Восстановить активные скачивания, если панель открыли
    // повторно во время загрузки (раньше состояние терялось).
    MODEL_CATALOG.forEach((m) => {
      if (downloadingRef.current[m.name]) return
      fetch(`/api/stt/models/download?name=${m.name}`)
        .then((r) => (r.ok ? (r.json() as Promise<DownloadProgress>) : null))
        .then((d) => {
          if (d && d.active && !d.done && !d.error && !d.cancelled) {
            setProg(m.name, d)
          }
        })
        .catch(() => { /* сервер недоступен — просто не восстанавливаем */ })
        .finally(() => { ensurePolling() })
    })
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const startDownload = async (name: string) => {
    try {
      const r = await fetch('/api/stt/models/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      const d = await r.json()
      if (!r.ok) {
        toast.error(d.error || 'Ошибка запуска скачивания')
        return
      }
      if (d.already && d.downloaded) {
        toast.success(tt("Модель {{p1}} уже скачана", { p1: name }))
        await refreshRef.current()
        return
      }
      toast.info(tt("Скачивание модели {{p1}} началось…", { p1: name }))
      resetToasts(name)
      setProg(name, { name, downloaded: 0, total: 0, done: false, error: null, cancelled: false })
      ensurePolling()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : tt("Ошибка скачивания"))
    }
  }

  const cancelDownload = async (name: string) => {
    try {
      await fetch(`/api/stt/models/download?name=${name}`, { method: 'DELETE' })
    } catch { /* ignore */ }
    const prev = downloadingRef.current[name]
    setProg(name, {
      ...(prev || { name, downloaded: 0, total: 0, done: false, error: null, cancelled: false }),
      cancelled: true,
    })
  }

  const isModelDownloaded = (modelName: string): boolean => {
    const cat = MODEL_CATALOG.find((m) => m.name === modelName)
    if (!cat) return false
    return (st?.models || []).some((m) => m === cat.file || m.includes(cat.file))
  }

  const save = async () => {
    setSaving(true)
    try {
      const r = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stt_enabled: enabled,
          stt_model: model,
          stt_language: language,
          stt_threads: threads,
        }),
      })
      if (!r.ok) {
        // (релиз) Показываем причину от сервера, а не безликое «ошибка».
        let msg = 'Ошибка сохранения настроек'
        try {
          const d = await r.json()
          if (d && typeof d.error === 'string' && d.error) msg = d.error
        } catch { /* ответ не JSON */ }
        toast.error(msg)
        return
      }
      toast.success(tt("Настройки голосового ввода сохранены"))
      // Restart STT service with new params
      const rr = await fetch('/api/stt/reload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, language, threads }),
      })
      const rd = await rr.json()
      if (rr.ok && rd.ok) {
        toast.success(tt("STT-сервис запущен и готов"), {
          description: rd.model ? tt("Модель: {{p1}}", { p1: String(rd.model).split(/[\\/]/).pop() }) : undefined,
        })
      } else if (enabled) {
        toast.error(rd.error || 'Не удалось запустить STT-сервис')
      }
      await refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : tt("Ошибка сохранения"))
    } finally {
      setSaving(false)
    }
  }

  const stopService = async () => {
    const r = await fetch('/api/stt/stop', { method: 'POST' })
    const d = await r.json().catch(() => ({}))
    if (d.ok !== false) toast.success(tt("STT-сервис остановлен (память освобождена)"))
    await refresh()
  }

  if (loading) {
    return (
      <div className="py-3 flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2Icon className="w-3.5 h-3.5 animate-spin" />
        {' '}{tt("Загрузка настроек голосового ввода…")}
      </div>
    )
  }

  const service = st?.service
  const anyModel = (st?.models.length ?? 0) > 0

  return (
    <div className="space-y-3">
﻿      {/* Вкл/выкл */}
      <SettingsCard
        icon={<MicIcon className="w-4 h-4" />}
        title={tt("Голосовой ввод")}
        description={tt("Кнопка диктовки у поля промпта, в редакторе и в чате ассистента. Работает на CPU (whisper / transcribe.cpp).")}
      >
        <SettingsRow
          label={tt("Включить диктовку")}
          description={tt("Кнопка микрофона появится в полях ввода по всему интерфейсу")}
          right={
            <SettingsToggle
              checked={enabled}
              onChange={setEnabled}
              label={tt("Голосовой ввод")}
            />
          }
        />
      </SettingsCard>

      {/* Скачивание моделей */}
      <SettingsCard
        icon={<DownloadIcon className="w-4 h-4" />}
        title={tt("Модели распознавания")}
        description={tt("Скачайте модель нужного качества. Для русского языка рекомендуется small или medium.")}
      >
        {MODEL_CATALOG.map((m) => {
          const downloaded = isModelDownloaded(m.name)
          const prog = downloading[m.name]
          const isActive = prog && !prog.done && !prog.cancelled
          const pct = prog && prog.total > 0 ? Math.round((prog.downloaded / prog.total) * 100) : 0

          return (
            <div key={m.name} className="flex items-center gap-2.5 px-3.5 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-xs font-medium text-foreground/90">{m.name}</span>
                  <span className="text-[10px] text-muted-foreground">{tt(m.sizeLabel)}</span>
                </div>
                <p className="text-[11px] text-muted-foreground">{tt(m.quality)}</p>
              </div>
              {downloaded ? (
                <Badge className="shrink-0 gap-1 border-emerald-500/30 bg-emerald-500/15 text-[10px] text-emerald-400">
                  <CheckCircleIcon className="w-3 h-3" />
                  {' '}{tt("Скачана")}
                </Badge>
              ) : isActive ? (
                <div className="flex shrink-0 items-center gap-2">
                  <div className="h-1 w-20 overflow-hidden rounded-full bg-[var(--surface-1)]">
                    <div
                      className="h-full rounded-full bg-cyan-400 transition-all"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="w-8 text-right text-[10px] text-muted-foreground">{pct}%</span>
                  <button
                    type="button"
                    onClick={() => cancelDownload(m.name)}
                    className="rounded p-1 text-red-400 hover:bg-red-500/20"
                    title={tt("Отменить скачивание")}
                  >
                    <XIcon className="w-3.5 h-3.5" />
                  </button>
                </div>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 shrink-0 gap-1.5 text-xs"
                  onClick={() => { void startDownload(m.name) }}
                >
                  <DownloadIcon className="w-3.5 h-3.5" />
                  {' '}{tt("Скачать")}
                </Button>
              )}
            </div>
          )
        })}
        {!anyModel && (
          <SettingsNote className="border-t border-amber-500/20 bg-amber-500/[0.06] text-amber-200/90">
            {tt("Модели пока нет. Скачайте модель выше (рекомендуется small для русского языка) — и она появится в списке.")}
          </SettingsNote>
        )}
      </SettingsCard>

      {/* Параметры распознавания */}
      <SettingsCard
        icon={<SlidersHorizontalIcon className="w-4 h-4" />}
        title={tt("Параметры распознавания")}
        description={tt("Модель, микрофон, язык речи и потоки CPU")}
      >
        <SettingsField
          label={tt("Активная модель")}
          description={tt("Какая модель будет использоваться. Пусто = автоматически (первая найденная).")}
        >
          <Select value={model || '__auto__'} onValueChange={(v) => setModel(v === '__auto__' ? '' : v)}>
            <SelectTrigger className="h-8 w-full text-xs">
              <SelectValue placeholder={tt("Выберите модель")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__auto__">{tt("Автоматически (первая доступная)")}</SelectItem>
              {st?.models.map((m) => (
                <SelectItem key={m} value={m}>{m}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsField>

        {/* (правка 85) Микрофон */}
        <SettingsRow
          label={tt("Микрофон")}
          description={tt("Если на компьютере несколько устройств ввода — выберите нужный здесь.")}
          right={
            <>
              <button
                type="button"
                onClick={() => { void refreshMics() }}
                disabled={micLoading}
                className="rounded p-1 text-muted-foreground transition-colors hover:bg-[var(--surface-3)] hover:text-foreground"
                title={tt("Обновить список микрофонов")}
              >
                <RefreshCwIcon className={cn('w-3.5 h-3.5', micLoading && 'animate-spin')} />
              </button>
              <Select value={selectedMic || '__default__'} onValueChange={handleMicChange} disabled={micLoading || micDevices.length === 0}>
                <SelectTrigger className="h-8 w-[240px] text-xs">
                  <SelectValue placeholder={micLoading ? tt("Загрузка…") : tt("Системный (по умолчанию)")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__default__">{tt("Системный (по умолчанию)")}</SelectItem>
                  {micDevices.map((d) => (
                    <SelectItem key={d.deviceId} value={d.deviceId}>
                      {d.label || `Микрофон ${micDevices.indexOf(d) + 1}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          }
        />

        {/* Язык + потоки */}
        <div className="grid grid-cols-2 gap-3 px-3.5 py-3">
          <div className="space-y-1.5">
            <span className="text-xs text-muted-foreground">{tt("Язык речи")}</span>
            <Select value={language} onValueChange={setLanguage}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ru">{tt("Русский")}</SelectItem>
                <SelectItem value="en">{tt("Английский")}</SelectItem>
                <SelectItem value="auto">{tt("Автоопределение")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <span className="text-xs text-muted-foreground">{tt("Потоки CPU")}</span>
            <Select value={String(threads)} onValueChange={(v) => setThreads(parseInt(v, 10))}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="0">{tt("Авто (по ядрам)")}</SelectItem>
                <SelectItem value="2">2</SelectItem>
                <SelectItem value="4">4</SelectItem>
                <SelectItem value="6">6</SelectItem>
                <SelectItem value="8">8</SelectItem>
                <SelectItem value="12">12</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </SettingsCard>

      {/* Статус сервиса */}
      <SettingsCard
        icon={<PowerIcon className="w-4 h-4" />}
        title={tt("Сервис распознавания")}
        description={tt("Запускается по требованию и освобождает память, когда не нужен")}
      >
        <SettingsRow
          label={tt("Состояние")}
          description={
            st?.health
              ? `${String(st.health.model ?? '')} · ${tt("язык:")} ${String(st.health.language ?? '')} · ${tt("потоки:")} ${String(st.health.threads ?? '')}${st.health.version ? ` · ${String(st.health.version)}` : ''}`
              : tt("Сервис поднимается при первом диктанте")
          }
          right={
            <>
              {service?.starting ? (
                <Badge variant="secondary" className="gap-1 text-[10px]">
                  <Loader2Icon className="w-3 h-3 animate-spin" />
                  {' '}{tt("Загрузка…")}
                </Badge>
              ) : service?.running ? (
                <Badge className="gap-1 border-emerald-500/30 bg-emerald-500/15 text-[10px] text-emerald-400">
                  <CheckCircleIcon className="w-3 h-3" />
                  {' '}{tt("Работает")}
                </Badge>
              ) : st?.runtimeFound === false ? (
                /* (правка 743) Рантайма нет — «запустится при первом диктанте»
                   было неправдой: сервер не сможет стартовать вообще. */
                <Badge className="border-red-500/30 bg-red-500/15 text-[10px] text-red-300">
                  {tt("Нет transcribe.dll")}
                </Badge>
              ) : (st?.models?.length ?? 0) === 0 ? (
                <Badge className="border-amber-500/30 bg-amber-500/15 text-[10px] text-amber-300">
                  {tt("Нет модели")}
                </Badge>
              ) : (
                <Badge variant="secondary" className="text-[10px]">
                  {tt("Остановлен")}
                </Badge>
              )}
              {service?.running && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 gap-1.5 text-xs"
                  onClick={stopService}
                >
                  <PowerIcon className="w-3 h-3" />
                  {' '}{tt("Остановить")}
                </Button>
              )}
            </>
          }
        />
        {/* (правка 743) Нет рантайма — объясняем, что делать. Общую ошибку
            запуска в этом случае не дублируем: причина уже названа. */}
        {st?.runtimeFound === false && (
          <p className="mx-3.5 mb-2.5 flex items-start gap-1.5 rounded-md border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-[11px] leading-snug text-amber-200/90">
            <AlertCircleIcon className="mt-0.5 w-3.5 h-3.5 shrink-0" />
            <span>
              {tt("Папка")}{' '} <code className="font-mono">stt/</code> {' '}{tt("с рантаймом (transcribe.dll и соседние DLL) не входит в поставку — скопируйте её целиком с рабочей машины рядом с")}{' '} <code className="font-mono">start.bat</code>.
            </span>
          </p>
        )}
        {service?.error && st?.runtimeFound !== false && (
          <p className="mx-3.5 mb-2.5 flex items-start gap-1.5 text-[11px] leading-snug text-red-300/90">
            <AlertCircleIcon className="mt-0.5 w-3.5 h-3.5 shrink-0" />
            {tt(service.error)}
          </p>
        )}
      </SettingsCard>

      {/* Тест */}
      <SettingsCard
        icon={<PlayIcon className="w-4 h-4" />}
        title={tt("Проверка")}
        description={tt("Нажмите кнопку, скажите фразу и нажмите её снова — текст появится ниже")}
      >
        <div className="flex items-center gap-3 px-3.5 py-2.5">
          <VoiceInputButton
            variant="inline"
            onText={(text) => setTestText(text)}
            disabled={!enabled}
          />
          <span className="text-[11px] text-muted-foreground">
            {enabled ? tt("Голосовой ввод включён") : tt("Голосовой ввод выключен — включите его выше")}
          </span>
        </div>
        {testText && (
          <div className="mx-3.5 mb-2.5 rounded-md border border-cyan-500/30 bg-cyan-500/10 px-3 py-2">
            <p className="text-xs leading-snug text-cyan-100/90">{testText}</p>
          </div>
        )}
      </SettingsCard>

      {/* Сохранить */}
      <div className="flex items-center justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          className="h-8 gap-1.5 text-xs"
          onClick={() => { void refresh() }}
          disabled={saving}
        >
          <RefreshCwIcon className="w-3.5 h-3.5" />
          {' '}{tt("Обновить")}
        </Button>
        <Button
          size="sm"
          className="h-8 gap-1.5 bg-cyan-600 text-xs hover:bg-cyan-500"
          onClick={() => { void save() }}
          disabled={saving}
        >
          {saving ? <Loader2Icon className="w-3.5 h-3.5 animate-spin" /> : <PlayIcon className="w-3.5 h-3.5" />}
          {' '}{tt("Сохранить и применить")}
        </Button>
      </div>
    </div>
  )
}

