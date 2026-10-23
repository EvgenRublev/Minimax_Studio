import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

/**
 * GET /api/comfy/active — состояние активных генераций в ComfyUI.
 *
 * (правка 718) Нужен для сверки при старте приложения: стор gen-progress
 * персистится в localStorage и при перезапуске восстанавливает фазу
 * «running» — даже если генерации давно нет (ComfyUI был перезапущен, задача
 * упала, компьютер перезагрузили). Без сверки карточка «Генерация идёт»
 * висела бы после каждого запуска приложения.
 *
 * Query:
 *   ?check=id1,id2 — prompt_id, состояние которых нужно уточнить
 *                     (не в очереди, но ещё живые в истории).
 *
 * Ответ:
 *   {
 *     ok: true,          // ComfyUI ответил — можно сверять
 *     active: boolean,   // есть ли вообще активные генерации
 *     prompts: string[], // prompt_id в queue_running + queue_pending
 *     states: { [id]: 'alive' | 'done' | 'gone' }
 *   }
 *   { ok: false, active: false, prompts: [], states: {} }
 *                      // ComfyUI недоступен (ещё поднимается): сверять НЕЛЬЗЯ,
 *                        // клиент не должен сбрасывать состояние.
 */
export async function GET(req: Request) {
  const COMFY_URL = process.env.COMFY_URL || 'http://127.0.0.1:8188'
  const url = new URL(req.url)
  const check = (url.searchParams.get('check') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 20)

  try {
    const res = await fetch(`${COMFY_URL}/queue`, {
      signal: AbortSignal.timeout(8000),
      cache: 'no-store',
    })
    if (!res.ok) {
      return NextResponse.json({ ok: false, active: false, prompts: [], states: {} })
    }
    const q = (await res.json()) as {
      queue_running?: unknown[]
      queue_pending?: unknown[]
    }
    // Формат очереди ComfyUI: [[number, prompt_id, prompt, ...], ...]
    // (item[0] — номер в очереди, item[1] — prompt_id). На всякий случай
    // поддержан и объектный вид.
    const idOf = (p: unknown): string => {
      if (Array.isArray(p)) return String(p[1] ?? '')
      if (p && typeof p === 'object') {
        const v = (p as { prompt_id?: unknown }).prompt_id
        return typeof v === 'string' ? v : ''
      }
      return ''
    }
    const prompts = [...(q.queue_running ?? []), ...(q.queue_pending ?? [])]
      .map(idOf)
      .filter(Boolean)
    const alive = new Set(prompts)

    // Для промптов, которых нет в очереди, уточняем: знает ли ComfyUI о них
    // вообще (история) — иначе нельзя отличить «только что завершилась» от
    // «перезапустили ComfyUI, задачи не существует».
    const states: Record<string, 'alive' | 'done' | 'gone'> = {}
    for (const id of check) {
      if (alive.has(id)) {
        states[id] = 'alive'
        continue
      }
      states[id] = (await isKnownToComfy(COMFY_URL, id)) ? 'done' : 'gone'
    }

    return NextResponse.json({ ok: true, active: prompts.length > 0, prompts, states })
  } catch {
    // ComfyUI ещё поднимается или упал — НЕ утверждаем, что генераций нет.
    return NextResponse.json({ ok: false, active: false, prompts: [], states: {} })
  }
}

/** Знает ли ComfyUI о таком prompt_id (запись в истории)? */
async function isKnownToComfy(comfyUrl: string, promptId: string): Promise<boolean> {
  try {
    const res = await fetch(`${comfyUrl}/history/${encodeURIComponent(promptId)}`, {
      signal: AbortSignal.timeout(8000),
      cache: 'no-store',
    })
    if (!res.ok) return false
    const hist = (await res.json()) as Record<string, unknown>
    return !!hist && Object.keys(hist).length > 0
  } catch {
    return false
  }
}
