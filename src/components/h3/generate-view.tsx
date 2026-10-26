'use client'

/**
 * GenerateView — the main screen of MiniMax H3 Studio.
 *
 * Left panel: generation parameters (resolution, duration, references,
 * advanced two-pass settings) with the pinned generation status card.
 * Right panel: prompt card with the CTA button and the results gallery.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import {
  AudioLinesIcon,
  ChevronDownIcon,
  FilmIcon,
  FolderIcon,
  HistoryIcon,
  ImageIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  StarIcon,
  UploadIcon,
  XIcon,
} from 'lucide-react'
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
import { toast } from 'sonner'
import { SettingSlider } from './setting-slider'
import { useVideoGen, computeOutputDimensions } from '@/hooks/use-video-gen'

import { useModelOptions } from '@/hooks/use-model-options'
import { useGenProgress } from '@/lib/gen-progress-store'
import { cn } from '@/lib/utils'
import { useGenStore, type VideoRefItem } from '@/lib/gen-store'
import {
  DurationSlider,
  SeedBlock,
  buildPresets,
  parseResolution,
  resolveResolution,
  uploadInputFile,
} from './video-shared'
import { MentionTextarea, type MentionItem } from './mention-textarea'
import { VoiceInputButton } from './voice-input-button'
import { PromptEditorDialog, PromptEditButton, PromptFixButton, PromptClearButton, PromptFixDialog, PromptFieldTools } from './prompt-editor-dialog'
import { requestImprovePrompt } from '@/hooks/use-improve-prompt' // (правка 691) «Исправить» прямо из поля
import { PromptQuality } from './prompt-quality'
import { EXAMPLES } from './learn/prompt-guide'
import { usePromptHistory } from '@/lib/prompt-history-store'
import { isStreamActive } from '@/lib/assistant-stream'
import { getClipboardImageFiles, getClipboardImageFromApi, hasClipboardImage } from '@/lib/paste-utils'
import { VideoGalleryGrid } from './video-gallery-grid'
import { GenerationStatus } from './generation-status'
// (правка 719) Общий компонент превью с полноэкранным просмотром —
// используется на всех вкладках (Генерация/Продление/Refine/ControlNet/…).
import { RefPreviewThumb } from './ref-preview-thumb'
import { useVideoGallery } from './use-video-gallery'
import { AssistantPanel } from './assistant/assistant-panel' // (правка 442) ассистент — правая панель вкладки

/* ──────────────── Constants ──────────────── */

const FALLBACK_REF_LIMITS = { image: 9, video: 3, audio: 3, total: 15 }

/* (правка 449) Селектор «интент аудио» (Голос/Темп/Стиль) удалён: на workflow
   он не влиял вообще (все аудио вставали в одинаковые ref_audio_N) — был лишь
   подсказкой ассистенту и строкой в метаданных. */

/* Подписи сэмплеров для обоих проходов (порядок — как в VALID_KSAMPLERS) */
const SAMPLER_OPTIONS = [
  { value: 'euler', label: 'euler (по умолчанию, классика)' },
  { value: 'er_sde', label: 'er_sde (SDE)' },
  { value: 'dpmpp_2m', label: 'dpmpp_2m (мультистеп)' },
  { value: 'dpmpp_3m_sde', label: 'dpmpp_3m_sde (высокое качество)' },
  { value: 'heun', label: 'heun (2-й порядок)' },
  { value: 'lcm', label: 'lcm (мало шагов)' },
  { value: 'res_multistep', label: 'res_multistep (резидуальный)' },
]

/* Подписи планировщиков pass 1 (порядок — как в PASS1_SCHEDULERS) */
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

const KIND_META: Record<
  VideoRefItem['kind'],
  { label: string; tag: string; icon: typeof ImageIcon; color: string }
> = {
  image: { label: 'Картинка', tag: 'Picture', icon: ImageIcon, color: 'text-purple-400 bg-purple-500/15' },
  video: { label: 'Видео', tag: 'Video', icon: FilmIcon, color: 'text-cyan-400 bg-cyan-500/15' },
  audio: { label: 'Аудио', tag: 'Audio', icon: AudioLinesIcon, color: 'text-emerald-400 bg-emerald-500/15' },
}

function detectKind(name: string): VideoRefItem['kind'] | null {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
  if (['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff'].includes(ext)) return 'image'
  if (['.avi', '.m4v', '.mkv', '.mov', '.mp4', '.webm'].includes(ext)) return 'video'
  if (['.aac', '.flac', '.m4a', '.mp3', '.ogg', '.wav'].includes(ext)) return 'audio'
  return null
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}

/* (правка 146) Аудио-референсы в режимах «Текст»/«Кадры»: у ноды
 * MiniMaxH3ImageToVideo аудио-входов нет — аудио подаётся через
 * MiniMaxH3AddGuide на сервере, в UI это просто зона загрузки аудио. */
function AudioRefsBlock({
  onPick,
  dragOver,
  setDragOver,
  onDropFiles,
  uploading,
  counts,
  hint,
}: {
  onPick: () => void
  dragOver: boolean
  setDragOver: (v: boolean) => void
  onDropFiles: (files: File[]) => void
  uploading: boolean
  counts: string
  hint: string
}) {
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        onDropFiles(Array.from(e.dataTransfer.files))
      }}
      onClick={onPick}
      className={cn(
        'border-2 border-dashed rounded-lg py-3 text-center cursor-pointer transition-all',
        dragOver ? 'border-cyan-400 bg-cyan-500/10' : 'border-border hover:border-cyan-500/50 hover:bg-[var(--surface-2)]',
      )}
    >
      {uploading ? (
        <p className="text-xs text-cyan-400">Загрузка аудио…</p>
      ) : (
        <>
          <AudioLinesIcon className="w-4 h-4 text-muted-foreground mx-auto mb-1" />
          <p className="text-xs text-muted-foreground">
            Аудио-референсы <span className="text-[10px] text-muted-foreground/60">({counts})</span>
          </p>
          <p className="text-[10px] text-muted-foreground/60 mt-0.5">{hint}</p>
        </>
      )}
    </div>
  )
}

/** Тег референса в промпте: <Picture N> / <Video N> / <Audio N>. */
function refTag(kind: VideoRefItem['kind'], n: number): string {
  const tag = kind === 'image' ? 'Picture' : kind === 'video' ? 'Video' : 'Audio'
  return `<${tag} ${n}>`
}

/** refId → текущий тег, нумерация по типу в порядке списка (как в mentions). */
function tagsForRefs(refs: VideoRefItem[]): Map<string, string> {
  const counters: Record<'image' | 'video' | 'audio', number> = { image: 0, video: 0, audio: 0 }
  const map = new Map<string, string>()
  for (const r of refs) map.set(r.id, refTag(r.kind, ++counters[r.kind]))
  return map
}

/**
 * Переписывает теги референсов в промпте под новый порядок списка:
 * теги удалённых референсов вырезаются, остальные перенумеровываются.
 * Промежуточные плейсхолдеры исключают коллизии при перенумерации
 * (например, swap <Video 1> ↔ <Video 2>).
 */
function rewritePromptTags(
  prompt: string,
  oldTags: Map<string, string>,
  newTags: Map<string, string>,
): string {
  let any = false
  for (const t of oldTags.values()) {
    if (prompt.includes(t)) { any = true; break }
  }
  if (!any) return prompt
  let text = prompt
  for (const [id, oldTag] of oldTags) {
    const next = newTags.get(id)
    // Удалённый референс: его тег вырезается из промпта целиком
    text = text.split(oldTag).join(next ? `\x00${id}\x00` : '')
  }
  for (const [id, tag] of newTags) {
    text = text.split(`\x00${id}\x00`).join(tag)
  }
  return text
}

/* ──────────────── Component ──────────────── */

export function GenerateView() {
  const { phase, error, progressValue, progressMax, statusMessage, promptId, generate, interrupt, reset } = useVideoGen()
  const videoStartedAt = useGenProgress((s) => s.video.startedAt)

  const video = useGenStore((s) => s.video)
  const setResolution = useGenStore((s) => s.setVideoResolution)
  const addRefs = useGenStore((s) => s.addVideoRefs)
  const updateRef = useGenStore((s) => s.updateVideoRef)
  const removeRef = useGenStore((s) => s.removeVideoRef)
  const moveRef = useGenStore((s) => s.moveVideoRef)
  const patchVideo = useGenStore((s) => s.patchVideo)
  const setPrompt = useGenStore((s) => s.setVideoPrompt)
  // (правка 146) слоты первого/последнего кадра (режим «Кадры»)
  const setVideoStartFrame = useGenStore((s) => s.setVideoStartFrame)
  const setVideoEndFrame = useGenStore((s) => s.setVideoEndFrame)

  const isGenerating = phase === 'submitting' || phase === 'queued' || phase === 'running'

  /* ──────────── Models & options ──────────── */

  const { options } = useModelOptions(video.modelType || null)

  /* ──────────── Derived params ──────────── */

  const fps = (options?.fps as number) || 24
  // Honest model bounds: the backend silently clamps anything below
  // frames_minimum back up — that's how a "2 s" request produced a 5 s clip.
  // (правка 131) фолбэк 124 → 42: минимум теперь ~2 с (42 кадра при 24 fps).
  // (правка 138) фолбэк 42 → 60: минимум 2.5 с (60 кадров), 1.75 с убрано.
  const framesMin = (options?.frames_minimum as number) || 60
  // (правка 59) max повышен до 30 с (719 кадров) — модель по факту генерит и длинные ролики
  const framesMax = (options?.frames_maximum as number) || 719
  const framesStep = (options?.frames_steps as number) || 17

  const refLimits = (options?.omni_reference_limits as typeof FALLBACK_REF_LIMITS | null) ?? FALLBACK_REF_LIMITS

  const presets = useMemo(() => buildPresets(options, true), [options])

  const refCounts = useMemo(() => {
    const counts = { image: 0, video: 0, audio: 0 }
    for (const r of video.refs) counts[r.kind]++
    return counts
  }, [video.refs])

  /* ──────────── Reference uploads ──────────── */

  const [uploadingRefs, setUploadingRefs] = useState(false)
  const refsInputRef = useRef<HTMLInputElement>(null)
  const [refsDragOver, setRefsDragOver] = useState(false)
  // (правка 146) режимы «Кадры»/«Текст»: скрытые инпуты для кадров и аудио
  const frameInputRef = useRef<HTMLInputElement>(null)
  const audioOnlyInputRef = useRef<HTMLInputElement>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [showPass1, setShowPass1] = useState(false)
  const [showPass2, setShowPass2] = useState(false)

  /** Свободное разрешение: отключаем пресеты качества и задаём MP напрямую. */
  const toggleFreeResolution = () => {
    const next = !video.freeResolution
    if (next) {
      if (!(video.finalResolution > 0)) {
        // Инициализируем MP из текущего пресета, чтобы ползунок был осмысленным.
        const m = video.resolution.match(/(\d+)\s*x\s*(\d+)/i)
        const mp = m
          ? Math.round((parseInt(m[1], 10) * parseInt(m[2], 10) / 1e6) * 100) / 100
          : 0.7
        patchVideo({ freeResolution: true, finalResolution: mp })
      } else {
        patchVideo({ freeResolution: true })
      }
      return
    }
    // Выключаем свободное разрешение → сбрасываем finalResolution в 0
    // (0 = «брать из пресета качества»), иначе оставшийся MP перебивает пресет.
    patchVideo({ freeResolution: false, finalResolution: 0 })
  }
  // (правка 719) Просмотр рефов переехал в общий компонент RefPreviewThumb
  // (у каждого превью свой просмотрщик), поэтому общего состояния
  // viewingRef/viewingRefId здесь больше не нужно.
  // Persisted stores (history) may differ on first client render vs SSR —
  // mount-gate their DOM to avoid hydration mismatch (React #418).
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const addReferenceFiles = useCallback(
    async (files: File[]) => {
      if (!files.length) return
      // (правка 146) В режимах «Текст»/«Кадры» картинки и видео-рефы не
      // поддерживаются нодой — сюда они могут попасть только вставкой/дропом
      // мимо специализированных полей; честно отклоняем.
      const mode = useGenStore.getState().video.mode
      if (mode !== 'ref') {
        const nonAudio = files.find((f) => detectKind(f.name) !== 'audio')
        if (nonAudio) {
          toast.error(mode === 't2v' ? 'В режиме «Текст» картинки и видео не используются' : 'В режиме «Кадры» картинки задаются полями «Первый/Последний кадр»')
        }
        files = files.filter((f) => detectKind(f.name) === 'audio')
        if (!files.length) return
      }
      // Считаем лимиты от АКТУАЛЬНОГО состояния стора: refCounts из рендер-
      // замыкания устаревает при перекрывающихся вызовах (paste + выбор файлов
      // одновременно) — оба проходили проверку и пускали сверх лимита.
      const current = useGenStore.getState().video.refs
      const liveCounts: Record<string, number> = { image: 0, video: 0, audio: 0 }
      for (const r of current) liveCounts[r.kind] = (liveCounts[r.kind] ?? 0) + 1
      let img = liveCounts.image
      let vid = liveCounts.video
      let aud = liveCounts.audio
      const accepted: File[] = []
      for (const file of files) {
        const kind = detectKind(file.name)
        if (!kind) {
          toast.error(`Неподдерживаемый файл: ${file.name}`)
          continue
        }
        if (kind === 'image' && ++img > refLimits.image) { toast.error(`Максимум ${refLimits.image} картинок-референсов`); img--; continue }
        if (kind === 'video' && ++vid > refLimits.video) { toast.error(`Максимум ${refLimits.video} видео-референсов`); vid--; continue }
        if (kind === 'audio' && ++aud > refLimits.audio) { toast.error(`Максимум ${refLimits.audio} аудио-референсов`); aud--; continue }
        if (current.length + accepted.length >= refLimits.total) { toast.error(`Максимум ${refLimits.total} референсов всего`); break }
        accepted.push(file)
      }
      if (!accepted.length) return

      setUploadingRefs(true)
      const items: VideoRefItem[] = []
      let anyStaged = false
      for (const file of accepted) {
        try {
          const { path, staged } = await uploadInputFile(file)
          if (staged) anyStaged = true
          items.push({
            id: newId(),
            kind: detectKind(file.name)!,
            path,
            name: file.name,
            previewUrl: URL.createObjectURL(file),
            role: '',
            imageIntent: 'identity',
            includeAudio: true,
            compress: false, // (правка 493)
          })
        } catch (err) {
          toast.error(err instanceof Error ? err.message : String(err))
        }
      }
      setUploadingRefs(false)
      if (items.length) {
        // Повторная проверка ПЕРЕД вставкой: за время загрузки параллельный
        // вызов мог уже занять лимиты — обрезаем, а не проталкиваем сверх.
        const nowRefs = useGenStore.getState().video.refs
        const room = Math.max(0, refLimits.total - nowRefs.length)
        if (items.length > room) {
          toast.error(`Максимум ${refLimits.total} референсов всего`)
          items.length = room
        }
        if (items.length) addRefs(items)
      }
      if (anyStaged) {
        toast.info('ComfyUI недоступен — референсы сохранены локально', {
          description: 'Они будут автоматически отправлены в ComfyUI при генерации.',
        })
      }
    },
    [addRefs, refLimits],
  )

  /* (правка 146) Загрузка кадра в слот режима «Кадры»: тот же uploadInputFile,
   * что и у референсов (включая staged-фолбэк при лежачем ComfyUI).
   * (правка 152) Получаем размеры изображения для aspect ratio. */
  const addFrameFile = useCallback(async (file: File, slot: 'start' | 'end') => {
    if (detectKind(file.name) !== 'image') {
      toast.error('Первый/последний кадр — только картинка')
      return
    }
    setUploadingRefs(true)
    try {
      const { path, staged } = await uploadInputFile(file)
      // (правка 152) Получаем размеры изображения (для aspect ratio в режиме flf)
      const previewUrl = URL.createObjectURL(file)
      const dims = await new Promise<{ w: number; h: number } | null>((resolve) => {
        const img = new Image()
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight })
        img.onerror = () => resolve(null)
        img.src = previewUrl
      })
      const item = {
        path,
        name: file.name,
        previewUrl,
        width: dims?.w,
        height: dims?.h,
      }
      if (slot === 'start') setVideoStartFrame(item)
      else setVideoEndFrame(item)
      if (staged) {
        toast.info('ComfyUI недоступен — кадр сохранён локально', {
          description: 'Он будет автоматически отправлен в ComfyUI при генерации.',
        })
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setUploadingRefs(false)
    }
  }, [setVideoStartFrame, setVideoEndFrame])

  /* (правка 146) Аудио-референсы в режимах «Текст»/«Кадры» — фильтрованный
   * проход через общий загрузчик референсов. */
  const addAudioOnlyFiles = useCallback((files: File[]) => {
    const audio = files.filter((f) => detectKind(f.name) === 'audio')
    const rejected = files.length - audio.length
    if (rejected > 0) toast.error(`Только аудио — ${rejected} файл(ов) отклонено`)
    if (audio.length) void addReferenceFiles(audio)
  }, [addReferenceFiles])



  /* ──────────── Ctrl+V → референс, где угодно на вкладке (правка 125) ────────────
   * (правка 123) вешала onPaste на корень вкладки, но `paste` браузер шлёт
   * ТОЛЬКО фокусированному элементу (событие пузырится вверх): если фокус
   * на body или на кнопке — до корневого onPaste оно не доходило, и вставка
   * «работала» только после клика по панели референсов (там клик фокусирует
   * скрытый file input внутри дерева).
   *
   * Теперь слушаем глобально, пока вкладка смонтирована (на других вкладках
   * компонент размонтирован, так что в чат ассистента это не лезет):
   *  1) `paste` на document (capture) — ловим вставку при любом фокусе внутри
   *     документа (body, промпт, инпуты, диалоги-порталы);
   *  2) `keydown` Ctrl/Cmd+V на window (capture) — фолбэк через
   *     navigator.clipboard.read() на случай, когда браузер не диспатчит
   *     paste-событие (фокус на кнопке и т.п.).
   * Текст из буфера НЕ трогаем — перехватываем только если там картинка.
   * Дедупликация: обе ветки могут сработать на один и тот же Ctrl+V,
   * поэтому фиксируем метку времени и вторая ветка отбрасывает повтор.
   */
  const lastRefPasteAt = useRef(0)
  useEffect(() => {
    const DEDUP_MS = 2000
    const tryAddFiles = (files: File[], viaPasteEvent: boolean): boolean => {
      const now = Date.now()
      if (now - lastRefPasteAt.current < DEDUP_MS) return false
      lastRefPasteAt.current = now
      if (!viaPasteEvent && files.length === 0) return false
      void addReferenceFiles(files)
      return true
    }

    // (правка 587) Перехват только «нецелевых» вставок: если paste/keydown
    // случился ВНУТРИ редактируемого поля (чат ассистента, textarea промпта,
    // input), событие принадлежит ему — capture-фаза + stopPropagation раньше
    // отбирали картинку у onPaste чата (вставка вложением была недоступна).
    const isEditableTarget = (t: EventTarget | null): boolean => {
      if (!(t instanceof HTMLElement)) return false
      if (t.isContentEditable) return true
      const tag = t.tagName
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
    }

    const onPaste = (e: ClipboardEvent) => {
      if (e.defaultPrevented) return
      if (isEditableTarget(e.target)) return // поле ввода само разберётся
      if (!hasClipboardImage(e.clipboardData)) return
      // Синхронно — до любых await, иначе браузер отклонит отмену.
      e.preventDefault()
      e.stopPropagation()
      const files = getClipboardImageFiles(e.clipboardData).then((list) => {
        // Метка ставится здесь (синхронно в микротаске), чтобы keydown-фолбэк
        // не добавил ту же картинку дважды.
        lastRefPasteAt.current = Date.now()
        if (list.length > 0) void addReferenceFiles(list)
      })
      void files
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'v') {
        if (isEditableTarget(e.target)) return // Ctrl+V в поле ввода — не наш
        void (async () => {
          // Даём шанс обычному paste-событию (оно приходит в том же тике
          // ввода и ставит метку раньше, чем разрешится clipboard.read()).
          const file = await getClipboardImageFromApi()
          if (!file) return // в буфере нет картинки — обычная текстовая вставка
          tryAddFiles([file], false)
        })()
      }
    }

    document.addEventListener('paste', onPaste, true)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('paste', onPaste, true)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [addReferenceFiles])

  /* ──────────── Prompt mentions (from refs) ──────────── */

  const mentions: MentionItem[] = useMemo(() => {
    // Нумерация триггеров идёт ОТДЕЛЬНО по каждому типу референса
    // (Picture N / Video N / Audio N), а не общим счётчиком по списку.
    const counters: Record<'image' | 'video' | 'audio', number> = { image: 0, video: 0, audio: 0 }
    return video.refs.map((ref) => {
      const tag = ref.kind === 'image' ? 'Picture' : ref.kind === 'video' ? 'Video' : 'Audio'
      counters[ref.kind] += 1
      return {
        id: ref.id,
        label: ref.name,
        trigger: `<${tag} ${counters[ref.kind]}>`,
        kind: ref.kind,
        color:
          ref.kind === 'image'
            ? 'bg-purple-500/15 text-purple-400'
            : ref.kind === 'video'
              ? 'bg-cyan-500/15 text-cyan-400'
              : 'bg-emerald-500/15 text-emerald-400',
        // Live blob preview while in-session; server URL after a reload
        previewUrl:
          ref.previewUrl ||
          (ref.path
            ? `/api/comfy/file?filename=${encodeURIComponent(ref.path)}&type=input`
            : undefined),
      }
    })
  }, [video.refs])

  const [promptEditorOpen, setPromptEditorOpen] = useState(false)

  // (правка 691) «Исправить промпт» прямо из поля: диалог «что изменить»
  // + задание уходят в generate-чат ассистента (requestImprovePrompt).
  const [fixOpen, setFixOpen] = useState(false)

  /* ──────────── Prompt history & examples ──────────── */

  const [historyOpen, setHistoryOpen] = useState(false)
  const [examplesOpen, setExamplesOpen] = useState(false)
  const historyBtnRef = useRef<HTMLButtonElement>(null)
  const examplesBtnRef = useRef<HTMLButtonElement>(null)
  const historyEntries = usePromptHistory((s) => s.entries)
  const toggleHistoryFavorite = usePromptHistory((s) => s.toggleFavorite)
  const removeHistoryEntry = usePromptHistory((s) => s.remove)
  const clearHistory = usePromptHistory((s) => s.clear)

  /** Position a portal dropdown under its anchor button (clamped to viewport). */
  const dropdownPos = (anchor: HTMLElement): React.CSSProperties => {
    const r = anchor.getBoundingClientRect()
    const width = 340
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8))
    const top = Math.min(r.bottom + 6, window.innerHeight - 80)
    return { top, left, width }
  }

  const applyExample = useCallback(
    (text: string) => {
      const old = video.prompt
      setPrompt(text)
      setExamplesOpen(false)
      if (old.trim()) {
        toast.success('Пример вставлен (прежний промпт заменён)', {
          action: { label: 'Отменить', onClick: () => setPrompt(old) },
        })
      }
    },
    [video.prompt, setPrompt],
  )

  /* ──────────── Gallery ──────────── */

  const { files: galleryFiles, folders: galleryFolders, loading: galleryLoading, load: loadGallery, deleteFile } = useVideoGallery({ phase })

  /* (правка 91) Активная папка проекта: галерея вкладки фильтруется по ней,
   * новые видео складываются в неё. '' = общая папка.
   * (правка 495) Вложенные папки: фильтр включает содержимое подпапок
   * (префиксное совпадение путей 'a/b'). */
  const outputFolder = video.outputFolder || ''
  const [folderMenuOpen, setFolderMenuOpen] = useState(false)
  const visibleGalleryFiles = useMemo(
    () => galleryFiles.filter((f) => {
      const sub = f.subfolder || ''
      return outputFolder === '' ? sub === '' : sub === outputFolder || sub.startsWith(outputFolder + '/')
    }),
    [galleryFiles, outputFolder],
  )

  /* ──────────── Generation ──────────── */

  const canGenerate = Boolean(video.prompt.trim())

  /** Ассистент грузится или отвечает — генерация заблокирована (vram-arbiter). */
  const [assistantBusy, setAssistantBusy] = useState(false)

  // (правка 110) Fallback против застарелой блокировки: если серверный
  // streaming-счётчик утечёт (зависший drain-насос), кнопка висела бы
  // заблокированной ВЕЧНО. Увидев busy >60 с при отсутствии активного
  // стрима В ЭТОЙ ВКЛАДКЕ, принудительно снимаем замок на сервере
  // (свежий замок — стрим реально идёт — сервер не тронет).
  const firstBusyAtRef = useRef<number | null>(null)
  const lockReleasedRef = useRef(false)

  // Лёгкий poll статуса LLM — только если ассистент использовался в этой
  // сессии (иначе запросы не нужны: LLM никогда не запускался).
  useEffect(() => {
    if (sessionStorage.getItem('assistantUsed') !== '1') return
    let stopped = false
    const tick = async () => {
      try {
        const r = await fetch('/api/llm/status', { signal: AbortSignal.timeout(4000) })
        const s = (await r.json()) as { assistantBusy?: boolean }
        if (stopped) return
        const busy = s.assistantBusy === true
        // (правка 110) после принудительного снятия — локально не блокируем;
        // реальный gate — всё равно 409 от runGeneration, так что ранний
        // «разблок» безопасен. НО: стрим активен В ЭТОЙ ВКЛАДКЕ — блокируем
        // (override не в силе), чтобы не пускать генерацию посреди ответа.
        // (правка 161) Если стрим НЕ активен — busy-лок застарел
        // (drain-насос не завершён). Генерация не мешает LLM, реальный
        // gate — 409 от runGeneration. Снимаем блокировку сразу.
        // Стрим активен → блокируем (не пускать генерацию посреди ответа).
        const override = !isStreamActive()
        setAssistantBusy(busy && !override)
        if (busy) {
          if (firstBusyAtRef.current === null) firstBusyAtRef.current = Date.now()
          const stuckMs = Date.now() - firstBusyAtRef.current
          if (!lockReleasedRef.current && stuckMs > 60_000 && !isStreamActive()) {
            // (правка 692) Два pass: сначала non-force (уважает minAge),
            // если не помогло — force (безусловный сброс).
            void fetch('/api/llm/release', { method: 'POST' }).catch(() => {})
            // Через 2 с — принудительный сброс, если первый не сработал.
            setTimeout(() => {
              if (!isStreamActive()) {
                void fetch('/api/llm/release?force=1', { method: 'POST' }).catch(() => {})
              }
            }, 2000)
            lockReleasedRef.current = true
            firstBusyAtRef.current = null
            setAssistantBusy(false)
            toast.warning('Ассистент', { description: 'Блокировка снята принудительно (засела после ответа). Кнопка «Сгенерировать» снова доступна.' })
          }
        } else {
          firstBusyAtRef.current = null
          // (правка 110) сервер подтвердил здоровье — снимаем локальный
          // override, чтобы следующая утечка снова была лечима fallback'ом
          lockReleasedRef.current = false
        }
      } catch {
        /* backend not up */
      }
    }
    void tick()
    const id = setInterval(tick, 5000)
    return () => {
      stopped = true
      clearInterval(id)
    }
  }, [])

  const canGenerateNow = canGenerate && !assistantBusy

  // (правка 333) Guard от случайного дабл-клика: пока generate() не вернулся
  // (POST сабмита в полёте, prompt_id ещё не получен), повторный вызов
  // игнорируется. Намеренные повторные запуски («Ещё в очередь») не
  // блокируются — после получения prompt_id флаг снимается.
  const submitInFlightRef = useRef(false)

  const handleGenerate = useCallback(async () => {
    // Единый guard для всех путей запуска (кнопка, Ctrl+Enter, диалог
    // «сохранить и запустить»): ассистент занят — vram-arbiter вернёт 409
    if (assistantBusy) {
      toast.error('Ассистент отвечает — дождитесь ответа или прервите его')
      return
    }
    // Read the store AT CALL TIME — the fullscreen editor's "save & run"
    // (and history/example inserts) may have updated the prompt a moment ago.
    const v = useGenStore.getState().video
    if (!v.prompt.trim()) {
      toast.error('Введите описание видео')
      return
    }
    // (правка 146) Режим «Кадры»: первый кадр обязателен
    if (v.mode === 'flf' && !v.startFrame) {
      toast.error('В режиме «Кадры» нужен первый кадр')
      return
    }
    let prompt = v.prompt.trim()
    // (правка 150) Чистим промпт от тегов, которые не поддерживаются режимом.
    // В t2v/flf ноды MiniMaxH3ReferenceToVideo нет — метки <Picture N>/<Video N>
    // не резолвятся и попадают в tokenize как текст (мусор для модели).
    // <Audio N> оставляем: в этих режимах аудио подаётся через MiniMaxH3AddGuide
    // и тег <Audio N> в prompt — корректная ссылка на аудио-референс.
    // <Subject N> — только FORMAT B (режим 'ref'), в t2v/flf чистим всегда.
    const mode = v.mode
    const removedTags: string[] = []
    if (mode !== 'ref') {
      // Убираем <Picture N> и <Video N> (включая закрывающие </Picture N>)
      const picRe = /<\/?(?:Picture|Video)\s*\d+\s*>/g
      const picMatches = prompt.match(picRe)
      if (picMatches) {
        for (const m of picMatches) {
          const norm = m.replace(/^<\//, '<')
          if (!removedTags.includes(norm)) removedTags.push(norm)
        }
        prompt = prompt.replace(picRe, '')
      }
      // Убираем <Subject N> (только FORMAT B / режим 'ref')
      const subjRe = /<\/Subject\s*\d+\s*>|<Subject\s*\d+\s*>/g
      const subjMatches = prompt.match(subjRe)
      if (subjMatches) {
        for (const m of subjMatches) {
          const norm = m.replace(/^<\//, '<')
          if (!removedTags.includes(norm)) removedTags.push(norm)
        }
        prompt = prompt.replace(subjRe, '')
      }
      // Убираем двойные пробелы после удаления
      prompt = prompt.replace(/\s{2,}/g, ' ').trim()
    }
    if (removedTags.length) {
      toast.warning('Режим генерации', {
        description: `Метки ${removedTags.join(', ')} убраны из промпта (не поддерживаются в режиме «${mode === 't2v' ? 'Текст' : 'Кадры'}»).`,
      })
    }
    if (!prompt) {
      toast.error('Промпт пуст после очистки тегов')
      return
    }

    // (правка 256) Валидация тегов референсов ДО отправки: каждый
    // <Picture N>/<Video N>/<Audio N> должен иметь соответствующий реф
    // (номер = позиция среди рефов того же типа). Раньше «висящий» тег
    // доходил до ComfyUI и генерация падала с невнятной ошибкой без причины.
    {
      const refsForMode = v.refs.filter((r) => mode === 'ref' || r.kind === 'audio')
      const counts: Record<string, number> = { Picture: 0, Video: 0, Audio: 0 }
      for (const r of refsForMode) {
        if (r.kind === 'image') counts.Picture++
        else if (r.kind === 'video') counts.Video++
        else if (r.kind === 'audio') counts.Audio++
      }
      const dangling = new Set<string>()
      const tagRe = /<(Picture|Video|Audio)\s+(\d+)\s*>/g
      let tm: RegExpExecArray | null
      while ((tm = tagRe.exec(prompt)) !== null) {
        const kind = tm[1]
        const n = parseInt(tm[2], 10)
        if (n < 1 || n > counts[kind]) dangling.add(tm[0])
      }
      if (dangling.size) {
        toast.error('Промпт ссылается на несуществующие референсы', {
          description: `Тег${dangling.size > 1 ? 'и' : ''} ${[...dangling].join(', ')} — под этим номером нет файла. Добавьте референс или удалите тег из промпта.`,
          duration: 8000,
        })
        return
      }
    }

    // (правка 333, 346) Флаг ставим синхронно ДО await — второй клик,
    // пришедший, пока валидация/сабмит первого ещё идут, отсекается guard'ом.
    // Запись в историю промптов — ПОСЛЕ guard'а, иначе дабл-клик клал в
    // историю два одинаковых энтрика.
    if (submitInFlightRef.current) return
    submitInFlightRef.current = true
    usePromptHistory.getState().add(prompt)
    // (правка 696) Зафиксировать stageKind на момент старта: во время
    // генерации переключение «Драфт/Полное» не меняет шаблон подписи.
    // extend всегда 'clips2' (generate-view передаёт pipeline='full' для extend),
    // иначе 'passes' (draft → 1 проход, full → 2 прохода — оба 'passes').
    useGenProgress.getState().setVideoFrozenStageKind(
      v.mode === 'extend' ? 'clips2' : 'passes',
    )
    try {
      await generate({
      modelType: v.modelType,
      mode: v.mode,
      pipeline: v.mode === 'extend' ? 'full' : v.pipeline,
      prompt,
      seed: v.seed,
      resolution: v.resolution,
      videoLength: v.videoLength,
      // (правка 146) «Кадры»: файлы кадров отдельно от референсов;
      // «Текст»/«Кадры»: из референсов уходят только аудио (картинки/видео
      // в этих режимах нода не принимает).
      firstFrame: v.mode === 'flf' ? v.startFrame?.path : undefined,
      lastFrame: v.mode === 'flf' ? v.endFrame?.path : undefined,
      // (правка 152) Размеры первого кадра — для aspect ratio в режиме flf
      firstFrameWidth: v.mode === 'flf' ? v.startFrame?.width : undefined,
      firstFrameHeight: v.mode === 'flf' ? v.startFrame?.height : undefined,
      // ref: аудио-гайд + сохранение оригинальной дорожки (галочка в UI).
      audioGuide: v.mode === 'ref' && v.audioGuide === true,
      references: v.refs
        .filter((r) => v.mode === 'ref' || r.kind === 'audio')
        .map((r) => ({
        kind: r.kind,
        path: r.path,
        role: r.role || undefined,
        imageIntent: r.imageIntent,
        includeAudio: r.includeAudio,
        compress: r.compress, // (правка 493)
        // (правка 302) обрезка аудио-рефа (виртуальная, нода AudioTrim)
        trimStart: r.trimStart,
        trimEnd: r.trimEnd,
        // (правка 694) громкость аудио-рефа (виртуальная, нода AudioGain)
        audioVolume: r.audioVolume,
      })),
      finalResolution: v.finalResolution || undefined,
      lowResMP: v.lowResMP ?? 0.2,
      firstSamplerSteps: v.firstSamplerSteps ?? 6,
      // Всего шагов расписания pass 1. По умолчанию = точке сплита («6 из 6»).
      firstSamplerTotalSteps: v.firstSamplerTotalSteps ?? v.firstSamplerSteps ?? 6,
      draftSteps: v.mode === 'extend' ? undefined : (v.draftSteps ?? 4),
      sigmaVariant: v.sigmaVariant || '3step',
      pass2Sampler: v.pass2Sampler || 'euler',
      pass1Sampler: v.pass1Sampler || 'euler',
      pass1Scheduler: v.pass1Scheduler || 'simple',
      // (правка 96) Влияние турбо-лоры управляется только в Настройках → LoRAs
      referenceDetail: v.referenceDetail || 'match', // (правка 58)
      sparseAttention: v.sparseAttention, // (правка 168)
      sparseTau: v.sparseTau, // (правка 466)
      sparseStartPercent: v.sparseStartPercent, // (правка 466)
      sparseEndPercent: v.sparseEndPercent, // (правка 466)
      sparseMinTokens: v.sparseMinTokens, // (правка 466)
      sparseExtraTokens: v.sparseExtraTokens, // (правка 466)
      vedaAttention: v.vedaAttention, // (правка 301)
      vedaGeneratedSparsity: v.vedaGeneratedSparsity, // (правка 402)
      vedaReferenceSparsity: v.vedaReferenceSparsity, // (правка 402)
      vedaFullAttentionLayers: v.vedaFullAttentionLayers, // (правка 402)
      vedaFullAttentionSteps: v.vedaFullAttentionSteps, // (правка 402)
      vedaVerbose: v.vedaVerbose, // (правка 402)
      lowVramAttention: v.lowVramAttention,
      chunkFeedForward: v.chunkFeedForward,
      chunkFFChunks: v.chunkFFChunks,
      chunkFFThreshold: v.chunkFFThreshold,
      outputSubfolder: v.outputFolder || '', // (правка 91) папка проекта
      })
    } finally {
      submitInFlightRef.current = false
    }
  }, [generate, assistantBusy])

  useEffect(() => {
    if (error) toast.error(error)
  }, [error])

  const progressPercent = progressMax > 0 ? Math.round((progressValue / progressMax) * 100) : 0

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && canGenerateNow) {
        e.preventDefault()
        void handleGenerate()
      }
    },
    [handleGenerate, canGenerateNow],
  )

  /* ──────────── Ref list edits that keep prompt tags in sync ──────────── */

  /** Удаление референса: его тег вырезается из промпта, остальные перенумеровываются.
   *  (правка 256) ИСКЛЮЧЕНИЕ: если удаляется ЕДИНСТВЕННЫЙ реф своего типа
   *  (типичный сценарий «заменю видео на другое»), теги в промпте СОХРАНЯЕМ —
   *  следующий добавленный реф того же типа займёт тот же слот <Video 1>.
   *  Раньше теги вырезались сразу, и после добавления нового видео промпт
   *  оставался без тегов (жалоба с YouTube). */
  const removeRefSynced = useCallback(
    (id: string) => {
      const v = useGenStore.getState().video
      const removed = v.refs.find((r) => r.id === id)
      // (правка 587) Освобождаем blob-URL удалённого референса (утечка:
      // revoke не вызывался, как в refine-view — правка 345).
      if (removed?.previewUrl?.startsWith('blob:')) {
        try { URL.revokeObjectURL(removed.previewUrl) } catch { /* уже мёртв */ }
      }
      const sameKindLeft = removed
        ? v.refs.filter((r) => r.kind === removed.kind && r.id !== id).length
        : 0
      if (removed && sameKindLeft === 0) {
        removeRef(id)
        return
      }
      const oldTags = tagsForRefs(v.refs)
      const newTags = tagsForRefs(v.refs.filter((r) => r.id !== id))
      const nextPrompt = rewritePromptTags(v.prompt, oldTags, newTags)
      removeRef(id)
      if (nextPrompt !== v.prompt) setPrompt(nextPrompt)
    },
    [removeRef, setPrompt],
  )

  /** Перемещение референса: теги <Video N> следуют за новым порядком списка. */
  const moveRefSynced = useCallback(
    (from: number, to: number) => {
      const v = useGenStore.getState().video
      const oldTags = tagsForRefs(v.refs)
      moveRef(from, to)
      const nextTags = tagsForRefs(useGenStore.getState().video.refs)
      const nextPrompt = rewritePromptTags(v.prompt, oldTags, nextTags)
      if (nextPrompt !== v.prompt) setPrompt(nextPrompt)
    },
    [moveRef, setPrompt],
  )

  /* ──────────── Ref card ──────────── */

  const renderRefCard = (ref: VideoRefItem, index: number) => {
    const meta = KIND_META[ref.kind]
    const KindIcon = meta.icon
    const total = video.refs.length
    // Номер референса в рамках его типа (Picture N / Video N / Audio N)
    const typeNum = video.refs.slice(0, index + 1).filter((r) => r.kind === ref.kind).length
    return (
      <motion.div
        key={ref.id}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        className="rounded-lg border border-border bg-[var(--surface-2)] p-2.5 space-y-2"
      >
        <div className="flex items-start gap-2.5">
          <div className="flex flex-col gap-0.5 shrink-0">
            <button
              onClick={() => moveRefSynced(index, index - 1)}
              disabled={index === 0}
              className="w-5 h-5 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-[var(--surface-3)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              title="Выше"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 6L5 3L8 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </button>
            <button
              onClick={() => moveRefSynced(index, index + 1)}
              disabled={index === total - 1}
              className="w-5 h-5 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-[var(--surface-3)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              title="Ниже"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 4L5 7L8 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </button>
          </div>
          {/* (правка 719) Превью рефа — общий компонент с полноэкранным
              просмотром (тот же, что на вкладках Refine/ControlNet/FPS/…).
              Аудио-реф открывает плеер с обрезкой. */}
          <RefPreviewThumb
            kind={ref.kind}
            name={ref.name}
            path={ref.path}
            className="w-14 h-14 rounded-md overflow-hidden bg-black/40 border border-border shrink-0 flex items-center justify-center hover:border-cyan-500/60 transition-colors disabled:cursor-not-allowed"
            title={ref.kind === 'audio' ? 'Открыть плеер / обрезку' : 'Открыть референс'}
            trimStart={ref.trimStart}
            trimEnd={ref.trimEnd}
            audioVolume={ref.audioVolume}
            onTrimChange={(start, end) => {
              // (правка 302) Обрезка сохраняется в сторе рефов.
              updateRef(ref.id, { trimStart: start, trimEnd: end })
            }}
            onVolumeChange={(v) => {
              updateRef(ref.id, { audioVolume: v })
            }}
          >
            {ref.kind === 'image' && ref.path && (
              <img src={`/api/comfy/file?filename=${encodeURIComponent(ref.path)}&type=input&width=200`} alt={ref.name} className="w-full h-full object-cover" />
            )}
            {ref.kind === 'video' && ref.path && (
              <video src={`/api/comfy/file?filename=${encodeURIComponent(ref.path)}&type=input`} muted playsInline className="w-full h-full object-cover" preload="metadata" />
            )}
            {ref.kind === 'audio' && (
              <KindIcon className="w-5 h-5 text-emerald-400" />
            )}
            {!ref.path && (
              <KindIcon className={cn('w-5 h-5', ref.kind === 'audio' ? 'text-emerald-400' : 'text-muted-foreground')} />
            )}
          </RefPreviewThumb>
          <div className="flex-1 min-w-0 space-y-1">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-mono text-muted-foreground">#{index + 1}</span>
              <span className={cn('text-[10px] px-1.5 py-0.5 rounded font-medium', meta.color)}>
                {meta.label} → &lt;{meta.tag} {typeNum}&gt;
              </span>
            </div>
            <p className="text-xs text-foreground/80 truncate" title={ref.name}>{ref.name}</p>
          </div>
          <button
            onClick={() => removeRefSynced(ref.id)}
            className="p-1 rounded hover:bg-red-500/20 text-muted-foreground hover:text-red-400 transition-colors shrink-0"
            title="Удалить референс"
          >
            <XIcon className="w-3.5 h-3.5" />
          </button>
        </div>
        {ref.kind === 'video' && (
          <div className="flex items-center gap-3 flex-wrap">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={ref.includeAudio}
                onChange={(e) => updateRef(ref.id, { includeAudio: e.target.checked })}
                className="accent-cyan-500"
              />
              использовать звук видео
            </label>
            {/* (правка 493) Сжатие рефа до 480p на сервере (ffmpeg, кэш):
                видео-референсы тяжёлые, а для якоря движения/сцены высокое
                разрешение почти никогда не нужно. */}
            <label
              className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer"
              title="Перед генерацией видео ресайзится до 480p с сохранением пропорций — меньше токенов и VRAM, для референса движения/сцены этого достаточно"
            >
              <input
                type="checkbox"
                checked={ref.compress === true}
                onChange={(e) => updateRef(ref.id, { compress: e.target.checked })}
                className="accent-cyan-500"
              />
              сжать видео (480p)
            </label>
          </div>
        )}
      </motion.div>
    )
  }

  /* ──────────── Render ──────────── */

  // SSR/hydration guard: persisted store values (video.resolution, prompt, refs)
  // differ between server render and first client render. Render a neutral
  // skeleton until mounted to avoid React hydration error #418.
  if (!mounted) {
    return (
      <div className="flex-1 flex min-h-0">
        {/* (правка 472) панель — surface-1, как у Refine/Tile/FPS (единый вид) */}
        <div className="w-[400px] shrink-0 border-r border-border flex flex-col bg-[var(--surface-1)]">
          <div className="flex-1 flex items-center justify-center p-4">
            <div className="text-xs text-muted-foreground">Загрузка…</div>
          </div>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <div className="text-xs text-muted-foreground">…</div>
        </div>
      </div>
    )
  }

  const badges = (
    <>
      {video.freeResolution ? (
        <Badge className="text-[10px] bg-cyan-500/15 text-cyan-300 border-cyan-500/30 hover:bg-cyan-500/15">
          {(() => {
            const bAspect = parseResolution(video.resolution, presets).aspect
            const bMP = video.finalResolution > 0 ? video.finalResolution : 0.7
            // (правки 121, 124) точные размеры: gen кратная 32 + финальный кроп
            const bDims = computeOutputDimensions(bAspect, bMP)
            return <>Свободное · {bAspect} · {bMP.toFixed(2)} MP ({bDims.w}×{bDims.h})</>
          })()}
        </Badge>
      ) : (
        <Badge variant="secondary" className="text-[10px]">{video.resolution}</Badge>
      )}
      <Badge variant="secondary" className="text-[10px]">{(video.videoLength / fps).toFixed(1)} с · {fps} fps</Badge>
      <Badge className="text-[10px] bg-amber-500/15 text-amber-400 border-amber-500/30 hover:bg-amber-500/15">
        2-Pass · {video.finalResolution || 'auto'} MP
      </Badge>
      {video.refs.length > 0 && (
        <Badge variant="secondary" className="text-[10px]">{video.refs.length} референс(ов)</Badge>
      )}
    </>
  )

  return (
    <div
      className="flex-1 flex min-h-0"
      // (правка 125) Ctrl+V → референс обрабатывается глобальными слушателями
      // paste/keydown (useEffect выше) — срабатывает при ЛЮБОМ фокусе вкладки,
      // а не только при фокусе внутри дерева; onPaste на корне удалён.
    >
      {/* LEFT: Settings panel (правка 472: surface-1, как у Refine/Tile/FPS) */}
      <div className="w-[400px] shrink-0 border-r border-border flex flex-col bg-[var(--surface-1)]">
        <div className="flex-1 overflow-y-auto p-4 space-y-4">

          {/* Header */}
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">Параметры</h2>
            <Badge className="text-[10px] bg-cyan-500/15 text-cyan-400 border-cyan-500/30 hover:bg-cyan-500/15">
              MiniMax H3
            </Badge>
          </div>

          <Separator className="bg-border opacity-50" />

          {/* (правка 146) Режим генерации: текст / кадры / референсы */}
          <div className="space-y-1.5">
            <Label
              className="text-xs text-muted-foreground"
              title={
                video.mode === 't2v'
                  ? 'Видео создаётся только по текстовому описанию. Аудио ниже можно добавить для голоса персонажей.'
                  : video.mode === 'flf'
                    ? 'Загрузите первый кадр (и при желании последний) — видео плавно построится между ними, а описание задаёт, что происходит по пути.'
                    : 'Добавьте картинки, видео или аудио — модель будет опираться на них как на образцы.'
              }
            >
              Режим генерации
            </Label>
            <div className="grid grid-cols-3 gap-1.5">
              {([
                ['t2v', 'Текст', 'Только описание — без картинок и референсов'],
                ['flf', 'Кадры', 'Первый (и опц. последний) кадр → видео'],
                ['ref', 'Референсы', 'Картинки/видео/аудио как референсы'],
              ] as const).map(([m, label, hint]) => (
                <button
                  key={m}
                  type="button"
                  title={hint}
                  onClick={() => patchVideo({ mode: m })}
                  className={cn(
                    'h-8 rounded-md border px-1 text-xs font-medium transition-all min-w-0 truncate text-center',
                    video.mode === m
                      ? 'bg-cyan-500/15 border-cyan-500/50 text-cyan-300'
                      : 'bg-[var(--surface-2)] border-border text-muted-foreground hover:border-cyan-500/30',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <Separator className="bg-border opacity-50" />

          {/* Пайплайн: драфт (один проход) / полное (два прохода) */}
          <div className="space-y-1.5">
            <Label
              className="text-xs text-muted-foreground"
              title={
                video.pipeline === 'draft'
                  ? 'Один быстрый проход — черновое качество, зато недолго. Довести до полного качества можно позже во вкладке Refine.'
                  : 'Сначала быстрый черновик в малом разрешении, затем доработка до чёткого результата. Дольше, но качественнее.'
              }
            >
              Качество прохода
            </Label>
            <div className="grid grid-cols-2 gap-1.5">
              {([
                ['draft', 'Драфт', 'Один быстрый проход — черновое качество; довести можно вкладкой Refine'],
                ['full', 'Полное', 'Два прохода: быстрый черновик, затем детализация до полного качества'],
              ] as const).map(([pl, label, hint]) => (
                <button
                  key={pl}
                  type="button"
                  title={hint}
                  onClick={() => patchVideo({ pipeline: pl })}
                  disabled={video.mode === 'extend'}
                  className={cn(
                    'h-8 rounded-md border text-xs font-medium transition-all',
                    video.pipeline === pl
                      ? 'bg-emerald-500/15 border-emerald-500/50 text-emerald-300'
                      : 'bg-[var(--surface-2)] border-border text-muted-foreground hover:border-emerald-500/30',
                    video.mode === 'extend' && 'opacity-50 cursor-not-allowed',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <Separator className="bg-border opacity-50" />

          {/* Resolution: quality + aspect ratio (+ free-resolution mode) */}
          {(() => {
            const { quality: curQuality, aspect: curAspect } = parseResolution(video.resolution, presets)
            const qualities = Object.keys(presets)
            const aspects = Object.keys(presets[curQuality] || presets[qualities[0] || '720p'] || {})
            const freeOn = !!video.freeResolution
            const freeMP = video.finalResolution > 0
              ? video.finalResolution
              : 0.7
            // (правки 121, 124) Реальное разрешение по MP + соотношению — тот же
            // алгоритм, что и на бэкенде (генерация кратная 32 → точный кроп)
            const freeDims = computeOutputDimensions(curAspect, freeMP)
            return (
              <div className="space-y-2.5">
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Разрешение</Label>
                    <Select
                      value={curQuality}
                      disabled={freeOn}
                      onValueChange={(q) => {
                        const { aspect } = parseResolution(video.resolution, presets)
                        setResolution(resolveResolution(q, aspect, presets))
                      }}
                    >
                      <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md disabled:cursor-not-allowed disabled:opacity-50">
                        <SelectValue placeholder="Разрешение" />
                      </SelectTrigger>
                      <SelectContent className="bg-[var(--surface-3)] border-border">
                        {qualities.map((q) => (
                          <SelectItem key={q} value={q}>{q}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Соотношение</Label>
                    {/* (правка 152) В режиме «Кадры» соотношение берётся из первого кадра — селектор заблокирован */}
                    <Select
                      value={curAspect}
                      disabled={video.mode === 'flf'}
                      onValueChange={(a) => {
                        const { quality } = parseResolution(video.resolution, presets)
                        setResolution(resolveResolution(quality, a, presets))
                      }}
                    >
                      <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md disabled:cursor-not-allowed disabled:opacity-50">
                        <SelectValue placeholder={video.mode === 'flf' ? 'Из кадра' : 'Соотношение'} />
                      </SelectTrigger>
                      {video.mode !== 'flf' && (
                        <SelectContent className="bg-[var(--surface-3)] border-border">
                          {aspects.map((a) => (
                            <SelectItem key={a} value={a}>{a}</SelectItem>
                          ))}
                        </SelectContent>
                      )}
                    </Select>
                  </div>
                </div>

                {/* Free-resolution toggle (правка 158) — в режиме «Кадры» не доступно:
                    ориентация и номинал берутся из первого кадра (flfNominalDimensions),
                    свободное разрешение (MP) ломало бы пропорции кадра. */}
                {video.mode !== 'flf' && (
                  <>
                <button
                  type="button"
                  onClick={toggleFreeResolution}
                  aria-pressed={freeOn}
                  className={cn(
                    'w-full flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-medium transition-all',
                    freeOn
                      ? 'bg-cyan-500/15 border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/20'
                      : 'bg-[var(--surface-2)] border-border text-muted-foreground hover:border-cyan-500/40 hover:text-foreground',
                  )}
                >
                  <SlidersHorizontalIcon className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">Свободное разрешение</span>
                  {freeOn && (
                    <span className="ml-auto text-[10px] font-mono tabular-nums text-cyan-300/90">
                      {freeMP.toFixed(2)} MP ({freeDims.w}×{freeDims.h})
                    </span>
                  )}
                </button>

                {/* Free-resolution MP slider */}
                {freeOn && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    className="overflow-hidden"
                  >
                    <div className="space-y-1 px-1">
                      <SettingSlider
                        label="Разрешение (MP)"
                        labelTitle="Точный размер видео в мегапикселях. Рядом показано итоговое разрешение в пикселях; в поле справа можно ввести вручную до 16 MP."
                        value={freeMP}
                        onChange={(v) => patchVideo({ finalResolution: Math.round(v * 100) / 100 })}
                        min={0.2}
                        max={3.0}
                        step={0.05}
                        formatValue={(v) => {
                          // (правки 121, 124) итог: gen кратная 32 + точный кроп
                          const d = computeOutputDimensions(curAspect, v)
                          return `${v.toFixed(2)} MP (${d.w}×${d.h})`
                        }}
                        inputMin={0.2}
                        inputMax={16}
                        inputHint="0.2–16 MP. Выше 3 MP — заметно больше VRAM и времени рендера"
                      />
                    </div>
                  </motion.div>
                )}
                  </>
                )}
              </div>
            )
          })()}

          <DurationSlider
            min={framesMin}
            max={framesMax}
            step={framesStep}
            fps={fps}
            hint="выравнивание 17n+5 · максимум 30 с"
          />

          <Separator className="bg-border opacity-50" />

          {/* Reference manager — содержимое зависит от режима (правка 146) */}
          {video.mode === 'flf' ? (
            /* ── Режим «Кадры»: первый/последний кадр + аудио-референсы ── */
            <div className="space-y-2.5">
              <Label className="text-xs text-muted-foreground flex items-center justify-between">
                <span>Кадры и аудио</span>
                <span className="text-[10px] font-normal">
                  {refCounts.audio}/{refLimits.audio} aud
                </span>
              </Label>

              <div className="grid grid-cols-2 gap-2">
                {(['start', 'end'] as const).map((slotKey) => {
                  const slot = slotKey === 'start' ? video.startFrame : video.endFrame
                  const isStart = slotKey === 'start'
                  return (
                    <div
                      key={slotKey}
                      onDragOver={(e) => { e.preventDefault(); setRefsDragOver(true) }}
                      onDragLeave={() => setRefsDragOver(false)}
                      onDrop={(e) => {
                        e.preventDefault()
                        setRefsDragOver(false)
                        const f = Array.from(e.dataTransfer.files).find((x) => detectKind(x.name) === 'image')
                        if (f) void addFrameFile(f, isStart ? 'start' : 'end')
                        else toast.error('Нужна картинка')
                      }}
                      onClick={() => frameInputRef.current?.click()}
                      data-frame-slot={slotKey}
                      className={cn(
                        'border-2 border-dashed rounded-lg py-3 text-center cursor-pointer transition-all',
                        refsDragOver ? 'border-cyan-400 bg-cyan-500/10' : 'border-border hover:border-cyan-500/50 hover:bg-[var(--surface-2)]',
                        isStart ? 'flf-slot-start' : 'flf-slot-end',
                      )}
                    >
                      {slot ? (
                        <div className="px-2">
                          {/* (правка 273) previewUrl пустой после перезапуска (localStorage
                              не хранит blob:) — фолбэк на серверный файл по path.
                              (правка 719) Клик по кадру — полноэкранный просмотр
                              (общий компонент, как у рефов). */}
                          <RefPreviewThumb
                            kind="image"
                            name={slot.name}
                            path={slot.path ?? ''}
                            url={slot.previewUrl || undefined}
                            className="w-full block"
                            title="Открыть кадр во весь экран"
                            stopPropagation
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={slot.previewUrl || (slot.path ? `/api/comfy/file?filename=${encodeURIComponent(slot.path)}&type=input` : undefined)}
                              alt={slot.name}
                              className="w-full h-16 object-cover rounded-md cursor-zoom-in"
                            />
                          </RefPreviewThumb>
                          <p className="text-[10px] text-muted-foreground truncate mt-1">{slot.name}</p>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              if (isStart) setVideoStartFrame(null)
                              else setVideoEndFrame(null)
                            }}
                            className="text-[10px] text-red-400 hover:text-red-300 mt-0.5"
                          >
                            убрать
                          </button>
                        </div>
                      ) : (
                        <>
                          <ImageIcon className="w-4 h-4 text-muted-foreground mx-auto mb-1" />
                          <p className="text-xs text-muted-foreground font-medium">{isStart ? 'Первый кадр' : 'Последний кадр'}</p>
                          <p className="text-[10px] text-muted-foreground/60">{isStart ? 'обязательный' : 'необязательный'}</p>
                        </>
                      )}
                    </div>
                  )
                })}
              </div>

              <AudioRefsBlock
                onPick={() => audioOnlyInputRef.current?.click()}
                dragOver={refsDragOver}
                setDragOver={setRefsDragOver}
                onDropFiles={(files) => void addAudioOnlyFiles(files)}
                uploading={uploadingRefs}
                counts={`${refCounts.audio}/${refLimits.audio} aud`}
                hint="аудио для голоса/озвучки (WAV, MP3…)"
              />
              <input
                ref={frameInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/bmp,image/tiff"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) {
                    // Оба слота пользуются один input: стартовый, если пуст или последний занят.
                    // (правка 347) Читаем стор в момент вызова (getState), а не
                    // рендер-замыкание `video` — onChange мог отработать после
                    // patchVideo, но до ре-рендера, и кадр улетал не в тот слот.
                    const vs = useGenStore.getState().video
                    const target = !vs.startFrame || (vs.startFrame && vs.endFrame) ? 'start' : 'end'
                    void addFrameFile(f, target)
                  }
                  e.target.value = ''
                }}
              />
              <input
                ref={audioOnlyInputRef}
                type="file"
                multiple
                accept="audio/wav,audio/mpeg,audio/ogg,audio/flac,audio/aac,audio/mp4,audio/x-m4a"
                className="hidden"
                onChange={(e) => {
                  void addAudioOnlyFiles(Array.from(e.target.files ?? []))
                  e.target.value = ''
                }}
              />

              {video.refs.some((r) => r.kind === 'audio') && (
                <div className="space-y-2">
                  {video.refs.map((ref, i) => ref.kind === 'audio' ? renderRefCard(ref, i) : null)}
                </div>
              )}
            </div>
          ) : video.mode === 't2v' ? (
            /* ── Режим «Текст»: только аудио-референсы ── */
            <div className="space-y-2.5">
              <AudioRefsBlock
                onPick={() => audioOnlyInputRef.current?.click()}
                dragOver={refsDragOver}
                setDragOver={setRefsDragOver}
                onDropFiles={(files) => void addAudioOnlyFiles(files)}
                uploading={uploadingRefs}
                counts={`${refCounts.audio}/${refLimits.audio} aud`}
                hint="аудио для голоса/озвучки — картинки/видео в этом режиме не используются"
              />
              <input
                ref={audioOnlyInputRef}
                type="file"
                multiple
                accept="audio/wav,audio/mpeg,audio/ogg,audio/flac,audio/aac,audio/mp4,audio/x-m4a"
                className="hidden"
                onChange={(e) => {
                  void addAudioOnlyFiles(Array.from(e.target.files ?? []))
                  e.target.value = ''
                }}
              />
              {video.refs.some((r) => r.kind === 'audio') && (
                <div className="space-y-2">
                  {video.refs.map((ref, i) => ref.kind === 'audio' ? renderRefCard(ref, i) : null)}
                </div>
              )}
            </div>
          ) : (
            /* ── Режим «Референсы»: как раньше ── */
            <div className="space-y-2.5">
              <Label
                className="text-xs text-muted-foreground flex items-center justify-between"
                title="Чтобы привязать файл к описанию, введите @ в тексте — появится список. Реплики героев оборачивайте в <d>…</d>."
              >
                <span>Референсы</span>
                <span className="text-[10px] font-normal">
                  {refCounts.image}/{refLimits.image} img · {refCounts.video}/{refLimits.video} vid ·{' '}
                  {refCounts.audio}/{refLimits.audio} aud
                </span>
              </Label>

              <div
                onDragOver={(e) => { e.preventDefault(); setRefsDragOver(true) }}
                onDragLeave={() => setRefsDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault()
                  setRefsDragOver(false)
                  void addReferenceFiles(Array.from(e.dataTransfer.files))
                }}
                onClick={() => refsInputRef.current?.click()}
                className={cn(
                  'border-2 border-dashed rounded-lg py-4 text-center cursor-pointer transition-all',
                  refsDragOver ? 'border-cyan-400 bg-cyan-500/10' : 'border-border hover:border-cyan-500/50 hover:bg-[var(--surface-2)]',
                )}
              >
                <input
                  ref={refsInputRef}
                  type="file"
                  multiple
                  accept="image/png,image/jpeg,image/webp,image/bmp,image/tiff,video/mp4,video/webm,video/quicktime,video/x-matroska,video/x-msvideo,video/x-m4v,audio/wav,audio/mpeg,audio/ogg,audio/flac,audio/aac,audio/mp4,audio/x-m4a"
                  className="hidden"
                  onChange={(e) => {
                    void addReferenceFiles(Array.from(e.target.files ?? []))
                    e.target.value = ''
                  }}
                />
                {uploadingRefs ? (
                  <p className="text-xs text-cyan-400">Загрузка референсов…</p>
                ) : (
                  <>
                    <UploadIcon className="w-5 h-5 text-muted-foreground mx-auto mb-1.5" />
                    <p className="text-xs text-muted-foreground">
                      Перетащите, <span className="text-cyan-400 underline">выберите</span> или вставьте по{' '}
                      <span className="font-mono text-cyan-400">Ctrl+V</span>
                    </p>
                    <p className="text-[10px] text-muted-foreground/60 mt-0.5">
                      картинки, видео и аудио — до {refLimits.total} шт.
                    </p>
                  </>
                )}
              </div>

              {video.refs.length > 0 && (
                <div className="space-y-2">
                  {video.refs.map(renderRefCard)}
                </div>
              )}

              {/* ref + аудио: Audio Guide ведёт генерацию, а в готовый ролик
                  сервер подставляет оригинальную дорожку. Опция — только когда
                  есть аудио-реф; в t2v/flf аудио-гайд уже штатный. */}
              {refCounts.audio > 0 && (
                <label className="flex items-start gap-2 rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={video.audioGuide === true}
                    onChange={(e) => patchVideo({ audioGuide: e.target.checked })}
                    className="mt-0.5 accent-emerald-400"
                  />
                  <span className="min-w-0">
                    <span className="block text-xs font-medium text-foreground">
                      Сохранить оригинальный звук и вести по нему
                    </span>
                    <span className="block text-[10px] text-muted-foreground/70 leading-snug mt-0.5">
                      Аудио-рефы станут Audio Guide; в итоговое видео подставится
                      оригинальная дорожка первого аудио-рефа, обрезанная по длине ролика.
                    </span>
                  </span>
                </label>
              )}
            </div>
          )}

          <Separator className="bg-border opacity-50" />

          {/* Collapsible: Additional parameters */}
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
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                className="space-y-3 pl-1 overflow-hidden"
              >
                {/* Root: Seed */}
                <SeedBlock />

                {/* Драфт-пайплайн: настройки единственного прохода; Pass 2 нет */}
                {(() => {
                  const isDraft = video.pipeline === 'draft' && video.mode !== 'extend'
                  // (правка 719) Сводка по сплиту pass 1: «N из M» + σ-границы.
                  // Показывает ровно то, что уйдёт в SplitSigmas/BasicScheduler,
                  // чтобы можно было сравнивать качество, не вычисляя вручную.
                  const pass1Split = Math.max(1, Math.round(video.firstSamplerSteps ?? 6))
                  const pass1TotalSteps = Math.max(
                    2,
                    Math.min(64, Math.round(video.firstSamplerTotalSteps ?? pass1Split)),
                  )
                  const effSplit = Math.min(pass1Split, pass1TotalSteps)
                  // Конечная сигма pass 1: linspace(1.0, 0.0, steps+1)[split-1]
                  // = 1 − (split−1)/steps.
                  const pass1SigmaEnd = 1 - (effSplit - 1) / pass1TotalSteps
                  const pass2Steps =
                    (video.sigmaVariant || '3step') === '3step'
                      ? 3
                      : (video.sigmaVariant || '3step') === '4step'
                        ? 4
                        : (video.sigmaVariant || '3step') === '5step'
                          ? 5
                          : (video.sigmaVariant || '3step') === '6step'
                            ? 6
                            : 7
                  const pass2SigmaStart =
                    video.sigmaVariant === '5step'
                      ? 0.9231
                      : video.sigmaVariant === '6step'
                        ? 0.9412
                        : video.sigmaVariant === '7step'
                          ? 0.95
                          : 0.9035
                  return (
                    <>
                      {/* (правка 277) «Рефы: режим размера» вынесен в ОСНОВНЫЕ настройки
                          (был в доп.). (правка 281) Режимы с референсами-картинками:
                          ref (рефы), extend (продление), flf (кадры — первый/последний).
                          Только t2v (текст) без рефов — Match/Max неактуален. */}
                      {video.mode !== 't2v' && (
                        <div className="space-y-1">
                          <Label
                            className="text-xs text-muted-foreground"
                            title="Как обрабатывать загруженные картинки. Match — быстрее; Max — точнее сохраняет детали референсов, но медленнее."
                          >
                            Рефы: режим размера
                          </Label>
                          <div className="grid grid-cols-2 gap-1.5">
                            <button
                              type="button"
                              onClick={() => patchVideo({ referenceDetail: 'match' })}
                              className={cn(
                                'px-2 py-1.5 rounded-md border text-xs transition-colors',
                                (video.referenceDetail || 'match') === 'match'
                                  ? 'border-cyan-500/40 text-cyan-300 bg-cyan-500/10'
                                  : 'border-border text-muted-foreground hover:text-foreground',
                              )}
                            >
                              Match (быстро)
                            </button>
                            <button
                              type="button"
                              onClick={() => patchVideo({ referenceDetail: 'max' })}
                              className={cn(
                                'px-2 py-1.5 rounded-md border text-xs transition-colors',
                                video.referenceDetail === 'max'
                                  ? 'border-cyan-500/40 text-cyan-300 bg-cyan-500/10'
                                  : 'border-border text-muted-foreground hover:text-foreground',
                              )}
                            >
                              Max (качество)
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Collapsible: Pass 1 (в драфте — единственный проход) */}
                      <div className="space-y-1.5">
                        <button
                          type="button"
                          onClick={() => setShowPass1(!showPass1)}
                          className="w-full flex items-center justify-between px-3 py-1.5 rounded-md bg-[var(--surface-3)] border border-border/60 hover:border-cyan-500/30 transition-all text-left"
                        >
                          <span className="text-xs font-medium text-muted-foreground">
                            {isDraft ? 'Драфт — единственный проход' : 'Pass 1 — Low-res'}
                          </span>
                          <span className={cn('text-[10px] text-muted-foreground transition-transform', showPass1 && 'rotate-180')}>▼</span>
                        </button>

                        {showPass1 && (
                          <motion.div
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: 'auto' }}
                            className="space-y-3 pl-1 overflow-hidden"
                          >
                            {/* Разрешение канвы Pass 1 — только 'full': в драфте
                                разрешение берётся из ОСНОВНЫХ настроек сверху */}
                            {!isDraft && (
                            <div className="space-y-1">
                              {(() => {
                                // (правка 258) Потолок pass 1 поднят 0.5 → 2.0 МП;
                                // инвариант «не больше финального разрешения» сохранён.
                                // (правка 327) Гарантированный минимум потолка 1.0 МП —
                                // зеркалит clampLowResMP в шаблоне.
                                const finalMP = video.finalResolution > 0 ? video.finalResolution : 0.7
                                const maxLowRes = Math.min(2, Math.max(finalMP, 1))
                                return (
                                  <SettingSlider
                                    label="Low-res разрешение (MP)"
                                    labelTitle="Размер чернового прохода: чем меньше, тем быстрее. В конце видео всё равно доводится до полного разрешения. (правка 525) При пресетах качества (480p/720p/1080p) шаблон сам подбирает канву pass 1 с той же пропорцией, что и финальное разрешение — апскейл равномерный, без искажения. Слайдер задаёт максимальный размер pass 1; шаблон может уменьшить его для сохранения пропорции."
                                    value={typeof video.lowResMP === 'number' ? Math.min(video.lowResMP, maxLowRes) : 0.2}
                                    onChange={(v) => {
                                      const clamped = Math.min(maxLowRes, Math.round(v * 100) / 100)
                                      patchVideo({ lowResMP: clamped })
                                    }}
                                    min={0.2}
                                    max={maxLowRes}
                                    step={0.05}
                                    inputMin={0.1}
                                    inputMax={maxLowRes}
                                    inputHint={`0.1–${maxLowRes.toFixed(2)} MP — размер чернового прохода (при пресетах — только скорость)`}
                                  />
                                )
                              })()}
                            </div>
                            )}

                            {/* Шаги: драфт — прямой счётчик единственного прохода;
                                'full' — точка сплита Pass 1 (эффективные шаги). */}
                            <div className="space-y-1">
                              <SettingSlider
                                label={isDraft ? 'Шаги драфта' : 'Шаги сэмплера'}
                                labelTitle={
                                  isDraft
                                    ? 'Сколько шагов делает модель, рисуя видео. 4 — стандарт: быстро и хорошо; больше — аккуратнее, но медленнее.'
                                    : 'Сколько сигм забирает черновой проход (точка сплита). Больше — точнее, но медленнее.'
                                }
                                value={isDraft ? (video.draftSteps ?? 4) : (video.firstSamplerSteps ?? 6)}
                                onChange={(v) =>
                                  patchVideo(
                                    isDraft
                                      ? { draftSteps: Math.round(v) }
                                      : { firstSamplerSteps: Math.round(v) },
                                  )
                                }
                                min={isDraft ? 2 : 2}
                                max={isDraft ? 16 : 30}
                                step={1}
                                inputMin={isDraft ? 2 : 1}
                                inputMax={isDraft ? 30 : 128}
                                inputHint={
                                  isDraft
                                    ? '2–30 шагов единственного прохода (стандарт — 4)'
                                    : '1–128 шагов. Выше 30 — заметно дольше генерация'
                                }
                              />
                            </div>

                            {/* Всего шагов в расписании pass 1 — задаётся отдельно
                                от точки сплита: по умолчанию «6 из 6», можно взять
                                «6 из 8». */}
                            {!isDraft && (
                              <div className="space-y-1">
                                <SettingSlider
                                  label="Всего шагов (pass 1)"
                                  labelTitle={
                                    'Длина расписания BasicScheduler, из которого SplitSigmas ' +
                                    'берёт верхнюю часть для чернового прохода. По умолчанию — ' +
                                    'столько же, сколько у сплита («6 из 6»). Увеличьте, чтобы ' +
                                    'взять, например, «6 из 8».'
                                  }
                                  value={pass1TotalSteps}
                                  onChange={(v) =>
                                    patchVideo({ firstSamplerTotalSteps: Math.round(v) })
                                  }
                                  min={2}
                                  max={64}
                                  step={1}
                                  inputMin={2}
                                  inputMax={128}
                                  inputHint="2–128 шагов расписания. По умолчанию — как у сплита (6/6)"
                                />
                                {/* Живая сводка: что реально получится — чтобы сравнивать
                                    качество, не считая формулы в голове. */}
                                <p className="text-[10px] text-muted-foreground/70 leading-snug">
                                  Pass 1: {pass1Split} из {pass1TotalSteps} · σ 1.0 → {pass1SigmaEnd.toFixed(3)} ·
                                  Pass 2: σ {pass2SigmaStart} → 0 ({pass2Steps} шага)
                                </p>
                              </div>
                            )}

                      <div className="space-y-1">
                        <Label
                          className="text-xs text-muted-foreground"
                          title="Способ, которым модель рисует кадры. Влияет на детализацию и стабильность; если не уверены — оставьте euler."
                        >
                          Сэмплер
                        </Label>
                        <Select
                          value={video.pass1Sampler || 'euler'}
                          onValueChange={(v) => patchVideo({ pass1Sampler: v })}
                        >
                          <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                            <SelectValue placeholder="Выберите" />
                          </SelectTrigger>
                          <SelectContent className="bg-[var(--surface-3)] border-border">
                            {SAMPLER_OPTIONS.map((o) => (
                              <SelectItem key={o.value} value={o.value}>
                                {o.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="space-y-1">
                        <Label
                          className="text-xs text-muted-foreground"
                          title="Как модель распределяет работу между шагами. Обычно лучше оставить simple."
                        >
                          Планировщик
                        </Label>
                        <Select
                          value={video.pass1Scheduler || 'simple'}
                          onValueChange={(v) => patchVideo({ pass1Scheduler: v })}
                        >
                          <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                            <SelectValue placeholder="Выберите" />
                          </SelectTrigger>
                          <SelectContent className="bg-[var(--surface-3)] border-border">
                            {SCHEDULER_OPTIONS.map((o) => (
                              <SelectItem key={o.value} value={o.value}>
                                {o.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </motion.div>
                  )}
                </div>

                {/* Collapsible: Pass 2 — только пайплайн 'full' */}
                {!isDraft && (
                <div className="space-y-1.5">
                  <button
                    type="button"
                    onClick={() => setShowPass2(!showPass2)}
                    className="w-full flex items-center justify-between px-3 py-1.5 rounded-md bg-[var(--surface-3)] border border-border/60 hover:border-cyan-500/30 transition-all text-left"
                  >
                    <span className="text-xs font-medium text-muted-foreground">Pass 2 — High-res</span>
                    <span className={cn('text-[10px] text-muted-foreground transition-transform', showPass2 && 'rotate-180')}>▼</span>
                  </button>

                  {showPass2 && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      className="space-y-3 pl-1 overflow-hidden"
                    >
                      <div className="space-y-1">
                        <Label
                          className="text-xs text-muted-foreground"
                          title="Сколько шагов делает финальный проход детализации. Больше — чётче картинка, но дольше."
                        >
                          Sigma-профиль (шаги)
                        </Label>
                        <Select
                          value={video.sigmaVariant || '3step'}
                          onValueChange={(v) => patchVideo({ sigmaVariant: v })}
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

                      <div className="space-y-1">
                        <Label
                          className="text-xs text-muted-foreground"
                          title="Способ, которым модель рисует кадры. Влияет на детализацию и стабильность; если не уверены — оставьте euler."
                        >
                          Сэмплер
                        </Label>
                        <Select
                          value={video.pass2Sampler || 'euler'}
                          onValueChange={(v) => patchVideo({ pass2Sampler: v })}
                        >
                          <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                            <SelectValue placeholder="Выберите" />
                          </SelectTrigger>
                          <SelectContent className="bg-[var(--surface-3)] border-border">
                            {SAMPLER_OPTIONS.map((o) => (
                              <SelectItem key={o.value} value={o.value}>
                                {o.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                    </motion.div>
                  )}
                </div>
                )}
              </>
                  )
                })()}
              </motion.div>
            )}
          </div>
        </div>

        {/* Pinned bottom: generation status */}
        {/* (правка 475) панель статуса/превью — surface-1, в цвет панели настроек */}
        <div className="shrink-0 border-t border-border p-3 bg-[var(--surface-1)]/90 backdrop-blur-sm">
          <GenerationStatus
            isGenerating={isGenerating}
            phase={phase}
            progressPercent={progressPercent}
            statusMessage={statusMessage}
            error={error}
            onInterrupt={interrupt}
            onReset={reset}
            startedAt={videoStartedAt}
            promptId={promptId}
          />
        </div>
      </div>

      {/* RIGHT: prompt + results */}
      <div className="flex-1 flex flex-col min-w-0 bg-[var(--surface-1)]">
        {/* Prompt card — takes all available space, results grid stays at bottom */}
        <div className="p-5 pb-3 space-y-3 aurora-bg overflow-hidden flex flex-col shrink-0">
          <div className="space-y-2 flex flex-col">
            <div className="flex items-center justify-between shrink-0">
              <Label className="text-sm font-medium text-foreground flex items-center gap-2">
                <SparklesIcon className="w-4 h-4 text-cyan-400" />
                Описание видео
              </Label>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-muted-foreground/70 hidden sm:block">
                  <kbd className="px-1.5 py-0.5 rounded border border-border bg-[var(--surface-2)] font-mono text-[10px]">Ctrl</kbd>
                  {' + '}
                  <kbd className="px-1.5 py-0.5 rounded border border-border bg-[var(--surface-2)] font-mono text-[10px]">Enter</kbd>
                  {' — запустить'}
                </span>
              </div>
            </div>
            <div className="relative">
              <MentionTextarea
                value={video.prompt}
                onChange={setPrompt}
                onKeyDown={handleKeyDown}
                placeholder="A girl with <Picture 1> walks through the market from <Video 1> and says: <d>Almost there.</d> …"
                mentions={mentions}
                className="h-[220px] pr-12"
              />
              {/* (правка 717) Кнопки поля — вертикальная колонка с ровными
                  интервалами (PromptFieldTools). Раньше каждая позиционировалась
                  сама (right-2 / right-10 / right-[4.25rem]) и налезала на
                  соседей. */}
              <PromptFieldTools>
                <PromptEditButton onOpen={() => setPromptEditorOpen(true)} />
                {/* (правка 691) «Очистить» + «Исправить» — над микрофоном (PromptFixButton/PromptClearButton). */}
                <PromptClearButton
                  disabled={!video.prompt.trim()}
                  onClear={() => setPrompt('')}
                />
                <PromptFixButton onFix={() => setFixOpen(true)} />
              </PromptFieldTools>
              {/* (правка 74) Голосовой ввод: круглый микрофон внутри поля промпта */}
              {/* (правка 118) hotkey: R/К — диктовка в поле промпта */}
              <VoiceInputButton
                hotkey
                onText={(t) => {
                  const cur = video.prompt
                  setPrompt((cur ? cur.trimEnd() : '') ? `${cur.trimEnd()} ${t}` : t)
                }}
              />
              <PromptEditorDialog
                open={promptEditorOpen}
                onOpenChange={setPromptEditorOpen}
                initialText={video.prompt}
                onSave={setPrompt}
                onSaveAndRun={() => {
                  void handleGenerate()
                }}
                placeholder="A girl with <Picture 1> walks through the market from <Video 1> and says: <d>Almost there.</d> …"
                mentions={mentions}
              />
              {/* (правка 691) Диалог «Исправить промпт» из поля: задание +
                  текущий черновик уходят в generate-чат ассистента. */}
              <PromptFixDialog
                open={fixOpen}
                onOpenChange={setFixOpen}
                hint="Промпт и ваше задание уйдут в чат ассистента вкладки «Генерация» — ответ можно будет вставить обратно кнопкой «В промпт». Ctrl+Enter — отправить, Esc — отмена."
                onSubmit={(req) => requestImprovePrompt(video.prompt, { mode: 'generate', fixRequest: req })}
              />
            </div>
            {/* Live prompt quality hints (non-blocking) */}
            <PromptQuality prompt={video.prompt} refsCount={video.refs.length} />

            {/* Prompt tools: history & ready-made examples.
                Dropdowns render in a portal (document.body) — inside the
                panel they would fall behind the video gallery stacking
                contexts. */}
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
                    ? 'border-cyan-500/40 text-cyan-300 bg-cyan-500/10'
                    : 'border-border text-muted-foreground hover:text-foreground',
                )}
              >
                <HistoryIcon className="w-3 h-3" />
                История
                {mounted && historyEntries.length > 0 && (
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
                    ? 'border-cyan-500/40 text-cyan-300 bg-cyan-500/10'
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

          <div className="flex items-center gap-3">
            <div className="flex flex-wrap items-center gap-1.5 flex-1 min-w-0">{badges}</div>

            {/* (правка 91) Выбор папки проекта: видео этой генерации лягут
                в неё, галерея ниже показывает только её. Показывается только
                когда папки уже есть (создаются во вкладке «Галерея»). */}
            {galleryFolders.length > 0 && (
              <div className="relative shrink-0">
                <button
                  type="button"
                  onClick={() => setFolderMenuOpen(!folderMenuOpen)}
                  className={cn(
                    'h-11 inline-flex items-center gap-1.5 px-3 rounded-lg border text-xs transition-colors',
                    outputFolder
                      ? 'border-violet-500/40 bg-violet-500/10 text-violet-300'
                      : 'border-border bg-[var(--surface-2)] text-muted-foreground hover:text-foreground',
                  )}
                  title={outputFolder ? `Папка проекта: ${outputFolder} — видео кладутся в неё, галерея показывает её и подпапки` : 'Папка проекта: видео кладутся в неё, галерея показывает только её'}
                >
                  <FolderIcon className="w-3.5 h-3.5" />
                  <span className="max-w-[120px] truncate">{outputFolder || 'Общая папка'}</span>
                  <ChevronDownIcon className={cn('w-3 h-3 transition-transform', folderMenuOpen && 'rotate-180')} />
                </button>
                {folderMenuOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setFolderMenuOpen(false)} />
                    <div className="absolute bottom-full mb-1.5 right-0 z-50 w-52 rounded-lg border border-border bg-[var(--surface-2)] shadow-xl p-1 max-h-64 overflow-y-auto">
                      <button
                        type="button"
                        onClick={() => { patchVideo({ outputFolder: '' }); setFolderMenuOpen(false) }}
                        className={cn(
                          'w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs text-left transition-colors',
                          !outputFolder ? 'bg-violet-500/10 text-violet-300' : 'hover:bg-[var(--surface-3)] text-foreground/80',
                        )}
                      >
                        <FilmIcon className="w-3.5 h-3.5 shrink-0" />
                        <span className="flex-1 truncate">Общая папка</span>
                      </button>
                      {galleryFolders.map((f) => {
                        // (правка 495) Вложенные папки: отступ по глубине,
                        // подпись — лист пути, полный путь — в title.
                        const depth = f.split('/').length - 1
                        const leaf = f.slice(f.lastIndexOf('/') + 1)
                        return (
                          <button
                            key={f}
                            type="button"
                            onClick={() => { patchVideo({ outputFolder: f }); setFolderMenuOpen(false) }}
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
            )}

            <Button
              onClick={() => void handleGenerate()}
              disabled={!canGenerateNow}
              title={
                assistantBusy
                  ? '💬 Ассистент отвечает — дождитесь ответа или прервите его'
                  : canGenerate
                    ? 'Сгенерировать видео (Ctrl+Enter)'
                    : 'Введите промпт'
              }
              className="h-11 px-6 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white border-0 text-sm font-semibold shadow-lg shadow-cyan-500/20"
            >
              {isGenerating ? 'Ещё в очередь' : 'Сгенерировать видео'}
            </Button>
          </div>
        </div>

        {/* Results */}
        <div className="flex-1 overflow-y-auto px-5 pb-5 min-h-0">
          <VideoGalleryGrid
            files={visibleGalleryFiles}
            loading={galleryLoading}
            onRefresh={loadGallery}
            onDeleteFile={deleteFile}
            emptyHint={
              outputFolder
                ? `В папке «${outputFolder}» пока нет видео. Новые генерации лягут в неё.`
                : 'Здесь появятся сгенерированные видео. Опишите сцену, добавьте референс-изображение и нажмите «Сгенерировать видео».'
            }
          />
        </div>
      </div>

      {/* (правка 442) Ассистент — правая боковая панель (чаты режима
          «Генерация»; resize за левую границу, сворачивается в рейл) */}
      <AssistantPanel mode="generate" />

      {/* (правка 719) Просмотр рефов теперь у каждого превью (общий
          компонент RefPreviewThumb) — отдельного диалога на вкладке больше
          нет. Раньше он висел «в конце» и открывался только картинкам-рефам;
          видео-рефы и кадры flf были без просмотра. */}
    </div>
  )
}
