'use client'

import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import {
  ClapperboardIcon,
  FilmIcon,
  FolderOpenIcon,
  GraduationCapIcon,
  GaugeIcon,
  Grid3x3Icon,
  SettingsIcon,
  TerminalIcon, // (правка 567) кнопка «Консоль»
  ChevronLeftIcon,
  ChevronRightIcon,
  SparklesIcon,
  ScanFaceIcon,
  Wand2Icon,
  WaypointsIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { SystemStatsBar } from '@/components/h3/system-stats-bar'
import { ConsoleDialog } from '@/components/h3/console-dialog' // (правка 567)
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'

// (правка 442) Вкладки «Ассистент» больше нет: ассистент — правая панель
// на вкладках «Генерация» и «Продление».
export type TabType = 'generate' | 'extend' | 'refine' | 'upscale' | 'tile-upscale' | 'controlnet' | 'fps' | 'face-refine' | 'gallery' | 'learn'

interface SidebarProps {
  activeTab: TabType
  onTabChange: (tab: TabType) => void
  /** Opens the Settings dialog. Optional — only the sidebar triggers it. */
  onOpenSettings?: () => void
}

const navItems = [
  { id: 'generate' as TabType, label: 'Генерация', icon: ClapperboardIcon, color: '#06B6D4' },
  { id: 'extend' as TabType, label: 'Продление', icon: FilmIcon, color: '#06B6D4' },
  { id: 'refine' as TabType, label: 'Refine', icon: Wand2Icon, color: '#10B981' },
  { id: 'controlnet' as TabType, label: 'ControlNet', icon: WaypointsIcon, color: '#FB923C' },
  { id: 'tile-upscale' as TabType, label: 'Tile Upscale', icon: Grid3x3Icon, color: '#EC4899' },
  { id: 'fps' as TabType, label: 'FPS', icon: GaugeIcon, color: '#22D3EE' },
  { id: 'face-refine' as TabType, label: 'Face Refine', icon: ScanFaceIcon, color: '#FACC15' },
  { id: 'upscale' as TabType, label: 'DLSS', icon: SparklesIcon, color: '#F472B6' },
  { id: 'gallery' as TabType, label: 'Галерея', icon: FolderOpenIcon, color: '#8B5CF6' },
  { id: 'learn' as TabType, label: 'Обучение', icon: GraduationCapIcon, color: '#10B981' },
]

/* ────────────────────────────────────────────────────────────────
 * ComfyUI connection indicator — polls /api/comfy/health.
 * Green dot = backend is up, red = unreachable.
 * ──────────────────────────────────────────────────────────────── */

function ComfyHealthDot({ collapsed }: { collapsed: boolean }) {
  const [state, setState] = useState<'checking' | 'up' | 'down'>('checking')
  /** (правка 54) счётчик СОБСТВЕННЫХ сбоев — для grace-периода. */
  const failCount = useRef(0)

  useEffect(() => {
    let cancelled = false
    const check = async () => {
      let ok = false
      try {
        // (правка 54) 10 s вместо 4 s: во время генерации event-loop ComfyUI
        // занят долгими GPU-шагами и может отвечать медленно — раньше это
        // давало ложный «ComfyUI недоступен» посреди работающей генерации.
        const res = await fetch('/api/comfy/health', { signal: AbortSignal.timeout(10_000) })
        ok = res.ok
      } catch {
        ok = false
      }
      if (cancelled) return
      if (ok) {
        failCount.current = 0
        setState('up')
      } else {
        failCount.current += 1
        // (правка 54) Одно сбойное чтение (ComfyUI просто занят) не красит
        // индикатор — «недоступен» только при 2+ сбоях подряд.
        if (failCount.current >= 2) setState('down')
      }
    }
    void check()
    const timer = setInterval(check, 30_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  const dot = (
    <span className="relative flex h-2 w-2 shrink-0">
      {state !== 'checking' && (
        <span
          className={cn(
            'absolute inline-flex h-full w-full rounded-full opacity-60',
            state === 'up' ? 'animate-ping bg-emerald-400' : 'bg-red-400',
          )}
        />
      )}
      <span
        className={cn(
          'relative inline-flex h-2 w-2 rounded-full',
          state === 'up' ? 'bg-emerald-400' : state === 'down' ? 'bg-red-400' : 'bg-muted-foreground',
        )}
      />
    </span>
  )

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center justify-center py-1.5">{dot}</div>
        </TooltipTrigger>
        <TooltipContent side="right" className="bg-[var(--surface-3)] border-border text-foreground">
          {state === 'up' ? 'ComfyUI подключен' : state === 'down' ? 'ComfyUI недоступен' : 'Проверка…'}
        </TooltipContent>
      </Tooltip>
    )
  }

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground">
      {dot}
      <span>{state === 'up' ? 'ComfyUI подключен' : state === 'down' ? 'ComfyUI недоступен' : 'Проверка…'}</span>
    </div>
  )
}

/* ────────────────────────────────────────────────────────────────
 * Sidebar
 * ──────────────────────────────────────────────────────────────── */

export function StudioSidebar({ activeTab, onTabChange, onOpenSettings }: SidebarProps) {
  const [collapsed, setCollapsed] = useState(false)
  // (правка 567) панель «Консоль» — весь вывод приложения внутри UI
  const [consoleOpen, setConsoleOpen] = useState(false)

  return (
    <TooltipProvider delayDuration={0}>
      <motion.aside
        initial={false}
        animate={{ width: collapsed ? 68 : 240 }}
        transition={{ duration: 0.2, ease: 'easeInOut' }}
        className="flex flex-col h-full border-r border-border bg-[var(--surface-1)] relative z-20"
      >
        {/* Logo */}
        <div className="flex items-center gap-2.5 px-4 h-14 border-b border-border shrink-0">
          <div className="w-8 h-8 rounded-lg gradient-creative flex items-center justify-center shrink-0 shadow-lg shadow-cyan-500/20">
            <span className="text-sm font-bold text-white tracking-tight">H3</span>
          </div>
          {!collapsed && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="flex flex-col min-w-0"
            >
              <span className="text-sm font-semibold text-foreground truncate leading-tight">
                MiniMax H3 <span className="gradient-creative-text font-bold">Studio 7</span>
              </span>
              <span className="text-[10px] text-muted-foreground truncate">by Evgen Rublev</span>
            </motion.div>
          )}
        </div>

        {/* Navigation */}
        <nav className="flex-1 py-3 px-2 space-y-1">
          {navItems.map((item) => {
            const isActive = activeTab === item.id
            const Icon = item.icon

            const button = (
              <button
                key={item.id}
                onClick={() => onTabChange(item.id)}
                className={cn(
                  'w-full flex items-center gap-3 rounded-lg transition-all duration-150 group relative',
                  collapsed ? 'justify-center px-0 py-2.5' : 'px-3 py-2.5',
                  isActive
                    ? 'bg-[var(--surface-3)] text-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-[var(--surface-2)]'
                )}
              >
                {/* Active indicator */}
                {isActive && (
                  <motion.div
                    layoutId="sidebar-active"
                    className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-r-full"
                    style={{ backgroundColor: item.color }}
                    transition={{ duration: 0.2, ease: 'easeInOut' }}
                  />
                )}
                <Icon
                  className={cn(
                    'w-[18px] h-[18px] shrink-0 transition-colors',
                    isActive ? '' : 'group-hover:text-foreground'
                  )}
                  style={isActive ? { color: item.color } : undefined}
                />
                {!collapsed && (
                  <motion.span
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="text-sm font-medium truncate"
                  >
                    {item.label}
                  </motion.span>
                )}
              </button>
            )

            if (collapsed) {
              return (
                <Tooltip key={item.id}>
                  <TooltipTrigger asChild>{button}</TooltipTrigger>
                  <TooltipContent side="right" className="bg-[var(--surface-3)] border-border text-foreground">
                    {item.label}
                  </TooltipContent>
                </Tooltip>
              )
            }

            return button
          })}
        </nav>

        {/* System stats */}
        <SystemStatsBar collapsed={collapsed} />

        {/* Bottom section */}
        <div className="px-2 py-2 border-t border-border space-y-0.5">
          <ComfyHealthDot collapsed={collapsed} />
          {/* (правка 567) «Консоль» — между индикатором ComfyUI и настройками:
              весь вывод реальной консоли внутри UI + копирование/сохранение. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => setConsoleOpen(true)}
                className={cn(
                  'w-full flex items-center gap-3 rounded-lg text-muted-foreground hover:text-foreground hover:bg-[var(--surface-2)] transition-colors',
                  collapsed ? 'justify-center px-0 py-2.5' : 'px-3 py-2.5'
                )}
              >
                <TerminalIcon className="w-[18px] h-[18px] shrink-0" />
                {!collapsed && <span className="text-sm font-medium">Консоль</span>}
              </button>
            </TooltipTrigger>
            {collapsed && (
              <TooltipContent side="right" className="bg-[var(--surface-3)] border-border text-foreground">
                Консоль
              </TooltipContent>
            )}
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onOpenSettings}
                className={cn(
                  'w-full flex items-center gap-3 rounded-lg text-muted-foreground hover:text-foreground hover:bg-[var(--surface-2)] transition-colors',
                  collapsed ? 'justify-center px-0 py-2.5' : 'px-3 py-2.5'
                )}
              >
                <SettingsIcon className="w-[18px] h-[18px] shrink-0" />
                {!collapsed && <span className="text-sm font-medium">Настройки</span>}
              </button>
            </TooltipTrigger>
            {collapsed && (
              <TooltipContent side="right" className="bg-[var(--surface-3)] border-border text-foreground">
                Настройки
              </TooltipContent>
            )}
          </Tooltip>
        </div>

        {/* Collapse toggle */}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="absolute -right-3 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-[var(--surface-3)] border border-border flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-[var(--surface-4)] transition-colors z-30"
        >
          {collapsed ? (
            <ChevronRightIcon className="w-3 h-3" />
          ) : (
            <ChevronLeftIcon className="w-3 h-3" />
          )}
        </button>

        {/* (правка 567) Панель «Консоль» */}
        <ConsoleDialog open={consoleOpen} onOpenChange={setConsoleOpen} />
      </motion.aside>
    </TooltipProvider>
  )
}
