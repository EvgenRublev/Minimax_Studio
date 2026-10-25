import { NextResponse } from 'next/server'
import { statSync, readdirSync } from 'fs'
import { join, resolve, basename } from 'path'
import { getAppConfig, setConfigValue } from '@/lib/app-config'
import { llmStatus, stopLlm } from '@/lib/llm-runner'
import { sttStatus, stopStt } from '@/lib/stt-runner'
import { writeExtraModelPathsYaml, EXTRA_CATEGORIES } from '@/lib/extra-model-paths'

/** (правка 262) Папка существует как каталог (для UI-индикатора и валидации). */
function isExistingDir(p: string): boolean {
  try { return statSync(p).isDirectory() } catch { return false }
}

/**
 * (правка 308) Резолвинг «своя LLM»: значением может быть ФАЙЛ .gguf
 * (возвращаем как есть) или ПАПКА — тогда берём первый подходящий файл
 * внутри неё (дальше по коду всегда ожидается файл: llm_server.py открывает
 * путь через open('rb')). Для mmproj ищем файл с 'mmproj' в имени
 * (или расширением .mmproj); для модели — .gguf БЕЗ 'mmproj' в имени.
 * Возвращает { path } при успехе или { error } с текстом для 400.
 *
 * (релиз) Три правки:
 *  1. ПРОВЕРЯЕМ РАСШИРЕНИЕ файла. Раньше принимался ЛЮБОЙ файл — в том числе
 *     README.md или картинка: конфиг принимал значение, а ошибка всплывала
 *     уже при запуске LLM, невнятным текстом от llama.cpp.
 *  2. Ищем В ПОДПАПКАХ (2 уровня). Студия сама раскладывает LLM-модели в
 *     подпапки (llm/qwen3.5-9b/…), и папка, выбранная пользователем, почти
 *     всегда содержит модель не в корне, а во вложенной.
 *  3. Результат — АБСОЛЮТНЫЙ путь (resolve). Относительный путь из
 *     config.ini разрешался от CWD процесса и тихо ломался при переносе
 *     папки или запуске не из корня проекта.
 */
function resolveGgufPath(input: string, kind: 'model' | 'mmproj'): { path: string } | { error: string } {
  const isModel = kind === 'model'
  const label = isModel ? 'Файл модели' : 'mmproj-файл'
  let st
  try { st = statSync(input) } catch {
    return { error: `${label} не найден: ${input}` }
  }

  if (st.isFile()) {
    const lower = input.toLowerCase()
    const isGguf = lower.endsWith('.gguf') || lower.endsWith('.mmproj')
    if (!isGguf) {
      return { error: `${label} должен быть файлом .gguf (указано: ${basename(input)})` }
    }
    // Для модели: mmproj-файл — не модель. Для mmproj: расширение .gguf
    // подходит (реальные проекторы называются mmproj-F16.gguf и т.п.).
    if (isModel && lower.includes('mmproj')) {
      return { error: 'Это mmproj-файл (проектор зрения), а не модель — укажите .gguf модели' }
    }
    return { path: resolve(input) }
  }

  if (!st.isDirectory()) {
    return { error: `Путь не является файлом или папкой: ${input}` }
  }

  // Собираем кандидатов: сначала корень папки, затем подпапки (2 уровня).
  // Сортировка по полному пути — выбор детерминирован.
  const candidates: string[] = []
  const collect = (dir: string, depth: number) => {
    if (depth > 2) return
    let entries: string[]
    try { entries = readdirSync(dir) } catch { return }
    for (const name of entries) {
      const full = join(dir, name)
      let isDir = false
      try { isDir = statSync(full).isDirectory() } catch { /* ignore */ }
      if (isDir) collect(full, depth + 1)
      else candidates.push(full)
    }
  }
  collect(input, 0)
  candidates.sort()

  const ggufs = candidates.filter(
    (f) => f.toLowerCase().endsWith('.gguf') || f.toLowerCase().endsWith('.mmproj'),
  )
  const match = isModel
    ? ggufs.find((f) => f.toLowerCase().endsWith('.gguf') && !f.toLowerCase().includes('mmproj'))
    : (ggufs.find((f) => f.toLowerCase().includes('mmproj')) ??
       ggufs.find((f) => f.toLowerCase().endsWith('.mmproj')))

  if (!match) {
    return {
      error: isModel
        ? `В папке нет .gguf-модели: ${input}`
        : `В папке нет mmproj-файла: ${input}`,
    }
  }
  return { path: resolve(match) }
}

/**
 * GET /api/config — runtime app settings (config.ini).
 * POST /api/config — update settings: { reserve_gb?, dynamic_vram?, llm_device?, comfy_dir? }.
 *
 * comfy_dir is the root of the portable backend install (the folder that
 * contains ComfyUI/ and python_embeded/). Changing it re-points every
 * file route immediately — no restart needed.
 *
 * llm_device ('auto'|'gpu'|'cpu') re-modes the LLM assistant: the running
 * instance (if any) is stopped so the next chat message reloads it with
 * the new device.
 */
export async function GET() {
  try {
    const config = getAppConfig()
    return NextResponse.json({
      reserve_gb: config.reserveGb,
      dynamic_vram: config.dynamicVram,
      vram_headroom: config.vramHeadroom, // (правка 490)
      llm_device: config.llmDevice,
      llm_context_size: config.llmContextSize,
      llm_max_output_tokens: config.llmMaxOutputTokens,
      comfy_dir: config.comfyRoot,
      diffusion_model: config.diffusionModel,
      llm_model: config.llmModel,
      // (правка 136 / Bonsai) папка портативной сборки Bonsai 2 27B
      llm_bonsai_dir: config.llmBonsaiDir,
      // (правка 257) своя LLM (.gguf + mmproj) и внешние папки моделей
      llm_custom_model: config.llmCustomModel,
      llm_custom_mmproj: config.llmCustomMmproj,
      model_extra_paths: config.modelExtraPaths.map((e) => ({ ...e, exists: isExistingDir(e.path) })),
      // (правка 53) видение видео ассистентом — по умолчанию false
      llm_video_vision: config.llmVideoVision,
      // (правка 109) квантизация KV-кэша LLM — по умолчанию off (fp16)
      llm_kv_cache: config.llmKvCache,
      // (правка 135b) тонкая настройка сэмплинга LLM
      llm_sampling_override: config.llmSamplingOverride,
      llm_temperature: config.llmTemperature,
      llm_top_p: config.llmTopP,
      llm_top_k: config.llmTopK,
      llm_min_p: config.llmMinP,
      llm_presence_penalty: config.llmPresencePenalty,
      llm_frequency_penalty: config.llmFrequencyPenalty,
      llm_repeat_penalty: config.llmRepeatPenalty,
      sound_on: config.soundOn,
      // (правка 65) голосовой ввод — whisper STT (CPU)
      stt_enabled: config.sttEnabled,
      stt_dir: config.sttDir,
      stt_model: config.sttModel,
      stt_language: config.sttLanguage,
      stt_threads: config.sttThreads,
      // (правка 386) формат сохранения видео ([video] в config.ini)
      video_codec: config.videoCodec,
      video_crf: config.videoCrf,
      video_nvenc_bitrate: config.videoNvencBitrate,
    })
  } catch {
    // (правка 119) дефолты: контекст 25K, KV-кэш Q4
    // (правка 135b) сэмплинг — override выкл, значения модель-осознанные
    // (правка 316) llm_bonsai_dir/llm_custom_*/model_extra_paths — дефолты,
    // чтобы контракт GET при ошибке совпадал с обычным ответом.
    return NextResponse.json({ reserve_gb: 3, dynamic_vram: true, vram_headroom: 2, llm_device: 'auto', llm_context_size: 25600, llm_max_output_tokens: 4096, comfy_dir: '', diffusion_model: '', llm_model: '', llm_bonsai_dir: '', llm_custom_model: '', llm_custom_mmproj: '', model_extra_paths: [], llm_video_vision: false, llm_kv_cache: 'q4_0', llm_sampling_override: false, llm_temperature: 0.7, llm_top_p: 0.95, llm_top_k: 40, llm_min_p: 0.05, llm_presence_penalty: 0.0, llm_frequency_penalty: 0.0, llm_repeat_penalty: 1.0, sound_on: true, stt_enabled: true, stt_dir: '', stt_model: '', stt_language: 'ru', stt_threads: 0, video_codec: 'h264', video_crf: 12, video_nvenc_bitrate: 16 })
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json()

    // (правка 716) ВАЛИДАЦИЯ ДО ЗАПИСЕЙ. Раньше проверки выполнялись по ходу
    // обработки, а записи в config.ini к тому моменту УЖЕ произошли. При
    // ошибке (несуществующая папка ComfyUI/Bonsai, битый .gguf, отсутствующая
    // папка моделей) клиент получал 400, но codec/CRF/VRAM/device/context уже
    // были записаны — расхождение конфига без единой ошибки. Теперь все
    // «могущие ответить 400» поля проверяются ЗАРАНЕЕ, и при любой ошибке
    // НИ ОДНОГО значения не пишется.
    const pre: {
      comfyDir?: string
      bonsaiDir?: string
      sttDir?: string
      customModel?: string
      customMmproj?: string
      extraPaths?: Array<{ path: string; category: string }>
    } = {}

    if (typeof body.comfy_dir === 'string') {
      const v = body.comfy_dir.trim()
      if (v && !isExistingDir(v)) {
        return NextResponse.json(
          { error: `Папка ComfyUI не найдена: ${v}` },
          { status: 400 },
        )
      }
      pre.comfyDir = v
    }

    if (typeof body.llm_bonsai_dir === 'string') {
      const v = body.llm_bonsai_dir.trim()
      if (v && !isExistingDir(v)) {
        return NextResponse.json(
          { error: `Папка Bonsai не найдена: ${v}` },
          { status: 400 },
        )
      }
      pre.bonsaiDir = v
    }

    // (релиз) Папка рантайма STT — тот же контракт, что у comfy_dir и
    // llm_bonsai_dir: непустое значение = существующая папка. Раньше путь
    // писался в конфиг как есть, и опечатка всплывала только при старте
    // дикта («STT-сервер не запустился»), уже во время работы.
    if (typeof body.stt_dir === 'string') {
      const v = body.stt_dir.trim()
      if (v && !isExistingDir(v)) {
        return NextResponse.json(
          { error: `Папка голосового ввода не найдена: ${v}` },
          { status: 400 },
        )
      }
      pre.sttDir = v
    }

    if (typeof body.llm_custom_model === 'string') {
      const v = body.llm_custom_model.trim()
      if (v) {
        const r = resolveGgufPath(v, 'model')
        if ('error' in r) {
          return NextResponse.json({ error: r.error }, { status: 400 })
        }
        pre.customModel = r.path
      } else {
        pre.customModel = ''
      }
    }

    if (typeof body.llm_custom_mmproj === 'string') {
      const v = body.llm_custom_mmproj.trim()
      if (v) {
        const r = resolveGgufPath(v, 'mmproj')
        if ('error' in r) {
          return NextResponse.json({ error: r.error }, { status: 400 })
        }
        pre.customMmproj = r.path
      } else {
        pre.customMmproj = ''
      }
    }

    if (Array.isArray(body.model_extra_paths)) {
      const validCats = new Set(EXTRA_CATEGORIES.map((c) => c.key))
      const entries = (body.model_extra_paths as unknown[])
        .filter(
          (e): e is { path: string; category: string } =>
            !!e && typeof e === 'object' &&
            typeof (e as { path?: unknown }).path === 'string' &&
            typeof (e as { category?: unknown }).category === 'string' &&
            validCats.has((e as { category?: unknown }).category as string),
        )
        .map((e) => ({ path: e.path.trim(), category: e.category }))
        .filter((e) => e.path.length > 0)
      if (entries.length > 0) {
        const missing = entries.filter((e) => !isExistingDir(e.path))
        if (missing.length > 0) {
          return NextResponse.json(
            { error: `Папки не найдены: ${missing.map((e) => e.path).join(', ')}` },
            { status: 400 },
          )
        }
      }
      pre.extraPaths = entries
    }

    // (правка 386) Формат сохранения видео: применяется ко ВСЕМ новым
    // задачам (генерация/рефайн/продление/тайлы/FPS/обрезка/склейки) без
    // перезапуска — шаблоны читают конфиг при сборке воркфлоу.
    if (body.video_codec !== undefined) {
      const codec = ['h264', 'h265', 'nvenc_h264', 'nvenc_h265'].includes(body.video_codec)
        ? body.video_codec
        : 'h264'
      setConfigValue('video', 'codec', codec)
    }
    if (body.video_crf !== undefined) {
      // (правка 556) crf=0 легитимен (0–30, меньше = лучше): parseInt()||12
      // превращал сохранённый 0 в дефолт 12 — дефолт только для не-числа.
      const parsedCrf = parseInt(body.video_crf, 10)
      const crf = Math.max(0, Math.min(30, Number.isFinite(parsedCrf) ? parsedCrf : 12))
      setConfigValue('video', 'crf', String(crf))
    }
    if (body.video_nvenc_bitrate !== undefined) {
      const br = Math.max(4, Math.min(40, parseInt(body.video_nvenc_bitrate, 10) || 16))
      setConfigValue('video', 'nvenc_bitrate', String(br))
    }

    if (body.reserve_gb !== undefined) {
      // (правка 315) Диапазон унифицирован с UI-слайдером: 1–16 ГБ
      const reserveGb = Math.max(1, Math.min(16, parseFloat(body.reserve_gb) || 3))
      setConfigValue('vram', 'reserve_gb', String(reserveGb))
    }

    if (body.dynamic_vram !== undefined) {
      // Written to [vram] next to reserve_gb — start_comfy.bat reads both
      // from there (single source of truth; [comfy] was a legacy duplicate).
      setConfigValue('vram', 'dynamic_vram', body.dynamic_vram ? '1' : '0')
    }

    // (правка 490) Доп. запас свободной VRAM для DynamicVRAM
    // (--vram-headroom в start_comfy.bat). 0 = выкл, диапазон 0–8 ГБ.
    if (body.vram_headroom !== undefined) {
      const headroom = Math.max(0, Math.min(8, parseFloat(body.vram_headroom) || 0))
      setConfigValue('vram', 'vram_headroom', String(headroom))
    }

    if (body.llm_device !== undefined) {
      const dev = ['auto', 'gpu', 'cpu'].includes(body.llm_device) ? body.llm_device : 'auto'
      // Перезапуск ТОЛЬКО при фактическом изменении: диалог всегда шлёт
      // device/ctx/kv_cache, и «Сохранить» без правок убивало загруженную
      // модель с холодной перезагрузкой на следующем сообщении.
      const changed = getAppConfig().llmDevice !== dev
      setConfigValue('llm', 'device', dev)
      // Re-mode the running assistant: stop it so the next chat message
      // reloads the model on the newly selected device.
      if (changed && llmStatus().running) await stopLlm()
    }

    if (body.llm_context_size !== undefined) {
      // (правка 119) максимум контекста — 100K токенов, дефолт — 25K
      const ctx = Math.max(4096, Math.min(102400, parseInt(body.llm_context_size, 10) || 25600))
      const ctxChanged = getAppConfig().llmContextSize !== ctx
      setConfigValue('llm', 'context_size', String(ctx))
      // Context size is baked into the Llama instance — restart to apply.
      if (ctxChanged && llmStatus().running) await stopLlm()
    }

    if (body.llm_max_output_tokens !== undefined) {
      const out = Math.max(256, Math.min(16384, parseInt(body.llm_max_output_tokens, 10) || 4096))
      setConfigValue('llm', 'max_output_tokens', String(out))
      // Applied per-request on the next chat message — no LLM restart needed.
    }

    // (правка 310) comfy_dir: непустое значение должно быть СУЩЕСТВУЮЩЕЙ
    // папкой (раньше писалось вслепую — и все файловые роуты молча ломались);
    // пустая строка = сброс к дефолту (<проект>/ComfyUI-Easy-Install), раньше
    // пустая строка отсекалась и сбросить путь было нельзя.
    if (typeof body.comfy_dir === 'string') {
      // (правка 716) Значение уже проверено в пре-валидации (см. начало POST).
      setConfigValue('comfy', 'comfy_dir', pre.comfyDir ?? '')
    }

    if (typeof body.diffusion_model === 'string') {
      setConfigValue('comfy', 'diffusion_model', body.diffusion_model.trim())
    }

    if (typeof body.llm_model === 'string') {
      const modelChanged = getAppConfig().llmModel !== body.llm_model.trim()
      setConfigValue('llm', 'model', body.llm_model.trim())
      // Model file change requires LLM restart to load the new file.
      if (modelChanged && llmStatus().running) await stopLlm()
    }

    // (правка 136 / Bonsai) папка внешней сборки Bonsai: смена пути требует
    // перезапуска ассистента (файлы модели грузятся из этой папки).
    // (правка 310) непустое значение — только существующая папка (400 иначе);
    // пустая строка = сброс к дефолту (<проект>/Bonsai_2_27B).
    if (typeof body.llm_bonsai_dir === 'string') {
      // (правка 716) Проверено в пре-валидации.
      const v = pre.bonsaiDir ?? ''
      const dirChanged = getAppConfig().llmBonsaiDir !== v
      setConfigValue('llm', 'bonsai_dir', v)
      if (dirChanged && llmStatus().running) await stopLlm()
    }

    // (правка 257) Своя LLM: пути к .gguf и mmproj. Пустая строка — валидное
    // значение (возврат к встроенным моделям). Смена — с перезапуском LLM.
    // (правка 262) Непустой путь — проверяем существование ДО записи в конфиг:
    // молчание (yaml без записей / ассистент «модель не найдена») — худший
    // исход, явная ошибка — сразу.
    // (правка 308) Значением может быть файл ИЛИ папка (UI предлагает выбрать
    // папку): папка резолвится в первый подходящий файл внутри неё, и в конфиг
    // сохраняется уже конкретный ФАЙЛ — дальше по коду (llm_server.py:
    // open(model_path,'rb')) всегда ожидается именно файл.
    if (typeof body.llm_custom_model === 'string') {
      // (правка 716) Разрешённый путь уже вычислен и проверен в пре-валидации.
      const resolved = pre.customModel ?? ''
      const changed = getAppConfig().llmCustomModel !== resolved
      setConfigValue('llm', 'custom_model_path', resolved)
      if (changed && llmStatus().running) await stopLlm()
    }
    if (typeof body.llm_custom_mmproj === 'string') {
      // (правка 716) Разрешённый путь уже вычислен и проверен в пре-валидации.
      const resolved = pre.customMmproj ?? ''
      const changed = getAppConfig().llmCustomMmproj !== resolved
      setConfigValue('llm', 'custom_mmproj_path', resolved)
      if (changed && llmStatus().running) await stopLlm()
    }

    // (правка 257) Внешние папки моделей: сохраняем список + перезаписываем
    // ComfyUI/extra_model_paths.yaml (форк читает его при старте сам).
    let extraPathsRestart = false
    if (Array.isArray(body.model_extra_paths)) {
      // (правка 716) Список уже нормализован и проверен в пре-валидации.
      const entries = pre.extraPaths ?? []
      const prev = getAppConfig().modelExtraPaths
      const same =
        prev.length === entries.length &&
        prev.every((p, i) => p.path === entries[i].path && p.category === entries[i].category)
      setConfigValue('models', 'extra_paths', JSON.stringify(entries))
      if (!same) extraPathsRestart = writeExtraModelPathsYaml(entries)
    }

    // (правка 53) Видение видео ассистентом: применяется к каждому запросу
    // чата — перезапуск LLM не нужен.
    if (typeof body.llm_video_vision === 'boolean') {
      setConfigValue('llm', 'video_vision', body.llm_video_vision ? '1' : '0')
    }

    // (правка 109) Квантизация KV-кэша LLM: параметр зашивается в Llama-инстанс
    // (type_k/type_v) при создании контекста — запущенный сервер перезапускаем,
    // новый загрузится с выбранным типом.
    if (typeof body.llm_kv_cache === 'string' && ['off', 'q8_0', 'q5_1', 'q4_0'].includes(body.llm_kv_cache)) {
      const kvChanged = getAppConfig().llmKvCache !== body.llm_kv_cache
      setConfigValue('llm', 'kv_cache', body.llm_kv_cache)
      if (kvChanged && llmStatus().running) await stopLlm()
    }

    // (правка 135b) Тонкая настройка сэмплинга LLM — применяется к каждому
    // запросу (per-request), перезапуск LLM не нужен.
    if (typeof body.llm_sampling_override === 'boolean') {
      setConfigValue('llm', 'sampling_override', body.llm_sampling_override ? '1' : '0')
    }
    if (typeof body.llm_temperature === 'number') {
      setConfigValue('llm', 'temperature', String(Math.max(0, Math.min(2.0, body.llm_temperature))))
    }
    if (typeof body.llm_top_p === 'number') {
      setConfigValue('llm', 'top_p', String(Math.max(0, Math.min(1.0, body.llm_top_p))))
    }
    if (typeof body.llm_top_k === 'number') {
      setConfigValue('llm', 'top_k', String(Math.max(1, Math.min(200, Math.round(body.llm_top_k)))))
    }
    if (typeof body.llm_min_p === 'number') {
      setConfigValue('llm', 'min_p', String(Math.max(0, Math.min(1.0, body.llm_min_p))))
    }
    if (typeof body.llm_presence_penalty === 'number') {
      setConfigValue('llm', 'presence_penalty', String(Math.max(0, Math.min(2.5, body.llm_presence_penalty))))
    }
    if (typeof body.llm_frequency_penalty === 'number') {
      setConfigValue('llm', 'frequency_penalty', String(Math.max(0, Math.min(2.5, body.llm_frequency_penalty))))
    }
    if (typeof body.llm_repeat_penalty === 'number') {
      setConfigValue('llm', 'repeat_penalty', String(Math.max(1.0, Math.min(2.0, body.llm_repeat_penalty))))
    }

    if (typeof body.sound_on === 'boolean') {
      setConfigValue('ui', 'sound_on', body.sound_on ? '1' : '0')
    }

    // (правка 65) Голосовой ввод (whisper STT). Изменения применяются со
    // следующего диктата: запущенный сервис останавливаем (перезапустится
    // сам при первом же использовании с новыми параметрами).
    let sttChanged = false
    if (typeof body.stt_enabled === 'boolean') {
      setConfigValue('stt', 'enabled', body.stt_enabled ? '1' : '0')
      sttChanged = true
    }
    // Пустая строка — ВАЛИДНОЕ значение (сброс к дефолту <project>/stt):
    // прежний guard `.trim()` молча съедал его, и кастомная папка переживала
    // «Сброс настроек» и заводской сброс вопреки обещанию диалога.
    if (typeof body.stt_dir === 'string') {
      // (релиз) Проверено в пре-валидации (существующая папка).
      setConfigValue('stt', 'dir', (pre.sttDir ?? '').trim())
      sttChanged = true
    }
    if (typeof body.stt_model === 'string') {
      setConfigValue('stt', 'model', body.stt_model.trim())
      sttChanged = true
    }
    if (typeof body.stt_language === 'string' && ['auto', 'ru', 'en'].includes(body.stt_language)) {
      setConfigValue('stt', 'language', body.stt_language)
      sttChanged = true
    }
    if (typeof body.stt_threads === 'number') {
      setConfigValue('stt', 'threads', String(Math.max(0, Math.min(32, Math.round(body.stt_threads)))))
      sttChanged = true
    }
    if (sttChanged && sttStatus().running) {
      await stopStt()
    }

    const config = getAppConfig()
    return NextResponse.json({
      ok: true,
      reserve_gb: config.reserveGb,
      dynamic_vram: config.dynamicVram,
      vram_headroom: config.vramHeadroom, // (правка 490)
      llm_device: config.llmDevice,
      llm_context_size: config.llmContextSize,
      llm_max_output_tokens: config.llmMaxOutputTokens,
      comfy_dir: config.comfyRoot,
      diffusion_model: config.diffusionModel,
      llm_model: config.llmModel,
      llm_custom_model: config.llmCustomModel,
      llm_custom_mmproj: config.llmCustomMmproj,
      model_extra_paths: config.modelExtraPaths,
      // (правка 257) yaml внешних папок изменился — нужен перезапуск start.bat
      restart_required: extraPathsRestart,
      llm_video_vision: config.llmVideoVision,
      llm_kv_cache: config.llmKvCache,
      llm_sampling_override: config.llmSamplingOverride,
      llm_temperature: config.llmTemperature,
      llm_top_p: config.llmTopP,
      llm_top_k: config.llmTopK,
      llm_min_p: config.llmMinP,
      llm_presence_penalty: config.llmPresencePenalty,
      llm_frequency_penalty: config.llmFrequencyPenalty,
      llm_repeat_penalty: config.llmRepeatPenalty,
      sound_on: config.soundOn,
      stt_enabled: config.sttEnabled,
      stt_dir: config.sttDir,
      stt_model: config.sttModel,
      stt_language: config.sttLanguage,
      stt_threads: config.sttThreads,
    })
  } catch {
    return NextResponse.json({ error: 'Failed to save config' }, { status: 500 })
  }
}