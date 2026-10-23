/**
 * Assistant panel store (Zustand, persisted) — правка 442.
 *
 * Ассистент живёт правой боковой панелью на вкладках «Генерация» и
 * «Продление» (отдельной вкладки больше нет). Стор хранит ширину панели
 * (resize за левую границу) и свёрнутость в узкий рейл.
 *
 * Стор на уровне модуля (а не useState в компоненте), чтобы событие
 * h3:open-assistant-panel могло развернуть панель ДО её монтирования:
 * «Улучшить промпт» переключает вкладку → панель монтируется уже
 * развёрнутой и сразу подхватывает pendingImprove.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export const ASSISTANT_PANEL_MIN = 300
export const ASSISTANT_PANEL_MAX = 640
export const ASSISTANT_PANEL_DEFAULT = 380

interface AssistantPanelState {
  /** Ширина развёрнутой панели, px. */
  width: number
  /** Свернута в узкий рейл (кнопка разворота + вертикальная подпись). */
  collapsed: boolean
  /** (правка 496) Режим «3D → Video»: к системному промпту ассистента
   *  добавляется компактный блок про перенос движения/камеры с 3D-болванки
   *  (видео-референс = источник motion/camera, не внешнего вида). */
  guide3d: boolean
  setWidth: (w: number) => void
  setCollapsed: (v: boolean) => void
  setGuide3d: (v: boolean) => void
}

export const useAssistantPanel = create<AssistantPanelState>()(
  persist(
    (set) => ({
      width: ASSISTANT_PANEL_DEFAULT,
      // (правка 444) По умолчанию панель свёрнута в рейл: разворачивается
      // кнопкой ‹ в рейле или событием h3:open-assistant-panel («Улучшить
      // промпт») — тогда открывается на полную сохранённую ширину.
      collapsed: true,
      guide3d: false,
      setWidth: (w) =>
        set({ width: Math.min(ASSISTANT_PANEL_MAX, Math.max(ASSISTANT_PANEL_MIN, Math.round(w))) }),
      setCollapsed: (v) => set({ collapsed: v }),
      setGuide3d: (v) => set({ guide3d: v }),
    }),
    {
      name: 'h3-assistant-panel',
      // (правка 444) Миграция v0→v1: у тех, кто уже открывал панель
      // (collapsed:false в localStorage), однократно сворачиваем в рейл —
      // новый дефолт. Ширину сохраняем.
      version: 1,
      migrate: (persisted, version) => {
        if (version === 0 && persisted && typeof persisted === 'object') {
          return { ...(persisted as AssistantPanelState), collapsed: true }
        }
        return persisted as AssistantPanelState
      },
    },
  )
)
