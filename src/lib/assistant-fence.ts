/**
 * Fence-логика ассистента (LLM-чат) — правка 34.
 *
 * Модель инструктирована (src/lib/h3-prompt-spec.ts) ВСЕГДА оборачивать
 * готовый структурированный промпт в fence ```text ... ```. UI опирается на
 * это: содержимое fence рендерится как карточка-«промпт» с копированием,
 * а кнопка «В промпт» вставляет именно его в редактор.
 *
 * Чистые функции (без React) — чтобы их можно было покрывать тестами
 * без DOM (scratchpad harness: fence-view-test.mjs) и чтобы единый
 * источник истины для fence-разбора использовали и вью, и тесты.
 */

export interface FenceParse {
  /** Текст ПЕРЕД fence (пояснение модели), обрезанный. */
  preamble: string
  /** Промпт ВНУТРИ fence, обрезанный. */
  prompt: string
  /** Текст ПОСЛЕ закрывающего fence, обрезанный (пусто при стриминге). */
  trailing: string
  /** true, если найден только ОТКРЫВАЮЩИЙ fence (стрим ещё идёт). */
  streaming: boolean
}

/** Официальные структурные поля H3 (первые поля FORMAT A и FORMAT B). */
const H3_FIELD_RE = /(subject_definitions|integrated_multimodal_description)\s*:/i

/**
 * Содержит ли текст настоящий маркер H3-поля.
 * Сам по себе fence ``` НЕ считается: в обычных ответах (Q&A, советы)
 * могут цитироваться фрагменты кода.
 */
export function hasH3Field(content: string): boolean {
  return !!content && H3_FIELD_RE.test(content)
}

/**
 * Разобрать ответ ассистента на preamble / fence-промпт / trailing.
 * Возвращает null, если fence нет вообще.
 *
 * - Полный fence (```text … ```) → prompt = содержимое, trailing = всё
 *   после закрывающего fence.
 * - Только открывающий fence (стриминг, закрывающий ещё не прилетел) →
 *   prompt = всё после открывающего fence, streaming = true.
 */
export function parseFence(raw: string): FenceParse | null {
  if (!raw) return null
  let m = raw.match(/```[a-zA-Z]*\s*\n?([\s\S]*?)\n?\s*```/)
  let streaming = false
  if (!m) {
    const open = raw.match(/```[a-zA-Z]*[ \t]*\n?([\s\S]*)$/)
    if (!open) return null
    m = open
    streaming = true
  }
  const idx = raw.indexOf(m[0])
  const preamble = raw.slice(0, idx).trim()
  const trailing = streaming ? '' : raw.slice(idx + m[0].length).trim()
  return { preamble, prompt: m[1].trim(), trailing, streaming }
}

/**
 * (правка 427) Разобрать ВСЕ fence-блоки сообщения (не только первый, как
 * parseFence): в extend-чатах модель выдаёт промпт КАЖДОГО клипа отдельным
 * fence с маркером `clip: N` — UI рисует карточку и кнопку вставки на
 * каждый. Порядок сегментов = порядок fence в тексте; текст между fence
 * попадает в preamble/trailing соседних сегментов. Незакрытый fence в конце
 * (стриминг) — последний сегмент с streaming=true.
 */
export function parseAllFences(raw: string): FenceParse[] {
  if (!raw) return []
  const out: FenceParse[] = []
  const re = /```[a-zA-Z]*\s*\n?([\s\S]*?)\n?\s*```/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    out.push({ preamble: raw.slice(last, m.index).trim(), prompt: m[1].trim(), trailing: '', streaming: false })
    last = m.index + m[0].length
  }
  const rest = raw.slice(last)
  // Незакрытый fence в конце — стриминг: важно проверять ДАЖЕ когда
  // завершённых fence не было вовсе (единственный fence ещё стримится).
  const open = rest.match(/```[a-zA-Z]*[ \t]*\n?([\s\S]*)$/)
  if (open && typeof open.index === 'number') {
    out.push({
      preamble: rest.slice(0, open.index).trim(),
      prompt: open[1].trim(),
      trailing: '',
      streaming: true,
    })
  } else if (out.length && rest.trim()) {
    out[out.length - 1].trailing = rest.trim()
  }
  return out
}

/** (правка 427) Маркер клипа в extend-чате: первая строка fence `clip: N`
 *  (регистронезависимо, пробелы вокруг `:` допустимы). null — маркера нет. */
export function parseClipMarker(fenceContent: string): number | null {
  if (!fenceContent) return null
  const firstLine = fenceContent.split('\n', 1)[0].trim()
  const m = firstLine.match(/^clip\s*:\s*(\d+)\s*$/i)
  if (!m) return null
  const n = parseInt(m[1], 10)
  return Number.isFinite(n) && n >= 1 ? n : null
}

/** (правка 427) Промпт клипа без маркерной строки `clip: N` — то, что
 *  реально вставляется в карточку клипа. Маркера нет → контент как есть. */
export function stripClipMarker(fenceContent: string): string {
  if (parseClipMarker(fenceContent) === null) return fenceContent.trim()
  return fenceContent.split('\n').slice(1).join('\n').trim()
}

function stripDecorativeQuotes(t: string): string {
  return t.replace(/^["«]+/, '').replace(/["»]+$/g, '').trim()
}

/**
 * Извлечь вставляемый H3-промпт из ответа ассистента (правка 34):
 * 1) содержимое fence-блока — ровно между ```text и ```, т.е. обрезка
 *    ПО ЗАКРЫВАЮЩЕМУ FENCE, а не до конца строки;
 * 2) fence нет — от первого маркера H3-поля, также с обрезкой по
 *    закрывающему fence, если он встречается;
 * 3) фолбэк — последний содержательный абзац.
 * Возвращает '' если ничего пригодного нет.
 */
export function extractInsertablePrompt(content: string): string {
  if (!content) return ''

  // 1)_fence-блок — предпочтительный источник.
  const fence = content.match(/```[a-zA-Z]*\s*\n?([\s\S]*?)\n?\s*```/)
  if (fence && fence[1].trim()) {
    return stripDecorativeQuotes(fence[1].trim())
  }

  // 2) Нет (полного) fence: от первого H3-поля, с обрезкой по закрывающему
  //    fence, если он всё же встречается дальше.
  const marker = content.search(H3_FIELD_RE)
  if (marker >= 0) {
    let text = content.slice(marker)
    const close = text.search(/\n\s*```/)
    if (close >= 0) text = text.slice(0, close)
    return stripDecorativeQuotes(text.trim())
  }

  // 3) Фолбэк: последний содержательный абзац (как было до правки 34).
  const para = content
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith('—') && p.length > 40)
    .pop()
  return stripDecorativeQuotes(para ?? content.trim())
}
