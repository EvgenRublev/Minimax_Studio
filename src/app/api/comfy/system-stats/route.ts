import { NextResponse } from 'next/server'
import os from 'os'
import { promisify } from 'util'
import { exec } from 'child_process'

const execAsync = promisify(exec)

// Cache last result to avoid hammering nvidia-smi
let lastResult: { data: unknown; ts: number } = { data: null, ts: 0 }
const CACHE_MS = 4000 // 4 second cache

// ── CPU: continuous background measurement (1 s interval) ──
let cpuPercent = 0
let lastCpuTimes: { idle: number; total: number } | null = null

function measureCpu(): void {
  try {
    const cpus = os.cpus()
    let idle = 0
    let total = 0
    for (const cpu of cpus) {
      idle += cpu.times.idle
      total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq + cpu.times.idle
    }
    if (lastCpuTimes) {
      const idleDelta = idle - lastCpuTimes.idle
      const totalDelta = total - lastCpuTimes.total
      if (totalDelta > 0) {
        cpuPercent = Math.min(100, Math.round(((totalDelta - idleDelta) / totalDelta) * 100))
      }
    }
    lastCpuTimes = { idle, total }
  } catch {
    // ignore
  }
}

// Prime the baseline, then measure every second in the background
// (правка 716) Таймер создаётся ЛЕНИВО (при первом GET) и хранится в
// module-level переменной. Раньше он создавался на уровне модуля — в dev-режиме
// Next.js перезагружает модуль при каждом HMR-обновлении, и каждый перезапуск
// добавлял ещё один 1-секундный таймер (и ещё один полный os.cpus()).
let cpuTimer: ReturnType<typeof setInterval> | null = null

function ensureCpuTimer() {
  if (cpuTimer) return
  measureCpu()
  cpuTimer = setInterval(measureCpu, 1000)
  cpuTimer.unref()
}

export async function GET() {
  ensureCpuTimer()
  // Return cached result if fresh
  if (lastResult.data && Date.now() - lastResult.ts < CACHE_MS) {
    return NextResponse.json(lastResult.data)
  }

  const data: Record<string, unknown> = {}

  // CPU (continuously measured in background, 1 s resolution)
  data.cpu = { percent: cpuPercent }

  // RAM
  try {
    const totalMem = os.totalmem()
    const freeMem = os.freemem()
    const usedMem = totalMem - freeMem
    const gb = 1024 ** 3
    data.ram = {
      percent: Math.round((usedMem / totalMem) * 100),
      used_gb: +(usedMem / gb).toFixed(1),
      total_gb: +(totalMem / gb).toFixed(1),
    }
  } catch {
    data.ram = { percent: 0, used_gb: 0, total_gb: 0 }
  }

  // GPU (nvidia-smi)
  let vram_used_gb = 0
  let vram_total_gb = 0
  let gpu_util_percent = 0
  let gpu_available = false

  try {
    const { stdout } = await execAsync(
      'nvidia-smi --query-gpu=memory.used,memory.total,utilization.gpu --format=csv,noheader,nounits',
      { timeout: 3000 }
    )
    const line = stdout.trim().split('\n')[0]
    const [used, total, util] = line.split(',').map(s => parseInt(s.trim(), 10))
    if (!isNaN(used) && !isNaN(total)) {
      vram_used_gb = used / 1024 // MiB → GiB
      vram_total_gb = total / 1024
      gpu_util_percent = !isNaN(util) ? util : 0
      gpu_available = true
    }
  } catch {
    // No GPU or nvidia-smi not found
  }

  data.gpu = {
    available: gpu_available,
    vram_used_gb: +vram_used_gb.toFixed(1),
    vram_total_gb: +vram_total_gb.toFixed(1),
    utilization_percent: gpu_util_percent,
  }

  lastResult = { data, ts: Date.now() }
  return NextResponse.json(data)
}
