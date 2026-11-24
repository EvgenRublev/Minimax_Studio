import { NextResponse } from 'next/server'
import { readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import { getAppConfig } from '@/lib/app-config'

export const dynamic = 'force-dynamic'

/**
 * (правка 1121) GET /api/models/llm-local
 *
 * Локальные .gguf-модели ассистента, найденные на диске: в папке моделей ядра,
 * во внешних папках моделей (config [models] extra_paths) и в сборке Bonsai.
 * Селектор «Модель ассистента» показывает их отдельной группой — раньше список
 * был статическим, и свои GGUF из папки Models в нём не появлялись.
 *
 * Ответ: { ok, models: [{ path, name, sizeGb, source }] }
 */
const MAX_DEPTH = 3
const MAX_ITEMS = 60

function walkGguf(dir: string, depth: number, out: Array<{ path: string; name: string; sizeGb: number; source: string }>, source: string) {
  if (depth > MAX_DEPTH || out.length >= MAX_ITEMS) return
  let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (out.length >= MAX_ITEMS) return
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      walkGguf(full, depth + 1, out, source)
      continue
    }
    if (!/\.gguf$/i.test(e.name)) continue
    // mmproj — это проектор зрения, а не самостоятельная модель
    if (/mmproj/i.test(e.name)) continue
    try {
      const size = statSync(full).size
      if (size < 100 * 1024 * 1024) continue
      out.push({ path: full, name: e.name, sizeGb: Math.round((size / 1024 ** 3) * 10) / 10, source })
    } catch { /* файл исчез — пропускаем */ }
  }
}

export async function GET() {
  try {
    const cfg = getAppConfig()
    const found: Array<{ path: string; name: string; sizeGb: number; source: string }> = []

    walkGguf(path.join(cfg.comfyCore, 'models', 'llm'), 0, found, 'models/llm')
    walkGguf(path.join(cfg.comfyCore, 'models'), 1, found, 'ComfyUI/models')
    for (const e of cfg.modelExtraPaths) {
      if (existsSync(e.path)) walkGguf(e.path, 0, found, 'свои папки моделей')
    }
    if (cfg.llmBonsaiDir) walkGguf(path.join(cfg.llmBonsaiDir, 'models'), 0, found, 'Bonsai')

    const seen = new Set<string>()
    const models = found.filter((m) => {
      const key = m.path.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    // (правка 1127) Зрение: ищем mmproj рядом с моделью (в той же папке) —
    // при выборе локальной модели селектор подставит и проектор, иначе
    // ассистент будет «слепым» без всякого предупреждения.
    const withMmproj = models.map((m) => {
      let mmproj: string | null = null
      try {
        const dir = path.dirname(m.path)
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          if (e.isFile() && /mmproj/i.test(e.name) && /\.gguf$/i.test(e.name)) {
            mmproj = path.join(dir, e.name)
            break
          }
        }
      } catch { /* каталог не читается — оставляем без зрения */ }
      return { ...m, mmproj }
    })
    return NextResponse.json({ ok: true, models: withMmproj })
  } catch {
    return NextResponse.json({ ok: false, models: [] })
  }
}
