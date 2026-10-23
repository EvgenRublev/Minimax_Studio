/**
 * Token estimation & context trimming for the assistant chat — (правка 169).
 *
 * Требования к длинным чатам:
 *   1) системный промпт присутствует ВСЕГДА (H3-спек, рефы, правила) —
 *      он не считается «историей» и не участвует в обрезке;
 *   2) режется ТОЛЬКО начало истории: модель всегда видит то, что
 *      обсуждали в конце (самый длинный влезающий хвост);
 *   3) последнее сообщение не трогаем никогда — к нему сервер прикрепил
 *      референсы и вложения текущего хода;
 *   4) если даже [system + последнее сообщение] не влезает — деградируем
 *      медиа (прореживаем кадры видео), а не шлём заведомый оверфлоу.
 *
 * Медиа живёт только на последнем user-сообщении (рефы и вложения чата
 * прикрепляются к текущему ходу при КАЖДОМ запросе заново), поэтому
 * обрезка истории с начала не может «молча потерять» приложенные
 * референсы — на следующем ходу они снова окажутся в хвосте.
 */

/**
 * Rough token estimate, char-class aware (правка 258).
 *
 * Прежняя плоская оценка 0.4 токена/символ занижала РУССКИЙ текст: у
 * Qwen/Bonsai-токенизаторов кириллица стоит ~0.5–0.7 токена на символ.
 * В длинных русских чатах бюджет обрезки врал в 1.5 раза — реальные токены
 * переваливали окно, сервер молча резал историю (а с ней и смысл) — отсюда
 * «ассистент глючит после 4–5 промптов». Кириллица считается по 0.65
 * (консервативно), остальное (латиница/цифры/пунктуация) — по 0.3.
 */
export function estimateTokens(text: string): number {
  let cyr = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c >= 0x0400 && c <= 0x04ff) cyr++
  }
  return Math.ceil(cyr * 0.65 + (text.length - cyr) * 0.3)
}

/** Обёртка chat-шаблона на сообщение (role-теги, спец-токены). Ранее не
 *  учитывалась: ~16 токенов × 60 сообщений ≈ 1000 «невидимых» токенов. */
export const TEMPLATE_TOKENS_PER_MSG = 16

/** Vision-токены на один кадр 512px (standard backend — целое видео). */
export const FRAME_TOKENS_512 = 768

/** Запас на суммарную ошибку эвристических оценок по всему промпту.
 *  (правка 258) поднят 192 → 320: оценка дешевле переполнения окна. */
export const TRIM_SAFETY_MARGIN = 320

/** (правка 258) Жёсткий потолок длины истории независимо от бюджета:
 *  страховка от сюрпризов chat-шаблонов на ОЧЕНЬ длинных чатах. */
export const MAX_HISTORY_MESSAGES = 60

export interface TrimMessage {
  role: string
  content: string | unknown[]
  images?: string[]
}

/** Estimate tokens for a message content (string or multimodal array). */
export function estimateMessageTokens(content: string | unknown[]): number {
  if (typeof content === 'string') return estimateTokens(content)
  if (Array.isArray(content)) {
    let tokens = 0
    for (const part of content) {
      if (typeof part === 'string') {
        tokens += estimateTokens(part)
      } else if (part && typeof part === 'object') {
        const p = part as Record<string, unknown>
        if (p.type === 'image') {
          // A 512px JPEG ≈ ~256-512 tokens for Gemma vision. Use 384 as midpoint.
          tokens += 384
        } else if (p.type === 'audio') {
          // A 16 kHz WAV clip ≈ 80-150 tokens per second of audio.
          tokens += 256
        } else if (p.type === 'video') {
          if (Array.isArray(p.video_frames)) {
            // (правка 162) Bonsai: кадры 256px, до 48 шт. — 384/кадр консервативно.
            tokens += (p.video_frames as unknown[]).length * 384
          } else if (typeof p.est_frames === 'number') {
            // (правка 169) standard backend: длительность видео ограничена
            // бюджетом контекста ДО прикрепления (videoBudgetSec) — оценку
            // считаем по фактическому лимиту кадров, а не «плоскими» 15К.
            tokens += (p.est_frames as number) * FRAME_TOKENS_512
          } else {
            tokens += 15_000
          }
        } else if (p.type === 'text' && typeof p.text === 'string') {
          tokens += estimateTokens(p.text)
        }
      }
    }
    return tokens
  }
  return 0
}

/** Полная стоимость сообщения: контент + обёртка chat-шаблона. */
export function messageTokens(m: { content: string | unknown[] }): number {
  return estimateMessageTokens(m.content) + TEMPLATE_TOKENS_PER_MSG
}

/**
 * (правка 169) Суффиксная обрезка: [system] + самый длинный хвост истории,
 * влезающий в бюджет (ctx − запас ответа − safety). Свойства:
 *   • системный промпт (индекс 0) сохраняется всегда;
 *   • режем только с начала; последнее сообщение сохраняется всегда —
 *     даже если оно одно не влезает (медиа), дальше работает
 *     degradeMediaToBudget, а не тихая потеря текущего хода;
 *   • хвост выравнивается по user-сообщению (шаблон ждёт user после system,
 *     иначе часть шаблонов рендерит «ответ без вопроса»);
 *   • если что-то отрезано — в первое оставленное сообщение добавляется
 *     заметка-маркер: модель понимает, почему история начинается резко.
 */
export function trimToContext(
  messages: TrimMessage[],
  ctxSize: number,
  outputReserve: number,
): TrimMessage[] {
  const budget = ctxSize - outputReserve - TRIM_SAFETY_MARGIN
  // (правка 717) Раньше при budget <= 0 (или messages.length <= 2) функция
  // возвращала messages КАК ЕСТЬ — и огромный последний запрос уходил в
  // модель целиком, переполняя окно. Теперь в вырожденном случае режем
  // ТЕКСТ последнего сообщения (медиа трогать нельзя — оно крепится заново
  // каждый ход) и честно сообщаем об усечении.
  if (budget <= 0) return truncateLastMessageText(messages)
  if (messages.length <= 2) {
    const sysTokens = messageTokens(messages[0])
    if (sysTokens + messageTokens(messages[1] ?? { content: '' }) <= budget) return messages
    return truncateLastMessageText(messages)
  }

  const sys = messages[0]
  // (правка 258) жёсткий потолок длины истории (страховка от шаблонных
  // сюрпризов на очень длинных чатах) — до бюджетной обрезки.
  const rest = messages.length - 1 > MAX_HISTORY_MESSAGES
    ? messages.slice(messages.length - MAX_HISTORY_MESSAGES)
    : messages.slice(1)
  const wasCapped = messages.length - 1 > MAX_HISTORY_MESSAGES
  const sysTokens = messageTokens(sys)

  // Суффиксные суммы: suf[i] — суммарные токены хвоста rest[i..].
  const suf = new Array<number>(rest.length + 1).fill(0)
  for (let i = rest.length - 1; i >= 0; i--) suf[i] = suf[i + 1] + messageTokens(rest[i])

  if (!wasCapped && sysTokens + suf[0] <= budget) return messages // всё влезает — не трогаем

  // Самый длинный влезающий хвост (последнее сообщение не режем никогда).
  let start = 0
  while (start < rest.length - 1 && sysTokens + suf[start] > budget) start++
  while (start < rest.length - 1 && rest[start].role === 'assistant') start++

  const kept = rest.slice(start)
  if (!wasCapped && (start === 0 || kept.length === 0)) return [sys, ...kept]
  return [sys, withTrimNotice(kept[0]), ...kept.slice(1)]
}

/**
 * (правка 717) Аварийное усечение: обрезаем ТЕКСТ последнего сообщения,
 * чтобы хоть что-то влезло в окно. Медиа-части не трогаем (картинки/видео
 * перекрепляются каждый ход заново), но в текст добавляем явную пометку,
 * чтобы модель знала, что ввод обрезан.
 */
function truncateLastMessageText(messages: TrimMessage[]): TrimMessage[] {
  if (messages.length === 0) return messages
  const out = messages.slice()
  const last = out[out.length - 1]
  const notice = '[Ввод обрезан: не поместился в контекст модели.]'
  if (typeof last.content === 'string') {
    const maxChars = 20_000
    const text = last.content.length > maxChars ? last.content.slice(0, maxChars) : last.content
    out[out.length - 1] = { ...last, content: `${notice}\n${text}` }
    return out
  }
  if (Array.isArray(last.content)) {
    const parts = [...(last.content as Array<Record<string, unknown>>)]
    const idx = parts.findIndex((p) => p && p.type === 'text' && typeof p.text === 'string')
    if (idx >= 0) {
      const text = String(parts[idx].text)
      parts[idx] = {
        ...parts[idx],
        text: `${notice}\n${text.length > 20_000 ? text.slice(0, 20_000) : text}`,
      }
    } else {
      parts.unshift({ type: 'text', text: notice })
    }
    out[out.length - 1] = { ...last, content: parts }
  }
  return out
}

/** (правка 169) Заметка об обрезке в первое оставленное сообщение. */
function withTrimNotice<T extends { content: string | unknown[] }>(msg: T): T {
  const notice =
    '[Заметка: более ранние сообщения этого чата не поместились в контекст и были обрезаны. Опирайся на последние сообщения и текущие прикреплённые референсы.]'
  if (typeof msg.content === 'string') {
    return { ...msg, content: `${notice}\n\n${msg.content}` }
  }
  if (Array.isArray(msg.content)) {
    const parts = [...(msg.content as Array<Record<string, unknown>>)]
    const firstText = parts.findIndex((p) => p && p.type === 'text' && typeof p.text === 'string')
    if (firstText >= 0) {
      parts[firstText] = { ...parts[firstText], text: `${notice}\n\n${parts[firstText].text}` }
    } else {
      parts.unshift({ type: 'text', text: notice })
    }
    return { ...msg, content: parts }
  }
  return msg
}

/**
 * (правка 169) Последний рубеж: [system + последнее сообщение] само по себе
 * не влезает в окно. Равномерно прореживаем кадры видео (Bonsai
 * video_frames), пока промп не влезет; картинки и целые видео не трогаем
 * (их лимиты считаются ДО прикрепления — videoBudgetSec). Ниже 4 кадров не
 * режем — движение станет нечитаемым; дальше решает бэкенд (standard:
 * context shift с n_keep, system уцелеет; Bonsai: честная ошибка).
 */
export function degradeMediaToBudget(
  messages: TrimMessage[],
  ctxSize: number,
  outputReserve: number,
): TrimMessage[] {
  const budget = ctxSize - outputReserve - TRIM_SAFETY_MARGIN
  if (budget <= 0 || messages.length === 0) return messages

  const work = messages.map((m) => ({ ...m }))
  const total = () => work.reduce((sum, m) => sum + messageTokens(m), 0)
  if (total() <= budget) return work

  const last = work[work.length - 1]
  if (!Array.isArray(last.content)) return work
  const parts = [...(last.content as Array<Record<string, unknown>>)]

  for (;;) {
    if (total() <= budget) break
    let best = -1
    let bestN = 0
    parts.forEach((p, i) => {
      const n = p && Array.isArray(p.video_frames) ? (p.video_frames as unknown[]).length : 0
      if (n > bestN) {
        best = i
        bestN = n
      }
    })
    if (best < 0 || bestN <= 4) break
    const frames = parts[best].video_frames as string[]
    // Равномерно: каждый второй кадр + гарантированно последний.
    parts[best] = {
      ...parts[best],
      video_frames: frames.filter((_, i) => i % 2 === 0 || i === frames.length - 1),
    }
    work[work.length - 1] = { ...last, content: parts }
  }
  return work
}

/**
 * (правка 169) Сколько секунд одного видео можно отдать под vision
 * (standard backend, целое видео): кадр 512px ≈ FRAME_TOKENS_512, 8 fps.
 * 60-секундный реф на 8 fps — ~480 кадров ≈ сотни тысяч vision-токенов;
 * прежняя «плоская» оценка в 15К приводила к реальному переполнению.
 * Свободное место делится поровну между видео-референсами хода.
 */
export function videoBudgetSec(
  messages: TrimMessage[],
  videoCount: number,
  ctxSize: number,
  outputReserve: number,
): number {
  if (videoCount <= 0) return 2
  const used = messages.reduce((sum, m) => sum + messageTokens(m), 0)
  const free = ctxSize - outputReserve - TRIM_SAFETY_MARGIN - used
  const frames = Math.floor(Math.max(0, free) / videoCount / FRAME_TOKENS_512)
  return Math.max(2, Math.min(60, Math.floor(frames / 8)))
}
