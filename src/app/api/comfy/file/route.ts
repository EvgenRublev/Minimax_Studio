import { NextRequest } from 'next/server'
import { promises as fs, existsSync } from 'fs'
import path from 'path'
import { fileUrl } from '@/lib/comfy/minimax-h3-client'
import { getThumb, thumbKind, safeOutputPath } from '@/lib/thumb'
import { sanitizeFolderPath } from '@/lib/gallery-folders' // (правка 495)
import { serveLocalFile } from '@/lib/local-file'
import { stagedPath } from '@/lib/staging'
import { getAppConfig } from '@/lib/app-config'
import sharp from 'sharp'

/** Dark gray 16:9 placeholder generated once — served when video poster
 *  extraction fails (e.g. ffmpeg missing or the file is still being written).
 *  Never fall back to the full video for a poster request: that would feed
 *  the browser a multi-MB (possibly incomplete) file under a poster URL. */
let placeholderPromise: Promise<Buffer> | null = null
function posterPlaceholder(): Promise<Buffer> {
  // (правка 349) Rejected-промис больше не кэшируется навсегда: при сбое
  // sharp (OOM и т.п.) сбрасываем кэш, чтобы следующий запрос попробовал
  // сгенерировать placeholder заново.
  placeholderPromise ??= sharp({
    create: { width: 64, height: 36, channels: 3, background: { r: 22, g: 26, b: 33 } },
  })
    .jpeg({ quality: 70 })
    .toBuffer()
  placeholderPromise.catch(() => { placeholderPromise = null })
  return placeholderPromise
}

/**
 * GET /api/comfy/file?filename=...&subfolder=...&type=...[&width=N]
 *
 * With `width` — a server-generated JPEG thumbnail (sharp for images /
 * ffmpeg poster for videos), disk-cached; no ComfyUI dependency.
 * Without `width` — the full file streamed from the local output dir
 * (Range-capable); the ComfyUI /view proxy is only a fallback for files
 * that are not on local disk (e.g. type=input).
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const filename = searchParams.get('filename')
  if (!filename) {
    return new Response('Missing filename', { status: 400 })
  }
  const subfolderRaw = searchParams.get('subfolder') ?? ''
  // (правка 91) Подпапка = путь папки галереи.
  // (правка 495) Многоуровневый относительный путь ('a/b'), без обхода.
  const subfolder = sanitizeFolderPath(subfolderRaw)
  const type = searchParams.get('type') ?? 'output'
  const widthParam = searchParams.get('width')
  const width = widthParam ? Math.min(1920, Math.max(32, parseInt(widthParam, 10) || 0)) : 0

  /* ── Thumbnail path: local file + sharp/ffmpeg + disk cache ──
     Works for BOTH output files (gallery posters) and input files
     (reference thumbnails in the metadata dialog). */
  if (width > 0 && (type === 'output' || (type === 'input' && !subfolder))) {
    const ext = path.extname(filename).toLowerCase()
    const kind = thumbKind(ext)
    if (kind) {
      let source: string | null = null
      if (type === 'output') {
        source = safeOutputPath(subfolder ? path.join(subfolder, filename) : filename)
      } else {
        // Input reference: staged copy first, then the real ComfyUI input dir
        source = (await stagedPath(filename)) || null
        if (!source) {
          const cfg = getAppConfig()
          const candidate = path.join(cfg.comfyRoot, 'ComfyUI', 'input', path.basename(filename))
          if (existsSync(candidate)) source = candidate
        }
      }
      if (!source) {
        return new Response('Invalid path', { status: 400 })
      }
      let mtime = 0
      try {
        mtime = Math.floor((await fs.stat(source)).mtimeMs / 1000)
      } catch {
        return new Response('Not found', { status: 404 })
      }
      const cacheKey = `${type}_${subfolder ? subfolder + '_' : ''}${path.basename(filename)}`
      const buf = await getThumb(source, cacheKey, kind, width)
      if (buf) {
        return new Response(new Uint8Array(buf), {
          headers: {
            'Content-Type': 'image/jpeg',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=86400, immutable',
            // HTTP headers are ByteStrings — encode non-ASCII filenames
            // (user references are often Cyrillic) or Response() throws.
            'ETag': `"${encodeURIComponent(cacheKey)}-${mtime}-${width}"`,
          },
        })
      }
      // Video poster failed (no ffmpeg / file still writing) — a gray
      // placeholder beats streaming the whole (possibly incomplete) video
      // as a poster. Short cache so the real poster is retried soon.
      if (kind === 'video') {
        const placeholder = await posterPlaceholder()
        return new Response(new Uint8Array(placeholder), {
          headers: {
            'Content-Type': 'image/jpeg',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=60',
          },
        })
      }
      // Image thumb failed — degrade to the full file below.
    }
  }

  /* ── Full file: local disk first (no ComfyUI dependency) ── */
  if (type === 'output') {
    const local = await serveLocalFile(req, filename, subfolder ? safeOutputPath(path.join(subfolder, filename)) ?? null : undefined)
    if (local) return local
  }

  /* ── Staged references: serve from .local-input/ when ComfyUI is down ── */
  if (type === 'input' && !subfolder) {
    const staged = await stagedPath(filename)
    if (staged) {
      const local = await serveLocalFile(req, filename, staged)
      if (local) return local
    }
  }

  /* ── Fallback: stream from ComfyUI /view (no buffering) ── */
  // (правка 349) basename на всякий случай: локальные ветки выше уже
  // санитизировали путь, а здесь filename уходит в upstream-запрос как есть.
  const upstream = fileUrl(path.basename(filename), subfolder, type)
  const rangeHeader = req.headers.get('range')

  try {
    const headers: Record<string, string> = {}
    if (rangeHeader) headers['Range'] = rangeHeader

    // (правка 587) Таймаут + связь с клиентом: ComfyUI во время генерации
    // может принять соединение и не отвечать долго — без сигнала этот fetch
    // висел вечно. AbortSignal.any: обрыв клиента ИЛИ 120 с форсажа.
    const UPSTREAM_TIMEOUT_MS = 120_000
    const signal =
      typeof AbortSignal.any === 'function'
        ? AbortSignal.any([req.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)])
        : AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)

    const res = await fetch(upstream, { headers, signal })

    if (!res.ok) {
      return new Response(`Upstream ${res.status}`, { status: res.status })
    }
    if (!res.body) {
      return new Response('Empty upstream body', { status: 502 })
    }

    const headersOut: Record<string, string> = {
      'Content-Type': res.headers.get('content-type') || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=86400',
      'Accept-Ranges': 'bytes',
    }
    const contentRange = res.headers.get('content-range')
    const contentLength = res.headers.get('content-length')
    const etag = res.headers.get('etag')
    if (contentRange) headersOut['Content-Range'] = contentRange
    if (contentLength) headersOut['Content-Length'] = contentLength
    if (etag) headersOut['ETag'] = etag

    const status = contentRange ? 206 : 200

    // Pipe through a TransformStream to safely handle client disconnects
    // without triggering "Controller is already closed" errors.
    const { readable, writable } = new TransformStream()
    const writer = writable.getWriter()
    const reader = res.body.getReader()

    void (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          await writer.write(value)
        }
        await writer.close()
      } catch {
        // (правка 587) Клиент ушёл/стрим сорвался — отменяем чтение upstream,
        // иначе недочитанное тело ComfyUI висело открытым (утечка соединений).
        try { await reader.cancel().catch(() => {}) } catch { /* ignore */ }
        try { await writer.close() } catch { /* already closed */ }
      }
    })()

    return new Response(readable, { status, headers: headersOut })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return new Response(null, { status: 499 })
    }
    return new Response('Failed to fetch from ComfyUI', { status: 502 })
  }
}
