#!/usr/bin/env node
/**
 * (правка 790) make-update-zip.mjs — сборка архива для автосредства обновления.
 *
 * Состав архива (ровно то, что подменяет install/apply_update.ps1):
 *   • дерево TRACKED-ных файлов репозитория (git archive — LF, без мусора
 *     рабочего дерева и без untracked файлов);
 *   • сжатая production-сборка .next из рабочего дерева (после
 *     `npm run release`, т.е. scripts/prune-build.mjs уже отработал).
 *
 * Чего в архиве НЕТ (и апдейтер их не трогает): node_modules, ComfyUI,
 * модели, install/cache, runtime, данные пользователя. Если package-lock.json
 * отличается от пользовательского, apply_update.ps1 сам запустит окно
 * установки зависимостей.
 *
 * Имя актива — Minimax_Studio_update.zip (строго как ASSET_NAME в
 * src/lib/app-update.ts, иначе приложение его не найдёт в релизе).
 *
 * Использование:
 *   node scripts/make-update-zip.mjs [ref]   (по умолчанию HEAD)
 *
 * Архив берёт git-дерево из REF, а .next — из рабочего дерева: перед выпуском
 * коммитьте, собирайте (npm run release) и только потом запускайте скрипт.
 * Версия в архиве (package.json из REF) сверяется с релизным тегом на стороне
 * фида; здесь дополнительно сверяем её с рабочим деревом — защита от «собрал из
 * старой головы».
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const REF = process.argv[2] || 'HEAD'
const TMP = join(ROOT, '.update-build')
const TMP_ZIP = join(ROOT, '.update-build', 'tree.zip')
const OUT = join(ROOT, 'Minimax_Studio_update.zip')
const TAR = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')

function run(label, cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: false })
  if (r.status !== 0) {
    console.error(`[update-zip] ПРОВАЛ: ${label}`)
    process.exit(1)
  }
}

// .next обязан быть собранным и ужатым.
if (!existsSync(join(ROOT, '.next', 'BUILD_ID'))) {
  console.error('[update-zip] .next не собран — сначала выполните `npm run release`')
  process.exit(1)
}

const pkgVer = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')).version

rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

console.log(`[update-zip] git-дерево из ${REF}...`)
run('git archive', 'git', ['archive', '--format=zip', '-o', TMP_ZIP, REF])
run('tree.zip -> tree/', TAR, ['-xf', TMP_ZIP, '-C', TMP])
rmSync(TMP_ZIP, { force: true })

const stagedPkg = join(TMP, 'package.json')
if (!existsSync(stagedPkg)) {
  console.error('[update-zip] в дереве нет package.json — странное HEAD')
  process.exit(1)
}
const refVer = JSON.parse(readFileSync(stagedPkg, 'utf-8')).version
if (refVer !== pkgVer) {
  console.error(`[update-zip] версия в ${REF} (${refVer}) != версия рабочего дерева (${pkgVer}) — закоммитьте изменения перед сборкой архива`)
  process.exit(1)
}

console.log('[update-zip] копирование .next в дерево...')
cpSync(join(ROOT, '.next'), join(TMP, '.next'), { recursive: true })

// (правка 955) Штамп версии для install.ps1: без .next\H3_APP_VERSION установщик
// считает собранную из архива сборку «устаревшей», сносит её и пересобирает из
// исходников на машине юзера — а там npm-зависимостей может не быть (update-zip
// их не тащит), сборка падает и приложение остаётся без .next. Пишем штамп —
// установщик увидит совпадение с package.json и оставит нашу сборку в покое.
writeFileSync(join(TMP, '.next', 'H3_APP_VERSION'), refVer, 'utf-8')
console.log(`[update-zip] штамп .next\\H3_APP_VERSION = ${refVer}`)

if (existsSync(OUT)) rmSync(OUT, { force: true })
console.log('[update-zip] упаковка...')
run('tar', TAR, ['-a', '-c', '-f', OUT, '-C', TMP, '.'])

const size = statSync(OUT).size
const hash = createHash('sha256').update(readFileSync(OUT)).digest('hex')
rmSync(TMP, { recursive: true, force: true })

console.log(
  `[update-zip] OK: ${OUT}\n  версия ${refVer}, размер ${(size / 1024 / 1024).toFixed(1)} МБ\n  sha256 ${hash}`,
)
