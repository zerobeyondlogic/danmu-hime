'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const { createRequire } = require('module');
const { recoverWindowBounds } = require('../desktop/window-bounds.js');

const primary = { x: 0, y: 0, width: 1920, height: 1040 };
let passed = 0;
function test(name, run) {
  run();
  passed += 1;
  console.log('PASS ' + name);
}

test('distant off-screen positions return fully inside the closest work area', () => {
  assert.deepStrictEqual(recoverWindowBounds({ x: 8000, y: 4000, width: 450, height: 650 }, [primary]),
    { x: 1470, y: 390, width: 450, height: 650 });
  assert.deepStrictEqual(recoverWindowBounds({ x: -8000, y: -4000, width: 450, height: 650 }, [primary]),
    { x: 0, y: 0, width: 450, height: 650 });
});

test('negative monitor coordinates and taskbar work-area insets are respected', () => {
  const left = { x: -1600, y: -200, width: 1600, height: 900 };
  assert.deepStrictEqual(recoverWindowBounds({ x: -1900, y: 600, width: 450, height: 650 }, [primary, left]),
    { x: -1600, y: 50, width: 450, height: 650 });
  const inset = { x: 48, y: 32, width: 1872, height: 1008 };
  assert.deepStrictEqual(recoverWindowBounds({ x: 0, y: 0, width: 450, height: 650 }, [inset]),
    { x: 48, y: 32, width: 450, height: 650 });
});

test('mixed-DPI displays use logical DIP bounds without applying scale factors', () => {
  const highDpi = { x: 1920, y: 0, width: 1280, height: 680, scaleFactor: 1.5 };
  assert.deepStrictEqual(recoverWindowBounds({ x: 3050, y: 90, width: 450, height: 650 }, [primary, highDpi]),
    { x: 2750, y: 30, width: 450, height: 650 });
});

test('fully visible windows can remain across a horizontal or vertical monitor seam', () => {
  const across = { x: 1750, y: 100, width: 450, height: 650 };
  assert.deepStrictEqual(recoverWindowBounds(across, [primary, { ...primary, x: 1920 }]), across);
  const vertical = { x: 100, y: 900, width: 450, height: 650 };
  assert.deepStrictEqual(recoverWindowBounds(vertical, [primary, { ...primary, y: 1040 }]), vertical);
});

test('gaps and staggered displays do not count invisible desktop space as a screen', () => {
  const right = { x: 2200, y: 300, width: 1600, height: 900 };
  assert.deepStrictEqual(recoverWindowBounds({ x: 2070, y: 200, width: 450, height: 650 }, [primary, right]),
    { x: 2200, y: 300, width: 450, height: 650 });
  assert.deepStrictEqual(recoverWindowBounds({ x: 1850, y: 0, width: 450, height: 650 }, [primary, { ...right, x: 1920 }]),
    { x: 1920, y: 300, width: 450, height: 650 });
});

test('removed monitors recover to the remaining display and mirrored areas do not double-count', () => {
  const bounds = { x: 2250, y: 100, width: 450, height: 650 };
  assert.deepStrictEqual(recoverWindowBounds(bounds, [primary]), { ...bounds, x: 1470 });
  assert.deepStrictEqual(recoverWindowBounds({ x: -100, y: 50, width: 450, height: 650 }, [primary, primary]),
    { x: 0, y: 50, width: 450, height: 650 });
});

test('oversized canvases expose their corner without changing output dimensions', () => {
  const bounds = { x: -100, y: -100, width: 2500, height: 1500 };
  assert.deepStrictEqual(recoverWindowBounds(bounds, [primary]), { ...bounds, x: 0, y: 0 });
  const across = { x: 500, y: 0, width: 2500, height: 1000 };
  assert.deepStrictEqual(recoverWindowBounds(across, [primary, { ...primary, x: 1920 }]), across);
});

test('first-use centering and valid saved positions remain unchanged', () => {
  const initial = { x: undefined, y: undefined, width: 450, height: 650 };
  const visible = { x: 400, y: 100, width: 450, height: 650 };
  assert.deepStrictEqual(recoverWindowBounds(initial, [primary]), initial);
  assert.deepStrictEqual(recoverWindowBounds(visible, [primary]), visible);
  assert.deepStrictEqual(recoverWindowBounds(visible, [null, { x: NaN }, { ...primary, width: 0 }]), visible);
});

function mainHarness() {
  let time = 1000;
  let timerId = 0;
  const timers = new Map();
  const app = new EventEmitter();
  app.requestSingleInstanceLock = () => true;
  // Evaluate actual handlers without starting the app, server, or a real window.
  app.whenReady = () => ({ then: () => ({ catch() {} }) });
  const screen = new EventEmitter();
  screen.areas = [primary];
  screen.getAllDisplays = () => screen.areas.map((workArea) => ({ workArea }));
  screen.getDisplayMatching = () => ({ workArea: screen.areas[0] });
  class Window extends EventEmitter {
    constructor(options) {
      super();
      this.bounds = { x: options.x ?? 400, y: options.y ?? 100, width: options.width, height: options.height };
      this.hooks = new Map();
      this.setCalls = [];
      this.destroyed = false;
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, { setWindowOpenHandler() {}, send() {}, isDestroyed: () => this.destroyed });
    }
    isDestroyed() { return this.destroyed; }
    isMaximized() { return false; }
    isMinimized() { return false; }
    getBounds() { return { ...this.bounds }; }
    setBounds(bounds) {
      this.bounds = { ...this.bounds, ...bounds };
      this.setCalls.push(this.getBounds());
      this.emit('move');
      this.emit('moved');
    }
    hookWindowMessage(message, callback) { this.hooks.set(message, callback); }
    setMenuBarVisibility() {}
    setAlwaysOnTop() {}
    setResizable() {}
    loadURL() {}
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const mainPath = path.join(__dirname, '../desktop/main.js');
  const localRequire = createRequire(mainPath);
  const mockFs = { mkdirSync() {}, writeFileSync() {} };
  const context = {
    require: (id) => id === 'electron' ? { app, screen, BrowserWindow: Window } : id === 'fs' ? mockFs : localRequire(id),
    __dirname: path.dirname(mainPath), process: { platform: 'win32' }, console,
    Date: class extends Date { static now() { return time; } },
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, at: time + delay }); return id; },
    clearTimeout: (id) => timers.delete(id)
  };
  vm.runInNewContext(fs.readFileSync(mainPath, 'utf8') + `
    globalThis.boundsTest = {
      create: (state) => { appState = state; roomConnectionRequested = true; return createOverlayWindow(38426); },
      recover: recoverOverlayToWorkArea, release: releaseOverlayWindow,
      schedule: scheduleOverlayBoundsRecovery,
      state: () => appState
    };
  `, context, { filename: mainPath });
  function advance(ms) {
    const end = time + ms;
    let remaining = 100;
    while (true) {
      const next = [...timers].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      assert.ok(remaining-- > 0, 'bounds recovery must not create an endless timer loop');
      timers.delete(next[0]);
      time = next[1].at;
      next[1].callback();
    }
    time = end;
  }
  return { api: context.boundsTest, screen, timers, advance };
}

test('main restores saved coordinates using current requested size without resizing the canvas', () => {
  const h = mainHarness();
  const window = h.api.create({ settings: {}, overlayBounds: { x: 8000, y: 4000, width: 300, height: 200 }, requestedPreviewSize: { width: 600, height: 800 } });
  assert.deepStrictEqual(window.getBounds(), { x: 1320, y: 240, width: 600, height: 800 });
  assert.strictEqual(window.setCalls.length, 0);
});

test('native Windows drag can pause off-screen and only recovers after WM_EXITSIZEMOVE', () => {
  const h = mainHarness();
  const window = h.api.create({ settings: {} });
  assert.ok(window.hooks.has(0x0231));
  assert.ok(window.hooks.has(0x0232));
  window.hooks.get(0x0231)();
  window.bounds.x = 7000;
  window.bounds.y = 4000;
  window.emit('move');
  window.emit('moved');
  h.advance(5000);
  assert.strictEqual(window.getBounds().x, 7000, 'holding a drag must not clamp a cross-screen move');
  assert.strictEqual(window.setCalls.length, 0);
  window.hooks.get(0x0232)();
  h.advance(200);
  assert.deepStrictEqual(window.getBounds(), { x: 1405, y: 390, width: 515, height: 650 });
  assert.deepStrictEqual(h.api.state().overlayBounds, window.getBounds());
  assert.strictEqual(window.setCalls.length, 1);
  assert.strictEqual(h.timers.size, 0, 'finished recovery leaves no polling timer');
});

test('near-edge snapping stays active during native drag and visible positions stay put on release', () => {
  const h = mainHarness();
  const window = h.api.create({ settings: {} });
  window.hooks.get(0x0231)();
  window.bounds.x = 6;
  window.emit('move');
  assert.strictEqual(window.getBounds().x, 0, 'existing 12 DIP edge snap is preserved');
  window.bounds.x = 100;
  window.emit('move');
  window.hooks.get(0x0232)();
  h.advance(200);
  assert.strictEqual(window.getBounds().x, 100);
  assert.strictEqual(window.setCalls.length, 1);
});

test('release cancels recovery and stale window events cannot disturb a new window', () => {
  const h = mainHarness();
  const old = h.api.create({ settings: {} });
  old.bounds.x = 6000;
  old.emit('move');
  h.api.release();
  const current = h.api.create({ settings: {} });
  current.bounds.x = 6000;
  current.emit('move');
  old.emit('moved');
  h.advance(500);
  assert.strictEqual(old.setCalls.length, 0);
  assert.strictEqual(current.getBounds().x, 1405);
  assert.strictEqual(current.setCalls.length, 1);
  assert.strictEqual(h.timers.size, 0);
});

console.log('Window bounds tests passed: ' + passed);
