/**
 * Central runtime app configuration, backed by config.ini next to the
 * project root. The backend folder (portable ComfyUI-Easy-Install root)
 * is user-configurable from the Settings dialog — all file routes read
 * it through getAppConfig() so a change applies without a restart.
 *
 * Precedence for the backend root:
 *   1. config.ini [comfy] comfy_dir
 *   2. env COMFY_ROOT
 *   3. ./ComfyUI-Easy-Install (default, next to the app)
 */
import { readFileSync, writeFileSync, renameSync, rmSync, existsSync, statSync, mkdirSync } from 'fs'
import { dirname, join, resolve } from 'path'

const CONFIG_PATH = join(process.cwd(), 'config', 'config.ini')

export interface AppConfig {
  reserveGb: number
  dynamicVram: boolean
  /** (правка 490) Доп. запас свободной VRAM для DynamicVRAM (--vram-headroom,
   *  ГБ; 0 = выкл). В отличие от reserveGb действует НЕПРЕРЫВНО (aimdo
   *  следит по NVML, включая чужие приложения), а не в точках решений —
   *  защита от всплесков активаций, которые перепрыгивают резерв. */
  vramHeadroom: number
  /** LLM assistant device: 'auto' (VRAM-based) | 'gpu' | 'cpu'. */
  llmDevice: 'auto' | 'gpu' | 'cpu'
  /** LLM context window size in tokens. */
  llmContextSize: number
  /** Max output tokens per LLM response (clamped to fit inside the context window). */
  llmMaxOutputTokens: number
  /** Root of the portable backend install (contains ComfyUI/ and python_embeded/). */
  comfyRoot: string
  /** ComfyUI output directory (gallery files). */
  outputDir: string
  /** ComfyUI input directory (reference uploads). */
  inputDir: string
  /** Embedded python executable for launching the backend. */
  pythonExe: string
  /** Custom diffusion model filename (empty = default). */
  diffusionModel: string
  /** Custom LLM model filename (empty = default Q4_K_M). */
  llmModel: string
  /** (правка 136 / Bonsai) Папка портативной сборки Bonsai 2 27B (llama.cpp\
   * + models). Модель ассистента llmModel='bonsai' запускается из неё. */
  llmBonsaiDir: string
  /** (правка 257) Абсолютный путь к СВОЕЙ модели ассистента (.gguf).
   *  Непустое значение = бэкенд 'custom': встроенный движок запускается
   *  с этим файлом вместо моделей из набора студии. */
  llmCustomModel: string
  /** (правка 257) mmproj-файл (зрение) для своей модели; пусто = только текст. */
  llmCustomMmproj: string
  /** (правка 257) Дополнительные папки моделей (вне папки студии):
   *  пишутся в ComfyUI/extra_model_paths.yaml + сканируются списками студии.
   *  Категория — имя папки ComfyUI (diffusion_models, loras, vae, ...). */
  modelExtraPaths: Array<{ path: string; category: string }>
  /** (правка 53) Ассистент смотрит кадры видео-референсов. Выкл по умолчанию:
   *  модель знает только о НАЛИЧИИ видео (экономия контекста). */
  llmVideoVision: boolean
  /** (правка 109) Квантизация KV-кэша LLM: 'off' (fp16) | 'q8_0' | 'q5_1' | 'q4_0'.
   *  Уменьшает потребление VRAM/RAM ценой небольшого падения качества. */
  llmKvCache: 'off' | 'q8_0' | 'q5_1' | 'q4_0'
  /** (правка 135b) Тонкая настройка сэмплинга LLM — ВКЛ/ВЫКЛ. */
  llmSamplingOverride: boolean
  /** (правка 135b) temperature — переопределение (если override вкл). */
  llmTemperature: number
  /** (правка 135b) top_p — переопределение (если override вкл). */
  llmTopP: number
  /** (правка 135b) top_k — переопределение (если override вкл). */
  llmTopK: number
  /** (правка 135b) min_p — переопределение (если override вкл). */
  llmMinP: number
  /** (правка 135b) presence_penalty — переопределение (если override вкл). */
  llmPresencePenalty: number
  /** (правка 135b) frequency_penalty — переопределение (если override вкл). */
  llmFrequencyPenalty: number
  /** (правка 135b) repeat_penalty — переопределение (если override вкл). */
  llmRepeatPenalty: number
  /** Play notification sound when generation completes (default true). */
  soundOn: boolean
  /** (правка 65) Голосовой ввод (whisper STT): включён ли диктат в UI. */
  sttEnabled: boolean
  /** (правка 72) Папка встроенного STT-рантайма (transcribe.dll + models/). Дефолт <проект>/stt. */
  sttDir: string
  /** (правка 65) Файл модели STT (имя в папках моделей; пусто = авто). */
  sttModel: string
  /** (правка 65) Язык распознавания: 'ru' | 'en' | 'auto'. */
  sttLanguage: string
  /** (правка 65) Потоки CPU (0 = авто). */
  sttThreads: number
  /** (правка 74) Вкладка Upscale (DLSS 5 Visual Enhancer): сервис включён. */
  upscaleEnabled: boolean
  /** (правка 74) Порт DLSS-моста Upscale (bridge.py, дефолт 7890). */
  upscalePort: number
  /** (правка 386) [video] Кодек видео-выходов: h264 | h265 | nvenc_h264 | nvenc_h265. */
  videoCodec: 'h264' | 'h265' | 'nvenc_h264' | 'nvenc_h265'
  /** (правка 386) [video] CRF программных кодеков (0–30, меньше = лучше). Default 12. */
  videoCrf: number
  /** (правка 386) [video] Битрейт NVENC, Мбит/с (4–40). Default 16. */
  videoNvencBitrate: number
}

/* ────────────────────────── INI parsing ────────────────────────── */

/** (правка 257) [models] extra_paths — JSON-массив [{path, category}]. */
function parseExtraPaths(raw: string): Array<{ path: string; category: string }> {
  const s = raw.trim()
  if (!s) return []
  try {
    const parsed = JSON.parse(s)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (e): e is { path: string; category: string } =>
          !!e && typeof e === 'object' &&
          typeof (e as { path?: unknown }).path === 'string' &&
          typeof (e as { category?: unknown }).category === 'string',
      )
      .map((e) => ({ path: e.path, category: e.category }))
  } catch {
    return []
  }
}

function parseIni(content: string): Record<string, string> {
  const result: Record<string, string> = {}
  let currentSection = ''
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      currentSection = trimmed.slice(1, -1)
      continue
    }
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim()
      const value = trimmed.slice(eqIdx + 1).trim()
      result[`${currentSection}.${key}`] = value
      // (правка 318) «Голые» ключи — только для реально читаемых legacy-
      // фолбэков (reserve_gb, dynamic_vram — см. getAppConfig ниже). Раньше
      // каждый ключ писался и голым: [llm] model и [stt] model затирали
      // друг друга (голый ini['model'] возвращал значение последней секции).
      if (key === 'reserve_gb' || key === 'dynamic_vram') {
        result[key] = value
      }
    }
  }
  return result
}

/* ────────────────────────── Cached reads ────────────────────────── */

/** (правка 556) Число из config.ini, где 0 — легитимное значение.
 *  Паттерн «parseFloat(v) || dflt» превращал сохранённый 0 в дефолт
 *  (llm.temperature=0 → 0.7 при sampling_override=1, video.crf=0 =
 *  максимум качества → 12): UI честно сохранял настройку, а чтение
 *  молча подменяло её. Дефолт — только при отсутствии/нечисловом значении. */
function parseNum0(v: string | undefined, dflt: number): number {
  if (v === undefined || v.trim() === '') return dflt
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : dflt
}

let cache: { mtimeMs: number; config: AppConfig } | null = null

export function getAppConfig(): AppConfig {
  let mtimeMs = 0
  try {
    mtimeMs = statSync(CONFIG_PATH).mtimeMs
  } catch {
    /* no config.ini yet — use defaults below */
  }
  if (cache && cache.mtimeMs === mtimeMs) return cache.config

  let ini: Record<string, string> = {}
  try {
    if (existsSync(CONFIG_PATH)) ini = parseIni(readFileSync(CONFIG_PATH, 'utf-8'))
  } catch {
    /* unreadable config — fall back to defaults */
  }

  const rawRoot =
    (ini['comfy.comfy_dir'] ?? '').trim() ||
    (process.env.COMFY_ROOT || '').trim() ||
    join(process.cwd(), 'ComfyUI-Easy-Install')
  const comfyRoot = resolve(rawRoot)

  // (правка 314) Минимум контекста унифицирован с POST-валидацией: 4096
  // (раньше чтение клампило снизу до 8192, а POST принимал от 4096 —
  // сохранённое 4096 «прыгало» обратно в 8192).
  const ctxSize = Math.max(4096, Math.min(102400, parseInt(ini['llm.context_size'] ?? '25600', 10) || 25600))
  const config: AppConfig = {
    // (правка 716) parseNum0, а не `|| 3`: сохранённый reserve_gb = 0
    // (валидное значение) молча превращался в 3. Правка 556 убрала этот
    // паттерн в остальных полях — здесь он остался.
    reserveGb: parseNum0(ini['vram.reserve_gb'] ?? ini['reserve_gb'] ?? '3', 3),
    // (правка 490) 0 = выкл (флаг не передаётся), диапазон как в UI: 0–8 ГБ.
    // По умолчанию 2 ГБ: aimdo держит этот запас свободным даже при чужих
    // приложениях, не давая DynamicVRAM занять всю карту под веса.
    vramHeadroom: Math.max(0, Math.min(8, parseFloat(ini['vram.vram_headroom'] ?? '2') || 0)),
    // Canonical home is [vram]; [comfy]/bare kept as read fallbacks for
    // configs written by older versions.
    dynamicVram: (ini['vram.dynamic_vram'] ?? ini['comfy.dynamic_vram'] ?? ini['dynamic_vram'] ?? '1') !== '0',
    llmDevice: (['auto', 'gpu', 'cpu'].includes(ini['llm.device'] ?? '')
      ? ini['llm.device']
      : 'auto') as AppConfig['llmDevice'],
    // (правка 119) контекст ассистента: по умолчанию 25K, максимум 100K токенов
    llmContextSize: ctxSize,
    // (правка 313) Макс. длина ответа не может превышать контекстное окно:
    // заявленный в docstring кламп под контекст отсутствовал — при ctx 4096
    // и max_output 16384 chat-роут получал заведомо невыполнимый бюджет.
    llmMaxOutputTokens: Math.max(256, Math.min(ctxSize, 16384, parseInt(ini['llm.max_output_tokens'] ?? '4096', 10) || 4096)),
    comfyRoot,
    outputDir: join(comfyRoot, 'ComfyUI', 'output'),
    inputDir: join(comfyRoot, 'ComfyUI', 'input'),
    pythonExe: join(comfyRoot, 'python_embeded', 'python.exe'),
    diffusionModel: (ini['comfy.diffusion_model'] ?? '').trim(),
    llmModel: (ini['llm.model'] ?? '').trim(),
    // (правка 136) Bonsai теперь живёт ВНУТРИ проекта (<проект>/Bonsai_2_27B)
    // — дефолт относительный, проект переносим. Внешний путь при желании
    // задаётся в config.ini: [llm] bonsai_dir=...
    llmBonsaiDir: (ini['llm.bonsai_dir'] ?? '').trim() || join(process.cwd(), 'Bonsai_2_27B'),
    // (правка 257) Своя LLM + внешние папки моделей
    llmCustomModel: (ini['llm.custom_model_path'] ?? '').trim(),
    llmCustomMmproj: (ini['llm.custom_mmproj_path'] ?? '').trim(),
    modelExtraPaths: parseExtraPaths(ini['models.extra_paths'] ?? ''),
    // (правка 53) по умолчанию ВЫКЛ: ассистент не тратит контекст на кадры видео
    llmVideoVision: ini['llm.video_vision'] === '1',
    // (правка 109) квантизация KV-кэша; (правка 119) по умолчанию q4_0 — экономия памяти
    llmKvCache: (['off', 'q8_0', 'q5_1', 'q4_0'].includes(ini['llm.kv_cache'] ?? '')
      ? ini['llm.kv_cache']
      : 'q4_0') as AppConfig['llmKvCache'],
    // (правка 135b) тонкая настройка сэмплинга LLM — по умолчанию ВЫКЛ,
    // тогда route.ts использует модель-осознанные значения из llm-sampling.ts.
    // Если ВКЛ — пользовательские значения ниже применяются.
    llmSamplingOverride: ini['llm.sampling_override'] === '1',
    // (правка 556) parseNum0 — 0 легитимен (детерминированный сэмплинг).
    llmTemperature: parseNum0(ini['llm.temperature'], 0.7),
    llmTopP: parseNum0(ini['llm.top_p'], 0.95),
    llmTopK: Math.max(1, Math.min(200, parseInt(ini['llm.top_k'] ?? '40', 10) || 40)),
    llmMinP: Math.max(0, Math.min(1, parseNum0(ini['llm.min_p'], 0.05))),
    llmPresencePenalty: Math.max(0, Math.min(2.5, parseFloat(ini['llm.presence_penalty'] ?? '0.0') || 0.0)),
    llmFrequencyPenalty: Math.max(0, Math.min(2.5, parseFloat(ini['llm.frequency_penalty'] ?? '0.0') || 0.0)),
    llmRepeatPenalty: Math.max(1.0, Math.min(2.0, parseFloat(ini['llm.repeat_penalty'] ?? '1.0') || 1.0)),
    soundOn: ini['ui.sound_on'] !== '0',
    // (правка 65) Голосовой ввод — whisper (transcribe.cpp), CPU-only.
    // По умолчанию ВКЛ: кнопка диктата видна, а при отсутствии модели
    // показывает понятную ошибку с подсказкой, где её скачать.
    sttEnabled: ini['stt.enabled'] !== '0',
    // (правка 72) STT-рантайм встроен в проект: <проект>/stt (переопределяется в config.ini).
    sttDir: (ini['stt.dir'] ?? '').trim() || join(process.cwd(), 'stt'),
    sttModel: (ini['stt.model'] ?? '').trim(),
    sttLanguage: (['auto', 'ru', 'en'].includes(ini['stt.language'] ?? '')
      ? ini['stt.language']
      : 'ru') as string,
    sttThreads: Math.max(0, Math.min(32, parseInt(ini['stt.threads'] ?? '0', 10) || 0)),
    // (правка 74) Upscale (DLSS 5 Visual Enhancer) — встроенная папка upscale/.
    upscaleEnabled: ini['upscale.enabled'] !== '0',
    upscalePort: Math.max(1024, Math.min(65535, parseInt(ini['upscale.port'] ?? '7890', 10) || 7890)),
    // (правка 386) [video] Формат сохранения: кодек + качество (CRF/NVENC-битрейт).
    videoCodec: (['h264', 'h265', 'nvenc_h264', 'nvenc_h265'].includes(ini['video.codec'] ?? '')
      ? ini['video.codec']
      : 'h264') as AppConfig['videoCodec'],
    // (правка 556) crf=0 легитимен (0–30, меньше = лучше) — parseNum0.
    videoCrf: Math.max(0, Math.min(30, parseNum0(ini['video.crf'], 12))),
    videoNvencBitrate: Math.max(4, Math.min(40, parseInt(ini['video.nvenc_bitrate'] ?? '16', 10) || 16)),
  }
  cache = { mtimeMs, config }
  return config
}

/* ────────────────────────── Writing ────────────────────────── */

/**
 * Set a single `key = value` line inside an INI section, preserving the
 * rest of the file. Creates the section when missing. Resets the cache.
 */
export function setConfigValue(section: string, key: string, value: string): void {
  let content = ''
  try {
    content = readFileSync(CONFIG_PATH, 'utf-8')
  } catch {
    content = ''
  }
  // A newline inside a value would corrupt the INI layout — strip
  // line breaks and other control characters defensively.
  const safeValue = value.replace(/[\r\n\0]/g, ' ').trim()
  const lines = content.split(/\r?\n/)

  let inSection = false
  let sectionStart = -1
  let replaced = false
  let insertAt = -1

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    if (t.startsWith('[') && t.endsWith(']')) {
      if (inSection) break // reached the next section
      inSection = t.slice(1, -1) === section
      if (inSection) sectionStart = i
      continue
    }
    if (inSection) {
      // (правка 716) Ключ сравниваем с допуском пробелов вокруг '=': парсер
      // ini (выше) принимает «key = value», а этот поиск — нет. Из-за
      // этого в файл с пробелами добавлялся ДУБЛЬ ключа с другим значением.
      const eqIdx = t.indexOf('=')
      if (eqIdx > 0 && t.slice(0, eqIdx).trim().toLowerCase() === key.toLowerCase()) {
        lines[i] = `${key}=${safeValue}`
        replaced = true
        break
      }
      insertAt = i + 1 // after the last line inside the section
    }
  }

  if (!replaced) {
    if (sectionStart >= 0) {
      // (правка 317) Вставка в КОНЕЦ секции (insertAt — позиция после
      // последней строки секции): раньше insertAt вычислялся, но не
      // использовался — новый ключ попадал сразу после заголовка секции.
      lines.splice(Math.max(insertAt, sectionStart + 1), 0, `${key}=${safeValue}`)
    } else {
      lines.push('', `[${section}]`, `${key}=${safeValue}`)
    }
  }

  // (правка 312) Атомарная запись: temp-файл + rename, как .part-подход в
  // /api/loras. Прямой writeFileSync мог оставить обрезанный config.ini при
  // сбое посередине записи. На Windows rename поверх существующего файла в
  // Node работает (MOVEFILE_REPLACE_EXISTING), но на всякий случай при
  // ошибке удаляем цель и повторяем.
  const tmpPath = CONFIG_PATH + '.tmp'
  writeFileSync(tmpPath, lines.join('\n'), 'utf-8')
  try {
    renameSync(tmpPath, CONFIG_PATH)
  } catch {
    try { rmSync(CONFIG_PATH, { force: true }) } catch { /* ignore */ }
    renameSync(tmpPath, CONFIG_PATH)
  }
  cache = null
}

/* ─────────────────────── Полный сброс конфига ─────────────────────── */

/**
 * Заводское содержимое config.ini.
 *
 * (полный сброс) Раньше «Заводской сброс» перезаписывал только часть
 * ключей через POST /api/config: `comfy_dir`, `upscale.*`, `video.*`,
 * `async_offload` и прочее оставались пользовательскими. Для полного
 * сброса «как с завода» файл перезаписывается целиком этим шаблоном.
 * Значения совпадают с дефолтами кода (getAppConfig) и с config.ini
 * репозитория, поэтому после сброса программа ведёт себя как при
 * первой установке.
 */
const DEFAULT_CONFIG_INI = `[vram]
reserve_gb=3
dynamic_vram=1
; 0 = синхронная загрузка моделей (стабильно), 1 = async-офлоад
async_offload=0
vram_headroom=2

[comfy]
turbo_lora=
; Пусто = дефолтная diffusion-модель из кода
diffusion_model=
; comfy_dir не задан = ./ComfyUI-Easy-Install рядом с программой

[llm]
custom_mmproj_path=
custom_model_path=
repeat_penalty=1
frequency_penalty=0
presence_penalty=0
min_p=0.05
top_k=40
top_p=0.95
temperature=0.7
sampling_override=0
kv_cache=q4_0
video_vision=0
model=Qwen3.5-9B-Q4_K_M.gguf
max_output_tokens=4096
context_size=25600
device=auto

[ui]
sound_on=1

[stt]
dir=
threads=0
language=ru
model=
enabled=1

[upscale]
enabled=1
port=7890

[models]
extra_paths=[]

[video]
codec=h264
crf=12
nvenc_bitrate=16
`

/**
 * (полный сброс) Перезаписать config/config.ini заводскими значениями.
 * Атомарно (tmp + rename), как setConfigValue: сбой посреди записи не
 * оставит обрезанный файл.
 */
export function resetConfigToDefaults(): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true })
  const tmpPath = CONFIG_PATH + '.tmp'
  writeFileSync(tmpPath, DEFAULT_CONFIG_INI, 'utf-8')
  try {
    renameSync(tmpPath, CONFIG_PATH)
  } catch {
    try { rmSync(CONFIG_PATH, { force: true }) } catch { /* ignore */ }
    renameSync(tmpPath, CONFIG_PATH)
  }
  cache = null
}
