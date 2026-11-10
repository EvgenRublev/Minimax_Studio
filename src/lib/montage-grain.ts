/**
 * (правка 910) Киношный шум (зерно) в превью монтажки — по каждому клипу.
 *
 * В рендере (ffmpeg, `noise=alls:allf=t+u`) зерно применяется к КАЖДОМУ клипу
 * отдельно. В превью раньше рисовался ОДИН оверлей, и это давало две ошибки:
 *
 *  1. Оверлей был закрыт условием `!inGap`, а `inGap` считается только по
 *     базовой дорожке. Клип на второй дорожке (слой V2+) над пустым местом
 *     базы играет, но шума не было вовсе.
 *  2. Источником считался только САМЫЙ ВЕРХНИЙ видимый слой: если у него шума
 *     нет, брался шум базового клипа и рисовался под слоями — визуально шум
 *     нижнего слоя пропадал.
 *
 * Правило (совпадает с рендером):
 *  • база — только пока база реально играет (не в промежутке), z = 1;
 *  • каждый видимый слой — свой оверлей, z = 5 + track (тот же z, что у его
 *    <video>; оверлеи идут в DOM позже, поэтому ложатся поверх своего клипа и
 *    под более высокими слоями).
 *
 * Чистая функция без зависимостей — покрыта scratchpad/montage-grain-check.mjs.
 */

/** Слой (V2+) в объёме, нужном для расчёта шума. */
export interface GrainLayerInput {
  key: string
  /** Дорожка слоя (>= 1). */
  track: number
  /** Начало на шкале, секунды. */
  at: number
  /** Эффективная длительность, секунды. */
  len: number
  hidden?: boolean
  /** Киношный шум 0..100 (уже с учётом байпаса). */
  grain?: number
}

/** Один оверлей зерна: для какого клипа и с каким z-index. */
export interface GrainOverlay {
  key: string
  grain: number
  z: number
}

export function collectGrainOverlays(input: {
  playT: number
  /** Играет «дырка» базовой дорожки (её видео скрыто). */
  inGap: boolean
  /** Шум базового клипа под плейхедом (0 = нет). */
  baseGrain: number
  layers: GrainLayerInput[]
}): GrainOverlay[] {
  const out: GrainOverlay[] = []
  if (input.baseGrain > 0 && !input.inGap) {
    out.push({ key: 'base', grain: input.baseGrain, z: 1 })
  }
  for (const l of input.layers) {
    if (l.hidden) continue
    if (input.playT < l.at || input.playT >= l.at + l.len) continue
    if (!l.grain || l.grain <= 0) continue
    out.push({ key: l.key, grain: l.grain, z: 5 + (Number.isFinite(l.track) ? l.track : 1) })
  }
  return out
}
