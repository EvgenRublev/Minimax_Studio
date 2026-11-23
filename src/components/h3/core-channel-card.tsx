'use client'

/**
 * (правка 1080) Поколение ядра ComfyUI и его переключение.
 *
 * Студия поддерживает два поколения бэкенда:
 *   • current  — ядро 0.44+ (comfy-aimdo 0.6.0): свежая DynamicVRAM, быстрее;
 *   • rollback — ядро 0.33.x (comfy-aimdo 0.4.13): держит большие разрешения и
 *     длины на картах 8-12 ГБ, где aimdo 0.5.5-0.6.0 уходит в перечитывание
 *     весов с диска (VRAM забита, утилизация 100% при 40-60 Вт, генерация встаёт).
 *
 * Меняет поколение не сам интерфейс, а установщик (install\install.ps1
 * -CoreRollback / -CoreCurrent): только он умеет переносить данные в
 * ComfyUI.keep, возвращать их слиянием и откатываться при сбое. Из студии
 * кнопка дергает main-процесс Electron (h3:core-switch), который останавливает
 * ComfyUI, прогоняет установщик с -SkipApp и поднимает бэкенд заново.
 */
import { useCallback, useEffect, useState } from 'react'
import { ArrowDownIcon, ArrowUpIcon, Loader2Icon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SettingsCard, SettingsNote } from '@/components/h3/settings-ui'
import { useTranslation } from 'react-i18next'

export interface CoreVersionInfo {
  ok?: boolean
  coreExists?: boolean
  version: string | null
  minVersion: string
  /** 'current' | 'rollback' | 'unsupported' (правка 1080) */
  support?: 'current' | 'rollback' | 'unsupported'
  currentMin?: string
  rollbackMin?: string
  rollbackMax?: string
  /** (правка 1115) какие настройки поддерживает установленное ядро */
  capabilities?: { veda?: boolean }
  /** канал, выбранный пользователем: 'rollback' | 'current' | '' */
  channel?: string
  outdated?: boolean
  unknown?: boolean
}

/** Опрос /api/comfy/core-version (дешёвый: читается comfyui_version.py). */
export function useCoreVersion(pollMs = 0) {
  const [info, setInfo] = useState<CoreVersionInfo | null>(null)
  const refresh = useCallback(() => {
    fetch('/api/comfy/core-version')
      .then((r) => r.json())
      .then((d: CoreVersionInfo) => setInfo(d))
      .catch(() => { /* эндпоинт недоступен — показываем то, что есть */ })
  }, [])
  useEffect(() => {
    refresh()
    if (!pollMs) return
    const t = setInterval(refresh, pollMs)
    return () => clearInterval(t)
  }, [refresh, pollMs])
  return { info, refresh }
}

/** (правка 1114) Строка прогресса из /api/setup-status (её пишут установщик и Electron). */
interface SetupProgress {
  state?: 'running' | 'done' | 'error'
  step?: number
  total?: number
  title?: string
  hint?: string
  detail?: string
  elapsed_min?: number
}

/**
 * Карточка «Ядро ComfyUI» в настройках: версия, поколение и обе кнопки
 * переключения. Ответ за себя не держит — состояние приходит с
 * /api/comfy/core-version, когда установщик закончит.
 */
export function CoreChannelCard() {
  const { t: tt } = useTranslation()
  const { info, refresh } = useCoreVersion()
  const [busy, setBusy] = useState<'' | 'rollback' | 'current'>('')
  const [msg, setMsg] = useState<string>('')
  const [prog, setProg] = useState<SetupProgress | null>(null)

  // (правка 1114) Пока идёт смена ядра — опрашиваем статус установщика:
  // остановка ComfyUI → архив/распаковка → замена файлов → база → Python-пины →
  // запуск бэкенда. Раньше в карточке была только надпись «идёт смена».
  useEffect(() => {
    if (!busy) { setProg(null); return }
    let cancelled = false
    const tick = async () => {
      try {
        const r = await fetch('/api/setup-status', { cache: 'no-store' })
        if (!r.ok) return
        const d = (await r.json()) as { status?: SetupProgress | null }
        if (!cancelled && d?.status) setProg(d.status)
      } catch { /* установщик ещё не записал статус — покажем «Готовлю…» */ }
    }
    void tick()
    const timer = setInterval(tick, 700)
    return () => { cancelled = true; clearInterval(timer) }
  }, [busy])

  const canSwitch = typeof window !== 'undefined' && !!window.h3desktop?.comfy?.switchCore
  const version = info?.version || '?'
  const support = info?.support || 'current'

  const run = async (to: 'rollback' | 'current') => {
    if (busy) return
    const bridge = window.h3desktop?.comfy?.switchCore
    if (!bridge) return
    setBusy(to)
    setMsg('')
    const res = await bridge(to).catch((e: unknown) => ({
      ok: false,
      error: String((e as Error)?.message || e),
    }))
    setBusy('')
    setMsg(res?.ok
      ? tt('Ядро обновлено, ComfyUI перезапущен.')
      : (res?.error || tt('Смена ядра не удалась')))
    refresh()
  }

  return (
    <SettingsCard
      icon={<ArrowDownIcon className="w-4 h-4" />}
      title={tt('Ядро ComfyUI')}
      description={tt('Версия бэкенда генерации. Откатное ядро медленнее, но держит большие разрешения на слабых картах.')}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium text-foreground/90">ComfyUI {version}</span>
        <span className="text-muted-foreground">
          {support === 'rollback'
            ? tt('откатное (comfy-aimdo 0.4.13)')
            : support === 'unsupported'
              ? tt('не поддерживается этой версией студии')
              : tt('актуальное')}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          className="h-8 text-xs"
          disabled={!canSwitch || !!busy || support === 'rollback'}
          onClick={() => void run('rollback')}
          title={canSwitch ? tt('Ставит ядро 0.33.x и comfy-aimdo 0.4.13; модели и ноды не трогаются') : tt('Доступно в десктопной версии студии')}
        >
          {busy === 'rollback' ? <Loader2Icon className="w-3 h-3 animate-spin" /> : <ArrowDownIcon className="w-3 h-3" />}
          {' '}{tt('Откатить ядро')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-8 text-xs"
          disabled={!canSwitch || !!busy || support === 'current'}
          onClick={() => void run('current')}
          title={canSwitch ? tt('Возвращает ядро 0.44+ и comfy-aimdo 0.6.0') : tt('Доступно в десктопной версии студии')}
        >
          {busy === 'current' ? <Loader2Icon className="w-3 h-3 animate-spin" /> : <ArrowUpIcon className="w-3 h-3" />}
          {' '}{tt('Вернуть актуальное ядро')}
        </Button>
      </div>
      {busy && (() => {
        const total = prog?.total && prog.total > 0 ? prog.total : 9
        const step = typeof prog?.step === 'number' ? prog.step : 0
        const pct = step > 0 ? Math.min(99, Math.max(4, Math.round((step / total) * 100))) : 6
        return (
          <div className="mt-3 space-y-1.5">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-3)]">
              <div
                className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-blue-500 transition-[width] duration-500"
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="flex items-center justify-between gap-2 text-[11px]">
              <span className="min-w-0 truncate text-foreground/90">
                {prog?.title || tt('Готовлю смену ядра…')}
              </span>
              <span className="shrink-0 font-mono text-muted-foreground">
                {step > 0 ? `${step}/${total}` : '…'}
              </span>
            </div>
            {prog?.hint && <p className="text-[11px] leading-snug text-muted-foreground">{prog.hint}</p>}
            {prog?.detail && <p className="text-[10px] font-mono text-muted-foreground/70">{prog.detail}</p>}
            <div className="flex flex-wrap items-center gap-x-2 text-[10px] text-muted-foreground/70">
              <span>{tt('ComfyUI перезапустится сам, окно можно свернуть.')}</span>
              {(prog?.elapsed_min ?? 0) > 0 && <span className="font-mono">· {prog?.elapsed_min} {tt('мин')}</span>}
            </div>
          </div>
        )
      })()}
      {msg && (
        <p className="mt-2 text-[11px] text-muted-foreground">{msg}</p>
      )}

      <SettingsNote>
        {canSwitch
          ? tt('Модели, custom_nodes, user, output и input остаются на месте: меняется только ядро и его Python-пины.')
          : tt('В браузерной версии смена ядра недоступна: запустите install.bat с ключом -CoreRollback.')}
      </SettingsNote>
    </SettingsCard>
  )
}
