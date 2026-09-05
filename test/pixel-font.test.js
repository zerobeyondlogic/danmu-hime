'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const file = path.join(__dirname, '..', 'desktop', 'fonts', 'unifont-16px.fpb.gz');
const raw = zlib.gunzipSync(fs.readFileSync(file));
assert.strictEqual(raw.subarray(0, 4).toString('ascii'), 'FPB2');
const gridSize = raw.readUInt8(4);
const count = raw.readUInt32LE(8);
const recordSize = 5 + gridSize * 2;
assert.strictEqual(gridSize, 16);
assert.ok(count > 50000, 'expected broad Unicode and simplified Chinese glyph coverage');
assert.strictEqual(raw.length, 12 + count * recordSize);

function readGlyph(codePoint) {
  for (let index = 0; index < count; index += 1) {
    const offset = 12 + index * recordSize;
    if (raw.readUInt32LE(offset) !== codePoint) continue;
    const rows = [];
    for (let row = 0; row < gridSize; row += 1) rows.push(raw.readUInt16LE(offset + 5 + row * 2));
    return { advance: raw.readUInt8(offset + 4), rows };
  }
  return null;
}

const space = readGlyph(0x20);
assert.ok(space);
assert.strictEqual(space.advance, 8);
assert.ok(space.rows.every((row) => row === 0));

const cjk = readGlyph('像'.codePointAt(0));
assert.ok(cjk);
assert.strictEqual(cjk.advance, 16);
assert.ok(cjk.rows.filter((row) => row !== 0).length >= 12);
console.log('pixel font tests passed: ' + count + ' glyphs on ' + gridSize + 'x' + gridSize + ' grid');
