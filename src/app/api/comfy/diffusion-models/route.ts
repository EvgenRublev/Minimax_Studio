import { NextResponse, NextRequest } from 'next/server'
import { readdirSync, mkdirSync, existsSync, renameSync, unlinkSync, createWriteStream, statSync } from 'fs'
import { basename, join } from 'path'
import { getAppConfig } from '@/lib/app-config'
import { listExternalModels } from '@/lib/extra-model-paths'
import {
  readFirstMultipartPart,
  MultipartParseError,
  type MultipartFilePart,
} from '@/lib/multipart-stream'

/**
 * GET /api/comfy/diffusion-models
 * Returns list of .safetensors files in the ComfyUI diffusion_models folder.
 *
 * (правка 90) POST — загрузка файла модели (FormData 'file', .safetensors)
 * в models/diffusion_models/; как «Добавить» у LoRA.
 *
 * (правка 102) Стриминг: тело запроса разбирается по потоку (без
 * `req.formData()`, который буферизовал ВЕСЬ файл в heap Node — на
 * моделях >4 ГБ это убивало процесс OOM-ом: «копируется до 100 %,
 * а модели нет»). Байты пишутся прямо в .part-файл, затем атомарный
 * rename. Память O(chunk), а не O(file).
 *
 * (правка 103) Общий потоковый парсер вынесен в @/lib/multipart-stream
 * (тот же, что используется в /api/loras).
 *
 * (правка 106) Тело запроса читается СОБСТВЕННЫМ reader'ом Web-потока
 * (req.body.getReader() внутри парсера) — так же, как рабочий роут
 * /api/upscale/upload. Раньше тело обматывалось Readable.fromWeb, и на
 * больших загрузках под Next.js сервер сбрасывал сокет (ECONNRESET);
 * через штатный reader всё идёт до конца (см. src/lib/multipart-stream).
 */
export const dynamic = 'force-dynamic'

// (правка 293) Основная модель — вернули обратно (была лучше по качеству)
const DEFAULT_MODEL = 'minimax_h3_fastvideo_vsa_datafree_1300step_4step_int8_convrot.safetensors'

export async function GET() {
  let config: ReturnType<typeof getAppConfig> | null = null
  try {
    config = getAppConfig()
    const modelsDir = join(config.comfyRoot, 'ComfyUI', 'models', 'diffusion_models')
    // (правка 102) Регистронезависимо: файл X.SAFETENSORS раньше
    // принимался POST'ом, но не показывался в списке.
    const files = readdirSync(modelsDir).filter(f => f.toLowerCase().endsWith('.safetensors'))
    // (правка 257) Внешние папки (Настройки → Свои папки моделей): модели
    // из них ComfyUI видит через extra_model_paths.yaml, студия — здесь.
    // Имена-относительные-пути совпадают с тем, как их резолвит ComfyUI.
    const external = listExternalModels('diffusion_models')
      .filter((n) => n.toLowerCase().endsWith('.safetensors'))
      .filter((n) => !files.includes(n))
    return NextResponse.json({
      models: [...files, ...external],
      default: DEFAULT_MODEL,
      current: config.diffusionModel || DEFAULT_MODEL,
    })
  } catch {
    // (правка 89) Папка недоступна — НЕ подменяем config.diffusionModel
    // дефолтом: селектор показал бы «базовая», хотя конфиг указывает
    // на альтернативную модель, и молча рассинхронился бы с генерацией.
    return NextResponse.json({
      models: [],
      default: DEFAULT_MODEL,
      current: config?.diffusionModel || DEFAULT_MODEL,
    })
  }
}

/** Прерываем загрузку: клиент больше не читает тело, сокет закрывается. */
function abortUpload(part: MultipartFilePart | null): void {
  try { part?.stream.destroy() } catch { /* уже разрушен */ }
  try { part?.cancel() } catch { /* уже закрыт */ }
}

export async function POST(req: NextRequest) {
  let tmpDest = ''
  let part: MultipartFilePart | null = null
  try {
    const webBody = req.body
    if (!webBody) {
      return NextResponse.json({ error: 'Empty request body' }, { status: 400 })
    }

    // (правка 102) Заголовки части приходят первыми — имя файла известно
    // ДО того, как начнётся передача гигабайтов, и можно отказать (400/409)
    // до единого записанного байта.
    // (правка 106) req.body — Web-поток, читаем его штатным reader'ом
    // (внутри парсера), без Readable.fromWeb — так же, как /api/upscale/upload.
    part = await readFirstMultipartPart(webBody, req.headers.get('content-type'))
    if (!part.filename) {
      abortUpload(part)
      return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    }

    // Санитизация имени — только базовое имя без недопустимых для
    // Windows символов (защита от path traversal).
    const safeName = basename(part.filename).replace(/[\\/:*?"<>|]+/g, '_').trim()
    if (!safeName) {
      abortUpload(part)
      return NextResponse.json({ error: 'Invalid file name' }, { status: 400 })
    }
    if (!safeName.toLowerCase().endsWith('.safetensors')) {
      abortUpload(part)
      return NextResponse.json({ error: 'Only .safetensors files are supported' }, { status: 400 })
    }

    const config = getAppConfig()
    const dir = join(config.comfyRoot, 'ComfyUI', 'models', 'diffusion_models')
    mkdirSync(dir, { recursive: true })
    const dest = join(dir, safeName)
    if (existsSync(dest)) {
      abortUpload(part)
      return NextResponse.json({ error: `File "${safeName}" already exists` }, { status: 409 })
    }

    // (правка 102) Чистим остаточный .part от предыдущей неудачной загрузки.
    const stalePart = dest + '.part'
    if (existsSync(stalePart)) {
      try { unlinkSync(stalePart) } catch { /* ignore */ }
    }

    // (правка 102) Пишем во временный файл .part по мере поступления
    // (потоково, без загрузки всего файла в RAM), затем атомарно
    // переименовываем — при сбое частичный файл не блокирует
    // повторную загрузку (409).
    tmpDest = dest + '.part'
    const ws = createWriteStream(tmpDest)

    await new Promise<void>((resolve, reject) => {
      ws.on('finish', resolve)
      ws.on('error', reject)
      part!.stream.on('error', reject)
      part!.stream.pipe(ws)
    })

    renameSync(tmpDest, dest)
    tmpDest = '' // успех — cleanup не нужен

    let size = 0
    try { size = statSync(dest).size } catch { /* ignore */ }
    return NextResponse.json({ ok: true, name: safeName, size })
  } catch (err) {
    // Убираем частичный файл и прерываем недогруженное тело.
    abortUpload(part)
    if (tmpDest) {
      try { unlinkSync(tmpDest) } catch { /* ignore */ }
    }
    const msg = err instanceof Error ? err.message : String(err)
    if (err instanceof MultipartParseError) {
      return NextResponse.json({ error: msg }, { status: 400 })
    }
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
