'use client'

/**
 * FaceRefineView — вкладка «Face Refine»: перерисовка мелких лиц в готовом
 * видео через набор нод ComfyUI-H3-FaceRefine (детект → кроп → H3 → вклейка
 * обратно).
 *
 * Layout как у Tile Upscale: слева — параметры + статус, справа — галерея.
 * Источник: drag&drop из галереи или файл с диска.
 *
 * «Кого именно перерисовывать» — три способа:
 *  • правило + номер в рейтинге (largest_face / centre_most / left_most …);
 *  • (правка 723) клик по лицу в превью исходника (closest_to_xy) — правило
 *    смотрит только на геометрию кадра и в толпе упирается в одно лицо;
 *  • референс-фото человека (identity_reference) — трекер находит его в
 *    каждом шоте по совпадению лица (insightface).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ScanFaceIcon,
  CrosshairIcon,
  PlayIcon,
  FileVideoIcon,
  ImageIcon,
  Loader2Icon,
  XIcon,
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
import { SettingSlider } from '@/components/h3/setting-slider'
import { VideoGalleryGrid, H3_VIDEO_DND_MIME } from '@/components/h3/video-gallery-grid'
import { GenerationStatus } from '@/components/h3/generation-status'
import { RefPreviewThumb } from '@/components/h3/ref-preview-thumb'
import { FacePickDialog } from '@/components/h3/face-pick-dialog'
import { useVideoGallery } from '@/components/h3/use-video-gallery'
import {
  useFaceRefineTarget,
  type FaceRefineSource,
} from '@/lib/face-refine-target-store'
import { useFaceRefineJob } from '@/lib/face-refine-job-store'
import { uploadInputFile } from '@/lib/upload'
import type { FaceSelectMode } from '@/lib/comfy/face-refine-template'

const SELECT_MODES: Array<{ value: FaceSelectMode; label: string }> = [
  { value: 'largest_face', label: 'Самое крупное лицо' },
  { value: 'centre_most', label: 'Ближе к центру кадра' },
  { value: 'left_most', label: 'Самое левое' },
  { value: 'right_most', label: 'Самое правое' },
  { value: 'top_most', label: 'Самое верхнее' },
  { value: 'bottom_most', label: 'Самое нижнее' },
  { value: 'smallest_face', label: 'Самое мелкое лицо' },
  { value: 'detector_score', label: 'Самое уверенное' },
  // (правка 723) Ставится кликом по кадру в окне выбора лица.
  { value: 'closest_to_xy', label: 'Точка на лице (клик по кадру)' },
]

export function FaceRefineView() {
  const storeTarget = useFaceRefineTarget((s) => s.target)
  const clearStoreTarget = useFaceRefineTarget((s) => s.clear)
  const source = useFaceRefineTarget((s) => s.source)
  const setSource = useFaceRefineTarget((s) => s.setSource)
  const identityRef = useFaceRefineTarget((s) => s.identityRef)
  const setIdentityRef = useFaceRefineTarget((s) => s.setIdentityRef)
  // (правка 723) Точка на лице, указанная кликом по кадру.
  const facePoint = useFaceRefineTarget((s) => s.facePoint)
  const setFacePoint = useFaceRefineTarget((s) => s.setFacePoint)
  const params = useFaceRefineTarget((s) => s.params)
  const patchParams = useFaceRefineTarget((s) => s.patchParams)

  const prevSourceUrlRef = useRef<string | null>(null)
  const setSourceSafe = useCallback(
    (next: FaceRefineSource | null) => {
      const prev = prevSourceUrlRef.current
      if (prev && prev.startsWith('blob:') && prev !== next?.url) {
        try { URL.revokeObjectURL(prev) } catch { /* уже отозван */ }
      }
      prevSourceUrlRef.current = next?.url ?? null
      setSource(next)
      // (правка 723) Точка клика — координаты конкретного ролика: сменили
      // исходник, значит и лицо выбираем заново.
      setFacePoint(null)
    },
    [setSource, setFacePoint],
  )
  const sourceRef = useRef<FaceRefineSource | null>(null)
  sourceRef.current = source

  const [prompt, setPrompt] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [uploadingSrc, setUploadingSrc] = useState(false)
  const [uploadingRef, setUploadingRef] = useState(false)
  // (правка 722) Есть ли в комбо H3FaceTrackCrop детектор человека.
  const [fallbackAvailable, setFallbackAvailable] = useState<boolean | null>(null)
  // (правка 723) Размер/fps исходника (ffprobe через GET) и окно выбора лица.
  const [srcProbe, setSrcProbe] = useState<{ fps: number; frames: number } | null>(null)
  const [pickOpen, setPickOpen] = useState(false)

  const busy = useFaceRefineJob((s) => s.busy)
  const phase = useFaceRefineJob((s) => s.phase)
  const progress = useFaceRefineJob((s) => s.progress)
  const error = useFaceRefineJob((s) => s.error)
  const promptId = useFaceRefineJob((s) => s.promptId)
  const startedAt = useFaceRefineJob((s) => s.startedAt)
  const jobSubmit = useFaceRefineJob((s) => s.submit)
  const jobCancel = useFaceRefineJob((s) => s.cancel)
  const jobReset = useFaceRefineJob((s) => s.reset)

  const gallery = useVideoGallery()

  // (правка 722) Список детекторов спрашиваем у бэкенда: модель человека
  // появляется в комбо только после регистрации models/ultralytics и
  // перезапуска ComfyUI. Перепроверяем после каждого прогона.
  // (правка 723) Тем же запросом берём fps/frames исходника: элемент <video>
  // кадров не отдаёт, а ноде нужен номер кадра клика.
  useEffect(() => {
    let alive = true
    const q = new URLSearchParams()
    if (source?.inputSource) {
      q.set('input', source.inputSource)
    } else if (source) {
      q.set('filename', source.filename)
      q.set('subfolder', source.subfolder ?? '')
    }
    const qs = q.toString()
    void fetch(`/api/comfy/face-refine${qs ? `?${qs}` : ''}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: {
        fallbackDetector?: string | null
        probe?: { fps?: number; frames?: number } | null
      } | null) => {
        if (!alive) return
        setFallbackAvailable(Boolean(d?.fallbackDetector))
        setSrcProbe(d?.probe ? { fps: d.probe.fps ?? 24, frames: d.probe.frames ?? 0 } : null)
      })
      .catch(() => {
        if (alive) {
          setFallbackAvailable(false)
          setSrcProbe(null)
        }
      })
    return () => { alive = false }
  }, [busy, source])

  // Цель из стора галереи
  useEffect(() => {
    if (!storeTarget) return
    const file = gallery.files.find(
      (f) => f.filename === storeTarget.filename && f.subfolder === storeTarget.subfolder,
    )
    if (file) {
      setSourceSafe(file as FaceRefineSource)
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

  const fileInputRef = useRef<HTMLInputElement>(null)
  const refInputRef = useRef<HTMLInputElement>(null)
  const VIDEO_EXTS = '.mp4,.m4v,.mov,.mkv,.avi,.webm,.m2ts,.mts,.mxf,.vob,.wmv,.flv,.mpg,.mpeg,.ogv'
  const IMAGE_EXTS = '.png,.jpg,.jpeg,.webp,.bmp'

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

  // Референс лица — отдельная картинка в ComfyUI input/.
  // (правка 723) Фото и точка клика взаимоисключающие: нода при подключённом
  // identity_reference не смотрит на X/Y, поэтому загрузка фото снимает точку.
  const uploadIdentityRef = useCallback(async (file: File) => {
    setUploadingRef(true)
    try {
      const { path } = await uploadInputFile(file)
      setIdentityRef({
        name: path,
        previewUrl: URL.createObjectURL(file),
      })
      if (facePoint) {
        setFacePoint(null)
        patchParams({ select: 'largest_face' })
        toast.success('Референс лица загружен — точка на кадре снята')
      } else {
        toast.success('Референс лица загружен')
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка загрузки референса')
    } finally {
      setUploadingRef(false)
    }
  }, [setIdentityRef, facePoint, setFacePoint, patchParams])

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
      canvas: params.canvas,
      denoise: params.denoise,
      steps: params.steps,
      // (правка 723) Без точки closest_to_xy мерить нечем — уходит правило.
      select: params.select === 'closest_to_xy' && !facePoint ? 'largest_face' : params.select,
      selectIndex: params.selectIndex,
      identityModel: params.identityModel,
      identityTrack: params.identityTrack,
      cropFactor: params.cropFactor,
      confidence: params.confidence,
      pasteRegion: params.pasteRegion,
      feather: params.feather,
      colourMatch: params.colourMatch,
      blend: params.blend,
      undetectedFrames: params.undetectedFrames,
      denoiseSmall: params.denoiseSmall,
      denoiseLarge: params.denoiseLarge,
      // (правка 722) детектор человека — только если он реально есть в списке
      // комбо ComfyUI (иначе сервер молча оставит 'none').
      fallback: params.fallback && fallbackAvailable === true,
      // (правка 723) Клик по лицу: бэкенд переводит выбор в closest_to_xy.
      ...(facePoint ? { facePoint } : {}),
      ...(identityRef ? { identityReference: identityRef.name } : {}),
    }
    await jobSubmit(body)
  }, [
    prompt,
    uploadingSrc,
    params,
    identityRef,
    jobSubmit,
    fallbackAvailable,
    facePoint,
  ])

  const cancel = useCallback(() => { void jobCancel() }, [jobCancel])
  const reset = useCallback(() => { jobReset() }, [jobReset])

  const srcThumb = (f: FaceRefineSource) =>
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

  const identityPreview = identityRef
    ? `/api/comfy/file?filename=${encodeURIComponent(identityRef.name)}&subfolder=&type=input&width=96`
    : null

  return (
    <div className="flex h-full w-full min-w-0">
      {/* ═══ Панель параметров ═══ */}
      <aside className="w-[360px] shrink-0 border-r border-border bg-[var(--surface-1)] flex flex-col">
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div className="flex items-center gap-2">
            <ScanFaceIcon className="w-4 h-4 text-yellow-400" />
            <h2 className="text-sm font-semibold text-foreground">Face Refine</h2>
          </div>

          <p className="text-[11px] text-muted-foreground leading-relaxed">
            H3 плохо рисует лица, когда голова занимает малую долю кадра. Нода
            находит лицо, перерисовывает его крупно и вклеивает обратно — остальной
            кадр остаётся исходным.
          </p>

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
                  dragOver ? 'border-yellow-400 ring-1 ring-yellow-400/50' : 'border-border',
                )}
              >
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
                  {uploadingSrc && <p className="text-[10px] text-yellow-400">загрузка…</p>}
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
                onClick={() => fileInputRef.current?.click()}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInputRef.current?.click() } }}
                className={cn(
                  'flex items-center gap-2 rounded-lg border border-dashed p-3 text-xs text-muted-foreground transition-all cursor-pointer',
                  dragOver ? 'border-yellow-400 bg-yellow-500/10' : 'border-border hover:border-yellow-500/40 hover:bg-[var(--surface-2)]',
                )}
              >
                <FileVideoIcon className="w-4 h-4 shrink-0" />
                <span>Кликните для выбора, перетащите карточку из галереи или файл с диска</span>
              </div>
            )}
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

          {/* Кого перерисовывать */}
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground font-medium">Кого перерисовывать</Label>

            {/* (правка 723) Клик по лицу: правило видит только геометрию кадра и
                в толпе упирается в одно и то же лицо. Точка задаёт цель напрямую. */}
            {facePoint ? (
              <div className="flex items-center gap-2 rounded-lg border border-yellow-500/40 bg-yellow-500/10 p-2">
                <CrosshairIcon className="w-4 h-4 text-yellow-400 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-foreground">Лицо выбрано кликом</p>
                  <p className="text-[10px] text-muted-foreground font-mono">
                    X {facePoint.x} · Y {facePoint.y} · кадр {facePoint.frame}
                  </p>
                </div>
                {!busy && (
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      onClick={() => setPickOpen(true)}
                      className="text-[10px] text-yellow-400 hover:text-yellow-300"
                    >
                      изменить
                    </button>
                    <button
                      onClick={() => {
                        setFacePoint(null)
                        patchParams({ select: 'largest_face' })
                      }}
                      className="text-muted-foreground hover:text-foreground"
                      title="Сбросить точку и вернуться к правилу"
                    >
                      <XIcon className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setPickOpen(true)}
                disabled={!source || busy}
                className="w-full flex items-center justify-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground hover:border-yellow-500/40 hover:bg-[var(--surface-2)] transition-all disabled:opacity-50"
                title="Открыть кадр исходника и кликнуть по нужному лицу"
              >
                <CrosshairIcon className="w-3.5 h-3.5" />
                Указать лицо кликом по кадру
              </button>
            )}

            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground" title="Правило выбора субъекта. Он выбирается ОДИН раз на шот, дальше трекер ведёт то же лицо.">
                Правило
              </Label>
              <Select
                value={params.select === 'closest_to_xy' && !facePoint ? 'largest_face' : params.select}
                onValueChange={(v) => {
                  const mode = v as FaceSelectMode
                  patchParams({ select: mode })
                  // (правка 723) Точка и правило взаимоисключающие.
                  if (mode !== 'closest_to_xy') setFacePoint(null)
                  else if (!facePoint) setPickOpen(true)
                }}
                disabled={busy}
              >
                <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-[var(--surface-3)] border-border">
                  {SELECT_MODES.map((m) => (
                    <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground" title="Номер лица в рейтинге правила: 0 — первое, 1 — второе и так далее. При выборе кликом не используется.">
                Номер в рейтинге
              </Label>
              <Select
                value={String(params.selectIndex)}
                onValueChange={(v) => patchParams({ selectIndex: parseInt(v, 10) })}
                disabled={busy || Boolean(facePoint)}
              >
                <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-[var(--surface-3)] border-border">
                  {[0, 1, 2, 3].map((n) => (
                    <SelectItem key={n} value={String(n)}>{n + 1}-е лицо</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Референс конкретного человека — надёжнее правила: трекер
                находит его в каждом шоте, даже если нумерация сбилась. */}
            <div className="space-y-1">
              <Label
                className="text-xs text-muted-foreground"
                title="Фото конкретного человека. Трекер сопоставляет лица по эмбеддингу (insightface) и ведёт этого человека через весь ролик. Требует buffalo_l и пакет insightface."
              >
                Референс конкретного человека (необязательно)
              </Label>
              {identityRef ? (
                <div className={cn(
                  'flex items-center gap-2 rounded-lg border border-border bg-[var(--surface-2)] p-2',
                  // (правка 723) С точкой клика фото в воркфлоу не идёт.
                  facePoint && 'opacity-60',
                )}>
                  {identityPreview && (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img
                      src={identityPreview}
                      alt=""
                      className="w-10 h-10 rounded object-cover border shrink-0"
                    />
                  )}
                  <p className="text-xs font-medium text-foreground truncate flex-1">{identityRef.name}</p>
                  {!busy && (
                    <button
                      onClick={() => setIdentityRef(null)}
                      className="text-muted-foreground hover:text-foreground shrink-0"
                    >
                      <XIcon className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => refInputRef.current?.click()}
                  disabled={busy}
                  className="w-full flex items-center justify-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground hover:border-yellow-500/40 hover:bg-[var(--surface-2)] transition-all disabled:opacity-50"
                >
                  {uploadingRef
                    ? <Loader2Icon className="w-3.5 h-3.5 animate-spin" />
                    : <ImageIcon className="w-3.5 h-3.5" />}
                  Загрузить фото человека
                </button>
              )}
              <input
                ref={refInputRef}
                type="file"
                accept={IMAGE_EXTS}
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) void uploadIdentityRef(f)
                  e.target.value = ''
                }}
              />
              {/* (правка 723) Пока лицо указано кликом, трекер выбирает его
                  геометрией, а не по фото — предупреждаем, чтобы не гадать,
                  почему фото «не сработало». */}
              {facePoint && identityRef && (
                <p className="text-[10px] text-yellow-400/90 leading-snug">
                  Не используется: лицо выбрано кликом, трекер берёт его с точки.
                  Уберите точку (✕ в карточке) или загрузите фото заново, чтобы
                  искать человека по лицу.
                </p>
              )}
            </div>
          </div>

          {/* Параметры пайплайна */}
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label
                className="text-xs text-muted-foreground"
                title="Канва, в которой H3 перерисовывает лицо. 512 дешевле 768 примерно в 2.25 раза по latent-токенам; выше 768 — заметно дороже по VRAM и времени (максимум движка — 1344)."
              >
                Канва (px)
              </Label>
              <Select
                value={String(params.canvas)}
                onValueChange={(v) => patchParams({ canvas: parseInt(v, 10) })}
                disabled={busy}
              >
                <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-[var(--surface-3)] border-border">
                  {[384, 512, 640, 768, 896, 1024, 1152, 1280].map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n}{n > 768 ? ' — выше эталона' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground" title="Шаги сэмплирования. Наша модель 4-шаговая — столько и нужно.">
                Шаги
              </Label>
              <Select
                value={String(params.steps)}
                onValueChange={(v) => patchParams({ steps: parseInt(v, 10) })}
                disabled={busy}
              >
                <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-[var(--surface-3)] border-border">
                  {[2, 3, 4, 6, 8].map((n) => (
                    <SelectItem key={n} value={String(n)}>{n}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <SettingSlider
            label="Денойз"
            labelTitle="Насколько сильно модель перерисовывает лицо. H3 — flow matching со сдвигом 12: 0.25 даёт эффективную sigma 0.800 (кадр переписывается целиком). Рабочий диапазон 0.25–0.40."
            value={params.denoise}
            min={0.05}
            max={0.6}
            step={0.05}
            onChange={(v) => patchParams({ denoise: v })}
            formatValue={(v) => v.toFixed(2)}
            disabled={busy}
          />

          {/* Дополнительные параметры */}
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="w-full flex items-center justify-between px-3 py-2 rounded-lg bg-[var(--surface-2)] border border-border hover:border-yellow-500/30 transition-all text-left"
            >
              <span className="text-xs font-medium text-muted-foreground">Дополнительные параметры</span>
              <span className={cn('text-[10px] text-muted-foreground transition-transform', showAdvanced && 'rotate-180')}>▼</span>
            </button>

            {showAdvanced && (
              <div className="space-y-3 pl-1">
                <SettingSlider
                  label="Кроп лица (×)"
                  labelTitle="Сторона кропа как кратное высоты лица. 2.5 помещает лицо примерно в 40% холста. Больше — больше контекста, но меньше увеличение."
                  value={params.cropFactor}
                  min={1.2}
                  max={5}
                  step={0.1}
                  onChange={(v) => patchParams({ cropFactor: v })}
                  formatValue={(v) => v.toFixed(1)}
                  disabled={busy}
                />
                <SettingSlider
                  label="Порог детектора"
                  labelTitle="Ниже — ловит больше профилей и мелких лиц, но и больше ложных срабатываний."
                  value={params.confidence}
                  min={0.05}
                  max={0.9}
                  step={0.05}
                  onChange={(v) => patchParams({ confidence: v })}
                  formatValue={(v) => v.toFixed(2)}
                  disabled={busy}
                />
                <SettingSlider
                  label="Денойз: мелкие лица ×"
                  labelTitle="Множитель денойза для самых мелких лиц. Ниже 1.0 — весь ролик становится мягче."
                  value={params.denoiseSmall}
                  min={0}
                  max={1}
                  step={0.05}
                  onChange={(v) => patchParams({ denoiseSmall: v })}
                  formatValue={(v) => v.toFixed(2)}
                  disabled={busy}
                />
                <SettingSlider
                  label="Денойз: крупные лица ×"
                  labelTitle="Множитель денойза для крупных лиц — у них уже есть детали, их не нужно переписывать."
                  value={params.denoiseLarge}
                  min={0}
                  max={1}
                  step={0.05}
                  onChange={(v) => patchParams({ denoiseLarge: v })}
                  formatValue={(v) => v.toFixed(2)}
                  disabled={busy}
                />

                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground" title="Что вклеивается обратно: только прямоугольник лица или весь кроп (с волосами и фоном — может дать видимый прямоугольник).">
                    Вклейка
                  </Label>
                  <Select
                    value={params.pasteRegion}
                    onValueChange={(v) => patchParams({ pasteRegion: v as 'face_only' | 'face_ellipse' | 'full_crop' })}
                    disabled={busy}
                  >
                    <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-[var(--surface-3)] border-border">
                      <SelectItem value="face_only">Только лицо</SelectItem>
                      <SelectItem value="face_ellipse">Лицо овалом</SelectItem>
                      <SelectItem value="full_crop">Весь кроп</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground" title="Что делать с кадрами, где лицо не найдено (отвернулся, закрыт).">
                    Кадры без лица
                  </Label>
                  <Select
                    value={params.undetectedFrames}
                    onValueChange={(v) => patchParams({ undetectedFrames: v as 'fade_out' | 'skip' | 'composite_anyway' })}
                    disabled={busy}
                  >
                    <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-[var(--surface-3)] border-border">
                      <SelectItem value="fade_out">Плавно убрать вклейку</SelectItem>
                      <SelectItem value="skip">Оставить как есть</SelectItem>
                      <SelectItem value="composite_anyway">Вклеить всё равно</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* (правка 722) Детектор человека на кадрах, где лица не видно:
                    верх бокса человека даёт реальное положение головы. */}
                <label
                  className={cn(
                    'flex items-start gap-2 rounded-lg border border-border bg-[var(--surface-2)] p-2.5 transition-all',
                    fallbackAvailable === true && !busy
                      ? 'cursor-pointer hover:border-yellow-500/40'
                      : 'opacity-60',
                  )}
                >
                  <input
                    type="checkbox"
                    checked={params.fallback && fallbackAvailable === true}
                    onChange={(e) => patchParams({ fallback: e.target.checked })}
                    disabled={busy || fallbackAvailable !== true}
                    className="mt-0.5 accent-yellow-400"
                  />
                  <span className="space-y-0.5">
                    <span className="block text-xs font-medium text-foreground">
                      Далёкие планы: искать человека
                    </span>
                    <span className="block text-[10px] text-muted-foreground leading-relaxed">
                      {fallbackAvailable === true
                        ? 'Лица не видно (человек спиной, в капюшоне) — голова берётся от бокса человека. Без этого такие кадры интерполируются.'
                        : fallbackAvailable === null
                          ? 'Проверяю модели детекторов…'
                          : 'Нужна модель segm/person_yolov8m-seg.pt в models/ultralytics — после установки перезапустите студию.'}
                    </span>
                  </span>
                </label>

                <SettingSlider
                  label="Размытие края (px)"
                  labelTitle="Радиус размытия маски вклейки в пикселях исходника. Меньше — резче стык."
                  value={params.feather}
                  min={0}
                  max={40}
                  step={2}
                  onChange={(v) => patchParams({ feather: v })}
                  formatValue={(v) => String(v)}
                  disabled={busy}
                />
                <SettingSlider
                  label="Колор-матч"
                  labelTitle="Сведение среднего и отклонения перерисованного лица к исходному участку — без этого лицо выглядит вклеенным."
                  value={params.colourMatch}
                  min={0}
                  max={1}
                  step={0.05}
                  onChange={(v) => patchParams({ colourMatch: v })}
                  formatValue={(v) => v.toFixed(2)}
                  disabled={busy}
                />
                <SettingSlider
                  label="Прозрачность вклейки"
                  labelTitle="Общая непрозрачность перерисованного лица. Ниже 1.0 — смесь с исходником."
                  value={params.blend}
                  min={0}
                  max={1}
                  step={0.05}
                  onChange={(v) => patchParams({ blend: v })}
                  formatValue={(v) => v.toFixed(2)}
                  disabled={busy}
                />
              </div>
            )}
          </div>

          {/* Запуск */}
          <div className="flex gap-2 pt-1">
            <Button onClick={start} disabled={!source || busy} className="flex-1 gap-1.5">
              {busy ? <Loader2Icon className="w-4 h-4 animate-spin" /> : <PlayIcon className="w-4 h-4" />}
              {busy ? 'Выполняется…' : 'Запустить Face Refine'}
            </Button>
          </div>
        </div>

        {/* Статус */}
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
            emptyHint="Результаты Face Refine появятся здесь"
          />
        </div>
      </section>

      {/* (правка 723) Окно выбора лица кликом по кадру исходника. */}
      {source && (
        <FacePickDialog
          open={pickOpen}
          onOpenChange={(open) => {
            setPickOpen(open)
            // (правка 723) Закрыли окно, ничего не выбрав, — правило
            // closest_to_xy без точки мерить нечем, возвращаем дефолт.
            if (!open && !facePoint) patchParams({ select: 'largest_face' })
          }}
          url={source.url}
          filename={source.filename}
          fps={srcProbe?.fps ?? 24}
          frames={srcProbe?.frames ?? 0}
          point={facePoint}
          onPick={(p) => {
            setFacePoint(p)
            patchParams({ select: 'closest_to_xy' })
          }}
          onClear={() => {
            setFacePoint(null)
            patchParams({ select: 'largest_face' })
          }}
        />
      )}
    </div>
  )
}
