'use client'

/**
 * LLM Model Selector — dropdown to switch between LLM models/quantizations:
 * Gemma 4 12B (Q3_K_M / Q4_K_M / Q5_K_M) or Qwen3.5 9B (правка 52).
 * Listed with VRAM recommendations. (правка 48)
 */
import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { BotIcon, Loader2Icon } from 'lucide-react'
import { MODELS } from '@/lib/models-config'

interface LlmModelOption {
  id: string
  label: string
  filename: string
  sizeLabel: string
}

/** Модель ассистента по умолчанию — Qwen3.5 9B. */
export const DEFAULT_LLM_MODEL_ID = 'llm_assistant_qwen'
const DEFAULT_LLM_MODEL_FILE = 'Qwen3.5-9B-Q4_K_M.gguf'

/**
 * Размер модели берём из реестра (models-config.ts), а не дублируем строкой
 * рядом: раньше подписи в селекторе разошлись с реальными файлами
 * (показывали «~8.6 GB» для Gemma Q5,whose файл весит 8.41 ГБ, и «~7.8 GB»
 * для Bonsai PQ2_0,whose файл весит 7.21 ГБ).
 *
 * Виртуальные id бонусов ('llm_assistant_bonsai*') в реестре отсутствуют —
 * для них указан источник id (какая запись реестра описывает этот файл).
 */
function sizeOf(modelId: string): string {
  const def = MODELS.find((m) => m.id === modelId)
  return def?.sizeLabel ?? '—'
}

const LLM_OPTIONS: LlmModelOption[] = [
  // (правка 136) Bonsai 2 27B — тернарный квант Qwen-семейства на форке
  // llama.cpp (PrismML). Значение 'bonsai' = спец-маркер в config [llm] model.
  {
    id: 'llm_assistant_bonsai',
    label: `Bonsai 2 27B · тернарная (27B в ${sizeOf('bonsai_model')}, vision)`,
    filename: 'bonsai',
    sizeLabel: sizeOf('bonsai_model'),
  },
  // (правка 168) Bonsai 2 27B PTQ1_0 — самая лёгкая квантизация, для карт ≤8 ГБ.
  // Значение 'bonsai_light' = использовать PTQ1_0 вместо PQ2_0.
  {
    id: 'llm_assistant_bonsai_light',
    label: `Bonsai 2 27B · PTQ1_0 (самая лёгкая, ${sizeOf('bonsai_model_light')}, для карт ≤8 ГБ)`,
    filename: 'bonsai_light',
    sizeLabel: sizeOf('bonsai_model_light'),
  },
  {
    id: 'llm_assistant',
    label: `Gemma 4 12B · Q4_K_M (баланс, ${sizeOf('llm_assistant')})`,
    filename: 'gemma-4-12b-it-Q4_K_M.gguf',
    sizeLabel: sizeOf('llm_assistant'),
  },
  {
    id: 'llm_assistant_q3',
    label: `Gemma 4 12B · Q3_K_M (лёгкая, ${sizeOf('llm_assistant_q3')}, ~8 GB VRAM)`,
    filename: 'gemma-4-12b-it-Q3_K_M.gguf',
    sizeLabel: sizeOf('llm_assistant_q3'),
  },
  {
    id: 'llm_assistant_q5',
    label: `Gemma 4 12B · Q5_K_M (макс. качество, ${sizeOf('llm_assistant_q5')}, ~12 GB VRAM)`,
    filename: 'gemma-4-12b-it-Q5_K_M.gguf',
    sizeLabel: sizeOf('llm_assistant_q5'),
  },
  // Qwen3.5 9B (правка 52): альтернатива для слабых машин — 5.7 ГБ весов,
  // мультимодальная (картинки + видео). Нужен свежий llama.cpp (qwen35).
  {
    id: 'llm_assistant_qwen',
    label: `Qwen3.5 9B · Q4_K_M (vision, лёгкая, ${sizeOf('llm_assistant_qwen')})`,
    filename: 'Qwen3.5-9B-Q4_K_M.gguf',
    sizeLabel: sizeOf('llm_assistant_qwen'),
  },
]

export function LlmModelSelector() {
  const [selected, setSelected] = useState(DEFAULT_LLM_MODEL_FILE)
  const [saving, setSaving] = useState(false)
  // Путь своей GGUF-модели из конфига: если задан — в списке появляется
  // пункт «Своя модель», и он же выбран, когда backend=custom.
  const [customPath, setCustomPath] = useState('')

  useEffect(() => {
    fetch('/api/config')
      .then((r) => r.json())
      .then((d) => {
        const custom = typeof d.llm_custom_model === 'string' ? d.llm_custom_model.trim() : ''
        setCustomPath(custom)
        const m = typeof d.llm_model === 'string' ? d.llm_model : ''
        if (custom && (m === '' || m === 'llm_custom')) {
          setSelected('llm_custom')
        } else {
          setSelected(m || DEFAULT_LLM_MODEL_FILE)
        }
      })
      .catch(() => {})
  }, [])

  const save = useCallback(async (filename: string) => {
    setSaving(true)
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ llm_model: filename }),
      })
      if (res.ok) {
        // Выгружаем загруженную LLM: иначе она продолжала бы отвечать СТАРОЙ
        // моделью, а чат-роут уже шлёт протокол/сэмплинг НОВОЙ (для смены
        // бэкенда standard↔bonsai это несовместимые /chat и
        // /v1/chat/completions). Страховка на гонку — сигнатура конфига в
        // ensureLlm (llm-runner.ts).
        void fetch('/api/llm/stop', { method: 'POST' }).catch(() => {})
        if (filename === 'llm_custom') {
          toast.success('LLM: своя модель (GGUF)', {
            description: 'Ассистент перезапустится с ней при следующем сообщении.',
          })
        } else {
          const opt = LLM_OPTIONS.find((o) => o.filename === filename)
          toast.success(
            `LLM: ${opt?.label ?? (filename || 'Qwen3.5 9B')}`,
            { description: 'Ассистент перезапустится с ней при следующем сообщении.' },
          )
        }
      }
    } catch {
      toast.error('Не удалось сохранить')
    } finally {
      setSaving(false)
    }
  }, [])

  const handleSelect = (value: string) => {
    setSelected(value)
    void save(value)
  }

  // Имя файла своей модели для подписи пункта (путь может быть и папкой).
  const customBase = customPath.split(/[\\/]/).filter(Boolean).pop() ?? ''

  return (
    <div className="space-y-2 pt-2 border-t border-border">
      <div className="flex items-center gap-2">
        <BotIcon className="w-3.5 h-3.5 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">Модель ассистента</span>
        {saving && <Loader2Icon className="w-3 h-3 animate-spin text-muted-foreground" />}
      </div>
      <select
        value={selected}
        onChange={(e) => handleSelect(e.target.value)}
        disabled={saving}
        className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
      >
        {customPath && (
          <option value="llm_custom">Своя модель (GGUF): {customBase}</option>
        )}
        {LLM_OPTIONS.map((opt) => (
          <option key={opt.id} value={opt.filename}>
            {opt.label} — {opt.sizeLabel}
          </option>
        ))}
      </select>
      <p className="text-[10px] text-muted-foreground/50">
        {customPath
          ? 'Своя модель задаётся путём в поле ниже; выбор встроенной модели в списке переключает обратно (путь при этом сохраняется).'
          : 'Qwen3.5 9B — модель по умолчанию (8–12 ГБ VRAM) · Bonsai 2 27B — необязательная тернарная модель · PTQ1_0 — самая лёгкая (≤8 ГБ) · Gemma Q3 — 8 ГБ VRAM · Q4 — 12 ГБ · Q5 — 16+ ГБ'}
      </p>
    </div>
  )
}
