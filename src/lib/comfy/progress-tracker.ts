/**
 * ComfyUI progress tracker.
 * Maintains a WebSocket connection to ComfyUI and stores:
 *   - Latest progress per prompt_id
 *   - Latest preview image (base64) per prompt_id
 *
 * IMPORTANT: Uses the SAME clientId as the prompt submission so that
 * ComfyUI ModelPreviewOverrideKJ events are delivered to us.
 */
import WebSocket from 'ws'
import { onQueueDrained } from '@/lib/vram-arbiter'

const COMFY_BASE_URL = (process.env.COMFY_URL || 'http://127.0.0.1:8188').replace(/\/+$/, '')
const COMFY_WS_URL = COMFY_BASE_URL.replace(/^http/, 'ws') + '/ws'

/** Single shared client_id used for BOTH prompt submission and WebSocket. */
const CLIENT_ID = `cb_session_${Date.now().toString(36)}`

export function getClientId(): string {
  return CLIENT_ID
}

interface NodeProgress {
  value: number
  max: number
}

/**
 * Per-prompt progress. The H3 workflow has TWO sampler passes (Pass 1 low-res,
 * Pass 2 high-res); each emits its own `progress` WS events, so a flat value/max
 * would bounce 0→100→0→100. We track each progress-emitting node separately and
 * expose an overall fraction that goes 0→100 once across all passes.
 */
interface ProgressEntry {
  /** progress-emitting nodes observed for this prompt, in order. */
  nodes: string[]
  byNode: Record<string, NodeProgress>
  /** True when `executing` reported node===null (prompt finished). */
  done: boolean
  /**
   * STICKY (правка 50): becomes true the moment ANY pass-2 node is observed
   * (progress event, executing event, or KJ preview node_id '13') and never
   * reverts. The workflow runs pass 1 → pass 2 strictly once, so the stage
   * must be monotonic. The old logic derived the stage from the most recent
   * event's node, so a pass-2 KJ preview event (pseudo-node 'preview',
   * statically stage 1) flipped the stage back to 1 every step — the overall
   * bar snapped to 50% (pass-1 fraction 1.0 → (0+1)/2) on every step.
   */
  stage2Seen: boolean
  /**
   * Which pass the shared 'preview' pseudo-node (KJ step/total) currently
   * reflects; set from the node_id of the kj_preview_override event, so stage
   * fractions never mix stale values from the other pass into the bar.
   */
  previewStage: number
  /**
   * (правка 255) Динамические стадии: сабмит регистрирует список сэмплер-узлов
   * воркфлоу В ПОРЯДКЕ выполнения (generate full: ['46:21'],['46:16']; draft:
   * одна; extend: ext_samp_i по клипам; refine chunks: cs_k по окнам).
   * Общий прогресс = (стадия + дробь)/N — честные 0→100 для ЛЮБОГО числа
   * проходов, а не только для двухпроходной генерации.
   */
  stageSpecs: string[][] | null
  /** node_id → индекс стадии (из stageSpecs; только сэмплер-узлы). */
  nodeStage: Record<string, number> | null
  /**
   * (фикс порядка) Сэмплер-узлы в порядке ПЕРВОГО события. ComfyUI
   * исполняет независимые окна рефайна не по порядку нумерации
   * (наблюдалось cs_0 → cs_2 → cs_1): стадия для метки/процента —
   * порядковый номер НАЧАВШЕГОСЯ сэмплера, а не индекс его узла,
   * иначе «Кусок 3/3» появляется во время второго и процент скачет.
   */
  stageObserved: string[]
  /** Sticky-максимум наблюдаемой стадии (−1 = ничего не видели). */
  maxStage: number
  /** Узел, который ComfyUI исполняет прямо сейчас (из 'executing'). */
  executingNode: string | null
  /**
   * Последний сэмплер, от которого было ЛЮБОЕ событие (executing или
   * progress). Прогресс сэмплера течёт непрерывно, пока он работает, —
   * это самое надёжное «что исполняется СЕЙЧАС»: одиночное забегающее
   * вперёд событие следующего сэмплера отбрасывается первым же событием
   * реального (фикс метки «Кусок 3/3» при работе второго окна).
   */
  lastStageEvidence: string | null
  /**
   * (правка 479) Tile-upscale: геометрия (число тайлов, чанков, шагов).
   * Задана при сабмите, если удалось вычислить. КJ-события счётчики:
   * kjEventCount = сколько KJ-превью уже пришло (каждое = 1 шаг 1 тайла-чанка).
   * Общий прогресс = kjEventCount / (totalUnits × stepsPerUnit), монотонно 0→1.
   */
  tileTotalUnits: number | null
  tileTotalTiles: number | null
  tileTotalChunks: number | null
  tileStepsPerUnit: number | null
  tileKjCount: number
}

interface PreviewEntry {
  image: string // base64 data
  mime: string // 'image/jpeg' | 'image/webp' | 'video/mp4' | 'image/png'
  width: number
  height: number
  step: number
  total: number
  timestamp: number
  /** (правка 198) Проход, из которого пришёл ЭТОТ кадр (1|2) — по node_id
   *  KJ-события ('12'/'extpv' = 1, '13'/'extpv2' = 2). Нестикадный: нужен,
   *  чтобы роут /api/comfy/preview скрывал ранние «перешумлённые» кадры
   *  прохода 2, не трогая черновики прохода 1. */
  stage?: number
}

const progressMap = new Map<string, ProgressEntry>()
const previewMap = new Map<string, PreviewEntry>()

function newEntry(): ProgressEntry {
  return {
    nodes: [], byNode: {}, done: false, stage2Seen: false, previewStage: 0,
    stageSpecs: null, nodeStage: null, stageObserved: [], maxStage: -1,
    executingNode: null, lastStageEvidence: null,
    tileTotalUnits: null, tileTotalTiles: null, tileTotalChunks: null,
    tileStepsPerUnit: null, tileKjCount: 0,
  }
}

/** (правка 479) Геометрия тайлов для прогресс-трекера. */
export interface TileGeometry {
  totalTiles: number
  tilesW: number
  tilesH: number
  totalChunks: number
  stepsPerUnit: number
  totalUnits: number
}

/**
 * (правка 255) Регистрация стадий промпта: список групп сэмплер-узлов в
 * порядке выполнения. Вызывается сразу после успешного сабмита — до любых
 * WS-событий. Без регистрации работает легаси-модель «ровно 2 прохода».
 * (правка 479) Опциональная tileGeometry — для tile-upscale прогресса.
 */
export function registerPromptStages(
  promptId: string,
  stages: string[][],
  tileGeometry?: TileGeometry | null,
) {
  ensureConnected()
  const entry = progressMap.get(promptId) ?? newEntry()
  progressMap.set(promptId, entry)
  if (!stages.length) return
  entry.stageSpecs = stages
  const map: Record<string, number> = {}
  stages.forEach((nodes, idx) => {
    for (const n of nodes) map[n] = idx
  })
  entry.nodeStage = map
  entry.stageObserved = []
  // (правка 479) tile-upscale геометрия
  if (tileGeometry) {
    entry.tileTotalUnits = tileGeometry.totalUnits
    entry.tileTotalTiles = tileGeometry.totalTiles
    entry.tileTotalChunks = tileGeometry.totalChunks
    // (правка 716) stepsPerUnit обязан быть > 0: в вычислениях прогресса
    // идёт деление на него (tileKjCount / tileStepsPerUnit) — клиент мог
    // прислать steps: 0, и получался NaN-шаг/NaN-прогресс.
    entry.tileStepsPerUnit = Math.max(1, Math.floor(tileGeometry.stepsPerUnit || 0) || 1)
    entry.tileKjCount = 0
  }
}

/**
 * Real execution window per prompt (ms), measured directly from ComfyUI
 * `executing` WS events: first node start → node===null (finished).
 * This is the ACTUAL generation time — independent of poll intervals and
 * submission overhead — and the single source of truth for both the gallery
 * badge and the .meta.json sidecar.
 */
const execWindows = new Map<string, { start: number; end: number | null }>()

/** Get the real execution duration in ms, or null if not (yet) measured. */
export function getExecutionDurationMs(promptId: string): number | null {
  const w = execWindows.get(promptId)
  if (!w || w.end === null) return null
  return Math.max(0, w.end - w.start)
}

let ws: WebSocket | null = null
let connecting = false
let activePromptId: string | null = null
/** The prompt_id currently executing (from 'executing' WS event). */
let executingPromptId: string | null = null
/** Предыдущее значение queue_remaining из status-событий ComfyUI. */
let lastQueueRemaining = 0

/** Set the active prompt_id (called when we submit a job). */
export function setActivePrompt(id: string) {
  activePromptId = id
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return
  if (connecting) return
  connecting = true

  try {
    // Use clientId query param so ComfyUI routes events to this session
    const sock = new WebSocket(`${COMFY_WS_URL}?clientId=${CLIENT_ID}`)
    ws = sock

    sock.on('open', () => {
      connecting = false
    })

    sock.on('message', (raw) => {
      try {
        applyTrackerMessage(JSON.parse(raw.toString()))
      } catch { /* ignore parse errors */ }
    })

    // (правка 716) Обработчики проверяют, что событие пришло ИМЕННО от
    // текущего сокета. Раньше обработчик СТАРОГО сокета присваивал ws = null
    // безусловно: если к этому моменту уже был создан новый сокет, модуль
    // терял ссылку на живое соединение (оно оставалось открытым), а
    // следующий connect() создавал ВТОРОЕ соединение → дубликат событий
    // ComfyUI и дубликатные обновления прогресса/превью.
    const isCurrent = () => ws === sock

    sock.on('close', () => {
      if (!isCurrent()) return
      ws = null
      connecting = false
      setTimeout(connect, 3000)
    })

    sock.on('error', () => {
      if (!isCurrent()) return
      ws = null
      connecting = false
      // Обычно после 'error' следует 'close' с реконнектом, но это не
      // гарантировано — страхуемся собственным таймером (безопасно: connect
      // сам идемпотентен через connecting-флаг).
      setTimeout(connect, 3000)
    })
  } catch {
    ws = null
    connecting = false
    setTimeout(connect, 5000)
  }
}

/**
 * Обработка одного WS-сообщения ComfyUI (тело ws.on('message')).
 * Выделено в экспорт (правка 255) для smoke-тестов математики стадий
 * без живого соединения.
 */
export function applyTrackerMessage(msg: {
  type?: string
  data?: Record<string, unknown> & { prompt_id?: string; node?: string | null }
}) {
  try {
    // Опустошение очереди → фоновая выгрузка моделей MiniMax из VRAM
    // (vram-arbiter: GPU освобождается сразу после завершения генераций)
    if (msg.type === 'status') {
      const remaining = (msg.data as { status?: { exec_info?: { queue_remaining?: number } } } | undefined)
        ?.status?.exec_info?.queue_remaining
      if (typeof remaining === 'number') {
        if (remaining === 0 && lastQueueRemaining > 0) {
          // (правка 716) .catch обязателен: onQueueDrained внутри ждёт
          // мьютекс VRAM-диспетчера, который может быть занят дольше
          // таймаута — без обработчика это необработанный rejection, а Node
          // по умолчанию завершает процесс на unhandled rejection.
          void onQueueDrained().catch((err) => {
            console.warn('[progress-tracker] onQueueDrained failed:', err instanceof Error ? err.message : String(err))
          })
        }
        lastQueueRemaining = remaining
      }
    }

    // Standard progress events (one per sampler node/pass)
    if (msg.type === 'progress' && msg.data?.prompt_id) {
      const pid = msg.data.prompt_id
      const node = typeof msg.data.node === 'string' ? msg.data.node : 'sampler'
      let entry = progressMap.get(pid)
      if (!entry) {
        entry = newEntry()
        progressMap.set(pid, entry)
      }
      if (!entry.byNode[node]) {
        entry.byNode[node] = { value: 0, max: 1 }
      }
      entry.byNode[node].value = (msg.data.value as number) || 0
      entry.byNode[node].max = (msg.data.max as number) || 1
      if (!entry.nodes.includes(node)) {
        entry.nodes.push(node)
      }
      // Правка 50: sticky stage — pass-2 evidence never reverts to pass 1
      if (STAGE2_NODES.has(node)) entry.stage2Seen = true
      // (фикс порядка) стадия в ПОРЯДКЕ НАБЛЮДЕНИЯ сэмплеров
      const obsIdx = obsStageOf(entry, node)
      if (obsIdx !== null) {
        entry.maxStage = Math.max(entry.maxStage, obsIdx)
        entry.lastStageEvidence = node
      }
    }

    // Standard preview events (from KSampler etc.)
    if (msg.type === 'preview' && msg.data?.prompt_id && msg.data.image) {
      previewMap.set(msg.data.prompt_id, {
        image: msg.data.image as string,
        mime: `image/${(msg.data.image_type as string) || 'png'}`,
        width: (msg.data.width as number) || 0,
        height: (msg.data.height as number) || 0,
        step: 0,
        total: 0,
        timestamp: Date.now(),
      })
      trimPreviewMap()
    }

    // KJNodes ModelPreviewOverride events (custom type)
    if (msg.type === 'kj_preview_override' && (msg.data as { image?: string } | undefined)?.image) {
      const d = msg.data as {
        image: string; mime?: string; w?: number; h?: number
        step?: number; total?: number; node_id?: string
      }
      // Use the currently-executing prompt (most accurate for queue scenarios)
      const pid = executingPromptId || activePromptId || d.node_id || 'unknown'
      const kjNodeForStage = typeof d.node_id === 'string' ? d.node_id : ''
      previewMap.set(pid, {
        image: d.image,
        mime: d.mime || 'image/jpeg',
        width: d.w || 0,
        height: d.h || 0,
        step: d.step || 0,
        total: d.total || 0,
        timestamp: Date.now(),
        // (правка 198) проход ЭТОГО кадра (нестикадно, по node_id события)
        stage: STAGE2_NODES.has(kjNodeForStage) ? 2 : 1,
      })
      // Also update progress from step/total
      if ((d.total || 0) > 0) {
        let entry = progressMap.get(pid)
        if (!entry) {
          entry = newEntry()
          progressMap.set(pid, entry)
        }
        // (правка 479) Tile-upscale: каждый KJ-событие = 1 шаг 1 тайла-чанка.
        // Считаем ВСЕ события монотонно — это честный прогресс 0→100.
        // (правка 487) Boundary-0 событие (step=0 — затравка из шума ДО
        // первого шага, шлётся при старте каждого сэмплинга) шагом НЕ
        // является: считаем только step>=1, иначе каждый тайл добавлял
        // лишнюю единицу и шкала убегала вперёд (прогресс «тайлы уже
        // проходят» ещё во время инициализации модели).
        if (entry.tileTotalUnits !== null && entry.tileStepsPerUnit !== null) {
          if ((d.step || 0) >= 1) entry.tileKjCount++
        }
        const node = 'preview'
        if (!entry.byNode[node]) entry.byNode[node] = { value: 0, max: 1 }
        entry.byNode[node].value = d.step || 0
        entry.byNode[node].max = d.total as number
        if (!entry.nodes.includes(node)) entry.nodes.push(node)
        // Правка 50: the KJ event knows its own node_id ('12' pass 1 /
        // '13' pass 2) — tag the shared pseudo-node with that pass and
        // latch the sticky stage from real pass-2 evidence.
        const kjNode = kjNodeForStage
        // (правка 255 + фикс порядка) псевдо-узел 'preview' отражает стадию
        // ИСПОЛНЯЕМОГО сэмплера в ПОРЯДКЕ НАБЛЮДЕНИЯ (KJ-обёртка общая
        // для всех клипов/окон — её node_id не различает стадии).
        const obsIdx = obsStageOf(entry, entry.executingNode)
        if (obsIdx !== null) {
          entry.previewStage = obsIdx
          entry.maxStage = Math.max(entry.maxStage, obsIdx)
        } else {
          // (правка 716) Единицы приведены к 0-BASED индексу стадии — как в
          // ветке выше. Раньше здесь писался 1-BASED номер прохода (1|2), а
          // поле previewStage использовалось ещё и в динамическом пути как
          // 0-based индекс (сравнение `idx !== cur`, где cur — 0-based). Из-за
          // смешения единиц доля KJ-превью приписывалась НЕ ТОЙ стадии
          // (off-by-one) — прогресс-бар прыгал.
          entry.previewStage = STAGE2_NODES.has(kjNode) ? 1 : 0
        }
        if (STAGE2_NODES.has(kjNode)) entry.stage2Seen = true
      }
      trimPreviewMap()
    }

    // Execution events
    if (msg.type === 'executing' && msg.data?.prompt_id) {
      // Real execution window: first node start → finished marker
      const pid = msg.data.prompt_id
      if (typeof msg.data.node === 'string') {
        let w = execWindows.get(pid)
        if (!w) {
          w = { start: Date.now(), end: null }
          execWindows.set(pid, w)
        }
        if (execWindows.size > 100) {
          const keys = Array.from(execWindows.keys())
          for (let i = 0; i < keys.length - 100; i++) execWindows.delete(keys[i])
        }
      } else if (msg.data.node === null) {
        const w = execWindows.get(pid)
        if (w && w.end === null) w.end = Date.now()
      }

      if (msg.data.node === null) {
        const entry = progressMap.get(msg.data.prompt_id)
        if (entry) entry.done = true
        // Clear preview when done
        previewMap.delete(msg.data.prompt_id)
        // Clear executing prompt if it was this one
        if (executingPromptId === msg.data.prompt_id) {
          executingPromptId = null
        }
        // (правка 716) activePromptId тоже сбрасываем: он НИКОГДА не
        // обнулялся, и позднее KJ-событие после завершения джоба
        // приписывалось ПРЕДЫДУЩЕМУ промпту (pid = executingPromptId ||
        // activePromptId) — в галерее появлялось «призрачное» превью
        // у уже завершённого ролика.
        if (activePromptId === msg.data.prompt_id) {
          activePromptId = null
        }
      } else if (typeof msg.data.node === 'string') {
        let entry = progressMap.get(msg.data.prompt_id)
        if (!entry) {
          entry = newEntry()
          progressMap.set(msg.data.prompt_id, entry)
        }
        // (правка 255) помним исполняемый узел — по нему KJ-превью
        // псевдо-узел 'preview' получает стадию (обёртка превью общая)
        entry.executingNode = msg.data.node
        if (STAGE2_NODES.has(msg.data.node)) entry.stage2Seen = true
        const obsIdx = obsStageOf(entry, msg.data.node)
        if (obsIdx !== null) {
          entry.maxStage = Math.max(entry.maxStage, obsIdx)
          entry.lastStageEvidence = msg.data.node
        }
        // Track which prompt is currently executing
        executingPromptId = msg.data.prompt_id
      }
    }

    // Error events
    if (msg.type === 'execution_error' && msg.data?.prompt_id) {
      progressMap.delete(msg.data.prompt_id)
      previewMap.delete(msg.data.prompt_id)
    }

    // Cleanup progress: keep max 100 entries
    if (progressMap.size > 100) {
      const keys = Array.from(progressMap.keys())
      for (let i = 0; i < keys.length - 100; i++) {
        progressMap.delete(keys[i])
      }
    }
  } catch { /* ignore parse errors */ }
}

function trimPreviewMap() {
  if (previewMap.size > 10) {
    const keys = Array.from(previewMap.keys())
    previewMap.delete(keys[0])
  }
}

/* ─── Fixed two-stage progress (workflow is known: Pass 1 low-res, Pass 2 high-res) ───
 *
 * Dividing by the number of OBSERVED progress nodes makes the bar bounce:
 * while only pass-1 nodes exist the divisor is 1 (bar hits 100%), then the
 * pass-2 node appears and the divisor becomes 2 (bar drops to 50%). Instead,
 * the workflow always has exactly TWO stages, and every progress-emitting
 * node id is mapped to its stage up front. */
const TOTAL_STAGES = 2

/** Pass 1: SamplerCustomAdvanced '46:21', KJ preview override '12';
 *  (правка 194) extend-режим: KJ preview 'extpv' (pass 1 Extender'а). */
const STAGE1_NODES = new Set(['46:21', '12', 'extpv'])
/** Pass 2: SamplerCustomAdvanced '46:16', KJ preview override '13';
 *  (правка 194) extend-режим: KJ preview 'extpv2' (MiniMaxH3ExtenderPass2). */
const STAGE2_NODES = new Set(['46:16', '13', 'extpv2'])
/** Pseudo-node carrying KJ preview step/total for whichever pass is active. */
const PREVIEW_PSEUDO = 'preview'

function stageOf(node: string): 1 | 2 | null {
  if (STAGE2_NODES.has(node)) return 2
  if (STAGE1_NODES.has(node)) return 1
  return null
}

/**
 * (правка 255) Стадия узла по динамическим спецификациям (0-базированный
 * индекс); null — спецификации не зарегистрированы или узел вне списков.
 */
function dynStageOf(entry: ProgressEntry, node: string | null): number | null {
  if (!entry.nodeStage || !node) return null
  const idx = entry.nodeStage[node]
  return typeof idx === 'number' ? idx : null
}

/**
 * (фикс порядка) ПОРЯДКОВЫЙ номер сэмпла по первому событию (0-базированный).
 * ComfyUI исполняет независимые окна рефайна не по порядку узлов
 * (cs_0 → cs_2 → cs_1): «Кусок X/N» и процент обязаны идти монотонно,
 * поэтому стадия = сколько сэмплеров уже начиналось, а не чей это узел.
 * Вызов с новым сэмплером добавляет его в конец порядка наблюдения.
 */
function obsStageOf(entry: ProgressEntry, node: string | null): number | null {
  if (dynStageOf(entry, node) === null) return null
  const n = node as string
  let i = entry.stageObserved.indexOf(n)
  if (i === -1) {
    entry.stageObserved.push(n)
    i = entry.stageObserved.length - 1
  }
  return i
}

/**
 * Текущая стадия динамической модели (0-базированная, в порядке наблюдения).
 *
 * Основа — ПОСЛЕДНЕЕ событие сэмплера (lastStageEvidence): прогресс
 * работающего сэмплера течёт непрерывно, поэтому одиночное «забегающее
 * вперёд» событие чужого сэмплера (executing/KJ-превью на смене узла)
 * отбрасывается первым же событием реального. Если сэмплеров в событиях
 * ещё не было (или они кончились) — sticky-максимум наблюдавшихся
 * порядков: назад workflow не возвращается.
 */
function curDynStage(entry: ProgressEntry): number {
  const n = entry.stageSpecs?.length ?? 1
  const evidenceIdx = obsStageOf(entry, entry.lastStageEvidence)
  const cur = evidenceIdx !== null ? evidenceIdx : entry.maxStage
  return Math.min(Math.max(cur, 0), n - 1)
}

/** Stage of a node; the shared 'preview' pseudo-node follows the pass that
 *  last wrote it (правка 50), so its step/total never leaks into the wrong
 *  stage fraction. */
function stageOfTracked(entry: ProgressEntry, node: string): 1 | 2 | null {
  // Легаси-ветка: previewStage хранится как 0-BASED индекс стадии (0 = проход
  // 1, 1 = проход 2) — как и в динамическом пути (правка 716). Здесь
  // переводим в 1|2 (номер прохода) для легаси-шкалы.
  if (node === PREVIEW_PSEUDO) return entry.previewStage >= 1 ? 2 : 1
  return stageOf(node)
}

/**
 * The stage currently executing. STICKY (правка 50): once pass 2 has any
 * evidence it stays 2 — the workflow never goes back from pass 2 to pass 1.
 */
function currentStage(entry: ProgressEntry): 1 | 2 {
  return entry.stage2Seen ? 2 : 1
}

/** Clamp helper. */
function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x))
}

/** Lazy-init: start the WebSocket connection on first access. */
let initialized = false
function ensureConnected() {
  if (!initialized) {
    initialized = true
    connect()
  }
}

/**
 * Compute the overall progress fraction (0..1) across ALL sampling stages.
 *
 * (правка 255) Если при сабмите зарегистрированы stageSpecs — прогресс честно
 * делится на N стадий (draft/extend-клипы/refine-окна дают свою длину шкалы):
 *   overall = (stageIdx + stageFraction) / N
 * Легаси-режим (без регистрации) — прежняя модель «ровно 2 прохода»:
 *   overall = ((stage − 1) + stageFraction) / 2
 * В обоих случаях шкала проходится 0→100 ровно один раз, монотонно.
 * Returns null if the prompt is unknown.
 */
export function getOverallProgress(promptId: string): number | null {
  ensureConnected()
  const entry = progressMap.get(promptId)
  if (!entry || entry.nodes.length === 0) return null
  if (entry.done) return 1

  // (правка 479) Tile-upscale: монотонный прогресс по счётчику KJ-событий.
  // Каждый KJ-превью = 1 шаг 1 тайла-чанка. Общее число шагов =
  // totalUnits × stepsPerUnit. Бар идёт 0→100 ровно один раз.
  if (entry.tileTotalUnits !== null && entry.tileStepsPerUnit !== null && entry.tileTotalUnits > 0) {
    const totalSteps = entry.tileTotalUnits * entry.tileStepsPerUnit
    return clamp01(entry.tileKjCount / totalSteps)
  }

  if (entry.stageSpecs && entry.stageSpecs.length > 0) {
    const n = entry.stageSpecs.length
    const cur = curDynStage(entry)
    let stageFrac = 0
    for (const node of entry.nodes) {
      // Псевдо-узел 'preview' получает стадию из previewStage (по исполняемому
      // сэмплеру в момент KJ-события); реальные сэмплеры — в порядке наблюдения.
      const idx = node === PREVIEW_PSEUDO ? entry.previewStage : obsStageOf(entry, node)
      if (idx === null || idx !== cur) continue
      const np = entry.byNode[node]
      if (np && np.max > 0) {
        stageFrac = Math.max(stageFrac, clamp01((np.value || 0) / np.max))
      }
    }
    return clamp01((cur + stageFrac) / n)
  }

  const stage = currentStage(entry)
  // Best fraction within the current stage (several nodes may report —
  // e.g. the sampler and the KJ preview override; take the furthest one).
  let stageFrac = 0
  for (const n of entry.nodes) {
    if (stageOfTracked(entry, n) !== stage) continue
    const np = entry.byNode[n]
    if (np && np.max > 0) {
      stageFrac = Math.max(stageFrac, clamp01((np.value || 0) / np.max))
    }
  }
  return clamp01(((stage - 1) + stageFrac) / TOTAL_STAGES)
}

/**
 * Stage readout for the live-preview overlay: which stage is running
 * (1-based) out of how many, and its step/total (the largest reporting
 * node of that stage).
 */
export interface TileStageInfo {
  stage: number
  totalStages: number
  step: number
  total: number
  /** (правка 479) Тайл-инфо для UI: «Тайл X/Y» + текущий тайл/чанк. */
  tileInfo?: {
    totalTiles: number
    currentTile: number
    totalUnits: number
    currentUnit: number
    stepsPerUnit: number
  }
  /**
   * (правка 487) Сэмплинг ещё не начался: идёт подготовка/динамическая
   * загрузка модели в VRAM (логи «Model Initialization», SLA и т.п.).
   * UI показывает «Подготовка модели…» вместо ложного «Тайл 1/N · шаг 1/2».
   */
  preparing?: boolean
}

export function getStageInfo(
  promptId: string,
): TileStageInfo | null {
  ensureConnected()
  const entry = progressMap.get(promptId)
  if (!entry) return null

  // (правка 479) Tile-upscale: «Тайл X/Y» по счётчику KJ-событий.
  // Тайлы идут в порядке row-major: тайл 1 (чанк 1..N), тайл 2 (чанк 1..N), …
  // currentTile = floor((unit-1) / totalChunks) + 1
  if (entry.tileTotalUnits !== null && entry.tileStepsPerUnit !== null && entry.tileTotalUnits > 0) {
    const completedUnits = Math.floor(entry.tileKjCount / entry.tileStepsPerUnit)
    const currentUnit = Math.min(completedUnits + 1, entry.tileTotalUnits)
    const stepInUnit = (entry.tileKjCount % entry.tileStepsPerUnit) + 1
    // Текущий тайл (1-based): тайлы идут в порядке row-major, каждый тайл
    // имеет totalChunks временных чанков.
    const totalChunks = entry.tileTotalChunks ?? 1
    const totalTiles = entry.tileTotalTiles ?? entry.tileTotalUnits
    const currentTile = Math.min(
      Math.floor((currentUnit - 1) / totalChunks) + 1,
      totalTiles,
    )
    return {
      stage: currentTile,
      totalStages: totalTiles,
      step: stepInUnit,
      total: entry.tileStepsPerUnit,
      // (правка 487) Пока ни одного реального шага — модель готовится
      // (инициализация, динамическая подгрузка весов): не обманываем
      // пользователя меткой «Тайл 1/N».
      preparing: entry.tileKjCount === 0,
      tileInfo: {
        totalTiles,
        currentTile,
        totalUnits: entry.tileTotalUnits,
        currentUnit,
        stepsPerUnit: entry.tileStepsPerUnit,
      },
    }
  }

  if (entry.stageSpecs && entry.stageSpecs.length > 0) {
    const n = entry.stageSpecs.length
    const cur = curDynStage(entry)
    let step = 0
    let total = 0
    for (const node of entry.nodes) {
      // Псевдо-узел 'preview' — стадия из previewStage; реальные — порядок
      // наблюдения (см. getOverallProgress).
      const idx = node === PREVIEW_PSEUDO ? entry.previewStage : obsStageOf(entry, node)
      if (idx === null || idx !== cur) continue
      const np = entry.byNode[node]
      if (np && np.max > total) {
        total = np.max
        step = Math.min(np.value || 0, np.max)
      }
    }
    return { stage: cur + 1, totalStages: n, step, total }
  }

  const stage = currentStage(entry)
  let step = 0
  let total = 0
  for (const n of entry.nodes) {
    if (stageOfTracked(entry, n) !== stage) continue
    const np = entry.byNode[n]
    if (np && np.max > total) {
      total = np.max
      step = Math.min(np.value || 0, np.max)
    }
  }
  return { stage, totalStages: TOTAL_STAGES, step, total }
}

/** Get progress for a prompt_id. Returns null if unknown. */
export function getProgress(promptId: string): ProgressEntry | null {
  ensureConnected()
  return progressMap.get(promptId) ?? null
}

/** Get the latest preview image for a prompt_id. Returns null if none. */
export function getPreview(promptId: string): PreviewEntry | null {
  ensureConnected()
  return previewMap.get(promptId) ?? null
}