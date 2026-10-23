/**
 * Custom LoRA management (правка 44).
 *
 * Stores settings for custom LoRAs in a JSON file in the project root.
 * The built-in turbo LoRA is NOT included in this list.
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

/** The turbo LoRA filename (excluded from custom list). */
export const TURBO_LORA_NAME = 'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors'

function lorasFile(): string {
  return path.join(process.cwd(), 'data', 'loras.json')
}

export function loadLoras(): LoraEntry[] {
  try {
    const raw = fs.readFileSync(lorasFile(), 'utf-8')
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr.filter((e) => e && typeof e.name === 'string')
  } catch {
    return []
  }
}

export function saveLoras(entries: LoraEntry[]): void {
  fs.writeFileSync(lorasFile(), JSON.stringify(entries, null, 2), 'utf-8')
}

/**
 * (правка 130) Сброс настроек LoRA к заводским:
 * все лоры выключены (enabled=false), сила по умолчанию (1.0), триггеры очищены.
 * Файл loras.json сохраняется с «чистым» состоянием.
 *
 * (правка 133) По умолчанию после заводского сброса включена стандартная
 * 4-шаговая турбо-лора (TURBO_LORA_NAME) — она нужна для базовой работы
 * генерации. Остальные кастомные лоры выключены.
 */
export function resetLorasToDefaults(): LoraEntry[] {
  const files = listLoraFiles()
  // (правка 578) Турбо-лора убрана — все LoRA теперь кастомные, по умолчанию выключены
  const defaults: LoraEntry[] = files.map((name) => ({
    name,
    strength: 1.0,
    enabled: false,
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
 * (правка 483) Включённые пользовательские LoRA для роутов refine /
 * tile-upscale (generate-роут собирает список сам — ему ещё нужна
 * turbo-запись). Фильтры те же, что в /api/comfy/generate: запись
 * включена, это НЕ турбо-лора и файл реально есть на диске (иначе
 * ComfyUI упал бы на загрузке несуществующей лоры — «призрак», правка 89).
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