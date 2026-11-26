/**
 * (правка 1149) Регресс-тест разбора промптов клипов в extend-чате.
 *
 * Зачем: ассистент может ответить без ```text-fence (просто текстом с
 * маркерами `clip: N`) или склеить маркер с первым полем
 * (`clip: 1 integrated_multimodal_description: ...`). В обоих случаях UI
 * обязан показать кнопки «В клип N» — на реальном отчёте кнопок не было.
 *
 * Компилируем src/lib/assistant-fence.ts через TypeScript API и гоняем
 * чистые функции: без DOM, без запуска Next.
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import ts from 'typescript'

const ROOT = resolve(process.cwd())
const problems = []
const ok = []

const expect = (cond, label) => (cond ? ok.push(label) : problems.push(label))

const src = readFileSync(join(ROOT, 'src/lib/assistant-fence.ts'), 'utf-8')
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  fileName: 'assistant-fence.ts',
}).outputText
const mod = await import('data:text/javascript;base64,' + Buffer.from(js, 'utf8').toString('base64'))
const { parseClipMarker, stripClipMarker, parsePlainClipSections, parseAllFences } = mod

// 1. Маркер отдельной строкой (норма) — и в fence, и в голом тексте.
const normal = 'clip: 1\nintegrated_multimodal_description: A.\noverall_soundscape: b\nnon_diegetic_music: "N/A"'
expect(parseClipMarker(normal) === 1, 'parseClipMarker: маркер отдельной строкой')
expect(!stripClipMarker(normal).includes('clip:'), 'stripClipMarker: маркерная строка вырезана')
expect(stripClipMarker(normal).startsWith('integrated_multimodal_description:'), 'stripClipMarker: первое поле сохранено')

// 2. Склеенный маркер (реальный отчёт): `clip: 1 integrated_multimodal_description: …`
const merged = 'clip: 1 integrated_multimodal_description: Camera pushes in.\noverall_soundscape: x\nnon_diegetic_music: "N/A"'
expect(parseClipMarker(merged) === 1, 'parseClipMarker: склеенный маркер распознан')
const mergedClean = stripClipMarker(merged)
expect(mergedClean.startsWith('integrated_multimodal_description:'), 'stripClipMarker: склеенный маркер вырезан, поле сохранено')
expect(!mergedClean.includes('clip:'), 'stripClipMarker: слово clip не осталось')

// 3. Ответ БЕЗ fence — секции по маркерам.
const sections = parsePlainClipSections(merged)
expect(sections.length === 1 && sections[0].clip === 1, 'parsePlainClipSections: один клип без fence')
expect(sections[0].prompt.startsWith('integrated_multimodal_description:'), 'parsePlainClipSections: промпт без маркера')

const two = 'clip: 1 integrated_multimodal_description: First.\noverall_soundscape: a\nclip: 2 integrated_multimodal_description: Second.\noverall_soundscape: b'
const twoSections = parsePlainClipSections(two)
expect(twoSections.length === 2, 'parsePlainClipSections: два клипа в одном тексте')
expect(twoSections[1].clip === 2, 'parsePlainClipSections: номер второго клипа')
expect(twoSections[1].prompt.startsWith('integrated_multimodal_description: Second.'), 'parsePlainClipSections: тело второго клипа')

// 4. Болтовня без промпта — секций нет (кнопок быть не должно).
expect(parsePlainClipSections('Привет! Чем помочь?').length === 0, 'parsePlainClipSections: болтовня не считается промптом')

// 5. Нормальный fence не ломается: строки ```text/``` снимаются.
const fenced = '```text\nclip: 1\nintegrated_multimodal_description: X\n```'
const fencedSections = parsePlainClipSections(fenced)
expect(fencedSections.length === 1 && fencedSections[0].clip === 1, 'parsePlainClipSections: fence-текст тоже разбирается')
expect(parseAllFences(fenced).length === 1, 'parseAllFences: обычный fence по-прежнему найден')

if (problems.length) {
  console.error('\n[assistant-fence] ПРОВАЛ:')
  for (const p of problems) console.error('  FAIL  ' + p)
  process.exit(1)
}
console.log(`[assistant-fence] OK — ${ok.length} проверок разбора промптов клипов`)
