'use strict';

const assert = require('assert');
const zlib = require('zlib');
const { createClient } = require('../js/protocol.js');

const { buildPacket, parseFrames, extractGift, OP_NOTIFY } = createClient()._test;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8');

function jsonPacket(cmd, data) {
  return buildPacket(OP_NOTIFY, JSON.stringify({ cmd, data }), 1);
}

function wrapZlib(packet) {
  return buildPacket(OP_NOTIFY, zlib.deflateSync(packet), 2);
}

let passed = 0;
function ok(name) {
  passed += 1;
  console.log('PASS ' + name);
}

(async () => {
  const auth = buildPacket(7, JSON.stringify({ uid: 0, roomid: 123, protover: 2, platform: 'web', type: 2 }), 1);
  assert.strictEqual(auth.length, 16 + textEncoder.encode(JSON.stringify({ uid: 0, roomid: 123, protover: 2, platform: 'web', type: 2 })).length);
  const dv = new DataView(auth.buffer);
  assert.strictEqual(dv.getUint32(0), auth.length);
  assert.strictEqual(dv.getUint16(4), 16);
  assert.strictEqual(dv.getUint16(6), 1);
  assert.strictEqual(dv.getUint32(8), 7);
  ok('auth packet structure');

  const gift = {
    cmd: 'SEND_GIFT',
    data: {
      uname: '观众A',
      giftName: '小电视飞船',
      num: 1,
      coin_type: 'gold',
      total_coin: 1245000
    }
  };
  const p = jsonPacket('SEND_GIFT', gift.data);
  const { frames, rest } = await parseFrames(p);
  assert.strictEqual(frames.length, 1);
  assert.strictEqual(rest.length, 0);
  const parsed = JSON.parse(textDecoder.decode(frames[0].body));
  const g = extractGift(parsed);
  assert.strictEqual(g.uname, '观众A');
  assert.strictEqual(g.coin, 1245000);
  assert.strictEqual(g.coinIsYuan, false);
  ok('plain SEND_GIFT parse');

  const zpacket = wrapZlib(jsonPacket('SEND_GIFT', gift.data));
  const zres = await parseFrames(zpacket);
  assert.strictEqual(zres.frames.length, 1);
  assert.strictEqual(extractGift(JSON.parse(textDecoder.decode(zres.frames[0].body))).coin, 1245000);
  ok('zlib compressed frame');

  const half1 = p.slice(0, 10);
  const half2 = p.slice(10);
  const r1 = await parseFrames(half1);
  assert.strictEqual(r1.frames.length, 0);
  assert.strictEqual(r1.rest.length, half1.length);
  const merged = new Uint8Array(r1.rest.length + half2.length);
  merged.set(r1.rest);
  merged.set(half2, r1.rest.length);
  const r2 = await parseFrames(merged);
  assert.strictEqual(r2.frames.length, 1);
  ok('partial packet buffering');

  const two = new Uint8Array(p.length * 2);
  two.set(p);
  two.set(p, p.length);
  const r3 = await parseFrames(two);
  assert.strictEqual(r3.frames.length, 2);
  ok('multi packet single buffer');

  let brotliSupported = true;
  try {
    new DecompressionStream('brotli');
  } catch (e) {
    brotliSupported = false;
  }
  if (brotliSupported) {
    const bpacket = buildPacket(OP_NOTIFY, zlib.brotliCompressSync(p), 3);
    const br = await parseFrames(bpacket);
    assert.strictEqual(br.frames.length, 1);
    ok('brotli compressed frame');
  } else {
    console.log('SKIP brotli (unsupported in this runtime)');
  }

  const silver = extractGift(JSON.parse(textDecoder.decode(jsonPacket('SEND_GIFT', {
    uname: 'x', giftName: '小心心', num: 1, coin_type: 'silver', total_coin: 100
  }).slice(16))));
  assert.strictEqual(silver, null);
  ok('silver gift ignored');

  const sc = extractGift(JSON.parse(textDecoder.decode(jsonPacket('SUPER_CHAT_MESSAGE', {
    price: 30,
    user_info: { uname: '观众B' }
  }).slice(16))));
  assert.strictEqual(sc.coin, 30);
  assert.strictEqual(sc.coinIsYuan, true);
  assert.strictEqual(sc.giftName, '超级留言');
  ok('super chat');

  const guard = extractGift(JSON.parse(textDecoder.decode(jsonPacket('GUARD_BUY', {
    username: '观众C', gift_name: '舰长', num: 1, price: 198000
  }).slice(16))));
  assert.strictEqual(guard.coin, 198000);
  assert.strictEqual(guard.coinIsYuan, false);
  ok('guard buy');

  const toast1 = extractGift(JSON.parse(textDecoder.decode(jsonPacket('USER_TOAST_MSG_V2', {
    sender_uinfo: { base: { name: '观众D' } },
    gift_info: { gift_name: '提督' },
    pay_info: { num: 2, price: 1998000 },
    option: { source: 0 }
  }).slice(16))));
  assert.strictEqual(toast1.uname, '观众D');
  assert.strictEqual(toast1.coin, 3996000);
  assert.strictEqual(toast1.num, 2);
  ok('user toast v2 (source 0)');

  const toast2 = extractGift(JSON.parse(textDecoder.decode(jsonPacket('USER_TOAST_MSG_V2', {
    sender_uinfo: { base: { name: '观众E' } },
    gift_info: { gift_name: '舰长' },
    pay_info: { num: 1, price: 198000 },
    option: { source: 2 }
  }).slice(16))));
  assert.strictEqual(toast2, null);
  ok('user toast v2 (source 2) ignored');

  console.log('全部通过: ' + passed + ' 项');
})().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
