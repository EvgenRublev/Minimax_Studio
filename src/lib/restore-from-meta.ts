/**
 * restoreFromMeta — восстанавливает ВСЕ параметры генерации из .meta.json
 * в useGenStore и переключает на вкладку «Генерация».
 *
 * Используется кнопкой «Повторить» на карточках галереи и в диалоге метаданных.
 */
import { toast } from 'sonner'
import { useGenStore, type VideoRefItem } from './gen-store'
import { FALLBACK_H3_PRESETS, collectResolutionValues } from '@/components/h3/video-shared'

/** (правка 124) Все номиналы пресетов — чтобы «Повторить» вернул режим
 *  пресета, а не свободный MP (иначе итог снова не был бы точным). */
const PRESET_RESOLUTIONS = new Set<string>(collectResolutionValues(FALLBACK_H3_PRESETS))

/* ─── Meta JSON shape (sidecar written by use-video-gen) ─── */
interface MetaReference {
  type?: string
  path?: string
  role?: string
  image_intent?: string
  audio_intent?: string
  include_audio?: boolean
  /** (правка 493) Видео-реф: сжатие до 480p. */
  compress?: boolean
  /** (правка 1) Обрезка аудио-рефа, секунды (trim_end null/0 = до конца). */
  trim_start?: number
  trim_end?: number | null
}

interface MetaJson {
  prompt?: string
  seed?: number
  /** (правка 146) Режим генерации: 'ref' | 't2v' | 'flf'. */
  generation_mode?: string
  /** (правка 146) FL2VA: имя файла первого кадра в ComfyUI input/. */
  first_frame?: string | null
  /** (правка 146) FL2VA: имя файла последнего кадра в ComfyUI input/. */
  last_frame?: string | null
  /** (правка 157) FL2VA: ширина первого кадра (px) — для «Повторить». */
  first_frame_width?: number | null
  /** (правка 157) FL2VA: высота первого кадра (px) — для «Повторить». */
  first_frame_height?: number | null
  /** (правка 158) FL2VA: итоговый номинал WxH — «Повторить» восстанавливает точные размеры. */
  flf_resolution?: string | null
  model_type?: string
  resolution?: string
  aspect_ratio?: string
  final_resolution_mp?: number
  low_res_mp?: number
  video_length?: number
  duration_seconds?: number
  fps?: number
  pass1_steps?: number
  /** Всего шагов в расписании pass 1 (для «6 из 6»; старые сайдкары без поля). */
  pass1_total_steps?: number
  pass2_steps?: number
  /** (правка 722) Пайплайн генерации: 'draft' (один проход) | 'full'. */
  pipeline?: string
  /** (правка 722) Шаги единственного прохода в режиме «Драфт». */
  draft_steps?: number
  sigma_variant?: string
  pass2_sampler?: string
  pass1_sampler?: string
  pass1_scheduler?: string
  turbo_lora_strength?: number
  minimax_h3_reference_detail?: string
  sparse_attention?: boolean // (правка 168)
  sparse_tau?: number // (правка 466)
  sparse_start_percent?: number // (правка 466)
  sparse_end_percent?: number // (правка 466)
  sparse_min_tokens?: number // (правка 466)
  sparse_extra_tokens?: number // (правка 466)
  veda_attention?: boolean // (правка 301)
  veda_generated_sparsity?: string // (правка 405)
  veda_reference_sparsity?: string // (правка 405)
  veda_full_attention_layers?: string // (правка 405)
  veda_full_attention_steps?: string // (правка 405)
  veda_verbose?: boolean // (правка 405)
  low_vram_attention?: boolean
  chunk_feed_forward?: boolean
  chunk_ff_chunks?: number
  chunk_ff_threshold?: number
  references?: MetaReference[]
  minimax_h3_references?: MetaReference[]
  job_id?: string
  created_at?: number
  generation_time?: number
  params?: Record<string, unknown>
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() || p
}

let refIdCounter = 0
function genId(): string {
  return `restore-${Date.now()}-${++refIdCounter}`
}

/** Map meta references → store VideoRefItem[]. */
function mapRefs(metaRefs: MetaReference[]): VideoRefItem[] {
  return metaRefs
    .filter((r) => r.path)
    .map((r) => {
      const kind = (r.type || 'image').toLowerCase() as 'image' | 'video' | 'audio'
      const role = r.role || r.image_intent || ''
      return {
        id: genId(),
        kind,
        path: r.path!,
        name: basename(r.path!),
        previewUrl: '', // will be loaded from server
        role,
        imageIntent: (r.image_intent || r.role || 'identity') as VideoRefItem['imageIntent'],
        includeAudio: r.include_audio !== false,
        compress: r.compress === true, // (правка 493)
        // (правка 1) Восстановление обрезки аудио-рефа из меты.
        trimStart: typeof r.trim_start === 'number' ? r.trim_start : undefined,
        trimEnd: typeof r.trim_end === 'number' ? r.trim_end : (r.trim_end ?? undefined),
      }
    })
}

/**
 * Fetch the .meta.json for a generated video and restore all parameters
 * into the generation store. Then switch to the Generate tab.
 *
 * @param filePath  Relative path: `subfolder/filename`
 */
export async function restoreFromMeta(filePath: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/comfy/meta?path=${encodeURIComponent(filePath)}`)
    if (!res.ok) {
      const ct = res.headers.get('content-type') || ''
      if (ct.includes('json')) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || `HTTP ${res.status}`)
      }
      throw new Error(`HTTP ${res.status}`)
    }

    const meta: MetaJson = await res.json()

    // Meta may nest params under `params` (old schema)
    const params = (meta.params && typeof meta.params === 'object' && !Array.isArray(meta.params))
      ? { ...meta, ...(meta.params as object) }
      : meta

    const store = useGenStore.getState()

    // ── Build the patch ──
    const patch: Record<string, unknown> = {}

    // Prompt
    if (typeof params.prompt === 'string' && params.prompt) {
      patch.prompt = params.prompt
    }

    // Seed
    if (typeof params.seed === 'number' && params.seed >= 0) {
      patch.seed = params.seed
    }

    // Model type
    if (typeof params.model_type === 'string' && params.model_type) {
      patch.modelType = params.model_type
    }

    // Video length (frames)
    if (typeof params.video_length === 'number' && params.video_length > 0) {
      patch.videoLength = params.video_length
    }

    // Reference detail
    if (typeof params.minimax_h3_reference_detail === 'string') {
      const detail = params.minimax_h3_reference_detail
      if (detail === 'match' || detail === 'max') {
        patch.referenceDetail = detail
      }
    }

    // Pass 1 steps
    if (typeof params.pass1_steps === 'number') {
      patch.firstSamplerSteps = params.pass1_steps
    }
    if (typeof params.pass1_total_steps === 'number') {
      patch.firstSamplerTotalSteps = params.pass1_total_steps
    }

    // (правка 722) Пайплайн «Драфт»/«Полное» — из сайдкара. Раньше он туда
    // записывался, но НЕ восстанавливался: «Повторить» драфтового ролика
    // открывал форму в режиме «Полное» (два прохода вместо одного) — то
    // есть повтор был совсем другой генерацией.
    if (params.pipeline === 'draft' || params.pipeline === 'full') {
      patch.pipeline = params.pipeline
    }

    // (правка 722) Шаги ЕДИНСТВЕННОГО прохода драфта. Сайдкар их хранил,
    // но форма их не подхватывала — драфт повторялся с дефолтными 4 шагами
    // вместо использованных.
    if (typeof params.draft_steps === 'number' && params.draft_steps > 0) {
      patch.draftSteps = params.draft_steps
    }

    // Sigma variant (pass 2 steps)
    if (typeof params.sigma_variant === 'string' && params.sigma_variant) {
      patch.sigmaVariant = params.sigma_variant
    }

    // Samplers
    if (typeof params.pass2_sampler === 'string' && params.pass2_sampler) {
      patch.pass2Sampler = params.pass2_sampler
    }
    if (typeof params.pass1_sampler === 'string' && params.pass1_sampler) {
      patch.pass1Sampler = params.pass1_sampler
    }
    if (typeof params.pass1_scheduler === 'string' && params.pass1_scheduler) {
      patch.pass1Scheduler = params.pass1_scheduler
    }

    // Turbo lora
    if (typeof params.turbo_lora_strength === 'number') {
      patch.turboLoraStrength = params.turbo_lora_strength
    }

    // VRAM / chunking
    if (typeof params.sparse_attention === 'boolean') {
      patch.sparseAttention = params.sparse_attention // (правка 168)
    }
    // (правка 466) настройки Sol-Attn — «Повторить» восстанавливает параметры ноды
    if (typeof params.sparse_tau === 'number') patch.sparseTau = params.sparse_tau
    if (typeof params.sparse_start_percent === 'number') patch.sparseStartPercent = params.sparse_start_percent
    if (typeof params.sparse_end_percent === 'number') patch.sparseEndPercent = params.sparse_end_percent
    if (typeof params.sparse_min_tokens === 'number') patch.sparseMinTokens = params.sparse_min_tokens
    if (typeof params.sparse_extra_tokens === 'number') patch.sparseExtraTokens = params.sparse_extra_tokens
    if (typeof params.veda_attention === 'boolean') {
      patch.vedaAttention = params.veda_attention // (правка 301)
    }
    // (правка 405) veda-настройки — «Повторить» восстанавливает параметры ноды
    if (typeof params.veda_generated_sparsity === 'string') {
      patch.vedaGeneratedSparsity = params.veda_generated_sparsity
    }
    if (typeof params.veda_reference_sparsity === 'string') {
      patch.vedaReferenceSparsity = params.veda_reference_sparsity
    }
    if (typeof params.veda_full_attention_layers === 'string') {
      patch.vedaFullAttentionLayers = params.veda_full_attention_layers
    }
    if (typeof params.veda_full_attention_steps === 'string') {
      patch.vedaFullAttentionSteps = params.veda_full_attention_steps
    }
    if (typeof params.veda_verbose === 'boolean') {
      patch.vedaVerbose = params.veda_verbose
    }
    if (typeof params.low_vram_attention === 'boolean') {
      patch.lowVramAttention = params.low_vram_attention
    }
    if (typeof params.chunk_feed_forward === 'boolean') {
      patch.chunkFeedForward = params.chunk_feed_forward
    }
    if (typeof params.chunk_ff_chunks === 'number') {
      patch.chunkFFChunks = params.chunk_ff_chunks
    }
    if (typeof params.chunk_ff_threshold === 'number') {
      patch.chunkFFThreshold = params.chunk_ff_threshold
    }

    // Resolution (правка 124): известный номинал → режим пресета
    // (freeResolution off, MP = 0) — повтор воспроизводит ТОЧНЫЕ размеры
    // (16:9 1080p → 1920×1080). Иначе — свободное разрешение по MP.
    // (правка 158) FL2VA: номинал из flfNominalDimensions (кадр + пресет UI) —
    // он НЕ входит в PRESET_RESOLUTIONS (напр. 854x480 для кадра 16:9), но это
    // РЕАЛЬНЫЙ размер генерации. Восстанавливаем как свободное разрешение (MP),
    // чтобы UI-бейдж совпадал с реальным.
    const metaRes = typeof params.resolution === 'string' ? params.resolution.trim() : ''
    const metaFlfRes = typeof params.flf_resolution === 'string' ? params.flf_resolution.trim() : ''
    const isFlfMode = (params.generation_mode || '').toLowerCase() === 'flf'

    if (isFlfMode && metaFlfRes) {
      // FL2VA: точный номинал из метаданных → свободное разрешение по MP
      const flfMatch = metaFlfRes.match(/(\d+)\s*x\s*(\d+)/i)
      if (flfMatch) {
        const fw = parseInt(flfMatch[1], 10)
        const fh = parseInt(flfMatch[2], 10)
        if (fw > 0 && fh > 0) {
          const flfMP = Math.round((fw * fh) / 1e6 * 100) / 100
          patch.finalResolution = flfMP
          patch.freeResolution = true
          // resolution = номинал flf (ориентация из кадра)
          patch.resolution = metaFlfRes
        }
      }
    } else if (metaRes && PRESET_RESOLUTIONS.has(metaRes)) {
      patch.resolution = metaRes
      patch.freeResolution = false
      patch.finalResolution = 0
    } else if (typeof params.final_resolution_mp === 'number' && params.final_resolution_mp > 0) {
      patch.finalResolution = params.final_resolution_mp
      patch.freeResolution = true
    }

    // Low-res MP (pass 1)
    if (typeof params.low_res_mp === 'number' && params.low_res_mp > 0) {
      patch.lowResMP = params.low_res_mp
    }

    // (правка 147) Режим генерации — восстанавливаем ДО референсов, чтобы
    // отфильтровать рефы под режим (в t2v/flf поддерживаются только аудио).
    const metaMode = typeof params.generation_mode === 'string'
      ? params.generation_mode.trim().toLowerCase()
      : ''
    if (metaMode === 't2v' || metaMode === 'flf' || metaMode === 'ref') {
      patch.mode = metaMode
    } else {
      // Старые метаданные без generation_mode — всегда были ref-режимом.
      patch.mode = 'ref'
    }
    const effMode: 'ref' | 't2v' | 'flf' = (patch.mode as string) as 'ref' | 't2v' | 'flf'

    // ── References (отфильтрованы под режим) ──
    const allMetaRefs: MetaReference[] = Array.isArray(params.references)
      ? params.references
      : Array.isArray(params.minimax_h3_references)
        ? params.minimax_h3_references
        : []

    // (правка 147) В t2v/flf поддерживаются только аудио-референсы.
    // Старый «Повторить» восстанавливал ВСЕ рефы — картинки/видео в т2v/flf
    // молча игнорировались генерацией, а в UI показывались как активные.
    // Фильтруем сразу, чтобы в стор попали только то, что реально задействуется.
    const metaRefs: MetaReference[] =
      effMode === 'ref'
        ? allMetaRefs
        : allMetaRefs.filter((r) => (r.type || 'image').toLowerCase() === 'audio')
    const droppedByMode = allMetaRefs.length - metaRefs.length

    // (правка 147) FL2VA: кадры — это отдельные файлы в input/, восстанавливаем
    // в слоты startFrame/endFrame (как и рефы, проверяем существование).
    const firstFramePath = typeof params.first_frame === 'string' ? params.first_frame : ''
    const lastFramePath = typeof params.last_frame === 'string' ? params.last_frame : ''
    const frameSlots: Array<{ slot: 'start' | 'end'; path: string; name: string }> = []
    if (effMode === 'flf') {
      if (firstFramePath) frameSlots.push({ slot: 'start', path: firstFramePath, name: basename(firstFramePath) })
      if (lastFramePath) frameSlots.push({ slot: 'end', path: lastFramePath, name: basename(lastFramePath) })
    }

    // Референсы и кадры в ComfyUI input/ недолговечны (чистка input,
    // переустановка ComfyUI). «Повторить» с несуществующим файлом падал бы
    // посреди генерации сырым FileNotFoundError. Проверяем существование и
    // честно предупреждаем, что восстановлены не все.
    // (правка 587) Пробуем существование по ОДНОМУ списку: пути фильтруются
    // от пустых, а флаги exists[] раньше индексировались по НЕфильтрованному
    // metaRefs — при пустом path у рефа все флаги съезжали. Считаем и потребляем
    // filteredRefs (при непустых путях поведение прежнее).
    const filteredRefs: MetaReference[] = metaRefs.filter((r) => r.path)
    const refAndFramePaths: string[] = [
      ...filteredRefs.map((r) => r.path!),
      ...frameSlots.map((f) => f.path),
    ]

    if (refAndFramePaths.length > 0) {
      const exists: boolean[] = await Promise.all(
        refAndFramePaths.map(async (p) => {
          try {
            const res = await fetch(`/api/comfy/file?type=input&filename=${encodeURIComponent(p)}`, {
              method: 'HEAD',
              signal: AbortSignal.timeout(5000),
            })
            return res.ok
          } catch {
            return true // сервер недоступен — не отбрасываем молча
          }
        }),
      )

      // (правка 587) exists[] индексируется по filteredRefs (см. выше).
      const presentRefs = filteredRefs.filter((_, i) => exists[i])
      const missingRefs = metaRefs.length - presentRefs.length
      if (presentRefs.length > 0) {
        patch.refs = mapRefs(presentRefs)
      }
      if (missingRefs > 0) {
        toast.warning(`${missingRefs} реф. не найдены в ComfyUI`, {
          description: 'Файлы были удалены из input/. Остальные параметры восстановлены.',
        })
      }

      // Кадры: если файл первого кадра отсутствует — в flf-режиме генерация
      // не может вообще стартовать (start frame обязателен). Честно
      // предупреждаем и НЕ включаем режим flf, если кадр утерян.
      if (frameSlots.length > 0) {
        const refOffset = filteredRefs.length // (правка 587) сдвиг кадров — по filteredRefs
        let missingFrames = 0
        const restored: Partial<{ startFrame: typeof frameSlots[number]; endFrame: typeof frameSlots[number] }> = {}
        for (let i = 0; i < frameSlots.length; i++) {
          const fs = frameSlots[i]
          if (exists[refOffset + i]) {
            if (fs.slot === 'start') restored.startFrame = fs
            else restored.endFrame = fs
          } else {
            missingFrames++
          }
        }
        if (restored.startFrame) {
          // (правка 157) Восстанавливаем размеры кадра из метаданных —
          // без них flf-ветка use-video-gen не сработает и ориентация
          // снова будет браться из пресета UI, а не из кадра.
          patch.startFrame = {
            path: restored.startFrame.path,
            name: restored.startFrame.name,
            previewUrl: '',
            width: typeof params.first_frame_width === 'number' ? params.first_frame_width : undefined,
            height: typeof params.first_frame_height === 'number' ? params.first_frame_height : undefined,
          }
        }
        if (restored.endFrame) {
          patch.endFrame = { path: restored.endFrame.path, name: restored.endFrame.name, previewUrl: '' }
        }
        if (missingFrames > 0) {
          toast.warning(`${missingFrames} кадр(ов) не найдены в ComfyUI`, {
            description: 'Файлы кадров были удалены из input/. Перетащите их заново, если нужен именно flf-режим.',
          })
          // Если стартовый кадр потерян — flf-генерация не может стартовать,
          // деградируем до t2v, чтобы «Повторить» хотя бы запустился.
          if (!restored.startFrame && effMode === 'flf') {
            patch.mode = 't2v'
          }
        }
      }
    }

    if (droppedByMode > 0) {
      // Информационный тост: в режиме t2v/flf поддерживаются только аудио,
      // картинки/видео из метаданных отброшены (они были бы молча игнорированы).
      toast.info('Референсы картинок/видео отброшены', {
        description: `Режим ${effMode} использует только аудио-референсы. ${droppedByMode} шт. не загружено.`,
      })
    }

    // ── Apply to store ──
    store.patchVideo(patch as Parameters<typeof store.patchVideo>[0])

    // ── Switch to Generate tab ──
    window.dispatchEvent(new CustomEvent('h3:goto-generate'))

    // (правка 147) Финальный тост учитывает режим и кадры.
    const modeShort = effMode === 'flf' ? 'Кадры' : effMode === 't2v' ? 'Текст' : 'Референсы'
    const restoredFrames = (patch.startFrame ? 1 : 0) + (patch.endFrame ? 1 : 0)
    const bits: string[] = ['Промпт', 'seed', `режим «${modeShort}»`]
    if (restoredFrames > 0) bits.push(`${restoredFrames} кадр(а)`)
    if (metaRefs.length > 0) bits.push(`${metaRefs.length} реф.`)
    toast.success('Параметры генерации восстановлены', {
      description: bits.join(', ') + ' загружены в форму генерации.',
    })

    return true
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    toast.error('Не удалось восстановить параметры', { description: msg })
    return false
  }
}
