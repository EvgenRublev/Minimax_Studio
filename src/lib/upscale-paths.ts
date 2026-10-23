/**
 * (правка 716) Разрешённые корни локальных файлов для вкладки Upscale.
 *
 * Вынесено в отдельный модуль, а не в api/upscale/file/route.ts: файлы
 * route.ts в Next.js App Router могут экспортировать только обработчики
 * и конфигурацию — любой другой экспорт ломает сборку.
 */
import path from 'path'
import { getAppConfig } from '@/lib/app-config'

/** Корни, из которых upscale может читать и писать файлы. */
export function upscaleAllowedRoots(): string[] {
  return [
    // (правка 74.2) основные результаты пишутся в общую папку output ComfyUI
    path.resolve(getAppConfig().outputDir),
    path.resolve(process.cwd(), 'data', 'upscale-output'),
    path.resolve(process.cwd(), 'data', 'upscale-input'),
    path.resolve(process.cwd(), 'upscale', 'outputs'),
  ]
}
