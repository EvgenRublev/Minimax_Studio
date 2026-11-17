#!/usr/bin/env node
/**
 * (правка 1042) Проверка DLSS runtime перед релизом.
 *
 * Полный setup.exe обязан содержать upscale/bin/runtime целиком. Проверка
 * ловит случай, когда upscale/bin не скопирован в payload или частично
 * потерян при пересборке. Update.zip намеренно DLSS не носит: обновление
 * приложения не трогает вендорный runtime на диске пользователя.
 */
import { resolve } from 'node:path'
import { REQUIRED_DLSS_RUNTIME, checkDlssRuntime } from './dlss-runtime.mjs'

const root = resolve(process.argv[2] || process.cwd())
const missing = checkDlssRuntime(root)

if (missing.length > 0) {
  console.error('[dlss] ОШИБКА: в upscale/bin/runtime нет обязательных файлов:')
  for (const rel of missing) console.error(`  - ${rel}`)
  process.exit(1)
}

console.log(`[dlss] OK — все ${REQUIRED_DLSS_RUNTIME.length} ключевых DLSS-файлов на месте.`)
