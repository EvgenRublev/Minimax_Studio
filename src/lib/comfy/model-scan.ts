import { readdirSync, existsSync, statSync } from 'fs'
import { join } from 'path'
import { listExternalModels } from '@/lib/extra-model-paths'

/**
 * (правка 934) Список .safetensors в категории моделей ComfyUI: локальная папка
 * + пути из extra_model_paths.yaml. Раньше эта функция жила в роуте
 * /api/comfy/image-assets, а роут /api/comfy/image копировал логику — вынесено,
 * чтобы оба роута видели один и тот же набор файлов.
 */
export function listModelFiles(modelsRoot: string, category: string): string[] {
  const names = new Set<string>()
  try {
    const dir = join(modelsRoot, category)
    if (existsSync(dir) && statSync(dir).isDirectory()) {
      for (const f of readdirSync(dir)) {
        if (f.toLowerCase().endsWith('.safetensors')) names.add(f)
      }
    }
  } catch { /* нет доступа к папке — пустой список */ }
  try {
    for (const f of listExternalModels(category)) {
      const base = f.split(/[\\/]/).pop()
      if (base && base.toLowerCase().endsWith('.safetensors')) names.add(base)
    }
  } catch { /* extra_model_paths не читаются — не критично */ }
  return [...names].sort((a, b) => a.localeCompare(b))
}
