/**
 * (правка 257) Свои папки моделей — коллекции ВНЕ папки студии.
 *
 * Самая частая просьба с YouTube (3 независимых запроса): «у меня пак
 * моделей на 2 ТБ, не хочу дублировать в папку студии».
 *
 * Как работает:
 *   1. Пользователь добавляет папки в Настройках (категория = имя папки
 *      ComfyUI: diffusion_models, loras, vae, text_encoders, ...).
 *      Если добавлена папка со стандартной структурой (как models/ у
 *      ComfyUI) — подпапки раскладываются по категориям автоматически.
 *   2. Список пишется в config.ini ([models] extra_paths, JSON) и в
 *      ComfyUI/extra_model_paths.yaml — форк ComfyUI читает его при
 *      старте САМ (main.py:141), модели из внешних папок появляются в
 *      списках нод. Изменения требуют перезапуска start.bat.
 *   3. Списки студии (модели видео, LoRA) сканируют внешние папки теми же
 *      расширениями, имена — относительные пути (subdir/name.safetensors),
 *      как их видит ComfyUI.
 */
import { readdirSync, writeFileSync, statSync, readFileSync, mkdirSync } from 'fs'
import { join, relative, dirname } from 'path'
import { getAppConfig } from './app-config'

/** Категории, которые имеет смысл подключать извне (folder_paths форка). */
export const EXTRA_CATEGORIES: Array<{ key: string; label: string; exts: string[] }> = [
  { key: 'diffusion_models', label: 'Модели видео (diffusion/unet)', exts: ['.safetensors', '.ckpt', '.pt', '.bin', '.gguf'] },
  { key: 'loras', label: 'LoRA', exts: ['.safetensors', '.ckpt', '.pt'] }, // (правка 587) '.pt' без точки ловил любые имена на «pt»
  { key: 'vae', label: 'VAE', exts: ['.safetensors', '.ckpt', '.pt', '.bin'] },
  { key: 'vae_approx', label: 'VAE Approx (TAE)', exts: ['.safetensors'] },
  { key: 'veda', label: 'Veda Sparse Attention', exts: ['.safetensors'] },
  { key: 'text_encoders', label: 'Текстовые энкодеры (CLIP)', exts: ['.safetensors', '.bin', '.gguf'] },
  { key: 'latent_upscale_models', label: 'Латентные апскейлеры', exts: ['.safetensors', '.pt'] },
  { key: 'upscale_models', label: 'Пиксельные апскейлеры', exts: ['.safetensors', '.pt', '.pth'] },
]

/** Подпапки корня, означающие категорию (алиасы имён ComfyUI). */
const CATEGORY_ALIASES: Record<string, string> = {
  diffusion_models: 'diffusion_models',
  unet: 'diffusion_models',
  loras: 'loras',
  vae: 'vae',
  vae_approx: 'vae_approx',
  veda: 'veda',
  text_encoders: 'text_encoders',
  clip: 'text_encoders',
  latent_upscale_models: 'latent_upscale_models',
  upscale_models: 'upscale_models',
}

/** Есть ли у папки стандартная структура models/ (подпапки-категории)? */
export function looksLikeModelsRoot(dir: string): boolean {
  try {
    const subs = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory())
    return subs.some((e) => CATEGORY_ALIASES[e.name.toLowerCase()])
  } catch {
    return false
  }
}

/**
 * Разложить добавленную папку на записи {path, category}:
 * корень со стандартной структурой → по одной записи на подпапку-категорию;
 * иначе → одна запись с угаданной (по имени) или дефолтной категорией.
 */
export function detectExtraEntries(dir: string): Array<{ path: string; category: string }> {
  if (looksLikeModelsRoot(dir)) {
    const out: Array<{ path: string; category: string }> = []
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      const cat = CATEGORY_ALIASES[e.name.toLowerCase()]
      if (cat) out.push({ path: join(dir, e.name), category: cat })
    }
    return out
  }
  const name = dir.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  let guess = CATEGORY_ALIASES[name]
  if (!guess) {
    // Эвристика по подстроке: «my-loras», «VAE-backup», «unet_big» ...
    if (name.includes('lora')) guess = 'loras'
    else if (name.includes('vae')) guess = 'vae'
    else if (name.includes('unet') || name.includes('diffusion')) guess = 'diffusion_models'
    else if (name.includes('clip') || name.includes('encoder')) guess = 'text_encoders'
  }
  return [{ path: dir, category: guess ?? 'diffusion_models' }]
}

/** Путь до yaml рядом с main.py ComfyUI (форк читает его сам при старте). */
function yamlPath(): string {
  const cfg = getAppConfig()
  return join(cfg.comfyRoot, 'ComfyUI', 'extra_model_paths.yaml')
}

/**
 * (правка 722) Собственная запись студии: папка детекторов Face Refine.
 *
 * Категорию `ultralytics` в этой сборке никто не регистрирует (Impact Pack не
 * установлен), а H3FaceTrackCrop собирает из неё список детекторов — без
 * регистрации в комбо живёт только дефолтный face_yolov8m.pt, и модель
 * человека для fallback_detector выбрать нельзя. Путь относительный: yaml
 * лежит в папке ComfyUI, загрузчик форка считает относительные пути от неё.
 */
const STUDIO_EXTRA_ENTRIES = [{ config: 'minimax_studio_detectors', category: 'ultralytics', paths: ['models/ultralytics'] }]

/**
 * Записать extra_model_paths.yaml: всегда — собственную папку детекторов,
 * плюс внешние папки моделей из настроек. Вызывается при сохранении настроек
 * и на старте сервера. Возвращает true, если файл изменился (нужен перезапуск
 * ComfyUI).
 */
export function writeExtraModelPathsYaml(
  entries: Array<{ path: string; category: string }>,
): boolean {
  const valid = entries.filter((e) => {
    try {
      return statSync(e.path).isDirectory()
    } catch {
      return false
    }
  })
  const file = yamlPath()
  // Группируем по категории; пути — с прямыми слэшами (yaml-friendly).
  const byCat = new Map<string, string[]>()
  for (const e of valid) {
    const list = byCat.get(e.category) ?? []
    list.push(e.path.replace(/\\/g, '/'))
    byCat.set(e.category, list)
  }
  // Канонический формат ComfyUI: имя конфига → категория → список путей.
  // (Одноуровневый «категория: [пути]» ломал загрузчик форка — TypeError
  // на старте: он ждёт dict-категории внутри имени конфига.)
  const lines: string[] = ['# Сгенерировано Minimax Studio (Настройки → Свои папки моделей). Удалять вручную не нужно.']
  for (const e of STUDIO_EXTRA_ENTRIES) {
    lines.push(`${e.config}:`)
    lines.push(`    ${e.category}:`)
    for (const p of e.paths) lines.push(`        - "${p}"`)
  }
  if (byCat.size) {
    lines.push('minimax_studio:')
    for (const [cat, paths] of byCat) {
      lines.push(`    ${cat}:`)
      for (const p of paths) lines.push(`        - "${p}"`)
    }
  }
  const content = lines.join('\n') + '\n'
  let prev: string | null = null
  try {
    prev = readFileSync(file, 'utf-8')
  } catch {
    prev = null
  }
  if (prev !== content) {
    // Каталог ComfyUI может отсутствовать (свежая установка/переезд) — создаём.
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content, 'utf-8')
    return true
  }
  return false
}

/**
 * (правка 722) Переписать yaml из текущих настроек. Зовётся на старте
 * сервера — ComfyUI поднимается следом и читает файл при импорте, поэтому
 * папка детекторов успевает зарегистрироваться до сборки /object_info.
 */
export function syncExtraModelPathsYaml(): boolean {
  return writeExtraModelPathsYaml(getAppConfig().modelExtraPaths)
}


/**
 * Перечислить модели из внешних папок данной категории.
 * Возвращает имена-относительные-пути ('subdir/x.safetensors'), как их
 * ожидает ComfyUI. Рекурсия до 4 уровней, только файлы с нужным
 * расширением.
 */
export function listExternalModels(category: string): string[] {
  const cfg = getAppConfig()
  const cat = EXTRA_CATEGORIES.find((c) => c.key === category)
  if (!cat) return []
  const out: string[] = []
  for (const entry of cfg.modelExtraPaths) {
    if (entry.category !== category) continue
    let root: string
    try {
      root = entry.path
      if (!statSync(root).isDirectory()) continue
    } catch {
      continue
    }
    walk(root, root, 0, cat.exts, out)
  }
  return out
}

function walk(root: string, dir: string, depth: number, exts: string[], out: string[]) {
  if (depth > 4) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      walk(root, full, depth + 1, exts, out)
    } else if (exts.some((x) => e.name.toLowerCase().endsWith(x))) {
      out.push(relative(root, full).replace(/\\/g, '/'))
    }
  }
}
