// (правка 1042) DLSS runtime — обязательная часть ПОЛНОГО setup.exe.
//
// Вкладка Upscale использует вендорный runtime из upscale/bin/runtime.
// Эти файлы не входят в git (слишком большие), поэтому их легко случайно
// потерять при пересборке setup payload. Один список обязательных файлов
// используется и проверкой релиза, и сборщиком setup.exe.
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Ключевые файлы, без которых DLSS/Upscale не запустится. */
export const REQUIRED_DLSS_RUNTIME = [
  'upscale/bin/runtime/dlss/nvngx_dlss.dll',
  'upscale/bin/runtime/dlssg/nvngx_dlssg.dll',
  'upscale/bin/runtime/dlssg/dlssg-worker.exe',
  'upscale/bin/runtime/dlssnr/nvngx_dlssnr.dll',
  'upscale/bin/runtime/dlssnr/renodx-dlss5.addon64',
  'upscale/bin/runtime/host/dxgi.dll',
  'upscale/bin/runtime/host/nvngx.dll',
  'upscale/bin/runtime/rtx_video/nvngx_truehdr.dll',
  'upscale/bin/runtime/rtx_video/nvngx_vsr.dll',
  'upscale/bin/runtime/rtx_video/rtx-video-worker.exe',
]

export function checkDlssRuntime(root) {
  const missing = []
  for (const rel of REQUIRED_DLSS_RUNTIME) {
    const full = join(root, ...rel.split('/'))
    if (!existsSync(full) || !statSync(full).isFile() || statSync(full).size === 0) {
      missing.push(rel)
    }
  }
  return missing
}
