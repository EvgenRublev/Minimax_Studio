import { NextResponse } from 'next/server'
import { checkForUpdate, getDownloadState } from '@/lib/app-update'

export const dynamic = 'force-dynamic'

/**
 * GET /api/update  (правка 790)
 *
 * Проверка обновлений + текущее состояние загрузки одним ответом, чтобы
 * UI (панель «О программе» и старт-тост) ездили одним запросом:
 *   current  — версия из package.json,
 *   update   — данные доступного релиза (если он новее текущей),
 *   armed    — уже разложенное в staging обновление (переживает перезапуск),
 *   download — живой прогресс, если загрузка идёт.
 */
export async function GET(req: Request) {
  const force = new URL(req.url).searchParams.get('force') === '1'
  const result = await checkForUpdate(force)
  const dl = getDownloadState()
  return NextResponse.json({
    ...result,
    download: dl && dl.status === 'downloading' ? dl : null,
  })
}
