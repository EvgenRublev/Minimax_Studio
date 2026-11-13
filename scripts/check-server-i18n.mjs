#!/usr/bin/env node
/**
 * (правка 959) check-server-i18n.mjs — в серверных модулях не должно быть
 * клиентских i18n-хуков.
 *
 * Что ловит: `useTranslation()` / `import ... from 'react-i18next'` в
 * src/app/api/** и src/lib/**. В серверном бандле Next.js react-i18next
 * отдаёт модуль без хука — `TypeError: (0, f.useTranslation) is not a function`
 * и HTTP 500 на каждом запросе. Именно так сломался /api/settings (ошибка
 * сохранения настроек) и /api/llm/chat (ассистент) в 7.1.23.
 *
 * Для серверных текстов использовать `st()` / `stLang()` из
 * `src/lib/i18n/server.ts`; хуки — только в клиентских компонентах.
 *
 * Запуск: node scripts/check-server-i18n.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const ROOT = process.cwd()
const AREAS = ['src/app/api', 'src/lib']

/** Клиентские файлы в src/lib, которым хук разрешён (инициализация i18n). */
const ALLOW = new Set(['src/lib/i18n/index.ts'])

function walk(dir, out = []) {
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(e.name) && statSync(p).isFile()) out.push(p)
  }
  return out
}

const files = AREAS.flatMap((a) => walk(join(ROOT, a)))
let pass = 0
const fails = []

for (const full of files) {
  const rel = relative(ROOT, full).split(sep).join('/')
  const src = readFileSync(full, 'utf8')
  const hooks = /useTranslation\s*\(/.test(src) || /from\s+['"]react-i18next['"]/.test(src)
  if (!hooks) {
    pass++
    continue
  }
  if (ALLOW.has(rel)) {
    pass++
    continue
  }
  fails.push(rel)
}

for (const f of fails) {
  console.error(`FAIL  ${f}: клиентский i18n-хук в серверном модуле — используйте st() из @/lib/i18n/server`)
}

console.log(`PASS=${pass} FAIL=${fails.length}`)
process.exit(fails.length ? 1 : 0)
