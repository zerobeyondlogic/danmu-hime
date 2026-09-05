(function () {
  'use strict';

  const desktopApi = window.DesktopOverlay || null;
  const isObsMode = new URLSearchParams(window.location.search).get('mode') === 'obs' || !desktopApi;

  const THEMES = new Set(['glass', 'pixel', 'tui', 'risograph']);
  const ROLE_LABELS = {
    host: '主播',
    manager: '房管',
    governor: '总督',
    admiral: '提督',
    captain: '舰长',
    viewer: ''
  };
  const GUARD_ROLES = { 1: 'governor', 2: 'admiral', 3: 'captain' };
  const MAX_MESSAGES = 48;
  const MIN_CANVAS_WIDTH = 240;
  const MIN_CANVAS_HEIGHT = 160;
  const THEME_CONFIG_VERSION = 3;
  const DEFAULT_THEME_CONFIGS = {
    glass: { overallScale: 82, messageGap: 8, messageFont: 30, nameFont: 18, metaFont: 13, timeFont: 12, fontFamily: 'Microsoft YaHei UI', bodyColor: '#fcfcfd', giftColor: '#e4a5b0', timeColor: '#c9d0d8', viewerColor: '#e7e9ed', hostColor: '#e99aa9', managerColor: '#72bfe7', governorColor: '#ef817c', admiralColor: '#c59ad8', captainColor: '#80cbe5', surfaceOpacity: 10, showAvatar: true, baseWidth: 720, baseHeight: 900 },
    pixel: { overallScale: 100, messageGap: 8, messageFont: 32, nameFont: 18, metaFont: 14, timeFont: 14, fontFamily: 'GNU Unifont 16 Bitmap', pixelFontVersion: 3, bitmapEngineVersion: 3, bodyColor: '#f2b93b', giftColor: '#f2b93b', timeColor: '#f2b93b', viewerColor: '#f2b93b', hostColor: '#f2b93b', managerColor: '#f2b93b', governorColor: '#f2b93b', admiralColor: '#f2b93b', captainColor: '#f2b93b', surfaceOpacity: 100, showAvatar: false, baseWidth: 720, baseHeight: 900 },
    tui: { overallScale: 100, messageGap: 4, messageFont: 22, nameFont: 14, metaFont: 12, timeFont: 14, fontFamily: 'JetBrains Maple Mono', bodyColor: '#f3f1ee', giftColor: '#ee9ba2', timeColor: '#a8a5a3', viewerColor: '#f3f1ee', hostColor: '#ee8d96', managerColor: '#4fa8f5', governorColor: '#ef766f', admiralColor: '#c98bd2', captainColor: '#58b9e6', surfaceOpacity: 70, showAvatar: false, baseWidth: 720, baseHeight: 900 },
    risograph: { overallScale: 86, messageGap: 4, messageFont: 34, nameFont: 20, metaFont: 15, timeFont: 12, fontFamily: 'KaiTi', bodyColor: '#123b8f', giftColor: '#e95562', timeColor: '#123b8f', viewerColor: '#123b8f', hostColor: '#e95562', managerColor: '#123b8f', governorColor: '#e95562', admiralColor: '#123b8f', captainColor: '#123b8f', surfaceOpacity: 100, showAvatar: true, baseWidth: 720, baseHeight: 900 }
  };

  let settings = {
    roomId: '',
    theme: 'glass',
    alwaysOnTop: true,
    themeConfigs: null,
    themeConfigVersion: THEME_CONFIG_VERSION
  };
  let client = null;
  let connectedRoomId = '';
  let ownerUid = 0;
  let roomEmoteAliases = {};
  const avatarUrlCache = new Map();
  const avatarLookupPending = new Map();
  let lastMessageAt = 0;
  let connectGeneration = 0;
  let pixelRenderTimer = null;
  let bitmapPixelFont = null;
  let resizeSession = null;
  let resizeFrame = null;
  let pendingResize = null;
  let viewportReportFrame = null;
  let scenePublishQueue = Promise.resolve();
  let canvasWidth = 720;
  let canvasHeight = 900;
  let renderedSceneRevision = -1;
  const els = {};

  function applyStageFit() {
    const viewportWidth = Math.max(1, window.innerWidth);
    const viewportHeight = Math.max(1, window.innerHeight);
    const scale = Math.min(viewportWidth / canvasWidth, viewportHeight / canvasHeight);
    const fittedWidth = canvasWidth * scale;
    const fittedHeight = canvasHeight * scale;
    const root = document.documentElement.style;
    root.setProperty('--obs-canvas-width', canvasWidth + 'px');
    root.setProperty('--obs-canvas-height', canvasHeight + 'px');
    root.setProperty('--stage-scale', scale.toFixed(6));
    root.setProperty('--stage-left', Math.max(0, (viewportWidth - fittedWidth) / 2).toFixed(3) + 'px');
    root.setProperty('--stage-top', Math.max(0, viewportHeight - fittedHeight).toFixed(3) + 'px');
  }

  function setCanvasSize(width, height) {
    canvasWidth = Math.max(MIN_CANVAS_WIDTH, Math.min(3840, Math.round(Number(width) || 720)));
    canvasHeight = Math.max(MIN_CANVAS_HEIGHT, Math.min(2160, Math.round(Number(height) || 900)));
    applyStageFit();
  }

  function reportPreviewViewport() {
    if (!desktopApi || isObsMode || viewportReportFrame !== null) return;
    viewportReportFrame = requestAnimationFrame(() => {
      viewportReportFrame = null;
      desktopApi.reportViewport({ width: window.innerWidth, height: window.innerHeight });
    });
  }

  function clamp(value, min, max, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
  }

  function normalizeThemeConfigs(source) {
    const result = {};
    Object.keys(DEFAULT_THEME_CONFIGS).forEach((theme) => {
      const defaults = DEFAULT_THEME_CONFIGS[theme];
      const given = Object.assign({}, source && source[theme] ? source[theme] : {});
      if (theme === 'pixel') {
        given.fontFamily = defaults.fontFamily;
        given.pixelFontVersion = 3;
        if (Number(given.bitmapEngineVersion) !== 3) {
          given.baseWidth = canvasWidth;
          given.baseHeight = canvasHeight;
          given.bitmapEngineVersion = 3;
        }
      }
      result[theme] = Object.assign({}, defaults, given, {
        overallScale: clamp(given.overallScale, 60, 140, defaults.overallScale),
        messageGap: clamp(given.messageGap, 0, 20, defaults.messageGap),
        messageFont: clamp(given.messageFont, 16, 48, defaults.messageFont),
        nameFont: clamp(given.nameFont, 10, 30, defaults.nameFont),
        metaFont: clamp(given.metaFont, 8, 24, defaults.metaFont),
        timeFont: clamp(given.timeFont, 9, 22, defaults.timeFont),
        surfaceOpacity: clamp(given.surfaceOpacity, 0, 100, defaults.surfaceOpacity),
        baseWidth: clamp(given.baseWidth, MIN_CANVAS_WIDTH, 7680, defaults.baseWidth),
        baseHeight: clamp(given.baseHeight, MIN_CANVAS_HEIGHT, 4320, defaults.baseHeight),
        bodyColor: /^#[0-9a-f]{6}$/i.test(given.bodyColor || '') ? given.bodyColor : defaults.bodyColor,
        giftColor: /^#[0-9a-f]{6}$/i.test(given.giftColor || '') ? given.giftColor : defaults.giftColor,
        timeColor: /^#[0-9a-f]{6}$/i.test(given.timeColor || '') ? given.timeColor : defaults.timeColor,
        fontFamily: String(given.fontFamily || defaults.fontFamily).slice(0, 120)
      });
      result[theme].showAvatar = typeof given.showAvatar === 'boolean' ? given.showAvatar : defaults.showAvatar;
      ['viewerColor', 'hostColor', 'managerColor', 'governorColor', 'admiralColor', 'captainColor'].forEach((key) => {
        result[theme][key] = /^#[0-9a-f]{6}$/i.test(given[key] || '') ? given[key] : defaults[key];
      });
      if (theme === 'pixel') {
        result[theme].messageFont = Math.max(32, result[theme].messageFont);
        result[theme].nameFont = Math.max(22, result[theme].nameFont);
        result[theme].metaFont = Math.max(22, result[theme].metaFont);
        result[theme].timeFont = Math.max(22, result[theme].timeFont);
      }
    });
    return result;
  }

  function currentThemeConfig() {
    return settings.themeConfigs[settings.theme] || DEFAULT_THEME_CONFIGS[settings.theme];
  }

  function applyResponsiveTheme() {
    const config = currentThemeConfig();
    // Width controls typography and wrapping. Height is the chat viewport and
    // must only change how many rows fit; otherwise shortening the window also
    // shrinks every row and preserves the empty space the user tried to remove.
    // The desktop preview and OBS are the same canonical canvas. Window size
    // changes are synchronized by the main process, so both outputs must use
    // identical typography instead of independently responsive layouts.
    const widthRatio = 1;
    // Width primarily changes line wrapping.  Keep a small optical response so
    // proportional resizing still feels alive, but never let a wide overlay
    // turn 32px chat text into page-sized display type.
    const responsive = Math.max(0.9, Math.min(1.12, Math.pow(widthRatio, 0.25)));
    const scale = responsive * config.overallScale / 100;
    const root = document.documentElement.style;
    root.setProperty('--ui-scale', scale.toFixed(4));
    root.setProperty('--message-gap-base', config.messageGap + 'px');
    root.setProperty('--message-font-base', config.messageFont + 'px');
    root.setProperty('--name-font-base', config.nameFont + 'px');
    root.setProperty('--meta-font-base', config.metaFont + 'px');
    root.setProperty('--time-font-base', config.timeFont + 'px');
    root.setProperty('--body-color', config.bodyColor);
    root.setProperty('--gift-color', config.giftColor);
    root.setProperty('--time-color', config.timeColor);
    root.setProperty('--theme-font-family', '"' + config.fontFamily.replace(/["\\]/g, '') + '"');
    document.body.style.setProperty('--viewer', config.viewerColor);
    document.body.style.setProperty('--host', config.hostColor);
    document.body.style.setProperty('--manager', config.managerColor);
    document.body.style.setProperty('--governor', config.governorColor);
    document.body.style.setProperty('--admiral', config.admiralColor);
    document.body.style.setProperty('--captain', config.captainColor);
    document.body.classList.toggle('show-avatars', config.showAvatar !== false);
    const surfaceOpacity = config.surfaceOpacity / 100;
    root.setProperty('--surface-opacity', surfaceOpacity.toFixed(2));
    root.setProperty('--surface-blur', (20 * surfaceOpacity).toFixed(1) + 'px');
    root.setProperty('--surface-saturation', (100 + 8 * surfaceOpacity).toFixed(1) + '%');
    root.setProperty('--surface-texture-opacity', (0.24 * surfaceOpacity).toFixed(3));
    requestAnimationFrame(() => {
      pruneMessages();
      if (settings.theme === 'pixel') renderAllPixelRows();
    });
  }

  function pad(number) {
    return String(number).padStart(2, '0');
  }

  function timeNow() {
    const date = new Date();
    return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
  }

  function formatGap(milliseconds) {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return '';
    if (milliseconds < 1000) return Math.max(0, Math.round(milliseconds)) + 'ms';
    if (milliseconds < 60000) {
      const seconds = milliseconds / 1000;
      return (seconds < 10 && Math.round(seconds) !== seconds ? seconds.toFixed(1) : Math.round(seconds)) + 's';
    }
    const totalSeconds = Math.round(milliseconds / 1000);
    return Math.floor(totalSeconds / 60) + 'm ' + (totalSeconds % 60) + 's';
  }

  function consumeGap(override) {
    const now = Date.now();
    const gap = Number.isFinite(override) ? override : (lastMessageAt ? now - lastMessageAt : null);
    lastMessageAt = now;
    return gap;
  }

  function roleFromGuardLevel(level) {
    return GUARD_ROLES[Number(level) || 0] || 'viewer';
  }

  function resolveRole(uid, isManager, guardLevel) {
    if (ownerUid > 0 && Number(uid) === ownerUid) return 'host';
    if (isManager) return 'manager';
    return roleFromGuardLevel(guardLevel);
  }

  function leaf(className, text) {
    const element = document.createElement('span');
    element.className = className + ' pixel-source';
    element.dataset.pixelText = String(text || '');
    element.textContent = String(text || '');
    return element;
  }

  function avatarInitial(name) {
    const characters = Array.from(String(name || '').trim());
    return characters[0] || '?';
  }

  function applyAvatarImage(avatar, rawUrl) {
    const url = window.DanmuAvatars && window.DanmuAvatars.normalizeUrl(rawUrl);
    if (!url || !avatar) return;
    const image = document.createElement('img');
    image.alt = '';
    image.loading = 'eager';
    image.decoding = 'async';
    image.referrerPolicy = 'no-referrer';
    image.addEventListener('load', () => avatar.classList.add('has-image'), { once: true });
    image.addEventListener('error', () => image.remove(), { once: true });
    image.src = '/api/emote_image?url=' + encodeURIComponent(url);
    avatar.appendChild(image);
  }

  function lookupAvatar(uid) {
    const key = String(Number(uid) || 0);
    if (key === '0') return Promise.resolve('');
    if (avatarUrlCache.has(key)) return Promise.resolve(avatarUrlCache.get(key));
    if (avatarLookupPending.has(key)) return avatarLookupPending.get(key);
    const pending = fetch('/api/user_avatar?uid=' + encodeURIComponent(key))
      .then((response) => response.json())
      .then((result) => {
        const url = result && result.ok ? String(result.avatarUrl || '') : '';
        avatarUrlCache.set(key, url);
        return url;
      })
      .catch(() => {
        avatarUrlCache.set(key, '');
        return '';
      })
      .finally(() => avatarLookupPending.delete(key));
    avatarLookupPending.set(key, pending);
    return pending;
  }

  function makeAvatar(message) {
    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    const fallback = document.createElement('span');
    fallback.className = 'message-avatar-fallback';
    fallback.textContent = avatarInitial(message.uname);
    avatar.appendChild(fallback);
    if (message.avatarUrl) {
      applyAvatarImage(avatar, message.avatarUrl);
    } else if (Number(message.uid) > 0) {
      lookupAvatar(message.uid).then((url) => applyAvatarImage(avatar, url));
    }
    return avatar;
  }

  function appendRichBody(element, text, emotes) {
    const source = String(text || '');
    const keys = Object.keys(emotes || {}).filter((key) => key && source.includes(key)).sort((a, b) => b.length - a.length);
    if (!keys.length) {
      element.textContent = source;
      return;
    }

    let cursor = 0;
    while (cursor < source.length) {
      let nextKey = '';
      let nextIndex = source.length;
      keys.forEach((key) => {
        const index = source.indexOf(key, cursor);
        if (index !== -1 && index < nextIndex) {
          nextIndex = index;
          nextKey = key;
        }
      });
      if (!nextKey) {
        element.appendChild(document.createTextNode(source.slice(cursor)));
        break;
      }
      if (nextIndex > cursor) element.appendChild(document.createTextNode(source.slice(cursor, nextIndex)));
      const visual = document.createElement('span');
      visual.className = 'emote-visual';
      const image = document.createElement('img');
      image.className = 'emote-image';
      if (emotes[nextKey].official) {
        visual.classList.add('is-official');
        image.classList.add('is-official');
      }
      image.alt = nextKey;
      image.title = nextKey;
      image.loading = 'eager';
      image.decoding = 'async';
      image.referrerPolicy = 'no-referrer';
      const pixelCanvas = document.createElement('canvas');
      pixelCanvas.className = 'emote-pixel-canvas';
      pixelCanvas.setAttribute('aria-hidden', 'true');
      image.addEventListener('load', () => {
        if (settings.theme === 'pixel') renderPixelEmote(image);
      });
      image.addEventListener('error', () => {
        visual.replaceWith(document.createTextNode(nextKey));
      }, { once: true });
      image.src = '/api/emote_image?url=' + encodeURIComponent(emotes[nextKey].url);
      visual.append(image, pixelCanvas);
      element.appendChild(visual);
      cursor = nextIndex + nextKey.length;
    }
  }

  function makeMessageRow(message) {
    const row = document.createElement('article');
    row.className = 'message-row role-' + (message.role || 'viewer') + ' is-' + message.type;
    row.appendChild(makeAvatar(message));

    const gapText = formatGap(message.gapMs);
    if (gapText) {
      const gap = document.createElement('div');
      gap.className = 'message-gap pixel-source';
      gap.dataset.pixelText = '+ Thought: ' + gapText;
      gap.textContent = gap.dataset.pixelText;
      row.appendChild(gap);
    }

    const meta = document.createElement('header');
    meta.className = 'message-meta';
    const identity = document.createElement('div');
    identity.className = 'identity-cluster';
    identity.appendChild(leaf('user-name', message.uname || '匿名用户'));

    const roleLabel = ROLE_LABELS[message.role] || '';
    if (roleLabel) {
      const role = leaf('role-label', roleLabel);
      role.dataset.pixelText = '[' + roleLabel + ']';
      identity.appendChild(role);
    }
    if (message.medal) identity.appendChild(leaf('medal-label', message.medal));
    meta.appendChild(identity);

    if (Number.isFinite(message.valueYuan)) {
      const kind = message.type === 'sc' ? 'SC' : (message.kind === 'guard' ? 'Guard' : 'Gift');
      meta.appendChild(leaf('gift-value', '▣ ' + kind + ' · ￥ ' + message.valueYuan.toFixed(2)));
    }

    const body = document.createElement('div');
    body.className = 'message-body pixel-source';
    body.dataset.pixelText = String(message.text || '');
    appendRichBody(body, message.text, message.emotes);
    Object.keys(message.emotes || {}).forEach((key) => {
      body.dataset.pixelText = body.dataset.pixelText.split(key).join('　');
    });

    const time = document.createElement('time');
    time.className = 'message-time pixel-source';
    time.dataset.pixelText = message.time || timeNow();
    time.textContent = time.dataset.pixelText;

    row.append(meta, body, time);
    return row;
  }

  function pruneMessages() {
    const stack = els.messageList;
    let rows = stack.querySelectorAll(':scope > .message-row');
    while (rows.length > MAX_MESSAGES) {
      rows[0].remove();
      rows = stack.querySelectorAll(':scope > .message-row');
    }
  }

  function updateEmptyState() {
    const hasMessages = !!(
      els.pinnedScStack.querySelector('.message-row') ||
      els.messageList.querySelector('.message-row')
    );
    els.emptyState.hidden = hasMessages;
  }

  function resetSwipeRow(row) {
    row.classList.remove('is-swiping', 'is-swipe-dismissed');
    row.classList.add('is-swipe-resetting');
    row.style.transform = '';
    row.style.opacity = '';
    setTimeout(() => row.classList.remove('is-swipe-resetting'), 180);
  }

  function dismissScRow(row, direction) {
    const id = row.dataset.sceneId;
    if (!desktopApi || isObsMode || !id || typeof desktopApi.dismissSc !== 'function') {
      resetSwipeRow(row);
      return;
    }
    row.classList.remove('is-swiping', 'is-swipe-resetting');
    row.classList.add('is-swipe-dismissed');
    row.style.transform = 'translateX(' + (direction * (row.offsetWidth + 48)) + 'px)';
    row.style.opacity = '0';
    desktopApi.dismissSc(id).then((dismissed) => {
      if (!dismissed) {
        resetSwipeRow(row);
        return;
      }
      setTimeout(() => {
        row.remove();
        updateEmptyState();
      }, 190);
    }).catch(() => resetSwipeRow(row));
  }

  function bindScSwipe(row) {
    if (isObsMode || !desktopApi || row.dataset.swipeBound === 'true') return;
    row.dataset.swipeBound = 'true';
    let gesture = null;

    row.addEventListener('pointerdown', (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      gesture = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, dx: 0, horizontal: false };
      row.setPointerCapture(event.pointerId);
    });
    row.addEventListener('pointermove', (event) => {
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      const dx = event.clientX - gesture.startX;
      const dy = event.clientY - gesture.startY;
      if (!gesture.horizontal && Math.abs(dx) < 6) return;
      if (!gesture.horizontal && Math.abs(dx) <= Math.abs(dy)) return;
      gesture.horizontal = true;
      gesture.dx = dx;
      row.classList.remove('is-swipe-resetting');
      row.classList.add('is-swiping');
      row.style.transform = 'translateX(' + dx + 'px)';
      row.style.opacity = String(Math.max(0.25, 1 - Math.abs(dx) / Math.max(1, row.offsetWidth)));
    });

    function finishSwipe(event) {
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      const completed = gesture.horizontal && Math.abs(gesture.dx) >= Math.max(72, row.offsetWidth * 0.22);
      const direction = gesture.dx < 0 ? -1 : 1;
      gesture = null;
      if (completed) dismissScRow(row, direction);
      else resetSwipeRow(row);
    }

    row.addEventListener('pointerup', finishSwipe);
    row.addEventListener('pointercancel', finishSwipe);
  }

  function appendMessage(message, sceneId) {
    const row = makeMessageRow(message);
    if (sceneId !== undefined && sceneId !== null) {
      row.dataset.sceneId = String(sceneId);
      row.dataset.sceneMessage = JSON.stringify(message);
    }
    const target = message.type === 'sc' ? els.pinnedScStack : els.messageList;
    target.appendChild(row);
    if (message.type === 'sc') bindScSwipe(row);
    updateEmptyState();
    requestAnimationFrame(() => {
      pruneMessages();
      if (settings.theme === 'pixel') renderPixelRow(row);
    });
    return row;
  }

  function addMessage(message, gapOverride) {
    const gapMs = consumeGap(gapOverride);
    const normalized = Object.assign({}, message, {
      gapMs,
      time: message.time || timeNow(),
      at: lastMessageAt,
      emotes: Object.assign({}, message.emotes || {})
    });
    if (!isObsMode && desktopApi && typeof desktopApi.publishSceneMessage === 'function') {
      scenePublishQueue = scenePublishQueue.then(async () => {
        const accepted = await desktopApi.publishSceneMessage(normalized);
        if (accepted) appendMessage(accepted, accepted.id);
        else appendMessage(normalized);
      }).catch(() => appendMessage(normalized));
      return;
    }
    appendMessage(normalized);
  }

  function renderSceneSnapshot(scene) {
    if (!scene || !Array.isArray(scene.messages)) return;
    const revision = Number(scene.revision);
    if (Number.isFinite(revision) && revision < renderedSceneRevision) return;
    const existing = new Map();
    els.messageStack.querySelectorAll('.message-row[data-scene-id]').forEach((row) => {
      existing.set(row.dataset.sceneId, row);
    });
    const keep = new Set();
    scene.messages.forEach((message) => {
      const id = String(message && message.id || '');
      if (!id) return;
      keep.add(id);
      const signature = JSON.stringify(message);
      let row = existing.get(id);
      if (!row || row.dataset.sceneMessage !== signature) {
        const replacement = makeMessageRow(message);
        replacement.dataset.sceneId = id;
        replacement.dataset.sceneMessage = signature;
        if (message.type === 'sc') bindScSwipe(replacement);
        if (row) row.replaceWith(replacement);
        row = replacement;
      }
      const target = message.type === 'sc' ? els.pinnedScStack : els.messageList;
      target.appendChild(row);
    });
    existing.forEach((row, id) => {
      if (!keep.has(id)) row.remove();
    });
    updateEmptyState();
    if (!isObsMode && scene.messages.length) {
      const latestAt = Number(scene.messages[scene.messages.length - 1].at);
      if (Number.isFinite(latestAt)) lastMessageAt = latestAt;
    }
    if (Number.isFinite(revision)) renderedSceneRevision = revision;
    requestAnimationFrame(() => {
      pruneMessages();
      if (settings.theme === 'pixel') renderAllPixelRows();
    });
  }

  function clearDisplayedScene() {
    els.messageStack.querySelectorAll('.message-row').forEach((row) => row.remove());
    updateEmptyState();
    lastMessageAt = 0;
    renderedSceneRevision = -1;
  }

  function parseDanmaku(obj) {
    const info = Array.isArray(obj.info) ? obj.info : [];
    const user = Array.isArray(info[2]) ? info[2] : [];
    const medal = Array.isArray(info[3]) ? info[3] : [];
    const uid = Number(user[0]) || 0;
    const guardLevel = Number(info[7]) || 0;
    const text = String(info[1] || '');
    const packetEmotes = window.DanmuEmotes.extractDanmakuEmotes(obj, info);
    return {
      type: 'chat',
      uid,
      uname: user[1] || '',
      text,
      emotes: window.DanmuEmotes.mergeRoomEmotes(text, packetEmotes, roomEmoteAliases),
      avatarUrl: window.DanmuAvatars ? window.DanmuAvatars.extractDanmakuAvatar(obj, info) : '',
      role: resolveRole(uid, Number(user[2]) === 1, guardLevel),
      medal: medal[1] ? String(medal[1]) + ' ' + (Number(medal[0]) || 0) : ''
    };
  }

  function guardLevelFromName(name) {
    const text = String(name || '');
    if (text.includes('总督')) return 1;
    if (text.includes('提督')) return 2;
    if (text.includes('舰长')) return 3;
    return 0;
  }

  function giftContext(obj, gift) {
    const cmd = String(obj.cmd || '').split(':')[0];
    const data = obj.data || {};
    const userInfo = data.user_info || {};
    const senderBase = data.sender_uinfo && data.sender_uinfo.base ? data.sender_uinfo.base : {};
    const medal = data.medal_info || userInfo.medal_info || {};
    const uid = Number(data.uid || userInfo.uid || senderBase.uid) || 0;
    const isManager = Number(userInfo.manager || data.is_admin) === 1;
    const guardLevel = Number(data.guard_level || userInfo.guard_level) || guardLevelFromName(gift.giftName);
    const role = resolveRole(uid, isManager, guardLevel);
    const valueYuan = gift.coinIsYuan ? Number(gift.coin) || 0 : (Number(gift.coin) || 0) / 1000;
    const kind = cmd === 'SUPER_CHAT_MESSAGE' ? 'sc' : (cmd === 'GUARD_BUY' || cmd === 'USER_TOAST_MSG_V2' ? 'guard' : 'gift');
    let text = '';
    if (kind === 'sc') {
      text = data.message || '超级留言';
    } else if (kind === 'guard') {
      text = '开通  ' + (gift.giftName || '大航海') + (Number(gift.num) > 1 ? ' × ' + gift.num : '');
    } else {
      text = '赠送  ' + (gift.giftName || '礼物') + ' × ' + (Number(gift.num) || 1);
    }
    return {
      type: kind === 'sc' ? 'sc' : 'gift',
      kind,
      uid,
      uname: gift.uname || userInfo.uname || senderBase.name || '匿名用户',
      avatarUrl: window.DanmuAvatars ? window.DanmuAvatars.extractEventAvatar(obj) : '',
      text,
      role,
      medal: medal.medal_name ? String(medal.medal_name) + ' ' + (Number(medal.medal_level) || 0) : '',
      valueYuan
    };
  }

  function onRaw(obj) {
    const cmd = String(obj.cmd || '').split(':')[0];
    if (cmd === 'DANMU_MSG') {
      addMessage(parseDanmaku(obj));
      return;
    }
    const extractor = window.BiliLive && window.BiliLive._test && window.BiliLive._test.extractGift;
    if (!extractor) return;
    const gift = extractor(obj);
    if (gift) addMessage(giftContext(obj, gift));
  }

  function reportStatus(status) {
    if (!isObsMode && desktopApi) desktopApi.reportStatus(status);
  }

  function ensureClient() {
    if (isObsMode) return;
    if (client) return;
    client = window.BiliLive.createClient();
    client.onStatus(reportStatus);
    client.onRawCommand(onRaw);
  }

  async function loadRoomEmotes(roomId, generation) {
    try {
      const response = await fetch('/api/room_emotes?roomId=' + encodeURIComponent(roomId));
      const result = await response.json();
      if (generation !== connectGeneration) return;
      roomEmoteAliases = result && result.ok
        ? window.DanmuEmotes.buildRoomEmoteAliases(result.emotes)
        : {};
    } catch (e) {
      if (generation === connectGeneration) roomEmoteAliases = {};
    }
  }

  async function connectRoom(roomId) {
    if (isObsMode) return;
    const normalized = String(roomId || '').trim();
    const generation = ++connectGeneration;
    if (!/^\d+$/.test(normalized)) {
      connectedRoomId = '';
      ownerUid = 0;
      roomEmoteAliases = {};
      if (client) client.disconnect();
      reportStatus('disconnected');
      return;
    }

    let resolvedRoomId = normalized;
    roomEmoteAliases = {};
    try {
      const response = await fetch('/api/room_info?roomId=' + encodeURIComponent(normalized));
      const result = await response.json();
      if (generation !== connectGeneration) return;
      ownerUid = result && result.ok ? Number(result.ownerUid) || 0 : 0;
      if (result && result.ok && /^\d+$/.test(String(result.roomId || ''))) {
        resolvedRoomId = String(result.roomId);
      }
    } catch (e) {
      if (generation !== connectGeneration) return;
      ownerUid = 0;
    }

    loadRoomEmotes(resolvedRoomId, generation);

    if (client && connectedRoomId && connectedRoomId !== normalized) {
      client.disconnect();
      client = null;
    }
    ensureClient();
    connectedRoomId = normalized;
    client.connect(normalized);
  }

  function applySettings(next) {
    const previousRoom = settings.roomId;
    settings = Object.assign(settings, next || {});
    if (!isObsMode) {
      // The desktop viewport is the canonical live canvas. Saved dimensions
      // can lag behind while the user is dragging a resize handle, so using
      // them here leaves the themed surface at its previous size until a later
      // settings round-trip completes.
      setCanvasSize(window.innerWidth, window.innerHeight);
    }
    if (!THEMES.has(settings.theme)) settings.theme = 'glass';
    if (Number(settings.themeConfigVersion) !== THEME_CONFIG_VERSION) {
      settings.themeConfigs = null;
      settings.themeConfigVersion = THEME_CONFIG_VERSION;
    }
    settings.themeConfigs = normalizeThemeConfigs(settings.themeConfigs);
    document.body.dataset.theme = settings.theme;
    document.body.classList.toggle('size-locked', settings.overlaySizeLocked === true);
    applyResponsiveTheme();
    if (settings.theme === 'pixel') schedulePixelRender();
    if (!isObsMode && (String(settings.roomId || '') !== String(previousRoom || '') || String(settings.roomId || '') !== connectedRoomId)) {
      connectRoom(settings.roomId);
    }
  }

  function applyOutputState(state) {
    if (isObsMode && state && state.canvas) {
      const width = Math.max(MIN_CANVAS_WIDTH, Math.min(3840, Math.round(Number(state.canvas.width) || 720)));
      const height = Math.max(MIN_CANVAS_HEIGHT, Math.min(2160, Math.round(Number(state.canvas.height) || 900)));
      setCanvasSize(width, height);
    }
    applySettings(state && state.settings ? state.settings : {});
    if (isObsMode && state && state.scene) renderSceneSnapshot(state.scene);
  }

  function addPreviewMessages() {
    const samples = [
      { type: 'chat', uname: '神绮爱', role: 'host', medal: '', text: '今晚的声音刚刚好' },
      { type: 'chat', uname: '小透明', role: 'manager', medal: '', text: '连接状态正常，弹幕已同步' },
      { type: 'chat', uname: '赤焰之心', role: 'governor', medal: '陪伴 18', text: '继续加油，期待更多精彩！' },
      { type: 'chat', uname: '紫电青霜', role: 'admiral', medal: '陪伴 12', text: '一起陪伴主播成长！' },
      { type: 'chat', uname: '晨曦之光', role: 'captain', medal: '陪伴 6', text: '舰长来啦，支持神绮爱！' },
      { type: 'chat', uname: '星河入梦', role: 'viewer', medal: '', text: '这套界面看着很舒服' },
      { type: 'gift', kind: 'gift', uname: '云水之间', role: 'viewer', medal: '', text: '赠送  小花花 × 10', valueYuan: 30 },
      { type: 'sc', kind: 'sc', uname: '晚风与你', role: 'captain', medal: '', text: '求配置和键位分享～', valueYuan: 50 }
    ];
    const gaps = [451, 385, 12000, 24000, 24000, 36000, 50000, 70000];
    samples.forEach((sample, index) => addMessage(sample, gaps[index]));
  }

  function renderPixelEmote(image) {
    if (!image || !image.complete || !image.naturalWidth) return;
    const visual = image.closest('.emote-visual');
    const canvas = visual && visual.querySelector('.emote-pixel-canvas');
    if (!visual || !canvas) return;
    const width = Math.max(1, Math.round(image.offsetWidth));
    const height = Math.max(1, Math.round(image.offsetHeight));
    if (width < 2 || height < 2) return;

    const ratio = 1;
    const cell = Math.max(3, Math.round(2 * ratio));
    const targetWidth = Math.max(1, Math.round(width * ratio));
    const targetHeight = Math.max(1, Math.round(height * ratio));
    const columns = Math.max(8, Math.floor(targetWidth / cell));
    const rows = Math.max(8, Math.floor(targetHeight / cell));
    const source = document.createElement('canvas');
    source.width = columns;
    source.height = rows;
    const sourceContext = source.getContext('2d', { willReadFrequently: true });
    sourceContext.clearRect(0, 0, columns, rows);
    sourceContext.drawImage(image, 0, 0, columns, rows);
    let pixels;
    try {
      pixels = sourceContext.getImageData(0, 0, columns, rows).data;
    } catch (e) {
      return;
    }

    canvas.width = targetWidth;
    canvas.height = targetHeight;
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    const context = canvas.getContext('2d');
    context.imageSmoothingEnabled = false;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = currentThemeConfig().bodyColor;

    // Emotes are illustrations, not photographs.  Filling their whole area
    // with ordered noise destroys the face at chat size, so keep only the
    // alpha silhouette and strong internal colour/luminance boundaries.  The
    // small Bayer variation prevents shallow diagonal lines from disappearing
    // without turning flat regions back into noise.
    const bayer = [
      [0, 8, 2, 10], [12, 4, 14, 6],
      [3, 11, 1, 9], [15, 7, 13, 5]
    ];
    const luminanceAt = (offset) => (
      pixels[offset] * 0.2126 + pixels[offset + 1] * 0.7152 + pixels[offset + 2] * 0.0722
    ) / 255;
    const dot = cell - 1;
    const inset = Math.floor((cell - dot) / 2);
    const drawingWidth = columns * cell;
    const drawingHeight = rows * cell;
    const originX = Math.floor((canvas.width - drawingWidth) / 2);
    const originY = Math.floor((canvas.height - drawingHeight) / 2);
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < columns; x += 1) {
        const offset = (y * columns + x) * 4;
        const alpha = pixels[offset + 3] / 255;
        if (alpha <= 0.02) continue;
        const luminance = luminanceAt(offset);
        let edge = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (!dx && !dy) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || nx >= columns || ny < 0 || ny >= rows) {
              edge = Math.max(edge, alpha);
              continue;
            }
            const neighbourOffset = (ny * columns + nx) * 4;
            const neighbourAlpha = pixels[neighbourOffset + 3] / 255;
            const sharedAlpha = Math.min(alpha, neighbourAlpha);
            const alphaEdge = Math.abs(alpha - neighbourAlpha);
            const lightEdge = Math.abs(luminance - luminanceAt(neighbourOffset)) * sharedAlpha;
            const redEdge = Math.abs(pixels[offset] - pixels[neighbourOffset]) / 255;
            const greenEdge = Math.abs(pixels[offset + 1] - pixels[neighbourOffset + 1]) / 255;
            const blueEdge = Math.abs(pixels[offset + 2] - pixels[neighbourOffset + 2]) / 255;
            const colourEdge = Math.max(redEdge, greenEdge, blueEdge) * sharedAlpha;
            edge = Math.max(edge, alphaEdge * 1.35, lightEdge * 1.2, colourEdge);
          }
        }
        const threshold = 0.1 + (bayer[y % 4][x % 4] / 15) * 0.12;
        if (edge < threshold) continue;
        const px = originX + x * cell + inset;
        const py = originY + y * cell + inset;
        context.fillRect(px, py, dot, dot);
      }
    }
  }

  function renderPixelRow(row) {
    if (bitmapPixelFont) {
      row.querySelectorAll('.pixel-source').forEach((element) => {
        window.BitmapPixelFont.render(element, bitmapPixelFont, currentThemeConfig().bodyColor);
      });
    }
    row.querySelectorAll('.emote-image').forEach(renderPixelEmote);
  }

  function renderAllPixelRows() {
    if (settings.theme !== 'pixel') return;
    els.messageStack.querySelectorAll('.message-row').forEach(renderPixelRow);
  }

  function schedulePixelRender() {
    if (pixelRenderTimer) clearTimeout(pixelRenderTimer);
    pixelRenderTimer = setTimeout(() => {
      pixelRenderTimer = null;
      requestAnimationFrame(renderAllPixelRows);
    }, 60);
  }

  function showUnlockToast(clickThrough) {
    document.body.classList.toggle('is-click-through', clickThrough);
    if (clickThrough) return;
    els.unlockToast.classList.remove('show');
    void els.unlockToast.offsetWidth;
    els.unlockToast.classList.add('show');
  }

  function queueOverlayResize(bounds) {
    pendingResize = bounds;
    if (resizeFrame !== null) return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = null;
      const next = pendingResize;
      pendingResize = null;
      if (next && desktopApi) desktopApi.setOverlayBounds(next);
    });
  }

  function bindResizeHandle() {
    if (!desktopApi || isObsMode) return;
    document.querySelectorAll('[data-resize-edge]').forEach((handle) => {
      handle.addEventListener('pointerdown', async (event) => {
        event.preventDefault();
        handle.setPointerCapture(event.pointerId);
        const state = await desktopApi.getWindowState();
        const bounds = state.overlayBounds || { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
        resizeSession = {
          pointerId: event.pointerId,
          edge: handle.dataset.resizeEdge,
          startX: event.screenX,
          startY: event.screenY,
          bounds: {
            x: Number(bounds.x) || 0,
            y: Number(bounds.y) || 0,
            width: Number(bounds.width) || window.innerWidth,
            height: Number(bounds.height) || window.innerHeight
          }
        };
      });

      handle.addEventListener('pointermove', (event) => {
        if (!resizeSession || event.pointerId !== resizeSession.pointerId) return;
        const edge = resizeSession.edge;
        const base = resizeSession.bounds;
        const dx = event.screenX - resizeSession.startX;
        const dy = event.screenY - resizeSession.startY;
        let x = base.x;
        let y = base.y;
        let width = base.width;
        let height = base.height;

        if (edge.includes('e')) width = base.width + dx;
        if (edge.includes('s')) height = base.height + dy;
        if (edge.includes('w')) {
          width = base.width - dx;
          x = base.x + dx;
        }
        if (edge.includes('n')) {
          height = base.height - dy;
          y = base.y + dy;
        }

        if (width < MIN_CANVAS_WIDTH) {
          if (edge.includes('w')) x = base.x + base.width - MIN_CANVAS_WIDTH;
          width = MIN_CANVAS_WIDTH;
        }
        if (height < MIN_CANVAS_HEIGHT) {
          if (edge.includes('n')) y = base.y + base.height - MIN_CANVAS_HEIGHT;
          height = MIN_CANVAS_HEIGHT;
        }
        queueOverlayResize({ x, y, width, height });
      });

      function endResize(event) {
        if (!resizeSession || event.pointerId !== resizeSession.pointerId) return;
        resizeSession = null;
      }

      handle.addEventListener('pointerup', endResize);
      handle.addEventListener('pointercancel', endResize);
    });
  }

  async function init() {
    els.messageStack = document.getElementById('messageStack');
    els.pinnedScStack = document.getElementById('pinnedScStack');
    els.messageList = document.getElementById('messageList');
    els.emptyState = document.getElementById('emptyState');
    els.unlockToast = document.getElementById('unlockToast');
    document.body.classList.toggle('obs-output', isObsMode);
    if (isObsMode) document.body.dataset.outputPixelRatio = '1';
    if (isObsMode && els.emptyState) {
      const hint = els.emptyState.querySelector('.empty-state-hint');
      if (hint) hint.textContent = 'OBS 镜像输出已就绪';
    }
    if (desktopApi) {
      const stored = await desktopApi.loadSettings();
      let storedScene = null;
      if (typeof desktopApi.loadScene === 'function') {
        storedScene = await desktopApi.loadScene();
      }
      applySettings(stored || {});
      renderSceneSnapshot(storedScene);
    } else {
      try {
        const response = await fetch('/api/desktop-output-state', { cache: 'no-store' });
        const state = await response.json();
        applyOutputState(state);
      } catch (e) {
        applyOutputState({});
      }
    }
    window.BitmapPixelFont.load('/desktop/fonts/unifont-16px.fpb.gz').then((font) => {
      bitmapPixelFont = font;
      document.body.classList.add('pixel-font-ready');
      if (settings.theme === 'pixel') requestAnimationFrame(renderAllPixelRows);
    }).catch(() => {
      bitmapPixelFont = null;
      document.body.classList.remove('pixel-font-ready');
    });
    if (desktopApi) {
      desktopApi.onSettingsChanged(applySettings);
      desktopApi.onPreviewMessages(addPreviewMessages);
      desktopApi.onSceneCleared(clearDisplayedScene);
      desktopApi.onClickThroughChanged(showUnlockToast);
    } else {
      const events = new EventSource('/api/desktop-output-events');
      events.addEventListener('settings', (event) => {
        try {
          const state = JSON.parse(event.data);
          applyOutputState(state);
        } catch (e) {}
      });
      events.addEventListener('scene', (event) => {
        try {
          renderSceneSnapshot(JSON.parse(event.data));
        } catch (e) {}
      });
    }
    window.addEventListener('resize', () => {
      if (isObsMode) applyStageFit();
      else {
        setCanvasSize(window.innerWidth, window.innerHeight);
        reportPreviewViewport();
      }
      applyResponsiveTheme();
      schedulePixelRender();
    });
    bindResizeHandle();
    if (desktopApi) {
      desktopApi.overlayReady();
      reportPreviewViewport();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
