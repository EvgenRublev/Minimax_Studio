'use client'

/**
 * (правка 929) ImageView — вкладка «Изображение»: генерация MiniMax H3 по
 * тексту и правка по референсам (режим p-h3-image).
 *
 * Layout как у «FPS»/«Tile Upscale»: слева параметры + статус, справа —
 * полученные картинки. Референсы: drag&drop файлов или выбор; image_1 — то,
 * что правим, остальные — картинки-источники (до 8 всего).
 *
 * LoRA p-h3-image (2 ГБ) кладётся поверх уже скачанной видео-модели, поэтому
 * отдельный 21-гигабайтный image-DiT не обязателен — переключается в
 * «Дополнительно».
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ImageIcon,
  PlayIcon,
  PlusIcon,
  Trash2Icon,
  ChevronDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  RefreshCwIcon,
  AlertTriangleIcon,
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
import { GenerationStatus } from '@/components/h3/generation-status'
import { ImageResultsGrid } from '@/components/h3/image-results-grid'
import { uploadInputFile } from '@/lib/upload'
import { useImageStore, type ImageReference, type ImageQuality, type ImageSchedule } from '@/lib/image-store'
import { useImageJob } from '@/lib/image-job-store'
import {
  IMAGE_ASPECTS,
  IMAGE_SIZES,
  IMAGE_MAX_REFERENCES,
  IMAGE_MEGAPIXELS,
  IMAGE_MP_HINT,
  IMAGE_SIGMA_SCHEDULES,
  IMAGE_SCHEDULE_LABELS,
  imageQualityLabel,
} from '@/lib/comfy/image-template'

interface ImageAssets {
  ok: boolean
  ready?: boolean
  missing?: string[]
  loras?: string[]
  textEncoders?: string[]
  vaes?: string[]
  imageModels?: string[]
  diffusionModels?: string[]
  defaults?: { imageLora: string; textEncoder: string; vae: string }
  error?: string
}

const IMAGE_EXT_OK = /\.(png|jpe?g|webp|bmp)$/i

export function ImageView() {
  const params = useImageStore((s) => s.params)
  const setParams = useImageStore((s) => s.setParams)
  const references = useImageStore((s) => s.references)
  const addReferences = useImageStore((s) => s.addReferences)
  const removeReference = useImageStore((s) => s.removeReference)
  const clearReferences = useImageStore((s) => s.clearReferences)
  const results = useImageStore((s) => s.results)
  const clearResults = useImageStore((s) => s.clearResults)
  const advancedOpen = useImageStore((s) => s.advancedOpen)
  const setAdvancedOpen = useImageStore((s) => s.setAdvancedOpen)

  const busy = useImageJob((s) => s.busy)
  const phase = useImageJob((s) => s.phase)
  const progress = useImageJob((s) => s.progress)
  const error = useImageJob((s) => s.error)
  const promptId = useImageJob((s) => s.promptId)
  const startedAt = useImageJob((s) => s.startedAt)
  const submitJob = useImageJob((s) => s.submit)
  const cancelJob = useImageJob((s) => s.cancel)
  const resetJob = useImageJob((s) => s.reset)

  const [assets, setAssets] = useState<ImageAssets | null>(null)
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const prevBlobUrls = useRef<Set<string>>(new Set())

  const loadAssets = useCallback(async () => {
    try {
      const res = await fetch('/api/comfy/image-assets')
      const data = await res.json()
      setAssets(data)
      // (правка 929) Автовыбор LoRA: без image-DiT на диске картинка получается
      // только видео-моделью + LoRA p-h3-image, поэтому пустой выбор («без LoRA»)
      // был бы заведомо нерабочим — ставим LoRA сами. Пользовательский выбор
      // (в т.ч. «Без LoRA») не перетираем: трогает только пустое значение.
      if (data?.ok && !useImageStore.getState().params.lora) {
        const def = data.defaults?.imageLora
        if (def && (data.loras ?? []).includes(def) && (data.imageModels ?? []).length === 0) {
          setParams({ lora: def })
        }
      }
      return data
    } catch {
      setAssets({ ok: false, error: 'Не удалось прочитать папку models' })
    }
  }, [setParams])

  useEffect(() => {
    void loadAssets()
  }, [loadAssets])

  const size = useMemo(() => {
    const q = IMAGE_SIZES[params.quality] ?? IMAGE_SIZES['4']
    return q[params.aspect] ?? q['1:1']
  }, [params.quality, params.aspect])

  const steps = useMemo(
    () => (IMAGE_SIGMA_SCHEDULES[params.schedule] ?? IMAGE_SIGMA_SCHEDULES.image8).split(',').length - 1,
    [params.schedule],
  )

  /* ─── Референсы: drag&drop / выбор файлов ─── */

  const addFiles = useCallback(
    async (files: File[]) => {
      const images = files.filter((f) => IMAGE_EXT_OK.test(f.name))
      if (images.length === 0) return
      const room = IMAGE_MAX_REFERENCES - references.length
      if (room <= 0) {
        toast.error(`Референсов не больше ${IMAGE_MAX_REFERENCES}`)
        return
      }
      setUploading(true)
      try {
        const added: ImageReference[] = []
        for (const file of images.slice(0, room)) {
          const { path, staged } = await uploadInputFile(file)
          const url = URL.createObjectURL(file)
          prevBlobUrls.current.add(url)
          added.push({ name: path, url, staged })
        }
        if (added.length) addReferences(added)
        if (images.length > room) toast.warning(`Добавлено ${added.length}: максимум ${IMAGE_MAX_REFERENCES} референсов`)
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Не удалось загрузить картинку')
      } finally {
        setUploading(false)
      }
    },
    [references.length, addReferences],
  )

  const removeRef = useCallback(
    (ref: ImageReference) => {
      if (ref.url.startsWith('blob:')) {
        try { URL.revokeObjectURL(ref.url) } catch { /* уже отозван */ }
        prevBlobUrls.current.delete(ref.url)
      }
      removeReference(ref.name)
    },
    [removeReference],
  )

  /** Сдвиг референса в списке: image_1 — то, что правим. */
  const moveRef = useCallback(
    (index: number, delta: number) => {
      const next = [...references]
      const to = index + delta
      if (to < 0 || to >= next.length) return
      const [item] = next.splice(index, 1)
      next.splice(to, 0, item)
      useImageStore.setState({ references: next })
    },
    [references],
  )

  useEffect(() => {
    const urls = prevBlobUrls.current
    return () => {
      for (const u of urls) {
        try { URL.revokeObjectURL(u) } catch { /* уже отозван */ }
      }
    }
  }, [])

  /* ─── Запуск ─── */

  const canRun = params.prompt.trim().length > 0 && !busy

  const start = useCallback(() => {
    if (!canRun) {
      if (!params.prompt.trim()) toast.error('Введите промпт')
      return
    }
    const seed = params.seed > 0 ? params.seed : Math.floor(Math.random() * 2 ** 31)
    void submitJob({
      prompt: params.prompt.trim(),
      width: size[0],
      height: size[1],
      schedule: params.schedule,
      seed,
      diffusionModel: params.model || undefined,
      imageLora: params.lora || null,
      loraStrength: params.loraStrength,
      textEncoder: params.textEncoder || undefined,
      vae: params.vae || undefined,
      references: references.map((r) => ({ name: r.name })),
      lowVramAttention: params.lowVramAttention,
      chunkFeedForward: params.chunkFeedForward,
    })
  }, [canRun, params, size, references, submitJob])

  const missing = assets?.missing ?? []

  return (
    <div className="flex h-full w-full min-w-0">
      {/* ═══ Параметры ═══ */}
      <aside className="w-[360px] shrink-0 border-r border-border bg-[var(--surface-1)] flex flex-col">
        <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-4">
          <div className="flex items-center gap-2">
            <ImageIcon className="w-4 h-4 text-[#A855F7]" />
            <h2 className="text-sm font-semibold">Изображение</h2>
            <span className="text-[11px] text-muted-foreground ml-auto">p-h3-image</span>
          </div>

          {missing.length > 0 && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-200 flex gap-2">
              <AlertTriangleIcon className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                <div className="font-medium mb-1">Не хватает файлов для режима «Изображение»:</div>
                <ul className="list-disc list-inside space-y-0.5">
                  {missing.map((m) => (
                    <li key={m} className="font-mono break-all">{m}</li>
                  ))}
                </ul>
                <div className="mt-1 text-amber-200/80">
                  Скачайте их в «Настройки → Модели» (группы LoRA / Text Encoder / VAE) или положите
                  вручную в ComfyUI/models/.
                </div>
              </div>
            </div>
          )}

          {/* ─── Промпт ─── */}
          <div className="space-y-1.5">
            <Label className="text-xs">Промпт</Label>
            <Textarea
              value={params.prompt}
              onChange={(e) => setParams({ prompt: e.target.value })}
              placeholder={
                references.length > 0
                  ? 'Короткая инструкция: «замени фон на заснеженный лес», «убери второй объект»…'
                  : 'Описание сцены. Модель чувствительна к формулировкам: лучше одна конкретная фраза, чем список гипербол.'
              }
              rows={5}
              className="text-sm resize-y"
            />
            <div className="text-[11px] text-muted-foreground">
              {references.length > 0
                ? `Правка: image_1 — исходник, остальные — источники. Нумерация в подсказке: <Picture 1>, <Picture 2>…`
                : 'Генерация по тексту. 8 МП даёт более чистые детали, 4 МП — быстрее.'}
            </div>
          </div>

          {/* ─── Размер ─── */}
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label className="text-xs">Соотношение</Label>
              <Select value={params.aspect} onValueChange={(v) => setParams({ aspect: v })}>
                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {IMAGE_ASPECTS.map((a) => (
                    <SelectItem key={a} value={a}>{a}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Качество (МП)</Label>
              <Select
                value={params.quality}
                onValueChange={(v) => setParams({ quality: v as ImageQuality })}
              >
                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {IMAGE_MEGAPIXELS.map((mp) => (
                    <SelectItem key={mp} value={mp}>{imageQualityLabel(mp, params.aspect)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="text-[11px] text-muted-foreground -mt-2">
            {size[0]}×{size[1]} пикселей ({(size[0] * size[1] / 1e6).toFixed(2)} МП)
            {IMAGE_MP_HINT[params.quality] ? ` · ${IMAGE_MP_HINT[params.quality]}` : ''}
          </div>

          {/* ─── Сетка шагов + seed ─── */}
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label className="text-xs">Сетка шагов</Label>
              <Select
                value={params.schedule}
                onValueChange={(v) => setParams({ schedule: v as ImageSchedule })}
              >
                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(IMAGE_SCHEDULE_LABELS).map(([k, label]) => (
                    <SelectItem key={k} value={k}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Seed (0 = случайный)</Label>
              <input
                type="number"
                min={0}
                value={params.seed}
                onChange={(e) => setParams({ seed: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
                className="w-full h-8 rounded-md border border-border bg-[var(--surface-2)] px-2 text-xs"
              />
            </div>
          </div>
          <div className="text-[11px] text-muted-foreground -mt-2">
            {steps} {steps === 1 ? 'шаг' : 'шагов'} · euler · без CFG
          </div>

          {/* ─── Референсы ─── */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs">
                Референсы ({references.length}/{IMAGE_MAX_REFERENCES})
              </Label>
              {references.length > 0 && (
                <button
                  type="button"
                  onClick={clearReferences}
                  className="text-[11px] text-muted-foreground hover:text-foreground underline underline-offset-2"
                >
                  Очистить
                </button>
              )}
            </div>

            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault()
                setDragOver(false)
                void addFiles(Array.from(e.dataTransfer.files))
              }}
              onClick={() => fileInputRef.current?.click()}
              className={cn(
                'rounded-md border border-dashed p-3 text-center cursor-pointer transition-colors',
                dragOver ? 'border-primary bg-primary/10' : 'border-border hover:border-primary/50',
              )}
            >
              <PlusIcon className="w-4 h-4 mx-auto mb-1 text-muted-foreground" />
              <div className="text-[11px] text-muted-foreground">
                {uploading ? 'Загружаю…' : 'Перетащите картинки или нажмите для выбора'}
              </div>
              <div className="text-[10px] text-muted-foreground/70 mt-0.5">
                первая — что правим, дальше — источники стиля/объектов
              </div>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".png,.jpg,.jpeg,.webp,.bmp"
              multiple
              className="hidden"
              onChange={(e) => {
                void addFiles(Array.from(e.target.files ?? []))
                e.target.value = ''
              }}
            />

            {references.length > 0 && (
              <div className="grid grid-cols-4 gap-2">
                {references.map((ref, i) => (
                  <div key={ref.name} className="relative rounded-md overflow-hidden border border-border bg-[var(--surface-2)]">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={ref.url} alt={ref.name} className="w-full aspect-square object-cover" />
                    <span className="absolute top-0.5 left-0.5 text-[9px] px-1 rounded bg-black/70 text-white">
                      {i === 0 ? 'image_1' : `реф ${i + 1}`}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeRef(ref)}
                      className="absolute top-0.5 right-0.5 p-0.5 rounded bg-black/70 hover:bg-red-500/80"
                      aria-label="Убрать"
                    >
                      <Trash2Icon className="w-3 h-3 text-white" />
                    </button>
                    <div className="absolute bottom-0 inset-x-0 flex justify-between px-0.5 pb-0.5">
                      <button
                        type="button"
                        onClick={() => moveRef(i, -1)}
                        disabled={i === 0}
                        className="p-0.5 rounded bg-black/60 disabled:opacity-30"
                        aria-label="Левее"
                      >
                        <ArrowLeftIcon className="w-3 h-3 text-white" />
                      </button>
                      <button
                        type="button"
                        onClick={() => moveRef(i, 1)}
                        disabled={i === references.length - 1}
                        className="p-0.5 rounded bg-black/60 disabled:opacity-30"
                        aria-label="Правее"
                      >
                        <ArrowRightIcon className="w-3 h-3 text-white" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ─── Дополнительно: модель / LoRA / TE / VAE / оптимизация ─── */}
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => setAdvancedOpen(!advancedOpen)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <ChevronDownIcon className={cn('w-3.5 h-3.5 transition-transform', advancedOpen && 'rotate-180')} />
              Дополнительно (модель, LoRA, энкодер)
            </button>

            {advancedOpen && (
              <div className="space-y-3 pt-1">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs">Модель диффузии (DiT)</Label>
                    <button
                      type="button"
                      onClick={() => void loadAssets()}
                      className="p-1 rounded hover:bg-[var(--surface-2)]"
                      aria-label="Обновить список"
                    >
                      <RefreshCwIcon className="w-3 h-3 text-muted-foreground" />
                    </button>
                  </div>
                  <Select value={params.model || '__default__'} onValueChange={(v) => setParams({ model: v === '__default__' ? '' : v })}>
                    <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__default__">Основная модель (из Настроек)</SelectItem>
                      {(assets?.diffusionModels ?? []).map((m) => (
                        <SelectItem key={m} value={m}>{m}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <div className="text-[10px] text-muted-foreground">
                    Видео-модель + LoRA = картинка без отдельного image-DiT.
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs">LoRA p-h3-image</Label>
                  <Select value={params.lora || '__off__'} onValueChange={(v) => setParams({ lora: v === '__off__' ? '' : v })}>
                    <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__off__">Без LoRA (только image-DiT)</SelectItem>
                      {(assets?.loras ?? []).map((l) => (
                        <SelectItem key={l} value={l}>{l}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {params.lora !== '' && (
                    <div className="flex items-center gap-2 pt-1">
                      <input
                        type="range"
                        min={0}
                        max={2}
                        step={0.05}
                        value={params.loraStrength}
                        onChange={(e) => setParams({ loraStrength: Number(e.target.value) })}
                        className="flex-1"
                      />
                      <span className="text-[11px] tabular-nums w-10 text-right">{params.loraStrength.toFixed(2)}</span>
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Text Encoder</Label>
                    <Select
                      value={params.textEncoder || '__auto__'}
                      onValueChange={(v) => setParams({ textEncoder: v === '__auto__' ? '' : v })}
                    >
                      <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__auto__">{assets?.defaults?.textEncoder ?? 'авто'}</SelectItem>
                        {(assets?.textEncoders ?? []).map((t) => (
                          <SelectItem key={t} value={t}>{t}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">VAE</Label>
                    <Select value={params.vae || '__auto__'} onValueChange={(v) => setParams({ vae: v === '__auto__' ? '' : v })}>
                      <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__auto__">{assets?.defaults?.vae ?? 'авто'}</SelectItem>
                        {(assets?.vaes ?? []).map((v) => (
                          <SelectItem key={v} value={v}>{v}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="text-[10px] text-muted-foreground">
                  Энкодер и VAE обязаны быть image-ными: видео-энкодер (qwen3vl_32b_minimax_h3_*)
                  с картинкой несовместим.
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={params.lowVramAttention}
                      onChange={(e) => setParams({ lowVramAttention: e.target.checked })}
                      disabled={busy}
                      className="h-3.5 w-3.5 rounded border-border bg-[var(--surface-2)]"
                    />
                    Low VRAM Attention
                  </label>
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={params.chunkFeedForward}
                      onChange={(e) => setParams({ chunkFeedForward: e.target.checked })}
                      disabled={busy}
                      className="h-3.5 w-3.5 rounded border-border bg-[var(--surface-2)]"
                    />
                    Chunk FeedForward
                  </label>
                </div>
              </div>
            )}
          </div>

          {/* ─── Запуск ─── */}
          <div className="flex gap-2 pt-1">
            <Button onClick={start} disabled={!canRun || uploading} className="flex-1 gap-1.5">
              <PlayIcon className="w-4 h-4" />
              {busy ? 'Ещё в очередь' : references.length > 0 ? 'Править изображение' : 'Сгенерировать'}
            </Button>
          </div>
        </div>

        {/* ─── Статус ─── */}
        <div className="shrink-0 border-t border-border p-3 bg-[var(--surface-1)]/90 backdrop-blur-sm">
          <GenerationStatus
            isGenerating={busy}
            phase={phase}
            progressPercent={progress}
            statusMessage={null}
            error={error}
            onInterrupt={cancelJob}
            onReset={resetJob}
            startedAt={startedAt}
            promptId={promptId}
            stageKind="single"
          />
        </div>
      </aside>

      {/* ═══ Результаты ═══ */}
      <section className="flex-1 min-w-0 overflow-y-auto">
        <ImageResultsGrid results={results} onClear={clearResults} />
      </section>
    </div>
  )
}
