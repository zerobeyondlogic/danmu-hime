'use strict';

const assert = require('assert');
const { _test } = require('../relay.js');

const { buildPacket, createWebSocketReader, wsClientFrame, isReplayableCommand, createCommandHistory } = _test;

let passed = 0;
function ok(name) {
  passed += 1;
  console.log('PASS ' + name);
}

function unmaskedFrame(payload, opcode, fin) {
  const data = Buffer.from(payload);
  const first = (fin === false ? 0 : 0x80) | (opcode === undefined ? 0x2 : opcode);
  let header;
  if (data.length < 126) {
    header = Buffer.from([first, data.length]);
  } else {
    header = Buffer.alloc(4);
    header[0] = first;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  }
  return Buffer.concat([header, data]);
}

{
  const messages = [];
  const errors = [];
  const reader = createWebSocketReader({
    onMessage: (payload, opcode) => messages.push({ payload, opcode }),
    onError: (e) => errors.push(e)
  });
  const frame = wsClientFrame(Buffer.from('masked payload'), 0x2);
  reader.push(frame.slice(0, 1));
  reader.push(frame.slice(1, 7));
  reader.push(frame.slice(7));
  assert.strictEqual(errors.length, 0);
  assert.strictEqual(messages.length, 1);
  assert.strictEqual(messages[0].opcode, 0x2);
  assert.strictEqual(messages[0].payload.toString(), 'masked payload');
  ok('masked WebSocket frame split across TCP chunks');
}

{
  const messages = [];
  const reader = createWebSocketReader({
    onMessage: (payload, opcode) => messages.push({ payload, opcode }),
    onError: (e) => assert.fail(e.message)
  });
  const first = unmaskedFrame('hello ', 0x2, false);
  const second = unmaskedFrame('world', 0x0, true);
  reader.push(Buffer.concat([first, second]));
  assert.strictEqual(messages.length, 1);
  assert.strictEqual(messages[0].opcode, 0x2);
  assert.strictEqual(messages[0].payload.toString(), 'hello world');
  ok('WebSocket continuation frames reassembled');
}

{
  const messages = [];
  const longPayload = Buffer.alloc(300, 0x61);
  const reader = createWebSocketReader({
    onMessage: (payload) => messages.push(payload),
    onError: (e) => assert.fail(e.message)
  });
  reader.push(Buffer.concat([
    unmaskedFrame(longPayload, 0x2),
    unmaskedFrame('next', 0x1)
  ]));
  assert.strictEqual(messages.length, 2);
  assert.deepStrictEqual(messages[0], longPayload);
  assert.strictEqual(messages[1].toString(), 'next');
  ok('multiple extended-length WebSocket frames in one TCP chunk');
}

{
  let ping = null;
  const reader = createWebSocketReader({
    onPing: (payload) => {
      ping = payload;
    },
    onError: (e) => assert.fail(e.message)
  });
  reader.push(wsClientFrame(Buffer.from('keepalive'), 0x9));
  assert.strictEqual(ping.toString(), 'keepalive');
  ok('masked WebSocket ping decoded');
}

{
  const biliHeartbeat = buildPacket(2, '{}', 1);
  let decoded = null;
  const reader = createWebSocketReader({
    onMessage: (payload) => {
      decoded = payload;
    },
    onError: (e) => assert.fail(e.message)
  });
  const framed = wsClientFrame(biliHeartbeat, 0x2);
  assert.strictEqual((framed[0] & 0x0f), 0x2);
  assert.strictEqual((framed[1] & 0x80), 0x80);
  reader.push(framed);
  assert.deepStrictEqual(decoded, biliHeartbeat);
  assert.strictEqual(decoded.readUInt32BE(8), 2);
  ok('Bilibili heartbeat wrapped in masked WebSocket binary frame');
}

{
  const errors = [];
  const reader = createWebSocketReader({
    onError: (e) => errors.push(e.message)
  });
  reader.push(unmaskedFrame('orphan', 0x0));
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0], /continuation/);
  ok('orphan continuation frame rejected');
}

{
  assert.strictEqual(isReplayableCommand({ cmd: 'DANMU_MSG:4:0:2:2:2:0' }), true);
  assert.strictEqual(isReplayableCommand({ cmd: 'SEND_GIFT' }), true);
  assert.strictEqual(isReplayableCommand({ cmd: 'SEND_GIFT_V2:0:0' }), true);
  assert.strictEqual(isReplayableCommand({ cmd: 'ONLINE_RANK_COUNT' }), false);
  ok('only visible chat commands are replayable');
}

{
  const history = createCommandHistory(2);
  history.add({ cmd: 'ONLINE_RANK_COUNT', data: { count: 1 } });
  history.add({ cmd: 'DANMU_MSG', info: [[], 'first'] });
  history.add({ cmd: 'SEND_GIFT', data: { giftName: 'flower' } });
  history.add({ cmd: 'SUPER_CHAT_MESSAGE', data: { message: 'third' } });
  assert.deepStrictEqual(history.snapshot().map((item) => item.cmd), ['SEND_GIFT', 'SUPER_CHAT_MESSAGE']);
  history.add({ cmd: 'SEND_GIFT_V2', data: { pb: 'AQ==' } });
  assert.deepStrictEqual(history.snapshot().map((item) => item.cmd), ['SUPER_CHAT_MESSAGE', 'SEND_GIFT_V2']);
  history.clear();
  assert.deepStrictEqual(history.snapshot(), []);
  ok('visible command history is bounded and clearable');
}

{
  const history = createCommandHistory(4);
  history.add({ cmd: 'SUPER_CHAT_MESSAGE', data: { id: 12, message: 'original' } });
  history.add({ cmd: 'SUPER_CHAT_MESSAGE:4:0', data: { id: '0012', message: 'updated' } });
  history.add({ cmd: 'SUPER_CHAT_MESSAGE', data: { id: 13, message: 'different' } });
  assert.deepStrictEqual(history.snapshot().map(item => item.data.message), ['updated', 'different']);
  history.add({ cmd: 'SUPER_CHAT_MESSAGE_DELETE', data: { ids: [12, '13'] } });
  history.add({ cmd: 'SUPER_CHAT_MESSAGE', data: { id: 12, message: 'late repeat' } });
  assert.deepStrictEqual(history.snapshot(), []);
  history.clear(); history.add({ cmd: 'SUPER_CHAT_MESSAGE', data: { id: 12, message: 'new room' } });
  assert.strictEqual(history.snapshot().length, 1);
  ok('legacy replay neither duplicates repeated SC IDs nor resurrects already-deleted messages');
}

{
  const { EventEmitter } = require('events');
  const server = new EventEmitter(); let roomRequests = 0;
  const relay = require('../relay.js').createRelay(server, {
    getUserInfo: async () => null, getCookies: () => ({}),
    roomInfoFetcher: async () => { roomRequests++; return { ok: false }; },
    danmuInfoFetcher: async () => ({ ok: false })
  });
  const makeSocket = () => Object.assign(new EventEmitter(), {
    destroyed: false, writes: [], write(value) { this.writes.push(value); },
    destroy() { this.destroyed = true; this.emit('close'); }
  });
  const foreign = makeSocket();
  server.emit('upgrade', { url: '/relay?room=123', headers: { origin: 'https://example.invalid', host: '127.0.0.1:3000', 'sec-websocket-key': 'test' } }, foreign);
  assert.equal(foreign.destroyed, true); assert.equal(roomRequests, 0); assert.equal(foreign.writes.length, 0);
  const local = makeSocket();
  server.emit('upgrade', { url: '/relay', headers: { origin: 'http://127.0.0.1:3000', host: '127.0.0.1:3000', 'sec-websocket-key': 'test' } }, local);
  assert.equal(local.destroyed, false); assert.ok(local.writes.length >= 2);
  relay.shutDown();
  ok('foreign web pages cannot change the room through a local WebSocket');
}

{
  const history = createCommandHistory(48, 300);
  const item = id => ({ cmd: 'DANMU_MSG', info: [[], String(id) + 'x'.repeat(80)] });
  history.add(item(1)); history.add(item(2));
  const before = history.snapshot();
  history.add({ cmd: 'DANMU_MSG', info: [[], 'x'.repeat(500)] });
  assert.deepEqual(history.snapshot(), before, 'one oversized command must not flush otherwise useful replay');
  for (let id = 3; id <= 1000; id++) history.add(item(id));
  assert.ok(history.getStats().bytes <= 300);
  assert.equal(history.getStats().bytes, history.snapshot().reduce((bytes, value) => bytes + Buffer.byteLength(JSON.stringify(value)), 0));
  assert.equal(history.snapshot().at(-1).info[1], item(1000).info[1], 'normal replay recovers after rejection and repeated eviction');
  history.clear(); assert.deepEqual(history.getStats(), { size: 0, bytes: 0 });
  history.add({ cmd: 'SUPER_CHAT_MESSAGE', data: { id: 1, message: 'original' } });
  history.add({ cmd: 'SUPER_CHAT_MESSAGE', data: { id: '1', message: 'updated content' } });
  assert.equal(history.getStats().size, 1);
  assert.equal(history.getStats().bytes, Buffer.byteLength(JSON.stringify(history.snapshot()[0])));
  history.add({ cmd: 'SUPER_CHAT_MESSAGE_DELETE', data: { ids: [1] } });
  assert.deepEqual(history.getStats(), { size: 0, bytes: 0 });
  ok('replay byte budget bounds retained data and recovers after oversized packets, SC correction and deletion');
}

console.log('全部通过: ' + passed + ' 项');
