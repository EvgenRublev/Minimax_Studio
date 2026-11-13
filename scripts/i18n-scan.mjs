/**
 * (правка 955) Разбор одного файла: находит показные строки, готовит правки
 * (замена на t("…"), хук useTranslation, импорт). Ничего не пишет сам.
 */
import { ts, CY, normKey } from './i18n-rules.mjs'
import { isDataUse, isDisplayPosition, enclosingFunction } from './i18n-classify.mjs'

function q(s) { return JSON.stringify(s) }

/** Части шаблона/конкатенации → ключ с {{pN}} + список подстановок. */
function parts(node) {
  const out = []
  const walk = (n) => {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) { walk(n.left); walk(n.right); return }
    if (ts.isParenthesizedExpression(n)) { walk(n.expression); return }
    if (ts.isStringLiteral(n)) { out.push({ text: n.text }); return }
    if (ts.isNoSubstitutionTemplateLiteral(n)) { out.push({ text: n.getText().slice(1, -1) }); return }
    if (ts.isTemplateExpression(n)) {
      out.push({ text: n.head.text ?? '' })
      for (const sp of n.templateSpans) {
        out.push({ expr: sp.expression.getText() })
        out.push({ text: sp.literal.text ?? '' })
      }
      return
    }
    out.push({ expr: n.getText() })
  }
  walk(node)
  let key = ''
  const params = []
  let hasNewline = false
  for (const p of out) {
    if (p.text !== undefined) { if (p.text.includes('\n')) hasNewline = true; key += p.text }
    else { params.push({ name: `p${params.length + 1}`, expr: p.expr }); key += `{{${params[params.length - 1].name}}}` }
  }
  return { key: normKey(key), params, hasNewline }
}

export function analyze(fileName, text, opts = {}) {
  const tFn = opts.fn || 't'
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const edits = []
  const keys = []
  const manual = []
  const skipped = []
  const fnUsage = new Map() // функция → 'component' | 'plain'
  const seen = new Set()

  const mark = (fn, kind) => {
    if (!fn) return
    const cur = fnUsage.get(fn)
    if (cur === 'component' || (cur === 'plain' && kind === 'plain')) return
    fnUsage.set(fn, kind)
  }

  const addSite = (node, rawKey, params, line) => {
    if (!rawKey) return
    const call = params.length
      ? `${tFn}(${q(rawKey)}, { ${params.map((p) => `${p.name}: ${p.expr}`).join(', ')} })`
      : `${tFn}(${q(rawKey)})`
    if (seen.has(node.getStart(sf))) return
    seen.add(node.getStart(sf))
    // в JSX-атрибуте значение обязано быть в фигурных скобках: title={t("…")}
    const inAttr = ts.isJsxAttribute(node.parent)
    edits.push({ start: node.getStart(sf), end: node.getEnd(), text: inAttr ? `{${call}}` : call })
    keys.push({ key: rawKey, line, params: params.length })
  }

  const handleStringNode = (node) => {
    const pos = node.getStart(sf)
    const line = sf.getLineAndCharacterOfPosition(pos).line + 1
    if (isDataUse(node)) {
      if (CY.test(node.getText())) manual.push({ line, why: 'сравнение/поиск', text: normKey(node.getText()).slice(0, 90) })
      return
    }
    if (!isDisplayPosition(node)) { skipped.push({ line, text: normKey(node.getText()).slice(0, 60) }); return }
    const { key, params, hasNewline } = parts(node)
    if (hasNewline) { manual.push({ line, why: 'многострочный текст — ключ схлопнет перенос', text: key.slice(0, 90) }); return }
    if (!CY.test(key)) { skipped.push({ line, text: key.slice(0, 60) }); return }
    const enc = enclosingFunction(node)
    if (!enc) { manual.push({ line, why: 'уровень модуля — нужен вызов при рендере', text: key.slice(0, 90) }); return }
    mark(enc.fn, enc.isComponent ? 'component' : 'plain')
    addSite(node, key, params, line)
  }

  const visit = (node) => {
    if (ts.isJsxText(node)) {
      if (!CY.test(node.text)) { ts.forEachChild(node, visit); return }
      if (node.containsEntity) { manual.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, why: 'HTML-сущность в тексте JSX', text: normKey(node.text).slice(0, 90) }); return }
      const raw = node.text
      const key = normKey(raw)
      if (!key) { ts.forEachChild(node, visit); return }
      // отступы вокруг текста оставляем как были: правка касается только самого текста
      const leadWs = /^\s*/.exec(raw)[0]
      const trailWs = /\s*$/.exec(raw.slice(leadWs.length))[0]
      const kids = node.parent.children
      const idx = kids.indexOf(node)
      const lead = leadWs && idx > 0 ? "{' '}" : ''
      const trail = trailWs && idx < kids.length - 1 ? "{' '}" : ''
      const start = node.getStart(sf) + leadWs.length
      const end = node.getEnd() - trailWs.length
      edits.push({ start, end, text: `${lead}{${tFn}(${q(key)})}${trail}` })
      keys.push({ key, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, params: 0 })
      const enc = enclosingFunction(node)
      if (!enc) { manual.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, why: 'JSX на уровне модуля', text: key.slice(0, 90) }); edits.pop() }
      else mark(enc.fn, enc.isComponent ? 'component' : 'plain')
      return
    }
    const strish = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node) ||
      (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
        (node.getText().match(CY) !== null))
    if (strish && !(ts.isStringLiteral(node) && (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)))) {
      const parent = node.parent
      const covered = parent && (ts.isBinaryExpression(parent) || ts.isTemplateExpression(parent) || ts.isTemplateSpan(parent) || ts.isParenthesizedExpression(parent))
      if (!covered) handleStringNode(node)
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sf, visit)

  return { sf, edits, keys, manual, skipped, fnUsage }
}
