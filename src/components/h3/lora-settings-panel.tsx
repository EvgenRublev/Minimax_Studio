'use client'

/**
 * LoraSettingsPanel (правка 44) — manages custom LoRAs in settings.
 * Shows enabled/disabled state, strength slider, add/remove buttons.
 * The built-in turbo LoRA is NOT shown here.
 * (правка 104) Прогресс загрузки — в общем store: закрытие окна настроек
 * не сбрасывает индикатор и не прерывает загрузку.
 */
import { useState, useCallback, useRef, useEffect } from 'react'
import {
  PlusIcon,
  Trash2Icon,
  Loader2Icon,
  PowerIcon,
  PowerOffIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useModelUploadStore } from '@/lib/model-upload-store'

interface LoraItem {
  name: string
  strength: number
  enabled: boolean
  trigger: string
  size: number
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`
  return `${(bytes / 1024).toFixed(0)} KB`
}

function shortName(name: string): string {
  // Remove .safetensors extension and trim to reasonable length
  const base = name.replace(/\.safetensors$/i, '')
  return base.length > 35 ? base.slice(0, 32) + '…' : base
}

export function LoraSettingsPanel() {
  const [loras, setLoras] = useState<LoraItem[]>([])
  const [loading, setLoading] = useState(true)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // (правка 104) Состояние загрузки — в общем store (живёт вне React-дерева):
  // Radix при закрытии диалога размонтирует панель, но загрузка и её прогресс
  // сохраняются; повторное открытие подхватывает тот же индикатор.
  const uploading = useModelUploadStore((s) => s.active && s.target === 'lora')
  const uploadProgress = useModelUploadStore((s) => s.progress)

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/loras')
      const d = await r.json()
      const items: LoraItem[] = d.loras ?? []
      setLoras(items)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const handleAdd = async () => {
    fileInputRef.current?.click()
  }

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''

    // (правка 104) Запрос живёт в промисе вне компонента — закрытие окна
    // настроек его не прерывает; прогресс пишется в общий store.
    const { start, setProgress, done } = useModelUploadStore.getState()
    start('lora', file.name)

    try {
      const form = new FormData()
      form.append('file', file)

      // Use XMLHttpRequest for progress events (fetch doesn't support upload progress)
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.open('POST', '/api/loras')
        xhr.upload.onprogress = (ev) => {
          if (ev.lengthComputable) {
            setProgress((ev.loaded / ev.total) * 100)
          }
        }
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve()
          else {
            try { reject(new Error(JSON.parse(xhr.responseText).error || `HTTP ${xhr.status}`)) }
            catch { reject(new Error(`Upload failed (${xhr.status})`)) }
          }
        }
        xhr.onerror = () => reject(new Error('Network error'))
        xhr.send(form)
      })

      toast.success('LoRA добавлена', { description: file.name })
      await refresh()
    } catch (err) {
      toast.error('Ошибка загрузки LoRA', { description: err instanceof Error ? err.message : String(err) })
    } finally {
      done()
    }
  }

  const toggleEnabled = async (name: string, enabled: boolean) => {
    // Optimistic update
    setLoras((prev) => prev.map((l) => l.name === name ? { ...l, enabled } : l))
    // (правка 587) Ловили только сетевые сбои: не-2xx (400/500) оставлял
    // оптимистичный флип в UI без роллбэка и без тоста — панель врала до
    // следующего refresh. Теперь проверяем res.ok, как POST/DELETE выше.
    try {
      const res = await fetch('/api/loras', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, enabled }),
      })
      if (!res.ok) {
        let msg = `HTTP ${res.status}`
        try {
          const d = await res.json()
          if (d?.error) msg = d.error
        } catch { /* без тела — код статуса */ }
        throw new Error(msg)
      }
    } catch (err) {
      setLoras((prev) => prev.map((l) => l.name === name ? { ...l, enabled: !enabled } : l))
      toast.error('Не удалось обновить', { description: err instanceof Error ? err.message : String(err) })
    }
  }

  /* (правка 81) Дебаус PUT-запросов: слайдер силы и поле триггера при каждом
     движении/символе шло отдельный PUT (десятки запросов на одно действие,
     каждый — запись loras.json). Теперь: оптимистичное обновление состояния
     + один запрос после 350мс тишины; незаписанные значения уходят при
     размонтировании панели. */
  type PendingPut = { timer: ReturnType<typeof setTimeout>; payload: Record<string, unknown> }
  const pendingPuts = useRef<Map<string, PendingPut>>(new Map())

  const sendPut = useCallback(async (payload: Record<string, unknown>) => {
    try {
      await fetch('/api/loras', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    } catch {
      // оптимистичное состояние уже применено; ошибка не критична
    }
  }, [])

  const schedulePut = useCallback((key: string, payload: Record<string, unknown>, delay = 350) => {
    const map = pendingPuts.current
    const existing = map.get(key)
    if (existing) clearTimeout(existing.timer)
    const timer = setTimeout(() => {
      map.delete(key)
      void sendPut(payload)
    }, delay)
    map.set(key, { timer, payload })
  }, [sendPut])

  // Незавершённые записи — отправить при размонтировании, чтобы последнее
  // значение слайдера/триггера не потерялось.
  useEffect(() => {
    const map = pendingPuts.current
    return () => {
      map.forEach((p) => {
        clearTimeout(p.timer)
        void sendPut(p.payload)
      })
      map.clear()
    }
  }, [sendPut])

  const updateStrength = (name: string, strength: number) => {
    setLoras((prev) => prev.map((l) => l.name === name ? { ...l, strength } : l))
    schedulePut(`strength:${name}`, { name, strength })
  }

  const updateTrigger = (name: string, trigger: string) => {
    setLoras((prev) => prev.map((l) => l.name === name ? { ...l, trigger } : l))
    schedulePut(`trigger:${name}`, { name, trigger })
  }

  const handleDelete = async (name: string) => {
    const msg = `Удалить LoRA "${name}"?\nФайл будет удалён из папки LoRAs.`
    if (!confirm(msg)) return
    try {
      const r = await fetch('/api/loras', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, deleteFile: true }),
      })
      if (!r.ok) {
        const d = await r.json().catch(() => ({}))
        throw new Error(d.error || `HTTP ${r.status}`)
      }
      toast.success('LoRA удалена')
      await refresh()
    } catch (err) {
      toast.error('Ошибка удаления', { description: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <div className="space-y-3 pt-3 border-t border-border">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">LoRAs</span>
        <div className="flex items-center gap-2">
          {/* (правка 133) Кнопка «Сбросить патчи» убрана — сброс теперь
           * автоматический при включении/выключении LoRA (в API PUT). */}
          <Button
            variant="outline"
            size="sm"
            onClick={handleAdd}
            disabled={uploading}
            className="h-7 gap-1.5 text-xs"
          >
            {uploading ? <Loader2Icon className="w-3.5 h-3.5 animate-spin" /> : <PlusIcon className="w-3.5 h-3.5" />}
            Добавить
          </Button>
        </div>
        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".safetensors"
          className="hidden"
          onChange={handleFile}
        />
      </div>

      {/* Upload progress (правка 104 — состояние из общего store) */}
      {uploading && (
        <div className="space-y-1">
          <div className="h-1.5 bg-[var(--surface-2)] rounded-full overflow-hidden">
            <div
              className="h-full bg-cyan-500 rounded-full transition-all duration-200"
              style={{ width: `${uploadProgress}%` }}
            />
          </div>
          <p className="text-[10px] text-muted-foreground text-right">{uploadProgress}%</p>
        </div>
      )}

      {/* LoRA list */}
      {loading ? (
        <div className="flex items-center justify-center py-4">
          <Loader2Icon className="w-4 h-4 animate-spin text-muted-foreground" />
        </div>
      ) : loras.length === 0 ? (
        <p className="text-xs text-muted-foreground/60 py-1">
          Нет кастомных LoRAs. Добавьте файл .safetensors.
        </p>
      ) : (
        <div className="space-y-2">
          {loras.map((lora) => (
            <div
              key={lora.name}
              className="rounded-lg border border-border bg-[var(--surface-2)] px-3 py-2 space-y-1.5"
            >
              {/* Header: name + actions */}
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-foreground truncate flex items-center gap-1.5" title={lora.name}>
                    <span className="truncate">{shortName(lora.name)}</span>
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    {formatSize(lora.size)}
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => toggleEnabled(lora.name, !lora.enabled)}
                    className={`p-1.5 rounded-md transition-colors ${
                      lora.enabled
                        ? 'text-emerald-400 hover:bg-emerald-500/10'
                        : 'text-muted-foreground/40 hover:bg-muted'
                    }`}
                    title={lora.enabled ? 'Отключить' : 'Включить'}
                  >
                    {lora.enabled ? <PowerIcon className="w-3.5 h-3.5" /> : <PowerOffIcon className="w-3.5 h-3.5" />}
                  </button>
                  <button
                    onClick={() => handleDelete(lora.name)}
                    className="p-1.5 rounded-md text-muted-foreground/40 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                    title="Удалить"
                  >
                    <Trash2Icon className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* Strength slider (only when enabled) */}
              {lora.enabled && (
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <input
                      type="range"
                      /* (правка 256) Диапазон −10…+10: на civitai есть лоры,
                         обученные с отрицательной силой (инверсия), а старые
                         границы 0.1…2.0 не давали их использовать. */
                      min="-10"
                      max="10"
                      step="0.05"
                      value={lora.strength}
                      onChange={(e) => updateStrength(lora.name, parseFloat(e.target.value))}
                      className="flex-1 h-1 accent-cyan-500 cursor-pointer"
                    />
                    <span className="text-[10px] font-mono text-muted-foreground w-12 text-right">
                      {lora.strength.toFixed(2)}
                    </span>
                  </div>
                  {/* Trigger words (правка 46) */}
                  {/* (правка 587) Условие !lora.isTurbo удалено: турбо-лора
                      убрана из списка (правка 578), поля isTurbo больше нет
                      ни в интерфейсе, ни в ответе API (ошибка TS2339). */}
                  <input
                    type="text"
                    placeholder="Триггерные слова (добавляются к промпту)"
                    value={lora.trigger || ''}
                    onChange={(e) => updateTrigger(lora.name, e.target.value)}
                    className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-cyan-500/40"
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
