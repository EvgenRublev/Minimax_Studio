/** (правка 955) Классификация позиции строки: показная она или данные. */
import { ts, DISPLAY_ATTRS, DISPLAY_PROPS, DISPLAY_CALLS, DISPLAY_TOAST_METHODS } from './i18n-rules.mjs'

const CMP = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken,
])
/** Методы, первый аргумент которых — ключ/подстрока для поиска, а не текст. */
const DATA_METHODS = new Set(['includes', 'indexOf', 'lastIndexOf', 'startsWith', 'endsWith', 'localeCompare', 'split', 'search', 'has', 'get', 'set', 'add', 'delete', 'match', 'replace', 'replaceAll', 'test', 'at'])

/** true, если строка сравнивается/ищется — переводить нельзя, нужен разбор руками. */
export function isDataUse(node) {
  let cur = node
  let p = cur.parent
  while (p) {
    if (ts.isBinaryExpression(p) && CMP.has(p.operatorToken.kind)) return true
    if (ts.isCaseClause(p) || ts.isDefaultClause(p)) return true
    if (ts.isCallExpression(p)) {
      const e = p.expression
      if (ts.isPropertyAccessExpression(e) && DATA_METHODS.has(e.name.text) && p.arguments[0] === cur) return true
      if (ts.isPropertyAccessExpression(e) && e.name.text === 'test') return true
    }
    if (ts.isRegularExpressionLiteral(p)) return true
    if (ts.isComputedPropertyName(p)) return true
    if (ts.isCaseClause(p) || ts.isDefaultClause(p)) return true
    // || / ?? с d.error — это фолбэк-текст, он показной
    if (ts.isBinaryExpression(p) && (p.operatorToken.kind === ts.SyntaxKind.BarBarToken || p.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
      return false
    }
    if (ts.isPropertyAssignment(p) && p.name === cur) return true
    if (ts.isElementAccessExpression(p)) return true
    if (ts.isNewExpression(p) && p.expression.getText() === 'Error') return false
    if (ts.isFunctionLike(p)) return false
    cur = p
    p = p.parent
  }
  return false
}

/** В файле есть локальная переменная с именем `name` (например `const st = fs.statSync`
 * или таймлайн map((t) => …)). Имя переводчика тогда берём другое. */
export function hasBinding(sf, name = 't') {
  let clash = false
  const visit = (n) => {
    if ((ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n)) && n.name && n.name.getText() === name) {
      const init = ts.isVariableDeclaration(n) ? (n.initializer?.getText() ?? '') : (ts.isBindingElement(n) ? (n.parent?.parent?.getText?.() ?? '') : '')
      if (!init.includes('useTranslation')) clash = true
    }
    if (ts.isShorthandPropertyAssignment(n) && n.name.text === name) clash = true
    if (!clash) ts.forEachChild(n, visit)
  }
  ts.forEachChild(sf, visit)
  return clash
}

/** Имя переводчика, свободное в этом файле: t → tt → tT; st → stT. */
export function pickFnName(sf, base) {
  const candidates = base === 't' ? ['t', 'tt', 'tT'] : [base, `${base}T`, `${base}X`]
  for (const c of candidates) if (!hasBinding(sf, c)) return c
  return candidates[candidates.length - 1]
}

export const hasTBinding = (sf) => hasBinding(sf, 't')

/** Показной ли текст в этой позиции: JSX-атрибут, свойство label/title, toast(), JSX-выражение, label-объект. */
export function isDisplayPosition(node, depth = 0) {
  const p = node.parent
  if (!p || depth > 6) return false
  if (ts.isParenthesizedExpression(p)) return isDisplayPosition(p, depth + 1)
  if (ts.isJsxAttribute(p) && p.initializer === node) {
    return DISPLAY_ATTRS.has(p.name.getText())
  }
  if (ts.isJsxExpression(p)) {
    const g = p.parent
    // title={cond ? 'a' : 'b'} / onClick-атрибут со сложным выражением
    if (g && ts.isJsxAttribute(g)) return DISPLAY_ATTRS.has(g.name.getText())
    // {...} прямо в детях JSX — это отрендеренный текст
    if (g && (ts.isJsxElement(g) || ts.isJsxFragment(g))) return true
    return false
  }
  if (ts.isPropertyAssignment(p) && p.initializer === node) return DISPLAY_PROPS.has(p.name.getText())
  if (ts.isCallExpression(p)) {
    const e = p.expression
    if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'toast' && DISPLAY_TOAST_METHODS.has(e.name.text)) return true
    if (ts.isIdentifier(e) && DISPLAY_CALLS.has(e.text)) return true
    if (ts.isIdentifier(e) && e.text === 'confirm') return true
    return false
  }
  if (ts.isBinaryExpression(p) && (p.operatorToken.kind === ts.SyntaxKind.BarBarToken || p.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
    return isDisplayPosition(p, depth + 1)
  }
  if (ts.isConditionalExpression(p)) return isDisplayPosition(p, depth + 1)
  if (ts.isJsxSpreadAttribute(p) || ts.isObjectLiteralExpression(p)) return false
  if (ts.isReturnStatement(p)) return false
  if (ts.isVariableDeclaration(p)) return false
  if (ts.isArrowFunction(p) || ts.isFunctionExpression(p)) return false
  if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.PlusToken) return isDisplayPosition(p, depth + 1)
  return false
}

/** Имя функции: объявление, `const X = () =>`, либо аргумент обёртки
 * (`memo(function X(){})`, `forwardRef(function X(){})`) — иначе компонент
 * с анонимной функцией внутри memo считался бы «уровнем модуля». */
function fnName(p) {
  if (ts.isFunctionDeclaration(p) && p.name) return p.name.text
  if (ts.isMethodDeclaration(p) && p.name) return p.name.getText()
  const parent = p.parent
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text
  if (parent && ts.isCallExpression(parent)) {
    const gp = parent.parent
    if (gp && ts.isVariableDeclaration(gp) && ts.isIdentifier(gp.name)) return gp.name.text
  }
  return ''
}

/** Хост для перевода: внешняя ИМЕНОВАННАЯ функция, в которую ставим хук (или
 * которая должна получить импорт t). Анонимные стрелки внутри компонента
 * накрываются хуком компонента — иначе в файле появляется неиспользуемый импорт.
 *
 * isComponent=true → хосту нужен `const { t } = useTranslation()`;
 * isComponent=false → хосту нужен импорт t из '@/lib/i18n' (модульная функция,
 * стор, хук: перевод берётся в момент вызова, это корректно для тостов/статусов). */
export function enclosingFunction(node) {
  const fns = []
  let p = node.parent
  while (p) {
    if (ts.isArrowFunction(p) || ts.isFunctionExpression(p) || ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) {
      fns.push({ fn: p, name: fnName(p) })
    }
    if (ts.isSourceFile(p)) break
    p = p.parent
  }
  if (!fns.length) return null
  const named = fns.filter((f) => f.name)
  if (!named.length) return null
  const innermost = named[named.length - 1]
  const hasOuterFn = fns.length > (fns.indexOf(innermost) + 1)
  if (!hasOuterFn) return { fn: innermost.fn, name: innermost.name, isComponent: /^[A-Z]/.test(innermost.name) }
  // вложенная: ищем самый внешний компонент — хук ставим ему
  const outer = named[0]
  const anyComponent = named.some((f) => /^[A-Z]/.test(f.name))
  if (anyComponent) {
    const host = named.find((f) => /^[A-Z]/.test(f.name))
    return { fn: host.fn, name: host.name, isComponent: true }
  }
  return { fn: outer.fn, name: outer.name, isComponent: false }
}
