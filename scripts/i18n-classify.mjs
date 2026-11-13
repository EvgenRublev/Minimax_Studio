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

/** В файле есть локальная переменная с именем `t` (например таймлайн: map((t) => …)).
 * Тогда переводчику нужно другое имя, иначе вызов t("…) разобьется на t("…") как вызов числа. */
export function hasTBinding(sf) {
  let clash = false
  const visit = (n) => {
    if ((ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n)) && n.name && n.name.getText() === 't') {
      const init = ts.isVariableDeclaration(n) ? (n.initializer?.getText() ?? '') : (ts.isBindingElement(n) ? (n.parent?.parent?.getText?.() ?? '') : '')
      if (!init.includes('useTranslation')) clash = true
    }
    if (ts.isShorthandPropertyAssignment(n) && n.name.text === 't') clash = true
    if (!clash) ts.forEachChild(n, visit)
  }
  ts.forEachChild(sf, visit)
  return clash
}

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
    if (g && ts.isJsxAttributes(g)) {
      const a = g.parent
      return !!a && DISPLAY_ATTRS.has(a.attributeName.getText())
    }
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
      let name = ''
      if (ts.isFunctionDeclaration(p) && p.name) name = p.name.text
      else if (ts.isMethodDeclaration(p) && p.name) name = p.name.getText()
      else {
        const vd = p.parent
        if (vd && ts.isVariableDeclaration(vd) && ts.isIdentifier(vd.name)) name = vd.name.text
      }
      fns.push({ fn: p, name })
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
