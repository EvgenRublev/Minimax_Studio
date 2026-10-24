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
  return path.join(cfg.comfyRoot, 'ComfyUI', 'models', 'loras')
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
  return loadLoras()
    .filter((e) => e.enabled && files.has(e.name))
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