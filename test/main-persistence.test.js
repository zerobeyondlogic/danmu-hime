'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const themes = require('../desktop/themes.js');
const { createScAlerts } = require('../desktop/sc-alerts.js');
const mainPath = path.join(__dirname, '../desktop/main.js');
const source = fs.readFileSync(mainPath, 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

function harness() {
  const profile = path.join('D:/mock-main-persistence', 'desktop-state.json');
  const disk = new Map(), timers = new Map(), writes = [], handlers = new Map(), published = [], notifications = [];
  let failure = null, time = 1789120000000, timerId = 0, opened = 0, listener = null, beforeRename = null;
  const initial = {
    dimensionModelVersion: 7, closeAction: 'tray', controlAppearance: { theme: 'light', opacity: 83 },
    settings: themes.migrateSettings({ theme: 'glass', roomId: '123', previewEnabled: false,
      themeConfigs: { glass: { scNeverExpire: true, messageFont: 31, fullCardsOnly: false }, portrait: { portraitWidth: 64, emoteScale: 150 } } }),
    requestedPreviewSize: { width: 515, height: 650 }, previewSize: { width: 515, height: 650 },
    overlayBounds: { x: 42, y: 68, width: 515, height: 650 }, marker: 'complete old profile',
    stylePresets: [{ id: 'retained', name: '原有预设', theme: 'portrait', width: 611, height: 799, config: { ...themes.defaults.portrait, portraitWidth: 64 } }]
  };
  disk.set(profile, JSON.stringify(initial, null, 2));
  const mockFs = {
    readFileSync(filename) { if (!disk.has(filename)) throw Error('Missing in-memory profile'); return disk.get(filename); },
    mkdirSync() {},
    writeFileSync(filename, content) {
      writes.push({ kind: 'write', filename });
      if (failure === 'partial-write') { disk.set(filename, String(content).slice(0, 37)); throw Error('disk became full during write'); }
      disk.set(filename, content);
    },
    renameSync(from, to) {
      writes.push({ kind: 'rename', from, to });
      if (failure === 'rename') throw Error('destination file locked');
      if (beforeRename) beforeRename();
      disk.set(to, disk.get(from)); disk.delete(from);
    },
    unlinkSync: filename => disk.delete(filename)
  };
  const relay = {
    subscribe(callback) { listener = callback; return () => { listener = null; }; },
    connectRoom(room) { if (listener) listener({ t: 'status', v: 'open', room }); }, disconnectRoom() {},
    raw(packet) { if (listener) listener({ t: 'cmd', v: packet, room: '123' }); }
  };
  const embedded = { relay, getRoomInfo: async () => ({ ok: true, roomId: '123', ownerUid: 0 }),
    getRoomEmotes: async () => ({ ok: true, emotes: [] }),
    publishDesktopOutput(type, value) { published.push({ type, value: plain(typeof value === 'function' ? value() : value) }); } };
  const alerts = createScAlerts({ hasPreview: () => false, onOpen: () => { opened++; }, createNotification(options) {
    const notification = new EventEmitter(); Object.assign(notification, { options, closed: 0, show() {}, close() { this.closed++; this.emit('close'); } });
    notifications.push(notification); return notification;
  } });
  const app = new EventEmitter();
  Object.assign(app, { isPackaged: true, requestSingleInstanceLock: () => true,
    whenReady: () => ({ then: () => ({ catch() {} }) }), getVersion: () => 'test', getPath: () => 'D:/mock-main-persistence' });
  const control = { isDestroyed: () => false, webContents: { send() {} } };
  const localRequire = createRequire(mainPath);
  const context = {
    require: id => id === 'fs' ? mockFs : id === 'electron' ? {
      app, BrowserWindow: class { constructor() { throw Error('Test must not create windows'); } },
      ipcMain: { handle: (name, fn) => handlers.set(name, fn), on() {} }
    } : localRequire(id),
    __dirname: path.dirname(mainPath), process: { platform: 'win32' },
    console: { log() {}, warn() {}, error() {} },
    Date: class extends Date { static now() { return time; } },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, at: time + delay }); return id; },
    clearTimeout: id => timers.delete(id)
  };
  // Execute the actual startup callback wiring, including onMessageDelete,
  // without starting Electron, a server, notifications or a real room.
  const wiringStart = source.indexOf('liveScene = createLiveScene({');
  const wiringEnd = source.indexOf('\n    });', wiringStart) + '\n    });'.length;
  assert.ok(wiringStart > 0 && wiringEnd > wiringStart, 'live-scene wiring must exist');
  const wiring = source.slice(wiringStart, wiringEnd);
  vm.runInNewContext(source + `
    globalThis.persistenceTest = {
      initialize(control,publisher,alerts) { controlWindow=control;embedded=publisher;scAlerts=alerts;loadState();bindIpc(); },
      state:()=>appState, snapshot:sceneSnapshot, receive:receiveLiveMessage, expiry:()=>scExpiry.getState(), diagnostics:()=>scDiagnostics.getSnapshot(),
      update:updateSceneMessage, remove:dismissSceneMessage, clear:clearScene, setActive:value=>messagePlayback.setActive(value),
      save:saveStateNow, soon:saveStateSoon, reload:loadState, setMarker(value){appState.marker=value;},
      presetBusy(value){stylePresetApplying=value;},
      startLive(){${wiring} return liveScene.connect('123');},
      dispose(){if(liveScene)liveScene.dispose();scExpiry.dispose();messagePlayback.dispose();scAlerts.dispose();if(saveTimer)clearTimeout(saveTimer);}
    };`, context, { filename: mainPath });
  const api = context.persistenceTest; api.initialize(control, embedded, alerts);
  function advance(ms) {
    const target = time + ms;
    for (let i = 0; i < 10000; i++) {
      const due = [...timers].filter(([, entry]) => entry.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) { time = target; return; }
      timers.delete(due[0]); time = due[1].at; due[1].fn();
    }
    throw Error('Unexpected timer loop');
  }
  return { api, profile, disk, timers, writes, published, notifications, relay, advance, opened: () => opened,
    fail: value => { failure = value; }, onRename: callback => { beforeRename = callback; }, settings: () => plain(api.state().settings),
    call: (name, ...args) => handlers.get('desktop:' + name)({ sender: control.webContents }, ...args) };
}

const cases = [];
const test = (name, run) => cases.push({ name, run });
test('immediate and delayed saves preserve the complete profile on partial temporary writes or failed rename', () => {
  for (const failure of ['partial-write', 'rename']) for (const delayed of [false, true]) {
    const h = harness(), oldFile = h.disk.get(h.profile); h.fail(failure); h.api.setMarker('new unsaved marker');
    if (delayed) { h.api.soon(); h.advance(150); } else assert.equal(h.api.save(), false);
    assert.equal(h.disk.get(h.profile), oldFile, failure + '/' + delayed);
    assert.deepEqual(JSON.parse(h.disk.get(h.profile)), JSON.parse(oldFile));
    assert.equal(h.disk.has(h.profile + '.tmp'), false);
    assert.ok(h.writes.filter(item => item.kind === 'write').every(item => item.filename === h.profile + '.tmp'));
    h.fail(null); h.api.reload(); assert.equal(h.api.state().marker, 'complete old profile'); h.api.dispose();
  }
});

test('the save parameter permits a preset commit but never bypasses atomic replacement', () => {
  const h = harness(), oldFile = h.disk.get(h.profile); h.api.presetBusy(true); h.api.setMarker('preset transaction');
  assert.equal(h.api.save(), false); assert.equal(h.writes.length, 0); assert.equal(h.disk.get(h.profile), oldFile);
  assert.equal(h.api.save(true), true);
  assert.equal(h.writes[0].filename, h.profile + '.tmp'); assert.equal(h.writes[1].kind, 'rename');
  assert.equal(JSON.parse(h.disk.get(h.profile)).marker, 'preset transaction'); assert.equal(h.disk.has(h.profile + '.tmp'), false);
  h.api.presetBusy(false); h.api.dispose();
});

test('failed settings commits do not expire kept SC or damage unrelated saved data', () => {
  for (const failure of ['partial-write', 'rename']) {
    const h = harness(), oldFile = h.disk.get(h.profile), oldState = plain(h.api.state());
    const sc = h.api.receive({ type: 'sc', valueYuan: 2, text: 'kept SC', uname: 'mock' }); h.advance(6000);
    const next = h.settings(); next.themeConfigs.glass.scNeverExpire = false; next.themeConfigs.glass.messageFont = 40;
    h.fail(failure); assert.throws(() => h.call('save-settings', next), /设置保存失败/);
    assert.deepEqual(plain(h.api.state()), oldState); assert.equal(h.disk.get(h.profile), oldFile);
    assert.equal(h.api.expiry().neverExpire, true); assert.equal(h.api.expiry().size, 1);
    assert.equal(h.api.snapshot().messages[0].id, sc.id); assert.equal(h.notifications[0].closed, 0);
    assert.equal(h.api.diagnostics().counts.expired, 0); assert.equal(h.disk.has(h.profile + '.tmp'), false);
    h.api.dispose();
  }
});

test('a committed automatic policy expires already-old SC only after the new profile exists', () => {
  const h = harness(); h.api.receive({ type: 'sc', valueYuan: 2, text: 'old SC' }); h.advance(6000);
  const next = h.settings(); next.themeConfigs.glass.scNeverExpire = false;
  let checkedCommitBoundary = false;
  h.onRename(() => {
    checkedCommitBoundary = true;
    assert.equal(h.api.snapshot().messages.length, 1, 'SC still exists at the atomic replacement boundary');
    assert.equal(h.api.expiry().neverExpire, true);
    assert.equal(JSON.parse(h.disk.get(h.profile)).settings.themeConfigs.glass.scNeverExpire, true);
  });
  const before = JSON.parse(h.disk.get(h.profile)); assert.equal(h.call('save-settings', next), true);
  assert.equal(checkedCommitBoundary, true);
  const stored = JSON.parse(h.disk.get(h.profile)); assert.equal(stored.settings.themeConfigs.glass.scNeverExpire, false);
  assert.deepEqual(stored.stylePresets, before.stylePresets); assert.deepEqual(stored.controlAppearance, before.controlAppearance);
  assert.equal(h.api.snapshot().messages.length, 1); assert.equal(h.api.snapshot().messages[0].scPinned, false);
  assert.equal(h.api.expiry().size, 0); assert.equal(h.notifications[0].closed, 1);
  assert.equal(h.api.diagnostics().counts.expired, 1); h.api.dispose();
});

test('successful keep-to-auto save retains the remaining original lifetime and then expires normally', () => {
  const h = harness(); h.api.receive({ type: 'sc', valueYuan: 30, text: 'one minute SC' }); h.advance(20000);
  const next = h.settings(); next.themeConfigs.glass.scNeverExpire = false; h.call('save-settings', next);
  h.advance(39999); assert.equal(h.api.snapshot().messages.length, 1);
  h.advance(1); assert.equal(h.api.snapshot().messages.length, 1); assert.equal(h.api.expiry().size, 0);
  assert.equal(h.api.snapshot().messages[0].scPinned, false);
  assert.equal(h.notifications[0].closed, 1); h.api.dispose();
});

test('actual upstream deletion wiring removes played SC, expiry, notification and records diagnostics without resurrection', async () => {
  const h = harness(); await h.api.startLive();
  const packet = { cmd: 'SUPER_CHAT_MESSAGE', data: { id: 8001, uid: 7, price: 30, message: 'upstream SC', user_info: { uname: 'mock' } } };
  h.relay.raw(packet); const localId = h.api.snapshot().messages[0].id;
  assert.equal(h.api.expiry().size, 1); assert.equal(h.notifications.length, 1);
  const oldClick = h.notifications[0].listeners('click')[0];
  h.relay.raw({ cmd: 'SUPER_CHAT_MESSAGE_DELETE:4:0', data: { ids: [8001, '8001'] } });
  assert.equal(h.api.snapshot().messages.length, 0); assert.equal(h.api.expiry().size, 0);
  assert.equal(h.notifications[0].closed, 1); assert.equal(h.notifications[0].listenerCount('click'), 0);
  oldClick(); assert.equal(h.opened(), 0);
  const deletion = h.api.diagnostics().events.filter(event => event.reason === 'upstream-delete');
  assert.equal(deletion.length, 1); assert.equal(deletion[0].messageId, localId); assert.equal(deletion[0].stage, 'removed');
  h.relay.raw(packet); h.relay.raw({ ...packet, data: { ...packet.data, message: 'late correction' } });
  assert.equal(h.api.snapshot().messages.length, 0); assert.equal(h.api.expiry().size, 0); assert.equal(h.notifications.length, 1);
  h.relay.raw({ cmd: 'SUPER_CHAT_MESSAGE_DELETE', data: { ids: [8002] } });
  h.relay.raw({ ...packet, data: { ...packet.data, id: 8002 } });
  assert.equal(h.api.snapshot().messages.length, 0); assert.equal(h.notifications.length, 1); h.api.dispose();
});

test('expiry returns SC between its original neighbours and late corrections cannot change its time or repin it', () => {
  const h = harness(), next = h.settings(); next.themeConfigs.glass.scNeverExpire = false;
  h.call('save-settings', next); h.api.setActive(true);
  const before = h.api.receive({ type: 'chat', text: 'before', at: 300 });
  const receipt = h.api.receive({ type: 'sc', valueYuan: 2, text: 'paid', at: 200, time: '12:34:56', avatarUrl: 'https://i0.hdslb.com/bfs/face/mock.jpg' });
  const after = h.api.receive({ type: 'chat', text: 'after', at: 100 });
  const oldClick = h.notifications[0].listeners('click')[0];
  h.advance(4999); assert.equal(h.api.snapshot().messages.find(m => m.id === receipt.id).scPinned, true);
  h.advance(1);
  let scene = plain(h.api.snapshot());
  assert.deepEqual(scene.messages.map(m => m.id), [before.id, receipt.id, after.id]);
  assert.deepEqual(scene.messages[1], { ...plain(receipt), scPinned: false });
  assert.equal(h.api.expiry().size, 0); assert.equal(h.notifications[0].closed, 1);
  oldClick(); assert.equal(h.opened(), 0, 'an expired notification cannot open a stale pinned card');
  assert.equal(h.api.update(receipt.id, { text: 'corrected', valueYuan: 30, scPinned: true, at: 900, time: '23:00:00' }), true);
  scene = plain(h.api.snapshot());
  assert.deepEqual(scene.messages.map(m => m.id), [before.id, receipt.id, after.id]);
  assert.equal(scene.messages[1].scPinned, false); assert.equal(scene.messages[1].at, 200);
  assert.equal(scene.messages[1].time, '12:34:56'); assert.equal(scene.messages[1].valueYuan, 30);
  assert.equal(h.api.expiry().size, 0); h.advance(60000);
  assert.equal(h.api.diagnostics().counts.expired, 1);
  assert.equal(h.api.remove(receipt.id), false, 'a card already in history is no longer swipeable');
  assert.deepEqual(plain(h.api.snapshot().messages.map(m => m.id)), [before.id, receipt.id, after.id]);
  h.api.dispose(); assert.equal(h.timers.size, 0);
});

test('a shorter corrected amount unpins immediately without losing SC and upstream deletion still removes the archived source', async () => {
  const h = harness(), next = h.settings(); next.themeConfigs.glass.scNeverExpire = false;
  h.call('save-settings', next); await h.api.startLive();
  const packet = { cmd: 'SUPER_CHAT_MESSAGE', data: { id: 9001, uid: 7, price: 30, message: 'correction test', user_info: { uname: 'mock' } } };
  h.relay.raw(packet); const receipt = plain(h.api.snapshot().messages[0]); h.advance(6000);
  h.relay.raw({ ...packet, data: { ...packet.data, price: 2, message: 'corrected' } });
  let archived = h.api.snapshot().messages[0];
  assert.equal(archived.id, receipt.id); assert.equal(archived.scPinned, false);
  assert.equal(archived.valueYuan, 2); assert.equal(archived.at, receipt.at);
  assert.equal(h.api.expiry().size, 0); assert.equal(h.api.diagnostics().counts.expired, 1);
  assert.equal(h.notifications.length, 1); assert.equal(h.notifications[0].closed, 1);
  h.relay.raw({ ...packet, data: { ...packet.data, price: 100, message: 'late correction' } });
  archived = h.api.snapshot().messages[0];
  assert.equal(archived.valueYuan, 100); assert.equal(archived.scPinned, false); assert.equal(h.api.expiry().size, 0);
  h.relay.raw({ cmd: 'SUPER_CHAT_MESSAGE_DELETE', data: { ids: [9001] } });
  assert.equal(h.api.snapshot().messages.length, 0);
  h.relay.raw(packet); assert.equal(h.api.snapshot().messages.length, 0);
  h.api.dispose(); assert.equal(h.timers.size, 0);
});

test('without output subscribers expired SC shares bounded history and clear invalidates old lifetime callbacks', () => {
  const h = harness(), next = h.settings(); next.themeConfigs.glass.scNeverExpire = false;
  h.call('save-settings', next);
  const old = h.api.receive({ type: 'sc', valueYuan: 2, text: 'older than history' });
  for (let i = 0; i < 70; i++) h.api.receive({ type: 'chat', text: String(i) });
  assert.equal(h.api.snapshot().messages.length, 49); h.advance(5000);
  assert.equal(h.api.snapshot().messages.length, 48);
  assert.equal(h.api.snapshot().messages.some(m => m.id === old.id), false);
  assert.equal(h.api.snapshot().playback.pending, 0); assert.equal(h.timers.size, 0);
  const pendingSc = h.api.receive({ type: 'sc', valueYuan: 2, text: 'clear me' });
  const callbacks = [...h.timers.values()].map(timer => timer.fn);
  h.api.clear('room-switch');
  const current = h.api.receive({ type: 'chat', text: 'new room' });
  callbacks.forEach(fn => fn()); h.advance(10000);
  assert.deepEqual(plain(h.api.snapshot().messages.map(m => m.id)), [current.id]);
  assert.equal(h.api.update(pendingSc.id, { text: 'late' }), false);
  assert.equal(h.api.expiry().size, 0); h.api.dispose(); assert.equal(h.timers.size, 0);
});

test('manual swipe shelves a pinned SC into original history and cancels expiry and stale notification actions', () => {
  const h = harness(), next = h.settings(); next.themeConfigs.glass.scNeverExpire = false;
  h.call('save-settings', next); h.api.setActive(true);
  const before = h.api.receive({ type: 'chat', text: 'before', at: 123 });
  const receipt = h.api.receive({ type: 'sc', text: 'shelve me', valueYuan: 30, at: 123 });
  const after = h.api.receive({ type: 'chat', text: 'after', at: 123 });
  const oldClick = h.notifications[0].listeners('click')[0];
  h.advance(100);
  const oldTimers = [...h.timers.values()].map(timer => timer.fn);
  assert.equal(h.api.remove(receipt.id), true); assert.equal(h.api.remove(receipt.id), false);
  let scene = plain(h.api.snapshot());
  assert.deepEqual(scene.messages.map(m => m.id), [before.id, receipt.id, after.id]);
  assert.deepEqual(scene.messages[1], { ...plain(receipt), scPinned: false });
  assert.equal(h.api.expiry().size, 0); assert.equal(h.notifications[0].closed, 1);
  assert.equal(h.api.diagnostics().counts.unpinned, 1); assert.equal(h.api.diagnostics().counts.removed, 0);
  oldClick(); assert.equal(h.opened(), 0);
  assert.equal(h.api.update(receipt.id, { text: 'late update', valueYuan: 500, scPinned: true }), true);
  next.themeConfigs.glass.scNeverExpire = true; h.call('save-settings', next);
  oldTimers.forEach(fn => fn()); h.advance(120000);
  scene = plain(h.api.snapshot());
  assert.equal(scene.messages[1].id, receipt.id); assert.equal(scene.messages[1].scPinned, false);
  assert.equal(scene.messages[1].valueYuan, 500); assert.equal(h.api.expiry().size, 0);
  assert.equal(h.api.diagnostics().counts.expired, 0); assert.equal(h.notifications.length, 1);
  h.api.dispose(); assert.equal(h.timers.size, 0);
});

(async () => {
  for (const { name, run } of cases) { await run(); console.log('PASS ' + name); }
  console.log('Main persistence tests passed: ' + cases.length);
})().catch(error => { console.error(error); process.exitCode = 1; });
