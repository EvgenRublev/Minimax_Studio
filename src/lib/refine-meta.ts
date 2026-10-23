/**
 * refine-meta — заимствование промпта драфта из .meta.json сайдкара для
 * v2v-refine, с зачисткой того, что в refine вредно или бессмысленно.
 *
 * Зачем: refine при σ_start 0.9035 — текст-условный ре-рендер, якорящийся
 * латентом исходника; оригинальный промпт драфта описывает сцену и делает
 * схему идентичной Pass 2 генерации (там pass 2 использует тот же caption,
 * что pass 1).
 *
 * Что вырезается (Формат A/B ассистента, h3-prompt-spec.ts + prompt-guide.md):
 *  • аудио-секции — overall_soundscape, non_diegetic_music (звук берём из
 *    исходника напрямую, эти токены только размывают внимание);
 *  • референсно-мета секции — retention_analysis, summary (построены
 *    вокруг тегов <Subject N>);
 *  • теги <Video N>/<Audio N> — этих модальностей в refine нет, висячая
 *    ссылка на несуществующие ref-сегменты = out-of-distribution
 *    conditioning. Теги <Picture N> (правка 310) СОХРАНЯЮТСЯ: билдер
 *    refine (правка 315) подаёт мета-рефы в исходной нумерации оригинальной
 *    генерации (<Picture 1..k>), так что ссылки снова валидны;
 *  • теги <Subject N> (правка 310) — абстракция из subject_definitions
 *    (prompt-guide.md: «<Subject N> — видимое содержимое, абстрагированное
 *    из рефов», задаётся через <Picture N>, маппинга 1:1 на слоты нет) —
 *    вырезаются, а СОДЕРЖИМОЕ subject_definitions (описания внешности с
 *    валидными <Picture N>) сохраняется;
 *  • маркеры спикеров (S1) и префикс [reference generation].
 * Диалог <d>…</d> СОХРАНЯЕТСЯ — синхрон губ ре-рендера с оригинальным звуком.
 *
 * Референсы (правка 315): картинки из меты исходника (<Picture 1..k>, исходный
 * порядок оригинальной генерации), первый кадр видео — ПОСЛЕДНИМ слотом
 * (<Picture k+1>); без мета-рефов первый кадр = <Picture 1>.
 *
 * (правка 316) Цепочка промптов: readPromptChain/promptChainFromMeta собирают
 * source_prompt → prompt → extend_prompts[] в один conditioning-текст
 * (разделитель '\n\n---\n\n') — для extend-combined исходников рефайн и
 * апскейлы наследуют ВЕСЬ путь «исходник → клипы», а не один промпт.
 */
import fs from 'fs'
import path from 'path'
import { getAppConfig } from '@/lib/app-config'
import { sanitizeFolderPath } from '@/lib/gallery-folders' // (правка 495)
import { validateLatentFile } from '@/lib/latent-file'

/** Есть ли в тексте хотя бы одно «настоящее» слово (2+ буквы)?
 *  Промпт из одних точек/цифр («.» — тестовые клипы продления) якорем
 *  conditioning быть не может: с таким caption refine при σ≈0.9
 *  пересобирает каждый кусок независимо — персонаж меняется от куска
 *  к куску. Такой промпт считаем отсутствующим → нейтральный enhance. */
function hasMeaningfulText(s: string): boolean {
  return /[a-zA-Zа-яА-ЯёЁ\u00c0-\u024f\u0400-\u04ff]{2,}/.test(s)
}

/** Секции, которые остаются (метка секции срезается, содержимое — целиком).
 *  (правка 310) subject_definitions сохраняется: её тело — описания внешности
 *  с тегами <Picture N>, которые снова валидны (правка 315). */
const KEEP_SECTIONS = new Set(['integrated_multimodal_description', 'detailed_description', 'subject_definitions'])

/** (правка 310) Тег-референс несуществующей в refine модальности:
 *  <Video 2> / <Audio 1> (звука/видео-рефов в refine-cond нет).
 *  <Picture N> НЕ вырезается — билдер (правка 315) сохраняет исходную
 *  нумерацию мета-рефов, ссылки валидны. */
const REF_TAG_RE = /<\s*(?:video|audio)\s+\d+\s*>/gi
/** (правка 310) Тег <Subject N> — абстракция subject_definitions, определённая
 *  через <Picture N> (prompt-guide.md), маппинга 1:1 на image-слоты нет →
 *  вырезается (содержимое секции остаётся). */
const SUBJECT_TAG_RE = /<\s*subject\s+\d+\s*>/gi
/** Маркер спикера из FORMAT B: «(S1)» и производные. */
const SPEAKER_RE = /\(\s*S\d+\s*\)/g
/** Префикс режима FORMAT B: «[reference generation] …». */
const REF_MODE_PREFIX_RE = /^\s*\[reference generation\]\s*/i
/** Метка секции в начале строки: «overall_soundscape: …». */
const SECTION_RE = /^([a-z_]+):\s*/gm

/**
 * Очистить промпт драфта для подачи в refine-conditioning.
 * Свободный текст без меток секций возвращается зачищенным от тегов как есть.
 */
export function sanitizeDraftPrompt(raw: string): string {
  const text = (raw || '').replace(/\r\n?/g, '\n')
  if (!text.trim()) return ''

  // Разбор по секциям: [label, body] — секция тянется до следующей метки.
  const sections: Array<{ label: string; body: string }> = []
  const marks: Array<{ label: string; start: number; end: number }> = []
  for (const m of text.matchAll(SECTION_RE)) {
    marks.push({ label: m[1], start: m.index, end: m.index + m[0].length })
  }
  if (marks.length === 0) {
    sections.push({ label: '', body: text })
  } else {
    // Текст до первой метки (обычно пусто) тоже считаем «безметочной» секцией.
    if (marks[0].start > 0) sections.push({ label: '', body: text.slice(0, marks[0].start) })
    marks.forEach((mk, i) => {
      const stop = i + 1 < marks.length ? marks[i + 1].start : text.length
      sections.push({ label: mk.label, body: text.slice(mk.end, stop) })
    })
  }

  const kept = sections
    .map(({ label, body }) => (label === '' || KEEP_SECTIONS.has(label) ? body : ''))
    .filter((s) => s.trim())

  return kept
    .map((s) => sanitizeFragment(s))
    .filter((s) => s.length > 0)
    .join('\n\n')
}

/** Зачистка одного фрагмента: теги <Video|Audio|Subject N> (правка 310;
 *  <Picture N> сохраняются), спикеры, префикс, лишние пробелы. */
function sanitizeFragment(fragment: string): string {
  return fragment
    .replace(REF_TAG_RE, '')
    .replace(SUBJECT_TAG_RE, '')
    .replace(SPEAKER_RE, '')
    .replace(REF_MODE_PREFIX_RE, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').trim())
    .filter((line, i, arr) => line !== '' || (i > 0 && arr[i - 1] !== ''))
    .join('\n')
    .trim()
}

/**
 * (правка 309) Прочитать картинки-референсы из .meta.json исходника.
 * (правка 311) Возвращает объекты { path, role } (role — imageIntent из
 * меты, может быть пустой): билдер refine пишет по роли осмысленную
 * подпись слота <Picture N>.
 * Порядок массива = порядок references оригинальной генерации (фильтр
 * type==='image' сохраняет относительный порядок) — это и есть исходная
 * нумерация <Picture 1..k> (см. правка 315 в refine-template.ts).
 */
export function readMetaImageRefs(subfolder: string, filename: string): Array<{ path: string; role: string }> {
  const OUTPUT_DIR = getAppConfig().outputDir
  if (!OUTPUT_DIR || !filename) return []

  const safeSub = subfolder ? sanitizeFolderPath(subfolder) : ''
  const safeName = path.basename(filename)
  const metaFile = path.resolve(path.join(OUTPUT_DIR, ...safeSub.split('/').filter(Boolean), safeName + '.meta.json'))
  // (правка 716) Сравниваем resolve-нутые пути (на win32 — в нижнем регистре)
  // с границей по разделителю. Прежний metaFile.startsWith(OUTPUT_DIR) сравнивал
  // НЕ-нормализованный OUTPUT_DIR и пропускал соседнюю папку «outputX».
  if (!isInsideOutput(metaFile, OUTPUT_DIR)) return []

  try {
    const raw = fs.readFileSync(metaFile, 'utf-8')
    const meta = JSON.parse(raw) as {
      references?: Array<{ type?: string; path?: string; role?: string }>
      minimax_h3_references?: Array<{ type?: string; path?: string; role?: string }>
    }
    const refs = Array.isArray(meta.references) ? meta.references
      : Array.isArray(meta.minimax_h3_references) ? meta.minimax_h3_references
      : []
    return refs
      .filter((r) => r.type === 'image' && typeof r.path === 'string' && r.path.length > 0)
      // (правка 716) Путь из сайдкара приводится к ИМЕНИ ФАЙЛА (basename).
      // Сайдкар клиентский (POST /api/comfy/metadata принимает params как есть),
      // поэтому r.path мог быть «../../../secret.png». Раньше он уходил в
      // path.join(cfg.inputDir, r.path) — это был oracle существования
      // произвольных файлов — и дальше в workflow, где ComfyUI LoadImage
      // ждёт просто имя файла из input/.
      .map((r) => ({
        path: path.basename((r.path as string).replace(/\\/g, '/')),
        role: typeof r.role === 'string' ? r.role : '',
      }))
      .filter((r) => r.path.length > 0 && r.path !== '.' && r.path !== '..')
  } catch {
    return []
  }
}

/** (правка 316) Общий резолв пути сайдкара с защитой от выхода за outputDir. */
function resolveMetaFile(subfolder: string, filename: string): string | null {
  const OUTPUT_DIR = getAppConfig().outputDir
  if (!OUTPUT_DIR || !filename) return null

  // (правка 495) subfolder — многоуровневый относительный путь ('a/b').
  const safeSub = subfolder ? sanitizeFolderPath(subfolder) : ''
  const safeName = path.basename(filename)
  const metaFile = path.resolve(path.join(OUTPUT_DIR, ...safeSub.split('/').filter(Boolean), safeName + '.meta.json'))
  // (правка 716) Нормализованное сравнение с границей по разделителю.
  if (!isInsideOutput(metaFile, OUTPUT_DIR)) return null
  return metaFile
}

/**
 * (правка 716) Путь внутри outputDir? Сравнение нормализованных путей
 * (на win32 — без учёта регистра), граница — по разделителю.
 */
function isInsideOutput(target: string, outputDir: string): boolean {
  const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p)
  const root = norm(path.resolve(outputDir))
  const t = norm(path.resolve(target))
  return t === root || t.startsWith(root + path.sep)
}

/**
 * Прочитать промпт драфта из сайдкара `<outputDir>/<subfolder>/<filename>.meta.json`.
 * Возвращает ЗАЧИЩЕННЫЙ промпт или null (нет файла/нет поля/пусто).
 */
export function readDraftPrompt(subfolder: string, filename: string): string | null {
  const metaFile = resolveMetaFile(subfolder, filename)
  if (!metaFile) return null

  try {
    const raw = fs.readFileSync(metaFile, 'utf-8')
    const meta = JSON.parse(raw) as { prompt?: unknown }
    if (typeof meta.prompt !== 'string' || !hasMeaningfulText(meta.prompt)) return null
    return sanitizeDraftPrompt(meta.prompt) || null
  } catch {
    return null
  }
}

/**
 * (правка 316) Собрать ПОЛНУЮ цепочку промптов из уже распарсенной меты:
 * исходник → продления. Порядок: source_prompt (промпт исходника, сохранён
 * concat'ом) → prompt → extend_prompts[] (накопленная цепочка продлений).
 * Подряд идущие дубли схлопываются (prompt первого продления часто совпадает
 * с промптом исходника). Каждая часть проходит sanitizeDraftPrompt; части
 * склеиваются разделителем '\n\n---\n\n'. Нет осмысленного текста → null.
 */
export function promptChainFromMeta(meta: Record<string, unknown>): string | null {
  const parts = promptChainPartsFromMeta(meta)
  if (parts.length === 0) return null
  const joined = parts.join('\n\n---\n\n')
  return hasMeaningfulText(joined) ? joined : null
}

/**
 * Цепочка промптов из меты ПО ЧАСТЯМ (та же раскладка, что
 * promptChainFromMeta, но без склейки): [source_prompt, prompt,
 * ...extend_prompts] — каждая часть санитизирована, подряд идущие дубли
 * схлопнуты. Нужна режиму «Частями», чтобы окно 0 получало ПЕРВЫЙ промпт
 * цепочки (он описывает начало видео), а не всю сумму сцен сразу.
 */
export function promptChainPartsFromMeta(meta: Record<string, unknown>): string[] {
  const parts: string[] = []
  const push = (v: unknown) => {
    if (typeof v !== 'string' || !hasMeaningfulText(v)) return
    const s = sanitizeDraftPrompt(v)
    if (s && parts[parts.length - 1] !== s) parts.push(s)
  }
  push(meta.source_prompt)
  push(meta.prompt)
  if (Array.isArray(meta.extend_prompts)) {
    for (const p of meta.extend_prompts) push(p)
  }
  return parts
}

/** Части цепочки промптов из сайдкара исходника (см. promptChainPartsFromMeta). */
export function readPromptChainParts(subfolder: string, filename: string): string[] | null {
  const metaFile = resolveMetaFile(subfolder, filename)
  if (!metaFile) return null

  try {
    const raw = fs.readFileSync(metaFile, 'utf-8')
    const parts = promptChainPartsFromMeta(JSON.parse(raw) as Record<string, unknown>)
    return parts.length > 0 ? parts : null
  } catch {
    return null
  }
}

/**
 * (правка 375/376) Прочитать из сайдкара исходника данные для lossless-ветки
 * рефайна: путь сохранённого AV-латента (latent_file — пишет финализация
 * меты из ui.latents ноды '46:49') + video_length/resolution той же меты.
 * Роут сверяет их с ffprobe-данными mp4: не совпало (видео обрезано/изменено
 * после генерации) → латент непригоден, рефайн идёт обычным mp4-путём.
 */
export function readMetaLatentSource(
  subfolder: string,
  filename: string,
): { latentFile: string; videoLength: number; resolution: string } | null {
  const metaFile = resolveMetaFile(subfolder, filename)
  if (!metaFile) return null

  try {
    const raw = fs.readFileSync(metaFile, 'utf-8')
    const meta = JSON.parse(raw) as {
      latent_file?: unknown
      video_length?: unknown
      resolution?: unknown
    }
    if (typeof meta.latent_file !== 'string' || meta.latent_file.length === 0) return null
    return {
      latentFile: meta.latent_file,
      videoLength: typeof meta.video_length === 'number' ? meta.video_length : -1,
      resolution: typeof meta.resolution === 'string' ? meta.resolution : '',
    }
  } catch {
    return null
  }
}

export interface ResolvedSourceLatent {
  /** Путь к .latent относительно output/ ComfyUI. */
  file: string
  /** Пиксельная канва латента (из шапки safetensors, латент × 16).
   *  Это канва ГЕНЕРАЦИИ (до кропа под номинал) — вся геометрия
   *  lossless-ветки (цель, conditioning, апскейл) считается от неё. */
  width: number
  height: number
  /** Число видео-токенов латента (точно, из shape). */
  tokens: number
  /** Число аудио-шагов латента (точно, из shape; 0 = не читается). */
  audioSteps: number
}

/**
 * (правки 381/382) ЕДИНЫЙ резолвер lossless-ветки для refine «Целый» /
 * «Частями» / Tile Upscale: мета → целостность mp4 → валидация файла →
 * пиксельная канва латента. Любой отказ → null (тихий fallback на mp4),
 * причина — в console.warn от вызывающего (флаг verbose).
 *
 * Проверки:
 *  • latent_file в сайдкаре, mp4 НЕ менялся (кадры/разрешение меты = ffprobe);
 *  • файл существует, шапка safetensors цела, версия/VAE совпадают;
 *  • канва латента ≥ размеров mp4 (кроп генерации только срезает) и кратна 32.
 */
export function resolveSourceLatent(
  subfolder: string,
  filename: string,
  probe: { width: number; height: number; frames: number },
  warn?: (msg: string) => void,
): ResolvedSourceLatent | null {
  const log = warn ?? (() => {})
  const ls = readMetaLatentSource(subfolder, filename)
  if (!ls) return null
  if (ls.videoLength !== probe.frames || ls.resolution !== `${probe.width}x${probe.height}`) {
    log(`mp4 не совпадает с метой (обрезан/изменён после генерации)`)
    return null
  }
  const check = validateLatentFile(ls.latentFile)
  if (!check.ok || !check.dims) {
    log(check.reason ?? 'нет размеров латента в шапке')
    return null
  }
  const { width, height, tokens, audioSteps } = check.dims
  if (width < probe.width || height < probe.height) {
    log(`канва латента ${width}×${height} меньше mp4 ${probe.width}×${probe.height} — мета не согласована`)
    return null
  }
  // (правка 396, 431) Канва обязана быть кратна 32 (это обещает docstring;
  // с правкой 431 extend-комбайн тоже пишет латент на канве ceil32 — до неё
  // ceil16 давал нечётный латент и падение LatentConcat на пост-сборке).
  // Иначе геометрия conditioning lossless-ветки расходится — тихий fallback
  // на mp4.
  if (width % 32 !== 0 || height % 32 !== 0) {
    log(`канва латента ${width}×${height} не кратна 32 — lossless отклонён`)
    return null
  }
  return { file: ls.latentFile, width, height, tokens, audioSteps }
}

/**
 * (правка 316) Прочитать цепочку промптов из сайдкара исходника.
 * Для обычной меты (одиночный prompt, без extend-полей) эквивалентна
 * readDraftPrompt; для extend-combined возвращает весь путь
 * «исходник → клип 1 → … → клип N».
 */
export function readPromptChain(subfolder: string, filename: string): string | null {
  const metaFile = resolveMetaFile(subfolder, filename)
  if (!metaFile) return null

  try {
    const raw = fs.readFileSync(metaFile, 'utf-8')
    return promptChainFromMeta(JSON.parse(raw) as Record<string, unknown>)
  } catch {
    return null
  }
}
