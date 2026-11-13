#!/usr/bin/env node
/**
 * (правка 955) Склейка словаря: ключи — из scratchpad/i18n-missing.json (тот же
 * порядок сортировки, что и в keys855.txt), переводы — построчно из
 * scratchpad/tr-01.txt … tr-04.txt. Результат — src/lib/i18n/messages/en/ui.json.
 *
 * Сверки: количество строк, совпадение ключей по позиции (пустой перевод —
 * пропускаем запись), совпадение набора {{pN}}-плейсхолдеров в ключе и переводе
 * (расхождение — строка в отчёт, запись всё равно добавляется: i18next подставит
 * что сможет).
 */
import fs from 'fs'

const missing = JSON.parse(fs.readFileSync('scratchpad/i18n-missing.json', 'utf8'))
const keys = Object.keys(missing).sort((a, b) => a.localeCompare(b, 'ru'))

const parts = ['tr-01.txt', 'tr-02.txt', 'tr-03.txt', 'tr-04.txt']
  .filter((f) => fs.existsSync('scratchpad/' + f))
  // пустые строки (в т.ч. хвостовые переводчика убирает) — не переводы, вырезаем по файлу
  .flatMap((f) => fs.readFileSync('scratchpad/' + f, 'utf8').split(/\r?\n/).filter((x) => x !== ''))

console.log(`keys=${keys.length} translations=${parts.length}`)
if (keys.length !== parts.length) {
  console.log('ОШИБКА: расхождение количества — правь чанки, а не скрипт')
  process.exit(1)
}

const ph = (s) => (s.match(/\{\{[^}]+\}\}/g) || []).sort().join(',')
const out = {}
const warns = []
keys.forEach((k, i) => {
  const v = String(parts[i] ?? '').trim()
  if (!v || v === k) return
  if (ph(k) !== ph(v)) warns.push(`#${i + 1} плейсхолдеры: «${k.slice(0, 50)}» → «${v.slice(0, 50)}»`)
  out[k] = v
})
fs.writeFileSync('src/lib/i18n/messages/en/ui.json', JSON.stringify(out, null, 2) + '\n', 'utf8')
console.log('записано записей:', Object.keys(out).length)
for (const w of warns) console.log('~', w)
