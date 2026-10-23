import { NextResponse } from 'next/server'
import { clearInflight } from '@/lib/inflight-journal'

export const dynamic = 'force-dynamic'

/**
 * POST /api/comfy/purge-queue — (правка 692) полный сброс очереди ComfyUI
 * + журнала inflight. Вызывается при заводском сбросе, чтобы удалить stale
 * queued prompts (WinError 2: 'E:\000\diffusion_models') и старые записи
 * clientToken → prompt_id.
 *
 * Не требует GPU: только HTTP-запросы к ComfyUI /queue (без генерации).
 */
export async function POST() {
  const results: { inflightCleared: boolean; queueCleared: boolean; error?: string } = {
    inflightCleared: false,
    queueCleared: false,
  }

  // 1) Удалить журнал inflight (stale clientToken записи)
  try {
    clearInflight()
    results.inflightCleared = true
  } catch (e) {
    results.error = `inflight: ${e instanceof Error ? e.message : String(e)}`
  }

  // 2) Очистить очередь ComfyUI (stale queued prompts)
  //    Сначала GET /queue, чтобы получить все pending prompt_id,
  //    затем POST /queue {delete: [...]} для каждого.
  try {
    const COMFY_URL = process.env.COMFY_URL || 'http://127.0.0.1:8188'
    // Получить все pending задачи
    const qRes = await fetch(`${COMFY_URL}/queue`, { signal: AbortSignal.timeout(5000) })
    if (qRes.ok) {
      const q = await qRes.json()
      // (правка 716) ComfyUI queue format: [[number, prompt_id, prompt, ...], ...]
      // → item[0] — НОМЕР в очереди, item[1] — prompt_id.
      // Раньше брался p[0], т.е. номера очереди: POST /queue {delete:[...]} с
      // такими значениями не удалял НИЧЕГО, а маршрут рапортовал об успехе.
      const promptIdOf = (p: unknown): string => {
        if (Array.isArray(p)) return String(p[1] ?? '')
        if (p && typeof p === 'object') return String((p as Record<string, unknown>).prompt_id ?? '')
        return ''
      }
      const pendingIds: string[] = (q.queue_pending ?? []).map(promptIdOf)
      const runningIds: string[] = (q.queue_running ?? []).map(promptIdOf)
      const allIds = [...new Set([...runningIds, ...pendingIds].filter(Boolean))]

      // Отменить running (interrupt) + удалить все из очереди
      if (runningIds.length > 0) {
        await fetch(`${COMFY_URL}/interrupt`, { method: 'POST', signal: AbortSignal.timeout(5000) }).catch(() => {})
      }
      if (allIds.length > 0) {
        const delRes = await fetch(`${COMFY_URL}/queue`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ delete: allIds }),
          signal: AbortSignal.timeout(5000),
        })
        // (правка 716) Раньше ошибка удаления глоталась catch(() => {}), а
        // queueCleared всё равно ставился в true — вызывающему сообщали об
        // успехе при провале.
        if (!delRes.ok) {
          results.error = `queue delete: HTTP ${delRes.status}`
        }
      }
      results.queueCleared = true
    }
  } catch (e) {
    // ComfyUI недоступен — это нормально (он может быть не запущен).
    // Журнал inflight уже очищен.
    if (!results.error) {
      results.error = `queue: ${e instanceof Error ? e.message : String(e)}`
    }
  }

  return NextResponse.json(results)
}
