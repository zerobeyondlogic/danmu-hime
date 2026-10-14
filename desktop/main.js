'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { createLiveScene } = require('./live-scene.js');
const { recoverWindowBounds } = require('./window-bounds.js');
const stylePresets = require('./style-presets.js');
const themes = require('./themes.js');
const controlAppearanceSettings = require('./control-appearance-settings.js');
const { createScAlerts } = require('./sc-alerts.js');
const { createMessagePlayback } = require('./message-playback.js');
const { createScExpiry } = require('./sc-expiry.js');
const { createScDiagnostics } = require('./sc-diagnostics.js');
const { safeEmoteUrl } = require('../js/emotes.js');
const {
  app,
  BrowserWindow,
  clipboard,
  globalShortcut,
  ipcMain,
  Menu,
  Notification,
  screen,
  Tray
} = require('electron');

const CONTROL_BOUNDS = { width: 468, height: 760 };
// Used only when no saved preview size exists (fresh install/profile).
const OVERLAY_BOUNDS = { width: 515, height: 650 };
const MIN_OVERLAY_BOUNDS = { width: 240, height: 160 };
const OBS_PORT = 38426;
const DIMENSION_MODEL_VERSION = 7;
const UNLOCK_SHORTCUT = 'CommandOrControl+Shift+F10';
const MAX_SCENE_MESSAGES = 48;
const OVERLAY_SNAP_DISTANCE = 12;
const OVERLAY_SNAP_RELEASE_DISTANCE = 32;
const APP_ICON = path.join(__dirname, 'assets', 'icon.png');
const OUTPUT_SESSION_ID = randomUUID();

let controlWindow = null;
let appTray = null;
let controlCloseTask = null;
let controlClosePromptFinish = null;
let controlQuitRequested = false;
let controlCloseSequence = 0;
let overlayWindow = null;
let embedded = null;
let liveScene = null;
let scAlerts = null;
let embeddedPort = OBS_PORT;
let clickThrough = false;
let overlayStatus = 'disconnected';
let overlayHasConnected = false;
let roomConnectionRequested = false;
let desktopRoomGeneration = 0;
let appState = {};
let stateFile = '';
let saveTimer = null;
let previewViewportRevision = 0;
let previewViewportWaiters = [];
let applyingPreviewSize = false;
let suppressRequestedViewportUntil = 0;
let manualPreviewResizePending = false;
let snappingOverlay = false;
let suppressOverlaySnapUntil = 0;
let overlaySnapState = { horizontal: null, vertical: null };
let overlayBoundsRecoveryTimer = null;
let overlayNativeMoveActive = false;
let sceneRevision = 0;
let latestWelcome = null;
let nextSceneMessageId = 1;
let previewResizeRequest = 0;
let stylePresetApplyTask = null;
let stylePresetApplying = false;
const scDiagnostics = createScDiagnostics({ now: () => Date.now() });
function recordScDiagnostic(event) {
  scDiagnostics.record({ room: (appState.settings || {}).roomId, ...event });
}
const messagePlayback = createMessagePlayback({
  maxPlayed: MAX_SCENE_MESSAGES,
  now: () => Date.now(),
  setTimer: (callback, delay) => setTimeout(callback, delay),
  clearTimer: (timer) => clearTimeout(timer),
  onChange() {
    sceneRevision += 1;
    flushScene();
  },
  onStateChange(state) {
    sendTo(controlWindow, 'desktop:playback-changed', state);
  }
});
const scExpiry = createScExpiry({
  now: () => Date.now(),
  setTimer: (callback, delay) => setTimeout(callback, delay),
  clearTimer: (timer) => clearTimeout(timer),
  onExpire(ids) {
    for (const messageId of ids) recordScDiagnostic({ stage: 'expired', messageId });
    if (scAlerts) scAlerts.cancel(ids);
    messagePlayback.unpinMany(ids);
  }
});

function syncScExpirySettings(settings = appState.settings) {
  const theme = themes.resolveTheme(settings && settings.theme);
  const config = settings && settings.themeConfigs && settings.themeConfigs[theme];
  scExpiry.setNeverExpire((config || themes.defaults[theme]).scNeverExpire === true);
}

function cleanSceneString(value, maxLength) {
  return String(value === undefined || value === null ? '' : value).slice(0, maxLength);
}

function sanitizeSceneMessage(value) {
  if (!value || typeof value !== 'object') return null;
  const type = ['chat', 'gift', 'sc', 'welcome'].includes(value.type) ? value.type : 'chat';
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
  if (type === 'sc') result.scPinned = value.scPinned !== false;
  const giftId = (typeof value.giftId === 'number' || typeof value.giftId === 'string') ? Number(value.giftId) : 0;
  if (Number.isSafeInteger(giftId) && giftId > 0) result.giftId = giftId;
  const giftImageUrl = typeof value.giftImageUrl === 'string' && value.giftImageUrl.length <= 2048
    ? safeEmoteUrl(value.giftImageUrl) : '';
  if (giftImageUrl) result.giftImageUrl = giftImageUrl;
  const amount = typeof value.valueYuan === 'number' ? value.valueYuan
    : typeof value.valueYuan === 'string' && value.valueYuan.trim() ? Number(value.valueYuan) : NaN;
  if (Number.isFinite(amount)) {
    result.valueYuan = amount;
  }
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
    sessionId: OUTPUT_SESSION_ID,
    appVersion: app.getVersion(),
    revision: sceneRevision,
    latestWelcome: latestWelcome ? { ...latestWelcome, emotes: { ...latestWelcome.emotes } } : null,
    playback: messagePlayback.getStats(),
    messages: messagePlayback.getMessages().map((message) => Object.assign({}, message, {
      emotes: Object.assign({}, message.emotes)
    }))
  };
}

function flushScene() {
  if (embedded && typeof embedded.publishDesktopOutput === 'function') {
    // Defer copying the scene until the server has an output subscriber.
    embedded.publishDesktopOutput('scene', sceneSnapshot);
  }
}

function addSceneMessage(value) {
  const message = sanitizeSceneMessage(value);
  if (!message) return null;
  message.id = String(nextSceneMessageId++);
  if (message.type === 'welcome') {
    // Fixed welcomes have one bounded slot and never displace chat or consume
    // its playback queue. Local receipt time keeps all outputs on one deadline.
    latestWelcome = { ...message, receivedAt: Date.now() };
    const current = appState.settings || {};
    const theme = themes.resolveTheme(current.theme);
    const config = current.themeConfigs && current.themeConfigs[theme] || themes.defaults[theme];
    if (config.welcomeMode === 'single') {
      sceneRevision += 1;
      flushScene();
      return { ...message, emotes: { ...message.emotes } };
    }
  }
  // Start SC lifetime at local receipt, before publishing any renderer data.
  // message.at may originate from a replay/source and does not control expiry.
  if (message.type === 'sc') {
    message.scPinned = true;
    scExpiry.track(message.id, message.valueYuan);
  }
  // Assign receipt identity at reception. The bounded played history is only
  // updated when the shared playback queue reveals this regular message.
  if (!messagePlayback.enqueue(message)) {
    if (message.type === 'sc') {
      scExpiry.remove(message.id);
      recordScDiagnostic({ stage: 'dropped', reason: 'publish-rejected', messageId: message.id });
    }
    return null;
  }
  if (message.type === 'sc') recordScDiagnostic({ stage: 'published', messageId: message.id, amount: message.valueYuan });
  return Object.assign({}, message, { emotes: Object.assign({}, message.emotes) });
}

function updateSceneMessage(id, value) {
  // Guard companion packets may arrive before their original card has left
  // the queue. Update pending or played data without changing its identity,
  // position or reception time; cleared/evicted receipts remain absent.
  let scAmountChanged = false;
  let nextAmount;
  const updated = messagePlayback.update(id, (previous) => {
    const next = sanitizeSceneMessage({ ...previous, ...value,
      at: previous.at, time: previous.time, gapMs: previous.gapMs });
    if (next && previous.type === 'sc' && !Object.is(previous.valueYuan, next.valueYuan)) {
      scAmountChanged = true;
      nextAmount = next.valueYuan;
    }
    return next;
  });
  // Run after the played update commits: shortening a lifetime may immediately
  // expire this card, and an unfinished update must never reinsert it afterward.
  if (updated && scAmountChanged) scExpiry.update(id, nextAmount);
  return updated;
}

function receiveLiveMessage(value) {
  const message = addSceneMessage(value);
  if (message && message.type === 'sc' && scAlerts) scAlerts.notify(message);
  return message;
}

function addWelcomeMessage(entry) {
  if (app.isQuitting || !entry || typeof entry.uname !== 'string') return null;
  const current = appState.settings || {};
  const theme = themes.resolveTheme(current.theme);
  const config = current.themeConfigs && current.themeConfigs[theme];
  // Disabled welcomes must not fill the shared history and evict real chat.
  if ((config || themes.defaults[theme]).showWelcome === false) return null;
  const uname = cleanSceneString(entry.uname, 120).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  const uid = Number(entry.uid);
  if (!uname || !Number.isSafeInteger(uid) || uid <= 0) return null;
  return addSceneMessage({
    type: 'welcome', uid, uname, avatarUrl: entry.avatarUrl,
    text: '欢迎 ' + uname + ' 进入直播间', at: entry.at
  });
}

function dismissSceneMessage(id) {
  const unpinned = messagePlayback.unpinMany([id]) > 0;
  if (unpinned) {
    recordScDiagnostic({ stage: 'unpinned', messageId: id });
    scExpiry.remove(id);
    if (scAlerts) scAlerts.cancel([id]);
  }
  return unpinned;
}

function removeUpstreamSc(ids) {
  if (!Array.isArray(ids)) return 0;
  const unique = [...new Set(ids.map(String))];
  for (const messageId of unique) {
    scExpiry.remove(messageId);
    recordScDiagnostic({ stage: 'removed', reason: 'upstream-delete', messageId });
  }
  if (scAlerts) scAlerts.cancel(unique);
  return messagePlayback.dismissMany(unique);
}

function clearScene(reason = 'manual-clear') {
  latestWelcome = null;
  recordScDiagnostic({ stage: 'clear', reason });
  if (scAlerts) scAlerts.clear();
  scExpiry.clear();
  // Clear both displayed and not-yet-displayed cards and invalidate timers
  // before publishing the empty scene. Old rooms cannot resume later.
  messagePlayback.clear();
  sendTo(overlayWindow, 'desktop:scene-cleared', sceneRevision);
}

function addPreviewMessages() {
  const samples = [
    { type: 'chat', uname: '神绮爱', role: 'host', text: '今晚的声音刚刚好' },
    { type: 'chat', uname: '小透明', role: 'manager', text: '连接状态正常，弹幕已同步' },
    { type: 'chat', uname: '赤焰之心', role: 'governor', medal: '陪伴 18', text: '继续加油，期待更多精彩！' },
    { type: 'chat', uname: '紫电青霜', role: 'admiral', medal: '陪伴 12', text: '一起陪伴主播成长！' },
    { type: 'chat', uname: '晨曦之光', role: 'captain', medal: '陪伴 6', text: '舰长来啦，支持神绮爱！' },
    { type: 'chat', uname: '星河入梦', role: 'viewer', text: '这套界面看着很舒服' },
    { type: 'gift', kind: 'gift', uname: '云水之间', role: 'viewer', text: '赠送  小花花 × 10', valueYuan: 30 },
    { type: 'sc', kind: 'sc', uname: '晚风与你', role: 'captain', text: '求配置和键位分享～', valueYuan: 50 }
  ];
  const gaps = [451, 385, 12000, 24000, 24000, 36000, 50000, 70000];
  const now = new Date();
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()].map((part) => String(part).padStart(2, '0')).join(':');
  samples.forEach((message, index) => addSceneMessage(Object.assign({}, message, {
    at: now.getTime(), time, gapMs: gaps[index]
  })));
  syncPreviewWindow();
}

function loadState() {
  stateFile = path.join(app.getPath('userData'), 'desktop-state.json');
  try {
    appState = JSON.parse(fs.readFileSync(stateFile, 'utf8')) || {};
  } catch (e) {
    appState = {};
  }
  if (!appState || typeof appState !== 'object' || Array.isArray(appState)) appState = {};
  appState.controlAppearance = controlAppearanceSettings.normalize(appState.controlAppearance);
  appState.settings = themes.migrateSettings(appState.settings);
  syncScExpirySettings();
  appState.stylePresets = stylePresets.normalizeStylePresets(appState.stylePresets);
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
  appState.activeStylePresetId = stylePresets.restoreStylePresetId(appState);
}

function saveStateSoon() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  // A preset commits its style and dimensions together after resizing settles.
  if (stylePresetApplying) return;
  saveTimer = setTimeout(() => {
    saveStateNow();
  }, 150);
}

function saveStateNow(allowPresetCommit = false) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  if (stylePresetApplying && !allowPresetCommit) return false;
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const serialized = JSON.stringify(appState, null, 2);
    // Every save preserves the previous complete profile on a partial write.
    const temporary = stateFile + '.tmp';
    try {
      fs.writeFileSync(temporary, serialized);
      fs.renameSync(temporary, stateFile);
    } finally {
      try { fs.unlinkSync(temporary); } catch (e) {}
    }
    return true;
  } catch (e) {
    console.error('[desktop] 保存设置失败:', e.message);
    return false;
  }
}

function getControlCloseAction() {
  return ['tray', 'quit'].includes(appState.closeAction) ? appState.closeAction : 'ask';
}

function setControlAppearance(value) {
  requireStylePresetIdle();
  const previous = appState.controlAppearance;
  const appearance = controlAppearanceSettings.normalize(value);
  appState.controlAppearance = appearance;
  if (!saveStateNow(true)) {
    appState.controlAppearance = previous;
    throw new Error('主界面外观保存失败，请重试。');
  }
  return { controlAppearance: { ...appearance } };
}

function setControlCloseAction(action) {
  if (!['ask', 'tray', 'quit'].includes(action)) throw new Error('Invalid control close action');
  const previous = appState.closeAction;
  appState.closeAction = action;
  if (!saveStateNow()) {
    appState.closeAction = previous;
    throw new Error('Unable to save control close action');
  }
  sendTo(controlWindow, 'desktop:close-action-changed', action);
  return { closeAction: action };
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
  // Keep the native hit-test/size-constraint path stable for transparent
  // Windows output. Lock manual resizing with will-resize instead of changing
  // Electron's resizable flag underneath the SC's no-drag interaction area.
  overlayWindow.setResizable(process.platform === 'win32' || (appState.settings || {}).overlaySizeLocked !== true);
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
    sessionId: OUTPUT_SESSION_ID,
    appVersion: app.getVersion(),
    settings: withPreviewCanvas(current, roomConnectionRequested ? String(current.roomId || '') : ''),
    canvas: {
      width: preview.width,
      height: preview.height
    },
    connectedRequested: roomConnectionRequested,
    scDiagnostics: scDiagnostics.getSnapshot(),
    playback: messagePlayback.getStats(),
    scene: sceneSnapshot()
  };
}

function getPreviewSize() {
  return normalizePreviewViewport(appState.requestedPreviewSize || appState.previewSize || appState.overlayBounds);
}

function withPreviewCanvas(settings, roomId) {
  const preview = getPreviewSize();
  return Object.assign({}, settings || {}, {
    roomId: roomId === undefined ? String(settings && settings.roomId || '') : String(roomId || ''),
    previewCanvasWidth: preview.width,
    previewCanvasHeight: preview.height
  });
}

function normalizePreviewViewport(value) {
  return {
    width: Math.max(MIN_OVERLAY_BOUNDS.width, Math.min(3840, Math.round(Number(value && value.width) || OVERLAY_BOUNDS.width))),
    height: Math.max(MIN_OVERLAY_BOUNDS.height, Math.min(2160, Math.round(Number(value && value.height) || OVERLAY_BOUNDS.height)))
  };
}

function acceptPreviewViewport(value) {
  const next = normalizePreviewViewport(value);
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
      clearTimeout(timer);
      previewViewportWaiters = previewViewportWaiters.filter((waiter) => waiter !== finish);
      resolve(value);
    };
    previewViewportWaiters.push(finish);
    const timer = setTimeout(() => finish(null), timeoutMs || 300);
  });
}

async function readRendererViewport(window = overlayWindow) {
  if (!window || window !== overlayWindow || window.isDestroyed() || window.webContents.isDestroyed()) return null;
  try {
    const value = await window.webContents.executeJavaScript(
      '({ width: window.innerWidth, height: window.innerHeight })',
      true
    );
    if (app.isQuitting || window !== overlayWindow || window.isDestroyed()) return null;
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
  if (next === 'reconnect' && overlayStatus !== 'reconnect') clearScene('reconnect');
  overlayStatus = next;
  overlayHasConnected = next === 'open';
  if (overlayHasConnected) syncPreviewWindow();
  sendTo(controlWindow, 'desktop:overlay-status-changed', overlayStatus);
}

function beginRoomConnection() {
  overlayHasConnected = false;
  setReportedStatus('init');
}

function connectDesktopRoom(roomId) {
  const normalized = String(roomId || '').trim();
  if (!/^\d+$/.test(normalized) || !liveScene) return false;
  const previousRoom = String((appState.settings || {}).roomId || '');
  const wasConnected = roomConnectionRequested;
  const generation = ++desktopRoomGeneration;
  roomConnectionRequested = true;
  appState.settings = Object.assign({}, appState.settings, { roomId: normalized });
  saveStateSoon();
  clearScene(previousRoom && previousRoom !== normalized ? 'room-switch' : wasConnected ? 'reconnect' : 'connect');
  beginRoomConnection();
  syncPreviewWindow();
  sendTo(overlayWindow, 'desktop:settings-changed', withPreviewCanvas(appState.settings, normalized));
  publishOutputSettings();
  liveScene.connect(normalized).catch((error) => {
    if (app.isQuitting || generation !== desktopRoomGeneration || !roomConnectionRequested) return;
    console.error('[desktop] 连接直播间失败:', error.message);
    setReportedStatus('api-fail');
  });
  return true;
}

function disconnectDesktopRoom() {
  if (app.isQuitting) return false;
  desktopRoomGeneration += 1;
  roomConnectionRequested = false;
  if (liveScene) liveScene.disconnect();
  messagePlayback.cancelPending();
  setReportedStatus('disconnected');
  // Keep the chosen room and all existing output windows. The controller can
  // reconnect it later; renderers receive an empty active room while stopped.
  sendTo(overlayWindow, 'desktop:settings-changed', withPreviewCanvas(appState.settings, ''));
  publishOutputSettings();
  return true;
}

function clearPreviewRuntime() {
  cancelOverlayBoundsRecovery();
  overlayNativeMoveActive = false;
  previewResizeRequest += 1;
  const waiters = previewViewportWaiters;
  previewViewportWaiters = [];
  waiters.forEach((finish) => finish(null));
  previewViewportRevision += 1;
  applyingPreviewSize = false;
  manualPreviewResizePending = false;
  suppressRequestedViewportUntil = 0;
  overlaySnapState = { horizontal: null, vertical: null };
}

function releaseOverlayWindow() {
  const window = overlayWindow;
  if (!window || window.isDestroyed()) return;
  rememberBounds(window, 'overlayBounds');
  overlayWindow = null;
  clearPreviewRuntime();
  window.destroy();
  saveStateSoon();
}

function syncPreviewWindow() {
  if ((appState.settings || {}).previewEnabled === false) {
    releaseOverlayWindow();
    return null;
  }
  if (!roomConnectionRequested && !messagePlayback.hasMessages()) return null;
  const window = createOverlayWindow(embeddedPort);
  if ((overlayHasConnected || messagePlayback.hasMessages()) && window && !window.webContents.isLoadingMainFrame()) {
    window.showInactive();
    setClickThrough(clickThrough);
  }
  return window;
}

function setPreviewEnabled(enabled) {
  if (enabled && scAlerts) scAlerts.clear();
  appState.settings = Object.assign({}, appState.settings, { previewEnabled: !!enabled });
  saveStateSoon();
  syncPreviewWindow();
  sendTo(controlWindow, 'desktop:preview-enabled-changed', !!enabled);
  publishOutputSettings();
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

function cancelOverlayBoundsRecovery() {
  if (overlayBoundsRecoveryTimer !== null) clearTimeout(overlayBoundsRecoveryTimer);
  overlayBoundsRecoveryTimer = null;
}

function recoverOverlayToWorkArea(window = overlayWindow) {
  if (!window || window !== overlayWindow || window.isDestroyed() || app.isQuitting ||
      snappingOverlay || overlayNativeMoveActive || applyingPreviewSize ||
      window.isMaximized() || window.isMinimized()) return false;
  const bounds = window.getBounds();
  const next = recoverWindowBounds(bounds, screen.getAllDisplays().map((display) => display.workArea));
  if (next.x === bounds.x && next.y === bounds.y) return false;
  overlaySnapState = { horizontal: null, vertical: null };
  snappingOverlay = true;
  try {
    window.setBounds(next, false);
  } finally {
    snappingOverlay = false;
  }
  rememberBounds(window, 'overlayBounds');
  return true;
}

function scheduleOverlayBoundsRecovery(window = overlayWindow, delay = 0) {
  if (!window || window !== overlayWindow || window.isDestroyed() || app.isQuitting) return;
  cancelOverlayBoundsRecovery();
  if (overlayNativeMoveActive || snappingOverlay) return;
  const wait = Math.max(delay, suppressOverlaySnapUntil - Date.now() + 1, 0);
  overlayBoundsRecoveryTimer = setTimeout(() => {
    overlayBoundsRecoveryTimer = null;
    recoverOverlayToWorkArea(window);
  }, wait);
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
  if (app.isQuitting || (appState.settings || {}).previewEnabled === false) return null;
  if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow;
  const requested = getPreviewSize();
  const bounds = recoverWindowBounds(Object.assign(
    {}, clampBounds(appState.overlayBounds, OVERLAY_BOUNDS, MIN_OVERLAY_BOUNDS.width, MIN_OVERLAY_BOUNDS.height), requested
  ), screen.getAllDisplays().map((display) => display.workArea));
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
    // Windows uses a will-resize veto for the size lock. Native resizability
    // stays stable so ordinary movement and SC pointer events are unaffected.
    resizable: process.platform === 'win32' || (appState.settings || {}).overlaySizeLocked !== true,
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

  const window = overlayWindow;
  secureWindow(window, port);
  if (process.platform === 'win32') {
    // Native drag loops can pause at a monitor boundary. Recover only after
    // WM_EXITSIZEMOVE, so crossing monitors never gets clamped mid-drag.
    window.hookWindowMessage(0x0231, () => {
      if (window !== overlayWindow) return;
      overlayNativeMoveActive = true;
      cancelOverlayBoundsRecovery();
    });
    window.hookWindowMessage(0x0232, () => {
      if (window !== overlayWindow) return;
      overlayNativeMoveActive = false;
      scheduleOverlayBoundsRecovery(window);
    });
  }
  setOverlayAlwaysOnTop((appState.settings || {}).alwaysOnTop !== false);
  setOverlayResizableForSettings();
  window.on('will-resize', (event) => {
    if (window !== overlayWindow || window.isDestroyed()) return;
    // Electron emits this only for manual native resizing. Explicit numeric
    // sizing, preset application and DPI corrections still use setContentSize
    // / setBounds, and ordinary window dragging uses the separate move path.
    if ((appState.settings || {}).overlaySizeLocked === true) event.preventDefault();
  });
  const clearVisibleScAlert = () => {
    if (window === overlayWindow && !window.isDestroyed() &&
        window.isVisible() && !window.isMinimized() && scAlerts) scAlerts.clear();
  };
  window.on('show', clearVisibleScAlert);
  window.on('restore', clearVisibleScAlert);
  window.once('ready-to-show', () => {
    if (window !== overlayWindow || window.isDestroyed() || app.isQuitting) return;
    setClickThrough(clickThrough);
    // A disabled preview may have had its canonical dimensions changed while
    // this page was loading. Always use the latest saved size.
    const target = getPreviewSize();
    setOverlayContentSize(target.width, target.height).catch((error) => console.warn('[desktop] 更新预览尺寸失败:', error.message));
    if (overlayHasConnected || messagePlayback.hasMessages()) window.showInactive();
  });
  window.on('resize', () => {
    rememberBounds(window, 'overlayBounds');
    scheduleOverlayBoundsRecovery(window, 160);
  });
  window.on('move', () => {
    if (window !== overlayWindow) return;
    snapOverlayToDisplayEdges();
    rememberBounds(window, 'overlayBounds');
    scheduleOverlayBoundsRecovery(window, 160);
  });
  window.on('moved', () => scheduleOverlayBoundsRecovery(window));
  window.on('close', (event) => {
    if (app.isQuitting) return;
    event.preventDefault();
    setPreviewEnabled(false);
  });
  window.on('closed', () => {
    if (overlayWindow === window) {
      overlayWindow = null;
      clearPreviewRuntime();
    }
  });
  window.loadURL('http://127.0.0.1:' + port + '/desktop/overlay.html');
  return window;
}

function ensureTray() {
  if (appTray && !appTray.isDestroyed()) return appTray;
  const tray = new Tray(APP_ICON);
  try {
    tray.setToolTip('Danmu Hime · 弹幕姬');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开控制台', click: showControlWindow },
      { type: 'separator' },
      { label: '退出弹幕姬', click: () => requestControlClose(controlWindow, true) }
    ]));
    tray.on('click', showControlWindow);
    tray.on('double-click', showControlWindow);
  } catch (error) {
    tray.destroy();
    throw error;
  }
  appTray = tray;
  return appTray;
}

function openScPreview() {
  if (app.isQuitting) return null;
  // A notification is an explicit request to interact with the SC card.
  setClickThrough(false);
  setPreviewEnabled(true);
  const window = overlayWindow;
  if (!window || window.isDestroyed()) return null;
  const reveal = () => {
    if (window !== overlayWindow || window.isDestroyed() || app.isQuitting) return;
    if (window.isMinimized()) window.restore();
    recoverOverlayToWorkArea(window);
    window.show();
    window.moveTop();
    window.focus();
  };
  if (window.webContents.isLoadingMainFrame()) window.once('ready-to-show', reveal);
  else reveal();
  return window;
}

function initializeScAlerts() {
  scAlerts = createScAlerts({
    hasPreview: () => !!(overlayWindow && !overlayWindow.isDestroyed() &&
      overlayWindow.isVisible() && !overlayWindow.isMinimized()),
    createNotification: options => Notification.isSupported()
      ? new Notification({ ...options, icon: APP_ICON }) : null,
    onOpen: openScPreview,
    showFallback(options, onClick) {
      const tray = ensureTray();
      if (typeof tray.displayBalloon !== 'function') return;
      tray.on('balloon-click', onClick);
      try {
        tray.displayBalloon({ title: options.title, content: options.body,
          icon: APP_ICON, noSound: true, respectQuietTime: true });
      } catch (error) {
        tray.removeListener('balloon-click', onClick);
        throw error;
      }
      return () => tray.removeListener('balloon-click', onClick);
    },
    hideFallback() {
      if (appTray && !appTray.isDestroyed() && typeof appTray.removeBalloon === 'function') appTray.removeBalloon();
    },
    onError: error => console.warn('[desktop] SC 提醒失败:', error.message)
  });
}

function showControlWindow() {
  if (app.isQuitting || !embedded || !embedded.server.listening) return null;
  const window = createControlWindow(embeddedPort);
  if (!window.webContents.isLoadingMainFrame()) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.moveTop();
    window.focus();
  }
  return window;
}

function prepareControlClose(window) {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed() || window.webContents.isLoadingMainFrame()) {
    return Promise.resolve(true);
  }
  const token = ++controlCloseSequence;
  return new Promise((resolve) => {
    const finish = (ok) => {
      clearTimeout(timer);
      ipcMain.removeListener('desktop:control-close-prepared', onPrepared);
      window.removeListener('closed', onClosed);
      resolve(ok);
    };
    const onPrepared = (event, receivedToken, ok) => {
      if (event.sender === window.webContents && receivedToken === token) finish(ok === true);
    };
    const onClosed = () => finish(true);
    const timer = setTimeout(() => finish(false), 2500);
    ipcMain.on('desktop:control-close-prepared', onPrepared);
    window.once('closed', onClosed);
    try {
      window.webContents.send('desktop:prepare-control-close', token);
    } catch (e) {
      finish(false);
    }
  });
}

function askControlClose(window) {
  const token = 'close-' + (++controlCloseSequence);
  const contents = window.webContents;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (response) => {
      if (settled) return;
      settled = true;
      if (controlClosePromptFinish === finish) controlClosePromptFinish = null;
      ipcMain.removeListener('desktop:control-close-choice', onChoice);
      window.removeListener('closed', onClosed);
      contents.removeListener('did-finish-load', showPrompt);
      contents.removeListener('did-fail-load', onLoadFailed);
      contents.removeListener('render-process-gone', onClosed);
      resolve(response);
    };
    const onChoice = (event, receivedToken, action, remember) => {
      if (event.sender !== contents || receivedToken !== token) return;
      if (['tray', 'quit', 'cancel'].includes(action)) {
        finish({ action, remember: action !== 'cancel' && remember === true });
      }
    };
    const onClosed = () => finish({ action: 'cancel', remember: false });
    const onLoadFailed = (_event, _code, _description, _url, isMainFrame) => {
      if (isMainFrame !== false) onClosed();
    };
    const showPrompt = () => {
      if (app.isQuitting || window.isDestroyed() || contents.isDestroyed()) {
        onClosed();
        return;
      }
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      // Render inside the existing console so the choice matches its theme
      // without creating another native dialog or renderer process.
      try {
        contents.send('desktop:control-close-prompt', { token });
      } catch (e) {
        onClosed();
      }
    };
    controlClosePromptFinish = finish;
    ipcMain.on('desktop:control-close-choice', onChoice);
    window.once('closed', onClosed);
    contents.once('render-process-gone', onClosed);
    if (contents.isLoadingMainFrame()) {
      contents.once('did-finish-load', showPrompt);
      contents.on('did-fail-load', onLoadFailed);
    } else {
      showPrompt();
    }
  });
}

function requestControlClose(window = controlWindow, quitDirectly = false) {
  if (app.isQuitting) return Promise.resolve();
  if (controlCloseTask) {
    if (quitDirectly) {
      controlQuitRequested = true;
      if (controlClosePromptFinish) controlClosePromptFinish({ action: 'quit', remember: false });
    }
    return controlCloseTask;
  }
  controlQuitRequested = quitDirectly;
  controlCloseTask = (async () => {
    if (!window || window.isDestroyed()) {
      if (quitDirectly) app.quit();
      return;
    }
    const closeAction = getControlCloseAction();
    const choice = quitDirectly
      ? { action: 'quit', remember: false }
      : closeAction === 'ask'
        ? await askControlClose(window)
        : { action: closeAction, remember: false };
    const response = controlQuitRequested ? 'quit' : choice.action;
    if (app.isQuitting || window.isDestroyed()) return;
    if (response !== 'tray' && response !== 'quit') return;
    if (response === 'tray') ensureTray();

    // Freeze edits while the renderer flushes its pending settings / resize work.
    window.setEnabled(false);
    const prepared = await prepareControlClose(window);
    if (window.isDestroyed() || app.isQuitting) return;
    window.setEnabled(true);
    if (!prepared) {
      sendTo(window, 'desktop:control-close-error', '设置尚未保存，请稍后重试。');
      return;
    }
    rememberBounds(window, 'controlBounds');
    const previousCloseAction = appState.closeAction;
    const rememberChoice = choice.remember && !controlQuitRequested;
    if (rememberChoice) appState.closeAction = response;
    if (!saveStateNow()) {
      appState.closeAction = previousCloseAction;
      sendTo(window, 'desktop:control-close-error', '设置保存失败，请稍后重试。');
      return;
    }
    if (rememberChoice) sendTo(window, 'desktop:close-action-changed', response);
    if (response === 'quit' || controlQuitRequested) {
      app.quit();
    } else {
      // Release the settings renderer, while the output renderer and relay live on.
      window.destroy();
    }
  })().catch((error) => {
    console.error('[desktop] 关闭控制台失败:', error);
    if (window && !window.isDestroyed() && !app.isQuitting) {
      window.setEnabled(true);
      sendTo(window, 'desktop:control-close-error', '暂时无法关闭控制台，请稍后重试。');
    }
  }).finally(() => {
    controlCloseTask = null;
    controlQuitRequested = false;
  });
  return controlCloseTask;
}

function createControlWindow(port) {
  if (controlWindow && !controlWindow.isDestroyed()) return controlWindow;
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
      backgroundThrottling: true
    }
  });

  const window = controlWindow;
  secureWindow(window, port);
  window.once('ready-to-show', () => {
    if (window.isDestroyed() || app.isQuitting) return;
    window.show();
    window.moveTop();
    window.focus();
  });
  window.on('focus', () => window.moveTop());
  window.on('resize', () => rememberBounds(window, 'controlBounds'));
  window.on('move', () => rememberBounds(window, 'controlBounds'));
  window.on('close', (event) => {
    if (app.isQuitting) return;
    event.preventDefault();
    requestControlClose(window);
  });
  window.on('closed', () => {
    if (controlWindow === window) controlWindow = null;
  });
  window.loadURL('http://127.0.0.1:' + port + '/desktop/index.html');
  return window;
}

async function setOverlayContentSize(width, height) {
  const { width: targetWidth, height: targetHeight } = normalizePreviewViewport({ width, height });
  const request = ++previewResizeRequest;
  const window = overlayWindow;
  const isCurrent = () => request === previewResizeRequest && window === overlayWindow && window && !window.isDestroyed();
  appState.requestedPreviewSize = { width: targetWidth, height: targetHeight };
  saveStateSoon();
  if (!window || window.isDestroyed()) {
    appState.previewSize = { width: targetWidth, height: targetHeight };
    sendTo(controlWindow, 'desktop:overlay-bounds-changed', overlayGeometry());
    publishOutputSettings();
    return overlayGeometry();
  }
  applyingPreviewSize = true;
  suppressRequestedViewportUntil = Date.now() + 1500;
  let actual;
  try {
    actual = await readRendererViewport(window) || getPreviewSize();
    if (!isCurrent()) return overlayGeometry();
    if (actual.width !== targetWidth || actual.height !== targetHeight) {
      const revision = previewViewportRevision;
      window.setContentSize(targetWidth, targetHeight);
      const report = await waitForPreviewViewport(revision, 350);
      if (!isCurrent()) return overlayGeometry();
      actual = report && report.size ? report.size : (await readRendererViewport(window) || actual);
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!isCurrent()) return overlayGeometry();
      if (actual.width === targetWidth && actual.height === targetHeight) break;
      const bounds = window.getBounds();
      const revision = previewViewportRevision;
      window.setBounds({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width + targetWidth - actual.width,
        height: bounds.height + targetHeight - actual.height
      });
      const report = await waitForPreviewViewport(revision, 350);
      if (!isCurrent()) return overlayGeometry();
      actual = report && report.size ? report.size : (await readRendererViewport(window) || actual);
    }
    if (!isCurrent()) return overlayGeometry();
    actual = await readRendererViewport(window) || actual;
  } finally {
    if (request === previewResizeRequest) {
      applyingPreviewSize = false;
      suppressRequestedViewportUntil = Date.now() + 1000;
    }
  }
  if (!isCurrent()) return overlayGeometry();
  appState.requestedPreviewSize = { width: targetWidth, height: targetHeight };
  scheduleOverlayBoundsRecovery(window);
  syncPreviewMetrics();
  return overlayGeometry();
}

async function resizeOverlay(width, height) {
  return setOverlayContentSize(width, height);
}

function setOverlayBounds(nextBounds) {
  if (!overlayWindow || overlayWindow.isDestroyed() || !nextBounds) return null;
  if (stylePresetApplying) return overlayGeometry();
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

function requireControlSender(event) {
  if (!controlWindow || controlWindow.isDestroyed() || event.sender !== controlWindow.webContents) {
    throw new Error('只有控制台可以管理样式预设。');
  }
}

function requireStylePresetIdle() {
  if (stylePresetApplying) throw new Error('正在套用预设，请稍后重试。');
}

function commitStylePresetList(result, selectSaved = false) {
  requireStylePresetIdle();
  const previous = appState.stylePresets;
  const previousActive = appState.activeStylePresetId;
  const nextActive = selectSaved ? result.preset.id : stylePresets.restoreStylePresetId(appState);
  appState.stylePresets = result.presets;
  appState.activeStylePresetId = result.presets.some(preset => preset.id === nextActive) ? nextActive : '';
  if (!saveStateNow(true)) {
    appState.stylePresets = previous;
    if (previousActive === undefined) delete appState.activeStylePresetId;
    else appState.activeStylePresetId = previousActive;
    throw new Error('预设保存失败，请检查磁盘空间后重试。');
  }
  return { ...result, activeStylePresetId: appState.activeStylePresetId };
}

function broadcastAppliedStyle() {
  syncScExpirySettings();
  const updates = [
    () => sendTo(overlayWindow, 'desktop:settings-changed', withPreviewCanvas(
      appState.settings,
      roomConnectionRequested ? (appState.settings || {}).roomId : ''
    )),
    () => sendTo(controlWindow, 'desktop:overlay-bounds-changed', overlayGeometry()),
    publishOutputSettings
  ];
  updates.forEach((update) => {
    try { update(); } catch (error) {
      // A window can disappear while resizing. A later renderer/OBS reconnect
      // reads the committed state; it must not undo an already saved preset.
      console.warn('[desktop] 同步预设外观失败:', error.message);
    }
  });
}

function applyStylePreset(id) {
  requireStylePresetIdle();
  const preset = stylePresets.findStylePreset(appState.stylePresets, id);
  const previousSettings = appState.settings;
  const previousActive = appState.activeStylePresetId;
  const previousRequested = appState.requestedPreviewSize;
  const previousPreview = appState.previewSize;
  const previousBounds = appState.overlayBounds;
  const previousSize = getPreviewSize();
  const window = overlayWindow;
  const previousWindowBounds = window && !window.isDestroyed() ? window.getBounds() : null;
  stylePresetApplying = true;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  stylePresetApplyTask = (async () => {
    try {
      appState.settings = stylePresets.settingsForStylePreset(appState.settings, preset);
      // Explicitly choosing a preset may resize a manually locked output. This
      // does not create a preview renderer when desktop preview is disabled.
      await setOverlayContentSize(preset.width, preset.height);
      appState.activeStylePresetId = preset.id;
      if (!saveStateNow(true)) throw new Error('预设套用后保存失败，请检查磁盘空间后重试。');
      broadcastAppliedStyle();
      return { settings: withPreviewCanvas(appState.settings), canvas: getPreviewSize(), preset };
    } catch (error) {
      if (previousActive === undefined) delete appState.activeStylePresetId;
      else appState.activeStylePresetId = previousActive;
      const current = appState.settings || {};
      appState.settings = Object.assign({}, current, {
        theme: previousSettings && previousSettings.theme,
        themeConfigVersion: previousSettings && previousSettings.themeConfigVersion,
        themeConfigs: previousSettings && previousSettings.themeConfigs
      });
      try {
        await setOverlayContentSize(previousSize.width, previousSize.height);
        if (previousWindowBounds && window === overlayWindow && !window.isDestroyed()) {
          window.setBounds(previousWindowBounds);
        }
      } catch (rollbackError) {
        console.warn('[desktop] 恢复预设前的窗口尺寸失败:', rollbackError.message);
      }
      appState.requestedPreviewSize = previousRequested;
      appState.previewSize = previousPreview;
      appState.overlayBounds = previousBounds;
      // A failed write must never remain scheduled to persist the failed style.
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = null;
      broadcastAppliedStyle();
      throw error;
    } finally {
      stylePresetApplying = false;
      stylePresetApplyTask = null;
    }
  })();
  return stylePresetApplyTask;
}

function bindIpc() {
  ipcMain.handle('desktop:set-control-appearance', (event, value) => {
    requireControlSender(event);
    return setControlAppearance(value);
  });
  ipcMain.handle('desktop:list-style-presets', (event) => {
    requireControlSender(event);
    return { presets: stylePresets.normalizeStylePresets(appState.stylePresets), activeStylePresetId: stylePresets.restoreStylePresetId(appState) };
  });
  ipcMain.handle('desktop:save-style-preset', (event, value) => {
    requireControlSender(event);
    requireStylePresetIdle();
    return commitStylePresetList(stylePresets.saveStylePreset(appState.stylePresets, value), true);
  });
  ipcMain.handle('desktop:rename-style-preset', (event, id, name) => {
    requireControlSender(event);
    requireStylePresetIdle();
    return commitStylePresetList(stylePresets.renameStylePreset(appState.stylePresets, id, name));
  });
  ipcMain.handle('desktop:delete-style-preset', (event, id) => {
    requireControlSender(event);
    requireStylePresetIdle();
    return commitStylePresetList(stylePresets.deleteStylePreset(appState.stylePresets, id));
  });
  ipcMain.handle('desktop:apply-style-preset', (event, id) => {
    requireControlSender(event);
    return applyStylePreset(id);
  });
  ipcMain.handle('desktop:get-window-state', () => ({
    sessionId: OUTPUT_SESSION_ID,
    appVersion: app.getVersion(),
    controlAppearance: controlAppearanceSettings.normalize(appState.controlAppearance),
    closeAction: getControlCloseAction(),
    previewEnabled: (appState.settings || {}).previewEnabled !== false,
    clickThrough,
    overlayStatus,
    playback: messagePlayback.getStats(),
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
  ipcMain.handle('desktop:set-preview-enabled', (event, enabled) => {
    if (!controlWindow || controlWindow.isDestroyed() || event.sender !== controlWindow.webContents) {
      throw new Error('Only the control window can change desktop preview visibility');
    }
    setPreviewEnabled(!!enabled);
    return {
      previewEnabled: (appState.settings || {}).previewEnabled !== false,
      overlayAvailable: !!(overlayWindow && !overlayWindow.isDestroyed())
    };
  });
  ipcMain.handle('desktop:set-close-action', (event, action) => {
    if (!controlWindow || controlWindow.isDestroyed() || event.sender !== controlWindow.webContents) {
      throw new Error('Only the control window can change its close action');
    }
    return setControlCloseAction(action);
  });
  ipcMain.handle('desktop:resize-overlay', (_event, width, height) => {
    requireStylePresetIdle();
    return resizeOverlay(width, height);
  });
  ipcMain.handle('desktop:set-overlay-bounds', (event, bounds) => {
    if (!overlayWindow || overlayWindow.isDestroyed() || event.sender !== overlayWindow.webContents) return null;
    return setOverlayBounds(bounds);
  });
  ipcMain.on('desktop:preview-viewport', (event, viewport) => {
    if (!overlayWindow || overlayWindow.isDestroyed() || event.sender !== overlayWindow.webContents) return;
    acceptPreviewViewport(viewport);
  });
  ipcMain.handle('desktop:load-settings', (event) => withPreviewCanvas(
    appState.settings,
    roomConnectionRequested || (controlWindow && !controlWindow.isDestroyed() && event && event.sender === controlWindow.webContents)
      ? (appState.settings || {}).roomId : ''
  ));
  ipcMain.handle('desktop:load-scene', () => sceneSnapshot());
  ipcMain.handle('desktop:save-settings', (_event, settings) => {
    requireStylePresetIdle();
    const previous = appState.settings;
    // Connection commands own the saved room. A delayed appearance save from
    // an older controller snapshot must not restore a previous/empty room ID.
    appState.settings = themes.migrateSettings(Object.assign({}, settings, {
      roomId: String((appState.settings || {}).roomId || '')
    }));
    // Expiring SC is irreversible: commit the preference before applying it.
    if (!saveStateNow()) {
      appState.settings = previous;
      throw new Error('设置保存失败，请检查磁盘空间后重试。');
    }
    syncScExpirySettings();
    setOverlayAlwaysOnTop(appState.settings.alwaysOnTop !== false);
    setOverlayResizableForSettings();
    sendTo(overlayWindow, 'desktop:settings-changed', withPreviewCanvas(
      appState.settings,
      roomConnectionRequested ? appState.settings.roomId : ''
    ));
    syncPreviewWindow();
    publishOutputSettings();
    return true;
  });
  ipcMain.on('desktop:preview-settings', (_event, settings) => {
    if (stylePresetApplying) return;
    const preview = withPreviewCanvas(
      themes.migrateSettings(settings),
      roomConnectionRequested ? String((appState.settings || {}).roomId || '') : ''
    );
    // Expiry belongs to each committed skin configuration. Visual drafts may
    // preview that skin's appearance, but must not change its lifetime policy
    // or irreversibly delete SC before save-settings/apply-style-preset commits.
    const committedConfigs = (appState.settings || {}).themeConfigs || {};
    for (const theme of themes.ids) {
      preview.themeConfigs[theme].scNeverExpire = (committedConfigs[theme] || themes.defaults[theme]).scNeverExpire === true;
    }
    delete preview.scNeverExpire;
    sendTo(overlayWindow, 'desktop:settings-changed', preview);
    if (embedded && typeof embedded.publishDesktopOutput === 'function') {
      embedded.publishDesktopOutput('settings', Object.assign(outputState(), { settings: preview }));
    }
  });
  ipcMain.handle('desktop:connect-room', (_event, roomId) => connectDesktopRoom(roomId));
  ipcMain.handle('desktop:disconnect-room', (event) => {
    requireControlSender(event);
    return disconnectDesktopRoom();
  });
  ipcMain.on('desktop:overlay-ready', (event) => {
    if (!overlayWindow || overlayWindow.isDestroyed() || event.sender !== overlayWindow.webContents) return;
    sendTo(overlayWindow, 'desktop:settings-changed', withPreviewCanvas(
      appState.settings,
      roomConnectionRequested ? (appState.settings || {}).roomId : ''
    ));
    sendTo(overlayWindow, 'desktop:click-through-changed', clickThrough);
  });
  ipcMain.handle('desktop:dismiss-sc', (event, id) => {
    if (!overlayWindow || overlayWindow.isDestroyed() || event.sender !== overlayWindow.webContents) return false;
    return dismissSceneMessage(id);
  });
  if (!app.isPackaged) ipcMain.on('desktop:preview-messages', addPreviewMessages);
  ipcMain.handle('desktop:copy-obs-url', () => {
    clipboard.writeText(obsUrl(embeddedPort));
    return true;
  });
  ipcMain.handle('desktop:reconnect-relay', () => {
    if (liveScene && roomConnectionRequested) {
      clearScene('manual-reconnect');
      liveScene.reconnect().catch((error) => console.warn('[desktop] 重新连接失败:', error.message));
      return true;
    }
    return false;
  });
  ipcMain.on('desktop:minimize', () => {
    if (controlWindow && !controlWindow.isDestroyed()) controlWindow.minimize();
  });
  ipcMain.on('desktop:close', (event) => {
    if (controlWindow && !controlWindow.isDestroyed() && event.sender === controlWindow.webContents) {
      controlWindow.close();
    }
  });
}

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    setClickThrough(false);
    showControlWindow();
  });
  app.on('activate', showControlWindow);

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    if (process.platform === 'win32' && typeof app.setAppUserModelId === 'function') {
      app.setAppUserModelId('com.danmuhime.overlay');
    }
    loadState();
    roomConnectionRequested = /^\d+$/.test(String((appState.settings || {}).roomId || '').trim());
    bindIpc();
    const recoverAfterDisplayChange = () => scheduleOverlayBoundsRecovery(overlayWindow, 160);
    screen.on('display-added', recoverAfterDisplayChange);
    screen.on('display-removed', recoverAfterDisplayChange);
    screen.on('display-metrics-changed', recoverAfterDisplayChange);
    const registered = globalShortcut.register(UNLOCK_SHORTCUT, toggleClickThrough);
    if (!registered) console.warn('[desktop] 全局快捷键注册失败: ' + UNLOCK_SHORTCUT);
    const port = await startEmbeddedServer();
    embeddedPort = port;
    appState.settings = Object.assign({
      previewEnabled: true,
      overlaySizeLocked: false
    }, appState.settings || {});
    embedded.setDesktopOutputBridge({
      getState: outputState,
      onSubscribersChanged: (count) => messagePlayback.setActive(count > 0)
    });
    initializeScAlerts();
    liveScene = createLiveScene({
      relay: embedded.relay,
      getRoomInfo: embedded.getRoomInfo,
      getRoomEmotes: embedded.getRoomEmotes,
      onMessage: receiveLiveMessage,
      onMessageUpdate: updateSceneMessage,
      onMessageDelete: removeUpstreamSc,
      onEntry: addWelcomeMessage,
      onDiagnostic: recordScDiagnostic,
      onStatus: (status) => {
        if (!app.isQuitting) setReportedStatus(status);
      }
    });
    try {
      ensureTray();
    } catch (e) {
      // Keep a usable console if Windows cannot create a notification icon.
      console.warn('[desktop] 托盘图标创建失败:', e.message);
    }
    createControlWindow(port);
    if (roomConnectionRequested) {
      connectDesktopRoom(appState.settings.roomId);
    }
  }).catch((e) => {
    console.error('[desktop] 启动失败:', e);
    app.quit();
  });
}

app.on('before-quit', () => {
  app.isQuitting = true;
  if (liveScene) liveScene.dispose();
  liveScene = null;
  if (scAlerts) scAlerts.dispose();
  scAlerts = null;
  scExpiry.dispose();
  messagePlayback.dispose();
  clearPreviewRuntime();
  rememberBounds(controlWindow, 'controlBounds');
  rememberBounds(overlayWindow, 'overlayBounds');
  saveStateNow();
});
app.on('window-all-closed', () => {
  if (!app.isQuitting && (!appTray || appTray.isDestroyed())) app.quit();
});
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (appTray && !appTray.isDestroyed()) appTray.destroy();
  appTray = null;
  if (embedded) {
    try {
      embedded.relay.shutDown();
    } catch (e) {}
    try {
      embedded.server.close();
    } catch (e) {}
  }
});
