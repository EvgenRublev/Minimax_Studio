#!/usr/bin/env node
/**
 * scripts/clean.mjs — очистка артефактов сборки и мусора.
 *
 * Что удаляет:
 *   .next/                — production build (собирается заново)
 *   .next/dev/            — dev-сервер
 *   tsconfig.tsbuildinfo  — инкрементальный кэш TypeScript
 *   __pycache__/          — байт-код Python (в upscale/, tools/)
 *   *.log                 — логи запуска (comfyui_startup.log, start_*.log)
 *   _nul                 — ловушка Git Bash: `2>nul` в bash создаёт файл
 *                          с зарезервированным именем Windows (см. .gitignore)
 *
 * Что НЕ трогает:
 *   node_modules/, ComfyUI-Easy-Install/, data/, .env, config/config.ini
 *
 * Использование:
 *   node scripts/clean.mjs          — очистить
 *   node scripts/clean.mjs --dry    — только показать, что будет удалено
 */
import { readdirSync, statSync, existsSync, rmSync } from 'node:fs';
import { join, relative, basename } from 'node:path';

const ROOT = process.cwd();
const DRY = process.argv.includes('--dry');

/** Файлы/папки верхнего уровня, которые всегда удаляются. */
const TOP_LEVEL = [
  '.next',
  'tsconfig.tsbuildinfo',
  '_nul',
  'comfyui_startup.log',
  'start_error.log',
  'start_debug.log',
];

/**
 * Папки с нашим собственным Python-кодом, где чистим кэш.
 * ВАЖНО: `upscale/bin/` — это вендорный embedded Python (site-packages);
 * его `__pycache__` трогать не нужно, он не наш код.
 */
const PYCACHE_ROOTS = ['upscale', 'tools'];

/** Каталоги, которые не обходим рекурсивно (вендорные рантаймы). */
const PYCACHE_SKIP = ['node_modules', '.next', 'bin', 'site-packages', 'Lib'];

/** Расширения логов в корне. */
const LOG_EXT = '.log';

const removed = [];
const freedBytes = [];

function sizeOf(p) {
  try {
    const st = statSync(p);
    if (st.isFile()) return st.size;
    let total = 0;
    for (const e of readdirSync(p, { withFileTypes: true })) {
      total += sizeOf(join(p, e.name));
    }
    return total;
  } catch {
    return 0;
  }
}

function drop(target, label) {
  if (!existsSync(target)) return;
  const size = sizeOf(target);
  removed.push(label);
  freedBytes.push(size);
  if (!DRY) {
    rmSync(target, { recursive: true, force: true });
  }
}

/** Рекурсивно ищем __pycache__ в указанных корнях. */
function findPycache(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (!entry.isDirectory()) continue;
    if (entry.name === '__pycache__') {
      drop(full, relative(ROOT, full));
    } else if (!PYCACHE_SKIP.includes(entry.name)) {
      findPycache(full);
    }
  }
}

console.log(`[clean] корень: ${ROOT}${DRY ? '  (--dry: ничего не удаляем)' : ''}`);

// 1. Точечные цели в корне.
for (const name of TOP_LEVEL) drop(join(ROOT, name), name);

// 2. Все *.log в корне (кроме тех, что уже удалены выше).
for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.toLowerCase().endsWith(LOG_EXT)) {
    drop(join(ROOT, entry.name), entry.name);
  }
}

// 3. Кэш Python.
for (const r of PYCACHE_ROOTS) findPycache(join(ROOT, r));

// 4. Рабочие артефакты DLSS-моста: отчёты о прошлых рендерах и файлы job'ов.
//    Сами папки оставляем — bridge.py ждёт, что они существуют.
for (const dir of ['upscale/logs', 'upscale/jobs']) {
  const full = join(ROOT, dir);
  if (!existsSync(full)) continue;
  for (const entry of readdirSync(full, { withFileTypes: true })) {
    drop(join(full, entry.name), `${dir}/${entry.name}`);
  }
}

if (removed.length === 0) {
  console.log('[clean] чисто — удалять нечего.');
} else {
  const total = freedBytes.reduce((a, b) => a + b, 0);
  for (const label of removed) console.log(`  - ${label}`);
  console.log(
    `[clean] ${DRY ? 'будет удалено' : 'удалено'}: ${removed.length} объект(ов), ` +
      `${(total / 1024 / 1024).toFixed(1)} МБ`,
  );
}
