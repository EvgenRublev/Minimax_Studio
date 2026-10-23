/**
 * (правка 392) Общий хелпер LatentCut с дроблением под лимит ComfyUI.
 *
 * ComfyUI валидирует inputs LatentCut: index/amount ≤ MAX_RESOLUTION
 * (16384, comfy_extras/nodes_latent.py:186-187) — превышение отклоняет
 * ВЕСЬ prompt на submit (HTTP 400). Для длинных источников аудио-шаги
 * (5/3 на кадр) упираются в лимит при ~6,8 мин, видео-токены — при ~39 мин.
 *
 * chainLatentCut возвращает ссылку [nodeId, 0] на ноду, эквивалентную
 * LatentCut(samples, dim, index, amount): при превышении лимита диапазон
 * [index, index+amount) дробится на окна по границам, кратным MAX
 * (каждое окно — LatentCut из ИСХОДНИКА + докrop головы/хвоста), куски
 * склеиваются LatentConcat по той же dim. Клампинг по фактической длине
 * источника сохраняется (LatentCut клампит, короткие куски просто
 * конкатенируются).
 *
 * base — базовый id ноды; при дроблении суффиксы _w/_h/_t/_cat делают
 * id уникальными внутри prompt (base обязан быть уникален у вызывающего).
 */

export const LATENT_CUT_MAX = 16_384

export type LatentRef = [string, number]

export function chainLatentCut(
  nodes: Record<string, unknown>,
  base: string,
  samples: LatentRef,
  dim: 'x' | 'y' | 't',
  index: number,
  amount: number,
  title: string,
): LatentRef {
  const idx = Math.max(0, Math.round(index))
  const amt = Math.max(1, Math.round(amount))
  if (idx <= LATENT_CUT_MAX && amt <= LATENT_CUT_MAX) {
    nodes[base] = {
      inputs: { samples, dim, index: idx, amount: amt },
      class_type: 'LatentCut',
      _meta: { title },
    }
    return [base, 0]
  }
  const end = idx + amt
  const pieces: LatentRef[] = []
  let part = 0
  for (let c0 = Math.floor(idx / LATENT_CUT_MAX) * LATENT_CUT_MAX; c0 < end; c0 += LATENT_CUT_MAX) {
    const h = Math.max(idx, c0)
    const e = Math.min(end, c0 + LATENT_CUT_MAX)
    const wid = `${base}_w${part}`
    nodes[wid] = {
      inputs: { samples, dim, index: c0, amount: LATENT_CUT_MAX },
      class_type: 'LatentCut',
      _meta: { title: `${title} — окно ${part + 1}` },
    }
    let cur: LatentRef = [wid, 0]
    if (h > c0) {
      const hid = `${base}_h${part}`
      nodes[hid] = {
        inputs: { samples: cur, dim, index: h - c0, amount: LATENT_CUT_MAX },
        class_type: 'LatentCut',
        _meta: { title: `${title} — срез головы окна ${part + 1}` },
      }
      cur = [hid, 0]
    }
    const tid = `${base}_t${part}`
    nodes[tid] = {
      inputs: { samples: cur, dim, index: 0, amount: e - h },
      class_type: 'LatentCut',
      _meta: { title: `${title} — кусок ${part + 1} (${e - h})` },
    }
    pieces.push([tid, 0])
    part++
  }
  let acc = pieces[0]
  for (let i = 1; i < pieces.length; i++) {
    const cid = `${base}_cat${i}`
    nodes[cid] = {
      inputs: { samples1: acc, samples2: pieces[i], dim },
      class_type: 'LatentConcat',
      _meta: { title: `${title} — склейка кусков` },
    }
    acc = [cid, 0]
  }
  return acc
}
