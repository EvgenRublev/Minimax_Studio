/**
 * (правка 911 → 1080) Версия ядра ComfyUI и диапазоны, которые поддерживает
 * студия.
 *
 * Зачем: внутрипрограммное обновление меняет только файлы студии и НИКОГДА не
 * трогает ComfyUI (см. install/apply_update.ps1). Значит пользователь может
 * обновить студию и остаться на старом ядре. Теперь поддерживаются два поколения
 * бэкенда, и у каждого свой набор патчей (см. CORE_PATCH_SETS в
 * scripts/sync_custom_nodes.js):
 *   • 0.44+          — основной набор install/comfy-patches;
 *   • 0.33.x (откат) — install/comfy-patches-0.33, comfy-aimdo 0.4.13: этот
 *      вариант держит большие разрешения на малых картах там, где DynamicVRAM
 *      0.5.5–0.6.0 уходит в страничевание весов.
 *   Версии между ними (0.34–0.43) не поддерживает ни один набор — это и есть
 *   «ядро устарело/не поддерживается» в баннере.
 *
 * Константы обязаны совпадать с scripts/sync_custom_nodes.js — совпадение
 * проверяет scripts/check-comfy-sync.mjs на шаге verify релиза.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Ядро основного набора патчей (comfy-aimdo 0.6.0). */
export const CORE_CURRENT_MIN = '0.44.0'
/** Нижняя/верхняя граница откатного ядра (comfy-aimdo 0.4.13). */
export const CORE_ROLLBACK_MIN = '0.33.0'
export const CORE_ROLLBACK_MAX = '0.34.0'
/** Минимальная поддерживаемая версия ядра вообще. */
export const CORE_MIN_VERSION = CORE_ROLLBACK_MIN

export type CoreSupport = 'current' | 'rollback' | 'unsupported'

/**
 * Версия установленного ядра: comfyui_version.py, иначе pyproject.toml.
 * Принимает КАТАЛОГ ЯДРА (cfg.comfyCore), а не корень бэкенда.
 * null — файлов нет или версия не разобралась.
 */
export function parseComfyVersion(comfyCore: string): string | null {
  try {
    const py = join(comfyCore, 'comfyui_version.py')
    if (existsSync(py)) {
      const m = /__version__\s*=\s*["']([^"']+)["']/.exec(readFileSync(py, 'utf8'))
      if (m) return m[1].trim()
    }
  } catch { /* нет доступа — пробуем pyproject */ }
  try {
    const proj = join(comfyCore, 'pyproject.toml')
    if (existsSync(proj)) {
      const m = /^version\s*=\s*["']([^"']+)["']/m.exec(readFileSync(proj, 'utf8'))
      if (m) return m[1].trim()
    }
  } catch { /* версию не определить */ }
  return null
}

/** Сравнение версий вида 0.44.0: <0 — a старее b, 0 — равны, >0 — a новее. */
export function compareCoreVersions(a: string, b: string): number {
  const pa = String(a).replace(/^v/i, '').split(/[.\-+]/)
  const pb = String(b).replace(/^v/i, '').split(/[.\-+]/)
  const n = Math.max(pa.length, pb.length)
  for (let i = 0; i < n; i++) {
    const na = parseInt(pa[i] ?? '0', 10)
    const nb = parseInt(pb[i] ?? '0', 10)
    const va = Number.isFinite(na) ? na : 0
    const vb = Number.isFinite(nb) ? nb : 0
    if (va !== vb) return va < vb ? -1 : 1
  }
  return 0
}

/** Какое поколение бэкенда соответствует версии ядра. */
export function coreSupport(version: string | null | undefined): CoreSupport {  if (!version) return 'current' // неизвестную версию не ругаем, как и раньше
  if (compareCoreVersions(version, CORE_CURRENT_MIN) >= 0) return 'current'
  if (compareCoreVersions(version, CORE_ROLLBACK_MIN) >= 0 && compareCoreVersions(version, CORE_ROLLBACK_MAX) < 0) {
    return 'rollback'
  }
  return 'unsupported'
}

/** Устарело ли ядро (неизвестная версия не считается устаревшей). */
export function isCoreOutdated(version: string | null | undefined): boolean {
  return coreSupport(version) === 'unsupported'
}

/**
 * (правка 1080) Канал ядра, выбранный пользователем: 'rollback' | 'current' | ''.
 * Пишут его install\install.ps1 (после смены поколения) и electron/main.js (до
 * запуска установщика). Нужен, чтобы обычный ремонт не вернул откатившегося
 * пользователя на 0.44 тайком: install.ps1 читает этот файл, когда ключей нет.
 */
export function readCoreChannel(): 'rollback' | 'current' | '' {
  try {
    const p = join(process.cwd(), 'config', 'comfy_core_channel.txt')
    if (!existsSync(p)) return ''
    const v = readFileSync(p, 'utf8').trim().toLowerCase()
    return v === 'rollback' ? 'rollback' : v === 'current' ? 'current' : ''
  } catch {
    return ''
  }
}
