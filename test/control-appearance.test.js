'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const appearance = require('../desktop/control-appearance-settings.js');
const themes = require('../desktop/themes.js');

const plain = value => JSON.parse(JSON.stringify(value));
let passed = 0;
function test(name, run) { run(); passed++; console.log('PASS ' + name); }

test('normalization uses accessible opacity bounds and excludes unrelated settings', () => {
  for (const invalid of [undefined, null, [], 5, 'light']) {
    assert.deepEqual(appearance.normalize(invalid), { theme: 'dark', opacity: 97 });
  }
  for (const opacity of [undefined, null, '', '  ', true, false, NaN, Infinity, {}]) {
    assert.deepEqual(appearance.normalize({ theme: 'light', opacity }), { theme: 'light', opacity: 97 });
  }
  assert.deepEqual(appearance.normalize({ theme: 'light', opacity: -10 }), { theme: 'light', opacity: 30 });
  assert.deepEqual(appearance.normalize({ theme: 'unknown', opacity: 500 }), { theme: 'dark', opacity: 100 });
  assert.deepEqual(appearance.normalize({ theme: 'dark', opacity: '62.7' }), { theme: 'dark', opacity: 63 });
  const input = { theme: 'light', opacity: 80, roomId: '12345', themeConfigs: { glass: {} } };
  assert.deepEqual(appearance.normalize(input), { theme: 'light', opacity: 80 });
  assert.equal(input.roomId, '12345');
  assert.ok(Object.isFrozen(appearance.defaults));
});

test('the browser UMD uses the same defaults and normalization as the main process', () => {
  const context = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../desktop/control-appearance-settings.js'), 'utf8'), context);
  assert.deepEqual(plain(context.ControlAppearanceSettings.defaults), appearance.defaults);
  assert.deepEqual(plain(context.ControlAppearanceSettings.normalize({ theme: 'light', opacity: 12 })),
    appearance.normalize({ theme: 'light', opacity: 12 }));
});

function harness(controlAppearance) {
  const handlers = new Map(), disk = new Map(), timers = new Map();
  let timerId = 0, failure = null;
  const profile = path.join('D:/mock-control-appearance', 'desktop-state.json');
  const initial = {
    dimensionModelVersion: 7,
    settings: themes.migrateSettings({ theme: 'portrait', roomId: '12345', previewEnabled: false,
      themeConfigs: { glass: { surfaceColor: '#123456', scNeverExpire: true } } }),
    stylePresets: [{ id: 'saved-style', name: '已有皮肤', theme: 'glass', width: 515, height: 650,
      config: { ...themes.defaults.glass } }],
    closeAction: 'tray', localMarker: 'preserve',
    requestedPreviewSize: { width: 515, height: 650 }, previewSize: { width: 515, height: 650 },
    overlayBounds: { x: 40, y: 60, width: 515, height: 650 },
    ...(controlAppearance === undefined ? {} : { controlAppearance })
  };
  disk.set(profile, JSON.stringify(initial));
  const mockFs = {
    readFileSync: file => { if (!disk.has(file)) throw new Error('No mock profile'); return disk.get(file); },
    mkdirSync() {},
    writeFileSync: (file, contents) => {
      if (failure === 'write') throw new Error('Mock disk full');
      disk.set(file, contents);
    },
    renameSync: (from, to) => {
      if (failure === 'rename') throw new Error('Mock file locked');
      disk.set(to, disk.get(from)); disk.delete(from);
    },
    unlinkSync: file => disk.delete(file)
  };
  const app = new EventEmitter();
  Object.assign(app, { requestSingleInstanceLock: () => true, isPackaged: true,
    whenReady: () => ({ then: () => ({ catch() {} }) }), getVersion: () => 'test',
    getPath: () => 'D:/mock-control-appearance' });
  const control = { isDestroyed: () => false, webContents: { send() {} } };
  const mainPath = path.join(__dirname, '../desktop/main.js');
  const localRequire = createRequire(mainPath);
  const context = {
    require: id => id === 'fs' ? mockFs : id === 'electron' ? {
      app, BrowserWindow: class { constructor() { throw new Error('This test never creates a window'); } },
      ipcMain: { handle: (name, callback) => handlers.set(name, callback), on() {} }
    } : localRequire(id),
    __dirname: path.dirname(mainPath), process: { platform: 'win32' },
    console: { log() {}, warn() {}, error() {} },
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id)
  };
  vm.runInNewContext(fs.readFileSync(mainPath, 'utf8') + `
    globalThis.appearanceTest = {
      initialize(control) { controlWindow = control; loadState(); bindIpc(); },
      reload: loadState, state: () => appState,
      presetBusy(value) { stylePresetApplying = value; },
      dispose() { scExpiry.dispose(); messagePlayback.dispose(); if (saveTimer) clearTimeout(saveTimer); }
    };
  `, context, { filename: mainPath });
  context.appearanceTest.initialize(control);
  return {
    api: context.appearanceTest, disk, profile, timers,
    call: (name, value, sender = control.webContents) => handlers.get('desktop:' + name)({ sender }, value),
    fail: value => { failure = value; }
  };
}

test('old profiles get dark/97 and existing saved appearance is normalized on startup', () => {
  const fresh = harness();
  assert.deepEqual(plain(fresh.api.state().controlAppearance), { theme: 'dark', opacity: 97 });
  assert.deepEqual(plain(fresh.call('get-window-state').controlAppearance), { theme: 'dark', opacity: 97 });
  fresh.api.dispose();
  const stored = harness({ theme: 'light', opacity: 140, ignored: true });
  assert.deepEqual(plain(stored.api.state().controlAppearance), { theme: 'light', opacity: 100 });
  stored.api.dispose();
});

test('committed appearance survives profile reload without modifying overlay skins, presets or room settings', () => {
  const h = harness();
  const before = plain(h.api.state()); delete before.controlAppearance;
  const result = h.call('set-control-appearance', { theme: 'light', opacity: 82 });
  assert.deepEqual(plain(result), { controlAppearance: { theme: 'light', opacity: 82 } });
  const persisted = JSON.parse(h.disk.get(h.profile));
  assert.deepEqual(persisted.controlAppearance, { theme: 'light', opacity: 82 });
  delete persisted.controlAppearance;
  assert.deepEqual(persisted, before);
  assert.ok(![...h.disk.keys()].some(file => file.endsWith('.tmp')));
  result.controlAppearance.opacity = 30;
  assert.equal(h.api.state().controlAppearance.opacity, 82);
  h.api.reload();
  assert.deepEqual(plain(h.call('get-window-state').controlAppearance), { theme: 'light', opacity: 82 });
  h.api.dispose();
});

test('write and atomic replacement failures roll back memory and preserve the previous profile', () => {
  for (const failure of ['write', 'rename']) {
    const h = harness({ theme: 'dark', opacity: 73 });
    const before = plain(h.api.state()), previousFile = h.disk.get(h.profile);
    h.fail(failure);
    assert.throws(() => h.call('set-control-appearance', { theme: 'light', opacity: 40 }), /主界面外观保存失败/);
    assert.deepEqual(plain(h.api.state()), before, failure);
    assert.equal(h.disk.get(h.profile), previousFile, failure);
    assert.ok(![...h.disk.keys()].some(file => file.endsWith('.tmp')), failure);
    h.fail(null); h.api.reload();
    assert.deepEqual(plain(h.call('get-window-state').controlAppearance), { theme: 'dark', opacity: 73 });
    h.api.dispose();
  }
});

test('only the current console may save appearance and an in-flight preset cannot be partially committed', () => {
  const h = harness();
  const before = plain(h.api.state()), previousFile = h.disk.get(h.profile);
  assert.throws(() => h.call('set-control-appearance', { theme: 'light', opacity: 70 }, {}), /控制台/);
  assert.deepEqual(plain(h.api.state()), before);
  h.api.presetBusy(true);
  assert.throws(() => h.call('set-control-appearance', { theme: 'light', opacity: 70 }), /正在套用预设/);
  assert.deepEqual(plain(h.api.state()), before);
  assert.equal(h.disk.get(h.profile), previousFile);
  h.api.presetBusy(false); h.api.dispose();
});

console.log('Control appearance tests passed: ' + passed);
