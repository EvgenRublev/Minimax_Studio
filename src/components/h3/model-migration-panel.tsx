'use client'

/**
 * Migration from an old version of the app (правка 47, 64, 74; ПРАВКА 765).
 *
 * (правка 765) Категории — содержимое папок целиком: models, input, output,
 * data (чаты ассистента, пресеты). Коллизии имен больше не молчат:
 * отличающиеся файлы переносятся под новым именем (счётчик «переименовано»).
 */
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  FolderOpenIcon,
  Loader2Icon,
  CheckCircleIcon,
  AlertTriangleIcon,
  ArrowRightIcon,
  ChevronDownIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { reloadAssistantChats } from '@/lib/assistant-chats-sync'
import { useTranslation } from 'react-i18next' // (правка 955)

interface CategoryResult {
  enabled: boolean
  found: boolean
  dir: string | null
  file?: string | null
  moved: number
  skipped: number
  /** (правка 765) Перенесено под новым именем (коллизия с другим содержимым). */
  renamed: number
  errors: string[]
}

interface MigrateResult {
  models: CategoryResult
  input: CategoryResult
  output: CategoryResult
  data: CategoryResult
}

export function ModelMigrationPanel() {
  const { t } = useTranslation() // (правка 955)

  const [expanded, setExpanded] = useState(false)
  const [sourceDir, setSourceDir] = useState('')
  const [migrating, setMigrating] = useState(false)
  // Выбор категорий переноса (правка 765)
  const [selModels, setSelModels] = useState(true)
  const [selInput, setSelInput] = useState(true)
  const [selOutput, setSelOutput] = useState(true)
  const [selData, setSelData] = useState(true)
  const [result, setResult] = useState<MigrateResult | null>(null)

  const nothingSelected = !selModels && !selInput && !selOutput && !selData

  const handleMigrate = async () => {
    if (!sourceDir.trim()) {
      toast.error(t("Укажите путь к папке старой версии."))
      return
    }
    if (nothingSelected) {
      toast.error(t("Выберите, что переносить: модели, файлы, контент и/или данные."))
      return
    }

    setMigrating(true)
    setResult(null)
    try {
      const res = await fetch('/api/models/migrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceDir: sourceDir.trim(),
          items: { models: selModels, input: selInput, output: selOutput, data: selData },
        }),
      })
      const data = await res.json()

      if (!res.ok) {
        toast.error(data.error || 'Ошибка переноса.')
      } else {
        setResult(data as MigrateResult)
        const parts: string[] = []
        for (const [cat, label] of [
          [data.models, 'Модели'],
          [data.input, 'Файлы ввода'],
          [data.output, 'Контент'],
          [data.data, 'Данные'],
        ] as const) {
          if (!cat.enabled) continue
          if (cat.found) {
            let p = `${label}: перенесено ${cat.moved + cat.renamed}`
            if (cat.renamed > 0) p += ` (под новыми именами: ${cat.renamed})`
            p += `, дубликатов пропущено: ${cat.skipped}`
            parts.push(p)
          } else {
            parts.push(`${label}: не найдено`)
          }
        }
        const cats = [data.models, data.input, data.output, data.data]
        const errCount = cats.reduce((s, c) => s + c.errors.length, 0)
        const allFound = cats.every((c) => !c.enabled || c.found)
        const msg = parts.join(' · ')
        if (allFound && errCount === 0) {
          toast.success(msg)
        } else {
          toast.warning(msg + (errCount > 0 ? t("· Ошибок: {{p1}}", { p1: errCount }) : ''))
        }

        // (правка 74) Чаты перенесены — подгружаем их в UI (вкладка «Ассистент»)
        if (data.data.enabled && data.data.found && data.data.moved > 0) {
          await reloadAssistantChats()
        }
      }
    } catch (err) {
      toast.error(t("Ошибка: {{p1}}", { p1: err instanceof Error ? err.message : String(err) }))
    } finally {
      setMigrating(false)
    }
  }

  return (
    <div className="divide-y divide-border/50">
      {/* Строка-переключатель: раскрывает форму переноса */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        disabled={migrating}
        className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left transition-colors hover:bg-[var(--surface-1)]"
      >
        <FolderOpenIcon className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 text-xs text-foreground/90">
          {t("Выбрать папку старой версии и перенести")}
        </span>
        <ChevronDownIcon className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-180')} />
      </button>

      {/* Expanded form */}
      {expanded && (
        <div className="space-y-3 px-3.5 py-3">
          <div className="space-y-1.5">
            <label className="text-[11px] text-muted-foreground">{t("Папка старой версии")}</label>
            <Button
              variant="outline"
              size="sm"
              className="h-8 w-full justify-start gap-1.5 text-left text-xs font-normal"
              onClick={async () => {
                try {
                  const res = await fetch('/api/dialog/folder', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ title: t("Выберите папку со старой версией программы") }),
                  })
                  const data = await res.json()
                  if (!res.ok) {
                    toast.error(data.error || 'Не удалось открыть диалог выбора папки.')
                    return
                  }
                  if (data.path) {
                    setSourceDir(data.path)
                  }
                } catch {
                  toast.error(t("Не удалось открыть диалог выбора папки."))
                }
              }}
              disabled={migrating}
            >
              <FolderOpenIcon className="w-3.5 h-3.5 shrink-0" />
              <span className={cn('truncate', !sourceDir && 'text-muted-foreground/60')}>
                {sourceDir || t("Выбрать папку…")}
              </span>
            </Button>
          </div>

          {/* (правка 765) Выбор категорий переноса */}
          <div className="space-y-1.5">
            <label className="text-[11px] text-muted-foreground">{t("Что перенести")}</label>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              <label className="flex cursor-pointer select-none items-center gap-1.5 text-xs text-foreground/80">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-cyan-500"
                  checked={selModels}
                  onChange={(e) => setSelModels(e.target.checked)}
                  disabled={migrating}
                />
                {' '}{t("Модели")}
              </label>
              <label className="flex cursor-pointer select-none items-center gap-1.5 text-xs text-foreground/80">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-cyan-500"
                  checked={selInput}
                  onChange={(e) => setSelInput(e.target.checked)}
                  disabled={migrating}
                />
                {' '}{t("Файлы ввода (что кидал)")}
              </label>
              <label className="flex cursor-pointer select-none items-center gap-1.5 text-xs text-foreground/80">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-cyan-500"
                  checked={selOutput}
                  onChange={(e) => setSelOutput(e.target.checked)}
                  disabled={migrating}
                />
                {' '}{t("Контент (output)")}
              </label>
              <label className="flex cursor-pointer select-none items-center gap-1.5 text-xs text-foreground/80">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-cyan-500"
                  checked={selData}
                  onChange={(e) => setSelData(e.target.checked)}
                  disabled={migrating}
                />
                {' '}{t("Данные (чаты, пресеты)")}
              </label>
            </div>
          </div>

          <Button
            size="sm"
            className="h-8 w-fit gap-1.5 text-xs"
            onClick={handleMigrate}
            disabled={migrating || nothingSelected}
          >
            {migrating ? (
              <>
                <Loader2Icon className="w-3.5 h-3.5 animate-spin" />
                {' '}{t("Перенос...")}
              </>
            ) : (
              <>
                <ArrowRightIcon className="w-3.5 h-3.5" />
                {' '}{t("Начать перенос")}
              </>
            )}
          </Button>

          <p className="text-[11px] leading-snug text-muted-foreground">
            {t("Программа найдёт в выбранной папке папки \"models\", \"input\", \"output\" и \"data\" (до 3 уровней глубины) и перенесёт их содержимое в текущую установку. Файлы с одинаковым именем и размером считаются дубликатами; если файл с таким же именем ДРУГОЙ — он переносится под новым именем (суффикс \"_restored\"), ничего не перезаписывается и не теряется.")}
          </p>

          {/* Result panels — по одной карточке на категорию */}
          {result && (
            <div className="space-y-2">
              <CategoryCard label={t("Модели")} cat={result.models} unit="файлов" />
              <CategoryCard label={t("Файлы ввода")} cat={result.input} unit="файлов" />
              <CategoryCard label={t("Контент")} cat={result.output} unit="файлов" />
              <CategoryCard label={t("Данные (чаты, пресеты)")} cat={result.data} unit="файлов" />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Карточка результата переноса одной категории. */
function CategoryCard({ label, cat, unit = 'файлов' }: { label: string; cat: CategoryResult; unit?: string }) {
  const { t } = useTranslation() // (правка 955)

  if (!cat.enabled) return null

  return (
    <div className="space-y-1.5 rounded-md border border-border/60 bg-[var(--surface-1)] p-2.5">
      <div className="flex items-center gap-2 text-xs">
        {cat.found ? (
          <CheckCircleIcon className="w-3.5 h-3.5 text-emerald-500" />
        ) : (
          <AlertTriangleIcon className="w-3.5 h-3.5 text-amber-500" />
        )}
        <span className="font-medium text-foreground/90">{label}</span>
        <span className={cn('ml-auto text-xs', cat.found ? 'text-emerald-500' : 'text-amber-500')}>
          {cat.found ? t("Готово") : t("Не найдено")}
        </span>
      </div>

      {cat.found ? (
        <div className="text-xs text-muted-foreground space-y-0.5">
          {(cat.file || cat.dir) && (
            <p className="break-all">
              {cat.file ? t("Файл:") : t("Папка:")}
              <code className="text-xs">{cat.file ?? cat.dir}</code>
            </p>
          )}
          <p>
            {t("Перенесено")}{' '} {unit}: <span className="text-emerald-400 font-medium">{cat.moved}</span>
            {cat.renamed > 0 && (
              <>
                {' · '}
                {' '}{t("Под новым именем:")}{' '} <span className="text-sky-400 font-medium">{cat.renamed}</span>
              </>
            )}
            {' · '}
            {' '}{t("Дубликатов пропущено:")}{' '} <span className="text-amber-400 font-medium">{cat.skipped}</span>
          </p>
          {cat.errors.length > 0 && (
            <>
              <p className="text-red-400">{t("Ошибок:")}{' '} {cat.errors.length}</p>
              <ul className="list-disc pl-4 space-y-0.5 max-h-24 overflow-y-auto">
                {cat.errors.map((e, i) => (
                  <li key={i} className="text-red-300/80 text-xs break-all">{e}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      ) : (
        cat.errors.length > 0 && (
          <p className="text-xs text-amber-400">{cat.errors[0]}</p>
        )
      )}
    </div>
  )
}
