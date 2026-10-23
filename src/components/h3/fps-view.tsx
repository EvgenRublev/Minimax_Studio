'use client'

/**
 * FpsView — вкладка «FPS»: frame interpolation (VFI) готового видео. (правка 268)
 *
 * Два режима из пакета Fannovel16/ComfyUI-Frame-Interpolation:
 *   RIFE VFI  — быстрый, мало VRAM (параметры: model, batch, scale, dtype, fast/ensemble).
 *   FILM VFI  — для крупных движений (только model + multiplier).
 *
 * Layout как у Tile Upscale: слева — параметры + статус, справа — галерея.
 * Источник: drag&drop из галереи или файл с диска.
 *
 * Целевой fps = исходный fps × multiplier. Скорость видео НЕ меняется —
 * вставляются промежуточные кадры (24→48/72/96 fps), звук сохраняется.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  GaugeIcon,
  PlayIcon,
  FileVideoIcon,
  Loader2Icon,
  ZapIcon,
  FilmIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select' // (правка 464)
import { VideoGalleryGrid, H3_VIDEO_DND_MIME } from '@/components/h3/video-gallery-grid'
import { GenerationStatus } from '@/components/h3/generation-status'
// (правка 719) Превью с полноэкранным просмотром — как на «Генерации».
import { RefPreviewThumb } from '@/components/h3/ref-preview-thumb'
import { useVideoGallery } from '@/components/h3/use-video-gallery'
import { useFpsTarget, type FpsSource, type FpsMode } from '@/lib/fps-store'
import { useFpsJob } from '@/lib/fps-job-store' // (правка 554)
import { uploadInputFile } from '@/lib/upload'

/** (правка 268) Два режима VFI — кнопки-карточки (паттерн MODES из upscale-view). */
const MODES: Array<{ id: FpsMode; label: string; hint: string; icon: typeof ZapIcon }> = [
  { id: 'rife', label: 'RIFE VFI', hint: 'Быстрый · мало VRAM', icon: ZapIcon },
  { id: 'film', label: 'FILM VFI', hint: 'Крупные движения', icon: FilmIcon },
]

export function FpsView() {
  const storeTarget = useFpsTarget((s) => s.target)
  const clearStoreTarget = useFpsTarget((s) => s.clear)
  const source = useFpsTarget((s) => s.source)
  const setSource = useFpsTarget((s) => s.setSource)
  // (правка 587) Отзыв предыдущего blob:-URL при любой замене/удалении
  // источника: URL.createObjectURL(file) утекал при каждом «убрать»/дропе
  // (паттерн refine-view, правка 345). Серверные /api-URL не трогаем.
  const prevSourceUrlRef = useRef<string | null>(null)
  const setSourceSafe = useCallback(
    (next: FpsSource | null) => {
      const prev = prevSourceUrlRef.current
      if (prev && prev.startsWith('blob:') && prev !== next?.url) {
        try { URL.revokeObjectURL(prev) } catch { /* уже отозван */ }
      }
      prevSourceUrlRef.current = next?.url ?? null
      setSource(next)
    },
    [setSource],
  )
  const sourceRef = useRef<FpsSource | null>(null)
  sourceRef.current = source

  const params = useFpsTarget((s) => s.params)
  const patchParams = useFpsTarget((s) => s.patchParams)

  const [dragOver, setDragOver] = useState(false)
  const [uploadingSrc, setUploadingSrc] = useState(false)
  // (правка 276) «Дополнительные параметры» — свёрнуты по умолчанию
  const [showAdvanced, setShowAdvanced] = useState(false)
  // (правка 554) Джоб-состояние — в модульном сторе (fps-job-store), НЕ в
  // useState: смена вкладки размонтирует FpsView, а задача в ComfyUI
  // продолжает идти. Раньше поллинг умирал вместе с компонентом, статус
  // сбрасывался, кнопка снова становилась активной (второй клик = вторая
  // задача), результат не появлялся до ручной перезагрузки. Поллинг в сторе
  // переживает unmount; задача видна в общей очереди (QueueIndicator).
  const busy = useFpsJob((s) => s.busy)
  const phase = useFpsJob((s) => s.phase)
  const progress = useFpsJob((s) => s.progress)
  const error = useFpsJob((s) => s.error)
  const promptId = useFpsJob((s) => s.promptId)
  const startedAt = useFpsJob((s) => s.startedAt)
  const submitJob = useFpsJob((s) => s.submit)
  const cancelJob = useFpsJob((s) => s.cancel)
  const resetJob = useFpsJob((s) => s.reset)

  const gallery = useVideoGallery()

  // Цель из стора галереи
  useEffect(() => {
    if (!storeTarget) return
    const file = gallery.files.find(
      (f) => f.filename === storeTarget.filename && f.subfolder === storeTarget.subfolder,
    )
    if (file) {
      setSourceSafe(file as FpsSource)
      toast.success(`Источник: ${file.filename}`)
    } else {
      setSourceSafe({
        url: `/api/comfy/file?filename=${encodeURIComponent(storeTarget.filename)}&subfolder=${encodeURIComponent(storeTarget.subfolder)}`,
        filename: storeTarget.filename,
        subfolder: storeTarget.subfolder,
      })
    }
    clearStoreTarget()
  }, [storeTarget, gallery.files, clearStoreTarget, setSourceSafe])

  // (правка 274) Клик-выбор файла: <input type='file'> + ref
  const fileInputRef = useRef<HTMLInputElement>(null)
  const VIDEO_EXTS = '.mp4,.m4v,.mov,.mkv,.avi,.webm,.m2ts,.mts,.mxf,.vob,.wmv,.flv,.mpg,.mpeg,.ogv'

  const uploadLocalFile = useCallback(async (file: File) => {
    setUploadingSrc(true)
    try {
      const { path } = await uploadInputFile(file)
      setSourceSafe({
        url: URL.createObjectURL(file),
        filename: file.name,
        subfolder: '',
        inputSource: path,
      })
      toast.success(`Источник: ${file.name}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка загрузки видео')
    } finally {
      setUploadingSrc(false)
    }
  }, [setSourceSafe])

  // (правка 554) Поллинг статуса/прогресса жил здесь в useEffect — и умирал
  // вместе с компонентом при смене вкладки. Теперь он в модуле fps-job-store
  // и переживает unmount (паттерн tile-upscale/controlnet).

  const start = useCallback(async () => {
    const src = sourceRef.current
    if (!src) {
      toast.error('Сначала выберите видео-источник')
      return
    }
    if (uploadingSrc) {
      toast.error('Видео ещё загружается')
      return
    }

    const body: Record<string, unknown> = {
      ...(src.inputSource
        ? { inputSource: src.inputSource }
        : { sourceFilename: src.filename, sourceSubfolder: src.subfolder ?? '' }),
      mode: params.mode,
      multiplier: params.multiplier,
      // (правка 269) Модели RIFE/FILM зафиксированы в fps-template.ts.
      rifeBatchSize: params.rifeBatchSize,
      rifeScale: params.rifeScale,
      rifeDtype: params.rifeDtype,
      rifeFastMode: params.rifeFastMode,
      rifeEnsemble: params.rifeEnsemble,
      clearCacheAfterNFrames: params.clearCacheAfterNFrames,
    }
    // (правка 554) Сабмит/поллинг/статусы — в fps-job-store.
    await submitJob(body)
  }, [uploadingSrc, params, submitJob])

  const cancel = useCallback(async () => {
    // (правка 554) Отмена — в сторе: эпоха отмены, cancelRequestedFor,
    // пометка элемента очереди. Старая версия просто слала /api/comfy/cancel
    // без подтверждения — и осознанная отмена рисовалась как «Ошибка».
    await cancelJob()
  }, [cancelJob])

  const reset = useCallback(() => {
    resetJob()
  }, [resetJob])

  const srcThumb = (f: FpsSource) =>
    f.url.includes('?') ? `${f.url}&width=320` : `${f.url}?width=320`

  const dropHandler = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const raw = e.dataTransfer.getData(H3_VIDEO_DND_MIME)
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { filename?: string; subfolder?: string }
        setSourceSafe({
          url: `/api/comfy/file?filename=${encodeURIComponent(parsed.filename ?? '')}&subfolder=${encodeURIComponent(parsed.subfolder ?? '')}`,
          filename: parsed.filename ?? '',
          subfolder: parsed.subfolder ?? '',
        })
        toast.success(`Источник: ${parsed.filename}`)
      } catch { toast.error('Не удалось прочитать перетащенное видео') }
      return
    }
    const f = e.dataTransfer.files?.[0]
    if (f) void uploadLocalFile(f)
    else toast.error('Нужно видео')
  }

  const isRife = params.mode === 'rife'

  return (
    <div className="flex h-full w-full min-w-0">
      {/* ═══ Панель параметров ═══ */}
      <aside className="w-[360px] shrink-0 border-r border-border bg-[var(--surface-1)] flex flex-col">
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div className="flex items-center gap-2">
            <GaugeIcon className="w-4 h-4 text-cyan-400" />
            <h2
              className="text-sm font-semibold text-foreground"
              title="Повышение плавности: между кадрами видео вставляются промежуточные. Скорость воспроизведения и звук не меняются."
            >
              FPS
            </h2>
          </div>

          {/* Источник */}
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground font-medium">Источник</Label>
            {source ? (
              <div
                onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
                onDragLeave={() => setDragOver(false)}
                onDrop={dropHandler}
                className={cn(
                  'flex items-center gap-3 rounded-lg border bg-[var(--surface-2)] p-2 transition-all',
                  dragOver ? 'border-cyan-400 ring-1 ring-cyan-400/50' : 'border-border',
                )}
              >
                {/* (правка 463) Превью: src — САМО видео (source.url), а не
                    srcThumb(...): URL с &width=320 отдаёт JPEG-постер, и <video>
                    показывал чёрный квадрат. JPEG-постер уходит в poster=
                    (мгновенная отрисовка), первый кадр — через preload="metadata"
                    + muted (WebView2). У blob:-URL (файл с диска) постера нет.
                    (правка 719) Клик — просмотр во весь экран. */}
                <RefPreviewThumb
                  kind="video"
                  name={source.filename}
                  url={source.url}
                  className="w-20 h-12 rounded object-cover bg-black shrink-0"
                  title="Открыть исходное видео во весь экран"
                >
                  <video
                    src={source.url}
                    poster={source.url.startsWith('blob:') ? undefined : srcThumb(source)}
                    preload="metadata"
                    muted
                    playsInline
                    className="w-full h-full object-cover"
                  />
                </RefPreviewThumb>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-foreground truncate">{source.filename}</p>
                  {uploadingSrc && <p className="text-[10px] text-cyan-400">загрузка…</p>}
                </div>
                {!busy && (
                  <button onClick={() => setSourceSafe(null)}
                    className="text-[10px] text-muted-foreground hover:text-foreground shrink-0">
                    убрать
                  </button>
                )}
              </div>
            ) : (
              <div
                onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
                onDragLeave={() => setDragOver(false)}
                onDrop={dropHandler}
                // (правка 274) Клик по полю — выбор файла с диска
                onClick={() => fileInputRef.current?.click()}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInputRef.current?.click() } }}
                className={cn(
                  'flex items-center gap-2 rounded-lg border border-dashed p-3 text-xs text-muted-foreground transition-all cursor-pointer',
                  dragOver ? 'border-cyan-400 bg-cyan-500/10' : 'border-border hover:border-cyan-500/40 hover:bg-[var(--surface-2)]',
                )}
              >
                <FileVideoIcon className="w-4 h-4 shrink-0" />
                <span>Кликните для выбора, перетащите карточку из галереи или файл с диска</span>
              </div>
            )}
            {/* (правка 274) Скрытый input — клик-выбор видео с диска */}
            <input
              ref={fileInputRef}
              type="file"
              accept={VIDEO_EXTS}
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void uploadLocalFile(f)
                e.target.value = ''
              }}
            />
          </div>

          {/* Выбор режима */}
          <div className="space-y-2">
            {/* (правка 464) Стили панели под эталон «Генерация»: Label
                text-xs text-muted-foreground font-medium, сырые <select>
                заменены на общий Select, segmented-кнопки — h-8 rounded-md
                grid-cols-N gap-1.5 с активной bg-cyan-500/15. */}
            <Label className="text-xs text-muted-foreground font-medium">Режим</Label>
            <div className="grid grid-cols-2 gap-2">
              {MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => patchParams({ mode: m.id })}
                  disabled={busy}
                  className={cn(
                    'rounded-lg border px-3 py-2 text-left transition-colors',
                    params.mode === m.id
                      ? 'border-cyan-500/60 bg-cyan-500/10'
                      : 'border-input bg-[var(--surface-2)]/50 hover:bg-accent/50',
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    <m.icon className="w-3.5 h-3.5 text-cyan-400" />
                    <span className="text-xs font-medium text-foreground">{m.label}</span>
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-0.5">{m.hint}</p>
                </button>
              ))}
            </div>
          </div>

          {/* Множитель FPS */}
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground font-medium">
              Множитель FPS
              <span className="ml-1 text-[10px] text-muted-foreground">(24 → {24 * params.multiplier} fps)</span>
            </Label>
            <div className="grid grid-cols-3 gap-1.5">
              {[2, 3, 4].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => patchParams({ multiplier: n })}
                  disabled={busy}
                  className={cn(
                    'h-8 rounded-md border text-xs font-medium transition-all',
                    params.multiplier === n
                      ? 'bg-cyan-500/15 border-cyan-500/50 text-cyan-300'
                      : 'bg-[var(--surface-2)] border-border text-muted-foreground hover:border-cyan-500/30',
                    busy && 'opacity-50 cursor-not-allowed',
                  )}
                >
                  ×{n}
                </button>
              ))}
            </div>
          </div>

          {/* (правка 276) Дополнительные параметры: RIFE batch/scale/dtype/
              fast/ensemble + Анти-OOM — свёрнуты по умолчанию (паттерн
              из tile-upscale-view, правка 270). Основные (источник, режим,
              множитель) остаются выше. */}
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="w-full flex items-center justify-between px-3 py-2 rounded-lg bg-[var(--surface-2)] border border-border hover:border-cyan-500/30 transition-all text-left"
            >
              <span className="text-xs font-medium text-muted-foreground">Дополнительные параметры</span>
              <span className={cn('text-[10px] text-muted-foreground transition-transform', showAdvanced && 'rotate-180')}>▼</span>
            </button>

            {showAdvanced && (
              <div className="space-y-3 pl-1">
                {/* RIFE параметры (только в режиме RIFE) */}
                {isRife && (
                  <>
                    {/* (правка 269) Модель RIFE зафиксирована (rife49.pth) —
                        скачивается в Настройках → Модели. Селект убран. */}
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Batch (VRAM)</Label>
                      <Select
                        value={String(params.rifeBatchSize)}
                        onValueChange={(v) => patchParams({ rifeBatchSize: parseInt(v, 10) })}
                        disabled={busy}
                      >
                        <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="bg-[var(--surface-3)] border-border">
                          {[1, 2, 4, 8, 16].map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">Scale (качество)</Label>
                        <Select
                          value={String(params.rifeScale)}
                          onValueChange={(v) => patchParams({ rifeScale: parseFloat(v) })}
                          disabled={busy}
                        >
                          <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent className="bg-[var(--surface-3)] border-border">
                            <SelectItem value="0.25">0.25 (быстрее, меньше VRAM)</SelectItem>
                            <SelectItem value="0.5">0.5 (сбалансировано)</SelectItem>
                            <SelectItem value="1">1.0 (качество)</SelectItem>
                            <SelectItem value="2">2.0 (эксперимент)</SelectItem>
                            <SelectItem value="4">4.0 (эксперимент)</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">Dtype</Label>
                        <Select
                          value={params.rifeDtype}
                          onValueChange={(v) => patchParams({ rifeDtype: v })}
                          disabled={busy}
                        >
                          <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent className="bg-[var(--surface-3)] border-border">
                            <SelectItem value="float16">float16 (экономия VRAM)</SelectItem>
                            <SelectItem value="bfloat16">bfloat16</SelectItem>
                            <SelectItem value="float32">float32 (качество)</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <label className="flex items-center gap-2 text-xs text-foreground">
                        <input
                          type="checkbox"
                          checked={params.rifeFastMode}
                          onChange={(e) => patchParams({ rifeFastMode: e.target.checked })}
                          disabled={busy}
                          className="h-3.5 w-3.5 rounded border-border bg-[var(--surface-2)]"
                        />
                        Fast mode
                      </label>
                      <label className="flex items-center gap-2 text-xs text-foreground">
                        <input
                          type="checkbox"
                          checked={params.rifeEnsemble}
                          onChange={(e) => patchParams({ rifeEnsemble: e.target.checked })}
                          disabled={busy}
                          className="h-3.5 w-3.5 rounded border-border bg-[var(--surface-2)]"
                        />
                        Ensemble
                      </label>
                    </div>
                  </>
                )}

                {/* (правка 269) FILM — одна модель (film_net_fp32.pt), зафиксирована.
                    Скачивается в Настройках → Модели. Селект убран. */}

                {/* Анти-OOM (общий для обоих режимов) */}
                <div className="space-y-1">
                  <Label
                    className="text-xs text-muted-foreground"
                    title="Как часто очищать видеопамять во время обработки. Меньше значение — меньше шанс нехватки памяти, но медленнее."
                  >
                    Анти-OOM (кадров между очисткой кэша)
                  </Label>
                  <Select
                    value={String(params.clearCacheAfterNFrames)}
                    onValueChange={(v) => patchParams({ clearCacheAfterNFrames: parseInt(v, 10) })}
                    disabled={busy}
                  >
                    <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-[var(--surface-3)] border-border">
                      {[2, 4, 8, 16, 32].map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}
          </div>

          {/* Запуск */}
          <div className="flex gap-2 pt-1">
            <Button onClick={start} disabled={!source || busy} className="flex-1 gap-1.5">
              {busy ? <Loader2Icon className="w-4 h-4 animate-spin" /> : <PlayIcon className="w-4 h-4" />}
              {busy ? 'Выполняется…' : 'Запустить FPS'}
            </Button>
          </div>

        </div>

        {/* Статус */}
        {/* (правка 475) панель статуса/превью — surface-1, в цвет панели настроек */}
        <div className="shrink-0 border-t border-border p-3 bg-[var(--surface-1)]/90 backdrop-blur-sm">
          <GenerationStatus
            isGenerating={busy}
            phase={phase}
            progressPercent={progress}
            statusMessage={null}
            error={error}
            onInterrupt={cancel}
            onReset={reset}
            startedAt={startedAt}
            promptId={promptId}
            stageKind="single"
          />
        </div>
      </aside>

      {/* ═══ Галерея ═══ */}
      <section className="flex-1 min-w-0 flex flex-col overflow-hidden">
        <div className="flex-1 min-h-0 overflow-y-auto p-3">
          <VideoGalleryGrid
            files={gallery.files}
            loading={gallery.loading}
            onRefresh={() => void gallery.load()}
            onDeleteFile={gallery.deleteFile}
            emptyHint="Результаты FPS появятся здесь"
          />
        </div>
      </section>
    </div>
  )
}
