/**
 * (правка 331) Журнал inflight-постановок: clientToken → prompt_id.
 *
 * Проблема: страница перезагружена, пока POST /api/comfy/generate был в
 * полёте — сервер мог уже поставить задачу в ComfyUI, а фронт prompt_id
 * не знает → задача-зомби без отслеживания. Теперь фронт генерит
 * clientToken и шлёт его в теле POST; сервер после постановки пишет
 * соответствие сюда. После перезагрузки фронт спрашивает
 * GET /api/comfy/inflight?token=… и re-attach'ит поллинг.
 *
 * Файл: data/inflight-generate.json, записи живут 24 часа.
 */
import fs from 'fs'
import path from 'path'

interface InflightEntry {
  prompt_id: string
  ts: number
}

const MAX_AGE_MS = 24 * 60 * 60 * 1000

function journalFile(): string {
  return path.join(process.cwd(), 'data', 'inflight-generate.json')
}

function loadJournal(): Record<string, InflightEntry> {
  const file = journalFile()
  if (!fs.existsSync(file)) return {}
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, InflightEntry>
    if (!parsed || typeof parsed !== 'object') return {}
    const now = Date.now()
    const fresh: Record<string, InflightEntry> = {}
    for (const [token, e] of Object.entries(parsed)) {
      if (e && typeof e.ts === 'number' && now - e.ts < MAX_AGE_MS) fresh[token] = e
    }
    // (правка 716) Вычищенный журнал СРАЗУ сохраняем: раньше просроченные
    // записи отбрасывались только в памяти, и файл оставался с ними до
    // следующей записи.
    if (Object.keys(fresh).length !== Object.keys(parsed).length) {
      try { saveJournal(fresh) } catch { /* non-critical */ }
    }
    return fresh
  } catch {
    return {}
  }
}

function saveJournal(map: Record<string, InflightEntry>) {
  try {
    fs.mkdirSync(path.dirname(journalFile()), { recursive: true })
    fs.writeFileSync(journalFile(), JSON.stringify(map, null, 2), 'utf-8')
  } catch { /* non-critical */ }
}

/** (правка 692) Полный сброс журнала — заводской сброс: старые clientToken
 *  записи (stale prompts, отменённые задачи) удаляются. */
export function clearInflight() {
  try {
    const file = journalFile()
    if (fs.existsSync(file)) fs.unlinkSync(file)
  } catch { /* non-critical */ }
}

/** /api/comfy/generate: задача принята ComfyUI — запоминаем соответствие. */
export function recordInflight(clientToken: string, promptId: string) {
  try {
    const map = loadJournal()
    map[clientToken] = { prompt_id: promptId, ts: Date.now() }
    saveJournal(map)
  } catch { /* non-critical */ }
}

/** GET /api/comfy/inflight: найти prompt_id по clientToken (null — ещё
 *  не поставлена или запись протухла). */
export function lookupInflight(clientToken: string): string | null {
  try {
    return loadJournal()[clientToken]?.prompt_id ?? null
  } catch {
    return null
  }
}
