'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { expandGiftCommands } = require('../js/gift-events.js');

// These are synthetic wire fixtures from the final published schema, not
// captured user traffic. The fixed hex case is independent of the encoder.
const varint = (source) => {
  let value = BigInt(source);
  const bytes = [];
  do {
    const byte = Number(value & 127n);
    value >>= 7n;
    bytes.push(byte + (value ? 128 : 0));
  } while (value);
  return Buffer.from(bytes);
};
const number = (field, value) => Buffer.concat([varint(BigInt(field) * 8n), varint(value)]);
const chunk = (field, value) => Buffer.concat([varint(BigInt(field) * 8n + 2n), varint(value.length), value]);
const text = (field, value) => chunk(field, Buffer.from(value));
const message = (...fields) => Buffer.concat(fields);
const packet = (bytes, cmd = 'SEND_GIFT_V2') => ({ cmd, data: { pb: bytes.toString('base64') } });
const expand = (...fields) => expandGiftCommands(packet(message(...fields)));
const item = (...fields) => chunk(10, message(...fields));
const gift = (...extra) => item(number(1, 7), text(2, '礼物'), number(3, 1), text(8, 'gold'), ...extra);
let passed = 0;
function ok(name) { passed += 1; console.log('PASS ' + name); }

const fixed = Buffer.from('082a1201411a0166280352190807120147180228dc0b30c4133888274204676f6c644a0174', 'hex');
assert.deepEqual(expandGiftCommands(packet(fixed)), [{
  cmd: 'SEND_GIFT', data: {
    uid: 42, uname: 'A', face: 'f', guard_level: 3, giftId: 7, giftName: 'G', num: 2,
    price: 1500, discount_price: 2500, total_coin: 5000, coin_type: 'gold', tid: 't'
  }
}]);
assert.deepEqual(expandGiftCommands(packet(fixed, 'SEND_GIFT_V2:compat')), expandGiftCommands(packet(fixed)));
ok('fixed protobuf fixture preserves corrected price fields and command suffix');

for (const value of [null, undefined, false, 0, '', 'SEND_GIFT_V2', []]) {
  assert.deepEqual(expandGiftCommands(value), []);
}
for (const cmd of ['SEND_GIFT', 'DANMU_MSG', 'SUPER_CHAT_MESSAGE', 'USER_TOAST_MSG_V2', 'GUARD_BUY']) {
  const original = { cmd, data: { arbitrary: true } };
  assert.equal(expandGiftCommands(original)[0], original);
}
ok('non-gift commands retain identity while invalid input is harmless');

// Observed decoded values documented by the upstream PR author; encoded here
// using the final corrected field order, with synthetic sender identity.
// https://github.com/xfgryujk/blivedm/pull/86#issuecomment-5103541545
const batch = expand(
  number(1, 123456789), text(2, '测试用户'), text(3, 'https://example.test/avatar.png'), number(5, 3),
  chunk(8, message(number(1, 99), number(4, 123), number(5, 12), text(6, '陪伴'))),
  chunk(9, message(number(2, 35206), text(3, '幸运盲盒'), number(6, 5000))),
  item(number(1, 35311), text(2, '好运柚叶'), number(3, 1), number(5, 2500), number(6, 2500), number(7, 5000), text(8, 'gold')),
  item(number(1, 35208), text(2, '星光铃铛'), number(3, 8), number(5, 5200), number(6, 5200), number(7, 40000), text(8, 'gold')),
  item(number(1, 35207), text(2, '幸运泡泡'), number(3, 1), number(5, 1500), number(6, 1500), number(7, 5000), text(8, 'gold'))
);
assert.equal(batch.length, 3);
assert.deepEqual(batch.map(({ data }) => data.num), [1, 8, 1]);
assert.deepEqual(batch.map(({ data }) => data.price * data.num), [2500, 41600, 1500]);
assert.deepEqual(batch.map(({ data }) => data.total_coin), [5000, 40000, 5000]);
for (const { data } of batch) {
  assert.equal(data.uid, 123456789);
  assert.equal(data.uname, '测试用户');
  assert.equal(data.medal_info.medal_name, '陪伴');
  assert.equal(data.blind_gift.original_gift_price, 5000);
}
ok('one broadcast expands all blind draws with original sender and exact item quantities');

const rich = expand(
  number(1, 11), text(2, '旧姓名'), text(3, 'https://example.test/old.png'),
  chunk(15, message(number(1, 4294967297),
    chunk(2, message(text(1, '新姓名'), text(2, 'https://example.test/new.png'))),
    chunk(3, message(text(1, '新勋章'), number(2, 20), number(8, 0), number(10, 88), number(11, 2))),
    chunk(6, number(1, 2)))),
  gift(text(9, 'transaction-id'), text(12, 'batch-id'), number(10, 1800000000), number(11, 99),
    number(14, 800000), text(18, '投喂'), chunk(35, text(1, 'https://example.test/gift.png')))
)[0].data;
assert.equal(rich.uid, 4294967297, 'UID is not truncated to 32 bits');
assert.equal(rich.uname, '新姓名');
assert.equal(rich.face, 'https://example.test/new.png');
assert.equal(rich.guard_level, 2);
assert.equal(rich.medal_info.medal_name, '新勋章');
assert.equal(rich.sender_uinfo.base.name, '新姓名');
assert.equal(rich.tid, 'transaction-id');
assert.equal(rich.batch_combo_id, 'batch-id', 'field 12 is a batch ID, not a per-transaction rnd');
assert.equal(rich.gift_info.img_basic, 'https://example.test/gift.png');
assert.equal(rich.num, 1, 'combo count does not replace current quantity');
ok('sender_uinfo fallback and transaction fields survive without 32-bit truncation');

assert.equal(expand(gift())[0].data.price, undefined);
assert.equal(expand(gift(number(5, 0), number(7, 0)))[0].data.total_coin, 0);
assert.equal(expand(gift(number(5, Number.MAX_SAFE_INTEGER)))[0].data.price, Number.MAX_SAFE_INTEGER);
assert.equal(expand(item(text(2, '免费礼物'), text(8, 'silver')))[0].data.coin_type, 'silver', 'price policy belongs to the existing gift parser');
assert.equal(expand(chunk(9, Buffer.alloc(0)), gift())[0].data.blind_gift, undefined, 'empty metadata is not a blind draw');
ok('missing and zero prices keep the gift while ordinary gifts remain ordinary');

const unknownFields = message(
  number(60, 18446744073709551615n), chunk(61, Buffer.from([255, 254])),
  varint(62 * 8 + 1), Buffer.alloc(8), varint(63 * 8 + 5), Buffer.alloc(4)
);
assert.equal(expand(unknownFields, gift(unknownFields)).length, 1);
assert.equal(expand(number(1, 42), number(1, 43), gift())[0].data.uid, 43);
ok('unknown protobuf fields are skipped and repeated scalar values follow protobuf semantics');

for (const value of [undefined, null, '', [], {}, 'a', '====', '!!!!', 'CA=A', 'CB==', 'CA==\n']) {
  assert.deepEqual(expandGiftCommands({ cmd: 'SEND_GIFT_V2', data: { pb: value } }), []);
}
assert.deepEqual(expandGiftCommands({ cmd: 'SEND_GIFT_V2' }), []);
assert.deepEqual(expand(), []);
assert.deepEqual(expand(item()), []);
assert.deepEqual(expand(number(1, 42)), []);
assert.deepEqual(expandGiftCommands({ cmd: 'SEND_GIFT_V2', data: { pb: fixed.toString('base64').replace(/=+$/, '') } }), expandGiftCommands(packet(fixed)));
ok('strict base64 validation rejects malformed and empty packets');

for (const bytes of [
  Buffer.from([0]), Buffer.from([8, 128]), Buffer.from([8, ...Array(10).fill(255)]),
  Buffer.from([18, 20, 65]), Buffer.from([18, 1, 255]), Buffer.from([82, 1, 18]),
  Buffer.from([9, 1]), Buffer.from([13, 1]), Buffer.from([11]),
  message(varint(0x100000000n), Buffer.from([0])),
  chunk(1, Buffer.from([42])), number(2, 1),
  message(number(1, 9007199254740992n), gift()),
  gift(number(5, 9007199254740992n))
]) assert.deepEqual(expandGiftCommands(packet(bytes)), [], bytes.toString('hex'));
assert.deepEqual(expand(gift(), Buffer.from([8, 128])), [], 'partial decoding must not publish part of a malformed packet');
ok('truncated, invalid wire, UTF-8, overflow and trailing corruption fail atomically');

assert.equal(expand(...Array.from({ length: 128 }, () => gift())).length, 128);
assert.deepEqual(expand(...Array.from({ length: 129 }, () => gift())), []);
assert.deepEqual(expand(...Array.from({ length: 8193 }, () => number(60, 0)), gift()), []);
assert.deepEqual(expand(text(2, 'x'.repeat(8193)), gift()), []);
assert.deepEqual(expandGiftCommands(packet(Buffer.alloc(256 * 1024 + 1))), []);
ok('packet, string, field and batch limits bound CPU and allocation');

const browser = { window: {}, TextDecoder, Uint8Array, atob, btoa };
vm.runInNewContext(fs.readFileSync(require.resolve('../js/gift-events.js'), 'utf8'), browser);
assert.equal(typeof browser.window.BiliGiftEvents.expandGiftCommands, 'function');
assert.deepEqual(JSON.parse(JSON.stringify(browser.window.BiliGiftEvents.expandGiftCommands(packet(fixed)))), expandGiftCommands(packet(fixed)));
ok('UMD browser path decodes without Buffer or third-party dependencies');

console.log('全部通过: ' + passed + ' 项');
