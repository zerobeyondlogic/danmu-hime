'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function on(channel, callback) {
  ipcRenderer.on(channel, (_event, payload) => callback(payload));
}

contextBridge.exposeInMainWorld('DesktopOverlay', {
  getWindowState: () => ipcRenderer.invoke('desktop:get-window-state'),
  setClickThrough: (enabled) => ipcRenderer.invoke('desktop:set-click-through', !!enabled),
  setAlwaysOnTop: (enabled) => ipcRenderer.invoke('desktop:set-always-on-top', !!enabled),
  resizeOverlay: (width, height) => ipcRenderer.invoke('desktop:resize-overlay', Number(width), Number(height)),
  setOverlayBounds: (bounds) => ipcRenderer.invoke('desktop:set-overlay-bounds', bounds || {}),
  loadSettings: () => ipcRenderer.invoke('desktop:load-settings'),
  loadScene: () => ipcRenderer.invoke('desktop:load-scene'),
  saveSettings: (settings) => ipcRenderer.invoke('desktop:save-settings', settings),
  previewSettings: (settings) => ipcRenderer.send('desktop:preview-settings', settings),
  connectRoom: (roomId) => ipcRenderer.invoke('desktop:connect-room', String(roomId || '')),
  copyObsUrl: () => ipcRenderer.invoke('desktop:copy-obs-url'),
  overlayReady: () => ipcRenderer.send('desktop:overlay-ready'),
  reportViewport: (viewport) => ipcRenderer.send('desktop:preview-viewport', viewport || {}),
  dismissSc: (id) => ipcRenderer.invoke('desktop:dismiss-sc', String(id || '')),
  previewMessages: () => ipcRenderer.send('desktop:preview-messages'),
  reconnectRelay: () => ipcRenderer.invoke('desktop:reconnect-relay'),
  showOverlay: () => ipcRenderer.send('desktop:show-overlay'),
  resetOverlayBounds: () => ipcRenderer.send('desktop:reset-overlay-bounds'),
  minimize: () => ipcRenderer.send('desktop:minimize'),
  close: () => ipcRenderer.send('desktop:close'),
  onControlClosePrompt: (callback) => on('desktop:control-close-prompt', callback),
  controlCloseChoice: (token, action) => ipcRenderer.send('desktop:control-close-choice', token, action),
  onControlCloseError: (callback) => on('desktop:control-close-error', callback),
  onPrepareControlClose: (callback) => on('desktop:prepare-control-close', callback),
  controlClosePrepared: (token, ok) => ipcRenderer.send('desktop:control-close-prepared', token, !!ok),
  onClickThroughChanged: (callback) => on('desktop:click-through-changed', (value) => callback(!!value)),
  onSettingsChanged: (callback) => on('desktop:settings-changed', (value) => callback(value || {})),
  onOverlayStatusChanged: (callback) => on('desktop:overlay-status-changed', (value) => callback(String(value || 'disconnected'))),
  onOverlayBoundsChanged: (callback) => on('desktop:overlay-bounds-changed', (value) => callback(value || null)),
  onPreviewEnabledChanged: (callback) => on('desktop:preview-enabled-changed', (value) => callback(!!value)),
  onSceneCleared: (callback) => on('desktop:scene-cleared', callback)
});
