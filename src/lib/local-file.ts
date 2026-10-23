/**
 * Local file serving with HTTP Range support.
 *
 * The gallery must not depend on the ComfyUI server being up — generated
 * files live in the local output directory, so full files (video playback,
 * downloads) are streamed straight from disk. The ComfyUI /view proxy stays
 * as a fallback for files that are not on disk (e.g. type=input).
 */
import { createReadStream, promises as fs } from 'fs'
import { Readable } from 'node:stream'
import path from 'path'
import type { NextRequest } from 'next/server'
import { safeOutputPath } from './thumb'

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm',
  '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.flac': 'audio/flac', '.aac': 'audio/aac', '.m4a': 'audio/mp4',
  '.txt': 'text/plain; charset=utf-8', '.json': 'application/json',
}

/**
 * (правка 716) Путь внутри одного из корней?
 *
 * Проверка ПО СЕГМЕНТАМ, а не префиксом строки: прежний тест
 * `!rel.startsWith('..')` отвергал легитимный файл «..foo.mp4» внутри
 * разрешённой папки (rel === '..foo.mp4' начинается с '..').
 */
export function isPathInsideRoots(resolved: string, roots: string[]): boolean {
  const target = path.resolve(resolved)
  return roots.some((root) => {
    const base = path.resolve(root)
    const rel = path.relative(base, target)
    if (rel === '') return false
    if (path.isAbsolute(rel)) return false
    if (rel === '..') return false
    if (rel.startsWith('..' + path.sep)) return false
    return true
  })
}

/** Parse a single-range "bytes=start-end" header. End may be empty. */
function parseRange(header: string): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (m[1] === '' && m[2] === '')) return null
  return { start: m[1] === '' ? -1 : parseInt(m[1], 10), end: m[2] === '' ? -1 : parseInt(m[2], 10) }
}

/**
 * Pipe a Node ReadStream into a web ReadableStream via a TransformStream.
 * The source stream is explicitly destroyed on client disconnect or on
 * completion — preventing "Controller is already closed" errors and
 * keeping the file handle released so Windows lets other processes
 * (e.g. VHS cleanup) access/delete the file.
 *
 * @returns the web ReadableStream to hand to a Response, and an
 *   `onAbort` callback the caller should invoke to cancel the pipe.
 */
function pipeNodeStream(source: Readable): { stream: ReadableStream<Uint8Array>; cancel: () => void } {
  const { readable, writable } = new TransformStream<Uint8Array>()
  const writer = writable.getWriter()

  let cancelled = false
  const cancel = () => {
    if (cancelled) return
    cancelled = true
    source.destroy()
  }

  void (async () => {
    try {
      for await (const chunk of source) {
        if (cancelled) break
        const buf = chunk as Buffer
        await writer.write(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength))
      }
      await writer.close()
    } catch {
      try { await writer.close() } catch { /* already closed */ }
    } finally {
      source.destroy()
    }
  })()

  return { stream: readable, cancel }
}

/**
 * Serve a file from the local disk with Range support.
 * Returns null when the file does not exist locally (caller falls back
 * to the upstream proxy).
 *
 * `sourceOverride` serves an already-resolved absolute path (e.g. a
 * staged reference file) instead of resolving inside the output dir.
 */
export async function serveLocalFile(
  req: NextRequest,
  filename: string,
  sourceOverride?: string | null,
): Promise<Response | null> {
  const source = sourceOverride !== undefined ? sourceOverride : safeOutputPath(filename)
  if (!source) {
    return sourceOverride !== undefined ? null : new Response('Invalid path', { status: 400 })
  }

  let size: number
  let mtime: number
  try {
    const st = await fs.stat(source)
    if (!st.isFile()) return null
    size = st.size
    mtime = Math.floor(st.mtimeMs / 1000)
  } catch {
    return null
  }

  // (правка 351) Имя без точки: lastIndexOf=-1 давал slice(-1) — «расширение»
  // из последнего символа имени (могло случайно совпасть с MIME-ключом).
  const dotIdx = filename.lastIndexOf('.')
  const mime = (dotIdx >= 0 ? MIME[filename.slice(dotIdx).toLowerCase()] : undefined) || 'application/octet-stream'
  // encodeURIComponent обязателен: имена с кириллицей не входят в ByteString,
  // и Response() кидал бы TypeError на отдаче файла
  const etag = `"local-${encodeURIComponent(filename)}-${size}-${mtime}"`
  const baseHeaders: Record<string, string> = {
    'Content-Type': mime,
    'Access-Control-Allow-Origin': '*',
    // Output files are immutable — cache aggressively
    'Cache-Control': 'public, max-age=86400',
    'Accept-Ranges': 'bytes',
    'ETag': etag,
  }

  // Abort the disk stream when the client disconnects (seek / cancel).
  const signal = req.signal

  const rangeHeader = req.headers.get('range')
  if (rangeHeader) {
    const range = parseRange(rangeHeader)
    if (range) {
      let start: number
      let end: number
      if (range.start < 0) {
        // Suffix range "bytes=-N": the final N bytes
        const n = range.end < 0 ? size : range.end
        start = Math.max(0, size - n)
        end = size - 1
      } else {
        start = range.start
        end = range.end < 0 ? size - 1 : Math.min(range.end, size - 1)
      }
      if (start > end || start >= size) {
        return new Response(null, {
          status: 416,
          headers: { ...baseHeaders, 'Content-Range': `bytes */${size}` },
        })
      }
      const { stream, cancel } = pipeNodeStream(createReadStream(source, { start, end }))
      const res = new Response(stream, {
        status: 206,
        headers: {
          ...baseHeaders,
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Content-Length': String(end - start + 1),
        },
      })
      signal.addEventListener('abort', () => {
        cancel()
        try { res.body?.cancel().catch(() => {}) } catch { /* noop */ }
      }, { once: true })
      return res
    }
  }

  const { stream, cancel } = pipeNodeStream(createReadStream(source))
  const res = new Response(stream, {
    status: 200,
    headers: { ...baseHeaders, 'Content-Length': String(size) },
  })
  signal.addEventListener('abort', () => {
    cancel()
    try { res.body?.cancel().catch(() => {}) } catch { /* noop */ }
  }, { once: true })
  return res
}
