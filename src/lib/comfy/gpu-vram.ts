/**
 * (правка 1076) Сколько видеопамяти у GPU. Нужен для того, чтобы отказать в
 * режиме, который заведомо не влезет (Refine до 2.3 Мп на 12 ГБ стоит минутами
 * и в итоге падает с OOM), а не гонять задачу до зависания.
 *
 * Первый источник — сам ComfyUI (/system_stats → vram_total, байты): это та же
 * цифра, которую видит планировщик памяти ядра. Если ComfyUI не отвечает —
 * берём nvidia-smi. Значение кэшируется на 10 минут: оно не меняется, а
 * /system_stats во время генерации отвечает медленно (правка 54).
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { COMFY_URL } from './minimax-h3-client'

const execFileAsync = promisify(execFile)

const TTL_MS = 10 * 60_000
const NULL_TTL_MS = 60_000
let cache: { gb: number; at: number } | null = null
let nullUntil = 0

/**
 * (правка 1131) Ручной объём VRAM для тестов на «слабой карте»: vram-hog.bat
 * держит часть памяти процессом, но vram_total остаётся прежним, и авто-ветки
 * (bounded attention, окна, бюджет) не включаются. `MINIMAX_VRAM_GB=8` перед
 * запуском студии заставляет все решения считать карту 8-гигабайтной.
 */
export function gpuVramOverrideGb(): number | null {
  const n = parseFloat(process.env.MINIMAX_VRAM_GB || '')
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * Всего VRAM, ГБ; null — определить не удалось (AMD/CPU-only и т. п.).
 * Отрицательный результат тоже кэшируется, но ненадолго: иначе на машине без
 * nvidia-smi каждая отправка задачи ждала бы оба таймаута.
 */
export async function gpuVramTotalGb(): Promise<number | null> {
  // (правка 1131) Тестовый override — до кэша и опроса, чтобы менять его без
  // перезапуска студии.
  const override = gpuVramOverrideGb()
  if (override !== null) return override
  if (cache && Date.now() - cache.at < TTL_MS) return cache.gb
  if (Date.now() < nullUntil) return null
  const gb = (await fromComfy()) ?? (await fromNvidiaSmi())
  if (gb === null) {
    nullUntil = Date.now() + NULL_TTL_MS
    return null
  }
  cache = { gb, at: Date.now() }
  return gb
}

/**
 * (правка 1089) Пользовательская настройка bounded attention из карточки
 * «Оптимизация VRAM и генерации»: auto = прежнее авторешение по VRAM.
 */
export type BoundedAttentionMode = 'auto' | 'on' | 'off'

/**
 * (правка 1092) Порог канвы, выше которого bounded attention включается
 * автоматически: QKV-буфер растёт квадратно по числу токенов, а токенов —
 * линейно по мегапикселям канвы. 1.5 Мп (≈ пресет 720p/21:9-1080) — это
 * ~55k токенов за 5 с: буфер ~2 ГБ, и на карте 12–16 ГБ с 19-ГБ DiT в
 * резиденте уже тесно.
 * (правка 1093) На картах от BOUNDED_ATTN_FREE_VRAM_GB этот порог не действует:
 * там QKV-буфер 1080p помещается и без поблочного attention, а блоки только
 * замедляют рендер. Для таких карт узел включается только вручную
 * («Bounded Attention → Вкл» или MINIMAX_BOUNDED_ATTN=1).
 */
export const BOUNDED_ATTN_MP = 1.5
/** (правка 1093) Карта не меньше этого объёма — авто-правило по канве не применяется. */
export const BOUNDED_ATTN_FREE_VRAM_GB = 16
/**
 * (правка 1095) Нижний порог последовательности для авто-включения на малых
 * картах. Поблочный attention платит временем (QKV-проекции считаются дважды,
 * attention-ядро запускается чаще), а экономия пропорциональна размеру QKV-буфера
 * (seq·3·inner·2 байт, inner = 7168). До этого порога буфер меньше ~0.85 ГБ и
 * узел только тормозит: бесплатные точные рычаги (head_chunks у
 * MiniMaxLowVRAMAttention и чанки MiniMaxChunkFeedForward) закрывают пик сами.
 * 20 000 токенов ≈ канва 0.4 Мп на 5 с (480p); 720p/5 с — уже ~37k, там узел нужен.
 */
export const BOUNDED_ATTN_MIN_SEQ_TOKENS = 20000

/**
 * (правка 1089) Итоговый признак «ставить ли MiniMaxStudioBoundedAttention в
 * цепочку модели». Единый для всех режимов (Генерация/Продление/ControlNet,
 * Refine, Tile Upscale, Face Refine), чтобы настройка работала одинаково
 * везде. Приоритеты (совпадают с правкой 1088 для env-оверрайда):
 *   1. MINIMAX_BOUNDED_ATTN=1/0 — ручной переопределитель для замеров,
 *      перебивает всё, включая Veda;
 *   2. Veda Sparse Attention — патчит attention своим override'ом и с
 *      поблочным Q не проверялась: bounded выключен при любом выборе;
 *   3. настройка пользователя on/off;
 *   4. auto — карты <12 ГБ (правкой 1088) или большая канва ≥ BOUNDED_ATTN_MP,
 *      но только если карта меньше BOUNDED_ATTN_FREE_VRAM_GB (правки 1092/1093);
 *      с правки 1095 на малых картах авто ещё требует, чтобы последовательность
 *      была достаточно длинной (BOUNDED_ATTN_MIN_SEQ_TOKENS) — иначе узел
 *      дороже, чем экономит, и память закрывают head_chunks + чанки FFN.
 * `vramGb` может быть null (не определилась) — тогда авто решает только канва.
 * `seqTokens` не передан (режимы, где длина неизвестна заранее) — прежнее
 * поведение: на картах <12 ГБ узел ставится всегда.
 */
export function resolveBoundedAttention(
  mode: BoundedAttentionMode | undefined,
  vramGb: number | null,
  opts?: { vedaAttention?: boolean; genMP?: number; seqTokens?: number },
): boolean {
  const env = process.env.MINIMAX_BOUNDED_ATTN
  if (env === '1') return true
  if (env === '0') return false
  if (opts?.vedaAttention === true) return false
  if (mode === 'on') return true
  if (mode === 'off') return false
  if (vramGb !== null && vramGb > 0 && vramGb < 12) {
    // (правка 1095) 480p/короткие клипы: поблочный attention не окупается.
    return opts?.seqTokens === undefined || opts.seqTokens >= BOUNDED_ATTN_MIN_SEQ_TOKENS
  }
  // (правка 1093) 16 ГБ и больше — canvas-порог не срабатывает, не тормозим 1080p.
  if (vramGb !== null && vramGb >= BOUNDED_ATTN_FREE_VRAM_GB) return false
  return (opts?.genMP ?? 0) >= BOUNDED_ATTN_MP
}

/** Нормализация поля из тела запроса: всё, кроме on/off, трактуем как auto. */
export function normalizeBoundedAttentionMode(v: unknown): BoundedAttentionMode {
  // (правка 1131) Дефолт 'auto', а не 'off': главный рычаг памяти на картах
  // 8–12 ГБ должен включаться сам. 'off' остаётся явным выбором пользователя,
  // а на 16 ГБ+ авто всё равно узел не ставит (см. resolveBoundedAttention).
  return v === 'on' || v === 'off' || v === 'auto' ? v : 'auto'
}

async function fromComfy(): Promise<number | null> {
  try {
    const r = await fetch(`${COMFY_URL}/system_stats`, { signal: AbortSignal.timeout(6000) })
    if (!r.ok) return null
    const j = await r.json()
    const total = j?.devices?.[0]?.vram_total
    return typeof total === 'number' && total > 0 ? total / 1024 ** 3 : null
  } catch {
    return null
  }
}

async function fromNvidiaSmi(): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      ['--query-gpu=memory.total', '--format=csv,noheader,nounits'],
      { timeout: 6000 },
    )
    const mb = parseInt((stdout.trim().split(/\r?\n/)[0] ?? ''), 10)
    return Number.isFinite(mb) && mb > 0 ? mb / 1024 : null
  } catch {
    return null
  }
}
