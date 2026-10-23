'use client'

/**
 * Diffusion Model Selector — строка с текущей моделью,
 * по клику раскрывается список альтернативных моделей.
 * (правка 45; правка 90 — кнопка «Добавить» с загрузкой файла
 * в models/diffusion_models/, как у LoRA;
 * правка 104 — прогресс загрузки в общем store: закрытие окна
 * настроек больше не сбрасывает индикатор и не прерывает загрузку.)
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import { toast } from 'sonner'
import { PackageIcon, ChevronDownIcon, CheckIcon, RotateCcwIcon, PlusIcon, Loader2Icon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useModelUploadStore } from '@/lib/model-upload-store'

interface ModelsResponse {
  models: string[]
  default: string
  current: string
}

export function DiffusionModelSelector() {
  const [models, setModels] = useState<string[]>([])
  const [defaultModel, setDefaultModel] = useState('')
  const [selected, setSelected] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [saving, setSaving] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // (правка 104) Состояние загрузки — в общем store (живёт вне React-дерева):
  // Radix при закрытии диалога размонтирует панель, но загрузка и её прогресс
  // сохраняются; повторное открытие подхватывает тот же индикатор.
  const uploading = useModelUploadStore((s) => s.active && s.target === 'diffusion')
  const uploadProgress = useModelUploadStore((s) => s.progress)

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/comfy/diffusion-models')
      const d: ModelsResponse = await r.json()
      setModels(d.models)
      setDefaultModel(d.default)
      setSelected((prev) => prev || d.current || d.default)
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  /* (правка 90) Загрузка файла модели в models/diffusion_models/.
   * XHR ради прогресса (fetch не умеет upload progress).
   * (правка 104) Прогресс пишется в общий store — запрос живёт в этом
   * промисе вне компонента, поэтому закрытие окна настроек его НЕ
   * прерывает; тост и refresh() выполнятся в любом случае. */
  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    const { start, setProgress, done } = useModelUploadStore.getState()
    start('diffusion', file.name)
    try {
      const form = new FormData()
      form.append('file', file)
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.open('POST', '/api/comfy/diffusion-models')
        xhr.upload.onprogress = (ev) => {
          if (ev.lengthComputable) {
            setProgress((ev.loaded / ev.total) * 100)
          }
        }
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve()
          } else {
            try { reject(new Error(JSON.parse(xhr.responseText).error || `HTTP ${xhr.status}`)) }
            catch { reject(new Error(`Upload failed (${xhr.status})`)) }
          }
        }
        xhr.onerror = () => reject(new Error('Network error'))
        xhr.send(form)
      })
      toast.success('Модель загружена', { description: file.name })
      await refresh()
    } catch (err) {
      toast.error('Ошибка загрузки модели', { description: err instanceof Error ? err.message : String(err) })
    } finally {
      done()
    }
  }

  const save = useCallback(async (value: string) => {
    setSaving(true)
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ diffusion_model: value }),
      })
      if (res.ok) {
        toast.success(
          value && value !== defaultModel ? `Модель: ${value}` : 'Базовая модель',
          { duration: 2500 },
        )
      }
    } catch {
      toast.error('Не удалось сохранить')
    } finally {
      setSaving(false)
    }
  }, [defaultModel])

  const handleSelect = (value: string) => {
    setSelected(value)
    save(value)
    setExpanded(false)
  }

  const isDefault = !selected || selected === defaultModel
  const displayName = selected || defaultModel || '—'

  return (
    <div className="pt-2 border-t border-border">
      {/* Header row + «Добавить» (правка 90) */}
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex-1 flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-[var(--surface-2)]/50 transition-colors text-left min-w-0"
        >
          <PackageIcon className={cn('w-4 h-4 shrink-0', isDefault ? 'text-muted-foreground' : 'text-cyan-400')} />
          <div className="flex-1 min-w-0">
            <span className="text-xs font-medium block truncate">{displayName}</span>
            <span className="text-[10px] text-muted-foreground">
              {isDefault ? 'Базовая модель' : 'Альтернативная модель'}
            </span>
          </div>
          <ChevronDownIcon className={cn('w-4 h-4 text-muted-foreground transition-transform shrink-0', expanded && 'rotate-180')} />
        </button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="h-7 gap-1.5 text-xs shrink-0"
        >
          {uploading ? <Loader2Icon className="w-3.5 h-3.5 animate-spin" /> : <PlusIcon className="w-3.5 h-3.5" />}
          Добавить
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".safetensors"
          className="hidden"
          onChange={handleFile}
        />
      </div>

      {/* Upload progress (правка 90; правка 104 — состояние из общего store) */}
      {uploading && (
        <div className="space-y-1 px-1">
          <div className="h-1.5 bg-[var(--surface-2)] rounded-full overflow-hidden">
            <div
              className="h-full bg-cyan-500 rounded-full transition-all duration-200"
              style={{ width: `${uploadProgress}%` }}
            />
          </div>
          <p className="text-[10px] text-muted-foreground text-right">{uploadProgress}%</p>
        </div>
      )}

      {/* Expanded list */}
      {expanded && (
        <div className="mt-1.5 space-y-0.5 px-1 pb-1 max-h-48 overflow-y-auto">
          {models.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => handleSelect(m)}
              disabled={saving}
              className={cn(
                'w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs text-left transition-colors',
                selected === m
                  ? 'bg-cyan-500/10 text-cyan-300'
                  : 'hover:bg-[var(--surface-2)]/60 text-foreground/80',
              )}
            >
              {selected === m && <CheckIcon className="w-3 h-3 shrink-0" />}
              <span className="flex-1 truncate">{m}</span>
              {m === defaultModel && (
                <span className="text-[10px] px-1 py-0.5 rounded bg-muted-foreground/20 text-muted-foreground shrink-0">
                  базовая
                </span>
              )}
            </button>
          ))}

          {/* Reset to default */}
          {!isDefault && (
            <button
              type="button"
              onClick={() => handleSelect('')}
              disabled={saving}
              className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs text-amber-400/80 hover:text-amber-300 hover:bg-amber-500/10 transition-colors"
            >
              <RotateCcwIcon className="w-3 h-3 shrink-0" />
              Вернуть базовую модель
            </button>
          )}
        </div>
      )}
    </div>
  )
}