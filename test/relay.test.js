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
  history.clear();
  assert.deepStrictEqual(history.snapshot(), []);
  ok('visible command history is bounded and clearable');
}

console.log('全部通过: ' + passed + ' 项');
