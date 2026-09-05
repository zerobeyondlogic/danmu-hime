'use strict';

const fs = require('fs');
const path = require('path');
const {
  app,
  BrowserWindow,
  clipboard,
  globalShortcut,
  ipcMain,
  Menu,
  screen
} = require('electron');

const CONTROL_BOUNDS = { width: 468, height: 760 };
// Used only when no saved preview size exists (fresh install/profile).
const OVERLAY_BOUNDS = { width: 450, height: 650 };
const MIN_OVERLAY_BOUNDS = { width: 240, height: 160 };
const OBS_PORT = 38426;
const DIMENSION_MODEL_VERSION = 7;
const UNLOCK_SHORTCUT = 'CommandOrControl+Shift+F10';
const MAX_SCENE_MESSAGES = 48;
const OVERLAY_SNAP_DISTANCE = 12;
const OVERLAY_SNAP_RELEASE_DISTANCE = 32;
const APP_ICON = path.join(__dirname, 'assets', 'icon.png');

let controlWindow = null;
let overlayWindow = null;
let embedded = null;
let embeddedPort = OBS_PORT;
let clickThrough = false;
let overlayStatus = 'disconnected';
let overlayHasConnected = false;
let roomConnectionRequested = false;
let appState = {};
let stateFile = '';
let saveTimer = null;
let previewViewport = null;
let previewViewportRevision = 0;
let previewViewportWaiters = [];
let applyingPreviewSize = false;
let suppressRequestedViewportUntil = 0;
let manualPreviewResizePending = false;
let snappingOverlay = false;
let suppressOverlaySnapUntil = 0;
let overlaySnapState = { horizontal: null, vertical: null };
let sceneMessages = [];
let sceneRevision = 0;
let nextSceneMessageId = 1;

function cleanSceneString(value, maxLength) {
  return String(value === undefined || value === null ? '' : value).slice(0, maxLength);
}

function sanitizeSceneMessage(value) {
  if (!value || typeof value !== 'object') return null;
  const type = ['chat', 'gift', 'sc'].includes(value.type) ? value.type : 'chat';
  const role = ['host', 'manager', 'governor', 'admiral', 'captain', 'viewer'].includes(value.role)
    ? value.role
    : 'viewer';
  const result = {
    type,
    kind: ['gift', 'guard', 'sc'].includes(value.kind) ? value.kind : type,
    uid: Math.max(0, Math.round(Number(value.uid) || 0)),
    uname: cleanSceneString(value.uname, 120),
    avatarUrl: cleanSceneString(value.avatarUrl, 2048),
    text: cleanSceneString(value.text, 4000),
    role,
    medal: cleanSceneString(value.medal, 120),
    time: cleanSceneString(value.time, 16),
    at: Number.isFinite(Number(value.at)) ? Math.max(0, Math.round(Number(value.at))) : Date.now(),
    gapMs: value.gapMs !== null && value.gapMs !== undefined && Number.isFinite(Number(value.gapMs))
      ? Math.max(0, Number(value.gapMs))
      : null,
    emotes: {}
  };
  if (Number.isFinite(Number(value.valueYuan))) result.valueYuan = Number(value.valueYuan);
  if (value.emotes && typeof value.emotes === 'object') {
    Object.entries(value.emotes).slice(0, 64).forEach(([key, emote]) => {
      if (!emote || typeof emote !== 'object') return;
      const name = cleanSceneString(key, 120);
      const url = cleanSceneString(emote.url, 2048);
      if (!name || !url || name === '__proto__' || name === 'constructor' || name === 'prototype') return;
      result.emotes[name] = { url, official: !!emote.official };
    });
  }
  return result;
}

function sceneSnapshot() {
  return {
    revision: sceneRevision,
    messages: sceneMessages.map((message) => Object.assign({}, message, {
      emotes: Object.assign({}, message.emotes)
    }))
  };
}

function publishScene() {
  if (embedded && typeof embedded.publishDesktopOutput === 'function') {
    embedded.publishDesktopOutput('scene', sceneSnapshot());
  }
}

function addSceneMessage(value) {
  const message = sanitizeSceneMessage(value);
  if (!message) return null;
  message.id = String(nextSceneMessageId++);
  sceneMessages.push(message);
  const regularMessages = sceneMessages.filter((item) => item.type !== 'sc');
  if (regularMessages.length > MAX_SCENE_MESSAGES) {
    const removeIds = new Set(
      regularMessages.slice(0, regularMessages.length - MAX_SCENE_MESSAGES).map((item) => item.id)
    );
    sceneMessages = sceneMessages.filter((item) => !removeIds.has(item.id));
  }
  sceneRevision += 1;
  publishScene();
  return Object.assign({}, message, { emotes: Object.assign({}, message.emotes) });
}

function dismissSceneMessage(id) {
  const key = String(id || '');
  const index = sceneMessages.findIndex((message) => message.id === key && message.type === 'sc');
  if (index < 0) return false;
  sceneMessages.splice(index, 1);
  sceneRevision += 1;
  publishScene();
  return true;
}

function clearScene() {
  sceneMessages = [];
  sceneRevision += 1;
  sendTo(overlayWindow, 'desktop:scene-cleared');
  publishScene();
}

function loadState() {
  stateFile = path.join(app.getPath('userData'), 'desktop-state.json');
  try {
    appState = JSON.parse(fs.readFileSync(stateFile, 'utf8')) || {};
  } catch (e) {
    appState = {};
  }
  if (appState.settings && typeof appState.settings === 'object') {
    delete appState.settings.obsWidth;
    delete appState.settings.obsHeight;
  }
  if (Number(appState.dimensionModelVersion) !== DIMENSION_MODEL_VERSION) {
    const saved = appState.overlayBounds || {};
    const previousPreview = appState.previewSize || {};
    const accumulatedDpiBug =
      (Number(previousPreview.width) === 400 && Number(previousPreview.height) === 602) ||
      (Number(previousPreview.width) === 405 && Number(previousPreview.height) === 604);
    const requested = appState.requestedPreviewSize || {};
    const onePixelDpiBug = Number(requested.width) === 401 && Number(requested.height) === 601;
    appState.previewSize = accumulatedDpiBug
      ? { width: 400, height: 600 }
      : {
          width: Math.max(MIN_OVERLAY_BOUNDS.width, Math.round(Number(previousPreview.width || saved.width) || OVERLAY_BOUNDS.width)),
          height: Math.max(MIN_OVERLAY_BOUNDS.height, Math.round(Number(previousPreview.height || saved.height) || OVERLAY_BOUNDS.height))
        };
    if (accumulatedDpiBug) {
      appState.overlayBounds = Object.assign({}, saved, { width: 400, height: 600 });
    }
    appState.requestedPreviewSize = accumulatedDpiBug || onePixelDpiBug
      ? { width: 400, height: 600 }
      : Object.assign({}, appState.previewSize);
    appState.dimensionModelVersion = DIMENSION_MODEL_VERSION;
    saveStateNow();
  }
}

function saveStateSoon() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveStateNow();
  }, 150);
}

function saveStateNow() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(appState, null, 2));
  } catch (e) {
    console.error('[desktop] 保存设置失败:', e.message);
  }
}

function sendTo(window, channel, payload) {
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
}

function setClickThrough(enabled) {
  clickThrough = !!enabled;
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.setIgnoreMouseEvents(clickThrough, { forward: true });
  }
  sendTo(controlWindow, 'desktop:click-through-changed', clickThrough);
  sendTo(overlayWindow, 'desktop:click-through-changed', clickThrough);
}

function toggleClickThrough() {
  setClickThrough(!clickThrough);
  if (!clickThrough && overlayHasConnected && (appState.settings || {}).previewEnabled !== false && overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.show();
    overlayWindow.focus();
  }
}

function setOverlayAlwaysOnTop(enabled) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  // Keep the output above normal/game windows, but below the control console.
  overlayWindow.setAlwaysOnTop(!!enabled, enabled ? 'floating' : 'normal');
}

function setOverlayResizableForSettings() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  overlayWindow.setResizable((appState.settings || {}).overlaySizeLocked !== true);
}

function waitForListening(server) {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
}

async function startEmbeddedServer() {
  process.env.PORT = String(OBS_PORT);
  process.env.HOST = '127.0.0.1';
  process.env.DANMU_DATA_DIR = path.join(app.getPath('userData'), 'data');
  embedded = require('../server.js');
  await waitForListening(embedded.server);
  const address = embedded.server.address();
  if (!address || typeof address !== 'object') throw new Error('无法读取内嵌服务端口');
  return address.port;
}

function obsUrl(port) {
  return 'http://127.0.0.1:' + port + '/desktop/overlay.html?mode=obs';
}

function outputState() {
  const current = appState.settings || {};
  const preview = getPreviewSize();
  return {
    settings: withPreviewCanvas(current, roomConnectionRequested ? String(current.roomId || '') : ''),
    canvas: {
      width: preview.width,
      height: preview.height
    },
    connectedRequested: roomConnectionRequested,
    scene: sceneSnapshot()
  };
}

function getPreviewSize() {
  const saved = appState.requestedPreviewSize || appState.previewSize || appState.overlayBounds || {};
  return {
    width: Math.max(MIN_OVERLAY_BOUNDS.width, Math.min(3840, Math.round(Number(saved.width) || OVERLAY_BOUNDS.width))),
    height: Math.max(MIN_OVERLAY_BOUNDS.height, Math.min(2160, Math.round(Number(saved.height) || OVERLAY_BOUNDS.height)))
  };
}

function withPreviewCanvas(settings, roomId) {
  const preview = getRequestedPreviewSize();
  return Object.assign({}, settings || {}, {
    roomId: roomId === undefined ? String(settings && settings.roomId || '') : String(roomId || ''),
    previewCanvasWidth: preview.width,
    previewCanvasHeight: preview.height
  });
}

function getRequestedPreviewSize() {
  return normalizePreviewViewport(appState.requestedPreviewSize || appState.previewSize || appState.overlayBounds);
}

function normalizePreviewViewport(value) {
  return {
    width: Math.max(MIN_OVERLAY_BOUNDS.width, Math.min(3840, Math.round(Number(value && value.width) || OVERLAY_BOUNDS.width))),
    height: Math.max(MIN_OVERLAY_BOUNDS.height, Math.min(2160, Math.round(Number(value && value.height) || OVERLAY_BOUNDS.height)))
  };
}

function acceptPreviewViewport(value) {
  const next = normalizePreviewViewport(value);
  previewViewport = next;
  appState.previewSize = next;
  if (manualPreviewResizePending && !applyingPreviewSize && Date.now() >= suppressRequestedViewportUntil) {
    appState.requestedPreviewSize = Object.assign({}, next);
    manualPreviewResizePending = false;
  }
  if (overlayWindow && !overlayWindow.isDestroyed()) appState.overlayBounds = overlayWindow.getBounds();
  previewViewportRevision += 1;
  const waiters = previewViewportWaiters;
  previewViewportWaiters = [];
  waiters.forEach((resolve) => resolve({ revision: previewViewportRevision, size: Object.assign({}, next) }));
  saveStateSoon();
  sendTo(controlWindow, 'desktop:overlay-bounds-changed', overlayGeometry());
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    sendTo(overlayWindow, 'desktop:settings-changed', withPreviewCanvas(
      appState.settings,
      roomConnectionRequested ? (appState.settings || {}).roomId : ''
    ));
  }
  publishOutputSettings();
  return next;
}

function waitForPreviewViewport(afterRevision, timeoutMs) {
  if (previewViewportRevision > afterRevision) {
    return Promise.resolve({ revision: previewViewportRevision, size: getPreviewSize() });
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    previewViewportWaiters.push(finish);
    setTimeout(() => finish(null), timeoutMs || 300);
  });
}

async function readRendererViewport() {
  if (!overlayWindow || overlayWindow.isDestroyed() || overlayWindow.webContents.isDestroyed()) return null;
  try {
    const value = await overlayWindow.webContents.executeJavaScript(
      '({ width: window.innerWidth, height: window.innerHeight })',
      true
    );
    return acceptPreviewViewport(value);
  } catch (e) {
    return null;
  }
}

function overlayGeometry() {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    const bounds = clampBounds(appState.overlayBounds, OVERLAY_BOUNDS, MIN_OVERLAY_BOUNDS.width, MIN_OVERLAY_BOUNDS.height);
    const preview = getPreviewSize();
    return Object.assign({}, bounds, { width: preview.width, height: preview.height });
  }
  const bounds = overlayWindow.getBounds();
  const preview = getPreviewSize();
  return {
    x: bounds.x,
    y: bounds.y,
    width: preview.width,
    height: preview.height,
    outerWidth: bounds.width,
    outerHeight: bounds.height
  };
}

function syncPreviewMetrics() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  appState.overlayBounds = overlayWindow.getBounds();
  saveStateSoon();
  sendTo(controlWindow, 'desktop:overlay-bounds-changed', overlayGeometry());
  publishOutputSettings();
}

function publishOutputSettings() {
  if (embedded && typeof embedded.publishDesktopOutput === 'function') {
    embedded.publishDesktopOutput('settings', outputState());
  }
}

function setReportedStatus(status) {
  if (!roomConnectionRequested) {
    overlayStatus = 'disconnected';
    overlayHasConnected = false;
    sendTo(controlWindow, 'desktop:overlay-status-changed', overlayStatus);
    return;
  }
  const next = String(status || 'disconnected');
  if (next === 'reconnect' && overlayStatus !== 'reconnect') clearScene();
  overlayStatus = next;
  overlayHasConnected = next === 'open';
  if (overlayStatus === 'open' && (appState.settings || {}).previewEnabled !== false && overlayWindow && !overlayWindow.isDestroyed() && !overlayWindow.isVisible()) {
    overlayWindow.showInactive();
    setClickThrough(clickThrough);
  }
  sendTo(controlWindow, 'desktop:overlay-status-changed', overlayStatus);
}

function beginRoomConnection() {
  overlayHasConnected = false;
  setReportedStatus('waiting-obs');
}

function clampBounds(saved, defaults, minWidth, minHeight) {
  const source = saved || {};
  return {
    x: Number.isFinite(source.x) ? source.x : undefined,
    y: Number.isFinite(source.y) ? source.y : undefined,
    width: Math.max(minWidth, Number(source.width) || defaults.width),
    height: Math.max(minHeight, Number(source.height) || defaults.height)
  };
}

function rememberBounds(window, key) {
  if (!window || window.isDestroyed() || window.isMaximized() || window.isMinimized()) return;
  appState[key] = window.getBounds();
  saveStateSoon();
}

function snapOverlayToDisplayEdges() {
  if (
    snappingOverlay ||
    Date.now() < suppressOverlaySnapUntil ||
    !overlayWindow ||
    overlayWindow.isDestroyed() ||
    overlayWindow.isMaximized() ||
    overlayWindow.isMinimized()
  ) return false;

  const bounds = overlayWindow.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const area = display.workArea;
  const left = area.x;
  const right = area.x + area.width;
  const top = area.y;
  const bottom = area.y + area.height;
  let x = bounds.x;
  let y = bounds.y;

  if (overlaySnapState.horizontal) {
    const distance = Math.abs(bounds.x - overlaySnapState.horizontal.x);
    if (distance >= OVERLAY_SNAP_RELEASE_DISTANCE) overlaySnapState.horizontal = null;
  } else if (Math.abs(bounds.x - left) <= OVERLAY_SNAP_DISTANCE) {
    x = left;
    overlaySnapState.horizontal = { edge: 'left', x };
  } else if (Math.abs(bounds.x + bounds.width - right) <= OVERLAY_SNAP_DISTANCE) {
    x = right - bounds.width;
    overlaySnapState.horizontal = { edge: 'right', x };
  }
  if (overlaySnapState.vertical) {
    const distance = Math.abs(bounds.y - overlaySnapState.vertical.y);
    if (distance >= OVERLAY_SNAP_RELEASE_DISTANCE) overlaySnapState.vertical = null;
  } else if (Math.abs(bounds.y - top) <= OVERLAY_SNAP_DISTANCE) {
    y = top;
    overlaySnapState.vertical = { edge: 'top', y };
  } else if (Math.abs(bounds.y + bounds.height - bottom) <= OVERLAY_SNAP_DISTANCE) {
    y = bottom - bounds.height;
    overlaySnapState.vertical = { edge: 'bottom', y };
  }

  if (x === bounds.x && y === bounds.y) return false;
  snappingOverlay = true;
  try {
    overlayWindow.setBounds({ x, y, width: bounds.width, height: bounds.height }, false);
  } finally {
    snappingOverlay = false;
  }
  return true;
}

function secureWindow(window, port) {
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    try {
      const allowed = new URL('http://127.0.0.1:' + port + '/');
      const target = new URL(url);
      if (target.origin !== allowed.origin) event.preventDefault();
    } catch (e) {
      event.preventDefault();
    }
  });
}

function createOverlayWindow(port) {
  if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow;
  const bounds = clampBounds(appState.overlayBounds, OVERLAY_BOUNDS, MIN_OVERLAY_BOUNDS.width, MIN_OVERLAY_BOUNDS.height);
  const requested = getRequestedPreviewSize();
  overlayWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: requested.width,
    height: requested.height,
    useContentSize: true,
    minWidth: MIN_OVERLAY_BOUNDS.width,
    minHeight: MIN_OVERLAY_BOUNDS.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    thickFrame: false,
    // Keep the custom resize handles, but allow Electron to honor
    // setContentSize() on Windows high-DPI displays.
    resizable: (appState.settings || {}).overlaySizeLocked !== true,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    show: false,
    skipTaskbar: false,
    title: 'Danmu Hime Output',
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });

  secureWindow(overlayWindow, port);
  setOverlayAlwaysOnTop((appState.settings || {}).alwaysOnTop !== false);
  setOverlayResizableForSettings();
  overlayWindow.once('ready-to-show', () => {
    setClickThrough(clickThrough);
    setOverlayContentSize(requested.width, requested.height);
  });
  overlayWindow.on('resize', () => {
    rememberBounds(overlayWindow, 'overlayBounds');
  });
  overlayWindow.on('move', () => {
    snapOverlayToDisplayEdges();
    rememberBounds(overlayWindow, 'overlayBounds');
  });
  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });
  overlayWindow.loadURL('http://127.0.0.1:' + port + '/desktop/overlay.html');
  return overlayWindow;
}

function createControlWindow(port) {
  const bounds = clampBounds(appState.controlBounds, CONTROL_BOUNDS, 420, 620);
  controlWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: 420,
    minHeight: 620,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    alwaysOnTop: false,
    show: false,
    title: 'Danmu Hime Control',
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });

  secureWindow(controlWindow, port);
  controlWindow.once('ready-to-show', () => {
    controlWindow.show();
    controlWindow.moveTop();
    controlWindow.focus();
  });
  controlWindow.on('focus', () => controlWindow.moveTop());
  controlWindow.on('resize', () => rememberBounds(controlWindow, 'controlBounds'));
  controlWindow.on('move', () => rememberBounds(controlWindow, 'controlBounds'));
  controlWindow.on('closed', () => {
    controlWindow = null;
    if (!app.isQuitting) app.quit();
  });
  controlWindow.loadURL('http://127.0.0.1:' + port + '/desktop/index.html');
}

function resetOverlayBounds() {
  if (!overlayHasConnected || !overlayWindow || overlayWindow.isDestroyed()) return;
  const display = screen.getPrimaryDisplay().workArea;
  // This action is labelled as a position reset, so it must preserve the
  // user's chosen size—especially while the size lock is enabled.
  overlaySnapState = { horizontal: null, vertical: null };
  suppressOverlaySnapUntil = Date.now() + 120;
  overlayWindow.setPosition(display.x + 24, display.y + 24, false);
  overlayWindow.show();
  setClickThrough(false);
  overlayWindow.focus();
  rememberBounds(overlayWindow, 'overlayBounds');
}

async function setOverlayContentSize(width, height) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return null;
  const targetWidth = Math.max(MIN_OVERLAY_BOUNDS.width, Math.min(3840, Math.round(Number(width) || OVERLAY_BOUNDS.width)));
  const targetHeight = Math.max(MIN_OVERLAY_BOUNDS.height, Math.min(2160, Math.round(Number(height) || OVERLAY_BOUNDS.height)));
  appState.requestedPreviewSize = { width: targetWidth, height: targetHeight };
  saveStateSoon();
  applyingPreviewSize = true;
  suppressRequestedViewportUntil = Date.now() + 1500;
  let actual;
  try {
    actual = await readRendererViewport() || getPreviewSize();
    if (actual.width !== targetWidth || actual.height !== targetHeight) {
      let revision = previewViewportRevision;
      overlayWindow.setContentSize(targetWidth, targetHeight);
      let report = await waitForPreviewViewport(revision, 350);
      actual = report && report.size ? report.size : (await readRendererViewport() || actual);
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (actual.width === targetWidth && actual.height === targetHeight) break;
      const bounds = overlayWindow.getBounds();
      const revision = previewViewportRevision;
      overlayWindow.setBounds({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width + targetWidth - actual.width,
        height: bounds.height + targetHeight - actual.height
      });
      const report = await waitForPreviewViewport(revision, 350);
      actual = report && report.size ? report.size : (await readRendererViewport() || actual);
    }
    actual = await readRendererViewport() || actual;
  } finally {
    applyingPreviewSize = false;
    suppressRequestedViewportUntil = Date.now() + 1000;
  }
  appState.requestedPreviewSize = { width: targetWidth, height: targetHeight };
  syncPreviewMetrics();
  return overlayGeometry();
}

async function resizeOverlay(width, height) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return null;
  return setOverlayContentSize(width, height);
}

function setOverlayBounds(nextBounds) {
  if (!overlayWindow || overlayWindow.isDestroyed() || !nextBounds) return null;
  if ((appState.settings || {}).overlaySizeLocked === true) return overlayGeometry();
  const current = overlayWindow.getBounds();
  const width = Math.max(MIN_OVERLAY_BOUNDS.width, Math.min(3840, Math.round(Number(nextBounds.width) || current.width)));
  const height = Math.max(MIN_OVERLAY_BOUNDS.height, Math.min(2160, Math.round(Number(nextBounds.height) || current.height)));
  const x = Number.isFinite(Number(nextBounds.x)) ? Math.round(Number(nextBounds.x)) : current.x;
  const y = Number.isFinite(Number(nextBounds.y)) ? Math.round(Number(nextBounds.y)) : current.y;
  manualPreviewResizePending = true;
  suppressOverlaySnapUntil = Date.now() + 120;
  overlaySnapState = { horizontal: null, vertical: null };
  overlayWindow.setBounds({ x, y, width, height });
  syncPreviewMetrics();
  return overlayGeometry();
}

function bindIpc() {
  ipcMain.handle('desktop:get-window-state', () => ({
    clickThrough,
    overlayStatus,
    overlayAvailable: !!(overlayWindow && !overlayWindow.isDestroyed()),
    obsUrl: obsUrl(embeddedPort),
    // The control window initializes before the output is created.  Returning
    // null here used to make theme migrations rebase against the saved output size
    // instead of the user's saved output size, which later produced 3x text.
    overlayBounds: overlayWindow && !overlayWindow.isDestroyed()
      ? overlayWindow.getBounds()
      : clampBounds(appState.overlayBounds, OVERLAY_BOUNDS, MIN_OVERLAY_BOUNDS.width, MIN_OVERLAY_BOUNDS.height),
    overlayViewport: overlayGeometry()
  }));
  ipcMain.handle('desktop:set-click-through', (_event, enabled) => {
    setClickThrough(enabled);
    return { clickThrough };
  });
  ipcMain.handle('desktop:set-always-on-top', (_event, enabled) => {
    setOverlayAlwaysOnTop(enabled);
    return { alwaysOnTop: !!enabled };
  });
  ipcMain.handle('desktop:resize-overlay', (_event, width, height) => resizeOverlay(width, height));
  ipcMain.handle('desktop:set-overlay-bounds', (_event, bounds) => setOverlayBounds(bounds));
  ipcMain.on('desktop:preview-viewport', (event, viewport) => {
    if (!overlayWindow || overlayWindow.isDestroyed() || event.sender !== overlayWindow.webContents) return;
    acceptPreviewViewport(viewport);
  });
  ipcMain.handle('desktop:load-settings', () => withPreviewCanvas(
    appState.settings,
    roomConnectionRequested ? (appState.settings || {}).roomId : ''
  ));
  ipcMain.handle('desktop:load-scene', () => sceneSnapshot());
  ipcMain.handle('desktop:save-settings', (_event, settings) => {
    appState.settings = Object.assign({}, settings);
    saveStateSoon();
    setOverlayAlwaysOnTop(appState.settings.alwaysOnTop !== false);
    setOverlayResizableForSettings();
    sendTo(overlayWindow, 'desktop:settings-changed', withPreviewCanvas(
      appState.settings,
      roomConnectionRequested ? appState.settings.roomId : ''
    ));
    const wantsPreview = appState.settings.previewEnabled !== false;
    if (roomConnectionRequested && (!overlayWindow || overlayWindow.isDestroyed())) {
      createOverlayWindow(embeddedPort);
    }
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      if (wantsPreview && overlayHasConnected) {
        overlayWindow.showInactive();
        setClickThrough(clickThrough);
      } else if (!wantsPreview) {
        overlayWindow.hide();
      }
    }
    publishOutputSettings();
    return true;
  });
  ipcMain.on('desktop:preview-settings', (_event, settings) => {
    const preview = withPreviewCanvas(
      settings,
      roomConnectionRequested ? String(settings && settings.roomId || '') : ''
    );
    sendTo(overlayWindow, 'desktop:settings-changed', preview);
    if (embedded && typeof embedded.publishDesktopOutput === 'function') {
      embedded.publishDesktopOutput('settings', Object.assign(outputState(), { settings: preview }));
    }
  });
  ipcMain.handle('desktop:connect-room', (_event, roomId) => {
    const normalized = String(roomId || '').trim();
    if (!/^\d+$/.test(normalized)) return false;
    roomConnectionRequested = true;
    appState.settings = Object.assign({}, appState.settings, { roomId: normalized });
    saveStateSoon();
    clearScene();
    beginRoomConnection();
    createOverlayWindow(embeddedPort);
    sendTo(overlayWindow, 'desktop:settings-changed', withPreviewCanvas(appState.settings, normalized));
    publishOutputSettings();
    return true;
  });
  ipcMain.on('desktop:overlay-ready', () => {
    sendTo(overlayWindow, 'desktop:settings-changed', withPreviewCanvas(
      appState.settings,
      roomConnectionRequested ? (appState.settings || {}).roomId : ''
    ));
    sendTo(overlayWindow, 'desktop:click-through-changed', clickThrough);
  });
  ipcMain.on('desktop:overlay-status', (_event, status) => {
    setReportedStatus(status);
  });
  ipcMain.handle('desktop:scene-message', (event, message) => {
    if (!overlayWindow || overlayWindow.isDestroyed() || event.sender !== overlayWindow.webContents) return null;
    return addSceneMessage(message);
  });
  ipcMain.handle('desktop:dismiss-sc', (event, id) => {
    if (!overlayWindow || overlayWindow.isDestroyed() || event.sender !== overlayWindow.webContents) return false;
    return dismissSceneMessage(id);
  });
  ipcMain.on('desktop:preview-messages', () => {
    sendTo(overlayWindow, 'desktop:preview-messages');
  });
  ipcMain.handle('desktop:copy-obs-url', () => {
    clipboard.writeText(obsUrl(embeddedPort));
    return true;
  });
  ipcMain.handle('desktop:reconnect-relay', () => {
    if (embedded && embedded.relay && typeof embedded.relay.reconnectCurrent === 'function') {
      clearScene();
      embedded.relay.reconnectCurrent();
      return true;
    }
    return false;
  });
  ipcMain.on('desktop:show-overlay', () => {
    if (overlayHasConnected && overlayWindow && !overlayWindow.isDestroyed()) {
      setClickThrough(false);
      overlayWindow.show();
      overlayWindow.focus();
    }
  });
  ipcMain.on('desktop:reset-overlay-bounds', resetOverlayBounds);
  ipcMain.on('desktop:minimize', () => {
    if (controlWindow && !controlWindow.isDestroyed()) controlWindow.minimize();
  });
  ipcMain.on('desktop:close', () => app.quit());
}

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    setClickThrough(false);
    if (controlWindow && !controlWindow.isDestroyed()) {
      controlWindow.restore();
      controlWindow.show();
      controlWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    loadState();
    roomConnectionRequested = /^\d+$/.test(String((appState.settings || {}).roomId || '').trim());
    bindIpc();
    const registered = globalShortcut.register(UNLOCK_SHORTCUT, toggleClickThrough);
    if (!registered) console.warn('[desktop] 全局快捷键注册失败: ' + UNLOCK_SHORTCUT);
    const port = await startEmbeddedServer();
    embeddedPort = port;
    appState.settings = Object.assign({
      previewEnabled: true,
      overlaySizeLocked: false
    }, appState.settings || {});
    embedded.setDesktopOutputBridge({
      getState: outputState
    });
    createControlWindow(port);
    if (roomConnectionRequested) {
      beginRoomConnection();
      createOverlayWindow(port);
      publishOutputSettings();
    }
  }).catch((e) => {
    console.error('[desktop] 启动失败:', e);
    app.quit();
  });
}

app.on('before-quit', () => {
  app.isQuitting = true;
  rememberBounds(controlWindow, 'controlBounds');
  rememberBounds(overlayWindow, 'overlayBounds');
  saveStateNow();
});
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (embedded) {
    try {
      embedded.relay.shutDown();
    } catch (e) {}
    try {
      embedded.server.close();
    } catch (e) {}
  }
});
