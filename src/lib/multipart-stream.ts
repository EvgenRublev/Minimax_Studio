/**
 * (правка 103) Потоковый разбор multipart/form-data для Next.js API-роутов.
 *
 * ЗАЧЕМ: `req.formData()` (undici) собирает ВСЁ тело запроса в Blob в RAM
 * (Blob → arrayBuffer() → Buffer — ещё одна полная копия). На файлах в
 * десятки ГБ это гарантированный OOM процесса Node: клиент «догружает
 * до 100 %», а сервер уже мёртв — файл не дописан, «модели нет».
 *
 * Решение: тело разбираем по потоку. Заголовки первой части читаются до
 * начала передачи байтов тела (имя файла известно сразу — можно отказать
 * 400/409 ДО записи), затем тело части отдаётся Readable-стримом, который
 * вызывающий pipe'ит прямо в файл. Память O(чанк), а не O(файл).
 *
 * Используется в: /api/comfy/diffusion-models (модели), /api/loras (LoRAs).
 * Аналогичная логика «вручную» есть в /api/upscale/upload — при изменении
 * этого либа сверить оба подхода.
 *
 * (правка 105) Фикс «утечки» закрывающего boundary в тело части:
 * до фикса байты, уже лежавшие в аккумуляторе carry (например, весь хвост
 * файла + "\r\n--boundary--\r\n"), выгружались как есть, без поиска
 * разделителя — тело части оказывалось длиннее файла, и файл получался
 * повреждённым. Теперь и выгрузка carry, и обработка нового чанка идут
 * через ОДИН хелпер drainCarry(), который всегда сначала ищет закрывающий
 * разделитель.
 *
 * (правка 106) Источник чтения — СОБСТВЕННЫЙ reader Web-потока
 * (req.body.getReader()), а НЕ Readable.fromWeb(req.body).
 * Причина: `Readable.fromWeb` оборачивает тело запроса в адаптер
 * Node↔Web поверх Web-потока, который сам Next построил из IncomingMessage
 * (Readable.toWeb) — двойная конвертация. На больших загрузках этот
 * мост «спотыкался» под бэкпресуром: сервер сбрасывал сокет (ECONNRESET),
 * тогда как тот же самый разбор через req.body.getReader() (как в
 * /api/upscale/upload — рабочем роуте на 32 ГБ) шёл до конца. Теперь
 * источник читаем тем же способом, что и роут, который В РАБОТЕ:
 * reader.read() по одному чанку, без промежуточного Node-адаптера.
 * Node-Readable по-прежнему принимается (для тестов вне Next) —
 * нормализуется через Readable.toWeb.
 */
import { Readable, type Readable as NodeReadable } from 'stream'

/** Ошибка валидации multipart-тела — роуты отдают её как 400, не 500. */
export class MultipartParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MultipartParseError'
  }
}

/**
 * (правка 106) Web-поток в структурном типе: у нас есть req.body (DOM-
 * ReadableStream) и Readable.toWeb (stream/web) — формально разные типы,
 * а нужен только getReader().read().
 */
type WebBody = {
  getReader(): {
    read(): Promise<{ done: boolean; value: unknown }>
    cancel(reason?: unknown): Promise<unknown>
  }
}

/** (правка 106) Принимаем и Web-поток (Next), и Node Readable (тесты). */
export type MultipartSource = WebBody | NodeReadable

function isWebStream(x: unknown): x is WebBody {
  return !!x && typeof (x as WebBody).getReader === 'function'
}

/**
 * Первая часть multipart/form-data.
 * `stream` — тело части (без заголовков и без закрывающего boundary);
 * `cancel()` — прервать чтение тела запроса (reader.cancel): сокет
 * закроется, браузер перестанет слать байты.
 */
export interface MultipartFilePart {
  /** filename из Content-Disposition (null, если у части нет filename). */
  filename: string | null
  /** Сырые заголовки части (до пустой строки). */
  headers: string
  /** Потоковое тело части. */
  stream: Readable
  /** (правка 106) Отменить чтение тела запроса (безопасно вызывать дважды). */
  cancel: () => void
}

const EMPTY = Buffer.alloc(0)

/** boundary из Content-Type: multipart/form-data; boundary=... */
function getBoundary(contentType: string | null): string | null {
  if (!contentType) return null
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
  const b = (m?.[1] ?? m?.[2] ?? '').trim()
  return b || null
}

/** filename из заголовков части (Content-Disposition), экранированные \\X разэкранируются. */
function parseFileName(headers: string): string | null {
  const cd = headers
    .split(/\r?\n/)
    .find((l) => /^content-disposition\s*:/i.test(l))
  if (!cd) return null
  const m = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(cd)
  if (!m) return null
  const name = m[1].replace(/\\(.)/g, '$1').trim()
  return name || null
}

/**
 * Читает первую часть multipart/form-data: заголовки + (возможно) начало
 * тела — и возвращает часть со стримом тела. Тело целиком в память НЕ
 * берётся: после возврата дальше читает только кто-то, кто pipe'ит
 * `part.stream`.
 *
 * @param body — тело запроса: Web ReadableStream (req.body из Next) или
 *              Node Readable (тесты; нормализуется через Readable.toWeb)
 * @param contentType — заголовок Content-Type запроса
 * @throws MultipartParseError — не multipart / нет частей / нет filename
 */
export async function readFirstMultipartPart(
  body: MultipartSource,
  contentType: string | null,
): Promise<MultipartFilePart> {
  const boundary = getBoundary(contentType)
  if (!boundary) {
    throw new MultipartParseError('Ожидается multipart/form-data с boundary')
  }

  const delim = Buffer.from(`\r\n--${boundary}`)

  // (правка 106) Читаем СОБСТВЕННЫМ reader'ом Web-потока — так же, как
  // /api/upscale/upload (рабочий роут). Node Readable переводим в Web
  // (Readable.toWeb — штатное направление, а не от обратного fromWeb).
  const webBody: WebBody = isWebStream(body)
    ? body
    : Readable.toWeb(body as NodeReadable)
  const reader = webBody.getReader()
  const readChunk = async (): Promise<Buffer | null> => {
    const { done, value } = await reader.read()
    if (done || value == null) return null
    return Buffer.isBuffer(value) ? value : Buffer.from(value as unknown as Uint8Array)
  }
  let cancelled = false
  const cancel = () => {
    if (cancelled) return
    cancelled = true
    try {
      const p = reader.cancel()
      if (p && typeof p.catch === 'function') void p.catch(() => { /* уже закрыт */ })
    } catch { /* уже закрыт */ }
  }

  // ── 1) первая граница ──
  // Виртуальный ведущий CRLF: первый «--boundary» в самом начале тела
  // матчится тем же разделителем, что и все последующие.
  let carry = Buffer.from('\r\n')
  for (;;) {
    const i = carry.indexOf(delim)
    if (i >= 0) {
      carry = carry.subarray(i + delim.length)
      break
    }
    const value = await readChunk()
    if (!value) throw new MultipartParseError('Пустое тело запроса (нет частей)')
    carry = Buffer.concat([carry, Buffer.from(value)])
  }

  // После разделителя: «--» = конец тела multipart (частей не было).
  if (carry.length >= 2 && carry.subarray(0, 2).toString() === '--') {
    throw new MultipartParseError('Часть с файлом не найдена')
  }
  if (carry.length >= 2 && carry.subarray(0, 2).toString() === '\r\n') {
    carry = carry.subarray(2)
  }

  // ── 2) заголовки части (до пустой строки) ──
  let headerEnd = -1
  for (;;) {
    headerEnd = carry.indexOf('\r\n\r\n')
    if (headerEnd >= 0) break
    const value = await readChunk()
    if (!value) throw new MultipartParseError('Неполные заголовки multipart-части')
    carry = Buffer.concat([carry, Buffer.from(value)])
  }
  const headers = carry.subarray(0, headerEnd).toString('utf8')
  carry = carry.subarray(headerEnd + 4)

  const filename = parseFileName(headers)

  // Состояние машины (carry — тот же аккумулятор: после заголовков в нём
  // уже лежит возможное начало тела части).
  let pendingEnd = false // разделитель найден, остаток выгружен — ждём push(null)
  let finished = false   // стрим завершён (null выгружен)
  let reading = false     // идёт async-чтение из источника
  let destroyed = false   // ошибка — больше не читаем

  // ── 3) стрим тела части ──
  // (правка 105) Единый хелпер для ОБОИХ путей выгрузки (carry и новый
  // чанк): сначала ищем закрывающий разделитель в накопленном буфере.
  //   - разделитель на позиции i → выдаём carry[0..i), pendingEnd = true;
  //   - разделителя нет → выдаём всё, кроме последних (delim-1) байтов
  //     (они могут быть началом разделителя, разрезанного границей
  //     чанков), хвост оставляем в carry.
  // До фикса путь «carry уже не пуст» выгружал буфер целиком БЕЗ поиска
  // разделителя — закрывающий «\r\n--boundary--\r\n» попадал в тело.
  //
  // Возврат drainCarry():
  //   - false → backpressure (данные во внутреннем буфере стрима — их
  //     дождётся потребитель; больше НЕ читаем источник);
  //   - true  → либо стрим завершён (push null), либо ничего не выдали
  //     (весь буфер — потенциальный хвост разделителя); в этом случае
  //     читающий цикл обязан взять следующий чанк из источника, иначе
  //     потребитель будет ждать «readable» вечно (event loop пустеет —
  //     процесс Node просто тихо выходит, загрузка «молча» не
  //     завершается).
  const drainCarry = (): boolean => {
    if (carry.length === 0) return true
    const i = carry.indexOf(delim)
    if (i >= 0) {
      const chunk = carry.subarray(0, i)
      carry = EMPTY
      pendingEnd = true
      if (chunk.length > 0 && !stream.push(chunk)) return false // backpressure
      stream.push(null)
      finished = true
      return true
    }
    const keep = Math.min(delim.length - 1, carry.length)
    const chunk = carry.subarray(0, carry.length - keep)
    carry = carry.subarray(carry.length - keep)
    if (chunk.length === 0) return true
    return stream.push(chunk) // false → backpressure, carry дождётся read()
  }

  // Читаем из источника, пока не выдали данные, не наступил backpressure
  // или не завершились. Вызывается и из read(), и продолжением цикла.
  const startReading = () => {
    if (reading || finished || destroyed) return
    reading = true
    void (async () => {
      try {
        for (;;) {
          const value = await readChunk()
          if (value == null) {
            // Источник иссяк без закрывающего boundary (например, клиент
            // оборвал загрузку) — выдаём, что накопилось, и завершаем;
            // то, что уже выгружено, остаётся валидным.
            if (carry.length > 0) {
              const chunk = carry
              carry = EMPTY
              stream.push(chunk)
            }
            finished = true
            stream.push(null)
            return
          }
          // Доливаем чанк в аккумулятор и выгружаем до разделителя
          // (или допустимую часть) — та же логика, что в read().
          carry = Buffer.concat([carry, Buffer.from(value)])
          const cont = drainCarry()
          if (finished || destroyed) return
          if (!cont) return // backpressure — read() продолжит позже
          // true, но не finished: чанк целиком ушёл в «хвост» — берём
          // следующий (иначе потребитель ждёт данные вечно).
        }
      } catch (err) {
        destroyed = true
        cancel()
        stream.destroy(err instanceof Error ? err : new Error(String(err)))
      } finally {
        reading = false
      }
    })()
  }

  const stream = new Readable({
    read() {
      if (finished || destroyed) return
      if (pendingEnd) {
        // Разделитель найден, остаток уже выгружен — завершаем стрим.
        finished = true
        stream.push(null)
        return
      }
      if (carry.length > 0) {
        // Выгружаем накопленное (С поиском разделителя — правка 105).
        if (!drainCarry()) return // backpressure — продолжим в read()
        if (finished) return
      }
      // Данных для выдачи нет (carry пуст или только хвост разделителя),
      // а стрим не завершён — обязательно берём следующий чанк из
      // источника (правка 105), иначе цикл «ожидания» никогда не
      // завершится.
      startReading()
    },
  })

  // (правка 106) При разрушении part.stream (отмена загрузки) сразу же
  // гасим и источник — иначе браузер продолжал бы слать гигабайты в
  // никуда.
  stream.on('close', () => {
    destroyed = true
    cancel()
  })

  return { filename, headers, stream, cancel }
}
