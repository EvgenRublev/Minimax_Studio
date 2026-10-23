import { NextRequest, NextResponse } from 'next/server'
import { forceReleaseAssistantLock } from '@/lib/vram-arbiter'

export const dynamic = 'force-dynamic'

/**
 * POST /api/llm/release — (правка 110) принудительное снятие блокировки
 * ассистента (зависший streaming-счётчик). Вызывается UI-fallback'ом, когда
 * кнопка «Сгенерировать» держится заблокированной больше 60 с, хотя активного
 * стрима на клиенте уже нет. Свежий замок (стрим реально идёт) НЕ снимает:
 * forceReleaseAssistantLock проверяет возраст блокировки.
 *
 * (правка 692) `?force=1` — безусловный сброс: игнорирует minAge, снимает
 * streamingCount + chatActive сразу. Используется вторым pass клиентского
 * fallback'а, когда первый (non-force) не помог.
 */
export async function POST(req: NextRequest) {
  const force = req.nextUrl.searchParams.get('force') === '1'
  const released = forceReleaseAssistantLock(60_000, force)
  return NextResponse.json({ ok: true, released, forced: force })
}
