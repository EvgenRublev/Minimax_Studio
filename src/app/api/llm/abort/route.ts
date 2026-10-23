import { NextRequest, NextResponse } from 'next/server'
import { LLM_PORT, llmStatus, llmBackend } from '@/lib/llm-runner'

export const dynamic = 'force-dynamic'

/**
 * POST /api/llm/abort — stop the current LLM generation (best effort).
 *
 * (правка 717) Принимает request_id (query или тело) и передаёт его дальше:
 * прерывание должно попасть ровно в ту генерацию, которую остановили. Без
 * адресации «Стоп» мог оборвать СЛЕДУЮЩИЙ запрос (прерывание приходило
 * позже, чем новый /chat).
 */
export async function POST(req: NextRequest) {
  const backend = llmBackend()
  let aborted = false
  let requestId: string | null = null
  try {
    const url = new URL(req.url)
    const q = url.searchParams.get('request_id')
    if (q) requestId = q
    if (!requestId) {
      const body = (await req.json().catch(() => null)) as { request_id?: unknown } | null
      if (body && typeof body.request_id === 'string' && body.request_id) {
        requestId = body.request_id
      }
    }
  } catch {
    /* без id — прерываем текущую генерацию (старый режим) */
  }
  // (правка 351) Bonsai-бэкенд (prism llama-server) не имеет endpoint /abort —
  // запрос возвращал 404 и логировал ошибку. Для bonsai не шлём ничего и
  // честно сообщаем клиенту aborted:false: серверная генерация продолжается,
  // прерывается только локальный стрим (SSE-чтение на клиенте).
  if (backend !== 'bonsai') {
    // (правка 587) Раньше aborted=true ставился безусловно — даже когда
    // запрос /abort не дошёл до сервера (ECONNREFUSED проглатывался
    // .catch(() => {})), и клиент считал генерацию остановленной.
    try {
      const r = await fetch(`http://127.0.0.1:${LLM_PORT}/abort`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestId ? { request_id: requestId } : {}),
      })
      aborted = r.ok
    } catch {
      /* runner not up — nothing to abort */
    }
  }
  return NextResponse.json({ ok: true, aborted, backend, requestId, ...llmStatus() })
}
