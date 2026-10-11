'use strict';

const assert = require('assert');
require('../js/avatars.js');

const avatars = globalThis.DanmuAvatars;

assert.strictEqual(avatars.normalizeUrl('//i0.hdslb.com/a.jpg'), 'https://i0.hdslb.com/a.jpg');
assert.strictEqual(avatars.normalizeUrl('http://i1.hdslb.com/b.jpg'), 'https://i1.hdslb.com/b.jpg');
assert.strictEqual(avatars.normalizeUrl('javascript:alert(1)'), '');
assert.strictEqual(avatars.normalizeUrl({ url: { toString() { throw new Error('must not coerce'); } } }), '');
assert.strictEqual(avatars.normalizeUrl('https://i0.hdslb.com/' + 'a'.repeat(2048)), '');
assert.strictEqual(avatars.extractDanmakuAvatar({ extra: '{' + ' '.repeat(70000) }, []), '');

const info = [[]];
info[0][15] = JSON.stringify({ user: { base: { face: '//i0.hdslb.com/danmaku.jpg' } } });
assert.strictEqual(
  avatars.extractDanmakuAvatar({ cmd: 'DANMU_MSG', info }, info),
  'https://i0.hdslb.com/danmaku.jpg'
);

assert.strictEqual(
  avatars.extractEventAvatar({ data: { sender_uinfo: { base: { face: 'https://i1.hdslb.com/gift.jpg' } } } }),
  'https://i1.hdslb.com/gift.jpg'
);

assert.strictEqual(
  avatars.extractEventAvatar({ data: { user_info: { face: '//i2.hdslb.com/sc.jpg' } } }),
  'https://i2.hdslb.com/sc.jpg'
);

console.log('avatars tests passed');
