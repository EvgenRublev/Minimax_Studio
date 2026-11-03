/**
 * (правка 804) Серверное зеркало пользовательских настроек.
 *
 * Зачем: раньше все настройки клиента жили только в localStorage Electron/браузера.
 * Практика показала, что запись может теряться:
 *   1. При выходе приложение убивает своё же дерево процессов
 *      (killAncestorCmd → taskkill /T /F), а localStorage Chromium сбрасывает
 *      на диск асинхронно — последние изменения (например, выключенный
 *      Sol-Attn) не успевают записаться и после перезапуска возвращаются
 *      к заводскому значению.
 *   2. Браузерный фолбэк (http://localhost:PORT) и Electron (http://127.0.0.1:PORT)
 *      — РАЗНЫЕ origin, то есть разные хранилища: настройка, выставленная в
 *      одном, отсутствует в другом.
 *   3. Чистка профиля браузера/Electron или смена пользователя — настройки
 *      пропадают вместе с localStorage.
 *
 * Решение: каждая настройка дублируется на сервер в data/settings/<key>.json.
 * Клиент при старте сравнивает метки времени и берёт более свежую копию,
 * поэтому «явно сбросил» (заводской сброс удаляет и зеркало) — единственный
 * способ потерять настройки.
 *
 * Файл пишется атомарно (tmp + rename), чтобы обрыв на середине записи не
 * оставил обрезанный JSON.
 */
import fs from 'fs'
import path from 'path'

/** Одна запись зеркала: значение + метка времени сервера. */
export interface MirrorSnapshot {
  key: string
  /** Date.now() в момент записи (серверное время — та же машина). */
  updatedAt: number
  data: unknown
}

/** Имя файла = ключ; принимаем только простые безопасные ключи. */
const KEY_RE = /^[A-Za-z0-9_-]{1,64}$/

/** Зеркало — не место для больших данных: снимок настроек порядка десятков КБ. */
const MAX_JSON_BYTES = 2 * 1024 * 1024

function mirrorDir(): string {
  return path.join(process.cwd(), 'data', 'settings')
}

function fileFor(key: string): string | null {
  if (!KEY_RE.test(key)) return null
  return path.join(mirrorDir(), `${key}.json`)
}

/** Прочитать зеркало одного ключа; null — если зеркала нет или оно битое. */
export function readMirror(key: string): MirrorSnapshot | null {
  const file = fileFor(key)
  if (!file) return null
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf-8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as MirrorSnapshot
    if (!parsed || typeof parsed !== 'object' || typeof parsed.updatedAt !== 'number') return null
    if (typeof parsed.key !== 'string') parsed.key = key
    return parsed
  } catch {
    // битый файл (например, обрезан при обрыве питания) — считаем, что зеркала нет
    return null
  }
}

/** Все зеркала разом (для дешёвой синхронизации на старте клиента). */
export function readAllMirrors(): Record<string, MirrorSnapshot> {
  const out: Record<string, MirrorSnapshot> = {}
  let names: string[]
  try {
    names = fs.readdirSync(mirrorDir())
  } catch {
    return out
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const key = name.slice(0, -'.json'.length)
    const snap = readMirror(key)
    if (snap) out[key] = snap
  }
  return out
}

/**
 * Записать зеркало. Возвращает записанный снимок или null, если ключ/размер
 * не прошли проверку (400 на уровне роута).
 */
export function writeMirror(key: string, data: unknown): MirrorSnapshot | null {
  const file = fileFor(key)
  if (!file) return null
  const snapshot: MirrorSnapshot = { key, updatedAt: Date.now(), data }
  let json: string
  try {
    json = JSON.stringify(snapshot)
  } catch {
    return null
  }
  if (Buffer.byteLength(json, 'utf-8') > MAX_JSON_BYTES) return null
  try {
    fs.mkdirSync(mirrorDir(), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, json, 'utf-8')
    fs.renameSync(tmp, file)
    return snapshot
  } catch {
    return null
  }
}

/** Удалить зеркало одного ключа (обычный сброс конкретной настройки). */
export function deleteMirror(key: string): boolean {
  const file = fileFor(key)
  if (!file) return false
  try {
    fs.rmSync(file, { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * Удалить ВСЕ зеркала — часть «Заводского сброса» (правка 804).
 * Без этого шага очищенный localStorage на следующем старте был бы молча
 * восстановлен из зеркала, то есть сброс не считался бы настоящим.
 */
export function clearAllMirrors(): number {
  let removed = 0
  let names: string[]
  try {
    names = fs.readdirSync(mirrorDir())
  } catch {
    return 0
  }
  for (const name of names) {
    if (!name.endsWith('.json') && !name.endsWith('.json.tmp')) continue
    try {
      fs.rmSync(path.join(mirrorDir(), name), { force: true })
      removed += 1
    } catch { /* ignore */ }
  }
  return removed
}
