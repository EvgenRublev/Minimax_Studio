#!/usr/bin/env node
/**
 * (правка 955) Дам remaining: показные строки, которые ЕЩЁ не переведены — то есть
 * русские литералы вне вызовов t()/tt()/st() в контуре интерфейса (комментарии и
 * строки исключённых разделов — «Обучение», воркфлоу, LLM-промпты — не попадают).
 *
 * Вывод: scratchpad/i18n-tables.json — { "русский текст": ["file:line", …] }.
 * По нему заполняется каталог: подписи модульных таблиц кодомод не оборачивает
 * (их нельзя вычислить при импорте), но перевод для них нужен.
 */
import fs from 'fs'
import path from 'path'
import { ts, CY } from './i18n-rules.mjs'

const EXCLUDE = /(\\|\/)learn(\\|\/)|(\\|\/)comfy(\\|\/)|assistant-stream|llm-runner|llm-context-trim|llm-sampling|llm-audio-guard|llm-media|llm-bonsai|llm-ref-digest|h3-prompt-spec|prompt-guide|app-config|settings-mirror|settings-storage|prefs-sync|(\\|\/)i18n(\\|\/)|(\\|\/)ui(\\|\/)/
const TR = /^(t|tt|st|stT|tT)$/

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (!e.name.startsWith('.')) walk(p, out) }
    else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts') && !EXCLUDE.test(p)) out.push(f2(p))
  }
  return out
}
const f2 = (p) => p

function inTranslateCall(n) {
  let p = n.parent
  while (p) {
    if (ts.isCallExpression(p) && ts.isIdentifier(p.expression) && TR.test(p.expression.text)) return true
    if (ts.isCallExpression(p) && ts.isPropertyAccessExpression(p.expression) && TR.test(p.expression.name.text)) return true
    if (ts.isJsxAttribute(p)) return false
    if (ts.isFunctionLike(p) && !ts.isArrowFunction(p)) return false
    p = p.parent
  }
  return false
}

const out = {}
for (const f of ['src/components', 'src/hooks', 'src/app', 'src/lib'].flatMap((d) => walk(d))) {
  const text = fs.readFileSync(f, 'utf8')
  if (!CY.test(text)) continue
  const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const add = (raw, pos) => {
    const key = raw.replace(/\s+/g, ' ').trim()
    if (!key || !CY.test(key)) return
    const line = sf.getLineAndCharacterOfPosition(pos).line + 1
    ;(out[key] ??= []).push(`${path.relative('.', f)}:${line}`)
  }
  const visit = (n) => {
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) && !inTranslateCall(n)) {
      add(ts.isStringLiteral(n) ? n.text : n.getText(), n.getStart(sf))
    }
    if (ts.isJsxText(n) && !inTranslateCall(n)) add(n.text, n.pos)
    ts.forEachChild(n, visit)
  }
  ts.forEachChild(sf, visit)
}
fs.mkdirSync('scratchpad', { recursive: true })
const sorted = Object.fromEntries(Object.entries(out).sort((a, b) => a[0].localeCompare(b[0], 'ru')))
fs.writeFileSync('scratchpad/i18n-tables.json', JSON.stringify(sorted, null, 2), 'utf8')
console.log('LEFT_KEYS=' + Object.keys(sorted).length)
