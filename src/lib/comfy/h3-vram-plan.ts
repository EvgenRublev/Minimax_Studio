/**
 * (правка 1131) VRAM-план для H3: прогноз пика pass 2 и авто-решение, как
 * провести клип на карте 8–12 ГБ.
 *
 * Зачем отдельно от шаблона: транзиенты attention и FFN зависят от ЧИСЛА
 * ТОКЕНОВ последовательности (S), а S — от канвы и латентной длины. Раньше
 * размеры кусков подбирались, но никто не проверял, влезает ли САМА
 * последовательность: на 1080p/10 с K/V — это 4.4 ГБ, и никакие чанки этого
 * не меняют. Здесь считается прогноз и, если клип не влезает, выбирается
 * временное окно, которое влезает.
 *
 * Оценка намеренно консервативна (лучше поставить окно на границе, чем
 * поймать OOM через 5 минут), но откалибрована по уже проверенным режимам:
 *   1080p/5 с bounded ≈ 5.8 ГБ — работает на 8 ГБ (правка 1088),
 *   1080p/10 с ≈ 10.2 ГБ — на 8 ГБ не работает ни с какими чанками.
 *
 * Веса не входят в прогноз: DynamicVRAM стримит их с диска и вытесняет под
 * давлением, поэтому бюджет активаций = VRAM − reserve − headroom − буфер
 * стриминга/каста. Сами коэффициенты — оценка, а не измерение; при
 * расхождении с логом VRAMReset правится здесь.
 */
import {
  autoChunkFFChunks,
  autoHeadChunks,
  boundedTokenChunk,
  framesForDuration,
  h3TransientGB,
  h3WindowGeometry,
} from './minimax-h3-template'

const HIDDEN = 5376
const INNER = 56 * 128
const GIB = 1024 ** 3

/** Буферы стриминга весов, cast/prefetch DynamicVRAM и прочая служебная VRAM. */
const STREAM_OVERHEAD_GB = 1.0
/** x + промежуточный norm/mod + residual: не меньше двух копий [S, hidden]. */
const RESID_FACTOR = 2.0
/** Рабочая область SDPA/ядер attention и мелкие временные. */
const ATTN_WORKSPACE_GB = 0.5
/** Минимальный бюджет: ниже него не имеет смысла считать — всё равно не влезет. */
const MIN_BUDGET_GB = 2.5
/** Запас на неточность оценки: 2% бюджета. На 12 ГБ это ~0.2 ГБ — ровно та
 *  разница, при которой «влезает по расчёту» ещё не значит «влезает на деле». */
const FIT_RATIO = 0.98
/** Окна короче 2 с H3 почти не держит (меньше 56 кадров — вне обучения). */
const MIN_WINDOW_SECONDS = 2
/** Длиннее 8 с окно перестаёт экономить: на 8–12 ГБ пик уже за бюджетом. */
const MAX_WINDOW_SECONDS = 8

export interface H3PeakEstimate {
  seq: number
  kvGb: number
  residGb: number
  attnProjectionGb: number
  outProjGb: number
  ffnGb: number
  peakGb: number
}

export interface H3WindowChoice {
  seconds: number
  length: number
  overlap: number
}

export interface H3VramPlan {
  /** Полная VRAM карты; null — не определилась (считаем как 8 ГБ). */
  vramGb: number | null
  /** Сколько остаётся под активации: VRAM − reserve − headroom − стриминг. */
  budgetGb: number
  /** Кадров в клипе (сетка 17n+5). */
  frames: number
  /** Прогноз пика одним проходом, без окон. */
  full: H3PeakEstimate
  /** Окно, если одного прохода не хватает; null — окна не нужны. */
  window: H3WindowChoice | null
  /** Пик внутри окна (или full.peakGb, если окна нет). */
  peakGb: number
  headChunks: number
  tokenChunk: number
  ffChunks: number
  /** Человекочитаемые причины/предупреждения для лога и UI. */
  notes: string[]
  /** true — даже минимальное окно не влезает: нужен тайловый маршрут. */
  overBudget: boolean
}

function seqFor(width: number, height: number, frames: number): number {
  return h3TransientGB(width, height, frames).seq
}

/** Пик активаций pass 2 для последовательности из `seq` токенов. */
function estimatePeak(
  seq: number,
  bounded: boolean,
  tokenChunk: number,
  ffChunks: number,
): H3PeakEstimate {
  const kvGb = (2 * seq * INNER * 2) / GIB
  const residGb = (seq * HIDDEN * 2 * RESID_FACTOR) / GIB
  // Без bounded материализуется весь QKV [S, 3·inner]; с bounded — только Q-блок.
  const attnProjectionGb = bounded
    ? (tokenChunk * 3 * INNER * 2) / GIB
    : (seq * 3 * INNER * 2) / GIB
  // mini-FFN SwiGLU: [S, 2·ffn] fp16, порезанный на чанки.
  const ffnRawGb = (seq * 2 * 14336 * 2) / GIB
  const ffnGb = ffnRawGb / Math.max(1, ffChunks)
  // bounded пишет out_proj сразу в [S, inner] — буфер нужен в обоих режимах.
  const outProjGb = (seq * INNER * 2) / GIB
  return {
    seq,
    kvGb,
    residGb,
    attnProjectionGb,
    outProjGb,
    ffnGb,
    peakGb: kvGb + residGb + attnProjectionGb + outProjGb + ffnGb + ATTN_WORKSPACE_GB,
  }
}

export interface H3VramPlanInput {
  width: number
  height: number
  seconds: number
  vramGb: number | null
  reserveGb?: number
  headroomGb?: number
  /** Bounded attention уже решён роутом (resolveBoundedAttention). */
  bounded: boolean
  /** Ручные значения из настроек; 0/undefined — авто. */
  headChunks?: number
  tokenChunk?: number
  ffChunks?: number
  /** false — не предлагать временные окна (настройка пользователя). */
  autoWindow?: boolean
}

/**
 * Считает бюджет и подбирает окно. Ничего не мутирует и не знает про ComfyUI —
 * роут применяет результат к параметрам шаблона.
 */
export function planH3Vram(input: H3VramPlanInput): H3VramPlan {
  const notes: string[] = []
  const vramGb = typeof input.vramGb === 'number' && input.vramGb > 0 ? input.vramGb : null
  const effectiveVram = vramGb ?? 8
  if (vramGb === null) notes.push('VRAM карты не определилась — считаем бюджет как для 8 ГБ')

  const reserveGb = Math.max(0, Number(input.reserveGb) || 0)
  const headroomGb = Math.max(0, Number(input.headroomGb) || 0)
  const budgetGb = Math.max(MIN_BUDGET_GB, effectiveVram - reserveGb - headroomGb - STREAM_OVERHEAD_GB)

  const frames = framesForDuration(Math.max(1, Number(input.seconds) || 5))
  const fullSeq = seqFor(input.width, input.height, frames)

  // Размеры кусков — те же функции, что использует шаблон (один источник истины).
  let tokenChunk = boundedTokenChunk(vramGb, fullSeq, input.tokenChunk)
  let ffChunks = autoChunkFFChunks(
    (fullSeq * 2 * 14336 * 2) / GIB,
    input.ffChunks,
    vramGb,
  )
  // Шаблон при bounded attention поднимает чанки FFN минимум до 8 — без этого
  // его пик (4.5 ГБ на 1080p/5 с) съел бы выигрыш. Для прогноза берём то же.
  const ffForPeak = input.bounded ? Math.max(8, ffChunks) : ffChunks
  const pickHead = (seq: number) => (input.headChunks && input.headChunks > 0
    ? Math.max(1, Math.min(56, Math.round(input.headChunks)))
    : autoHeadChunks(vramGb, seq))
  let headChunks = pickHead(fullSeq)
  const full = estimatePeak(fullSeq, input.bounded, tokenChunk, ffForPeak)
  // В лог и в ответ — фактическое число чанков шаблона (с полом 8 при bounded).
  if (input.bounded) ffChunks = ffForPeak

  let window: H3WindowChoice | null = null
  let peakGb = full.peakGb
  let overBudget = false
  // «Влезает» — с запасом FIT_RATIO: оценка не измерение, на границе бюджета
  // лучше лишнее окно, чем OOM через пять минут.
  const fits = (peak: number) => peak <= budgetGb * FIT_RATIO
  const safeBudgetGb = budgetGb * FIT_RATIO

  if (!fits(full.peakGb) && input.autoWindow !== false) {
    // Идём от длинного окна к короткому: длинное = меньше швов и меньше
    // повторной работы (нахлёст ~31.5% окна).
    const maxSeconds = Math.min(MAX_WINDOW_SECONDS, Math.ceil(input.seconds))
    for (let sec = maxSeconds; sec >= MIN_WINDOW_SECONDS; sec--) {
      const geo = h3WindowGeometry(sec)
      if (geo.context_length >= frames) continue
      const seq = seqFor(input.width, input.height, geo.context_length)
      const chunk = boundedTokenChunk(vramGb, seq, input.tokenChunk)
      const chunks = autoChunkFFChunks((seq * 2 * 14336 * 2) / GIB, input.ffChunks, vramGb)
      const est = estimatePeak(seq, input.bounded, chunk, input.bounded ? Math.max(8, chunks) : chunks)
      if (fits(est.peakGb)) {
        window = { seconds: sec, length: geo.context_length, overlap: geo.context_overlap }
        peakGb = est.peakGb
        // В лог и в ответ отдаём те размеры, с которыми реально пойдёт шаблон:
        // он считает их по окну, а не по всей длине клипа.
        tokenChunk = chunk
        ffChunks = input.bounded ? Math.max(8, chunks) : chunks
        headChunks = pickHead(seq)
        break
      }
    }
    if (!window) {
      // Даже минимальное окно не влезает. Ставим его всё равно: с ним шанс
      // есть (оценка пессимистична), без него — гарантированный OOM.
      const geo = h3WindowGeometry(MIN_WINDOW_SECONDS)
      if (geo.context_length < frames) {
        window = { seconds: MIN_WINDOW_SECONDS, length: geo.context_length, overlap: geo.context_overlap }
        const seq = seqFor(input.width, input.height, geo.context_length)
        const chunk = boundedTokenChunk(vramGb, seq, input.tokenChunk)
        const chunks = autoChunkFFChunks((seq * 2 * 14336 * 2) / GIB, input.ffChunks, vramGb)
        const est = estimatePeak(seq, input.bounded, chunk, input.bounded ? Math.max(8, chunks) : chunks)
        peakGb = est.peakGb
        tokenChunk = chunk
        ffChunks = input.bounded ? Math.max(8, chunks) : chunks
        headChunks = pickHead(seq)
        overBudget = !fits(est.peakGb)
        notes.push(
          `даже окно ${geo.context_length} кадров (${MIN_WINDOW_SECONDS} с) не влезает: прогноз ` +
          `${est.peakGb.toFixed(1)} ГБ при безопасном бюджете ${safeBudgetGb.toFixed(1)} ГБ — ` +
          'уменьшите разрешение или идите через Tile Upscale',
        )
      } else {
        overBudget = true
        notes.push(
          `клип не влезает в безопасный бюджет ${safeBudgetGb.toFixed(1)} ГБ, а окна короче клипа ` +
          'не строятся — уменьшите разрешение или идите через Tile Upscale',
        )
      }
    } else {
      notes.push(
        `клип не влезает одним проходом: прогноз ${full.peakGb.toFixed(1)} ГБ при безопасном ` +
        `бюджете ${safeBudgetGb.toFixed(1)} ГБ — временные окна ${window.length} кадров ` +
        `(${window.seconds} с, нахлёст ${window.overlap}), прогноз ${peakGb.toFixed(1)} ГБ`,
      )
    }
  } else if (!fits(full.peakGb)) {
    overBudget = true
    notes.push(
      `прогноз ${full.peakGb.toFixed(1)} ГБ выше бюджета ${budgetGb.toFixed(1)} ГБ, ` +
      'а авто-окна выключены — возможен OOM',
    )
  }

  return {
    vramGb,
    budgetGb,
    frames,
    full,
    window,
    peakGb,
    headChunks,
    tokenChunk,
    ffChunks,
    notes,
    overBudget,
  }
}

/** Короткая строка для лога ComfyUI-стадии: «план 5.8/6.0 ГБ, окна 124». */
export function formatH3VramPlan(plan: H3VramPlan): string {
  const head = `[vram-plan] ${plan.frames} кадров, прогноз ${plan.peakGb.toFixed(1)} из ` +
    `${plan.budgetGb.toFixed(1)} ГБ бюджета`
  const win = plan.window
    ? `, окна ${plan.window.length}/${plan.window.overlap} (${plan.window.seconds} с)`
    : ''
  const knobs = `, head_chunks ${plan.headChunks}, token_chunk ${plan.tokenChunk}, ff ${plan.ffChunks}`
  return head + win + knobs + (plan.notes.length ? `; ${plan.notes.join('; ')}` : '')
}
