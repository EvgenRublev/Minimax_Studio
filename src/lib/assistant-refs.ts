/**
 * (правка 823) ЕДИНЫЙ сборщик референсов ассистента.
 *
 * Зачем: до правки списки референсов собирались в ТРЁХ независимых местах —
 *   1) buildSystemMessage/buildExtendSystemMessage/buildControlNetSystemMessage
 *      (assistant-stream.ts) — перечисляли ВСЕ рефы без лимитов;
 *   2) getReferences (assistant-stream.ts) — резал по REF_LIMITS;
 *   3) route.ts — ещё раз резал по своим REF_LIMITS.
 * Из-за расхождения (1) и (2) при >9 картинок системный промпт перечислял
 * <Picture 10..12>, файлы не прикреплялись, а модель писала в промпт метки
 * несуществующих референсов (жалоба «указывает несуществующие референсы»).
 *
 * Теперь единственный источник истины — buildReferenceSet(): и системный
 * промпт, и payload /api/llm/chat берут ОДИН И ТОТ ЖЕ список с ОДНОЙ
 * нумерацией. Модуль чистый (без React/Next/zustand) — покрыт харнессом
 * scratchpad/assistant-refs-check.mjs (уровень C плана отладки).
 */

/** Потолки по видам — ровно как у модели H3 (ref_images/ref_videos/ref_audios)
 *  и как на сервере (/api/llm/chat). Приоритет: image → video → audio. */
export const REF_LIMITS = { image: 9, video: 3, audio: 3, total: 15 } as const

export type AssistantRefKind = 'image' | 'video' | 'audio'
export type AssistantChatMode = 'generate' | 'extend' | 'controlnet'

/** Один референс во входных данных (снимок сторов). */
export interface AssistantRefSource {
  path: string
  /** Отображаемое имя файла (для системного промпта). */
  name: string
  kind: AssistantRefKind
  /** Роль картинки (identity / style / ...) — как в форме «Генерация». */
  imageIntent?: string
  includeAudio?: boolean
}

export interface AssistantControlNetSource {
  filename: string
  inputSource?: string
  subfolder?: string
}

/** Снимок всех сторов, от которых зависят референсы. */
export interface AssistantRefInput {
  /** Режим формы «Генерация»: ref | t2v | flf | extend. */
  mode: 'ref' | 't2v' | 'flf' | 'extend'
  refs: AssistantRefSource[]
  startFrame?: { path: string; name: string } | null
  endFrame?: { path: string; name: string } | null
  /** Картинки вкладки «Продление». */
  extendImageRefs: AssistantRefSource[]
  controlnet: {
    controlType: string
    source: AssistantControlNetSource | null
    refImages: AssistantRefSource[]
  }
}

/** Итоговый референс: то, что уходит на провод И перечисляется в system-промпте. */
export interface AssistantRefEntry {
  path: string
  name: string
  /** Метка ровно в том виде, в каком её пишет модель: `Picture 1`, `Video 1`,
   *  `Audio 1`, `Первый кадр`, `Последний кадр`. */
  trigger: string
  kind: AssistantRefKind
  intent?: string
  includeAudio?: boolean
}

/**
 * Собрать референсы для режима чата. Инварианты (см. харнесс):
 *  • нумерация по виду компактная 1..k без дырок;
 *  • kind/порядок = порядок формы (flf: кадры ПЕРВЫМИ, затем аудио);
 *  • ни один вид не превышает свой потолок, всего ≤ REF_LIMITS.total;
 *  • один и тот же список используется system-промптом и payload.
 */
export function buildReferenceSet(
  input: AssistantRefInput,
  chatMode: AssistantChatMode = 'generate',
): AssistantRefEntry[] {
  if (chatMode === 'controlnet') {
    const out: AssistantRefEntry[] = []
    // (правка 907) Контрольное видео идёт в референсы ассистента ВО ВСЕХ
    // режимах, а не только в direct. В графе оно всегда подаётся как
    // ref_video_0 (controlnet-template.ts: direct — сам исходник, depth/canny/
    // pose — построенная карта), и модель H3 его «видит» — значит ассистент
    // обязан понимать, ЧТО в этом ролике происходит, иначе промпт пишется
    // вслепую. Раньше при depth/canny/pose (дефолт — depth) видео в списке
    // отсутствовало вовсе, и ассистент честно сообщал «кадров не вижу».
    if (input.controlnet.source) {
      const src = input.controlnet.source
      const sourcePath = src.inputSource
        || (src.subfolder ? `${src.subfolder}/${src.filename}` : src.filename)
      out.push({
        path: sourcePath,
        name: src.filename,
        trigger: 'Video 1',
        // inputSource — файл с диска, уже лежит в input/staging; иначе это
        // галерейный output-файл, и resolver должен искать его в output.
        intent: src.inputSource ? 'control_source_input' : 'control_source',
        kind: 'video',
        includeAudio: false,
      })
    }
    for (const r of input.controlnet.refImages) {
      if (out.filter((e) => e.kind === 'image').length >= REF_LIMITS.image) break
      out.push({
        path: r.path,
        name: r.name,
        trigger: `Picture ${countKind(out, 'image') + 1}`,
        kind: 'image',
        intent: r.imageIntent,
      })
    }
    return out
  }

  if (chatMode === 'extend') {
    // Референсы вкладки «Продление» (extendImageRefs), а НЕ refs «Генерации».
    // (правка 823) Потолок картинок применяется ЗДЕСЬ — раньше система
    // перечисляла все, а сервер молча резал до 9.
    return input.extendImageRefs.slice(0, REF_LIMITS.image).map((r, i) => ({
      path: r.path,
      name: r.name,
      trigger: `Picture ${i + 1}`,
      intent: r.imageIntent || 'identity',
      kind: 'image' as const,
    }))
  }

  // ── generate: ref / t2v / flf ──
  // (правка 150) В t2v/flf из рефов уходят ТОЛЬКО аудио (картинки/видео не используются нодой).
  const refs = input.mode === 'ref' ? input.refs : input.refs.filter((r) => r.kind === 'audio')
  const out: AssistantRefEntry[] = []

  // (правка 151) В flf кадры идут ПЕРВЫМИ (они главные), затем аудио.
  // (правка 717) Кадры занимают слоты <Picture N> — учитываем их в лимите
  // картинок, иначе общее число картинок могло превысить 9.
  if (input.mode === 'flf') {
    if (input.startFrame?.path && countKind(out, 'image') < REF_LIMITS.image) {
      out.push({
        path: input.startFrame.path,
        name: input.startFrame.name,
        trigger: 'Первый кадр',
        intent: 'first_frame',
        kind: 'image',
      })
    }
    if (input.endFrame?.path && countKind(out, 'image') < REF_LIMITS.image) {
      out.push({
        path: input.endFrame.path,
        name: input.endFrame.name,
        trigger: 'Последний кадр',
        intent: 'last_frame',
        kind: 'image',
      })
    }
  }

  for (const r of refs) {
    if (out.length >= REF_LIMITS.total) break
    if (r.kind === 'image') {
      if (countKind(out, 'image') >= REF_LIMITS.image) continue
      out.push({
        path: r.path,
        name: r.name,
        trigger: `Picture ${countKind(out, 'image') + 1}`,
        intent: r.imageIntent || 'identity',
        kind: 'image',
      })
    } else if (r.kind === 'video') {
      if (countKind(out, 'video') >= REF_LIMITS.video) continue
      out.push({
        path: r.path,
        name: r.name,
        trigger: `Video ${countKind(out, 'video') + 1}`,
        kind: 'video',
        includeAudio: r.includeAudio,
      })
    } else if (r.kind === 'audio') {
      if (countKind(out, 'audio') >= REF_LIMITS.audio) continue
      out.push({
        path: r.path,
        name: r.name,
        trigger: `Audio ${countKind(out, 'audio') + 1}`,
        kind: 'audio',
      })
    }
  }
  return out
}

function countKind(entries: AssistantRefEntry[], kind: AssistantRefKind): number {
  let n = 0
  for (const e of entries) if (e.kind === kind) n++
  return n
}

/* ──────────────────────────────────────────────────────────────────────────
 * (правка 906) «Референсы изменились с прошлого хода».
 *
 * Проблема: метка <Picture N> — это ПОЗИЦИЯ в списке, а не идентификатор файла.
 * Пользователь меняет реф (UI: «убрать» + добавить — новый файл встаёт в конец,
 * см. addVideoRefs), из-за чего <Picture 2> с этого момента означает ДРУГОЙ
 * файл, а в истории чата остались реплики ассистента про старый. Модель видит
 * свежий системный список и свежие описания, но не знает, что номера «переехали»,
 * и охотно продолжает «<Picture 2> — девушка в красном», когда там уже мужчина.
 *
 * Решение: храним в чате отпечаток последнего набора, который модель реально
 * видела (AssistantChat.refSnapshot), и при расхождении добавляем в системный
 * промпт явный блок «что изменилось». Чистые функции — покрыты
 * scratchpad/assistant-ref-replace-check.mjs.
 * ────────────────────────────────────────────────────────────────────────── */

/** Компактная запись набора референсов для хранения в чате. */
export function serializeRefSnapshot(entries: AssistantRefEntry[]): string {
  return JSON.stringify(entries.map((e) => ({ t: e.trigger, p: e.path, n: e.name })))
}

interface RefSnapshotItem { t: string; p: string; n: string }

function parseRefSnapshot(raw: string | null | undefined): RefSnapshotItem[] | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return null
    const out: RefSnapshotItem[] = []
    for (const item of parsed) {
      if (!item || typeof item !== 'object') return null
      const t = (item as Record<string, unknown>).t
      const p = (item as Record<string, unknown>).p
      const n = (item as Record<string, unknown>).n
      if (typeof t !== 'string' || typeof p !== 'string' || typeof n !== 'string') return null
      out.push({ t, p, n })
    }
    return out
  } catch {
    return null
  }
}

/**
 * Текст-предупреждение для системного промпта или '' если набор не изменился
 * (или предыдущего снимка нет — первый ход в чате).
 */
export function describeRefsChange(
  prevSnapshot: string | null | undefined,
  entries: AssistantRefEntry[],
): string {
  const prev = parseRefSnapshot(prevSnapshot)
  if (!prev) return ''

  const prevByTrigger = new Map(prev.map((e) => [e.t, e]))
  const nowByTrigger = new Map(entries.map((e) => [e.trigger, e]))

  const changed: string[] = []
  const removed: string[] = []
  const added: string[] = []

  // Метки-теги печатаем в угловых скобках (как их видит модель в промпте),
  // особые триггеры («Первый кадр») — как есть.
  const fmt = (trigger: string): string =>
    /^(Picture|Video|Audio) \d+$/.test(trigger) ? `<${trigger}>` : trigger

  for (const [trigger, now] of nowByTrigger) {
    const before = prevByTrigger.get(trigger)
    if (!before) {
      added.push(`${fmt(trigger)} = «${now.name}»`)
      continue
    }
    if (before.p !== now.path || before.n !== now.name) {
      changed.push(`${fmt(trigger)} — было «${before.n}», стало «${now.name}»`)
    }
  }
  for (const [trigger, before] of prevByTrigger) {
    if (!nowByTrigger.has(trigger)) removed.push(`${fmt(trigger)} = «${before.n}»`)
  }

  if (!changed.length && !removed.length && !added.length) return ''

  const lines = ['=== ⚠️ РЕФЕРЕНСЫ ИЗМЕНИЛИСЬ С ПРОШЛОГО ХОДА ===']
  if (changed.length) lines.push(`Изменены: ${changed.join('; ')}.`)
  if (added.length) lines.push(`Появились: ${added.join('; ')}.`)
  if (removed.length) lines.push(`Убраны: ${removed.join('; ')}.`)
  lines.push(
    'Номера меток могли перейти к ДРУГИМ файлам: в истории этого чата <Picture N>/<Video N>/<Audio N> могли означать другой референс.',
    'Не переноси из прошлых реплик описания, внешность, имена и не ссылайся на старые номера — опирайся ТОЛЬКО на текущий список выше и свежие описания.',
    'Если пользователь говорит «второй референс» / «тот, что был» и по смыслу это уже не текущий файл — уточни, какой именно референс он имеет в виду, прежде чем писать промпт.',
  )
  return lines.join('\n')
}

