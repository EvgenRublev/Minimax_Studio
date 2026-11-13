#!/usr/bin/env node
/**
 * (правка 955) Проверка состояния перевода — отдельная от сборки и от приложения:
 *
 *   1)=in_scope:  файлы, где остались незакрытые показные строки (счётчик по каждому);
 *   2) keys_missing: ключи, которые код уже просит перевести, но их нет в каталоге;
 *   3) keys_unused: записи каталога, которые нигде в коде не вызываются (мусор);
 *   4) runtime: быстрая проверка самого механизма — при языке ru t() возвращает
 *      исходный текст (значит ничего не «пропало»), при en — строку из каталога,
 *      а пустое значение в каталоге не перекрывает ключ.
 *
 * Ничего не меняет; выход ≠ 0, если есть keys_unused или провален рантайм-тест
 * (непереведённые ключи — это норма процесса, они только показываются).
 */
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const { CY } = { CY: /[А-Яа-яЁё]/ }

const AREAS = ['common', 'settings', 'views', 'api']
const catalog = {}
for (const a of AREAS) {
  Object.assign(catalog, JSON.parse(fs.readFileSync(path.join('src/lib/i18n/messages/en', `${a}.json`), 'utf8')))
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules' && !e.name.startsWith('.')) walk(f, out) }
    else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(f)
  }
  return out
}

const files = walk('src')
const used = new Set()
const codeKeys = new Map() // key → файлы
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8')
  const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const visit = (n) => {
    if ((ts.isCallExpression(n) || ts.isTaggedTemplateExpression(n)) && ts.isIdentifier(n.expression) && /^(t|st|stLang)$/.test(n.expression.text)) {
      const a = n.arguments[0]
      if (a && ts.isStringLiteral(a)) { used.add(a.text); if (!codeKeys.has(a.text)) codeKeys.set(a.text, []); codeKeys.get(a.text).push(path.relative('.', f)) }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
}

const missing = [...codeKeys.keys()].filter((k) => CY.test(k) && !(k in catalog))
const unused = Object.keys(catalog).filter((k) => !used.has(k))

// --- 1) сколько показных строк ещё НЕ обёрнуто в t() (progress-метрика) ---
const { analyze } = await import('./i18n-scan.mjs')
const perFile = []
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8')
  if (!CY.test(text)) continue
  const n = analyze(f, text).keys.length
  if (n) perFile.push([path.relative('.', f), n])
}
perFile.sort((a, b) => b[1] - a[1])
const leftTotal = perFile.reduce((s, r) => s + r[1], 0)

// --- 4) рантайм-тест механизма (тот же код, что в приложении, но без React) ---
const i18n = require('i18next')
i18n.init({
  lng: 'ru', fallbackLng: 'ru', supportedLngs: ['ru', 'en'],
  resources: { ru: { translation: {} }, en: { translation: catalog } },
  keySeparator: false, nsSeparator: false, returnEmptyString: false,
})
const checks = []
checks.push(['ru: ключ возвращается как есть', i18n.t('Совсем не переведённая строка') === 'Совсем не переведённая строка'])
checks.push(['en: перевод из каталога', (() => { const k = Object.keys(catalog)[0]; return !k || i18n.t(k, { lng: 'en' }) === catalog[k] })()])
checks.push(['en: пропущенный ключ не пустой', i18n.t('Нет такой записи', { lng: 'en' }) === 'Нет такой записи'])
checks.push(['подстановка {{p1}}', i18n.t('В очереди {{p1}} задач', { lng: 'ru', p1: 3 }) === 'В очереди 3 задач'])

console.log(`Каталог en: записей ${Object.keys(catalog).length}; ключей в коде: ${codeKeys.size}`)
console.log(`\n1) ПОКАЗНЫХ СТРОК БЕЗ t(): ${leftTotal}`)
for (const [f, n] of perFile.slice(0, 25)) console.log(`   ${String(n).padStart(4)}  ${f}`)
console.log(`\n2) НЕПЕРЕВЕДЕНО (ключ есть в коде, нет в каталоге): ${missing.length}`)
for (const k of missing.slice(0, 60)) console.log('   ?', k.slice(0, 100))
console.log(`\n3) НЕИСПОЛЬЗУЕМЫЕ ЗАПИСИ КАТАЛОГА: ${unused.length}`)
for (const k of unused) console.log('   x', k.slice(0, 100))
console.log('\n4) РАНТАЙМ-ПРОВЕРКИ:')
let bad = 0
for (const [name, ok] of checks) { console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${name}`); if (!ok) bad++ }
process.exit(unused.length || bad ? 1 : 0)
