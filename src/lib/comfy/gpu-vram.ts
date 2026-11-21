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
 * Всего VRAM, ГБ; null — определить не удалось (AMD/CPU-only и т. п.).
 * Отрицательный результат тоже кэшируется, но ненадолго: иначе на машине без
 * nvidia-smi каждая отправка задачи ждала бы оба таймаута.
 */
export async function gpuVramTotalGb(): Promise<number | null> {
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
