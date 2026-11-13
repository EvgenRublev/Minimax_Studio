#!/usr/bin/env node
/**
 * (правка 955) Проход 2: подписи из таблиц уровня модуля (TABS, SAMPLERS,
 * FACE_RULES…). Саму таблицу не трогаем — её русские значения и есть ключи;
 * оборачиваем МЕСТА ВЫВОДА: `{item.label}` → `{tt(item.label)}`.
 *
 * Передозировка безопасна: t() от неизвестного ключа возвращает его же, поэтому
 * лишняя обёртка ничего не меняет.
 *
 * Запуск: node scripts/i18n-pass2.mjs [--apply] <файл|папка>…
 */
import fs from 'fs'
import path from 'path'
import { ts, CY } from './i18n-rules.mjs'
import { pickFnName } from './i18n-classify.mjs'
import { DISPLAY_PROPS } from './i18n-rules.mjs'

const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const targets = argv.filter((a) => !a.startsWith('--'))

function filesOf(list, out = []) {
  for (const t of list) {
    const p = path.resolve(t)
    if (fs.statSync(p).isDirectory()) for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const f = path.join(p, e.name)
      if (e.isDirectory()) filesOf([f], out)
      else if (/\.(tsx)$/.test(e.name)) out.push(f)
    } else out.push(p)
  }
  return out
}

let touched = 0
for (const f of filesOf(targets)) {
  const text = fs.readFileSync(f, 'utf8')
  if (!CY.test(text)) continue
  const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  // имя переводчика то же, что выбирает основной кодомод (t / tt / …)
  const hasHook = /\{ t(?:: \w+)? \} = useTranslation/.test(text)
  const hasImport = /from '@\/lib\/i18n'/.test(text)
  if (!hasHook && !hasImport) { console.log(`SKIP (нет хука t): ${path.relative(process.cwd(), f)}`); continue }
  // имя, которым этот файл УЖЕ пользуется (основной кодомод выбрал его с учётом коллизий)
  const used = ['tt', 't', 'tT'].find((n) => new RegExp(`[^\\w$.]${n}\\(`).test(text))
  const tFn = used || pickFnName(sf, 't')
  const edits = []
  const visit = (n) => {
    if (ts.isJsxExpression(n) && n.expression && ts.isPropertyAccessExpression(n.expression)) {
      const prop = n.expression.name.text
      if (DISPLAY_PROPS.has(prop)) {
        const inner = text.slice(n.expression.getStart(sf), n.expression.getEnd())
        if (!new RegExp(`\\b${tFn}\\(`).test(inner)) {
          edits.push({ start: n.expression.getStart(sf), end: n.expression.getEnd(), text: `${tFn}(${inner})` })
        }
      }
    }
    ts.forEachChild(n, visit)
  }
  ts.forEachChild(sf, visit)
  if (!edits.length) continue
  edits.sort((a, b) => b.start - a.start)
  let out = text
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end)
  touched++
  console.log(`${path.relative(process.cwd(), f)}: +${edits.length}`)
  if (APPLY) fs.writeFileSync(f, out, 'utf8')
}
console.log('FILES=' + touched + ' MODE=' + (APPLY ? 'apply' : 'report'))
