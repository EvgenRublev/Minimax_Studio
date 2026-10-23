import { NextResponse } from 'next/server'
import { getAppConfig } from '@/lib/app-config'
import { upscaleStatus, upscaleDir, upscalePort, fetchUpscaleHealth } from '@/lib/upscale-runner'

/**
 * (правка 74) GET /api/upscale/status
 * Вкладка Upscale (DLSS-мост): конфиг + состояние сервиса + health моста.
 *
 * (правка 77) Чисто чтение — без side-эффектов. Автозапуск убран отсюда:
 * раньше каждый GET, заставший сервис «не запущен», спавнил ensureUpscale —
 * при сироте/зомби на порту это было бесконечным спамом процессов.
 * Автозапуск теперь живёт в клиентском синглтоне useUpscaleService
 * (src/lib/upscale-service.ts) и переживает переключение вкладок.
 *
 * Пока сервис стартует (starting) делаем best-effort health: мост мог уже
 * отвечать, и тогда UI увидит живой log_tail («Подготовка рантайма…»)
 * вместо мёртвого спиннера «запуск…».
 */
export const dynamic = 'force-dynamic'

export async function GET() {
  const cfg = getAppConfig()
  const service = upscaleStatus()

  let health: unknown = null
  if (service.running) {
    try {
      health = await fetchUpscaleHealth(2500)
    } catch {
      health = null
    }
  } else if (service.starting) {
    try {
      health = await fetchUpscaleHealth(1200)
    } catch {
      health = null
    }
  }

  return NextResponse.json({
    enabled: cfg.upscaleEnabled,
    port: upscalePort(),
    dir: upscaleDir(),
    service,
    health,
  })
}
