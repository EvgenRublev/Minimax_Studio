/**
 * (правка 135) Тонкая настройка сэмплинга LLM под конкретную модель.
 *
 * До этой правки route.ts передавал в llm_server только `temperature`
 * (хардкод 0.7), а top_p / top_k / min_p / penalties уходили в дефолты
 * llama-cpp-python (top_k=40, top_p=0.95, min_p=0.05) — которые НЕ
 * оптимизированы под наши две модели. Результат: периодическое
 * зацикливание, дегенерация thought-канала, «плавание» ответа.
 *
 * Теперь параметры подбираются по семейству активной модели, опираясь на
 * официальные рекомендации (unsloth / Ollama / HuggingFace) с поправкой на
 * то, что у нас llama.cpp, а не Ollama. Приоритет — СТАБИЛЬНОСТЬ
 * (меньше глючей), а не максимальная креативность.
 *
 * (правка 135b) UI: в настройках LLM есть свёрнутый блок «Доп. настройки
 * сэмплинга» — пользователь может ВКЛЮЧИТЬ переопределение и подкрутить
 * любые из 7 параметров. Если override ВЫКЛ (по умолчанию) — применяются
 * модель-осознанные значения из этой функции.
 *
 * Модуль ЧИСТОЙ (без импортов Next) — легко тестировать и переиспользовать.
 */

import { getAppConfig } from './app-config'

export interface SamplingParams {
  temperature: number
  top_p: number
  top_k: number
  min_p: number
  presence_penalty: number
  frequency_penalty: number
  repeat_penalty: number
}

const FALLBACK: SamplingParams = {
  temperature: 0.7,
  top_p: 0.95,
  top_k: 40,
  min_p: 0.05,
  presence_penalty: 0.0,
  frequency_penalty: 0.0,
  repeat_penalty: 1.0,
}

/**
 * Рекомендуемый набор сэмплинга для семейства моделей.
 *
 * ── Gemma 4 12B (unsloth/Gemma, HF Gemma team) ──
 *   Официально: temperature=1.0, top_p=0.95, top_k=64.
 *   Но это для Ollama; в llama.cpp/llama-cpp-python сообщество (r/LocalLLaMA)
 *   стабильнее получает при пониженной температуре. Берём 0.7 (середина
 *   между «слишком креативно → дегенерация» и «слишком жёстко → однобоко»).
 *   top_p=0.95 + top_k=64 — умеренный срез хвоста, min_p=0.0 (Gemma не
 *   любит min_p>0), repeat_penalty=1.05 — мягкий антицикл без потери стиля.
 *
 * ── Qwen3.5 9B (unsloth Qwen3.5-9B-MTP-GGUF, «Instruct general») ──
 *   temperature=0.7, top_p=0.8, top_k=20, min_p=0.0,
 *   presence_penalty=1.5 (Qwen любит presence-штраф против повторов),
 *   frequency_penalty=0.0, repeat_penalty=1.0.
 *
 * ── Fallback (неизвестная модель) ──
 *   Близко к дефолтам llama-cpp-python, но с честными нулями по min_p/penalty,
 *   чтобы не вносить сюрпризов.
 */
const QWEN_PRESET: SamplingParams = {
  temperature: 0.7,
  top_p: 0.8,
  top_k: 20,
  min_p: 0.0,
  presence_penalty: 1.5,
  frequency_penalty: 0.0,
  repeat_penalty: 1.0,
}

const GEMMA_PRESET: SamplingParams = {
  temperature: 0.7,
  top_p: 0.95,
  top_k: 64,
  min_p: 0.0,
  presence_penalty: 0.0,
  frequency_penalty: 0.0,
  repeat_penalty: 1.05,
}

function modelSampling(modelId: string): SamplingParams {
  // (правка 136 / Bonsai) Ternary Bonsai 2 27B — Qwen-семейство, тернарный
  // квант. Думание выключено (--reasoning-budget 0) → instruct-рекомендации
  // авторов: temp 0.7, top_p 0.80, presence_penalty 1.5; top_k 20 из
  // thinking-профиля (умеренный срез хвоста, стабильность).
  if (modelId === 'llm_assistant_bonsai') {
    return { ...QWEN_PRESET }
  }
  // Qwen3.5 9B — дефолтная модель (правка 99).
  if (modelId.startsWith('llm_assistant_qwen')) {
    return { ...QWEN_PRESET }
  }
  // Gemma 4 12B (Q3/Q4/Q5 — любое квантование того же семейства).
  if (modelId.startsWith('llm_assistant')) {
    return { ...GEMMA_PRESET }
  }
  return { ...FALLBACK }
}

/**
 * (правка 477) Сэмплинг для СВОЕЙ GGUF-модели: семейство по имени файла
 * (пресеты Qwen/Gemma выше). Раньше 'llm_custom' падал в FALLBACK без
 * presence_penalty — Qwen-совместимые модели (Qwen3.5-4B и т.п.) уходили
 * в повторы/луп.
 */
export function samplingForCustomModel(customPath: string): SamplingParams {
  const base = customPath.split(/[\\/]/).pop() || ''
  if (/qwen/i.test(base)) return { ...QWEN_PRESET }
  if (/gemma/i.test(base)) return { ...GEMMA_PRESET }
  return { ...FALLBACK }
}

/**
 * (правка 135b) Финальный набор сэмплинга: если пользователь ВКЛЮЧИЛ
 * переопределение в настройках — берём его значения из config.ini;
 * иначе — модель-осознанные значения из modelSampling().
 */
export function samplingForModel(modelId: string): SamplingParams {
  try {
    const cfg = getAppConfig()
    if (cfg.llmSamplingOverride) {
      return {
        temperature: cfg.llmTemperature,
        top_p: cfg.llmTopP,
        top_k: cfg.llmTopK,
        min_p: cfg.llmMinP,
        presence_penalty: cfg.llmPresencePenalty,
        frequency_penalty: cfg.llmFrequencyPenalty,
        repeat_penalty: cfg.llmRepeatPenalty,
      }
    }
    // (правка 477) Своя модель: семейство по имени файла — иначе FALLBACK
    // без presence_penalty отправлял Qwen-совместимые модели в луп.
    if (modelId === 'llm_custom') {
      return samplingForCustomModel(cfg.llmCustomModel || '')
    }
  } catch {
    /* config unavailable — fall through to model-based defaults */
  }
  return modelSampling(modelId)
}
