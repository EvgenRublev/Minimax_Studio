'use client'

import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { StudioSidebar, TabType } from '@/components/h3/sidebar'
import { GenerateView } from '@/components/h3/generate-view'
import { ExtendView } from '@/components/h3/extend-view'
import { RefineView } from '@/components/h3/refine-view'
import { UpscaleView } from '@/components/h3/upscale-view'
import { TileUpscaleView } from '@/components/h3/tile-upscale-view'
import { ControlNetView } from '@/components/h3/controlnet-view' // (правка 497)
import { FpsView } from '@/components/h3/fps-view'
import { FaceRefineView } from '@/components/h3/face-refine-view'
import { GalleryView } from '@/components/h3/gallery-view'
import { MontageView } from '@/components/h3/montage-view' // (правка 720)
import { LearnView } from '@/components/h3/learn/learn-view'
import { QueueIndicator } from '@/components/queue-indicator'
import { SettingsDialog } from '@/components/h3/settings-dialog'
import { PrefsSync } from '@/components/h3/prefs-sync' // (правка 804)
import { pushPrefs } from '@/lib/prefs-sync' // (правка 804)
// (правка 112) Всплывающее окно с краткой инструкцией при первом запуске
import { WelcomeDialog } from '@/components/h3/welcome-dialog'
import { ModelsWarningBanner } from '@/components/h3/models-warning-banner'
import { initAssistantChatsSync } from '@/lib/assistant-chats-sync'
// (правка 718) Сверка «идёт ли генерация» с живым ComfyUI при старте:
// персистентный стор восстанавливает фазу «running» из localStorage, и без
// сверки карточка «Генерация идёт» висела бы после каждого запуска.
import {
  reconcileGenerationOnStartup,
  cleanupLostPendingQueueItems,
  cancelReconcile,
} from '@/lib/gen-startup-reconcile'
import { initComfyTurn } from '@/lib/comfy-turn'
import { sweepOrphanRefineItems } from '@/lib/refine-queue'
// (правка 442) Ассистент — не вкладка, а правая панель на «Генерации» и
// «Продлении»; событие «открыть ассистента» разворачивает панель через стор.
import { useAssistantPanel } from '@/lib/assistant-panel-store'
import { toast } from 'sonner' // (правка 790) тосты проверки обновлений

const TAB_CONTENT = {
  generate: GenerateView,
  extend: ExtendView,
  refine: RefineView,
  upscale: UpscaleView,
  'tile-upscale': TileUpscaleView,
  controlnet: ControlNetView, // (правка 497)
  fps: FpsView,
  'face-refine': FaceRefineView,
  gallery: GalleryView,
  montage: MontageView, // (правка 720)
  learn: LearnView,
}

export default function Home() {
  const [activeTab, setActiveTab] = useState<TabType>('generate')
  const [settingsOpen, setSettingsOpen] = useState(false)

  // (правка 112) Приветственное окно при первом запуске.
  // (правка 113) Флаг «не показывать» пишется ТОЛЬКО если пользователь
  // поставил галочку; иначе окно появляется при каждом запуске.
  // Инициализируется в useEffect — SSR не читает localStorage.
  const [welcomeOpen, setWelcomeOpen] = useState(false)
  useEffect(() => {
    try {
      if (!localStorage.getItem('h3_welcome_seen_v1')) setWelcomeOpen(true)
    } catch { /* приватный режим и т.п. — просто не показываем */ }
  }, [])
  const closeWelcome = (dontShowAgain: boolean) => {
    if (dontShowAgain) {
      try {
        localStorage.setItem('h3_welcome_seen_v1', '1')
        pushPrefs() // (правка 804) дублируем prefs на сервер
      } catch { /* ignore */ }
    }
    setWelcomeOpen(false)
  }

  // (правка 116) «Показать окно приветствия» из Настройки → Общие:
  // компонент шлёт событие h3:show-welcome (флаг уже сброшен им),
  // мы просто открываем окно поверх.
  useEffect(() => {
    const showWelcome = () => setWelcomeOpen(true)
    window.addEventListener('h3:show-welcome', showWelcome)
    return () => window.removeEventListener('h3:show-welcome', showWelcome)
  }, [])

  // Cross-component navigation (e.g. MetaDialog's "→ В редактор" button,
  // or the prompt editor's "Улучшить промпт" → assistant panel)
  useEffect(() => {
    const gotoGenerate = () => setActiveTab('generate')
    const gotoExtend = () => setActiveTab('extend')
    const gotoRefine = () => setActiveTab('refine')
    const gotoUpscale = () => setActiveTab('upscale')
    const gotoTileUpscale = () => setActiveTab('tile-upscale')
    const gotoControlNet = () => setActiveTab('controlnet') // (правка 497)
    const gotoFps = () => setActiveTab('fps')
    const gotoFaceRefine = () => setActiveTab('face-refine')
    const gotoMontage = () => setActiveTab('montage') // (правка 720)
    // (правка 442) «Открыть ассистента»: вкладки «Ассистент» больше нет —
    // переключаемся на вкладку нужного режима (generate/extend) и разворачиваем
    // правую панель. Стор модульный: панель примонтируется уже развёрнутой.
    const openAssistantPanel = (e: Event) => {
      const mode = (e as CustomEvent<{ mode?: 'generate' | 'extend' | 'controlnet' }>).detail?.mode
      // (правка 502) 'controlnet' → вкладка «ControlNet».
      setActiveTab(mode === 'extend' ? 'extend' : mode === 'controlnet' ? 'controlnet' : 'generate')
      useAssistantPanel.getState().setCollapsed(false)
    }
    window.addEventListener('h3:goto-generate', gotoGenerate)
    window.addEventListener('h3:goto-extend', gotoExtend)
    window.addEventListener('h3:goto-refine', gotoRefine)
    window.addEventListener('h3:goto-upscale', gotoUpscale)
    window.addEventListener('h3:goto-tile-upscale', gotoTileUpscale)
    window.addEventListener('h3:goto-controlnet', gotoControlNet) // (правка 497)
    window.addEventListener('h3:goto-fps', gotoFps)
    window.addEventListener('h3:goto-face-refine', gotoFaceRefine)
    window.addEventListener('h3:goto-montage', gotoMontage) // (правка 720)
    window.addEventListener('h3:open-assistant-panel', openAssistantPanel)
    return () => {
      window.removeEventListener('h3:goto-generate', gotoGenerate)
      window.removeEventListener('h3:goto-extend', gotoExtend)
      window.removeEventListener('h3:goto-refine', gotoRefine)
      window.removeEventListener('h3:goto-upscale', gotoUpscale)
      window.removeEventListener('h3:goto-tile-upscale', gotoTileUpscale)
      window.removeEventListener('h3:goto-controlnet', gotoControlNet) // (правка 497)
      window.removeEventListener('h3:goto-fps', gotoFps)
      window.removeEventListener('h3:goto-face-refine', gotoFaceRefine)
      window.removeEventListener('h3:goto-montage', gotoMontage) // (правка 720)
      window.removeEventListener('h3:open-assistant-panel', openAssistantPanel)
    }
  }, [])

  // (правка 73) Синхронизация чатов ассистента с файлом проекта
  // (data/assistant-chats.json) — переносимое хранилище.
  useEffect(() => {
    initAssistantChatsSync()
  }, [])

  // (правка 718) Сверка активных генераций при старте приложения.
  // ComfyUI поднимается ~30-60 с, поэтому сверка сама ждёт его ответа
  // (до 5 минут) и снимает «зависшее» состояние из localStorage. Пока
  // ComfyUI не отвечает, состояние НЕ трогаем — мы не знаем, что идёт.
  useEffect(() => {
    // Сначала убираем «потерянные» элементы очереди (их payload не пережил
    // reload), затем восстанавливаем ход у реально живой задачи ComfyUI.
    cleanupLostPendingQueueItems()
    // Refine после reload не имеет живого раннера; без этого его prompt_id
    // никто не финализирует (глобальный поллер намеренно не делает stitch),
    // и шлюз держал бы ход до watchdog.
    sweepOrphanRefineItems()
    initComfyTurn()
    void reconcileGenerationOnStartup()
    return () => cancelReconcile()
  }, [])

  // (правка 790) Стартовая проверка обновлений студии: тост «доступно
  // обновление» с кнопкой «Скачать», и «обновление готово» с кнопкой
  // «Перезапустить», если прошлый раз обновление было скачано и разложено.
  // Сервер кэширует фид GitHub на 10 минут — лишнего внимания API не будет.
  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        const res = await fetch('/api/update')
        const j = await res.json()
        if (j.armed) {
          toast.info(`Обновление до v${j.armed.version} готово — перезапустите студию для установки`, {
            // (правка 794) duration: Infinity — тост не исчезает сам, только
            // крестиком: стартовое уведомление об обновлении нельзя пропустить.
            duration: Infinity,
            action: window.h3desktop?.applyUpdate
              ? {
                  label: 'Перезапустить',
                  onClick: () => void window.h3desktop?.applyUpdate?.(),
                }
              : undefined,
          })
        } else if (j.update) {
          toast.warning(`Доступно обновление студии: v${j.update.version}`, {
            // (правка 794) Не исчезает сам — см. выше.
            duration: Infinity,
            action: {
              label: 'Скачать',
              onClick: () => {
                void fetch('/api/update/download', { method: 'POST' })
                  .then((r) => r.json())
                  .then((d) => {
                    if (!d.ok) toast.error(d.error || 'Не удалось начать загрузку')
                    else toast.success(`Загрузка v${j.update.version} началась — прогресс в Настройках → О программе`)
                  })
                  .catch(() => toast.error('Ошибка запроса к серверу'))
              },
            },
          })
        }
      } catch { /* сеть/сервер недоступны — молча пропускаем */ }
    }, 5000)
    return () => clearTimeout(t)
  }, [])

  const ContentComponent = TAB_CONTENT[activeTab]

  return (
    <div className="h-full w-full flex overflow-hidden">
      {/* Sidebar */}
      <StudioSidebar
        activeTab={activeTab}
        onTabChange={setActiveTab}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      {/* Main Content */}
      <main className="flex-1 min-w-0 relative flex flex-col">
        {/* Models not downloaded warning */}
        <ModelsWarningBanner onOpenSettings={() => setSettingsOpen(true)} />

        <div className="flex-1 min-h-0 relative">
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            className="h-full flex"
          >
            <ContentComponent />
          </motion.div>
        </AnimatePresence>
        </div>

        {/* Queue indicator — bottom-right floating; (правка 442) сдвигается
            левее панели ассистента на вкладках «Генерация»/«Продление» */}
        <QueueIndicator activeTab={activeTab} />
      </main>

      {/* Settings dialog (connection, GPU memory) — opened from the sidebar */}
      <PrefsSync />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />

      {/* (правка 112) Приветствие при первом запуске — поверх всего */}
      <AnimatePresence>
        {welcomeOpen && (
          <WelcomeDialog
            onClose={closeWelcome}
            onOpenSettings={(dontShowAgain) => {
              closeWelcome(dontShowAgain)
              setSettingsOpen(true)
            }}
            onGoLearn={(dontShowAgain) => {
              closeWelcome(dontShowAgain)
              setActiveTab('learn')
            }}
          />
        )}
      </AnimatePresence>
    </div>
  )
}
