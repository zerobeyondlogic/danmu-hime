'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { createLiveScene } = require('../desktop/live-scene.js');
const { createRelay, _test: relayProtocol } = require('../relay.js');
const { _test: biliProtocol } = require('../js/protocol.js');

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
  const statuses = [];
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
    onMessage: (message) => messages.push(message),
    onStatus: (status) => statuses.push(status),
    now: () => timestamp,
    ...options
  });
  return { relay, messages, statuses, roomCalls, emoteCalls, service, advance: (ms) => { timestamp += ms; } };
}

function chat({ uid = 7, uname = '测试用户', text = '测试', manager = 0, guard = 0, flags = [], medal = [] } = {}) {
  return { cmd: 'DANMU_MSG:4:0:2:2:2:0', info: [flags, text, [uid, uname, manager], medal, [], [], [], guard] };
}

const tests = [];
function test(name, run) { tests.push({ name, run }); }

test('service stays lazy and has no renderer or bitmap-font dependency', async () => {
  const h = setup();
  await tick();
  assert.deepStrictEqual(h.roomCalls, []);
  assert.deepStrictEqual(h.emoteCalls, []);
  assert.strictEqual(h.relay.listeners.size, 0);
  assert.strictEqual(h.relay.disconnects, 0);
  assert.strictEqual(Object.keys(require.cache).some((file) => file.endsWith('pixel-font.js')), false);
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
    ['gift', 'gift', 30], ['sc', 'sc', 50], ['gift', 'guard', 276], ['gift', 'guard', 1998]
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

(async () => {
  for (const { name, run } of tests) {
    await run();
    console.log('PASS ' + name);
  }
  console.log('Live scene tests passed: ' + tests.length);
})().catch((error) => { console.error(error); process.exitCode = 1; });
