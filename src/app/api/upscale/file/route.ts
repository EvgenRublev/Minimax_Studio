import { NextRequest } from 'next/server'
import path from 'path'
import { serveLocalFile, isPathInsideRoots } from '@/lib/local-file'
import { upscaleAllowedRoots } from '@/lib/upscale-paths'

/**
 * (правка 74) GET /api/upscale/file?path=<absolute path>
 * Стриминг результата (Range-поддержка, video seek). Пути ограничены
 * разрешёнными корнями: общая папка output ComfyUI (результаты с правки 74.2),
 * data/upscale-output (старые результаты), data/upscale-input, upscale/outputs.
 */
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const raw = new URL(req.url).searchParams.get('path') ?? ''
  if (!raw) {
    return new Response('Missing path', { status: 400 })
  }
  const resolved = path.resolve(raw)
  // (правка 716) Проверка по сегментам (isPathInsideRoots) вместо
  // префиксного startsWith('..'): легитимный файл «..foo.mp4» внутри
  // разрешённой папки больше не отвергается с 403.
  if (!isPathInsideRoots(resolved, upscaleAllowedRoots())) {
    return new Response('Forbidden path', { status: 403 })
  }
  const res = await serveLocalFile(req, path.basename(resolved), resolved)
  if (!res) {
    return new Response('Not found', { status: 404 })
  }
  return res
}
