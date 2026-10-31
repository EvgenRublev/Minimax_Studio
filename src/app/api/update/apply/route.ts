import { NextResponse } from 'next/server'
import { cancelDownload, discardUpdate, prepareApply } from '@/lib/app-update'

export const dynamic = 'force-dynamic'

/**
 * POST /api/update/apply  (правка 790)
 *
 * Действие задаётся полем body.action:
 *   • 'prepare' (по умолчанию) — проверить sha256, распаковать в staging,
 *     записать armed.json; сама замена файлов потом делает apply_update.ps1
 *     (запускает Electron через h3:apply-update, когда мы уже выходим);
 *   • 'cancel'   — оборвать загрузку (частичный файл остаётся для докачки);
 *   • 'discard'  — убрать скачанное/взведённое обновление.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const action = typeof body?.action === 'string' ? body.action : 'prepare'

  if (action === 'cancel') return NextResponse.json(cancelDownload())
  if (action === 'discard') return NextResponse.json(discardUpdate())

  try {
    return NextResponse.json(await prepareApply())
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) })
  }
}
