'use client'

import { useEffect, useState } from 'react'
import { CpuIcon, MemoryStickIcon, MonitorCogIcon, Trash2Icon } from 'lucide-react'
import { toast } from 'sonner'

const POLL_INTERVAL = 5000 // 5 seconds

interface StatsData {
  cpu_percent: number
  ram_used_gb: number
  ram_total_gb: number
  vram_used_gb: number
  vram_total_gb: number
  gpu_util_percent: number
  gpu_available: boolean
}

/**
 * Parse WanGP system-stats response.
 * Format: { cpu: { percent }, ram: { percent, used_gb, total_gb }, gpu: { available, percent, vram_used_gb, vram_total_gb } }
 */
function parseStats(data: unknown): StatsData | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>

  const cpu = (d.cpu as Record<string, unknown>)?.percent
  const ram = d.ram as Record<string, unknown> | undefined
  const gpu = d.gpu as Record<string, unknown> | undefined

  if (typeof cpu !== 'number' || !ram || typeof ram.used_gb !== 'number' || typeof ram.total_gb !== 'number') return null

  return {
    cpu_percent: cpu,
    ram_used_gb: ram.used_gb,
    ram_total_gb: ram.total_gb,
    vram_used_gb: typeof gpu?.vram_used_gb === 'number' ? gpu.vram_used_gb : 0,
    vram_total_gb: typeof gpu?.vram_total_gb === 'number' ? gpu.vram_total_gb : 0,
    gpu_util_percent: typeof gpu?.utilization_percent === 'number' ? gpu.utilization_percent : 0,
    gpu_available: gpu?.available === true,
  }
}

function StatBar({ value, max, color, label }: { value: number; max: number; color: string; label: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0
  return (
    <div
      className="flex-1 h-1.5 bg-[var(--surface-3)] rounded-full overflow-hidden"
      title={`${label}: ${value.toFixed(1)} / ${max.toFixed(1)} GB (${pct.toFixed(0)}%)`}
    >
      <div
        className="h-full rounded-full transition-all duration-700"
        style={{ width: `${pct}%`, backgroundColor: color }}
      />
    </div>
  )
}

export function SystemStatsBar({ collapsed }: { collapsed: boolean }) {
  const [stats, setStats] = useState<StatsData | null>(null)

  useEffect(() => {
    let cancelled = false

    async function poll() {
      try {
        const res = await fetch('/api/comfy/system-stats')
        if (!res.ok) return
        const data = await res.json()
        const parsed = parseStats(data)
        if (!cancelled && parsed) setStats(parsed)
      } catch {
        /* backend not ready yet */
      }
    }

    poll() // initial
    const timer = setInterval(poll, POLL_INTERVAL)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  if (!stats) return null

  if (collapsed) {
    // Collapsed: only colored bars, no icons or labels
    return (
      <div className="px-2 py-1 space-y-0.5 border-t border-border">
        {stats.gpu_available && stats.vram_total_gb > 0 && (
          <div className="h-1 bg-[var(--surface-3)] rounded-full overflow-hidden" title={`VRAM: ${(stats.vram_used_gb / stats.vram_total_gb * 100).toFixed(0)}%`}>
            <div className="h-full rounded-full" style={{ width: `${(stats.vram_used_gb / stats.vram_total_gb * 100)}%`, backgroundColor: '#06B6D4' }} />
          </div>
        )}
        {stats.gpu_available && (
          <div className="h-1 bg-[var(--surface-3)] rounded-full overflow-hidden" title={`GPU: ${stats.gpu_util_percent.toFixed(0)}%`}>
            <div className="h-full rounded-full" style={{ width: `${Math.min(100, stats.gpu_util_percent)}%`, backgroundColor: '#8B5CF6' }} />
          </div>
        )}
        {stats.ram_total_gb > 0 && (
          <div className="h-1 bg-[var(--surface-3)] rounded-full overflow-hidden" title={`RAM: ${(stats.ram_used_gb / stats.ram_total_gb * 100).toFixed(0)}%`}>
            <div className="h-full rounded-full" style={{ width: `${(stats.ram_used_gb / stats.ram_total_gb * 100)}%`, backgroundColor: '#10B981' }} />
          </div>
        )}
        <div className="h-1 bg-[var(--surface-3)] rounded-full overflow-hidden" title={`CPU: ${stats.cpu_percent.toFixed(0)}%`}>
          <div className="h-full rounded-full" style={{ width: `${Math.min(100, stats.cpu_percent)}%`, backgroundColor: '#F59E0B' }} />
        </div>
      </div>
    )
  }

  return (
    <div className="px-3 py-2 space-y-1.5 border-t border-border">
      {/* GPU VRAM */}
      {stats.gpu_available && stats.vram_total_gb > 0 && (
        <div className="flex items-center gap-1.5">
          <MonitorCogIcon className="w-3 h-3 text-cyan-400 shrink-0" />
          <span className="text-[10px] text-muted-foreground w-7 shrink-0">VRAM</span>
          <StatBar value={stats.vram_used_gb} max={stats.vram_total_gb} color="#06B6D4" label="VRAM" />
          <span className="text-[10px] font-mono text-muted-foreground tabular-nums shrink-0">
            {((stats.vram_used_gb / stats.vram_total_gb) * 100).toFixed(0)}%
          </span>
        </div>
      )}

      {/* GPU Utilization */}
      {stats.gpu_available && (
        <div className="flex items-center gap-1.5">
          <MonitorCogIcon className="w-3 h-3 text-violet-400 shrink-0" />
          <span className="text-[10px] text-muted-foreground w-7 shrink-0">GPU</span>
          <div className="flex-1 h-1.5 bg-[var(--surface-3)] rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-700"
              style={{ width: `${Math.min(100, stats.gpu_util_percent)}%`, backgroundColor: '#8B5CF6' }}
            />
          </div>
          <span className="text-[10px] font-mono text-muted-foreground tabular-nums shrink-0">
            {stats.gpu_util_percent.toFixed(0)}%
          </span>
        </div>
      )}

      {/* RAM */}
      {stats.ram_total_gb > 0 && (
        <div className="flex items-center gap-1.5">
          <MemoryStickIcon className="w-3 h-3 text-emerald-400 shrink-0" />
          <span className="text-[10px] text-muted-foreground w-7 shrink-0">RAM</span>
          <StatBar value={stats.ram_used_gb} max={stats.ram_total_gb} color="#10B981" label="RAM" />
          <span className="text-[10px] font-mono text-muted-foreground tabular-nums shrink-0">
            {((stats.ram_used_gb / stats.ram_total_gb) * 100).toFixed(0)}%
          </span>
        </div>
      )}

      {/* CPU */}
      <div className="flex items-center gap-1.5">
        <CpuIcon className="w-3 h-3 text-amber-400 shrink-0" />
        <span className="text-[10px] text-muted-foreground w-7 shrink-0">CPU</span>
        <div className="flex-1 h-1.5 bg-[var(--surface-3)] rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-700"
            style={{ width: `${Math.min(100, stats.cpu_percent)}%`, backgroundColor: '#F59E0B' }}
          />
        </div>
        <span className="text-[10px] font-mono text-muted-foreground tabular-nums shrink-0">
          {stats.cpu_percent.toFixed(0)}%
        </span>
      </div>

      {/* Free VRAM cache button */}
      <div className="flex items-center justify-between pt-1">
        <button
          onClick={async () => {
            try {
              const [comfyRes, llmRes] = await Promise.allSettled([
                fetch('/api/comfy/free', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ weights: 'high' }),
                }).then(r => r.json().then(d => ({ ok: r.ok, ...d }))),
                fetch('/api/llm/stop', { method: 'POST' }).then(r => r.json().then(d => ({ ok: r.ok, ...d }))),
              ])
              const comfyOk = comfyRes.status === 'fulfilled' && comfyRes.value.ok
              const llmOk = llmRes.status === 'fulfilled' && llmRes.value.ok
              if (comfyOk && llmOk) {
                toast.success('Кэш VRAM выгружен (ComfyUI + LLM)')
              } else if (comfyOk || llmOk) {
                toast.success('Часть выгружена из VRAM')
              } else {
                const errors: string[] = []
                if (comfyRes.status === 'fulfilled' && comfyRes.value.error) errors.push(comfyRes.value.error)
                if (llmRes.status === 'fulfilled' && llmRes.value.error) errors.push(llmRes.value.error)
                toast.error(errors.join('; ') || 'Не удалось выгрузить кэш')
              }
            } catch {
              toast.error('Сервисы недоступны')
            }
          }}
          className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-red-400 transition-colors"
          title="Выгрузить модели ComfyUI и LLM из VRAM"
        >
          <Trash2Icon className="w-3 h-3" />
          Выгрузить кэш VRAM
        </button>
      </div>
    </div>
  )
}
