'use client'

/**
 * (правка 720, v3..v5) MontageView — видеоредактор: таймлайн с линейкой,
 * плейхедом и воспроизведением всей сборки; галерея справа (drag&drop).
 * Сборка — POST /api/montage/render (жесткие склейки, без переходов).
 * v5: разрез клипа на плейхеде (S), полноэкранный превью (F), удаление
 * выделенного (Del), дубликат клипа (D), звук вкл/выкл в превью.
 * v7: двойной буфер превью — следующий клип прогревается в скрытом <video>,
 * на стыке буферы меняются видимостью: склейка без скачка и чёрного кадра.
 * v8: общая громкость таймлайна (мастер) + своя громкость у каждого клипа;
 * обе и в превью, и вплавляются в рендер (volume= у входа и после concat).
 * v9: параметры вкладки (состав, подрезки, громкости, зум...) сохраняются в
 * localStorage; исправлен обмен буферов на стыке клипов (swapTo по индексу
 * буфера, а не клипа) и старт нового клипа с позиции подрезки, а не с нуля.
 * v10: ревизия таймлайна — линейка без float-дрейфа шага; позиция прогрева
 * резервного буфера не теряется, если метаданные ещё не загружены.
 * v11: пауза остаётся на верном кадре (выделение следует за плейхедом);
 * кинополоса строится по подрезке (зум/разрез больше не растягивают и не
 * сжимают чужие кадры); полный экран — CSS-оверлей (в Electron нативный
 * fullscreen ненадёжен). Новое: отмена/повтор (Ctrl+Z/Ctrl+Shift+Z), магнит
 * плейхеда к краям клипов, покадровый шаг «,»/«.», сдвиг клипа Alt+стрелки,
 * вписывание таймлайна, «+» в галерее (вставка на плейхеде), фейды звука
 * клипа (и в превью, и в рендер через afade), луп текущего клипа, подсказка
 * длительности при подрезке, копирование пути готового файла.
 * v12 (правки 840-845): плейхед при игре двигается через ref без ре-рендера
 * всей вкладки на каждый кадр; кинополосы чистятся за удалёнными шотами;
 * detached <video> выгружаются, setState после unmount нет; ссылки на удалённые
 * файлы галереи снимаются с таймлайна; снимок истории сборки откатывается при
 * ошибке; кнопка «Собрать» показывает прогресс сборки (GET /api/montage/render).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  ClapperboardIcon,
  CopyIcon,
  DownloadIcon,
  EyeIcon,
  EyeOffIcon,
  FilmIcon,
  FrameIcon,
  LinkIcon,
  MagnetIcon,
  // (правка 874) кнопки «+ слой» и «+ аудио»
  LayersIcon,
  MusicIcon,
  MaximizeIcon,
  MinimizeIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  Redo2Icon,
  Repeat1Icon,
  RepeatIcon,
  ScissorsIcon,
  SkipBackIcon,
  TrashIcon,
  Undo2Icon,
  Volume2Icon,
  VolumeXIcon,
  Wand2Icon, // (правка 856) «В Refine» на клипе
  XIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useGalleryRefresh } from '@/lib/gallery-refresh-store'
import { useMontageTarget } from '@/lib/montage-target-store' // (правка 855)
import { useMontageReturn } from '@/lib/montage-return-store' // (правка 857)
import { useRefineTarget } from '@/lib/refine-target-store' // (правка 856)
import { useFsFullscreen } from '@/lib/use-fs-fullscreen' // (правка 869)
import { useVideoGallery } from './use-video-gallery'
import type { VideoGalleryFile } from './video-gallery-grid'

/** Один шот монтажной последовательности (порядок = позиция в списке) */
type MontageShot = {
  key: string
  filename: string
  subfolder: string
  url: string
  name: string
  /** Подрезка начала, сек; пусто = с начала */
  trimStart: string
  /** Подрезка конца, сек; пусто/0 = до конца */
  trimEnd: string
  /** Полная длительность исходника, сек (0 = неизвестна) */
  duration: number
  /** Громкость клипа, 0..1 (вплавляется в рендер); не задана = 1 */
  vol?: number
  /** (правка 720 v11) плавное появление звука клипа, сек; 0 = нет */
  fadeIn?: number
  /** (правка 720 v11) плавное затухание звука клипа в конце, сек; 0 = нет */
  fadeOut?: number
  /** (правка 849) скорость клипа, 0.25..4; не задана = 1 (правка 848 бэкенда) */
  speed?: number
  /** (правка 849, 859) картинные эффекты клипа */
  fx?: ShotFx
  /** (правка 860) пустой промежуток (пауза, сек >= 0) перед этим клипом на таймлайне */
  gap?: number
}

// (правка 874, 877) клип видео-слоя (дорожки V2+): лежит поверх базовой дорожки в окне [at, at+эфф.длит.).
// trimStart/trimEnd — числа (сек), speed — множитель; fit — как кадрируется в кадре;
// звук слоя смешивается с базой так же, как у клипа базовой дорожки (громкость/фейды/mute)
type LayerClip = {
  key: string
  filename: string
  subfolder?: string
  name: string
  url: string // /api/comfy/file?... — для превью
  at: number
  track: number // >=1; меньше — ниже; верхний перекрывает нижние
  trimStart: number
  trimEnd: number
  speed: number
  fit: 'stretch' | 'cover' | 'contain' | 'blur'
  duration: number
  hidden?: boolean
  /** (правка 876) картинные эффекты слоя — те же, что у клипа базовой дорожки */
  fx?: ShotFx
  /** (правка 877) громкость звука слоя, 0..1; не задана = 1 */
  vol?: number
  /** (правка 877) плавное появление звука слоя, сек; 0 = нет */
  fadeIn?: number
  /** (правка 877) плавное затухание звука слоя в конце, сек; 0 = нет */
  fadeOut?: number
  /** (правка 877) выключить звук слоя (картинка остаётся) */
  muted?: boolean
}

// (правка 874) аудиоклип звуковой дорожки (A1+): файл импортирован на сервер (.montage-audio)
type AudioClip = {
  key: string
  file: string // имя файла на сервере — для рендера
  name: string
  url: string // /api/montage/audio?f=... — для превью
  at: number
  track: number // >=1
  trimStart: number
  trimEnd: number
  vol: number // % (100 = без изменения)
  fadeIn: number
  fadeOut: number
  duration: number
  muted?: boolean
}

/** (правка 874, 883) снимок таймлайна для истории (отмена/повтор), включая число дорожек */
type HistSnap = {
  shots: MontageShot[]
  layers: LayerClip[]
  audios: AudioClip[]
  layerTracks?: number
  audioTracks?: number
}

/** (правка 859, 861) 5 узловых точек 2D-кривой [x, y] (0..1):
 *  0: Чёрные (0,0), 1: Тени (0.25,0.25), 2: Средние (0.5,0.5), 3: Света (0.75,0.75), 4: Белые (1,1).
 *  Каждая точка двигается и вверх/вниз (Y), и влево/вправо (X), как в DaVinci Resolve. */
type CurveNode = [number, number]
type CurvePts = [CurveNode, CurveNode, CurveNode, CurveNode, CurveNode]

type ShotCurves = {
  master?: CurvePts
  r?: CurvePts
  g?: CurvePts
  b?: CurvePts
}

/** (правка 884) ключи индивидуального байпаса каждого эффекта */
type FxBypassKey = 'flip' | 'curves' | 'temp' | 'hue' | 'bright' | 'contrast' | 'sat' | 'dispersion' | 'grain'

/** (правка 849, 859, 861, 884) картинные эффекты шота (совпадают с полем fx в /api/montage/render) */
type ShotFx = {
  flipH?: boolean
  flipV?: boolean
  /** яркость −0.5..0.5 */
  bright?: number
  /** контраст −0.5..0.5 */
  contrast?: number
  /** насыщенность 0..2 */
  sat?: number
  /** (правка 861) температура −100..100 (холоднее..теплее) */
  temp?: number
  /** (правка 861) сдвиг оттенка HUE −180..180° */
  hue?: number
  /** (правка 859, 861) 5-точечные 2D-кривые цвета (Мастер RGB и поканально R/G/B) */
  curves?: ShotCurves
  /** (правка 859, 861) радиальная хроматическая дисперсия (центр чистый, к краям до 20) */
  dispersion?: number
  /** (правка 884) радиальная маска чистого центра для дисперсии, 0..90% (по умолчанию 35%) */
  dispersionMask?: number
  /** (правка 859) киношный анимированный шум (зерно 35mm), 0..100% */
  grain?: number
  /** (правка 884) общий байпас всех эффектов клипа для сравнения До/После */
  bypass?: boolean
  /** (правка 884) индивидуальный байпас каждого эффекта отдельно */
  bypassed?: Partial<Record<FxBypassKey, boolean>>
}

const DEFAULT_CURVE: CurvePts = [
  [0, 0],
  [0.25, 0.25],
  [0.5, 0.5],
  [0.75, 0.75],
  [1, 1],
]

/** (правка 861) конвертирует как 5-точечный массив [[x,y],...], так и старый 3-точечный [y1,y2,y3] в CurvePts */
function normalizeCurvePts(raw?: unknown): CurvePts {
  if (!Array.isArray(raw)) return DEFAULT_CURVE.map(([x, y]) => [x, y]) as CurvePts
  if (raw.length === 3 && typeof raw[0] === 'number') {
    return [
      [0, 0],
      [0.25, clamp01(Number(raw[0]))],
      [0.5, clamp01(Number(raw[1]))],
      [0.75, clamp01(Number(raw[2]))],
      [1, 1],
    ]
  }
  if (raw.length === 5 && Array.isArray(raw[0])) {
    return raw.map((p, i) => {
      const def = i * 0.25
      const x = Array.isArray(p) && Number.isFinite(p[0]) ? clamp01(Number(p[0])) : def
      const y = Array.isArray(p) && Number.isFinite(p[1]) ? clamp01(Number(p[1])) : def
      return [x, y] as CurveNode
    }) as CurvePts
  }
  return DEFAULT_CURVE.map(([x, y]) => [x, y]) as CurvePts
}

/** (правка 849) настройки секвенции (правка 846 бэкенда) */
type SeqSettings = {
  /** 0 = «как у первого клипа» */
  w: number
  h: number
  /** 0 = 24 к/с */
  fps: number
  fit: 'stretch' | 'cover' | 'contain' | 'blur'
  quality: 'high' | 'standard' | 'fast'
  /** (правка 882) кодировщик результата */
  codec: 'auto' | 'cpu' | 'gpu'
}

const DEFAULT_SEQ: SeqSettings = { w: 0, h: 0, fps: 0, fit: 'stretch', quality: 'standard', codec: 'auto' }

/** (правка 849) пресеты секвенции: разрешение + соотношения сторон */
const SEQ_SIZES: Array<{ label: string; w: number; h: number }> = [
  { label: 'Авто (как первый клип)', w: 0, h: 0 },
  { label: '1920×1080 (16:9)', w: 1920, h: 1080 },
  { label: '1280×720 (16:9)', w: 1280, h: 720 },
  { label: '1080×1920 (9:16, Reels/Shorts)', w: 1080, h: 1920 },
  { label: '1080×1080 (1:1)', w: 1080, h: 1080 },
]

/** (правка 849) пресеты скорости клипа */
const SPEED_STEPS = [0.25, 0.5, 1, 1.5, 2, 4]

/** строка последовательности: шот + его место на шкале сборки (с учётом паузы gap перед ним) */
type SeqRow = { shot: MontageShot; r: { start: number; end: number }; offset: number; len: number; gap: number }

let shotCounter = 0
const newShotKey = () => `shot-${Date.now()}-${++shotCounter}`
// (правка 874) ключи клипов слоёв и аудио (тот же счётчик — ключи не пересекаются)
const newLayerKey = () => `lay-${Date.now()}-${++shotCounter}`
const newAudioKey = () => `aud-${Date.now()}-${++shotCounter}`

const MAX_SHOTS = 60
/** (правка 874) мягкие защитные лимиты для слоёв и аудио (как DaVinci, но с крышкой) */
const MAX_LAYER_CLIPS = 40
const MAX_AUDIO_CLIPS = 60
const MAX_TRACKS = 12

/** за сколько секунд до конца клипа прогревать резервный буфер превью */
const PREWARM = 1.5

const showToast = (msg: string, kind: 'success' | 'error' = 'success') =>
  kind === 'error' ? toast.error(msg) : toast.success(msg)

const clamp01 = (n: number) => Math.max(0, Math.min(1, n))

/**
 * (правка 720 v9) параметры вкладки переживают переключение вкладок и
 * перезапуск: состав таймлайна и настройки сохраняем в localStorage.
 */
const LS_KEY = 'h3_montage_v1'

type MontageSaved = {
  shots?: MontageShot[]
  // (правка 874) видео-слои и звуковые дорожки
  layers?: LayerClip[]
  audios?: AudioClip[]
  // (правка 883) открытые пустые дорожки V2+ и A1+
  layerTracks?: number
  audioTracks?: number
  selectedKey?: string | null
  folderFilter?: string
  pps?: number
  loop?: boolean
  trackH?: number
  vScale?: number
  masterVol?: number
  muted?: boolean
  /** (правка 720 v11) новые переключатели транспорта */
  snap?: boolean
  loopClip?: boolean
  /** (правка 849) настройки секвенции */
  seq?: SeqSettings
}

/** «12,5» → 12.5; некорректное → null */
function parseSec(raw: string): number | null {
  const s = (raw || '').trim().replace(',', '.')
  if (!s) return null
  const n = Number(s)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** время мм:сс.т для транспорта */
function fmtT(sec: number): string {
  const s = Math.max(0, sec)
  const m = Math.floor(s / 60)
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`
}

/** шаг подписей линейки: чтобы между рисками было не меньше 80 px */
const RULER_STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200]
function pickStep(total: number, pps: number): number {
  for (const st of RULER_STEPS) if (st * pps >= 80 && total / st <= 300) return st
  return RULER_STEPS[RULER_STEPS.length - 1]
}

/** Длительность видео через метаданные <video> (декодирование не запускается) */
function getVideoDuration(url: string): Promise<number> {
  return new Promise((resolve) => {
    const v = document.createElement('video')
    v.preload = 'metadata'
    // (правка 842) отвязываем элемент после ожидания: раньше detached <video>
    // с src оставался жить в JS и держал медиа-ресурс/соединение
    const drop = () => {
      v.onloadedmetadata = null
      v.onerror = null
      v.removeAttribute('src')
      v.load()
    }
    v.onloadedmetadata = () => {
      const d = Number.isFinite(v.duration) ? v.duration : 0
      drop()
      resolve(d)
    }
    v.onerror = () => {
      drop()
      resolve(0)
    }
    v.src = url
  })
}

/** эффективный диапазон показа шота на таймлайне (с учётом trim) */
function effRange(s: MontageShot): { start: number; end: number } {
  const st = parseSec(s.trimStart)
  const en = parseSec(s.trimEnd)
  const start = st && st > 0 ? st : 0
  const full = s.duration || 0
  let end = full || (en && en > start ? en : start + 2)
  if (en && en > 0) end = Math.min(end, en)
  if (end <= start) end = start + 0.2
  return { start, end }
}

/** (правка 859, 861) отличается ли канал 5-точечной кривой от линейной диагонали */
function isCurveActive(raw?: unknown): boolean {
  if (!raw) return false
  const pts = normalizeCurvePts(raw)
  return pts.some(([x, y], i) => Math.abs(x - i * 0.25) > 0.004 || Math.abs(y - i * 0.25) > 0.004)
}

function hasCurves(c?: ShotCurves): boolean {
  if (!c) return false
  return isCurveActive(c.master) || isCurveActive(c.r) || isCurveActive(c.g) || isCurveActive(c.b)
}

/**
 * (правка 859, 861) Монотонная кубическая интерполяция (Фрич–Карлсон, как в DaVinci Resolve)
 * по 5 узлам [x_i, y_i] с произвольными X и Y (0 <= x0 < x1 < x2 < x3 < x4 <= 1).
 * Слева от x0 удерживается y0 (точка чёрного), справа от x4 — y4 (точка белого).
 */
function evalCurve(raw: unknown, x: number): number {
  if (!raw || !isCurveActive(raw)) return x
  const pts = normalizeCurvePts(raw)
  const cx = Math.max(0, Math.min(1, x))
  if (cx <= pts[0][0]) return pts[0][1]
  if (cx >= pts[4][0]) return pts[4][1]

  const n = 5
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const dx: number[] = []
  const dy: number[] = []
  const m: number[] = []
  for (let i = 0; i < n - 1; i++) {
    const dxi = Math.max(0.001, xs[i + 1] - xs[i])
    dx.push(dxi)
    dy.push(ys[i + 1] - ys[i])
    m.push(dy[i] / dxi)
  }
  const tangents: number[] = [m[0]]
  for (let i = 1; i < n - 1; i++) {
    if (m[i - 1] * m[i] <= 0) {
      tangents.push(0)
    } else {
      const w1 = 2 * dx[i] + dx[i - 1]
      const w2 = dx[i] + 2 * dx[i - 1]
      tangents.push((w1 + w2) / (w1 / m[i - 1] + w2 / m[i]))
    }
  }
  tangents.push(m[n - 2])

  let k = 0
  while (k < n - 2 && cx > xs[k + 1]) k++
  const h = dx[k]
  const t = (cx - xs[k]) / h
  const t2 = t * t
  const t3 = t2 * t
  const h00 = 2 * t3 - 3 * t2 + 1
  const h10 = t3 - 2 * t2 + t
  const h01 = -2 * t3 + 3 * t2
  const h11 = t3 - t2
  const v = h00 * ys[k] + h10 * h * tangents[k] + h01 * ys[k + 1] + h11 * h * tangents[k + 1]
  return Math.max(0, Math.min(1, v))
}

/** (правка 859, 861) строит строку из 17 значений 0..1 для SVG <feFuncR/G/B type="table"> с учётом температуры */
function buildChannelTable(master?: CurvePts, ch?: CurvePts, tempShift = 0): string {
  const out: string[] = []
  for (let i = 0; i <= 16; i++) {
    const x = i / 16
    let v = evalCurve(master, evalCurve(ch, x))
    if (tempShift !== 0) {
      // мягкий сдвиг баланса белого с сохранением 0 и 1 (колокол синуса/параболы)
      v = Math.max(0, Math.min(1, v + tempShift * (0.35 + 0.65 * Math.sin(Math.PI * v))))
    }
    out.push(v.toFixed(3))
  }
  return out.join(' ')
}

/** (правка 859, 861) SVG path кривой канала на канве WxH для редактора кривых */
function buildCurveSvgPath(pts: CurvePts | undefined, W: number, H: number): string {
  const steps = 40
  const parts: string[] = []
  for (let i = 0; i <= steps; i++) {
    const x = i / steps
    const y = evalCurve(pts, x)
    const px = (x * W).toFixed(1)
    const py = ((1 - y) * H).toFixed(1)
    parts.push(`${i === 0 ? 'M' : 'L'}${px},${py}`)
  }
  return parts.join(' ')
}

/** (правка 850, 859, 861) есть ли у шота хотя бы один активный эффект */
function hasFx(fx?: ShotFx): boolean {
  if (!fx) return false
  return !!(
    fx.flipH ||
    fx.flipV ||
    fx.bright ||
    fx.contrast ||
    (fx.sat !== undefined && fx.sat !== 1) ||
    (fx.temp && Math.abs(fx.temp) >= 1) ||
    (fx.hue && Math.abs(fx.hue) >= 1) ||
    hasCurves(fx.curves) ||
    (fx.dispersion && fx.dispersion > 0) ||
    (fx.grain && fx.grain > 0)
  )
}

/** (правка 859, 861, 884) глубокое клонирование объекта эффектов для копирования между клипами */
function cloneFx(fx?: ShotFx): ShotFx {
  if (!fx) return {}
  return {
    flipH: fx.flipH,
    flipV: fx.flipV,
    bright: fx.bright,
    contrast: fx.contrast,
    sat: fx.sat,
    temp: fx.temp,
    hue: fx.hue,
    dispersion: fx.dispersion,
    dispersionMask: fx.dispersionMask,
    grain: fx.grain,
    bypass: fx.bypass,
    bypassed: fx.bypassed ? { ...fx.bypassed } : undefined,
    curves: fx.curves
      ? {
          master: fx.curves.master ? normalizeCurvePts(fx.curves.master) : undefined,
          r: fx.curves.r ? normalizeCurvePts(fx.curves.r) : undefined,
          g: fx.curves.g ? normalizeCurvePts(fx.curves.g) : undefined,
          b: fx.curves.b ? normalizeCurvePts(fx.curves.b) : undefined,
        }
      : undefined,
  }
}

/** (правка 884) возвращает эффекты с учётом общего и поэффектного байпаса */
function effectiveFx(fx?: ShotFx): ShotFx | undefined {
  if (!fx || fx.bypass) return undefined
  const b = fx.bypassed || {}
  return {
    flipH: b.flip ? undefined : fx.flipH,
    flipV: b.flip ? undefined : fx.flipV,
    bright: b.bright ? undefined : fx.bright,
    contrast: b.contrast ? undefined : fx.contrast,
    sat: b.sat ? undefined : fx.sat,
    temp: b.temp ? undefined : fx.temp,
    hue: b.hue ? undefined : fx.hue,
    curves: b.curves ? undefined : fx.curves,
    dispersion: b.dispersion ? undefined : fx.dispersion,
    dispersionMask: fx.dispersionMask,
    grain: b.grain ? undefined : fx.grain,
  }
}

/** (правка 884) есть ли хотя бы один активный (не в байпасе) эффект */
function hasActiveFx(fx?: ShotFx): boolean {
  return hasFx(effectiveFx(fx))
}

/** (правка 858, 859, 861, 884) CSS-представление эффектов шота для мгновенного превью в плеере */
function shotFxCss(fx: ShotFx | undefined, svgFilterId?: string): { filter?: string; scaleX: number; scaleY: number } {
  const efx = effectiveFx(fx)
  if (!efx) return { scaleX: 1, scaleY: 1 }
  const filters: string[] = []
  if (
    svgFilterId &&
    (hasCurves(efx.curves) || (efx.dispersion && efx.dispersion > 0) || (efx.temp && Math.abs(efx.temp) >= 1))
  ) {
    filters.push(`url(#${svgFilterId})`)
  }
  if (efx.hue && Math.abs(efx.hue) >= 1) filters.push(`hue-rotate(${efx.hue.toFixed(0)}deg)`)
  if (efx.bright) filters.push(`brightness(${Math.max(0.2, 1 + efx.bright).toFixed(2)})`)
  if (efx.contrast) filters.push(`contrast(${Math.max(0.2, 1 + efx.contrast).toFixed(2)})`)
  if (efx.sat !== undefined && efx.sat !== 1) filters.push(`saturate(${Math.max(0, efx.sat).toFixed(2)})`)
  return {
    filter: filters.length ? filters.join(' ') : undefined,
    scaleX: efx.flipH ? -1 : 1,
    scaleY: efx.flipV ? -1 : 1,
  }
}

/** (правка 876, 884) нужны ли эффектам SVG-фильтр (кривые/температура/дисперсия) */
function needsSvgFx(fx?: ShotFx): boolean {
  const efx = effectiveFx(fx)
  return !!(efx && (hasCurves(efx.curves) || (efx.dispersion && efx.dispersion > 0) || (efx.temp && Math.abs(efx.temp) >= 1)))
}

/** (правка 884) кэш радиальных карт дисперсии по размеру маски центра (0..90%) */
const radialDispMapCache = new Map<number, string>()

/** (правка 876, 884) SVG-фильтр цветокоррекции для мгновенного превью (кривые + температура +
 * радиальная дисперсия с настраиваемой маской центра); учитывает байпас */
function FxSvgFilter({ fx, id, dispMap }: { fx?: ShotFx; id: string; dispMap: string }) {
  const efx = effectiveFx(fx)
  const c = efx?.curves
  const temp = efx?.temp && Math.abs(efx.temp) >= 1 ? efx.temp / 380 : 0
  const disp = efx?.dispersion && efx.dispersion > 0 ? efx.dispersion : 0
  const maskPct = typeof efx?.dispersionMask === 'number' ? Math.max(0, Math.min(90, Math.round(efx.dispersionMask))) : 35
  const mapUrl = disp > 0 ? (createRadialDispMapDataUrl(maskPct) || dispMap) : dispMap
  const rTab = buildChannelTable(c?.master, c?.r, temp)
  const gTab = buildChannelTable(c?.master, c?.g, temp * 0.18)
  const bTab = buildChannelTable(c?.master, c?.b, -temp)
  return (
    <filter id={id} colorInterpolationFilters="sRGB" x="-2%" y="-2%" width="104%" height="104%">
      <feComponentTransfer in="SourceGraphic" result="curved">
        <feFuncR type="table" tableValues={rTab} />
        <feFuncG type="table" tableValues={gTab} />
        <feFuncB type="table" tableValues={bTab} />
      </feComponentTransfer>
      {disp > 0 && mapUrl && (
        <>
          <feImage href={mapUrl} x="0%" y="0%" width="100%" height="100%" preserveAspectRatio="none" result="dispMap" />
          <feDisplacementMap in="curved" in2="dispMap" scale={disp * 1.1} xChannelSelector="R" yChannelSelector="G" result="radR" />
          <feColorMatrix in="radR" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="chR" />
          <feColorMatrix in="curved" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="chG" />
          <feDisplacementMap in="curved" in2="dispMap" scale={-disp * 1.1} xChannelSelector="R" yChannelSelector="G" result="radB" />
          <feColorMatrix in="radB" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="chB" />
          <feBlend in="chR" in2="chG" mode="screen" result="rg" />
          <feBlend in="rg" in2="chB" mode="screen" result="abFull" />
          <feComposite in="abFull" in2="dispMap" operator="in" result="abEdges" />
          <feMerge>
            <feMergeNode in="curved" />
            <feMergeNode in="abEdges" />
          </feMerge>
        </>
      )}
    </filter>
  )
}

/**
 * (правка 861, 884) Генерирует карту радиальной линзовой дисперсии с настраиваемой
 * маской центра (maskPct = 0..90%, по умолчанию 35%):
 * - В радиусе <= r0 R=128, G=128, Alpha=0 -> центр НЕ задействуется вообще (100% чистый)!
 * - От r0 к краям и углам R и G кодируют радиальный вектор от центра наружу, а Alpha плавно
 *   растёт от 0 до 255 — дисперсия плавно проявляется к краям и углам кадра.
 */
function createRadialDispMapDataUrl(maskPct = 35): string {
  const key = Math.max(0, Math.min(90, Math.round(maskPct)))
  const cached = radialDispMapCache.get(key)
  if (cached) return cached
  try {
    const size = 192
    const c = document.createElement('canvas')
    c.width = size
    c.height = size
    const ctx = c.getContext('2d')
    if (!ctx) return ''
    const img = ctx.createImageData(size, size)
    const d = img.data
    const r0 = (key / 100) * 1.08
    const span = Math.max(0.18, 1.25 - r0)
    for (let y = 0; y < size; y++) {
      const ny = (y / (size - 1)) * 2 - 1 // -1..1
      for (let x = 0; x < size; x++) {
        const nx = (x / (size - 1)) * 2 - 1 // -1..1
        const r = Math.hypot(nx, ny) // 0 в центре, 1 у краёв, ~1.41 в углах
        // в радиусе 0..r0 вес строго 0 (центр чистый), дальше плавный подъём к краям
        const t = Math.max(0, Math.min(1, (r - r0) / span))
        let weight = t * t * (3 - 2 * t)
        // (правка 862) у самой кромки кадра смещение плавно гасим, иначе
        // выборка за пределами кадра даёт цветную «рамку» по периметру
        const dEdge = Math.min(1 - Math.abs(nx), 1 - Math.abs(ny))
        const ef = Math.max(0, Math.min(1, dEdge / 0.045))
        weight *= ef * ef * (3 - 2 * ef)
        const vx = Math.max(-1, Math.min(1, nx * weight))
        const vy = Math.max(-1, Math.min(1, ny * weight))
        const idx = (y * size + x) * 4
        d[idx] = Math.round(128 + vx * 127)
        d[idx + 1] = Math.round(128 + vy * 127)
        d[idx + 2] = 128
        d[idx + 3] = Math.round(weight * 255)
      }
    }
    ctx.putImageData(img, 0, 0)
    const url = c.toDataURL('image/png')
    radialDispMapCache.set(key, url)
    return url
  } catch {
    return ''
  }
}

/** (правка 859) генерирует тайл монохромного плёночного зерна 160×160 для анимированного наложения */
function createGrainTileDataUrl(): string {
  try {
    const size = 160
    const c = document.createElement('canvas')
    c.width = size
    c.height = size
    const ctx = c.getContext('2d')
    if (!ctx) return ''
    const img = ctx.createImageData(size, size)
    const d = img.data
    for (let i = 0; i < d.length; i += 4) {
      // сумма двух случайных величин даёт мягкое треугольное (псевдо-гауссово) зерно kolem 128
      const v = Math.round(((Math.random() + Math.random()) * 0.5) * 255)
      d[i] = v
      d[i + 1] = v
      d[i + 2] = v
      d[i + 3] = 255
    }
    ctx.putImageData(img, 0, 0)
    return c.toDataURL('image/png')
  } catch {
    return ''
  }
}

/** (правка 849) скорость шота: те же границы 0.25..4, что и в /api/montage/render */
function shotSpeed(s: MontageShot): number {
  const v = typeof s.speed === 'number' && Number.isFinite(s.speed) ? s.speed : 1
  return Math.max(0.25, Math.min(4, v))
}

/**
 * ключ кинополосы: файл + диапазон подрезки. (правка 720 v11) полоса строится
 * ТОЛЬКО по видимому диапазону — иначе при зуме кадры растягиваются, а после
 * разреза весь файл сжимается в половинку блока.
 */
// (правка 882) размеры квантуются шагом 8 px: драг высоты дорожки или зума
// переснимал ПОЛОСУ на каждый пиксель (ключ менялся каждые 4 px); теперь
// перевыпуск только при смене бакета, погрешность растяжки ≤ 4 px незаметна.
const stripBucketW = (w: number) => Math.max(16, Math.round(w / 8) * 8)
const stripBucketH = (h: number) => Math.max(24, Math.round(h / 8) * 8)

const stripKey = (url: string, r: { start: number; end: number }, w: number, h: number) =>
  // (правка 854) размер блока в ключе: ячейки снимаются в пропорции видео под
  // конкретный блок, при зуме/высоте дорожки полоса переснимается (с 882 — шаг 8 px).
  `${url}|${r.start.toFixed(2)}|${r.end.toFixed(2)}|${stripBucketW(w)}x${stripBucketH(h)}`

/**
 * кинополоса клипа: кадры диапазона [r.start, r.end] через canvas → dataURL.
 * (правка 854, 860) полотно снимается точно под блок (cw x ch), а каждый кадр
 * внутри ячейки (cellW x ch) рисуется по правилу object-fit: cover (центральный
 * кроп из v.videoWidth x v.videoHeight) — при любом растягивании высоты
 * таймлайна или зуме кадры никогда не сплющиваются и не растягиваются.
 */
function makeStrip(url: string, r: { start: number; end: number }, w: number, h: number): Promise<string | null> {
  return new Promise((resolve) => {
    const s = r.start > 0 ? r.start : 0
    const e = r.end > s + 0.05 ? r.end : s + 2
    const d = e - s
    let n = 1
    let cellW = 80
    const cw = Math.max(16, Math.round(w))
    const ch = Math.max(24, Math.round(h))
    const v = document.createElement('video')
    v.muted = true
    v.preload = 'auto'
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    let i = 0
    let done = false
    const finish = (res: string | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      // (правка 842) полностью выгружаем декодер: одного «пустого src» мало
      v.onloadeddata = null
      v.onseeked = null
      v.removeAttribute('src')
      v.load()
      resolve(res)
    }
    const timer = setTimeout(() => finish(null), 12000)
    const seek = () => {
      if (i >= n) {
        try { finish(canvas.toDataURL('image/jpeg', 0.65)) } catch { finish(null) }
        return
      }
      v.currentTime = Math.max(s, Math.min(e - 0.05, s + (d * (i + 0.5)) / n))
    }
    v.onloadeddata = () => {
      const vw = v.videoWidth > 0 ? v.videoWidth : 640
      const vh = v.videoHeight > 0 ? v.videoHeight : 360
      const aspect = vw / vh
      const tileW = Math.max(16, ch * aspect)
      n = Math.max(1, Math.min(20, Math.ceil(cw / tileW)))
      cellW = cw / n
      canvas.width = cw
      canvas.height = ch
      seek()
    }
    v.onseeked = () => {
      if (ctx) {
        try {
          const vw = v.videoWidth > 0 ? v.videoWidth : 640
          const vh = v.videoHeight > 0 ? v.videoHeight : 360
          const srcAspect = vw / vh
          const dstAspect = cellW / ch
          let sx = 0
          let sy = 0
          let sw = vw
          let sh = vh
          if (srcAspect > dstAspect) {
            sw = vh * dstAspect
            sx = (vw - sw) * 0.5
          } else {
            sh = vw / dstAspect
            sy = (vh - sh) * 0.5
          }
          const dx = Math.floor(i * cellW)
          const dw = Math.ceil((i + 1) * cellW) - dx
          ctx.drawImage(v, sx, sy, sw, sh, dx, 0, dw, ch)
        } catch { /* кадр не получился */ }
      }
      i += 1
      seek()
    }
    v.onerror = () => finish(null)
    v.src = url
  })
}

export function MontageView() {
  const { files, folders, loading } = useVideoGallery()
  const { bump } = useGalleryRefresh.getState()

  const [shots, setShots] = useState<MontageShot[]>([])
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [folderFilter, setFolderFilter] = useState('__all__')
  const [search, setSearch] = useState('')
  const [rendering, setRendering] = useState(false)
  const [result, setResult] = useState<{ filename: string; url: string } | null>(null)
  /** превью: выбранный шот, клип сборки при проигрывании или результат */
  const [previewSrc, setPreviewSrc] = useState<string | null>(null)
  /** масштаб таймлайна, пикселей в секунду */
  const [pps, setPps] = useState(30)
  /** индекс вставки при перетаскивании (null = не перетаскиваем) */
  const [dropIdx, setDropIdx] = useState<number | null>(null)
  /** играет ли вся сборка целиком */
  const [playing, setPlaying] = useState(false)
  /** курсор времени на шкале сборки, с */
  const [playT, setPlayT] = useState(0)
  /** кинополосы клипов: url+подрезка -> dataURL ('' = снять не удалось) */
  const [strips, setStrips] = useState<Record<string, string>>({})
  /** зациклить воспроизведение всей последовательности */
  const [loop, setLoop] = useState(false)
  /** высота дорожки таймлайна, px */
  const [trackH, setTrackH] = useState(64)
  /** масштаб превью: доля панели 0.2..1 */
  const [vScale, setVScale] = useState(0.8)
  /** превью развернуто на весь экран (правка 869) — общий хук, см. use-fs-fullscreen */
  const { isFs, setIsFs, toggleFs: toggleFullscreen } = useFsFullscreen()
  /** выключить звук в превью */
  const [muted, setMuted] = useState(false)
  /** (правка 720 v8) общая громкость таймлайна, 0..1; вплавляется и в рендер */
  const [masterVol, setMasterVol] = useState(1)
  /** (правка 720 v11) магнит: плейхед притягивается к краям клипов */
  const [snap, setSnap] = useState(true)
  /** (правка 720 v11) зациклить текущий клип (повторять его, не переходя дальше) */
  const [loopClip, setLoopClip] = useState(false)
  /** (правка 720 v11) подсказка новой длительности при тяге за край блока */
  const [trimBadge, setTrimBadge] = useState<{ x: number; y: number; text: string } | null>(null)
  /** (правка 720 v11) счётчик перерисовки из-за истории (кнопки Отмены/Повтора) */
  const [histTick, setHistTick] = useState(0)
  /** (правка 853) настройки секвенции: разрешение/частота/вписывание/качество */
  const [seqSet, setSeqSet] = useState<SeqSettings>(DEFAULT_SEQ)
  /** (правка 853) открыт ли поповер настроек секвенции */
  const [seqOpen, setSeqOpen] = useState(false)
  /** (правка 859) вкладка правой панели: галерея | свойства | эффекты */
  const [rightTab, setRightTab] = useState<'gallery' | 'props' | 'fx'>('gallery')
  /** (правка 874) видео-слои (дорожки V2+): поверх базы, трек выше — перекрывает */
  const [layers, setLayers] = useState<LayerClip[]>([])
  const layersRef = useRef<LayerClip[]>([])
  /** (правка 874) нижняя граница числа рядов слоёв в UI («+ слой» добавляет ряд) */
  const [layerTracks, setLayerTracks] = useState(0)
  const layerTracksRef = useRef(0)
  const [selectedLayerKey, setSelectedLayerKey] = useState<string | null>(null)
  /** (правка 874) аудиоклипы звуковых дорожек (A1+) */
  const [audios, setAudios] = useState<AudioClip[]>([])
  const audiosRef = useRef<AudioClip[]>([])
  const [audioTracks, setAudioTracks] = useState(0)
  const audioTracksRef = useRef(0)
  const [selectedAudioKey, setSelectedAudioKey] = useState<string | null>(null)
  /** (правка 883) контейнер превью для точного лимита при растягивании таймлайна */
  const previewBoxRef = useRef<HTMLDivElement | null>(null)
  /** (правка 874) DOM-элементы слоистых <video>/<audio> в превью: key -> элемент
   *  (для fit=blur — контейнер с двумя <video>) */
  const layerElsRef = useRef<Map<string, HTMLVideoElement | HTMLDivElement>>(new Map())
  const audioElsRef = useRef<Map<string, HTMLAudioElement>>(new Map())
  /** (правка 874) скрытый <input type=file> импорта звука */
  const audioFileInputRef = useRef<HTMLInputElement | null>(null)
  /** (правка 859) редактируемый канал кривых цвета */
  const [curveCh, setCurveCh] = useState<'master' | 'r' | 'g' | 'b'>('master')
  /** (правка 859) буфер скопированных эффектов для переноса на другие клипы */
  const [copiedFx, setCopiedFx] = useState<ShotFx | null>(null)
  /** (правка 860) стоит ли плейхед сейчас в пустом промежутке между клипами (чёрный кадр) */
  const [inGap, setInGap] = useState(false)
  const inGapRef = useRef(false)
  /** (правка 860) таймер проигрывания пустого промежутка (паузы между клипами) */
  const gapPlayRef = useRef<{ startWall: number; startT: number; endT: number; nextIdx: number } | null>(null)
  /** (правка 860) последняя готовая кинополоса каждого шота (чтобы при ресайзе дорожки не мигало) */
  const lastStripByShotRef = useRef<Record<string, string>>({})
  // (правка 876) последняя готовая полоса для клипа слоя (пока строится новая)
  const lastStripByLayerRef = useRef<Record<string, string>>({})
  /** (правка 859, 861) dataURL тайла киношного зерна, карты радиальной дисперсии и DOM-реф анимированного слоя */
  const [grainTile, setGrainTile] = useState('')
  const [radialDispMap, setRadialDispMap] = useState('')
  const grainOverlayRef = useRef<HTMLDivElement | null>(null)
  const curveSvgRef = useRef<SVGSVGElement | null>(null)
  useEffect(() => {
    setGrainTile(createGrainTileDataUrl())
    setRadialDispMap(createRadialDispMapDataUrl())
  }, [])

  /** источник текущего drag (dataTransfer данные на dragover недоступны) */
  const dragRef = useRef<
    | { kind: 'gallery'; file: VideoGalleryFile }
    | { kind: 'move'; key: string }
    | { kind: 'move-layer'; key: string }
    | { kind: 'move-audio'; key: string }
    | null
  >(null)
  /** true, пока тянем за край блока (гасит HTML5-drag блока) */
  const suppressDrag = useRef(false)
  const trackRef = useRef<HTMLDivElement>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  /** два <video> в превью: активный виден, резервный прогревается под следующий клип */
  const previewARef = useRef<HTMLVideoElement>(null)
  const previewBRef = useRef<HTMLVideoElement>(null)
  /** индекс видимого буфера: 0 = A, 1 = B */
  const [buf, setBuf] = useState(0)
  const bufRef = useRef(0)
  const playingRef = useRef(false)
  /** индекс клипа сборки в текущем src превью (-1 = не клип сборки) */
  const idxRef = useRef(-1)
  /** курсор времени для обработчиков (зеркало playT) */
  const seqTRef = useRef(0)
  /** позиция внутри исходника для каждого буфера после смены src */
  const wantSeekRef = useRef<(number | null)[]>([null, null])
  /** (правка 858) коалесинг seek: пока декодер занят (v.seeking), не отменяем
   *  текущий декод кадра, а запоминаем свежую цель и прыгаем туда в onSeeked */
  const pendingSeekRef = useRef<(number | null)[]>([null, null])
  /** (правка 858) какой ключ шота сейчас отображается в каждом буфере (для CSS fx) */
  const bufShotKeyRef = useRef<(string | null)[]>([null, null])
  /** резервный буфер: клип и позиция старта; null = буфер не прогрет */
  const stageSeekRef = useRef<{ idx: number; t: number } | null>(null)
  const rafRef = useRef(0)
  /** (правка 858) rAF-троттлинг обновления React-состояния playT при ведении мыши */
  const scrubRafRef = useRef(0)
  /** (правка 858) идёт ли активный скраб мышью (блокирует фоновые makeStrip) */
  const scrubbingRef = useRef(false)
  /** (правка 858) DOM-узел таймкода транспорта для обновления в 0 мс без ре-рендера */
  const timecodeRef = useRef<HTMLSpanElement | null>(null)
  /** звук вкл/выкл в превью (зеркало для обработчиков) */
  const mutedRef = useRef(false)
  /** зеркало общей громкости для обработчиков */
  const masterVolRef = useRef(1)
  /** ключ клипа, чью громкость показывает статичное превью (null = не клип) */
  const previewVolKeyRef = useRef<string | null>(null)
  const ppsRef = useRef(30)
  /** высота дорожки для обработчика ресайза */
  const trackHRef = useRef(64)
  const stripBusy = useRef<Set<string>>(new Set())
  /** (правка 720 v11) зеркала переключателей транспорта для rAF-обработчика */
  const snapRef = useRef(true)
  const loopClipRef = useRef(false)
  /** (правка 720 v11) история таймлайна для Ctrl+Z / Ctrl+Shift+Z
   *  (правка 874) снапшот теперь {shots, layers, audios} */
  const undoRef = useRef<HistSnap[]>([])
  const redoRef = useRef<HistSnap[]>([])
  /** точка времени, которую держим под курсором при зуме колесом */
  const zoomAnchorRef = useRef<{ t: number; x: number } | null>(null)
  /** зеркало shots для обработчиков без зависимостей */
  const shotsRef = useRef<MontageShot[]>([])
  /** (правка 842) после unmount колбэки длительности/кинополос не должны звать setState */
  const mountedRef = useRef(true)
  useEffect(() => () => { mountedRef.current = false }, [])
  /** (правка 840) DOM-узел плейхеда: его двигаем каждый кадр без ре-рендера */
  const playheadRef = useRef<HTMLDivElement | null>(null)
  /** (правка 845) прогресс текущей сборки, %; null = нет данных */
  const [renderPct, setRenderPct] = useState<number | null>(null)

  const videoFiles = useMemo(() => {
    let list = files
    if (folderFilter !== '__all__') list = list.filter((f) => inFolder(f.subfolder || '', folderFilter))
    const q = search.trim().toLowerCase()
    if (q) list = list.filter((f) => f.filename.toLowerCase().includes(q))
    return [...list].sort((a, b) => (b.mtime || 0) - (a.mtime || 0))
  }, [files, folderFilter, search])

  const selected = shots.find((s) => s.key === selectedKey) || null
  // (правка 874) выделенные слой/аудио + точечные правки из панели свойств
  const selectedLayer = layers.find((l) => l.key === selectedLayerKey) || null
  const selectedAudio = audios.find((a) => a.key === selectedAudioKey) || null
  /**
   * (правка 893) Выбор клипа эксклюзивен для всех типов дорожек: клик по клипу
   * базы/слоя/аудио снимает выделение с остальных. Раньше клик по базе не
   * сбрасывал выделенный слой (панель свойств приоритетнее), и «свойства
   * одного клипа» оставались на экране при выборе клипа на другой дорожке.
   */
  const selectClip = useCallback((kind: 'shot' | 'layer' | 'audio', key: string | null) => {
    setSelectedKey(kind === 'shot' ? key : null)
    setSelectedLayerKey(kind === 'layer' ? key : null)
    setSelectedAudioKey(kind === 'audio' ? key : null)
  }, [])
  const patchLayer = useCallback((key: string, patch: Partial<LayerClip>) => {
    setLayers((prev) => prev.map((x) => (x.key === key ? { ...x, ...patch } : x)))
  }, [])
  const patchAudio = useCallback((key: string, patch: Partial<AudioClip>) => {
    setAudios((prev) => prev.map((x) => (x.key === key ? { ...x, ...patch } : x)))
  }, [])

  const seq = useMemo<SeqRow[]>(() => {
    let acc = 0
    return shots.map((shot) => {
      // (правка 860) учитываем пустой промежуток (gap) перед клипом на таймлайне
      const gap = Math.max(0, typeof shot.gap === 'number' && Number.isFinite(shot.gap) ? shot.gap : 0)
      acc += gap
      const r = effRange(shot)
      // (правка 849) скорость меняет место шота на шкале: 2× ⇒ вдвое короче
      const len = (r.end - r.start) / shotSpeed(shot)
      const row: SeqRow = { shot, r, offset: acc, len, gap }
      acc += len
      return row
    })
  }, [shots])
  const totalSec = seq.length ? seq[seq.length - 1].offset + seq[seq.length - 1].len : 0

  // (правка 874) эффективная длина на таймлайне для слоёв/аудио, сек на выходе
  const layerLen = useCallback((l: LayerClip) => Math.max(0.05, (l.duration - l.trimStart - l.trimEnd) / (l.speed || 1)), [])
  const audioLen = useCallback((a: AudioClip) => Math.max(0.05, a.duration - a.trimStart - a.trimEnd), [])
  /** полная длина шкалы таймлайна: база + хвосты слоёв/аудио (рендер всё равно режется по базе) */
  const tlEnd = useMemo(() => {
    let e = totalSec
    for (const l of layers) e = Math.max(e, l.at + layerLen(l))
    for (const a of audios) e = Math.max(e, a.at + audioLen(a))
    return e
  }, [totalSec, layers, audios, layerLen, audioLen])
  /** индексы рядов слоёв сверху вниз (верхний ряд — самый верхний трек); V1 — база, её тут нет */
  const layerRows = useMemo(() => {
    const maxT = Math.min(MAX_TRACKS, Math.max(layerTracks, layers.reduce((m, l) => Math.max(m, l.track), 0)))
    const rows: number[] = []
    for (let t = maxT; t >= 1; t--) rows.push(t)
    return rows
  }, [layerTracks, layers])
  /** индексы аудиорядов сверху вниз: A1, A2, ... */
  const audioRows = useMemo(() => {
    const maxT = Math.min(MAX_TRACKS, Math.max(audioTracks, audios.reduce((m, a) => Math.max(m, a.track), 0)))
    const rows: number[] = []
    for (let t = 1; t <= maxT; t++) rows.push(t)
    return rows
  }, [audioTracks, audios])

  // зеркала для rAF/клавиатурных обработчиков, чтобы не зависеть от замыканий
  const seqRef = useRef<SeqRow[]>([])
  useEffect(() => { seqRef.current = seq }, [seq])
  /** (правка 879) полная длина композиции: учитывает все дорожки, не только V1 */
  const tlEndRef = useRef(0)
  useEffect(() => { tlEndRef.current = tlEnd }, [tlEnd])
  useEffect(() => { ppsRef.current = pps }, [pps])
  useEffect(() => { seqTRef.current = playT }, [playT])
  useEffect(() => { trackHRef.current = trackH }, [trackH])
  useEffect(() => { shotsRef.current = shots }, [shots])
  // (правка 874) зеркала слоёв/аудио для обработчиков без зависимостей
  useEffect(() => { layersRef.current = layers }, [layers])
  useEffect(() => { audiosRef.current = audios }, [audios])
  useEffect(() => { layerTracksRef.current = layerTracks }, [layerTracks])
  useEffect(() => { audioTracksRef.current = audioTracks }, [audioTracks])
  /**
   * (правка 893) Магнит — общий для ВСЕХ дорожек. Точки притяжения: 0, плейхед
   * и оба края каждого клипа (база V1, слои V2+, аудио), кроме самого
   * перетаскиваемого. Раньше база притягивалась только к базе, а слои — только
   * к базе и соседям того же типа, поэтому клип не «прилипал» к клипу на
   * другой дорожке.
   */
  const snapPointsExcept = useCallback(
    (skip: { shot?: string; layer?: string; audio?: string }) => {
      // (правка 893) плейхед — и его край для клипа, упирающегося в него концом
      const pts: number[] = [0, seqTRef.current]
      for (const r of seqRef.current) {
        if (r.shot.key === skip.shot) continue
        pts.push(r.offset, r.offset + r.len)
      }
      for (const l of layersRef.current) {
        if (l.key === skip.layer) continue
        pts.push(l.at, l.at + layerLen(l))
      }
      for (const a of audiosRef.current) {
        if (a.key === skip.audio) continue
        pts.push(a.at, a.at + audioLen(a))
      }
      return pts
    },
    [layerLen, audioLen],
  )
  /**
   * (правка 893) Притягивает ЛЮБОЙ из двух краёв клипа (старт и конец) к
   * ближайшей точке магнита: можно подтащить и началом к концу чужого клипа,
   * и концом к началу. Возвращает скорректированный старт клипа.
   */
  const snapClipStart = useCallback((want: number, len: number, pts: number[], tol: number) => {
    let best = want
    let bestD = tol + 0.0001
    for (const p of pts) {
      const dStart = Math.abs(want - p)
      if (dStart < bestD) { bestD = dStart; best = p }
      const dEnd = Math.abs(want + len - p)
      if (dEnd < bestD) { bestD = dEnd; best = p - len }
    }
    return bestD <= tol ? Math.max(0, best) : want
  }, [])
  // (правка 874) синхронизация слоистых <video>/<audio> с курсором превью:
  // играем только окна клипов, рассинхрон > 0.35 с подтягиваем seek'ом
  const layerVideosOf = (host: HTMLVideoElement | HTMLDivElement): HTMLVideoElement[] =>
    host.tagName === 'VIDEO' ? [host as HTMLVideoElement] : Array.from(host.querySelectorAll('video'))
  useEffect(() => {
    const live = new Set<string>()
    if (!result) {
      for (const l of layers) {
        if (l.hidden) continue
        const sp = l.speed || 1
        const len = layerLen(l)
        if (playT < l.at || playT >= l.at + len) continue
        const host = layerElsRef.current.get(l.key)
        if (!host) continue
        live.add(l.key)
        const want = Math.min(l.trimStart + (playT - l.at) * sp, Math.max(0, (l.duration || 0) - 0.01))
        // (правка 877) звук слоя: громкость клипа × фейды × общая громкость, mute слоя/превью
        const local = playT - l.at
        let g = 1
        const lfi = l.fadeIn || 0
        const lfo = l.fadeOut || 0
        if (lfi > 0.01) g = Math.min(g, clamp01(local / lfi))
        if (lfo > 0.01) g = Math.min(g, clamp01((len - local) / lfo))
        const lvol = clamp01((l.vol ?? 1) * g * masterVol)
        const silent = muted || !!l.muted
        for (const v of layerVideosOf(host)) {
          // (правка 876) скорость слоя учитываем и в превью (playbackRate)
          if (Math.abs(v.playbackRate - sp) > 0.01) v.playbackRate = sp
          // (правка 877) звук слоя в превью — как у базы и аудиодорожек
          if (v.muted !== silent) v.muted = silent
          v.volume = silent ? 0 : lvol
          if (playing) {
            if (Math.abs(v.currentTime - want) > 0.35) { try { v.currentTime = Math.max(0, want) } catch { /* ignore */ } }
            if (v.paused) void v.play().catch(() => {})
          } else {
            // (правка 879) пауза останавливает и слои, которые играли в текущем окне
            if (!v.paused) v.pause()
            // (правка 876) на паузе кадр слоя позиционируется по плейхеду — как у базы
            if (Math.abs(v.currentTime - want) > 0.02) {
              try { v.currentTime = Math.max(0, want) } catch { /* ignore */ }
            }
          }
        }
      }
      for (const a of audios) {
        if (a.muted) continue
        if (playT < a.at || playT >= a.at + audioLen(a)) continue
        const el = audioElsRef.current.get(a.key)
        if (!el) continue
        live.add(a.key)
        const want = Math.min(a.trimStart + (playT - a.at), Math.max(0, (a.duration || 0) - 0.01))
        if (playing) {
          if (Math.abs(el.currentTime - want) > 0.35) { try { el.currentTime = Math.max(0, want) } catch { /* ignore */ } }
          el.volume = muted ? 0 : Math.max(0, Math.min(1, ((a.vol ?? 100) / 100) * masterVol))
          if (el.paused) void el.play().catch(() => {})
        } else {
          // (правка 879) пауза останавливает и звук, играющий в текущем окне
          if (!el.paused) el.pause()
          // (правка 876) готовим позицию звука к старту воспроизведения
          if (Math.abs(el.currentTime - want) > 0.02) {
            try { el.currentTime = Math.max(0, want) } catch { /* ignore */ }
          }
        }
      }
    }
    for (const [k, host] of layerElsRef.current) {
      if (live.has(k)) continue
      for (const v of layerVideosOf(host)) if (!v.paused) v.pause()
    }
    for (const [k, el] of audioElsRef.current) if (!live.has(k) && !el.paused) el.pause()
  }, [playT, playing, result, layers, audios, muted, masterVol, layerLen, audioLen])
  useEffect(() => { snapRef.current = snap }, [snap])
  useEffect(() => { loopClipRef.current = loopClip }, [loopClip])

  // (правка 720 v9) восстановление сохранённых параметров при монтаже вкладки
  const hydrated = useRef(false)
  useEffect(() => {
    let s: MontageSaved = {}
    try {
      const raw = JSON.parse(localStorage.getItem(LS_KEY) || '{}')
      if (raw && typeof raw === 'object') s = raw
    } catch { /* битые данные — стартуем пусто */ }
    if (Array.isArray(s.shots)) {
      setShots(s.shots.filter((x) => x && typeof x.key === 'string' && typeof x.url === 'string').slice(0, MAX_SHOTS))
    }
    // (правка 874) слои и аудио: валидация полей, мягкие лимиты рядов/клипов
    if (Array.isArray(s.layers)) {
      const ls = s.layers
        .filter((x) => x && typeof x.key === 'string' && typeof x.filename === 'string' && typeof x.url === 'string')
        .slice(0, MAX_LAYER_CLIPS)
        .map((x) => ({
          key: x.key as string,
          filename: x.filename as string,
          subfolder: typeof x.subfolder === 'string' ? x.subfolder : '',
          name: typeof x.name === 'string' ? x.name : (x.filename as string),
          url: x.url as string,
          at: Number.isFinite(x.at as number) ? Math.max(0, x.at as number) : 0,
          track: Number.isFinite(x.track as number) ? Math.max(1, Math.round(x.track as number)) : 1,
          trimStart: Number.isFinite(x.trimStart as number) ? Math.max(0, x.trimStart as number) : 0,
          trimEnd: Number.isFinite(x.trimEnd as number) ? Math.max(0, x.trimEnd as number) : 0,
          speed: Number.isFinite(x.speed as number) ? Math.max(0.25, Math.min(4, x.speed as number)) : 1,
          // (правка 883) все видеодорожки масштабируются целиком по умолчанию (contain), без обрезки
          fit: (['stretch', 'cover', 'contain', 'blur'] as const).includes(x.fit as 'blur') ? (x.fit as LayerClip['fit']) : 'contain',
          duration: Number.isFinite(x.duration as number) ? Math.max(0, x.duration as number) : 0,
          hidden: x.hidden === true,
          // (правка 876) эффекты слоя: валидируем через cloneFx, мусор отбрасываем
          fx: x.fx && typeof x.fx === 'object' && hasFx(x.fx as ShotFx) ? cloneFx(x.fx as ShotFx) : undefined,
          // (правка 877) звук слоя
          vol: Number.isFinite(x.vol as number) ? clamp01(x.vol as number) : undefined,
          fadeIn: Number.isFinite(x.fadeIn as number) ? Math.max(0, Math.min(30, x.fadeIn as number)) : undefined,
          fadeOut: Number.isFinite(x.fadeOut as number) ? Math.max(0, Math.min(30, x.fadeOut as number)) : undefined,
          muted: x.muted === true,
        }))
      setLayers(ls)
      const savedLT = Number.isFinite(s.layerTracks as number) ? Math.max(0, Math.min(MAX_TRACKS, Math.round(s.layerTracks as number))) : 0
      setLayerTracks(Math.max(savedLT, ls.reduce((m, l) => Math.max(m, l.track), 0)))
    } else if (Number.isFinite(s.layerTracks as number)) {
      setLayerTracks(Math.max(0, Math.min(MAX_TRACKS, Math.round(s.layerTracks as number))))
    }
    if (Array.isArray(s.audios)) {
      const as = s.audios
        .filter((x) => x && typeof x.key === 'string' && typeof x.file === 'string' && typeof x.url === 'string')
        .slice(0, MAX_AUDIO_CLIPS)
        .map((x) => ({
          key: x.key as string,
          file: x.file as string,
          name: typeof x.name === 'string' ? x.name : (x.file as string),
          url: x.url as string,
          at: Number.isFinite(x.at as number) ? Math.max(0, x.at as number) : 0,
          track: Number.isFinite(x.track as number) ? Math.max(1, Math.round(x.track as number)) : 1,
          trimStart: Number.isFinite(x.trimStart as number) ? Math.max(0, x.trimStart as number) : 0,
          trimEnd: Number.isFinite(x.trimEnd as number) ? Math.max(0, x.trimEnd as number) : 0,
          vol: Number.isFinite(x.vol as number) ? Math.max(0, Math.min(200, x.vol as number)) : 100,
          fadeIn: Number.isFinite(x.fadeIn as number) ? Math.max(0, x.fadeIn as number) : 0,
          fadeOut: Number.isFinite(x.fadeOut as number) ? Math.max(0, x.fadeOut as number) : 0,
          duration: Number.isFinite(x.duration as number) ? Math.max(0, x.duration as number) : 0,
          muted: x.muted === true,
        }))
      setAudios(as)
      const savedAT = Number.isFinite(s.audioTracks as number) ? Math.max(0, Math.min(MAX_TRACKS, Math.round(s.audioTracks as number))) : 0
      setAudioTracks(Math.max(savedAT, as.reduce((m, a) => Math.max(m, a.track), 0)))
    } else if (Number.isFinite(s.audioTracks as number)) {
      setAudioTracks(Math.max(0, Math.min(MAX_TRACKS, Math.round(s.audioTracks as number))))
    }
    if (typeof s.selectedKey === 'string') setSelectedKey(s.selectedKey)
    if (typeof s.folderFilter === 'string') setFolderFilter(s.folderFilter)
    if (Number.isFinite(s.pps)) setPps(Math.max(8, Math.min(240, s.pps as number)))
    if (typeof s.loop === 'boolean') setLoop(s.loop)
    if (Number.isFinite(s.trackH)) setTrackH(Math.max(40, Math.min(480, s.trackH as number)))
    if (Number.isFinite(s.vScale)) setVScale(Math.max(0.2, Math.min(1, s.vScale as number)))
    if (Number.isFinite(s.masterVol)) setMasterVol(clamp01(s.masterVol as number))
    if (typeof s.muted === 'boolean') setMuted(s.muted)
    if (typeof s.snap === 'boolean') { setSnap(s.snap); snapRef.current = s.snap }
    if (typeof s.loopClip === 'boolean') { setLoopClip(s.loopClip); loopClipRef.current = s.loopClip }
    // (правка 849) секвенция: значения клампим так же, как принимает бэкенд
    if (s.seq && typeof s.seq === 'object') {
      const q = s.seq
      const num = (v: unknown, hi: number) => (Number.isFinite(v as number) ? Math.max(0, Math.min(hi, v as number)) : 0)
      setSeqSet({
        w: num(q.w, 7680),
        h: num(q.h, 4320),
        fps: num(q.fps, 120),
        fit: (['stretch', 'cover', 'contain', 'blur'] as const).includes(q.fit as 'blur') ? q.fit as SeqSettings['fit'] : 'stretch',
        quality: (['high', 'standard', 'fast'] as const).includes(q.quality as 'fast') ? q.quality as SeqSettings['quality'] : 'standard',
        // (правка 882) кодировщик: загодя недопустимое значение = «Авто»
        codec: (['auto', 'cpu', 'gpu'] as const).includes(q.codec as 'cpu') ? q.codec as SeqSettings['codec'] : 'auto',
      })
    }
    hydrated.current = true
  }, [])

  // (правка 720 v9, 858) пишем параметры с коротким дебаунсом (и синхронно при
  // уходе со вкладки), чтобы во время трима/зума/скраба не блокировать главный поток
  useEffect(() => {
    if (!hydrated.current) return
    const payload: MontageSaved = {
      shots, layers, audios, layerTracks, audioTracks, selectedKey, folderFilter, pps, loop, trackH, vScale, masterVol, muted, snap, loopClip, seq: seqSet,
    }
    const save = () => {
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(payload))
      } catch { /* приватный режим / квота */ }
    }
    const timer = setTimeout(save, 180)
    return () => {
      clearTimeout(timer)
      save()
    }
  }, [shots, layers, audios, layerTracks, audioTracks, selectedKey, folderFilter, pps, loop, trackH, vScale, masterVol, muted, snap, loopClip, seqSet])

  // (правка 858) если в сохранённом таймлайне остались шоты с duration === 0
  // (вкладку закрыли до завершения измерения), домеряем их при монтировании
  const durProbedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!hydrated.current) return
    for (const s of shots) {
      if (s.duration > 0 || durProbedRef.current.has(s.key)) continue
      durProbedRef.current.add(s.key)
      getVideoDuration(s.url).then((d) => {
        if (d > 0 && mountedRef.current) {
          setShots((cur) => cur.map((x) => (x.key === s.key && !x.duration ? { ...x, duration: d } : x)))
        }
      })
    }
    // (правка 874) так же домеряем длительность видео-слоёв
    for (const l of layers) {
      if (l.duration > 0 || durProbedRef.current.has(l.key)) continue
      durProbedRef.current.add(l.key)
      getVideoDuration(l.url).then((d) => {
        if (d > 0 && mountedRef.current) {
          setLayers((cur) => cur.map((x) => (x.key === l.key && !x.duration ? { ...x, duration: d } : x)))
        }
      })
    }
  }, [shots, layers])

  // (правка 843) в сохранённом таймлайне могут остаться ссылки на УДАЛЁННЫЕ файлы
  // галереи (url больше не отдаётся, превью и рендер битые). Когда галерея
  // отрендерилась непустым списком — снимаем с таймлайна то, чего в ней нет.
  useEffect(() => {
    if (loading || files.length === 0 || !hydrated.current) return
    const aliveKey = (s: { subfolder?: string; filename: string }) => `${s.subfolder || ''}|${s.filename}`
    const alive = new Set(files.map((f) => aliveKey(f)))
    const gone = shotsRef.current.filter((s) => !alive.has(aliveKey(s))).length
    // (правка 874) мёртвые видео-слои снимаем так же (аудио живёт в .montage-audio — не трогаем)
    const goneL = layersRef.current.filter((l) => !alive.has(aliveKey(l))).length
    if (!gone && !goneL) return
    setShots((prev) => {
      const next = prev.filter((s) => alive.has(aliveKey(s)))
      return next.length === prev.length ? prev : next
    })
    setLayers((prev) => {
      const next = prev.filter((l) => alive.has(aliveKey(l)))
      return next.length === prev.length ? prev : next
    })
    const cur = selectedKey ? shotsRef.current.find((x) => x.key === selectedKey) : null
    if (cur && !alive.has(aliveKey(cur))) setSelectedKey(null)
    const curL = selectedLayerKey ? layersRef.current.find((x) => x.key === selectedLayerKey) : null
    if (curL && !alive.has(aliveKey(curL))) setSelectedLayerKey(null)
    showToast(`С таймлайна убрано удалённых файлов: ${gone + goneL}`, 'error')
  }, [files, loading, selectedKey, selectedLayerKey])

  // зум таймлайна колесом мыши (вверх = крупнее), точка под курсором остаётся на месте
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const old = ppsRef.current
      const next = Math.min(240, Math.max(8, e.deltaY < 0 ? Math.round(old * 1.25) : Math.round(old / 1.25)))
      if (next === old) return
      const track = el.firstElementChild as HTMLElement | null
      if (track) zoomAnchorRef.current = { t: (e.clientX - track.getBoundingClientRect().left) / old, x: e.clientX }
      setPps(next)
    }
    // нативный listener: React на wheel вешает passive, в нём preventDefault не работает
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // после зума докручиваем скролл, чтобы момент времени под курсором не уехал
  useEffect(() => {
    const a = zoomAnchorRef.current
    const el = scrollerRef.current
    zoomAnchorRef.current = null
    if (!a || !el) return
    const track = el.firstElementChild as HTMLElement | null
    if (!track) return
    el.scrollLeft = Math.max(0, el.scrollLeft + (track.getBoundingClientRect().left - a.x + a.t * pps))
  }, [pps])

  // превью: результат важнее выбора; выбор не перебивает проигрывание сборки
  // (правка 858) при паузе и скрабе не перезаписываем previewSrc поверх
  // буфера, который уже показывает клип под плейхедом (previewVolKeyRef)
  useEffect(() => {
    if (result) {
      previewVolKeyRef.current = null
      bufShotKeyRef.current[bufRef.current] = null
      setPreviewSrc(result.url)
    } else if (selected && !playing && idxRef.current < 0 && !previewVolKeyRef.current) {
      previewVolKeyRef.current = selected.key
      bufShotKeyRef.current[bufRef.current] = selected.key
      const r = effRange(selected)
      wantSeekRef.current[bufRef.current] = r.start
      setPreviewSrc(selected.url)
    } else if (!shots.length && !playing) {
      previewVolKeyRef.current = null
      bufShotKeyRef.current = [null, null]
      setPreviewSrc(null)
    }
  }, [result, selected, playing, shots.length])

  /** индекс строки seq, которой принадлежит время t на шкале сборки */
  const findRow = (t: number): number => {
    const sq = seqRef.current
    for (let i = 0; i < sq.length; i++) if (t < sq[i].offset + sq[i].len - 0.001) return i
    return sq.length - 1
  }

  /**
   * (правка 860) определяет, попадает ли время t на шкале сборки внутрь клипа
   * или в пустой промежуток (gap) перед клипом idx.
   */
  const findAtTime = (t: number): { inGap: boolean; idx: number } => {
    const sq = seqRef.current
    for (let i = 0; i < sq.length; i++) {
      if (t < sq[i].offset - 0.004) return { inGap: true, idx: i }
      if (t < sq[i].offset + sq[i].len - 0.001) return { inGap: false, idx: i }
    }
    return { inGap: false, idx: Math.max(0, sq.length - 1) }
  }

  /** <video> буфера превью по индексу */
  const bufEl = (b: number): HTMLVideoElement | null => (b === 0 ? previewARef.current : previewBRef.current)

  /**
   * (правка 858) Мгновенно (0 мс, без React-рендера) обновляет положение линии
   * плейхеда, текст таймкода и зеркало seqTRef.
   */
  const syncPlayheadDOM = useCallback((t: number, total?: number) => {
    seqTRef.current = t
    const ph = playheadRef.current
    if (ph) ph.style.left = `${t * ppsRef.current}px`
    const tc = timecodeRef.current
    if (tc) {
      const tot = total ?? tlEndRef.current
      tc.textContent = `${fmtT(t)} / ${fmtT(tot)}`
    }
  }, [])

  /**
   * (правка 858) Быстрый seek буфера b без очереди отменённых декодов:
   * если декодер сейчас ищет кадр (v.seeking === true), не сбиваем его новым
   * currentTime (иначе при ведении мыши картинка замирает до остановки руки),
   * а сохраняем самую свежую цель в pendingSeekRef[b] — onSeeked тут же
   * прыгнет туда.
   */
  const seekBufferTo = useCallback((b: number, target: number, immediate = false) => {
    const v = bufEl(b)
    if (!v) return
    if (v.readyState < 1) {
      wantSeekRef.current[b] = target
      pendingSeekRef.current[b] = null
      return
    }
    wantSeekRef.current[b] = null
    if (!immediate && v.seeking) {
      pendingSeekRef.current[b] = target
      return
    }
    pendingSeekRef.current[b] = null
    if (Math.abs(v.currentTime - target) > 0.004) {
      try { v.currentTime = target } catch { wantSeekRef.current[b] = target }
    }
  }, [])

  /** (правка 720 v11) коэффициент фейда звука клипа на localT (сек исходника) */
  const fadeGain = useCallback((row: SeqRow, localT: number): number => {
    const fi = row.shot.fadeIn || 0
    const fo = row.shot.fadeOut || 0
    let g = 1
    if (fi > 0.01) g = Math.min(g, clamp01((localT - row.r.start) / fi))
    if (fo > 0.01) g = Math.min(g, clamp01((row.r.end - localT) / fo))
    return g
  }, [])

  /** итоговая громкость клипа i: мастер × громкость клипа × фейды (если задан localT) */
  const effVol = useCallback((i: number, localT?: number): number => {
    const row = i >= 0 ? seqRef.current[i] : undefined
    const c = row ? (row.shot.vol ?? 1) : 1
    const f = row && localT != null ? fadeGain(row, localT) : 1
    return clamp01(masterVolRef.current * c * f)
  }, [fadeGain])

  /** сбрасывает состояние резервного буфера превью */
  const resetStage = useCallback(() => {
    stageSeekRef.current = null
  }, [])

  /**
   * Греет резервный буфер под клип i: ставит src и позицию, ждёт декода кадра.
   * Элемент скрыт (opacity 0, но в макете) — стартовый кадр отрисован заранее,
   * и на стыке он просто становится видимым: без чёрного кадра и перезагрузки.
   */
  const stageClip = useCallback((b: number, i: number, localT: number) => {
    const el = bufEl(b)
    const row = seqRef.current[i]
    if (!el || !row) return
    const t = Math.max(row.r.start, Math.min(row.r.end - 0.01, localT))
    stageSeekRef.current = { idx: i, t }
    bufShotKeyRef.current[b] = row.shot.key
    // (правка 851) скорость шота в превью: браузерный playbackRate (звук тоже темпится)
    el.playbackRate = shotSpeed(row.shot)
    el.pause()
    el.muted = true // на время прогрева звук только у видимого буфера
    if (el.getAttribute('src') !== row.shot.url) {
      pendingSeekRef.current[b] = null
      wantSeekRef.current[b] = t
      el.src = row.shot.url
      el.load()
    } else {
      seekBufferTo(b, t, true)
    }
  }, [seekBufferTo])

  /** меняет активный буфер на прогретый резервный (стык без скачка) */
  const swapTo = useCallback((b: number) => {
    const el = bufEl(b)
    const st = stageSeekRef.current
    if (!el || !st) return
    const old = bufEl(b === 0 ? 1 : 0)
    if (old) {
      old.pause()
      old.muted = true
    }
    gapPlayRef.current = null
    if (inGapRef.current) {
      inGapRef.current = false
      setInGap(false)
    }
    stageSeekRef.current = null
    idxRef.current = st.idx
    const srow = seqRef.current[st.idx]
    if (srow) {
      previewVolKeyRef.current = srow.shot.key
      bufShotKeyRef.current[b] = srow.shot.key
      setPreviewSrc(srow.shot.url)
      el.playbackRate = shotSpeed(srow.shot)
    }
    bufRef.current = b
    setBuf(b)
    if (Math.abs(el.currentTime - st.t) > 0.08) {
      try { el.currentTime = st.t } catch { /* ignore */ }
    }
    el.muted = mutedRef.current
    el.volume = effVol(st.idx, st.t)
    void el.play().catch(() => { /* автоплей заблокирован */ })
    // (правка 858) сразу начинаем греть освободившийся буфер под следующий клип
    const nextIdx = st.idx + 1
    if (nextIdx < seqRef.current.length) {
      stageClip(b === 0 ? 1 : 0, nextIdx, seqRef.current[nextIdx].r.start)
    }
  }, [effVol, stageClip])

  /** ставит в активный буфер клип i сборки на время localT (шкала исходника) */
  const showClip = useCallback((i: number, localT: number, autoplay: boolean) => {
    const row = seqRef.current[i]
    if (!row) return
    gapPlayRef.current = null
    if (inGapRef.current) {
      inGapRef.current = false
      setInGap(false)
    }
    resetStage()
    idxRef.current = i
    previewVolKeyRef.current = row.shot.key
    const t = Math.max(row.r.start, Math.min(row.r.end - 0.01, localT))
    // (правка 858) если резервный буфер уже держит этот URL — переключаемся на
    // него мгновенно без перезагрузки src и без чёрной вспышки
    let b = bufRef.current
    const curV = bufEl(b)
    const altB = b === 0 ? 1 : 0
    const altV = bufEl(altB)
    if (curV && curV.getAttribute('src') !== row.shot.url && altV && altV.getAttribute('src') === row.shot.url) {
      curV.pause()
      curV.muted = true
      b = altB
      bufRef.current = b
      setBuf(b)
    }
    const v = bufEl(b)
    if (!v) return
    bufShotKeyRef.current[b] = row.shot.key
    setPreviewSrc(row.shot.url)
    v.muted = mutedRef.current
    v.volume = effVol(i, t)
    // (правка 851) скорость шота в превью
    v.playbackRate = shotSpeed(row.shot)
    if (v.getAttribute('src') === row.shot.url && v.readyState >= 1) {
      seekBufferTo(b, t, true)
      if (autoplay) void v.play().catch(() => { /* автоплей заблокирован */ })
    } else {
      // новый файл: старт даём на loadedmetadata (см. JSX превью) — иначе
      // первые кадры и звук идут с нуля файла, а не с позиции подрезки
      pendingSeekRef.current[b] = null
      wantSeekRef.current[b] = t
      if (v.getAttribute('src') !== row.shot.url) {
        v.src = row.shot.url
        v.load()
      }
    }
    // (правка 858) параллельно прогреваем следующий клип во втором буфере
    const nextIdx = i + 1
    if (nextIdx < seqRef.current.length) {
      stageClip(b === 0 ? 1 : 0, nextIdx, seqRef.current[nextIdx].r.start)
    }
  }, [resetStage, effVol, seekBufferTo, stageClip])

  /** (правка 860) запускает проигрывание пустого промежутка (паузы) до начала клипа nextIdx */
  const startGapPlay = useCallback((fromT: number, toT: number, nextIdx: number) => {
    for (const v of [previewARef.current, previewBRef.current]) if (v) v.pause()
    idxRef.current = -1
    inGapRef.current = true
    setInGap(true)
    gapPlayRef.current = { startWall: performance.now(), startT: fromT, endT: toT, nextIdx }
    const sq = seqRef.current
    if (nextIdx >= 0 && nextIdx < sq.length) {
      setPreviewSrc(sq[nextIdx].shot.url)
      stageClip(bufRef.current === 0 ? 1 : 0, nextIdx, sq[nextIdx].r.start)
    }
  }, [stageClip])

  const stopSeq = useCallback((resetHead: boolean) => {
    playingRef.current = false
    setPlaying(false)
    cancelAnimationFrame(rafRef.current)
    gapPlayRef.current = null
    resetStage()
    // (правка 720 v11) пауза: выделение едет за плейхедом — тогда превью
    // совпадает с уже показанным буфером, src не перезагружается и кадр остаётся
    const i = idxRef.current
    if (!resetHead && i >= 0) {
      const row = seqRef.current[i]
      if (row) {
        previewVolKeyRef.current = row.shot.key
        setSelectedKey(row.shot.key)
      }
    }
    idxRef.current = -1
    for (const v of [previewARef.current, previewBRef.current]) if (v) v.pause()
    if (resetHead) {
      inGapRef.current = false
      setInGap(false)
      syncPlayheadDOM(0)
      setPlayT(0)
    } else {
      setPlayT(seqTRef.current)
    }
  }, [resetStage, syncPlayheadDOM])

  const playSeq = useCallback(() => {
    const sq = seqRef.current
    // (правка 879) дорожки равноценны: играем всю композицию, даже если V1 пуста
    const endT = tlEndRef.current
    if (endT <= 0) return
    setResult(null)
    const start = seqTRef.current >= endT - 0.05 ? 0 : seqTRef.current
    syncPlayheadDOM(start, endT)
    setPlayT(start)
    setPlaying(true)
    playingRef.current = true
    // пустая V1 или позиция за её концом — идём по часам, слои/звук играют сами
    if (!sq.length || start >= totalSec - 0.001) {
      startGapPlay(start, endT, -1)
      return
    }
    const loc = findAtTime(start)
    if (loc.inGap) {
      startGapPlay(start, sq[loc.idx].offset, loc.idx)
      return
    }
    const row = sq[loc.idx]
    // (правка 858) переводим время сборки start в локальное время исходника клипа
    const local = row.r.start + Math.max(0, start - row.offset) * shotSpeed(row.shot)
    showClip(loc.idx, local, true)
  }, [showClip, totalSec, syncPlayheadDOM, startGapPlay])

  const pauseSeq = useCallback(() => {
    stopSeq(false)
  }, [stopSeq])

  const togglePlay = useCallback(() => {
    if (playingRef.current) pauseSeq()
    else playSeq()
  }, [pauseSeq, playSeq])

  /**
   * переносит курсор сборки на время t (шкала сборки).
   * (правка 858) fastScrub=true при ведении мыши: DOM плейхеда и таймкода
   * обновляются синхронно в 0 мс, кадр ищется с коалесингом по onSeeked, а
   * React-состояние playT троттлится до 1 раза за rAF.
   * (правка 860) если время попадает в пустой промежуток между клипами (gap) —
   * в превью показывается чёрный кадр.
   */
  const seekTo = useCallback((t: number, fastScrub = false) => {
    const sq = seqRef.current
    // (правка 879) шкала принадлежит всей композиции, а не только V1
    const endT = tlEndRef.current
    if (endT <= 0) return
    const baseEnd = sq.length ? sq[sq.length - 1].offset + sq[sq.length - 1].len : 0
    let ct = Math.max(0, Math.min(endT, t))
    // (правка 720 v11) магнит: рядом с границей клипа плейхед прилипает к ней
    if (snapRef.current) {
      const tol = Math.min(0.15, 7 / Math.max(8, ppsRef.current))
      for (const r of sq) {
        if (Math.abs(ct - r.offset) <= tol) { ct = r.offset; break }
        if (Math.abs(ct - (r.offset + r.len)) <= tol) { ct = Math.min(endT, r.offset + r.len); break }
      }
    }
    // (правка 858) мгновенно двигаем плейхед и таймкод в DOM без ожидания React
    syncPlayheadDOM(ct, endT)
    if (fastScrub) {
      if (!scrubRafRef.current) {
        scrubRafRef.current = requestAnimationFrame(() => {
          scrubRafRef.current = 0
          if (mountedRef.current) setPlayT(seqTRef.current)
        })
      }
    } else {
      setPlayT(ct)
    }
    // (правка 879) пустая V1 или время за её концом: кадр пустой, слои/звук идут
    const pastBase = !sq.length || ct >= baseEnd - 0.001
    const loc = pastBase ? { inGap: true, idx: 0 } : findAtTime(ct)
    if (pastBase || loc.inGap) {
      const gapEnd = pastBase ? endT : sq[loc.idx].offset
      if (playingRef.current) {
        startGapPlay(ct, gapEnd, pastBase ? -1 : loc.idx)
      } else {
        gapPlayRef.current = null
        idxRef.current = -1
        for (const v of [previewARef.current, previewBRef.current]) if (v) v.pause()
        if (!inGapRef.current) {
          inGapRef.current = true
          setInGap(true)
        }
        if (!pastBase) {
          const nrow = sq[loc.idx]
          if (nrow) {
            setPreviewSrc(nrow.shot.url)
            stageClip(bufRef.current === 0 ? 1 : 0, loc.idx, nrow.r.start)
          }
        }
      }
      return
    }
    gapPlayRef.current = null
    if (inGapRef.current) {
      inGapRef.current = false
      setInGap(false)
    }
    const i = loc.idx
    const row = sq[i]
    // (правка 851) шкала сборки пересчитывается через скорость: local = start + dt·speed
    const local = Math.max(row.r.start, Math.min(row.r.end - 0.005, row.r.start + (ct - row.offset) * shotSpeed(row.shot)))
    if (playingRef.current) {
      showClip(i, local, true)
    } else {
      resetStage()
      idxRef.current = -1
      previewVolKeyRef.current = row.shot.key
      // (правка 858) если другой буфер уже держит этот клип — переключаемся на
      // него без перезагрузки src (переход через склейку при скрабе мгновенный)
      let b = bufRef.current
      const curV = bufEl(b)
      const altB = b === 0 ? 1 : 0
      const altV = bufEl(altB)
      if (curV && curV.getAttribute('src') !== row.shot.url && altV && altV.getAttribute('src') === row.shot.url) {
        b = altB
        bufRef.current = b
        setBuf(b)
      }
      bufShotKeyRef.current[b] = row.shot.key
      setPreviewSrc(row.shot.url)
      const v = bufEl(b)
      if (v) {
        v.volume = effVol(i, local)
        v.playbackRate = shotSpeed(row.shot)
        if (v.getAttribute('src') === row.shot.url) {
          seekBufferTo(b, local, !fastScrub)
        } else {
          pendingSeekRef.current[b] = null
          wantSeekRef.current[b] = local
          v.src = row.shot.url
          v.load()
        }
      }
      // предпрогреваем соседний клип во втором буфере для бесшовного скраба через стык
      const neighborIdx = ct - row.offset > row.len * 0.5 ? i + 1 : i - 1
      if (neighborIdx >= 0 && neighborIdx < sq.length) {
        const nb = b === 0 ? 1 : 0
        const nv = bufEl(nb)
        const nrow = sq[neighborIdx]
        if (nv && nrow && nv.getAttribute('src') !== nrow.shot.url) {
          stageClip(nb, neighborIdx, neighborIdx > i ? nrow.r.start : Math.max(nrow.r.start, nrow.r.end - 0.05))
        }
      }
    }
  }, [showClip, resetStage, effVol, syncPlayheadDOM, seekBufferTo, stageClip, startGapPlay])

  const scrubBy = useCallback((dt: number) => seekTo(seqTRef.current + dt), [seekTo])

  /**
   * (правка 720 v11) снимок таймлайна перед изменением — для Ctrl+Z.
   * Храним сами шоты: подрезки, громкости, фейды, порядок.
   */
  const pushHistory = useCallback(() => {
    undoRef.current.push({
      shots: shotsRef.current.map((s) => ({ ...s })),
      layers: layersRef.current.map((l) => ({ ...l })),
      audios: audiosRef.current.map((a) => ({ ...a })),
      layerTracks: layerTracksRef.current,
      audioTracks: audioTracksRef.current,
    })
    if (undoRef.current.length > 50) undoRef.current.shift()
    redoRef.current = []
    setHistTick((v) => v + 1)
  }, [])

  const undo = useCallback(() => {
    const prev = undoRef.current.pop()
    if (!prev) return
    redoRef.current.push({
      shots: shotsRef.current.map((s) => ({ ...s })),
      layers: layersRef.current.map((l) => ({ ...l })),
      audios: audiosRef.current.map((a) => ({ ...a })),
      layerTracks: layerTracksRef.current,
      audioTracks: audioTracksRef.current,
    })
    setHistTick((v) => v + 1)
    stopSeq(false)
    setResult(null)
    setShots(prev.shots)
    setLayers(prev.layers)
    setAudios(prev.audios)
    setLayerTracks(prev.layerTracks ?? prev.layers.reduce((m, l) => Math.max(m, l.track), 0))
    setAudioTracks(prev.audioTracks ?? prev.audios.reduce((m, a) => Math.max(m, a.track), 0))
    setSelectedKey((cur) => (cur && prev.shots.some((s) => s.key === cur) ? cur : null))
    setSelectedLayerKey((cur) => (cur && prev.layers.some((l) => l.key === cur) ? cur : null))
    setSelectedAudioKey((cur) => (cur && prev.audios.some((a) => a.key === cur) ? cur : null))
  }, [stopSeq])

  const redo = useCallback(() => {
    const next = redoRef.current.pop()
    if (!next) return
    undoRef.current.push({
      shots: shotsRef.current.map((s) => ({ ...s })),
      layers: layersRef.current.map((l) => ({ ...l })),
      audios: audiosRef.current.map((a) => ({ ...a })),
      layerTracks: layerTracksRef.current,
      audioTracks: audioTracksRef.current,
    })
    setHistTick((v) => v + 1)
    stopSeq(false)
    setResult(null)
    setShots(next.shots)
    setLayers(next.layers)
    setAudios(next.audios)
    setLayerTracks(next.layerTracks ?? next.layers.reduce((m, l) => Math.max(m, l.track), 0))
    setAudioTracks(next.audioTracks ?? next.audios.reduce((m, a) => Math.max(m, a.track), 0))
    setSelectedKey((cur) => (cur && next.shots.some((s) => s.key === cur) ? cur : null))
    setSelectedLayerKey((cur) => (cur && next.layers.some((l) => l.key === cur) ? cur : null))
    setSelectedAudioKey((cur) => (cur && next.audios.some((a) => a.key === cur) ? cur : null))
  }, [stopSeq])

  /** (правка 883) тянем границу между превью и таймлайном — делим дельту мыши на
   *  суммарный множитель всех видимых дорожек и ограничиваем упор превью (120 px),
   *  чтобы граница шла ровно 1:1 под курсором мыши и не улетала вверх быстрее него */
  const startTlResize = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    suppressDrag.current = true
    const startY = e.clientY
    const startH = trackHRef.current
    const vExtra = Math.min(MAX_TRACKS, Math.max(layerTracksRef.current, layersRef.current.reduce((m, l) => Math.max(m, l.track), 0)))
    const aExtra = Math.min(MAX_TRACKS, Math.max(audioTracksRef.current, audiosRef.current.reduce((m, a) => Math.max(m, a.track), 0)))
    const mult = Math.max(1, 1 + vExtra + aExtra * 0.45)
    const previewH = previewBoxRef.current?.getBoundingClientRect().height ?? 360
    const maxGrowPx = Math.max(0, previewH - 120)
    const maxH = Math.max(startH, Math.min(480, Math.floor(startH + maxGrowPx / mult)))
    const onMove = (ev: PointerEvent) => {
      const nextH = Math.round(startH + (startY - ev.clientY) / mult)
      setTrackH(Math.max(40, Math.min(maxH, nextH)))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      suppressDrag.current = false
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [])

  // пока играет: плейхед и переключение клипов идут за currentTime активного буфера
  // (правка 860) а в пустых промежутках (gap) — по часам gapPlayRef с чёрным экраном
  useEffect(() => {
    if (!playing) return
    let lastStateCommit = 0
    const tick = (now: number) => {
      const sq = seqRef.current
      const tot = tlEndRef.current
      const baseEnd = sq.length ? sq[sq.length - 1].offset + sq[sq.length - 1].len : 0
      const gp = gapPlayRef.current
      if (gp) {
        const t = Math.min(gp.endT, gp.startT + (now - gp.startWall) / 1000)
        syncPlayheadDOM(t, tot)
        if (now - lastStateCommit >= 160) {
          lastStateCommit = now
          setPlayT(t)
        }
        const sc = scrollerRef.current
        if (sc) {
          const x = t * ppsRef.current
          if (x > sc.scrollLeft + sc.clientWidth - 80) sc.scrollLeft = x - sc.clientWidth + 120
          else if (x < sc.scrollLeft) sc.scrollLeft = Math.max(0, x - 20)
        }
        if (t >= gp.endT - 0.015) {
          const ni = gp.nextIdx
          if (ni < 0) {
            // (правка 879) хвост композиции без клипов V1: луп или стоп
            if (loop) {
              syncPlayheadDOM(0, tot)
              setPlayT(0)
              if (sq.length && sq[0].gap < 0.02) showClip(0, sq[0].r.start, true)
              else startGapPlay(0, sq.length ? sq[0].offset : tot, sq.length ? 0 : -1)
            } else stopSeq(false)
          } else {
            const sb = bufRef.current === 0 ? 1 : 0
            const sel = bufEl(sb)
            const stg = stageSeekRef.current
            if (stg && stg.idx === ni && sel && sel.readyState >= 2) swapTo(sb)
            else if (sq[ni]) showClip(ni, sq[ni].r.start, true)
            else stopSeq(false)
          }
        }
        rafRef.current = requestAnimationFrame(tick)
        return
      }
      const i = idxRef.current
      const row = i >= 0 ? sq[i] : undefined
      const v = bufEl(bufRef.current)
      if (v && row && !v.paused) {
        const sp = shotSpeed(row.shot)
        const ct = Math.max(row.r.start, Math.min(row.r.end, v.currentTime))
        // (правка 851, 858) позиция на шкале сборки: dt исходника ДЕЛИТСЯ на скорость шота
        const t = row.offset + (ct - row.r.start) / sp
        syncPlayheadDOM(t, tot)
        if (now - lastStateCommit >= 160) {
          lastStateCommit = now
          setPlayT(t)
        }
        // плавная автопрокрутка дорожки за плейхедом прямо в rAF
        const sc = scrollerRef.current
        if (sc) {
          const x = t * ppsRef.current
          if (x > sc.scrollLeft + sc.clientWidth - 80) sc.scrollLeft = x - sc.clientWidth + 120
          else if (x < sc.scrollLeft) sc.scrollLeft = Math.max(0, x - 20)
        }
        v.volume = effVol(i, ct)
        const ni = i + 1
        const sb = bufRef.current === 0 ? 1 : 0
        const endMargin = Math.max(0.035, 0.035 * sp)
        if (loopClipRef.current) {
          // (правка 720 v11) луп текущего клипа: доводим до конца и перезапускаем
          if (ct >= row.r.end - endMargin) {
            try { v.currentTime = row.r.start + 0.001 } catch { /* ignore */ }
            syncPlayheadDOM(row.offset, tot)
            setPlayT(row.offset)
          }
        } else if (ni < sq.length) {
          // заранее греем резервный буфер под следующий клип (с поправкой на скорость)
          if ((!stageSeekRef.current || stageSeekRef.current.idx !== ni) && (row.r.end - ct) / sp <= PREWARM * 1.5) {
            stageClip(sb, ni, sq[ni].r.start)
          }
          if (ct >= row.r.end - endMargin) {
            // (правка 860) если перед следующим клипом есть пустой промежуток (gap),
            // проигрываем паузу (чёрный кадр + тишина) до его старта sq[ni].offset
            if (sq[ni].gap >= 0.02) {
              startGapPlay(row.offset + row.len, sq[ni].offset, ni)
            } else {
              const sel = bufEl(sb)
              const stg = stageSeekRef.current
              if (stg && stg.idx === ni && sel && sel.readyState >= 2) swapTo(sb)
              else showClip(ni, sq[ni].r.start, true)
            }
          }
        } else if (ct >= row.r.end - endMargin) {
          // (правка 879) за концом последнего клипа V1 композиция может продолжаться
          // слоями/аудио — доигрываем хвост по часам, а не обрываем воспроизведение
          if (tot > baseEnd + 0.02) {
            startGapPlay(baseEnd, tot, -1)
          } else if (loop) {
            syncPlayheadDOM(0, tot)
            setPlayT(0)
            if (sq[0].gap >= 0.02) startGapPlay(0, sq[0].offset, 0)
            else showClip(0, sq[0].r.start, true)
          } else stopSeq(false)
        }
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [playing, loop, showClip, stopSeq, stageClip, swapTo, effVol, syncPlayheadDOM, startGapPlay])

  // звук в превью: у скрытого буфера всегда тихо, чтобы не было двойного звука
  useEffect(() => {
    mutedRef.current = muted
    if (previewARef.current) previewARef.current.muted = muted || buf !== 0
    if (previewBRef.current) previewBRef.current.muted = muted || buf !== 1
  }, [muted, buf])

  // громкость активного буфера: мастер × громкость клипа × фейды; в превью результата
  // громкость уже вплавляна в файл, там = 1
  useEffect(() => {
    masterVolRef.current = masterVol
    const v = bufEl(bufRef.current)
    if (!v) return
    const i = idxRef.current
    const key = i >= 0 ? seqRef.current[i]?.shot.key : previewVolKeyRef.current
    const shot = key ? shots.find((s) => s.key === key) : null
    if (!shot) { v.volume = 1; return }
    // (правка 720 v11) фейды клипа действуют и в превью, по позиции currentTime
    const row = i >= 0 ? seqRef.current[i] : seqRef.current.find((r) => r.shot.key === key)
    const local = row ? Math.max(row.r.start, Math.min(row.r.end, v.currentTime)) : undefined
    v.volume = clamp01(masterVol * (shot.vol ?? 1) * (row && local != null ? fadeGain(row, local) : 1))
  }, [masterVol, shots, result, previewSrc, buf, fadeGain])

  // ставим src на активный <video> прямо (без key), если он отличается
  useEffect(() => {
    const v = bufEl(bufRef.current)
    if (!v) return
    const cur = v.getAttribute('src')
    if (previewSrc == null) {
      if (cur != null) { v.removeAttribute('src'); v.load() }
      return
    }
    if (cur === previewSrc) return
    v.src = previewSrc
    v.load()
  }, [previewSrc])

  // кинополосы для блоков; ключ — файл + подрезка, при смене
  // подрезки/разрезе полоса переснимается по новому диапазону.
  // (правка 854) ключ и съёмка учитывают размер блока (зум/высота дорожки).
  // (правка 858) неблокирующая съёмка: дебаунс 250 мс, пауза на время игры и
  // перетаскивания, и по 1 клипу за раз — декодер видео остаётся свободным для
  // мгновенного скраба и воспроизведения.
  const stripDims = useCallback(
    (row: { len: number }) => ({
      w: stripBucketW(row.len * pps),
      h: stripBucketH(trackH),
    }),
    [pps, trackH],
  )
  // (правка 876) размеры/окно кинополосы для чипа слоя (тот же кэш strips, что у базы)
  const layerStripReq = useCallback(
    (l: LayerClip) => {
      const w = stripBucketW(layerLen(l) * pps)
      const h = stripBucketH(trackH)
      const start = l.trimStart
      const end = Math.max(start + 0.05, (l.duration || 0) - l.trimEnd)
      return { w, h, r: { start, end } }
    },
    [layerLen, pps, trackH],
  )
  useEffect(() => {
    if (playing) return
    type StripJob = { url: string; r: { start: number; end: number }; w: number; h: number; shotKey?: string; layerKey?: string }
    const jobs: StripJob[] = []
    for (const row of seq) {
      const { w, h } = stripDims(row)
      jobs.push({ url: row.shot.url, r: row.r, w, h, shotKey: row.shot.key })
    }
    // (правка 876) полосы для чипов слоёв V2+ — как у базовой дорожки
    for (const l of layers) {
      if (!l.duration) continue
      const { w, h, r } = layerStripReq(l)
      jobs.push({ url: l.url, r, w, h, layerKey: l.key })
    }
    // (правка 841) чистим полосы ушедших шотов/подрезок: без этого кэш dataURL
    // растёт всю жизнь вкладки (единицы МБ на каждые 60 клипов с правками)
    const live = new Set(jobs.map((j) => stripKey(j.url, j.r, j.w, j.h)))
    setStrips((prev) => {
      const keys = Object.keys(prev)
      if (!keys.some((k) => !live.has(k))) return prev
      const next: Record<string, string> = {}
      for (const k of keys) if (live.has(k)) next[k] = prev[k]
      return next
    })
    const need = jobs.filter((j) => {
      const k = stripKey(j.url, j.r, j.w, j.h)
      return !strips[k] && !stripBusy.current.has(k)
    })
    if (!need.length) return
    const timer = setTimeout(() => {
      if (playingRef.current || scrubbingRef.current || suppressDrag.current) return
      const job = need[0]
      const k = stripKey(job.url, job.r, job.w, job.h)
      if (stripBusy.current.has(k)) return
      stripBusy.current.add(k)
      makeStrip(job.url, job.r, job.w, job.h).then((data) => {
        stripBusy.current.delete(k)
        // (правка 842) вкладка могла закрыться/шот удалиться, пока полоса строилась
        if (!mountedRef.current || !live.has(k)) return
        if (data && job.shotKey) lastStripByShotRef.current[job.shotKey] = data
        if (data && job.layerKey) lastStripByLayerRef.current[job.layerKey] = data
        setStrips((prev) => ({ ...prev, [k]: data ?? '' }))
      })
    }, 240)
    return () => clearTimeout(timer)
  }, [seq, strips, stripDims, layerStripReq, playing, layers])

  // скраб по линейке и за головку плейхеда
  const startScrub = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    const track = trackRef.current
    if (!track) return
    setResult(null)
    scrubbingRef.current = true
    const wasPlaying = playingRef.current
    if (wasPlaying) stopSeq(false)
    const at = (cx: number, fast: boolean) => {
      const rect = track.getBoundingClientRect()
      seekTo((cx - rect.left) / ppsRef.current, fast)
    }
    at(e.clientX, false)
    const onMove = (ev: PointerEvent) => at(ev.clientX, true)
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      scrubbingRef.current = false
      if (scrubRafRef.current) {
        cancelAnimationFrame(scrubRafRef.current)
        scrubRafRef.current = 0
      }
      at(ev.clientX, false)
      // выделяем клип, на котором остановился плейхед
      const sq = seqRef.current
      if (sq.length) {
        const row = sq[findRow(seqTRef.current)]
        if (row) setSelectedKey(row.shot.key)
      }
      if (wasPlaying) playSeq()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [seekTo, stopSeq, playSeq])

  const addShot = useCallback(
    (f: VideoGalleryFile, atIdx?: number) => {
      if (shots.length >= MAX_SHOTS) {
        showToast('Максимум 60 шотов на таймлайне', 'error')
        return
      }
      pushHistory()
      stopSeq(true)
      const shot: MontageShot = {
        key: newShotKey(), filename: f.filename, subfolder: f.subfolder || '', url: f.url,
        name: f.filename.replace(/\.[^.]+$/, ''), trimStart: '', trimEnd: '', duration: 0,
      }
      setShots((prev) => {
        const idx = atIdx == null ? prev.length : Math.max(0, Math.min(atIdx, prev.length))
        const next = [...prev]
        next.splice(idx, 0, shot)
        return next
      })
      setSelectedKey(shot.key)
      setResult(null)
      // реальная длительность для ширины блока и trim
      getVideoDuration(f.url).then((d) => {
        // (правка 842) не дёргаем setState, если вкладка уже размонтирована
        if (d > 0 && mountedRef.current) setShots((cur) => cur.map((x) => (x.key === shot.key ? { ...x, duration: d } : x)))
      })
    },
    [shots.length, stopSeq, pushHistory],
  )

  const removeShot = useCallback((key: string) => {
    pushHistory()
    stopSeq(false)
    setShots((prev) => prev.filter((s) => s.key !== key))
    setSelectedKey((cur) => (cur === key ? null : cur))
  }, [stopSeq, pushHistory])

  /** разрез шота под плейхедом на две части (S) */
  /**
   * (правка 880) разрез клипа слоя по времени сборки t: возвращает [лево, право]
   * или null, если разрезать нельзя (края, неизвестная длительность).
   */
  const splitLayerAt = useCallback((l: LayerClip, t: number): [LayerClip, LayerClip] | null => {
    if (!l.duration) return null
    const len = layerLen(l)
    if (t < l.at + 0.05 || t >= l.at + len - 0.05) return null
    const local = l.trimStart + (t - l.at) * (l.speed || 1)
    if (local >= l.duration - l.trimEnd - 0.05) return null
    const left: LayerClip = { ...l, trimEnd: Math.max(0, +(l.duration - local).toFixed(3)) }
    const right: LayerClip = { ...l, key: newLayerKey(), at: +t.toFixed(3), trimStart: +Math.max(0, local).toFixed(3) }
    return [left, right]
  }, [layerLen])

  /** (правка 880) разрез аудиоклипа по времени сборки t */
  const splitAudioAt = useCallback((a: AudioClip, t: number): [AudioClip, AudioClip] | null => {
    if (!a.duration) return null
    const len = audioLen(a)
    if (t < a.at + 0.05 || t >= a.at + len - 0.05) return null
    const local = Math.max(0, Math.min(a.duration - 0.05, a.trimStart + (t - a.at)))
    const left: AudioClip = { ...a, trimEnd: Math.max(0, +(a.duration - local).toFixed(3)) }
    const right: AudioClip = { ...a, key: newAudioKey(), at: +t.toFixed(3), trimStart: +local.toFixed(3) }
    return [left, right]
  }, [audioLen])

  /** (правка 880) разрез клипа базы по времени сборки t (скорость шота учтена) */
  const splitShotAt = useCallback((row: SeqRow, t: number): [MontageShot, MontageShot] | null => {
    const local = row.r.start + (t - row.offset) * shotSpeed(row.shot)
    if (local <= row.r.start + 0.05 || local >= row.r.end - 0.05) return null
    const cut = local.toFixed(2)
    const left: MontageShot = { ...row.shot, trimEnd: cut }
    // (правка 860) правая половинка идёт встык за левой (gap: 0)
    const right: MontageShot = { ...row.shot, key: newShotKey(), trimStart: cut, trimEnd: row.shot.trimEnd, gap: 0 }
    return [left, right]
  }, [])

  const splitAtPlayhead = useCallback(() => {
    const t = seqTRef.current
    const sq = seqRef.current
    // (правка 876) разрез по плейхеду работает для любого выделенного клипа:
    // очерёдность та же, что у Del/D и панели свойств — слой → аудио → база
    const lay = selectedLayerKey ? layersRef.current.find((x) => x.key === selectedLayerKey) : null
    const aud = selectedAudioKey ? audiosRef.current.find((x) => x.key === selectedAudioKey) : null
    if (lay) {
      stopSeq(false)
      if (!lay.duration) {
        showToast('Длительность исходника ещё не известна — попробуйте позже', 'error')
        return
      }
      const pair = splitLayerAt(lay, t)
      if (!pair) {
        showToast('Поставьте плейхед внутрь клипа слоя (не на его край)', 'error')
        return
      }
      if (layersRef.current.length >= MAX_LAYER_CLIPS) {
        showToast(`Не более ${MAX_LAYER_CLIPS} клипов видео-слоёв`, 'error')
        return
      }
      pushHistory()
      setLayers((prev) => prev.flatMap((x) => (x.key === lay.key ? pair : [x])))
      setSelectedLayerKey(pair[1].key)
      setResult(null)
      return
    }
    if (aud) {
      stopSeq(false)
      if (!aud.duration) {
        showToast('Длительность файла ещё не известна — попробуйте позже', 'error')
        return
      }
      const pair = splitAudioAt(aud, t)
      if (!pair) {
        showToast('Поставьте плейхед внутрь аудиоклипа (не на его край)', 'error')
        return
      }
      if (audiosRef.current.length >= MAX_AUDIO_CLIPS) {
        showToast(`Не более ${MAX_AUDIO_CLIPS} аудиоклипов`, 'error')
        return
      }
      pushHistory()
      setAudios((prev) => prev.flatMap((x) => (x.key === aud.key ? pair : [x])))
      setSelectedAudioKey(pair[1].key)
      setResult(null)
      return
    }
    // (правка 880) клип не выделен — режем всё, что стоит под плейхедом, на всех
    // дорожках (как лезвие в DaVinci): база, слои V2+ и все аудиодорожки
    const baseEnd = sq.length ? sq[sq.length - 1].offset + sq[sq.length - 1].len : 0
    const loc = sq.length && t < baseEnd - 0.001 ? findAtTime(t) : null
    const row = loc && !loc.inGap ? sq[loc.idx] : null
    const shotPair = row ? splitShotAt(row, t) : null
    const layPairs = layersRef.current
      .map((l) => ({ key: l.key, pair: splitLayerAt(l, t) }))
      .filter((p): p is { key: string; pair: [LayerClip, LayerClip] } => !!p.pair)
    const audPairs = audiosRef.current
      .map((a) => ({ key: a.key, pair: splitAudioAt(a, t) }))
      .filter((p): p is { key: string; pair: [AudioClip, AudioClip] } => !!p.pair)
    if (!shotPair && !layPairs.length && !audPairs.length) {
      if (row) showToast('Поставьте плейхед внутрь клипа (не на его край)', 'error')
      else showToast('Поставьте плейхед на клип любой дорожки', 'error')
      return
    }
    if (layPairs.length && layersRef.current.length + layPairs.length > MAX_LAYER_CLIPS) {
      showToast(`Не более ${MAX_LAYER_CLIPS} клипов видео-слоёв`, 'error')
      return
    }
    if (audPairs.length && audiosRef.current.length + audPairs.length > MAX_AUDIO_CLIPS) {
      showToast(`Не более ${MAX_AUDIO_CLIPS} аудиоклипов`, 'error')
      return
    }
    if (shotPair && shotsRef.current.length >= MAX_SHOTS) {
      showToast('Максимум 60 шотов на таймлайне', 'error')
      return
    }
    stopSeq(false)
    pushHistory()
    if (shotPair && row) {
      setShots((prev) => {
        const idx = prev.findIndex((s) => s.key === row.shot.key)
        if (idx < 0) return prev
        const next = [...prev]
        next.splice(idx, 1, shotPair[0], shotPair[1])
        return next
      })
      setSelectedKey(shotPair[1].key)
    }
    if (layPairs.length) {
      const lmap = new Map(layPairs.map((p) => [p.key, p.pair]))
      setLayers((prev) => prev.flatMap((x) => (lmap.has(x.key) ? lmap.get(x.key) as [LayerClip, LayerClip] : [x])))
      setSelectedLayerKey(layPairs[0].pair[1].key)
    }
    if (audPairs.length) {
      const amap = new Map(audPairs.map((p) => [p.key, p.pair]))
      setAudios((prev) => prev.flatMap((x) => (amap.has(x.key) ? amap.get(x.key) as [AudioClip, AudioClip] : [x])))
      if (!shotPair && !layPairs.length) setSelectedAudioKey(audPairs[0].pair[1].key)
    }
    setResult(null)
  }, [stopSeq, pushHistory, selectedLayerKey, selectedAudioKey, splitLayerAt, splitAudioAt, splitShotAt])

  /** копия шота сразу за оригиналом (D) */
  const duplicateShot = useCallback((key: string) => {
    const src = shotsRef.current.find((s) => s.key === key)
    if (!src) return
    if (shotsRef.current.length >= MAX_SHOTS) {
      showToast('Максимум 60 шотов на таймлайне', 'error')
      return
    }
    pushHistory()
    stopSeq(false)
    const copy: MontageShot = { ...src, key: newShotKey() }
    setShots((prev) => {
      const i = prev.findIndex((s) => s.key === key)
      if (i < 0) return prev
      const next = [...prev]
      next.splice(i + 1, 0, copy)
      return next
    })
    selectClip('shot', copy.key)
    setResult(null)
  }, [stopSeq, pushHistory, selectClip])

  /** (правка 720 v11) сдвинуть клип в последовательности (Alt+← / Alt+→) */
  const moveShot = useCallback((key: string | null, dir: -1 | 1) => {
    if (!key) return
    const prev = shotsRef.current
    const from = prev.findIndex((s) => s.key === key)
    const to = from + dir
    if (from < 0 || to < 0 || to >= prev.length) return
    pushHistory()
    stopSeq(false)
    const next = [...prev]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    setShots(next)
  }, [stopSeq, pushHistory])

  /** (правка 874) положить файл галереи клипом на слой track (по умолчанию — верхний ряд, по плейхеду) */
  const addLayerClip = useCallback(
    (f: VideoGalleryFile, at?: number, track?: number) => {
      if (layersRef.current.length >= MAX_LAYER_CLIPS) {
        showToast(`Не более ${MAX_LAYER_CLIPS} клипов видео-слоёв`, 'error')
        return
      }
      const trk = Math.min(MAX_TRACKS, Math.max(1, track ?? Math.max(1, layerTracks)))
      pushHistory()
      const lay: LayerClip = {
        key: newLayerKey(), filename: f.filename, subfolder: f.subfolder || '',
        name: f.filename.replace(/\.[^.]+$/, ''), url: f.url,
        at: Math.max(0, at ?? seqTRef.current), track: trk,
        // (правка 883) contain по умолчанию — все дорожки масштабируются целиком без обрезки
        trimStart: 0, trimEnd: 0, speed: 1, fit: 'contain', duration: 0,
      }
      setLayers((prev) => [...prev, lay])
      setLayerTracks((cur) => Math.max(cur, trk))
      setSelectedLayerKey(lay.key)
      setSelectedKey(null)
      setSelectedAudioKey(null)
      setResult(null)
      getVideoDuration(f.url).then((d) => {
        if (d > 0 && mountedRef.current) setLayers((cur) => cur.map((x) => (x.key === lay.key ? { ...x, duration: d } : x)))
      })
    },
    [layerTracks, pushHistory],
  )

  /**
   * (правка 878) базовая дорожка — обычная дорожка: клип V1 можно перетащить
   * на любой ряд V2+ (и обратно). Здесь шот базы превращается в клип слоя:
   * сохраняются подрезка, скорость, эффекты, громкость/фейды; на месте шота в
   * базе остаётся дырка, чтобы клипы справа не прыгали.
   */
  const shotToLayer = useCallback(
    (key: string, track: number, at: number, opts?: { history?: boolean }) => {
      const row = seqRef.current.find((r) => r.shot.key === key)
      if (!row) return
      if (layersRef.current.length >= MAX_LAYER_CLIPS) {
        showToast(`Не более ${MAX_LAYER_CLIPS} клипов видео-слоёв`, 'error')
        return
      }
      const shot = row.shot
      const sp = shotSpeed(shot)
      const r = effRange(shot)
      const duration = shot.duration > 0 ? shot.duration : r.end
      const trimStart = Math.max(0, Math.min(r.start, duration))
      const trimEnd = Math.max(0, duration - r.end)
      const trk = Math.min(MAX_TRACKS, Math.max(1, track))
      const lay: LayerClip = {
        key: newLayerKey(),
        filename: shot.filename,
        subfolder: shot.subfolder || '',
        name: shot.name,
        url: shot.url,
        at: Math.max(0, at),
        track: trk,
        trimStart: +trimStart.toFixed(3),
        trimEnd: +trimEnd.toFixed(3),
        speed: sp,
        // (правка 883) contain по умолчанию — как на V1, без обрезки
        fit: 'contain',
        duration,
        fx: shot.fx,
        vol: shot.vol,
        fadeIn: shot.fadeIn,
        fadeOut: shot.fadeOut,
      }
      if (opts?.history !== false) {
        pushHistory()
        stopSeq(false)
      }
      setShots((prev) => {
        const i = prev.findIndex((s) => s.key === key)
        if (i < 0) return prev
        const next = prev.map((s) => ({ ...s }))
        const removed = next.splice(i, 1)[0]
        const gapBefore = Math.max(0, typeof removed.gap === 'number' ? removed.gap : 0)
        // освободившееся место отдаём следующему клипу как паузу — правые клипы
        // остаются на тех же абсолютных позициях
        if (i < next.length) {
          const curGap = Math.max(0, typeof next[i].gap === 'number' ? next[i].gap : 0)
          const g = +(curGap + gapBefore + row.len).toFixed(3)
          next[i] = { ...next[i], gap: g < 0.01 ? undefined : g }
        }
        return next
      })
      setLayers((prev) => [...prev, lay])
      setLayerTracks((cur) => Math.max(cur, trk))
      setSelectedLayerKey(lay.key)
      setSelectedKey(null)
      setSelectedAudioKey(null)
      setResult(null)
      if (!(shot.duration > 0)) {
        getVideoDuration(shot.url).then((d) => {
          if (d > 0 && mountedRef.current) {
            setLayers((cur) =>
              cur.map((x) =>
                x.key === lay.key
                  ? { ...x, duration: Math.max(d, x.trimStart + x.trimEnd + 0.05) }
                  : x,
              ),
            )
          }
        })
      }
    },
    [pushHistory, stopSeq],
  )

  /**
   * (правка 878) слой V2+ → базовая дорожка V1. Вставка с overwrite-логикой,
   * как в DaVinci: новый клип кладётся в точку `at` и перекрывает базу —
   * пересекающиеся клипы обрезаются, полностью закрытые удаляются, а длинный
   * клип под ним делится на две части. Подрезка/скорость/эффекты/звук клипа
   * слоя переносятся в шот; паузы базы пересчитываются по абсолютным позициям.
   */
  const layerToShot = useCallback(
    (key: string, at: number, opts?: { history?: boolean }) => {
      const layer = layersRef.current.find((l) => l.key === key)
      if (!layer) return
      const sp = layer.speed || 1
      const len = layerLen(layer)
      const start = Math.max(0, at)
      const end = start + len
      const ts = Math.max(0, layer.trimStart)
      const te = Math.max(0, layer.trimEnd)
      const duration = layer.duration > 0 ? layer.duration : ts + te + len * sp
      type Seg = { shot: MontageShot; s: number; e: number }
      const segs: Seg[] = []
      for (const row of seqRef.current) {
        const s = row.offset
        const e = row.offset + row.len
        // вне окна вставки — клип остаётся как есть
        if (e <= start + 0.001 || s >= end - 0.001) {
          segs.push({ shot: row.shot, s, e })
          continue
        }
        const rowSp = shotSpeed(row.shot)
        const rr = effRange(row.shot)
        if (s < start - 0.001 && e > end + 0.001) {
          // клип длиннее окна — делим на левую и правую части
          const leftEndSrc = rr.start + (start - s) * rowSp
          const rightStartSrc = rr.start + (end - s) * rowSp
          segs.push({ shot: { ...row.shot, trimEnd: leftEndSrc.toFixed(3) }, s, e: start })
          segs.push({
            shot: { ...row.shot, key: newShotKey(), trimStart: rightStartSrc.toFixed(3) },
            s: end,
            e,
          })
        } else if (s < start - 0.001) {
          // перекрыт хвост — обрезаем конец
          const srcEnd = rr.start + (start - s) * rowSp
          segs.push({ shot: { ...row.shot, trimEnd: srcEnd.toFixed(3) }, s, e: start })
        } else if (e > end + 0.001) {
          // перекрыто начало — обрезаем начало
          const srcStart = rr.start + (end - s) * rowSp
          segs.push({ shot: { ...row.shot, trimStart: srcStart.toFixed(3) }, s: end, e })
        }
        // полностью закрыт — удаляем
      }
      if (segs.length + 1 > MAX_SHOTS) {
        showToast(`Максимум ${MAX_SHOTS} шотов на таймлайне`, 'error')
        return
      }
      const newShot: MontageShot = {
        key: newShotKey(),
        filename: layer.filename,
        subfolder: layer.subfolder || '',
        url: layer.url,
        name: layer.name,
        trimStart: ts > 0.001 ? ts.toFixed(3) : '',
        trimEnd: te > 0.001 ? te.toFixed(3) : '',
        duration,
        vol: layer.vol,
        fadeIn: layer.fadeIn,
        fadeOut: layer.fadeOut,
        speed: sp,
        fx: layer.fx,
        gap: undefined,
      }
      segs.push({ shot: newShot, s: start, e: end })
      segs.sort((a, b) => a.s - b.s)
      let prevEnd = 0
      const nextShots: MontageShot[] = segs.map((seg) => {
        const gap = Math.max(0, +(seg.s - prevEnd).toFixed(3))
        prevEnd = seg.e
        return { ...seg.shot, gap: gap < 0.01 ? undefined : gap }
      })
      if (opts?.history !== false) {
        pushHistory()
        stopSeq(false)
      }
      setShots(nextShots)
      setLayers((prev) => prev.filter((l) => l.key !== key))
      setSelectedLayerKey(null)
      setSelectedKey(newShot.key)
      setSelectedAudioKey(null)
      setResult(null)
      if (!(layer.duration > 0)) {
        getVideoDuration(layer.url).then((d) => {
          if (d > 0 && mountedRef.current) {
            setShots((cur) => cur.map((x) => (x.key === newShot.key ? { ...x, duration: d } : x)))
          }
        })
      }
    },
    [layerLen, pushHistory, stopSeq],
  )

  const removeLayerClip = useCallback((key: string) => {
    pushHistory()
    setLayers((prev) => prev.filter((l) => l.key !== key))
    setSelectedLayerKey((cur) => (cur === key ? null : cur))
  }, [pushHistory])

  const duplicateLayerClip = useCallback((key: string) => {
    const src = layersRef.current.find((l) => l.key === key)
    if (!src) return
    if (layersRef.current.length >= MAX_LAYER_CLIPS) {
      showToast(`Не более ${MAX_LAYER_CLIPS} клипов видео-слоёв`, 'error')
      return
    }
    pushHistory()
    const copy: LayerClip = { ...src, key: newLayerKey(), at: src.at + layerLen(src) }
    setLayers((prev) => [...prev, copy])
    selectClip('layer', copy.key)
  }, [pushHistory, layerLen, selectClip])

  /** (правка 874) импорт звука с диска (POST /api/montage/audio) + клип на ряд track по плейхеду */
  const importAndAddAudio = useCallback(
    async (fileObj: File, at?: number, track?: number) => {
      if (audiosRef.current.length >= MAX_AUDIO_CLIPS) {
        showToast(`Не более ${MAX_AUDIO_CLIPS} аудиоклипов`, 'error')
        return
      }
      const fd = new FormData()
      fd.append('file', fileObj)
      try {
        const res = await fetch('/api/montage/audio', { method: 'POST', body: fd })
        const data = await res.json().catch(() => ({}))
        if (!res.ok || typeof data?.file !== 'string') {
          showToast(String(data?.error || 'Не удалось импортировать аудио'), 'error')
          return
        }
        pushHistory()
        // (правка 880) без явной дорожки ставим клип на первую аудиодорожку, где
        // он ни с чем не пересекается; если все заняты — заводим новую
        const start = Math.max(0, at ?? seqTRef.current)
        const dur = Number.isFinite(data.duration) ? data.duration : 0
        let trk: number
        if (track != null) {
          trk = Math.min(MAX_TRACKS, Math.max(1, track))
        } else {
          const maxT = Math.min(MAX_TRACKS, Math.max(audioTracks, audiosRef.current.reduce((m, a) => Math.max(m, a.track), 0)))
          const busy = (t: number) => audiosRef.current.some((a) =>
            a.track === t && start < a.at + audioLen(a) - 0.01 && start + (dur || 1e9) > a.at + 0.01)
          let free = 0
          for (let t = 1; t <= maxT; t++) if (!busy(t)) { free = t; break }
          trk = free || Math.min(MAX_TRACKS, maxT + 1)
        }
        const clip: AudioClip = {
          key: newAudioKey(), file: data.file, name: typeof data.name === 'string' ? data.name : fileObj.name,
          url: typeof data.url === 'string' ? data.url : `/api/montage/audio?f=${encodeURIComponent(data.file)}`,
          at: start, track: trk,
          trimStart: 0, trimEnd: 0, vol: 100, fadeIn: 0, fadeOut: 0,
          duration: dur,
        }
        setAudios((prev) => [...prev, clip])
        setAudioTracks((cur) => Math.max(cur, trk))
        setSelectedAudioKey(clip.key)
        setSelectedKey(null)
        setSelectedLayerKey(null)
      } catch (e) {
        showToast(`Импорт аудио не удался: ${e instanceof Error ? e.message : String(e)}`, 'error')
      }
    },
    [audioTracks, audioLen, pushHistory],
  )

  const removeAudioClip = useCallback((key: string) => {
    pushHistory()
    setAudios((prev) => prev.filter((a) => a.key !== key))
    setSelectedAudioKey((cur) => (cur === key ? null : cur))
  }, [pushHistory])

  /**
   * (правка 883) удаление видеодорожки:
   * - t >= 1 (V2, V3…): удаляет клипы этой дорожки, сдвигает верхние дорожки (track > t)
   *   на 1 вниз и уменьшает число открытых дорожек на 1;
   * - t === 0 (V1, когда есть V2+): удаляет V1, переносит клипы V2 (track === 1) на V1
   *   с сохранением их позиций на шкале и сдвигает остальные дорожки вниз.
   */
  const removeVideoTrack = useCallback((t: number) => {
    const rowsNow = Math.max(layerTracksRef.current, layersRef.current.reduce((m, l) => Math.max(m, l.track), 0))
    if (t <= 0) {
      if (rowsNow <= 0) {
        if (!shotsRef.current.length) return
        pushHistory()
        stopSeq(false)
        setShots([])
        setSelectedKey(null)
        setResult(null)
        showToast('Дорожка V1 очищена')
        return
      }
      pushHistory()
      stopSeq(false)
      setResult(null)
      const v2Clips = layersRef.current
        .filter((l) => l.track === 1)
        .sort((a, b) => a.at - b.at)
      let prevEnd = 0
      const promoted: MontageShot[] = []
      for (const l of v2Clips) {
        const start = Math.max(prevEnd, l.at)
        const len = layerLen(l)
        const gap = Math.max(0, +(start - prevEnd).toFixed(3))
        prevEnd = start + len
        promoted.push({
          key: newShotKey(),
          filename: l.filename,
          subfolder: l.subfolder || '',
          url: l.url,
          name: l.name,
          trimStart: l.trimStart > 0.001 ? l.trimStart.toFixed(3) : '',
          trimEnd: l.trimEnd > 0.001 ? l.trimEnd.toFixed(3) : '',
          duration: l.duration,
          vol: l.vol,
          fadeIn: l.fadeIn,
          fadeOut: l.fadeOut,
          speed: l.speed,
          fx: l.fx,
          gap: gap < 0.01 ? undefined : gap,
        })
      }
      setShots(promoted)
      setLayers((prev) => prev.filter((l) => l.track > 1).map((l) => ({ ...l, track: l.track - 1 })))
      setLayerTracks(Math.max(0, rowsNow - 1))
      setSelectedKey(null)
      setSelectedLayerKey(null)
      showToast('Удалена видеодорожка V1')
      return
    }
    if (t > rowsNow) return
    pushHistory()
    stopSeq(false)
    setResult(null)
    const removedKeys = new Set(layersRef.current.filter((l) => l.track === t).map((l) => l.key))
    setLayers((prev) =>
      prev
        .filter((l) => l.track !== t)
        .map((l) => (l.track > t ? { ...l, track: l.track - 1 } : l)),
    )
    setLayerTracks(Math.max(0, rowsNow - 1))
    setSelectedLayerKey((cur) => (cur && removedKeys.has(cur) ? null : cur))
    showToast(`Удалена видеодорожка V${t + 1}`)
  }, [pushHistory, stopSeq, layerLen])

  /**
   * (правка 883) удаление аудиодорожки A{t}: убирает её клипы, сдвигает
   * дорожки с номером > t на 1 вверх и уменьшает число аудиодорожек на 1.
   */
  const removeAudioTrack = useCallback((t: number) => {
    const rowsNow = Math.max(audioTracksRef.current, audiosRef.current.reduce((m, a) => Math.max(m, a.track), 0))
    if (t < 1 || t > rowsNow) return
    pushHistory()
    stopSeq(false)
    setResult(null)
    const removedKeys = new Set(audiosRef.current.filter((a) => a.track === t).map((a) => a.key))
    setAudios((prev) =>
      prev
        .filter((a) => a.track !== t)
        .map((a) => (a.track > t ? { ...a, track: a.track - 1 } : a)),
    )
    setAudioTracks(Math.max(0, rowsNow - 1))
    setSelectedAudioKey((cur) => (cur && removedKeys.has(cur) ? null : cur))
    showToast(`Удалена аудиодорожка A${t}`)
  }, [pushHistory, stopSeq])

  const duplicateAudioClip = useCallback((key: string) => {
    const src = audiosRef.current.find((a) => a.key === key)
    if (!src) return
    if (audiosRef.current.length >= MAX_AUDIO_CLIPS) {
      showToast(`Не более ${MAX_AUDIO_CLIPS} аудиоклипов`, 'error')
      return
    }
    pushHistory()
    const copy: AudioClip = { ...src, key: newAudioKey(), at: src.at + audioLen(src) }
    setAudios((prev) => [...prev, copy])
    selectClip('audio', copy.key)
  }, [pushHistory, audioLen, selectClip])

  /**
   * Превью на весь экран (F). (правка 720 v11) В кадре окна с невидимым
   * заголовком (titleBarStyle hidden) нативный requestFullscreen в Electron
   * срабатывает через раз, поэтому полный экран делаем CSS-оверлеем на весь
   * вьюпорт (тот же прием, что в video-lightbox). (правки 868, 869) сам оверлей
   * таскбар не прячет — настоящий фулскрин окна включает общий хук
   * useFsFullscreen (Electron-мост / браузерный Fullscreen API).
   */

  // (правка 859) обновление эффектов выбранного клипа и копирование между клипами
  // (правка 876) цель панели «Эффекты»: выделенный слой важнее базового клипа
  // (та же очерёдность, что в панели свойств и у хоткеев Del/D)
  const fxTarget: (MontageShot | LayerClip) | null = selectedLayer || selected
  const updateSelectedFx = useCallback((patch: Partial<ShotFx> | ((prev: ShotFx) => ShotFx)) => {
    const apply = <T extends { fx?: ShotFx }>(x: T): T => {
      const cur = x.fx || {}
      const nextFx = typeof patch === 'function' ? patch(cur) : { ...cur, ...patch }
      return { ...x, fx: nextFx }
    }
    if (selectedLayerKey) {
      setLayers((prev) => prev.map((x) => (x.key === selectedLayerKey ? apply(x) : x)))
    } else if (selectedKey) {
      setShots((prev) => prev.map((x) => (x.key === selectedKey ? apply(x) : x)))
    }
  }, [selectedKey, selectedLayerKey])

  const resetSelectedFx = useCallback(() => {
    if (selectedLayerKey) {
      pushHistory()
      setLayers((prev) => prev.map((x) => (x.key === selectedLayerKey ? { ...x, fx: undefined } : x)))
      showToast('Эффекты слоя сброшены')
    } else if (selectedKey) {
      pushHistory()
      setShots((prev) => prev.map((x) => (x.key === selectedKey ? { ...x, fx: undefined } : x)))
      showToast('Эффекты клипа сброшены')
    }
  }, [selectedKey, selectedLayerKey, pushHistory])

  const applyFxToTargets = useCallback((sourceFx: ShotFx | undefined, targetKeys: string[], label: string) => {
    if (!targetKeys.length) return
    pushHistory()
    const targetSet = new Set(targetKeys)
    // (правка 876) ключи могут быть у клипов базы и у слоёв — обновляем и тех, и других
    setShots((prev) =>
      prev.map((x) => (targetSet.has(x.key) ? { ...x, fx: hasFx(sourceFx) ? cloneFx(sourceFx) : undefined } : x)),
    )
    setLayers((prev) =>
      prev.map((x) => (targetSet.has(x.key) ? { ...x, fx: hasFx(sourceFx) ? cloneFx(sourceFx) : undefined } : x)),
    )
    showToast(label)
  }, [pushHistory])

  // (правка 859, 884) анимированный киношный шум в превью: 24 кадра/с сдвигает тайл зерна,
  // учитывает общий/индивидуальный байпас и слои V2+
  const activePreviewKey = !result ? (previewVolKeyRef.current ?? bufShotKeyRef.current[buf] ?? selectedKey) : null
  const activePreviewShot = activePreviewKey ? shots.find((s) => s.key === activePreviewKey) ?? selected : selected
  const activeTopLayer = useMemo(() => {
    if (result) return null
    const vis = layers.filter((l) => !l.hidden && playT >= l.at && playT < l.at + layerLen(l))
    if (!vis.length) return selectedLayer
    return vis.reduce((top, cur) => (cur.track >= top.track ? cur : top), vis[0])
  }, [result, layers, playT, layerLen, selectedLayer])
  // (правка 886) источник киношного шума и порядок его отрисовки: в рендере шум
  // применяется к каждому клипу отдельно, поэтому зерно слоя V2+ должно лежать НАД
  // видео слоёв (z 5+track), а зерно базы — ПОД ними (иначе шум слоя не видно).
  // Источник — самый верхний видимый слой, поэтому над ним рисовать нечего: z=999.
  const grainSrc = useMemo(() => {
    if (result) return null
    const lg = effectiveFx(activeTopLayer?.fx)?.grain ?? 0
    if (lg > 0 && activeTopLayer && !activeTopLayer.hidden &&
        playT >= activeTopLayer.at && playT < activeTopLayer.at + layerLen(activeTopLayer)) {
      return { grain: lg, zIndex: 999 }
    }
    const sg = effectiveFx(activePreviewShot?.fx)?.grain ?? 0
    if (sg > 0) return { grain: sg, zIndex: 1 }
    return null
  }, [result, activeTopLayer, activePreviewShot, playT, layerLen])
  const activeGrain = grainSrc?.grain ?? 0
  useEffect(() => {
    if (!activeGrain || activeGrain <= 0) return
    const iv = setInterval(() => {
      const el = grainOverlayRef.current
      if (!el) return
      const ox = Math.floor(Math.random() * 160)
      const oy = Math.floor(Math.random() * 160)
      el.style.backgroundPosition = `${ox}px ${oy}px`
    }, 42)
    return () => clearInterval(iv)
  }, [activeGrain])

  // пробел = play/pause, стрелки = шаг ±0.1 с, «,»/«.» = кадр назад/вперёд,
  // S = разрез, D = дубликат, F = полный экран (Esc — выход), Alt+стрелки =
  // сдвинуть клип в последовательности, Del = убрать выделенный,
  // Ctrl+Z / Ctrl+Shift+Z (Ctrl+Y) = отмена/повтор (кроме полей ввода)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      const tag = el?.tagName ?? ''
      const inputType = tag === 'INPUT' ? ((el as HTMLInputElement).type || 'text').toLowerCase() : ''
      // (правка 865) «текстовые» поля забирают все клавиши: там пробел — это
      // пробел, а не воспроизведение. Ползунки/чекбоксы/кнопки к ним не относятся.
      const isTextEntry =
        tag === 'TEXTAREA' ||
        (tag === 'INPUT' && !['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file'].includes(inputType)) ||
        !!el?.isContentEditable
      if (isTextEntry) return
      // (правка 865) пробел = play/pause ВСЕГДА, даже если фокус остался на
      // кнопке или ползунке после клика: раньше срабатывало родное действие
      // (кнопка нажималась заново, селект открывался), а воспроизведение нет.
      if (e.code === 'Space' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault()
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
        togglePlay()
        return
      }
      if (e.key === 'Escape') {
        if (isFs) {
          e.preventDefault()
          setIsFs(false)
        }
        return
      }
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        const k = e.key.toLowerCase()
        if (k === 'z' || k === 'я') {
          e.preventDefault()
          if (e.shiftKey) redo()
          else undo()
        } else if (k === 'y' || k === 'н') {
          e.preventDefault()
          redo()
        }
        return
      }
      if (!seqRef.current.length) return
      if (e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault()
        moveShot(selectedKey, -1)
      } else if (e.altKey && e.key === 'ArrowRight') {
        e.preventDefault()
        moveShot(selectedKey, 1)
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        scrubBy(-0.1)
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        scrubBy(0.1)
      } else if (e.key === ',' || e.key === '<' || e.key === 'Б') {
        e.preventDefault()
        // (правка 853) шаг кадром — по частоте секвенции (0 = 24, как в рендере)
        scrubBy(-1 / (seqSet.fps || 24))
      } else if (e.key === '.' || e.key === '>' || e.key === 'Ю') {
        e.preventDefault()
        scrubBy(1 / (seqSet.fps || 24))
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        // (правка 874) удаляем выделенное: слой, аудио или базовый клип
        if (selectedLayerKey) {
          e.preventDefault()
          removeLayerClip(selectedLayerKey)
        } else if (selectedAudioKey) {
          e.preventDefault()
          removeAudioClip(selectedAudioKey)
        } else if (selectedKey) {
          e.preventDefault()
          removeShot(selectedKey)
        }
      } else if (['s', 'S', 'ы', 'Ы'].includes(e.key)) {
        e.preventDefault()
        splitAtPlayhead()
      } else if (['d', 'D', 'в', 'В'].includes(e.key)) {
        // (правка 874) дубликат выделенного клипа любого типа
        if (selectedLayerKey) {
          e.preventDefault()
          duplicateLayerClip(selectedLayerKey)
        } else if (selectedAudioKey) {
          e.preventDefault()
          duplicateAudioClip(selectedAudioKey)
        } else if (selectedKey) {
          e.preventDefault()
          duplicateShot(selectedKey)
        }
      } else if (['f', 'F', 'а', 'А'].includes(e.key)) {
        e.preventDefault()
        toggleFullscreen()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    togglePlay, scrubBy, selectedKey, selectedLayerKey, selectedAudioKey,
    removeShot, removeLayerClip, removeAudioClip, splitAtPlayhead, duplicateShot,
    duplicateLayerClip, duplicateAudioClip, toggleFullscreen, moveShot, undo, redo, isFs, seqSet.fps,
  ])

  /**
   * (правка 884) подрезка шота на V1:
   * - при сжатии от начала (side === 'start') начальная граница перемещается вправо
   *   (пауза gap перед клипом увеличивается на величину подрезки), конечная граница
   *   клипа остаётся на месте, и все следующие клипы остаются на своих местах;
   * - при сжатии с конца (side === 'end') пауза перед следующим клипом компенсирует
   *   изменение длины, чтобы остальные клипы после этого тоже оставались на местах.
   */
  const setTrim = useCallback((key: string, side: 'start' | 'end', value: number, dur: number) => {
    setShots((prev) => {
      const idx = prev.findIndex((s) => s.key === key)
      if (idx < 0) return prev
      const s = prev[idx]
      const r = effRange(s)
      const sp = shotSpeed(s)
      const next = [...prev]
      if (side === 'start') {
        const oldGap = Math.max(0, typeof s.gap === 'number' && Number.isFinite(s.gap) ? s.gap : 0)
        const minSt = idx > 0 ? Math.max(0, r.start - oldGap * sp) : 0
        const st = Math.max(minSt, Math.min(value, (dur || r.end) - 0.1))
        const deltaTimeline = (st - r.start) / sp
        const newGap = Math.max(0, +(oldGap + deltaTimeline).toFixed(3))
        next[idx] = {
          ...s,
          trimStart: st <= 0.001 ? '' : st.toFixed(2),
          gap: newGap < 0.01 ? undefined : newGap,
        }
        return next
      }
      const hasNext = idx + 1 < next.length
      const nextShot = hasNext ? next[idx + 1] : null
      const nextGap0 = nextShot ? Math.max(0, typeof nextShot.gap === 'number' && Number.isFinite(nextShot.gap) ? nextShot.gap : 0) : 0
      const maxEn = hasNext
        ? Math.min(dur || Number.POSITIVE_INFINITY, r.end + nextGap0 * sp)
        : (dur || Number.POSITIVE_INFINITY)
      const en = Math.min(Math.max(value, r.start + 0.1), maxEn)
      const deltaLen = (en - r.end) / sp
      next[idx] = {
        ...s,
        trimEnd: dur && en >= dur - 0.01 ? '' : en.toFixed(2),
      }
      if (hasNext && nextShot) {
        const newNextGap = Math.max(0, +(nextGap0 - deltaLen).toFixed(3))
        next[idx + 1] = {
          ...nextShot,
          gap: newNextGap < 0.01 ? undefined : newNextGap,
        }
      }
      return next
    })
  }, [])

  const runRender = useCallback(async () => {
    // (правка 864) собирать можно и один шот: пустой таймлайн — единственное
    // условие отказа (раньше требовалось минимум два)
    if (!shots.length || rendering) return
    // (правка 720 v11) правки в полях свойств не имеют своей точки снимка —
    // сохраняем перед ними историю на ходу (кнопка «Собрать» нажимается редко)
    // (правка 844) снимок кладём руками и при НЕудачной сборке снимаем его:
    // иначе после любой ошибки Ctrl+Z «срабатывает вхолостую»
    const histSnap: HistSnap = {
      shots: shotsRef.current.map((s) => ({ ...s })),
      layers: layersRef.current.map((l) => ({ ...l })),
      audios: audiosRef.current.map((a) => ({ ...a })),
    }
    undoRef.current.push(histSnap)
    if (undoRef.current.length > 50) undoRef.current.shift()
    redoRef.current = []
    setHistTick((v) => v + 1)
    const dropHistSnapshot = () => {
      const i = undoRef.current.indexOf(histSnap)
      if (i >= 0) undoRef.current.splice(i, 1)
      setHistTick((v) => v + 1)
    }
    stopSeq(false)
    setRendering(true)
    setResult(null)
    try {
      const res = await fetch('/api/montage/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inputs: shots.map((s) => ({
            name: s.filename,
            subfolder: s.subfolder || undefined,
            trimStart: parseSec(s.trimStart) ?? undefined,
            trimEnd: parseSec(s.trimEnd) ?? undefined,
            vol: s.vol ?? 1,
            fadeIn: s.fadeIn || undefined,
            fadeOut: s.fadeOut || undefined,
            // (правка 850, 859, 860) скорость, эффекты и пауза (gap) перед клипом
            speed: s.speed && s.speed !== 1 ? shotSpeed(s) : undefined,
            fx: hasFx(s.fx) ? s.fx : undefined,
            gap: s.gap && s.gap >= 0.02 ? +s.gap.toFixed(3) : undefined,
          })),
          masterVol,
          // (правка 874) видео-слои: трек от 0 (первый над базой), подрезка конца —
          // АБСОЛЮТНАЯ секунда конца исходника (бэкенд делает trim=start:end)
          layers: layers
            .filter((l) => !l.hidden)
            .map((l) => ({
              name: l.filename,
              subfolder: l.subfolder || undefined,
              at: +l.at.toFixed(3),
              track: Math.max(0, l.track - 1),
              trimStart: l.trimStart > 0.001 ? +l.trimStart.toFixed(3) : undefined,
              trimEnd:
                l.duration > 0 && l.trimEnd > 0.001 ? +Math.max(0.05, l.duration - l.trimEnd).toFixed(3) : undefined,
              speed: l.speed !== 1 ? l.speed : undefined,
              fit: l.fit,
              // (правка 876) эффекты слоя едут в рендер так же, как у базовых клипов
              fx: hasFx(l.fx) ? l.fx : undefined,
              // (правка 877) звук слоя: громкость/фейды; muted = vol 0
              vol: l.muted ? 0 : (l.vol ?? 1),
              fadeIn: (l.fadeIn || 0) > 0.04 ? +l.fadeIn!.toFixed(2) : undefined,
              fadeOut: (l.fadeOut || 0) > 0.04 ? +l.fadeOut!.toFixed(2) : undefined,
            })),
          // (правка 874) аудиоклипы звуковых дорожек (muted не едут в микс)
          audios: audios
            .filter((a) => !a.muted)
            .map((a) => ({
              file: a.file,
              at: +a.at.toFixed(3),
              trimStart: a.trimStart > 0.001 ? +a.trimStart.toFixed(3) : undefined,
              trimEnd:
                a.duration > 0 && a.trimEnd > 0.001 ? +Math.max(0.05, a.duration - a.trimEnd).toFixed(3) : undefined,
              vol: (a.vol ?? 100) / 100,
              fadeIn: a.fadeIn > 0.04 ? +a.fadeIn.toFixed(2) : undefined,
              fadeOut: a.fadeOut > 0.04 ? +a.fadeOut.toFixed(2) : undefined,
            })),
          // (правка 850) настройки секвенции (правка 846 бэкенда)
          seq: seqSet,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        dropHistSnapshot()
        showToast(String(data?.error || 'Не удалось собрать видео'), 'error')
        return
      }
      setResult({ filename: data.filename, url: data.url })
      showToast(`Видео собрано: ${data.filename}`, 'success')
      bump()
    } catch (e) {
      dropHistSnapshot()
      showToast(`Ошибка сборки: ${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      setRendering(false)
    }
  }, [shots, masterVol, seqSet, rendering, bump, stopSeq])

  // (правка 845) пока идёт сборка, опрашиваем GET /api/montage/render: там
  // прогресс ffmpeg (-progress pipe:1) — без этого «Сборка…» висит без индикатора
  useEffect(() => {
    if (!rendering) {
      setRenderPct(null)
      return
    }
    let stop = false
    const poll = async () => {
      try {
        const d = await (await fetch('/api/montage/render')).json()
        const p = d?.progress?.pct
        if (!stop && typeof p === 'number') setRenderPct(p)
      } catch { /* сервер перезапустили — дождёмся следующего тика */ }
    }
    poll()
    const iv = setInterval(poll, 800)
    return () => {
      stop = true
      clearInterval(iv)
    }
  }, [rendering])

  /** индекс вставки под курсором */
  const computeDropIdx = useCallback((clientX: number): number => {
    const track = trackRef.current
    if (!track) return shots.length
    const blocks = Array.from(track.querySelectorAll<HTMLElement>('[data-clip]'))
    for (let i = 0; i < blocks.length; i++) {
      const r = blocks[i].getBoundingClientRect()
      if (clientX < r.left + r.width / 2) return i
    }
    return blocks.length
  }, [shots.length])

  const onTimelineDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const d = dragRef.current
    const idx = computeDropIdx(e.clientX)
    setDropIdx(null)
    dragRef.current = null
    const el = e.target as HTMLElement | null
    const trackEl = trackRef.current
    const atX = trackEl ? Math.max(0, (e.clientX - trackEl.getBoundingClientRect().left) / ppsRef.current) : seqTRef.current
    // (правка 874) сброс на ряд видео-слоя: файл галереи -> клип слоя на этом треке
    const lRow = el?.closest('[data-layer-row]') as HTMLElement | null
    if (lRow) {
      if (d?.kind === 'gallery') addLayerClip(d.file, atX, Number(lRow.dataset.layerRow) || 1)
      return
    }
    // (правка 874) сброс на аудиоряд: файл прямо из проводника (или dragRef не галерея — игнор)
    const aRow = el?.closest('[data-audio-row]') as HTMLElement | null
    if (aRow) {
      const f0 = Array.from(e.dataTransfer?.files || []).find((x) => x.size > 0)
      if (f0) void importAndAddAudio(f0, atX, Number(aRow.dataset.audioRow) || 1)
      return
    }
    if (!d) return
    if (d.kind === 'gallery') {
      addShot(d.file, idx)
      return
    }
    if (d.kind !== 'move') return // (правка 874) слои/аудио двигаются pointer-drag'ом внутри своих рядов
    pushHistory()
    setShots((prev) => {
      const from = prev.findIndex((s) => s.key === d.key)
      if (from < 0) return prev
      const next = [...prev]
      const [moved] = next.splice(from, 1)
      const to = idx > from ? idx - 1 : idx
      next.splice(Math.max(0, Math.min(to, next.length)), 0, moved)
      return next
    })
  }, [addShot, addLayerClip, importAndAddAudio, computeDropIdx, pushHistory])

  /** тяга за край блока — подрезка в секундах (+ подсказка новой длительности и живой кадр в превью) */
  const startTrimDrag = useCallback(
    (e: React.PointerEvent, shot: MontageShot, side: 'start' | 'end') => {
      e.preventDefault()
      e.stopPropagation()
      stopSeq(false)
      setResult(null)
      selectClip('shot', shot.key)
      suppressDrag.current = true
      const startX = e.clientX
      const r0 = effRange(shot)
      const dur = shot.duration || 0
      const sp = shotSpeed(shot)
      let pushed = false
      let trimRaf = 0
      let pendingNv = side === 'start' ? r0.start : r0.end
      // готовим буфер под этот шот, чтобы показывать живой кадр точки разреза
      const b = bufRef.current
      const v = bufEl(b)
      previewVolKeyRef.current = shot.key
      bufShotKeyRef.current[b] = shot.key
      setPreviewSrc(shot.url)
      if (v && v.getAttribute('src') !== shot.url) {
        wantSeekRef.current[b] = pendingNv
        v.src = shot.url
        v.load()
      }
      const onMove = (ev: PointerEvent) => {
        if (!pushed) {
          pushed = true
          pushHistory()
        }
        // dt на таймлайне переводим в секунды исходника с учётом скорости шота
        const dt = ((ev.clientX - startX) / pps) * sp
        const nv = side === 'start' ? r0.start + dt : r0.end + dt
        pendingNv = nv
        const st = side === 'start' ? Math.max(0, Math.min(nv, (dur || r0.end) - 0.1)) : r0.start
        const en = side === 'end' ? Math.min(Math.max(nv, r0.start + 0.1), dur || Number.POSITIVE_INFINITY) : r0.end
        // (правка 858) живой показ кадра точки подрезки в превью (как в Premiere)
        seekBufferTo(b, side === 'start' ? st : Math.max(st, en - 0.02))
        if (!trimRaf) {
          const bx = ev.clientX
          const by = ev.clientY
          trimRaf = requestAnimationFrame(() => {
            trimRaf = 0
            setTrim(shot.key, side, pendingNv, dur)
            setTrimBadge({ x: bx, y: by, text: `${(Math.max(0.1, en - st) / sp).toFixed(2)} с` })
          })
        }
      }
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        if (trimRaf) {
          cancelAnimationFrame(trimRaf)
          trimRaf = 0
        }
        if (pushed) setTrim(shot.key, side, pendingNv, dur)
        setTrimBadge(null)
        setTimeout(() => { suppressDrag.current = false }, 0)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [pps, setTrim, stopSeq, pushHistory, seekBufferTo, selectClip],
  )

  /**
   * (правка 860) Свободное перемещение клипа по таймлайну мышью:
   * - тянем вправо/влево — клип плавно меняет позицию старта (между клипами
   *   может оставаться пустое пространство gap >= 0);
   * - если включён Магнит (snap), края клипа прилипают к 0, к плейхеду и к
   *   краям соседних клипов (чтобы легко ставить и встык);
   * - если перетащить центр клипа за центр соседнего — клипы меняются местами;
   * - если просто кликнули без перетаскивания — выделяем клип и ставим плейхед.
   */
  const startClipDrag = useCallback(
    (e: React.PointerEvent, row: SeqRow) => {
      if (e.button !== 0) return
      const targetEl = e.target as HTMLElement | null
      if (targetEl && (targetEl.closest('button') || targetEl.closest('[data-trim-handle]'))) return
      e.preventDefault()
      e.stopPropagation()
      const startX = e.clientX
      const sq0 = seqRef.current.map((r) => ({
        shot: r.shot,
        offset: r.offset,
        len: r.len,
        gap: r.gap,
      }))
      const dragIdx = sq0.findIndex((r) => r.shot.key === row.shot.key)
      if (dragIdx < 0) return
      const dragItem = sq0[dragIdx]
      const others = sq0.filter((_, idx) => idx !== dragIdx)
      const startY = e.clientY
      const trackLeft = trackRef.current?.getBoundingClientRect().left ?? 0
      const grabOffset = Math.max(
        0,
        (startX - trackLeft) / Math.max(8, ppsRef.current) - dragItem.offset,
      )
      // (правка 878) ряды слоёв: при вертикальном перетаскивании клип базы
      // превращается в клип слоя (V1 → V2+)
      const layerBoxes: Array<{ track: number; top: number; bottom: number }> = []
      for (const el of Array.from(
        scrollerRef.current?.querySelectorAll<HTMLElement>('[data-layer-row]') || [],
      )) {
        const r = el.getBoundingClientRect()
        layerBoxes.push({
          track: Number(el.dataset.layerRow) || 1,
          top: r.top,
          bottom: r.bottom,
        })
      }
      const detectLayerTrack = (clientY: number): number | null => {
        for (const b of layerBoxes) {
          if (clientY >= b.top - 3 && clientY <= b.bottom + 3) return b.track
        }
        const baseTop = trackRef.current?.getBoundingClientRect().top
        if (baseTop == null) return null
        const topRowTop = layerBoxes.length
          ? Math.min(...layerBoxes.map((b) => b.top))
          : baseTop
        const rowH = layerBoxes.length
          ? Math.max(20, Math.max(...layerBoxes.map((b) => b.bottom - b.top)))
          : Math.max(24, trackHRef.current)
        if (clientY >= topRowTop - rowH && clientY < topRowTop) {
          const maxT = layerBoxes.length ? Math.max(...layerBoxes.map((b) => b.track)) : 0
          if (maxT + 1 > MAX_TRACKS) return null
          return maxT + 1
        }
        return null
      }
      const atFromX = (clientX: number) =>
        Math.max(0, (clientX - trackLeft) / Math.max(8, ppsRef.current) - grabOffset)
      let moved = false
      let dragRaf = 0
      let latestX = startX
      let latestY = startY

      const applyMove = (clientX: number, clientY: number) => {
        // (правка 878) курсор над рядом слоя — базу не двигаем, на отпускании
        // клип уедет на этот ряд
        const vTrack = detectLayerTrack(clientY)
        if (vTrack != null) {
          const at = atFromX(clientX)
          setTrimBadge({
            x: clientX,
            y: clientY,
            text: `→ V${vTrack + 1} · ${at.toFixed(2)} с`,
          })
          return
        }
        const curPps = Math.max(8, ppsRef.current)
        const dt = (clientX - startX) / curPps
        let wantStart = Math.max(0, dragItem.offset + dt)
        if (snapRef.current) {
          const tol = Math.min(0.18, 8 / curPps)
          // (правка 893) магнит общий: база + слои + аудио, оба края клипа
          const snapPts = snapPointsExcept({ shot: dragItem.shot.key })
          wantStart = snapClipStart(wantStart, dragItem.len, snapPts, tol)
        }
        // определяем порядок клипов по положению центров
        const dragCenter = wantStart + dragItem.len * 0.5
        let insertIdx = 0
        for (let i = 0; i < others.length; i++) {
          if (others[i].offset + others[i].len * 0.5 < dragCenter) insertIdx = i + 1
        }
        const ordered = [...others]
        ordered.splice(insertIdx, 0, dragItem)

        const nextShots: MontageShot[] = []
        let prevEnd = 0
        let actualDragStart = 0
        let actualDragGap = 0
        const sameOrderRightShift = insertIdx === dragIdx && wantStart > dragItem.offset ? wantStart - dragItem.offset : 0
        for (let m = 0; m < ordered.length; m++) {
          const item = ordered[m]
          let start: number
          if (m < insertIdx) {
            start = Math.max(prevEnd, item.offset)
          } else if (m === insertIdx) {
            start = Math.max(prevEnd, wantStart)
            actualDragStart = start
            actualDragGap = Math.max(0, start - prevEnd)
          } else {
            // если клип просто отодвигают вправо без смены порядка, а правый сосед
            // стоял встык (gap===0) — сдвигаем хвост вместе с ним; если между ними
            // было окно — сосед стоит на месте, пока его не коснутся
            const desired = item.gap > 0.01 ? item.offset : item.offset + sameOrderRightShift
            start = Math.max(prevEnd, desired)
          }
          const gap = Math.max(0, +(start - prevEnd).toFixed(3))
          nextShots.push({ ...item.shot, gap: gap < 0.01 ? undefined : gap })
          prevEnd = start + item.len
        }
        setShots(nextShots)
        setTrimBadge({
          x: clientX,
          y: clientY,
          text: `${actualDragStart.toFixed(2)} с${actualDragGap >= 0.02 ? ` (пауза +${actualDragGap.toFixed(2)} с)` : ' (встык)'}`,
        })
      }

      const onMove = (ev: PointerEvent) => {
        latestX = ev.clientX
        latestY = ev.clientY
        if (!moved) {
          if (Math.abs(ev.clientX - startX) < 3 && Math.abs(ev.clientY - startY) < 3) return
          moved = true
          suppressDrag.current = true
          stopSeq(false)
          setResult(null)
          selectClip('shot', row.shot.key)
          pushHistory()
        }
        if (!dragRaf) {
          dragRaf = requestAnimationFrame(() => {
            dragRaf = 0
            applyMove(latestX, latestY)
          })
        }
      }

      const onUp = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        if (dragRaf) {
          cancelAnimationFrame(dragRaf)
          dragRaf = 0
        }
        setTrimBadge(null)
        if (moved) {
          // (правка 878) финальная проверка: курсор над рядом слоя — конвертация
          const vTrack = detectLayerTrack(ev.clientY)
          if (vTrack != null) {
            shotToLayer(row.shot.key, vTrack, atFromX(ev.clientX), { history: false })
          } else {
            applyMove(ev.clientX, ev.clientY)
          }
          setTimeout(() => { suppressDrag.current = false }, 0)
        } else {
          // обычный клик без перетаскивания: выбираем клип и переносим плейхед в точку клика
          selectClip('shot', row.shot.key)
          setResult(null)
          const track = trackRef.current
          if (track) {
            const clickT = (ev.clientX - track.getBoundingClientRect().left) / ppsRef.current
            const clamped = Math.max(row.offset, Math.min(row.offset + Math.max(0.01, row.len - 0.02), clickT))
            seekTo(clamped)
          } else {
            seekTo(row.offset)
          }
        }
      }

      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [stopSeq, pushHistory, seekTo, shotToLayer, snapPointsExcept, snapClipStart],
  )

  /**
   * (правка 874) свободный pointer-drag клипа слоя/аудио: горизонталь — позиция
   * at (магнит к 0, плейхеду, стыкам базы и краям соседних свободных клипов),
   * вертикаль — смена ряда того же типа.
   */
  const startFreeClipDrag = useCallback(
    (e: React.PointerEvent, kind: 'layer' | 'audio', clip: LayerClip | AudioClip) => {
      if (e.button !== 0) return
      const targetEl = e.target as HTMLElement | null
      if (targetEl && (targetEl.closest('button') || targetEl.closest('[data-trim-handle]'))) return
      e.preventDefault()
      e.stopPropagation()
      const startX = e.clientX
      const at0 = clip.at
      const len = kind === 'layer' ? layerLen(clip as LayerClip) : audioLen(clip as AudioClip)
      const rows: Array<{ kind: 'layer' | 'audio'; track: number; top: number; bottom: number }> = []
      for (const el of Array.from(scrollerRef.current?.querySelectorAll<HTMLElement>('[data-layer-row],[data-audio-row]') || [])) {
        const r = el.getBoundingClientRect()
        if (el.dataset.layerRow != null) rows.push({ kind: 'layer', track: Number(el.dataset.layerRow) || 1, top: r.top, bottom: r.bottom })
        else if (el.dataset.audioRow != null) rows.push({ kind: 'audio', track: Number(el.dataset.audioRow) || 1, top: r.top, bottom: r.bottom })
      }
      // (правка 878) слой можно бросить на V1 (превратится в клип базы) или
      // выше верхнего ряда — тогда создаётся новый ряд V(N+1)
      const baseRect = trackRef.current?.getBoundingClientRect() ?? null
      const layerRowsGeo = rows.filter((r) => r.kind === 'layer')
      const topLayerTop = layerRowsGeo.length
        ? Math.min(...layerRowsGeo.map((r) => r.top))
        : baseRect?.top ?? null
      const layerRowH = layerRowsGeo.length
        ? Math.max(20, Math.max(...layerRowsGeo.map((r) => r.bottom - r.top)))
        : Math.max(24, trackHRef.current)
      const isOverBase = (y: number) =>
        !!baseRect && y >= baseRect.top - 4 && y <= baseRect.bottom + 4
      // (правка 880) под нижним аудиорядом — новая дорожка A(N+1)
      const audioRowsGeo = rows.filter((r) => r.kind === 'audio')
      const bottomAudioBottom = audioRowsGeo.length
        ? Math.max(...audioRowsGeo.map((r) => r.bottom))
        : baseRect?.bottom ?? null
      const audioRowH = audioRowsGeo.length
        ? Math.max(18, Math.max(...audioRowsGeo.map((r) => r.bottom - r.top)))
        : Math.max(22, Math.round(trackHRef.current * 0.45))
      const newAudioTrack = (y: number): number | null => {
        if (bottomAudioBottom == null) return null
        if (y > bottomAudioBottom && y <= bottomAudioBottom + audioRowH) {
          const maxT = audioRowsGeo.length ? Math.max(...audioRowsGeo.map((r) => r.track)) : 0
          if (maxT + 1 > MAX_TRACKS) return null
          return maxT + 1
        }
        return null
      }
      const newTopTrack = (y: number): number | null => {
        if (topLayerTop == null) return null
        if (y >= topLayerTop - layerRowH && y < topLayerTop) {
          const maxT = layerRowsGeo.length
            ? Math.max(...layerRowsGeo.map((r) => r.track))
            : 0
          if (maxT + 1 > MAX_TRACKS) return null
          return maxT + 1
        }
        return null
      }
      const setClip = (at: number, track: number) => {
        if (kind === 'layer') setLayers((prev) => prev.map((x) => (x.key === clip.key ? { ...x, at, track } : x)))
        else setAudios((prev) => prev.map((x) => (x.key === clip.key ? { ...x, at, track } : x)))
      }
      let moved = false
      let dragRaf = 0
      let latestX = startX
      let latestY = e.clientY
      let curAt = at0
      let curTrack = clip.track
      const applyMove = (clientX: number, clientY: number) => {
        const curPps = Math.max(8, ppsRef.current)
        let want = Math.max(0, at0 + (clientX - startX) / curPps)
        if (snapRef.current) {
          const tol = Math.min(0.18, 8 / curPps)
          // (правка 893) магнит общий: база + все слои + все аудио, оба края
          const snapPts = snapPointsExcept(kind === 'layer' ? { layer: clip.key } : { audio: clip.key })
          want = snapClipStart(want, len, snapPts, tol)
        }
        // (правка 878) над V1 — превращаем слой в клип базы; над верхним рядом —
        // новый ряд. В этих зонах слой пока не двигаем, только показываем бейдж.
        if (kind === 'layer') {
          if (isOverBase(clientY)) {
            setTrimBadge({ x: clientX, y: clientY, text: `→ V1 · ${want.toFixed(2)} с` })
            return
          }
          const nt = newTopTrack(clientY)
          if (nt != null) {
            setTrimBadge({ x: clientX, y: clientY, text: `→ V${nt + 1} · ${want.toFixed(2)} с` })
            return
          }
        }
        // (правка 880) под нижним аудиорядом — перенос на новую дорожку A(N+1)
        if (kind === 'audio') {
          const nt = newAudioTrack(clientY)
          if (nt != null) {
            setTrimBadge({ x: clientX, y: clientY, text: `→ A${nt} · ${want.toFixed(2)} с` })
            return
          }
        }
        let track = curTrack
        for (const r of rows) {
          if (r.kind !== kind) continue
          if (clientY >= r.top - 4 && clientY <= r.bottom + 4) { track = r.track; break }
        }
        curAt = +want.toFixed(3)
        curTrack = Math.min(MAX_TRACKS, Math.max(1, track))
        setClip(curAt, curTrack)
        setTrimBadge({ x: clientX, y: clientY, text: `${curAt.toFixed(2)} с · ${kind === 'layer' ? 'V' : 'A'}${curTrack}` })
      }
      const onMove = (ev: PointerEvent) => {
        latestX = ev.clientX
        latestY = ev.clientY
        if (!moved) {
          if (Math.abs(ev.clientX - startX) < 3) return
          moved = true
          suppressDrag.current = true
          stopSeq(false)
          setResult(null)
          selectClip(kind, clip.key)
          pushHistory()
        }
        if (!dragRaf) {
          dragRaf = requestAnimationFrame(() => {
            dragRaf = 0
            applyMove(latestX, latestY)
          })
        }
      }
      const onUp = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        if (dragRaf) { cancelAnimationFrame(dragRaf); dragRaf = 0 }
        setTrimBadge(null)
        if (moved) {
          // (правка 878) вертикальные зоны: на V1 слой превращается в клип базы,
          // над верхним рядом — переносится на новый ряд V(N+1)
          if (kind === 'layer') {
            const at = Math.max(0, at0 + (ev.clientX - startX) / Math.max(8, ppsRef.current))
            if (isOverBase(ev.clientY)) {
              layerToShot(clip.key, +at.toFixed(3), { history: false })
              setTimeout(() => { suppressDrag.current = false }, 0)
              return
            }
            const nt = newTopTrack(ev.clientY)
            if (nt != null) {
              setLayers((prev) => prev.map((x) => (x.key === clip.key ? { ...x, track: nt } : x)))
              setLayerTracks((cur) => Math.max(cur, nt))
              setTimeout(() => { suppressDrag.current = false }, 0)
              return
            }
          }
          // (правка 880) аудиоклип под нижним рядом → новая дорожка A(N+1)
          if (kind === 'audio') {
            const at = Math.max(0, at0 + (ev.clientX - startX) / Math.max(8, ppsRef.current))
            const nt = newAudioTrack(ev.clientY)
            if (nt != null) {
              setAudios((prev) => prev.map((x) => (x.key === clip.key ? { ...x, at: +at.toFixed(3), track: nt } : x)))
              setAudioTracks((cur) => Math.max(cur, nt))
              setTimeout(() => { suppressDrag.current = false }, 0)
              return
            }
          }
          applyMove(ev.clientX, ev.clientY)
          setTimeout(() => { suppressDrag.current = false }, 0)
        } else {
          selectClip(kind, clip.key)
          setResult(null)
          const track = trackRef.current
          if (track) seekTo(Math.max(0, (ev.clientX - track.getBoundingClientRect().left) / ppsRef.current))
        }
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [stopSeq, pushHistory, seekTo, layerLen, audioLen, layerToShot, snapPointsExcept, snapClipStart],
  )

  /** (правка 874, 884) подрезка клипа слоя/аудио за край:
   *  при сжатии от начала (side === 'start') начальная граница at перемещается
   *  вправо за курсором мыши, а конечная граница остаётся на месте */
  const startFreeTrimDrag = useCallback(
    (e: React.PointerEvent, kind: 'layer' | 'audio', clip: LayerClip | AudioClip, side: 'start' | 'end') => {
      e.preventDefault()
      e.stopPropagation()
      suppressDrag.current = true
      selectClip(kind, clip.key)
      const startX = e.clientX
      const at0 = clip.at
      const ts0 = clip.trimStart
      const te0 = clip.trimEnd
      const dur = clip.duration || 0
      const sp = kind === 'layer' ? (clip as LayerClip).speed || 1 : 1
      const peers =
        kind === 'layer'
          ? layersRef.current.filter((x) => x.key !== clip.key && x.track === clip.track)
          : audiosRef.current.filter((x) => x.key !== clip.key && x.track === clip.track)
      let leftLimitAt = 0
      for (const p of peers) {
        const pEnd = p.at + (kind === 'layer' ? layerLen(p as LayerClip) : audioLen(p as AudioClip))
        if (pEnd <= at0 + 0.01) leftLimitAt = Math.max(leftLimitAt, pEnd)
      }
      const minTs = Math.max(0, ts0 - Math.max(0, at0 - leftLimitAt) * sp)
      const maxTs = dur > 0 ? Math.max(0, dur - te0 - 0.05) : 0
      const maxTe = dur > 0 ? Math.max(0, dur - ts0 - 0.05) : 0
      let pushed = false
      let ts = ts0
      let te = te0
      let nextAt = at0
      let raf = 0
      const commit = () => {
        if (kind === 'layer') {
          setLayers((prev) =>
            prev.map((x) =>
              x.key === clip.key ? { ...x, at: +nextAt.toFixed(3), trimStart: +ts.toFixed(3), trimEnd: +te.toFixed(3) } : x,
            ),
          )
        } else {
          setAudios((prev) =>
            prev.map((x) =>
              x.key === clip.key ? { ...x, at: +nextAt.toFixed(3), trimStart: +ts.toFixed(3), trimEnd: +te.toFixed(3) } : x,
            ),
          )
        }
      }
      const onMove = (ev: PointerEvent) => {
        if (!pushed) { pushed = true; pushHistory() }
        const srcDt = ((ev.clientX - startX) / ppsRef.current) * sp
        if (side === 'start') {
          ts = Math.max(minTs, Math.min(ts0 + srcDt, maxTs))
          nextAt = Math.max(leftLimitAt, at0 + (ts - ts0) / sp)
        } else {
          te = Math.max(0, Math.min(te0 - srcDt, maxTe))
        }
        if (!raf) {
          const bx = ev.clientX
          const by = ev.clientY
          raf = requestAnimationFrame(() => {
            raf = 0
            commit()
            const outLen = dur > 0 ? (dur - ts - te) / sp : 0
            setTrimBadge({ x: bx, y: by, text: dur > 0 ? `${outLen.toFixed(2)} с` : '…' })
          })
        }
      }
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        if (raf) { cancelAnimationFrame(raf); raf = 0 }
        if (pushed) commit()
        setTrimBadge(null)
        setTimeout(() => { suppressDrag.current = false }, 0)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [pushHistory, layerLen, audioLen, selectClip],
  )

  /** (правка 720 v11) вписать всю сборку в видимую ширину таймлайна */
  const fitZoom = useCallback(() => {
    const el = scrollerRef.current
    const endT = tlEndRef.current
    if (!el || endT <= 0) return
    const w = el.clientWidth - 20
    if (w <= 0) return
    setPps(Math.max(8, Math.min(240, Math.floor(w / endT))))
  }, [])

  /** (правка 720 v11) позиция вставки сразу за клипом, где стоит плейхед */
  const insertAtPlayheadIdx = useCallback((): number | undefined => {
    const sq = seqRef.current
    if (!sq.length) return undefined
    return Math.min(sq.length, findRow(seqTRef.current) + 1)
  }, [findRow])

  // (правка 855) приём цели из галереи («В Монтаж»): добавляем следующим клипом
  // (или на плейхеде). Монтирование вкладки происходит ПОСЛЕ смены таба, поэтому
  // цель живёт в zustand-сторе, а не в событии.
  const montageTarget = useMontageTarget((s) => s.target)
  useEffect(() => {
    if (!montageTarget || !hydrated.current) return
    const url = `/api/comfy/file?filename=${encodeURIComponent(montageTarget.filename)}&subfolder=${encodeURIComponent(montageTarget.subfolder)}&type=output`
    const f = { filename: montageTarget.filename, subfolder: montageTarget.subfolder, url } as VideoGalleryFile
    addShot(f, montageTarget.atPlayhead ? insertAtPlayheadIdx() : undefined)
    useMontageTarget.getState().clear()
  }, [montageTarget, addShot, insertAtPlayheadIdx])

  // (правка 856) «В Refine» с клипа: источник — файл целиком (подрезка/скорость
  // не переносятся); цель кладём в RefineTargetStore + переключаем вкладку.
  // (правка 857) заодно помечаем шот как ждущий чистовик — по возврату он
  // будет заменён отрефайненной версией (подрезки сохранятся).
  const sendShotToRefine = useCallback((shot: MontageShot) => {
    useRefineTarget.getState().setTarget({ filename: shot.filename, subfolder: shot.subfolder })
    useMontageReturn.getState().add({ shotKey: shot.key, filename: shot.filename, subfolder: shot.subfolder })
    window.dispatchEvent(new CustomEvent('h3:goto-refine'))
  }, [])

  // (правка 878) «В Refine» для клипа слоя — паритет с базовой дорожкой:
  // по возврату чистовик заменит файл слоя, сохранив подрезку/скорость/звук.
  const sendLayerToRefine = useCallback((layer: LayerClip) => {
    useRefineTarget.getState().setTarget({ filename: layer.filename, subfolder: layer.subfolder || '' })
    useMontageReturn.getState().add({
      shotKey: layer.key,
      filename: layer.filename,
      subfolder: layer.subfolder || '',
    })
    window.dispatchEvent(new CustomEvent('h3:goto-refine'))
  }, [])

  // (правка 857) возврат чистовика из Refine: шот, отправленный кнопкой
  // «В Refine», подменяется отрефайненным файлом. Ждём, пока файл появится в
  // галерее (иначе правка 843 сняла бы шот как «удалённый»); все настройки
  // клипа — подрезка по краям, громкость, фейды, скорость, эффекты, переход —
  // остаются как были. Дубли/половинки одного исходника заменяются тем же
  // чистовиком.
  const pendingReturn = useMontageReturn((s) => s.pending)
  const arrivals = useMontageReturn((s) => s.arrivals)
  useEffect(() => {
    if (!hydrated.current || loading || files.length === 0 || !arrivals.length) return
    const keys = Object.keys(pendingReturn)
    if (!keys.length) return
    for (const key of keys) {
      const p = pendingReturn[key]
      // (правка 878) чистовик может ждать как клип базы, так и клип слоя V2+
      if (
        !shotsRef.current.some((s) => s.key === key) &&
        !layersRef.current.some((l) => l.key === key)
      ) {
        useMontageReturn.getState().drop(key)
        continue
      }
      const a = arrivals.find(
        (x) => x.sourceFilename === p.filename && (x.sourceSubfolder || '') === (p.subfolder || ''),
      )
      if (!a) continue
      const f = files.find((x) => x.filename === a.filename && (x.subfolder || '') === (a.subfolder || ''))
      if (!f) continue // чистовик ещё не в списке галереи — дождёмся bump
      stopSeq(false)
      pushHistory()
      setShots((prev) =>
        prev.map((s) =>
          s.key === key
            ? {
                ...s,
                filename: f.filename,
                subfolder: f.subfolder || '',
                url: f.url,
                name: f.filename.replace(/\.[^.]+$/, ''),
                duration: 0,
              }
            : s,
        ),
      )
      // (правка 878) подмена файла у клипа слоя — подрезка и звук остаются
      setLayers((prev) =>
        prev.map((l) =>
          l.key === key
            ? {
                ...l,
                filename: f.filename,
                subfolder: f.subfolder || '',
                url: f.url,
                name: f.filename.replace(/\.[^.]+$/, ''),
                duration: 0,
              }
            : l,
        ),
      )
      useMontageReturn.getState().drop(key)
      useMontageReturn.getState().dropArrival(a.filename)
      // реальная длительность чистовика (у Refine она может отличаться на доли
      // секунды от драфта) — блок перестроится по ней
      getVideoDuration(f.url).then((d) => {
        if (d > 0 && mountedRef.current) {
          setShots((cur) => cur.map((x) => (x.key === key ? { ...x, duration: d } : x)))
          setLayers((cur) => cur.map((x) => (x.key === key ? { ...x, duration: d } : x)))
        }
      })
      showToast(`Клип заменён чистовиком Refine: ${f.filename}`, 'success')
    }
  }, [arrivals, pendingReturn, files, loading, stopSeq, pushHistory])

  /** (правка 720 v11) копирование ссылки (и через неё пути) готового файла */
  const copyResult = useCallback(async () => {
    if (!result) return
    const href = new URL(result.url, window.location.origin).href
    try {
      await navigator.clipboard.writeText(href)
      showToast('Ссылка на результат скопирована', 'success')
    } catch {
      showToast('Не удалось скопировать ссылку', 'error')
    }
  }, [result])

  // (правка 865) клик мышью не оставляет фокус на кнопке/ползунке: иначе после
  // любого клика элемент подсвечен рамкой фокуса, а пробел уходит «в него».
  // Текстовые поля не трогаем — в них фокус нужен для ввода.
  const dropMouseFocus = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement | null
    const ctl = el?.closest('button, input') as HTMLElement | null
    if (!ctl) return
    if (ctl instanceof HTMLInputElement) {
      const t = (ctl.type || 'text').toLowerCase()
      if (!['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file'].includes(t)) return
    }
    requestAnimationFrame(() => ctl.blur())
  }, [])

  // (правка 879) линейка и вписывание считаются по всей композиции (все дорожки)
  const rulerStep = tlEnd > 0 ? pickStep(tlEnd, pps) : 1
  const rulerTicks: number[] = []
  // (правка 720 v10) шаг через индекс: накопление "+0.1" в float уезжало
  // (метки вида 0.30000000000000004, лишний последний штрих)
  if (tlEnd > 0) for (let i = 0; i * rulerStep <= tlEnd + 0.001; i++) rulerTicks.push(+(i * rulerStep).toFixed(3))

  // (правка 720 v11) стеки истории живут в ref, а histTick заставляет
  // перерисовать состояние кнопок Отмены/Повтора
  const canUndo = histTick >= 0 && undoRef.current.length > 0
  const canRedo = histTick >= 0 && redoRef.current.length > 0

  return (
    <div className="flex h-full w-full min-w-0" onPointerUp={dropMouseFocus}>
      {/* центр: шапка + превью + транспорт + таймлайн */}
      <section className="flex min-w-0 flex-1 flex-col">
        {/* шапка: заголовок + настройки секвенции + сборка (правка 861: настройки таймлайна перенесены вниз к таймлайну) */}
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          <ScissorsIcon className="h-4 w-4 shrink-0 text-[#A78BFA]" />
          <span className="text-sm font-medium">Монтаж</span>
          <span className="text-xs text-zinc-500">
            {shots.length} шот{shots.length === 1 ? '' : 'ов'} · ≈ {tlEnd.toFixed(1)} с
          </span>
          <div className="ml-auto flex items-center gap-2">
            {/* (правка 853) настройки секвенции — как проект/секвенция в Premiere */}
            <div className="relative">
              <button
                className={cn(
                  'rounded border border-border px-2 py-1 text-xs text-zinc-400 hover:bg-[var(--surface-2)]',
                  seqOpen && 'border-[#A78BFA] text-[#A78BFA]',
                )}
                onClick={() => setSeqOpen((v) => !v)}
                title="Настройки секвенции: разрешение, частота кадров, вписывание, качество"
              >
                <ClapperboardIcon className="mr-1 inline h-3.5 w-3.5" />
                {seqSet.w && seqSet.h ? `${seqSet.w}×${seqSet.h}` : 'Авто'}
                {seqSet.fps ? ` @${seqSet.fps}` : ''}
              </button>
              {seqOpen && (
                <>
                  {/* клик мимо — закрыть поповер */}
                  <div className="fixed inset-0 z-30" onClick={() => setSeqOpen(false)} />
                  <div className="absolute right-0 top-full z-40 mt-1 w-60 rounded-lg border border-border bg-[var(--surface-1)] p-2 text-xs shadow-xl">
                    <div className="mb-1 text-[10px] uppercase tracking-wide text-zinc-500">Размер кадра</div>
                    {SEQ_SIZES.map((s) => (
                      <button
                        key={s.label}
                        className={cn(
                          'w-full rounded px-2 py-1 text-left hover:bg-[var(--surface-2)]',
                          seqSet.w === s.w && seqSet.h === s.h && 'text-[#A78BFA]',
                        )}
                        onClick={() => setSeqSet((q) => ({ ...q, w: s.w, h: s.h }))}
                      >
                        {s.label}
                      </button>
                    ))}
                    <div className="mb-1 mt-2 text-[10px] uppercase tracking-wide text-zinc-500">Частота кадров</div>
                    <div className="flex gap-1">
                      {[0, 24, 30, 60].map((f) => (
                        <button
                          key={f}
                          className={cn(
                            'flex-1 rounded border border-border px-1 py-1 hover:bg-[var(--surface-2)]',
                            seqSet.fps === f && 'border-[#A78BFA] text-[#A78BFA]',
                          )}
                          onClick={() => setSeqSet((q) => ({ ...q, fps: f }))}
                        >
                          {f === 0 ? '24 (как раньше)' : `${f}`}
                        </button>
                      ))}
                    </div>
                    <div className="mb-1 mt-2 text-[10px] uppercase tracking-wide text-zinc-500">Вписывание клипов</div>
                    {([
                      ['stretch', 'Растянуть (как раньше)'],
                      ['cover', 'Заполнить кадр (кроп)'],
                      ['contain', 'Вписать с полями'],
                      ['blur', 'Вписать, фон размытый'],
                    ] as const).map(([k, label]) => (
                      <button
                        key={k}
                        className={cn(
                          'w-full rounded px-2 py-1 text-left hover:bg-[var(--surface-2)]',
                          seqSet.fit === k && 'text-[#A78BFA]',
                        )}
                        onClick={() => setSeqSet((q) => ({ ...q, fit: k }))}
                      >
                        {label}
                      </button>
                    ))}
                    <div className="mb-1 mt-2 text-[10px] uppercase tracking-wide text-zinc-500">Качество</div>
                    {([
                      ['high', 'Высокое (медленно, crf 18)'],
                      ['standard', 'Обычное (crf 20)'],
                      ['fast', 'Черновик (быстро, crf 28)'],
                    ] as const).map(([k, label]) => (
                      <button
                        key={k}
                        className={cn(
                          'w-full rounded px-2 py-1 text-left hover:bg-[var(--surface-2)]',
                          seqSet.quality === k && 'text-[#A78BFA]',
                        )}
                        onClick={() => setSeqSet((q) => ({ ...q, quality: k }))}
                      >
                        {label}
                      </button>
                    ))}
                    {/* (правка 882) кодировщик результата: NVENC быстрее libx264 в разы,
                        но требует видеокарту NVIDIA; auto сам определит и откатится на CPU */}
                    <div className="mb-1 mt-2 text-[10px] uppercase tracking-wide text-zinc-500">Кодирование</div>
                    {([
                      ['auto', 'Авто (видеокарта, если есть)'],
                      ['cpu', 'Процессор (x264)'],
                      ['gpu', 'Видеокарта (NVENC)'],
                    ] as const).map(([k, label]) => (
                      <button
                        key={k}
                        className={cn(
                          'w-full rounded px-2 py-1 text-left hover:bg-[var(--surface-2)]',
                          (seqSet.codec ?? 'auto') === k && 'text-[#A78BFA]',
                        )}
                        onClick={() => setSeqSet((q) => ({ ...q, codec: k }))}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            {result && (
              <>
                <a href={result.url} download={result.filename} className="text-xs text-[#A78BFA] hover:underline">
                  <DownloadIcon className="mr-1 inline h-3.5 w-3.5" />
                  {result.filename}
                </a>
                <button
                  className="rounded border border-border p-1 text-zinc-400 hover:bg-[var(--surface-2)] hover:text-zinc-200"
                  onClick={copyResult}
                  title="Скопировать ссылку на готовый файл"
                >
                  <LinkIcon className="h-3.5 w-3.5" />
                </button>
              </>
            )}
            <button
              className="rounded-md bg-[#7C3AED] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#6D28D9] disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!shots.length || rendering}
              onClick={runRender}
            >
              {rendering ? `Сборка…${renderPct != null ? ` ${renderPct}%` : ''}` : `Собрать (${shots.length})`}
            </button>
          </div>
        </div>

        {/* большое превью: видео чуть меньше панели, масштаб настраивается;
            два буфера — видимый и прогретый под следующий клип (стык без скачка) */}
        {/* (правка 881, 883) min-h-[120px] + previewBoxRef: панель превью никогда
            не схлопнется в ноль, а видео на любой дорожке уменьшается в масштабе */}
        <div
          ref={previewBoxRef}
          className={cn('relative min-h-[120px] flex-1 overflow-hidden bg-black', isFs && 'fixed inset-0 z-[9999]')}
        >
          {/* (правка 859, 861) живые SVG-фильтры для каждого буфера: 5-точечные кривые цвета RGB,
              температура и радиальная дисперсия (центр кадра чистый, к краям нарастает) */}
          <svg width="0" height="0" className="pointer-events-none absolute opacity-0" aria-hidden>
            <defs>
              {[0, 1].map((b) => {
                const bKey = buf === b ? (previewVolKeyRef.current ?? bufShotKeyRef.current[b] ?? selectedKey) : bufShotKeyRef.current[b]
                const bShot = !result && bKey ? shots.find((s) => s.key === bKey) : null
                return <FxSvgFilter key={b} fx={bShot?.fx} id={`h3-fx-buf-${b}`} dispMap={radialDispMap} />
              })}
              {/* (правка 876) SVG-фильтры эффектов клипов слоёв V2+ (только когда нужны) */}
              {layers.map((l) =>
                needsSvgFx(l.fx) ? (
                  <FxSvgFilter key={`l-${l.key}`} fx={l.fx} id={`h3-fx-layer-${l.key}`} dispMap={radialDispMap} />
                ) : null,
              )}
            </defs>
          </svg>
          {/* (правка 874, 877, 883) видео-слои поверх базового кадра, синхронно playT.
              Бокс видео = vScale% × vScale% панели с object-fit: contain — при уменьшении
              высоты панели видео уменьшается в масштабе целиком и никогда не обрезается. */}
          {!result &&
            layers.map((l) => {
              const len = layerLen(l)
              if (l.hidden || playT < l.at || playT >= l.at + len) return null
              // (правка 876) эффекты слоя показываем в превью так же, как у базовых клипов
              const fxCss = shotFxCss(l.fx, `h3-fx-layer-${l.key}`)
              return (
                <video
                  key={l.key}
                  ref={(el) => {
                    if (el) layerElsRef.current.set(l.key, el)
                    else layerElsRef.current.delete(l.key)
                  }}
                  src={l.url}
                  playsInline
                  preload="auto"
                  className="absolute object-contain"
                  style={{
                    left: '50%',
                    top: '50%',
                    transform: `translate(-50%, -50%) scale(${fxCss.scaleX}, ${fxCss.scaleY})`,
                    filter: fxCss.filter,
                    width: `${Math.round(vScale * 100)}%`,
                    height: `${Math.round(vScale * 100)}%`,
                    maxWidth: '100%',
                    maxHeight: `${Math.round(vScale * 100)}%`,
                    objectFit: 'contain',
                    zIndex: 5 + l.track,
                  }}
                />
              )
            })}
          {/* (правка 874) аудиоклипы звуковых дорожек в превью (скрытые <audio>), микшируются с базой */}
          {!result &&
            audios.map((a) => {
              const len = audioLen(a)
              if (a.muted || playT < a.at || playT >= a.at + len) return null
              return (
                <audio
                  key={a.key}
                  ref={(el) => {
                    if (el) audioElsRef.current.set(a.key, el)
                    else audioElsRef.current.delete(a.key)
                  }}
                  src={a.url}
                  preload="auto"
                  className="hidden"
                />
              )
            })}
          {[0, 1].map((b) => {
            // (правка 858, 859) живые CSS+SVG эффекты (отражение, кривые, дисперсия, яркость/контраст/насыщенность)
            const bKey = buf === b ? (previewVolKeyRef.current ?? bufShotKeyRef.current[b] ?? selectedKey) : bufShotKeyRef.current[b]
            const bShot = !result && bKey ? shots.find((s) => s.key === bKey) : null
            const fxCss = shotFxCss(bShot?.fx, `h3-fx-buf-${b}`)
            return (
              <video
                key={b}
                ref={b === 0 ? previewARef : previewBRef}
                playsInline
                preload="auto"
                className="absolute cursor-pointer object-contain"
                style={{
                  left: '50%',
                  top: '50%',
                  transform: `translate(-50%, -50%) scale(${fxCss.scaleX}, ${fxCss.scaleY})`,
                  filter: fxCss.filter,
                  width: `${Math.round(vScale * 100)}%`,
                  height: `${Math.round(vScale * 100)}%`,
                  maxWidth: '100%',
                  maxHeight: `${Math.round(vScale * 100)}%`,
                  objectFit: 'contain',
                  opacity: !inGap && buf === b ? 1 : 0,
                  pointerEvents: buf === b ? 'auto' : 'none',
                }}
                onClick={togglePlay}
                onLoadedMetadata={(e) => {
                  const v = e.currentTarget
                  const w = wantSeekRef.current[b]
                  if (w != null) {
                    try { v.currentTime = w } catch { /* ignore */ }
                    wantSeekRef.current[b] = null
                  }
                  // гретый резерв остаётся на паузе, играем только активный буфер
                  if (playingRef.current && bufRef.current === b) void v.play().catch(() => {})
                }}
                onSeeked={(e) => {
                  // (правка 858) коалесинг seek при быстром скрабе: если за время декода
                  // кадра курсор ушёл дальше, сразу запускаем декод самой свежей точки
                  const next = pendingSeekRef.current[b]
                  if (next != null) {
                    pendingSeekRef.current[b] = null
                    const v = e.currentTarget
                    if (Math.abs(v.currentTime - next) > 0.004) {
                      try { v.currentTime = next } catch { /* ignore */ }
                    }
                  }
                }}
                onEnded={() => {
                  if (!playingRef.current || bufRef.current !== b) return
                  const i = idxRef.current
                  const sq = seqRef.current
                  const baseEnd = sq.length ? sq[sq.length - 1].offset + sq[sq.length - 1].len : 0
                  if (i >= 0 && i + 1 < sq.length) showClip(i + 1, sq[i + 1].r.start, true)
                  // (правка 879) хвост композиции за концом V1 доигрываем по часам
                  else if (tlEndRef.current > baseEnd + 0.02) startGapPlay(baseEnd, tlEndRef.current, -1)
                  else if (loop && sq.length) { syncPlayheadDOM(0); setPlayT(0); showClip(0, sq[0].r.start, true) }
                  else stopSeq(false)
                }}
                onTimeUpdate={(e) => {
                  // на паузе не даём уйти за границу подрезки
                  const i = idxRef.current
                  if (i < 0 || playingRef.current || bufRef.current !== b) return
                  const v = e.currentTarget
                  const row = seqRef.current[i]
                  if (row && v.currentTime >= row.r.end - 0.02) v.currentTime = Math.max(row.r.start, row.r.end - 0.02)
                }}
              />
            )
          })}
          {/* (правка 859, 884) анимированный киношный шум (зерно 35mm, 24 к/с) поверх кадра превью */}
          {(previewSrc || layers.length > 0) && !inGap && activeGrain > 0 && grainTile && (
            <div
              ref={grainOverlayRef}
              className="pointer-events-none absolute"
              style={{
                left: '50%',
                top: '50%',
                transform: 'translate(-50%, -50%)',
                width: `${Math.round(vScale * 100)}%`,
                height: `${Math.round(vScale * 100)}%`,
                backgroundImage: `url(${grainTile})`,
                backgroundRepeat: 'repeat',
                mixBlendMode: 'overlay',
                opacity: Math.min(0.78, (activeGrain / 100) * 0.72),
                // (правка 886) над видеобуферами базы и слоем-источником шума, под
                // более высокими чистыми слоями (у слоёв zIndex = 5 + track)
                zIndex: grainSrc?.zIndex ?? 1,
              }}
            />
          )}
          {!previewSrc && !layers.length && !audios.length && (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 text-zinc-500">
              <FilmIcon className="h-10 w-10 opacity-40" />
              <div className="text-sm">
                {shots.length
                  ? 'Выберите клип на таймлайне или нажмите «Играть»'
                  : 'Перетащите видео из галереи на любую дорожку'}
              </div>
            </div>
          )}
          {result && (
            <div className="absolute left-3 top-3 rounded bg-emerald-600/90 px-2 py-1 text-xs font-medium text-white">
              Готово: {result.filename}
            </div>
          )}
          {isFs && (
            <button
              className="absolute right-2 top-2 z-10 rounded border border-border bg-black/60 p-1.5 text-zinc-300 hover:text-white"
              onClick={() => setIsFs(false)}
              title="Выйти из полноэкранного режима (Esc)"
            >
              <MinimizeIcon className="h-4 w-4" />
            </button>
          )}
          {/* масштаб превью */}
          <div className="absolute bottom-2 right-2 flex items-center gap-1 rounded border border-border bg-black/60 px-1.5 py-1 text-xs text-zinc-300">
            <button
              className="rounded p-0.5 hover:bg-[var(--surface-2)]"
              onClick={() => setVScale((s) => Math.max(0.2, +(s - 0.1).toFixed(2)))}
              title="Уменьшить превью"
            >
              <ZoomOutIcon className="h-3.5 w-3.5" />
            </button>
            <span className="w-10 text-center font-mono">{Math.round(vScale * 100)}%</span>
            <button
              className="rounded p-0.5 hover:bg-[var(--surface-2)]"
              onClick={() => setVScale((s) => Math.min(1, +(s + 0.1).toFixed(2)))}
              title="Увеличить превью"
            >
              <ZoomInIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* граница между превью и таймлайном — тянем вверх/вниз */}
        <div
          className="group flex h-2.5 shrink-0 cursor-ns-resize items-center justify-center border-t border-border bg-[var(--surface-1)] hover:bg-[#7C3AED]/20"
          onPointerDown={startTlResize}
          title="Потяните вверх/вниз — высота таймлайна"
        >
          <div className="h-0.5 w-10 rounded bg-zinc-600 group-hover:bg-[#A78BFA]" />
        </div>

        {/* (правка 861) транспорт + настройки таймлайна: прямо над самим таймлайном */}
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border bg-[var(--surface-1)] px-3 py-1.5">
          {/* слева: история, разрез, магнит, дорожки, очистка таймлайна */}
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              className="rounded border border-border px-1.5 py-1 text-zinc-400 hover:bg-[var(--surface-2)] disabled:opacity-40"
              onClick={undo}
              disabled={!canUndo}
              title="Отменить (Ctrl+Z)"
            >
              <Undo2Icon className="h-3.5 w-3.5" />
            </button>
            <button
              className="rounded border border-border px-1.5 py-1 text-zinc-400 hover:bg-[var(--surface-2)] disabled:opacity-40"
              onClick={redo}
              disabled={!canRedo}
              title="Повторить (Ctrl+Shift+Z или Ctrl+Y)"
            >
              <Redo2Icon className="h-3.5 w-3.5" />
            </button>
            <div className="mx-0.5 h-4 w-px bg-border" />
            <button
              className="rounded border border-border px-1.5 py-1 text-zinc-400 hover:bg-[var(--surface-2)] disabled:cursor-not-allowed disabled:opacity-40"
              onClick={splitAtPlayhead}
              disabled={tlEnd <= 0}
              title="Разрезать клип на плейхеде (S): режет все дорожки под плейхедом"
            >
              <ScissorsIcon className="h-3.5 w-3.5" />
            </button>
            <button
              className={cn(
                'rounded border px-1.5 py-1 hover:bg-[var(--surface-2)]',
                snap ? 'border-[#A78BFA] text-[#A78BFA]' : 'border-border text-zinc-400',
              )}
              onClick={() => setSnap((v) => !v)}
              title="Магнит: прилипание к краям клипов и плейхеду"
            >
              <MagnetIcon className="h-3.5 w-3.5" />
            </button>
            {/* (правка 874, 883) создание и удаление видеодорожек (V+ / V−) и аудиодорожек (A+ / A−) */}
            <button
              className="rounded border border-border px-1.5 py-1 text-zinc-400 hover:bg-[var(--surface-2)]"
              onClick={() => {
                const rowsNow = Math.max(layerTracks, layers.reduce((m, l) => Math.max(m, l.track), 0))
                if (rowsNow >= MAX_TRACKS) {
                  showToast(`Не более ${MAX_TRACKS} видеодорожек`, 'error')
                  return
                }
                pushHistory()
                setLayerTracks(rowsNow + 1)
                showToast(`Добавлена видеодорожка V${rowsNow + 2} — перетащите файл из галереи на неё`)
              }}
              title="Добавить видеодорожку (V2, V3…)"
            >
              <span className="font-mono text-[11px] font-semibold">V+</span>
            </button>
            <button
              className="rounded border border-border px-1.5 py-1 text-zinc-400 hover:border-red-500/50 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={layerRows.length === 0}
              onClick={() => {
                if (layerRows.length > 0) removeVideoTrack(layerRows[0])
              }}
              title={layerRows.length > 0 ? `Удалить верхнюю видеодорожку V${layerRows[0] + 1}` : 'Нет дополнительных видеодорожек для удаления'}
            >
              <span className="font-mono text-[11px] font-semibold">V−</span>
            </button>
            <button
              className="rounded border border-border px-1.5 py-1 text-zinc-400 hover:bg-[var(--surface-2)]"
              onClick={() => {
                // (правка 880) новая аудиодорожка: A2, A3… — верхняя существующая + 1
                const rowsNow = Math.max(audioTracks, audios.reduce((m, a) => Math.max(m, a.track), 0))
                if (rowsNow >= MAX_TRACKS) {
                  showToast(`Не более ${MAX_TRACKS} аудиодорожек`, 'error')
                  return
                }
                pushHistory()
                setAudioTracks(rowsNow + 1)
                showToast(`Добавлена аудиодорожка A${rowsNow + 1} — перетащите аудиофайл на неё`)
              }}
              title="Добавить аудиодорожку (A1, A2…)"
            >
              <span className="font-mono text-[11px] font-semibold">A+</span>
            </button>
            <button
              className="rounded border border-border px-1.5 py-1 text-zinc-400 hover:border-red-500/50 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={audioRows.length === 0}
              onClick={() => {
                if (audioRows.length > 0) removeAudioTrack(audioRows[audioRows.length - 1])
              }}
              title={audioRows.length > 0 ? `Удалить аудиодорожку A${audioRows[audioRows.length - 1]}` : 'Нет аудиодорожек для удаления'}
            >
              <span className="font-mono text-[11px] font-semibold">A−</span>
            </button>
            <button
              className="rounded border border-border px-1.5 py-1 text-zinc-400 hover:bg-[var(--surface-2)]"
              onClick={() => audioFileInputRef.current?.click()}
              title="Импорт аудиофайла с диска на аудиодорожку (встаёт по плейхеду)"
            >
              <MusicIcon className="h-3.5 w-3.5" />
            </button>
            <input
              ref={audioFileInputRef}
              type="file"
              accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg,.flac,.opus"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                e.target.value = ''
                if (f) void importAndAddAudio(f)
              }}
            />
            {(shots.length > 0 || layers.length > 0 || audios.length > 0 || layerRows.length > 0 || audioRows.length > 0) && (
              <button
                className="rounded border border-border px-2 py-1 text-xs text-zinc-400 hover:border-red-500/50 hover:text-red-300"
                onClick={() => {
                  // (правка 880) очищаем все дорожки одинаково: видеоряды и аудиоряды
                  pushHistory()
                  stopSeq(false)
                  setShots([])
                  setLayers([])
                  setAudios([])
                  setLayerTracks(0)
                  setAudioTracks(0)
                  setSelectedKey(null)
                  setSelectedLayerKey(null)
                  setSelectedAudioKey(null)
                  setResult(null)
                }}
                title="Очистить все дорожки таймлайна"
              >
                Очистить
              </button>
            )}
          </div>

          {/* по центру: транспорт воспроизведения и общая громкость */}
          <div className="flex items-center gap-2">
            <button
              className="rounded border border-border px-1.5 py-1 hover:bg-[var(--surface-2)] disabled:opacity-40"
              onClick={() => seekTo(0)}
              disabled={tlEnd <= 0}
              title="В начало"
            >
              <SkipBackIcon className="h-3.5 w-3.5" />
            </button>
            <button
              className="rounded-md bg-[#7C3AED] px-2.5 py-1.5 text-white hover:bg-[#6D28D9] disabled:cursor-not-allowed disabled:opacity-50"
              onClick={togglePlay}
              disabled={tlEnd <= 0}
              title="Играть / пауза (пробел)"
            >
              {playing ? <PauseIcon className="h-4 w-4" /> : <PlayIcon className="h-4 w-4" />}
            </button>
            <button
              className={cn(
                'rounded border px-1.5 py-1 hover:bg-[var(--surface-2)]',
                loop ? 'border-[#A78BFA] text-[#A78BFA]' : 'border-border text-zinc-400',
              )}
              onClick={() => setLoop((v) => !v)}
              title="Повтор всей последовательности (луп)"
            >
              <RepeatIcon className="h-3.5 w-3.5" />
            </button>
            <button
              className={cn(
                'rounded border px-1.5 py-1 hover:bg-[var(--surface-2)]',
                loopClip ? 'border-[#A78BFA] text-[#A78BFA]' : 'border-border text-zinc-400',
              )}
              onClick={() => setLoopClip((v) => !v)}
              title="Повторять текущий клип (не переходя дальше по таймлайну)"
            >
              <Repeat1Icon className="h-3.5 w-3.5" />
            </button>
            <button
              className={cn(
                'rounded border px-1.5 py-1 hover:bg-[var(--surface-2)]',
                muted ? 'border-border text-zinc-600' : 'border-border text-zinc-400',
              )}
              onClick={() => setMuted((v) => !v)}
              title={muted ? 'Включить звук превью' : 'Выключить звук превью'}
            >
              {muted ? <VolumeXIcon className="h-3.5 w-3.5" /> : <Volume2Icon className="h-3.5 w-3.5" />}
            </button>
            <label
              className="flex items-center gap-1.5"
              title="Общая громкость таймлайна (вплавляется и в готовое видео)"
            >
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(masterVol * 100)}
                onChange={(e) => setMasterVol(Number(e.target.value) / 100)}
                className="h-1 w-20 cursor-pointer accent-[#7C3AED]"
              />
              <span className="w-8 font-mono text-[10px] text-zinc-400">{Math.round(masterVol * 100)}%</span>
            </label>
            <span ref={timecodeRef} className="font-mono text-xs text-zinc-400">{fmtT(playT)} / {fmtT(tlEnd)}</span>
          </div>

          {/* справа: масштаб таймлайна + полный экран */}
          <div className="flex items-center gap-1 text-xs text-zinc-400">
            <button
              className="rounded border border-border px-1.5 py-1 hover:bg-[var(--surface-2)]"
              onClick={() => setPps((p) => Math.max(8, Math.round(p / 1.5)))}
              title="Уменьшить масштаб таймлайна"
            >
              <ZoomOutIcon className="h-3.5 w-3.5" />
            </button>
            <span className="w-14 text-center font-mono" title="Колесо мыши над таймлайном — тот же масштаб">
              {pps} px/с
            </span>
            <button
              className="rounded border border-border px-1.5 py-1 hover:bg-[var(--surface-2)]"
              onClick={() => setPps((p) => Math.min(240, Math.round(p * 1.5)))}
              title="Увеличить масштаб таймлайна"
            >
              <ZoomInIcon className="h-3.5 w-3.5" />
            </button>
            <button
              className="rounded border border-border px-1.5 py-1 hover:bg-[var(--surface-2)] disabled:opacity-40"
              onClick={fitZoom}
              disabled={!shots.length}
              title="Вписать весь таймлайн в окно"
            >
              <FrameIcon className="h-3.5 w-3.5" />
            </button>
            <button
              className="ml-1 rounded border border-border px-1.5 py-1 text-zinc-400 hover:bg-[var(--surface-2)]"
              onClick={toggleFullscreen}
              title={isFs ? 'Выйти из полноэкранного режима (F)' : 'Просмотр на весь экран (F)'}
            >
              {isFs ? <MinimizeIcon className="h-3.5 w-3.5" /> : <MaximizeIcon className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>

        {/* таймлайн: линейка + дорожка + плейхед.
            (правка 881) раньше ряды дорожек (shrink-0 + overflow-y-hidden) переполняли
            окно при большой высоте дорожек — превью сминалось и обрезалось. Теперь
            контейнер может сжиматься и листается по вертикали. */}
        <div
          ref={scrollerRef}
          className="min-h-0 overflow-x-auto overflow-y-auto border-t border-border bg-[var(--surface-1)] px-2 py-2"
          onDragOver={(e) => {
            const el = e.target as HTMLElement | null
            const aRow = el?.closest('[data-audio-row]')
            const lRow = el?.closest('[data-layer-row]')
            const d = dragRef.current
            // (правка 874) над аудиорядом принимаем и файлы из проводника (dragRef пуст)
            if (aRow) {
              if (d || Array.from(e.dataTransfer.types || []).includes('Files')) {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'copy'
                setDropIdx(null)
              }
              return
            }
            if (lRow) {
              if (d?.kind === 'gallery') {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'copy'
                setDropIdx(null)
              }
              return
            }
            if (!d) return
            e.preventDefault()
            e.dataTransfer.dropEffect = d.kind === 'gallery' ? 'copy' : 'move'
            setDropIdx(computeDropIdx(e.clientX))
          }}
          onDragLeave={() => setDropIdx(null)}
          onDrop={onTimelineDrop}
        >
          <div className="relative" style={{ width: `${Math.max(400, (tlEnd + 5) * pps)}px` }}>
            {/* линейка времени */}
            <div
              className="relative h-6 cursor-pointer select-none"
              onPointerDown={startScrub}
              title="Клик или тяните — перемотка"
              style={tlEnd > 0 ? {
                backgroundImage: `repeating-linear-gradient(to right, var(--border) 0 1px, transparent 1px ${(rulerStep / 5) * pps}px)`,
              } : undefined}
            >
              {rulerTicks.map((t) => (
                <span
                  key={t}
                  className="absolute top-0 font-mono text-[10px] leading-4 text-zinc-500"
                  style={{ left: `${t * pps + 3}px` }}
                >
                  {t.toFixed(rulerStep < 0.5 ? 2 : rulerStep < 1 ? 1 : 0)}
                </span>
              ))}
            </div>
            {/* (правка 874) ряды видео-слоёв V2+ над базой: верхний ряд перекрывает нижние */}
            {layerRows.map((t) => {
              // (правка 879) все дорожки одинаковые: та же высота и оформление, что у V1
              const h = trackH
              const clips = layers.filter((l) => l.track === t)
              return (
                <div
                  key={`layer-${t}`}
                  data-layer-row={t}
                  className="relative mb-1 overflow-hidden rounded border border-border/50 bg-black/30"
                  style={{ height: h }}
                  onPointerDown={(e) => {
                    if ((e.target as HTMLElement | null) === e.currentTarget) startScrub(e)
                  }}
                  title={`Дорожка V${t + 1}: перетащите сюда файл из галереи`}
                >
                  <div className=" absolute left-1 top-0.5 z-20 flex items-center gap-0.5 rounded bg-black/50 px-1 py-0.5">
                    <span className="pointer-events-none font-mono text-[9px] font-semibold text-zinc-400">
                      V{t + 1}
                    </span>
                    <button
                      type="button"
                      data-remove-video-track={t}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation()
                        removeVideoTrack(t)
                      }}
                      className="rounded px-0.5 font-mono text-[10px] leading-none text-zinc-500 hover:bg-red-500/30 hover:text-red-300"
                      title={`Удалить дорожку V${t + 1}`}
                    >
                      ×
                    </button>
                  </div>
                  {clips.map((l) => {
                    const w = Math.max(14, layerLen(l) * pps)
                    // (правка 876) кинополоса на чипе слоя — как у базовой дорожки;
                    // пока строится новая — показываем предыдущую с cover-кропом
                    const { w: sw, h: sh, r: sr } = layerStripReq(l)
                    const exactStrip = strips[stripKey(l.url, sr, sw, sh)]
                    const strip = exactStrip || lastStripByLayerRef.current[l.key]
                    return (
                      <div
                        key={l.key}
                        onPointerDown={(e) => startFreeClipDrag(e, 'layer', l)}
                        className={cn(
                          'group absolute inset-y-0 cursor-grab select-none overflow-hidden rounded-[2px] border bg-[var(--surface-2)] active:cursor-grabbing',
                          selectedLayerKey === l.key
                            ? 'z-10 border-[#A78BFA] ring-1 ring-[#A78BFA]/40'
                            : 'border-border hover:border-zinc-500',
                          l.hidden && 'opacity-40',
                        )}
                        style={{
                          left: `${l.at * pps}px`,
                          width: `${w}px`,
                          backgroundImage: strip ? `url(${strip})` : undefined,
                          backgroundSize: exactStrip ? '100% 100%' : 'cover',
                          backgroundPosition: 'center',
                          backgroundRepeat: 'no-repeat',
                        }}
                        title={`${l.name} · дорожка V${t + 1} · старт ${l.at.toFixed(2)} с · длина ${layerLen(l).toFixed(1)} с${l.muted ? ' · звук выключен' : ` · громкость ${Math.round((l.vol ?? 1) * 100)}%`}`}
                      >
                        {!strip && (
                          <img
                            src={`${l.url}${l.url.includes('?') ? '&' : '?'}width=160`}
                            alt=""
                            draggable={false}
                            loading="lazy"
                            className="h-full w-full object-cover opacity-70"
                            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                          />
                        )}
                        {/* (правка 878) маркер: клип слоя ждёт чистовик из Refine */}
                        {pendingReturn[l.key] && (
                          <span
                            className="absolute left-1 top-1 flex items-center gap-0.5 rounded bg-[#7C3AED]/85 px-1 py-0.5 text-[9px] font-semibold text-white animate-pulse"
                            title="Отправлен в Refine — придёт и заменит этот клип"
                          >
                            <Wand2Icon className="h-2.5 w-2.5" />
                            Refine
                          </span>
                        )}
                        {/* (правка 876) маркер активных эффектов на слое */}
                        {!pendingReturn[l.key] && hasFx(l.fx) && (
                          <span
                            className="pointer-events-none absolute left-1 top-1 rounded bg-[#7C3AED]/80 px-1 py-0.2 text-[9px] font-semibold text-white"
                            title="На клипе применены эффекты"
                          >
                            FX
                          </span>
                        )}
                        <div className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-black/60 px-1 text-[10px] leading-4 text-white">
                          {l.name} · {layerLen(l).toFixed(1)}с{l.hidden ? ' · скрыт' : ''}{l.muted ? ' · без звука' : ''}
                        </div>
                        <div
                          data-trim-handle="start"
                          onPointerDown={(e) => startFreeTrimDrag(e, 'layer', l, 'start')}
                          className="absolute inset-y-0 left-0 w-2 cursor-ew-resize bg-[#7C3AED]/0 group-hover:bg-[#7C3AED]/60"
                          title="Подрезать начало"
                        />
                        <div
                          data-trim-handle="end"
                          onPointerDown={(e) => startFreeTrimDrag(e, 'layer', l, 'end')}
                          className="absolute inset-y-0 right-0 w-2 cursor-ew-resize bg-[#7C3AED]/0 group-hover:bg-[#7C3AED]/60"
                          title="Подрезать конец"
                        />
                        <button
                          onClick={(e) => { e.stopPropagation(); sendLayerToRefine(l) }}
                          className="absolute right-5 top-0.5 hidden rounded bg-black/60 p-0.5 text-zinc-300 hover:text-[#A78BFA] group-hover:block"
                          title="В Refine (исходник слоя целиком)"
                        >
                          <Wand2Icon className="h-2.5 w-2.5" />
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); removeLayerClip(l.key) }}
                          className="absolute right-0.5 top-0.5 hidden rounded bg-black/60 p-0.5 text-zinc-300 hover:text-white group-hover:block"
                          title="Убрать клип"
                        >
                          <XIcon className="h-2.5 w-2.5" />
                        </button>
                      </div>
                    )
                  })}
                </div>
              )
            })}
            {/* дорожка с клипами (правка 860: клипы позиционируются по offset и двигаются свободно с паузами gap) */}
            <div
              ref={trackRef}
              data-base-row="1"
              className="relative mb-1 overflow-hidden rounded border border-border/50 bg-black/30"
              style={{ height: trackH }}
              onPointerDown={(e) => {
                if ((e.target as HTMLElement | null) === e.currentTarget) startScrub(e)
              }}
            >
              <div className="absolute left-1 top-0.5 z-20 flex items-center gap-0.5 rounded bg-black/50 px-1 py-0.5">
                <span className="pointer-events-none font-mono text-[9px] font-semibold text-zinc-400">V1</span>
                {(layerRows.length > 0 || shots.length > 0) && (
                  <button
                    type="button"
                    data-remove-video-track={0}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation()
                      removeVideoTrack(0)
                    }}
                    className="rounded px-0.5 font-mono text-[10px] leading-none text-zinc-500 hover:bg-red-500/30 hover:text-red-300"
                    title={layerRows.length > 0 ? 'Удалить дорожку V1' : 'Очистить дорожку V1'}
                  >
                    ×
                  </button>
                )}
              </div>
              {seq.map((row) => {
                const w = Math.max(16, row.len * pps)
                const exactStrip = strips[stripKey(row.shot.url, row.r, w, Math.max(24, trackH))]
                // (правка 860) пока при растягивании панели таймлайна вверх/вниз новая
                // полоса ещё строится, показываем предыдущую полосу клипа с cover-кадрированием,
                // а сама makeStrip рисует каждую ячейку с cover-кропом — кадры никогда не растягиваются
                const strip = exactStrip || lastStripByShotRef.current[row.shot.key]
                return (
                  <div
                    key={row.shot.key}
                    data-clip={row.shot.key}
                    onPointerDown={(e) => startClipDrag(e, row)}
                    className={cn(
                      'group absolute inset-y-0 cursor-grab select-none overflow-hidden rounded-[2px] border bg-[var(--surface-2)] active:cursor-grabbing',
                      selectedKey === row.shot.key ? 'z-10 border-[#A78BFA] ring-1 ring-[#A78BFA]/40' : 'border-border hover:border-zinc-500',
                    )}
                    style={{
                      left: `${row.offset * pps}px`,
                      width: `${w}px`,
                      backgroundImage: strip ? `url(${strip})` : undefined,
                      backgroundSize: exactStrip ? '100% 100%' : 'cover',
                      backgroundPosition: 'center',
                      backgroundRepeat: 'no-repeat',
                    }}
                    title={`${row.shot.name} · старт ${row.offset.toFixed(2)} с · длина ${row.len.toFixed(1)} с${row.gap >= 0.02 ? ` · пауза перед клипом ${row.gap.toFixed(2)} с` : ''}`}
                  >
                    {!strip && (
                      <img
                        src={`${row.shot.url}${row.shot.url.includes('?') ? '&' : '?'}width=160`}
                        alt=""
                        draggable={false}
                        loading="lazy"
                        className="h-full w-full object-cover opacity-70"
                        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                      />
                    )}
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-black/60 px-1 text-[10px] leading-4 text-white">
                      {row.shot.name} · {row.len.toFixed(1)}с{row.shot.vol != null && row.shot.vol !== 1 ? ` · ${Math.round(row.shot.vol * 100)}%` : ''}
                    </div>
                    <div
                      data-trim-handle="start"
                      onPointerDown={(e) => startTrimDrag(e, row.shot, 'start')}
                      className="absolute inset-y-0 left-0 w-2 cursor-ew-resize bg-[#7C3AED]/0 group-hover:bg-[#7C3AED]/60"
                      title="Подрезать начало"
                    />
                    <div
                      data-trim-handle="end"
                      onPointerDown={(e) => startTrimDrag(e, row.shot, 'end')}
                      className="absolute inset-y-0 right-0 w-2 cursor-ew-resize bg-[#7C3AED]/0 group-hover:bg-[#7C3AED]/60"
                      title="Подрезать конец"
                    />
                    {/* (правка 857) маркер: клип ждёт чистовик из Refine */}
                    {pendingReturn[row.shot.key] && (
                      <span
                        className="absolute left-1 top-1 flex items-center gap-0.5 rounded bg-[#7C3AED]/85 px-1 py-0.5 text-[9px] font-semibold text-white animate-pulse"
                        title="Отправлен в Refine — придёт и заменит этот клип"
                      >
                        <Wand2Icon className="h-2.5 w-2.5" />
                        Refine
                      </span>
                    )}
                    {/* (правка 859) маркер активных эффектов на клипе */}
                    {!pendingReturn[row.shot.key] && hasFx(row.shot.fx) && (
                      <span
                        className="pointer-events-none absolute left-1 top-1 rounded bg-[#7C3AED]/80 px-1 py-0.2 text-[9px] font-semibold text-white"
                        title="На клипе применены эффекты"
                      >
                        FX
                      </span>
                    )}
                    {/* (правка 856) отправить исходник клипа во вкладку «Refine» */}
                    <button
                      onClick={(e) => { e.stopPropagation(); sendShotToRefine(row.shot) }}
                      className="absolute right-6 top-0.5 hidden rounded bg-black/60 p-0.5 text-zinc-300 hover:text-[#A78BFA] group-hover:block"
                      title="В Refine (исходник целиком, без подрезки)"
                    >
                      <Wand2Icon className="h-3 w-3" />
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); removeShot(row.shot.key) }}
                      className="absolute right-0.5 top-0.5 hidden rounded bg-black/60 p-0.5 text-zinc-300 hover:text-white group-hover:block"
                      title="Убрать шот"
                    >
                      <XIcon className="h-3 w-3" />
                    </button>
                  </div>
                )
              })}
              {/* маркер вставки */}
              {dropIdx != null && (
                <div
                  className="pointer-events-none absolute inset-y-0 z-10 w-0.5 bg-[#A78BFA]"
                  style={{
                    left: `${dropIdx < seq.length ? seq[dropIdx].offset * pps : tlEnd * pps}px`,
                  }}
                />
              )}
            </div>
            {/* (правка 874) аудиоряды A1+ под базой: клипы со звуком с диска */}
            {audioRows.map((t) => {
              const h = Math.max(22, Math.round(trackH * 0.45))
              const clips = audios.filter((a) => a.track === t)
              return (
                <div
                  key={`audio-${t}`}
                  data-audio-row={t}
                  className="relative mb-1 rounded border border-emerald-500/25 bg-emerald-500/5"
                  style={{ height: h }}
                  onPointerDown={(e) => {
                    if ((e.target as HTMLElement | null) === e.currentTarget) startScrub(e)
                  }}
                  title={`Аудиодорожка A${t}: перетащите сюда аудиофайл из проводника`}
                >
                  <div className="absolute left-1 top-0.5 z-20 flex items-center gap-0.5 rounded bg-black/50 px-1 py-0.5">
                    <span className="pointer-events-none font-mono text-[9px] font-semibold text-emerald-400/80">
                      A{t}
                    </span>
                    <button
                      type="button"
                      data-remove-audio-track={t}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation()
                        removeAudioTrack(t)
                      }}
                      className="rounded px-0.5 font-mono text-[10px] leading-none text-emerald-400/60 hover:bg-red-500/30 hover:text-red-300"
                      title={`Удалить аудиодорожку A${t}`}
                    >
                      ×
                    </button>
                  </div>
                  {clips.map((a) => {
                    const w = Math.max(12, audioLen(a) * pps)
                    return (
                      <div
                        key={a.key}
                        onPointerDown={(e) => startFreeClipDrag(e, 'audio', a)}
                        className={cn(
                          'group absolute inset-y-0.5 cursor-grab select-none overflow-hidden rounded-[2px] border bg-emerald-600/25 active:cursor-grabbing',
                          selectedAudioKey === a.key
                            ? 'z-10 border-emerald-300 ring-1 ring-emerald-300/40'
                            : 'border-emerald-500/40 hover:border-emerald-400/70',
                          a.muted && 'opacity-40',
                        )}
                        style={{ left: `${a.at * pps}px`, width: `${w}px` }}
                        title={`${a.name} · дорожка A${t} · старт ${a.at.toFixed(2)} с · длина ${audioLen(a).toFixed(1)} с · ${Math.round(a.vol)}%`}
                      >
                        <div className="pointer-events-none absolute inset-0 flex items-center px-2 opacity-25">
                          <MusicIcon className="h-3 w-3 shrink-0 text-emerald-200" />
                        </div>
                        <div className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-black/60 px-1 text-[9px] leading-3 text-white">
                          {a.name} · {audioLen(a).toFixed(1)}с · {Math.round(a.vol)}%{a.muted ? ' · нем' : ''}
                        </div>
                        <div
                          data-trim-handle="start"
                          onPointerDown={(e) => startFreeTrimDrag(e, 'audio', a, 'start')}
                          className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize bg-emerald-500/0 group-hover:bg-emerald-500/60"
                          title="Подрезать начало"
                        />
                        <div
                          data-trim-handle="end"
                          onPointerDown={(e) => startFreeTrimDrag(e, 'audio', a, 'end')}
                          className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-emerald-500/0 group-hover:bg-emerald-500/60"
                          title="Подрезать конец"
                        />
                        <button
                          onClick={(e) => { e.stopPropagation(); removeAudioClip(a.key) }}
                          className="absolute right-0.5 top-0.5 hidden rounded bg-black/60 p-0.5 text-zinc-300 hover:text-white group-hover:block"
                          title="Убрать аудио"
                        >
                          <XIcon className="h-2.5 w-2.5" />
                        </button>
                      </div>
                    )
                  })}
                </div>
              )
            })}
            {/* плейхед: линия + ромб-головка (тяните — перемотка) */}
            {tlEnd > 0 && (
              <div ref={playheadRef} className="pointer-events-none absolute inset-y-0 z-20" style={{ left: `${playT * pps}px` }}>
                <div className="absolute inset-y-0 w-px -translate-x-px bg-red-400" />
                <div
                  onPointerDown={startScrub}
                  className="pointer-events-auto absolute -left-[5px] top-0 h-2.5 w-2.5 rotate-45 cursor-ew-resize bg-red-400"
                  title="Тяните — перемотка"
                />
              </div>
            )}
          </div>
        </div>
      </section>

      {/* (правка 859) правая панель: 3 вкладки — Галерея | Свойства | Эффекты */}
      <aside className="flex w-[350px] shrink-0 flex-col border-l border-border bg-[var(--surface-1)]">
        {/* переключатель вкладок */}
        <div className="grid grid-cols-3 gap-1 border-b border-border p-2 text-xs">
          {([
            ['gallery', 'Галерея'],
            ['props', 'Свойства'],
            ['fx', 'Эффекты'],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setRightTab(id)}
              className={cn(
                'relative rounded-md px-2 py-1.5 font-medium transition-colors',
                rightTab === id
                  ? 'bg-[#7C3AED] text-white'
                  : 'bg-[var(--surface-2)] text-zinc-400 hover:text-zinc-200',
              )}
            >
              {label}
              {id === 'fx' && fxTarget && hasFx(fxTarget.fx) && (
                <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 align-middle" />
              )}
            </button>
          ))}
        </div>

        {/* ВКЛАДКА 1: ГАЛЕРЕЯ */}
        {rightTab === 'gallery' && (
          <>
            <div className="space-y-2 border-b border-border p-3">
              <div className="flex gap-2">
                <select
                  className="min-w-0 flex-1 rounded-md border border-border bg-[var(--surface-2)] px-2 py-1.5 text-xs outline-none focus:border-[#A78BFA]"
                  value={folderFilter}
                  onChange={(e) => setFolderFilter(e.target.value)}
                >
                  <option value="__all__">Все видео</option>
                  <option value="">Общая</option>
                  {folders.map((f) => (
                    <option key={f} value={f}>{f}</option>
                  ))}
                </select>
                <input
                  className="min-w-0 flex-1 rounded-md border border-border bg-[var(--surface-2)] px-2 py-1.5 text-xs outline-none placeholder:text-zinc-500 focus:border-[#A78BFA]"
                  value={search}
                  placeholder="Поиск…"
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <div className="text-[11px] text-zinc-500">
                Перетащите карточку на таймлайн; клик — добавить в конец, «+» — на плейхед
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {loading && <div className="p-2 text-xs text-zinc-500">Загрузка…</div>}
              {!loading && videoFiles.length === 0 && (
                <div className="p-2 text-xs text-zinc-500">Видео не найдены</div>
              )}
              <div className="grid grid-cols-2 gap-2">
                {videoFiles.map((f) => (
                  <div
                    key={`${f.subfolder}/${f.filename}`}
                    draggable
                    onDragStart={(e) => {
                      dragRef.current = { kind: 'gallery', file: f }
                      e.dataTransfer.effectAllowed = 'copy'
                    }}
                    onDragEnd={() => { dragRef.current = null; setDropIdx(null) }}
                    onClick={() => addShot(f)}
                    className="group cursor-grab overflow-hidden rounded-md border border-border bg-[var(--surface-2)] transition-colors hover:border-[#A78BFA]"
                    title={`${f.filename} — перетащите на таймлайн`}
                  >
                    <div className="relative aspect-video bg-black">
                      <img
                        src={`${f.url}${f.url.includes('?') ? '&' : '?'}width=600`}
                        alt=""
                        draggable={false}
                        loading="lazy"
                        className="h-full w-full object-cover"
                        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                      />
                      <button
                        onClick={(e) => { e.stopPropagation(); addShot(f, insertAtPlayheadIdx()) }}
                        className="absolute right-1 top-1 hidden rounded bg-black/70 p-1 text-zinc-200 hover:text-white group-hover:block"
                        title="Вставить в таймлайн на месте плейхеда"
                      >
                        <PlusIcon className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <div className="truncate px-1.5 py-1 text-[11px]">
                      {f.filename.replace(/\.[^.]+$/, '')}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {/* ВКЛАДКА 2: СВОЙСТВА КЛИПА (правка 874: плюс свойства слоёв и аудио) */}
        {rightTab === 'props' && (
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 text-xs">
            {selectedLayer ? (
              <div className="space-y-3">
                <div className="rounded-lg border border-[#7C3AED]/40 bg-[var(--surface-2)] p-2.5">
                  <div className="flex items-center gap-1.5">
                    <LayersIcon className="h-3.5 w-3.5 shrink-0 text-[#A78BFA]" />
                    <span className="truncate font-medium text-zinc-100" title={selectedLayer.filename}>{selectedLayer.name}</span>
                  </div>
                  <div className="mt-1 flex items-center justify-between text-[11px] text-zinc-400">
                    <span>В кадре: <strong className="text-zinc-200">{layerLen(selectedLayer).toFixed(2)} с</strong></span>
                    <span>Исходник: {selectedLayer.duration ? `${selectedLayer.duration.toFixed(2)} с` : '…'}</span>
                  </div>
                  <div className="mt-1.5 rounded bg-black/30 px-2 py-1 text-[10px] text-zinc-400">
                    Слой V{selectedLayer.track + 1} лежит над базовой дорожкой; его звук микшируется с базой.
                    Тяните клип по ряду или между рядами, за края — подрезка.
                  </div>
                  {/* (правка 878) паритет с базой: слой тоже можно отправить в Refine */}
                  <button
                    onClick={() => sendLayerToRefine(selectedLayer)}
                    className="mt-2 flex w-full items-center justify-center gap-1.5 rounded border border-[#7C3AED]/50 bg-[#7C3AED]/15 px-2 py-1.5 text-[11px] text-[#C4B5FD] hover:bg-[#7C3AED]/25"
                    title="Отправить исходник слоя в Refine целиком (без подрезки)"
                  >
                    <Wand2Icon className="h-3 w-3" />
                    В Refine (исходник целиком)
                  </button>
                  {pendingReturn[selectedLayer.key] && (
                    <div className="mt-1 flex items-center gap-1 text-[10px] text-[#A78BFA]">
                      <Wand2Icon className="h-2.5 w-2.5 animate-pulse" />
                      Ждём чистовик из Refine — он заменит файл слоя
                    </div>
                  )}
                </div>
                <div className="space-y-1.5 rounded-lg border border-border bg-[var(--surface-2)] p-2.5">
                  <div className="text-[11px] font-medium text-zinc-300">Позиция на шкале, с</div>
                  <input
                    key={`at-${selectedLayer.key}-${selectedLayer.at}`}
                    type="text"
                    inputMode="decimal"
                    defaultValue={selectedLayer.at.toFixed(2)}
                    onFocus={pushHistory}
                    onBlur={(e) => {
                      const v = parseSec(e.target.value)
                      if (v != null && Math.abs(v - selectedLayer.at) > 0.001) patchLayer(selectedLayer.key, { at: +v.toFixed(3) })
                    }}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                    className="w-full rounded border border-border bg-[var(--surface-1)] px-2 py-1 font-mono text-xs text-zinc-200 focus:border-[#A78BFA] focus:outline-none"
                  />
                </div>
                <div className="space-y-2 rounded-lg border border-border bg-[var(--surface-2)] p-2.5">
                  <div className="text-[11px] font-medium text-zinc-300">Вписывание в кадр</div>
                  <div className="grid grid-cols-4 gap-1">
                    {([
                      ['stretch', 'Растянуть'],
                      ['cover', 'Заполнить'],
                      ['contain', 'Вписать'],
                      ['blur', 'Подложка'],
                    ] as const).map(([f, lab]) => (
                      <button
                        key={f}
                        onClick={() => { pushHistory(); patchLayer(selectedLayer.key, { fit: f }) }}
                        className={cn(
                          'rounded border px-1 py-1.5 text-[10px] transition-colors',
                          selectedLayer.fit === f
                            ? 'border-[#A78BFA] bg-[#7C3AED]/30 text-white'
                            : 'border-border bg-[var(--surface-1)] text-zinc-400 hover:text-zinc-200',
                        )}
                      >
                        {lab}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="space-y-2 rounded-lg border border-border bg-[var(--surface-2)] p-2.5">
                  <div className="text-[11px] font-medium text-zinc-300">Скорость воспроизведения</div>
                  <div className="grid grid-cols-6 gap-1">
                    {SPEED_STEPS.map((v) => (
                      <button
                        key={v}
                        onClick={() => { pushHistory(); patchLayer(selectedLayer.key, { speed: v }) }}
                        className={cn(
                          'rounded border py-1 text-[11px] font-mono transition-colors',
                          Math.abs((selectedLayer.speed || 1) - v) < 0.01
                            ? 'border-[#A78BFA] bg-[#7C3AED]/30 text-white'
                            : 'border-border bg-[var(--surface-1)] text-zinc-400 hover:text-zinc-200',
                        )}
                      >
                        {v}×
                      </button>
                    ))}
                  </div>
                </div>
                {/* (правка 877) звук слоя — как у клипа базовой дорожки: громкость/фейды/mute */}
                <div className="space-y-2.5 rounded-lg border border-border bg-[var(--surface-2)] p-2.5">
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-medium text-zinc-300">Громкость слоя</span>
                      <button
                        onClick={() => { pushHistory(); patchLayer(selectedLayer.key, { vol: 1, muted: false }) }}
                        className="font-mono text-[11px] text-[#A78BFA] hover:underline"
                        title="Клик — сбросить в 100%"
                      >
                        {Math.round((selectedLayer.vol ?? 1) * 100)}%
                      </button>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={Math.round((selectedLayer.vol ?? 1) * 100)}
                      onPointerDown={pushHistory}
                      onChange={(e) => patchLayer(selectedLayer.key, { vol: Number(e.target.value) / 100 })}
                      className="h-1.5 w-full cursor-pointer accent-[#7C3AED]"
                    />
                  </div>
                  <div className="space-y-1 pt-0.5">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-zinc-400">Плавный вход звука (↑)</span>
                      <button
                        onClick={() => { pushHistory(); patchLayer(selectedLayer.key, { fadeIn: 0 }) }}
                        className="font-mono text-[#A78BFA] hover:underline"
                        title="Клик — выключить плавный вход"
                      >
                        {(selectedLayer.fadeIn || 0).toFixed(1)} с
                      </button>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={Math.max(1, Math.min(10, +layerLen(selectedLayer).toFixed(1)))}
                      step={0.1}
                      value={Math.min(10, selectedLayer.fadeIn || 0)}
                      onPointerDown={pushHistory}
                      onChange={(e) => patchLayer(selectedLayer.key, { fadeIn: Math.max(0, Math.min(30, Number(e.target.value) || 0)) })}
                      className="h-1.5 w-full cursor-pointer accent-[#7C3AED]"
                    />
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-zinc-400">Затухание звука в конце (↓)</span>
                      <button
                        onClick={() => { pushHistory(); patchLayer(selectedLayer.key, { fadeOut: 0 }) }}
                        className="font-mono text-[#A78BFA] hover:underline"
                        title="Клик — выключить затухание"
                      >
                        {(selectedLayer.fadeOut || 0).toFixed(1)} с
                      </button>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={Math.max(1, Math.min(10, +layerLen(selectedLayer).toFixed(1)))}
                      step={0.1}
                      value={Math.min(10, selectedLayer.fadeOut || 0)}
                      onPointerDown={pushHistory}
                      onChange={(e) => patchLayer(selectedLayer.key, { fadeOut: Math.max(0, Math.min(30, Number(e.target.value) || 0)) })}
                      className="h-1.5 w-full cursor-pointer accent-[#7C3AED]"
                    />
                  </div>
                </div>
                {/* (правка 876) отражения слоя — как у клипа базовой дорожки */}
                <div className="space-y-2 rounded-lg border border-border bg-[var(--surface-2)] p-2.5">
                  <div className="text-[11px] font-medium text-zinc-300">Отражение кадра</div>
                  <div className="grid grid-cols-2 gap-1.5">
                    {([
                      ['flipH', '↔ По горизонтали'],
                      ['flipV', '↕ По вертикали'],
                    ] as const).map(([k, label]) => (
                      <button
                        key={k}
                        onClick={() => {
                          pushHistory()
                          updateSelectedFx((cur) => ({ ...cur, [k]: !cur[k] }))
                        }}
                        className={cn(
                          'rounded border px-2 py-1.5 text-[11px] transition-colors',
                          selectedLayer.fx?.[k]
                            ? 'border-[#A78BFA] bg-[#7C3AED]/30 text-white'
                            : 'border-border bg-[var(--surface-1)] text-zinc-400 hover:text-zinc-200',
                        )}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="grid grid-cols-4 gap-1.5 pt-1">
                  <button
                    onClick={() => { pushHistory(); patchLayer(selectedLayer.key, { muted: !selectedLayer.muted }) }}
                    className={cn(
                      'rounded border border-border bg-[var(--surface-2)] py-1.5 text-[11px] hover:border-[#A78BFA]',
                      selectedLayer.muted ? 'text-[#A78BFA]' : 'text-zinc-300',
                    )}
                    title="Выключить звук слоя в превью и сборке (картинка остаётся)"
                  >
                    {selectedLayer.muted ? 'Включить звук' : 'Заглушить'}
                  </button>
                  <button
                    onClick={() => { pushHistory(); patchLayer(selectedLayer.key, { hidden: !selectedLayer.hidden }) }}
                    className={cn(
                      'rounded border border-border bg-[var(--surface-2)] py-1.5 text-[11px] hover:border-[#A78BFA]',
                      selectedLayer.hidden ? 'text-[#A78BFA]' : 'text-zinc-300',
                    )}
                    title="Скрывать слой в превью и сборке"
                  >
                    {selectedLayer.hidden ? 'Показать' : 'Скрыть'}
                  </button>
                  <button
                    onClick={() => duplicateLayerClip(selectedLayer.key)}
                    className="flex items-center justify-center gap-1 rounded border border-border bg-[var(--surface-2)] py-1.5 text-zinc-300 hover:border-[#A78BFA] hover:text-[#A78BFA]"
                    title="Дублировать слой (D)"
                  >
                    <CopyIcon className="h-3.5 w-3.5" />
                    Дубликат
                  </button>
                  <button
                    onClick={() => removeLayerClip(selectedLayer.key)}
                    className="flex items-center justify-center gap-1 rounded border border-border bg-[var(--surface-2)] py-1.5 text-zinc-300 hover:border-red-500/60 hover:text-red-300"
                    title="Удалить слой (Del)"
                  >
                    <TrashIcon className="h-3.5 w-3.5" />
                    Удалить
                  </button>
                </div>
              </div>
            ) : selectedAudio ? (
              <div className="space-y-3">
                <div className="rounded-lg border border-emerald-500/40 bg-[var(--surface-2)] p-2.5">
                  <div className="flex items-center gap-1.5">
                    <MusicIcon className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                    <span className="truncate font-medium text-zinc-100" title={selectedAudio.name}>{selectedAudio.name}</span>
                  </div>
                  <div className="mt-1 flex items-center justify-between text-[11px] text-zinc-400">
                    <span>В сборке: <strong className="text-zinc-200">{audioLen(selectedAudio).toFixed(2)} с</strong></span>
                    <span>Файл: {selectedAudio.duration ? `${selectedAudio.duration.toFixed(2)} с` : '…'}</span>
                  </div>
                  <div className="mt-1.5 rounded bg-black/30 px-2 py-1 text-[10px] text-zinc-400">
                    Звук дорожки A{selectedAudio.track} микшируется с базой без нормализации.
                  </div>
                </div>
                <div className="space-y-2.5 rounded-lg border border-border bg-[var(--surface-2)] p-2.5">
                  <div className="space-y-1.5">
                    <div className="text-[11px] font-medium text-zinc-300">Позиция на шкале, с</div>
                    <input
                      key={`aat-${selectedAudio.key}-${selectedAudio.at}`}
                      type="text"
                      inputMode="decimal"
                      defaultValue={selectedAudio.at.toFixed(2)}
                      onFocus={pushHistory}
                      onBlur={(e) => {
                        const v = parseSec(e.target.value)
                        if (v != null && Math.abs(v - selectedAudio.at) > 0.001) patchAudio(selectedAudio.key, { at: +v.toFixed(3) })
                      }}
                      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                      className="w-full rounded border border-border bg-[var(--surface-1)] px-2 py-1 font-mono text-xs text-zinc-200 focus:border-[#A78BFA] focus:outline-none"
                    />
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-medium text-zinc-300">Громкость клипа</span>
                      <button
                        onClick={() => { pushHistory(); patchAudio(selectedAudio.key, { vol: 100 }) }}
                        className="font-mono text-[11px] text-[#A78BFA] hover:underline"
                        title="Клик — сбросить в 100%"
                      >
                        {Math.round(selectedAudio.vol)}%
                      </button>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={200}
                      value={Math.round(selectedAudio.vol)}
                      onPointerDown={pushHistory}
                      onChange={(e) => patchAudio(selectedAudio.key, { vol: Number(e.target.value) })}
                      className="h-1.5 w-full cursor-pointer accent-[#7C3AED]"
                    />
                  </div>
                  <div className="space-y-1 pt-0.5">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-zinc-400">Плавный вход звука (↑)</span>
                      <button
                        onClick={() => { pushHistory(); patchAudio(selectedAudio.key, { fadeIn: 0 }) }}
                        className="font-mono text-[#A78BFA] hover:underline"
                        title="Клик — выключить плавный вход"
                      >
                        {(selectedAudio.fadeIn || 0).toFixed(1)} с
                      </button>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={Math.max(1, Math.min(10, +audioLen(selectedAudio).toFixed(1)))}
                      step={0.1}
                      value={Math.min(10, selectedAudio.fadeIn || 0)}
                      onPointerDown={pushHistory}
                      onChange={(e) => patchAudio(selectedAudio.key, { fadeIn: Math.max(0, Math.min(30, Number(e.target.value) || 0)) })}
                      className="h-1.5 w-full cursor-pointer accent-[#7C3AED]"
                    />
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-zinc-400">Затухание звука в конце (↓)</span>
                      <button
                        onClick={() => { pushHistory(); patchAudio(selectedAudio.key, { fadeOut: 0 }) }}
                        className="font-mono text-[#A78BFA] hover:underline"
                        title="Клик — выключить затухание"
                      >
                        {(selectedAudio.fadeOut || 0).toFixed(1)} с
                      </button>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={Math.max(1, Math.min(10, +audioLen(selectedAudio).toFixed(1)))}
                      step={0.1}
                      value={Math.min(10, selectedAudio.fadeOut || 0)}
                      onPointerDown={pushHistory}
                      onChange={(e) => patchAudio(selectedAudio.key, { fadeOut: Math.max(0, Math.min(30, Number(e.target.value) || 0)) })}
                      className="h-1.5 w-full cursor-pointer accent-[#7C3AED]"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-1.5 pt-1">
                  <button
                    onClick={() => { pushHistory(); patchAudio(selectedAudio.key, { muted: !selectedAudio.muted }) }}
                    className={cn(
                      'rounded border border-border bg-[var(--surface-2)] py-1.5 text-[11px] hover:border-[#A78BFA]',
                      selectedAudio.muted ? 'text-[#A78BFA]' : 'text-zinc-300',
                    )}
                    title="Выключить этот звук в превью и сборке"
                  >
                    {selectedAudio.muted ? 'Включить звук' : 'Заглушить'}
                  </button>
                  <button
                    onClick={() => duplicateAudioClip(selectedAudio.key)}
                    className="flex items-center justify-center gap-1 rounded border border-border bg-[var(--surface-2)] py-1.5 text-zinc-300 hover:border-[#A78BFA] hover:text-[#A78BFA]"
                    title="Дублировать аудио (D)"
                  >
                    <CopyIcon className="h-3.5 w-3.5" />
                    Дубликат
                  </button>
                  <button
                    onClick={() => removeAudioClip(selectedAudio.key)}
                    className="flex items-center justify-center gap-1 rounded border border-border bg-[var(--surface-2)] py-1.5 text-zinc-300 hover:border-red-500/60 hover:text-red-300"
                    title="Удалить аудио (Del)"
                  >
                    <TrashIcon className="h-3.5 w-3.5" />
                    Удалить
                  </button>
                </div>
              </div>
            ) : !selected ? (
              <div className="rounded-lg border border-dashed border-border p-4 text-center text-zinc-500">
                <div>Кликните по клипу на таймлайне, чтобы настроить его свойства</div>
                {shots.length > 0 && (
                  <button
                    onClick={() => selectClip('shot', shots[0].key)}
                    className="mt-2 rounded border border-border bg-[var(--surface-2)] px-2.5 py-1 text-zinc-300 hover:border-[#A78BFA]"
                  >
                    Выбрать 1-й клип
                  </button>
                )}
              </div>
            ) : (
              <>
                {/* карточка клипа */}
                <div className="rounded-lg border border-border bg-[var(--surface-2)] p-2.5">
                  <div className="truncate font-medium text-zinc-100" title={selected.filename}>
                    {selected.name}
                  </div>
                  <div className="mt-1 flex items-center justify-between text-[11px] text-zinc-400">
                    <span>
                      На таймлайне:{' '}
                      <strong className="text-zinc-200">
                        {((effRange(selected).end - effRange(selected).start) / shotSpeed(selected)).toFixed(2)} с
                      </strong>
                    </span>
                    <span>Исходник: {selected.duration ? `${selected.duration.toFixed(2)} с` : '…'}</span>
                  </div>
                  {(selected.gap ?? 0) >= 0.02 && (
                    <div className="mt-1.5 flex items-center justify-between rounded bg-[#7C3AED]/15 px-2 py-1 text-[11px] text-[#A78BFA]">
                      <span>Пауза перед клипом: {(selected.gap ?? 0).toFixed(2)} с</span>
                      <button
                        onClick={() => {
                          pushHistory()
                          setShots((prev) => prev.map((x) => (x.key === selected.key ? { ...x, gap: undefined } : x)))
                        }}
                        className="rounded border border-[#A78BFA]/40 px-1.5 py-0.5 text-[10px] text-white hover:bg-[#7C3AED]/40"
                      >
                        Прижать встык
                      </button>
                    </div>
                  )}
                  <div className="mt-1.5 rounded bg-black/30 px-2 py-1 text-[10px] text-zinc-400">
                    Тяните сам клип по дорожке для свободного сдвига, за края — для подрезки; разрез на плейхеде — <kbd className="rounded border border-border px-1">S</kbd>
                  </div>
                </div>

                {/* звук клипа (громкость + ползунки плавного входа и затухания) */}
                {(() => {
                  const clipDur = Math.max(0.5, (effRange(selected).end - effRange(selected).start) / shotSpeed(selected))
                  const maxFade = Math.max(1, Math.min(10, +clipDur.toFixed(1)))
                  return (
                    <div className="space-y-2.5 rounded-lg border border-border bg-[var(--surface-2)] p-2.5">
                      <div className="space-y-1">
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] font-medium text-zinc-300">Громкость клипа</span>
                          <button
                            onClick={() => {
                              pushHistory()
                              setShots((prev) => prev.map((x) => (x.key === selected.key ? { ...x, vol: 1 } : x)))
                            }}
                            className="font-mono text-[11px] text-[#A78BFA] hover:underline"
                            title="Клик — сбросить в 100%"
                          >
                            {Math.round((selected.vol ?? 1) * 100)}%
                          </button>
                        </div>
                        <input
                          type="range"
                          min={0}
                          max={100}
                          value={Math.round((selected.vol ?? 1) * 100)}
                          onPointerDown={pushHistory}
                          onChange={(e) => {
                            const vol = Number(e.target.value) / 100
                            setShots((prev) => prev.map((x) => (x.key === selected.key ? { ...x, vol } : x)))
                          }}
                          className="h-1.5 w-full cursor-pointer accent-[#7C3AED]"
                        />
                      </div>

                      {/* (правка 860) Плавный вход аудио — ползунок */}
                      <div className="space-y-1 pt-0.5">
                        <div className="flex items-center justify-between text-[11px]">
                          <span className="text-zinc-400">Плавный вход звука (↑)</span>
                          <button
                            onClick={() => {
                              pushHistory()
                              setShots((prev) => prev.map((x) => (x.key === selected.key ? { ...x, fadeIn: undefined } : x)))
                            }}
                            className="font-mono text-[#A78BFA] hover:underline"
                            title="Клик — выключить плавный вход"
                          >
                            {(selected.fadeIn || 0).toFixed(1)} с
                          </button>
                        </div>
                        <input
                          type="range"
                          min={0}
                          max={maxFade}
                          step={0.1}
                          value={Math.min(maxFade, selected.fadeIn || 0)}
                          onPointerDown={pushHistory}
                          onChange={(e) => {
                            const fadeIn = Math.max(0, Math.min(30, Number(e.target.value) || 0))
                            setShots((prev) =>
                              prev.map((x) => (x.key === selected.key ? { ...x, fadeIn: fadeIn < 0.05 ? undefined : +fadeIn.toFixed(1) } : x)),
                            )
                          }}
                          className="h-1.5 w-full cursor-pointer accent-[#7C3AED]"
                        />
                      </div>

                      {/* (правка 860) Затухание аудио — ползунок */}
                      <div className="space-y-1">
                        <div className="flex items-center justify-between text-[11px]">
                          <span className="text-zinc-400">Затухание звука в конце (↓)</span>
                          <button
                            onClick={() => {
                              pushHistory()
                              setShots((prev) => prev.map((x) => (x.key === selected.key ? { ...x, fadeOut: undefined } : x)))
                            }}
                            className="font-mono text-[#A78BFA] hover:underline"
                            title="Клик — выключить затухание"
                          >
                            {(selected.fadeOut || 0).toFixed(1)} с
                          </button>
                        </div>
                        <input
                          type="range"
                          min={0}
                          max={maxFade}
                          step={0.1}
                          value={Math.min(maxFade, selected.fadeOut || 0)}
                          onPointerDown={pushHistory}
                          onChange={(e) => {
                            const fadeOut = Math.max(0, Math.min(30, Number(e.target.value) || 0))
                            setShots((prev) =>
                              prev.map((x) => (x.key === selected.key ? { ...x, fadeOut: fadeOut < 0.05 ? undefined : +fadeOut.toFixed(1) } : x)),
                            )
                          }}
                          className="h-1.5 w-full cursor-pointer accent-[#7C3AED]"
                        />
                      </div>
                    </div>
                  )
                })()}

                {/* скорость */}
                <div className="space-y-2 rounded-lg border border-border bg-[var(--surface-2)] p-2.5">
                  <div className="text-[11px] font-medium text-zinc-300">Скорость воспроизведения</div>
                  <div className="grid grid-cols-6 gap-1">
                    {SPEED_STEPS.map((v) => {
                      const active = Math.abs(shotSpeed(selected) - v) < 0.01
                      return (
                        <button
                          key={v}
                          onClick={() => {
                            pushHistory()
                            setShots((prev) =>
                              prev.map((x) => (x.key === selected.key ? { ...x, speed: v === 1 ? undefined : v } : x)),
                            )
                          }}
                          className={cn(
                            'rounded border py-1 text-[11px] font-mono transition-colors',
                            active
                              ? 'border-[#A78BFA] bg-[#7C3AED]/30 text-white'
                              : 'border-border bg-[var(--surface-1)] text-zinc-400 hover:text-zinc-200',
                          )}
                        >
                          {v}×
                        </button>
                      )
                    })}
                  </div>
                </div>

                {/* отражение */}
                <div className="space-y-2 rounded-lg border border-border bg-[var(--surface-2)] p-2.5">
                  <div className="text-[11px] font-medium text-zinc-300">Отражение кадра</div>
                  <div className="grid grid-cols-2 gap-1.5">
                    {([
                      ['flipH', '↔ По горизонтали'],
                      ['flipV', '↕ По вертикали'],
                    ] as const).map(([k, label]) => (
                      <button
                        key={k}
                        onClick={() => {
                          pushHistory()
                          updateSelectedFx((cur) => ({ ...cur, [k]: !cur[k] }))
                        }}
                        className={cn(
                          'rounded border px-2 py-1.5 text-[11px] transition-colors',
                          selected.fx?.[k]
                            ? 'border-[#A78BFA] bg-[#7C3AED]/30 text-white'
                            : 'border-border bg-[var(--surface-1)] text-zinc-400 hover:text-zinc-200',
                        )}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* действия с клипом */}
                <div className="grid grid-cols-3 gap-1.5 pt-1">
                  <button
                    onClick={() => sendShotToRefine(selected)}
                    className="flex items-center justify-center gap-1 rounded border border-border bg-[var(--surface-2)] py-1.5 text-zinc-300 hover:border-[#A78BFA] hover:text-[#A78BFA]"
                    title="Отправить исходник в Refine (результат вернётся и заменит этот клип)"
                  >
                    <Wand2Icon className="h-3.5 w-3.5" />
                    В Refine
                  </button>
                  <button
                    onClick={() => duplicateShot(selected.key)}
                    className="flex items-center justify-center gap-1 rounded border border-border bg-[var(--surface-2)] py-1.5 text-zinc-300 hover:border-[#A78BFA] hover:text-[#A78BFA]"
                    title="Дублировать клип (D)"
                  >
                    <CopyIcon className="h-3.5 w-3.5" />
                    Дубликат
                  </button>
                  <button
                    onClick={() => removeShot(selected.key)}
                    className="flex items-center justify-center gap-1 rounded border border-border bg-[var(--surface-2)] py-1.5 text-zinc-300 hover:border-red-500/60 hover:text-red-300"
                    title="Удалить клип (Del)"
                  >
                    <TrashIcon className="h-3.5 w-3.5" />
                    Удалить
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* ВКЛАДКА 3: ЭФФЕКТЫ (Кривые цвета, Насыщенность, Яркость, Контраст, Дисперсия, Киношный шум + Копирование) */}
        {rightTab === 'fx' && (
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 text-xs">
            {!fxTarget ? (
              <div className="rounded-lg border border-dashed border-border p-4 text-center text-zinc-500">
                <div>Выберите клип на базовой дорожке или слой V2+, чтобы настроить его эффекты</div>
                {shots.length > 0 && (
                  <button
                    onClick={() => selectClip('shot', shots[0].key)}
                    className="mt-2 rounded border border-border bg-[var(--surface-2)] px-2.5 py-1 text-zinc-300 hover:border-[#A78BFA]"
                  >
                    Выбрать 1-й клип
                  </button>
                )}
              </div>
            ) : (
              <>
                {/* (правка 884) шапка выбранного клипа + общий байпас (До/После) + сброс */}
                {(() => {
                  const isAllBypassed = !!fxTarget.fx?.bypass
                  const isByp = (k: FxBypassKey) => !!fxTarget.fx?.bypassed?.[k]
                  const toggleOneBypass = (k: FxBypassKey) => {
                    pushHistory()
                    updateSelectedFx((cur) => {
                      const nextMap = { ...(cur.bypassed || {}) }
                      if (nextMap[k]) delete nextMap[k]
                      else nextMap[k] = true
                      return {
                        ...cur,
                        bypassed: Object.keys(nextMap).length ? nextMap : undefined,
                      }
                    })
                  }
                  const renderBypassBtn = (k: FxBypassKey, titleLabel: string) => {
                    const off = isAllBypassed || isByp(k)
                    return (
                      <button
                        type="button"
                        data-fx-bypass={k}
                        onClick={() => toggleOneBypass(k)}
                        className={cn(
                          'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium transition-colors',
                          isByp(k)
                            ? 'border-amber-500/50 bg-amber-500/15 text-amber-300'
                            : off
                              ? 'border-border bg-[var(--surface-1)] text-zinc-500'
                              : 'border-[#A78BFA]/40 bg-[#7C3AED]/20 text-zinc-200 hover:border-[#A78BFA]',
                        )}
                        title={
                          isByp(k)
                            ? `Включить эффект «${titleLabel}» (сейчас в байпасе — До)`
                            : `Байпас эффекта «${titleLabel}» (сравнить До/После)`
                        }
                      >
                        {isByp(k) ? <EyeOffIcon className="h-3 w-3" /> : <EyeIcon className="h-3 w-3" />}
                        <span>{isByp(k) ? 'До' : 'Вкл'}</span>
                      </button>
                    )
                  }
                  return (
                    <>
                      <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-[var(--surface-2)] px-2.5 py-2">
                        <div className="min-w-0">
                          <div className="truncate font-medium text-zinc-100">
                            {fxTarget.name}
                            {/* (правка 876) подпись дорожки: слой V2+ или базовая V1 */}
                            {'track' in fxTarget ? (
                              <span className="ml-1.5 font-mono text-[10px] text-[#A78BFA]">слой V{fxTarget.track + 1}</span>
                            ) : null}
                          </div>
                          <div className="text-[10px] text-zinc-400">
                            {!hasFx(fxTarget.fx)
                              ? 'Без эффектов'
                              : isAllBypassed
                                ? 'Общий байпас включён — показан исходник (До)'
                                : hasActiveFx(fxTarget.fx)
                                  ? 'Эффекты активны (После)'
                                  : 'Все настроенные эффекты в байпасе (До)'}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <button
                            type="button"
                            data-fx-bypass="all"
                            onClick={() => {
                              pushHistory()
                              updateSelectedFx((cur) => ({ ...cur, bypass: !cur.bypass }))
                            }}
                            className={cn(
                              'inline-flex items-center gap-1 rounded border px-2 py-1 text-[11px] font-medium transition-colors',
                              isAllBypassed
                                ? 'border-amber-500/60 bg-amber-500/20 text-amber-200'
                                : 'border-[#A78BFA]/50 bg-[#7C3AED]/25 text-white hover:bg-[#7C3AED]/40',
                            )}
                            title="Общий байпас всех эффектов клипа: сравнить До / После одним кликом"
                          >
                            {isAllBypassed ? <EyeOffIcon className="h-3.5 w-3.5" /> : <EyeIcon className="h-3.5 w-3.5" />}
                            <span>{isAllBypassed ? 'До (Байпас)' : 'До / После'}</span>
                          </button>
                          {hasFx(fxTarget.fx) && (
                            <button
                              onClick={resetSelectedFx}
                              className="shrink-0 rounded border border-border bg-[var(--surface-1)] px-2 py-1 text-[11px] text-zinc-300 hover:border-red-500/50 hover:text-red-300"
                            >
                              Сбросить
                            </button>
                          )}
                        </div>
                      </div>

                      {/* 1. КРИВЫЕ ЦВЕТА (RGB Curves, правка 861: 5 узлов [x,y] с 2D-перетаскиванием как в DaVinci Resolve) */}
                      {(() => {
                        const curCurves = fxTarget.fx?.curves || {}
                        const activePts: CurvePts = normalizeCurvePts(curCurves[curveCh])
                        const strokeColor =
                          curveCh === 'r' ? '#f87171' : curveCh === 'g' ? '#4ade80' : curveCh === 'b' ? '#60a5fa' : '#A78BFA'
                        const setChannelPts = (pts: CurvePts | undefined) => {
                          updateSelectedFx((cur) => {
                            const nextCurves: ShotCurves = { ...(cur.curves || {}) }
                            if (!pts || !isCurveActive(pts)) delete nextCurves[curveCh]
                            else nextCurves[curveCh] = pts
                            return { ...cur, curves: hasCurves(nextCurves) ? nextCurves : undefined }
                          })
                        }
                        const startPointDrag = (idx: 0 | 1 | 2 | 3 | 4, ev: React.PointerEvent) => {
                          ev.preventDefault()
                          ev.stopPropagation()
                          pushHistory()
                          const svg = curveSvgRef.current
                          if (!svg) return
                          // (правка 862) переводим координаты курсора в систему viewBox
                          // (0..200 × 0..140) через CTM: раньше делили на getBoundingClientRect,
                          // а SVG вписан с полями -> ручка «улетала» при захвате
                          const VIEW_W = 200
                          const VIEW_H = 140
                          const toNorm = (clientX: number, clientY: number): [number, number] => {
                            const m = svg.getScreenCTM()
                            if (!m) return [0, 0]
                            const p = new DOMPoint(clientX, clientY).matrixTransform(m.inverse())
                            return [
                              Math.max(0, Math.min(1, p.x / VIEW_W)),
                              Math.max(0, Math.min(1, 1 - p.y / VIEW_H)),
                            ]
                          }
                          const basePts = activePts.map(([x, y]) => [x, y] as CurveNode) as CurvePts
                          const start = toNorm(ev.clientX, ev.clientY)
                          const startNode = basePts[idx]
                          const minX = idx === 0 ? 0 : +(basePts[idx - 1][0] + 0.03).toFixed(3)
                          const maxX = idx === 4 ? 1 : +(basePts[idx + 1][0] - 0.03).toFixed(3)
                          const onMove = (me: PointerEvent) => {
                            const cur = toNorm(me.clientX, me.clientY)
                            // тянем ОТНОСИТЕЛЬНО точки захвата: клик по ручке не сдвигает её рывком
                            const nx = Math.max(minX, Math.min(maxX, startNode[0] + (cur[0] - start[0])))
                            const ny = Math.max(0, Math.min(1, startNode[1] + (cur[1] - start[1])))
                            const next = basePts.map(([x, y], i) =>
                              i === idx ? ([+nx.toFixed(3), +ny.toFixed(3)] as CurveNode) : ([x, y] as CurveNode),
                            ) as CurvePts
                            setChannelPts(next)
                          }
                          const onUp = () => {
                            window.removeEventListener('pointermove', onMove)
                            window.removeEventListener('pointerup', onUp)
                          }
                          window.addEventListener('pointermove', onMove)
                          window.addEventListener('pointerup', onUp)
                        }
                        const pointLabels = ['Чёрные', 'Тени', 'Средние', 'Света', 'Белые'] as const
                        return (
                          <div className={cn('space-y-2 rounded-lg border border-border bg-[var(--surface-2)] p-2.5', (isAllBypassed || isByp('curves')) && 'opacity-65')}>
                            <div className="flex items-center justify-between gap-1">
                              <div className="flex items-center gap-1.5">
                                {renderBypassBtn('curves', 'Кривые цвета')}
                                <span className="text-[11px] font-medium text-zinc-200">Кривые цвета (5 точек)</span>
                              </div>
                              <button
                                onClick={() => { pushHistory(); setChannelPts(undefined) }}
                                className="text-[10px] text-zinc-400 hover:text-[#A78BFA]"
                                title="Сбросить выбранный канал кривой"
                              >
                                Сброс канала
                              </button>
                            </div>
                            {/* переключатель канала RGB / R / G / B */}
                            <div className="grid grid-cols-4 gap-1">
                              {([
                                ['master', 'RGB', 'text-zinc-200'],
                                ['r', 'R (Красн)', 'text-red-400'],
                                ['g', 'G (Зел)', 'text-emerald-400'],
                                ['b', 'B (Син)', 'text-blue-400'],
                              ] as const).map(([ch, label, col]) => (
                                <button
                                  key={ch}
                                  onClick={() => setCurveCh(ch)}
                                  className={cn(
                                    'rounded border py-1 text-[10px] font-medium transition-colors',
                                    curveCh === ch
                                      ? 'border-[#A78BFA] bg-[#7C3AED]/25 ' + col
                                      : 'border-border bg-[var(--surface-1)] text-zinc-400 hover:text-zinc-200',
                                  )}
                                >
                                  {label}
                                  {isCurveActive(curCurves[ch]) && ' •'}
                                </button>
                              ))}
                            </div>
                            {/* интерактивный график 2D-кривой (5 узлов двигаются в любые стороны) */}
                            <div className="relative overflow-hidden rounded border border-border bg-black/70">
                              <svg
                                ref={curveSvgRef}
                                viewBox="0 0 200 140"
                                className="block h-[140px] w-full select-none"
                              >
                                {/* сетка 4x4 */}
                                {[1, 2, 3].map((g) => (
                                  <g key={g} stroke="rgba(255,255,255,0.08)" strokeWidth="1">
                                    <line x1={g * 50} y1={0} x2={g * 50} y2={140} />
                                    <line x1={0} y1={g * 35} x2={200} y2={g * 35} />
                                  </g>
                                ))}
                                {/* базовая диагональ */}
                                <line x1={0} y1={140} x2={200} y2={0} stroke="rgba(255,255,255,0.18)" strokeDasharray="3 3" strokeWidth="1" />
                                {/* фоновые неактивные каналы */}
                                {(['master', 'r', 'g', 'b'] as const).map((ch) => {
                                  if (ch === curveCh || !isCurveActive(curCurves[ch])) return null
                                  const c = ch === 'r' ? '#f87171' : ch === 'g' ? '#4ade80' : ch === 'b' ? '#60a5fa' : '#a78bfa'
                                  return (
                                    <path
                                      key={ch}
                                      d={buildCurveSvgPath(normalizeCurvePts(curCurves[ch]), 200, 140)}
                                      fill="none"
                                      stroke={c}
                                      strokeOpacity={0.35}
                                      strokeWidth="1.5"
                                    />
                                  )
                                })}
                                {/* активная кривая */}
                                <path
                                  d={buildCurveSvgPath(activePts, 200, 140)}
                                  fill="none"
                                  stroke={strokeColor}
                                  strokeWidth="2.2"
                                />
                                {/* 5 узловых точек: Чёрные (0), Тени (1), Средние (2), Света (3), Белые (4) */}
                                {([0, 1, 2, 3, 4] as const).map((idx) => {
                                  const [pxNorm, pyNorm] = activePts[idx]
                                  const cx = Math.max(5, Math.min(195, pxNorm * 200))
                                  const cy = Math.max(5, Math.min(135, (1 - pyNorm) * 140))
                                  const defVal = idx * 0.25
                                  return (
                                    <circle
                                      key={idx}
                                      data-curve-handle={idx}
                                      cx={cx}
                                      cy={cy}
                                      r={5.2}
                                      fill="#18181b"
                                      stroke={strokeColor}
                                      strokeWidth="2.2"
                                      className="cursor-move"
                                      onPointerDown={(ev) => startPointDrag(idx, ev)}
                                      onDoubleClick={() => {
                                        pushHistory()
                                        const next = activePts.map(([x, y], i) =>
                                          i === idx ? ([defVal, defVal] as CurveNode) : ([x, y] as CurveNode),
                                        ) as CurvePts
                                        setChannelPts(next)
                                      }}
                                    >
                                      <title>{`${pointLabels[idx]}: X=${Math.round(pxNorm * 100)}%, Y=${Math.round(pyNorm * 100)}% (тяните в любую сторону, двойной клик — сброс)`}</title>
                                    </circle>
                                  )
                                })}
                              </svg>
                              <div className="pointer-events-none flex justify-between px-1.5 pb-1 text-[9px] text-zinc-500">
                                <span>Чёрн {Math.round(activePts[0][1] * 100)}%</span>
                                <span>Тени {Math.round(activePts[1][1] * 100)}%</span>
                                <span>Сред {Math.round(activePts[2][1] * 100)}%</span>
                                <span>Света {Math.round(activePts[3][1] * 100)}%</span>
                                <span>Бел {Math.round(activePts[4][1] * 100)}%</span>
                              </div>
                            </div>
                            {/* пресеты кривых */}
                            <div className="flex flex-wrap gap-1 pt-0.5">
                              {([
                                [
                                  'S-контраст',
                                  { master: [[0, 0], [0.25, 0.18], [0.5, 0.5], [0.75, 0.82], [1, 1]] as CurvePts },
                                ],
                                [
                                  'Мягкие тени',
                                  { master: [[0, 0.06], [0.25, 0.3], [0.5, 0.52], [0.75, 0.76], [1, 0.96]] as CurvePts },
                                ],
                                [
                                  'Тёплое кино',
                                  {
                                    master: [[0, 0.02], [0.25, 0.22], [0.5, 0.5], [0.75, 0.8], [1, 0.98]] as CurvePts,
                                    r: [[0, 0], [0.25, 0.27], [0.5, 0.54], [0.75, 0.79], [1, 1]] as CurvePts,
                                    b: [[0, 0.03], [0.25, 0.22], [0.5, 0.46], [0.75, 0.71], [1, 0.94]] as CurvePts,
                                  },
                                ],
                                [
                                  'Холодный циан',
                                  {
                                    master: [[0, 0], [0.25, 0.21], [0.5, 0.5], [0.75, 0.81], [1, 1]] as CurvePts,
                                    r: [[0, 0], [0.25, 0.21], [0.5, 0.46], [0.75, 0.72], [1, 0.95]] as CurvePts,
                                    b: [[0, 0.03], [0.25, 0.28], [0.5, 0.54], [0.75, 0.8], [1, 1]] as CurvePts,
                                  },
                                ],
                              ] as const).map(([name, preset]) => (
                                <button
                                  key={name}
                                  onClick={() => {
                                    pushHistory()
                                    updateSelectedFx((cur) => ({ ...cur, curves: preset }))
                                  }}
                                  className="rounded border border-border bg-[var(--surface-1)] px-2 py-0.5 text-[10px] text-zinc-300 hover:border-[#A78BFA] hover:text-white"
                                >
                                  {name}
                                </button>
                              ))}
                            </div>
                          </div>
                        )
                      })()}

                      {/* 2. ЦВЕТ И ТОН: ТЕМПЕРАТУРА, ОТТЕНОК (HUE), ЯРКОСТЬ, КОНТРАСТ, НАСЫЩЕННОСТЬ + ИНДИВИДУАЛЬНЫЙ БАЙПАС */}
                      <div className="space-y-2.5 rounded-lg border border-border bg-[var(--surface-2)] p-2.5">
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] font-medium text-zinc-200">Цвет и тон</span>
                          <button
                            onClick={() => {
                              pushHistory()
                              updateSelectedFx({
                                temp: undefined,
                                hue: undefined,
                                bright: undefined,
                                contrast: undefined,
                                sat: undefined,
                              })
                            }}
                            className="text-[10px] text-zinc-400 hover:text-[#A78BFA]"
                            title="Сбросить температуру, оттенок, яркость, контраст и насыщенность"
                          >
                            Сброс
                          </button>
                        </div>
                        {/* Температура (-100 .. +100) */}
                        <div className={cn('space-y-1', (isAllBypassed || isByp('temp')) && 'opacity-65')}>
                          <div className="flex items-center justify-between text-[11px]">
                            <div className="flex items-center gap-1.5">
                              {renderBypassBtn('temp', 'Температура')}
                              <span className="text-zinc-300" title="Цветовая температура: влево — холоднее (синий), вправо — теплее (янтарный)">
                                Температура
                              </span>
                            </div>
                            <button
                              onClick={() => { pushHistory(); updateSelectedFx({ temp: undefined }) }}
                              className="font-mono text-[#A78BFA] hover:underline"
                              title="Клик — сбросить в 0"
                            >
                              {Math.round(fxTarget.fx?.temp ?? 0) > 0 ? `+${Math.round(fxTarget.fx?.temp ?? 0)}` : `${Math.round(fxTarget.fx?.temp ?? 0)}`}
                            </button>
                          </div>
                          <input
                            type="range"
                            min={-100}
                            max={100}
                            step={1}
                            value={Math.round(fxTarget.fx?.temp ?? 0)}
                            onPointerDown={pushHistory}
                            onChange={(e) => {
                              const v = Number(e.target.value)
                              updateSelectedFx({ temp: Math.abs(v) < 1 ? undefined : v })
                            }}
                            className="h-1.5 w-full cursor-pointer accent-[#7C3AED]"
                          />
                        </div>
                        {/* Оттенок / HUE (-180° .. +180°) */}
                        <div className={cn('space-y-1', (isAllBypassed || isByp('hue')) && 'opacity-65')}>
                          <div className="flex items-center justify-between text-[11px]">
                            <div className="flex items-center gap-1.5">
                              {renderBypassBtn('hue', 'Оттенок (HUE)')}
                              <span className="text-zinc-300" title="Сдвиг цветового тона по кругу (HUE)">
                                Оттенок (HUE)
                              </span>
                            </div>
                            <button
                              onClick={() => { pushHistory(); updateSelectedFx({ hue: undefined }) }}
                              className="font-mono text-[#A78BFA] hover:underline"
                              title="Клик — сбросить в 0°"
                            >
                              {Math.round(fxTarget.fx?.hue ?? 0) > 0 ? `+${Math.round(fxTarget.fx?.hue ?? 0)}°` : `${Math.round(fxTarget.fx?.hue ?? 0)}°`}
                            </button>
                          </div>
                          <input
                            type="range"
                            min={-180}
                            max={180}
                            step={1}
                            value={Math.round(fxTarget.fx?.hue ?? 0)}
                            onPointerDown={pushHistory}
                            onChange={(e) => {
                              const v = Number(e.target.value)
                              updateSelectedFx({ hue: Math.abs(v) < 1 ? undefined : v })
                            }}
                            className="h-1.5 w-full cursor-pointer accent-[#7C3AED]"
                          />
                        </div>
                        {/* Яркость */}
                        <div className={cn('space-y-1', (isAllBypassed || isByp('bright')) && 'opacity-65')}>
                          <div className="flex items-center justify-between text-[11px]">
                            <div className="flex items-center gap-1.5">
                              {renderBypassBtn('bright', 'Яркость')}
                              <span className="text-zinc-300">Яркость</span>
                            </div>
                            <button
                              onClick={() => { pushHistory(); updateSelectedFx({ bright: undefined }) }}
                              className="font-mono text-[#A78BFA] hover:underline"
                              title="Клик — сбросить в 0"
                            >
                              {Math.round((fxTarget.fx?.bright ?? 0) * 100) > 0 ? `+${Math.round((fxTarget.fx?.bright ?? 0) * 100)}%` : `${Math.round((fxTarget.fx?.bright ?? 0) * 100)}%`}
                            </button>
                          </div>
                          <input
                            type="range"
                            min={-50}
                            max={50}
                            value={Math.round((fxTarget.fx?.bright ?? 0) * 100)}
                            onPointerDown={pushHistory}
                            onChange={(e) => {
                              const v = Number(e.target.value) / 100
                              updateSelectedFx({ bright: Math.abs(v) < 0.005 ? undefined : v })
                            }}
                            className="h-1.5 w-full cursor-pointer accent-[#7C3AED]"
                          />
                        </div>
                        {/* Контраст */}
                        <div className={cn('space-y-1', (isAllBypassed || isByp('contrast')) && 'opacity-65')}>
                          <div className="flex items-center justify-between text-[11px]">
                            <div className="flex items-center gap-1.5">
                              {renderBypassBtn('contrast', 'Контраст')}
                              <span className="text-zinc-300">Контраст</span>
                            </div>
                            <button
                              onClick={() => { pushHistory(); updateSelectedFx({ contrast: undefined }) }}
                              className="font-mono text-[#A78BFA] hover:underline"
                              title="Клик — сбросить в 0"
                            >
                              {Math.round((fxTarget.fx?.contrast ?? 0) * 100) > 0 ? `+${Math.round((fxTarget.fx?.contrast ?? 0) * 100)}%` : `${Math.round((fxTarget.fx?.contrast ?? 0) * 100)}%`}
                            </button>
                          </div>
                          <input
                            type="range"
                            min={-50}
                            max={50}
                            value={Math.round((fxTarget.fx?.contrast ?? 0) * 100)}
                            onPointerDown={pushHistory}
                            onChange={(e) => {
                              const v = Number(e.target.value) / 100
                              updateSelectedFx({ contrast: Math.abs(v) < 0.005 ? undefined : v })
                            }}
                            className="h-1.5 w-full cursor-pointer accent-[#7C3AED]"
                          />
                        </div>
                        {/* Насыщенность */}
                        <div className={cn('space-y-1', (isAllBypassed || isByp('sat')) && 'opacity-65')}>
                          <div className="flex items-center justify-between text-[11px]">
                            <div className="flex items-center gap-1.5">
                              {renderBypassBtn('sat', 'Насыщенность')}
                              <span className="text-zinc-300">Насыщенность</span>
                            </div>
                            <button
                              onClick={() => { pushHistory(); updateSelectedFx({ sat: undefined }) }}
                              className="font-mono text-[#A78BFA] hover:underline"
                              title="Клик — сбросить в 100%"
                            >
                              {Math.round((fxTarget.fx?.sat ?? 1) * 100)}%
                            </button>
                          </div>
                          <input
                            type="range"
                            min={0}
                            max={200}
                            value={Math.round((fxTarget.fx?.sat ?? 1) * 100)}
                            onPointerDown={pushHistory}
                            onChange={(e) => {
                              const sat = Number(e.target.value) / 100
                              updateSelectedFx({ sat: Math.abs(sat - 1) < 0.005 ? undefined : sat })
                            }}
                            className="h-1.5 w-full cursor-pointer accent-[#7C3AED]"
                          />
                        </div>
                      </div>

                      {/* 3. ОПТИКА И ПЛЁНКА: РАДИАЛЬНАЯ ДИСПЕРСИЯ + МАСКА ЦЕНТРА + КИНОШНЫЙ ШУМ */}
                      <div className="space-y-2.5 rounded-lg border border-border bg-[var(--surface-2)] p-2.5">
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] font-medium text-zinc-200">Оптика и плёнка</span>
                          <button
                            onClick={() => {
                              pushHistory()
                              updateSelectedFx({ dispersion: undefined, dispersionMask: undefined, grain: undefined })
                            }}
                            className="text-[10px] text-zinc-400 hover:text-[#A78BFA]"
                            title="Сбросить дисперсию, радиальную маску и киношный шум"
                          >
                            Сброс
                          </button>
                        </div>
                        {/* Дисперсия (радиальная: центр чистый, к краям нарастает) + радиальная маска центра */}
                        <div className={cn('space-y-2', (isAllBypassed || isByp('dispersion')) && 'opacity-65')}>
                          <div className="space-y-1">
                            <div className="flex items-center justify-between text-[11px]">
                              <div className="flex items-center gap-1.5">
                                {renderBypassBtn('dispersion', 'Дисперсия')}
                                <span className="text-zinc-300" title="Линзовая дисперсия как в DaVinci Resolve: центр кадра остаётся резким, а к краям и углам расходится спектр RGB">
                                  Дисперсия (к краям)
                                </span>
                              </div>
                              <button
                                onClick={() => { pushHistory(); updateSelectedFx({ dispersion: undefined }) }}
                                className="font-mono text-[#A78BFA] hover:underline"
                                title="Клик — выключить дисперсию"
                              >
                                {fxTarget.fx?.dispersion ?? 0} пикс
                              </button>
                            </div>
                            <input
                              type="range"
                              min={0}
                              max={20}
                              step={1}
                              value={fxTarget.fx?.dispersion ?? 0}
                              onPointerDown={pushHistory}
                              onChange={(e) => {
                                const v = Number(e.target.value)
                                updateSelectedFx({ dispersion: v <= 0 ? undefined : v })
                              }}
                              className="h-1.5 w-full cursor-pointer accent-[#7C3AED]"
                            />
                          </div>
                          {/* (правка 884) Радиальная маска центра для дисперсии (0..90%, по умолчанию 35%) */}
                          <div className="space-y-1 rounded border border-border/60 bg-black/25 p-2">
                            <div className="flex items-center justify-between text-[11px]">
                              <span
                                className="text-zinc-400"
                                title="Размер чистой зоны в центре кадра, не затронутой дисперсией (0% — от самого центра, 90% — только у самых углов)"
                              >
                                Радиальная маска центра
                              </span>
                              <button
                                onClick={() => { pushHistory(); updateSelectedFx({ dispersionMask: undefined }) }}
                                className="font-mono text-[#A78BFA] hover:underline"
                                title="Клик — сбросить маску центра в 35%"
                              >
                                {Math.round(fxTarget.fx?.dispersionMask ?? 35)}%
                              </button>
                            </div>
                            <input
                              type="range"
                              data-dispersion-mask="1"
                              min={0}
                              max={90}
                              step={1}
                              value={Math.round(fxTarget.fx?.dispersionMask ?? 35)}
                              onPointerDown={pushHistory}
                              onChange={(e) => {
                                const v = Number(e.target.value)
                                updateSelectedFx({ dispersionMask: Math.abs(v - 35) < 1 ? undefined : v })
                              }}
                              className="h-1.5 w-full cursor-pointer accent-[#7C3AED]"
                            />
                          </div>
                        </div>
                        {/* Киношный анимированный шум */}
                        <div className={cn('space-y-1', (isAllBypassed || isByp('grain')) && 'opacity-65')}>
                          <div className="flex items-center justify-between text-[11px]">
                            <div className="flex items-center gap-1.5">
                              {renderBypassBtn('grain', 'Киношный шум')}
                              <span className="text-zinc-300" title="Живое анимированное зерно 35mm плёнки (noise=allf=t+u)">
                                Киношный анимированный шум
                              </span>
                            </div>
                            <button
                              onClick={() => { pushHistory(); updateSelectedFx({ grain: undefined }) }}
                              className="font-mono text-[#A78BFA] hover:underline"
                              title="Клик — выключить шум"
                            >
                              {fxTarget.fx?.grain ?? 0}%
                            </button>
                          </div>
                          <input
                            type="range"
                            min={0}
                            max={100}
                            step={1}
                            value={fxTarget.fx?.grain ?? 0}
                            onPointerDown={pushHistory}
                            onChange={(e) => {
                              const v = Number(e.target.value)
                              updateSelectedFx({ grain: v <= 0 ? undefined : v })
                            }}
                            className="h-1.5 w-full cursor-pointer accent-[#7C3AED]"
                          />
                        </div>
                      </div>
                    </>
                  )
                })()}

                {/* 4. КОПИРОВАНИЕ ЭФФЕКТОВ НА ДРУГИЕ КЛИПЫ */}
                <div className="space-y-2 rounded-lg border border-border bg-[var(--surface-2)] p-2.5">
                  <div className="text-[11px] font-medium text-zinc-200">Перенос эффектов на другие клипы</div>
                  <div className="grid grid-cols-2 gap-1.5">
                    <button
                      onClick={() => {
                        setCopiedFx(cloneFx(fxTarget.fx))
                        showToast('Эффекты клипа скопированы в буфер')
                      }}
                      className="flex items-center justify-center gap-1 rounded border border-border bg-[var(--surface-1)] py-1.5 text-[11px] text-zinc-200 hover:border-[#A78BFA]"
                    >
                      <CopyIcon className="h-3 w-3" />
                      Скопировать
                    </button>
                    <button
                      disabled={!copiedFx}
                      onClick={() => {
                        if (!copiedFx) return
                        applyFxToTargets(copiedFx, [fxTarget.key], `Эффекты вставлены в «${fxTarget.name}»`)
                      }}
                      className="rounded border border-border bg-[var(--surface-1)] py-1.5 text-[11px] text-zinc-200 hover:border-[#A78BFA] disabled:opacity-40"
                    >
                      Вставить сюда
                    </button>
                  </div>
                  {shots.length + layers.length > 1 && (
                    <button
                      onClick={() =>
                        applyFxToTargets(
                          fxTarget.fx,
                          [
                            ...shots.filter((s) => s.key !== fxTarget.key).map((s) => s.key),
                            // (правка 876) «на все клипы» теперь захватывает и слои V2+
                            ...layers.filter((l) => l.key !== fxTarget.key).map((l) => l.key),
                          ],
                          `Эффекты применены ко всем клипам и слоям (${shots.length + layers.length})`,
                        )
                      }
                      className="w-full rounded bg-[#7C3AED] py-1.5 text-[11px] font-medium text-white hover:bg-[#6D28D9]"
                    >
                      Скопировать на все клипы и слои ({shots.length + layers.length - 1})
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </aside>

      {/* (правка 720 v11) подсказка новой длительности при тяге за край клипа */}
      {trimBadge && (
        <div
          className="pointer-events-none fixed z-[10000] rounded border border-[#A78BFA] bg-black/80 px-1.5 py-0.5 font-mono text-[11px] text-white"
          style={{ left: trimBadge.x + 14, top: trimBadge.y + 14 }}
        >
          {trimBadge.text}
        </div>
      )}
    </div>
  )
}

function inFolder(subfolder: string, folder: string): boolean {
  if (folder === '') return subfolder === ''
  return subfolder === folder || subfolder.startsWith(folder + '/')
}
