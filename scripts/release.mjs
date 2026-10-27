#!/usr/bin/env node
/**
 * scripts/release.mjs — подготовка портативной сборки к релизу.
 *
 * Последовательность:
 *   1. clean       — убрать артефакты прошлой сборки и мусор
 *   2. typecheck   — tsc --noEmit (strict + noUnusedLocals/Parameters)
 *   3. build       — next build --webpack через scripts/build.mjs (хип 8 ГБ)
 *   4. verify      — проверить, что артефакты на месте и проект «чист»
 *
 * Шаг 4 — самый ценный: он ловит ровно те проблемы, из-за которых
 * релиз «не запускается у пользователя»:
 *   • .next/ не собран или собран частично;
 *   • в корне остались логи / мусорные файлы;
 *   • пропал node_modules (без него start.bat не поднимет приложение);
 *   • нет .env (без него ComfyUI-бэкенд не найдёт);
 *   • не хватает electron/ (start.bat уйдёт в браузерный режим);
 *   • нет public/splash-videos/ (заставка останется чёрной).
 *
 * Использование:
 *   node scripts/release.mjs            — полный цикл
 *   node scripts/release.mjs --verify   — только проверка (без сборки)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const VERIFY_ONLY = process.argv.includes('--verify');

let failed = false;

function run(label, cmd, args) {
  console.log(`\n[release] === ${label} ===`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) {
    console.error(`[release] ПРОВАЛ: ${label}`);
    failed = true;
    return false;
  }
  return true;
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

// ── 1. Очистка ────────────────────────────────────────────────────────────
if (!VERIFY_ONLY) {
  if (!run('clean', process.execPath, ['scripts/clean.mjs'])) process.exit(1);

  // ── 2. Проверка типов ───────────────────────────────────────────────────
  if (!run('typecheck', process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit'])) process.exit(1);

  // ── 3. Сборка ──────────────────────────────────────────────────────────
  if (!run('build', process.execPath, ['scripts/build.mjs'])) process.exit(1);

  // ── 3b. Ужатие сборки ──────────────────────────────────────────────────
  // .next/cache (кэш пересборки, ~300 МБ) и манифесты .nft.json (~530 МБ)
  // в рантайме не нужны: server.js запускает next() из node_modules.
  if (!run('prune build', process.execPath, ['scripts/prune-build.mjs'])) process.exit(1);

  // ── 3c. Имя процесса ───────────────────────────────────────────────────
  // Копия electron.exe с именем MinimaxH3Studio.exe — чтобы в диспетчере
  // задач процесс студии не выглядел как «electron».
  run('prepare electron', process.execPath, ['scripts/prepare-electron.mjs']);
}

// ── 4. Проверка артефактов ───────────────────────────────────────────────
console.log(`\n[release] === verify ===`);

const checks = [];
const check = (ok, label, hint) => checks.push({ ok, label, hint });

// Сборка.
const buildId = join(ROOT, '.next', 'BUILD_ID');
check(existsSync(buildId), 'production build (.next/BUILD_ID)', 'запустите `npm run build`');
check(existsSync(join(ROOT, '.next', 'server')), 'серверный бандл (.next/server)');
check(existsSync(join(ROOT, '.next', 'static')), 'клиентские ассеты (.next/static)');

// Рантайм.
check(existsSync(join(ROOT, 'node_modules')), 'node_modules (npm-зависимости)', 'запустите `npm install`');
check(
  existsSync(join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')),
  'Electron (окно приложения)',
  'скопируйте node_modules целиком с исходного ПК',
);
check(
  existsSync(join(ROOT, 'node_modules', 'electron', 'dist', 'MinimaxH3Studio.exe')),
  'переименованный MinimaxH3Studio.exe (имя в диспетчере задач)',
  'выполните `node scripts/prepare-electron.mjs`',
);
check(existsSync(join(ROOT, 'electron', 'main.js')), 'electron/main.js');
check(existsSync(join(ROOT, 'electron', 'preload.js')), 'electron/preload.js');

// Точка входа.
check(existsSync(join(ROOT, 'start.bat')), 'start.bat (точка входа)');
check(existsSync(join(ROOT, 'start_hidden.vbs')), 'start_hidden.vbs');
check(existsSync(join(ROOT, 'server.js')), 'server.js');
check(existsSync(join(ROOT, '.env')), '.env (COMFY_URL)', 'скопируйте .env из исходного ПК');

// Ресурсы.
check(existsSync(join(ROOT, 'public', 'splash-videos')), 'public/splash-videos (видео-заставка)');
check(existsSync(join(ROOT, 'public', 'logo.svg')), 'public/logo.svg');
check(existsSync(join(ROOT, 'config', 'config.ini')), 'config/config.ini');
// (правка 740) GPL-3.0 требует передавать лицензию вместе с программой.
check(existsSync(join(ROOT, 'LICENSE')), 'LICENSE (GPL-3.0)');

// Мусор в корне.
const junk = [];
for (const e of readdirSync(ROOT, { withFileTypes: true })) {
  if (e.isFile() && (e.name.toLowerCase().endsWith('.log') || e.name === '_nul' || e.name.endsWith('.tsbuildinfo'))) {
    junk.push(e.name);
  }
}
check(junk.length === 0, 'в корне нет логов/мусора', `удалите: ${junk.join(', ')}`);

// Итог.
console.log('');
for (const c of checks) {
  console.log(`  ${c.ok ? 'OK  ' : 'FAIL'}  ${c.label}${c.ok ? '' : `   → ${c.hint}`}`);
}

const bad = checks.filter((c) => !c.ok);
if (bad.length > 0) {
  console.error(`\n[release] ПРОВАЛ: ${bad.length} проверок не пройдено.`);
  process.exit(1);
}

// Мягкие предупреждения — не блокируют релиз, но показывают, что можно ужать.
const warnings = [];
const cacheDir = join(ROOT, '.next', 'cache');
if (existsSync(cacheDir)) {
  const cacheSize = dirSize(cacheDir);
  // Мелкий кэш (tsconfig.tsbuildinfo на ~200 КБ) — норма, он пересоздаётся
  // при каждом запуске typecheck. Предупреждаем только про тяжёлый кэш webpack.
  if (cacheSize > 10 * 1024 * 1024) {
    warnings.push(
      `в .next/cache остался кэш пересборки (${(cacheSize / 1024 / 1024).toFixed(0)} МБ) — выполните 'npm run release'`,
    );
  }
}
const nextSize = dirSize(join(ROOT, '.next'));
if (nextSize > 100 * 1024 * 1024) {
  warnings.push(`.next весит ${(nextSize / 1024 / 1024).toFixed(0)} МБ — выполните 'node scripts/prune-build.mjs'`);
}

const size = dirSize(join(ROOT, '.next'));
const buildIdValue = existsSync(buildId) ? readFileSync(buildId, 'utf-8').trim() : '?';
console.log(
  `\n[release] OK — сборка готова к релизу ` +
    `(.next: ${(size / 1024 / 1024).toFixed(1)} МБ, BUILD_ID ${buildIdValue}).`,
);
for (const w of warnings) {
  console.log(`  ВНИМАНИЕ  ${w}`);
}
