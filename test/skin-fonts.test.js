'use strict';
const assert = require('node:assert/strict');
const skinFonts = require('../desktop/skin-fonts');

const created = [];
class FontFace {
  constructor(family, source, options) {
    Object.assign(this, { family, source, options, loaded: Promise.resolve() });
    created.push(this);
  }
  load() { throw new Error('Do not eagerly load every font'); }
}
const fonts = new Set();
const controller = skinFonts.create({ fonts, FontFace });
for (const theme of ['glass', 'portrait', 'mecha', 'comic', 'win95', 'el', 'tui', 'outline']) {
  controller.sync(theme, skinFonts.family);
}
assert.equal(created.length, 0, 'retained and new non-manga skins must not allocate the handwritten font');
controller.sync('manga', 'Microsoft YaHei UI');
assert.equal(created.length, 0, 'a custom manga font must not load an unused bundled font');
controller.sync('manga', skinFonts.family);
controller.sync('manga', skinFonts.family);
assert.equal(created.length, 1, 'message updates and shape changes reuse the registered face');
assert.equal(fonts.size, 1);
assert.equal(created[0].family, 'ZCOOL KuaiLe');
assert.match(created[0].source, /^url\("\/desktop\/fonts\//);
assert.deepEqual(created[0].options, { weight: '400', style: 'normal', display: 'swap' });
controller.sync('win95', skinFonts.family);
assert.equal(fonts.size, 0, 'switching away releases the document font registration');
controller.sync('manga', skinFonts.family);
assert.equal(fonts.size, 1);
controller.clear();
controller.clear();
assert.equal(fonts.size, 0, 'pagehide/disposal safely release the font');
const unsupported = skinFonts.create({ fonts, FontFace: undefined });
assert.doesNotThrow(() => unsupported.sync('manga', skinFonts.family));
assert.equal(fonts.size, 0);
console.log('PASS handwriting font stays lazy, local, single-face and scoped to its selected skin');
