'use client'

/**
 * GalleryView (правка 91) — полная библиотека сгенерированных видео.
 *
 * Справа — рейка папок: «Все видео» (всё подряд), «Общая» (корень output,
 * есть всегда) и папки проектов (подпапки output). Папки создаются кнопкой
 * «+», переименовываются карандашом (правка 122), удаляются крестиком
 * (только пустые). Видео перетаскиваются в папки drag&drop'ом (карточки
 * грида уже draggable — тем же MIME, что и для Upscale; drop-цели здесь
 * читают его).
 *
 * (правка 495) Вложенные папки: путь 'проект/сцены', в рейке — дерево с
 * отступом по глубине. Подпапка создаётся кнопкой «+» на строке родителя
 * или путём со слэшем в поле создания («проект/сцены»). Фильтр по папке
 * включает содержимое её подпапок (префиксное совпадение); счётчики — тоже.
 * Переименование меняет имя листа (родитель сохраняется); вложенные папки
 * переезжают вместе с родителем — фильтр и активная папка генерации
 * переписываются по префиксу.
 *
 * Выбор на этой вкладке НЕ влияет на вкладку «Генерация» — у неё своя
 * активная папка (gen-store → video.outputFolder).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import {
  CheckIcon,
  FilmIcon,
  FolderIcon,
  FolderPlusIcon,
  LayersIcon,
  PencilIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useGenStore } from '@/lib/gen-store'
import { VideoGalleryGrid, H3_VIDEO_DND_MIME } from './video-gallery-grid'
import { useVideoGallery } from './use-video-gallery'

type FolderFilter = '__all__' | '' | string

interface DragPayload {
  filename: string
  subfolder?: string
}

/** (правка 495) Файл лежит в папке folder или в любой её подпапке.
 *  folder '' (общая) — только корень, без папок проектов. */
function inFolder(subfolder: string, folder: string): boolean {
  if (folder === '') return subfolder === ''
  return subfolder === folder || subfolder.startsWith(folder + '/')
}

/** Лист пути папки: 'проект/сцены' → 'сцены'. */
function leafName(folder: string): string {
  const i = folder.lastIndexOf('/')
  return i === -1 ? folder : folder.slice(i + 1)
}

/** (правка 495) Переписать путь после переименования/переноса папки:
 *  сама папка и все её потомки. */
function remapFolderPath(value: string, oldPath: string, newPath: string): string {
  if (value === oldPath) return newPath
  if (value.startsWith(oldPath + '/')) return newPath + value.slice(oldPath.length)
  return value
}

export function GalleryView() {
  const { files, folders, loading, load, deleteFile } = useVideoGallery()
  const [filter, setFilter] = useState<FolderFilter>('__all__')
  const [creating, setCreating] = useState(false)
  /** (правка 495) Родитель создаваемой папки ('' = корень output). */
  const [createParent, setCreateParent] = useState('')
  const [newName, setNewName] = useState('')
  // (правка 122) Переименование: путь папки + новое значение (имя листа)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [dragOver, setDragOver] = useState<string | null>(null)
  const newInputRef = useRef<HTMLInputElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (creating) newInputRef.current?.focus()
  }, [creating])

  useEffect(() => {
    if (renaming) {
      renameInputRef.current?.focus()
      renameInputRef.current?.select()
    }
  }, [renaming])

  /** (правка 495) Счётчики — с учётом вложенных папок (префикс). */
  const countFor = useCallback(
    (key: FolderFilter) => {
      if (key === '__all__') return files.length
      return files.filter((f) => inFolder(f.subfolder || '', key)).length
    },
    [files],
  )

  const visibleFiles = useMemo(
    () => (filter === '__all__' ? files : files.filter((f) => inFolder(f.subfolder || '', filter))),
    [files, filter],
  )

  const startCreate = useCallback((parent: string) => {
    setCreateParent(parent)
    setNewName('')
    setCreating(true)
  }, [])

  const createFolder = useCallback(async () => {
    const name = newName.trim()
    if (!name) return
    // (правка 495) Полный путь: родитель + введённое имя (само имя тоже
    // может содержать '/', чтобы создать цепочку сразу).
    const full = createParent ? `${createParent}/${name}` : name
    try {
      const r = await fetch('/api/comfy/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: full }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
      toast.success('Папка создана', { description: d.name })
      setCreating(false)
      setNewName('')
      setCreateParent('')
      setFilter(d.name)
      await load(true)
    } catch (err) {
      toast.error('Не удалось создать папку', { description: err instanceof Error ? err.message : String(err) })
    }
  }, [newName, createParent, load])

  /** (правка 122) Переименовать папку. Синхронизируем активную папку
   *  вкладки «Генерация» (gen-store), если она указывает на переименованную.
   *  (правка 495) Переписываем по префиксу: потомки переезжают вместе с
   *  родителем. */
  const renameFolder = useCallback(async (oldName: string) => {
    const to = renameValue.trim()
    if (!to) { setRenaming(null); return }
    try {
      const r = await fetch('/api/comfy/folders', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: oldName, to }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
      toast.success('Папка переименована', { description: `«${oldName}» → «${d.name}»` })
      if (filter !== '__all__') setFilter((cur) => remapFolderPath(cur, oldName, d.name))
      // Активная папка генерации — обновляем, если совпадает со старой
      const gen = useGenStore.getState()
      if (gen.video.outputFolder) {
        gen.patchVideo({ outputFolder: remapFolderPath(gen.video.outputFolder, oldName, d.name) })
      }
      setRenaming(null)
      setRenameValue('')
      await load(true)
    } catch (err) {
      toast.error('Не удалось переименовать папку', { description: err instanceof Error ? err.message : String(err) })
    }
  }, [renameValue, filter, load])

  const deleteFolder = useCallback(async (name: string) => {
    if (!confirm(`Удалить папку «${name}»?\nПапка должна быть пустой (без видео и подпапок) — содержимое не пострадает.`)) return
    try {
      const r = await fetch('/api/comfy/folders', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
      toast.success('Папка удалена')
      // (правка 495) Фильтр мог указывать на удалённую папку или её потомка.
      if (filter !== '__all__' && inFolder(filter, name) ) setFilter('__all__')
      await load(true)
    } catch (err) {
      toast.error('Не удалось удалить папку', { description: err instanceof Error ? err.message : String(err) })
    }
  }, [filter, load])

  /** Drop видео на папку: читаем MIME грида и просим сервер переместить файл. */
  const handleDrop = useCallback(async (e: React.DragEvent, targetFolder: string) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(null)
    // «Все видео» — не папка, drop туда бессмыслен
    if (targetFolder === '__all__') return
    let payload: DragPayload | null = null
    try {
      payload = JSON.parse(e.dataTransfer.getData(H3_VIDEO_DND_MIME)) as DragPayload
    } catch { /* не наше DnD (например, файл из проводника) — игнор */ }
    if (!payload?.filename) return
    const from = payload.subfolder || ''
    if (from === targetFolder) return
    try {
      const r = await fetch('/api/comfy/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: payload.filename, from, to: targetFolder }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
      toast.success(`Перемещено в «${targetFolder || 'Общая'}»`, { description: payload.filename })
      await load(true)
    } catch (err) {
      toast.error('Не удалось переместить', { description: err instanceof Error ? err.message : String(err) })
    }
  }, [load])

  const folderItem = (
    key: FolderFilter,
    icon: React.ReactNode,
    label: string,
    opts?: { onDelete?: boolean; onRename?: boolean; onAddChild?: boolean; depth?: number },
  ) => {
    const active = filter === key
    const count = countFor(key)
    const isRenaming = renaming === key
    const depth = opts?.depth ?? 0
    return (
      <div
        key={key}
        onClick={() => setFilter(key)}
        onDragOver={(e) => {
          if (key !== '__all__') {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            setDragOver(key)
          }
        }}
        onDragLeave={() => setDragOver((cur) => (cur === key ? null : cur))}
        onDrop={(e) => void handleDrop(e, key)}
        style={depth > 0 ? { paddingLeft: 12 + depth * 14 } : undefined}
        title={typeof key === 'string' && key.includes('/') ? key : undefined}
        className={cn(
          'group flex items-center gap-2 px-3 py-2 cursor-pointer border-b border-border/40 transition-colors',
          active ? 'bg-violet-500/10' : 'hover:bg-white/5',
          dragOver === key && 'ring-1 ring-violet-400/60 bg-violet-500/15',
        )}
      >
        <span className={cn('shrink-0', active ? 'text-violet-400' : 'text-muted-foreground/60')}>{icon}</span>
        {isRenaming ? (
          /* (правка 122) inline-переименование вместо имени */
          <span
            className="flex-1 min-w-0 flex items-center gap-1"
            onClick={(e) => e.stopPropagation()}
          >
            <input
              ref={renameInputRef}
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void renameFolder(key)
                if (e.key === 'Escape') setRenaming(null)
              }}
              placeholder="Новое имя…"
              className="w-full min-w-0 rounded-md border border-border bg-background px-1.5 py-0.5 text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-violet-500/40"
              maxLength={60}
            />
            <button
              type="button"
              onClick={() => void renameFolder(key)}
              className="shrink-0 w-4 h-4 flex items-center justify-center text-emerald-400/80 hover:text-emerald-300"
              title="Сохранить (Enter)"
            >
              <CheckIcon className="w-3 h-3" />
            </button>
            <button
              type="button"
              onClick={() => setRenaming(null)}
              className="shrink-0 w-4 h-4 flex items-center justify-center text-muted-foreground/60 hover:text-foreground"
              title="Отмена (Esc)"
            >
              <XIcon className="w-3 h-3" />
            </button>
          </span>
        ) : (
          <>
            <span className={cn('flex-1 min-w-0 truncate text-xs', active ? 'text-foreground' : 'text-foreground/80')}>
              {label}
            </span>
            <span className="text-[10px] text-muted-foreground/60 shrink-0 tabular-nums">{count}</span>
          </>
        )}
        {opts?.onAddChild && !isRenaming && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); startCreate(key) }}
            className="shrink-0 w-4 h-4 flex items-center justify-center text-muted-foreground/40 hover:text-violet-300 opacity-0 group-hover:opacity-100 transition-opacity"
            title="Создать подпапку"
          >
            <FolderPlusIcon className="w-3 h-3" />
          </button>
        )}
        {opts?.onRename && !isRenaming && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              setRenaming(key)
              setRenameValue(label)
            }}
            className="shrink-0 w-4 h-4 flex items-center justify-center text-muted-foreground/40 hover:text-violet-300 opacity-0 group-hover:opacity-100 transition-opacity"
            title="Переименовать папку"
          >
            <PencilIcon className="w-3 h-3" />
          </button>
        )}
        {opts?.onDelete && !isRenaming && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); void deleteFolder(key) }}
            className="shrink-0 w-4 h-4 flex items-center justify-center text-muted-foreground/40 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
            title="Удалить папку (только пустую)"
          >
            <Trash2Icon className="w-3 h-3" />
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-row min-h-0 bg-[var(--surface-1)]">
      {/* Main content */}
      <div className="flex-1 flex flex-col min-h-0 min-w-0">
        {/* Header */}
        <div className="px-6 pt-5 pb-3 shrink-0 aurora-bg">
          <div className="flex items-end justify-between gap-4">
            <div>
              <h1 className="text-xl font-semibold text-foreground flex items-center gap-2.5">
                <span className="w-9 h-9 rounded-xl gradient-creative flex items-center justify-center shrink-0 shadow-lg shadow-violet-500/20">
                  <FilmIcon className="w-4.5 h-4.5 text-white" />
                </span>
                Галерея
              </h1>
              <p className="text-xs text-muted-foreground mt-1.5">
                {filter === '__all__'
                  ? 'Все видео из всех папок'
                  : filter === ''
                    ? 'Общая папка (без проектов)'
                    : `Папка «${filter}» (включая подпапки)`}
                {!loading && (
                  <> · <span className="text-foreground/80 font-medium">{visibleFiles.length}</span> шт.</>
                )}
              </p>
            </div>
          </div>
        </div>

        {/* Grid */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
          className="flex-1 overflow-y-auto px-6 pb-6 min-h-0"
        >
          <VideoGalleryGrid
            files={visibleFiles}
            loading={loading}
            onRefresh={load}
            onDeleteFile={deleteFile}
            emptyHint="Пока нет видео. Сгенерируйте первое на вкладке «Генерация»."
          />
        </motion.div>
      </div>

      {/* Right rail: folders (правка 91) */}
      <div className="w-56 border-l border-border flex flex-col bg-[var(--surface-0)]/60 shrink-0">
        <div className="p-3 border-b border-border flex items-center gap-2">
          <span className="text-xs font-medium text-foreground flex-1">Папки</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => startCreate(filter !== '__all__' ? filter : '')}
            className="h-7 gap-1 text-xs"
            title="Создать папку проекта (внутри выбранной, если она выбрана)"
          >
            <FolderPlusIcon className="w-3.5 h-3.5" />
          </Button>
        </div>

        {/* New folder input */}
        {creating && (
          <div className="p-2 border-b border-border/60 space-y-1.5">
            {createParent && (
              <p className="text-[10px] text-muted-foreground/60 leading-snug">
                Подпапка в «{createParent}»
              </p>
            )}
            <input
              ref={newInputRef}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void createFolder()
                if (e.key === 'Escape') setCreating(false)
              }}
              placeholder="Имя папки…"
              className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-violet-500/40"
              maxLength={120}
            />
            <div className="flex gap-1.5">
              <Button size="sm" onClick={() => void createFolder()} disabled={!newName.trim()} className="h-6 text-[10px] px-2 flex-1">
                Создать
              </Button>
              <Button variant="outline" size="sm" onClick={() => setCreating(false)} className="h-6 text-[10px] px-2">
                Отмена
              </Button>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {folderItem('__all__', <LayersIcon className="w-3.5 h-3.5" />, 'Все видео')}
          {folderItem('', <FilmIcon className="w-3.5 h-3.5" />, 'Общая', { onAddChild: true })}
          {/* (правка 495) Папки приходят отсортированными (родитель раньше
              детей) — рисуем дерево отступами по глубине пути. */}
          {folders.map((f) =>
            folderItem(
              f,
              <FolderIcon className="w-3.5 h-3.5" />,
              leafName(f),
              { onRename: true, onDelete: true, onAddChild: true, depth: f.split('/').length - 1 },
            ),
          )}
        </div>

        <p className="px-3 py-2 text-[10px] text-muted-foreground/50 border-t border-border/60 leading-snug">
          Перетащите видео на папку, чтобы переместить его. «+» на строке папки создаёт подпапку; папку можно переименовать (карандаш) или удалить (крестик, только пустую). Папку можно выбрать и на вкладке «Генерация» — новые видео будут ложиться в неё.
        </p>
      </div>
    </div>
  )
}
