// Чтение и сборка ресурса версии PE (VS_VERSIONINFO).
//
// Зачем: у Electron в ресурсе версии написано «Electron / GitHub, Inc.» —
// в свойствах файла и в колонке «Имя продукта» диспетчера задач. Для студии
// это выглядит как чужое приложение.
//
// Секреты формата, из-за которых это неочевидно:
//   • выравнивание — по АБСОЛУТНОМУ смещению (6 байт заголовка + ключ),
//     а не по длине ключа. Иначе VS_FIXEDFILEINFO сдвигается на 2 байта
//     и Windows не читает ресурс вовсе (в свойствах — пусто);
//   • ключ таблицы строк — ШЕСТНАДЦАТЕРИЧНЫЙ: «040904B0» (en-US, Unicode),
//     а не десятичный;
//   • в VarFileInfo\Translation DWORD устроен как MAKELANGUAGE: кодовая
//     страница в младшем слове, язык в старшем (0x04B00409). Без этого
//     блока строки не привязаны к языку, и GetFileVersionInfo вернёт пустоту.
import fs from 'node:fs';

export function readPeResourceInfo(exePath) {
  const buf = fs.readFileSync(exePath);
  if (buf.readUInt16LE(0) !== 0x5a4d) throw new Error('не PE-файл');
  const peOff = buf.readUInt32LE(0x3c);
  if (buf.readUInt32LE(peOff) !== 0x00004550) throw new Error('нет сигнатуры PE');

  const coff = peOff + 4;
  const numSections = buf.readUInt16LE(coff + 2);
  const optSize = buf.readUInt16LE(coff + 16);
  const opt = coff + 20;
  const magic = buf.readUInt16LE(opt);
  const dataDirOff = opt + (magic === 0x20b ? 112 : 96);
  const rsrcRva = buf.readUInt32LE(dataDirOff + 2 * 8);

  const secOff = opt + optSize;
  const sections = [];
  for (let i = 0; i < numSections; i++) {
    const s = secOff + i * 40;
    sections.push({
      vaddr: buf.readUInt32LE(s + 12),
      vsize: buf.readUInt32LE(s + 8),
      rawSize: buf.readUInt32LE(s + 16),
      rawPtr: buf.readUInt32LE(s + 20),
    });
  }
  const rvaToOff = (rva) => {
    for (const s of sections) {
      if (rva >= s.vaddr && rva < s.vaddr + Math.max(s.vsize, s.rawSize)) {
        return s.rawPtr + (rva - s.vaddr);
      }
    }
    return -1;
  };

  const base = rvaToOff(rsrcRva);
  if (base < 0) throw new Error('раздел ресурсов не найден');

  // Уровни: type(0) → name(1) → lang(2); лист — запись данных.
  const walk = (dirOff, path, out) => {
    const nNamed = buf.readUInt16LE(dirOff + 12);
    const nId = buf.readUInt16LE(dirOff + 14);
    for (let i = 0; i < nNamed + nId; i++) {
      const e = dirOff + 16 + i * 8;
      const nameId = buf.readUInt32LE(e);
      const off = buf.readUInt32LE(e + 4);
      const isDir = (off & 0x80000000) !== 0;
      const childOff = base + (off & 0x7fffffff);
      const nextPath = [...path, { nameId, isName: (nameId & 0x80000000) !== 0 }];
      if (isDir) walk(childOff, nextPath, out);
      else {
        out.push({
          path: nextPath,
          dataRva: buf.readUInt32LE(childOff),
          dataSize: buf.readUInt32LE(childOff + 4),
          dataOff: rvaToOff(buf.readUInt32LE(childOff)),
        });
      }
    }
  };
  const leaves = [];
  walk(base, [], leaves);

  const versionLeaf = leaves.find((l) => l.path.length >= 3 && l.path[0].nameId === 16);
  if (!versionLeaf) {
    throw new Error(
      'RT_VERSION не найден (типы в файле: ' +
        [...new Set(leaves.map((l) => l.path[0]?.nameId))].join(', ') + ')',
    );
  }
  return {
    leaves,
    version: {
      typeId: versionLeaf.path[0].nameId,
      nameId: versionLeaf.path[1]?.nameId ?? 1,
      langId: versionLeaf.path[2]?.nameId ?? 0,
      dataOff: versionLeaf.dataOff,
      dataSize: versionLeaf.dataSize,
    },
  };
}

// ── Сборка VS_VERSIONINFO ────────────────────────────────────────────────

/** Отступ до 4-байтовой границы ПО ТЕКУЩЕМУ смещению. */
function align4(offset) {
  return (4 - (offset % 4)) % 4;
}

function utf16z(s) {
  const out = Buffer.alloc(s.length * 2 + 2);
  for (let i = 0; i < s.length; i++) out.writeUInt16LE(s.charCodeAt(i), i * 2);
  return out;
}

/** Заголовок блока: wLength, wValueLength, wType. */
function blockHeader(valueLength, type) {
  const h = Buffer.alloc(6);
  h.writeUInt16LE(0, 0); // wLength — проставим после сборки
  h.writeUInt16LE(valueLength, 2);
  h.writeUInt16LE(type, 4);
  return h;
}

/**
 * Строка таблицы: wLength, wValueLength (в WORD'ах), wType=1,
 * szKey, выравнивание, szValue, выравнивание.
 */
function stringEntry(key, value) {
  const k = utf16z(key);
  const v = utf16z(value);
  const head = blockHeader(value.length + 1, 1);
  let off = 6;
  const padK = align4(off + k.length);
  off += k.length + padK;
  const padV = align4(off + v.length);
  const total = off + v.length + padV;
  const buf = Buffer.alloc(total);
  let o = 0;
  head.copy(buf, o); o += 6;
  k.copy(buf, o); o += k.length;
  o += padK;
  v.copy(buf, o);
  buf.writeUInt16LE(total, 0);
  return buf;
}

/**
 * Блок с ключом и потомками: header(6), szKey, выравнивание, children.
 * ВНИМАНИЕ: выравнивание считается от смещения 6 (после заголовка),
 * а не от длины ключа.
 */
function blockWithKey(key, type, children, valueLength = 0) {
  const k = utf16z(key);
  const head = blockHeader(valueLength, type);
  let off = 6;
  const pad = align4(off + k.length);
  off += k.length + pad;
  const total = off + children.length;
  const buf = Buffer.alloc(total);
  let o = 0;
  head.copy(buf, o); o += 6;
  k.copy(buf, o); o += k.length;
  o += pad;
  children.copy(buf, o);
  buf.writeUInt16LE(total, 0);
  return buf;
}

/**
 * Собирает VS_VERSIONINFO.
 * strings: [['ProductName', 'Minimax H3 Studio'], ...]
 * langId/codePage — язык и кодовая страница строк (0x0409 / 0x04B0).
 */
export function buildVersionInfo(strings, fileVer, productVer, langId = 0x0409, codePage = 0x04b0) {
  // StringTable: ключ = «040904B0» (язык + кодовая страница, hex).
  const tableKey =
    langId.toString(16).padStart(4, '0').toUpperCase() +
    codePage.toString(16).padStart(4, '0').toUpperCase();
  const stringTable = blockWithKey(
    tableKey,
    1,
    Buffer.concat(strings.map(([k, v]) => stringEntry(k, v))),
  );

  // StringFileInfo → StringTable
  const stringFileInfo = blockWithKey('StringFileInfo', 1, stringTable);

  // VarFileInfo → Translation (wValueLength = 1 DWORD, wType = binary).
  const translation = (() => {
    const k = utf16z('Translation');
    const head = blockHeader(1, 0);
    let off = 6;
    const pad = align4(off + k.length);
    off += k.length + pad;
    const total = off + 4;
    const buf = Buffer.alloc(total);
    let o = 0;
    head.copy(buf, o); o += 6;
    k.copy(buf, o); o += k.length;
    o += pad;
    // MAKELANGUAGE: кодовая страница в младшем слове, язык в старшем.
    buf.writeUInt16LE(codePage, o);
    buf.writeUInt16LE(langId, o + 2);
    buf.writeUInt16LE(total, 0);
    return buf;
  })();
  const varFileInfo = blockWithKey('VarFileInfo', 1, translation);

  // VS_FIXEDFILEINFO (52 байта)
  const ffi = Buffer.alloc(52);
  const ms = (v) => (v >>> 16) & 0xffff;
  const ls = (v) => v & 0xffff;
  ffi.writeUInt32LE(0xfeef04bd, 0);
  ffi.writeUInt32LE(0x00010000, 4);
  ffi.writeUInt32LE((ms(fileVer) << 16) | ls(fileVer), 8);
  ffi.writeUInt32LE((ms(productVer) << 16) | ls(productVer), 12);
  ffi.writeUInt32LE((ms(productVer) << 16) | ls(productVer), 16);
  ffi.writeUInt32LE((ms(productVer) << 16) | ls(productVer), 20);
  ffi.writeUInt32LE(0x0000003f, 24);
  ffi.writeUInt32LE(0x00000000, 28);
  ffi.writeUInt32LE(0x00040004, 32);
  ffi.writeUInt32LE(0x00000001, 36);
  ffi.writeUInt32LE(0x00000000, 40);
  ffi.writeUInt32LE(0, 44);
  ffi.writeUInt32LE(0, 48);

  // Корень VS_VERSIONINFO
  const rootKey = utf16z('VS_VERSION_INFO');
  const rootHead = blockHeader(52, 0);
  let off = 6;
  const rootPad = align4(off + rootKey.length);
  off += rootKey.length + rootPad;
  const ffiPad = align4(off + ffi.length);
  off += ffi.length + ffiPad;
  const children = Buffer.concat([stringFileInfo, varFileInfo]);
  const total = off + children.length;
  const root = Buffer.alloc(total);
  let o = 0;
  rootHead.copy(root, o); o += 6;
  rootKey.copy(root, o); o += rootKey.length;
  o += rootPad;
  ffi.copy(root, o); o += ffi.length;
  o += ffiPad;
  children.copy(root, o);
  root.writeUInt16LE(total, 0);
  return root;
}
