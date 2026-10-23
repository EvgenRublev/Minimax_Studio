#!/usr/bin/env node
/**
 * scripts/launch-electron.mjs — запуск окна студии.
 *
 * ЗАЧЕМ НЕ `electron electron/main.js`. Обычный запуск идёт через
 * node_modules/electron/cli.js, а тот поднимает `dist/electron.exe` — в
 * диспетчере задач процесс называется «electron.exe», и пользователь не
 * может отличить студию от любого другого Electron-приложения.
 *
 * Здесь запускается переименованная копия (scripts/prepare-electron.mjs):
 * `dist/MinimaxH3Studio.exe` — в диспетчере видно «MinimaxH3Studio».
 *
 * ПОЧЕМУ НЕ НАПРЯМУЮ ИЗ .BAT. electron.exe собран как GUI-приложение
 * (PE subsystem 2), поэтому его stdout не попадает в консоль bat-окна.
 * cli.js работал как прослойка: он сам жил в консоли и запускал Electron с
 * stdio:'inherit'. Этот скрипт делает ровно то же, но для переименованного
 * бинарника — вывод остаётся виден в консоли и в панели «Консоль» внутри
 * приложения.
 *
 * ЗАПАСНОЙ ПУТЬ. Если переименованной копии нет (или prepare не отработал) —
 * запускается штатный electron.exe, приложение работает как раньше.
 *
 * Использование:
 *   node scripts/launch-electron.mjs electron/main.js
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');

const RENAMED = path.join(DIST, 'MinimaxH3Studio.exe');
const STOCK = path.join(DIST, 'electron.exe');

const exe = existsSync(RENAMED) ? RENAMED : STOCK;
if (!existsSync(exe)) {
  console.error('[launch] electron не найден в node_modules/electron/dist — ' +
    'выполните `npm install`.');
  process.exit(1);
}
console.log(`[launch] ${path.basename(exe)} ${process.argv.slice(2).join(' ')}`);

const child = spawn(exe, process.argv.slice(2), {
  stdio: 'inherit',
  windowsHide: false,
  cwd: ROOT,
});

let childClosed = false;
child.on('close', (code, signal) => {
  childClosed = true;
  if (code === null) {
    console.error('[launch] завершён по сигналу', signal);
    process.exit(1);
  }
  process.exit(code);
});

for (const sig of ['SIGINT', 'SIGTERM', 'SIGUSR2']) {
  process.on(sig, () => {
    if (!childClosed) child.kill(sig);
  });
}
