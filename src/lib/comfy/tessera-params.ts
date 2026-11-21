/**
 * (правка 1058) Параметры тайлового режима Refine «Частями по тайлам»
 * (Tessera) — выведены в UI вкладки Refine, чтобы стыки можно было подбирать
 * вручную, без правки шаблона.
 *
 * Модуль намеренно без импортов: его типы/дефолты использует и клиентская
 * вкладка (Zustand-стор), и серверный шаблон воркфлоу. Сами значения —
 * проверенный рецепт правки 1057 (Tessera: overlap-режим, seam_regen 32,
 * seed_mode global, frame_match dc); менять только осознанно.
 *
 * Что на что влияет (замеры и предупреждения самих нод Tessera):
 *  • seamOverlap — ширина полосы шва, которую генерируют ОБА соседних тайла
 *    и кроссфейдят. Прямая ручка видимости вертикального стыка: при 32 px
 *    (2 латент-клетки) последний шаг веса — 1/3, и на стыке читается линия;
 *    96 px (6 клеток) даёт шаг 1/7. Требует места в contextBorder:
 *    seamOverlap <= contextBorder − 32 px (нода иначе не растит маску и
 *    печатает «raise context_border»).
 *  • contextBorder — сколько соседней картинки каждый тайл видит за швом
 *    (не маска, а контекст для модели). Больше — согласованнее края, дороже
 *    только размером окна.
 *  • temporalOverlap/временное окно — чанки со сквозной генерацией; стык по
 *    времени жёсткий, но следующий чанк стартует с уже готовыми кадрами
 *    лида (guide_inherit). Больше нахлёст — мягче стык, больше чанков.
 *  • videoRefCrop/imageRefCrop — per_tile даёт каждому тайлу свой кроп
 *    референса и СВОЙ Qwen-эмбеддинг (сильнее расходятся соседи на стыке);
 *    global — одна картинка/промпт на все тайлы (консистентнее по стыкам).
 *  • composite — latent: один декод готового канваса (быстрее, меньше VRAM);
 *    pixel: покадровый композит с кроссфейдом в пикселях (медленнее).
 *  • guideRelease/motionAdapt — насколько модель отпускает гайд в тонкой
 *    фазе; на быстром движении шумная текстура «кипит» на стыках.
 *  • flatSkip — плоские окна не сэмплировать (0 = выкл; рецепт Tessera — 4.0,
 *    но мы по умолчанию всё пересэмплируем, чтобы мягкая пластинка не
 *    оставалась мылом).
 */

export interface TesseraTileParams {
  /** Размер тайла: авто-кап 768 px (low_vram) / 1024 px (high_vram) / custom. */
  spatialTile: 'low_vram' | 'high_vram' | 'custom'
  /** Только для spatialTile='custom': размер окна тайла (px, кратно 64). */
  tileWidth: number
  tileHeight: number
  /** Контекст вокруг маски тайла (px, кратно 8; 0..512). */
  contextBorder: number
  /** Ширина полосы шва (px, кратно 32; 0..128). <= contextBorder − 32. */
  seamOverlap: number
  /** Временное окно: 'auto' — по «длине части» (2–3 с → 73, 5–8 с → 124),
   *  '73'|'124'|'192' — родные кадры H3 (17k+5), 'off' — весь клип одним окном. */
  temporalTile: 'auto' | '73' | '124' | '192' | 'off'
  /** Сколько латент-кадров чанк наследует из предыдущего (0..16). */
  temporalOverlap: number
  /** Склейка тайлов: latent — один декод канваса, pixel — попиксельно. */
  composite: 'latent' | 'pixel'
  /** Референсы: свой кроп на тайл (+свой text encode) или общие на весь кадр. */
  videoRefCrop: 'per_tile' | 'global'
  imageRefCrop: 'per_tile' | 'whole'
  /** Доля фазы «отпускания» гайда (0..1): тонкая текстура свободнее. */
  guideRelease: number
  /** Релей деталей: гайд следующих чанков несёт уже готовый канвас. */
  guideInherit: boolean
  /** Гасить отпускание гайда на быстром движении (меньше «кипения»). */
  motionAdapt: boolean
  motionReleaseFloor: number
  /** Порог пропуска плоских окон (0 = выкл; 4.0 — рецепт Tessera). */
  flatSkip: number
}

/** Дефолты = рецепт правки 1057 (поведение до правки 1058 не меняется). */
export const DEFAULT_TESSERA_TILES: TesseraTileParams = {
  spatialTile: 'low_vram',
  tileWidth: 1024,
  tileHeight: 1024,
  contextBorder: 64,
  seamOverlap: 32,
  temporalTile: 'auto',
  temporalOverlap: 4,
  composite: 'latent',
  videoRefCrop: 'per_tile',
  imageRefCrop: 'per_tile',
  guideRelease: 0.8,
  guideInherit: true,
  motionAdapt: false,
  motionReleaseFloor: 0,
  flatSkip: 0,
}

export interface TesseraTilesResolved extends TesseraTileParams {
  /** Итоговые виджеты TesseraPlan/TesseraRefine для временного окна. */
  nodeTemporalTile: 'low_vram' | 'high_vram' | 'custom' | 'off'
  /** temporal_size ноды (значаще только для nodeTemporalTile='custom'). */
  nodeTemporalSize: number
}

/**
 * Привести значения из UI к валидным для нод Tessera. Вызывается и на
 * сервере (шаблон/мета), поэтому не доверяет ни одному полю.
 */
export function resolveTesseraTiles(
  raw: Partial<TesseraTileParams> | undefined,
  chunkSeconds?: number,
): TesseraTilesResolved {
  const src = raw ?? {}
  const pick = <T extends string>(v: unknown, allowed: readonly T[], def: T): T =>
    (allowed as readonly string[]).includes(String(v)) ? (v as T) : def
  const num = (v: unknown, def: number, min: number, max: number, step = 0): number => {
    const n = Number(v)
    if (!Number.isFinite(n)) return def
    const c = Math.min(max, Math.max(min, n))
    return step > 0 ? Math.round(c / step) * step : Math.round(c)
  }
  const bool = (v: unknown, def: boolean): boolean =>
    typeof v === 'boolean' ? v : def

  const spatialTile = pick(src.spatialTile, ['low_vram', 'high_vram', 'custom'] as const, 'low_vram')
  // 64 px — один DiT-патч на полуразмерном референсе (q=2): на нём кропы
  // референсов режутся точно, без latent-интерполяции (предупреждение
  // TesseraRefine «RESAMPLED»).
  const tileWidth = num(src.tileWidth, DEFAULT_TESSERA_TILES.tileWidth, 256, 2048, 64)
  const tileHeight = num(src.tileHeight, DEFAULT_TESSERA_TILES.tileHeight, 256, 2048, 64)
  const contextBorder = num(src.contextBorder, DEFAULT_TESSERA_TILES.contextBorder, 0, 512, 8)
  // Шов требует минимум один DiT-патч (32 px) контекста на стороне соседа,
  // который маску НЕ растит — иначе _apply_seam_regen молча ничего не делает.
  const maxSeam = Math.min(128, Math.floor(Math.max(0, contextBorder - 32) / 32) * 32)
  const seamOverlap = Math.min(maxSeam, num(src.seamOverlap, DEFAULT_TESSERA_TILES.seamOverlap, 0, 128, 32))
  const temporalOverlap = num(src.temporalOverlap, DEFAULT_TESSERA_TILES.temporalOverlap, 0, 16)

  const temporalTile = pick(src.temporalTile, ['auto', '73', '124', '192', 'off'] as const, 'auto')
  const chunkSec = Number(chunkSeconds)
  const autoWindow = (Number.isFinite(chunkSec) ? chunkSec : 5) <= 3 ? 'low_vram' : 'high_vram'
  const nodeTemporalTile = temporalTile === 'auto'
    ? autoWindow
    : temporalTile === '73'
      ? 'low_vram'
      : temporalTile === '124'
        ? 'high_vram'
        : temporalTile === '192'
          ? 'custom'
          : 'off'
  const nodeTemporalSize = temporalTile === '192' ? 192 : 124

  return {
    spatialTile,
    tileWidth,
    tileHeight,
    contextBorder,
    seamOverlap,
    temporalTile,
    temporalOverlap,
    composite: pick(src.composite, ['latent', 'pixel'] as const, 'latent'),
    videoRefCrop: pick(src.videoRefCrop, ['per_tile', 'global'] as const, 'per_tile'),
    imageRefCrop: pick(src.imageRefCrop, ['per_tile', 'whole'] as const, 'per_tile'),
    guideRelease: num(src.guideRelease, DEFAULT_TESSERA_TILES.guideRelease, 0, 1, 0.05),
    guideInherit: bool(src.guideInherit, true),
    motionAdapt: bool(src.motionAdapt, false),
    motionReleaseFloor: num(src.motionReleaseFloor, 0, 0, 1, 0.05),
    flatSkip: num(src.flatSkip, DEFAULT_TESSERA_TILES.flatSkip, 0, 64, 0.1),
    nodeTemporalTile,
    nodeTemporalSize,
  }
}
