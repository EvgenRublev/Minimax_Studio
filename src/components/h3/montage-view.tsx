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
  FilmIcon,
  FrameIcon,
  LinkIcon,
  MagnetIcon,
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

/** (правка 849, 859, 861) картинные эффекты шота (совпадают с полем fx в /api/montage/render) */
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
  /** (правка 859) киношный анимированный шум (зерно 35mm), 0..100% */
  grain?: number
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
}

const DEFAULT_SEQ: SeqSettings = { w: 0, h: 0, fps: 0, fit: 'stretch', quality: 'standard' }

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

const MAX_SHOTS = 60

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

/** (правка 859, 861) глубокое клонирование объекта эффектов для копирования между клипами */
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
    grain: fx.grain,
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

/** (правка 858, 859, 861) CSS-представление эффектов шота для мгновенного превью в плеере */
function shotFxCss(fx: ShotFx | undefined, svgFilterId?: string): { filter?: string; scaleX: number; scaleY: number } {
  if (!fx) return { scaleX: 1, scaleY: 1 }
  const filters: string[] = []
  if (
    svgFilterId &&
    (hasCurves(fx.curves) || (fx.dispersion && fx.dispersion > 0) || (fx.temp && Math.abs(fx.temp) >= 1))
  ) {
    filters.push(`url(#${svgFilterId})`)
  }
  if (fx.hue && Math.abs(fx.hue) >= 1) filters.push(`hue-rotate(${fx.hue.toFixed(0)}deg)`)
  if (fx.bright) filters.push(`brightness(${Math.max(0.2, 1 + fx.bright).toFixed(2)})`)
  if (fx.contrast) filters.push(`contrast(${Math.max(0.2, 1 + fx.contrast).toFixed(2)})`)
  if (fx.sat !== undefined && fx.sat !== 1) filters.push(`saturate(${Math.max(0, fx.sat).toFixed(2)})`)
  return {
    filter: filters.length ? filters.join(' ') : undefined,
    scaleX: fx.flipH ? -1 : 1,
    scaleY: fx.flipV ? -1 : 1,
  }
}

/**
 * (правка 861) Генерирует карту радиальной линзовой дисперсии 256×256 (как в DaVinci Resolve):
 * - В центре кадра (радиус <= 32%) R=128, G=128, Alpha=0 -> центр НЕ задействуется вообще (100% чистый)!
 * - От центра к краям и углам R и G кодируют радиальный вектор от центра наружу, а Alpha плавно
 *   растёт от 0 до 255 — дисперсия плавно проявляется к краям и углам кадра.
 */
function createRadialDispMapDataUrl(): string {
  try {
    const size = 256
    const c = document.createElement('canvas')
    c.width = size
    c.height = size
    const ctx = c.getContext('2d')
    if (!ctx) return ''
    const img = ctx.createImageData(size, size)
    const d = img.data
    for (let y = 0; y < size; y++) {
      const ny = (y / (size - 1)) * 2 - 1 // -1..1
      for (let x = 0; x < size; x++) {
        const nx = (x / (size - 1)) * 2 - 1 // -1..1
        const r = Math.hypot(nx, ny) // 0 в центре, 1 у краёв, ~1.41 в углах
        // в радиусе 0..0.4 вес строго 0 (центр чистый), дальше плавный подъём к краям
        const t = Math.max(0, Math.min(1, (r - 0.4) / 0.75))
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
    return c.toDataURL('image/png')
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
const stripKey = (url: string, r: { start: number; end: number }, w: number, h: number) =>
  // (правка 854) размер блока в ключе: ячейки снимаются в пропорции видео под
  // конкретный блок, при зуме/высоте дорожки полоса переснимается.
  `${url}|${r.start.toFixed(2)}|${r.end.toFixed(2)}|${Math.round(w / 8) * 8}x${Math.round(h / 4) * 4}`

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
  /** превью развернуто на весь экран */
  const [isFs, setIsFs] = useState(false)
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
  const dragRef = useRef<{ kind: 'gallery'; file: VideoGalleryFile } | { kind: 'move'; key: string } | null>(null)
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
  /** (правка 720 v11) история таймлайна для Ctrl+Z / Ctrl+Shift+Z */
  const undoRef = useRef<MontageShot[][]>([])
  const redoRef = useRef<MontageShot[][]>([])
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

  // зеркала для rAF/клавиатурных обработчиков, чтобы не зависеть от замыканий
  const seqRef = useRef<SeqRow[]>([])
  useEffect(() => { seqRef.current = seq }, [seq])
  useEffect(() => { ppsRef.current = pps }, [pps])
  useEffect(() => { seqTRef.current = playT }, [playT])
  useEffect(() => { trackHRef.current = trackH }, [trackH])
  useEffect(() => { shotsRef.current = shots }, [shots])
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
      })
    }
    hydrated.current = true
  }, [])

  // (правка 720 v9, 858) пишем параметры с коротким дебаунсом (и синхронно при
  // уходе со вкладки), чтобы во время трима/зума/скраба не блокировать главный поток
  useEffect(() => {
    if (!hydrated.current) return
    const payload: MontageSaved = {
      shots, selectedKey, folderFilter, pps, loop, trackH, vScale, masterVol, muted, snap, loopClip, seq: seqSet,
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
  }, [shots, selectedKey, folderFilter, pps, loop, trackH, vScale, masterVol, muted, snap, loopClip, seqSet])

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
  }, [shots])

  // (правка 843) в сохранённом таймлайне могут остаться ссылки на УДАЛЁННЫЕ файлы
  // галереи (url больше не отдаётся, превью и рендер битые). Когда галерея
  // отрендерилась непустым списком — снимаем с таймлайна то, чего в ней нет.
  useEffect(() => {
    if (loading || files.length === 0 || !hydrated.current) return
    const aliveKey = (s: { subfolder?: string; filename: string }) => `${s.subfolder || ''}|${s.filename}`
    const alive = new Set(files.map((f) => aliveKey(f)))
    const gone = shotsRef.current.filter((s) => !alive.has(aliveKey(s))).length
    if (!gone) return
    setShots((prev) => {
      const next = prev.filter((s) => alive.has(aliveKey(s)))
      return next.length === prev.length ? prev : next
    })
    const cur = selectedKey ? shotsRef.current.find((x) => x.key === selectedKey) : null
    if (cur && !alive.has(aliveKey(cur))) setSelectedKey(null)
    showToast(`С таймлайна убрано удалённых файлов: ${gone}`, 'error')
  }, [files, loading, selectedKey])

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
      const tot = total ?? (seqRef.current.length ? seqRef.current[seqRef.current.length - 1].offset + seqRef.current[seqRef.current.length - 1].len : 0)
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
    if (!sq.length) return
    setResult(null)
    const start = seqTRef.current >= totalSec - 0.05 ? 0 : seqTRef.current
    const loc = findAtTime(start)
    syncPlayheadDOM(start, totalSec)
    setPlayT(start)
    setPlaying(true)
    playingRef.current = true
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
    if (!sq.length) return
    const total = sq[sq.length - 1].offset + sq[sq.length - 1].len
    let ct = Math.max(0, Math.min(total, t))
    // (правка 720 v11) магнит: рядом с границей клипа плейхед прилипает к ней
    if (snapRef.current) {
      const tol = Math.min(0.15, 7 / Math.max(8, ppsRef.current))
      for (const r of sq) {
        if (Math.abs(ct - r.offset) <= tol) { ct = r.offset; break }
        if (Math.abs(ct - (r.offset + r.len)) <= tol) { ct = Math.min(total, r.offset + r.len); break }
      }
    }
    // (правка 858) мгновенно двигаем плейхед и таймкод в DOM без ожидания React
    syncPlayheadDOM(ct, total)
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
    const loc = findAtTime(ct)
    if (loc.inGap) {
      if (playingRef.current) {
        startGapPlay(ct, sq[loc.idx].offset, loc.idx)
      } else {
        gapPlayRef.current = null
        idxRef.current = -1
        for (const v of [previewARef.current, previewBRef.current]) if (v) v.pause()
        if (!inGapRef.current) {
          inGapRef.current = true
          setInGap(true)
        }
        const nrow = sq[loc.idx]
        if (nrow) {
          setPreviewSrc(nrow.shot.url)
          stageClip(bufRef.current === 0 ? 1 : 0, loc.idx, nrow.r.start)
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
    undoRef.current.push(shotsRef.current.map((s) => ({ ...s })))
    if (undoRef.current.length > 50) undoRef.current.shift()
    redoRef.current = []
    setHistTick((v) => v + 1)
  }, [])

  const undo = useCallback(() => {
    const prev = undoRef.current.pop()
    if (!prev) return
    redoRef.current.push(shotsRef.current.map((s) => ({ ...s })))
    setHistTick((v) => v + 1)
    stopSeq(false)
    setResult(null)
    setShots(prev)
    setSelectedKey((cur) => (cur && prev.some((s) => s.key === cur) ? cur : null))
  }, [stopSeq])

  const redo = useCallback(() => {
    const next = redoRef.current.pop()
    if (!next) return
    undoRef.current.push(shotsRef.current.map((s) => ({ ...s })))
    setHistTick((v) => v + 1)
    stopSeq(false)
    setResult(null)
    setShots(next)
    setSelectedKey((cur) => (cur && next.some((s) => s.key === cur) ? cur : null))
  }, [stopSeq])

  /** тянем границу между превью и таймлайном — меняем высоту дорожки */
  const startTlResize = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    suppressDrag.current = true
    const startY = e.clientY
    const startH = trackHRef.current
    const onMove = (ev: PointerEvent) => {
      setTrackH(Math.max(40, Math.min(480, startH + (startY - ev.clientY))))
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
      const tot = sq.length ? sq[sq.length - 1].offset + sq[sq.length - 1].len : 0
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
          const sb = bufRef.current === 0 ? 1 : 0
          const sel = bufEl(sb)
          const stg = stageSeekRef.current
          if (stg && stg.idx === ni && sel && sel.readyState >= 2) swapTo(sb)
          else if (sq[ni]) showClip(ni, sq[ni].r.start, true)
          else stopSeq(false)
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
          if (loop) {
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
      w: Math.max(16, row.len * pps),
      h: Math.max(24, trackH),
    }),
    [pps, trackH],
  )
  useEffect(() => {
    if (playing) return
    // (правка 841) чистим полосы ушедших шотов/подрезок: без этого кэш dataURL
    // растёт всю жизнь вкладки (единицы МБ на каждые 60 клипов с правками)
    const live = new Set(seq.map((row) => {
      const { w, h } = stripDims(row)
      return stripKey(row.shot.url, row.r, w, h)
    }))
    setStrips((prev) => {
      const keys = Object.keys(prev)
      if (!keys.some((k) => !live.has(k))) return prev
      const next: Record<string, string> = {}
      for (const k of keys) if (live.has(k)) next[k] = prev[k]
      return next
    })
    const need = seq.filter((row) => {
      const { w, h } = stripDims(row)
      const k = stripKey(row.shot.url, row.r, w, h)
      return !strips[k] && !stripBusy.current.has(k)
    })
    if (!need.length) return
    const timer = setTimeout(() => {
      if (playingRef.current || scrubbingRef.current || suppressDrag.current) return
      const row = need[0]
      const { w, h } = stripDims(row)
      const k = stripKey(row.shot.url, row.r, w, h)
      if (stripBusy.current.has(k)) return
      stripBusy.current.add(k)
      makeStrip(row.shot.url, row.r, w, h).then((data) => {
        stripBusy.current.delete(k)
        // (правка 842) вкладка могла закрыться/шот удалиться, пока полоса строилась
        if (!mountedRef.current || !live.has(k)) return
        if (data) lastStripByShotRef.current[row.shot.key] = data
        setStrips((prev) => ({ ...prev, [k]: data ?? '' }))
      })
    }, 240)
    return () => clearTimeout(timer)
  }, [seq, strips, stripDims, playing])

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
  const splitAtPlayhead = useCallback(() => {
    const sq = seqRef.current
    if (!sq.length) return
    stopSeq(false)
    const t = seqTRef.current
    const loc = findAtTime(t)
    if (loc.inGap) {
      showToast('Поставьте плейхед внутрь клипа (не в пустой промежуток)', 'error')
      return
    }
    const row = sq[loc.idx]
    if (!row) return
    // (правка 858) учитываем скорость шота при переводе времени сборки в исходник
    const local = row.r.start + (t - row.offset) * shotSpeed(row.shot)
    if (local <= row.r.start + 0.05 || local >= row.r.end - 0.05) {
      showToast('Поставьте плейхед внутрь клипа (не на его край)', 'error')
      return
    }
    if (shotsRef.current.length >= MAX_SHOTS) {
      showToast('Максимум 60 шотов на таймлайне', 'error')
      return
    }
    pushHistory()
    const cut = local.toFixed(2)
    const left: MontageShot = { ...row.shot, trimEnd: cut }
    // (правка 860) правая половинка идёт встык за левой (gap: 0)
    const right: MontageShot = { ...row.shot, key: newShotKey(), trimStart: cut, trimEnd: row.shot.trimEnd, gap: 0 }
    setShots((prev) => {
      const idx = prev.findIndex((s) => s.key === row.shot.key)
      if (idx < 0) return prev
      const next = [...prev]
      next.splice(idx, 1, left, right)
      return next
    })
    setSelectedKey(right.key)
  }, [stopSeq, pushHistory])

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
    setSelectedKey(copy.key)
    setResult(null)
  }, [stopSeq, pushHistory])

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

  /**
   * Превью на весь экран (F). (правка 720 v11) В кадре окна с невидимым
   * заголовком (titleBarStyle hidden) нативный requestFullscreen в Electron
   * срабатывает через раз, поэтому полный экран делаем CSS-оверлеем на весь
   * вьюпорт (тот же прием, что в video-lightbox).
   */
  const toggleFullscreen = useCallback(() => {
    setIsFs((v) => !v)
  }, [])

  // (правка 859) обновление эффектов выбранного клипа и копирование между клипами
  const updateSelectedFx = useCallback((patch: Partial<ShotFx> | ((prev: ShotFx) => ShotFx)) => {
    setShots((prev) =>
      prev.map((x) => {
        if (x.key !== selectedKey) return x
        const cur = x.fx || {}
        const nextFx = typeof patch === 'function' ? patch(cur) : { ...cur, ...patch }
        return { ...x, fx: nextFx }
      }),
    )
  }, [selectedKey])

  const resetSelectedFx = useCallback(() => {
    if (!selectedKey) return
    pushHistory()
    setShots((prev) => prev.map((x) => (x.key === selectedKey ? { ...x, fx: undefined } : x)))
    showToast('Эффекты клипа сброшены')
  }, [selectedKey, pushHistory])

  const applyFxToTargets = useCallback((sourceFx: ShotFx | undefined, targetKeys: string[], label: string) => {
    if (!targetKeys.length) return
    pushHistory()
    const targetSet = new Set(targetKeys)
    setShots((prev) =>
      prev.map((x) => (targetSet.has(x.key) ? { ...x, fx: hasFx(sourceFx) ? cloneFx(sourceFx) : undefined } : x)),
    )
    showToast(label)
  }, [pushHistory])

  // (правка 859) анимированный киношный шум в превью: 24 кадра/с сдвигает тайл зерна
  const activePreviewKey = !result ? (previewVolKeyRef.current ?? bufShotKeyRef.current[buf] ?? selectedKey) : null
  const activePreviewShot = activePreviewKey ? shots.find((s) => s.key === activePreviewKey) ?? selected : selected
  const activeGrain = !result ? (activePreviewShot?.fx?.grain ?? 0) : 0
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
        if (selectedKey) {
          e.preventDefault()
          removeShot(selectedKey)
        }
      } else if (['s', 'S', 'ы', 'Ы'].includes(e.key)) {
        e.preventDefault()
        splitAtPlayhead()
      } else if (['d', 'D', 'в', 'В'].includes(e.key)) {
        if (selectedKey) {
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
  }, [togglePlay, scrubBy, selectedKey, removeShot, splitAtPlayhead, duplicateShot, toggleFullscreen, moveShot, undo, redo, isFs, seqSet.fps])

  const setTrim = useCallback((key: string, side: 'start' | 'end', value: number, dur: number) => {
    setShots((prev) =>
      prev.map((s) => {
        if (s.key !== key) return s
        const r = effRange(s)
        if (side === 'start') {
          const st = Math.max(0, Math.min(value, (dur || r.end) - 0.1))
          return { ...s, trimStart: st <= 0 ? '' : st.toFixed(2) }
        }
        const en = Math.min(value, dur || Number.POSITIVE_INFINITY)
        return { ...s, trimEnd: dur && en >= dur - 0.01 ? '' : Math.max(r.start + 0.1, en).toFixed(2) }
      }),
    )
  }, [])

  const runRender = useCallback(async () => {
    // (правка 864) собирать можно и один шот: пустой таймлайн — единственное
    // условие отказа (раньше требовалось минимум два)
    if (!shots.length || rendering) return
    // (правка 720 v11) правки в полях свойств не имеют своей точки снимка —
    // сохраняем перед ними историю на ходу (кнопка «Собрать» нажимается редко)
    // (правка 844) снимок кладём руками и при НЕудачной сборке снимаем его:
    // иначе после любой ошибки Ctrl+Z «срабатывает вхолостую»
    const histSnap = shotsRef.current.map((s) => ({ ...s }))
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
    if (!d) return
    if (d.kind === 'gallery') {
      addShot(d.file, idx)
      return
    }
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
  }, [addShot, computeDropIdx, pushHistory])

  /** тяга за край блока — подрезка в секундах (+ подсказка новой длительности и живой кадр в превью) */
  const startTrimDrag = useCallback(
    (e: React.PointerEvent, shot: MontageShot, side: 'start' | 'end') => {
      e.preventDefault()
      e.stopPropagation()
      stopSeq(false)
      setResult(null)
      setSelectedKey(shot.key)
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
    [pps, setTrim, stopSeq, pushHistory, seekBufferTo],
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
      let moved = false
      let dragRaf = 0
      let latestX = startX

      const applyMove = (clientX: number) => {
        const curPps = Math.max(8, ppsRef.current)
        const dt = (clientX - startX) / curPps
        let wantStart = Math.max(0, dragItem.offset + dt)
        if (snapRef.current) {
          const tol = Math.min(0.18, 8 / curPps)
          const snapPts: number[] = [0, seqTRef.current, Math.max(0, seqTRef.current - dragItem.len)]
          for (const o of others) {
            snapPts.push(o.offset + o.len)
            if (o.offset - dragItem.len >= 0) snapPts.push(o.offset - dragItem.len)
          }
          for (const sp of snapPts) {
            if (Math.abs(wantStart - sp) <= tol) {
              wantStart = sp
              break
            }
          }
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
          y: e.clientY,
          text: `${actualDragStart.toFixed(2)} с${actualDragGap >= 0.02 ? ` (пауза +${actualDragGap.toFixed(2)} с)` : ' (встык)'}`,
        })
      }

      const onMove = (ev: PointerEvent) => {
        latestX = ev.clientX
        if (!moved) {
          if (Math.abs(ev.clientX - startX) < 3) return
          moved = true
          suppressDrag.current = true
          stopSeq(false)
          setResult(null)
          setSelectedKey(row.shot.key)
          pushHistory()
        }
        if (!dragRaf) {
          dragRaf = requestAnimationFrame(() => {
            dragRaf = 0
            applyMove(latestX)
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
          applyMove(ev.clientX)
          setTimeout(() => { suppressDrag.current = false }, 0)
        } else {
          // обычный клик без перетаскивания: выбираем клип и переносим плейхед в точку клика
          setSelectedKey(row.shot.key)
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
    [stopSeq, pushHistory, seekTo],
  )

  /** (правка 720 v11) вписать всю сборку в видимую ширину таймлайна */
  const fitZoom = useCallback(() => {
    const el = scrollerRef.current
    if (!el || totalSec <= 0) return
    const w = el.clientWidth - 20
    if (w <= 0) return
    setPps(Math.max(8, Math.min(240, Math.floor(w / totalSec))))
  }, [totalSec])

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
      if (!shotsRef.current.some((s) => s.key === key)) {
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
      useMontageReturn.getState().drop(key)
      useMontageReturn.getState().dropArrival(a.filename)
      // реальная длительность чистовика (у Refine она может отличаться на доли
      // секунды от драфта) — блок перестроится по ней
      getVideoDuration(f.url).then((d) => {
        if (d > 0 && mountedRef.current) {
          setShots((cur) => cur.map((x) => (x.key === key ? { ...x, duration: d } : x)))
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

  // деления линейки
  const rulerStep = totalSec > 0 ? pickStep(totalSec, pps) : 1
  const rulerTicks: number[] = []
  // (правка 720 v10) шаг через индекс: накопление "+0.1" в float уезжало
  // (метки вида 0.30000000000000004, лишний последний штрих)
  if (totalSec > 0) for (let i = 0; i * rulerStep <= totalSec + 0.001; i++) rulerTicks.push(+(i * rulerStep).toFixed(3))

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
            {shots.length} шот{shots.length === 1 ? '' : 'ов'} · ≈ {totalSec.toFixed(1)} с
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
        <div className={cn('relative min-h-0 flex-1 overflow-hidden bg-black', isFs && 'fixed inset-0 z-[9999]')}>
          {/* (правка 859, 861) живые SVG-фильтры для каждого буфера: 5-точечные кривые цвета RGB,
              температура и радиальная дисперсия (центр кадра чистый, к краям нарастает) */}
          <svg width="0" height="0" className="pointer-events-none absolute opacity-0" aria-hidden>
            <defs>
              {[0, 1].map((b) => {
                const bKey = buf === b ? (previewVolKeyRef.current ?? bufShotKeyRef.current[b] ?? selectedKey) : bufShotKeyRef.current[b]
                const bShot = !result && bKey ? shots.find((s) => s.key === bKey) : null
                const fx = bShot?.fx
                const c = fx?.curves
                const temp = fx?.temp && Math.abs(fx.temp) >= 1 ? fx.temp / 380 : 0
                const disp = fx?.dispersion && fx.dispersion > 0 ? fx.dispersion : 0
                const rTab = buildChannelTable(c?.master, c?.r, temp)
                const gTab = buildChannelTable(c?.master, c?.g, temp * 0.18)
                const bTab = buildChannelTable(c?.master, c?.b, -temp)
                return (
                  <filter key={b} id={`h3-fx-buf-${b}`} colorInterpolationFilters="sRGB" x="-2%" y="-2%" width="104%" height="104%">
                    <feComponentTransfer in="SourceGraphic" result="curved">
                      <feFuncR type="table" tableValues={rTab} />
                      <feFuncG type="table" tableValues={gTab} />
                      <feFuncB type="table" tableValues={bTab} />
                    </feComponentTransfer>
                    {disp > 0 && radialDispMap && (
                      <>
                        <feImage href={radialDispMap} x="0%" y="0%" width="100%" height="100%" preserveAspectRatio="none" result="dispMap" />
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
              })}
            </defs>
          </svg>
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
                  maxWidth: '100%',
                  maxHeight: `${Math.round(vScale * 100)}%`,
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
                  if (i >= 0 && i + 1 < sq.length) showClip(i + 1, sq[i + 1].r.start, true)
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
          {/* (правка 859) анимированный киношный шум (зерно 35mm, 24 к/с) поверх кадра превью */}
          {previewSrc && !inGap && activeGrain > 0 && grainTile && (
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
              }}
            />
          )}
          {!previewSrc && (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 text-zinc-500">
              <FilmIcon className="h-10 w-10 opacity-40" />
              <div className="text-sm">
                {shots.length
                  ? 'Выберите клип на таймлайне или нажмите «Играть»'
                  : 'Перетащите видео из галереи на таймлайн снизу'}
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
          {/* слева: история, разрез, магнит, очистка таймлайна */}
          <div className="flex items-center gap-1.5">
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
              disabled={!shots.length || !seq.length}
              title="Разрезать клип на плейхеде (S)"
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
            {shots.length > 0 && (
              <button
                className="rounded border border-border px-2 py-1 text-xs text-zinc-400 hover:border-red-500/50 hover:text-red-300"
                onClick={() => { pushHistory(); stopSeq(false); setShots([]); setSelectedKey(null); setResult(null) }}
                title="Очистить весь таймлайн"
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
              disabled={!shots.length}
              title="В начало"
            >
              <SkipBackIcon className="h-3.5 w-3.5" />
            </button>
            <button
              className="rounded-md bg-[#7C3AED] px-2.5 py-1.5 text-white hover:bg-[#6D28D9] disabled:cursor-not-allowed disabled:opacity-50"
              onClick={togglePlay}
              disabled={!shots.length}
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
            <span ref={timecodeRef} className="font-mono text-xs text-zinc-400">{fmtT(playT)} / {fmtT(totalSec)}</span>
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

        {/* таймлайн: линейка + дорожка + плейхед */}
        <div
          ref={scrollerRef}
          className="shrink-0 overflow-x-auto overflow-y-hidden border-t border-border bg-[var(--surface-1)] px-2 py-2"
          onDragOver={(e) => {
            if (!dragRef.current) return
            e.preventDefault()
            e.dataTransfer.dropEffect = dragRef.current.kind === 'gallery' ? 'copy' : 'move'
            setDropIdx(computeDropIdx(e.clientX))
          }}
          onDragLeave={() => setDropIdx(null)}
          onDrop={onTimelineDrop}
        >
          <div className="relative" style={{ width: `${Math.max(400, (totalSec + 5) * pps)}px` }}>
            {/* линейка времени */}
            <div
              className="relative h-6 cursor-pointer select-none"
              onPointerDown={startScrub}
              title="Клик или тяните — перемотка"
              style={totalSec > 0 ? {
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
            {/* дорожка с клипами (правка 860: клипы позиционируются по offset и двигаются свободно с паузами gap) */}
            <div
              ref={trackRef}
              className="relative overflow-hidden rounded border border-border/50 bg-black/30"
              style={{
                height: trackH,
                backgroundImage:
                  seq.length > 0
                    ? 'repeating-linear-gradient(-45deg, rgba(255,255,255,0.025) 0 6px, transparent 6px 12px)'
                    : undefined,
              }}
              onPointerDown={(e) => {
                if ((e.target as HTMLElement | null) === e.currentTarget) startScrub(e)
              }}
            >
              {seq.length === 0 && (
                <div
                  className="flex w-full items-center justify-center rounded border border-dashed border-border text-xs text-zinc-500"
                  style={{ height: trackH }}
                >
                  Перетащите видео из галереи на эту дорожку
                </div>
              )}
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
                    left: `${dropIdx < seq.length ? seq[dropIdx].offset * pps : totalSec * pps}px`,
                  }}
                />
              )}
            </div>
            {/* плейхед: линия + ромб-головка (тяните — перемотка) */}
            {seq.length > 0 && (
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
              {id === 'fx' && selected && hasFx(selected.fx) && (
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

        {/* ВКЛАДКА 2: СВОЙСТВА КЛИПА */}
        {rightTab === 'props' && (
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 text-xs">
            {!selected ? (
              <div className="rounded-lg border border-dashed border-border p-4 text-center text-zinc-500">
                <div>Кликните по клипу на таймлайне, чтобы настроить его свойства</div>
                {shots.length > 0 && (
                  <button
                    onClick={() => setSelectedKey(shots[0].key)}
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
            {!selected ? (
              <div className="rounded-lg border border-dashed border-border p-4 text-center text-zinc-500">
                <div>Выберите клип на таймлайне, чтобы настроить его эффекты</div>
                {shots.length > 0 && (
                  <button
                    onClick={() => setSelectedKey(shots[0].key)}
                    className="mt-2 rounded border border-border bg-[var(--surface-2)] px-2.5 py-1 text-zinc-300 hover:border-[#A78BFA]"
                  >
                    Выбрать 1-й клип
                  </button>
                )}
              </div>
            ) : (
              <>
                {/* шапка выбранного клипа + сброс */}
                <div className="flex items-center justify-between rounded-lg border border-border bg-[var(--surface-2)] px-2.5 py-2">
                  <div className="min-w-0">
                    <div className="truncate font-medium text-zinc-100">{selected.name}</div>
                    <div className="text-[10px] text-zinc-400">
                      {hasFx(selected.fx) ? 'Эффекты активны (видны в превью и рендере)' : 'Без эффектов'}
                    </div>
                  </div>
                  {hasFx(selected.fx) && (
                    <button
                      onClick={resetSelectedFx}
                      className="shrink-0 rounded border border-border bg-[var(--surface-1)] px-2 py-1 text-[11px] text-zinc-300 hover:border-red-500/50 hover:text-red-300"
                    >
                      Сбросить
                    </button>
                  )}
                </div>

                {/* 1. КРИВЫЕ ЦВЕТА (RGB Curves, правка 861: 5 узлов [x,y] с 2D-перетаскиванием как в DaVinci Resolve) */}
                {(() => {
                  const curCurves = selected.fx?.curves || {}
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
                    <div className="space-y-2 rounded-lg border border-border bg-[var(--surface-2)] p-2.5">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-medium text-zinc-200">Кривые цвета (5 точек)</span>
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

                {/* 2. ЦВЕТ И ТОН: ТЕМПЕРАТУРА, ОТТЕНОК (HUE), ЯРКОСТЬ, КОНТРАСТ, НАСЫЩЕННОСТЬ + КНОПКА СБРОСА */}
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
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-zinc-400" title="Цветовая температура: влево — холоднее (синий), вправо — теплее (янтарный)">
                        Температура
                      </span>
                      <button
                        onClick={() => { pushHistory(); updateSelectedFx({ temp: undefined }) }}
                        className="font-mono text-[#A78BFA] hover:underline"
                        title="Клик — сбросить в 0"
                      >
                        {Math.round(selected.fx?.temp ?? 0) > 0 ? `+${Math.round(selected.fx?.temp ?? 0)}` : `${Math.round(selected.fx?.temp ?? 0)}`}
                      </button>
                    </div>
                    <input
                      type="range"
                      min={-100}
                      max={100}
                      step={1}
                      value={Math.round(selected.fx?.temp ?? 0)}
                      onPointerDown={pushHistory}
                      onChange={(e) => {
                        const v = Number(e.target.value)
                        updateSelectedFx({ temp: Math.abs(v) < 1 ? undefined : v })
                      }}
                      className="h-1.5 w-full cursor-pointer accent-[#7C3AED]"
                    />
                  </div>
                  {/* Оттенок / HUE (-180° .. +180°) */}
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-zinc-400" title="Сдвиг цветового тона по кругу (HUE)">
                        Оттенок (HUE)
                      </span>
                      <button
                        onClick={() => { pushHistory(); updateSelectedFx({ hue: undefined }) }}
                        className="font-mono text-[#A78BFA] hover:underline"
                        title="Клик — сбросить в 0°"
                      >
                        {Math.round(selected.fx?.hue ?? 0) > 0 ? `+${Math.round(selected.fx?.hue ?? 0)}°` : `${Math.round(selected.fx?.hue ?? 0)}°`}
                      </button>
                    </div>
                    <input
                      type="range"
                      min={-180}
                      max={180}
                      step={1}
                      value={Math.round(selected.fx?.hue ?? 0)}
                      onPointerDown={pushHistory}
                      onChange={(e) => {
                        const v = Number(e.target.value)
                        updateSelectedFx({ hue: Math.abs(v) < 1 ? undefined : v })
                      }}
                      className="h-1.5 w-full cursor-pointer accent-[#7C3AED]"
                    />
                  </div>
                  {/* Яркость */}
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-zinc-400">Яркость</span>
                      <button
                        onClick={() => { pushHistory(); updateSelectedFx({ bright: undefined }) }}
                        className="font-mono text-[#A78BFA] hover:underline"
                        title="Клик — сбросить в 0"
                      >
                        {Math.round((selected.fx?.bright ?? 0) * 100) > 0 ? `+${Math.round((selected.fx?.bright ?? 0) * 100)}%` : `${Math.round((selected.fx?.bright ?? 0) * 100)}%`}
                      </button>
                    </div>
                    <input
                      type="range"
                      min={-50}
                      max={50}
                      value={Math.round((selected.fx?.bright ?? 0) * 100)}
                      onPointerDown={pushHistory}
                      onChange={(e) => {
                        const v = Number(e.target.value) / 100
                        updateSelectedFx({ bright: Math.abs(v) < 0.005 ? undefined : v })
                      }}
                      className="h-1.5 w-full cursor-pointer accent-[#7C3AED]"
                    />
                  </div>
                  {/* Контраст */}
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-zinc-400">Контраст</span>
                      <button
                        onClick={() => { pushHistory(); updateSelectedFx({ contrast: undefined }) }}
                        className="font-mono text-[#A78BFA] hover:underline"
                        title="Клик — сбросить в 0"
                      >
                        {Math.round((selected.fx?.contrast ?? 0) * 100) > 0 ? `+${Math.round((selected.fx?.contrast ?? 0) * 100)}%` : `${Math.round((selected.fx?.contrast ?? 0) * 100)}%`}
                      </button>
                    </div>
                    <input
                      type="range"
                      min={-50}
                      max={50}
                      value={Math.round((selected.fx?.contrast ?? 0) * 100)}
                      onPointerDown={pushHistory}
                      onChange={(e) => {
                        const v = Number(e.target.value) / 100
                        updateSelectedFx({ contrast: Math.abs(v) < 0.005 ? undefined : v })
                      }}
                      className="h-1.5 w-full cursor-pointer accent-[#7C3AED]"
                    />
                  </div>
                  {/* Насыщенность */}
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-zinc-400">Насыщенность</span>
                      <button
                        onClick={() => { pushHistory(); updateSelectedFx({ sat: undefined }) }}
                        className="font-mono text-[#A78BFA] hover:underline"
                        title="Клик — сбросить в 100%"
                      >
                        {Math.round((selected.fx?.sat ?? 1) * 100)}%
                      </button>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={200}
                      value={Math.round((selected.fx?.sat ?? 1) * 100)}
                      onPointerDown={pushHistory}
                      onChange={(e) => {
                        const sat = Number(e.target.value) / 100
                        updateSelectedFx({ sat: Math.abs(sat - 1) < 0.005 ? undefined : sat })
                      }}
                      className="h-1.5 w-full cursor-pointer accent-[#7C3AED]"
                    />
                  </div>
                </div>

                {/* 3. ОПТИКА И ПЛЁНКА: РАДИАЛЬНАЯ ДИСПЕРСИЯ + КИНОШНЫЙ АНИМИРОВАННЫЙ ШУМ + КНОПКА СБРОСА */}
                <div className="space-y-2.5 rounded-lg border border-border bg-[var(--surface-2)] p-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-medium text-zinc-200">Оптика и плёнка</span>
                    <button
                      onClick={() => {
                        pushHistory()
                        updateSelectedFx({ dispersion: undefined, grain: undefined })
                      }}
                      className="text-[10px] text-zinc-400 hover:text-[#A78BFA]"
                      title="Сбросить дисперсию и киношный шум"
                    >
                      Сброс
                    </button>
                  </div>
                  {/* Дисперсия (радиальная: центр чистый, к краям нарастает) */}
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-zinc-400" title="Линзовая дисперсия как в DaVinci Resolve: центр кадра остаётся резким, а к краям и углам расходится спектр RGB">
                        Дисперсия (к краям)
                      </span>
                      <button
                        onClick={() => { pushHistory(); updateSelectedFx({ dispersion: undefined }) }}
                        className="font-mono text-[#A78BFA] hover:underline"
                        title="Клик — выключить дисперсию"
                      >
                        {selected.fx?.dispersion ?? 0} пикс
                      </button>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={20}
                      step={1}
                      value={selected.fx?.dispersion ?? 0}
                      onPointerDown={pushHistory}
                      onChange={(e) => {
                        const v = Number(e.target.value)
                        updateSelectedFx({ dispersion: v <= 0 ? undefined : v })
                      }}
                      className="h-1.5 w-full cursor-pointer accent-[#7C3AED]"
                    />
                  </div>
                  {/* Киношный анимированный шум */}
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-zinc-400" title="Живое анимированное зерно 35mm плёнки (noise=allf=t+u)">
                        Киношный анимированный шум
                      </span>
                      <button
                        onClick={() => { pushHistory(); updateSelectedFx({ grain: undefined }) }}
                        className="font-mono text-[#A78BFA] hover:underline"
                        title="Клик — выключить шум"
                      >
                        {selected.fx?.grain ?? 0}%
                      </button>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      value={selected.fx?.grain ?? 0}
                      onPointerDown={pushHistory}
                      onChange={(e) => {
                        const v = Number(e.target.value)
                        updateSelectedFx({ grain: v <= 0 ? undefined : v })
                      }}
                      className="h-1.5 w-full cursor-pointer accent-[#7C3AED]"
                    />
                  </div>
                </div>

                {/* 4. КОПИРОВАНИЕ ЭФФЕКТОВ НА ДРУГИЕ КЛИПЫ */}
                <div className="space-y-2 rounded-lg border border-border bg-[var(--surface-2)] p-2.5">
                  <div className="text-[11px] font-medium text-zinc-200">Перенос эффектов на другие клипы</div>
                  <div className="grid grid-cols-2 gap-1.5">
                    <button
                      onClick={() => {
                        setCopiedFx(cloneFx(selected.fx))
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
                        applyFxToTargets(copiedFx, [selected.key], `Эффекты вставлены в «${selected.name}»`)
                      }}
                      className="rounded border border-border bg-[var(--surface-1)] py-1.5 text-[11px] text-zinc-200 hover:border-[#A78BFA] disabled:opacity-40"
                    >
                      Вставить сюда
                    </button>
                  </div>
                  {shots.length > 1 && (
                    <button
                      onClick={() =>
                        applyFxToTargets(
                          selected.fx,
                          shots.filter((s) => s.key !== selected.key).map((s) => s.key),
                          `Эффекты применены ко всем клипам (${shots.length})`,
                        )
                      }
                      className="w-full rounded bg-[#7C3AED] py-1.5 text-[11px] font-medium text-white hover:bg-[#6D28D9]"
                    >
                      Скопировать на все клипы таймлайна ({shots.length - 1})
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
