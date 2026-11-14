'use client'

/**
 * (правка 997) Выбор папки сохранения результата — одинаковый на всех
 * вкладках, прямо над кнопкой запуска.
 */
import { useEffect, useState } from 'react'
import { FolderIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

export function OutputFolderPicker({
  value,
  onChange,
  className,
}: {
  value: string
  onChange: (folder: string) => void
  className?: string
}) {
  const { t } = useTranslation()
  const [folders, setFolders] = useState<string[]>([])

  useEffect(() => {
    let cancelled = false
    void fetch('/api/comfy/folders')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { folders?: string[] } | null) => {
        if (!cancelled && Array.isArray(d?.folders)) setFolders(d.folders)
      })
      .catch(() => { /* папки не критичны */ })
    return () => { cancelled = true }
  }, [])

  const list = value && !folders.includes(value) ? [value, ...folders] : folders

  return (
    <label
      className={cn('flex items-center gap-2 text-[11px] text-muted-foreground', className)}
      title={t("Куда сохранить результат: общая папка output или выбранная папка проекта")}
    >
      <FolderIcon className="h-3.5 w-3.5 shrink-0 text-violet-400" />
      <span className="shrink-0">{t("Папка:")}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 min-w-0 flex-1 rounded-md border border-border bg-[var(--surface-2)] px-2 text-[11px] text-foreground outline-none focus:border-cyan-500/60 focus:ring-1 focus:ring-cyan-500/30"
      >
        <option value="">{t("Общая папка")}</option>
        {list.map((f) => (
          <option key={f} value={f}>{f}</option>
        ))}
      </select>
    </label>
  )
}
