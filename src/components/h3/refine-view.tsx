'use client'

/**
 * RefineView — вкладка «Refine»: генеративный v2v-апскейл готового видео
 * (латентная схема Pass 2: VAEEncode исходника → LatentUpscaler3D →
 * короткий проход по сигма-лестнице вкладки «Генерация»).
 *
 * Сценарий: пользователь генерирует драфты в низком разрешении (дёшево),
 * удачный клип выбирает здесь — и получает ту же сцену в 720p/1080p:
 * исходник кодируется в латент H3 в СВОЁМ разрешении, латент
 * растягивается 3D-апскейлером до цели, и модель дорисовывает
 * детализацию за 3–5 шагов (как Pass 2 генерации, без guide-токенов —
 * потому в разы быстрее старой LMS-схемы).
 *
 * Layout как у вкладки «Генерация»:
 *  • слева — панель параметров: источник, цель, профиль прохода, кнопка
 *    запуска и карточка статуса; промпт видео из галереи подаётся из его
 *    метаданных автоматически и в UI не показывается. Для файлов с диска
 *    (метаданных нет) показывается блок ручного ввода промпта и
 *    картинок-референсов (правка 509);
 *  • справа — общая галерея: результат падает туда же. Источник задаётся
 *    drag&drop карточки/файла в поле «Источник» слева или кнопкой
 *    «В Refine» на карточках галереи.
 *
 * Сервер делает всё сам: /api/comfy/refine копирует output→input,
 * пробит исходник (ffprobe), собран workflow и отправлен в ComfyUI.
 * Прогресс — тем же прогресс-трекером (/api/comfy/progress), статус —
 * /api/comfy/status; отмена — /api/comfy/cancel.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { H3_VIDEO_DND_MIME } from './video-gallery-grid'
import {
  Wand2Icon,
  PlayIcon,
  FileVideoIcon,
  Loader2Icon,
  UploadIcon,
  XIcon,
  WandSparklesIcon,
  Trash2Icon,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { VideoGalleryGrid, type VideoGalleryFile } from '@/components/h3/video-gallery-grid'
import { PromptFixDialog } from '@/components/h3/prompt-editor-dialog' // (правка 691) «Исправить промпт» из поля
import { requestImprovePrompt } from '@/hooks/use-improve-prompt' // (правка 691) задание → чат ассистента
import { GenerationStatus } from '@/components/h3/generation-status'
// (правка 719) Превью рефов с полноэкранным просмотром — как на «Генерации».
import { RefPreviewThumb } from '@/components/h3/ref-preview-thumb'
import { SettingSlider } from '@/components/h3/setting-slider' // (правка 458)
// (правка 723) Пресет Pass 2 и показ фактической лестницы сигм: маленький модуль
// без импортов — шаблон воркфлоу (95 КБ) в клиентский бандл не тянем.
import {
  REFINE_PASS2_SIGMA,
  REFINE_PASS2_STEPS,
  refineSigmaLadder,
} from '@/lib/comfy/refine-sigmas'
import { useVideoGallery } from '@/components/h3/use-video-gallery'
import { useRefineTarget, type RefineSource } from '@/lib/refine-target-store'
import {
  enqueueRefine,
  cancelActiveRefines,
  sweepOrphanRefineItems,
} from '@/lib/refine-queue'
import { useGenQueue, type QueueItem } from '@/lib/gen-queue-store'
import { useGenStore } from '@/lib/gen-store' // (правка 407) veda-настройки
import { uploadInputFile } from '@/lib/upload'

type Phase = 'idle' | 'submitting' | 'queued' | 'running' | 'done' | 'error'

export function RefineView() {
  // ── Источник: из стора (кнопка «В Refine» в галерее) или клик в ленте ──
  const storeTarget = useRefineTarget((s) => s.target)
  const clearStoreTarget = useRefineTarget((s) => s.clear)
  // Источник и параметры — в сторе: вкладка размонтируется при переключении
  // (key={activeTab}), локальный useState терялся — кнопка запуска после
  // возврата на вкладку была недоступна, источник приходилось кидать заново.
  const source = useRefineTarget((s) => s.source)
  const setSource = useRefineTarget((s) => s.setSource)
  const sourceRef = useRef<RefineSource | null>(null)
  sourceRef.current = source

  // (правка 345) blob-URL источника с диска живёт в persist-сторе —
  // отзываем его при замене/удалении источника, иначе утечка на каждый файл.
  const revokeSourceUrl = useCallback((s: RefineSource | null) => {
    if (s?.url?.startsWith('blob:')) {
      try { URL.revokeObjectURL(s.url) } catch { /* уже отозван */ }
    }
  }, [])

  const params = useRefineTarget((s) => s.params)
  const patchParams = useRefineTarget((s) => s.patchParams)
  const { target, steps, strength, mode, chunkSec, refDetail, targetMp } = params

  // (правка 509) Промпт — в сторе (переживает переключение вкладок);
  // вводится вручную для источников с диска (у них нет .meta.json).
  const prompt = useRefineTarget((s) => s.prompt)
  const setPrompt = useRefineTarget((s) => s.setPrompt)
  // (правка 691) Диалог «Исправить промпт» из поля — задание уходит в
  // generate-чат (у refine-режима своего чата нет, правка 559).
  const [fixOpen, setFixOpen] = useState(false)
  // (правка 509) Пользовательские референсы для источника с диска.
  const userRefs = useRefineTarget((s) => s.userRefs)
  const [uploadingRefs, setUploadingRefs] = useState(false)
  const refsInputRef = useRef<HTMLInputElement>(null)
  const [refsDragOver, setRefsDragOver] = useState(false)
  // (правка 494) Размеры источника (для предпросчёта пикселей MP-слайдера
  // «Свободное разрешение») — снимаются с превью-видео.
  const [srcDims, setSrcDims] = useState<{ w: number; h: number } | null>(null)

  // (правка 275) Референсы из .meta.json выбранного источника (галерея):
  // какие картинки реально подадутся в conditioning рефайна. У источника с
  // диска (inputSource) сайдкара нет — блок показывает состояние «нет меты».
  type MetaRef = { path: string; role: string }
  const [metaRefs, setMetaRefs] = useState<MetaRef[] | null>(null)
  const [metaLoading, setMetaLoading] = useState(false)
  // (правка 377) Наличие латента у источника: true → lossless-путь
  // (refine стартует с первозданного латента, без h264+VAE-потерь).
  const [latentOk, setLatentOk] = useState(false)
  useEffect(() => {
    setMetaRefs(null)
    setLatentOk(false)
    if (!source || source.inputSource || !source.filename) return
    const sub = source.subfolder ?? ''
    const p = sub ? `${sub}/${source.filename}` : source.filename
    let cancelled = false
    setMetaLoading(true)
    fetch(`/api/comfy/meta?path=${encodeURIComponent(p)}`)
      .then(async (r) => {
        if (!r.ok) return null // 404 — нет сайдкара: тихо, без тостов
        return (await r.json()) as {
          references?: Array<{ type?: string; path?: string; role?: string }>
          minimax_h3_references?: Array<{ type?: string; path?: string; role?: string }>
          generation_mode?: string
          first_frame?: string | null
          latent_available?: boolean // (правка 377)
        }
      })
      .then((meta) => {
        if (cancelled) return
        setLatentOk(meta?.latent_available === true)
        const list = Array.isArray(meta?.references) ? meta!.references!
          : Array.isArray(meta?.minimax_h3_references) ? meta!.minimax_h3_references!
          : []
        const imgRefs = list
          .filter((r) => r?.type === 'image' && typeof r?.path === 'string' && r.path.length > 0)
          .map((r) => ({ path: r.path as string, role: typeof r.role === 'string' ? r.role : '' }))
        // (правка 452) Режим «Кадры»: кадры не пишутся в references, поэтому
        // рефайн flf-видео шёл без якорей внешности. Первый кадр исходника
        // добавляем как реф (в refine-промптах тегов <Picture N> из flf не
        // было — сдвига нумерации для пользователя не происходит).
        const firstFrame =
          meta?.generation_mode === 'flf' && typeof meta.first_frame === 'string' && meta.first_frame
            ? meta.first_frame
            : null
        if (firstFrame && !imgRefs.some((r) => r.path === firstFrame)) {
          imgRefs.unshift({ path: firstFrame, role: 'первый кадр оригинала' })
        }
        // Порядок = порядок слотов <Picture 1..k> (см. правку 315 в refine-template.ts)
        setMetaRefs(imgRefs)
      })
      .catch(() => { if (!cancelled) setMetaRefs([]) })
      .finally(() => { if (!cancelled) setMetaLoading(false) })
    return () => { cancelled = true }
  }, [source])

  // (правка 265) Drag&drop: подсветка зоны источника
  const [dragOver, setDragOver] = useState(false)
  // (правка 265, фикс) Загрузка файла с диска в ComfyUI input/
  const [uploadingSrc, setUploadingSrc] = useState(false)
  // (правка 274) Клик-выбор файла: <input type='file'> + ref
  const fileInputRef = useRef<HTMLInputElement>(null)
  const VIDEO_EXTS = '.mp4,.m4v,.mov,.mkv,.avi,.webm,.m2ts,.mts,.mxf,.vob,.wmv,.flv,.mpg,.mpeg,.ogv'

  // (правка 265, фикс) Файл с диска → /api/comfy/upload (→ input/),
  // серверный refine использует его как inputSource (копия из output не нужна).
  const uploadLocalFile = useCallback(async (file: File) => {
    setUploadingSrc(true)
    try {
      const { path } = await uploadInputFile(file)
      revokeSourceUrl(sourceRef.current) // (правка 345)
      setSource({
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
  }, [revokeSourceUrl])

  // (правка 509) Картинки-референсы для источника с диска — паттерн вкладки
  // ControlNet: upload в ComfyUI input/, превью через /api/comfy/file.
  // Максимум 8: первый кадр исходника займёт девятый слот (refine-template).
  const addRefFiles = useCallback(async (files: File[]) => {
    const images = files.filter((f) => /^image\//.test(f.type) || /\.(png|jpe?g|webp|bmp|tiff?)$/i.test(f.name))
    if (!images.length) { toast.error('Референсы — только картинки (png, jpg, webp)'); return }
    const room = 8 - useRefineTarget.getState().userRefs.length
    if (room <= 0) { toast.error('Максимум 8 картинок-референсов'); return }
    if (images.length > room) toast.error(`Максимум 8 референсов — добавлено ${room}`)
    setUploadingRefs(true)
    try {
      for (const file of images.slice(0, room)) {
        try {
          const { path } = await uploadInputFile(file)
          useRefineTarget.getState().addUserRefs([{
            id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            path,
            name: file.name,
            previewUrl: `/api/comfy/file?filename=${encodeURIComponent(path)}&type=input&width=200`,
          }])
        } catch (e) {
          toast.error(e instanceof Error ? e.message : 'Ошибка загрузки референса')
        }
      }
    } finally {
      setUploadingRefs(false)
    }
  }, [])

  const removeRef = useCallback((id: string) => {
    useRefineTarget.getState().removeUserRef(id)
  }, [])

  // ── Статус задачи из общей очереди (правка 261) ──
  const queueItems = useGenQueue((s) => s.items)
  // (правка 335) При нескольких активных refine-задачах карточка показывает
  // предпочтительно ИСПОЛНЯЮЩУЮСЯ (running), а не первую попавшуюся queued.
  const myItem: QueueItem | undefined =
    queueItems.find((i) => i.type === 'refine' && i.status === 'running') ??
    queueItems.find(
      (i) => i.type === 'refine' && (i.status === 'submitting' || i.status === 'queued'),
    )
  const [lastDone, setLastDone] = useState<QueueItem | null>(null)
  const [lastError, setLastError] = useState<QueueItem | null>(null)

  const phase: Phase = myItem
    ? (myItem.status === 'submitting' ? 'submitting' : myItem.status === 'queued' ? 'queued' : 'running')
    : lastDone
      ? 'done'
      : lastError
        ? 'error'
        : 'idle'
  const promptId = myItem?.promptId ?? null
  const percent = myItem ? Math.round((myItem.progressValue / Math.max(myItem.progressMax, 1)) * 100) : lastDone ? 100 : 0
  const error = lastError?.error ?? null
  // (правка 587) startedAt: фактическое время старта (при переходе в running),
  // а не время постановки в очередь — иначе при двух задачах подряд таймер
  // не сбрасывался и показывал суммарное время.
  const startedAt = myItem
    ? (myItem.startedAt ?? myItem.createdAt)
    : (lastDone?.startedAt ?? lastDone?.createdAt ?? null)

  // (правка 261) Чистка orphan-задач после перезагрузки страницы
  useEffect(() => {
    sweepOrphanRefineItems()
  }, [])

  // Следим за завершением/ошибкой refine-задач для отображения статуса
  useEffect(() => {
    for (const it of queueItems) {
      if (it.type !== 'refine') continue
      if (it.status === 'done' && it.completedAt && (!lastDone || it.completedAt > (lastDone.completedAt ?? 0))) {
        setLastDone(it)
      }
      if (it.status === 'error' && (!lastError || (it.completedAt ?? 0) > (lastError.completedAt ?? 0))) {
        setLastError(it)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueItems])

  const gallery = useVideoGallery()

  // Цель из стора галереи («В Refine»)
  useEffect(() => {
    if (!storeTarget) return
    const file = gallery.files.find(
      (f) => f.filename === storeTarget.filename && f.subfolder === storeTarget.subfolder,
    )
    revokeSourceUrl(sourceRef.current) // (правка 345)
    if (file) {
      setSource(file)
      toast.success(`Источник: ${file.filename}`)
    } else {
      // файл может быть ещё не в списке — берём как есть (url соберём сами)
      setSource({
        url: `/api/comfy/file?filename=${encodeURIComponent(storeTarget.filename)}&subfolder=${encodeURIComponent(storeTarget.subfolder)}`,
        filename: storeTarget.filename,
        subfolder: storeTarget.subfolder,
      })
    }
    clearStoreTarget()
  }, [storeTarget, gallery.files, clearStoreTarget, revokeSourceUrl])

  const busy = !!myItem

  // ── Промпт ──
  // Для видео из галереи промпт и референсы сервер берёт сам из .meta.json
  // сайдкара исходника: есть прикреплённые картинки — они подаются вместе
  // с ОРИГИНАЛЬНЫМ промптом (теги <Picture N> биндятся к картинкам, как в
  // генерации); нет — зачищенный промпт + первый кадр. Поле ввода видно
  // только у файлов с диска (inputSource): сайдкара у них нет.
  useEffect(() => {
    // новый источник — с чистого промпта, чтобы не протекал прошлый
    setPrompt('')
    setSrcDims(null) // (правка 494)
    // (правка 509) и с чистых пользовательских рефов — они привязаны к
    // конкретному исходнику
    useRefineTarget.getState().clearUserRefs()
  }, [source])

  // (правка 261) Опрос статуса/прогресса теперь ведёт раннер refine-queue.ts
  // через useGenQueue — локальный polling больше не нужен.

  // ── (правка 261) Запуск через общую очередь (refine-queue.ts) ──
  // (правка 333) Guard от случайного дабл-клика: enqueueRefine синхронен,
  // поэтому in-flight флаг бессмысленен — игнорируем повторный запуск в
  // течение 1 с после предыдущего. Намеренные повторные запуски не
  // блокируются.
  const lastSubmitAtRef = useRef(0)
  const start = useCallback(async () => {
    const src = sourceRef.current
    if (!src) {
      toast.error('Сначала выберите видео-источник')
      return
    }
    // (правка 587) Дешёвые guard'ы — ДО троттла и очистки статуса: клик во
    // время загрузки источника раньше успевал потратить тротл-окно и стереть
    // карточку только что завершённого результата, ничего не сделав.
    if (uploadingSrc) {
      toast.error('Видео ещё загружается — дождитесь завершения')
      return
    }
    if (Date.now() - lastSubmitAtRef.current < 1000) return // (правка 333)
    lastSubmitAtRef.current = Date.now()
    setLastDone(null)
    setLastError(null)

    const task = {
      mode: mode as 'whole' | 'chunks',
      source: { filename: src.filename, subfolder: src.subfolder ?? '' },
      ...(src.inputSource ? { inputSource: src.inputSource } : {}),
      target: target === 'same' ? 'same' as const : target === 'free' ? 'free' as const : parseInt(target, 10),
      ...(target === 'free' ? { targetMp } : {}), // (правка 494)
      steps: parseInt(steps, 10),
      sigmaStart: strength,
      seed: -1, // всегда случайный (правка: поле Seed убрано из UI)
      prompt: prompt.trim() ? prompt.trim() : '',
      // (правка 509) Референсы от пользователя (актуальны для источника
      // с диска; галерейный путь сервером игнорируется — там рефы из меты)
      ...(userRefs.length > 0 && { refImages: userRefs.map((r) => r.path) }),
      chunkSeconds: parseInt(chunkSec, 10),
      refImageSize: refDetail, // (правка 276)
      // (правка 407) Veda-настройки из общих настроек программы (gen-store)
      ...(useGenStore.getState().video.vedaAttention === true && {
        vedaAttention: true,
        vedaGeneratedSparsity: useGenStore.getState().video.vedaGeneratedSparsity,
        vedaReferenceSparsity: useGenStore.getState().video.vedaReferenceSparsity,
        vedaFullAttentionLayers: useGenStore.getState().video.vedaFullAttentionLayers,
        vedaFullAttentionSteps: useGenStore.getState().video.vedaFullAttentionSteps,
        vedaVerbose: useGenStore.getState().video.vedaVerbose,
      }),
      // (правка 466) Sol-Attn + настройки ноды из общих настроек программы
      ...(useGenStore.getState().video.sparseAttention === true && {
        sparseAttention: true,
        sparseTau: useGenStore.getState().video.sparseTau,
        sparseStartPercent: useGenStore.getState().video.sparseStartPercent,
        sparseEndPercent: useGenStore.getState().video.sparseEndPercent,
        sparseMinTokens: useGenStore.getState().video.sparseMinTokens,
        sparseExtraTokens: useGenStore.getState().video.sparseExtraTokens,
      }),
    }
    enqueueRefine(task)
    toast.info(`Refine поставлен в очередь: ${src.filename}`)
  }, [mode, target, targetMp, steps, strength, prompt, chunkSec, uploadingSrc, refDetail, userRefs])

  const cancel = useCallback(async () => {
    await cancelActiveRefines()
    toast.info('Refine отменён')
  }, [])

  const reset = useCallback(() => {
    setLastDone(null)
    setLastError(null)
  }, [])

  const srcThumb = (f: VideoGalleryFile) =>
    f.url.includes('?') ? `${f.url}&width=320` : `${f.url}?width=320`

  return (
    <div className="flex h-full w-full min-w-0">
      {/* ═══ Панель параметров ═══ */}
      <aside className="w-[360px] shrink-0 border-r border-border bg-[var(--surface-1)] flex flex-col">
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div className="flex items-center gap-2">
            <Wand2Icon className="w-4 h-4 text-emerald-400" />
            <h2 className="text-sm font-semibold text-foreground">Refine</h2>
          </div>

          {/* Источник */}
          <div className="space-y-2">
            {/* (правка 459) Лейблы/селекты панели приведены к эталону вкладки
                «Генерация»: Label text-xs text-muted-foreground font-medium,
                SelectTrigger h-9 bg-[var(--surface-2)] text-sm. */}
            <Label className="text-xs text-muted-foreground font-medium">Источник</Label>
            {source ? (
              <div
                onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault()
                  setDragOver(false)
                  const raw = e.dataTransfer.getData(H3_VIDEO_DND_MIME)
                  if (raw) {
                    try {
                      const parsed = JSON.parse(raw) as { filename?: string; subfolder?: string }
                      revokeSourceUrl(sourceRef.current) // (правка 345)
                      setSource({
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
                }}
                className={cn(
                  'flex items-center gap-3 rounded-lg border bg-[var(--surface-2)] p-2 transition-all',
                  dragOver ? 'border-cyan-400 ring-1 ring-cyan-400/50' : 'border-border',
                )}
              >
                {/* (правка 457) Превью: src — САМО видео (source.url), а не
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
                    onLoadedMetadata={(e) => {
                      const v = e.currentTarget
                      if (v.videoWidth > 0 && v.videoHeight > 0) {
                        setSrcDims({ w: v.videoWidth, h: v.videoHeight })
                      }
                    }}
                    className="w-full h-full object-cover"
                  />
                </RefPreviewThumb>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-foreground truncate">
                    {source.filename}
                  </p>
                  {uploadingSrc && (
                    <p className="text-[10px] text-cyan-400">загрузка…</p>
                  )}
                </div>
                {!busy && (
                  <button
                    onClick={() => { revokeSourceUrl(sourceRef.current); setSource(null) }} // (правка 345)
                    className="text-[10px] text-muted-foreground hover:text-foreground shrink-0"
                  >
                    убрать
                  </button>
                )}
              </div>
            ) : (
              <div
                onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault()
                  setDragOver(false)
                  const raw = e.dataTransfer.getData(H3_VIDEO_DND_MIME)
                  if (raw) {
                    try {
                      const parsed = JSON.parse(raw) as { filename?: string; subfolder?: string }
                      revokeSourceUrl(sourceRef.current) // (правка 345)
                      setSource({
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
                }}
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

          {/* (правка 368) Куда сохранится результат: сервер кладёт рефайн
              в папку оригинала (правка 366); файл с диска — общая папка. */}
          {source && (
            <p className="text-[10px] text-muted-foreground/60 -mt-2">
              Папка результата: {source.inputSource ? 'общая' : `${source.subfolder || 'общая'} (по оригиналу)`}
            </p>
          )}

          {/* (правка 377) Бейдж «латент ✓»: источник несёт сохранённый
              AV-латент генерации → рефайн пойдёт по lossless-пути (без
              h264-декода и повторного VAEEncode) — в ОБОИХ режимах:
              «Целый» и «Частями» (правка 382: окна режутся токенами
              латента). Показываем только при наличии латента: его
              отсутствие — обычный mp4-путь (старые файлы, чужие видео). */}
          {source && !source.inputSource && latentOk && (
            <p
              className="text-[10px] -mt-1 flex items-center gap-1.5 text-emerald-400/90"
              title={
                mode === 'whole'
                  ? 'Рефайн стартует с первозданного латента генерации — без потерь от h264 и повторного VAE-кодирования'
                  : 'Окна режима «Частями» режутся токенами прямо из латента генерации — без потерь на кодировании'
              }
            >
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
              Латент ✓ — рефайн без потерь
            </p>
          )}

          {/* (правка 509) Источник с диска: метаданных нет — показываем
              блок ручного ввода промпта и картинок-референсов (вместо
              блока «Референсы из метаданных»). Промпт и рефы уходят в
              воркфлоу как есть: рефы занимают слоты <Picture 1..N>,
              первый кадр исходника добавляется последним. */}
          {source && source.inputSource && (
            <div className="space-y-2 rounded-lg border border-cyan-500/30 bg-cyan-500/5 p-2.5">
              <Label
                className="text-xs text-muted-foreground font-medium"
                title="У файла с диска нет сохранённых метаданных — опишите сцену сами и, при желании, добавьте картинки-якоря (персонаж, локация, стиль)."
              >
                Промпт и референсы
              </Label>
              <div className="relative">
                <Textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="Опишите сцену: что происходит, персонажи, стиль, свет. Пусто — универсальный промпт детализации…"
                  disabled={uploadingRefs}
                  className="min-h-[72px] resize-y bg-[var(--surface-2)] border-border text-xs pr-14"
                />
                {/* (правка 691) «Исправить промпт» + «Очистить» — правый верх
                    поля, те же кнопки что на вкладках «Генерация»/«ControlNet».
                    Refine — постобработка готового видео: задание уходит в
                    generate-чат (у refine своего чата нет, правка 559). */}
                <button
                  type="button"
                  onClick={() => setFixOpen(true)}
                  title="Исправить промпт с ассистентом: напишите, что изменить — промпт и задание уйдут в чат"
                  className="absolute top-2 right-9 p-1.5 rounded-md bg-[var(--surface-3)]/80 hover:bg-[var(--surface-4)] text-violet-300 hover:text-violet-200 transition-colors border border-violet-500/30 z-10 backdrop-blur-sm"
                >
                  <WandSparklesIcon className="w-3.5 h-3.5" />
                </button>
                {prompt.trim() && (
                  <button
                    type="button"
                    onClick={() => setPrompt('')}
                    title="Очистить поле промпта"
                    className="absolute top-2 right-16 p-1.5 rounded-md bg-[var(--surface-3)]/80 hover:bg-red-500/15 text-muted-foreground hover:text-red-400 transition-colors border border-border/50 z-10 backdrop-blur-sm"
                  >
                    <Trash2Icon className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              <div
                onDragOver={(e) => { e.preventDefault(); setRefsDragOver(true) }}
                onDragLeave={() => setRefsDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault()
                  setRefsDragOver(false)
                  void addRefFiles(Array.from(e.dataTransfer.files))
                }}
                onClick={() => refsInputRef.current?.click()}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); refsInputRef.current?.click() } }}
                className={cn(
                  'rounded-lg border border-dashed p-2.5 text-[11px] text-muted-foreground text-center cursor-pointer transition-all',
                  refsDragOver ? 'border-cyan-400 bg-cyan-500/10' : 'border-border hover:border-cyan-500/40 hover:bg-[var(--surface-2)]',
                )}
              >
                <input
                  ref={refsInputRef}
                  type="file"
                  multiple
                  accept="image/png,image/jpeg,image/webp,image/bmp,image/tiff"
                  className="hidden"
                  onChange={(e) => {
                    void addRefFiles(Array.from(e.target.files ?? []))
                    e.target.value = ''
                  }}
                />
                {uploadingRefs ? (
                  <span className="text-cyan-400">Загрузка референсов…</span>
                ) : (
                  <span className="flex items-center justify-center gap-1.5">
                    <UploadIcon className="w-3.5 h-3.5" />
                    Референсы (необязательно, до 8)
                  </span>
                )}
              </div>
              {userRefs.length > 0 && (
                <div className="grid grid-cols-4 gap-1.5">
                  {userRefs.map((r, i) => (
                    <div key={r.id} className="relative group rounded-md overflow-hidden border border-border bg-black/40 aspect-square">
                      {/* (правка 719) Клик по превью — просмотр во весь экран
                          (как на вкладке «Генерация»). */}
                      <RefPreviewThumb
                        kind="image"
                        name={r.name}
                        path={r.path}
                        url={r.previewUrl}
                        className="w-full h-full block"
                        title="Открыть референс во весь экран"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={r.previewUrl} alt={r.name} className="w-full h-full object-cover" />
                      </RefPreviewThumb>
                      <span className="absolute left-0.5 bottom-0.5 text-[9px] font-mono px-1 rounded bg-black/70 text-cyan-300 pointer-events-none">
                        P{i + 1}
                      </span>
                      <button
                        onClick={() => removeRef(r.id)}
                        className="absolute right-0.5 top-0.5 p-0.5 rounded bg-black/70 text-muted-foreground hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                        title={`Удалить (${r.name})`}
                      >
                        <XIcon className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <p className="text-[10px] text-muted-foreground/60">
                На картинки в промпте ссылайтесь как &lt;Picture 1&gt;, &lt;Picture 2&gt;… Первый кадр видео добавится якорем последним слотом автоматически.
              </p>
            </div>
          )}

          {/* (правка 275) Референсы, которые реально подадутся в рефайн:
              картинки из меты исходника (слоты <Picture 1..k>) + первый кадр
              последним. Превью — из ComfyUI input/ через /api/comfy/file
              (тот же механизм, что у чипов meta-dialog/generate-view). */}
          {source && !source.inputSource && (
            <div className="space-y-2">
              <Label
                className="text-xs text-muted-foreground font-medium"
                title="Картинки, сохранённые в видео при генерации, плюс его первый кадр — они помогают сохранить персонажей, цвета и свет."
              >
                Референсы из метаданных
              </Label>
              {metaLoading ? (
                <p className="text-[10px] text-muted-foreground">Чтение метаданных…</p>
              ) : metaRefs && metaRefs.length > 0 ? (
                <>
                  <div className="flex flex-wrap gap-1.5">
                    {metaRefs.map((r, i) => (
                      <div
                        key={`${r.path}-${i}`}
                        title={r.path}
                        className="relative w-14 rounded-md border border-purple-500/30 bg-[var(--surface-2)] overflow-hidden"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={`/api/comfy/file?filename=${encodeURIComponent(r.path)}&type=input&width=96`}
                          alt=""
                          loading="lazy"
                          className="w-14 h-14 object-cover"
                        />
                        <span className="absolute top-0.5 left-0.5 rounded bg-black/70 px-1 text-[10px] font-mono text-cyan-300">
                          P{i + 1}
                        </span>
                        <p className="px-1 py-0.5 text-[10px] leading-tight text-muted-foreground truncate">
                          {r.role
                            ? ({ identity: 'персонаж', scene: 'сцена', style: 'стиль', composition: 'композиция' } as Record<string, string>)[r.role] ?? r.role
                            : r.path.split(/[\\/]/).pop()}
                        </p>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <p className="text-[10px] text-muted-foreground">
                  Нет метаданных: якорем будет только первый кадр.
                </p>
              )}
            </div>
          )}

          {/* (правка 276) Режим размера референсов — как во вкладке
              «Генерация» (referenceDetail), дефолт Max. */}
          <div className="space-y-2">
            <Label
              className="text-xs text-muted-foreground font-medium"
              title="Как обрабатывать картинки-референсы. Match — быстрее; Max — точнее сохраняет детали, но медленнее."
            >
              Рефы: режим размера
            </Label>
            <div className="grid grid-cols-2 gap-1.5">
              {/* (правка 465) Настройки НЕ блокируются во время генерации:
                  параметры снапшотятся в задачу при enqueue (refine-queue),
                  поэтому можно крутить настройки и ставить следующий вариант
                  в очередь, не дожидаясь конца текущего. */}
              {(['match', 'max'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => patchParams({ refDetail: m })}
                  className={cn(
                    'px-2 py-1.5 rounded-md border text-xs transition-colors',
                    refDetail === m
                      ? 'border-cyan-500/40 text-cyan-300 bg-cyan-500/10'
                      : 'border-border text-muted-foreground hover:text-foreground',
                  )}
                >
                  {m === 'match' ? 'Match (быстро)' : 'Max (качество)'}
                </button>
              ))}
            </div>
          </div>

          {/* Целевое разрешение */}
          <div className="space-y-2">
            <Label
              className="text-xs text-muted-foreground font-medium"
              title={
                target === 'same'
                  ? 'Размер не меняется — видео просто становится чётче и детальнее.'
                  : target === 'free'
                    ? 'Точный размер результата в мегапикселях (как во вкладке «Генерация»), пропорции исходника сохраняются. Максимум 8.3 Мп = 4K.'
                    : `Короткая сторона результата — ${target}p, пропорции исходника сохраняются.`
              }
            >
              Целевое разрешение
            </Label>
            <Select value={target} onValueChange={(v) => patchParams({ target: v as 'same' | '720' | '1080' | 'free' })}>
              <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                <SelectValue placeholder="Разрешение" />
              </SelectTrigger>
              <SelectContent className="bg-[var(--surface-3)] border-border">
                <SelectItem value="720">720p (быстрее, безопаснее по VRAM)</SelectItem>
                <SelectItem value="1080">1080p (медленнее, максимум детализации)</SelectItem>
                <SelectItem value="free">Свободное (в Мп, до 4K)</SelectItem>
                <SelectItem value="same">Как в исходнике (только детализация)</SelectItem>
              </SelectContent>
            </Select>
            {/* (правка 494) Свободное разрешение — MP-слайдер как во вкладке
                «Генерация», но до 4K (8.3 Мп). Конвертация Мп → короткая
                сторона — на сервере по реальным размерам источника (в
                lossless-ветке — по канве латента); здесь — приблизительный
                предпросчёт по размерам превью-видео. */}
            {target === 'free' && (
              <SettingSlider
                label="Разрешение (Мп)"
                labelTitle="Точный размер результата в мегапикселях — пропорции исходника сохраняются. 8.3 Мп = 4K (например 3840×2160). Выше 2–3 Мп — заметно больше VRAM и времени."
                value={targetMp}
                onChange={(v) => patchParams({ targetMp: Math.round(v * 100) / 100 })}
                min={0.2}
                max={8.3}
                step={0.05}
                formatValue={(v) => {
                  if (!srcDims) return `${v.toFixed(2)} Мп`
                  const scale = Math.sqrt((Math.min(8.3, v) * 1e6) / (srcDims.w * srcDims.h))
                  const even = (n: number) => 2 * Math.round(n / 2)
                  return `${v.toFixed(2)} Мп (≈${even(srcDims.w * scale)}×${even(srcDims.h * scale)})`
                }}
                inputMin={0.2}
                inputMax={8.3}
                inputHint="0.2–8.3 Мп (8.3 = 4K). Выше 2–3 Мп — заметно больше VRAM и времени"
              />
            )}
          </div>

          {/* Режим: целиком / частями */}
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground font-medium">Режим</Label>
            <div className="grid grid-cols-2 gap-1.5">
              {([
                ['whole', 'Целый', 'Один джоб на всё видео'],
                ['chunks', 'Частями', 'Кусками с перекрытием + бесшовная склейка (для длинных видео)'],
              ] as const).map(([m, label, hint]) => (
                <button
                  key={m}
                  type="button"
                  title={hint}
                  // (правка 698) При переключении режима — дефолтное влияние
                  // Refine для этого режима (Целый 90% / Частями 80%).
                  // Перезаписываем ТОЛЬКО при смене режима; если пользователь
                  // уже вручную подвинул слайдер, его значение остаётся.
                  onClick={() => {
                    if (mode === m) return
                    const defaultStrength = m === 'chunks' ? 0.8 : 0.9
                    patchParams({ mode: m, strength: defaultStrength })
                  }}
                  className={cn(
                    'h-8 rounded-md border text-xs font-medium transition-all',
                    mode === m
                      ? 'bg-cyan-500/15 border-cyan-500/50 text-cyan-300'
                      : 'bg-[var(--surface-2)] border-border text-muted-foreground hover:border-cyan-500/30',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            {mode === 'chunks' && (
              <div
                className="space-y-1.5 pt-1"
                title="Длинное видео обрабатывается кусками с небольшим нахлёстом, затем куски незаметно склеиваются. Звук перегенерируется вместе с видео — галочка «Оставить оригинальный звук» ниже подставит дорожку исходника."
              >
                <Select value={chunkSec} onValueChange={(v) => patchParams({ chunkSec: v as '3' | '5' | '8' })}>
                  <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                    <SelectValue placeholder="Длина куска" />
                  </SelectTrigger>
                  <SelectContent className="bg-[var(--surface-3)] border-border">
                    <SelectItem value="3">~3 с (меньше VRAM)</SelectItem>
                    <SelectItem value="5">~5 с (рекомендуется)</SelectItem>
                    <SelectItem value="8">~8 с (быстрее в сумме)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          {/* Профиль прохода (сигма-лестница Pass 2 генерации) */}
          <div className="space-y-2">
            <Label
              className="text-xs text-muted-foreground font-medium"
              title={
                steps === '2'
                  ? 'Лёгкая доработка: модель только слегка дорисовывает детали, почти не меняя картинку.'
                  : 'Сколько шагов делает проход улучшения. 3 — проверенный баланс скорости и чёткости; больше — детальнее, но медленнее.'
              }
            >
              Проход (шаги)
            </Label>
            <Select value={steps} onValueChange={(v) => patchParams({ steps: v as '2' | '3' | '4' | '5' | '6' | '7' })}>
              <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                <SelectValue placeholder="Шаги" />
              </SelectTrigger>
              <SelectContent className="bg-[var(--surface-3)] border-border">
                <SelectItem value="2">2 шага</SelectItem>
                <SelectItem value="3">3 шага — быстро (эталон генерации)</SelectItem>
                <SelectItem value="4">4 шага — детальнее</SelectItem>
                <SelectItem value="5">5 шагов</SelectItem>
                <SelectItem value="6">6 шагов</SelectItem>
                <SelectItem value="7">7 шагов — максимум (как в генерации)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Влияние Refine (σ_start сигма-лестницы)
              (правка 458) Сырой <input type="range"> заменён на общий
              SettingSlider (как во вкладке «Генерация»): значение и σ —
              в formatValue, пояснение — в labelTitle-тултипе.
              (правка 723) Под слайдером — фактическая лестница сигм и пресет
              «Pass 2»: 3 шага, старт σ 0.9035 — ровно второй проход
              двухпроходной генерации (ManualSigmas 0.9035, 0.6316, 0.3158, 0). */}
          <div className="space-y-1.5">
            <SettingSlider
              label="Влияние Refine"
              labelTitle={
                strength >= 0.9
                  ? 'Модель смело дорисовывает детали — максимальный эффект.'
                  : strength >= 0.6
                    ? 'Изменения деликатнее, результат остаётся ближе к исходнику.'
                    : 'Совсем лёгкая доработка — почти без перерисовки, деталей может не прибавиться.'
              }
              value={Math.round(strength * 100)}
              min={30}
              max={95}
              step={5}
              onChange={(v) => patchParams({ strength: v / 100 })}
              formatValue={() => `${Math.round(strength * 100)}% · σ ${strength.toFixed(3)}`}
            />
            <div className="flex items-center gap-2">
              <span
                className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground"
                title="Фактическая лестница сигм (старт → … → 0), которую получит сэмплер. Пресет Pass 2 повторяет сигмы второго прохода двухпроходной генерации."
              >
                σ{' '}
                {refineSigmaLadder(parseInt(steps, 10), strength)
                  .split(',')
                  .map((s) => s.trim())
                  .join(' → ')}
              </span>
              <button
                type="button"
                onClick={() =>
                  patchParams({
                    steps: String(REFINE_PASS2_STEPS) as '2' | '3' | '4' | '5' | '6' | '7',
                    strength: REFINE_PASS2_SIGMA,
                  })
                }
                title={`Как Pass 2 генерации: ${REFINE_PASS2_STEPS} шага, старт σ ${REFINE_PASS2_SIGMA} — точное совпадение лестницы.`}
                className={
                  steps === String(REFINE_PASS2_STEPS) &&
                  Math.abs(strength - REFINE_PASS2_SIGMA) < 1e-6
                    ? 'shrink-0 rounded-md border border-cyan-500/50 bg-cyan-500/10 px-1.5 py-0.5 font-mono text-[10px] text-cyan-300'
                    : 'shrink-0 rounded-md border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors hover:border-cyan-500/40 hover:text-foreground'
                }
              >
                Pass 2
              </button>
            </div>
          </div>

          {/* Запуск (правка 261): можно ставить в очередь, пока идёт задача */}
          <div className="flex gap-2 pt-1">
            <Button
              onClick={start}
              disabled={!source}
              className="flex-1 gap-1.5"
            >
              {busy ? <Loader2Icon className="w-4 h-4 animate-spin" /> : <PlayIcon className="w-4 h-4" />}
              {busy ? 'Ещё в очередь' : 'Запустить Refine'}
            </Button>
          </div>

        </div>

        {/* (правка 261) Pinned bottom: generation status — всегда виден, как в «Генерация» */}
        {/* (правка 475) панель статуса/превью — surface-1, в цвет панели настроек */}
        <div className="shrink-0 border-t border-border p-3 bg-[var(--surface-1)]/90 backdrop-blur-sm">
          <GenerationStatus
            isGenerating={busy}
            phase={phase}
            progressPercent={percent}
            statusMessage={null}
            error={error}
            onInterrupt={cancel}
            onReset={reset}
            startedAt={startedAt}
            promptId={promptId}
            stageKind={mode === 'chunks' ? 'chunks' : 'single'}
          />
        </div>
      </aside>

      {/* (правка 691) Диалог «Исправить промпт» из поля refine: задание +
          промпт уходят в generate-чат (у refine-режима своего чата нет). */}
      <PromptFixDialog
        open={fixOpen}
        onOpenChange={setFixOpen}
        hint="Промпт и ваше задание уйдут в чат ассистента — ответ можно будет вставить обратно кнопкой «В промпт». Ctrl+Enter — отправить, Esc — отмена."
        onSubmit={(req) => requestImprovePrompt(prompt, { mode: 'generate', fixRequest: req })}
      />

      {/* ═══ Правая часть: галерея (источник — drag&drop в поле «Источник») ═══ */}
      <section className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {/* Общая галерея — результат появится здесь */}
        <div className="flex-1 min-h-0 overflow-y-auto p-3">
          <VideoGalleryGrid
            files={gallery.files}
            loading={gallery.loading}
            onRefresh={() => void gallery.load()}
            onDeleteFile={gallery.deleteFile}
            emptyHint="Результаты Refine появятся здесь"
          />
        </div>
      </section>
    </div>
  )
}
