/**
 * (правка 955) Прогон извлечения по всему контуру интерфейса — без shell-списков,
 * чтобы ничего не обрезалось и не терялось: сам обходит файлы и выбирает режим
 * (t() в клиентских модулях, st() в серверных).
 *
 * Запуск: node scripts/i18n-run.mjs [--apply] [--pass2]
 * Отчёт: scratchpad/i18n-run.log, scratchpad/i18n-manual.txt
 */
import fs from 'fs'
import path from 'path'
import { analyze } from './i18n-scan.mjs'
import { apply } from './i18n-apply.mjs'
import { CY } from './i18n-rules.mjs'

const APPLY = process.argv.includes('--apply')
const PASS2 = process.argv.includes('--pass2')

/** Не переводим: воркфлоу-шаблоны и клиент ComfyUI (данные/протокол), LLM-промпты,
 * «Обучение», i18n-ядро, shadcn-примитивы. */
const EXCLUDE = /(\\|\/)learn(\\|\/)|(\\|\/)comfy(\\|\/)|assistant-stream|llm-runner|llm-context-trim|llm-sampling|llm-audio-guard|llm-media|llm-bonsai|llm-ref-digest|h3-prompt-spec|prompt-guide|app-config|settings-mirror|settings-storage|prefs-sync|(\\|\/)i18n(\\|\/)|(\\|\/)ui(\\|\/)/
/** Серверные модули: их тексты рождаются в Node → st() из i18n/server. */
/** Серверные модули (в браузерный бандл не попадают): их тексты рождаются в Node
 * → st() из i18n/server. Список = lib-модули, недостижимые из клиентских файлов. */
const SERVER_ONLY = new Set(['app-update', 'assistant-refs', 'assistant-sse', 'extend-meta', 'extra-model-paths', 'gallery-folders', 'inflight-journal', 'latent-file', 'local-file', 'loras-config', 'model-downloader', 'multipart-stream', 'pending-meta', 'ref-video-compress', 'refine-meta', 'replace-video-audio', 'stt-runner', 'thumb', 'upscale-meta', 'upscale-paths', 'upscale-runner', 'video-format', 'video-probe', 'vram-arbiter', 'splash'])

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (!e.name.startsWith('.')) walk(p, out) }
    else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts') && !EXCLUDE.test(p)) out.push(p)
  }
  return out
}

const files = ['src/components', 'src/hooks', 'src/app', 'src/lib'].flatMap((d) => walk(d))
const manual = []
let wrapped = 0
let newFiles = 0
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8')
  if (!CY.test(text)) continue
  const name = path.basename(f, path.extname(f))
  const serverMode = f.includes(`${path.sep}api${path.sep}`) || SERVER_ONLY.has(name)
  const opts = serverMode ? { fn: 'st', module: '@/lib/i18n/server' } : {}
  const a = analyze(f, text, opts)
  if (!a.keys.length && !a.manual.length) continue
  const r = apply(text, a, opts)
  wrapped += a.keys.length
  newFiles++
  if (APPLY) fs.writeFileSync(f, r.out, 'utf8')
  for (const m of a.manual) manual.push(`${path.relative('.', f)}:${m.line}\t[${m.why}]\t${m.text}`)
  for (const d of r.dropped) manual.push(`${path.relative('.', f)}:${d.start}\t[конфликт правки]\t${d.text}`)
}
fs.mkdirSync('scratchpad', { recursive: true })
fs.writeFileSync('scratchpad/i18n-manual.txt', manual.join('\n') + '\n', 'utf8')
fs.writeFileSync('scratchpad/i18n-run.log', `files=${newFiles} wrapped=${wrapped} manual=${manual.length} mode=${APPLY ? 'apply' : 'report'} pass2=${PASS2 ? 'on' : 'off'}\n`, 'utf8')
console.log(fs.readFileSync('scratchpad/i18n-run.log', 'utf8'))
