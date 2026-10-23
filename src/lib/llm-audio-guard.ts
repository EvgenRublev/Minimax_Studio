/**
 * LLM audio-reliability guard — «нормальная работа с аудио-рефами без Whisper».
 *
 * Проблема: маленькая локальная LLM нестабильна на «сыром» аудио. Часть
 * прогонов дегенерирует (зацикливание: артефакты thought-канала
 * `<|channel>thought\n<channel|>` × N или повтор одной фразы × N), часть —
 * «осмысленные», но взаимопротиворечивые ответы (конфабуляция, а не
 * реальное слушание).
 *
 * Что делаем (без установки ничего нового):
 *  1) STOP-ТОКЕНЫ — `LLM_STOP_TOKENS` передаются в каждый запрос: генерация
 *     физически обрывается, как только модель начинает вываливать
 *     thought-канал. Дегенерация больше не «доедает» max_tokens.
 *  2) ПРОБА С РЕТРАЕМ — если к сообщению приложено аудио, ПЕРЕД реальным
 *     ответом делаем короткий не-стриминговый прогон (~48 токенов) с
 *     возрастающей температурой. Первый НЕ-дегенеративный прогон побеждает —
 *     его температура используется в основном ответе (темп, на котором модель
 *     «слышит» стабильнее, в среднем выигрывает). Если все пробы дегенеративны
 *     — идём с исходной температурой (stop-токены всё равно срежут цикл).
 *  3) ЧЕСТНОСТЬ ПРОМПТА — формулировки «описывай ТОЛЬКО то, что реально
 *     слышно; если не уверен — скажи, ничего не выдумывай» (route.ts и
 *     assistant-stream.ts).
 *
 * Модуль ЧИСТОЙ (без импортов Next) — его можно тестировать напрямую:
 *   node src/lib/llm-audio-guard.selftest.ts  (или внешний скрипт).
 *
 * (правка 135) тип SamplingParams импортируется из ./llm-sampling
 * (тоже чистый модуль, без Next) — один источник правды для формы
 * сэмплинга: и основной ответ, и аудио-проба передают в llm_server
 * одинаковый набор top_p / top_k / min_p / presence_penalty /
 * frequency_penalty / repeat_penalty.
 */

import type { SamplingParams } from './llm-sampling'

/** Артефакты thought-канала шаблона чата, которыми дегенерирует модель. */
export const LLM_STOP_TOKENS = ['<|channel>', '<channel|>']

/**
 * Детектор дегенеративного ответа.
 *  • пустой/короткий (< 12 символов) — не ответ;
 *  • любой thought-канал (`<|channel` / `channel|>`) — артефакт шаблона;
 *  • зацикливание: одно и то же окно из 8/16/32 символов встречается ≥ 5 раз
 *    (покрывает «Yes, I'm on the train.» × N и подобные повторы).
 */
export function isDegenerateAnswer(text: string | undefined | null): boolean {
  const t = (text ?? '').trim()
  if (t.length < 12) return true
  if (/<\|channel|channel\|>/i.test(t)) return true
  if (t.length < 80) return false
  for (const len of [8, 16, 32]) {
    if (t.length < len * 5) continue
    const counts = new Map<string, number>()
    let degenerate = false
    for (let i = 0; i + len <= t.length; i++) {
      const block = t.slice(i, i + len)
      if (/^\s+$/.test(block)) continue
      const c = (counts.get(block) ?? 0) + 1
      counts.set(block, c)
      if (c >= 5) {
        degenerate = true
        break
      }
    }
    if (degenerate) return true
  }
  return false
}

export interface ProbeResult {
  /** Температура, которую надо использовать в основном (стриминговом) ответе. */
  temperature: number
  /** Сколько проб было сделано (1..3). */
  attempts: number
  /** Текст последней пробы (для отладки/логирования). */
  lastProbeText: string | null
  /** Человеческое описание исхода. */
  note: string
}

const PROBE_MAX_TOKENS = 48
const PROBE_TIMEOUT_MS = 90_000
/** Шаги температуры: base, base+0.1, base+0.2 (кап — 1.0). */
const PROBE_STEPS = [0, 0.1, 0.2]

/**
 * Пробный прогон LLM (не-стриминг, ~48 токенов) с ретраем по температуре.
 * Возвращает температуру первого не-дегенеративного прогона (или base,
 * если все пробы дегенеративны — тогда stop-токены спасают основной ответ).
 *
 * Не бросает исключений: любой сбой (сеть, таймаут, 5xx) — просто «идём
 * дальше с исходной температурой», ассистент не должен падать из-за пробы.
 */
export async function probeAudioAnswer(opts: {
  baseUrl: string
  messages: Array<{ role: string; content: unknown }>
  baseTemperature: number
  maxTokens?: number
  /** (правка 135) набор сэмплинга — передаётся в каждую пробу, как в основной ответ. */
  sampling?: SamplingParams
  fetchImpl?: typeof fetch
  log?: (msg: string) => void
}): Promise<ProbeResult> {
  const { baseUrl, messages, baseTemperature } = opts
  const log = opts.log ?? (() => {})
  const fetchImpl = opts.fetchImpl ?? fetch
  const sampling = opts.sampling
  const temps = PROBE_STEPS.map(
    (d) => Math.min(1.0, Math.round((baseTemperature + d) * 100) / 100),
  )

  let lastText: string | null = null
  for (let i = 0; i < temps.length; i++) {
    const temp = temps[i]
    try {
      const res = await fetchImpl(`${baseUrl}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages,
          max_tokens: opts.maxTokens ?? PROBE_MAX_TOKENS,
          // (правка 135) — та же форма сэмплинга, что и в основном ответе,
          // только температура меняется по шагам PROBE_STEPS.
          // (правка 421) temperature ПОСЛЕ spread: SamplingParams включает
          // своё temperature, и spread затирал шаговую temp — все пробы шли
          // на одной температуре, лестница PROBE_STEPS не работала.
          ...(sampling ?? {}),
          temperature: temp,
          stream: false,
          stop: LLM_STOP_TOKENS,
        }),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })
      if (!res.ok) {
        log(`probe temp=${temp}: HTTP ${res.status} — следующая проба`)
        continue
      }
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean
        text?: string
        error?: string
      } | null
      if (!data?.ok) {
        log(`probe temp=${temp}: ${data?.error ?? 'ответ без ok'} — следующая проба`)
        continue
      }
      const text = (data.text ?? '').trim()
      lastText = text
      if (!isDegenerateAnswer(text)) {
        log(`probe temp=${temp}: OK (${text.length} симв.)`)
        return {
          temperature: temp,
          attempts: i + 1,
          lastProbeText: text,
          note: `audio-probe passed (temp ${temp}, попытка ${i + 1})`,
        }
      }
      log(`probe temp=${temp}: ДЕГЕНЕРАЦИЯ (${text.length} симв.) — следующая проба`)
    } catch (e) {
      log(`probe temp=${temp}: ${e instanceof Error ? e.message : String(e)} — следующая проба`)
    }
  }
  return {
    temperature: baseTemperature,
    attempts: temps.length,
    lastProbeText: lastText,
    note: 'все аудио-пробы дегенеративны — идём с исходной температурой (stop-токены срежут цикл в основном ответе)',
  }
}
