/**
 * (правка 824) Чистый потребитель SSE-потока ассистента (уровень B плана
 * отладки: docs/assistant-debug-plan.md).
 *
 * До правки 824 цикл чтения жил внутри runAssistantCompletion в
 * assistant-stream.ts и зависел от zustand/sonner/сторов — его нельзя было
 * проверить без React. Теперь это чистая функция: без сторов, тостов и
 * таймеров (idle-watchdog остаётся вызывающему — через onActivity).
 * Покрыта харнессом scratchpad/assistant-sse-check.mjs.
 *
 * Протокол /api/llm/chat (правка 717): события разделены пустой строкой,
 * данные — в строке `data: {...}`. Финальный кадр несёт finish_reason и
 * флаг aborted. Битый/неполный JSON-чанк пропускается (ждём следующий).
 */

/** Кадр SSE от /api/llm/chat. */
export interface SseFrame {
  delta?: string
  error?: string
  done?: boolean
  aborted?: boolean
  finish_reason?: string | null
}

/** Накапливаемое состояние стрима. Мутируется consumeSse; читается и при
 *  успешном завершении, и при throw (обрывок нужен в catch/finally). */
export interface SseState {
  /** Весь текст дельт, накопленный на данный момент. */
  text: string
  /** Финальный кадр с finish_reason='length' — ответ упёрся в max_tokens. */
  truncatedByLimit: boolean
}

export interface SseOptions {
  /** Пришёл чанк байтов — вызвать для переброса idle-watchdog. */
  onActivity?: () => void
  /** Всё ещё НАШ живой стрим? (runId-гейт: после «Стоп»+новый запрос
   *  старый цикл не должен обновлять UI нового стрима.) Накопление текста
   *  при этом продолжается — обрывок нужен для коммита в чат. */
  isCurrent?: () => boolean
  /** Каждая дельта: полный накопленный текст + флаг «это живой стрим». */
  onText?: (fullText: string, live: boolean) => void
}

/**
 * Читать поток до конца. Бросает Error на кадрах error/aborted
 * (как и раньше); частично накопленный текст остаётся в state.
 */
export async function consumeSse(
  stream: ReadableStream<Uint8Array>,
  state: SseState,
  opts: SseOptions = {},
): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      opts.onActivity?.()
      buf += decoder.decode(value, { stream: true })
      const events = buf.split('\n\n')
      buf = events.pop() ?? ''
      for (const ev of events) {
        const line = ev.split('\n').find((l) => l.startsWith('data: '))
        if (!line) continue
        // JSON.parse — в отдельном try: раньше фильтр «не JSON в сообщении»
        // глотал payload.error, если текст ошибки упоминал JSON.
        let payload: SseFrame | null = null
        try {
          payload = JSON.parse(line.slice(6)) as SseFrame
        } catch {
          continue // битый/незавершённый чанк — ждём следующий
        }
        if (!payload) continue
        if (payload.error) throw new Error(payload.error)
        if (payload.aborted) {
          throw new Error('Ответ прерван (остановлен пользователем или сбой сервера).')
        }
        if (payload.done && payload.finish_reason === 'length') {
          // Ответ упёрся в max_tokens — не «ошибка», но и не полный промпт.
          state.truncatedByLimit = true
        }
        if (payload.delta) {
          state.text += payload.delta
          const live = opts.isCurrent ? opts.isCurrent() : true
          opts.onText?.(state.text, live)
        }
      }
    }
  } finally {
    // Чтение прервали (abort/ошибка) — освобождаем ридер, как и раньше.
    reader.cancel().catch(() => {})
  }
}
