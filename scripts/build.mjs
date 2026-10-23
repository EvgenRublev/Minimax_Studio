#!/usr/bin/env node
/**
 * scripts/build.mjs — кроссплатформенная обёртка над `next build --webpack`.
 *
 * Почему: сборка этого проекта не помещается в хип Node по умолчанию
 * (~4 ГБ) и падает с `FATAL ERROR: JavaScript heap out of memory`.
 * При увеличенном хипе (8 ГБ) сборка проходит штатно (проверено).
 *
 * Как: NODE_OPTIONS читается только в момент СТАРТА node-процесса, поэтому
 * мы запускаем `next build` отдельным дочерним процессом, у которого этот
 * флаг уже задан в окружении (рабочие потоки webpack — потоки того же
 * процесса — делят с ним хип). Никаких новых зависимостей не требуется.
 *
 * Переопределить размер хипа (в МБ):
 *   NEXT_BUILD_HEAP_MB=12288 npm run build
 *
 * Вернуться к сборке без обёртки (хип по умолчанию):
 *   npm run build:default
 */
import { spawnSync } from 'node:child_process';

// (правка 716) NEXT_BUILD_HEAP_MB валидируется: 0 молча превращался в 8192,
// а отрицательное значение давало «--max-old-space-size=-1», который Node
// отвергает с невнятной ошибкой.
const heapMbRaw = Number(process.env.NEXT_BUILD_HEAP_MB);
const heapMb = Number.isInteger(heapMbRaw) && heapMbRaw >= 512 && heapMbRaw <= 65536
  ? heapMbRaw
  : 8192;
const flag = `--max-old-space-size=${heapMb}`;
// (правка 587) Не дублируем флаг, если он уже в NODE_OPTIONS (последний
// выигрывает, но дубликат путает диагностику).
// (правка 716) NODE_OPTIONS НЕ пересобирается разбиением по пробелам:
// значение с пробелом (например --require "C:\my path\preload.js") ломалось,
// и Node отказывался стартовать с «--require is not allowed in NODE_OPTIONS».
// Просто вырезаем наш флаг из исходной строки.
const rawOptions = process.env.NODE_OPTIONS || '';
const prev = rawOptions
  .split(/--max-old-space-size=\d+/)
  .join(' ')
  .replace(/\s+/g, ' ')
  .trim();
const env = { ...process.env, NODE_OPTIONS: prev ? `${prev} ${flag}` : flag };

console.log(`[build] next build --webpack  (heap = ${heapMb} MB)`);
// (правка 716) --no-install: без него npx при отсутствующем node_modules
// ПРЕДЛОЖИТ скачать next из реестра и спросит «Ok to proceed? (y)» — в
// неинтерактивном контексте сборка зависала навсегда вместо падения.
const r = spawnSync('npx', ['--no-install', 'next', 'build', '--webpack'], {
  env,
  stdio: 'inherit',
  // На Windows npx это npx.cmd — нужен shell, чтобы он резолвился.
  shell: process.platform === 'win32',
});

if (r.error) {
  console.error('[build] не удалось запустить next build:', r.error.message);
  process.exit(1);
}
if (r.signal) {
  console.error(`[build] next build прерван сигналом ${r.signal}`);
  process.exit(1);
}
process.exit(r.status == null ? 1 : r.status);
