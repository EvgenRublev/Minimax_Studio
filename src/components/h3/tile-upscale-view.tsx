'use client'

/**
 * TileUpscaleView — вкладка «Tile Upscale»: tiled latent upscale готового видео
 * через MMH3UltimateUpscale (монолитная нода: temporal chunks → latent upscale →
 * spatial tiles → per-tile sampling → stitch).
 *
 * Layout как у Refine: слева — параметры + статус, справа — галерея.
 * Источник: drag&drop из галереи или файл с диска.
 *
 * (правка 319) Состояние джоба (promptId/phase/progress/error) и поллинг
 * /api/comfy/status вынесены в модульный tile-upscale-job-store — переживают
 * unmount вкладки и перезагрузку страницы. Обновление галереи — через
 * useGalleryRefresh.bump() из стора (staggered-reload встроен в useVideoGallery).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Grid3x3Icon,
  PlayIcon,
  FileVideoIcon,
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
} from '@/components/ui/select'
import { SettingSlider } from '@/components/h3/setting-slider' // (правка 461)
import { VideoGalleryGrid, H3_VIDEO_DND_MIME } from '@/components/h3/video-gallery-grid'
import { GenerationStatus } from '@/components/h3/generation-status'
// (правка 719) Превью с полноэкранным просмотром — как на «Генерации».
import { RefPreviewThumb } from '@/components/h3/ref-preview-thumb'
import { useVideoGallery } from '@/components/h3/use-video-gallery'
import { useTileUpscaleTarget, type TileUpscaleSource } from '@/lib/tile-upscale-target-store'
import { useTileUpscaleJob } from '@/lib/tile-upscale-job-store'
import { uploadInputFile } from '@/lib/upload'

export function TileUpscaleView() {
  const storeTarget = useTileUpscaleTarget((s) => s.target)
  const clearStoreTarget = useTileUpscaleTarget((s) => s.clear)
  const source = useTileUpscaleTarget((s) => s.source)
  const setSource = useTileUpscaleTarget((s) => s.setSource)
  // (правка 587) Отзыв предыдущего blob:-URL при замене/удалении источника
  // (паттерн refine-view, правка 345) — URL.createObjectURL утекал.
  const prevSourceUrlRef = useRef<string | null>(null)
  const setSourceSafe = useCallback(
    (next: TileUpscaleSource | null) => {
      const prev = prevSourceUrlRef.current
      if (prev && prev.startsWith('blob:') && prev !== next?.url) {
        try { URL.revokeObjectURL(prev) } catch { /* уже отозван */ }
      }
      prevSourceUrlRef.current = next?.url ?? null
      setSource(next)
    },
    [setSource],
  )
  const sourceRef = useRef<TileUpscaleSource | null>(null)
  sourceRef.current = source

  const params = useTileUpscaleTarget((s) => s.params)
  const patchParams = useTileUpscaleTarget((s) => s.patchParams)

  const [prompt, setPrompt] = useState('')
  // (правка 270) «Дополнительные параметры» — свёрнуты по умолчанию.
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [uploadingSrc, setUploadingSrc] = useState(false)
  // (правка 319) Состояние джоба — из модульного стора (переживает unmount).
  const busy = useTileUpscaleJob((s) => s.busy)
  const phase = useTileUpscaleJob((s) => s.phase)
  const progress = useTileUpscaleJob((s) => s.progress)
  const error = useTileUpscaleJob((s) => s.error)
  const promptId = useTileUpscaleJob((s) => s.promptId)
  const startedAt = useTileUpscaleJob((s) => s.startedAt)
  const jobSubmit = useTileUpscaleJob((s) => s.submit)
  const jobCancel = useTileUpscaleJob((s) => s.cancel)
  const jobReset = useTileUpscaleJob((s) => s.reset)

  const gallery = useVideoGallery()

  // Цель из стора галереи
  useEffect(() => {
    if (!storeTarget) return
    const file = gallery.files.find(
      (f) => f.filename === storeTarget.filename && f.subfolder === storeTarget.subfolder,
    )
    if (file) {
      setSourceSafe(file as TileUpscaleSource)
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

  useEffect(() => {
    setPrompt('')
  }, [source])

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

  // (правка 319) Поллинг и staggered-reload галереи вынесены в
  // tile-upscale-job-store (модульный, переживает unmount); обновление
  // галереи — через useGalleryRefresh.bump() по завершении джоба.

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
      prompt: prompt.trim() || undefined,
      seed: -1,
      tileSize: params.tileSize,
      overlap: params.overlap,
      fade: params.fade,
      chunkFrames: params.chunkFrames,
      temporalOverlap: params.temporalOverlap,
      anchorStrength: params.anchorStrength,
      targetResolution: params.targetResolution,
      denoise: params.denoise,
      steps: params.steps,
      syncTiles: params.syncTiles,
    }
    await jobSubmit(body)
  }, [prompt, uploadingSrc, params, jobSubmit])

  // (правка 319) Отмена/сброс — через стор (поллинг модульный).
  const cancel = useCallback(() => { void jobCancel() }, [jobCancel])
  const reset = useCallback(() => { jobReset() }, [jobReset])

  const srcThumb = (f: TileUpscaleSource) =>
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

  return (
    <div className="flex h-full w-full min-w-0">
      {/* ═══ Панель параметров ═══ */}
      <aside className="w-[360px] shrink-0 border-r border-border bg-[var(--surface-1)] flex flex-col">
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div className="flex items-center gap-2">
            <Grid3x3Icon className="w-4 h-4 text-pink-400" />
            <h2 className="text-sm font-semibold text-foreground">Tile Upscale</h2>
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
                  dragOver ? 'border-pink-400 ring-1 ring-pink-400/50' : 'border-border',
                )}
              >
                {/* (правка 460) Превью: src — САМО видео (source.url), а не
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
                  {uploadingSrc && <p className="text-[10px] text-pink-400">загрузка…</p>}
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
                  dragOver ? 'border-pink-400 bg-pink-500/10' : 'border-border hover:border-pink-500/40 hover:bg-[var(--surface-2)]',
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

          {/* (правка 270) Основные параметры: разрешение + шаги в одну
              строку, денойз ниже. Остальные (тайлы/overlap/temporal) —
              в «Дополнительные параметры» (паттерн из generate-view).
              (правка 462) Сырые <select> заменены на общий Select из
              @/components/ui/select (эталон вкладки «Генерация»). */}
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Разрешение</Label>
              <Select
                value={String(params.targetResolution)}
                onValueChange={(v) => patchParams({ targetResolution: parseInt(v, 10) })}
                disabled={busy}
              >
                <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-[var(--surface-3)] border-border">
                  {[720, 1080, 1440, 2160].map((n) => <SelectItem key={n} value={String(n)}>{n}p</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Шаги</Label>
              <Select
                value={String(params.steps)}
                onValueChange={(v) => patchParams({ steps: parseInt(v, 10) })}
                disabled={busy}
              >
                <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-[var(--surface-3)] border-border">
                  {[2, 3, 4, 5, 6, 8].map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* (правка 461) Сырой <input type="range"> заменён на общий
              SettingSlider (как во вкладке «Генерация»): значение — в
              formatValue, пояснение — в labelTitle-тултипе. */}
          <SettingSlider
            label="Денойз"
            labelTitle="Насколько сильно модель перерисовывает картинку при апскейле. Меньше — результат ближе к исходнику, больше — больше новых деталей."
            value={params.denoise}
            min={0.05}
            max={1}
            step={0.05}
            onChange={(v) => patchParams({ denoise: v })}
            formatValue={(v) => v.toFixed(2)}
            disabled={busy}
          />

          {/* (правка 270) Дополнительные параметры — тайлы, перекрытия, temporal. */}
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="w-full flex items-center justify-between px-3 py-2 rounded-lg bg-[var(--surface-2)] border border-border hover:border-pink-500/30 transition-all text-left"
            >
              <span className="text-xs font-medium text-muted-foreground">Дополнительные параметры</span>
              <span className={cn('text-[10px] text-muted-foreground transition-transform', showAdvanced && 'rotate-180')}>▼</span>
            </button>

            {showAdvanced && (
              <div className="space-y-3 pl-1">
                {/* (правка 481) SyncTile: per-step синхронизация тайлов.
                    В sync-режиме «Фейд» не используется (блендинг идёт после
                    каждого шага), «Перекрытие» задаёт геометрию рамп. */}
                <div className="space-y-1">
                  <Label
                    className="text-xs text-muted-foreground"
                    title="Тайлы согласуются после каждого шага сэмплирования (блендинг в общий канвас + общий шум) — убирает мерцание на стыках. Выключите для сравнения со старым режимом."
                  >
                    SyncTile (швы без мерцания)
                  </Label>
                  <Select
                    value={params.syncTiles ? 'on' : 'off'}
                    onValueChange={(v) => patchParams({ syncTiles: v === 'on' })}
                    disabled={busy}
                  >
                    <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-[var(--surface-3)] border-border">
                      <SelectItem value="on">Вкл (рекомендуется)</SelectItem>
                      <SelectItem value="off">Выкл (старый режим)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Тайл: размер задаёт пользователь, количество — авто */}
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label
                      className="text-xs text-muted-foreground"
                      title="Размер кусочков, на которые делится кадр при обработке. Сколько их понадобится — посчитается автоматически."
                    >
                      Тайл (px)
                    </Label>
                    <Select
                      value={String(params.tileSize)}
                      onValueChange={(v) => patchParams({ tileSize: parseInt(v, 10) })}
                      disabled={busy}
                    >
                      <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="bg-[var(--surface-3)] border-border">
                        {[512, 640, 768, 896, 1024].map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {/* Overlap + Fade */}
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Перекрытие (px)</Label>
                    <Select
                      value={String(params.overlap)}
                      onValueChange={(v) => patchParams({ overlap: parseInt(v, 10) })}
                      disabled={busy}
                    >
                      <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="bg-[var(--surface-3)] border-border">
                        {[64, 96, 128, 192, 256].map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Фейд (px)</Label>
                    <Select
                      value={String(params.fade)}
                      onValueChange={(v) => patchParams({ fade: parseInt(v, 10) })}
                      disabled={busy}
                    >
                      <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="bg-[var(--surface-3)] border-border">
                        {[32, 48, 64, 96, 128].map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {/* Temporal */}
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Кусок (кадры)</Label>
                    <Select
                      value={String(params.chunkFrames)}
                      onValueChange={(v) => patchParams({ chunkFrames: parseInt(v, 10) })}
                      disabled={busy}
                    >
                      <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="bg-[var(--surface-3)] border-border">
                        {[102, 136, 170, 204, 272].map((n) => <SelectItem key={n} value={String(n)}>{n} (~{Math.round(n/24*10)/10}с)</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Overlap (кадры)</Label>
                    <Select
                      value={String(params.temporalOverlap)}
                      onValueChange={(v) => patchParams({ temporalOverlap: parseInt(v, 10) })}
                      disabled={busy}
                    >
                      <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="bg-[var(--surface-3)] border-border">
                        {[17, 34, 51, 68].map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Запуск */}
          <div className="flex gap-2 pt-1">
            <Button onClick={start} disabled={!source} className="flex-1 gap-1.5">
              <PlayIcon className="w-4 h-4" />
              {busy ? 'Ещё в очередь' : 'Запустить Tile Upscale'}
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
            // (правка 478) свой вид стадии — метка «Tile Upscale», а не «Refine»
            stageKind="tile"
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
            emptyHint="Результаты Tile Upscale появятся здесь"
          />
        </div>
      </section>
    </div>
  )
}
