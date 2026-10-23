'use client'

/**
 * (правка 497) ControlNetView — вкладка «ControlNet»: генерация видео,
 * следующего движению контрольного ролика (3D-болванка, превиз, референс)
 * покадрово — через стандартный References-воркфлоу MiniMax H3.
 * Контрольное видео подаётся как обычный video-референс (depth/canny карта).
 *
 * (правка 502) Layout как у «Генерации»: слева — параметры + статус,
 * по центру сверху — карточка промпта (с кнопкой «Улучшить» в ассистент),
 * ниже — галерея, справа — панель ассистента в режиме 'controlnet'.
 * Источник: drag&drop карточки из галереи (application/x-h3-video) или файл
 * с диска (uploadInputFile → ComfyUI input/). Состояние джоба — в модульном
 * controlnet-job-store, промпт/seed/референсы — в controlnet-target-store
 * (оба переживают unmount при переключении вкладок).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  WaypointsIcon,
  PlayIcon,
  FileVideoIcon,
  Loader2Icon,
  AlertTriangleIcon,
  DicesIcon,
  UploadIcon,
  XIcon,
  SparklesIcon,
  HistoryIcon,
  StarIcon,
  FolderIcon,
  FilmIcon,
  ChevronDownIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

import { MentionTextarea, type MentionItem } from './mention-textarea' // (правка 512)
// (правка 515) Полное поле промпта — как на вкладке «Генерация»:
// PromptEditButton + PromptEditorDialog (полноэкранный редактор),
// VoiceInputButton (диктовка), PromptQuality (живые подсказки),
// История промптов + Готовые примеры (портал-дропдауны).
import { PromptEditorDialog, PromptEditButton, PromptFixButton, PromptClearButton, PromptFixDialog, PromptFieldTools } from './prompt-editor-dialog'
import { requestImprovePrompt } from '@/hooks/use-improve-prompt' // (правка 691) «Исправить» прямо из поля
import { PromptQuality } from './prompt-quality'
// (правка 719) Превью рефов с полноэкранным просмотром — как на «Генерации».
import { RefPreviewThumb } from './ref-preview-thumb'
import { VoiceInputButton } from './voice-input-button'
import { EXAMPLES } from './learn/prompt-guide'
import { usePromptHistory } from '@/lib/prompt-history-store'
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
import { useVideoGallery } from '@/components/h3/use-video-gallery'
import { useControlNetTarget, type ControlNetSource } from '@/lib/controlnet-target-store'
import { useControlNetJob } from '@/lib/controlnet-job-store'
import { uploadInputFile } from '@/lib/upload'
import { AssistantPanel } from './assistant/assistant-panel' // (правка 502)
import { useGenStore } from '@/lib/gen-store' // (правка 512) Veda/Sparse из настроек приложения

// (правка 511) Подписи сэмплеров/планировщиков — те же, что на вкладке «Генерация»
const SAMPLER_OPTIONS = [
  { value: 'euler', label: 'euler (по умолчанию, классика)' },
  { value: 'er_sde', label: 'er_sde (SDE)' },
  { value: 'dpmpp_2m', label: 'dpmpp_2m (мультистеп)' },
  { value: 'dpmpp_3m_sde', label: 'dpmpp_3m_sde (высокое качество)' },
  { value: 'heun', label: 'heun (2-й порядок)' },
  { value: 'lcm', label: 'lcm (мало шагов)' },
  { value: 'res_multistep', label: 'res_multistep (резидуальный)' },
]

const SCHEDULER_OPTIONS = [
  { value: 'simple', label: 'simple (по умолчанию)' },
  { value: 'sgm_uniform', label: 'sgm_uniform' },
  { value: 'karras', label: 'karras' },
  { value: 'exponential', label: 'exponential' },
  { value: 'ddim_uniform', label: 'ddim_uniform' },
  { value: 'normal', label: 'normal' },
  { value: 'beta', label: 'beta' },
  { value: 'linear_quadratic', label: 'linear_quadratic' },
  { value: 'kl_optimal', label: 'kl_optimal' },
]

export function ControlNetView() {
  const storeTarget = useControlNetTarget((s) => s.target)
  const clearStoreTarget = useControlNetTarget((s) => s.clear)
  const source = useControlNetTarget((s) => s.source)
  const setSource = useControlNetTarget((s) => s.setSource)
  // (правка 587) Отзыв предыдущего blob:-URL при замене/удалении источника
  // (паттерн refine-view, правка 345) — URL.createObjectURL утекал.
  const prevSourceUrlRef = useRef<string | null>(null)
  const setSourceSafe = useCallback(
    (next: ControlNetSource | null) => {
      const prev = prevSourceUrlRef.current
      if (prev && prev.startsWith('blob:') && prev !== next?.url) {
        try { URL.revokeObjectURL(prev) } catch { /* уже отозван */ }
      }
      prevSourceUrlRef.current = next?.url ?? null
      setSource(next)
    },
    [setSource],
  )
  const sourceRef = useRef<ControlNetSource | null>(null)
  sourceRef.current = source

  const params = useControlNetTarget((s) => s.params)
  const patchParams = useControlNetTarget((s) => s.patchParams)
  // (правка 727) Папка результата — как на вкладке «Генерация».
  const outputFolder = useControlNetTarget((s) => s.outputFolder)
  const setOutputFolder = useControlNetTarget((s) => s.setOutputFolder)
  const [folderMenuOpen, setFolderMenuOpen] = useState(false)

  // (правка 511) Доп. параметры — как на вкладке «Генерация»:
  // шаги (draft: 1 слайдер, full: 2), сэмплер + планировщик (Pass 1),
  // Sigma-профиль + сэмплер (Pass 2).
  const isDraft = params.pipeline === 'draft'
  // (правка 719) Сводка по сплиту pass 1 — как на вкладке «Генерация».
  const cnSplit = Math.max(1, Math.round(params.firstSamplerSteps ?? 6))
  const cnTotal = Math.max(2, Math.min(64, Math.round(params.firstSamplerTotalSteps ?? cnSplit * 2)))
  const cnEffSplit = Math.min(cnSplit, cnTotal)
  const cnSigmaEnd = 1 - (cnEffSplit - 1) / cnTotal
  const cnPass2Steps =
    params.sigmaVariant === '7step' ? 7
      : params.sigmaVariant === '6step' ? 6
        : params.sigmaVariant === '5step' ? 5
          : params.sigmaVariant === '4step' ? 4 : 3
  const cnPass2Start =
    params.sigmaVariant === '5step' ? 0.9231
      : params.sigmaVariant === '6step' ? 0.9412
        : params.sigmaVariant === '7step' ? 0.95 : 0.9035
  const [showPass1, setShowPass1] = useState(false)
  const [showPass2, setShowPass2] = useState(false)

  // (правка 502) Промпт/seed/референсы — из стора вкладки: раньше жили в
  // локальном useState и сбрасывались при каждом переключении вкладок.
  const prompt = useControlNetTarget((s) => s.prompt)
  const setPrompt = useControlNetTarget((s) => s.setPrompt)
  const seed = useControlNetTarget((s) => s.seed)
  const setSeed = useControlNetTarget((s) => s.setSeed)
  const [dragOver, setDragOver] = useState(false)
  const [uploadingSrc, setUploadingSrc] = useState(false)

  // (правка 498) Картинки-референсы (персонаж/локация/кадр) — как в режиме
  // «Референсы» генерации, только картинки, до 9. Не сбрасываются при смене
  // источника (рефы обычно живут дольше конкретного контрольного видео).
  // (правка 502) Массив — в сторе вкладки (см. выше).
  const refImages = useControlNetTarget((s) => s.refImages)
  const [uploadingRefs, setUploadingRefs] = useState(false)
  const [refsDragOver, setRefsDragOver] = useState(false)
  const refsInputRef = useRef<HTMLInputElement>(null)

  // Состояние джоба — из модульного стора (переживает unmount).
  const busy = useControlNetJob((s) => s.busy)
  const phase = useControlNetJob((s) => s.phase)
  const progress = useControlNetJob((s) => s.progress)
  const error = useControlNetJob((s) => s.error)
  const promptId = useControlNetJob((s) => s.promptId)
  const startedAt = useControlNetJob((s) => s.startedAt)
  const jobSubmit = useControlNetJob((s) => s.submit)
  const jobCancel = useControlNetJob((s) => s.cancel)
  const jobReset = useControlNetJob((s) => s.reset)

  const gallery = useVideoGallery()

  // ── Готовность моделей: стандартный References-воркфлоу — нужны базовые H3
  //    модели (diffusion, text_encoder, vae_video) + upscaler в режиме «полный».
  //    Для «карты» depth нужна лишь depth_anything_v2_vits.
  //    (правка 720) turbo LoRA из списка УБРАНА: она убрана из пайплайна
  //    (правки 578/587) и больше не подключается, а скачать её теперь можно
  //    только вручную — блокировать вкладку из-за неё нельзя.
  const [missingModels, setMissingModels] = useState<string[]>([])
  // Свёрнутые доп. параметры (Seed), как на вкладке «Генерация»
  const [showAdvanced, setShowAdvanced] = useState(false)
  useEffect(() => {
    let cancelled = false
    const check = () => {
      fetch('/api/models/status')
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (cancelled || !data) return
          const models = (data.models ?? []) as Array<{ id: string; label: string; status: string }>
          const need = params.preprocessOnly
            ? (params.controlType === 'depth' ? ['depth_anything_v2_vits'] : [])
            : [
                ...(params.controlType === 'depth' ? ['depth_anything_v2_vits'] : []),
                'diffusion',
                'text_encoder',
                'vae_video',
                ...(params.pipeline === 'full' ? ['upscaler'] : []),
              ]
          setMissingModels(
            models.filter((m) => need.includes(m.id) && m.status !== 'ready').map((m) => m.label),
          )
        })
        .catch(() => { /* API недоступен — не блокируем */ })
    }
    check()
    const t = setInterval(check, 15_000)
    return () => { cancelled = true; clearInterval(t) }
  }, [params.controlType, params.preprocessOnly, params.pipeline])
  const modelsMissing = missingModels.length > 0

  // Цель из стора галереи (кнопка «ControlNet (движение)» на карточке)
  useEffect(() => {
    if (!storeTarget) return
    const file = gallery.files.find(
      (f) => f.filename === storeTarget.filename && f.subfolder === storeTarget.subfolder,
    )
    if (file) {
      setSourceSafe(file as ControlNetSource)
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

  // (правка 502) Сброс промпта при смене источника УДАЛЁН (был useEffect
  // setPrompt('') по [source]): промпт пользователя ценнее источника.

  // Клик-выбор файла: <input type='file'> + ref
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

  // (правка 510) Референсы для ControlNet уменьшаем до 1024px по короткой
  // стороне ПЕРЕД загрузкой. Режим ref_image_size='max' у ноды
  // MiniMaxH3ReferenceToVideo реф не уменьшает (потолок 2048px): квадрат
  // 2048² после патчификации — ~4k визуальных токенов, сопоставимо со всем
  // видеорядом (~8.6k на 5 с) — при SLA-спарсити рефы вытесняли контрольные
  // токены depth/canny (камера уплывала от болванки, картинка
  // деформировалась). 1024px ≈ 1k токенов: идентичность лица заметно лучше
  // 'match' (~400 токенов при 480p), а контроль движения не страдает.
  // На 'match' не влияет: нода всё равно уменьшает реф до площади кадра.
  const REF_SHORT_EDGE_CAP = 1024
  const downscaleRef = useCallback(async (file: File): Promise<File> => {
    try {
      const bmp = await createImageBitmap(file)
      const short = Math.min(bmp.width, bmp.height)
      if (short <= REF_SHORT_EDGE_CAP) { bmp.close(); return file }
      const scale = REF_SHORT_EDGE_CAP / short
      const w = Math.max(2, Math.round(bmp.width * scale))
      const h = Math.max(2, Math.round(bmp.height * scale))
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) { bmp.close(); return file }
      ctx.drawImage(bmp, 0, 0, w, h)
      bmp.close()
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'))
      if (!blob) return file
      return new File([blob], file.name.replace(/\.[a-z0-9]+$/i, '') + '.png', { type: 'image/png' })
    } catch {
      return file // не смогли прочитать — грузим как есть
    }
  }, [])

  const addRefFiles = useCallback(async (files: File[]) => {
    const images = files.filter((f) => /^image\//.test(f.type) || /\.(png|jpe?g|webp|bmp|tiff?)$/i.test(f.name))
    if (!images.length) { toast.error('Референсы — только картинки (png, jpg, webp)'); return }
    // (правка 502) Актуальный список — из стора (реактивный refImages здесь
    // мог бы устареть в момент длительной загрузки).
    const room = 9 - useControlNetTarget.getState().refImages.length
    if (room <= 0) { toast.error('Максимум 9 картинок-референсов'); return }
    if (images.length > room) toast.error(`Максимум 9 референсов — добавлено ${room}`)
    setUploadingRefs(true)
    try {
      for (const raw of images.slice(0, room)) {
        try {
          const file = await downscaleRef(raw) // (правка 510)
          const { path } = await uploadInputFile(file)
          useControlNetTarget.getState().addRefImages([{
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
  }, [downscaleRef])

  const removeRef = useCallback((id: string) => {
    useControlNetTarget.getState().removeRefImage(id)
  }, [])

  const start = useCallback(async () => {
    const src = sourceRef.current
    if (!src) {
      toast.error('Сначала выберите контрольное видео')
      return
    }
    if (uploadingSrc) {
      toast.error('Видео ещё загружается')
      return
    }
    if (modelsMissing) {
      toast.error('Сначала скачайте модели ControlNet (Настройки → Модели)')
      return
    }

    // Промпт/seed/референсы — свежие из стора (submit-body собирается в момент
    // клика, реактивные значения тут не обязательны).
    const st = useControlNetTarget.getState()
    const body: Record<string, unknown> = {
      ...(src.inputSource
        ? { inputSource: src.inputSource }
        : { sourceFilename: src.filename, sourceSubfolder: src.subfolder ?? '' }),
      prompt: st.prompt.trim() || undefined,
      seed: st.seed,
      duration: params.duration,
      targetShortSide: params.targetShortSide,
      controlType: params.controlType,
      preprocessOnly: params.preprocessOnly || undefined,
      // (правка 727) Куда класть результат: по умолчанию папка исходника,
      // пользователь может выбрать другую (как на вкладке «Генерация»).
      outputSubfolder: st.outputFolder,
      refImageSize: params.refImageSize,
      compress: params.compressSource || undefined,
      pipeline: params.pipeline,
      // (правка 511) Доп. параметры — как на вкладке «Генерация»
      draftSteps: params.draftSteps,
      firstSamplerSteps: params.firstSamplerSteps,
      // (правка 719) Всего шагов в расписании pass 1 (undefined = авто 2× сплита).
      firstSamplerTotalSteps: params.firstSamplerTotalSteps,
      pass1Sampler: params.pass1Sampler,
      pass1Scheduler: params.pass1Scheduler,
      pass2Sampler: params.pass2Sampler,
      sigmaVariant: params.sigmaVariant,
      lowResMP: params.lowResMP,
      ...(st.refImages.length > 0 && { refImages: st.refImages.map((r) => r.path) }),
      // (правка 512) Veda/Sparse/lowVRAM — из настроек приложения (useGenStore.video)
      ...(() => {
        const v = useGenStore.getState().video
        return {
          sparseAttention: v.sparseAttention,
          sparseTau: v.sparseTau,
          sparseStartPercent: v.sparseStartPercent,
          sparseEndPercent: v.sparseEndPercent,
          sparseMinTokens: v.sparseMinTokens,
          sparseExtraTokens: v.sparseExtraTokens,
          vedaAttention: v.vedaAttention,
          vedaGeneratedSparsity: v.vedaGeneratedSparsity,
          vedaReferenceSparsity: v.vedaReferenceSparsity,
          vedaFullAttentionLayers: v.vedaFullAttentionLayers,
          vedaFullAttentionSteps: v.vedaFullAttentionSteps,
          vedaVerbose: v.vedaVerbose,
          lowVramAttention: v.lowVramAttention,
          chunkFeedForward: v.chunkFeedForward,
          chunkFFChunks: v.chunkFFChunks,
          chunkFFThreshold: v.chunkFFThreshold,
        }
      })(),
    }
    await jobSubmit(body)
  }, [uploadingSrc, params, modelsMissing, jobSubmit])

  const cancel = useCallback(() => { void jobCancel() }, [jobCancel])
  const reset = useCallback(() => { jobReset() }, [jobReset])

  // (правка 515) Полное поле промпта — как на вкладке «Генерация»:
  //  • MentionTextarea с onKeyDown Ctrl+Enter → start (как в generate-view);
  //  • PromptEditButton (карандаш) + PromptEditorDialog (полноэкранный
  //    редактор: вставка тегов, реплики, кинематографический словарь,
  //    скелеты сцен, история, примеры, «Улучшить промпт»);
  //  • VoiceInputButton (микрафон + hotkey R/К) — диктовка в поле;
  //  • PromptQuality — живые подсказки по тегам/репликам/длине;
  //  • История + Готовые примеры — портал-дропдауны (как в generate-view);
  //  • Запись в usePromptHistory.add() при каждом успешном сабмите
  //    (в generate-view — там же, в handleGenerate, до POST).
  const [promptEditorOpen, setPromptEditorOpen] = useState(false)
  // (правка 691) «Исправить промпт» прямо из поля: задание + промпт уходят
  // в controlnet-чат ассистента (requestImprovePrompt).
  const [fixOpen, setFixOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [examplesOpen, setExamplesOpen] = useState(false)
  const historyBtnRef = useRef<HTMLButtonElement>(null)
  const examplesBtnRef = useRef<HTMLButtonElement>(null)
  const historyEntries = usePromptHistory((s) => s.entries)
  const toggleHistoryFavorite = usePromptHistory((s) => s.toggleFavorite)
  const removeHistoryEntry = usePromptHistory((s) => s.remove)
  const clearHistory = usePromptHistory((s) => s.clear)

  const dropdownPos = (anchor: HTMLElement): React.CSSProperties => {
    const r = anchor.getBoundingClientRect()
    const width = 340
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8))
    const top = Math.min(r.bottom + 6, window.innerHeight - 80)
    return { top, left, width }
  }

  const applyExample = useCallback(
    (text: string) => {
      const old = useControlNetTarget.getState().prompt
      useControlNetTarget.getState().setPrompt(text)
      setExamplesOpen(false)
      if (old.trim()) {
        toast.success('Пример вставлен (прежний промпт заменён)', {
          action: { label: 'Отменить', onClick: () => useControlNetTarget.getState().setPrompt(old) },
        })
      }
    },
    [],
  )

  // Ctrl+Enter — запустить (как в generate-view.handleKeyDown)
  const canStart = Boolean(source) && !modelsMissing && !params.preprocessOnly
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && canStart) {
        e.preventDefault()
        void start()
      }
    },
    [start, canStart],
  )

  // (правка 515) Запись в историю — при каждом успешном сабмите (как в
  // generate-view: usePromptHistory.add(prompt) до POST). Обёртка над start().
  const startWithHistory = useCallback(async () => {
    const p = useControlNetTarget.getState().prompt.trim()
    if (p) usePromptHistory.getState().add(p)
    await start()
  }, [start])

  const srcThumb = (f: ControlNetSource) =>
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
            <WaypointsIcon className="w-4 h-4 text-orange-400" />
            <h2 className="text-sm font-semibold text-foreground">ControlNet</h2>
          </div>
          <p className="text-[10px] text-muted-foreground/70 -mt-2">
            Генерация видео, следующего движению контрольного ролика (3D-болванка, превиз или референс) покадрово.
          </p>

          {/* Баннер недостающих моделей */}
          {modelsMissing && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
              <AlertTriangleIcon className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <p className="text-xs text-amber-300">
                Для режима ControlNet нужно скачать модели: {missingModels.join(', ')} — Настройки → Модели (категория Препроцессоры)
              </p>
            </div>
          )}

          {/* (правка 504) Режим: полный (генерация Minimax по контролю) или
              «только карта» — сохранить depth/canny-видео без генерации,
              для переиспользования вне программы. */}
          <div className="space-y-1">
            <Label
              className="text-xs text-muted-foreground"
              title="Драфт — один проход (быстро). Полный — два прохода: черновик в низком разрешении, затем апскейл латента и дорисовка в полном (дольше, качественнее). Карта — просто сохранить Depth/Canny-видео без генерации, чтобы использовать его в других программах."
            >
              Режим
            </Label>
            {/* (правка 508) Три режима: драфт (однопроходный), полный
                (двухпроходный, бейдж «ControlNet x2»), карта (только
                препроцессинг, preprocessOnly).
                (правка 511) «Карта» недоступна в режиме «Прямой» — карта не строится. */}
            <div className="grid grid-cols-3 gap-1.5">
              {([
                ['draft', 'Драфт', 'Один проход — быстро'],
                ['full', 'Полный', 'Два прохода: low-res черновик → апскейл латента → дорисовка в полном разрешении'],
                ['map', 'Карта', 'Сохранить Depth/Canny-видео без генерации'],
              ] as const).map(([v, label, hint]) => {
                const active = v === 'map'
                  ? params.preprocessOnly
                  : !params.preprocessOnly && params.pipeline === v
                // (правка 511) «Карта» недоступна в режиме «Прямой»
                const mapDisabled = busy || (v === 'map' && params.controlType === 'direct')
                return (
                  <button
                    key={v}
                    type="button"
                    title={v === 'map' && params.controlType === 'direct' ? 'Недоступно в режиме «Прямой»' : hint}
                    disabled={mapDisabled}
                    onClick={() => patchParams(
                      v === 'map'
                        ? { preprocessOnly: true }
                        : { preprocessOnly: false, pipeline: v },
                    )}
                    className={cn(
                      'h-8 rounded-md border px-1 text-xs font-medium transition-all min-w-0 truncate text-center',
                      mapDisabled && 'opacity-40 cursor-not-allowed',
                      active
                        ? 'bg-orange-500/15 border-orange-500/50 text-orange-300'
                        : 'bg-[var(--surface-2)] border-border text-muted-foreground hover:border-orange-500/30',
                    )}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Источник */}
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground font-medium">Источник (контрольное видео)</Label>
            {source ? (
              <div
                onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
                onDragLeave={() => setDragOver(false)}
                onDrop={dropHandler}
                className={cn(
                  'flex items-center gap-3 rounded-lg border bg-[var(--surface-2)] p-2 transition-all',
                  dragOver ? 'border-orange-400 ring-1 ring-orange-400/50' : 'border-border',
                )}
              >
                {/* Превью: src — САМО видео (source.url); JPEG-постер в poster=
                    (URL с &width=320 отдаёт картинку, не видео). У blob:-URL
                    (файл с диска) постера нет.
                    (правка 719) Клик — просмотр во весь экран (как на
                    вкладке «Генерация»). */}
                <RefPreviewThumb
                  kind="video"
                  name={source.filename}
                  url={source.url}
                  className="w-20 h-12 rounded object-cover bg-black shrink-0"
                  title="Открыть контрольное видео во весь экран"
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
                  {uploadingSrc && <p className="text-[10px] text-orange-400">загрузка…</p>}
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
                  dragOver ? 'border-orange-400 bg-orange-500/10' : 'border-border hover:border-orange-500/40 hover:bg-[var(--surface-2)]',
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
            {/* (правка 506) Сжатие болванки до 480p — как у видео-рефов
                «Генерации» (правка 493): depth/canny не нужно высокое
                разрешение, а препроцессинг и VAE-энкод заметно легче. */}
            <label
              className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer"
              title="Перед обработкой видео ресайзится до 480p с сохранением пропорций (сервер, кэш) — быстрее препроцессинг и меньше VRAM. Для переноса движения высокое разрешение болванки не нужно."
            >
              <input
                type="checkbox"
                checked={params.compressSource}
                onChange={(e) => patchParams({ compressSource: e.target.checked })}
                className="accent-orange-500"
              />
              Сжать видео до 480p
            </label>
          </div>

          {/* (правка 502) Поле промпта переехало наверх центральной колонки
              (как на вкладке «Генерация») — в левой панели его больше нет. */}

          {/* (правка 498) Картинки-референсы: персонаж/локация/кадр.
              (правка 504) В режиме «только карта» не используются. */}
          <div className={cn('space-y-1.5', params.preprocessOnly && 'opacity-40 pointer-events-none select-none')}>
            <Label
              className="text-xs text-muted-foreground font-medium flex items-center justify-between"
              title="Картинки персонажа, локации или кадра — модель сохранит их внешность в каждом кадре. В промпте ссылайтесь на них как <Picture 1>, <Picture 2> и т.д."
            >
              <span>Референсы (персонаж / локация / кадр){params.preprocessOnly ? ' — не используются в режиме карты' : ''}</span>
              {refImages.length > 0 && <span className="text-[10px] font-normal">{refImages.length}/9</span>}
            </Label>
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
                refsDragOver ? 'border-orange-400 bg-orange-500/10' : 'border-border hover:border-orange-500/40 hover:bg-[var(--surface-2)]',
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
                <span className="text-orange-400">Загрузка референсов…</span>
              ) : (
                <span className="flex items-center justify-center gap-1.5">
                  <UploadIcon className="w-3.5 h-3.5" />
                  Перетащите или выберите картинки (до 9)
                </span>
              )}
            </div>
            {refImages.length > 0 && (
              <div className="grid grid-cols-4 gap-1.5">
                {refImages.map((r, i) => (
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
                    <span className="absolute left-0.5 bottom-0.5 text-[9px] font-mono px-1 rounded bg-black/70 text-orange-300 pointer-events-none">
                      &lt;Picture {i + 1}&gt;
                    </span>
                    {!busy && (
                      <button
                        onClick={() => removeRef(r.id)}
                        className="absolute right-0.5 top-0.5 p-0.5 rounded bg-black/70 text-muted-foreground hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                        title={`Удалить (${r.name})`}
                      >
                        <XIcon className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
            <p className="text-[10px] text-muted-foreground/60">
              В промпте ссылайтесь на них как &lt;Picture 1&gt;, &lt;Picture 2&gt;…
            </p>

            {/* (правка 505) Рефы: режим размера — как на вкладке «Генерация»
                (правка 277): Match — быстрее, Max — точнее детали. */}
            <div className="space-y-1 pt-1">
              <Label
                className="text-xs text-muted-foreground"
                title="Как обрабатывать загруженные картинки. Match — уменьшает референс до размера кадра (быстрее, но лицо может терять сходство). Max — сохраняет детали референса (точнее идентичность, медленнее). В ControlNet референсы ограничены 1024px при загрузке — иначе в режиме Max они вытесняют контроль движения и ломают картинку."
              >
                Рефы: режим размера
              </Label>
              <div className="grid grid-cols-2 gap-1.5">
                {(['match', 'max'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => patchParams({ refImageSize: m })}
                    className={cn(
                      'px-2 py-1.5 rounded-md border text-xs transition-colors',
                      params.refImageSize === m
                        ? 'border-orange-500/40 text-orange-300 bg-orange-500/10'
                        : 'border-border text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {m === 'match' ? 'Match (быстро)' : 'Max (детально)'}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Тип контроля (правка 511) — добавлен «Прямой» */}
          <div className="space-y-1">
            <Label
              className="text-xs text-muted-foreground"
              title="Глубина — карта расстояний (сцены, объёмы). Контуры — линии краёв (рисунки, чертежи). Поза — скелет тела (DWPose). Прямой — видео подаётся как обычный видео-референс, без карт (как на вкладке «Генерация»)."
            >
              Тип контроля
            </Label>
            <Select
              value={params.controlType}
              onValueChange={(v) => patchParams({
                controlType: v as 'depth' | 'canny' | 'direct' | 'pose', // (правка 512)
                // (правка 511) «Прямой» несовместим с режимом «Карта» (карта не строится)
                ...(v === 'direct' && params.preprocessOnly ? { preprocessOnly: false } : {}),
              })}
            >
              <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-[var(--surface-3)] border-border">
                <SelectItem value="depth">Глубина (Depth)</SelectItem>
                <SelectItem value="canny">Контуры (Canny)</SelectItem>
                <SelectItem value="pose">Поза (DWPose)</SelectItem>
                <SelectItem value="direct">Прямой (без карт)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Длительность */}
          <div className="space-y-1">
            <SettingSlider
              label="Длительность, сек"
              labelTitle="Длительность результата в секундах."
              value={params.duration}
              min={1}
              max={30}
              step={1}
              onChange={(v) => patchParams({ duration: Math.round(v) })}
              formatValue={(v) => `${v} с`}
            />
            <p className="text-[10px] text-muted-foreground/60">
              Если контрольное видео короче — длительность обрежется под него.
            </p>
          </div>

          {/* Короткая сторона */}
          <div className="space-y-1">
            <Label
              className="text-xs text-muted-foreground"
              title="Короткая сторона результата. Длинная считается по пропорции контрольного видео."
            >
              Короткая сторона результата
            </Label>
            <Select
              value={String(params.targetShortSide)}
              onValueChange={(v) => patchParams({ targetShortSide: parseInt(v, 10) })}
            >
              <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-[var(--surface-3)] border-border">
                {[480, 576, 720, 1080].map((n) => <SelectItem key={n} value={String(n)}>{n}p</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          {/* Дополнительные параметры: Seed */}
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="w-full flex items-center justify-between px-3 py-2 rounded-lg bg-[var(--surface-2)] border border-border hover:border-orange-500/30 transition-all text-left"
            >
              <span className="text-xs font-medium text-muted-foreground">Дополнительные параметры</span>
              <span className={cn('text-[10px] text-muted-foreground transition-transform', showAdvanced && 'rotate-180')}>▼</span>
            </button>

            {showAdvanced && (
              <div className="space-y-3 pl-1">
                {/* Seed */}
                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground flex items-center justify-between">
                    <span>Seed</span>
                    <button
                      onClick={() => setSeed(-1)}
                      className="p-1 rounded hover:bg-[var(--surface-3)] transition-colors"
                      title="Случайный seed (-1)"
                    >
                      <DicesIcon className="w-4 h-4 text-muted-foreground" />
                    </button>
                  </Label>
                  <Input
                    type="number"
                    value={seed}
                    onChange={(e) => {
                      const n = e.target.valueAsNumber
                      const MAX_SEED = 2 ** 31 - 1
                      if (!Number.isFinite(n)) { setSeed(-1); return }
                      setSeed(n < 0 ? -1 : Math.min(Math.trunc(n), MAX_SEED))
                    }}
                    className={cn('h-9 bg-[var(--surface-2)] border-border text-sm font-mono')}
                  />
                </div>

                {/* (правка 511) Шаги + сэмплер + планировщик — как на вкладке «Генерация» */}
                {/* Pass 1 (в драфте — единственный проход) */}
                <div className="space-y-1.5">
                  <button
                    type="button"
                    onClick={() => setShowPass1(!showPass1)}
                    className="w-full flex items-center justify-between px-3 py-1.5 rounded-md bg-[var(--surface-3)] border border-border/60 hover:border-orange-500/30 transition-all text-left"
                  >
                    <span className="text-xs font-medium text-muted-foreground">
                      {isDraft ? 'Драфт — единственный проход' : 'Pass 1 — Low-res'}
                    </span>
                    <span className={cn('text-[10px] text-muted-foreground transition-transform', showPass1 && 'rotate-180')}>▼</span>
                  </button>

                  {showPass1 && (
                    <div className="space-y-3 pl-1">
                      {/* Full: low-res разрешение канвы pass 1 */}
                      {!isDraft && (
                        <div className="space-y-1">
                          <SettingSlider
                            label="Low-res разрешение (MP)"
                            labelTitle="Размер чернового прохода: чем меньше, тем быстрее. В конце видео всё равно доводится до полного разрешения."
                            value={params.lowResMP}
                            onChange={(v) => patchParams({ lowResMP: Math.min(2, Math.max(0.2, Math.round(v * 100) / 100)) })}
                            min={0.2}
                            max={2}
                            step={0.05}
                            inputMin={0.1}
                            inputMax={2}
                            inputHint={`0.1–2.0 MP — размер чернового прохода`}
                          />
                        </div>
                      )}

                      {/* Шаги */}
                      <div className="space-y-1">
                        <SettingSlider
                          label={isDraft ? 'Шаги драфта' : 'Шаги сэмплера (Pass 1)'}
                          labelTitle={isDraft
                            ? 'Сколько шагов делает модель, рисуя видео. 4 — стандарт: быстро и хорошо; больше — аккуратнее, но медленнее.'
                            : 'Сколько шагов делает черновой проход. Больше — точнее, но медленнее.'}
                          value={isDraft ? params.draftSteps : params.firstSamplerSteps}
                          onChange={(v) => {
                            const n = Math.round(v)
                            if (isDraft) patchParams({ draftSteps: n })
                            else patchParams({ firstSamplerSteps: n })
                          }}
                          min={2}
                          max={isDraft ? 16 : 30}
                          step={1}
                          inputMin={1}
                          inputMax={128}
                          inputHint={isDraft ? '2–30 шагов единственного прохода (стандарт — 4)' : '1–128 шагов. Выше 30 — заметно дольше генерация'}
                        />
                      </div>

                      {/* (правка 719) Всего шагов в расписании pass 1 — задаётся
                          отдельно от точки сплита (иначе «N из 2N» — единственный
                          вариант). undefined = авто (2× сплита). */}
                      {!isDraft && (
                        <div className="space-y-1">
                          <SettingSlider
                            label="Всего шагов (pass 1)"
                            labelTitle={
                              'Длина расписания BasicScheduler, из которого SplitSigmas берёт ' +
                              'верхнюю часть для чернового прохода. По умолчанию — вдвое больше ' +
                              'точки сплита («N из 2N»).'
                            }
                            value={cnTotal}
                            onChange={(v) => patchParams({ firstSamplerTotalSteps: Math.round(v) })}
                            min={2}
                            max={64}
                            step={1}
                            inputMin={2}
                            inputMax={128}
                            inputHint="2–128 шагов расписания. По умолчанию — вдвое больше сплита"
                          />
                          <p className="text-[10px] text-muted-foreground/70 leading-snug">
                            Pass 1: {cnSplit} из {cnTotal} · σ 1.0 → {cnSigmaEnd.toFixed(3)} ·
                            Pass 2: σ {cnPass2Start} → 0 ({cnPass2Steps} шага)
                          </p>
                        </div>
                      )}

                      {/* Сэмплер Pass 1 */}
                      <div className="space-y-1">
                        <Label
                          className="text-xs text-muted-foreground"
                          title="Способ, которым модель рисует кадры. Влияет на детализацию и стабильность; если не уверены — оставьте euler."
                        >
                          Сэмплер
                        </Label>
                        <Select
                          value={params.pass1Sampler}
                          onValueChange={(v) => patchParams({ pass1Sampler: v })}
                        >
                          <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                            <SelectValue placeholder="Выберите" />
                          </SelectTrigger>
                          <SelectContent className="bg-[var(--surface-3)] border-border">
                            {SAMPLER_OPTIONS.map((o) => (
                              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      {/* Планировщик Pass 1 */}
                      <div className="space-y-1">
                        <Label
                          className="text-xs text-muted-foreground"
                          title="Как модель распределяет работу между шагами. Обычно лучше оставить simple."
                        >
                          Планировщик
                        </Label>
                        <Select
                          value={params.pass1Scheduler}
                          onValueChange={(v) => patchParams({ pass1Scheduler: v })}
                        >
                          <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                            <SelectValue placeholder="Выберите" />
                          </SelectTrigger>
                          <SelectContent className="bg-[var(--surface-3)] border-border">
                            {SCHEDULER_OPTIONS.map((o) => (
                              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  )}
                </div>

                {/* Pass 2 — только пайплайн 'full' */}
                {!isDraft && (
                  <div className="space-y-1.5">
                    <button
                      type="button"
                      onClick={() => setShowPass2(!showPass2)}
                      className="w-full flex items-center justify-between px-3 py-1.5 rounded-md bg-[var(--surface-3)] border border-border/60 hover:border-orange-500/30 transition-all text-left"
                    >
                      <span className="text-xs font-medium text-muted-foreground">Pass 2 — High-res</span>
                      <span className={cn('text-[10px] text-muted-foreground transition-transform', showPass2 && 'rotate-180')}>▼</span>
                    </button>

                    {showPass2 && (
                      <div className="space-y-3 pl-1">
                        {/* Sigma-профиль (шаги pass 2) */}
                        <div className="space-y-1">
                          <Label
                            className="text-xs text-muted-foreground"
                            title="Сколько шагов делает финальный проход детализации. Больше — чётче картинка, но дольше."
                          >
                            Sigma-профиль (шаги)
                          </Label>
                          <Select
                            value={params.sigmaVariant}
                            onValueChange={(v) => patchParams({ sigmaVariant: v })}
                          >
                            <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                              <SelectValue placeholder="Выберите" />
                            </SelectTrigger>
                            <SelectContent className="bg-[var(--surface-3)] border-border">
                              <SelectItem value="3step">3 шага (быстрее)</SelectItem>
                              <SelectItem value="4step">4 шага (баланс)</SelectItem>
                              <SelectItem value="5step">5 шагов (высокое)</SelectItem>
                              <SelectItem value="6step">6 шагов (оч. высокое)</SelectItem>
                              <SelectItem value="7step">7 шагов (макс.)</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>

                        {/* Сэмплер Pass 2 */}
                        <div className="space-y-1">
                          <Label
                            className="text-xs text-muted-foreground"
                            title="Способ, которым модель рисует кадры. Влияет на детализацию и стабильность; если не уверены — оставьте euler."
                          >
                            Сэмплер
                          </Label>
                          <Select
                            value={params.pass2Sampler}
                            onValueChange={(v) => patchParams({ pass2Sampler: v })}
                          >
                            <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                              <SelectValue placeholder="Выберите" />
                            </SelectTrigger>
                            <SelectContent className="bg-[var(--surface-3)] border-border">
                              {SAMPLER_OPTIONS.map((o) => (
                                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* (правка 727) Папка результата — как на вкладке «Генерация».
              По умолчанию — папка контрольного видео: переиспользование
              ролика из папки не разбрасывает результаты по корню. */}
          {gallery.folders.length > 0 && (
            <div className="space-y-1.5">
              <Label
                className="text-xs text-muted-foreground"
                title="Куда сохранять результат. По умолчанию — папка исходного видео."
              >
                Папка результата
              </Label>
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setFolderMenuOpen(!folderMenuOpen)}
                  disabled={busy}
                  className={cn(
                    'w-full h-9 inline-flex items-center gap-1.5 px-3 rounded-lg border text-xs transition-colors',
                    outputFolder
                      ? 'border-violet-500/40 bg-violet-500/10 text-violet-300'
                      : 'border-border bg-[var(--surface-2)] text-muted-foreground hover:text-foreground',
                    busy && 'opacity-50 pointer-events-none',
                  )}
                  title={outputFolder
                    ? `Папка результата: ${outputFolder}`
                    : 'Папка результата: общая папка output'}
                >
                  <FolderIcon className="w-3.5 h-3.5" />
                  <span className="flex-1 text-left truncate">{outputFolder || 'Общая папка'}</span>
                  <ChevronDownIcon className={cn('w-3 h-3 transition-transform', folderMenuOpen && 'rotate-180')} />
                </button>
                {folderMenuOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setFolderMenuOpen(false)} />
                    <div className="absolute bottom-full mb-1.5 left-0 right-0 z-50 rounded-lg border border-border bg-[var(--surface-2)] shadow-xl p-1 max-h-64 overflow-y-auto">
                      <button
                        type="button"
                        onClick={() => { setOutputFolder(''); setFolderMenuOpen(false) }}
                        className={cn(
                          'w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs text-left transition-colors',
                          !outputFolder ? 'bg-violet-500/10 text-violet-300' : 'hover:bg-[var(--surface-3)] text-foreground/80',
                        )}
                      >
                        <FilmIcon className="w-3.5 h-3.5 shrink-0" />
                        <span className="flex-1 truncate">Общая папка</span>
                      </button>
                      {gallery.folders.map((f) => {
                        // (правка 495) Вложенные папки: отступ по глубине.
                        const depth = f.split('/').length - 1
                        const leaf = f.slice(f.lastIndexOf('/') + 1)
                        return (
                          <button
                            key={f}
                            type="button"
                            onClick={() => { setOutputFolder(f); setFolderMenuOpen(false) }}
                            title={depth > 0 ? f : undefined}
                            style={depth > 0 ? { paddingLeft: 10 + depth * 14 } : undefined}
                            className={cn(
                              'w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs text-left transition-colors',
                              outputFolder === f ? 'bg-violet-500/10 text-violet-300' : 'hover:bg-[var(--surface-3)] text-foreground/80',
                            )}
                          >
                            <FolderIcon className="w-3.5 h-3.5 shrink-0" />
                            <span className="flex-1 truncate">{leaf}</span>
                          </button>
                        )
                      })}
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Запуск */}
          <div className="flex gap-2 pt-1">
            <Button onClick={startWithHistory} disabled={!source || modelsMissing || uploadingSrc} className="flex-1 gap-1.5">
              {busy ? <Loader2Icon className="w-4 h-4 animate-spin" /> : <PlayIcon className="w-4 h-4" />}
              {params.preprocessOnly ? 'Сохранить карту' : 'Сгенерировать'}
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
            // (правка 512) Pass 1/2 показываем как на вкладке «Генерация».
            // 'passes': full → «Pass 1/2 · черновик» / «Pass 2/2 · детализация»;
            //            draft → «Проход» (totalStages=1).
            stageKind="passes"
          />
        </div>
      </aside>

      {/* ═══ Центральная колонка: промпт + галерея (правка 502) ═══ */}
      <section className="flex-1 min-w-0 flex flex-col overflow-hidden bg-[var(--surface-1)]">
        {/* (правка 515) Карточка промпта — ТОЧНО как на вкладке «Генерация»:
            MentionTextarea + PromptEditButton (карандаш) + VoiceInputButton
            (диктовка) + PromptEditorDialog (полноэкранный редактор) +
            PromptQuality (живые подсказки) + История + Готовые примеры. */}
        <div className="p-5 pb-3 space-y-3 aurora-bg shrink-0">
          <div className="flex items-center justify-between shrink-0">
            <Label className="text-sm font-medium text-foreground flex items-center gap-2">
              <SparklesIcon className="w-4 h-4 text-orange-400" />
              Описание видео
            </Label>
            <span className="text-[10px] text-muted-foreground/70 hidden sm:block">
              <kbd className="px-1.5 py-0.5 rounded border border-border bg-[var(--surface-2)] font-mono text-[10px]">Ctrl</kbd>
              {' + '}
              <kbd className="px-1.5 py-0.5 rounded border border-border bg-[var(--surface-2)] font-mono text-[10px]">Enter</kbd>
              {' — запустить'}
            </span>
          </div>

          <div className="relative">
            <MentionTextarea
              value={prompt}
              onChange={setPrompt}
              onKeyDown={handleKeyDown}
              placeholder="A character with <Picture 1> [what they are doing], [place, time of day], [lighting and mood]. The camera [movement/shot]. He/She says: <d>short line.</d> …"
              mentions={params.preprocessOnly ? undefined : refImages.map((r, i): MentionItem => ({
                id: r.id,
                label: `Picture ${i + 1}`,
                trigger: `<Picture ${i + 1}>`,
                kind: 'image',
                color: 'bg-purple-500/15 text-purple-400',
                previewUrl: r.previewUrl,
              }))}
              className="h-[220px] pr-12"
            />
            {/* (правка 717) Кнопки поля — вертикальная колонка с ровными
                интервалами (PromptFieldTools). */}
            <PromptFieldTools>
              {/* (правка 515) Карандаш — открывает полноэкранный редактор промпта */}
              <PromptEditButton onOpen={() => setPromptEditorOpen(true)} />
              {/* (правка 691) «Очистить» + «Исправить» — над микрофоном */}
              <PromptClearButton
                disabled={!prompt.trim()}
                onClear={() => setPrompt('')}
              />
              <PromptFixButton onFix={() => setFixOpen(true)} />
            </PromptFieldTools>
            {/* (правка 515) Микрафон — диктовка в поле (hotkey R/К) */}
            <VoiceInputButton
              hotkey
              onText={(t) => {
                const cur = prompt
                setPrompt((cur ? cur.trimEnd() : '') ? `${cur.trimEnd()} ${t}` : t)
              }}
            />
            {/* (правка 515) Полноэкранный редактор — как на вкладке «Генерация»:
                вставка тегов/реплик/кинословаря/скелетов, история, примеры,
                «Улучшить промпт» (уходит в controlnet-чат ассистента). */}
            <PromptEditorDialog
              open={promptEditorOpen}
              onOpenChange={setPromptEditorOpen}
              initialText={prompt}
              onSave={setPrompt}
              onSaveAndRun={() => { void startWithHistory() }}
              placeholder="A character with <Picture 1> [what they are doing], [place, time of day], [lighting and mood]. …"
              mentions={params.preprocessOnly ? undefined : refImages.map((r, i): MentionItem => ({
                id: r.id,
                label: `Picture ${i + 1}`,
                trigger: `<Picture ${i + 1}>`,
                kind: 'image',
                color: 'bg-purple-500/15 text-purple-400',
                previewUrl: r.previewUrl,
              }))}
              improveOptions={{ mode: 'controlnet' }}
            />
            {/* (правка 691) Диалог «Исправить промпт» из поля: задание +
                промпт уходят в controlnet-чат ассистента. */}
            <PromptFixDialog
              open={fixOpen}
              onOpenChange={setFixOpen}
              hint="Промпт и ваше задание уйдут в чат ассистента вкладки «ControlNet» — ответ можно будет вставить обратно кнопкой «В промпт». Ctrl+Enter — отправить, Esc — отмена."
              onSubmit={(req) => requestImprovePrompt(prompt, { mode: 'controlnet', fixRequest: req })}
            />
          </div>

          {/* (правка 515) Живые подсказки качества — как на вкладке «Генерация» */}
          <PromptQuality prompt={prompt} refsCount={refImages.length} />

          {/* (правка 515) История + Готовые примеры — портал-дропдауны, как в generate-view */}
          <div className="flex items-center gap-1.5">
            <button
              ref={historyBtnRef}
              type="button"
              onClick={() => {
                setHistoryOpen((o) => !o)
                setExamplesOpen(false)
              }}
              className={cn(
                'inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] border transition-colors',
                historyOpen
                  ? 'border-orange-500/40 text-orange-300 bg-orange-500/10'
                  : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              <HistoryIcon className="w-3 h-3" />
              История
              {historyEntries.length > 0 && (
                <span className="ml-0.5 px-1 rounded-full bg-[var(--surface-3)] text-[10px] text-muted-foreground">
                  {historyEntries.length}
                </span>
              )}
            </button>
            <button
              ref={examplesBtnRef}
              type="button"
              onClick={() => {
                setExamplesOpen((o) => !o)
                setHistoryOpen(false)
              }}
              className={cn(
                'inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] border transition-colors',
                examplesOpen
                  ? 'border-orange-500/40 text-orange-300 bg-orange-500/10'
                  : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              <SparklesIcon className="w-3 h-3" />
              Примеры
            </button>
          </div>

          {(historyOpen || examplesOpen) && (
            <div
              className="fixed inset-0 z-[95]"
              onClick={() => {
                setHistoryOpen(false)
                setExamplesOpen(false)
              }}
            />
          )}
          {historyOpen &&
            historyBtnRef.current &&
            createPortal(
              <div
                className="fixed z-[100] w-[340px] max-h-80 overflow-y-auto rounded-lg border border-border bg-[var(--surface-3)] shadow-2xl shadow-black/60"
                style={dropdownPos(historyBtnRef.current)}
              >
                <div className="flex items-center justify-between px-2.5 py-1.5 border-b border-border sticky top-0 bg-[var(--surface-3)]">
                  <span className="text-[10px] font-semibold text-foreground">История промптов</span>
                  {historyEntries.length > 0 && (
                    <button
                      type="button"
                      onClick={clearHistory}
                      className="text-[10px] text-muted-foreground hover:text-red-400"
                    >
                      очистить всё
                    </button>
                  )}
                </div>
                {historyEntries.length === 0 && (
                  <p className="px-2.5 py-3 text-xs text-muted-foreground">
                    Пока пусто — запущенные промпты сохраняются здесь автоматически.
                  </p>
                )}
                {historyEntries.map((e) => (
                  <div
                    key={e.id}
                    className="group flex items-start gap-2 px-2.5 py-1.5 hover:bg-white/5 cursor-pointer"
                    onClick={() => {
                      setPrompt(e.text)
                      setHistoryOpen(false)
                      toast.success('Промпт вставлен из истории')
                    }}
                  >
                    <button
                      type="button"
                      onClick={(ev) => {
                        ev.stopPropagation()
                        toggleHistoryFavorite(e.id)
                      }}
                      title={e.favorite ? 'Убрать из избранного' : 'В избранное'}
                      className={cn(
                        'shrink-0 mt-0.5 w-4 h-4 flex items-center justify-center transition-colors',
                        e.favorite ? 'text-amber-400' : 'text-muted-foreground/40 hover:text-amber-400',
                      )}
                    >
                      <StarIcon className="w-3 h-3" fill={e.favorite ? 'currentColor' : 'none'} />
                    </button>
                    <p className="flex-1 min-w-0 text-xs text-foreground/90 leading-snug line-clamp-2 break-words">
                      {e.text}
                    </p>
                    <button
                      type="button"
                      onClick={(ev) => {
                        ev.stopPropagation()
                        removeHistoryEntry(e.id)
                      }}
                      className="shrink-0 mt-0.5 w-4 h-4 flex items-center justify-center text-muted-foreground/40 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                      title="Удалить из истории"
                    >
                      <XIcon className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>,
              document.body
            )}
          {examplesOpen &&
            examplesBtnRef.current &&
            createPortal(
              <div
                className="fixed z-[100] w-[340px] max-h-80 overflow-y-auto rounded-lg border border-border bg-[var(--surface-3)] shadow-2xl shadow-black/60"
                style={dropdownPos(examplesBtnRef.current)}
              >
                <div className="px-2.5 py-1.5 border-b border-border sticky top-0 bg-[var(--surface-3)]">
                  <span className="text-[10px] font-semibold text-foreground">Готовые примеры</span>
                </div>
                {EXAMPLES.map((ex) => (
                  <div
                    key={ex.title}
                    className="px-2.5 py-1.5 hover:bg-white/5 cursor-pointer"
                    onClick={() => applyExample(ex.text)}
                  >
                    <p className="text-xs font-medium text-foreground">{ex.title}</p>
                    <p className="text-[10px] text-muted-foreground/80 line-clamp-2 leading-snug break-words">
                      {ex.text}
                    </p>
                  </div>
                ))}
                <p className="px-2.5 py-2 text-[10px] text-muted-foreground/60 border-t border-border">
                  Заменяет текущий промпт (с возможностью отменить). Промпты — на английском: модель понимает его лучше всего.
                </p>
              </div>,
              document.body
            )}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-3">
          <VideoGalleryGrid
            files={gallery.files}
            loading={gallery.loading}
            onRefresh={() => void gallery.load()}
            onDeleteFile={gallery.deleteFile}
            emptyHint="Результаты ControlNet появятся здесь"
          />
        </div>
      </section>

      {/* (правка 502) Ассистент — правая боковая панель (чаты режима
          «ControlNet»; resize за левую границу, сворачивается в рейл) */}
      <AssistantPanel mode="controlnet" />
    </div>
  )
}
