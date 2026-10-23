/**
 * (правка 136 / Bonsai) Адаптер протокола для Ternary Bonsai 2 27B.
 *
 * Bonsai-бэкенд — это prism llama-server с OpenAI-совместимым API
 * (/v1/chat/completions, stream:true), а вся остальная студия говорит на
 * протоколе tools/llm_server.py:
 *   запрос:  messages с медиа-частями {type:'image', image:'/abs/path.jpg'}
 *   ответ:   SSE `data: {"delta":"..."}\n\n` (+ {"done":true} в конце)
 *
 * Этот модуль bridg'ит оба направления:
 *  • toOpenAiMessages() — внутренние messages → OpenAI (картинки читаются
 *    с диска и уходят как data:image/...;base64 URI);
 *  • openAiSseToDelta() — OpenAI SSE → наш SSE-формат, чтобы ФРОНТЕНД
 *    (assistant-stream.ts) не менялся вовсе. reasoning_content (если вдруг
 *    появится несмотря на --reasoning-budget 0) отбрасывается.
 *
 * ВИДЕО: llama-server форка целые видео не принимает (наш python-сервер
 * умеет это через патч mtmd) — на Bonsai-бэкенде видео-кадры извлекаются
 * ffmpeg'ом в отдельные JPEG и уходят как image_url (правка 162).
 */
import { readFileSync } from 'fs'

/* ──────────────────── Запрос: messages → OpenAI ──────────────────── */

interface InternalPart {
  type?: string
  text?: string
  image?: string
  video?: string
  /** (правка 162) Массив путей к JPEG-кадрам, извлечённым из видео. */
  video_frames?: string[]
}

export interface InternalMessage {
  role: string
  /** Как и во всём роуте чата: строка ИЛИ массив частей (типизация слабая —
   * сужаем по полю type при обходе, как это делает estimateMessageTokens). */
  content: string | unknown[]
}

export type OpenAiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface OpenAiMessage {
  role: string
  content: string | Array<OpenAiContentPart>
}

function imageToDataUri(absPath: string): string | null {
  try {
    const buf = readFileSync(absPath)
    const mime = /\.png$/i.test(absPath) ? 'image/png' : 'image/jpeg'
    return `data:${mime};base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}

/**
 * Конвертация внутренних messages в OpenAI-формат. Каждая {type:'image'}
 * часть читается с диска и становится image_url data-URI; {type:'video'}
 * заменяется текстовой заметкой (модель не должна описывать то, чего
 * не видит). Текстовые части проходят как есть, в исходном порядке.
 */
export async function toOpenAiMessages(
  messages: Array<InternalMessage>,
): Promise<OpenAiMessage[]> {
  const out: OpenAiMessage[] = []
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content })
      continue
    }
    if (!Array.isArray(m.content)) {
      out.push({ role: m.role, content: '' })
      continue
    }
    const parts: OpenAiContentPart[] = []
    for (const raw of m.content as unknown[]) {
      const p = raw as InternalPart
      if (p && p.type === 'text' && typeof p.text === 'string') {
        parts.push({ type: 'text', text: p.text })
      } else if (p && p.type === 'image' && typeof p.image === 'string') {
        const uri = imageToDataUri(p.image)
        if (uri) {
          parts.push({ type: 'image_url', image_url: { url: uri } })
        } else {
          parts.push({
            type: 'text',
            text: '(an image reference could not be attached — do NOT describe or invent its content)',
          })
        }
      } else if (p && p.type === 'video') {
        // (правка 162) Видео-кадры, извлечённые ffmpeg'ом — отправляем как картинки.
        if (Array.isArray(p.video_frames) && p.video_frames.length > 0) {
          for (const framePath of p.video_frames) {
            const uri = imageToDataUri(framePath)
            if (uri) {
              parts.push({ type: 'image_url', image_url: { url: uri } })
            }
          }
          if (parts.length === 0 || parts[parts.length - 1].type !== 'image_url') {
            parts.push({
              type: 'text',
              text: '(video frames could not be attached — do NOT describe or invent its content)',
            })
          }
        } else {
          // Кадры не извлечены — честная заметка.
          parts.push({
            type: 'text',
            text: '(a video reference exists, but its frames are NOT attached to this assistant — reference it as a tag only and do NOT describe, guess or invent its content)',
          })
        }
      }
    }
    out.push({
      role: m.role,
      content: parts.length === 1 && parts[0].type === 'text'
        ? (parts[0] as { type: 'text'; text: string }).text
        : parts,
    })
  }
  return out
}

/* ──────────────────── Ответ: OpenAI SSE → наш SSE ──────────────────── */

/**
 * Оборачивает тело OpenAI-стрима (data: {"choices":[{"delta":{"content"}}]}
 * ... data: [DONE]) в наш формат (data: {"delta":"..."} / {"done":true}).
 * Фронтенд assistant-stream.ts остаётся нетронутым.
 */
export function openAiSseToDelta(
  body: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buf = ''
  let sentDone = false

  // JSON.stringify экранирует переводы строк внутри строк сам —
  // фрейминг SSE (разделитель \n\n) не ломается.
  const emit = (
    controller: TransformStreamDefaultController<Uint8Array>,
    obj: Record<string, unknown>,
  ) => {
    if (sentDone && obj.done) return // один done на стрим: [DONE] ИЛИ flush
    if (obj.done) sentDone = true
    controller.enqueue(
      encoder.encode(`data: ${JSON.stringify(obj)}\n\n`),
    )
  }

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buf += decoder.decode(chunk, { stream: true })
        const events = buf.split('\n\n')
        buf = events.pop() ?? ''
        for (const ev of events) {
          for (const line of ev.split('\n')) {
            if (!line.startsWith('data: ')) continue
            const payload = line.slice(6)
            if (payload === '[DONE]') {
              emit(controller, { done: true })
              continue
            }
            let parsed: {
              choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }>
              error?: { message?: string } | string
            }
            try {
              parsed = JSON.parse(payload)
            } catch {
              continue // битый/недокачанный чанк — ждём следующего
            }
            if (parsed.error) {
              const msg = typeof parsed.error === 'string'
                ? parsed.error
                : parsed.error.message || 'LLM error'
              emit(controller, { error: msg, done: true })
              continue
            }
            const delta = parsed.choices?.[0]?.delta
            // reasoning_content отбрасываем: с --reasoning-budget 0 его
            // быть не должно, но форк может прислать пустые куски.
            if (typeof delta?.content === 'string' && delta.content.length > 0) {
              emit(controller, { delta: delta.content })
            }
          }
        }
      },
      flush(controller) {
        // Стрим оборвался без [DONE] — закрываем наш протокол честно.
        emit(controller, { done: true })
      },
    }),
  )
}
