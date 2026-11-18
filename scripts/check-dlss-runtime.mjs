#!/usr/bin/env node
/**
 * (правки 1042, 1053) Проверка DLSS runtime перед релизом.
 *
 * Инварианты правила 1053:
 *  • полный setup.exe ОБЯЗАН содержать upscale/bin/runtime целиком;
 *  • в Minimax_Studio_update.zip и в git-репозитории GitHub этих файлов
 *    быть НЕ должно (проверяются здесь и в make-update-zip.mjs).
 * Проверка ловит случай, когда upscale/bin не скопирован в payload или
 * частично потерян при пересборке — и наоборот, когда runtime случайно
 * закоммитили в репозиторий.
 */
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { REQUIRED_DLSS_RUNTIME, checkDlssRuntime } from './dlss-runtime.mjs'

const root = resolve(process.argv[2] || process.cwd())
const missing = checkDlssRuntime(root)

if (missing.length > 0) {
  console.error('[dlss] ОШИБКА: в upscale/bin/runtime нет обязательных файлов:')
  for (const rel of missing) console.error(`  - ${rel}`)
  process.exit(1)
}

// (правка 1053) git обязан оставаться чистым: десятки МБ вендорных dll в
// репозитории ломают и клонирование, и update-зипы (git archive берёт
// трекнутые файлы). .gitignore закрывает /upscale/bin/ — ловим обход.
const tracked = spawnSync('git', ['ls-files', '--', 'upscale/bin'], { cwd: root, encoding: 'utf8' })
if (tracked.error) {
  console.error(`[dlss] не удалось спросить git ls-files: ${tracked.error.message}`)
  process.exit(1)
}
const inGit = String(tracked.stdout || '').split(/\r?\n/).filter(Boolean)
if (inGit.length > 0) {
  console.error('[dlss] ОШИБКА: DLSS runtime закоммичен в git (так нельзя, см. AGENTS.md):')
  for (const rel of inGit.slice(0, 10)) console.error(`  - ${rel}`)
  console.error(`  ... всего ${inGit.length} файлов; удалите их из индекса/истории коммита.`)
  process.exit(1)
}

console.log(`[dlss] OK — все ${REQUIRED_DLSS_RUNTIME.length} ключевых DLSS-файлов на месте; git чист (upscale/bin не трекнется).`)
