#!/usr/bin/env node
/**
 * (правка 939) Генератор install/checksums.json — контрольных сумм офлайн-бандла
 * установщика (install/cache/**) и, опционально, докачка самого бандла.
 *
 * Зачем: половина «у меня не устанавливается» — это битый архив в .install-cache
 * (обрванное качание или HTML-страница прокси вместо файла). Install.ps1 теперь
 * проверяет любой архив по магическим байтам, а для неизменяемых артефактов ещё
 * и sha256 — вот эти суммы здесь и лежат.
 *
 * Запуск:
 *   node scripts/make-installer-cache.mjs          — пересчитать checksums.json
 *   node scripts/make-installer-cache.mjs --fill   — докачать недостающие файлы бандла,
 *                                                    затем пересчитать checksums.json
 *
 * Бандл в git не кладётся (лимит GitHub 100 МБ/файл), checksums.json — кладётся.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CACHE_DIR = join(ROOT, 'install', 'cache')
const OUT = join(ROOT, 'install', 'checksums.json')

/**
 * Неизменяемые артефакты: их sha256 инсталлятор сверяет и с бандла, и с сети.
 * Архивы тегов GitHub (ComfyUI, зипи нод через codeload) GitHub пересобирает
 * не байт-в-байт — для них сумма годится только как «бандл целый», но не как
 * ожидание для скачанного из сети.
 */
const PINNED = [
  /^node-v\d+\.\d+\.\d+-win-x64\.zip$/,
  /^python-\d+\.\d+\.\d+-embed-amd64\.zip$/,
  /^electron-v\d+\.\d+\.\d+-win32-x64\.zip$/,
  /^uv-[a-z0-9_.-]+\.zip$/,
]

const isPinned = (rel) => PINNED.some((re) => re.test(basename(rel)))
const kindOf = (rel) => (rel.toLowerCase().endsWith('.zip') ? 'zip' : '')

function walk(dir, prefix = '') {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    const full = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(full, rel))
    else if (e.isFile()) out.push({ rel, full })
  }
  return out
}

function sha256(file) {
  const h = createHash('sha256')
  h.update(readFileSync(file))
  return h.digest('hex')
}

// ─── --fill: чего именно не хватает в бандле ────────────────────────────────

function bundleSpec() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const elVer = (String(pkg.devDependencies?.electron || pkg.dependencies?.electron || '').replace(/^[\^~]/, '')) || null
  const inst = readFileSync(join(ROOT, 'install', 'install.ps1'), 'utf8')
  const nodeVer = (inst.match(/\$nodeVersion\s*=\s*'([\d.]+)'/) || [])[1] || null
  const comfyVer = (inst.match(/\$ComfyVersion\s*=\s*'([\d.]+)'/) || [])[1] || null
  const pyMatch = inst.match(/python-(\d+\.\d+\.\d+)-embed-amd64\.zip/)
  const pyVer = pyMatch ? pyMatch[1] : null
  const uvVer = (inst.match(/uv\/releases\/download\/([\d.]+)\//) || [])[1] || null

  const jobs = []
  if (nodeVer) jobs.push({ rel: `node-v${nodeVer}-win-x64.zip`, url: `https://nodejs.org/dist/v${nodeVer}/node-v${nodeVer}-win-x64.zip` })
  if (pyVer) jobs.push({ rel: `python-${pyVer}-embed-amd64.zip`, url: `https://www.python.org/ftp/python/${pyVer}/python-${pyVer}-embed-amd64.zip` })
  if (elVer) jobs.push({ rel: `electron-v${elVer}-win32-x64.zip`, url: `https://github.com/electron/electron/releases/download/v${elVer}/electron-v${elVer}-win32-x64.zip` })
  if (uvVer) jobs.push({ rel: `uv-x86_64-pc-windows-msvc.zip`, url: `https://github.com/astral-sh/uv/releases/download/${uvVer}/uv-x86_64-pc-windows-msvc.zip` })
  if (comfyVer) jobs.push({ rel: `ComfyUI-v${comfyVer}.zip`, url: `https://github.com/comfyanonymous/ComfyUI/archive/refs/tags/v${comfyVer}.zip` })
  jobs.push({ rel: 'get-pip.py', url: 'https://bootstrap.pypa.io/get-pip.py' })
  for (const n of JSON.parse(readFileSync(join(ROOT, 'install', 'nodes.json'), 'utf8'))) {
    jobs.push({ rel: `nodes/${n.name}.zip`, url: `https://codeload.github.com/${n.repo}/zip/${n.sha}` })
  }
  return jobs
}

function fill() {
  mkdirSync(join(CACHE_DIR, 'nodes'), { recursive: true })
  const jobs = bundleSpec().filter((j) => !existsSync(join(CACHE_DIR, j.rel)))
  if (!jobs.length) {
    console.log('[cache] бандл полон, докачивать нечего')
    return
  }
  console.log(`[cache] не хватает ${jobs.length} файл(ов), качаю в install/cache ...`)
  for (const j of jobs) {
    const dst = join(CACHE_DIR, j.rel)
    mkdirSync(dirname(dst), { recursive: true })
    console.log(`  ↓ ${j.rel}`)
    const r = spawnSync('curl.exe', ['-fL', '--retry', '3', '--retry-delay', '2', '-o', dst, j.url], { stdio: 'inherit' })
    if (r.status !== 0 || !existsSync(dst) || statSync(dst).size === 0) {
      console.error(`[cache] НЕ скачалось: ${j.rel} (${j.url})`)
      if (existsSync(dst)) { try { rmSync(dst) } catch { /* уже нет */ } }
      process.exitCode = 1
    }
  }
}

// ─── checksums.json ─────────────────────────────────────────────────────────

function main() {
  if (process.argv.includes('--fill')) fill()
  if (!existsSync(CACHE_DIR)) {
    console.error('[cache] нет папки install/cache — бандл установщика не собран')
    process.exit(1)
  }
  const files = walk(CACHE_DIR).sort((a, b) => (a.rel < b.rel ? -1 : 1))
  const out = {
    note: 'Контрольные суммы офлайн-бандла установщика (install/cache). Нужны, чтобы битый архив в кэше или в самом установщике обнаруживался до распаковки. Заполняется скриптом scripts/make-installer-cache.mjs.',
    generatedAt: new Date().toISOString().slice(0, 19) + 'Z',
    pinnedMeaning: 'pinned=true — артефакт неизменяем (nodejs.org, python.org, релизный ассет GitHub), сумму сверяем и для скачанного из сети; pinned=false — архив тега GitHub, сумма проверяется только для бандла.',
    files: {},
  }
  for (const f of files) {
    out.files[f.rel] = {
      size: statSync(f.full).size,
      sha256: sha256(f.full),
      kind: kindOf(f.rel),
      pinned: isPinned(f.rel),
    }
  }
  writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n', 'utf8')
  const pinned = Object.values(out.files).filter((v) => v.pinned).length
  console.log(`[cache] написано ${OUT}: файлов ${Object.keys(out.files).length}, с проверкой по сети (pinned) ${pinned}`)
}

main()
