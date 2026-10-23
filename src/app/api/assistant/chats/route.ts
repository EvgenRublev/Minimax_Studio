import { NextResponse } from 'next/server'
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs'
import { join } from 'path'

/**
 * GET  /api/assistant/chats — загрузить чаты из файла проекта.
 * PUT  /api/assistant/chats — сохранить чаты в файл проекта.
 *
 * Файл: <project>/data/assistant-chats.json
 * Формат: { chats: AssistantChat[], activeChatId: string | null }
 *
 * Это позволяет переносить чаты между версиями программы
 * (файл лежит в папке проекта, а не в localStorage браузера).
 */
export const dynamic = 'force-dynamic'

const DATA_DIR = join(process.cwd(), 'data')
const CHATS_FILE = join(DATA_DIR, 'assistant-chats.json')

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

interface Chat {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  /** (правка 427) Режим чата ('generate' | 'extend' | 'controlnet' (правка 502));
   *  необязателен — старые записи без него клиент трактует как 'generate'.
   *  Поля сверх валидации сохраняются как есть (JSON round-trip). */
  mode?: 'generate' | 'extend' | 'controlnet'
  messages: ChatMessage[]
}

interface ChatsPayload {
  chats: Chat[]
  activeChatId: string | null
}

function readChats(): ChatsPayload | null {
  try {
    if (!existsSync(CHATS_FILE)) return null
    const raw = readFileSync(CHATS_FILE, 'utf-8')
    const data = JSON.parse(raw)
    if (!data || !Array.isArray(data.chats)) return null
    // Validate each chat
    const valid = data.chats.filter(
      (c: unknown): c is Chat =>
        !!c &&
        typeof c === 'object' &&
        typeof (c as Chat).id === 'string' &&
        Array.isArray((c as Chat).messages) &&
        (c as Chat).messages.every(
          (m: unknown) =>
            !!m &&
            ((m as ChatMessage).role === 'user' || (m as ChatMessage).role === 'assistant'),
        ),
    )
    return {
      chats: valid,
      activeChatId: typeof data.activeChatId === 'string' ? data.activeChatId : (valid[0]?.id ?? null),
    }
  } catch {
    return null
  }
}

function writeChats(payload: ChatsPayload): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
  const safe = {
    chats: payload.chats,
    activeChatId: payload.activeChatId ?? null,
  }
  // Атомарная запись (tmp + rename): при краше/переполнении диска/гонке
  // PUT+POST прямой writeFileSync мог оставить обрезанный JSON — и тогда
  // ВСЕ серверные чаты терялись (readChats падал бы на парсе).
  const tmp = CHATS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(safe, null, 2), 'utf-8')
  renameSync(tmp, CHATS_FILE)
}

/* ─── GET ─── */
export async function GET() {
  const data = readChats()
  if (!data) {
    return NextResponse.json({ chats: [], activeChatId: null, found: false })
  }
  return NextResponse.json({ ...data, found: true })
}

/* ─── PUT ─── */
export async function PUT(request: Request) {
  try {
    // (правка 716) Лимит тела и числа чатов. Раньше payload был неограничен:
    // весь массив сериализовался и писался синхронно (writeFileSync) в
    // обработчике запроса — один запрос мог занять процесс надолго.
    const MAX_BODY_BYTES = 32 * 1024 * 1024
    const MAX_CHATS = 500
    const declared = Number(request.headers.get('content-length') || 0)
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return NextResponse.json({ error: 'Payload too large' }, { status: 413 })
    }
    const body = await request.json()
    if (!body || !Array.isArray(body.chats)) {
      return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })
    }
    if (body.chats.length > MAX_CHATS) {
      return NextResponse.json({ error: `Too many chats (max ${MAX_CHATS})` }, { status: 400 })
    }
    writeChats({
      chats: body.chats,
      activeChatId: typeof body.activeChatId === 'string' ? body.activeChatId : null,
    })
    return NextResponse.json({ ok: true, count: body.chats.length })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

/* ─── POST ─── */
// Псевдоним PUT: navigator.sendBeacon умеет только POST — без этого
// хендлера фолбэк сохранения чатов при закрытии вкладки получает 405.
export async function POST(request: Request) {
  return PUT(request)
}
