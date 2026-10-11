'use strict';

// Test-only guard. Showing an offscreen BrowserWindow displays Electron's
// native "No content under offscreen mode" placeholder on the real desktop.
// Install before any test windows are created; this is never packaged.
module.exports = function guardOffscreenWindows({ app, BrowserWindow }) {
  const proto = BrowserWindow.prototype;
  if (proto.__danmuOffscreenGuard) return;
  Object.defineProperty(proto, '__danmuOffscreenGuard', { value: true });
  for (const name of ['show', 'showInactive', 'restore', 'focus', 'moveTop']) {
    const original = proto[name];
    if (typeof original !== 'function') continue;
    proto[name] = function (...args) {
      const contents = this.webContents;
      if (!this.isDestroyed() && contents && contents.isOffscreen()) {
        if (typeof contents.startPainting === 'function') contents.startPainting();
        if (typeof contents.invalidate === 'function') contents.invalidate();
        return;
      }
      return original.apply(this, args);
    };
  }
  app.on('browser-window-created', (_event, window) => {
    if (window.webContents.isOffscreen()) {
      // Calling hide() on an already-hidden offscreen window stops its begin
      // frames in Electron 43, preventing rAF/ResizeObserver and captures.
      if (window.isVisible()) window.hide();
      window.setSkipTaskbar(true);
    }
  });
};
