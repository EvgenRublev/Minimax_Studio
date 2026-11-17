/**
 * Custom LoRA management (правка 44).
 *
 * Stores settings for LoRAs in a JSON file in the project root.
 * The built-in turbo LoRA is stored here too: it is ON by default, while
 * user LoRAs are OFF by default.
 *
 * File: loras.json
 * Schema: [{ name: string, strength: number, enabled: boolean, trigger?: string }]
 */
import fs from 'fs'
import path from 'path'
import { getAppConfig } from './app-config'
import { listExternalModels } from './extra-model-paths'

export interface LoraEntry {
  /** Filename in ComfyUI models/loras/ (e.g. "my_lora.safetensors") */
  name: string
  /** Strength (0.0 – 2.0). */
  strength: number
  /** Whether this LoRA is included in generation. */
  enabled: boolean
  /** Trigger words — appended to the prompt when this LoRA is enabled. */
  trigger?: string
}

/** The built-in turbo LoRA filename (ON by default, skipped in flf+audio). */
export const TURBO_LORA_NAME = 'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors'

function lorasFile(): string {
  return path.join(process.cwd(), 'data', 'loras.json')
}

export function loadLoras(): LoraEntry[] {
  let entries: LoraEntry[] = []
  try {
    const raw = fs.readFileSync(lorasFile(), 'utf-8')
    const arr = JSON.parse(raw)
    if (Array.isArray(arr)) {
      entries = arr.filter((e) => e && typeof e.name === 'string')
    }
  } catch {
    entries = []
  }
  // Встроенная турбо-лора включена по умолчанию. Если файл есть, а записи
  // в loras.json ещё нет (первый запуск / старая установка), добавляем
  // синтетическую включённую запись. Явная запись пользователя (в том числе
  // enabled=false) всегда главнее — выключить турбо-лору в настройках можно.
  if (!entries.some((e) => e.name === TURBO_LORA_NAME)) {
    const files = listLoraFiles()
    if (files.includes(TURBO_LORA_NAME)) {
      entries.push({ name: TURBO_LORA_NAME, strength: 1.0, enabled: true, trigger: '' })
    }
  }
  return entries
}

export function saveLoras(entries: LoraEntry[]): void {
  fs.writeFileSync(lorasFile(), JSON.stringify(entries, null, 2), 'utf-8')
}

/**
 * (правка 130) Сброс настроек LoRA к заводским:
 * сила по умолчанию (1.0), триггеры очищены. Файл loras.json сохраняется
 * с «чистым» состоянием.
 *
 * По умолчанию после заводского сброса включена стандартная 4-шаговая
 * турбо-лора (TURBO_LORA_NAME) — она нужна для базовой работы генерации.
 * Остальные кастомные лоры выключены.
 */
export function resetLorasToDefaults(): LoraEntry[] {
  const files = listLoraFiles()
  // Встроенная турбо-лора — ON по умолчанию, пользовательские — OFF.
  const defaults: LoraEntry[] = files.map((name) => ({
    name,
    strength: 1.0,
    enabled: name === TURBO_LORA_NAME,
    trigger: '',
  }))
  saveLoras(defaults)
  return defaults
}

/** Path to the ComfyUI models/loras/ directory. */
export function lorasDir(): string {
  const cfg = getAppConfig()
  return path.join(cfg.comfyCore, 'models', 'loras')
}

/** List all .safetensors files in the LoRAs folder.
 *  (правка 95) Турбо-лора теперь в общем списке — управляется как обычная
 *  (вкл/выкл, сила, удаление), отдельная панель в настройках убрана. */
export function listLoraFiles(): string[] {
  const dir = lorasDir()
  try {
    const local = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.safetensors')) // (правка 82) убран дубль условия
    // (правка 257) Внешние папки (Настройки → Свои папки моделей): лоры
    // из коллекций вне студии — имена как их видит ComfyUI (yaml).
    const external = listExternalModels('loras')
      .filter((n) => n.toLowerCase().endsWith('.safetensors'))
      .filter((n) => !local.includes(n))
    return [...local, ...external].sort()
  } catch {
    return []
  }
}

/** Предел шапки safetensors: у LoRA это десятки/сотни КБ, 64 МБ — с запасом. */
const MAX_SAFETENSORS_HEADER = 64 * 1024 * 1024

/**
 * (правка 1046) Проверить .safetensors по шапке, НЕ читая тензоры: заголовок
 * парсится, тензоры объявлены, данных в файле хватает. ComfyUI проверяет ровно
 * это при загрузке LoRA и на ошибке обрывает ВЕСЬ промпт английским трейсбеком
 * («The safetensors file is corrupt or invalid») уже после загрузки моделей.
 * Битый/недокачанный файл ловим здесь — до постановки джоба.
 */
export function checkSafetensorsFile(fullPath: string): { ok: boolean; reason?: string } {
  let fd: number | null = null
  try {
    const size = fs.statSync(fullPath).size
    if (size < 8) return { ok: false, reason: 'файл пуст' }
    fd = fs.openSync(fullPath, 'r')
    const lenBuf = Buffer.alloc(8)
    if (fs.readSync(fd, lenBuf, 0, 8, 0) < 8) return { ok: false, reason: 'обрезан заголовок' }
    const headerLen = Number(lenBuf.readBigUInt64LE(0))
    if (!Number.isFinite(headerLen) || headerLen <= 0 || headerLen > MAX_SAFETENSORS_HEADER || 8 + headerLen > size) {
      return { ok: false, reason: 'повреждён заголовок safetensors' }
    }
    const headBuf = Buffer.alloc(headerLen)
    if (fs.readSync(fd, headBuf, 0, headerLen, 8) < headerLen) {
      return { ok: false, reason: 'повреждён заголовок safetensors' }
    }
    let header: unknown
    try {
      header = JSON.parse(headBuf.toString('utf-8'))
    } catch {
      return { ok: false, reason: 'не safetensors: заголовок не JSON' }
    }
    if (!header || typeof header !== 'object' || Array.isArray(header)) {
      return { ok: false, reason: 'повреждён заголовок safetensors' }
    }
    let tensors = 0
    let dataEnd = 0
    for (const [key, value] of Object.entries(header as Record<string, unknown>)) {
      if (key === '__metadata__') continue
      const offsets = (value as { data_offsets?: unknown } | null)?.data_offsets
      if (
        !Array.isArray(offsets) || offsets.length !== 2 ||
        !Number.isFinite(offsets[0]) || !Number.isFinite(offsets[1]) ||
        offsets[0] < 0 || offsets[1] < offsets[0]
      ) {
        return { ok: false, reason: 'повреждённая шапка тензоров' }
      }
      tensors++
      dataEnd = Math.max(dataEnd, offsets[1])
    }
    if (tensors === 0) return { ok: false, reason: 'в файле нет тензоров' }
    if (8 + headerLen + dataEnd > size) return { ok: false, reason: 'файл обрезан — веса не помещаются' }
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd) } catch { /* уже закрыт */ }
    }
  }
}

/** Путь к файлу LoRA: локальная папка студии, затем внешние папки (правка 257). */
function resolveLoraFile(name: string): string | null {
  const rel = name.split('/').join(path.sep)
  const localRoot = path.resolve(lorasDir())
  const local = path.resolve(localRoot, rel)
  if (isInsideDir(localRoot, local) && fs.existsSync(local)) return local
  for (const entry of getAppConfig().modelExtraPaths) {
    if (entry.category !== 'loras') continue
    const root = path.resolve(entry.path)
    const full = path.resolve(root, rel)
    if (isInsideDir(root, full) && fs.existsSync(full)) return full
  }
  return null
}

/** win32 — без учёта регистра (как в latent-file.ts). */
function isInsideDir(root: string, full: string): boolean {
  const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p)
  return norm(full).startsWith(norm(root) + path.sep)
}

/** (правка 1046) Проверка LoRA по имени из loras.json: файл есть, шапка цела. */
export function checkLoraFile(name: string): { ok: boolean; reason?: string } {
  const full = resolveLoraFile(name)
  if (!full) return { ok: false, reason: 'файл не найден' }
  return checkSafetensorsFile(full)
}

/** (правка 1046) Убрать повреждённые LoRA из набора для воркфлоу: ComfyUI не
 *  умеет «пропустить» битую лору — падает загрузкой и обрывает весь промпт. */
export function filterBrokenLoras<T extends { name: string }>(entries: T[]): T[] {
  return entries.filter((e) => {
    const check = checkLoraFile(e.name)
    if (!check.ok) console.warn(`[loras] «${e.name}» пропущена: ${check.reason}`)
    return check.ok
  })
}

/**
 * (правка 483) Включённые LoRA для роутов refine / tile-upscale / controlnet
 * (generate-роут собирает список сам — ему нужно отдельно пропускать турбо
 * в режиме «Кадры» с аудио). Встроенная турбо-лора входит в список, когда
 * включена (по умолчанию — да). Фильтры: запись включена и файл реально
 * есть на диске (иначе ComfyUI упал бы на загрузке несуществующей лоры —
 * «призрак», правка 89).
 */
export function enabledCustomLoras(): Array<{ name: string; strength: number; trigger?: string }> {
  const files = new Set(listLoraFiles())
  // (правка 1046) Битая LoRA не доезжает до ComfyUI — генерация не падает.
  return filterBrokenLoras(loadLoras().filter((e) => e.enabled && files.has(e.name)))
    .map((e) => ({ name: e.name, strength: e.strength, trigger: e.trigger }))
}

/** (правка 483) Триггерные слова включённых LoRA одной строкой ('' = нет). */
export function loraTriggerSuffix(
  entries: Array<{ trigger?: string }>,
): string {
  return entries
    .map((e) => e.trigger?.trim())
    .filter((t): t is string => !!t)
    .join(', ')
}