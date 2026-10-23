/**
 * Генерация иконок приложения из public/logo.svg (правка 561).
 *
 *   node scripts/make-icons.mjs
 *
 * Создаёт:
 *   electron/icons/icon-16/24/32/48/64/128/256/512.png  — PNG-набор
 *   electron/icons/icon.ico                              — Windows ICO
 *     (контейнер с PNG-записями: 16–256 px, валиден с Vista)
 *   public/icon-192.png / icon-512.png                   — для PWA-манифеста
 *
 * Запускается вручную/одноразово; артефакты коммитятся. sharp уже в
 * зависимостях проекта (Next.js image).
 */
import sharp from 'sharp'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'public', 'logo.svg')
const OUT = join(ROOT, 'electron', 'icons')
mkdirSync(OUT, { recursive: true })

const SIZES = [16, 24, 32, 48, 64, 128, 256, 512]

/**
 * SVG → PNG заданного размера.
 *
 * (правка 716) Размер результата ПРОВЕРЯЕТСЯ. Формула density опирается на
 * viewBox 64px и работает ТОЛЬКО если у SVG нет явных width/height: sharp
 * для SVG с заданными width/height игнорирует density, и resize() всё равно
 * «успешно» отдаёт картинку другого размера — без единой ошибки.
 */
async function renderPng(size) {
  const density = Math.round((72 * size) / 64) // viewBox 64px при 72dpi
  const buf = await sharp(SRC, { density }).resize(size, size).png().toBuffer()
  const meta = await sharp(buf).metadata()
  if (meta.width !== size || meta.height !== size) {
    throw new Error(
      `icon-${size}: получен размер ${meta.width}x${meta.height}, ожидалось ${size}x${size}. ` +
      'Проверьте, что у public/logo.svg нет явных width/height (нужен только viewBox).',
    )
  }
  return buf
}

const pngs = new Map()
for (const s of SIZES) {
  const buf = await renderPng(s)
  pngs.set(s, buf)
  writeFileSync(join(OUT, `icon-${s}.png`), buf)
  console.log(`[icons] icon-${s}.png (${buf.length} B)`)
}

// PWA-иконки в public/ (192/512 — стандарт манифеста)
// (правка 587) 192 сначала РЕНДЕРИМСЯ, потом пишется: раньше первой записью
// летел 128-пиксельный буфер (pngs.get(128)), и если renderPng(192) падал,
// public/icon-192.png молча оставался с неправильным размером.
{
  const buf192 = await renderPng(192)
  pngs.set(192, buf192)
  writeFileSync(join(ROOT, 'public', 'icon-192.png'), buf192)
  writeFileSync(join(OUT, 'icon-192.png'), buf192)
  console.log('[icons] public/icon-192.png')
  writeFileSync(join(ROOT, 'public', 'icon-512.png'), pngs.get(512))
  console.log('[icons] public/icon-512.png')
}

/* ── ICO-контейнер с PNG-записями ──
 * ICONDIR:  reserved(2)=0, type(2)=1 (icon), count(2)=N
 * ICONDIRENTRY (16 B): width(1), height(1)  (0 = 256), colors(1)=0,
 *  reserved(1)=0, planes(2)=1, bpp(2)=32, size(4), offset(4)
 * Затем подряд PNG-блобы. Windows читает PNG в ICO с Vista. */
const icoSizes = [16, 24, 32, 48, 64, 128, 256]
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(icoSizes.length, 4)

let offset = 6 + icoSizes.length * 16
const entries = []
const blobs = []
for (const s of icoSizes) {
  const png = pngs.get(s)
  const e = Buffer.alloc(16)
  e.writeUInt8(s === 256 ? 0 : s, 0)
  e.writeUInt8(s === 256 ? 0 : s, 1)
  e.writeUInt8(0, 2)
  e.writeUInt8(0, 3)
  e.writeUInt16LE(1, 4)
  e.writeUInt16LE(32, 6)
  e.writeUInt32LE(png.length, 8)
  e.writeUInt32LE(offset, 12)
  offset += png.length
  entries.push(e)
  blobs.push(png)
}
writeFileSync(join(OUT, 'icon.ico'), Buffer.concat([header, ...entries, ...blobs]))
console.log(`[icons] icon.ico (${icoSizes.join('/')} px, PNG-in-ICO)`)
