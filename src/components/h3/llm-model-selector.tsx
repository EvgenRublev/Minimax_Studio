'use client'

/**
 * LLM Model Selector — dropdown to switch between LLM models/quantizations:
 * Gemma 4 12B (Q3_K_M / Q4_K_M / Q5_K_M) or Qwen3.5 9B (правка 52).
 * Listed with VRAM recommendations. (правка 48)
 */
import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { Loader2Icon } from 'lucide-react'
import { MODELS } from '@/lib/models-config'
import { useTranslation } from 'react-i18next' // (правка 955)

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
  const { t } = useTranslation() // (правка 955)

  const [selected, setSelected] = useState(DEFAULT_LLM_MODEL_FILE)
  const [saving, setSaving] = useState(false)
  // Путь своей GGUF-модели из конфига: если задан — в списке появляется
  // пункт «Своя модель», и он же выбран, когда backend=custom.
  const [customPath, setCustomPath] = useState('')
  // (правка 1121) Что реально лежит на диске: отсутствующие встроенные модели
  // помечаем «нет файла» (раньше список врал: выбираешь — а файла нет), а свои
  // .gguf из папки Models показываем отдельной группой, без ручного ввода пути.
  const [missing, setMissing] = useState<Set<string>>(new Set())
  const [localModels, setLocalModels] = useState<Array<{ path: string; name: string; sizeGb: number; source: string; mmproj?: string | null }>>([])

  useEffect(() => {
    fetch('/api/models/status')
      .then((r) => r.json())
      .then((d) => {
        const m = new Set<string>()
        for (const s of Array.isArray(d?.models) ? d.models : []) {
          if (s?.status !== 'ready' && typeof s?.relPath === 'string') {
            m.add(s.relPath.split(/[\\/]/).pop() as string)
          }
        }
        setMissing(m)
      })
      .catch(() => {})
    fetch('/api/models/llm-local')
      .then((r) => r.json())
      .then((d) => setLocalModels(Array.isArray(d?.models) ? d.models : []))
      .catch(() => {})
  }, [])

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
          toast.success(t("LLM: своя модель (GGUF)"), {
            description: t("Ассистент перезапустится с ней при следующем сообщении."),
          })
        } else {
          const opt = LLM_OPTIONS.find((o) => o.filename === filename)
          toast.success(
            `LLM: ${opt?.label ?? (filename || 'Qwen3.5 9B')}`,
            { description: t("Ассистент перезапустится с ней при следующем сообщении.") },
          )
        }
      }
    } catch {
      toast.error(t("Не удалось сохранить"))
    } finally {
      setSaving(false)
    }
  }, [])

  const handleSelect = (value: string) => {
    setSelected(value)
    if (value.startsWith('local:')) {
      const picked = localModels.find((m) => `local:${m.path}` === value)
      void saveLocal(value.slice('local:'.length), picked?.mmproj ?? null)
      return
    }
    void save(value)
  }

  /** (правка 1121) Выбор найденного на диске .gguf: это и есть своя модель. */
  const saveLocal = async (absPath: string, mmproj?: string | null) => {
    setSaving(true)
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          llm_custom_model: absPath,
          llm_model: 'llm_custom',
          // (правка 1127) зрение: mmproj из той же папки, если он там есть
          llm_custom_mmproj: mmproj || '',
        }),
      })
      if (res.ok) {
        setCustomPath(absPath)
        void fetch('/api/llm/stop', { method: 'POST' }).catch(() => {})
        toast.success(t("LLM: своя модель (GGUF)"), {
          description: t("Ассистент перезапустится с ней при следующем сообщении."),
        })
      } else {
        toast.error(t("Не удалось сохранить"))
      }
    } catch {
      toast.error(t("Не удалось сохранить"))
    } finally {
      setSaving(false)
    }
  }

  // Имя файла своей модели для подписи пункта (путь может быть и папкой).
  const customBase = customPath.split(/[\\/]/).filter(Boolean).pop() ?? ''

  return (
    <div className="max-w-[480px] space-y-2 px-3.5 py-3">
      <div className="flex items-center gap-2">
        <select
          value={selected}
          onChange={(e) => handleSelect(e.target.value)}
          disabled={saving}
          className="h-8 w-full rounded-md border border-border bg-[var(--surface-1)] px-2.5 text-xs text-foreground focus:border-cyan-500/60 focus:outline-none focus:ring-1 focus:ring-cyan-500/40"
        >
          {customPath && (
            <option value="llm_custom">{t("Своя модель (GGUF):")}{' '} {customBase}</option>
          )}
          {localModels.length > 0 && (
            <optgroup label={t('Найдено на диске')}>
              {localModels.map((m) => (
                <option key={m.path} value={`local:${m.path}`}>
                  {m.name} — {m.sizeGb} ГБ ({m.source})
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label={t('Встроенные')}>
            {LLM_OPTIONS.map((opt) => (
              <option key={opt.id} value={opt.filename}>
                {t(opt.label)} — {opt.sizeLabel}{missing.has(opt.filename) ? ` · ${t('нет файла')}` : ''}
              </option>
            ))}
          </optgroup>
        </select>
        {saving && <Loader2Icon className="w-3.5 h-3.5 shrink-0 animate-spin text-muted-foreground" />}
      </div>
      {selected !== 'llm_custom' && missing.has(selected) && (
        <p className="text-[11px] leading-snug text-amber-400/90">
          {t('Файл этой модели не найден на диске: ассистент не запустится. Скачайте её в разделе «Ссылки» или выберите свою .gguf ниже.')}
        </p>
      )}
      {localModels.length === 0 && (
        <p className="text-[11px] leading-snug text-muted-foreground">
          {t('Свои .gguf ищем в папке моделей студии и в «Своих папках моделей»; путь можно задать и вручную ниже.')}
        </p>
      )}
      <p className="text-[11px] leading-snug text-muted-foreground">
        {customPath
          ? t("Своя модель задаётся путём в поле ниже; выбор встроенной модели в списке переключает обратно (путь при этом сохраняется).")
          : t("Qwen3.5 9B — модель по умолчанию (8–12 ГБ VRAM) · Bonsai 2 27B — необязательная тернарная модель · PTQ1_0 — самая лёгкая (≤8 ГБ) · Gemma Q3 — 8 ГБ VRAM · Q4 — 12 ГБ · Q5 — 16+ ГБ")}
      </p>
    </div>
  )
}
