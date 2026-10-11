'use strict';

const assert = require('assert');
const zlib = require('zlib');
const { createClient } = require('../js/protocol.js');

const { buildPacket, parseFrames, extractGift, extractGifts, extractGuard, OP_NOTIFY } = createClient()._test;
const giftV2 = require('./fixtures/gift-v2.json');
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

  // Synthetic fixtures using the documented SEND_GIFT semantics:
  // blivedm 3bf17fe, models/web.py#L286-L326. 1000 gold coins = RMB 1.
  // The box costs RMB 10; it draws an RMB 100 gift twice, so display RMB 200.
  const blindData = {
    uname: '盲盒观众', giftName: '抽中礼物', coin_type: 'gold', num: 2,
    price: 100000, discount_price: 10000, total_coin: 20000,
    combo_total_coin: 500000, super_batch_gift_num: 50,
    combo_send: { combo_num: 50 }, batch_combo_send: { batch_combo_num: 50 },
    blind_gift: { original_gift_id: 30973, original_gift_name: '测试盲盒', original_gift_price: 10000, gift_tip_price: 0 }
  };
  const blindGift = extractGift({ cmd: 'SEND_GIFT', data: blindData });
  assert.deepStrictEqual(blindGift, { uname: '盲盒观众', giftName: '抽中礼物', num: 2, coin: 200000, coinIsYuan: false });
  assert.strictEqual(extractGift({ cmd: 'SEND_GIFT', data: { ...blindData, price: 500 } }).coin, 1000, 'a losing draw must also use its result value');
  const blindString = extractGift({ cmd: 'SEND_GIFT', data: { ...blindData, num: '2', price: '100000', total_coin: '20000' } });
  assert.strictEqual(blindString.coin, 200000);
  assert.strictEqual(blindString.num, 2);
  ok('blind box uses drawn unit price times this event quantity');

  for (const price of [undefined, null, '', 'bad', -1, '-1', false, {}, [], Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.strictEqual(extractGift({ cmd: 'SEND_GIFT', data: { ...blindData, price } }).coin, null, 'unknown result value must not become zero or fall back to box cost');
  }
  for (const price of [0, '0']) assert.strictEqual(extractGift({ cmd: 'SEND_GIFT', data: { ...blindData, price } }).coin, 0);
  for (const num of [undefined, null, '', 'bad', 0, '0', -1, '-1', 1.5, false, {}, [], Infinity]) {
    const result = extractGift({ cmd: 'SEND_GIFT', data: { ...blindData, num } });
    assert.strictEqual(result.num, 1, 'invalid quantities retain the single-gift default');
    assert.strictEqual(result.coin, 100000);
  }
  assert.strictEqual(extractGift({ cmd: 'SEND_GIFT', data: { ...blindData, price: Number.MAX_SAFE_INTEGER } }).coin, null, 'overflow is never emitted as an amount');
  assert.strictEqual(extractGift({ cmd: 'SEND_GIFT', data: { ...blindData, coin_type: 'silver' } }), null);
  ok('blind box missing, zero, invalid and string fields have safe fallbacks');

  const discounted = extractGift({ cmd: 'SEND_GIFT', data: { ...blindData, blind_gift: null, total_coin: '160000' } });
  assert.strictEqual(discounted.coin, 160000, 'ordinary gift keeps its discounted paid total');
  assert.strictEqual(discounted.num, 2);
  for (const blind_gift of [undefined, null, {}, [], '', 'blind', 0, false]) {
    assert.strictEqual(extractGift({ cmd: 'SEND_GIFT', data: { ...blindData, blind_gift, total_coin: 160000 } }).coin, 160000, 'empty or non-object blind metadata does not identify a blind-box result');
  }
  for (const total_coin of [undefined, null, '', 'bad', -1, '-1', Infinity, false, {}, []]) {
    assert.strictEqual(extractGift({ cmd: 'SEND_GIFT', data: { ...blindData, blind_gift: null, total_coin } }).coin, 0);
  }
  assert.strictEqual(extractGift({ cmd: 'SEND_GIFT', data: { ...blindData, blind_gift: null, total_coin: 0 } }).coin, 0);
  ok('ordinary gift pricing still uses this event paid total');

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

  for (const [total, header] of [[0, 16], [16, 0], [16, 17], [33 * 1024 * 1024, 16]]) {
    const invalid = buildPacket(5, '', 1); const view = new DataView(invalid.buffer);
    view.setUint32(0, total); view.setUint16(4, header);
    await assert.rejects(parseFrames(invalid), /header/);
  }
  await assert.rejects(parseFrames(wrapZlib(p.slice(0, p.length - 1))), /Truncated compressed/);
  let nested = p;
  for (let depth = 0; depth < 5; depth++) nested = wrapZlib(nested);
  await assert.rejects(parseFrames(nested), /nesting/);
  const expanding = wrapZlib(buildPacket(5, new Uint8Array(33 * 1024 * 1024), 1));
  await assert.rejects(parseFrames(expanding), /decompression.*safety/);
  assert.strictEqual((await parseFrames(p)).frames.length, 1, 'a rejected packet cannot poison the next parse');
  ok('invalid headers, truncated compressed packets, deep nesting and expansion bombs are bounded');

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
  for (const price of [undefined, null, '', -1, '-1', 'bad', Infinity, {}, []]) {
    assert.strictEqual(extractGift({ cmd: 'SUPER_CHAT_MESSAGE', data: { price } }).coin, null);
  }
  assert.strictEqual(extractGift({ cmd: 'SUPER_CHAT_MESSAGE', data: { price: '30' } }).coin, 30);
  ok('SC missing or invalid prices stay unknown instead of becoming zero-value short-lived cards');

  const guard = extractGift(JSON.parse(textDecoder.decode(jsonPacket('GUARD_BUY', {
    username: '观众C', gift_name: '舰长', num: 1, price: 198000
  }).slice(16))));
  assert.strictEqual(guard.coin, null, 'GUARD_BUY list price is not the paid amount');
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

  // Synthetic fields following the public V2 schema and paired renewal capture:
  // https://github.com/Akokk0/bilibili-notify/blob/b8713162c8e02e6b8d7a6629a42e9564f06afb93/packages/blive/src/__tests__/fixtures/payloads.json
  const toastData = {
    sender_uinfo: { uid: '42', base: { uid: 999, name: '同一位舰长' } },
    guard_info: { guard_level: '3', role_name: '舰长', start_time: '1700000000', end_time: 1700000000 },
    gift_info: { gift_id: 10003 },
    pay_info: { price: '168000', num: '1', unit: '月', payflow_id: '2609011234567890123456789' },
    option: { source: '0' }
  };
  const normalizeToast = (data = toastData) => extractGuard({ cmd: 'USER_TOAST_MSG_V2', data });
  assert.deepStrictEqual(normalizeToast(), {
    source: 'USER_TOAST_MSG_V2', uid: 42, uname: '同一位舰长', giftName: '舰长', guardLevel: 3,
    num: 1, coin: 168000, coinIsYuan: false, startTime: 1700000000, endTime: 1700000000,
    payflowId: '2609011234567890123456789'
  });
  assert.strictEqual(normalizeToast({ ...toastData, sender_uinfo: { base: { uid: '43', name: '旧格式' } } }).uid, 43);
  assert.strictEqual(normalizeToast({ ...toastData, sender_uinfo: { uid: 'bad', base: { uid: '43' } } }).uid, 43);
  assert.strictEqual(normalizeToast({ ...toastData, sender_uinfo: { uid: 0, base: {} } }).uid, 0);
  ok('guard V2 reads sender UID outside base and preserves exact payment ID');

  for (const [guard_level, name] of [[1, '总督'], [2, '提督'], [3, '舰长']]) {
    assert.strictEqual(normalizeToast({ ...toastData, guard_info: { guard_level } }).giftName, name);
  }
  assert.strictEqual(normalizeToast({ ...toastData, gift_info: { gift_name: '定制舰长' } }).giftName, '定制舰长');
  assert.strictEqual(normalizeToast({ ...toastData, guard_info: { guard_level: 3, role_name: '舰长身份' } }).giftName, '舰长身份');
  assert.strictEqual(normalizeToast({ ...toastData, guard_info: {} }).giftName, '大航海');
  assert.strictEqual(normalizeToast({ ...toastData, guard_info: { role_name: '舰长' } }).giftName, '舰长');
  ok('guard name falls back to the purchased level when V2 gift metadata has no name');

  for (const source of [2, '2']) {
    assert.strictEqual(normalizeToast({ ...toastData, option: { source } }), null);
    assert.strictEqual(extractGift({ cmd: 'USER_TOAST_MSG_V2', data: { ...toastData, option: { source } } }), null);
  }
  for (const price of [undefined, null, '', 'bad', -1, '-1', false, {}, [], Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.strictEqual(normalizeToast({ ...toastData, pay_info: { num: 1, price } }).coin, null);
  }
  for (const price of [0, '0']) assert.strictEqual(normalizeToast({ ...toastData, pay_info: { price, num: 2 } }).coin, 0);
  for (const num of [undefined, null, '', 'bad', 0, '0', -1, '-1', false, {}, [], Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const result = normalizeToast({ ...toastData, pay_info: { price: 168000, num } });
    assert.strictEqual(result.num, 1);
    assert.strictEqual(result.coin, null, 'unknown quantity cannot be replaced by one when computing a paid amount');
  }
  assert.strictEqual(normalizeToast({ ...toastData, pay_info: { num: 2, price: Number.MAX_SAFE_INTEGER } }).coin, null);
  assert.strictEqual(normalizeToast({ ...toastData, pay_info: { num: 2, price: '168000' } }).coin, 336000);
  assert.strictEqual(normalizeToast({ ...toastData, pay_info: {} }).coin, null);
  ok('guard payment amount validates unit price and quantity, preserves zero, and rejects overflow');

  const buyData = { uid: 42, username: '同一位舰长', guard_level: 3, num: 1, price: 198000, start_time: 1700000000, end_time: 1700000000 };
  const buy = extractGuard({ cmd: 'GUARD_BUY', data: buyData });
  assert.strictEqual(buy.source, 'GUARD_BUY');
  assert.strictEqual(buy.uid, normalizeToast().uid);
  assert.strictEqual(buy.guardLevel, normalizeToast().guardLevel);
  assert.strictEqual(buy.startTime, normalizeToast().startTime);
  assert.strictEqual(buy.coin, null);
  assert.strictEqual(buy.payflowId, '');
  const legacy = extractGuard({ cmd: 'USER_TOAST_MSG', data: { ...buyData, price: 168000, payflow_id: toastData.pay_info.payflow_id, role_name: '舰长', source: 0 } });
  assert.strictEqual(legacy.source, 'USER_TOAST_MSG');
  assert.strictEqual(legacy.coin, 168000);
  assert.strictEqual(legacy.payflowId, normalizeToast().payflowId);
  assert.strictEqual(extractGuard({ cmd: 'USER_TOAST_MSG', data: { ...buyData, source: '2' } }), null);
  assert.strictEqual(extractGuard(null), null);
  assert.strictEqual(extractGuard({ cmd: 'SEND_GIFT', data: buyData }), null);
  assert.strictEqual(extractGuard({ cmd: 'GUARD_BUY:compat', data: buyData }).source, 'GUARD_BUY');
  assert.deepStrictEqual(Object.keys(extractGift({ cmd: 'USER_TOAST_MSG_V2', data: toastData })).sort(), ['coin', 'coinIsYuan', 'giftName', 'num', 'uname']);
  ok('buy and both toast generations share matching fields while legacy gift shape stays stable');

  assert.deepStrictEqual(extractGifts(giftV2.multi).map(gift => [gift.giftName, gift.num, gift.coin]), [
    ['小花花', 2, 20000], ['喵娘', 1, 5000]
  ]);
  assert.strictEqual(extractGift(giftV2.single).uname, '协议测试观众');
  assert.strictEqual(extractGift(giftV2.blind).coin, 200000);
  assert.deepStrictEqual(extractGifts({ cmd: 'SEND_GIFT_V2', data: { pb: 'bad!' } }), []);
  ok('V2 gift batches retain each paid item, ignore silver, and preserve blind-box value');

  const OriginalWebSocket = global.WebSocket;
  let socket;
  try {
    global.WebSocket = class {
      constructor() { socket = this; }
      close() {}
    };
    const client = createClient();
    const gifts = [], raw = [];
    client.onGift(gift => gifts.push(gift));
    client.onRawCommand(command => raw.push(command));
    client.connect('123');
    socket.onmessage({ data: JSON.stringify({ t: 'cmd', v: giftV2.multi }) });
    socket.onmessage({ data: JSON.stringify({ t: 'cmd', v: { cmd: 'SEND_GIFT_V2', data: { pb: 'bad!' } } }) });
    socket.onmessage({ data: JSON.stringify({ t: 'cmd', v: { cmd: 'SEND_GIFT', data: { uname: '旧协议', giftName: '花', num: 1, total_coin: 1000, coin_type: 'gold' } } }) });
    assert.deepStrictEqual(gifts.map(gift => gift.giftName), ['小花花', '喵娘', '花']);
    assert.strictEqual(raw[0].cmd, 'SEND_GIFT_V2', 'raw callbacks retain the original packet');
    client.disconnect();
  } finally {
    global.WebSocket = OriginalWebSocket;
  }
  ok('browser relay client emits every V2 gift and keeps processing after a malformed event');

  {
    const sockets = [], raw = [], states = [], timers = new Map();
    const originalSetTimeout = global.setTimeout, originalClearTimeout = global.clearTimeout;
    let timerId = 0;
    try {
      global.setTimeout = callback => { const id = ++timerId; timers.set(id, callback); return id; };
      global.clearTimeout = id => timers.delete(id);
      global.WebSocket = class {
        static OPEN = 1; static CONNECTING = 0;
        constructor(url) { this.url = url; this.readyState = 0; this.closes = 0; sockets.push(this); }
        close() { this.closes++; }
      };
      const client = createClient(); client.onRawCommand(value => raw.push(value)); client.onStatus(value => states.push(value));
      client.connect('1'); const old = sockets[0];
      client.connect('2'); const current = sockets[1]; const stateCount = states.length;
      old.onopen(); old.onmessage({ data: JSON.stringify({ t: 'cmd', v: gift }) }); old.onerror(); old.onclose();
      assert.strictEqual(current.closes, 0, 'old socket error cannot close the replacement');
      assert.strictEqual(states.length, stateCount); assert.strictEqual(raw.length, 0); assert.strictEqual(timers.size, 0);
      current.onmessage({ data: JSON.stringify({ t: 'cmd', v: gift }) }); assert.strictEqual(raw.length, 1);
      current.onclose(); const retry = [...timers.values()][0]; assert.strictEqual(timers.size, 1);
      client.disconnect(); assert.strictEqual(timers.size, 0); retry();
      current.onmessage({ data: JSON.stringify({ t: 'cmd', v: gift }) });
      assert.strictEqual(sockets.length, 2); assert.strictEqual(raw.length, 1);
    } finally {
      global.WebSocket = OriginalWebSocket;
      global.setTimeout = originalSetTimeout; global.clearTimeout = originalClearTimeout;
    }
    ok('room switches and disconnects invalidate old browser socket callbacks and pending retries');
  }

  console.log('全部通过: ' + passed + ' 项');
})().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
