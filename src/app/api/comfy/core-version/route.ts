import { NextResponse } from 'next/server'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getAppConfig } from '@/lib/app-config'
import { CORE_MIN_VERSION, isCoreOutdated, parseComfyVersion } from '@/lib/comfy/core-version'

export const dynamic = 'force-dynamic'

/**
 * (правка 911) GET /api/comfy/core-version
 *
 * Версия установленного ядра ComfyUI и признак «устарело».
 *
 * Нужно потому, что внутрипрограммное обновление не трогает папку ComfyUI:
 * обновившаяся студия может работать на старом ядре (0.33), и до этой правки
 * единственным сигналом был console.error в синхронизаторе — то есть никакой.
 *
 * Ответ:
 *   { ok, coreExists, version, minVersion, outdated, unknown }
 *   • version — null, если файлов версии нет (тогда outdated = false:
 *     неизвестное не считаем устаревшим, как и синхронизатор патчей);
 *   • unknown — ядро есть, но версия не определилась (диагностика).
 */
export async function GET() {
  try {
    const cfg = getAppConfig()
    const coreExists = existsSync(join(cfg.comfyCore, 'main.py'))
    const version = coreExists ? parseComfyVersion(cfg.comfyCore) : null
    return NextResponse.json({
      ok: true,
      coreExists,
      version,
      minVersion: CORE_MIN_VERSION,
      outdated: isCoreOutdated(version),
      unknown: coreExists && !version,
    })
  } catch {
    // Не смогли прочитать конфиг/диск — молчим, баннер не показываем.
    return NextResponse.json({ ok: false, coreExists: false, version: null, minVersion: CORE_MIN_VERSION, outdated: false, unknown: false })
  }
}
