/**
 * (правка 955) Применение правок сканера: хуки useTranslation, импорты, замена
 * строк на t("…"). Возвращает новый текст и список пропущенных из-за коллизий правок.
 */
import { ts } from './i18n-rules.mjs'

function sortDesc(edits) { return [...edits].sort((a, b) => b.start - a.start) }

function applyEdits(text, edits) {
  const list = sortDesc(edits)
  const dropped = []
  let out = text
  let prevStart = Infinity
  for (const e of list) {
    if (e.end > prevStart) { dropped.push({ start: e.start, text: e.text.slice(0, 60) }); continue }
    out = out.slice(0, e.start) + e.text + out.slice(e.end)
    prevStart = e.start
  }
  return { out, dropped }
}

export function apply(text, analysis, opts = {}) {
  const tFn = analysis.tFn || opts.fn || 't'
  const mod = opts.module || '@/lib/i18n'
  const hookDecl = tFn === 't' ? 'const { t } = useTranslation()' : `const { t: ${tFn} } = useTranslation()`
  const plainImport = tFn === 't' ? `import { t } from '${mod}'` : tFn === 'st' ? `import { st } from '${mod}'` : `import { t as ${tFn} } from '${mod}'`
  const sf = analysis.sf
  const extra = []
  let hookCount = 0
  let plainUsed = false

  for (const [fn, kind] of analysis.fnUsage) {
    if (kind === 'plain') { plainUsed = true; continue }
    const body = fn.body
    if (!body) continue
    if (body.kind === ts.SyntaxKind.Block) {
      const src = body.getText()
      if (src.includes('useTranslation(')) continue
      extra.push({ start: body.getStart(sf) + 1, end: body.getStart(sf) + 1, text: `\n  ${hookDecl} // (правка 955)\n` })
      hookCount++
    } else {
      // стрелочная с телом-выражением: оборачиваем в блок, иначе хук вставить некуда
      extra.push({
        start: body.getStart(sf), end: body.getEnd(),
        text: `{ ${hookDecl}; return ${body.getText()} }`,
      })
      hookCount++
    }
  }

  const head = text.slice(0, 400)
  const lastImport = sf.statements.filter((s) => ts.isImportDeclaration(s)).pop()
  const anchor = lastImport ? lastImport.getEnd() : (head.startsWith("'use client'") || head.startsWith('"use client"') ? (head.includes('\n') ? head.indexOf('\n') : 0) : 0)
  const addImports = []
  if (hookCount && !/from ['"]react-i18next['"]/.test(text)) addImports.push(`\nimport { useTranslation } from 'react-i18next' // (правка 955)`)
  if (plainUsed && !new RegExp(`from ['"]${mod.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`).test(text)) {
    addImports.push(`\n${plainImport} // (правка 955)`)
  }
  if (addImports.length) extra.push({ start: anchor, end: anchor, text: addImports.join('') })

  return applyEdits(text, [...analysis.edits, ...extra])
}
