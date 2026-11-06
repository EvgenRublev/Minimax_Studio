/**
 * (правка 720) POST /api/montage/render — сборка видеомонтажа.
 * Принимает список файлов галереи (output ComfyUI) с подрезкой по секундам
 * и склеивает их ffmpeg'ом (бинарник из runtime/ffmpeg, см. resolveFfmpeg)
 * в один MP4 ЖЕСТКИМИ склейками (без переходов). Канва результата =
 * размер ПЕРВОГО клипа (даже + 24fps), остальные клипы масштабируются под неё.
 * Клипы без звуковой дорожки получают тишину (anullsrc) — склейка всегда ровно
 * один видеопоток + один аудиопоток. (правка 720 v8) у каждого клипа своя
 * громкость (volume= на аудиопотоке входа) и есть общая громкость таймлайна
 * (volume= после concat), обе вплавляются в результат. (правка 720 v11) у клипа
 * бывают аудиопереходы fadeIn/fadeOut (сек) — они делаются afade на аудиопотоке.
 *
 * (правка 834) сборка однопоточная: второй запрос получает 409, а имя результата
 * резервируется атомарно ('wx') — две параллельные сборки больше не перезаписывают
 * друг друга. (правка 835) подрезки сверяются с реальной длительностью клипа:
 * старт за концом или «шот тоньше 0.05 с» — это 400 с именем шота, а не молча
 * пропавший клип и не технический текст ffmpeg. (правка 836) поиск файла с тем же
 * именем учитывает subfolder и не подставляет чужой файл молча. (правка 837)
 * папка результата проверяется с path.sep. (правка 838) отмена запроса убивает
 * ffmpeg и подчищает неполный файл. (правка 839) probe входов параллельный, а
 * прогресс кодирования (-progress pipe:1) доступен через GET /api/montage/render.
 *
 * (правка 846) «Секвенция» как в Premiere: body.seq = { w, h, fps, fit, quality }.
 * w/h = 0 ⇒ канва как у первого клипа (прежнее поведение); fit = stretch
 * (растянуть, по умолчанию = прежнее поведение) | cover (залить кадр, кроп) |
 * contain (вписать с полями) | blur (вписать, фоном размытая копия); fps = 0 ⇒ 24;
 * quality = high (crf 18) | standard (crf 20, прежний профиль) | fast (crf 28).
 * (правка 847) переходы: у шота поле tr = переход к СЛЕДУЮЩЕМУ шоту
 * { type, dur }. Стыки с переходом склеиваются xfade (видео) + acrossfade
 * (звук) в цепочку-«ран», жёсткие стыки — concat поверх ранов; длительность
 * ролика = Σ d − Σ D, offset k-го xfade = Σ d(<k) − Σ D(≤k).
 * (правка 848) эффекты шота: speed 0.25–4 (setpts + цепочка atempo из-за
 * диапазона 0.5–2) и fx { flipH, flipV, gray, bright, contrast, sat }.
 */
import path from 'path'
import { promises as fs, existsSync } from 'fs'
import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import { NextResponse } from 'next/server'
import { getAppConfig } from '@/lib/app-config'
import { sanitizeFolderPath } from '@/lib/gallery-folders' // (правка 495)
import { resolveFfmpeg } from '@/lib/thumb'

export const runtime = 'nodejs'

const execFileAsync = promisify(execFile)

/** (правка 834) одна сборка за раз: второй запрос получает 409, а не гонку имён */
let renderBusy = false

/** (правка 839) прогресс текущей сборки для UI; null = сборки нет */
let renderProgress: { name: string; startedAt: number; pct: number } | null = null

export function GET() {
  return NextResponse.json({ progress: renderProgress })
}

/**
 * (правка 838/839) один проход ffmpeg с отчетом прогресса и отменой:
 * stdout разбираем на `out_time_ms=` (флаг `-progress pipe:1`), при abort/таймауте
 * убиваем процесс. Reject: Error с .stderr и (правка 838) .aborted = true.
 */
function runFfmpegEncode(
  bin: string,
  args: string[],
  signal: AbortSignal | undefined,
  totalOut: number,
  name: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true })
    let stderr = ''
    let stdoutBuf = ''
    let aborted = false
    let killReason: 'abort' | 'timeout' | null = null
    const startedAt = Date.now()
    renderProgress = { name, startedAt, pct: 0 }
    const kill = (why: 'abort' | 'timeout') => {
      if (aborted) return
      aborted = true
      killReason = why
      try { child.kill('SIGKILL') } catch { /* уже мёртв */ }
      // (правка 838) reject только после close: на Windows нельзя удалить файл,
      // пока живой ffmpeg держит его открытым — rm раньше падал молча
    }
    const mkErr = () => {
      const e = new Error(killReason === 'timeout' ? 'Сборка превысила лимит времени' : 'Сборка отменена') as Error & {
        stderr?: string
        aborted?: boolean
      }
      e.aborted = true
      e.stderr = stderr.slice(-500)
      return e
    }
    const timer = setTimeout(() => kill('timeout'), 15 * 60_000)
    if (signal) {
      if (signal.aborted) kill('abort')
      else signal.addEventListener('abort', () => kill('abort'), { once: true })
    }
    child.stdout.on('data', (b: Buffer) => {
      stdoutBuf += b.toString('utf8')
      // (правка 839) ищем out_time_ms ДО обрезки буфера: иначе регулярка
      // никогда не видела завершённую строку прогресса и pct оставался 0
      const m = /out_time_ms=(\d+)/.exec(stdoutBuf)
      const i = stdoutBuf.lastIndexOf('\n')
      if (i >= 0) stdoutBuf = stdoutBuf.slice(i + 1) // держим только незавершённую строку
      if (m && totalOut > 0) {
        const sec = Number(m[1]) / 1_000_000
        const p = renderProgress
        if (p) p.pct = Math.min(100, Math.round((sec / totalOut) * 100))
      }
    })
    child.stderr.on('data', (b: Buffer) => {
      stderr = (stderr + b.toString('utf8')).slice(-8000)
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      renderProgress = null
      if (aborted) {
        reject(mkErr())
        return
      }
      const e = err as Error & { stderr?: string }
      e.stderr = stderr.slice(-500)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      renderProgress = null
      if (aborted) {
        // (правка 838) процесс мёртв, дескриптор закрыт — теперь POST сможет
        // удалить неполный файл; reject именно здесь, а не в kill()
        reject(mkErr())
        return
      }
      if (code === 0) resolve()
      else {
        const e = new Error(`ffmpeg завершился с кодом ${code}`) as Error & { stderr?: string }
        e.stderr = stderr.slice(-500) || `ffmpeg exited with code ${code}`
        reject(e)
      }
    })
  })
}

/** Один шот монтажной последовательности */
interface MontageInput {
  /** имя файла в папке output ComfyUI */
  name: string
  /** подпапка внутри output (как в галерее) */
  subfolder?: string
  /** подрезка начала, сек; пусто/0 = с начала */
  trimStart?: number | string | null
  /** подрезка конца, сек; пусто/0 = до конца */
  trimEnd?: number | string | null
  /** (правка 720 v8) громкость клипа, 0..1; не задана = 1 */
  vol?: number | string | null
  /** (правка 720 v11) плавное появление звука, сек; 0/пусто = без фейда */
  fadeIn?: number | string | null
  /** (правка 720 v11) плавное затухание звука в конце клипа, сек */
  fadeOut?: number | string | null
  /** (правка 848) скорость клипа, 0.25..4; не задана = 1 */
  speed?: number | string | null
  /** (правка 848) фильтры картинки клипа */
  fx?: ShotFx | null
  /** (правка 847) переход к следующему клипу; null = жёсткая склейка */
  tr?: TransitionSpec | null
  /** (правка 860) пустой промежуток (пауза: чёрный кадр + тишина) перед клипом, сек */
  gap?: number | string | null
}

/** (правка 848, 859, 861) картинные фильтры клипа (панель Эффекты):
 *  5-точечные 2D-кривые цвета, температура, HUE, яркость, контраст, насыщенность,
 *  радиальная дисперсия (от центра к краям) и киношный шум */
type CurveNode = [number, number]
type CurveSpec = CurveNode[] | [number, number, number]

interface CurveChannels {
  master?: CurveSpec | null
  r?: CurveSpec | null
  g?: CurveSpec | null
  b?: CurveSpec | null
}

interface ShotFx {
  flipH?: boolean | null
  flipV?: boolean | null
  /** ч/б (оставлено в API для совместимости; из UI убрано в правке 859) */
  gray?: boolean | null
  /** яркость −0.5..0.5 (ffmpeg eq brightness) */
  bright?: number | null
  /** контраст −0.5..0.5 (eq contrast, 1 = норма) */
  contrast?: number | null
  /** насыщенность 0..2 (eq saturation, 1 = норма) */
  sat?: number | null
  /** (правка 861) температура −100..100 (холоднее..теплее, colorbalance) */
  temp?: number | null
  /** (правка 861) сдвиг оттенка HUE −180..180 град */
  hue?: number | null
  /** (правка 859, 861) кривые цвета (5 точек [x,y] или legacy 3 точки) */
  curves?: CurveChannels | null
  /** (правка 859, 861) радиальная хроматическая дисперсия (центр 0, к краям до 20) */
  dispersion?: number | null
  /** (правка 859) киношный анимированный шум (зерно плёнки), 0..100% */
  grain?: number | null
}

/** (правка 847) переход: тип xfade и длительность, сек */
interface TransitionSpec {
  type: string
  dur: number
}

/** (правка 846) настройки секвенции */
interface MontageSeq {
  w?: number | null
  h?: number | null
  fps?: number | null
  fit?: string | null
  quality?: string | null
}

/** (правка 847) типы переходов, разрешённые к сборке (набор xfade ffmpeg) */
const TRANSITIONS = new Set([
  'fade', 'fadeblack', 'fadewhite',
  'wipeleft', 'wiperight', 'wipeup', 'wipedown',
  'slideright', 'slideleft', 'slideup', 'slidedown',
  'circleopen', 'pixelize',
])

/** (правка 846) профиль кодирования по настройке качества */
const QUALITY: Record<string, { crf: string; preset: string }> = {
  high: { crf: '18', preset: 'medium' },
  standard: { crf: '20', preset: 'veryfast' },
  fast: { crf: '28', preset: 'veryfast' },
}

/** (правка 848) скорость клипа: вне диапазона или некорректная = 1 */
function parseSpeed(v: number | string | null | undefined): number {
  if (v == null || v === '') return 1
  const n = typeof v === 'number' ? v : parseFloat(v)
  if (!Number.isFinite(n) || n < 0.25 || n > 4) return 1
  return Math.round(n * 1000) / 1000
}

/** (правка 848, 859, 861) чистка 5-точечной 2D-кривой (или legacy 3-точечной) */
function cleanCurveChannel(raw: unknown): CurveNode[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const clamp01 = (v: unknown, def: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, Math.round(v * 1000) / 1000)) : def
  // legacy-формат: [y1, y2, y3] на x = 0.25, 0.5, 0.75
  if (raw.length === 3 && typeof raw[0] === 'number') {
    const y1 = clamp01(raw[0], 0.25)
    const y2 = clamp01(raw[1], 0.5)
    const y3 = clamp01(raw[2], 0.75)
    if (Math.abs(y1 - 0.25) < 0.003 && Math.abs(y2 - 0.5) < 0.003 && Math.abs(y3 - 0.75) < 0.003) return null
    return [[0, 0], [0.25, y1], [0.5, y2], [0.75, y3], [1, 1]]
  }
  if (raw.length !== 5) return null
  const nodes: CurveNode[] = []
  for (let i = 0; i < 5; i++) {
    const item = raw[i]
    const def = i * 0.25
    if (Array.isArray(item) && item.length >= 2) {
      nodes.push([clamp01(item[0], def), clamp01(item[1], def)])
    } else {
      nodes.push([def, def])
    }
  }
  // гарантируем строгое возрастание x для фильтра ffmpeg curves
  for (let i = 1; i < nodes.length; i++) {
    if (nodes[i][0] <= nodes[i - 1][0] + 0.01) {
      nodes[i][0] = Math.min(1, +(nodes[i - 1][0] + 0.015).toFixed(3))
    }
  }
  for (let i = nodes.length - 2; i >= 0; i--) {
    if (nodes[i][0] >= nodes[i + 1][0] - 0.01) {
      nodes[i][0] = Math.max(0, +(nodes[i + 1][0] - 0.015).toFixed(3))
    }
  }
  const isIdentity = nodes.every(([x, y], i) => Math.abs(x - i * 0.25) < 0.004 && Math.abs(y - i * 0.25) < 0.004)
  return isIdentity ? null : nodes
}

function cleanFx(fx?: ShotFx | null): ShotFx {
  if (!fx || typeof fx !== 'object') return {}
  const num = (v: unknown, lo: number, hi: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null
  const r: ShotFx = { flipH: fx.flipH === true, flipV: fx.flipV === true, gray: fx.gray === true }
  const b = num(fx.bright, -0.5, 0.5)
  if (b) r.bright = b
  const c = num(fx.contrast, -0.5, 0.5)
  if (c) r.contrast = c
  const s = num(fx.sat, 0, 2)
  if (s !== null && s !== 1) r.sat = s
  const temp = num(fx.temp, -100, 100)
  if (temp && Math.abs(temp) >= 1) r.temp = temp
  const hue = num(fx.hue, -180, 180)
  if (hue && Math.abs(hue) >= 1) r.hue = hue
  if (fx.curves && typeof fx.curves === 'object') {
    const cm = cleanCurveChannel(fx.curves.master)
    const cr = cleanCurveChannel(fx.curves.r)
    const cg = cleanCurveChannel(fx.curves.g)
    const cb = cleanCurveChannel(fx.curves.b)
    if (cm || cr || cg || cb) {
      r.curves = { ...(cm ? { master: cm } : {}), ...(cr ? { r: cr } : {}), ...(cg ? { g: cg } : {}), ...(cb ? { b: cb } : {}) }
    }
  }
  const disp = num(fx.dispersion, 0, 20)
  if (disp && disp > 0) r.dispersion = disp
  const grain = num(fx.grain, 0, 100)
  if (grain && grain > 0) r.grain = grain
  return r
}

/** (правка 847) чистка перехода: неизвестный тип или длительность вне 0.1..3 = null */
function cleanTransition(tr?: TransitionSpec | null): TransitionSpec | null {
  if (!tr || typeof tr !== 'object') return null
  const type = typeof tr.type === 'string' && TRANSITIONS.has(tr.type) ? tr.type : null
  const dur = typeof tr.dur === 'number' && Number.isFinite(tr.dur) ? Math.round(tr.dur * 1000) / 1000 : 0
  if (!type || dur < 0.1 || dur > 3) return null
  return { type, dur }
}

/** (правка 848) atempo живёт в диапазоне 0.5–2, поэтому 4× = две стадии по 2× */
function atempoChain(speed: number): string {
  let s = speed
  const parts: string[] = []
  while (s > 2.0001) {
    parts.push('atempo=2')
    s /= 2
  }
  while (s < 0.4999) {
    parts.push('atempo=0.5')
    s *= 2
  }
  parts.push(`atempo=${s.toFixed(4)}`)
  return parts.join(',')
}

interface RenderBody {
  inputs: MontageInput[]
  /** (правка 846) настройки секвенции; не заданы = прежнее поведение */
  seq?: MontageSeq | null
  /** (правка 720 v8) общая громкость таймлайна, 0..1; применяется к mixes-output */
  masterVol?: number | string | null
  /** куда положить результат (подпапка output), по умолчанию — общая */
  outSubfolder?: string
}

/** Значение подрезки в секундах или null (нет подрезки) */
function parseSec(v: number | string | null | undefined): number | null {
  if (v == null || v === '') return null
  const n = typeof v === 'number' ? v : parseFloat(v)
  if (!Number.isFinite(n) || n <= 0) return null
  return n
}

/** (правка 720 v8) значение громкости: 0..1, некорректное = 1 */
function parseVol(v: number | string | null | undefined): number {
  if (v == null || v === '') return 1
  const n = typeof v === 'number' ? v : parseFloat(v)
  if (!Number.isFinite(n)) return 1
  return Math.max(0, Math.min(1, n))
}

/** (правка 720 v11) длительность аудиоперехода, сек; 0/пусто = выключен */
function parseFade(v: number | string | null | undefined): number {
  if (v == null || v === '') return 0
  const n = typeof v === 'number' ? v : parseFloat(v)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(n, 30)
}

/** Данные probe одного входного клипа */
interface ProbeInfo {
  duration: number
  width: number
  height: number
  hasAudio: boolean
}

/**
 * Probe через `ffmpeg -i` (парсинг stderr) — тот же прием, что в
 * /api/comfy/concat (правка 359: разрешение только из строки видеопотока).
 */
async function probeVideo(ffmpeg: string, filePath: string): Promise<ProbeInfo | null> {
  let stderr = ''
  try {
    const r = await execFileAsync(ffmpeg, ['-hide_banner', '-i', filePath], { timeout: 15_000 })
    stderr = r.stderr ?? ''
  } catch (e) {
    stderr = (e as { stderr?: string }).stderr ?? ''
  }

  const durM = /Duration:\s*(\d+):(\d{2}):(\d{2}\.\d{2})/.exec(stderr)
  const duration = durM
    ? Number(durM[1]) * 3600 + Number(durM[2]) * 60 + Number(durM[3])
    : 0

  const videoLine = stderr.split('\n').find((l) => /Stream #.*Video:/.test(l)) ?? ''
  const resM = /(\d{2,5})x(\d{2,5})/.exec(videoLine)
  const width = resM ? parseInt(resM[1], 10) : 0
  const height = resM ? parseInt(resM[2], 10) : 0
  const hasAudio = /Stream #.*Audio:/.test(stderr)

  if (duration <= 0 || width <= 0 || height <= 0) return null
  return { duration, width, height, hasAudio }
}

/**
 * (правка 836) Рекурсивный поиск ВСЕХ файлов с таким именем в подпапках output
 * (глубина ≤ depth). Раньше брали первый попавшийся и игнорировали subfolder —
 * из-за чего в сборку мог попасть ДРУГОЙ видеофайл с тем же именем.
 */
async function findAllRecursive(root: string, fileName: string, depth: number, limit = 8): Promise<string[]> {
  const hits: string[] = []
  const walk = async (dir: string, d: number): Promise<void> => {
    if (d < 0 || hits.length >= limit) return
    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.isFile() && e.name === fileName) {
        hits.push(path.join(dir, e.name))
        if (hits.length >= limit) return
      }
    }
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.')) {
        await walk(path.join(dir, e.name), d - 1)
        if (hits.length >= limit) return
      }
    }
  }
  await walk(root, depth)
  return hits
}

export async function POST(req: Request) {
  let releaseBusy: (() => void) | null = null
  try {
    let body: RenderBody
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ error: 'Некорректное тело запроса' }, { status: 400 })
    }
    const inputs = Array.isArray(body.inputs) ? body.inputs : []
    // (правка 864) сборка из одного шота — тоже сборка (перекодировка,
    // эффекты, скорость, канва секвенции); ругаемся только на пустой таймлайн
    if (!inputs.length) {
      return NextResponse.json({ error: 'Добавьте на таймлайн хотя бы один шот' }, { status: 400 })
    }
    if (inputs.length > 60) {
      return NextResponse.json({ error: 'Слишком много шотов (максимум 60)' }, { status: 400 })
    }

    // (правка 834) single-flight: параллельные сборки давали одно имя результата,
    // и ffmpeg с -y перезаписывал чужой файл (гонка existsSync → запись)
    if (renderBusy) {
      return NextResponse.json({ error: 'Сборка уже выполняется — дождитесь окончания' }, { status: 409 })
    }
    renderBusy = true
    releaseBusy = () => { renderBusy = false }

    const cfg = getAppConfig()
    const outputDir = cfg.outputDir
    const outputRoot = path.resolve(outputDir)
    if (!outputDir || !existsSync(outputDir)) {
      return NextResponse.json({ error: 'Не найдена папка output ComfyUI. Запустите ComfyUI.' }, { status: 500 })
    }

    const ffmpeg = await resolveFfmpeg()
    if (!ffmpeg) {
      return NextResponse.json({ error: 'FFmpeg не найден (runtime/ffmpeg).' }, { status: 500 })
    }

    // ---- resolve + проверка входов (с защитой от path traversal) ----
    const items: Array<{
      src: string
      start: number | null
      end: number | null
      vol: number
      fi: number
      fo: number
      speed: number // (правка 848)
      fx: ShotFx // (правка 848)
      /** (правка 847) переход к СЛЕДУЮЩЕМУ шоту (null = жёсткая склейка) */
      tr: TransitionSpec | null
      /** (правка 860) пауза (пустое место на таймлайне) перед этим клипом, сек */
      gap: number
    }> = []
    for (const inp of inputs) {
      const name = String(inp.name || '')
      if (!name || name.includes('..') || /[\\/:]/.test(name)) {
        return NextResponse.json({ error: 'Некорректное имя файла' }, { status: 400 })
      }
      const sub = sanitizeFolderPath(inp.subfolder || '')
      const src = path.resolve(outputDir, ...(sub ? sub.split('/') : []), name)
      let final: string | null = null
      if (src.startsWith(outputRoot + path.sep) && existsSync(src)) {
        final = src
      } else {
        // (правка 836) файл мог лежать в другой подпапке. Ищем ВСЕ совпадения:
        // берём либо то, что в запрошенной папке, либо единственный найденный.
        // Раньше брался первый попавшийся по обходу — в сборку мог попасть ДРУГОЙ
        // видеофайл с тем же именем из чужой папки.
        const hits = await findAllRecursive(outputDir, name, 3)
        const wantDir = path.dirname(src)
        final = hits.find((h) => path.dirname(h) === wantDir) ?? (hits.length === 1 ? hits[0] : null)
        if (!final && hits.length > 1) {
          return NextResponse.json(
            { error: `Несколько файлов с именем ${name} в разных папках — обновите галерею` },
            { status: 409 },
          )
        }
      }
      if (!final) {
        return NextResponse.json({ error: `Файл не найден: ${name}` }, { status: 404 })
      }
      const start = parseSec(inp.trimStart)
      const end = parseSec(inp.trimEnd)
      if (start != null && end != null && end <= start) {
        return NextResponse.json({ error: `Подрезка конца больше начала в шоте ${name}` }, { status: 400 })
      }
      const rawGap = parseSec(inp.gap)
      items.push({
        src: final,
        start,
        end,
        vol: parseVol(inp.vol),
        fi: parseFade(inp.fadeIn),
        fo: parseFade(inp.fadeOut),
        speed: parseSpeed(inp.speed),
        fx: cleanFx(inp.fx),
        tr: cleanTransition(inp.tr),
        gap: rawGap && rawGap >= 0.02 ? Math.min(300, rawGap) : 0,
      })
    }

    // ---- probe всех входов; канва = ПЕРВЫЙ клип (даже) + 24fps ----
    // (правка 839) probe идёт параллельно (до 4 процессов): раньше 60 входов
    // давали ~1.26 с только на чтение метаданных перед началом кодирования.
    const probed: Array<ProbeInfo | null> = new Array(items.length).fill(null)
    {
      let next = 0
      const worker = async () => {
        while (next < items.length) {
          const i = next++
          probed[i] = await probeVideo(ffmpeg, items[i].src)
        }
      }
      await Promise.all(Array.from({ length: Math.min(4, items.length) }, worker))
    }
    const broken = probed.findIndex((p) => !p)
    if (broken >= 0) {
      return NextResponse.json({ error: `Не удалось прочитать видео: ${path.basename(items[broken].src)}` }, { status: 500 })
    }
    const infos: ProbeInfo[] = probed as ProbeInfo[]
    // (правка 846) канва секвенции: w/h = 0 ⇒ размер первого клипа (как раньше),
    // fps = 0 ⇒ 24, fit = stretch (как раньше), quality = standard (crf 20)
    const seqIn: MontageSeq = body.seq && typeof body.seq === 'object' ? body.seq : {}
    const nInt = (v: unknown, lo: number, hi: number): number => {
      const n = typeof v === 'number' ? v : Number(v)
      if (!Number.isFinite(n) || n <= 0) return 0
      return Math.min(hi, Math.max(lo, Math.round(n)))
    }
    const even = (n: number, fb: number) => (n % 2 === 0 ? n : fb)
    const rawW = nInt(seqIn.w, 16, 7680)
    const rawH = nInt(seqIn.h, 16, 4320)
    const evW = rawW ? even(rawW, rawW - 1) : even(infos[0].width, infos[0].width + 1)
    const evH = rawH ? even(rawH, rawH - 1) : even(infos[0].height, infos[0].height + 1)
    const FPS = nInt(seqIn.fps, 1, 120) || 24
    const FIT = ['stretch', 'cover', 'contain', 'blur'].includes(String(seqIn.fit)) ? String(seqIn.fit) : 'stretch'
    const QUAL = QUALITY[String(seqIn.quality)] ?? QUALITY.standard
    const masterVol = parseVol(body.masterVol)

    // ---- filter_complex: подрезка + скорость + эффекты + канва секвенции ----
    const parts: string[] = []
    const durs: number[] = [] // (правка 847) длительности шотов после скорости
    let totalOut = 0 // (правка 839) суммарная длительность результата — для прогресса
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      const info = infos[i]
      const s = it.start ?? 0
      // (правка 835) подрезки сверяются с РЕАЛЬНОЙ длительностью клипа: раньше
      // старт за концом давал пустой поток (шот молча исчезал из сборки), а у
      // клипа без звука уходил в минус и ffmpeg падал с техническим текстом.
      if (s >= info.duration - 0.05) {
        return NextResponse.json(
          { error: `Шот ${path.basename(it.src)}: начало подрезки ${s.toFixed(2)} с за пределами клипа (${info.duration.toFixed(2)} с)` },
          { status: 400 },
        )
      }
      let e: number | null = it.end != null ? Math.min(it.end, info.duration) : null
      if (e != null && e - s < 0.05) e = s + 0.05 // минимальная осмысленная длина, а не отмена подрезки
      if (e != null && e > info.duration) e = info.duration
      // (правка 848) скорость: шот на 2× короче, на 0.5× длиннее
      const dur = ((e ?? info.duration) - s) / it.speed
      // (правка 847) переход не может съесть шот целиком: xfade снимает у шота
      // голову (переход слева) и хвост (переход справа), поэтому сумма обоих
      // обязана оставлять шоту материал
      const inD = i > 0 ? (items[i - 1].tr?.dur ?? 0) : 0
      const outD = it.tr?.dur ?? 0
      if ((inD > 0 || outD > 0) && dur <= inD + outD + 0.05) {
        return NextResponse.json(
          {
            error: `Шот ${path.basename(it.src)}: переходы ${inD.toFixed(2)} с + ${outD.toFixed(2)} с длиннее шота (${dur.toFixed(2)} с)`,
          },
          { status: 400 },
        )
      }
      durs[i] = dur
      totalOut += dur
      const trimV = s > 0.001 || e != null ? `trim=start=${s.toFixed(4)}${e != null ? `:end=${e.toFixed(4)}` : ''},` : ''
      // (правка 848, 859, 861) картинные эффекты шота: отражения, 5-точечные 2D-кривые,
      // температура, HUE, яркость/контраст/насыщенность, радиальная дисперсия (центр 0, к краям), шум
      const fxv: string[] = []
      if (it.fx.flipH) fxv.push('hflip')
      if (it.fx.flipV) fxv.push('vflip')
      if (it.fx.gray) fxv.push('hue=s=0')
      if (it.fx.curves) {
        const fmtCurve = (raw: CurveSpec) => {
          const nodes = cleanCurveChannel(raw)
          if (!nodes) return ''
          const pts: string[] = []
          if (nodes[0][0] > 0.002) pts.push(`0/${nodes[0][1].toFixed(3)}`)
          for (const [x, y] of nodes) pts.push(`${x.toFixed(3)}/${y.toFixed(3)}`)
          if (nodes[nodes.length - 1][0] < 0.998) pts.push(`1/${nodes[nodes.length - 1][1].toFixed(3)}`)
          return pts.join(' ')
        }
        const cparts: string[] = []
        if (it.fx.curves.master) { const s = fmtCurve(it.fx.curves.master); if (s) cparts.push(`all='${s}'`) }
        if (it.fx.curves.r) { const s = fmtCurve(it.fx.curves.r); if (s) cparts.push(`r='${s}'`) }
        if (it.fx.curves.g) { const s = fmtCurve(it.fx.curves.g); if (s) cparts.push(`g='${s}'`) }
        if (it.fx.curves.b) { const s = fmtCurve(it.fx.curves.b); if (s) cparts.push(`b='${s}'`) }
        if (cparts.length) fxv.push(`curves=${cparts.join(':')}`)
      }
      if (it.fx.temp && Math.abs(it.fx.temp) >= 1) {
        const t = +(it.fx.temp / 250).toFixed(3)
        const g = +(t * 0.2).toFixed(3)
        const th = +(t * 0.6).toFixed(3)
        fxv.push(`colorbalance=rs=${t}:gs=${g}:bs=${-t}:rm=${t}:gm=${g}:bm=${-t}:rh=${th}:bh=${-th}`)
      }
      if (it.fx.dispersion && it.fx.dispersion > 0) {
        // (правка 861, 862) радиальная дисперсия как в DaVinci Resolve: центр кадра
        // не затрагивается (смещение = 0), а к краям и углам R и B расходятся.
        // Кадр предварительно чуть увеличиваем, а после эффекта обрезаем обратно:
        // смещённая кромка уходит за кадр и не оставляет цветной «рамки».
        const k1 = +(it.fx.dispersion * 0.0018).toFixed(4)
        const k2 = +(it.fx.dispersion * 0.001).toFixed(4)
        // (правка 862) запас кадра считаем от силы линзы: смещение кромки равно
        // (k1+k2) от половины меньшей стороны, поэтому zoom = 1 + k1 + k2 + запас.
        // Фиксированные 1.14 не хватало на максимальной дисперсии — оставалась рамка.
        const zoom = Math.min(1.5, 1 + k1 + k2 + 0.01)
        const upW = Math.max(2, Math.round((info.width * zoom) / 2) * 2)
        const upH = Math.max(2, Math.round((info.height * zoom) / 2) * 2)
        const cropW = Math.max(2, info.width - (info.width % 2))
        const cropH = Math.max(2, info.height - (info.height % 2))
        // (правка 863) extractplanes отдаёт каналы в порядке R,G,B, а не в порядке
        // букв «g+b+r»: раньше R/B подмешивались в чужие плоскости и рендер зеленел.
        // Раскладка mergeplanes: G (без сдвига), B (сдвиг +k), R (сдвиг -k).
        fxv.push(
          `scale=${upW}:${upH},format=gbrp,extractplanes=g+b+r[pg${i}][pb${i}][pr${i}];[pg${i}]lenscorrection=k1=${-k1}:k2=${-k2}[sr${i}];[pr${i}]lenscorrection=k1=${k1}:k2=${k2}[sb${i}];[pb${i}][sb${i}][sr${i}]mergeplanes=0x001020:gbrp,crop=${cropW}:${cropH}`,
        )
      }
      if (it.fx.hue && Math.abs(it.fx.hue) >= 1) {
        fxv.push(`format=yuv420p,hue=h=${it.fx.hue.toFixed(1)}`)
      }
      const satv = it.fx.sat ?? 1
      if (it.fx.bright || it.fx.contrast || satv !== 1) {
        const eq: string[] = []
        if (it.fx.bright) eq.push(`brightness=${it.fx.bright.toFixed(3)}`)
        if (it.fx.contrast) eq.push(`contrast=${(1 + it.fx.contrast).toFixed(3)}`)
        eq.push(`saturation=${satv.toFixed(3)}`)
        fxv.push(`format=yuv420p,eq=${eq.join(':')}`)
      }
      if (it.fx.grain && it.fx.grain > 0) {
        const strength = Math.max(1, Math.round(it.fx.grain * 0.45))
        fxv.push(`format=yuv420p,noise=alls=${strength}:allf=t+u`)
      }
      // (правка 848) setpts делит на скорость: (PTS-STARTPTS)/speed
      const pts = it.speed !== 1 ? `setpts=(PTS-STARTPTS)/${it.speed}` : 'setpts=PTS-STARTPTS'
      const fxStr = fxv.length ? `,${fxv.join(',')}` : ''
      const tail = `fps=${FPS},format=yuv420p[v${i}]`
      if (FIT === 'blur' && (evW !== info.width || evH !== info.height)) {
        // (правка 846) вписывание с размытой заливкой: split → размытый cover-фон
        // + кадр по центру. Метки с суффиксом i, иначе два таких шота конфликтуют.
        const k = Math.min(evW / info.width, evH / info.height)
        const fw = Math.max(2, Math.floor((info.width * k) / 2) * 2)
        const fh = Math.max(2, Math.floor((info.height * k) / 2) * 2)
        parts.push(`[${i}:v]${trimV}${pts}${fxStr},split=2[bg${i}][fg${i}]`)
        parts.push(`[bg${i}]scale=${evW}:${evH}:force_original_aspect_ratio=increase,crop=${evW}:${evH},gblur=sigma=20[bgz${i}]`)
        parts.push(`[fg${i}]scale=${fw}:${fh}[fgz${i}]`)
        parts.push(`[bgz${i}][fgz${i}]overlay=(W-w)/2:(H-h)/2,setsar=1,${tail}`)
      } else {
        // (правка 846) stretch = прежнее поведение; cover = залить кадр кропом;
        // contain = вписать с полями. setsar=1 обязателен для xfade (правка 847)
        let fit = `scale=${evW}:${evH}`
        if (FIT === 'cover') fit = `scale=${evW}:${evH}:force_original_aspect_ratio=increase,crop=${evW}:${evH}`
        else if (FIT === 'contain') fit = `scale=${evW}:${evH}:force_original_aspect_ratio=decrease,pad=${evW}:${evH}:(ow-iw)/2:(oh-ih)/2`
        parts.push(`[${i}:v]${trimV}${pts}${fxStr},${fit},setsar=1,${tail}`)
      }
      if (info.hasAudio) {
        const at = s > 0.001 || e != null
          ? `atrim=start=${s.toFixed(4)}${e != null ? `:end=${e.toFixed(4)}` : ''},asetpts=PTS-STARTPTS,`
          : ''
        // (правка 720 v11) фейды звука клипа (после asetpts локальное время начинается с 0)
        const fi = Math.min(it.fi, Math.max(0, dur - 0.01))
        const fo = Math.min(it.fo, Math.max(0, dur - 0.01))
        const af = (fi > 0.01 ? `afade=t=in:st=0:d=${fi.toFixed(4)},` : '')
          + (fo > 0.01 ? `afade=t=out:st=${Math.max(0, dur - fo).toFixed(4)}:d=${fo.toFixed(4)},` : '')
        const av = it.vol !== 1 ? `volume=${it.vol.toFixed(4)},` : ''
        // (правка 848) скорость звука: atempo сохраняет высоту тона
        const spd = it.speed !== 1 ? `${atempoChain(it.speed)},` : ''
        parts.push(`[${i}:a]${at}${af}${av}${spd}aresample=44100[a${i}]`)
      } else {
        // нет звука — генерируем тишину той же длительности
        parts.push(`anullsrc=r=44100:cl=stereo,atrim=duration=${dur.toFixed(4)}[a${i}]`)
      }
    }
    // (правка 847) склейка: стыки с переходом — цепочки xfade (видео) +
    // acrossfade (звук), между цепочками-«ранами» — обычный concat. Разбивка на
    // раны нужна потому, что xfade работает только попарно и варит обе ветки
    // в память, а жёсткий стык дешевле и не требует нахлёста материала.
    const runs: Array<{ idx: number[]; tr: TransitionSpec[] }> = []
    let curIdx = [0]
    let curTr: TransitionSpec[] = []
    for (let i = 0; i < items.length - 1; i++) {
      const t = items[i].tr
      if (!t) {
        runs.push({ idx: curIdx, tr: curTr })
        curIdx = [i + 1]
        curTr = []
      } else {
        curIdx.push(i + 1)
        curTr.push(t)
      }
    }
    runs.push({ idx: curIdx, tr: curTr })

    const runV: string[] = []
    const runA: string[] = []
    for (let r = 0; r < runs.length; r++) {
      const { idx, tr } = runs[r]
      // (правка 860) если перед первым шотом рана есть пустой промежуток (gap > 0),
      // вставляем перед ним сегмент чёрного кадра и тишины той же длительности
      const g0 = items[idx[0]].gap
      if (g0 >= 0.02) {
        parts.push(`color=c=black:s=${evW}x${evH}:r=${FPS}:d=${g0.toFixed(4)},setsar=1,format=yuv420p[vg${idx[0]}]`)
        parts.push(`anullsrc=r=44100:cl=stereo,atrim=duration=${g0.toFixed(4)}[ag${idx[0]}]`)
        runV.push(`vg${idx[0]}`)
        runA.push(`ag${idx[0]}`)
        totalOut += g0
      }
      if (idx.length === 1) {
        runV.push(`v${idx[0]}`)
        runA.push(`a${idx[0]}`)
        continue
      }
      let vprev = `v${idx[0]}`
      let aprev = `a${idx[0]}`
      let cum = durs[idx[0]]
      for (let k = 1; k < idx.length; k++) {
        const t = tr[k - 1]
        // offset = Σ длин шотов до k − Σ переходов до k включительно: xfade
        // начинает нахлёст в этой точке, а не после конца первой ветки
        const off = cum - t.dur
        const vn = `vx${r}_${k}`
        const an = `ax${r}_${k}`
        parts.push(`[${vprev}][v${idx[k]}]xfade=transition=${t.type}:duration=${t.dur.toFixed(3)}:offset=${off.toFixed(3)}[${vn}]`)
        parts.push(`[${aprev}][a${idx[k]}]acrossfade=d=${t.dur.toFixed(3)}[${an}]`)
        totalOut -= t.dur
        vprev = vn
        aprev = an
        cum += durs[idx[k]]
      }
      runV.push(vprev)
      runA.push(aprev)
    }
    const pairs = runV.map((v, r) => `[${v}][${runA[r]}]`).join('')
    parts.push(`${pairs}concat=n=${runV.length}:v=1:a=1[vout][aout]`)
    let aOutTag = 'aout'
    if (masterVol !== 1) {
      parts.push(`[aout]volume=${masterVol.toFixed(4)}[aoutm]`)
      aOutTag = 'aoutm'
    }

    // ---- куда писать результат (счётчик в имени) ----
    const outSub = sanitizeFolderPath(body.outSubfolder || '')
    const destDir = path.join(outputDir, ...(outSub ? outSub.split('/') : []))
    // (правка 837) сравнение с path.sep: без него проходил бы сосед вроде output_bak
    const destAbs = path.resolve(destDir)
    if (destAbs !== outputRoot && !destAbs.startsWith(outputRoot + path.sep)) {
      return NextResponse.json({ error: 'Некорректная папка результата' }, { status: 400 })
    }
    await fs.mkdir(destDir, { recursive: true })
    // (правка 834) имя резервируется атомарным созданием файла ('wx'), а не
    // проверкой existsSync: между ней и записью ffmpeg другой запрос успевал
    // взять то же имя, и -y перезаписывал чужую готовую сборку.
    let outName = ''
    let outPath = ''
    for (let i = 1; i <= 999; i++) {
      const cand = `Minimax_Studio_montage_${i}.mp4`
      const candPath = path.join(destDir, cand)
      try {
        const h = await fs.open(candPath, 'wx')
        await h.close()
        outName = cand
        outPath = candPath
        break
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      }
    }
    if (!outName) return NextResponse.json({ error: 'Слишком много файлов монтажа в выходной папке' }, { status: 500 })

    // ---- один проход: все входы + filter_complex ----
    // (правка 839) -progress pipe:1: прогресс кода времени читаем из stdout
    const args: string[] = ['-hide_banner', '-loglevel', 'error', '-progress', 'pipe:1', '-y']
    for (const it of items) args.push('-i', it.src)
    args.push(
      '-filter_complex', parts.join(';'),
      '-map', '[vout]', '-map', `[${aOutTag}]`,
      '-c:v', 'libx264', '-preset', QUAL.preset, '-crf', QUAL.crf,
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ar', '44100', '-ac', '2',
      '-movflags', '+faststart',
      outPath,
    )
    try {
      await runFfmpegEncode(ffmpeg, args, req.signal, totalOut, outName)
    } catch (err) {
      // (правка 838) убирать неполный файл: раньше битые/брошенные сборки
      // оставались в output и забивали счётчик имён
      await fs.rm(outPath, { force: true }).catch(() => {})
      if ((err as { aborted?: boolean }).aborted) {
        return NextResponse.json({ error: 'Сборка отменена' }, { status: 499 })
      }
      const stderr = (err as { stderr?: string }).stderr ?? (err instanceof Error ? err.message : String(err))
      return NextResponse.json({ error: `Ошибка сборки: ${String(stderr).slice(-500)}` }, { status: 500 })
    }
    let created = true
    try {
      created = (await fs.stat(outPath)).size > 0
    } catch {
      created = false
    }
    if (!created) {
      await fs.rm(outPath, { force: true }).catch(() => {})
      return NextResponse.json({ error: 'Файл результата не создан' }, { status: 500 })
    }

    return NextResponse.json({
      filename: outName,
      subfolder: outSub,
      url: `/api/comfy/file?filename=${encodeURIComponent(outName)}${outSub ? `&subfolder=${encodeURIComponent(outSub)}` : ''}&type=output`,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  } finally {
    // (правка 834) снимаем блокировку сборки на любом выходе
    releaseBusy?.()
  }
}
