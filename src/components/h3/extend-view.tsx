'use client'

/**
 * ExtendView — отдельная вкладка «Продление видео».
 *
 * Двухколоночный layout (как в GenerateView):
 *   ЛЕВАЯ панель (400px): параметры — исходное видео, рефы, доп. настройки,
 *   статус генерации (закреплён внизу).
 *   ПРАВАЯ панель (flex-1): горизонтальная лента клипов продления (каждый
 *   со своим промптом и длительностью, добавляются слева направо) + badges +
 *   галерея + кнопка «Сгенерировать». Общего промпта нет — conditioning
 *   строится только из промптов клипов.
 *
 * Режим продления (extend) через ноду MiniMaxH3Extender:
 *   - Цепочка клипов (prompt + duration)
 *   - Картинки-рефы (до 9) — для сохранения персонажей/сцены
 *   - Опционально: исходное видео
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import {
  Maximize2Icon,
  PlayIcon,
  PlusIcon,
  SparklesIcon,
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
import { cn } from '@/lib/utils'
import { useGenStore, type VideoRefItem } from '@/lib/gen-store'
import { useVideoGen } from '@/hooks/use-video-gen'
import { useGenProgress } from '@/lib/gen-progress-store'
import { uploadInputFile } from '@/lib/upload'
import { SeedBlock } from './video-shared'
import { GenerationStatus } from './generation-status'
import { VideoGalleryGrid, H3_VIDEO_DND_MIME } from './video-gallery-grid'
import { MentionTextarea, type MentionItem } from './mention-textarea'
import { useVideoGallery } from './use-video-gallery'
import { isStreamActive } from '@/lib/assistant-stream'
import { useExtendTarget } from '@/lib/extend-target-store' // (правка 370) цель «Продлить» из галереи
import { requestImprovePrompt } from '@/hooks/use-improve-prompt' // (правка 427) «Улучшить промпт клипа» → extend-чат
import { AssistantPanel } from './assistant/assistant-panel' // (правка 442) ассистент — правая панель вкладки
import { PromptEditorDialog, PromptFixDialog, PromptFixButton, PromptClearButton, PromptFieldTools } from './prompt-editor-dialog' // (правка 443) редактор клипа + (правка 691) диалог «Исправить» + (правка 692) кнопки на поле
// (правка 719) Превью с полноэкранным просмотром — как на «Генерации».
import { RefPreviewThumb } from './ref-preview-thumb'

function detectKind(name: string): VideoRefItem['kind'] | null {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
  if (['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff'].includes(ext)) return 'image'
  if (['.avi', '.m4v', '.mkv', '.mov', '.mp4', '.webm'].includes(ext)) return 'video'
  if (['.aac', '.flac', '.m4a', '.mp3', '.ogg', '.wav'].includes(ext)) return 'audio'
  return null
}

let _id = 0
function newId(): string {
  return `extref_${Date.now()}_${++_id}`
}

export function ExtendView() {
  const { phase, error, progressValue, progressMax, statusMessage, promptId, generate, interrupt, reset } = useVideoGen()
  const videoStartedAt = useGenProgress((s) => s.video.startedAt)

  const video = useGenStore((s) => s.video)
  const patchVideo = useGenStore((s) => s.patchVideo)

  const isGenerating = phase === 'submitting' || phase === 'queued' || phase === 'running'
  // (правка 341) isStreamActive() в теле рендера нереактивен: кнопка
  // оставалась разблокированной посреди ответа ассистента. Поллим
  // /api/llm/status (как generate-view), плюс локальный override по
  // активному стриму в этой вкладке.
  const [assistantBusy, setAssistantBusy] = useState(false)
  // (правка 587) Те же защиты, что у generate-view (правка 110): серверный
  // busy-флаг мог протухать (утёкший streaming-счётчик), а этот опрос брал
  // его «как есть» — «Сгенерировать продление» оставалось заблокированным
  // бесконечно (generate-view лечил замок, но только когда открыт он).
  // Override: стрим в этой вкладке НЕ активен → busy считаем застарелым;
  // 60-секундный fallback — принудительный /api/llm/release.
  const firstBusyAtRef = useRef<number | null>(null)
  const lockReleasedRef = useRef(false)
  useEffect(() => {
    let stopped = false
    const tick = async () => {
      if (stopped) return
      if (isStreamActive()) {
        setAssistantBusy(true)
        firstBusyAtRef.current = Date.now()
        return
      }
      if (sessionStorage.getItem('assistantUsed') !== '1') {
        setAssistantBusy(false)
        return
      }
      try {
        const r = await fetch('/api/llm/status', { signal: AbortSignal.timeout(4000) })
        const s = (await r.json()) as { assistantBusy?: boolean }
        if (stopped) return
        const busy = s.assistantBusy === true && !isStreamActive()
        setAssistantBusy(busy)
        if (busy) {
          if (firstBusyAtRef.current === null) firstBusyAtRef.current = Date.now()
          const stuckMs = Date.now() - firstBusyAtRef.current
          if (!lockReleasedRef.current && stuckMs > 60_000 && !isStreamActive()) {
            // (правка 692) Два pass: сначала non-force, потом force.
            void fetch('/api/llm/release', { method: 'POST' }).catch(() => {})
            setTimeout(() => {
              if (!isStreamActive()) {
                void fetch('/api/llm/release?force=1', { method: 'POST' }).catch(() => {})
              }
            }, 2000)
            lockReleasedRef.current = true
            firstBusyAtRef.current = null
            setAssistantBusy(false)
            toast.warning('Ассистент', { description: 'Блокировка снята принудительно (засела после ответа).' })
          }
        } else {
          firstBusyAtRef.current = null
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
  // (правка 290) Очередь: НЕ блокируем кнопку при активной генерации —
  // ComfyUI ставит задачи в очередь, mutex освобождается после submit.
  // Блокируем только когда ассистент занят (VRAM-конфликт).
  const canGenerateNow = !assistantBusy

  /* ──────────── UI state ──────────── */
  const [uploadingRefs, setUploadingRefs] = useState(false)
  const [refsDragOver, setRefsDragOver] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [showPass1, setShowPass1] = useState(false)
  const [showPass2, setShowPass2] = useState(false) // (правка 473)
  // (правка 719) Просмотр рефов переехал в общий компонент RefPreviewThumb
  // (у каждого превью свой просмотрщик) — своего состояния тут больше нет.
  // (правка 443) Индекс клипа, открытого в полноэкранном редакторе промпта
  // (null — редактор закрыт). Карточки клипов — фиксированной высоты, длинный
  // промпт смотрим/правим в редакторе.
  const [editingClip, setEditingClip] = useState<number | null>(null)
  // (правка 691) «Исправить промпт» прямо из карточки клипа: диалог
  // «что изменить» + промпт клипа уходят в extend-чат (requestImprovePrompt
  // уже импортирован, правка 427).
  const [fixClip, setFixClip] = useState<number | null>(null)
  const extendImageInputRef = useRef<HTMLInputElement>(null)
  const videoInputRef = useRef<HTMLInputElement>(null)
  const clipsStripRef = useRef<HTMLDivElement>(null)
  const [sourceVideo, setSourceVideo] = useState<{ name: string; previewUrl: string } | null>(null)
  const sourceVideoPath = video.extendSourceVideoPath
  const [videoDragOver, setVideoDragOver] = useState(false)

  // Шаги клипа «авто»: первый проход ИСХОДНИКА из его .meta.json (продление
  // продолжает исходник — его расписание и берём). null = меты нет (фолбэк —
  // firstSamplerSteps, как в шаблоне). Явное значение из инпута побеждает.
  const [autoClipSteps, setAutoClipSteps] = useState<number | null>(null)
  useEffect(() => {
    const name = video.extendSourceName
    if (!name) { setAutoClipSteps(null); return }
    const sub = video.extendSourceSubfolder ? video.extendSourceSubfolder + '/' : ''
    let cancelled = false
    fetch(`/api/comfy/meta?path=${encodeURIComponent(sub + name)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Record<string, unknown> | null) => {
        if (cancelled || !d) return
        const p = (d.params && typeof d.params === 'object' ? d.params : d) as Record<string, unknown>
        const steps = typeof p.pass1_steps === 'number' ? p.pass1_steps
          : typeof p.draft_steps === 'number' ? p.draft_steps
          : null
        setAutoClipSteps(steps && steps >= 2 ? steps : null)
      })
      .catch(() => { if (!cancelled) setAutoClipSteps(null) })
    return () => { cancelled = true }
  }, [video.extendSourceName, video.extendSourceSubfolder])
  // Эффективное значение для инпута: override → авто из меты → firstSamplerSteps.
  const effectiveClipSteps = video.extendClipSteps ?? autoClipSteps ?? video.firstSamplerSteps ?? 6

  const extendRefs = video.extendImageRefs
  const progressPercent = progressMax > 0 ? Math.round((progressValue / progressMax) * 100) : 0

  // (правка 296, 342) Синхронизация sourceVideo с store: реагируем на ЛЮБУЮ
  // смену extendSourceVideoPath (не только «store есть, локально пусто»):
  // новый путь → серверное превью (blob-превью при этом отзываем — правка
  // 343), очистка пути → сбрасываем локальное состояние.
  useEffect(() => {
    if (!sourceVideoPath) {
      setSourceVideo((prev) => {
        if (prev?.previewUrl.startsWith('blob:')) {
          try { URL.revokeObjectURL(prev.previewUrl) } catch { /* уже отозван */ }
        }
        return null
      })
      return
    }
    setSourceVideo((prev) => {
      if (prev && prev.name === sourceVideoPath) return prev
      if (prev?.previewUrl.startsWith('blob:')) {
        try { URL.revokeObjectURL(prev.previewUrl) } catch { /* уже отозван */ }
      }
      return {
        name: sourceVideoPath,
        previewUrl: `/api/comfy/file?filename=${encodeURIComponent(sourceVideoPath)}&type=input`,
      }
    })
  }, [sourceVideoPath]) // eslint-disable-line react-hooks/exhaustive-deps

  // (правка 304) При добавлении клипа прокручиваем ленту в конец,
  // чтобы новая карточка сразу была видна.
  const clipsCount = video.extendClips.length
  useEffect(() => {
    const el = clipsStripRef.current
    if (el) el.scrollTo({ left: el.scrollWidth, behavior: 'smooth' })
  }, [clipsCount])

  // (правка 289) Mention items для тэгов <Picture N> в промптах клипов.
  // Аналогично generate-view: нумерация по порядку добавленных рефов.
  const clipMentions: MentionItem[] = useMemo(() => {
    return extendRefs.map((ref, i) => ({
      id: ref.id,
      label: ref.name,
      trigger: `<Picture ${i + 1}>`,
      kind: 'image',
      color: 'bg-purple-500/15 text-purple-400',
      previewUrl:
        ref.previewUrl ||
        (ref.path
          ? `/api/comfy/file?filename=${encodeURIComponent(ref.path)}&type=input`
          : undefined),
    }))
  }, [extendRefs])

  /* ──────────── Upload handlers ──────────── */

  const addExtendImageFiles = useCallback(async (files: File[]) => {
    const images = files.filter((f) => detectKind(f.name) === 'image')
    const rejected = files.length - images.length
    if (rejected > 0) toast.error(`Только картинки — ${rejected} файл(ов) отклонено`)
    if (!images.length) return
    const current = useGenStore.getState().video.extendImageRefs.length
    const available = Math.max(0, 9 - current)
    if (available === 0) {
      toast.error('Максимум 9 картинок-рефов для продления')
      return
    }
    setUploadingRefs(true)
    try {
      const items: VideoRefItem[] = []
      for (const file of images.slice(0, available)) {
        const { path } = await uploadInputFile(file)
        items.push({
          id: newId(),
          kind: 'image',
          path,
          name: file.name,
          previewUrl: URL.createObjectURL(file),
          role: '',
          imageIntent: 'identity',
          includeAudio: false,
        })
      }
      const prev = useGenStore.getState().video.extendImageRefs
      patchVideo({ extendImageRefs: [...prev, ...items] })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка загрузки')
    } finally {
      setUploadingRefs(false)
    }
  }, [patchVideo])

  const [uploadingVideo, setUploadingVideo] = useState(false)

  const handleVideoSelect = useCallback(async (file: File) => {
    if (detectKind(file.name) !== 'video') {
      toast.error('Выберите видеофайл (mp4, webm, mov, ...)')
      return
    }
    // (правка 343) Старое blob-превью отзываем при замене — иначе утечка.
    const blobUrl = URL.createObjectURL(file)
    setSourceVideo((prev) => {
      if (prev?.previewUrl.startsWith('blob:')) {
        try { URL.revokeObjectURL(prev.previewUrl) } catch { /* уже отозван */ }
      }
      return { name: file.name, previewUrl: blobUrl }
    })
    // (правка 164) Сразу загружаем видео в ComfyUI input/ (или staged) —
    // без этого нода LoadVideo не найдёт файл и видео не будет учитываться.
    setUploadingVideo(true)
    try {
      // (правка 291) /api/comfy/upload возвращает durationSec (ffprobe на сервере)
      // для видео-файлов — храним в store, badges/карточки клипов сразу
      // показывают «итого ~X с» вместе с оригиналом.
      const form = new FormData()
      form.append('image', file)
      const res = await fetch('/api/comfy/upload', { method: 'POST', body: form })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`Upload failed (${res.status}): ${text.slice(0, 200)}`)
      }
      const data = await res.json() as { name?: string; durationSec?: number; staged?: boolean }
      if (!data.name) throw new Error('Upload: no name in response')
      const duration = typeof data.durationSec === 'number' && data.durationSec > 0 ? data.durationSec : 0
      // (правка 363) Файл с диска — не из галереи: папка результата = outputFolder
      patchVideo({ extendSourceVideoPath: data.name, extendSourceDuration: duration, extendSourceSubfolder: null, extendSourceName: null })
      if (duration > 0) {
        toast.success(`Исходник: ${file.name} (${duration.toFixed(1)} с)`)
      } else {
        toast.success(`Исходник: ${file.name}`)
      }
      // (правка 343) Файл уже на сервере — blob-превью больше не нужно,
      // отзываем и переключаемся на серверный URL (если имя совпало с
      // именем файла, эффект синхронизации сам бы blob не отозвал).
      try { URL.revokeObjectURL(blobUrl) } catch { /* уже отозван */ }
      setSourceVideo({ name: data.name, previewUrl: `/api/comfy/file?filename=${encodeURIComponent(data.name)}&type=input` })
    } catch (e) {
      // (правка 344) Ошибка загрузки — сбрасываем превью, не оставляем
      // карточку «как будто видео выбрано»: generate всё равно упал бы
      // на отсутствии файла в input/.
      try { URL.revokeObjectURL(blobUrl) } catch { /* уже отозван */ }
      setSourceVideo(null)
      toast.error(e instanceof Error ? e.message : 'Ошибка загрузки видео')
    } finally {
      setUploadingVideo(false)
    }
  }, [patchVideo])

  // (правка 265, фикс) Импорт видео из галереи (DnD карточки) в ComfyUI input/.
  // Нода продления (VHS_LoadVideo) и проба размеров/кадров в /api/comfy/generate
  // ищут источник ПО ИМЕНИ В Папке input/ — поэтому сервер копирует output → input
  // и отдаёт basename (как uploadInputFile для файла с диска), а не абсолютный путь.
  const importGalleryVideo = useCallback(async (filename: string, subfolder: string) => {
    if (!filename) {
      toast.error('Не удалось прочитать перетащенное видео')
      return
    }
    // Превью из общей папки output — /api/comfy/file (type=output) стримит локально.
    setSourceVideo({ name: filename, previewUrl: `/api/comfy/file?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder || '')}` })
    setUploadingVideo(true)
    try {
      const r = await fetch('/api/extend/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, subfolder: subfolder || '' }),
      })
      const d = (await r.json().catch(() => ({}))) as { ok?: boolean; name?: string; path?: string; error?: string; durationSec?: number }
      if (!r.ok || !d.ok || !d.name) {
        throw new Error(d.error ?? `import → ${r.status}`)
      }
      // (правка 291) Длительность исходника из ответа импорта (сервер ffprobe)
      const dur = typeof d.durationSec === 'number' && d.durationSec > 0 ? d.durationSec : 0
      // (правка 363) Источник из галереи — запоминаем её подпапку: результат
      // продления (и автосклейка) падает в папку оригинала.
      // (правка 385) И имя ОРИГИНАЛА в output/ (копия в input/ получает
      // случайное имя): по имени+папке роут резолвит латент исходника.
      patchVideo({
        extendSourceVideoPath: d.name,
        extendSourceDuration: dur,
        extendSourceSubfolder: subfolder || '',
        extendSourceName: filename,
      })
      // (правка 389) Наследуем картинки-рефы ОРИГИНАЛА из его .meta.json —
      // раньше при «Продлить»/DnD из галереи референсы источника (в т.ч. у
      // драфтов, pipeline='draft') терялись: клипы генерились без якорей
      // идентичности. Сайдкар пишется во всех режимах (правка ~305+), читаем
      // его через /api/comfy/meta. Пути в мете — имена в ComfyUI input/;
      // /api/comfy/generate умеет читать extendRefs прямо с диска input/.
      // Добавляем только те, которых ещё нет в списке (по path), лимит 9.
      try {
        const metaPath = subfolder ? `${subfolder}/${filename}` : filename
        const mr = await fetch(`/api/comfy/meta?path=${encodeURIComponent(metaPath)}`)
        if (mr.ok) {
          const meta = (await mr.json()) as {
            references?: Array<{ type?: string; path?: string; role?: string }>
            minimax_h3_references?: Array<{ type?: string; path?: string; role?: string }>
            generation_mode?: string
            first_frame?: string | null
          }
          const list = Array.isArray(meta.references) ? meta.references
            : Array.isArray(meta.minimax_h3_references) ? meta.minimax_h3_references
            : []
          const imgRefs = list.filter((r) => r?.type === 'image' && typeof r?.path === 'string' && r.path.length > 0)
          // (правка 452) Исходник сгенерирован в режиме «Кадры»: кадры в
          // references не попадают (там только аудио), поэтому продление такого
          // видео шло вообще без якорей внешности. Первый кадр из меты
          // добавляем как картинку-реф (с дедупликацией ниже).
          const firstFrame =
            meta.generation_mode === 'flf' && typeof meta.first_frame === 'string' && meta.first_frame
              ? meta.first_frame
              : null
          if (firstFrame && !imgRefs.some((r) => r.path === firstFrame)) {
            imgRefs.unshift({ type: 'image', path: firstFrame, role: 'первый кадр оригинала' })
          }
          if (imgRefs.length > 0) {
            const prev = useGenStore.getState().video.extendImageRefs
            const known = new Set(prev.map((r) => r.path))
            const inherited: VideoRefItem[] = []
            for (const r of imgRefs) {
              if (prev.length + inherited.length >= 9) break
              const p = r.path as string
              if (known.has(p)) continue
              known.add(p)
              inherited.push({
                id: newId(),
                kind: 'image',
                path: p,
                name: p.split(/[\\/]/).pop() ?? p,
                previewUrl: `/api/comfy/file?filename=${encodeURIComponent(p)}&type=input`,
                role: typeof r.role === 'string' ? r.role : '',
                imageIntent: 'identity',
                includeAudio: false,
              })
            }
            if (inherited.length > 0) {
              patchVideo({ extendImageRefs: [...prev, ...inherited] })
              toast.success(`Референсы оригинала: +${inherited.length} из метаданных`)
            }
          }
        }
      } catch { /* нет сайдкара/сеть — продление просто без наследованных рефов */ }
      toast.success(dur > 0 ? `Исходное видео: ${filename} (${dur.toFixed(1)} с)` : `Исходное видео: ${filename}`)
    } catch (e) {
      // (правка 344) Ошибка импорта — сбрасываем превью и путь в store,
      // чтобы карточка не выглядела «выбранной» при отсутствующем файле.
      setSourceVideo(null)
      patchVideo({ extendSourceVideoPath: '', extendSourceDuration: 0, extendSourceSubfolder: null, extendSourceName: null })
      toast.error(e instanceof Error ? e.message : 'Ошибка импорта видео из галереи')
    } finally {
      setUploadingVideo(false)
    }
  }, [patchVideo])

  // (правка 370) Цель «Продлить» из галереи: клик по пункту меню в
  // video-gallery-grid кладёт {filename, subfolder} в ExtendTargetStore и шлёт
  // 'h3:goto-extend' — забираем цель и импортируем как обычный DnD из галереи.
  const galleryTarget = useExtendTarget((s) => s.target)
  const clearGalleryTarget = useExtendTarget((s) => s.clear)
  useEffect(() => {
    if (!galleryTarget) return
    clearGalleryTarget()
    void importGalleryVideo(galleryTarget.filename, galleryTarget.subfolder)
  }, [galleryTarget, clearGalleryTarget, importGalleryVideo])

  /* ──────────── Generate ──────────── */

  // (правка 333) Guard от случайного дабл-клика: пока generate() не вернулся
  // (POST сабмита в полёте, prompt_id ещё не получен), повторный вызов
  // игнорируется. Намеренные повторные запуски не блокируются.
  const submitInFlightRef = useRef(false)

  const handleGenerate = useCallback(async () => {
    if (assistantBusy) {
      toast.error('Ассистент отвечает — дождитесь ответа или прервите его')
      return
    }
    const v = useGenStore.getState().video
    // (правка 177) Жёсткий чек исходного видео: без него в итоговом склеенном
    // файле не будет оригинала (а это ключевой UX-требование — «полное
    // бесшовно склеенное видео, включая оригинал в начале»).
    if (!v.extendSourceVideoPath) {
      toast.error('Загрузите исходное видео — без него продление не имеет смысла (исходный фрагмент должен быть в итоге склеен с новыми клипами)')
      return
    }
    if (v.extendClips.length === 0) {
      toast.error('Добавьте хотя бы один клип')
      return
    }
    if (v.extendClips.every((c) => !c.prompt.trim())) {
      toast.error('Заполните промпт хотя бы одного клипа')
      return
    }
    if (uploadingVideo) {
      toast.error('Видео ещё загружается — дождитесь завершения')
      return
    }

    // (правка 165) Если загружено исходное видео — автоматически вставляем
    // <Video 1> в каждый клип-промпт. Без этой тега модель НЕ использует
    // видео-реф для ракурса/сцены/движения камеры.
    //
    // (правка 170) Ref2VA — это *reference-conditioning*: исходное видео задаёт
    // «мягкий» контекст, а не жёсткий якорь, поэтому без явной инструкции модель
    // может сдвинуть ракурс.
    //
    // (правка 197) КРИТИЧНО для двухпроходной схемы: pass 2 перешумляет латент
    // до σ≈0.9 и пересобирает сцену по conditioning. Если в промпте есть своя
    // декорация («in the room» и т.п.), ТЕКСТ побеждает мягкий <Video 1>-реф —
    // оригинал перестаёт продолжаться (воспроизведено: лес → комната).
    // Директива явно связывает локацию/свет/персонажей с <Video 1> и проверена
    // прогоном: с ней оба клипа продолжают исходную сцену с теми же промптами.
    const CAMERA_LOCK =
      'You are continuing the reference video <Video 1>: keep the exact same scene, location, environment, lighting and time of day as shown in <Video 1>; the same characters with the same appearance and clothing. Continue exactly the same camera angle, framing and camera movement as the reference video; keep the same subject position and shot. Do not change the location, do not introduce a new setting or new characters, do not cut to a new shot.'
    const hasSourceVideo = !!v.extendSourceVideoPath
    const clips = v.extendClips.map((c) => {
      let prompt = c.prompt.trim()
      if (hasSourceVideo && prompt) {
        if (!/<Video 1>/i.test(prompt)) {
          prompt = `<Video 1> ${prompt}`
        }
        if (!/camera angle|ракурс|same scene|same location/i.test(prompt)) {
          prompt = `${prompt} ${CAMERA_LOCK}`
        }
      }
      // (правка 309, ослаблена правкой 434) Жёсткий кламп: клипы продления
      // минимум 3 с (было 5: при коротких клипах первый кадр клипа 0
      // «отъезжал» от хвоста исходника; на 3 с риск ниже, а гибкость нужна).
      // Кламп здесь, чтобы не пробились значения из сохранённых настроек/
      // очереди мимо UI.
      return { prompt, duration: Math.max(3, c.duration), seed: c.seed }
    })

    // Общий промпт удалён из UI: conditioning строят только промпты клипов.
    // В `prompt` идёт первый ОСМЫСЛЕННЫЙ клиповый промпт (2+ буквы — не «.»
    // и прочий мусор) — как подпись карточки очереди и промпт в .meta.json
    // сайдкаре: по нему refine подбирает caption, точка там якорем быть не
    // может (генерацию он не меняет: клипы всегда непусты, фолбэк
    // buildExtendWorkflow не срабатывает).
    const MEANINGFUL_WORD = /[a-zA-Zа-яА-ЯёЁ]{2,}/
    const labelPrompt = v.extendClips.find((c) => MEANINGFUL_WORD.test(c.prompt))?.prompt.trim() ?? ''
    // (правка 333) Флаг синхронно до await — дабл-клик за время сабмита
    // не шлёт дубль задачи.
    if (submitInFlightRef.current) return
    submitInFlightRef.current = true
    // (правка 696) Зафиксировать stageKind на момент старта: во время
    // генерации переключение «Драфт/Полное» не меняет шаблон подписи.
    useGenProgress.getState().setVideoFrozenStageKind(v.extendTwoPass ? 'clips2' : 'clips')
    try {
      await generate({
      modelType: v.modelType,
      mode: 'extend',
      prompt: labelPrompt,
      seed: v.seed,
      resolution: v.resolution,
      videoLength: v.videoLength,
      extendClips: clips,
      extendRefs: v.extendImageRefs.map((r) => r.path),
      extendSourceVideo: v.extendSourceVideoPath || undefined,
      extendSourceName: v.extendSourceName ?? undefined, // (правка 385)
      extendSourceSubfolder: v.extendSourceSubfolder ?? undefined, // (правка 385)
      extendTwoPass: v.extendTwoPass, // (правка 423) два прохода: low-res → апскейл → рефайн
      // (правка 174) Debug: ensure extendSourceVideoPath is not lost
      referenceDetail: v.referenceDetail || 'match', // (правка 307) — выбор Match/Max как в генерации
      lowResMP: v.lowResMP ?? 0.2,
        firstSamplerSteps: v.firstSamplerSteps ?? 6,
        // Шаги клипа: явное значение побеждает; иначе «авто» — шаги первого
        // прохода исходника из его меты (посчитаны выше autoClipSteps); нет
        // меты — undefined, сервер возьмёт firstSamplerSteps (фолбэк шаблона).
        extendClipSteps: v.extendClipSteps ?? autoClipSteps ?? undefined,
      sigmaVariant: v.sigmaVariant || '3step',
      pass2Sampler: v.pass2Sampler || 'euler', // (правка 473) раньше не отправлялся — pass 2 продления всегда шёл на euler
      pass1Sampler: v.pass1Sampler || 'euler',
      pass1Scheduler: v.pass1Scheduler || 'simple',
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
      outputSubfolder: v.extendSourceSubfolder ?? (v.outputFolder || ''), // (правка 363) галерея-источник → папка оригинала
      })
    } finally {
      submitInFlightRef.current = false
    }
  }, [generate, assistantBusy, uploadingVideo, autoClipSteps])

  /* ──────────── Gallery ──────────── */
  const { files: galleryFiles, loading: galleryLoading, load: loadGallery, deleteFile } = useVideoGallery({ phase })

  /* ──────────── Badges ──────────── */
  // (правка 291) Итоговая длительность = исходник + все клипы (без учёта
  // перекрытия швов — оценка «сколько секунд будет по итогу вместе с
  // оригиналом», а не только добавленных клипов).
  const clipsSum = video.extendClips.reduce((s, c) => s + c.duration, 0)
  const sourceDur = typeof video.extendSourceDuration === 'number' && video.extendSourceDuration > 0
    ? video.extendSourceDuration
    : 0
  const totalDuration = sourceDur + clipsSum
  const badges = (
    <>
      <Badge variant="secondary" className="text-[10px]">Как в исходнике</Badge>
      {/* (правка 291) Итоговая длительность: исходник + клипы (если исходник
          известен); иначе только сумма клипов. */}
      <Badge variant="secondary" className="text-[10px]">
        {totalDuration.toFixed(1)} с{sourceDur > 0 ? ' (исх.' + sourceDur.toFixed(0) + '+' + clipsSum + ')' : ''}
      </Badge>
      <Badge variant="secondary" className="text-[10px]">{video.extendClips.length} клип(ов)</Badge>
      {extendRefs.length > 0 && (
        <Badge variant="secondary" className="text-[10px]">{extendRefs.length} реф(ов)</Badge>
      )}
      {/* (правка 247, 423, 437) По умолчанию — ДВУХПРОХОДНАЯ генерация
          (правка 437: low-res pass 1 → апскейл латента → pass 2 рефайн до
          размера исходника, схема «full»-пайплайна генерации). Однопроходный
          «Драфт» — переключатель «Качество прохода» выше (Extender один на
          канве разрешения исходника, цепочка motion-context). */}
      {video.extendTwoPass ? (
        <Badge className="text-[10px] bg-cyan-500/15 text-cyan-400 border-cyan-500/30 hover:bg-cyan-500/15">
          Полное (2 прохода)
        </Badge>
      ) : (
        <Badge className="text-[10px] bg-emerald-500/15 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/15">
          Драфт (1 проход) ✓
        </Badge>
      )}
    </>
  )

  /* ──────────── Render ──────────── */

  return (
    <div className="flex-1 flex min-h-0 min-w-0">
      {/* ═══════════ LEFT: Settings panel (400px) ═══════════ */}
      {/* (правка 472) фон — surface-1, как у Refine/Tile/FPS (единый вид) */}
      <div className="w-[400px] shrink-0 border-r border-border flex flex-col bg-[var(--surface-1)]">
        <div className="flex-1 overflow-y-auto p-4 space-y-4">

          {/* Header */}
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">Параметры продления</h2>
            <Badge className="text-[10px] bg-cyan-500/15 text-cyan-400 border-cyan-500/30 hover:bg-cyan-500/15">
              MiniMax H3
            </Badge>
          </div>

          <Separator className="bg-border opacity-50" />

          {/* Source video (required) */}
          <div className="space-y-2">
            <Label
              className="text-xs text-amber-400"
              title="Видео продолжится с тем же ракурсом, сценой и движением камеры. Готовые клипы автоматически склеиваются с исходником в один ролик."
            >
              Исходное видео <span className="text-amber-400/70">(обязательно)</span>
            </Label>
            <div
              onDragOver={(e) => { e.preventDefault(); setVideoDragOver(true); setRefsDragOver(true) }}
              onDragLeave={() => { setVideoDragOver(false); setRefsDragOver(false) }}
              onDrop={(e) => {
                e.preventDefault()
                setVideoDragOver(false)
                setRefsDragOver(false)
                // (правка 265) Видео из галереи (превьюшка) — импортируем на сервере
                const raw = e.dataTransfer.getData(H3_VIDEO_DND_MIME)
                if (raw) {
                  try {
                    const parsed = JSON.parse(raw) as { filename?: string; subfolder?: string }
                    void importGalleryVideo(parsed.filename ?? '', parsed.subfolder ?? '')
                  } catch {
                    toast.error('Не удалось прочитать перетащенное видео')
                  }
                  return
                }
                const f = Array.from(e.dataTransfer.files).find((x) => detectKind(x.name) === 'video')
                if (f) void handleVideoSelect(f)
                else toast.error('Нужно видео')
              }}
              onClick={() => videoInputRef.current?.click()}
              className={cn(
                'border-2 border-dashed rounded-lg p-3 text-center cursor-pointer transition-all',
                (videoDragOver || refsDragOver) ? 'border-cyan-400 bg-cyan-500/10' : 'border-border hover:border-cyan-500/50 hover:bg-[var(--surface-2)]',
              )}
            >
              {sourceVideo ? (
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    {/* (правка 455) Живое превью исходника вместо голой иконки:
                        preload="metadata" + muted — WebView2 показывает первый
                        кадр без загрузки всего файла. Клик по превью не должен
                        открывать диалог выбора файла (onClick на всей зоне).
                        (правка 719) Клик по превью — просмотр исходника во
                        весь экран (как на вкладке «Генерация»). */}
                    <RefPreviewThumb
                      kind="video"
                      name={sourceVideo.name}
                      url={sourceVideo.previewUrl}
                      className="h-16 w-28 rounded-md object-cover bg-black shrink-0"
                      title="Открыть исходное видео во весь экран"
                      stopPropagation
                    >
                      <video
                        src={sourceVideo.previewUrl}
                        preload="metadata"
                        muted
                        playsInline
                        onClick={(e) => e.stopPropagation()}
                        className="w-full h-full object-cover"
                      />
                    </RefPreviewThumb>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs truncate" title={sourceVideo.name}>{sourceVideo.name}</p>
                      <div className="flex items-center gap-1.5">
                        {/* (правка 291) Показываем длительность исходника, если известна */}
                        {typeof video.extendSourceDuration === 'number' && video.extendSourceDuration > 0 && (
                          <span className="text-[10px] text-cyan-400/80 shrink-0" title="Длительность исходного видео">
                            {video.extendSourceDuration.toFixed(1)} с
                          </span>
                        )}
                        {uploadingVideo && <span className="text-[10px] text-cyan-400 shrink-0">загрузка…</span>}
                        {sourceVideoPath && !uploadingVideo && <span className="text-[10px] text-green-400 shrink-0">✓</span>}
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      // (правка 343) blob-превью при удалении отзываем — иначе утечка
                      setSourceVideo((prev) => {
                        if (prev?.previewUrl.startsWith('blob:')) {
                          try { URL.revokeObjectURL(prev.previewUrl) } catch { /* уже отозван */ }
                        }
                        return null
                      })
                      patchVideo({ extendSourceVideoPath: '', extendSourceSubfolder: null }) // (правка 363)
                    }}
                    className="text-[10px] text-muted-foreground hover:text-red-400 shrink-0"
                  >
                    Убрать
                  </button>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">Добавить видео для продления — перетащите карточку из галереи или файл с диска</p>
              )}
            </div>
            <input
              ref={videoInputRef}
              type="file"
              accept="video/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void handleVideoSelect(f)
                e.target.value = ''
              }}
            />
            {/* (правка 363) Куда сохранится результат: источник из галереи —
                папка оригинала; файл с диска — как на вкладке «Генерация». */}
            {sourceVideoPath && (
              <p className="text-[10px] text-muted-foreground/60">
                Папка результата: {video.extendSourceSubfolder !== null
                  ? `${video.extendSourceSubfolder || 'общая'} (по оригиналу)`
                  : (video.outputFolder || 'общая')}
              </p>
            )}
          </div>

          <Separator className="bg-border opacity-50" />

          {/* (правка 227) Разрешение продления ВСЕГДА как в исходнике:
              и размер, и соотношение сторон (роут снимает их с файла).
              Поле «Разрешение» убрано — информация уже в подсказке
              исходного видео и не даёт пользователю выбора. */}

          {/* Клипы продления — в правой панели (лента с промптами) */}

          <Separator className="bg-border opacity-50" />

          {/* Image references */}
          <div className="space-y-2">
            <Label
              className="text-xs text-muted-foreground"
              title="До 9 картинок — помогают сохранить персонажей и сцену одинаковыми во всех клипах продления."
            >
              Картинки-рефы
              <span className="text-[10px] font-normal text-muted-foreground/60 ml-2">
                {extendRefs.length}/9 img
              </span>
            </Label>
            <div
              onDragOver={(e) => { e.preventDefault(); setRefsDragOver(true) }}
              onDragLeave={() => setRefsDragOver(false)}
              onDrop={(e) => {
                e.preventDefault()
                setRefsDragOver(false)
                const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'))
                if (files.length) void addExtendImageFiles(files)
              }}
              onClick={() => extendImageInputRef.current?.click()}
              className={cn(
                'border-2 border-dashed rounded-lg py-3 text-center cursor-pointer transition-all',
                refsDragOver ? 'border-cyan-400 bg-cyan-500/10' : 'border-border hover:border-cyan-500/50 hover:bg-[var(--surface-2)]',
              )}
            >
              {uploadingRefs ? (
                <p className="text-xs text-cyan-400">Загрузка…</p>
              ) : (
                <p className="text-xs text-muted-foreground">Добавить картинки-рефы</p>
              )}
            </div>
            <input
              ref={extendImageInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = Array.from(e.target.files || [])
                if (files.length) void addExtendImageFiles(files)
                e.target.value = ''
              }}
            />
            {extendRefs.length > 0 && (
              <div className="grid grid-cols-3 gap-2">
                {extendRefs.map((ref) => (
                  <div key={ref.id} className="relative group">
                    {/* (правка 288) Фолбэк на серверный файл, если previewUrl пуст
                        (localStorage не хранит blob: — после перезапуска превьюшки
                        исчезали).
                        (правка 719) Клик — полноэкранный просмотр (общий
                        компонент, как на вкладке «Генерация»). */}
                    <RefPreviewThumb
                      kind="image"
                      name={ref.name}
                      path={ref.path ?? ''}
                      url={ref.previewUrl || undefined}
                      className="w-full block"
                      title="Открыть референс во весь экран"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={ref.previewUrl || (ref.path ? `/api/comfy/file?filename=${encodeURIComponent(ref.path)}&type=input&width=200` : undefined)}
                        alt={ref.name}
                        className="w-full h-16 object-cover rounded-md border border-border cursor-zoom-in"
                        onError={(e) => {
                          if (!ref.previewUrl) {
                            (e.target as HTMLImageElement).src = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2224%22 height=%2224%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%2394a3b8%22 stroke-width=%222%22%3E%3Crect x=%223%22 y=%223%22 width=%2218%22 height=%2218%22 rx=%222%22/%3E%3Ccircle cx=%228.5%22 cy=%228.5%22 r=%221.5%22/%3E%3Cpath d=%22m21 15-5-5L5 21%22/%3E%3C/svg%3E'
                          }
                        }}
                      />
                    </RefPreviewThumb>
                    <button
                      type="button"
                      onClick={() => {
                        const refs = useGenStore.getState().video.extendImageRefs
                        // (правка 587) Отзываем blob-URL удаляемого референса —
                        // как при замене источника выше (утечка blob: строк).
                        const removed = refs.find((r) => r.id === ref.id)
                        if (removed?.previewUrl?.startsWith('blob:')) {
                          try { URL.revokeObjectURL(removed.previewUrl) } catch { /* уже отозван */ }
                        }
                        patchVideo({ extendImageRefs: refs.filter((r) => r.id !== ref.id) })
                      }}
                      className="absolute top-1 right-1 p-0.5 rounded bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <XIcon className="w-3 h-3 text-white" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* (правка 307) Рефы: режим размера — как в генерации */}
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

          <Separator className="bg-border opacity-50" />

          {/* (правка 423) Качество прохода — как на вкладке «Генерация»:
              «Драфт» = один проход на канве исходника (быстро, правка 247);
              «Полное» = два прохода (low-res → апскейл латента → рефайн). */}
          <div className="space-y-1.5">
            <Label
              className="text-xs text-muted-foreground"
              title={
                video.extendTwoPass
                  ? 'Сначала быстрый черновик каждого клипа, затем доработка до чёткого результата. Дольше, но детальнее.'
                  : 'Один проход сразу в разрешении исходника — быстрее. Довести до полного качества можно позже во вкладке Refine.'
              }
            >
              Качество прохода
            </Label>
            <div className="grid grid-cols-2 gap-1.5">
              {([
                [false, 'Драфт', 'Один быстрый проход — черновое качество; довести можно вкладкой Refine'],
                [true, 'Полное', 'Два прохода: быстрый черновик, затем детализация до качества исходника'],
              ] as const).map(([tp, label, hint]) => (
                <button
                  key={label}
                  type="button"
                  title={hint}
                  onClick={() => patchVideo({ extendTwoPass: tp })}
                  className={cn(
                    'h-8 rounded-md border text-xs font-medium transition-all',
                    (video.extendTwoPass === true) === tp
                      ? 'bg-emerald-500/15 border-emerald-500/50 text-emerald-300'
                      : 'bg-[var(--surface-2)] border-border text-muted-foreground hover:border-emerald-500/30',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <Separator className="bg-border opacity-50" />

          {/* Collapsible: Advanced parameters */}
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
                <SeedBlock />

                {/* Pass 1 */}
                <div className="space-y-1.5">
                  <button
                    type="button"
                    onClick={() => setShowPass1(!showPass1)}
                    className="w-full flex items-center justify-between px-3 py-1.5 rounded-md bg-[var(--surface-3)] border border-border/60 hover:border-cyan-500/30 transition-all text-left"
                  >
                    <span className="text-xs font-medium text-muted-foreground">
                      {video.extendTwoPass ? 'Pass 1 (low-res)' : 'Проход продления (один)'}
                    </span>
                    <span className={cn('text-[10px] text-muted-foreground transition-transform', showPass1 && 'rotate-180')}>▼</span>
                  </button>

                  {showPass1 && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      className="space-y-3 pl-1 overflow-hidden"
                    >
                      <div className="space-y-1">
                        {/* (правка 456) Стили под эталон «Генерация»: Label text-xs,
                            Select-триггеры h-9 bg-[var(--surface-2)] text-sm. */}
                        <Label
                          className="text-xs text-muted-foreground"
                          title="Сколько шагов делает модель, дорисовывая клип. Больше — точнее, но медленнее. По умолчанию — авто: шаги первого прохода исходника (из его метаданных); ручное значение побеждает авто."
                        >
                          Шаги сэмплера
                          {video.extendClipSteps == null && (
                            <span className="ml-1.5 text-[10px] text-cyan-400/80">авто</span>
                          )}
                        </Label>
                        <div className="flex items-center gap-2">
                          <input
                            type="number"
                            min={2}
                            max={30}
                            value={effectiveClipSteps}
                            onChange={(e) => patchVideo({ extendClipSteps: Math.max(2, Math.min(30, parseInt(e.target.value, 10) || 2)) })}
                            className="w-20 text-xs bg-[var(--surface-3)] border border-border rounded-md px-2 py-1.5 text-foreground"
                          />
                          {video.extendClipSteps != null ? (
                            <button
                              type="button"
                              onClick={() => patchVideo({ extendClipSteps: undefined })}
                              className="shrink-0 rounded-md border border-cyan-500/40 px-1.5 py-0.5 text-[10px] text-cyan-300 transition-colors hover:bg-cyan-500/10"
                              title={`Вернуть «авто»: шаги исходника${autoClipSteps != null ? ` (${autoClipSteps})` : ' → как в генерации'}`}
                            >
                              авто
                            </button>
                          ) : (
                            <span className="text-[10px] text-muted-foreground">
                              {autoClipSteps != null
                                ? `из исходника · ${autoClipSteps}`
                                : `как в генерации · ${video.firstSamplerSteps ?? 6}`}
                            </span>
                          )}
                          <span className="text-[10px] text-muted-foreground/70">2–30</span>
                        </div>
                      </div>

                      <div className="space-y-1">
                        <Label
                          className="text-xs text-muted-foreground"
                          title="Способ, которым модель рисует кадры. Влияет на детализацию и стабильность; если не уверены — оставьте euler."
                        >
                          Сэмплер (pass 1)
                        </Label>
                        <Select value={video.pass1Sampler || 'euler'} onValueChange={(v) => patchVideo({ pass1Sampler: v })}>
                          <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent className="bg-[var(--surface-3)] border-border">
                            {['euler', 'er_sde', 'dpmpp_2m', 'dpmpp_3m_sde', 'heun', 'lcm', 'res_multistep'].map((s) => (
                              <SelectItem key={s} value={s}>{s}</SelectItem>
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
                        <Select value={video.pass1Scheduler || 'simple'} onValueChange={(v) => patchVideo({ pass1Scheduler: v })}>
                          <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent className="bg-[var(--surface-3)] border-border">
                            {['simple', 'ddim_uniform', 'karras', 'exponential'].map((s) => (
                              <SelectItem key={s} value={s}>{s}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </motion.div>
                  )}
                </div>

                {/* (правка 473) Pass 2 — только в двухпроходном режиме
                    («Полное»). Шаблон extend уже использует sigmaVariant/
                    pass2Sampler (minimax-h3-template.ts) — раньше настройки
                    не были выведены в UI и pass2Sampler даже не отправлялся. */}
                {video.extendTwoPass && (
                  <div className="space-y-1.5">
                    <button
                      type="button"
                      onClick={() => setShowPass2(!showPass2)}
                      className="w-full flex items-center justify-between px-3 py-1.5 rounded-md bg-[var(--surface-3)] border border-border/60 hover:border-cyan-500/30 transition-all text-left"
                    >
                      <span className="text-xs font-medium text-muted-foreground">Pass 2 — детализация</span>
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
                          <Select value={video.sigmaVariant || '3step'} onValueChange={(v) => patchVideo({ sigmaVariant: v })}>
                            <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                              <SelectValue />
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
                            title="Способ, которым модель рисует кадры на финальном проходе. Если не уверены — оставьте euler."
                          >
                            Сэмплер (pass 2)
                          </Label>
                          <Select value={video.pass2Sampler || 'euler'} onValueChange={(v) => patchVideo({ pass2Sampler: v })}>
                            <SelectTrigger className="w-full h-9 bg-[var(--surface-2)] border-border text-sm rounded-md">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent className="bg-[var(--surface-3)] border-border">
                              {['euler', 'er_sde', 'dpmpp_2m', 'dpmpp_3m_sde', 'heun', 'lcm', 'res_multistep'].map((s) => (
                                <SelectItem key={s} value={s}>{s}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </motion.div>
                    )}
                  </div>
                )}

              </motion.div>
            )}
          </div>

          {/* (правка 308) Устаревший статичный блок «Рефы: режим размера» (правка 286) удалён:
              он дублировал интерактивный переключатель (правка 307) выше и вводил в заблуждение
              подписью «зафиксирован Match». Реально в генерацию уходит video.referenceDetail. */}
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
            // (правка 433) «Попробовать снова»: был no-op — баннер ошибки
            // не убирался. Теперь реальный reset (фаза idle + очистка error),
            // как на вкладках Генерация/Refine.
            onReset={reset}
            startedAt={videoStartedAt}
            promptId={promptId}
            // (правка 430) Двухпроходный extend: стадий clips×2 (pass 1+2 на
            // клип) — подпись «Клип N/M · проход K/2», а не «Клип N/2M».
            stageKind={video.extendTwoPass ? 'clips2' : 'clips'}
          />
        </div>
      </div>

      {/* ═══════════ RIGHT: Clips + Gallery (flex-1) ═══════════ */}
      {/* (правка 302) Правая панель: жёстко ограничена по ширине (flex-1 + overflow-hidden). */}
      <div style={{ minWidth: 0, overflow: 'hidden' }} className="flex-1 flex flex-col bg-[var(--surface-1)]">
        {/* Clips card: inline overflow-hidden гарантирует обрезку переполнения. */}
        <div style={{ overflow: 'hidden', maxWidth: '100%' }} className="p-5 pb-3 space-y-3 aurora-bg">
          <div style={{ minWidth: 0 }} className="space-y-2">
            <div className="flex items-center justify-between shrink-0">
              <Label
                className="text-sm font-medium text-foreground flex items-center gap-2"
                title="Каждый клип продолжает предыдущий — вместе они склеиваются с исходником в один ролик."
              >
                <SparklesIcon className="w-4 h-4 text-cyan-400" />
                Клипы продления
                <span className="text-[10px] font-normal text-muted-foreground/60">
                  {video.extendClips.length} клип(ов)
                </span>
              </Label>
              <span className="text-[10px] text-muted-foreground/70 hidden sm:block">
                <kbd className="px-1.5 py-0.5 rounded border border-border bg-[var(--surface-2)] font-mono text-[10px]">Ctrl</kbd>
                {' + '}
                <kbd className="px-1.5 py-0.5 rounded border border-border bg-[var(--surface-2)] font-mono text-[10px]">Enter</kbd>
                {' — запустить'}
              </span>
            </div>

            {/* (правка 304) Лента клипов: overflow-x-auto + w-max —
                стандартный паттерн: внутренняя строка шириной по контенту,
                внешний контейнер скроллит по горизонтали. */}
            <div ref={clipsStripRef} className="pb-2 overflow-x-auto min-w-0">
            <div className="pb-1 flex gap-3 w-max">
              {video.extendClips.map((clip, i) => (
                <div
                  key={clip.id ?? `clip-${i}`} /* (правка 587) стабильный ключ: key={i} после splice переносил состояние карточки на соседний клип */
                  className="flex flex-col p-3 rounded-lg border border-border bg-[var(--surface-2)] space-y-2 w-[280px] shrink-0"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-foreground">Клип {i + 1}</span>
                    <div className="flex items-center gap-2">
                      {/* (правка 427) «Исправить промпт клипа» с ассистентом
                          (правка 560 — переименовано из «Улучшить»):
                          цитирует текущий промпт клипа и его номер в extend-чате
                          (пустой промпт — ассистент придумает с нуля по
                          контексту исходника). */}
                      <button
                        type="button"
                        onClick={() => setFixClip(i)}
                        className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-amber-300 transition-colors"
                        title="Исправить промпт клипа с ассистентом (напишите, что изменить)"
                      >
                        <SparklesIcon className="w-3 h-3" />
                        Исправить
                      </button>
                      {/* (правка 691) «Очистить» промпт клипа — только если он непустой */}
                      {clip.prompt.trim() && (
                        <button
                          type="button"
                          onClick={() => {
                            const clips = [...video.extendClips]
                            clips[i] = { ...clips[i], prompt: '' }
                            patchVideo({ extendClips: clips })
                          }}
                          className="text-[10px] text-muted-foreground hover:text-red-400 transition-colors"
                          title="Очистить промпт клипа"
                        >
                          Очистить
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          const clips = [...video.extendClips]
                          clips.splice(i, 1)
                          patchVideo({ extendClips: clips })
                        }}
                        className="text-[10px] text-muted-foreground hover:text-red-400 transition-colors"
                      >
                        Удалить
                      </button>
                    </div>
                  </div>
                  {/* (правка 289) MentionTextarea вместо <textarea>: поддержка
                      тэгов <Picture N> с подсветкой и @-меню, как в generate-view.
                      (правка 443) Фиксированная высота карточки: h-full-режим
                      (без ручного resize-ручки), переполнение — внутренний
                      скролл; полный промпт — в редакторе (кнопка внизу
                      карточки, правка 454). */}
                  <div className="relative h-[150px] shrink-0">
                    {/* (правка 717) Кнопки поля — вертикальная колонка с ровными
                        интервалами (PromptFieldTools), как в generate/controlnet. */}
                    <PromptFieldTools>
                      {/* (правка 692) «Очистить» + «Исправить» — над микрофоном, как в generate/controlnet */}
                      <PromptClearButton
                        disabled={!clip.prompt.trim()}
                        onClear={() => {
                          const clips = [...video.extendClips]
                          clips[i] = { ...clips[i], prompt: '' }
                          patchVideo({ extendClips: clips })
                        }}
                      />
                      <PromptFixButton onFix={() => setFixClip(i)} />
                    </PromptFieldTools>
                    <MentionTextarea
                      value={clip.prompt}
                      onChange={(v) => {
                        const clips = [...video.extendClips]
                        clips[i] = { ...clips[i], prompt: v }
                        patchVideo({ extendClips: clips })
                      }}
                      onKeyDown={(e) => {
                        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                          e.preventDefault()
                          void handleGenerate()
                        }
                      }}
                      placeholder="Что происходит в этом клипе: действие, ракурс, движение камеры..."
                      mentions={clipMentions}
                      className="h-full min-h-0 pr-12"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <Label className="text-[10px] text-muted-foreground">Длит., с:</Label>
                    <input
                      type="number"
                      min={3}
                      max={30}
                      value={Math.round(clip.duration)}
                      onChange={(e) => {
                        const clips = [...video.extendClips]
                        // (правка 434) минимум 3 с (было 5, правка 309) — см. кламп при отправке.
                        clips[i] = { ...clips[i], duration: Math.max(3, Math.min(30, parseInt(e.target.value, 10) || 3)) }
                        patchVideo({ extendClips: clips })
                      }}
                      className="w-16 text-xs bg-[var(--surface-3)] border border-border rounded-md px-2 py-1 text-foreground"
                    />
                    {/* (правка 291) Показываем накопленную сумму клипов +
                        итог вместе с оригиналом — пользователь видит, сколько
                        секунд будет по итогу, а не только добавленных клипов. */}
                    <span className="text-[10px] text-muted-foreground">
                      {(() => {
                        const sumUpTo = video.extendClips.slice(0, i + 1).reduce((s, c) => s + c.duration, 0)
                        const srcD = typeof video.extendSourceDuration === 'number' && video.extendSourceDuration > 0
                          ? video.extendSourceDuration : 0
                        return srcD > 0
                          ? `${sumUpTo} с · итог ~${(srcD + sumUpTo).toFixed(0)} с`
                          : `${sumUpTo} с (итого клипов: ${video.extendClips.reduce((s, c) => s + c.duration, 0)} с)`
                      })()}
                    </span>
                    {/* (правка 454) Кнопка полноэкранного редактора промпта
                        перенесена из шапки в низ карточки (правый край ряда
                        длительности) — в шапке она теснила «Улучшить/Удалить». */}
                    <button
                      type="button"
                      onClick={() => setEditingClip(i)}
                      className="ml-auto inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-cyan-300 transition-colors"
                      title="Открыть промпт клипа в полноэкранном редакторе"
                    >
                      <Maximize2Icon className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              ))}

              {/* Добавить клип — карточка в конце ленты (новые клипы справа) */}
              <button
                type="button"
                onClick={() => {
                  const clips = [...video.extendClips]
                  // (правка 587) Стабильный id нового клипа — key карточки.
                  clips.push({ prompt: '', duration: 5, seed: -1, id: `clip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}` })
                  patchVideo({ extendClips: clips })
                }}
                className="w-[140px] shrink-0 rounded-lg border-2 border-dashed border-border hover:border-cyan-500/50 hover:bg-[var(--surface-2)] transition-all flex flex-col items-center justify-center gap-2 text-muted-foreground hover:text-cyan-400"
              >
                <PlusIcon className="w-5 h-5" />
                <span className="text-xs">Добавить клип</span>
              </button>
            </div>
            </div>

            {/* Badges */}
            <div className="flex flex-wrap items-center gap-1.5">{badges}</div>
          </div>

          {/* Generate button (правка 295) — размер как в generate-view */}
          <div className="pt-2 flex justify-end">
            <Button
              onClick={() => void handleGenerate()}
              disabled={!canGenerateNow}
              title={
                assistantBusy
                  ? '💬 Ассистент отвечает — дождитесь ответа или прервите его'
                  : 'Сгенерировать продление (Ctrl+Enter)'
              }
              className="h-11 px-6 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white border-0 text-sm font-semibold shadow-lg shadow-cyan-500/20"
            >
              {isGenerating ? 'Ещё в очередь' : (
                <>
                  <PlayIcon className="w-4 h-4 mr-2" />
                  Сгенерировать продление
                </>
              )}
            </Button>
          </div>
        </div>

        {/* (правка 302) Results gallery — flex-1 + overflow-y-auto.
            Галерея получает оставшееся место, скроллится вертикально. */}
        <div style={{ flex: '1 1 0%', minHeight: 0, overflowY: 'auto' }} className="px-5 pb-5">
          <VideoGalleryGrid
            files={galleryFiles}
            loading={galleryLoading}
            onRefresh={loadGallery}
            onDeleteFile={deleteFile}
            emptyHint="Здесь появятся сгенерированные видео продления. Опишите сцену, добавьте клипы и нажмите «Сгенерировать продление»."
          />
        </div>
      </div>

      {/* (правка 442) Ассистент — правая боковая панель (чаты режима
          «Продление»; resize за левую границу, сворачивается в рейл) */}
      <AssistantPanel mode="extend" />

      {/* (правка 443) Полноэкранный редактор промпта клипа (кнопка-«раскрыть»
          внизу карточки, правка 454). «Сохранить и запустить» ведёт в
          handleGenerate — стор уже обновлён onSave, читается свежим
          (getState). */}
      <PromptEditorDialog
        open={editingClip !== null}
        onOpenChange={(v) => { if (!v) setEditingClip(null) }}
        initialText={editingClip !== null ? (video.extendClips[editingClip]?.prompt ?? '') : ''}
        onSave={(text) => {
          if (editingClip === null) return
          const clips = [...useGenStore.getState().video.extendClips]
          if (!clips[editingClip]) return
          clips[editingClip] = { ...clips[editingClip], prompt: text }
          patchVideo({ extendClips: clips })
        }}
        onSaveAndRun={() => { void handleGenerate() }}
        placeholder="Что происходит в этом клипе: действие, ракурс, движение камеры..."
        mentions={clipMentions}
        improveOptions={editingClip !== null ? { mode: 'extend', clipNumber: editingClip + 1 } : undefined}
      />

      {/* (правка 691) Диалог «Исправить промпт» из карточки клипа: задание +
          промпт клипа уходят в extend-чат с номером клипа. */}
      <PromptFixDialog
        open={fixClip !== null}
        onOpenChange={(v) => { if (!v) setFixClip(null) }}
        hint={fixClip !== null ? `Промпт клипа ${fixClip + 1} и ваше задание уйдут в чат ассистента вкладки «Продление» — ответ можно будет вставить обратно кнопкой «В промпт». Ctrl+Enter — отправить, Esc — отмена.` : undefined}
        onSubmit={(req) => {
          const n = fixClip
          if (n === null) return
          requestImprovePrompt(video.extendClips[n]?.prompt ?? '', { mode: 'extend', clipNumber: n + 1, fixRequest: req })
        }}
      />

      {/* (правка 719) Просмотр рефов — у каждого превью (общий компонент
          RefPreviewThumb), отдельного диалога на вкладке больше нет. */}
    </div>
  )
}
