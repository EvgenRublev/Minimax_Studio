'use client'

/**
 * Generation status card — phase readout, animated progress bar, elapsed
 * timer, live ComfyUI preview and error state. Pinned to the bottom of
 * the parameters panel so it stays visible while adjusting settings.
 * (правка 984) Здесь же — единая кнопка «Сгенерировать» / «Остановить».
 */
import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { PlayIcon, PlusIcon, SquareIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useGenProgress } from '@/lib/gen-progress-store' // (правка 696)
// (правка 719) Превью с полноэкранным просмотром — как на «Генерации».
import { RefPreviewThumb } from '@/components/h3/ref-preview-thumb'
import { OutputFolderPicker } from '@/components/h3/output-folder-picker'
import { useTranslation } from 'react-i18next' // (правка 955)

interface GenerationStatusProps {
  phase: string
  isGenerating: boolean
  progressPercent: number
  statusMessage: string | null
  error: string | null
  onInterrupt: () => void
  onReset: () => void
  /** (правка 984) Единая кнопка запуска под превью. Пока генерация идёт,
   *  она заменяется на «Остановить» (onInterrupt). */
  onGenerate?: () => void
  generateLabel?: string
  generateDisabled?: boolean
  generateTitle?: string
  /** (правка 997) Папка сохранения результата — над кнопкой запуска. */
  outputFolder?: string
  onOutputFolderChange?: (folder: string) => void
  /** Timestamp (Date.now()) when generation started — drives the elapsed timer. */
  startedAt?: number | null
  /** Current prompt_id for the live preview. */
  promptId?: string | null
  /**
   * (правка 255) Как называть стадии в подписи превью/статуса:
   * 'passes' — «Pass 1/2 · черновик/детализация» (генерация, default);
   * 'clips'  — «Клип 1/3» (продление: стадия = клип цепочки);
   * 'clips2' — «Клип 1/2 · проход 1/2» (правка 430: двухпроходный extend —
   *   стадий в трекере clips×2 (pass 1 + pass 2 на клип), показываем пару);
   * 'chunks' — «Кусок 1/4» (рефайн частями);
   * 'single' — без нумерации проходов (рефайн целиком, драфт);
   * 'tile' — «Tile Upscale» (правка 478: у вкладки Tile Upscale метка была
   *   'Refine', потому что она делила вид 'single' с рефайном целиком).
   */
  stageKind?: 'passes' | 'clips' | 'clips2' | 'chunks' | 'single' | 'tile' | 'controlnet' | 'face' | 'fps'
  /**
   * (правка 950) Текущий узел ComfyUI и время на нём — из /api/comfy/progress.
   * Показываем рядом с процентами, чтобы «0%»/«50%» не выглядели зависанием.
   */
  executingNode?: string | null
  executingTitle?: string | null
  nodeStep?: number | null
  nodeTotal?: number | null
  nodeElapsedMs?: number | null
  /**
   * (правка 950) «Кадры» (FLF): Pass 1 идёт в полном разрешении, поэтому
   * подпись «Pass 1 · черновик» врёт — пишем «полное разрешение».
   */
  passFullRes?: boolean
}

/** Подпись текущей стадии с учётом вида вкладки (правка 255, 478). */
function stageLabel(
  kind: 'passes' | 'clips' | 'clips2' | 'chunks' | 'single' | 'tile' | 'controlnet' | 'face' | 'fps',
  stage: number,
  totalStages: number,
  fullResPass1 = false,
): string {
  // (правка 965) свои подписи у Face Refine и FPS: раньше обе делили
  // 'single' с Refine и подписывались «Refine» на чужой вкладке.
  if (kind === 'face') return 'Face Refine'
  if (kind === 'fps') return 'FPS'
  // (правка 478+479) метка вкладки Tile Upscale: «Тайл X/Y»
  if (kind === 'tile') return totalStages > 0 ? `Тайл ${stage}/${totalStages}` : 'Tile Upscale'
  // (правка 497) вкладка ControlNet — один проход, без нумерации
  if (kind === 'controlnet') return 'ControlNet'
  if (kind === 'clips') return `Клип ${stage}/${totalStages}`
  // (правка 430) Стадии двухпроходного extend идут парами [p1_i, p2_i]:
  // нечётная = pass 1 (черновик), чётная = pass 2 (детализация) того же клипа.
  if (kind === 'clips2') {
    const clip = Math.ceil(stage / 2)
    const totalClips = Math.ceil(totalStages / 2)
    const pass = ((stage - 1) % 2) + 1
    return `Клип ${clip}/${totalClips} · проход ${pass}/2${pass === 1 ? ' · черновик' : ' · детализация'}`
  }
  if (kind === 'chunks') return `Кусок ${stage}/${totalStages}`
  if (kind === 'single') return 'Refine'
  // passes: единственный проход (драфт) не нумеруем как «1/1»
  if (totalStages <= 1) return 'Проход'
  // (правка 950) FLF генерирует Pass 1 сразу в полном разрешении — не
  // называем его черновиком.
  const firstPass = fullResPass1 ? ' · полное разрешение' : ' · черновик'
  return `Pass ${stage}/${totalStages}${stage === 1 ? firstPass : ' · детализация'}`
}

/**
 * (правка 1145) Подпись текущего окна контекста «Частями». Раньше верхняя
 * панель показывала только «шаг 1/3», и многоминутные окна выглядели как
 * зависание; теперь видно, какое окно и какие кадры считаются.
 */
function contextWindowLabel(
  cw?: { index: number; total: number; start: number; end: number; frames: number } | null,
): string {
  if (!cw || !cw.index) return ''
  const total = cw.total > 0 ? `/${cw.total}` : ''
  const frames = cw.frames > 0 ? ` из ${cw.frames}` : ''
  return ` · Окно ${cw.index}${total}: кадры ${cw.start}–${cw.end}${frames}`
}

/** Live preview of the current denoising step (from ComfyUI WebSocket). */
export function GenPreview({
  promptId,
  active,
  stageKind,
  isGenerating,
  passFullRes = false,
}: {
  promptId: string | null
  active: boolean
  stageKind: 'passes' | 'clips' | 'clips2' | 'chunks' | 'single' | 'tile' | 'controlnet' | 'face' | 'fps'
  /** (правка 696) true во время активной генерации — используем frozen kind. */
  isGenerating: boolean
  /** (правка 950) FLF: Pass 1 в полном разрешении. */
  passFullRes?: boolean
}) {
  const { t: tt } = useTranslation() // (правка 955)

  // (правка 696) Frozen stageKind из стора — до всех early-returns (hook order).
  const frozenKind = useGenProgress((s) => s.video.frozenStageKind)
  const [previewData, setPreviewData] = useState<{
    url: string
    mime: string
    step: number
    total: number
    width: number
    height: number
    stage?: {
      stage: number
      totalStages: number
      step: number
      total: number
      /** (правка 487) tile-upscale: модель ещё готовится, сэмплинг не начался. */
      preparing?: boolean
      /** (правка 1134) Сэмплинг закончен — идёт декод/сохранение (минуты на 2K). */
      finalizing?: boolean
      /** (правка 1145) Окно контекста «Частями». */
      contextWindow?: { index: number; total: number; start: number; end: number; frames: number } | null
    } | null
  } | null>(null)

  useEffect(() => {
    if (!active || !promptId) return
    let cancelled = false
    const poll = async () => {
      try {
        // Cache-busting: append timestamp to prevent browser caching
        const res = await fetch(`/api/comfy/preview?prompt_id=${encodeURIComponent(promptId)}&_t=${Date.now()}`)
        if (!res.ok) return
        const data = await res.json()
        if (cancelled) return
        // Stage must update even WITHOUT a new preview image: during pass 2
        // the KJ preview override (pass 1 only) emits nothing, so the last
        // pass-1 frame stays on screen while the label must move to 2/2.
        if (data.stage) {
          const s = data.stage as { stage: number; totalStages: number; step: number; total: number; preparing?: boolean; finalizing?: boolean; contextWindow?: { index: number; total: number; start: number; end: number; frames: number } | null }
          setPreviewData((prev) =>
            prev ? { ...prev, stage: s } : {
              url: '', mime: 'image/jpeg', step: 0, total: 0, width: 0, height: 0, stage: s,
            },
          )
        }
        if (data.preview?.image) {
          setPreviewData((prev) => {
            const base = prev ?? { url: '', mime: 'image/jpeg', step: 0, total: 0, width: 0, height: 0, stage: null }
            return {
              ...base,
              url: data.preview.image,
              mime: data.preview.mime || 'image/jpeg',
              step: data.preview.step || 0,
              total: data.preview.total || 0,
              width: data.preview.width || 0,
              height: data.preview.height || 0,
            }
          })
        }
      } catch { /* ignore */ }
    }
    poll()
    const timer = setInterval(poll, 1500)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [promptId, active])

  if (!previewData || !previewData.url) {
    // No preview frame yet (or pass 2, where none is emitted) — still show
    // which pass is running so the label is never stale/empty.
    const stageOnly = previewData?.stage
    return (
      <div className="rounded-lg border border-dashed border-border bg-[var(--surface-1)]/50 h-28 flex flex-col items-center justify-center gap-1">
        <span className="text-[10px] text-muted-foreground/50 creative-pulse">{tt("Ожидание preview…")}</span>
        {stageOnly && (
          <span className="text-[10px] text-cyan-300 font-medium">
            {/* (правка 487) фаза подготовки модели — без ложных «Тайл 1/N»;
                правка 696 — frozen kind во время генерации */}
            {stageOnly.finalizing
              ? tt("Декодирование и сохранение…")
              : stageOnly.preparing
              ? tt("Подготовка модели…")
              : <>{stageLabel(isGenerating ? (frozenKind ?? stageKind) : stageKind, stageOnly.stage, stageOnly.totalStages, passFullRes)}{contextWindowLabel(stageOnly.contextWindow)}{stageOnly.total > 0 ? tt("· шаг {{p1}}/{{p2}}", { p1: stageOnly.step, p2: stageOnly.total }) : ''}</>}
          </span>
        )}
      </div>
    )
  }

  const isVideo = previewData.mime === 'video/mp4'
  const isAnimatedWebp = previewData.mime === 'image/webp'

  // (правка 696) Во время активной генерации используем зафиксированный на
  // момент старта stageKind — переключение «Драфт/Полное» не меняет шаблон
  // подписи. Вне генерации — текущий stageKind (актуальные настройки).
  const activeKind = isGenerating ? (frozenKind ?? stageKind) : stageKind

  // Stage label across the WHOLE generation (not just the pass the preview
  // image comes from): "Pass 1/2" during low-res, "Pass 2/2" during the
  // high-res refinement. Step/total prefer the stage tracker (works even on
  // pass 2, where no KJ preview image is emitted) and fall back to the
  // preview image's own counters.
  const stage = previewData.stage
  const passLabel = stage
    // (правка 487) фаза подготовки модели — без ложных «Тайл 1/N»
    // (правка 1134) после сэмплинга — декод/сохранение, а не «100%, шаг N/N»
    ? (stage.finalizing
        ? tt("Декодирование и сохранение…")
        : stage.preparing ? 'Подготовка модели…' : stageLabel(activeKind, stage.stage, stage.totalStages, passFullRes))
    : 'Превью'
  const step = stage && stage.total > 0 ? stage.step : previewData.step
  const total = stage && stage.total > 0 ? stage.total : previewData.total
  const stepLabel = !stage?.preparing && !stage?.finalizing && total > 0 ? ` · шаг ${step}/${total}` : ''
  // (правка 1145) Окно контекста важнее шага: показываем его первым.
  const windowLabel = !stage?.preparing && !stage?.finalizing ? contextWindowLabel(stage?.contextWindow) : ''

  return (
    // (правка 447) Рамка превью — нейтральная border-border, без голубого cyan-обвода.
    <div className="relative rounded-lg overflow-hidden border border-border bg-black/40">
      {/* (правка 719) Клик по превью — полноэкранный просмотр (как на вкладке
          «Генерация»). */}
      <RefPreviewThumb
        kind={isVideo ? 'video' : 'image'}
        name="Превью генерации"
        url={previewData.url}
        videoIcon={false}
        className="block w-full"
        title={tt("Открыть превью во весь экран")}
      >
        {isVideo ? (
          <video
            src={previewData.url}
            autoPlay
            loop
            muted
            className="w-full h-auto max-h-48 object-contain"
          />
        ) : (
          <img
            src={previewData.url}
            alt="Preview"
            className="w-full h-auto max-h-48 object-contain cursor-zoom-in"
            draggable={false}
          />
        )}
      </RefPreviewThumb>
      {isAnimatedWebp && (
        <span className="absolute bottom-1 right-1 px-1 py-0.5 bg-black/50 rounded text-[10px] text-cyan-300">anim</span>
      )}
      <div className="absolute top-1 left-1 px-1.5 py-0.5 bg-black/60 rounded text-[10px] text-cyan-300 font-medium flex items-center gap-1.5">
        <span>{passLabel}{windowLabel}{stepLabel}</span>
        {previewData.width > 0 && previewData.height > 0 && (
          <span className="text-white/40 font-normal">{previewData.width}×{previewData.height}</span>
        )}
      </div>
    </div>
  )
}

export function GenerationStatus({
  isGenerating,
  error,
  onInterrupt,
  onReset,
  onGenerate,
  generateLabel,
  generateDisabled,
  generateTitle,
  outputFolder = '',
  onOutputFolderChange,
}: GenerationStatusProps) {
  const { t: tt } = useTranslation() // (правка 955)

  return (
    <div className="space-y-2">
      {/* (правка 989) Превью генерации переехало в карточку галереи. */}

      {/* (правка 997) Папка сохранения — прямо над кнопкой запуска. */}
      {onOutputFolderChange && (
        <OutputFolderPicker value={outputFolder} onChange={onOutputFolderChange} />
      )}

      {/* (правка 984) Одна кнопка на всё: под статусом.
          Идёт генерация → «Остановить», иначе → запуск. */}
      {(isGenerating || onGenerate) && (
        <div className="pt-0.5">
          {isGenerating ? (
            <div className="flex items-center gap-1.5">
              <Button
                onClick={onInterrupt}
                className="flex-1 h-9 gap-1.5 bg-red-500/15 hover:bg-red-500/25 text-red-300 border border-red-500/30 text-xs font-semibold"
              >
                <SquareIcon className="w-3.5 h-3.5 fill-current" />
                {tt("Остановить")}
              </Button>
              {onGenerate && (
                <Button
                  onClick={onGenerate}
                  disabled={generateDisabled}
                  title={generateTitle
                    ? `${tt("Добавить ещё в очередь")} · ${generateTitle}`
                    : tt("Добавить ещё в очередь")}
                  aria-label={tt("Добавить ещё в очередь")}
                  className="h-9 w-11 shrink-0 px-0 gap-0.5 bg-[var(--surface-2)] hover:bg-[var(--surface-3)] text-cyan-300 border border-cyan-500/30 text-xs font-bold disabled:opacity-40"
                >
                  <PlusIcon className="w-3.5 h-3.5" />
                  1
                </Button>
              )}
            </div>
          ) : onGenerate ? (
            <Button
              onClick={onGenerate}
              disabled={generateDisabled}
              title={generateTitle}
              className="w-full h-9 gap-1.5 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white border-0 text-xs font-semibold shadow-lg shadow-cyan-500/20 disabled:opacity-50"
            >
              <PlayIcon className="w-3.5 h-3.5" />
              {generateLabel ?? tt("Сгенерировать")}
            </Button>
          ) : null}
        </div>
      )}

      {/* Error */}
      {error && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex items-start gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-lg"
        >
          <span className="text-sm text-red-400 font-medium shrink-0">{tt("Ошибка")}</span>
          <div className="space-y-1 min-w-0">
            <p className="text-xs text-red-300/70 break-words">{error}</p>
            <Button
              variant="ghost"
              size="sm"
              onClick={onReset}
              className="h-auto p-1 text-xs text-red-400 hover:text-red-300 hover:bg-red-500/20"
            >
              {tt("Попробовать снова")}
            </Button>
          </div>
        </motion.div>
      )}
    </div>
  )
}
