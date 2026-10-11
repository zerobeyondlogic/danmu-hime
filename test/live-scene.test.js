'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { createLiveScene } = require('../desktop/live-scene.js');
const { normalizeEntryCommand } = require('../desktop/entry-events.js');
const { createRelay, _test: relayProtocol } = require('../relay.js');
const { _test: biliProtocol } = require('../js/protocol.js');
const giftV2 = require('./fixtures/gift-v2.json');

const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function mockRelay() {
  const listeners = new Set();
  const previousListeners = [];
  const connections = [];
  let room = null;
  let disconnects = 0;
  return {
    listeners, previousListeners, connections,
    get room() { return room; },
    get disconnects() { return disconnects; },
    subscribe(listener) {
      listeners.add(listener);
      previousListeners.push(listener);
      return () => listeners.delete(listener);
    },
    connectRoom(id) {
      if (room === id) return;
      room = id;
      connections.push(id);
      this.emit({ t: 'status', v: 'connecting', room });
    },
    disconnectRoom() { room = null; disconnects += 1; },
    emit(event) { for (const listener of listeners) listener(event); },
    raw(packet, id = room) { this.emit({ t: 'cmd', v: packet, room: id }); }
  };
}

function setup(options = {}) {
  const relay = options.relay || mockRelay();
  const messages = [];
  const entries = [];
  const statuses = [];
  const updates = [];
  const roomCalls = [];
  const emoteCalls = [];
  let timestamp = new Date(2026, 8, 8, 12, 34, 56).getTime();
  const service = createLiveScene({
    relay,
    getRoomInfo: async (room) => {
      roomCalls.push(room);
      return { ok: true, roomId: room, ownerUid: 99 };
    },
    getRoomEmotes: async (room) => { emoteCalls.push(room); return { ok: true, emotes: [] }; },
    onMessage: (message) => { messages.push(message); return { id: String(messages.length) }; },
    onMessageUpdate: (id, message) => { updates.push({ id, message }); messages[Number(id) - 1] = message; },
    onEntry: (entry) => entries.push(entry),
    onStatus: (status) => statuses.push(status),
    now: () => timestamp,
    ...options
  });
  return { relay, messages, updates, entries, statuses, roomCalls, emoteCalls, service, advance: (ms) => { timestamp += ms; } };
}

function chat({ uid = 7, uname = '测试用户', text = '测试', manager = 0, guard = 0, flags = [], medal = [] } = {}) {
  return { cmd: 'DANMU_MSG:4:0:2:2:2:0', info: [flags, text, [uid, uname, manager], medal, [], [], [], guard] };
}

function entry(uid = 7, uname = '进房用户', msgType = 1) {
  return { cmd: 'INTERACT_WORD', data: { uid, uname, msg_type: msgType } };
}

// Synthetic wire fixture encoded from the public schema, not a live account
// capture: blivedm commit 3bf17fe862b8c2fc6bc04c81c3f0c5db95de93d6,
// models/pb.py#L33: uid=1, uname=2, msg_type=5, timestamp=7, uinfo=22.
// uid 1234567, uname 入场测试, enter (1), timestamp 1700000000, empty uinfo.
const ENTRY_V2_PB = 'CIetSxIM5YWl5Zy65rWL6K+VKAE4gOLPqgayAQA=';
const FOLLOW_V2_PB = 'CIetSxIM5YWl5Zy65rWL6K+VKAI4gOLPqgayAQA=';
// Same public schema: uinfo (22) -> base (2) -> face (2).
const ENTRY_AVATAR_V2_PB = 'CIetSxIM5YWl5Zy65rWL6K+VKAE4gOLPqgayAQCyAR4SHBIaLy9pMC5oZHNsYi5jb20vYXJyaXZhbC5wbmc=';
function entryV2(pb = ENTRY_V2_PB) { return { cmd: 'INTERACT_WORD_V2', data: { pb } }; }

const tests = [];
function test(name, run) { tests.push({ name, run }); }

test('service stays lazy and has no renderer dependency', async () => {
  const h = setup();
  await tick();
  assert.deepStrictEqual(h.roomCalls, []);
  assert.deepStrictEqual(h.emoteCalls, []);
  assert.strictEqual(h.relay.listeners.size, 0);
  assert.strictEqual(h.relay.disconnects, 0);
  assert.strictEqual(Object.keys(require.cache).some((file) => file.endsWith('overlay.js')), false);
  h.service.dispose();
});

test('raw DANMU_MSG becomes a complete timed scene message without a window', async () => {
  const h = setup();
  await h.service.connect(' 123 ');
  const flags = [];
  flags[13] = { url: '//i0.hdslb.com/emote.png', width: 60, height: 60 };
  flags[15] = JSON.stringify({ user: { base: { face: '//i0.hdslb.com/avatar.jpg' } } });
  h.relay.raw(chat({ text: '[笑]', guard: 3, flags, medal: [6, '陪伴'] }));
  assert.deepStrictEqual(h.messages[0], {
    type: 'chat', uid: 7, uname: '测试用户', text: '[笑]', role: 'captain', medal: '陪伴 6',
    avatarUrl: 'https://i0.hdslb.com/avatar.jpg',
    emotes: { '[笑]': { url: 'https://i0.hdslb.com/emote.png', width: 60, height: 60, official: true } },
    at: new Date(2026, 8, 8, 12, 34, 56).getTime(), time: '12:34:56', gapMs: null
  });
  h.advance(125);
  h.relay.raw(chat());
  assert.strictEqual(h.messages[1].gapMs, 125);
  assert.deepStrictEqual(h.relay.connections, ['123']);
  h.service.dispose();
});

test('entry callback receives only room arrivals and never changes chat history or gaps', async () => {
  const h = setup();
  await h.service.connect('123');
  h.relay.raw(chat());
  h.advance(400);
  h.relay.raw(entry());
  for (const type of [0, 2, 3, 4, 5, 6, true, 'follow']) h.relay.raw(entry(8, '非进房用户', type));
  h.relay.raw({ cmd: 'ENTRY_EFFECT', data: { uid: 9, copy_writing: '<%不推测用户名%> 进入直播间' } });
  h.relay.raw({ cmd: 'WELCOME', data: { uid: 9 } });
  h.advance(600);
  h.relay.raw(chat());
  assert.deepStrictEqual(h.entries, [{ uid: 7, uname: '进房用户', at: new Date(2026, 8, 8, 12, 34, 56).getTime() + 400 }]);
  assert.strictEqual(h.messages.length, 2);
  assert.strictEqual(h.messages[1].gapMs, 1000);
  h.service.dispose();
});

test('entry artwork uses an existing JSON avatar without changing the verified V2 identity', async () => {
  const h = setup();
  await h.service.connect('123');
  h.relay.raw({ cmd: 'INTERACT_WORD', data: {
    uid: 77, uname: '头像观众', msg_type: 1,
    uinfo: { base: { face: '//i0.hdslb.com/arrival.png' } }
  } });
  h.relay.raw({ ...entryV2(), data: { ...entryV2().data, face: '//i0.hdslb.com/unverified.png' } });
  assert.strictEqual(h.entries[0].uid, 77);
  assert.strictEqual(h.entries[0].avatarUrl, 'https://i0.hdslb.com/arrival.png');
  assert.strictEqual(h.entries[1].uid, 1234567);
  assert.strictEqual(Object.hasOwn(h.entries[1], 'avatarUrl'), false);
  assert.strictEqual(h.messages.length, 0);
  h.service.dispose();
});

test('INTERACT_WORD_V2 decodes verified protobuf fields and ignores follow/share events', async () => {
  const h = setup();
  await h.service.connect('123');
  h.relay.raw(entryV2());
  h.relay.raw(entryV2(FOLLOW_V2_PB));
  h.relay.raw({ cmd: 'INTERACT_WORD_V2', data: { pb: FOLLOW_V2_PB, msg_type: 1, uname: 'cannot override protobuf', uid: 88 } });
  const share = Buffer.from(ENTRY_V2_PB, 'base64');
  share[19] = 3;
  h.relay.raw(entryV2(share.toString('base64')));
  assert.deepStrictEqual(h.entries.map(({ uid, uname }) => ({ uid, uname })), [{ uid: 1234567, uname: '入场测试' }]);
  assert.deepStrictEqual(h.messages, []);
  assert.deepStrictEqual(normalizeEntryCommand(entryV2(ENTRY_V2_PB.replace(/=+$/, ''))), { uid: 1234567, uname: '入场测试' });
  const unknownFields = Buffer.from([
    0xa0, 6, 1, // field 100: varint
    0xa9, 6, 0, 0, 0, 0, 0, 0, 0, 0, // field 101: fixed64
    0xb5, 6, 0, 0, 0, 0, // field 102: fixed32
    0xba, 6, 3, 1, 2, 3 // field 103: bytes
  ]);
  const extended = Buffer.concat([Buffer.from(ENTRY_V2_PB, 'base64'), unknownFields]);
  assert.deepStrictEqual(normalizeEntryCommand(entryV2(extended.toString('base64'))), { uid: 1234567, uname: '入场测试' });
  h.service.dispose();
});

test('V2 arrival carries the schema-defined nested avatar without trusting shadow JSON fields', async () => {
  const packet = { cmd: 'INTERACT_WORD_V2', data: { pb: ENTRY_AVATAR_V2_PB,
    uid: 88, uname: 'JSON cannot replace protobuf identity', msg_type: 3, face: 'https://i0.hdslb.com/wrong.png' } };
  const expected = { uid: 1234567, uname: '入场测试', avatarUrl: 'https://i0.hdslb.com/arrival.png' };
  assert.deepStrictEqual(normalizeEntryCommand(packet), expected);
  const h = setup();
  await h.service.connect('123');
  h.relay.raw(packet);
  assert.deepStrictEqual(h.entries.map(({ at, ...value }) => value), [expected]);
  assert.strictEqual(h.messages.length, 0);
  const followed = Buffer.from(ENTRY_AVATAR_V2_PB, 'base64');
  followed[19] = 2;
  assert.strictEqual(normalizeEntryCommand(entryV2(followed.toString('base64'))), null);
  h.service.dispose();
});

test('V2 optional avatar rejects wrong paths, unsafe URLs and malformed nested bytes while keeping the arrival', () => {
  const varint = value => {
    const bytes = [];
    do { const low = value & 127; value = Math.floor(value / 128); bytes.push(low | (value ? 128 : 0)); } while (value);
    return Buffer.from(bytes);
  };
  const field = (number, bytes) => Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
  const nested = text => field(2, field(2, Buffer.from(text)));
  const packet = (bytes, number = 22) => entryV2(Buffer.concat([Buffer.from(ENTRY_V2_PB, 'base64'), field(number, bytes)]).toString('base64'));
  const identity = { uid: 1234567, uname: '入场测试' };
  for (const face of ['javascript:alert(1)', 'https://example.test/avatar.png', 'https://i0.hdslb.com@evil.test/a.png',
    'https://user:pass@i0.hdslb.com/a.png', 'https://i0.hdslb.com/' + 'a'.repeat(2049)]) {
    assert.deepStrictEqual(normalizeEntryCommand(packet(nested(face))), identity);
  }
  assert.deepStrictEqual(normalizeEntryCommand(packet(nested('https://i0.hdslb.com/wrong-path.png'), 23)), identity);
  assert.deepStrictEqual(normalizeEntryCommand(packet(field(1, field(2, Buffer.from('https://i0.hdslb.com/wrong-base.png'))))), identity);
  assert.deepStrictEqual(normalizeEntryCommand(packet(Buffer.from([18, 255]))), identity);
  assert.deepStrictEqual(normalizeEntryCommand(packet(field(2, field(2, Buffer.from([255]))))), identity);
  assert.strictEqual(normalizeEntryCommand(packet(nested('http://i1.hdslb.com/arrival.png'))).avatarUrl, 'https://i1.hdslb.com/arrival.png');
});

test('invalid entry payloads are ignored, and display names remain bounded plain text', async () => {
  const h = setup();
  await h.service.connect('123');
  const invalid = [null, {}, { cmd: 'INTERACT_WORD' }, { cmd: 'INTERACT_WORD', data: [] },
    entry(0), entry(-1), entry(Number.MAX_SAFE_INTEGER + 1), entry({}, 'name'), entry(3, {}), entry(3, ' \n\0 '),
    ...['', null, [], {}, '%%%=', 'AA=', 'A===', 'A'.repeat(90000)].map(entryV2)];
  const prefix = Buffer.from(ENTRY_V2_PB, 'base64');
  for (const invalidTail of [
    [0], [8, 0x80], [18, 0xff, 0x7f], [18, 1, 0xff], [17, 0, 0, 0, 0, 0, 0, 0, 0],
    [8, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x10],
    [8, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 2],
    [0xa9, 6, 0], [0xb5, 6, 0], [0xa3, 6]
  ]) invalid.push(entryV2(Buffer.concat([prefix, Buffer.from(invalidTail)]).toString('base64')));
  for (const packet of invalid) assert.doesNotThrow(() => h.relay.raw(packet));
  assert.deepStrictEqual(h.entries, []);
  assert.deepStrictEqual(h.messages, []);
  h.relay.raw(entry('123', ' \n😀'.repeat(100)));
  assert.strictEqual(h.entries[0].uid, 123);
  assert.strictEqual(Array.from(h.entries[0].uname).length, 80);
  assert.strictEqual(/[\n\r\0]/.test(h.entries[0].uname), false);
  h.service.dispose();
});

test('duplicate entry protocols share a bounded UID cache that expires and resets on reconnect', async () => {
  const h = setup();
  await h.service.connect('123');
  h.relay.raw(entry(1234567, '入场测试'));
  h.advance(500);
  h.relay.raw(entryV2());
  h.relay.raw(entry(8));
  assert.strictEqual(h.entries.length, 2);
  h.advance(2500);
  h.relay.raw(entryV2());
  assert.strictEqual(h.entries.length, 3);
  const oldListener = h.relay.previousListeners.at(-1);
  await h.service.reconnect();
  oldListener({ t: 'cmd', v: entryV2(), room: '123' });
  h.relay.raw(entryV2());
  assert.strictEqual(h.entries.length, 4);
  h.relay.emit({ t: 'status', v: 'reconnect', room: '123' });
  h.relay.raw(entryV2());
  assert.strictEqual(h.entries.length, 5);
  for (let uid = 100; uid < 356; uid += 1) h.relay.raw(entry(uid));
  h.relay.raw(entryV2());
  assert.strictEqual(h.entries.length, 262, 'older UID is evicted after 256 distinct arrivals');
  assert.deepStrictEqual(h.messages, []);
  h.service.dispose();
});

test('entry delivery rejects stale rooms, pending generations, disconnects, and disposed callbacks', async () => {
  const pending = deferred();
  const h = setup({ getRoomInfo: (room) => room === '2' ? pending.promise : Promise.resolve({ ok: true }) });
  await h.service.connect('1');
  h.relay.raw(entry());
  const oldListener = h.relay.previousListeners.at(-1);
  const switching = h.service.connect('2');
  h.relay.raw(entry(), '1');
  h.relay.raw(entry(), '2');
  oldListener({ t: 'cmd', v: entryV2(), room: '1' });
  assert.strictEqual(h.entries.length, 1);
  pending.resolve({ ok: true });
  await switching;
  h.relay.raw(entry());
  assert.strictEqual(h.entries.length, 2, 'same UID is accepted in the new room');
  const currentListener = h.relay.previousListeners.at(-1);
  await h.service.connect('');
  currentListener({ t: 'cmd', v: entryV2(), room: '2' });
  h.service.dispose();
  currentListener({ t: 'cmd', v: entryV2(), room: '2' });
  assert.strictEqual(h.entries.length, 2);
  assert.deepStrictEqual(h.messages, []);
});

test('entry callback is optional and does not affect normal message delivery', async () => {
  const h = setup({ onEntry: undefined });
  await h.service.connect('123');
  h.relay.raw(entry());
  h.relay.raw(entryV2());
  h.relay.raw(chat());
  assert.strictEqual(h.messages.length, 1);
  assert.strictEqual(h.messages[0].gapMs, null);
  assert.deepStrictEqual(h.entries, []);
  h.service.dispose();
});

test('host, manager, and three guard roles retain their precedence', async () => {
  const h = setup();
  await h.service.connect('123');
  h.relay.raw(chat({ uid: 99, manager: 1, guard: 1 }));
  h.relay.raw(chat({ manager: 1, guard: 1 }));
  for (const guard of [1, 2, 3, 0]) h.relay.raw(chat({ guard }));
  assert.deepStrictEqual(h.messages.map((message) => message.role), ['host', 'manager', 'governor', 'admiral', 'captain', 'viewer']);
  h.service.dispose();
});

test('paid gifts, SC, guards and toast packets preserve values and skip duplicate or free gifts', async () => {
  const h = setup();
  await h.service.connect('123');
  h.relay.raw({ cmd: 'SEND_GIFT', data: { uid: 2, uname: '礼物用户', giftName: '小花花', num: 10, total_coin: 30000, coin_type: 'gold' } });
  h.relay.raw({ cmd: 'SEND_GIFT', data: { coin_type: 'silver', giftName: '免费礼物' } });
  h.relay.raw({ cmd: 'SUPER_CHAT_MESSAGE', data: {
    uid: 99, message: '超级留言测试', price: 50,
    user_info: { uname: '主播', face: '//i0.hdslb.com/host.jpg', manager: 1, guard_level: 3 },
    medal_info: { medal_name: '陪伴', medal_level: 8 }
  } });
  h.relay.raw({ cmd: 'GUARD_BUY', data: { uid: 3, username: '舰长用户', gift_name: '舰长', num: 2, price: 138000 } });
  h.relay.raw({ cmd: 'USER_TOAST_MSG_V2', data: {
    sender_uinfo: { base: { uid: 4, name: '提督用户', face: '//i0.hdslb.com/guard.jpg' } },
    gift_info: { gift_name: '提督' }, pay_info: { num: 1, price: 1998000 }
  } });
  h.relay.raw({ cmd: 'USER_TOAST_MSG_V2', data: { option: { source: 2 } } });
  h.relay.raw({ cmd: 'WATCHED_CHANGE', data: { num: 100 } });
  assert.strictEqual(h.messages.length, 4);
  assert.deepStrictEqual(h.messages.map((m) => [m.type, m.kind, m.valueYuan]), [
    ['gift', 'gift', 30], ['sc', 'sc', 50], ['gift', 'guard', undefined], ['gift', 'guard', 1998]
  ]);
  assert.strictEqual(h.messages[0].text, '赠送  小花花 × 10');
  assert.strictEqual(h.messages[1].text, '超级留言测试');
  assert.strictEqual(h.messages[1].role, 'host');
  assert.strictEqual(h.messages[1].medal, '陪伴 8');
  assert.strictEqual(h.messages[1].avatarUrl, 'https://i0.hdslb.com/host.jpg');
  assert.strictEqual(h.messages[2].text, '开通  舰长 × 2');
  assert.strictEqual(h.messages[2].role, 'captain');
  assert.strictEqual(h.messages[3].role, 'admiral');
  assert.strictEqual(h.messages[3].uid, 4);
  assert.strictEqual(h.messages[3].avatarUrl, 'https://i0.hdslb.com/guard.jpg');
  h.service.dispose();
});

test('blind-box scene values use drawn gifts while ordinary gifts keep the paid total', async () => {
  const h = setup();
  await h.service.connect('123');
  const data = {
    uid: 7, uname: '盲盒观众', giftName: '抽中礼物', num: '2', coin_type: 'gold',
    price: '100000', total_coin: '20000', discount_price: 10000,
    super_batch_gift_num: 50, combo_total_coin: 500000,
    blind_gift: { original_gift_name: '测试盲盒', original_gift_price: 10000, gift_tip_price: 0 }
  };
  h.relay.raw({ cmd: 'SEND_GIFT', data });
  h.advance(100);
  h.relay.raw({ cmd: 'SEND_GIFT', data: { ...data, blind_gift: null, total_coin: 160000 } });
  h.relay.raw({ cmd: 'SEND_GIFT', data: { ...data, price: undefined } });
  h.relay.raw({ cmd: 'SEND_GIFT', data: { ...data, price: 0 } });
  h.relay.raw({ cmd: 'SEND_GIFT', data: { ...data, blind_gift: {}, total_coin: 160000 } });
  assert.deepStrictEqual(h.messages.map((m) => m.valueYuan), [200, 160, undefined, 0, 160]);
  assert.strictEqual(h.messages[0].text, '赠送  抽中礼物 × 2');
  assert.strictEqual(h.messages[0].kind, 'gift');
  assert.strictEqual(h.messages[1].gapMs, 100);
  assert.strictEqual(h.messages[2].text, '赠送  抽中礼物 × 2', 'missing value must still retain the gift itself');
  assert.strictEqual(Object.hasOwn(h.messages[2], 'valueYuan'), false, 'unknown drawn price must omit the amount field');
  assert.strictEqual(Object.hasOwn(h.messages[3], 'valueYuan'), true, 'a known zero value remains explicit');
  assert.deepStrictEqual(h.entries, []);
  h.service.dispose();
});

test('gift artwork retains the actual gift identity and accepts only Bilibili image URLs', async () => {
  const h = setup();
  await h.service.connect('123');
  const data = {
    uid: 7, uname: '礼物观众', giftId: 35208, giftName: '星光铃铛', num: 2,
    coin_type: 'gold', price: 5200, total_coin: 10000,
    face: '//i0.hdslb.com/sender.png', gift_info: { img_basic: '//i0.hdslb.com/drawn.png' },
    blind_gift: { original_gift_id: 35206, original_gift_name: '幸运盲盒',
      original_gift_price: 5000, img_basic: '//i0.hdslb.com/box.png' }
  };
  h.relay.raw({ cmd: 'SEND_GIFT', data });
  assert.strictEqual(h.messages[0].giftId, 35208);
  assert.strictEqual(h.messages[0].giftImageUrl, 'https://i0.hdslb.com/drawn.png');
  assert.strictEqual(h.messages[0].avatarUrl, 'https://i0.hdslb.com/sender.png');
  assert.strictEqual(h.messages[0].valueYuan, 10.4);
  const unsafe = ['javascript:alert(1)', 'https://example.test/gift.png',
    'https://i0.hdslb.com.example.test/gift.png', 'data:image/png;base64,AAAA', '//i0.hdslb.com/' + 'a'.repeat(2048)];
  for (const img_basic of unsafe) {
    h.relay.raw({ cmd: 'SEND_GIFT', data: { ...data, giftId: -1, gift_info: { img_basic } } });
    assert.strictEqual(Object.hasOwn(h.messages.at(-1), 'giftId'), false);
    assert.strictEqual(Object.hasOwn(h.messages.at(-1), 'giftImageUrl'), false);
    assert.strictEqual(h.messages.at(-1).valueYuan, 10.4, 'image rejection never drops the paid gift');
  }
  h.relay.raw({ cmd: 'SUPER_CHAT_MESSAGE', data: { uid: 8, message: '留言', price: 30,
    user_info: { uname: '留言观众', face: '//i1.hdslb.com/sc-user.png' },
    gift: { gift_id: 12000, img_basic: 'http://i1.hdslb.com/sc.png' } } });
  assert.strictEqual(h.messages.at(-1).giftId, 12000);
  assert.strictEqual(h.messages.at(-1).giftImageUrl, 'https://i1.hdslb.com/sc.png');
  assert.strictEqual(h.messages.at(-1).avatarUrl, 'https://i1.hdslb.com/sc-user.png');
  h.service.dispose();
});

test('raw V2 gift image field survives protobuf decoding into the scene', async () => {
  const h = setup();
  await h.service.connect('123');
  // Synthetic schema fields: gift_info=35 (wire 2), img_basic=1 (wire 2).
  const image = Buffer.from('//i0.hdslb.com/v2-gift.png');
  const gift = Buffer.concat([Buffer.from('0807120147180228dc0b3888274204676f6c64', 'hex'),
    Buffer.from([0x9a, 0x02, image.length + 2, 0x0a, image.length]), image]);
  const body = Buffer.concat([Buffer.from([0x08, 42, 0x52, gift.length]), gift]);
  h.relay.raw({ cmd: 'SEND_GIFT_V2', data: { pb: body.toString('base64') } });
  assert.strictEqual(h.messages.length, 1);
  assert.strictEqual(h.messages[0].giftId, 7);
  assert.strictEqual(h.messages[0].giftImageUrl, 'https://i0.hdslb.com/v2-gift.png');
  assert.strictEqual(h.messages[0].valueYuan, 5);
  h.service.dispose();
});

test('short room IDs resolve emote metadata while events retain the requested room ID', async () => {
  const calls = [];
  const h = setup({
    getRoomInfo: async () => ({ ok: true, roomId: 123456, ownerUid: 99 }),
    getRoomEmotes: async (room) => { calls.push(room); return { ok: true, emotes: [{ emoji: '笑', url: 'https://i0.hdslb.com/room.png' }] }; }
  });
  await h.service.connect('6');
  await tick();
  h.relay.raw(chat({ text: '[笑]' }));
  assert.deepStrictEqual(calls, ['123456']);
  assert.deepStrictEqual(h.relay.connections, ['6']);
  assert.strictEqual(h.messages[0].emotes['[笑]'].url, 'https://i0.hdslb.com/room.png');
  h.service.dispose();
});

test('switching rooms rejects old commands, statuses, and pending owner metadata', async () => {
  const oldInfo = deferred();
  const h = setup({ getRoomInfo: (room) => room === '1' ? oldInfo.promise : Promise.resolve({ ok: true, ownerUid: 22 }) });
  const first = h.service.connect('1');
  const oldListener = h.relay.previousListeners[0];
  await h.service.connect('2');
  h.relay.raw(chat({ uid: 22 }), '1');
  oldListener({ t: 'cmd', v: chat({ uid: 11 }), room: '1' });
  oldListener({ t: 'status', v: 'open', room: '1' });
  oldInfo.resolve({ ok: true, ownerUid: 11 });
  await first;
  h.relay.raw(chat({ uid: 22 }));
  assert.deepStrictEqual(h.relay.connections, ['2']);
  assert.strictEqual(h.messages.length, 1);
  assert.strictEqual(h.messages[0].role, 'host');
  assert.strictEqual(h.statuses.includes('open'), false);
  h.service.dispose();
});

test('room switches stop an active upstream before waiting for new metadata and reset gaps', async () => {
  const nextInfo = deferred();
  const h = setup({ getRoomInfo: (room) => room === '2' ? nextInfo.promise : Promise.resolve({ ok: true }) });
  await h.service.connect('1');
  h.relay.raw(chat());
  h.advance(1000);
  const switching = h.service.connect('2');
  assert.strictEqual(h.relay.room, null);
  h.relay.raw(chat(), '1');
  h.relay.raw(chat(), '2');
  nextInfo.resolve({ ok: true });
  await switching;
  h.relay.raw(chat());
  assert.strictEqual(h.messages.length, 2);
  assert.strictEqual(h.messages[1].gapMs, null);
  h.service.dispose();
});

test('same-room reconnect really restarts the relay and ignores old callbacks and emotes', async () => {
  const oldEmotes = deferred();
  let emoteRequest = 0;
  const h = setup({ getRoomEmotes: () => ++emoteRequest === 1 ? oldEmotes.promise : Promise.resolve({
    ok: true, emotes: [{ emoji: '笑', url: 'https://i0.hdslb.com/new.png' }]
  }) });
  await h.service.connect('123');
  const oldListener = h.relay.previousListeners[0];
  h.relay.raw(chat());
  h.advance(500);
  await h.service.reconnect();
  await tick();
  oldEmotes.resolve({ ok: true, emotes: [{ emoji: '笑', url: 'https://i0.hdslb.com/old.png' }] });
  await tick();
  oldListener({ t: 'cmd', v: chat(), room: '123' });
  h.relay.raw(chat({ text: '[笑]' }));
  assert.deepStrictEqual(h.relay.connections, ['123', '123']);
  assert.strictEqual(h.relay.listeners.size, 1);
  assert.strictEqual(h.messages.length, 2);
  assert.strictEqual(h.messages[1].gapMs, 500);
  assert.strictEqual(h.messages[1].emotes['[笑]'].url, 'https://i0.hdslb.com/new.png');
  h.service.dispose();
});

test('invalid rooms disconnect, and dispose cancels metadata plus all future delivery', async () => {
  const info = deferred();
  const h = setup({ getRoomInfo: () => info.promise });
  const pending = h.service.connect('1');
  const listener = h.relay.previousListeners[0];
  await h.service.connect('not a room');
  assert.strictEqual(h.statuses.at(-1), 'disconnected');
  assert.strictEqual(h.relay.listeners.size, 0);
  h.service.dispose();
  info.resolve({ ok: true, ownerUid: 99 });
  await pending;
  await h.service.connect('2');
  listener({ t: 'cmd', v: chat(), room: '1' });
  assert.deepStrictEqual(h.relay.connections, []);
  assert.deepStrictEqual(h.messages, []);
  assert.strictEqual(h.relay.room, null);
});

test('metadata failures still allow live text with packet-provided identity and emotes', async () => {
  const h = setup({ getRoomInfo: async () => { throw new Error('offline metadata'); }, getRoomEmotes: async () => { throw new Error('offline emotes'); } });
  await h.service.connect('1');
  await tick();
  h.relay.raw(chat({ uid: 99, guard: 2 }));
  assert.strictEqual(h.messages[0].role, 'admiral');
  assert.deepStrictEqual(h.relay.connections, ['1']);
  h.service.dispose();
});

test('explicit disconnect invalidates pending metadata and old listeners but permits reconnecting the saved room', async () => {
  const info=deferred();const h=setup({getRoomInfo:()=>info.promise});
  const connecting=h.service.connect('123');const stale=h.relay.previousListeners[0];
  h.service.disconnect();assert.strictEqual(h.statuses.at(-1),'disconnected');
  assert.strictEqual(h.relay.listeners.size,0);assert.strictEqual(h.relay.room,null);
  info.resolve({ok:true,roomId:'123',ownerUid:99});await connecting;await tick();
  stale({t:'cmd',room:'123',v:chat()});stale({t:'status',room:'123',v:'open'});
  await h.service.reconnect();assert.deepStrictEqual(h.relay.connections,[]);assert.deepStrictEqual(h.messages,[]);
  await h.service.connect('123');h.relay.raw(chat());assert.strictEqual(h.messages.length,1);
  h.service.disconnect();h.service.disconnect();assert.strictEqual(h.statuses.at(-1),'disconnected');
  h.service.dispose();
});

class Socket extends EventEmitter {
  constructor() { super(); this.destroyed = false; this.writes = []; }
  write(data) { this.writes.push(data); }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('close'); } }
}

function realRelayHarness(options = {}) {
  const server = new EventEmitter();
  const sockets = [];
  const events = [];
  const relay = createRelay(server, {
    getUserInfo: async () => ({ uid: 1 }),
    roomInfoFetcher: async (room) => ({ ok: true, roomId: room }),
    danmuInfoFetcher: async () => ({ ok: true, token: 'test', hosts: [{ host: 'mock.invalid' }] }),
    getCookies: () => ({}),
    connectTls: (config, ready) => {
      const socket = new Socket();
      sockets.push(socket);
      queueMicrotask(ready);
      return socket;
    },
    ...options
  });
  relay.subscribe((event) => events.push(event));
  const receive = (socket, packet) => socket.emit('data', relayProtocol.wsClientFrame(relayProtocol.buildPacket(5, JSON.stringify(packet), 1), 2));
  async function connect(room) {
    relay.connectRoom(room);
    await tick();
    const socket = sockets.at(-1);
    socket.emit('data', Buffer.from('HTTP/1.1 101 Switching Protocols\r\n\r\n'));
    return socket;
  }
  return { relay, server, sockets, events, receive, connect };
}

test('relay delivers raw commands directly without local WS clients or event JSON serialization', async () => {
  const h = realRelayHarness();
  const originalStringify = JSON.stringify;
  let eventSerializations = 0;
  JSON.stringify = function (value, ...args) {
    if (value && (value.t === 'cmd' || value.t === 'status')) eventSerializations += 1;
    return originalStringify(value, ...args);
  };
  try {
    const socket = await h.connect('123');
    h.receive(socket, chat());
    await tick();
    const command = h.events.find((event) => event.t === 'cmd');
    assert.strictEqual(command.room, '123');
    assert.strictEqual(command.v.info[1], '测试');
    assert.strictEqual(eventSerializations, 0);
  } finally {
    JSON.stringify = originalStringify;
    h.relay.shutDown();
  }
});

test('relay disconnect rejects in-flight metadata and stops retry timers without closing local consumers', async () => {
  const info=deferred();let calls=0;
  const h=realRelayHarness({roomInfoFetcher:()=>{calls++;return info.promise;}});
  try{
    h.relay.connectRoom('123');await tick();h.relay.disconnectRoom();
    info.resolve({ok:true,roomId:'123'});await tick();h.relay.reconnectCurrent();await tick();
    assert.strictEqual(h.sockets.length,0);assert.strictEqual(calls,1);
    const socket=await h.connect('123');assert.strictEqual(h.sockets.length,1);
    socket.destroy();assert.strictEqual(h.events.at(-1).v,'reconnect');
    h.relay.disconnectRoom();const stoppedCalls=calls;
    await new Promise(resolve=>setTimeout(resolve,1100));
    assert.strictEqual(calls,stoppedCalls);assert.strictEqual(h.sockets.length,1);
    assert.strictEqual(h.events.at(-1).v,'disconnected');
  }finally{h.relay.shutDown();}
});

test('legacy WebSocket clients retain their event shape and bounded replay', async () => {
  const h = realRelayHarness();
  try {
    const upstream = await h.connect('123');
    h.receive(upstream, chat());
    await tick();
    const client = new Socket();
    h.server.emit('upgrade', { url: '/relay?room=123', headers: { 'sec-websocket-key': 'test-key' } }, client);
    const messages = [];
    const reader = relayProtocol.createWebSocketReader({ onMessage: (payload) => messages.push(JSON.parse(payload.toString())) });
    for (const frame of client.writes.slice(1)) reader.push(frame);
    assert.deepStrictEqual(messages.map((message) => message.t), ['status', 'cmd']);
    assert.strictEqual(messages[1].v.info[1], '测试');
    assert.strictEqual('room' in messages[0], false);
    assert.strictEqual('room' in messages[1], false);
  } finally { h.relay.shutDown(); }
});

test('relay discards compressed packets whose decoding completes after a room switch', async () => {
  const decode = deferred();
  let parses = 0;
  const h = realRelayHarness({ parseFrames: (bytes) => ++parses === 1 ? decode.promise : biliProtocol.parseFrames(bytes) });
  try {
    const old = await h.connect('1');
    h.receive(old, chat({ text: 'old' }));
    await tick();
    const current = await h.connect('2');
    const staleFrames = await biliProtocol.parseFrames(new Uint8Array(relayProtocol.buildPacket(5, JSON.stringify(chat({ text: 'old' })), 1)));
    decode.resolve(staleFrames);
    await tick();
    h.receive(current, chat({ text: 'new' }));
    await tick();
    assert.deepStrictEqual(h.events.filter((event) => event.t === 'cmd').map((event) => [event.room, event.v.info[1]]), [['2', 'new']]);
  } finally { h.relay.shutDown(); }
});

test('relay discards old decoding after same-room reconnect and unsubscribe stops delivery', async () => {
  const decode = deferred();
  let parses = 0;
  const h = realRelayHarness({ parseFrames: (bytes) => ++parses === 1 ? decode.promise : biliProtocol.parseFrames(bytes) });
  try {
    const old = await h.connect('1');
    h.receive(old, chat({ text: 'old' }));
    await tick();
    h.relay.reconnectCurrent();
    await tick();
    const current = h.sockets.at(-1);
    current.emit('data', Buffer.from('HTTP/1.1 101 Switching Protocols\r\n\r\n'));
    decode.resolve(await biliProtocol.parseFrames(new Uint8Array(relayProtocol.buildPacket(5, JSON.stringify(chat({ text: 'old' })), 1))));
    const observed = [];
    const unsubscribe = h.relay.subscribe((event) => observed.push(event));
    unsubscribe();
    h.receive(current, chat({ text: 'new' }));
    await tick();
    assert.strictEqual(h.sockets.length, 2);
    assert.deepStrictEqual(h.events.filter((event) => event.t === 'cmd').map((event) => event.v.info[1]), ['new']);
    assert.deepStrictEqual(observed, []);
  } finally { h.relay.shutDown(); }
});

// Redacted synthetic fixtures using the public membership/transaction fields:
// Akokk0/bilibili-notify b8713162c8e02e6b8d7a6629a42e9564f06afb93,
// packages/blive/src/__tests__/fixtures/payloads.json (three renew variants).
function guardPackets(uid = 71337, payflowId = 'purchase-one', startTime = 1700000000) {
  return {
    buy: { cmd: 'GUARD_BUY', data: { uid, username: '上舰观众', guard_level: 3, gift_name: '舰长', num: 1, price: 198000, start_time: startTime, end_time: startTime } },
    toast: { cmd: 'USER_TOAST_MSG_V2', data: {
      option: { source: 0 }, sender_uinfo: { uid, base: { name: '上舰观众', face: '//i0.hdslb.com/captain.jpg' } },
      guard_info: { guard_level: 3, role_name: '舰长', start_time: startTime, end_time: startTime },
      gift_info: { gift_id: 10003 }, pay_info: { num: 1, price: 168000, unit: '月', payflow_id: payflowId }
    } },
    legacy: { cmd: 'USER_TOAST_MSG', data: { uid, username: '上舰观众', guard_level: 3, role_name: '舰长', num: 1, price: 168000, source: 0, start_time: startTime, end_time: startTime, payflow_id: payflowId } }
  };
}

test('guard buy plus paid toast updates one card to 168 with UID, avatar and captain role', async () => {
  const h = setup(); await h.service.connect('123');
  const p = guardPackets();
  h.relay.raw(p.buy);
  assert.strictEqual(h.messages.length, 1);
  assert.strictEqual(Object.hasOwn(h.messages[0], 'valueYuan'), false, 'list price 198 must never be shown as paid');
  const original = { ...h.messages[0] };
  h.advance(100); h.relay.raw(chat({ text: '中间的普通弹幕' }));
  h.advance(100); h.relay.raw(p.toast);
  assert.strictEqual(h.messages.length, 2);
  assert.strictEqual(h.updates.length, 1);
  assert.strictEqual(h.updates[0].id, '1');
  assert.strictEqual(h.messages[0].valueYuan, 168);
  assert.strictEqual(h.messages[0].uid, 71337);
  assert.strictEqual(h.messages[0].role, 'captain');
  assert.strictEqual(h.messages[0].text, '开通  舰长');
  assert.strictEqual(h.messages[0].avatarUrl, 'https://i0.hdslb.com/captain.jpg');
  for (const field of ['at', 'time', 'gapMs']) assert.strictEqual(h.messages[0][field], original[field]);
  h.advance(100); h.relay.raw(chat({ text: '后来的普通弹幕' }));
  assert.strictEqual(h.messages[2].gapMs, 200, 'a companion notification must not reset ordinary chat timing');
  h.service.dispose();
});

test('reversed guard protocols and repeated paid transaction do not duplicate or overwrite payment', async () => {
  const h = setup(); await h.service.connect('123'); const p = guardPackets();
  h.relay.raw(p.toast); h.relay.raw(p.buy); h.relay.raw(p.toast); h.relay.raw(p.legacy);
  assert.strictEqual(h.messages.length, 1);
  assert.strictEqual(h.messages[0].valueYuan, 168);
  assert.strictEqual(h.messages[0].avatarUrl, 'https://i0.hdslb.com/captain.jpg');
  h.service.dispose();
});

test('guard companion packets keep existing artwork and one paid card', async () => {
  const h = setup(); await h.service.connect('123'); const p = guardPackets();
  p.toast.data.gift_info.img_basic = '//i0.hdslb.com/captain-icon.png';
  h.relay.raw(p.toast); h.relay.raw(p.buy); h.relay.raw(p.legacy);
  assert.strictEqual(h.messages.length, 1);
  assert.strictEqual(h.messages[0].giftId, 10003);
  assert.strictEqual(h.messages[0].giftImageUrl, 'https://i0.hdslb.com/captain-icon.png');
  assert.strictEqual(h.messages[0].avatarUrl, 'https://i0.hdslb.com/captain.jpg');
  assert.strictEqual(h.messages[0].valueYuan, 168);
  h.service.dispose();
});

test('distinct transactions from one viewer remain separate even at the same timestamp', async () => {
  const h = setup(); await h.service.connect('123');
  const a = guardPackets(), b = guardPackets(71337, 'purchase-two');
  h.relay.raw(a.buy); h.relay.raw(a.toast); h.relay.raw(b.toast); h.relay.raw(b.legacy);
  assert.strictEqual(h.messages.length, 2);
  assert.deepStrictEqual(h.messages.map((message) => message.valueYuan), [168, 168]);
  h.relay.raw(guardPackets(71338, 'purchase-other-viewer').buy);
  assert.strictEqual(h.messages.length, 3, 'identical display names must not merge different UIDs');
  h.service.dispose();
  const second = setup(); await second.service.connect('123');
  second.relay.raw(a.buy); second.relay.raw(b.buy);
  assert.strictEqual(second.messages.length, 2, 'membership timestamps alone do not prove a duplicate buy');
  second.relay.raw(a.toast); second.relay.raw(b.toast);
  assert.strictEqual(second.messages.length, 2);
  assert.deepStrictEqual(second.messages.map((message) => message.valueYuan), [168, 168]);
  second.service.dispose();
});

test('unstamped guard packets pair one-to-one without discarding repeated real purchases', async () => {
  const h = setup(); await h.service.connect('123'); const p = guardPackets(71337, '', 0);
  h.relay.raw(p.buy); h.relay.raw(p.buy); h.relay.raw(p.toast); h.relay.raw(p.toast);
  assert.strictEqual(h.messages.length, 2);
  assert.deepStrictEqual(h.messages.map((message) => message.valueYuan), [168, 168]);
  assert.strictEqual(h.updates.length, 2);
  h.service.dispose();
});

test('known transaction IDs take precedence over timestamp differences across toast versions', async () => {
  const h = setup(); await h.service.connect('123'); const p = guardPackets();
  p.legacy.data.start_time += 30; p.legacy.data.end_time += 30;
  h.relay.raw(p.toast); h.relay.raw(p.legacy);
  assert.strictEqual(h.messages.length, 1);
  h.service.dispose();
});

test('guard correlation expires, stays bounded, and resets on room or connection changes', async () => {
  const h = setup(); await h.service.connect('123'); const p = guardPackets();
  h.relay.raw(p.buy); h.advance(10001); h.relay.raw(p.toast);
  assert.strictEqual(h.messages.length, 2);
  await h.service.connect('456');
  for (let i = 0; i < 129; i++) h.relay.raw(guardPackets(80000 + i, 'bound-' + i).buy);
  const count = h.messages.length;
  h.relay.raw(guardPackets(80000, 'bound-0').toast);
  assert.strictEqual(h.messages.length, count + 1, 'the oldest of 129 records must be evicted');
  h.relay.raw(guardPackets(99999).buy);
  await h.service.reconnect();
  const reconnected = h.messages.length;
  h.relay.raw(guardPackets(99999).toast);
  assert.strictEqual(h.messages.length, reconnected + 1);
  h.service.dispose();
});

test('raw V2 batches reach the scene with paid value, identity and avatar while free gifts stay filtered', async () => {
  const h = setup();
  await h.service.connect('123');
  h.relay.raw({ ...giftV2.multi, cmd: 'SEND_GIFT_V2:0:0' });
  assert.deepStrictEqual(h.messages.map(message => [message.type, message.text, message.valueYuan]), [
    ['gift', '赠送  小花花 × 2', 20], ['gift', '赠送  喵娘 × 1', 5]
  ]);
  for (const message of h.messages) {
    assert.strictEqual(message.uid, 4294967419);
    assert.strictEqual(message.uname, '协议测试观众');
    assert.strictEqual(message.role, 'captain');
    assert.strictEqual(message.medal, '陪伴 8');
    assert.strictEqual(message.avatarUrl, 'https://i0.hdslb.com/fixture-avatar.png');
  }
  assert.strictEqual(h.updates.length, 0, 'ordinary gifts never enter guard pairing');
  h.relay.raw(giftV2.single);
  assert.strictEqual(h.messages.length, 3, 'separate ordinary purchases are not merged');
  h.relay.raw(giftV2.blind);
  assert.strictEqual(h.messages[3].valueYuan, 200, 'use drawn result value rather than the box cost');
  h.service.dispose();
});

test('invalid or stale V2 gifts never suppress later valid gifts or ordinary chat', async () => {
  const h = setup();
  await h.service.connect('123');
  h.relay.raw({ cmd: 'SEND_GIFT_V2', data: { pb: 'bad!' } });
  assert.strictEqual(h.messages.length, 0);
  h.relay.raw(giftV2.single, '456');
  assert.strictEqual(h.messages.length, 0);
  h.relay.raw(chat({ text: '仍然接收' }));
  h.relay.raw(giftV2.single);
  assert.deepStrictEqual(h.messages.map(message => message.type), ['chat', 'gift']);
  h.service.dispose();
});

test('same SC source ID updates one receipt without changing its age or republishing after local removal', async () => {
  const h = setup(); await h.service.connect('12');
  const packet = { cmd: 'SUPER_CHAT_MESSAGE', data: { id: 123, uid: 7, price: 30, message: 'first', user_info: { uname: 'SC test' } } };
  h.relay.raw(packet); const original = { ...h.messages[0] }; h.advance(2000);
  h.relay.raw({ ...packet, cmd: 'SUPER_CHAT_MESSAGE:4:0', data: { ...packet.data, id: '00123', message: 'corrected', price: 50 } });
  assert.strictEqual(h.messages.length, 1); assert.strictEqual(h.updates.length, 1);
  assert.strictEqual(h.messages[0].text, 'corrected'); assert.strictEqual(h.messages[0].at, original.at);
  assert.strictEqual(h.messages[0].gapMs, original.gapMs);
  // A main-process updater rejects an expired/dismissed receipt; repeating its
  // server ID must still use that updater rather than call onMessage again.
  let publications = 0, updates = 0; const relay = mockRelay();
  const service = createLiveScene({ relay, getRoomInfo: async () => ({ ok: true }), getRoomEmotes: async () => ({}),
    onMessage: () => { publications++; return { id: 'local' }; }, onMessageUpdate: () => { updates++; return false; } });
  await service.connect('12'); relay.raw(packet); relay.raw(packet);
  assert.strictEqual(publications, 1); assert.strictEqual(updates, 1);
  service.dispose(); h.service.dispose();
});

test('SC deletion correlates local receipts, handles delete-before-arrival and resets across rooms', async () => {
  const deleted = [], h = setup({ onMessageDelete: ids => deleted.push(ids) }); await h.service.connect('12');
  const sc = id => ({ cmd: 'SUPER_CHAT_MESSAGE', data: { id, price: 30, message: 'SC', user_info: { uname: 'test' } } });
  h.relay.raw(sc(1)); h.relay.raw(sc(2));
  h.relay.raw({ cmd: 'SUPER_CHAT_MESSAGE_DELETE', data: { ids: [1, '1', 3, -1, {}, 'x', 0] } });
  assert.deepStrictEqual(deleted, [['1']]);
  h.relay.raw(sc(1)); h.relay.raw(sc(3)); assert.strictEqual(h.messages.length, 2);
  h.relay.raw({ cmd: 'SUPER_CHAT_MESSAGE_DELETE:4:0', data: { ids: ['2'] } });
  assert.deepStrictEqual(deleted, [['1'], ['2']]);
  h.relay.raw({ cmd: 'SUPER_CHAT_MESSAGE_DELETE', data: { ids: '2' } });
  await h.service.connect('34'); h.relay.raw(sc(1)); assert.strictEqual(h.messages.length, 3);
  h.service.dispose();
});

test('SC correlation and deletion tombstones stay bounded and never guess identity without a valid ID', async () => {
  const h = setup(); await h.service.connect('12');
  const sc = id => ({ cmd: 'SUPER_CHAT_MESSAGE', data: { id, price: 30, message: 'same', user_info: { uname: 'test' } } });
  h.relay.raw(sc(1));
  h.relay.raw({ cmd: 'SUPER_CHAT_MESSAGE_DELETE', data: { ids: Array.from({ length: 4097 }, (_, i) => i + 2) } });
  h.relay.raw(sc(1)); assert.strictEqual(h.messages.length, 2, 'oldest correlation may be evicted at the explicit cap');
  h.relay.raw(sc(4097)); assert.strictEqual(h.messages.length, 2, 'retained deletion tombstone suppresses late arrival');
  h.relay.raw(sc(4098)); assert.strictEqual(h.messages.length, 3, 'oversized delete arrays stop at the cap');
  for (const id of [null, undefined, -1, {}, 'x', '1'.repeat(33)]) { h.relay.raw(sc(id)); h.relay.raw(sc(id)); }
  assert.strictEqual(h.messages.length, 15); h.service.dispose();
});

test('relay bounds a stalled decoder queue and discards queued old data after overload', async () => {
  const decode = deferred(); let parses = 0;
  const h = realRelayHarness({ parseFrames: () => { parses++; return decode.promise; } });
  try {
    const socket = await h.connect('12'); h.receive(socket, chat()); await tick();
    for (let index = 0; index <= 4096; index++) h.receive(socket, chat());
    assert.strictEqual(socket.destroyed, true); assert.strictEqual(h.events.at(-1).v, 'reconnect');
    decode.resolve({ frames: [{ op: 5, body: Buffer.from(JSON.stringify(chat())) }], rest: new Uint8Array() });
    await tick(); assert.strictEqual(parses, 1); assert.strictEqual(h.events.some(event => event.t === 'cmd'), false);
  } finally { h.relay.shutDown(); }
});

test('silent TLS/upgrade/auth connections time out and connection timers are released on stop or auth success', async () => {
  for (const phase of ['tls', 'upgrade', 'auth', 'open']) {
    const timers = new Map(); let nextId = 0;
    let pendingTlsSocket;
    const h = realRelayHarness({ setTimer: (run, delay) => { const id = ++nextId; timers.set(id, { run, delay }); return id; },
      ...(phase === 'tls' ? { connectTls: () => { pendingTlsSocket = new Socket(); return pendingTlsSocket; } } : {}),
      clearTimer: id => timers.delete(id) });
    try {
      h.relay.connectRoom('12'); await tick(); const socket = h.sockets[0] || pendingTlsSocket;
      assert.strictEqual(timers.size, 1); assert.strictEqual([...timers.values()][0].delay, 35000);
      if (phase === 'auth' || phase === 'open') socket.emit('data', Buffer.from('HTTP/1.1 101 Switching Protocols\r\n\r\n'));
      if (phase === 'open') {
        socket.emit('data', relayProtocol.wsClientFrame(relayProtocol.buildPacket(8, JSON.stringify({ code: 0 }), 1), 2));
        await tick(); assert.strictEqual(timers.size, 0); assert.strictEqual(socket.destroyed, false);
      } else {
        const [id, timer] = [...timers][0]; timers.delete(id); timer.run();
        assert.strictEqual(socket.destroyed, true); assert.strictEqual(h.events.at(-1).v, 'reconnect');
      }
    } finally { h.relay.shutDown(); assert.strictEqual(timers.size, 0); }
  }
});

test('synchronous TLS setup failure retries instead of becoming an unhandled rejection', async () => {
  const timers = new Map(); let nextId = 0;
  const h = realRelayHarness({ connectTls: () => { throw new Error('Invalid TLS setup'); },
    setTimer: (run, delay) => { const id = ++nextId; timers.set(id, { run, delay }); return id; },
    clearTimer: id => timers.delete(id) });
  try {
    h.relay.connectRoom('12'); await tick();
    assert.strictEqual(h.events.at(-1).v, 'reconnect'); assert.strictEqual(timers.size, 1);
  } finally { h.relay.shutDown(); assert.strictEqual(timers.size, 0); }
});

test('stalled legacy WebSockets stop growing while healthy clients and the desktop stream keep receiving', async () => {
  const h = realRelayHarness();
  try {
    const upstream = await h.connect('12');
    const slow = new Socket(), healthy = new Socket();
    slow.writableLength = 0; slow.writeCount = 0;
    slow.write = function(data) { this.writableLength += Buffer.byteLength(data); this.writeCount++; return false; };
    healthy.writableLength = 0; healthy.writeCount = 0;
    healthy.write = function() { this.writeCount++; return false; };
    for (const socket of [slow, healthy]) h.server.emit('upgrade', { url: '/relay?room=12', headers: { 'sec-websocket-key': 'test' } }, socket);
    for (let i = 0; i < 100; i++) { h.receive(upstream, chat({ text: 'x'.repeat(64 * 1024) })); await tick(); }
    assert.equal(slow.destroyed, true); assert.ok(slow.writableLength < 1150 * 1024);
    assert.equal(healthy.destroyed, false, 'write(false) below the byte cap is ordinary backpressure');
    assert.equal(healthy.writeCount, 102); assert.equal(h.events.filter(event => event.t === 'cmd').length, 100);
    const stopped = slow.writeCount; h.receive(upstream, chat({ text: 'after overflow' })); await tick();
    assert.equal(slow.writeCount, stopped); assert.equal(healthy.writeCount, 103);
  } finally { h.relay.shutDown(); }
});

test('an oversized replay item still reaches live consumers and later normal replay remains available', async () => {
  const h = realRelayHarness();
  try {
    const upstream = await h.connect('12');
    h.receive(upstream, chat({ text: 'x'.repeat(8 * 1024 * 1024 + 1) })); await tick();
    assert.equal(h.events.filter(event => event.t === 'cmd').length, 1);
    const first = new Socket(); h.server.emit('upgrade', { url: '/relay?room=12', headers: { 'sec-websocket-key': 'test' } }, first);
    assert.equal(first.writes.length, 2, 'oversized history must not be retained for a future viewer'); first.destroy();
    h.receive(upstream, chat({ text: 'replay recovered' })); await tick();
    const second = new Socket(); h.server.emit('upgrade', { url: '/relay?room=12', headers: { 'sec-websocket-key': 'test' } }, second);
    const received = []; const reader = relayProtocol.createWebSocketReader({ onMessage: body => received.push(JSON.parse(body.toString())) });
    for (const frame of second.writes.slice(1)) reader.push(frame);
    assert.deepEqual(received.filter(event => event.t === 'cmd').map(event => event.v.info[1]), ['replay recovered']);
  } finally { h.relay.shutDown(); }
});

(async () => {
  for (const { name, run } of tests) {
    await run();
    console.log('PASS ' + name);
  }
  console.log('Live scene tests passed: ' + tests.length);
})().catch((error) => { console.error(error); process.exitCode = 1; });
