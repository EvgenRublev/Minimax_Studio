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
  ChevronDownIcon,
  ChevronRightIcon,
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useGenStore } from '@/lib/gen-store'
import { VideoGalleryGrid, H3_VIDEO_DND_MIME } from './video-gallery-grid'
import { useVideoGallery } from './use-video-gallery'
import { useTranslation } from 'react-i18next' // (правка 955)

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
  const { t } = useTranslation() // (правка 955)

  const { files, folders, loading, load, deleteFile, toggleLike } = useVideoGallery()
  const [filter, setFilter] = useState<FolderFilter>('__all__')
  // (правка 793) Фильтр «только избранные» — по флагу liked в сайдкарах.
  const [onlyLiked, setOnlyLiked] = useState(false)
  const [creating, setCreating] = useState(false)
  /** (правка 495) Родитель создаваемой папки ('' = корень output). */
  const [createParent, setCreateParent] = useState('')
  const [newName, setNewName] = useState('')
  // (правка 122) Переименование: путь папки + новое значение (имя листа)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [dragOver, setDragOver] = useState<string | null>(null)
  // (правка 1014) Свёрнутые папки: путь родителя → его подпапки скрыты.
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set())
  // (правка 1015) Тематическое подтверждение удаления вместо нативного белого окна.
  const [folderToDelete, setFolderToDelete] = useState<string | null>(null)
  const [deletingFolder, setDeletingFolder] = useState(false)
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

  /** (правка 1014) Есть ли у папки вложенные папки. */
  const hasSubfolders = useCallback(
    (folder: string) => folders.some((f) => f.startsWith(folder + '/')),
    [folders],
  )

  /** (правка 1014) Дерево с учётом свёрнутых родителей. */
  const visibleFolders = useMemo(() => {
    return folders.filter((f) => {
      const parts = f.split('/')
      for (let i = 1; i < parts.length; i++) {
        if (collapsedFolders.has(parts.slice(0, i).join('/'))) return false
      }
      return true
    })
  }, [folders, collapsedFolders])

  // Если активной стала подпапка свёрнутого родителя — раскрываем её.
  useEffect(() => {
    if (filter === '__all__' || filter === '') return
    const parts = filter.split('/')
    const ancestors = Array.from({ length: Math.max(0, parts.length - 1) }, (_, i) =>
      parts.slice(0, i + 1).join('/'),
    )
    setCollapsedFolders((prev) => {
      const next = new Set(prev)
      for (const a of ancestors) next.delete(a)
      return next.size === prev.size ? prev : next
    })
  }, [filter])

  const toggleFolder = useCallback((folder: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev)
      if (next.has(folder)) next.delete(folder)
      else next.add(folder)
      return next
    })
  }, [])

  /** (правка 495) Счётчики — с учётом вложенных папок (префикс). */
  const countFor = useCallback(
    (key: FolderFilter) => {
      if (key === '__all__') return files.length
      return files.filter((f) => inFolder(f.subfolder || '', key)).length
    },
    [files],
  )

  // (правка 793) Список текущей папки, затем фильтр «только избранные».
  // likedCount — сколько избранных в текущей папке (для чипа в тулбаре).
  const folderFiles = useMemo(
    () => (filter === '__all__' ? files : files.filter((f) => inFolder(f.subfolder || '', filter))),
    [files, filter],
  )
  const likedCount = useMemo(
    () => folderFiles.reduce((n, f) => n + (f.liked ? 1 : 0), 0),
    [folderFiles],
  )
  const visibleFiles = useMemo(
    () => (onlyLiked ? folderFiles.filter((f) => f.liked) : folderFiles),
    [folderFiles, onlyLiked],
  )
  // (правка 793) Избранное в текущей папке кончилось (сняли последнюю
  // звёздочку / удалили файл / перешли в пустую папку) — фильтр гасим сам,
  // иначе грид покажет пустоту без тулбара и фильтр не выключить.
  useEffect(() => {
    if (onlyLiked && likedCount === 0) setOnlyLiked(false)
  }, [onlyLiked, likedCount])
  // Стабильная ссылка на переключатель — иначе memo(VideoGalleryGrid)
  // перерисовывался бы на каждый рендер вью.
  const toggleOnlyLiked = useCallback(() => setOnlyLiked((v) => !v), [])

  const startCreate = useCallback((parent: string) => {
    setCreateParent(parent)
    setNewName('')
    setCreating(true)
    // (правка 1014) Создаём подпапку — раскрываем родителя.
    if (parent) {
      setCollapsedFolders((prev) => {
        if (!prev.has(parent)) return prev
        const next = new Set(prev)
        next.delete(parent)
        return next
      })
    }
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
      toast.success(t("Папка создана"), { description: d.name })
      setCreating(false)
      setNewName('')
      setCreateParent('')
      setFilter(d.name)
      await load(true)
    } catch (err) {
      toast.error(t("Не удалось создать папку"), { description: err instanceof Error ? err.message : String(err) })
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
      toast.success(t("Папка переименована"), { description: `«${oldName}» → «${d.name}»` })
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
      toast.error(t("Не удалось переименовать папку"), { description: err instanceof Error ? err.message : String(err) })
    }
  }, [renameValue, filter, load])

  const deleteFolder = useCallback(async (name: string) => {
    try {
      const r = await fetch('/api/comfy/folders', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
      toast.success(t("Папка удалена"))
      // (правка 495) Фильтр мог указывать на удалённую папку или её потомка.
      if (filter !== '__all__' && inFolder(filter, name)) setFilter('__all__')
      await load(true)
    } catch (err) {
      toast.error(t("Не удалось удалить папку"), { description: err instanceof Error ? err.message : String(err) })
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
      toast.success(t("Перемещено в «{{p1}}»", { p1: targetFolder || 'Общая' }), { description: payload.filename })
      await load(true)
    } catch (err) {
      toast.error(t("Не удалось переместить"), { description: err instanceof Error ? err.message : String(err) })
    }
  }, [load])

  const folderItem = (
    key: FolderFilter,
    icon: React.ReactNode,
    label: string,
    opts?: {
      onDelete?: boolean
      onRename?: boolean
      onAddChild?: boolean
      depth?: number
      /** (правка 1014) Показывать стрелку сворачивания. */
      hasChildren?: boolean
      collapsed?: boolean
      onToggle?: () => void
    },
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
        {opts?.hasChildren && opts.onToggle ? (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); opts.onToggle?.() }}
            className="shrink-0 w-4 h-4 -ml-1 flex items-center justify-center rounded text-muted-foreground/50 hover:text-foreground hover:bg-white/10"
            title={opts.collapsed ? t("Развернуть подпапки") : t("Свернуть подпапки")}
            aria-label={opts.collapsed ? t("Развернуть подпапки") : t("Свернуть подпапки")}
          >
            {opts.collapsed
              ? <ChevronRightIcon className="w-3.5 h-3.5" />
              : <ChevronDownIcon className="w-3.5 h-3.5" />}
          </button>
        ) : (
          <span className="shrink-0 w-4 -ml-1" aria-hidden />
        )}
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
              placeholder={t("Новое имя…")}
              className="w-full min-w-0 rounded-md border border-border bg-background px-1.5 py-0.5 text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-violet-500/40"
              maxLength={60}
            />
            <button
              type="button"
              onClick={() => void renameFolder(key)}
              className="shrink-0 w-4 h-4 flex items-center justify-center text-emerald-400/80 hover:text-emerald-300"
              title={t("Сохранить (Enter)")}
            >
              <CheckIcon className="w-3 h-3" />
            </button>
            <button
              type="button"
              onClick={() => setRenaming(null)}
              className="shrink-0 w-4 h-4 flex items-center justify-center text-muted-foreground/60 hover:text-foreground"
              title={t("Отмена (Esc)")}
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
            title={t("Создать подпапку")}
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
            title={t("Переименовать папку")}
          >
            <PencilIcon className="w-3 h-3" />
          </button>
        )}
        {opts?.onDelete && !isRenaming && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setFolderToDelete(key) }}
            className="shrink-0 w-4 h-4 flex items-center justify-center text-muted-foreground/40 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
            title={t("Удалить папку (только пустую)")}
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
                {' '}{t("Галерея")}
              </h1>
              <p className="text-xs text-muted-foreground mt-1.5">
                {filter === '__all__'
                  ? t("Все видео из всех папок")
                  : filter === ''
                    ? t("Общая папка (без проектов)")
                    : t("Папка «{{p1}}» (включая подпапки)", { p1: filter })}
                {!loading && (
                  <> · <span className="text-foreground/80 font-medium">{visibleFiles.length}</span> {' '}{t("шт.")}</>
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
            onToggleLike={toggleLike}
            onlyLiked={onlyLiked}
            onToggleOnlyLiked={toggleOnlyLiked}
            likedCount={likedCount}
            emptyHint="Пока нет видео. Сгенерируйте первое на вкладке «Генерация»."
          />
        </motion.div>
      </div>

      {/* Right rail: folders (правка 91) — (правка 1014) шире и со сворачиванием. */}
      <div className="w-[340px] border-l border-border flex flex-col bg-[var(--surface-0)]/60 shrink-0">
        <div className="p-3 border-b border-border flex items-center gap-2">
          <span className="text-xs font-medium text-foreground flex-1">{t("Папки")}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => startCreate(filter !== '__all__' ? filter : '')}
            className="h-7 gap-1 text-xs"
            title={t("Создать папку проекта (внутри выбранной, если она выбрана)")}
          >
            <FolderPlusIcon className="w-3.5 h-3.5" />
          </Button>
        </div>

        {/* New folder input */}
        {creating && (
          <div className="p-2 border-b border-border/60 space-y-1.5">
            {createParent && (
              <p className="text-[10px] text-muted-foreground/60 leading-snug">
                {t("Подпапка в «")}{createParent}»
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
              placeholder={t("Имя папки…")}
              className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-violet-500/40"
              maxLength={120}
            />
            <div className="flex gap-1.5">
              <Button size="sm" onClick={() => void createFolder()} disabled={!newName.trim()} className="h-6 text-[10px] px-2 flex-1">
                {t("Создать")}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setCreating(false)} className="h-6 text-[10px] px-2">
                {t("Отмена")}
              </Button>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {folderItem('__all__', <LayersIcon className="w-3.5 h-3.5" />, t("Все видео"))}
          {folderItem('', <FilmIcon className="w-3.5 h-3.5" />, t("Общая"), { onAddChild: true })}
          {/* (правка 495) Папки приходят отсортированными (родитель раньше
              детей) — рисуем дерево отступами по глубине пути. */}
          {visibleFolders.map((f) =>
            folderItem(
              f,
              <FolderIcon className="w-3.5 h-3.5" />,
              leafName(f),
              {
                onRename: true,
                onDelete: true,
                onAddChild: true,
                depth: f.split('/').length - 1,
                hasChildren: hasSubfolders(f),
                collapsed: collapsedFolders.has(f),
                onToggle: () => toggleFolder(f),
              },
            ),
          )}
        </div>

        <p className="px-3 py-2 text-[10px] text-muted-foreground/50 border-t border-border/60 leading-snug">
          {t("Перетащите видео на папку, чтобы переместить его. Стрелка сворачивает подпапки; «+» на строке папки создаёт подпапку; папку можно переименовать (карандаш) или удалить (крестик, только пустую). Папку можно выбрать и на вкладке «Генерация» — новые видео будут ложиться в неё.")}
        </p>
      </div>

      {/* (правка 1015) Подтверждение удаления папки в стиле приложения. */}
      <Dialog
        open={folderToDelete !== null}
        onOpenChange={(open) => { if (!open && !deletingFolder) setFolderToDelete(null) }}
      >
        <DialogContent
          className="max-w-md"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && folderToDelete && !deletingFolder) {
              e.preventDefault()
              setDeletingFolder(true)
              void deleteFolder(folderToDelete).finally(() => {
                setDeletingFolder(false)
                setFolderToDelete(null)
              })
            }
          }}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Trash2Icon className="w-4 h-4 text-red-400" />
              {' '}{t("Удалить папку?")}
            </DialogTitle>
            <DialogDescription>
              {t("Папка «{{p1}}» должна быть пустой (без видео и подпапок) — содержимое не пострадает.", { p1: folderToDelete ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 mt-1">
            <Button
              variant="outline"
              size="sm"
              disabled={deletingFolder}
              onClick={() => setFolderToDelete(null)}
            >
              {t("Отмена")}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              autoFocus
              disabled={deletingFolder}
              onClick={() => {
                if (!folderToDelete) return
                setDeletingFolder(true)
                void deleteFolder(folderToDelete).finally(() => {
                  setDeletingFolder(false)
                  setFolderToDelete(null)
                })
              }}
            >
              <Trash2Icon className="w-3.5 h-3.5" />
              {' '}{deletingFolder ? t("Удаление…") : t("Удалить")}
            </Button>
          </div>
          <p className="text-[10px] text-muted-foreground/50 text-right -mt-1">
            {t("Enter — удалить · Esc — отмена")}
          </p>
        </DialogContent>
      </Dialog>
    </div>
  )
}
