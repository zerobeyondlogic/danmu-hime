'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const guard = require('../scripts/electron-test-windows.cjs');
class Window {
  constructor(offscreen, visible = true) {
    this.calls = [];
    this.visible = visible;
    this.webContents = { isOffscreen: () => offscreen, startPainting: () => this.calls.push('paint'), invalidate: () => this.calls.push('invalidate') };
  }
  isDestroyed() { return false; }
  isVisible() { return this.visible; }
  show() { this.calls.push('show'); }
  showInactive() { this.calls.push('showInactive'); }
  focus() { this.calls.push('focus'); }
  restore() { this.calls.push('restore'); }
  moveTop() { this.calls.push('moveTop'); }
  hide() { this.calls.push('hide'); }
  setSkipTaskbar(value) { this.calls.push(['skip', value]); }
}
const app = new EventEmitter();
guard({ app, BrowserWindow: Window });
guard({ app, BrowserWindow: Window });
assert.equal(app.listenerCount('browser-window-created'), 1);
const offscreen = new Window(true);
app.emit('browser-window-created', {}, offscreen);
for (const name of ['show', 'showInactive', 'restore', 'focus', 'moveTop']) offscreen[name]();
assert.deepEqual(offscreen.calls.slice(0, 2), ['hide', ['skip', true]]);
assert.equal(offscreen.calls.filter(c => c === 'paint').length, 5);
assert.equal(offscreen.calls.some(c => ['show','showInactive','restore','focus','moveTop'].includes(c)), false);
const alreadyHidden = new Window(true, false);
app.emit('browser-window-created', {}, alreadyHidden);
assert.deepEqual(alreadyHidden.calls, [['skip', true]], 'already-hidden offscreen windows must keep rendering without a second hide');
const native = new Window(false);
app.emit('browser-window-created', {}, native);
for (const name of ['show', 'showInactive', 'restore', 'focus', 'moveTop']) native[name]();
assert.deepEqual(native.calls, ['show','showInactive','restore','focus','moveTop']);
console.log('PASS offscreen tests stay hidden while native interaction windows remain usable');
