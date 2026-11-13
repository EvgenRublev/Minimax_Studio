#!/usr/bin/env node
/**
 * (правка 955) Драйвер выемки: `node scripts/i18n-extract.mjs [--apply] [--server] <файл|папка>…`
 *
 * Без --apply только отчёт (что именно будет переведено и что требует разбора
 * руками). --apply переписывает файлы. --server — для API-роутов: правки идут
 * через st() из '@/lib/i18n/server' вместо t().
 *
 * Список ключей пишется в scratchpad/i18n-keys.json (gitignore) — по нему
 * заполняется английский каталог; ключи, уже закрытые переводом, помечены ok.
 */
import fs from 'fs'
import path from 'path'
import { analyze } from './i18n-scan.mjs'
import { apply } from './i18n-apply.mjs'
import { CY } from './i18n-rules.mjs'

const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const SERVER = argv.includes('--server')
let targets = argv.filter((a) => !a.startsWith('--'))
const opts = SERVER ? { fn: 'st', module: '@/lib/i18n/server' } : {}
const MANUAL_OUT = (argv.find((a) => a.startsWith('--manual-out=')) || '').slice('--manual-out='.length)

/** (правка 955) Контуры интерфейса: всё, что переводим (без «Обучения», ворокфлоу-шаблонов и LLM-промптов). */
const EXCLUDE = /\\learn\\|\\comfy\\|assistant-stream|llm-runner|llm-context-trim|llm-sampling|llm-audio-guard|llm-media|llm-bonsai|llm-ref-digest|h3-prompt-spec|app-config|settings-mirror|settings-storage|prefs-sync|\\i18n\\/
function collect(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (!EXCLUDE.test(p)) collect(p, out) }
    else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts') && !EXCLUDE.test(p)) out.push(p)
  }
  return out
}
if (argv.includes('--ui')) targets = ['src/components', 'src/hooks', 'src/app', 'src/lib'].flatMap((d) => collect(d))

function filesOf(list) {
  const out = []
  for (const t of list) {
    const p = path.resolve(t)
    const stt = fs.statSync(p)
    if (stt.isDirectory()) {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        const f = path.join(p, e.name)
        if (e.isDirectory()) out.push(...filesOf([f]))
        else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(f)
      }
    } else out.push(p)
  }
  return out
}

const catalog = JSON.stringify(
  ['common', 'settings', 'views', 'api'].flatMap((n) => Object.keys(JSON.parse(fs.readFileSync(path.join('src/lib/i18n/messages/en', `${n}.json`), 'utf8')))),
)

let totKeys = 0
let totManual = 0
const manualRows = []
const allKeys = new Set()
for (const f of filesOf(targets)) {
  const text = fs.readFileSync(f, 'utf8')
  if (!CY.test(text)) continue
  const a = analyze(f, text, opts)
  if (!a.keys.length && !a.manual.length) continue
  const r = apply(text, a, opts)
  const rel = path.relative(process.cwd(), f)
  console.log(`\n== ${rel}: t()=${a.keys.length} manual=${a.manual.length} left-as-is=${a.skipped.length}`)
  for (const m of a.manual) { console.log(`   ~ ${m.line}: [${m.why}] ${m.text}`); manualRows.push(`${rel}:${m.line}\t[${m.why}]\t${m.text}`) }
  for (const d of r.dropped) console.log(`   ! конфликт правки у ${d.start}: ${d.text}`)
  for (const k of a.keys) { totKeys++; if (!catalog.includes(JSON.stringify(k.key))) allKeys.add(k.key) }
  totManual += a.manual.length
  if (APPLY) fs.writeFileSync(f, r.out, 'utf8')
}
fs.mkdirSync('scratchpad', { recursive: true })
fs.writeFileSync('scratchpad/i18n-keys.json', JSON.stringify([...allKeys], null, 2), 'utf8')
fs.writeFileSync(MANUAL_OUT || 'scratchpad/i18n-manual.txt', manualRows.join('\n') + '\n', 'utf8')
console.log(`\nИТОГ: строк к переводу=${totKeys} (новых ключей=${allKeys.size}), разbor руками=${totManual}, режим=${APPLY ? 'apply' : 'report'}`)
