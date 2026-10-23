#!/usr/bin/env node
/**
 * scripts/prune-build.mjs — ужатие production-сборки перед релизом.
 *
 * Что делает:
 *   1. Удаляет `.next/cache/` (≈300 МБ) — это кэш webpack для УСКОРЕНИЯ
 *      пересборок. На работу приложения не влияет.
 *   2. Обрезает `.next/server` — манифесты `.nft.json` (≈530 МБ): это
 *      списки файлов, которые Next считает нужными для standalone-деплоя
 *      (output-file-tracing). Каждый перечисляет ~87 000 файлов деревьев
 *      ComfyUI / embedded-Python, к которым приложение обращается по
 *      АБСОЛЮТНОМУ пути в рантайме, а не через require().
 *
 * Почему не `outputFileTracingExcludes` в next.config.ts:
 * Next склеивает паттерн с корнем проекта через `path.join`, а на Windows
 * это даёт обратные слэши — picomatch считает обратный слэш экранирующим
 * символом, и ни один паттерн не совпадает. Проверено на Next 16.1.1:
 *   path.join(dir, GLOB) даёт 'E:\\proj\\**\\ComfyUI-Easy-Install\\**'
 *   и такой шаблон НЕ совпадает с абсолютным путём, тогда как сырой
 *   шаблон с прямыми слэшами совпадает. Поэтому обрезаем манифесты
 *   после сборки — предсказуемо на любой платформе.
 *
 * Безопасность: манифесты .nft.json читаются только при standalone-сборке
 * (output: 'standalone') и при деплое. Здесь приложение запускается как
 * `next()` из node_modules (server.js) — манифесты в рантайме не нужны.
 *
 * Использование:
 *   node scripts/prune-build.mjs
 *   node scripts/prune-build.mjs --dry
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const DRY = process.argv.includes('--dry');

/**
 * Куски путей, которые не нужны приложению в рантайме.
 * Сравнение — по нормализованному пути (без обратных слэшей).
 */
const EXCLUDE_SEGMENTS = [
  'ComfyUI-Easy-Install',
  'upscale\\bin',
  'upscale/bin',
  'Bonsai_2_27B',
  '.local-input',
];

/** Файлы, которые нужно оставить в манифесте всегда. */
const KEEP_SUFFIXES = ['node_modules/next/dist/compiled'];

function normalize(p) {
  return p.split(sep).join('/').split('\\').join('/');
}

/** Нужно ли исключить этот путь из манифеста? */
function isExcluded(filePath) {
  const p = normalize(filePath);
  for (const seg of EXCLUDE_SEGMENTS) {
    const s = normalize(seg);
    if (p === s || p.includes('/' + s + '/') || p.startsWith(s + '/')) return true;
  }
  return false;
}

function dirSize(dir) {
  try {
    let total = 0;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      total += e.isDirectory() ? dirSize(p) : statSync(p).size;
    }
    return total;
  } catch {
    return 0;
  }
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// ── 1. Кэш сборки ─────────────────────────────────────────────────────────
const cacheDir = join(ROOT, '.next', 'cache');
if (existsSync(cacheDir)) {
  const size = dirSize(cacheDir);
  console.log(`[prune] .next/cache            ${(size / 1024 / 1024).toFixed(0)} МБ — удаляю (кэш пересборки)`);
  if (!DRY) rmSync(cacheDir, { recursive: true, force: true });
}

// ── 2. Манифесты .nft.json ────────────────────────────────────────────────
const serverDir = join(ROOT, '.next', 'server');
const manifests = walk(serverDir).filter((f) => f.endsWith('.nft.json'));

let before = 0;
let after = 0;
let trimmed = 0;

for (const file of manifests) {
  const size = statSync(file).size;
  before += size;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    continue;
  }
  if (!Array.isArray(parsed.files)) continue;
  const kept = parsed.files.filter((f) => !isExcluded(f) || KEEP_SUFFIXES.some((s) => normalize(f).includes(s)));
  if (kept.length === parsed.files.length) {
    after += size;
    continue;
  }
  const removed = parsed.files.length - kept.length;
  trimmed += removed;
  parsed.files = kept;
  const out = JSON.stringify(parsed);
  after += Buffer.byteLength(out);
  if (!DRY) writeFileSync(file, out);
}

console.log(
  `[prune] .nft.json (${manifests.length} шт.)  ` +
    `${(before / 1024 / 1024).toFixed(0)} МБ → ${(after / 1024 / 1024).toFixed(1)} МБ` +
    (trimmed ? `  (исключено записей: ${trimmed.toLocaleString('ru-RU')})` : ''),
);

const total = dirSize(join(ROOT, '.next'));
console.log(`[prune] итоговый размер .next:  ${(total / 1024 / 1024).toFixed(1)} МБ${DRY ? '  (--dry: ничего не удалено)' : ''}`);
