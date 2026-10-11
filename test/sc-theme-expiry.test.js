'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const themes = require('../desktop/themes.js');

const plain = value => JSON.parse(JSON.stringify(value));
const sc = (price = 2) => ({ type: 'sc', uname: '过期规则测试', text: '测试 SC', valueYuan: price });
const pinned = h => h.api.snapshot().messages.filter(message => message.type === 'sc' && message.scPinned !== false);

// Exercise actual main/expiry/preset code with an in-memory profile and clock.
// No real filesystem write, HTTP server, BrowserWindow or notification is used.
function harness(initialSettings = {}) {
  let at = 1789120000000, timerId = 0, failAtomic = false;
  const timers = new Map(), disk = new Map(), published = [], sent = [];
  const handlers = new Map(), events = new EventEmitter();
  const profilePath = path.join('D:/mock-sc-theme-profile', 'desktop-state.json');
  const autoTui = { ...themes.defaults.tui, scNeverExpire: false };
  const keepGlass = { ...themes.defaults.glass, scNeverExpire: true };
  const legacyGlass = { ...themes.defaults.glass };
  delete legacyGlass.scNeverExpire;
  const initial = {
    dimensionModelVersion: 7,
    settings: { theme: 'glass', previewEnabled: false, ...initialSettings },
    requestedPreviewSize: { width: 515, height: 650 },
    previewSize: { width: 515, height: 650 },
    overlayBounds: { x: 40, y: 60, width: 515, height: 650 },
    stylePresets: [
      { id: 'auto-tui', name: '自动 SC', theme: 'tui', width: 515, height: 650, config: autoTui },
      { id: 'keep-glass', name: '长期 SC', theme: 'glass', width: 515, height: 650, config: keepGlass },
      { id: 'legacy-glass', name: '旧预设', theme: 'glass', width: 515, height: 650, config: legacyGlass }
    ]
  };
  disk.set(profilePath, JSON.stringify(initial));
  const app = new EventEmitter();
  Object.assign(app, { isPackaged: true, requestSingleInstanceLock: () => true,
    whenReady: () => ({ then: () => ({ catch() {} }) }), getVersion: () => 'test',
    getPath: () => 'D:/mock-sc-theme-profile' });
  const control = { isDestroyed: () => false,
    webContents: { send: (channel, value) => sent.push({ channel, value: plain(value) }) } };
  const embedded = { publishDesktopOutput(type, value) {
    published.push({ type, value: plain(typeof value === 'function' ? value() : value) });
  } };
  const mockFs = {
    readFileSync: file => {
      if (!disk.has(file)) throw new Error('No mock state');
      return disk.get(file);
    },
    mkdirSync() {},
    writeFileSync: (file, value) => disk.set(file, value),
    renameSync: (from, to) => {
      if (failAtomic) throw new Error('Mock atomic write failure');
      disk.set(to, disk.get(from)); disk.delete(from);
    },
    unlinkSync: file => disk.delete(file)
  };
  const mainPath = path.join(__dirname, '../desktop/main.js');
  const localRequire = createRequire(mainPath);
  const context = {
    require: id => id === 'fs' ? mockFs : id === 'electron' ? {
      app,
      BrowserWindow: class { constructor() { throw new Error('No test may create a window'); } },
      ipcMain: { handle: (name, callback) => handlers.set(name, callback), on: events.on.bind(events) }
    } : localRequire(id),
    __dirname: path.dirname(mainPath), process: { platform: 'win32' },
    console: { log() {}, warn() {}, error() {} },
    Date: class extends Date { static now() { return at; } },
    setTimeout: (run, delay) => { const id = ++timerId; timers.set(id, { run, at: at + delay }); return id; },
    clearTimeout: id => timers.delete(id)
  };
  vm.runInNewContext(fs.readFileSync(mainPath, 'utf8') + `
    globalThis.scThemeTest = {
      initialize(control, publisher) { controlWindow = control; embedded = publisher; loadState(); bindIpc(); },
      receive: receiveLiveMessage, snapshot: sceneSnapshot,
      settings: () => appState.settings, expiry: () => scExpiry.getState(),
      dispose() { scExpiry.dispose(); messagePlayback.dispose(); if (saveTimer) clearTimeout(saveTimer); }
    };
  `, context, { filename: mainPath });
  const api = context.scThemeTest;
  api.initialize(control, embedded);
  function advance(ms) {
    const end = at + ms;
    for (let index = 0; index < 10000; index++) {
      const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) { at = end; return; }
      timers.delete(due[0]); at = due[1].at; due[1].run();
    }
    throw new Error('Unexpected timer loop');
  }
  return { api, advance, published, sent, timers,
    edit: () => plain(api.settings()),
    call: (name, ...args) => handlers.get('desktop:' + name)({ sender: control.webContents }, ...args),
    preview: value => events.emit('desktop:preview-settings', { sender: control.webContents }, value),
    failAtomic: value => { failAtomic = value; } };
}

let passed = 0;
async function test(name, run) { await run(); passed++; console.log('PASS ' + name); }

(async () => {
  await test('startup follows the migrated active skin instead of retaining a root-level SC switch', () => {
    const h = harness({ scNeverExpire: true, themeConfigs: { tui: { scNeverExpire: false } } });
    assert.equal(Object.hasOwn(h.api.settings(), 'scNeverExpire'), false);
    assert.equal(h.api.settings().themeConfigs.glass.scNeverExpire, true);
    assert.equal(h.api.settings().themeConfigs.tui.scNeverExpire, false);
    assert.equal(h.api.expiry().neverExpire, true);
    h.api.receive(sc()); h.advance(10000);
    assert.equal(h.api.snapshot().messages.length, 1);
    assert.equal(h.timers.size, 0);
    h.api.dispose();
  });

  await test('editing another skin does not change current expiry; switching skins uses the original receipt age', () => {
    const h = harness({ themeConfigs: { glass: { scNeverExpire: true }, tui: { scNeverExpire: false } } });
    const message = h.api.receive(sc()); h.advance(6000);
    const editOther = h.edit(); editOther.themeConfigs.tui.scNeverExpire = true;
    h.call('save-settings', editOther); h.advance(6000);
    assert.equal(h.api.expiry().neverExpire, true);
    assert.equal(h.api.snapshot().messages[0].id, message.id);
    editOther.themeConfigs.tui.scNeverExpire = false;
    h.call('save-settings', editOther);
    assert.equal(h.api.snapshot().messages[0].id, message.id, 'inactive-skin edit cannot delete current SC');
    editOther.theme = 'tui'; h.call('save-settings', editOther);
    assert.equal(h.api.expiry().neverExpire, false);
    assert.equal(pinned(h).length, 0, 'new active auto skin unpins the already-old SC');
    assert.equal(h.api.snapshot().messages[0].id, message.id, 'expired SC remains in regular history');
    assert.equal(h.api.snapshot().messages[0].scPinned, false);
    assert.equal(h.api.settings().themeConfigs.glass.scNeverExpire, true);
    editOther.theme = 'glass'; h.call('save-settings', editOther); h.advance(10000);
    assert.equal(pinned(h).length, 0, 'returning to keep mode cannot repin expired cards');
    assert.equal(h.api.snapshot().messages[0].id, message.id);
    h.api.dispose();
  });

  await test('visual previews preserve every committed skin policy without expiring SC or reintroducing the root field', () => {
    const h = harness({ themeConfigs: { glass: { scNeverExpire: true }, tui: { scNeverExpire: false } } });
    h.api.receive(sc()); h.advance(10000);
    const draft = h.edit();
    draft.themeConfigs.glass.scNeverExpire = false;
    draft.themeConfigs.tui.scNeverExpire = true;
    draft.themeConfigs.glass.bodyColor = '#123456';
    draft.scNeverExpire = false;
    h.preview(draft);
    const output = h.published.at(-1).value.settings;
    assert.equal(output.themeConfigs.glass.scNeverExpire, true);
    assert.equal(output.themeConfigs.tui.scNeverExpire, false);
    assert.equal(output.themeConfigs.glass.bodyColor, '#123456', 'ordinary appearance still previews');
    assert.equal(Object.hasOwn(output, 'scNeverExpire'), false);
    draft.theme = 'tui'; h.preview(draft);
    assert.equal(h.published.at(-1).value.settings.themeConfigs.tui.scNeverExpire, false);
    h.advance(10000);
    assert.equal(h.api.settings().theme, 'glass');
    assert.equal(h.api.expiry().neverExpire, true);
    assert.equal(h.api.snapshot().messages.length, 1);
    h.api.dispose();
  });

  await test('auto-to-keep-to-auto switches retain the remaining original lifetime rather than restarting it', () => {
    const h = harness({ themeConfigs: { glass: { scNeverExpire: false }, outline: { scNeverExpire: true } } });
    h.api.receive(sc(30)); h.advance(20000);
    const edit = h.edit(); edit.theme = 'outline'; h.call('save-settings', edit); h.advance(20000);
    assert.equal(h.api.expiry().neverExpire, true);
    edit.themeConfigs.outline.scNeverExpire = false; h.call('save-settings', edit);
    assert.equal(h.api.expiry().neverExpire, false);
    h.advance(19999); assert.equal(pinned(h).length, 1);
    h.advance(1); assert.equal(pinned(h).length, 0);
    assert.equal(h.api.snapshot().messages.length, 1);
    assert.equal(h.api.settings().themeConfigs.glass.scNeverExpire, false);
    h.api.dispose();
  });

  await test('applying a preset changes only its selected skin policy and updates active expiry', async () => {
    const h = harness({ themeConfigs: { glass: { scNeverExpire: true }, tui: { scNeverExpire: true }, outline: { scNeverExpire: true } } });
    h.api.receive(sc()); h.advance(6000);
    await h.call('apply-style-preset', 'auto-tui');
    assert.equal(h.api.settings().theme, 'tui');
    assert.equal(h.api.settings().themeConfigs.tui.scNeverExpire, false);
    assert.equal(h.api.settings().themeConfigs.glass.scNeverExpire, true);
    assert.equal(h.api.settings().themeConfigs.outline.scNeverExpire, true);
    assert.equal(pinned(h).length, 0);
    assert.equal(h.api.snapshot().messages.length, 1);
    await h.call('apply-style-preset', 'keep-glass');
    assert.equal(h.api.expiry().neverExpire, true);
    assert.equal(pinned(h).length, 0);
    assert.equal(h.api.snapshot().messages.length, 1);
    h.api.receive(sc()); h.advance(6000);
    assert.equal(pinned(h).length, 1);
    assert.equal(h.api.snapshot().messages.length, 2);
    h.api.dispose();
  });

  await test('legacy preset default applies automatic expiry while a failed preset cannot prematurely delete kept SC', async () => {
    const h = harness({ themeConfigs: { glass: { scNeverExpire: true } } });
    h.api.receive(sc()); h.advance(6000);
    h.failAtomic(true);
    await assert.rejects(h.call('apply-style-preset', 'auto-tui'), /预设套用后保存失败/);
    assert.equal(h.api.settings().theme, 'glass');
    assert.equal(h.api.expiry().neverExpire, true);
    assert.equal(h.api.snapshot().messages.length, 1);
    h.failAtomic(false);
    await h.call('apply-style-preset', 'legacy-glass');
    assert.equal(h.api.settings().themeConfigs.glass.scNeverExpire, false);
    assert.equal(h.api.expiry().neverExpire, false);
    assert.equal(pinned(h).length, 0);
    assert.equal(h.api.snapshot().messages.length, 1);
    h.api.dispose();
  });

  console.log('SC per-skin main tests passed: ' + passed);
})().catch(error => { console.error(error); process.exitCode = 1; });
