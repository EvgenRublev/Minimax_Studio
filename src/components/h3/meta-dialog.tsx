'use client'

/**
 * MetaDialog — modal that displays WanGP generation metadata.
 * Renders the generation params in a human-readable layout: prompt block,
 * key parameters grid, references summary; everything else collapses
 * under "Ещё" as raw JSON.
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { XIcon, InfoIcon, Loader2Icon, ImageIcon, FilmIcon, AudioLinesIcon, ArrowDownToLineIcon, RotateCcwIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useGenStore } from '@/lib/gen-store'
import { restoreFromMeta } from '@/lib/restore-from-meta'
import { RefViewerDialog, RefViewerData } from './ref-viewer-dialog'

interface MetaDialogProps {
  /** Relative path of the file (subfolder/filename). */
  filePath: string
  /** Display name (usually just the filename). */
  filename: string
  onClose: () => void
}

type MetaValue = string | number | boolean | null | undefined | Record<string, unknown> | unknown[]

const IMAGE_INTENT_LABELS: Record<string, string> = {
  identity: 'персонаж / объект',
  scene: 'сцена',
  style: 'стиль',
  composition: 'композиция',
}

const AUDIO_INTENT_LABELS: Record<string, string> = {
  voice: 'голос',
  drive: 'темп / ритм',
  style: 'стиль',
}

const DETAIL_LABELS: Record<string, string> = {
  match: 'Соответствовать выходу (match)',
  max: 'Максимальная детализация (max)',
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} ГБ`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} МБ`
  return `${(bytes / 1024).toFixed(0)} КБ`
}

function formatCreatedAt(raw: unknown): string | null {
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n) || n <= 0) return null
  return new Date(n * 1000).toLocaleString('ru-RU')
}

function basename(p: unknown): string {
  return typeof p === 'string' ? p.split(/[\\/]/).pop() || p : '—'
}

interface RefEntry {
  type?: string
  path?: string
  /** New schema: imageIntent value or free-text role. */
  role?: string
  /** Old WanGP schema. */
  image_intent?: string
  audio_intent?: string
  include_audio?: boolean
}

function RefRow({ ref, index, onView }: { ref: RefEntry; index: number; onView?: (r: RefEntry) => void }) {
  const type = (ref.type || '').toLowerCase()
  const Icon = type === 'image' ? ImageIcon : type === 'video' ? FilmIcon : AudioLinesIcon
  // (правка 476) Картинки и видео открываются во вьювере по клику на строку
  const viewable = !!ref.path && (type === 'image' || type === 'video')
  // New schema keeps the intent in `role`; old WanGP used image_intent/audio_intent
  const intent =
    type === 'image'
      ? (IMAGE_INTENT_LABELS[ref.image_intent || ref.role || 'identity'] ?? ref.role) || '—'
      : type === 'audio'
        ? AUDIO_INTENT_LABELS[ref.audio_intent || 'voice']
        : ref.include_audio === false
          ? 'без звука'
          : 'со звуком'

  // Live thumbnail: server extracts a poster/frame for image/video
  // references straight from ComfyUI's input/ dir.
  const canThumb =
    !!ref.path && (type === 'image' || type === 'video')
  const thumbUrl =
    canThumb && ref.path
      ? `/api/comfy/file?filename=${encodeURIComponent(ref.path)}&subfolder=&type=input&width=96`
      : null
  const [thumbFailed, setThumbFailed] = useState(false)
  const showThumb = thumbUrl && !thumbFailed

  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-md bg-[var(--surface-2)] border border-border px-2 py-1.5',
        viewable && 'cursor-pointer hover:border-cyan-500/40 transition-colors',
      )}
      onClick={viewable ? () => onView?.(ref) : undefined}
      title={viewable ? 'Открыть во вьювере' : undefined}
    >
      <span className="text-[10px] font-mono text-muted-foreground shrink-0 mt-0.5">#{index + 1}</span>
      {showThumb ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={thumbUrl}
          alt=""
          loading="lazy"
          onError={() => setThumbFailed(true)}
          className={cn(
            'w-10 h-10 rounded-md object-cover border shrink-0',
            type === 'image' ? 'border-purple-500/30' : 'border-cyan-500/30',
          )}
        />
      ) : (
        <Icon className={cn(
          'w-3.5 h-3.5 shrink-0 mt-0.5',
          type === 'image' ? 'text-purple-400' : type === 'video' ? 'text-cyan-400' : 'text-emerald-400',
        )} />
      )}
      <div className="min-w-0 flex-1">
        <p className="text-xs text-foreground/90 truncate" title={basename(ref.path)}>{basename(ref.path)}</p>
        <p className="text-[10px] text-muted-foreground">
          {intent}
          {ref.role ? ` · роль: ${ref.role}` : ''}
        </p>
      </div>
    </div>
  )
}

function ParamCell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">{label}</p>
      <div className="text-sm text-foreground/90 break-words">{children}</div>
    </div>
  )
}

export function MetaDialog({ filePath, filename, onClose }: MetaDialogProps) {
  const [data, setData] = useState<Record<string, MetaValue> | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // (правка 476) открытый во вьювере референс (картинка/видео)
  const [viewingRef, setViewingRef] = useState<RefViewerData | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    fetch(`/api/comfy/meta?path=${encodeURIComponent(filePath)}`)
      .then((res) => {
        if (!res.ok) {
          const ct = res.headers.get('content-type') || ''
          if (ct.includes('json')) return res.json().then((d) => { throw new Error(d.error || `HTTP ${res.status}`) })
          throw new Error(`HTTP ${res.status}`)
        }
        return res.json()
      })
      .then((json) => {
        if (!cancelled) setData(json)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [filePath])

  // Esc закрывает диалог (как и в VideoLightbox); когда открыт вьювер рефа — его закроет сам Dialog
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape' && !viewingRef) onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose, viewingRef])

  // The sidecar is a FLAT object written by use-video-gen
  // ({ created_at, generation_time, job_id, prompt, seed, ... }).
  // Very old files may nest params under `params` — fall back to that.
  const params = ((data?.params && typeof data.params === 'object' && !Array.isArray(data.params))
    ? data.params
    : data) as Record<string, unknown> | null

  const prompt = typeof params?.prompt === 'string' ? params.prompt : null
  // (правка 147) Режим генерации (правка 146): ref | t2v | flf.
  // Показываем явно в сетке и убираем из «Ещё», чтобы не затерялся в JSON.
  const MODE_LABELS: Record<string, string> = {
    t2v: 'Текст в видео',
    flf: 'Первый/последний кадр',
    ref: 'Референсы',
    extend: 'Продление видео', // (правка 161)
    refine: 'Рефайн видео', // (правка 264)
    controlnet: 'ControlNet (движение)',
    upscale: 'Апскейл / DLSS',
    facerefine: 'Face Refine (лица)',
    tileupscale: 'Тайловый апскейл',
    fps: 'FPS (интерполяция)',
  }
  const generationMode = typeof params?.generation_mode === 'string'
    ? params.generation_mode.trim().toLowerCase()
    : ''
  const modeLabel = MODE_LABELS[generationMode] ?? (generationMode ? generationMode : null)
  // (правка 147) FL2VA: первый/последний кадр — отдельные файлы в input/.
  const firstFrame = typeof params?.first_frame === 'string' && params.first_frame ? params.first_frame : null
  const lastFrame = typeof params?.last_frame === 'string' && params.last_frame ? params.last_frame : null
  // References: current schema `references`, legacy WanGP `minimax_h3_references`
  // (правка 470) flf-меты пишут первый кадр и в references (якорь для
  // рефайна) — в диалоге он уже показан блоком «Первый кадр», не дублируем.
  const references = (
    Array.isArray(params?.references)
      ? (params.references as RefEntry[])
      : Array.isArray(params?.minimax_h3_references)
        ? (params.minimax_h3_references as RefEntry[])
        : []
  ).filter((r) => r?.path !== firstFrame && r?.path !== lastFrame)
  const videoLength = typeof params?.video_length === 'number' ? params.video_length : null
  // fps не выдумываем: если его нет в метаданных — не считаем длительность
  // из числа кадров по дефолтным 24 (получалось неверное значение).
  const fps = typeof params?.fps === 'number' && params.fps > 0 ? params.fps : null
  const durationSeconds =
    typeof params?.duration_seconds === 'number' ? params.duration_seconds : null
  // Steps: two-pass workflow stores pass1_steps/pass2_steps; legacy stores num_inference_steps
  const pass1 = typeof params?.pass1_steps === 'number' ? params.pass1_steps : null
  const pass2 = typeof params?.pass2_steps === 'number' ? params.pass2_steps : null
  // (правка 440) Pass 2 реально идёт НЕ всегда: pipeline 'draft' — один
  // проход (шаги = draft_steps), extend с extend_two_pass=false —
  // однопроходный (правка 247). Сайдкар пишет pass1_steps/pass2_steps
  // безусловно — без этой проверки диалог показывал «4 + 3» и сэмплер
  // pass 2 даже там, где второго прохода не было.
  const isDraft = params?.pipeline === 'draft'
  const extendSinglePass = generationMode === 'extend' && params?.extend_two_pass === false
  const pass2Ran = pass2 != null && !isDraft && !extendSinglePass
  const draftSteps = typeof params?.draft_steps === 'number' ? params.draft_steps : null
  const stepsLabel = isDraft
    ? String(draftSteps ?? pass1 ?? '—')
    : pass1 != null || pass2 != null
      ? pass2Ran ? `${pass1 ?? '—'} + ${pass2 ?? '—'}` : `${pass1 ?? '—'}`
      : params?.num_inference_steps != null
        ? String(params.num_inference_steps)
        : // Однопроходные режимы (face-refine, тайловый апскейл) пишут шаги
          // полем steps — старые сайдкары до появления pass1_steps.
          params?.steps != null && typeof params.steps === 'number'
            ? String(params.steps)
            : null

  // "Ещё": everything except the fields already rendered above
  const restJson = (() => {
    if (!data) return null
    const shallow = { ...data }
    delete shallow.params
    // (правка 377) вычисляемое поле meta-роута (наличие .latent-файла) —
    // в «Ещё» не дублируем; сам путь остаётся в latent_file
    delete shallow.latent_available
    const p = params && params !== data ? { ...params } : null
    if (p) {
      delete p.prompt
      delete p.model_type
      delete p.seed
      delete p.resolution
      delete p.video_length
      delete p.num_inference_steps
      delete p.pass1_steps
      delete p.pass2_steps
      delete p.steps // показан строкой «Шаги» (fallback однопроходных режимов)
      delete p.guidance_scale
      delete p.activated_loras
      delete p.loras_multipliers
      delete p.lora
      delete p.references
      delete p.minimax_h3_references
      delete p.minimax_h3_turbo_mode
      delete p.minimax_h3_reference_detail
      delete p.minimax_h3_text_encoder
      delete p.pass2_sampler // (правка 69) — показан явно выше
      delete p.pass1_sampler // (правка 70)
      delete p.pass1_scheduler // (правка 70)
      delete p.turbo_lora_strength // (правка 70)
      delete p.generation_mode // (правка 147) — показан явно выше
      delete p.first_frame // (правка 147) — показан явно выше
      delete p.last_frame // (правка 147) — показан явно выше
      // (правка 94) Поля сайдкара апскейла — показаны отдельным блоком ниже
      delete p.tool
      delete p.duration_seconds
      delete p.fps
      delete p.file_size
      delete p.source_file
      delete p.upscale_feature
      delete p.upscale_options
    }
    const merged = p ? { ...shallow, ...p } : shallow
    return Object.keys(merged).length > 0 ? JSON.stringify(merged, null, 2) : null
  })()

  /* (правка 94) Сайдкар апскейла (DLSS / RTX Video): без промпта, но с
   * информацией о файле — показываем отдельным блоком вместо пустоты. */
  const isUpscaleMeta = typeof params?.tool === 'string'

  /* Порталим в body (как VideoLightbox): внутри грида предки с transform/
     filter (framer-анимации) ломают position:fixed и обрезают модалку. */
  const content = (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        className="w-full max-w-lg max-h-[80vh] rounded-xl border border-border bg-[var(--surface-3)] shadow-2xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <InfoIcon className="w-4 h-4 text-cyan-400 shrink-0" />
            <h3 className="text-sm font-medium truncate">{filename}</h3>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} className="h-7 w-7 p-0">
            <XIcon className="w-4 h-4" />
          </Button>
        </div>

        {/* Body */}
        {/* (правка 564) select-text: значения метаданных можно выделять и копировать. */}
        <div className="select-text flex-1 overflow-y-auto p-4 space-y-4">
          {loading && (
            <div className="flex items-center justify-center py-8">
              <Loader2Icon className="w-5 h-5 animate-spin text-muted-foreground" />
              <span className="ml-2 text-sm text-muted-foreground">Загрузка метаданных…</span>
            </div>
          )}

          {error && (
            <div className="text-center py-6">
              <p className="text-sm text-amber-400">{error}</p>
              <p className="text-xs text-muted-foreground mt-1">Файл метаданных не найден или недоступен</p>
            </div>
          )}

          {data && !loading && (
            <>
              {/* Job id line */}
              {typeof data.job_id === 'string' && (
                <p className="text-[10px] text-muted-foreground font-mono">job {data.job_id}</p>
              )}

              {/* (правка 94) Инфо о файле апскейла (DLSS 5 / RTX Video) */}
              {isUpscaleMeta && (
                <div className="space-y-1">
                  <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                    Результат апскейла
                  </p>
                  <div className="grid grid-cols-2 gap-2 rounded-md border border-border bg-[var(--surface-2)] p-3">
                    <ParamCell label="Инструмент">
                      <span className="text-sm">{String(params?.tool)}</span>
                    </ParamCell>
                    <ParamCell label="Разрешение">
                      {typeof params?.resolution === 'string' ? params.resolution : '—'}
                    </ParamCell>
                    <ParamCell label="Длительность">
                      {typeof params?.duration_seconds === 'number'
                        ? `${formatDuration(params.duration_seconds)} (${params.duration_seconds.toFixed(1)} с)`
                        : '—'}
                    </ParamCell>
                    <ParamCell label="FPS">
                      {typeof params?.fps === 'number' ? `${params.fps}` : '—'}
                    </ParamCell>
                    <ParamCell label="Размер файла">
                      {typeof params?.file_size === 'number' ? formatSize(params.file_size) : '—'}
                    </ParamCell>
                    <ParamCell label="Создано">
                      {formatCreatedAt(params?.created_at) ?? '—'}
                    </ParamCell>
                    {typeof params?.source_file === 'string' && params.source_file && (
                      <div className="col-span-2">
                        <ParamCell label="Исходник">
                          <span className="font-mono text-xs break-all">{params.source_file}</span>
                        </ParamCell>
                      </div>
                    )}
                    {typeof params?.upscale_feature === 'string' && (
                      <div className="col-span-2">
                        <ParamCell label="Настройка DLSS">
                          <span className="font-mono text-xs">{String(params.upscale_feature)}</span>
                        </ParamCell>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Prompt */}
              {prompt && (
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Промпт</p>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          // Quick: prompt + seed only
                          const store = useGenStore.getState()
                          store.setVideoPrompt(prompt)
                          if (typeof params?.seed === 'number' && params.seed >= 0) {
                            store.setVideoSeed(params.seed)
                          }
                          window.dispatchEvent(new CustomEvent('h3:goto-generate'))
                          toast.success('Промпт загружен в редактор', {
                            description: 'Только промпт и seed. Для полного восстановления используйте «Повторить».',
                          })
                          onClose()
                        }}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] border border-cyan-500/30 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20 transition-colors"
                        title="Загрузить промпт и seed в форму генерации"
                      >
                        <ArrowDownToLineIcon className="w-3 h-3" />
                        В редактор
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          const ok = await restoreFromMeta(filePath)
                          if (ok) onClose()
                        }}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 transition-colors"
                        title="Восстановить ВСЕ параметры генерации (промпт, seed, референсы, сэмплеры, разрешение…)"
                      >
                        <RotateCcwIcon className="w-3 h-3" />
                        Повторить
                      </button>
                    </div>
                  </div>
                  <div className="rounded-md bg-[var(--surface-2)] border border-border p-2.5 text-xs text-foreground/90 whitespace-pre-wrap break-words max-h-48 overflow-y-auto leading-relaxed">
                    {prompt}
                  </div>
                </div>
              )}

              {/* Key parameters grid */}
              <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                {/* (правка 147) Режим генерации — первое в сетке, чтобы сразу
                    было видно, какой путь модели был задействован. */}
                {modeLabel && (
                  <ParamCell label="Режим">
                    <span className="text-sm text-cyan-300">{modeLabel}</span>
                  </ParamCell>
                )}
                <ParamCell label="Seed">
                  <span className="font-mono">{typeof params?.seed === 'number' ? params.seed : '—'}</span>
                </ParamCell>
                <ParamCell label="Разрешение">{params?.resolution != null ? String(params.resolution) : '—'}</ParamCell>
                <ParamCell label="Длительность">
                  {durationSeconds != null
                    ? `${durationSeconds.toFixed(1)} c${videoLength != null ? ` · ${videoLength} кадр.` : ''}`
                    : videoLength != null && fps != null
                      ? `${(videoLength / fps).toFixed(1)} c · ${videoLength} кадр.`
                      : '—'}
                </ParamCell>
                <ParamCell label={pass2Ran ? 'Шаги (pass1 + pass2)' : 'Шаги'}>
                  {stepsLabel ?? '—'}
                </ParamCell>
                {/* (правка 69, 440) Сэмплер pass 2 — только если pass 2 был */}
                {params?.pass2_sampler != null && pass2Ran && (
                  <ParamCell label="Сэмплер (pass 2)">
                    <span className="font-mono">{String(params.pass2_sampler)}</span>
                  </ParamCell>
                )}
                {/* (правка 70) Pass 1: сэмплер, планировщик */}
                {params?.pass1_sampler != null && (
                  <ParamCell label="Сэмплер (pass 1)">
                    <span className="font-mono">{String(params.pass1_sampler)}</span>
                  </ParamCell>
                )}
                {params?.pass1_scheduler != null && (
                  <ParamCell label="Планировщик (pass 1)">
                    <span className="font-mono">{String(params.pass1_scheduler)}</span>
                  </ParamCell>
                )}
                {params?.guidance_scale != null && (
                  <ParamCell label="Guidance">{String(params.guidance_scale)}</ParamCell>
                )}
                <ParamCell label="Дата">
                  {formatCreatedAt(data.created_at) ?? '—'}
                </ParamCell>
                <ParamCell label="Время генерации">
                  {typeof data.generation_time === 'number' && data.generation_time > 0
                    ? formatDuration(data.generation_time)
                    : '—'}
                </ParamCell>
              </div>

              {/* (правка 147) FL2VA: первый/последний кадр — показываем рядом
                  с референсами (это то, что реально шло в генерацию). */}
              {(firstFrame || lastFrame) && (
                <div className="space-y-1.5">
                  <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Кадры (fl2va)</p>
                  {firstFrame && (
                    <div className="flex items-center gap-2 rounded-md bg-[var(--surface-2)] border border-border px-2 py-1.5">
                      <ImageIcon className="w-3.5 h-3.5 text-purple-400 shrink-0" />
                      <span className="text-xs text-foreground/90 truncate flex-1" title={firstFrame}>Первый кадр: {basename(firstFrame)}</span>
                    </div>
                  )}
                  {lastFrame && (
                    <div className="flex items-center gap-2 rounded-md bg-[var(--surface-2)] border border-border px-2 py-1.5">
                      <ImageIcon className="w-3.5 h-3.5 text-purple-400 shrink-0" />
                      <span className="text-xs text-foreground/90 truncate flex-1" title={lastFrame}>Последний кадр: {basename(lastFrame)}</span>
                    </div>
                  )}
                </div>
              )}

              {/* References */}
              {references.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                    Референсы ({references.length})
                  </p>
                  {references.map((r, i) => (
                    <RefRow
                      key={i}
                      ref={r}
                      index={i}
                      onView={(entry) =>
                        setViewingRef({
                          kind: (entry.type || '').toLowerCase() === 'video' ? 'video' : 'image',
                          name: basename(entry.path || ''),
                          path: entry.path || '',
                        })
                      }
                    />
                  ))}
                  {params?.minimax_h3_reference_detail != null && (
                    <p className="text-[10px] text-muted-foreground">
                      Детализация:{' '}
                      {DETAIL_LABELS[String(params.minimax_h3_reference_detail)] ??
                        String(params.minimax_h3_reference_detail)}
                    </p>
                  )}
                </div>
              )}

              {/* Everything else */}
              {restJson && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground hover:text-foreground select-none">
                    Ещё (остальные поля)
                  </summary>
                  <pre className="mt-1.5 p-2 rounded bg-[var(--surface-2)] border border-border overflow-auto max-h-48">
                    {restJson}
                  </pre>
                </details>
              )}
            </>
          )}
        </div>
      </motion.div>
      {/* (правка 476) вьювер прикреплённых референсов (порталится в body поверх этого диалога) */}
      <RefViewerDialog data={viewingRef} onOpenChange={(v) => { if (!v) setViewingRef(null) }} />
    </motion.div>
  )

  return createPortal(content, document.body)
}
