'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function on(channel, callback) {
  ipcRenderer.on(channel, (_event, payload) => callback(payload));
}

contextBridge.exposeInMainWorld('DesktopOverlay', {
  getWindowState: () => ipcRenderer.invoke('desktop:get-window-state'),
  setControlAppearance: (value) => ipcRenderer.invoke('desktop:set-control-appearance', value),
  setClickThrough: (enabled) => ipcRenderer.invoke('desktop:set-click-through', !!enabled),
  setAlwaysOnTop: (enabled) => ipcRenderer.invoke('desktop:set-always-on-top', !!enabled),
  setPreviewEnabled: (enabled) => ipcRenderer.invoke('desktop:set-preview-enabled', !!enabled),
  resizeOverlay: (width, height) => ipcRenderer.invoke('desktop:resize-overlay', Number(width), Number(height)),
  setOverlayBounds: (bounds) => ipcRenderer.invoke('desktop:set-overlay-bounds', bounds || {}),
  loadSettings: () => ipcRenderer.invoke('desktop:load-settings'),
  loadScene: () => ipcRenderer.invoke('desktop:load-scene'),
  saveSettings: (settings) => ipcRenderer.invoke('desktop:save-settings', settings),
  listStylePresets: () => ipcRenderer.invoke('desktop:list-style-presets'),
  saveStylePreset: (preset) => ipcRenderer.invoke('desktop:save-style-preset', preset),
  renameStylePreset: (id, name) => ipcRenderer.invoke('desktop:rename-style-preset', id, name),
  deleteStylePreset: (id) => ipcRenderer.invoke('desktop:delete-style-preset', id),
  applyStylePreset: (id) => ipcRenderer.invoke('desktop:apply-style-preset', id),
  previewSettings: (settings) => ipcRenderer.send('desktop:preview-settings', settings),
  connectRoom: (roomId) => ipcRenderer.invoke('desktop:connect-room', String(roomId || '')),
  disconnectRoom: () => ipcRenderer.invoke('desktop:disconnect-room'),
  copyObsUrl: () => ipcRenderer.invoke('desktop:copy-obs-url'),
  overlayReady: () => ipcRenderer.send('desktop:overlay-ready'),
  reportViewport: (viewport) => ipcRenderer.send('desktop:preview-viewport', viewport || {}),
  dismissSc: (id) => ipcRenderer.invoke('desktop:dismiss-sc', String(id || '')),
  reconnectRelay: () => ipcRenderer.invoke('desktop:reconnect-relay'),
  minimize: () => ipcRenderer.send('desktop:minimize'),
  close: () => ipcRenderer.send('desktop:close'),
  setCloseAction: (action) => ipcRenderer.invoke('desktop:set-close-action', action),
  onCloseActionChanged: (callback) => on('desktop:close-action-changed', callback),
  onControlClosePrompt: (callback) => on('desktop:control-close-prompt', callback),
  controlCloseChoice: (token, action, remember) => ipcRenderer.send('desktop:control-close-choice', token, action, !!remember),
  onControlCloseError: (callback) => on('desktop:control-close-error', callback),
  onPrepareControlClose: (callback) => on('desktop:prepare-control-close', callback),
  controlClosePrepared: (token, ok) => ipcRenderer.send('desktop:control-close-prepared', token, !!ok),
  onClickThroughChanged: (callback) => on('desktop:click-through-changed', (value) => callback(!!value)),
  onSettingsChanged: (callback) => on('desktop:settings-changed', (value) => callback(value || {})),
  onOverlayStatusChanged: (callback) => on('desktop:overlay-status-changed', (value) => callback(String(value || 'disconnected'))),
  onPlaybackChanged: (callback) => on('desktop:playback-changed', (value) => callback(value || {})),
  onOverlayBoundsChanged: (callback) => on('desktop:overlay-bounds-changed', (value) => callback(value || null)),
  onPreviewEnabledChanged: (callback) => on('desktop:preview-enabled-changed', (value) => callback(!!value)),
  onSceneCleared: (callback) => on('desktop:scene-cleared', callback)
});
