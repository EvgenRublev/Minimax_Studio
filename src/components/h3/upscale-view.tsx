'use client'

/**
 * (правка 74) UpscaleView — нативная вкладка «Upscale» (переименована в «DLSS» — правка 266).
 *
 * Layout повторяет вкладку «Генерация»:
 *  • слева — панель параметров: статус сервиса (всегда виден), затем
 *    сворачиваемый блок «{режим} — параметры»
 *    (правки 136/137/162: блоки «GPU» и «Кодирование» убраны — всегда H.264, HDR отключён);
 *    закреплённый блок статуса job внизу панели;
 *  • справа сверху — выбор режима (Neural Rendering / RTX VSR) + загрузка
 *    видео + кнопка запуска;
 *  • справа снизу — ОБЩАЯ галерея видео (папка output ComfyUI): результаты
 *    апскейла появляются рядом со сгенерированными видео, видны во вкладке
 *    «Галерея» и чистятся кнопкой «Удалить контент».
 *
 * (правка 77) Состояние сервиса (running/starting/schema/job) вынесено в
 * клиентский синглтон `useUpscaleService` (src/lib/upscale-service.ts):
 * опрос, автозапуск и тосты переживают переключение вкладок (раньше
 * интервалы умирали при unmount, и сервис «запускался, когда вернулся»).
 * Ссылка на скачивание результата убрана — файл лежит в общей галерее.
 *
 * DLSS 5 Visual Enhancer, встроенный в проект (папка upscale/):
 *  • Neural Rendering — видео (шум, тон, структура, пресеты)
 *  • RTX Video Super Resolution — апскейл 1×–4× (HDR отключён, правка 162)
 *
 * UI общается ТОЛЬКО с роутами Next.js /api/upscale/*; они, в свою очередь,
 * разговаривают с headless-мостом upscale/bridge.py (embedded Python).
 * Работаем только с видео: подрежимы картинок в UI не выводятся.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import {
  SparklesIcon,
  PlayIcon,
  SquareIcon,
  UploadCloudIcon,
  RefreshCwIcon,
  PowerOffIcon,
  FileVideoIcon,
  Loader2Icon,
  AlertTriangleIcon,
  XIcon,
  CheckCircle2Icon,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SettingSlider } from '@/components/h3/setting-slider'
// (правка 719) Превью с полноэкранным просмотром — как на «Генерации».
import { RefPreviewThumb } from '@/components/h3/ref-preview-thumb'
import { VideoGalleryGrid, H3_VIDEO_DND_MIME } from '@/components/h3/video-gallery-grid'
import { useVideoGallery } from '@/components/h3/use-video-gallery'
import { useGalleryRefresh } from '@/lib/gallery-refresh-store'
import { useUpscaleTarget } from '@/lib/upscale-target-store'
import {
  useUpscaleService,
  attachUpscaleService,
  detachUpscaleService,
  isUpscaleJobActive,
  type UpscaleFeatureSchema,
  type UpscaleSchema,
} from '@/lib/upscale-service'
import {
  enqueueUpscale,
  cancelActiveUpscales,
  sweepOrphanUpscaleItems,
} from '@/lib/upscale-queue'

/* ────────────────────────────────────────────────────────────────
 * Типы (статус/схема/job/Gpu — в @/lib/upscale-service)
 * ──────────────────────────────────────────────────────────────── */

type FeatureKey = 'nr-video' | 'vsr-video'

interface UploadResp {
  ok: boolean
  path: string
  name: string
  size: number
  kind: 'image' | 'video'
  /** (правка 727) Папка исходника в галерее ('' = корень output). */
  subfolder?: string
  error?: string
}

interface ProbeResp {
  input: string
  size_bytes: number
  name: string
  kind: string
  width?: number
  height?: number
  fps?: number
  duration?: number
  frames?: number
  codec?: string
  hdr?: unknown
  format?: string
}

/* ────────────────────────────────────────────────────────────────
 * Контролы форм (описания параметров по фичам)
 * ──────────────────────────────────────────────────────────────── */

interface OptItem {
  label: string
  value: string | number
}

type Control = {
  kind: 'select' | 'slider' | 'toggle' | 'number'
  key: string
  label: string
  items?: OptItem[]
  min?: number
  max?: number
  step?: number
  int?: boolean
  hiddenIf?: (o: Record<string, unknown>) => boolean
}

const STR = (arr: string[]): OptItem[] => arr.map((v) => ({ label: v, value: v }))

const FALLBACK = {
  nrPreset: STR(['Default', 'Preset #1', 'Preset #2', 'Preset #3']),
  nrStyle: STR(['Default', 'Natural', 'Cinematic']),
  dlssModel: STR(['Default', 'J', 'K', 'L', 'M']),
  factor: [
    { label: '1× (DLAA / native)', value: 1.0 },
    { label: '1.5× (Quality)', value: 1.5 },
    { label: '1.724× (Balanced)', value: 1.724 },
    { label: '2× (Performance)', value: 2.0 },
    { label: '3× (Ultra Performance)', value: 3.0 },
  ],
  /* (правка 137) Кодек всегда H.264 — селект «Кодек» убран из UI, fallback остаётся
     на случай, если bridge отдаёт схему с этим полем. */
  codec: ['H.264'],
  vq: ['Auto (Default)'],
  cont: ['MP4'],
  vsrQ: [
    { label: '1 — Low', value: 1 },
    { label: '2 — Medium', value: 2 },
    { label: '3 — High', value: 3 },
    { label: '4 — Ultra', value: 4 },
  ],
  scale: [
    { label: '1×', value: 1 },
    { label: '1.5×', value: 1.5 },
    { label: '2×', value: 2 },
    { label: '3×', value: 3 },
    { label: '4×', value: 4 },
  ],
  sizeMode: STR(['Scale factor', 'Custom dimensions']),
}

function itemsFrom(s: UpscaleFeatureSchema | undefined, key: string, fallback: OptItem[]): OptItem[] {
  const raw = s?.choices?.[key]
  if (!Array.isArray(raw) || raw.length === 0) return fallback
  return raw.map((v) => {
    const item = Array.isArray(v) ? { label: String(v[0]), value: v[1] as string | number } : { label: String(v), value: String(v) }
    // (правка 162) scale_factor — число (1, 1.5, 2, 3, 4), не строка:
    // bridge раньше отдавал только labels → value = "1.5" → Python validate() падал.
    // Если bridge уже отдаёт pairs — v[1] = number и этот каст не нужен, но не вредит.
    if (key === 'scale_factor' && typeof item.value === 'string') {
      const n = parseFloat(item.value)
      if (!Number.isNaN(n) && n >= 1) item.value = n
    }
    return item
  })
}

/** Режим размера «Custom dimensions» (устойчиво к регистру/формату bridge). */
function isCustomSize(o: Record<string, unknown>): boolean {
  return String(o.size_mode ?? '').toLowerCase().includes('custom')
}

function buildSpecs(schema: UpscaleSchema | null): Record<FeatureKey, Control[]> {
  const nrVid = schema?.['nr-video']
  const vsrVid = schema?.['vsr-video']
  // NR-параметры общие для видео-фич (в bridge — общие dataclass-поля).
  // Схему берём из nr-video, фолбэк — из nr-image (если бэкенд отдаёт её).
  const nrSrc = nrVid ?? schema?.['nr-image']

  const nrPreset = itemsFrom(nrSrc, 'nr_preset', FALLBACK.nrPreset)
  const nrStyle = itemsFrom(nrSrc, 'nr_style', FALLBACK.nrStyle)
  const dlssModel = itemsFrom(nrSrc, 'dlss_model_preset', FALLBACK.dlssModel)
  const factor = itemsFrom(nrSrc, 'upscaling_factor', FALLBACK.factor)
  /* (правка 137) codec/quality/container не используются в UI — значения
     форсируются в run() (H.264 + авто-качество + MP4). */
  const vsrQ = itemsFrom(vsrVid, 'vsr_quality', FALLBACK.vsrQ)
  const scale = itemsFrom(vsrVid, 'scale_factor', FALLBACK.scale)
  const sizeMode = itemsFrom(vsrVid, 'size_mode', FALLBACK.sizeMode)

  const nrSliders: Control[] = [
    { kind: 'slider', key: 'nr_intensity', label: 'Интенсивность NR', min: 0, max: 2, step: 0.05 },
    { kind: 'slider', key: 'local_tone_strength', label: 'Локальный тон', min: 0, max: 2, step: 0.05 },
    { kind: 'slider', key: 'local_structure_strength', label: 'Локальная структура', min: 0, max: 2, step: 0.05 },
    { kind: 'slider', key: 'skin_structure_strength', label: 'Структура кожи', min: -1, max: 2, step: 0.05 },
  ]

  return {
    'nr-video': [
      { kind: 'select', key: 'nr_preset', label: 'Пресет NR', items: nrPreset },
      { kind: 'select', key: 'nr_style', label: 'Стиль', items: nrStyle },
      { kind: 'select', key: 'dlss_model_preset', label: 'DLSS-модель', items: dlssModel },
      { kind: 'select', key: 'upscaling_factor', label: 'Коэффициент', items: factor },
      ...nrSliders,
    ],
    'vsr-video': [
      { kind: 'select', key: 'vsr_quality', label: 'Качество VSR', items: vsrQ },
      { kind: 'select', key: 'size_mode', label: 'Режим размера', items: sizeMode },
      /* size_mode может прийти из bridge в другом регистре/формате — сравниваем
         без учёта регистра по слову 'custom', а не по точной строке. */
      { kind: 'select', key: 'scale_factor', label: 'Коэффициент', items: scale, hiddenIf: isCustomSize },
      { kind: 'number', key: 'width', label: 'Ширина', min: 2, max: 16384, step: 2, int: true, hiddenIf: (o) => !isCustomSize(o) },
      { kind: 'number', key: 'height', label: 'Высота', min: 2, max: 16384, step: 2, int: true, hiddenIf: (o) => !isCustomSize(o) },
      { kind: 'toggle', key: 'aspect_lock', label: 'Сохранять пропорции', hiddenIf: (o) => !isCustomSize(o) },
      /* (правка 162) RTX Video HDR убран из UI: H.264 не поддерживает HDR,
         а пользователь не должен сталкиваться с ошибкой. */
    ],
  }
}

/* ────────────────────────────────────────────────────────────────
 * Мелкие UI-элементы
 * ──────────────────────────────────────────────────────────────── */

function OptSelect({ label, value, items, onChange }: {
  label: string
  value: string | number
  items: OptItem[]
  onChange: (v: string | number) => void
}) {
  const current = items.find((i) => String(i.value) === String(value))
  return (
    <div className="space-y-1.5">
      <span className="block text-xs font-medium text-muted-foreground">{label}</span>
      <Select
        value={String(value)}
        onValueChange={(v) => {
          const it = items.find((i) => String(i.value) === v)
          onChange(it ? it.value : v)
        }}
      >
        <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
          <SelectValue>{current ? current.label : String(value)}</SelectValue>
        </SelectTrigger>
        <SelectContent className="bg-[var(--surface-3)] border-border">
          {items.map((it) => (
            <SelectItem key={String(it.value)} value={String(it.value)}>
              {it.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function OptToggle({ label, checked, onChange }: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between rounded-md border border-input bg-[var(--surface-2)]/40 px-3 py-2 text-left transition-colors hover:bg-accent/50"
    >
      <span className="text-xs font-medium text-foreground/90">{label}</span>
      <span
        className={cn(
          'relative h-5 w-9 shrink-0 rounded-full p-0.5 transition-colors',
          checked ? 'bg-violet-500' : 'bg-muted-foreground/30',
        )}
      >
        <span
          className={cn(
            'block h-4 w-4 rounded-full bg-white shadow transition-transform',
            checked ? 'translate-x-4' : 'translate-x-0',
          )}
        />
      </span>
    </button>
  )
}

function OptNumber({ label, value, min, max, step, int, onChange }: {
  label: string
  value: number
  min: number
  max: number
  step: number
  int?: boolean
  onChange: (v: number) => void
}) {
  return (
    <div className="space-y-1.5">
      <span className="block text-xs font-medium text-muted-foreground">{label}</span>
      <input
        type="number"
        value={Number.isFinite(value) ? value : min}
        min={min}
        max={max}
        step={int ? 1 : step}
        onChange={(e) => {
          const v = Number(e.target.value)
          if (Number.isFinite(v)) onChange(v)
        }}
        className="h-9 w-full rounded-md border border-input bg-[var(--surface-2)]/40 px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-ring/40"
      />
    </div>
  )
}

function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—'
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

function humanDuration(sec?: number): string {
  if (!Number.isFinite(sec) || sec === undefined || sec <= 0) return ''
  const s = Math.round(sec)
  const m = Math.floor(s / 60)
  const r = s % 60
  return m > 0 ? `${m} мин ${r} с` : `${r} с`
}

/* ────────────────────────────────────────────────────────────────
 * Режимы (видео-only)
 * ──────────────────────────────────────────────────────────────── */

const MODES = [
  { id: 'nr', label: 'Neural Rendering', hint: 'Шум, тон, структура · до 3×' },
  { id: 'vsr', label: 'RTX VSR', hint: 'Апскейл 1–4×' },
] as const

type ModeId = (typeof MODES)[number]['id']

const VIDEO_EXTS =
  '.mp4,.m4v,.mov,.mkv,.avi,.webm,.m2ts,.mts,.mxf,.vob,.wmv,.flv,.mpg,.mpeg,.ogv'

/* (правка 137) ENC_KEYS/encControls/блок «Кодирование» убраны: всегда H.264. */

/* ────────────────────────────────────────────────────────────────
 * Вкладка
 * ──────────────────────────────────────────────────────────────── */

export function UpscaleView() {
  /* (правка 77) Состояние сервиса — синглтон-стор: переживает unmount
   * вкладок, тосты fire'ятся в цикле (один раз), автозапуск — в tick. */
  const st = useUpscaleService((s) => s.st)
  const schema = useUpscaleService((s) => s.schema)
  const job = useUpscaleService((s) => s.job)
  const startBusy = useUpscaleService((s) => s.startBusy)
  const cancelBusy = useUpscaleService((s) => s.cancelBusy)
  const start = useUpscaleService((s) => s.start)
  const stop = useUpscaleService((s) => s.stop)


  /* Режим (вместо старого «таб NR/VSR + тип медиа») */
  const [tab, setTab] = useState<ModeId>('nr')

  /* (правка 77) Сворачиваемые блоки — свёрнуты по умолчанию, как Pass1/Pass2.
     (правка 136) Блок GPU убран из настроек DLSS: там всегда одна карта, выбор не нужен.
     (правка 137) Блок «Кодирование» убран: всегда H.264, HDR-сохранение отключено. */
  const [showMode, setShowMode] = useState(false)

  /* Файл */
  const [file, setFile] = useState<UploadResp | null>(null)
  const [probe, setProbe] = useState<ProbeResp | null>(null)
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  /* Опции (локальное UI-состояние: значения параметров по фичам) */
  const [opts, setOpts] = useState<Record<string, Record<string, unknown>>>({})

  /* Общая галерея (та же, что во вкладке «Генерация» и «Галерея») */
  const { files: galleryFiles, loading: galleryLoading, load: loadGallery, deleteFile } = useVideoGallery()

  const svcRunning = st?.service.running ?? false
  const svcStarting = st?.service.starting ?? false
  const svcError = st?.service.error ?? null
  const gpus = st?.health?.gpus ?? []
  const runtimeReady = st?.health?.ready ?? false
  const runtimeError = st?.health?.error ?? null
  const disabled = st?.enabled === false

  const featureKey: FeatureKey = tab === 'nr' ? 'nr-video' : 'vsr-video'

  const isBusy = isUpscaleJobActive(job)

  /* (правка 267) Защита от дурака: апскейл — только УВЕЛИЧЕНИЕ. Если исходник
   * уже выше или равен 4K (короткая сторона >= 2160), любой множитель (1–4×)
   * даст >= 2160p — результат выше исходника. Если исходник меньше 2160p,
   * множитель 1× уже не увеличит его (1× — «как есть»), а меньших
   * значений в схеме нет — значит, апскейл без повышения невозможен и
   * запуск запрещён (иначе DLSS «улучшит» уже высокое видео вхолостую). */
  const srcShortSide = probe?.width && probe?.height ? Math.min(probe.width, probe.height) : null
  const upscaleBlocked = !!srcShortSide && srcShortSide >= 2160

  // (правка 262) canRun не зависит от isBusy — можно ставить в очередь
  // (правка 267) + запрет, если исходник уже 4K и выше
  const canRun = !disabled && svcRunning && runtimeReady && !!file && !uploading && !upscaleBlocked

  /* (правка 77) Последняя строка лога моста — живая строка во время запуска. */
  const startLog = (() => {
    const t = st?.health?.log_tail
    return t && t.length > 0 ? t[t.length - 1] : null
  })()

  /* (правка 77) Подписка на синглтон: цикл опроса живёт на уровне модуля. */
  useEffect(() => {
    attachUpscaleService()
    return () => detachUpscaleService()
  }, [])

  /* Дефолты из схемы — один раз, когда схема пришла (store её кэширует). */
  useEffect(() => {
    if (!schema) return
    setOpts((prev) => {
      const next = { ...prev }
      for (const [key, f] of Object.entries(schema)) {
        if (f?.defaults && !next[key]) next[key] = { ...f.defaults }
      }
      return next
    })
  }, [schema])

  /**
   * После завершения job результат может задержаться на flush/encode —
   * несколько отложенных фоновых перезагрузок гарантируют появление
   * файла в общей галерее (аналог «staggered reload»).
   * (правка 77) Тост о завершении теперь в синглтоне; здесь только галерея,
   * привязана к id job, чтобы не дублировать при (пере)монтировании.
   */
  const refreshTimers = useRef<ReturnType<typeof setTimeout>[]>([])
  const scheduleGalleryRefresh = useCallback(() => {
    refreshTimers.current.forEach(clearTimeout)
    refreshTimers.current = [1000, 3000, 6000, 12000].map((d) =>
      setTimeout(() => void loadGallery(true), d),
    )
  }, [loadGallery])
  useEffect(() => () => refreshTimers.current.forEach(clearTimeout), [])

  const galleryRefreshedFor = useRef<string | null>(null)
  useEffect(() => {
    if (job && job.status === 'done' && galleryRefreshedFor.current !== job.id) {
      galleryRefreshedFor.current = job.id
      scheduleGalleryRefresh()
      // (правка 259) Глобальный сигнал: результат апскейла появляется и в
      // ДРУГИХ вкладках с галереей («Галерея», «Генерация»), а не только здесь.
      useGalleryRefresh.getState().bump()
    }
  }, [job, scheduleGalleryRefresh])

  /* ── действия ── */

  /** Общая часть после появления файла (загрузка ИЛИ импорт из галереи). */
  const applyLoadedFile = useCallback(async (d: UploadResp) => {
    setFile(d)
    toast.success(`Файл загружен: ${d.name}`)
    // Метаданные (нужен bridge).
    try {
      const p = await fetch('/api/upscale/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: d.path }),
        signal: AbortSignal.timeout(60000),
      })
      const pd = (await p.json().catch(() => ({}))) as ProbeResp & { error?: string }
      if (p.ok) {
        setProbe(pd)
      } else if (pd.error) {
        // Метаданные не критичны для рендера, но молча глотать причину
        // (например «сервис остановлен пользователем») — плохой UX.
        toast.warning(`Метаданные недоступны: ${pd.error}`)
      }
    } catch {
      /* без метаданных тоже можно — рендер не зависит от probe */
    }
  }, [])

  const doUpload = useCallback(async (f: File) => {
    if (uploading || isBusy) return
    setUploading(true)
    setProbe(null)
    setFile(null)
    try {
      const form = new FormData()
      form.append('file', f)
      const r = await fetch('/api/upscale/upload', { method: 'POST', body: form })
      const d = (await r.json().catch(() => ({}))) as UploadResp
      if (!r.ok || !d.ok) throw new Error(d.error ?? `upload → ${r.status}`)
      await applyLoadedFile(d)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка загрузки файла')
    } finally {
      setUploading(false)
    }
  }, [uploading, isBusy, applyLoadedFile])

  /**
   * Импорт видео ИЗ ГАЛЕРЕИ (общая папка output ComfyUI): сервер копирует
   * файл в upscale-input напрямую — без браузера в цикле (видео может быть
   * гигабайтами, fetch→blob→upload было бы двойной передачей).
   */
  const doImport = useCallback(async (filename: string, subfolder: string) => {
    if (!filename) return
    if (uploading || isBusy) {
      toast.warning('Дождитесь завершения текущей обработки апскейла')
      return
    }
    setUploading(true)
    setProbe(null)
    setFile(null)
    try {
      const r = await fetch('/api/upscale/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, subfolder }),
      })
      const d = (await r.json().catch(() => ({}))) as UploadResp
      if (!r.ok || !d.ok) throw new Error(d.error ?? `import → ${r.status}`)
      await applyLoadedFile(d)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось загрузить видео из галереи')
    } finally {
      setUploading(false)
    }
  }, [uploading, isBusy, applyLoadedFile])

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    // Видео, перетащенное из галереи проекта (превьюшка): импортируем
    // на сервере из общей папки output (без браузера в цикле).
    const raw = e.dataTransfer.getData(H3_VIDEO_DND_MIME)
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { filename?: string; subfolder?: string }
        void doImport(parsed.filename ?? '', parsed.subfolder ?? '')
      } catch {
        toast.error('Не удалось прочитать перетащенное видео')
      }
      return
    }
    const f = e.dataTransfer.files?.[0]
    if (f) void doUpload(f)
  }, [doUpload, doImport])

  /* ── Видео, отправленное кнопкой «✨» с превьюшки галереи.
   *    Клик может произойти до монтирования вкладки (и из самой галереи
   *    вкладки) — забираем цель из store и грузим видео. ── */
  const target = useUpscaleTarget((s) => s.target)
  const clearTarget = useUpscaleTarget((s) => s.clear)
  const targetInFlightRef = useRef(false)
  const doImportRef = useRef(doImport)
  doImportRef.current = doImport
  useEffect(() => {
    if (!target || targetInFlightRef.current) return
    targetInFlightRef.current = true
    // (правка 587) finally чистит цель только если в store лежит ЕЩЁ ТА ЖЕ
    // цель: второй ролик, отправленный из галереи во время импорта первого,
    // раньше молча терялся (его цель затирал finally первого импорта).
    const importedName = target.filename
    const importedSub = target.subfolder
    void doImportRef.current(importedName, importedSub).finally(() => {
      targetInFlightRef.current = false
      const cur = useUpscaleTarget.getState().target
      if (cur && cur.filename === importedName && cur.subfolder === importedSub) {
        clearTarget()
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target])

  // (правка 262) Запуск через общую очередь
  const run = useCallback(async () => {
    if (!canRun || !file) return
    /* (правка 137) Кодек принудительно H.264 + авто-качество + MP4:
       «Кодирование» убрано из UI, HDR-сохранение отключено. */
    const base = { ...(opts[featureKey] ?? {}) }
    base.codec = 'H.264'
    base.quality = 'Auto (Default)'
    base.container = 'MP4'
    /* (правка 162) HDR отключён: H.264 не поддерживает HDR. */
    base.hdr_enabled = false
    base.preserve_hdr = false
    // (правка 264) sourceName — имя исходника для сайдкара результата
    // (пока не используется в мета; оставляем для будущего расширения).
    enqueueUpscale({
      feature: featureKey,
      input: file.path,
      options: base,
      sourceName: file.name,
      // (правка 727) Результат — в папку исходника из галереи.
      subfolder: file.subfolder || '',
    })
    toast.info(`Upscale поставлен в очередь: ${file.name}`)
  }, [canRun, file, featureKey, opts])

  const cancel = useCallback(() => {
    void cancelActiveUpscales()
  }, [])

  // (правка 262) Чистка orphan-задач после перезагрузки
  useEffect(() => {
    sweepOrphanUpscaleItems()
  }, [])

  const setOptValue = useCallback((feature: FeatureKey, field: string, value: unknown) => {
    setOpts((prev) => {
      const cur = { ...(prev[feature] ?? {}) }
      cur[field] = value
      return { ...prev, [feature]: cur }
    })
  }, [])

  /* ── рендер опций режима ── */
  const specs = schema ? buildSpecs(schema) : null
  const spec = specs?.[featureKey] ?? []
  const optsFor = opts[featureKey] ?? {}
  const visibleSpec = spec.filter((c) => (c.hiddenIf ? !c.hiddenIf(optsFor) : true))
  /* (правка 137) Блок «Кодирование» убран — все видимые контролы идут в режим. */
  const modeControls = visibleSpec

  const renderControl = (c: Control) => {
    if (c.kind === 'select') {
      return (
        <OptSelect
          key={c.key}
          label={c.label}
          items={c.items ?? []}
          value={(optsFor[c.key] as string | number) ?? ''}
          onChange={(v) => setOptValue(featureKey, c.key, v)}
        />
      )
    }
    if (c.kind === 'toggle') {
      return (
        <OptToggle
          key={c.key}
          label={c.label}
          checked={!!optsFor[c.key]}
          onChange={(v) => setOptValue(featureKey, c.key, v)}
        />
      )
    }
    if (c.kind === 'number') {
      return (
        <OptNumber
          key={c.key}
          label={c.label}
          value={(optsFor[c.key] as number) ?? (c.min ?? 0)}
          min={c.min ?? 0}
          max={c.max ?? 16384}
          step={c.step ?? 1}
          int={c.int}
          onChange={(v) => setOptValue(featureKey, c.key, v)}
        />
      )
    }
    return (
      <SettingSlider
        key={c.key}
        label={c.label}
        value={(optsFor[c.key] as number) ?? (c.min ?? 0)}
        min={c.min ?? 0}
        max={c.max ?? 100}
        step={c.step ?? 0.05}
        onChange={(v) => setOptValue(featureKey, c.key, v)}
        formatValue={(v) => (v >= 100 ? String(Math.round(v)) : v.toFixed(2).replace(/\.?0+$/, ''))}
      />
    )
  }

  /* (правка 77) Заголовок сворачиваемого блока (шаблон как у Pass1/Pass2). */
  const collapseHeader = (title: string, open: boolean, onToggle: () => void) => (
    <button
      type="button"
      onClick={onToggle}
      className="w-full flex items-center justify-between px-3 py-1.5 rounded-md bg-[var(--surface-3)] border border-border/60 hover:border-violet-500/30 transition-all text-left"
    >
      <span className="text-xs font-medium text-muted-foreground">{title}</span>
      <span className={cn('text-[10px] text-muted-foreground transition-transform', open && 'rotate-180')}>▼</span>
    </button>
  )

  /* ───────────────────────────────────────────────────────────── */

  return (
    <div className="flex-1 flex min-h-0">
      {/* LEFT: панель параметров (как во вкладке «Генерация»; правка 472 — фон surface-1, как у Refine/Tile/FPS) */}
      <div className="w-[400px] shrink-0 border-r border-border flex flex-col bg-[var(--surface-1)]">
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Header */}
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">Параметры</h2>
            <Badge className="text-[10px] bg-violet-500/15 text-violet-400 border-violet-500/30 hover:bg-violet-500/15">
              DLSS 5
            </Badge>
          </div>

          <Separator className="bg-border opacity-50" />

          {/* Сервис — всегда виден, не сворачивается */}
          <div
            className="space-y-2"
            title="Сервис запускается автоматически. Первый запуск занимает 2–3 минуты. Работает только на видеокартах NVIDIA RTX (серии 20/30/40/50)."
          >
            <div className="flex items-center justify-between gap-2">
              {disabled ? (
                <span className="text-xs font-medium text-red-300">Вкладка отключена</span>
              ) : svcRunning ? (
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-300">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> сервис запущен
                </span>
              ) : svcStarting ? (
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-300">
                  <Loader2Icon className="w-3 h-3 animate-spin" /> запуск…
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">сервис не запущен</span>
              )}
              <div className="flex items-center gap-1.5 shrink-0">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void start()}
                  disabled={svcRunning || svcStarting || disabled || startBusy}
                  title="Запустить / переподключить DLSS-мост"
                >
                  <RefreshCwIcon className={cn((svcStarting || startBusy) && 'animate-spin')} />
                  Запустить
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => void stop()}
                  disabled={(!svcRunning && !svcStarting) || isBusy}
                  title={isBusy ? 'Дождитесь окончания обработки или отмените её' : 'Остановить DLSS-мост'}
                >
                  <PowerOffIcon className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>

            {/* (правка 77) Живая строка лога моста во время запуска. */}
            {(svcStarting || startBusy) && (
              <p className="text-xs text-amber-300/80 flex items-start gap-1.5 min-w-0">
                <Loader2Icon className="w-3.5 h-3.5 shrink-0 animate-spin" />
                <span className="truncate" title={startLog ?? undefined}>
                  {startLog ?? 'Подготовка рантайма DLSS…'}
                </span>
              </p>
            )}

            {svcError && (
              <p className="text-xs text-red-300 break-words flex items-start gap-1.5">
                <AlertTriangleIcon className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span className="break-words">{svcError}</span>
              </p>
            )}

            <div className="flex flex-wrap gap-1.5">
              {svcRunning && runtimeReady && (
                <Badge className="bg-violet-500/10 text-violet-300 border-violet-500/30 text-[10px]">
                  рантайм готов
                </Badge>
              )}
              {svcRunning && !runtimeReady && runtimeError && (
                <Badge variant="destructive" className="max-w-full text-[10px] truncate" title={runtimeError}>
                  <AlertTriangleIcon className="w-3 h-3" /> {runtimeError}
                </Badge>
              )}
              {svcRunning && !runtimeReady && !runtimeError && (
                <Badge className="bg-amber-500/10 text-amber-300 border-amber-500/30 text-[10px]">
                  <Loader2Icon className="w-3 h-3 animate-spin" /> подготовка рантайма…
                </Badge>
              )}
              {gpus.length > 0 && (
                <Badge variant="secondary" className="font-mono text-[10px]">
                  GPU: {gpus.map((g) => g.label).join(' + ')}
                </Badge>
              )}
            </div>
          </div>

          <Separator className="bg-border opacity-50" />

          {/* (правка 77) Сворачиваемый блок: параметры режима */}
          <div className="space-y-1.5">
            {collapseHeader(
              `${tab === 'nr' ? 'Neural Rendering' : 'RTX VSR'} — параметры`,
              showMode,
              () => setShowMode(!showMode),
            )}
            {showMode && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                className="space-y-3 pl-1 overflow-hidden"
              >
                {!schema ? (
                  <p className="text-xs text-muted-foreground/70 flex items-center gap-1.5">
                    <Loader2Icon className="w-3 h-3 animate-spin" />
                    {svcStarting ? 'запуск сервиса…' : 'ожидание схемы параметров…'}
                  </p>
                ) : modeControls.length > 0 ? (
                  <div className="space-y-3">{modeControls.map(renderControl)}</div>
                ) : (
                  <p className="text-xs text-muted-foreground/70">
                    Схема параметров появится после запуска сервиса.
                  </p>
                )}
              </motion.div>
            )}
          </div>

        </div>

        {/* Закреплённый блок: статус job (аналог GenerationStatus).
            В idle (нет джоба) не показываем — инструкция переехала в тултип
            лейбла «Режим обработки». */}
        {(isBusy || job) && (
        <div className="shrink-0 border-t border-border p-3 bg-[var(--surface-1)]/90 backdrop-blur-sm">
          {/* (правка 475) панель статуса/превью — surface-1, в цвет панели настроек */}
          {isBusy ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-violet-300 inline-flex items-center gap-1.5">
                  <Loader2Icon className="w-3.5 h-3.5 animate-spin" />
                  {job?.status === 'queued' ? 'В очереди…' : 'Идёт обработка…'}
                </span>
                <span className="text-muted-foreground font-mono tabular-nums">
                  {Math.round((job?.progress ?? 0) * 100)}%
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted-foreground/20">
                <div
                  className="h-full rounded-full transition-all duration-500 gradient-creative"
                  style={{ width: `${Math.round((job?.progress ?? 0) * 100)}%` }}
                />
              </div>
              {job?.message && (
                <p className="text-xs text-muted-foreground truncate" title={job.message}>
                  {job.message}
                </p>
              )}
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] text-muted-foreground/60">GPU занята — дождитесь</span>
                <Button variant="outline" size="sm" onClick={() => cancel()} disabled={cancelBusy}>
                  <SquareIcon />
                  {cancelBusy ? 'Отмена…' : 'Отменить'}
                </Button>
              </div>
            </div>
          ) : job?.status === 'done' ? (
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 text-sm font-medium text-emerald-300">
                <CheckCircle2Icon className="w-4 h-4" /> Готово
              </div>
              {/* (правка 77) Скачивание убрано: результат в общей галерее. */}
              <p className="text-[10px] text-muted-foreground/60">
                Результат добавлен в общую галерею справа.
              </p>
            </div>
          ) : job?.status === 'error' ? (
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-sm font-medium text-red-300">
                <AlertTriangleIcon className="w-4 h-4" /> Ошибка
              </div>
              <p className="text-xs text-red-300/80 break-words">{job.error}</p>
            </div>
          ) : job?.status === 'cancelled' ? (
            <p className="text-xs text-muted-foreground">Обработка отменена.</p>
          ) : null}
        </div>
        )}
      </div>

      {/* RIGHT: режим + файл + CTA, снизу — общая галерея */}
      <div className="flex-1 flex flex-col min-w-0 bg-[var(--surface-1)]">
        {/* Card — режим обработки + загрузка + CTA (аналог карточки промпта) */}
        <div className="p-5 pb-3 space-y-3 aurora-bg overflow-hidden flex flex-col shrink-0">
          <div className="flex items-center justify-between shrink-0">
            <Label
              className="text-sm font-medium text-foreground flex items-center gap-2"
              title="Загрузите видео, выберите режим и нажмите «Запустить». Результат появится в общей галерее справа."
            >
              <SparklesIcon className="w-4 h-4 text-violet-400" />
              Режим обработки
            </Label>
            <span className="text-[10px] text-muted-foreground/70 hidden sm:block">
              DLSS 5 · только видео · NVIDIA RTX (20/30/40/50)
            </span>
          </div>

          {disabled && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300 flex items-center gap-2">
              <AlertTriangleIcon className="w-3.5 h-3.5 shrink-0" />
              Вкладка отключена: config.ini → [upscale] enabled=1
            </div>
          )}

          {/* Выбор режима (вместо промпта) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setTab(m.id)}
                className={cn(
                  'rounded-lg border px-3 py-2.5 text-left transition-colors',
                  tab === m.id
                    ? 'border-violet-500/60 bg-violet-500/10'
                    : 'border-input bg-[var(--surface-2)]/50 hover:bg-accent/50',
                )}
              >
                <div className={cn('text-sm font-medium', tab === m.id ? 'text-violet-200' : 'text-foreground/90')}>
                  {m.label}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">{m.hint}</div>
              </button>
            ))}
          </div>

          {/* Upload (видео-only) */}
          <div
            onDragOver={(e) => {
              e.preventDefault()
              if (!uploading && !isBusy) setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            className={cn(
              'rounded-xl border border-dashed p-4 transition-colors',
              dragOver ? 'border-violet-500 bg-violet-500/10' : 'border-input',
            )}
          >
            {!file ? (
              <div className="flex flex-col items-center gap-2 py-3">
                <UploadCloudIcon className="w-8 h-8 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  Перетащите видео сюда — можно прямо с превьюшки в галерее — или{' '}
                  <button
                    type="button"
                    className="text-violet-300 underline underline-offset-2 hover:text-violet-200"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading || isBusy}
                  >
                    выберите файл
                  </button>{' '}
                  (MP4 / MOV / MKV / AVI / WEBM…)
                </p>
                <div className="flex items-center gap-2">
                  <Button size="sm" onClick={() => fileInputRef.current?.click()} disabled={uploading || isBusy}>
                    <UploadCloudIcon />
                    {uploading ? 'Загрузка…' : 'Выбрать видео'}
                  </Button>
                </div>
                {uploading && (
                  <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                    <Loader2Icon className="w-3 h-3 animate-spin" /> Пересылка в сервис… (крупные видео могут идти минуту)
                  </p>
                )}
              </div>
            ) : (
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2">
                    {/* (правка 719) Клик по названию файла — просмотр во
                        весь экран (как на вкладке «Генерация»). */}
                    <RefPreviewThumb
                      kind={file.kind === 'image' ? 'image' : 'video'}
                      name={file.name}
                      path={file.path}
                      url={`/api/upscale/file?path=${encodeURIComponent(file.path)}`}
                      className="flex items-center gap-2 text-left min-w-0 group"
                      title="Открыть файл во весь экран"
                    >
                      <FileVideoIcon className="w-4 h-4 text-violet-300 shrink-0" />
                      <span className="text-sm font-medium truncate group-hover:underline">
                        {file.name}
                      </span>
                    </RefPreviewThumb>
                  </div>
                  <div className="text-xs text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5">
                    <span>{humanBytes(file.size)}</span>
                    {probe?.width && probe?.height && <span>{probe.width}×{probe.height}</span>}
                    {probe?.fps && <span>{Number(probe.fps).toFixed(2).replace(/\.?0+$/, '')} fps</span>}
                    {probe && probe.duration ? <span>{humanDuration(probe.duration)}</span> : null}
                    {probe?.frames && <span>{probe.frames} кадров</span>}
                    {probe?.codec && <span className="font-mono">{probe.codec}</span>}
                    {probe?.hdr ? <span className="text-amber-300">HDR</span> : null}
                    {/* (правка 727) Куда ляжет результат: папка источника. */}
                    <span className="text-violet-300/90">
                      Результат: {file.subfolder ? `папка «${file.subfolder}»` : 'общая папка'}
                    </span>
                  </div>
                  {upscaleBlocked && (
                    <p className="text-xs text-amber-300/90 flex items-center gap-1.5">
                      <AlertTriangleIcon className="w-3 h-3 shrink-0" />
                      Исходник уже 4K и выше — апскейл только увеличивает, запуск запрещён
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading || isBusy}
                  >
                    Сменить
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setFile(null)
                      setProbe(null)
                    }}
                    disabled={isBusy}
                  >
                    <XIcon />
                  </Button>
                </div>
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept={VIDEO_EXTS}
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void doUpload(f)
                e.target.value = ''
              }}
            />
          </div>

          {/* CTA row */}
          <div className="flex items-center gap-3">
            <div className="flex flex-wrap items-center gap-1.5 flex-1 min-w-0">
              {file && (
                <Badge variant="secondary" className="text-[10px] max-w-[280px] truncate" title={file.name}>
                  {file.name} · {humanBytes(file.size)}
                </Badge>
              )}
              {svcRunning && runtimeReady && (
                <Badge className="bg-violet-500/10 text-violet-300 border-violet-500/30 text-[10px]">
                  готово к работе
                </Badge>
              )}
              {svcRunning && !runtimeReady && (
                <Badge className="bg-amber-500/10 text-amber-300 border-amber-500/30 text-[10px]">
                  <Loader2Icon className="w-3 h-3 animate-spin" /> ждём рантайм DLSS…
                </Badge>
              )}
              {!svcRunning && !disabled && (
                <Badge variant="secondary" className="text-[10px]">
                  сервис не запущен
                </Badge>
              )}
            </div>
            <Button
              onClick={() => void run()}
              disabled={!canRun}
              title={
                isBusy
                  ? 'Идёт обработка'
                  : upscaleBlocked
                    ? `Исходник ${probe!.width}×${probe!.height} уже 4K и выше — апскейл только увеличивает, поэтому запуск запрещён`
                    : file
                      ? 'Запустить обработку (DLSS 5)'
                      : 'Сначала загрузите видео'
              }
              className="h-11 px-6 bg-gradient-to-r from-violet-500 to-fuchsia-600 hover:from-violet-400 hover:to-fuchsia-500 text-white border-0 text-sm font-semibold shadow-lg shadow-violet-500/20"
            >
              {isBusy ? <Loader2Icon className="w-4 h-4 animate-spin" /> : <PlayIcon className="w-4 h-4" />}
              {isBusy ? 'Ещё в очередь' : 'Запустить'}
            </Button>
          </div>
        </div>

        {/* Results — ОБЩАЯ галерея (та же, что в «Генерация» и «Галерея») */}
        <div className="flex-1 overflow-y-auto px-5 pb-5 min-h-0">
          <VideoGalleryGrid
            files={galleryFiles}
            loading={galleryLoading}
            onRefresh={loadGallery}
            onDeleteFile={deleteFile}
            emptyHint="Здесь появятся сгенерированные и апскейл-видео. Выберите режим, загрузите видео и нажмите «Запустить»."
          />
        </div>
      </div>
    </div>
  )
}
