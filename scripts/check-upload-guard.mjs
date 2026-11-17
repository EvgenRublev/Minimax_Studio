#!/usr/bin/env node
/**
 * (правка 1043) Регрессия: тяжёлые upload-роуты не должны попадать под proxy.
 *
 * Next 16 буферизует тело proxy-запросов с лимитом 10 МБ. Если upload-роут
 * снова окажется в matcher'е, большие LoRA/модели/видео будут обрезаться до
 * 10 МБ — именно так сломалась загрузка LoRA в 7.1.31.
 *
 * Проверяем:
 *   - proxy.ts импортирует localRequestGuard и исключает все upload-пути;
 *   - каждый исключённый роут сам вызывает localRequestGuard;
 *   - helper содержит host/origin-проверки.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(process.cwd())
const problems = []
const ok = []

function read(rel) {
  const p = join(ROOT, rel)
  if (!existsSync(p)) {
    problems.push(`нет файла ${rel}`)
    return ''
  }
  return readFileSync(p, 'utf-8')
}

function expect(cond, label) {
  if (cond) ok.push(label)
  else problems.push(label)
}

const proxy = read('src/proxy.ts')
expect(/from\s+['"]@\/lib\/local-request-guard['"]/.test(proxy), 'proxy.ts импортирует localRequestGuard')
expect(/localRequestGuard\(request\)/.test(proxy), 'proxy.ts вызывает localRequestGuard')

const uploadRoutes = [
  'loras',
  'comfy/upload',
  'comfy/diffusion-models',
  'upscale/upload',
  'montage/video',
  'montage/audio',
  'assistant/attachment',
  'stt/transcribe',
]
for (const path of uploadRoutes) {
  expect(proxy.includes(`api/${path}`) || proxy.includes(`api/(?:`) && proxy.includes(path.split('/')[0]),
    `proxy.ts исключает /api/${path} из body-buffering matcher`)
  const file = path === 'loras'
    ? 'src/app/api/loras/route.ts'
    : `src/app/api/${path}/route.ts`
  const src = read(file)
  expect(/localRequestGuard/.test(src), `${file}: импортирует/вызывает localRequestGuard`)
  expect(/localRequestGuard\((?:req|request)\)/.test(src), `${file}: guard реально вызывается`)
}

const helper = read('src/lib/local-request-guard.ts')
expect(/Forbidden host/.test(helper), 'local-request-guard.ts: host-проверка')
expect(/Forbidden origin/.test(helper), 'local-request-guard.ts: origin-проверка')
expect(/sec-fetch-site/i.test(helper), 'local-request-guard.ts: Sec-Fetch-Site-проверка')

if (problems.length) {
  console.error(`[upload-guard] FAIL (${problems.length}):`)
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
console.log(`[upload-guard] OK — ${ok.length} проверок, тяжёлые upload-роуты вне proxy.`)
