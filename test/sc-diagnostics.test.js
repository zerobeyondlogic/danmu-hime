'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { createScDiagnostics, incrementCount } = require('../desktop/sc-diagnostics.js');
const { createLiveScene } = require('../desktop/live-scene.js');
const themes = require('../desktop/themes.js');
const plain = value => JSON.parse(JSON.stringify(value));
const scPacket = (price = 2) => ({ cmd: 'SUPER_CHAT_MESSAGE', data: {
  uid: 777, price, message: 'PRIVATE MESSAGE', user_info: { uname: 'PRIVATE NAME' }
} });

let passed = 0;
async function test(name, run) { await run(); passed++; console.log('PASS ' + name); }

function mockRelay() {
  let listener = null, room = '';
  return {
    subscribe(fn) { listener = fn; return () => { listener = null; }; },
    connectRoom(id) { room = id; }, disconnectRoom() { room = ''; },
    raw(v, sourceRoom = room) { if (listener) listener({ t: 'cmd', room: sourceRoom, v }); },
    status(v) { if (listener) listener({ t: 'status', room, v }); }
  };
}

// Evaluate the real main process and its actual createLiveScene wiring against
// a mock relay/clock. No native window, account, filesystem write or HTTP server.
function mainHarness() {
  let at = 1789120000000, timerId = 0;
  const timers = new Map(), relay = mockRelay();
  const app = new EventEmitter();
  Object.assign(app, { isPackaged: true, requestSingleInstanceLock: () => true,
    whenReady: () => ({ then: () => ({ catch() {} }) }), getVersion: () => 'test' });
  const publisher = { relay, publishDesktopOutput() {},
    getRoomInfo: async room => ({ ok: true, roomId: room }),
    getRoomEmotes: async () => ({ ok: true, emotes: [] }) };
  const mainPath = path.join(__dirname, '../desktop/main.js');
  const mainSource = fs.readFileSync(mainPath, 'utf8');
  const localRequire = createRequire(mainPath);
  const wiring = mainSource.match(/liveScene = createLiveScene\(\{[\s\S]*?\n    \}\);/);
  assert.ok(wiring, 'actual production live-scene callback wiring must be exercised');
  const context = {
    require: id => id === 'electron' ? { app,
      BrowserWindow: class { constructor() { throw new Error('Test cannot create a window'); } }
    } : id === 'fs' ? { mkdirSync() {}, writeFileSync() {}, renameSync() {} } : localRequire(id),
    __dirname: path.dirname(mainPath), process: { platform: 'win32' },
    console: { log() {}, warn() {}, error() {} },
    Date: class extends Date { static now() { return at; } },
    setTimeout: (run, delay) => { const id = ++timerId; timers.set(id, { run, at: at + delay }); return id; },
    clearTimeout: id => timers.delete(id)
  };
  vm.runInNewContext(mainSource + `
    globalThis.scDiagnosticTest = {
      initialize(publisher, settings) {
        embedded = publisher; appState.settings = settings;
        syncScExpirySettings(); ${wiring[0]}
      },
      connect: connectDesktopRoom, disconnect: disconnectDesktopRoom,
      output: outputState, scene: sceneSnapshot, remove: dismissSceneMessage,
      dispose() { liveScene.dispose(); scExpiry.dispose(); messagePlayback.dispose();
        if (saveTimer) clearTimeout(saveTimer); }
    };
  `, context, { filename: mainPath });
  const api = context.scDiagnosticTest;
  api.initialize(publisher, { theme: 'glass', previewEnabled: false,
    themeConfigs: { glass: { ...themes.defaults.glass, scNeverExpire: false } } });
  function advance(ms) {
    const end = at + ms;
    for (let index = 0; index < 10000; index++) {
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) { at = end; return; }
      timers.delete(next[0]); at = next[1].at; next[1].run();
    }
    throw new Error('Timer loop');
  }
  async function connect(room) { assert.equal(api.connect(room), true); await new Promise(setImmediate); }
  return { api, relay, timers, advance, connect, snapshot: () => plain(api.output().scDiagnostics) };
}

(async () => {
  await test('events retain only bounded diagnostic metadata and reject unknown stages', () => {
    const d = createScDiagnostics({ now: () => 123 });
    assert.equal(d.record({ stage: 'ordinary-chat', text: 'PRIVATE' }), false);
    d.record({ stage: 'parsed', command: 'SUPER_CHAT_MESSAGE:4:0', room: '123', amount: 30,
      uid: 777, uname: 'PRIVATE NAME', text: 'PRIVATE MESSAGE', payload: scPacket(), cookie: 'PRIVATE COOKIE' });
    assert.deepEqual(d.getSnapshot().events, [{ at: 123, stage: 'parsed', command: 'SUPER_CHAT_MESSAGE:4:0', room: '123', amount: 30 }]);
    assert.equal(d.getSnapshot().total, 1);
    assert.equal(JSON.stringify(d.getSnapshot()).includes('PRIVATE'), false);
  });

  await test('the ring retains only the newest 32 events in order while preserving fixed counters', () => {
    let at = 0; const d = createScDiagnostics({ now: () => at++ });
    for (let index = 0; index < 10000; index++) d.record({ stage: 'raw', command: 'SUPER_CHAT_MESSAGE' });
    const s = d.getSnapshot(); assert.equal(s.events.length, 32);
    assert.equal(s.events[0].at, 9968); assert.equal(s.events.at(-1).at, 9999);
    assert.equal(s.counts.raw, 10000); assert.equal(s.total, 10000);
    assert.equal(Object.keys(s.counts).length, 9);
  });

  await test('snapshots cannot mutate collector counters, order or retained event fields', () => {
    const d = createScDiagnostics({ now: () => 1 }); d.record({ stage: 'raw', room: '12' });
    const s = d.getSnapshot(); s.events[0].room = '99'; s.events.length = 0; s.counts.raw = -1;
    assert.equal(d.getSnapshot().events[0].room, '12'); assert.equal(d.getSnapshot().counts.raw, 1);
  });

  await test('invalid or unbounded command, room, identity, reason and status values are omitted', () => {
    const d = createScDiagnostics({ now: () => 1 });
    d.record({ stage: 'raw', command: 'SUPER_CHAT_' + 'A'.repeat(10000), room: 'x'.repeat(10000),
      messageId: 'PRIVATE UID', status: 'PRIVATE STATUS', reason: 'PRIVATE REASON' });
    assert.deepEqual(d.getSnapshot().events[0], { at: 1, stage: 'raw' });
    d.record({ stage: 'connection', room: 12, status: 'open', reason: 'connect' });
    assert.equal(d.getSnapshot().events[1].room, '12');
  });

  await test('amounts and timestamps remain finite bounded numbers', () => {
    for (const amount of [NaN, Infinity, -1, Number.MAX_VALUE, '30', {}, null]) {
      const d = createScDiagnostics({ now: () => NaN }); d.record({ stage: 'parsed', amount });
      assert.deepEqual(d.getSnapshot().events[0], { at: 0, stage: 'parsed' });
    }
    const d = createScDiagnostics({ now: () => Number.MAX_VALUE });
    d.record({ stage: 'published', amount: 0, messageId: '123' });
    assert.equal(d.getSnapshot().events[0].at, Number.MAX_SAFE_INTEGER);
    assert.equal(d.getSnapshot().events[0].amount, 0);
  });

  await test('cumulative counters saturate without wrapping or growing beyond safe integers', () => {
    assert.equal(incrementCount(0), 1);
    assert.equal(incrementCount(Number.MAX_SAFE_INTEGER - 1), Number.MAX_SAFE_INTEGER);
    assert.equal(incrementCount(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
  });

  await test('no observer and a failing observer both preserve normal live-scene delivery', async () => {
    for (const onDiagnostic of [undefined, () => { throw Error('observer failed'); }]) {
      const relay = mockRelay(), messages = [];
      const scene = createLiveScene({ relay, getRoomInfo: async () => ({ ok: true }),
        getRoomEmotes: async () => ({ ok: true, emotes: [] }), onMessage: message => messages.push(message), onDiagnostic });
      await scene.connect('12'); relay.raw(scPacket(30));
      assert.equal(messages.length, 1); assert.equal(messages[0].type, 'sc'); scene.dispose();
    }
  });

  await test('actual main wiring distinguishes absent SC, unsupported raw SC, published SC and expiry', async () => {
    const h = mainHarness(); await h.connect('12');
    const before = h.snapshot(), timersBefore = h.timers.size;
    for (let index = 0; index < 1000; index++) h.relay.raw({ cmd: 'DANMU_MSG', info: [[], 'ordinary', [1, 'name']] });
    assert.deepEqual(h.snapshot(), before, 'ordinary chat must not generate diagnostics');
    assert.equal(h.timers.size, timersBefore, 'diagnostics must not create timers');
    assert.equal(h.snapshot().counts.raw, 0);
    h.relay.raw({ ...scPacket(), cmd: 'SUPER_CHAT_MESSAGE_JPN' });
    assert.equal(h.snapshot().counts.raw, 1); assert.equal(h.snapshot().counts.dropped, 1);
    assert.equal(h.snapshot().events.at(-1).reason, 'unsupported-command');
    h.relay.raw({ ...scPacket(), cmd: 'SUPER_CHAT_MESSAGE:4:0' });
    let s = h.snapshot(); assert.equal(s.counts.parsed, 1); assert.equal(s.counts.published, 1);
    assert.deepEqual(s.events.slice(-3).map(event => event.stage), ['raw', 'parsed', 'published']);
    const id = h.api.scene().messages.find(message => message.type === 'sc').id;
    assert.equal(s.events.at(-1).messageId, id); assert.equal(s.events.at(-1).amount, 2);
    h.advance(5000); s = h.snapshot(); assert.equal(s.counts.expired, 1);
    assert.equal(s.events.at(-1).messageId, id);
    const archived = h.api.scene().messages.find(message => message.id === id);
    assert.equal(archived.type, 'sc'); assert.equal(archived.scPinned, false);
    assert.equal(JSON.stringify(s).includes('PRIVATE'), false); h.api.dispose();
  });

  await test('actual main wiring distinguishes manual unpinning from deletion, reconnect, room switch and disconnect', async () => {
    const h = mainHarness(); await h.connect('12'); h.relay.raw(scPacket(30));
    let id = h.api.scene().messages[0].id; assert.equal(h.api.remove(id), true);
    assert.equal(h.snapshot().counts.unpinned, 1); assert.equal(h.api.remove(id), false);
    assert.equal(h.snapshot().counts.unpinned, 1); assert.equal(h.snapshot().counts.removed, 0);
    assert.equal(h.api.scene().messages[0].scPinned, false); assert.equal(h.api.scene().messages[0].id, id);
    h.relay.raw(scPacket(30)); h.relay.status('reconnect');
    assert.equal(h.snapshot().events.at(-1).reason, 'reconnect');
    assert.equal(h.api.scene().messages.length, 0);
    await h.connect('34'); let s = h.snapshot();
    assert.ok(s.events.some(event => event.stage === 'clear' && event.reason === 'room-switch' && event.room === '34'));
    assert.ok(s.events.some(event => event.stage === 'connection' && event.reason === 'room-switch' && event.room === '34'));
    h.relay.raw(scPacket(30)); const count = h.snapshot().counts.raw;
    h.relay.raw(scPacket(), '12'); assert.equal(h.snapshot().counts.raw, count, 'old-room packets are not accepted arrivals');
    const clears = h.snapshot().counts.clear; h.api.disconnect(); s = h.snapshot();
    assert.equal(s.events.at(-1).reason, 'disconnect'); assert.equal(s.events.at(-1).room, '34');
    assert.equal(s.counts.clear, clears); assert.equal(h.api.scene().messages.length, 1);
    h.api.dispose();
  });

  console.log(passed + ' SC diagnostic tests passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
