/**
 * (правка 911) Версия ядра ComfyUI и минимально допустимая.
 *
 * Зачем: внутрипрограммное обновление меняет только файлы студии и НИКОГДА не
 * трогает ComfyUI (см. install/apply_update.ps1). Значит пользователь может
 * обновиться до студии, которой нужны ноды ядра 0.44, и остаться на 0.33:
 * до сих пор об этом сообщал только `console.error` в синхронизаторе, то есть
 * никто этого не видел. Теперь версия читается API-роутом
 * /api/comfy/core-version, а UI показывает баннер «ядро устарело».
 *
 * Константа обязана совпадать с CORE_MIN_VERSION в
 * scripts/sync_custom_nodes.js (там она решает, класть ли патчи ядра) —
 * совпадение проверяет scripts/check-comfy-sync.mjs на шаге verify релиза.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Минимальная версия ядра, под которую написаны наши патчи и ноды. */
export const CORE_MIN_VERSION = '0.44.0'

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

/** Устарело ли ядро (неизвестная версия не считается устаревшей). */
export function isCoreOutdated(version: string | null | undefined): boolean {
  if (!version) return false
  return compareCoreVersions(version, CORE_MIN_VERSION) < 0
}
