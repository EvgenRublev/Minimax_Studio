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

      {busy && (
        <p className="mt-2 text-[11px] text-muted-foreground">
          {tt('Идёт смена ядра: ComfyUI перезапущется сам, окно можно свернуть.')}
        </p>
      )}
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
