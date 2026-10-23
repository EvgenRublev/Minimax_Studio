import { NextResponse } from 'next/server'
import { createWriteStream, existsSync, mkdirSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { getAppConfig } from '@/lib/app-config'
import { sttStatus } from '@/lib/stt-runner'
import { stopStt } from '@/lib/stt-runner'

/**
 * (правка 72) STT-модели: скачивание, прогресс, отмена.
 *
 * POST   — начать скачивание модели
 * DELETE — отменить активное скачивание
 * GET    — прогресс скачивания (?name=small)
 *
 * Модели скачиваются из HuggingFace (ggerganov/whisper.cpp)
 * во встроенную папку <project>/stt/models/.
 */
export const dynamic = 'force-dynamic'

/* (правка 73) Модели лежат в корне репозитория (папки models/ больше нет —
 * старые URL вида .../resolve/main/models/*.bin дают 404). */
const HF_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'

const STT_MODEL_CATALOG: Array<{
  name: string
  file: string
  sizeLabel: string
  quality: string
}> = [
  { name: 'tiny',     file: 'ggml-tiny.bin',     sizeLabel: '~75 МБ',  quality: 'быстро, качество низкое' },
  { name: 'base',     file: 'ggml-base.bin',     sizeLabel: '~142 МБ', quality: 'среднее качество' },
  { name: 'small',    file: 'ggml-small.bin',    sizeLabel: '~466 МБ', quality: 'хорошее (рекомендуется)' },
  { name: 'medium',   file: 'ggml-medium.bin',   sizeLabel: '~1.5 ГБ', quality: 'отличное' },
  { name: 'large-v3', file: 'ggml-large-v3.bin', sizeLabel: '~3.1 ГБ', quality: 'лучшее, медленно' },
]

interface DownloadState {
  name: string
  file: string
  dest: string
  downloaded: number
  total: number
  done: boolean
  error: string | null
  cancelled: boolean
  controller: AbortController
}

const active = new Map<string, DownloadState>()

function destDir(): string {
  const cfg = getAppConfig()
  const dir = join(cfg.sttDir, 'models')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function isAlreadyDownloaded(name: string): boolean {
  const cat = STT_MODEL_CATALOG.find((m) => m.name === name)
  if (!cat) return false
  const dest = join(destDir(), cat.file)
  return existsSync(dest) && statSync(dest).size > 0
}

/* ─── GET /api/stt/models/download?name=small ─── */
export async function GET(request: Request) {
  const url = new URL(request.url)
  const name = (url.searchParams.get('name') || '').trim()
  if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 })

  const st = active.get(name)
  if (st) {
    return NextResponse.json({
      name: st.name,
      active: true,
      downloaded: st.downloaded,
      total: st.total,
      done: st.done,
      error: st.error,
      cancelled: st.cancelled,
    })
  }

  // Not actively downloading — report if file already exists
  const cat = STT_MODEL_CATALOG.find((m) => m.name === name)
  if (cat && isAlreadyDownloaded(name)) {
    const dest = join(destDir(), cat.file)
    return NextResponse.json({
      name,
      active: false,
      downloaded: statSync(dest).size,
      total: statSync(dest).size,
      done: true,
      error: null,
      cancelled: false,
    })
  }

  return NextResponse.json({ name, active: false, downloaded: 0, total: 0, done: false, error: null, cancelled: false })
}

/* ─── POST /api/stt/models/download ─── */
export async function POST(request: Request) {
  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const name = (typeof body.name === 'string' ? body.name : '').trim()
  const cat = STT_MODEL_CATALOG.find((m) => m.name === name)
  if (!cat) {
    return NextResponse.json({ error: `Неизвестная модель: ${name}` }, { status: 400 })
  }

  if (active.has(name)) {
    return NextResponse.json({ ok: true, already: true })
  }

  if (isAlreadyDownloaded(name)) {
    return NextResponse.json({ ok: true, already: true, downloaded: true })
  }

  const dir = destDir()
  const dest = join(dir, cat.file)

  // Stop STT service if running (it may hold the model file open)
  if (sttStatus().running) {
    try { await stopStt() } catch { /* ignore */ }
  }

  const controller = new AbortController()
  const state: DownloadState = {
    name,
    file: cat.file,
    dest,
    downloaded: 0,
    total: 0,
    done: false,
    error: null,
    cancelled: false,
    controller,
  }
  active.set(name, state)

  // Start download in background (fire-and-forget)
  // (правка 716) .catch обязателен: doDownload — async, и его отклонение
  // без обработчика стало бы unhandled rejection (Node по умолчанию завершает
  // процесс). Состояние загрузки само пишет error — терять его нельзя.
  void doDownload(state).catch((err) => {
    const message = err instanceof Error ? err.message : String(err)
    state.error = message
    state.done = true
    console.error('[stt-model-download] failed:', message)
  })

  return NextResponse.json({ ok: true, started: true, name })
}

/* ─── DELETE /api/stt/models/download?name=small ─── */
export async function DELETE(request: Request) {
  const url = new URL(request.url)
  const name = (url.searchParams.get('name') || '').trim()
  if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 })

  const st = active.get(name)
  if (!st) return NextResponse.json({ ok: false, error: 'Нет активного скачивания' }, { status: 404 })

  st.cancelled = true
  st.controller.abort()

  return NextResponse.json({ ok: true, cancelled: true })
}

/* ─── Internal: stream download ─── */
async function doDownload(state: DownloadState) {
  const tmpDest = state.dest + '.part'
  try {
    const res = await fetch(`${HF_BASE}/${state.file}`, {
      signal: state.controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'MiniMaxH3Studio/1.0' },
    })
    if (!res.ok) {
      state.error = `HuggingFace ${res.status} ${res.statusText}`
      return
    }

    const contentLength = res.headers.get('content-length')
    if (contentLength) state.total = parseInt(contentLength, 10)

    if (!res.body) {
      state.error = 'Ответ без body (неподдерживаемый окружение)'
      return
    }

    const reader = res.body.getReader()
    const out = createWriteStream(tmpDest, { flags: 'w' })

    // (правка 587) 'error'-listener на ВЕСЬ write-этап: раньше слушатели
    // вешались только вокруг out.end() — ошибка записи посреди цикла
    // (ENOSPC/EPERM на .part-файле) эмитилась с нулём слушателей и
    // валила весь сервер uncaught-ом. Флаг проваливает цикл (throw),
    // fetch и reader отменяет controller.abort() в catch ниже.
    let writeError: Error | null = null
    out.on('error', (err: Error) => {
      writeError = err
    })

    let received = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (state.cancelled) break

      if (value) {
        const b = Buffer.from(value)
        // (правка 347) Backpressure: write() возвращает false, когда
        // внутренний буфер переполнен — раньше чанки продолжали сыпаться,
        // и весь файл копился в RAM (до сотен МБ у ggml-моделей).
        if (!out.write(b)) {
          await new Promise<void>((resolve, reject) => {
            // (правка 587) drain после ошибки записи = ошибка, не успех
            out.once('drain', () => (writeError ? reject(writeError) : resolve()))
            out.once('error', reject)
          })
        }
        if (writeError) {
          out.destroy()
          throw writeError
        }
        received += b.length
        state.downloaded = received
      }
    }
    if (writeError) {
      out.destroy()
      throw writeError
    }
    out.end()
    await new Promise<void>((resolve, reject) => {
      out.on('finish', resolve)
      out.on('error', reject)
    })

    if (state.cancelled) {
      // Clean up partial file
      try { if (existsSync(tmpDest)) unlinkSync(tmpDest) } catch { /* ignore */ }
      return
    }

    // (правка 347) Сверяем фактический объём с content-length ДО rename:
    // раньше обрыв соединения (fetch без ошибки, просто короткий body)
    // переименовывал обрезанный файл в «готовую» модель, и whisper падал
    // на загрузке уже молча.
    if (state.total && received < state.total) {
      state.error = `Скачано не полностью: ${received} из ${state.total} байт — нажмите «Скачать» ещё раз`
      try { if (existsSync(tmpDest)) unlinkSync(tmpDest) } catch { /* ignore */ }
      return
    }

    // Rename .part → final
    const fs = await import('fs')
    fs.renameSync(tmpDest, state.dest)
    state.done = true
    state.downloaded = received
  } catch (err) {
    if (state.cancelled) {
      try { if (existsSync(tmpDest)) unlinkSync(tmpDest) } catch { /* ignore */ }
    } else {
      state.error = err instanceof Error ? err.message : String(err)
      try { if (existsSync(tmpDest)) unlinkSync(tmpDest) } catch { /* ignore */ }
    }
  } finally {
    // Keep state in map for progress queries; clean up after a delay
    setTimeout(() => {
      if (state.done || state.cancelled || state.error) {
        active.delete(state.name)
      }
    }, 60_000) // keep available for 60s after completion
  }
}
