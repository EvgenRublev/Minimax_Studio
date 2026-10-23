'use client'

/**
 * ModelsWarningBanner — показывает предупреждение вверху контента,
 * если одна или несколько моделей не скачаны.
 *
 * - Загружает /api/models/status и /api/config при монтировании.
 * - Учитывает выбранную LLM-квантизацию: неактивные квантизации не считаются missing.
 * - Собирает модели со статусом 'missing' или 'error' (не 'ready', не 'downloading').
 * - Если есть — показывает жёлтый баннер с кнопкой «Скачать в настройках».
 * - Скрывается крестиком (до перезагрузки страницы).
 */
import { useState, useEffect } from 'react'
import { AlertTriangleIcon, XIcon, DownloadIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface ModelStatusItem {
  id: string
  label: string
  status: string
  relPath: string
  /** (правка 162) optional: true — модель не обязательна (баннер не требует) */
  optional?: boolean
}

interface ModelsWarningBannerProps {
  onOpenSettings: () => void
}

/** ID mmproj-файла (vision) — не сама модель, а сопутствующий файл (правка 52) */
function isLlmMmproj(id: string): boolean {
  return id === 'llm_assistant_mmproj' || id === 'llm_assistant_qwen_mmproj'
}

/** Определяет, является ли модель LLM-квантизацией (не mmproj) */
function isLlmQuant(id: string): boolean {
  return id.startsWith('llm_assistant') && !isLlmMmproj(id)
}

/** Файл, соответствующий выбранной LLM (пустая строка = дефолт Qwen). */
function resolveSelectedLlm(llmModel: string): string {
  if (!llmModel) return 'Qwen3.5-9B-Q4_K_M.gguf'
  return llmModel
}

/** (правка 52) «Семья» выбранной LLM — от неё зависит, чей mmproj считается нужным
 *  (правка 162) добавлена семья 'bonsai' — свой mmproj, не Gemma/Qwen */
function selectedLlmFamily(llmModel: string): 'gemma' | 'qwen' | 'bonsai' {
  if (/bonsai/i.test(llmModel)) return 'bonsai'
  return /qwen/i.test(llmModel) ? 'qwen' : 'gemma'
}

export function ModelsWarningBanner({ onOpenSettings }: ModelsWarningBannerProps) {
  const [missing, setMissing] = useState<ModelStatusItem[]>([])
  const [dismissed, setDismissed] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const check = () => {
      Promise.all([
        fetch('/api/models/status'),
        fetch('/api/config'),
      ])
        .then(([statusRes, configRes]) => Promise.all([statusRes.json(), configRes.json()]))
        .then(([data, config]) => {
          const selectedLlm = resolveSelectedLlm(config.llm_model || '')
          const family = selectedLlmFamily(selectedLlm)
          // Bonsai-набор учитывается только при явном выборе Bonsai.
          const isBonsaiSelected = config.llm_model === 'bonsai' || config.llm_model === 'bonsai_light'
          const notReady = (data.models ?? []).filter((m: ModelStatusItem) => {
            if (m.status === 'ready' || m.status === 'downloading') return false

            // (правка 257) Подключена СВОЯ LLM (Настройки → LLM, путь к .gguf):
            // модели ассистента из набора студии не нужны — не требуем их.
            if (config.llm_custom_model && (isLlmQuant(m.id) || isLlmMmproj(m.id) || m.id.startsWith('bonsai_'))) {
              return false
            }

            // (правка 162) Опциональные модели (bonsai_model_light) не требуются
            if (m.optional) return false

            // (правка 160) Bonsai-набор: видим только когда Bonsai выбрана.
            // bonsai_mmproj — часть набора (не optional), поэтому попадает сюда.
            if (m.id.startsWith('bonsai_') && !isBonsaiSelected) return false

            // LLM-квантизации: считаем только выбранную
            if (isLlmQuant(m.id)) {
              const file = m.relPath.split('/').pop() || ''
              if (file !== selectedLlm) return false
            }

            // (правка 52) mmproj: считаем только того семейства, что выбрано
            // (Gemma и Qwen3.5 имеют разные mmproj-файлы)
            // (правка 170) BUGFIX: при выбранной Bonsai (family === 'bonsai')
            // gemma/qwen mmproj НЕ требуются — у Bonsai свой bonsai_mmproj
            // (он обрабатывается правилом bonsai_ выше). Раньше семья 'bonsai'
            // проваливалась в ветку Gemma (isQwenMmproj=false === (family!=='qwen'))
            // и баннер вечно требовал mmproj-BF16.gguf от Gemma при полностью
            // скачанном Bonsai — «вижн-модель не скачана», хотя она на месте.
            if (isLlmMmproj(m.id)) {
              if (family === 'bonsai') return false
              const isQwenMmproj = m.id === 'llm_assistant_qwen_mmproj'
              if (isQwenMmproj !== (family === 'qwen')) return false
            }

            return true
          })
          setMissing(notReady)
        })
        .catch(() => {
          /* API недоступен — не показываем баннер */
        })
        .finally(() => setLoading(false))
    }
    check()
    // Периодический перерасчёт: раньше баннер вычислялся один раз на маунте
    // и оставался устаревшим, когда пользователь менял/докачивал модели
    // в настройках (до перезагрузки страницы).
    const t = setInterval(check, 15_000)
    return () => clearInterval(t)
  }, [])

  if (loading || dismissed || missing.length === 0) return null

  const label =
    missing.length === 1
      ? `Не скачана модель: ${missing[0].label}`
      : missing.length === 2
        ? `Не скачаны модели: ${missing.map((m) => m.label).join(', ')}`
        : `Не скачано моделей: ${missing.length}. Генерация будет работать некорректно.`

  return (
    <div className="flex items-center gap-3 px-4 py-2.5 bg-amber-500/10 border-b border-amber-500/20 shrink-0">
      <AlertTriangleIcon className="w-4 h-4 text-amber-400 shrink-0" />
      <span className="text-xs text-amber-300 flex-1 min-w-0 truncate" title={label}>
        {label}
      </span>
      <Button
        size="sm"
        variant="outline"
        className="h-7 text-xs text-amber-300 border-amber-500/30 hover:bg-amber-500/10 hover:text-amber-200 shrink-0"
        onClick={onOpenSettings}
      >
        <DownloadIcon className="w-3 h-3" />
        Скачать в настройках
      </Button>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="p-1 rounded hover:bg-amber-500/20 text-amber-400/70 hover:text-amber-300 shrink-0"
        title="Скрыть"
      >
        <XIcon className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}