#!/usr/bin/env node
/**
 * scripts/prepare-electron.mjs — переименование процесса Electron.
 *
 * ЗАЧЕМ. В диспетчере задач процесс окна студии называется «electron.exe» —
 * у пользователя нет способа отличить его от чужого Electron-приложения.
 * По запросу «прибить студию, если зависла» это невозможно сделать
 * правильно. Здесь exe копируется с именем приложения, и дальше запускается
 * именно он: в диспетчере видно «MinimaxH3Studio».
 *
 * ЧТО ДЕЛАЕТСЯ.
 *   1. Копия `node_modules/electron/dist/electron.exe` →
 *      `node_modules/electron/dist/MinimaxH3Studio.exe`.
 *      Имя файла образа — это ровно то, что показывает диспетчер задач.
 *      Копия, а не перемещение: штатный `node_modules/electron` остаётся
 *      нетронутым, `require('electron')` и `npm install` продолжают работать.
 *   2. В копию вписывается ресурс версии (ProductName, FileDescription,
 *      CompanyName, OriginalFilename, InternalName) — чтобы и Свойства
 *      файла, и колонка «Имя продукта» в диспетчере показывали студию,
 *      а не «Electron / GitHub, Inc.».
 *
 * ИДЕНТИЧНОСТЬ ПРИЛОЖЕНИЯ. Копия лежит в той же папке dist, поэтому Electron
 * находит свои ресурсы (resources/, icudtl.dat, DLL) как обычно — путь
 * вычисляется от расположения exe.
 *
 * ЗАПУСК. Скопию нельзя запускать напрямую из .bat: exe собран как
 * GUI-приложение (subsystem 2), stdout в консоль не попадёт. Поэтому
 * запуском занимается scripts/launch-electron.mjs — он поднимает копию с
 * stdio:'inherit' (вывод виден в консоли) и корректно завершается вместе
 * с ней.
 *
 * ПОВТОРЯЕМОСТЬ. Скрипт идемпотентен: если копия уже есть и не старше
 * оригинала, ничего не делается. Любая ошибка (например, запрет менять
 * ресурсы) НЕ Ломает запуск — переименование exe уже решает задачу,
 * поэтому ошибка вписывания ресурса лишь пишется в консоль.
 *
 * Использование:
 *   node scripts/prepare-electron.mjs
 *   node scripts/prepare-electron.mjs --force   — пересоздать копию заново
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readPeResourceInfo, buildVersionInfo } from './pe-version.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORCE = process.argv.includes('--force');

/** Имя процесса в диспетчере задач. */
const EXE_NAME = 'MinimaxH3Studio.exe';
/** Что показывать в свойствах файла и в колонке «Имя продукта». */
const APP_TITLE = 'Minimax H3 Studio';
const APP_VENDOR = 'Minimax H3 Studio';
const APP_DESC = 'MiniMax H3 Studio — локальная генерация видео со звуком';
const APP_COPYRIGHT = 'MiniMax H3 Studio';

const DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');
const SRC_EXE = path.join(DIST, 'electron.exe');
const DST_EXE = path.join(DIST, EXE_NAME);

function log(msg) {
  console.log(`[prepare-electron] ${msg}`);
}

/** Копия новее оригинала? */
function isFresh() {
  try {
    return fs.statSync(DST_EXE).mtimeMs >= fs.statSync(SRC_EXE).mtimeMs;
  } catch {
    return false;
  }
}

if (!fs.existsSync(SRC_EXE)) {
  log('electron.exe не найден — пропуск (запуск пойдёт обычным путём).');
  process.exit(0);
}

if (!FORCE && fs.existsSync(DST_EXE) && isFresh()) {
  log(`${EXE_NAME} уже актуален — пропуск.`);
  process.exit(0);
}

log(`копирую electron.exe → ${EXE_NAME} ...`);
try {
  fs.copyFileSync(SRC_EXE, DST_EXE);
} catch (e) {
  log(`НЕ УДАЛОСЬ скопировать: ${e.message}`);
  log('приложение запустится обычным путём (имя процесса будет electron).');
  process.exit(0);
}

// ── Ресурс версии ─────────────────────────────────────────────────────────
// Не критично: без него копия всё равно называется MinimaxH3Studio.exe.
try {
  const info = readPeResourceInfo(DST_EXE);
  const langId = info.version.langId;
  const nameId = info.version.nameId;

  // Версия приложения — из package.json, чтобы «Свойства файла» и
  // «О программе» показывали то же, что и сам релиз.
  let fileVer = 7_01_00;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const [maj, min, pat] = String(pkg.version || '7.1.0').split('.').map((n) => parseInt(n, 10) || 0);
    fileVer = ((maj & 0xffff) << 16) | ((min & 0xffff) << 8) | (pat & 0xff);
  } catch { /* версия из package.json недоступна — оставляем 7.1.0 */ }

  const vi = buildVersionInfo(
    [
      ['CompanyName', APP_VENDOR],
      ['FileDescription', APP_DESC],
      ['FileVersion', `${(fileVer >>> 16) & 0xffff}.${(fileVer >>> 8) & 0xff}.${fileVer & 0xff}`],
      ['InternalName', EXE_NAME],
      ['LegalCopyright', APP_COPYRIGHT],
      ['OriginalFilename', EXE_NAME],
      ['ProductName', APP_TITLE],
      ['ProductVersion', `${(fileVer >>> 16) & 0xffff}.${(fileVer >>> 8) & 0xff}.${fileVer & 0xff}`],
    ],
    fileVer,
    fileVer,
  );

  const tmp = path.join(ROOT, 'data', 'electron-version.bin');
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.writeFileSync(tmp, vi);
  try {
    const ps = path.join(ROOT, 'scripts', 'set-version-resource.ps1');
    const r = spawnSync(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps, '-ExePath', DST_EXE, '-ResFile', tmp, '-LangId', String(langId), '-NameId', String(nameId)],
      { stdio: 'pipe', windowsHide: true, encoding: 'utf8' },
    );
    if (r.status === 0) {
      log('ресурс версии вписан (ProductName / FileDescription / OriginalFilename).');
    } else {
      log(`ресурс версии не вписан: ${(r.stderr || r.stdout || '').trim().split('\n').pop()}`);
      log('(на имя процесса в диспетчере это не влияет)');
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* нечего удалять */ }
  }
} catch (e) {
  log(`ресурс версии не вписан: ${e.message}`);
  log('(на имя процесса в диспетчере это не влияет)');
}

log(`готово: ${path.relative(ROOT, DST_EXE)}`);
