import { NextResponse } from 'next/server'
import { checkForUpdate, startUpdateDownload } from '@/lib/app-update'
import { useTranslation } from 'react-i18next' // (правка 955)

export const dynamic = 'force-dynamic'

/**
 * POST /api/update/download  (правка 790)
 *
 * Тело пустое: актуальные url/sha256 всегда берутся из свежего фида —
 * UI не может «протащить» ссылку из устаревшего ответа.
 */
export async function POST() {
  const { t: st } = useTranslation() // (правка 955)

  const check = await checkForUpdate()
  if (!check.update) {
    return NextResponse.json({ ok: false, error: st("Обновление недоступно — сначала проверьте его") })
  }
  const result = await startUpdateDownload(check.update)
  return NextResponse.json(result)
}
