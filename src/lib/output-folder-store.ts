/**
 * (правка 997) Папка сохранения результата по вкладкам.
 * Хранится отдельно от параметров генерации, чтобы выбор папки переживал
 * перезапуск и не зависел от того, каким стором пользуется вкладка.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type OutputFolderTab =
  | 'extend'
  | 'refine'
  | 'tile-upscale'
  | 'fps'
  | 'face-refine'
  | 'upscale'

interface OutputFolderState {
  folders: Record<OutputFolderTab, string>
  setFolder: (tab: OutputFolderTab, folder: string) => void
}

const EMPTY: Record<OutputFolderTab, string> = {
  extend: '',
  refine: '',
  'tile-upscale': '',
  fps: '',
  'face-refine': '',
  upscale: '',
}

export const useOutputFolderStore = create<OutputFolderState>()(
  persist(
    (set) => ({
      folders: { ...EMPTY },
      setFolder: (tab, folder) =>
        set((s) => ({ folders: { ...s.folders, [tab]: folder } })),
    }),
    { name: 'h3-output-folders' },
  ),
)
