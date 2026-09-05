'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const sourcePath = process.argv[2];
const outputPath = process.argv[3];
const gridSize = Number(process.argv[4] || 12);
if (!sourcePath || !outputPath) {
  throw new Error('usage: node scripts/build-pixel-font.js <source.bdf> <output.fpb.gz> [grid-size]');
}
if (!Number.isInteger(gridSize) || gridSize < 8 || gridSize > 16) throw new Error('grid-size must be an integer from 8 to 16');

const lines = fs.readFileSync(sourcePath, 'utf8').split(/\r?\n/);
let fontAscent = gridSize - 2;
const glyphs = [];

for (const line of lines) {
  if (line.startsWith('FONT_ASCENT ')) fontAscent = Number(line.slice(12)) || 10;
}

for (let index = 0; index < lines.length; index += 1) {
  if (!lines[index].startsWith('STARTCHAR ')) continue;
  let encoding = -1;
  let advance = gridSize;
  let box = [0, 0, 0, 0];
  const bitmap = [];
  for (index += 1; index < lines.length && lines[index] !== 'ENDCHAR'; index += 1) {
    const line = lines[index];
    if (line.startsWith('ENCODING ')) encoding = Number(line.slice(9));
    else if (line.startsWith('DWIDTH ')) advance = Number(line.split(/\s+/)[1]) || gridSize;
    else if (line.startsWith('BBX ')) box = line.split(/\s+/).slice(1).map(Number);
    else if (line.trim() === 'BITMAP') {
      for (index += 1; index < lines.length && lines[index] !== 'ENDCHAR'; index += 1) bitmap.push(lines[index]);
      break;
    }
  }
  if (encoding < 0 || encoding > 0x10ffff) continue;

  const [width, height, offsetX, offsetY] = box;
  const normalizedRows = new Uint16Array(gridSize);
  const sourceBits = Math.ceil(width / 8) * 8;
  const targetStartY = fontAscent - (offsetY + height);
  for (let row = 0; row < Math.min(height, bitmap.length); row += 1) {
    const targetY = targetStartY + row;
    if (targetY < 0 || targetY >= gridSize) continue;
    const value = BigInt('0x' + (bitmap[row] || '0'));
    for (let column = 0; column < width; column += 1) {
      const targetX = offsetX + column;
      if (targetX < 0 || targetX >= gridSize) continue;
      const sourceMask = 1n << BigInt(sourceBits - 1 - column);
      if ((value & sourceMask) !== 0n) normalizedRows[targetY] |= 1 << (gridSize - 1 - targetX);
    }
  }
  glyphs.push({ encoding, advance: Math.max(1, Math.min(gridSize, advance)), rows: normalizedRows });
}

glyphs.sort((a, b) => a.encoding - b.encoding);
const recordSize = 5 + gridSize * 2;
const headerSize = 12;
const raw = Buffer.allocUnsafe(headerSize + glyphs.length * recordSize);
raw.write('FPB2', 0, 'ascii');
raw.writeUInt8(gridSize, 4);
raw.fill(0, 5, 8);
raw.writeUInt32LE(glyphs.length, 8);
glyphs.forEach((glyph, index) => {
  const offset = headerSize + index * recordSize;
  raw.writeUInt32LE(glyph.encoding, offset);
  raw.writeUInt8(glyph.advance, offset + 4);
  for (let row = 0; row < gridSize; row += 1) raw.writeUInt16LE(glyph.rows[row], offset + 5 + row * 2);
});

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, zlib.gzipSync(raw, { level: 9 }));
console.log(JSON.stringify({ glyphs: glyphs.length, gridSize, rawBytes: raw.length, gzipBytes: fs.statSync(outputPath).size }));
