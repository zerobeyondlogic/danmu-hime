(function () {
  'use strict';

  const desktopApi = window.DesktopOverlay || null;
  const isObsMode = new URLSearchParams(window.location.search).get('mode') === 'obs' || !desktopApi;
  const loadedAppVersion = String(document.documentElement.dataset.appVersion || '');

  const themeRegistry = window.DanmuThemes;
  const skinFonts = window.DanmuSkinFonts.create({ fonts: document.fonts, FontFace: window.FontFace });
  const ROLE_LABELS = {
    host: '主播',
    manager: '房管',
    governor: '总督',
    admiral: '提督',
    captain: '舰长',
    viewer: ''
  };
  const MAX_MESSAGES = 48;
  const MAX_AVATAR_URLS = 512;
  const AVATAR_SUCCESS_TTL = 6 * 60 * 60 * 1000;
  const AVATAR_FAILURE_TTL = 15000;
  const MIN_CANVAS_WIDTH = 240;
  const MIN_CANVAS_HEIGHT = 160;
  const THEME_CONFIG_VERSION = themeRegistry.configVersion;
  const DEFAULT_THEME_CONFIGS = themeRegistry.defaults;

  let settings = {
    roomId: '',
    theme: 'glass',
    alwaysOnTop: true,
    themeConfigs: null,
    themeConfigVersion: THEME_CONFIG_VERSION
  };
  const avatarUrlCache = new Map();
  const avatarLookupPending = new Map();
  const avatarLookupControllers = new Map();
  const avatarSources = new WeakMap();
  const artMessages = new WeakMap();
  const artRows = new Map();
  const artQueue = new Set();
  const giftImageUrlCache = new Map();
  let artObserver = null;
  let activeArtLoads = 0;
  let messageFitObserver = null;
  let messageFitFrame = null;
  const messageMotions = new Map();
  const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
  let messageMotionFrame = null;
  let messageMotionGeometry = null;
  let lastMessageMotionAt = 0;
  const measuredMessageRows = new Set();
  let resizeSession = null;
  let resizeFrame = null;
  let pendingResize = null;
  let viewportReportFrame = null;
  let canvasWidth = 515;
  let canvasHeight = 650;
  let renderedSceneRevision = -1;
  let latestWelcome = null;
  let welcomeTimer = null;
  let welcomeDeadline = 0;
  let renderedSessionId = '';
  const retiredSessionIds = new Set();
  let outputEvents = null;
  let pageHidden = false;
  let outputInitialized = false;
  let streamGeneration = 0;
  let streamStateSerial = 0;
  let stateRefreshTask = null;
  let stateRefreshController = null;
  let stateRefreshTimeout = null;
  let versionReloadRequested = false;
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
    const nextWidth = Math.max(MIN_CANVAS_WIDTH, Math.min(3840, Math.round(Number(width) || 515)));
    const nextHeight = Math.max(MIN_CANVAS_HEIGHT, Math.min(2160, Math.round(Number(height) || 650)));
    if (nextWidth !== canvasWidth || nextHeight !== canvasHeight) cancelMessageMotion();
    canvasWidth = nextWidth;
    canvasHeight = nextHeight;
    applyStageFit();
  }

  function reportPreviewViewport() {
    if (!desktopApi || isObsMode || viewportReportFrame !== null) return;
    viewportReportFrame = requestAnimationFrame(() => {
      viewportReportFrame = null;
      desktopApi.reportViewport({ width: window.innerWidth, height: window.innerHeight });
    });
  }

  function currentThemeConfig() {
    return settings.themeConfigs[settings.theme] || DEFAULT_THEME_CONFIGS[settings.theme];
  }

  function applyResponsiveTheme() {
    cancelMessageMotion();
    const config = currentThemeConfig();
    skinFonts.sync(settings.theme, config.fontFamily);
    // Typography uses the saved scale in every output. Canvas dimensions only
    // affect line wrapping and the number of visible cards.
    const scale = config.overallScale / 100;
    const root = document.documentElement.style;
    root.setProperty('--ui-scale', scale.toFixed(4));
    root.setProperty('--message-gap-base', config.messageGap + 'px');
    root.setProperty('--content-inset-inline', config.horizontalPadding + 'px');
    root.setProperty('--welcome-font-base', config.welcomeFont + 'px');
    root.setProperty('--message-font-base', config.messageFont + 'px');
    root.setProperty('--emote-scale', (Math.max(50, Math.min(200, Number(config.emoteScale) || 100)) / 100).toFixed(3));
    root.setProperty('--name-font-base', config.nameFont + 'px');
    root.setProperty('--meta-font-base', config.metaFont + 'px');
    root.setProperty('--time-font-base', config.timeFont + 'px');
    root.setProperty('--body-color', config.bodyColor);
    root.setProperty('--gift-color', config.giftColor);
    root.setProperty('--time-color', config.timeColor);
    const medalColor = config.medalColor || '#eceff4';
    root.setProperty('--medal-rgb', [1, 3, 5].map(index => parseInt(medalColor.slice(index, index + 2), 16)).join(', '));
    root.setProperty('--thought-color', config.thoughtColor || '#f1a431');
    root.setProperty('--gift-value-color', config.giftValueColor || '#a8a5a3');
    root.setProperty('--gift-marker-color', config.giftMarkerColor || '#4fa8f5');
    if (settings.theme === 'portrait') {
      const width = Number(config.portraitWidth);
      root.setProperty('--portrait-width', Math.max(30, Math.min(70, Number.isFinite(width) ? width : 48)) + '%');
    } else root.removeProperty('--portrait-width');
    root.setProperty('--welcome-text-color', config.welcomeTextColor);
    root.setProperty('--welcome-name-color', config.welcomeNameColor);
    root.setProperty('--theme-font-family', '"' + config.fontFamily.replace(/["\\]/g, '') + '"');
    const hasTextShadow = settings.theme === 'glass' || settings.theme === 'outline';
    const configuredShadow = Number(config.shadowStrength);
    const shadowStrength = hasTextShadow
      ? Math.max(0, Math.min(100, Number.isFinite(configuredShadow) ? configuredShadow : (settings.theme === 'outline' ? 70 : 60))) / 100
      : 0;
    const shadowAlpha = shadowStrength.toFixed(3);
    root.setProperty('--message-text-shadow', shadowStrength > 0
      ? '0 0 ' + scale.toFixed(2) + 'px rgba(0, 0, 0, ' + shadowAlpha + '), ' +
        '0 ' + scale.toFixed(2) + 'px ' + (1.8 * scale).toFixed(2) + 'px rgba(0, 0, 0, ' + shadowAlpha + '), ' +
        '0 ' + (1.5 * scale).toFixed(2) + 'px ' + (3 * scale).toFixed(2) + 'px rgba(0, 0, 0, ' + (shadowStrength * 0.78).toFixed(3) + ')'
      : 'none');
    root.setProperty('--outline-frame-shadow', settings.theme === 'outline' && shadowStrength > 0
      ? '0 ' + scale.toFixed(2) + 'px ' + (2.5 * scale).toFixed(2) + 'px rgba(0, 0, 0, ' + (shadowStrength * 0.7).toFixed(3) + '), ' +
        'inset 0 0 ' + (1.5 * scale).toFixed(2) + 'px rgba(0, 0, 0, ' + (shadowStrength * 0.22).toFixed(3) + ')'
      : 'none');
    document.body.style.setProperty('--viewer', config.viewerColor);
    document.body.style.setProperty('--host', config.hostColor);
    document.body.style.setProperty('--manager', config.managerColor);
    document.body.style.setProperty('--governor', config.governorColor);
    document.body.style.setProperty('--admiral', config.admiralColor);
    document.body.style.setProperty('--captain', config.captainColor);
    document.body.classList.toggle('show-avatars', config.showAvatar !== false);
    document.body.classList.toggle('show-welcome', config.showWelcome !== false);
    document.body.classList.toggle('welcome-single', config.welcomeMode === 'single');
    syncFixedWelcome();
    updateEmptyState();
    if (config.showAvatar !== false) {
      els.messageStack.querySelectorAll('.message-avatar').forEach(loadAvatar);
    } else stopAvatars();
    const surfaceOpacity = config.surfaceOpacity / 100;
    root.setProperty('--glass-surface-color', settings.theme === 'glass' ? config.surfaceColor : '#000000');
    root.setProperty('--surface-opacity', surfaceOpacity.toFixed(2));
    root.setProperty('--surface-blur', (20 * surfaceOpacity).toFixed(1) + 'px');
    root.setProperty('--surface-saturation', (100 + 8 * surfaceOpacity).toFixed(1) + '%');
    syncMessageFit();
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

  function leaf(className, text) {
    const element = document.createElement('span');
    element.className = className;
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
    image.addEventListener('load', () => {
      if (image.parentElement === avatar && avatar.isConnected && !pageHidden) avatar.classList.add('has-image');
    }, { once: true });
    image.addEventListener('error', () => image.remove(), { once: true });
    image.src = '/api/emote_image?url=' + encodeURIComponent(url);
    avatar.appendChild(image);
  }

  function cachedAvatarUrl(key) {
    const cached = avatarUrlCache.get(key);
    if (!cached) return undefined;
    if (cached.expiresAt <= Date.now()) {
      avatarUrlCache.delete(key);
      return undefined;
    }
    return cached.url;
  }

  function lookupAvatar(uid) {
    const key = String(Number(uid) || 0);
    if (key === '0') return Promise.resolve('');
    const cached = cachedAvatarUrl(key);
    if (cached !== undefined) return Promise.resolve(cached);
    if (avatarLookupPending.has(key)) return avatarLookupPending.get(key);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort('timeout'), 8000);
    const pending = fetch('/api/user_avatar?uid=' + encodeURIComponent(key), { signal: controller.signal })
      .then((response) => response.json())
      .then((result) => {
        const url = result && result.ok ? String(result.avatarUrl || '') : '';
        if (!controller.signal.aborted) cacheAvatarUrl(key, url);
        return url;
      })
      .catch(() => {
        if (!controller.signal.aborted || controller.signal.reason === 'timeout') cacheAvatarUrl(key, '');
        return '';
      })
      .finally(() => {
        clearTimeout(timeout);
        if (avatarLookupPending.get(key) === pending) avatarLookupPending.delete(key);
        if (avatarLookupControllers.get(key) === controller) avatarLookupControllers.delete(key);
      });
    avatarLookupControllers.set(key, controller);
    avatarLookupPending.set(key, pending);
    return pending;
  }

  function cacheAvatarUrl(key, url) {
    avatarUrlCache.delete(key);
    avatarUrlCache.set(key, { url, expiresAt: Date.now() + (url ? AVATAR_SUCCESS_TTL : AVATAR_FAILURE_TTL) });
    while (avatarUrlCache.size > MAX_AVATAR_URLS) {
      avatarUrlCache.delete(avatarUrlCache.keys().next().value);
    }
  }

  function releaseAvatar(avatar) {
    const source = avatarSources.get(avatar);
    if (source) { source.started = false; source.generation++; }
    avatar.classList.remove('has-image');
    avatar.querySelectorAll('img').forEach(image => { image.removeAttribute('src'); image.remove(); });
  }

  function stopAvatars() {
    avatarLookupControllers.forEach(controller => controller.abort());
    avatarLookupControllers.clear();
    avatarLookupPending.clear();
    els.messageStack.querySelectorAll('.message-avatar').forEach(releaseAvatar);
  }

  function loadAvatar(avatar) {
    const source = avatarSources.get(avatar);
    if (!source || source.started || pageHidden || !avatar.isConnected || currentThemeConfig().showAvatar === false ||
        avatar.closest('.is-clipped')) return;
    source.started = true;
    const generation = ++source.generation;
    const pending = source.url ? Promise.resolve(source.url) : lookupAvatar(source.uid);
    pending.then((url) => {
      if (source.generation !== generation) return;
      if (!pageHidden && avatar.isConnected && currentThemeConfig().showAvatar !== false && !avatar.closest('.is-clipped')) {
        applyAvatarImage(avatar, url);
      } else {
        // A later toggle can load it from the bounded URL cache.
        source.started = false;
      }
    });
  }

  function makeAvatar(message) {
    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    const fallback = document.createElement('span');
    fallback.className = 'message-avatar-fallback';
    fallback.textContent = avatarInitial(message.uname);
    avatar.appendChild(fallback);
    if (message.avatarUrl || Number(message.uid) > 0) {
      avatarSources.set(avatar, { uid: message.uid, url: message.avatarUrl, started: false, generation: 0 });
      // Wait until the card is attached; discarded or hidden avatars need no request.
      queueMicrotask(() => loadAvatar(avatar));
    }
    return avatar;
  }

  function artEnabled() {
    return !pageHidden && settings.theme === 'portrait' && currentThemeConfig().surfaceOpacity > 0;
  }

  function safeArtUrl(value) {
    const normalized = window.DanmuAvatars && window.DanmuAvatars.normalizeUrl(value);
    if (!normalized) return '';
    try {
      const url = new URL(normalized);
      return url.protocol === 'https:' && !url.username && !url.password &&
        (url.hostname.endsWith('.hdslb.com') || url.hostname.endsWith('.bilibili.com')) ? url.href : '';
    } catch (_) { return ''; }
  }

  function releaseMessageArt(state) {
    artQueue.delete(state);
    state.visible = false;
    state.attempted = false;
    if (state.controller) state.controller.abort();
    state.controller = null;
    if (state.element) {
      state.element.querySelectorAll('img').forEach(img => img.removeAttribute('src'));
      state.element.remove();
      state.element = null;
    }
  }

  function stopMessageArt() {
    if (artObserver) artObserver.disconnect();
    artObserver = null;
    artRows.forEach(releaseMessageArt);
    artRows.clear();
    artQueue.clear();
  }

  async function artAvatarUrl(message, signal) {
    const explicit = safeArtUrl(message.avatarUrl);
    if (explicit) return explicit;
    const key = String(Number(message.uid) || 0);
    if (key === '0') return '';
    const cached = cachedAvatarUrl(key);
    if (cached !== undefined) return safeArtUrl(cached);
    try {
      const result = await (await fetch('/api/user_avatar?uid=' + encodeURIComponent(key), { signal })).json();
      const url = safeArtUrl(result && result.avatarUrl);
      if (!signal.aborted) cacheAvatarUrl(key, url);
      return url;
    } catch (_) { return ''; }
  }

  async function artGiftUrl(message, signal) {
    const explicit = safeArtUrl(message.giftImageUrl);
    if (explicit) return explicit;
    if (!Number.isSafeInteger(Number(message.giftId)) || Number(message.giftId) <= 0) return '';
    const key = String(settings.roomId || '0') + ':' + message.giftId;
    const cached = giftImageUrlCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.url;
    try {
      const endpoint = '/api/gift_image?giftId=' + encodeURIComponent(message.giftId) + '&roomId=' + encodeURIComponent(settings.roomId || '0');
      const result = await (await fetch(endpoint, { signal })).json();
      const url = safeArtUrl(result && result.giftImageUrl);
      if (!signal.aborted) {
        giftImageUrlCache.delete(key);
        giftImageUrlCache.set(key, { url, expiresAt: Date.now() + (url ? 600000 : 60000) });
        while (giftImageUrlCache.size > 512) giftImageUrlCache.delete(giftImageUrlCache.keys().next().value);
      }
      return url;
    } catch (_) { return ''; }
  }

  function loadArtImage(state, rawUrl, signal) {
    const url = safeArtUrl(rawUrl);
    const surface = state.element;
    if (!url || signal.aborted || !surface || !surface.isConnected) return Promise.resolve(false);
    return new Promise(resolve => {
      const focus = document.createElement('img');
      focus.className = 'message-art-focus';
      focus.alt = '';
      focus.decoding = 'async';
      focus.referrerPolicy = 'no-referrer';
      let finished = false;
      const aborted = () => finish(false);
      const loaded = () => finish(true);
      const failed = () => finish(false);
      const timeout = setTimeout(failed, 5000);
      function finish(ok) {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        focus.removeEventListener('load', loaded);
        focus.removeEventListener('error', failed);
        signal.removeEventListener('abort', aborted);
        if (ok && !signal.aborted && state.element === surface && state.visible && artEnabled()) {
          const wash = document.createElement('img');
          wash.className = 'message-art-wash';
          wash.alt = '';
          wash.decoding = 'async';
          wash.referrerPolicy = 'no-referrer';
          wash.src = focus.src;
          surface.prepend(wash);
          surface.classList.add('has-image');
          resolve(true);
        } else {
          focus.removeAttribute('src');
          focus.remove();
          resolve(false);
        }
      }
      focus.addEventListener('load', loaded);
      focus.addEventListener('error', failed);
      signal.addEventListener('abort', aborted, { once: true });
      surface.appendChild(focus);
      focus.src = '/api/emote_image?url=' + encodeURIComponent(url);
    });
  }

  function pumpMessageArt() {
    while (artEnabled() && activeArtLoads < 4 && artQueue.size) {
      const state = artQueue.values().next().value;
      artQueue.delete(state);
      if (!state.visible || state.attempted || !state.row.isConnected) continue;
      state.attempted = true;
      const controller = new AbortController();
      state.controller = controller;
      activeArtLoads++;
      const deadline = setTimeout(() => controller.abort(), 15000);
      (async () => {
        const signal = controller.signal;
        // SC and room arrivals use the sender; paid gifts use their own art.
        const gift = state.message.type === 'gift' ? await artGiftUrl(state.message, signal) : '';
        if (gift && await loadArtImage(state, gift, signal)) return;
        if (!signal.aborted) {
          const avatar = await artAvatarUrl(state.message, signal);
          if (avatar && avatar !== gift) await loadArtImage(state, avatar, signal);
        }
      })().catch(() => {}).finally(() => {
        clearTimeout(deadline);
        if (state.controller === controller) state.controller = null;
        activeArtLoads--;
        pumpMessageArt();
      });
    }
  }

  function syncMessageArt() {
    if (!artEnabled()) {
      stopMessageArt();
      return;
    }
    if (!artObserver) {
      const observer = new IntersectionObserver(entries => {
        if (artObserver !== observer || !artEnabled()) return;
        entries.forEach(entry => {
          const state = artRows.get(entry.target);
          if (!state) return;
          const visible = !state.row.classList.contains('is-clipped') && entry.isIntersecting &&
            entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0;
          if (!visible) { releaseMessageArt(state); return; }
          state.visible = true;
          if (!state.element) {
            state.element = document.createElement('div');
            state.element.className = 'message-art';
            state.element.setAttribute('aria-hidden', 'true');
            state.row.prepend(state.element);
          }
          if (!state.attempted) artQueue.add(state);
        });
        pumpMessageArt();
      }, { root: els.messageStack, threshold: 0 });
      artObserver = observer;
    }
    artRows.forEach((state, row) => {
      if (!row.isConnected || row.classList.contains('is-clipped')) {
        artObserver.unobserve(row);
        releaseMessageArt(state);
        artRows.delete(row);
      }
    });
    els.messageStack.querySelectorAll('.message-row').forEach(row => {
      if (artRows.has(row) || row.classList.contains('is-clipped')) return;
      const message = artMessages.get(row);
      if (!message) return;
      artRows.set(row, { row, message, element: null, controller: null, visible: false, attempted: false });
      artObserver.observe(row);
    });
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
      image.addEventListener('load', () => {
        const ratio = image.naturalWidth / image.naturalHeight;
        if (Number.isFinite(ratio) && ratio > 0) visual.style.setProperty('--emote-aspect', String(ratio));
      }, { once: true });
      image.addEventListener('error', () => {
        visual.replaceWith(document.createTextNode(nextKey));
      }, { once: true });
      image.src = '/api/emote_image?url=' + encodeURIComponent(emotes[nextKey].url);
      visual.appendChild(image);
      element.appendChild(visual);
      cursor = nextIndex + nextKey.length;
    }
  }

  function isPinnedSc(message) {
    return message.type === 'sc' && message.scPinned !== false;
  }

  function makeMessageRow(message) {
    const row = document.createElement('article');
    artMessages.set(row, message);
    row.className = 'message-row role-' + (message.role || 'viewer') + ' is-' + message.type;
    // Keep new regular rows unpainted until the first visibility fit pass.
    if (isPinnedSc(message)) row.classList.add('is-pinned-sc');
    else row.classList.add('is-clipped');
    if (message.type === 'welcome') {
      const body = document.createElement('div');
      body.className = 'welcome-body';
      body.append(leaf('welcome-prefix', '欢迎 '), leaf('welcome-name', message.uname || '观众'),
        leaf('welcome-suffix', ' 进入直播间'));
      row.appendChild(body);
      return row;
    }
    row.appendChild(makeAvatar(message));

    const gapText = formatGap(message.gapMs);
    if (gapText) {
      const gap = document.createElement('div');
      gap.className = 'message-gap';
      gap.textContent = '+ Thought: ' + gapText;
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
      identity.appendChild(role);
    }
    if (message.medal) identity.appendChild(leaf('medal-label', message.medal));
    meta.appendChild(identity);

    if (Number.isFinite(message.valueYuan)) {
      const kind = message.type === 'sc' ? 'SC' : (message.kind === 'guard' ? 'Guard' : 'Gift');
      meta.appendChild(leaf('gift-value', '▣ ' + kind + ' · ￥ ' + message.valueYuan.toFixed(2)));
    }

    const body = document.createElement('div');
    body.className = 'message-body';
    appendRichBody(body, message.text, message.emotes);

    const time = document.createElement('time');
    time.className = 'message-time';
    time.textContent = message.time || timeNow();

    row.append(meta, body, time);
    return row;
  }

  function pruneMessages() {
    const stack = els.messageList;
    const rows = stack.querySelectorAll(':scope > .message-row');
    for (let index = 0; index < rows.length - MAX_MESSAGES; index += 1) {
      rows[index].remove();
    }
  }

  function cancelMessageMotion() {
    if (messageMotionFrame !== null) cancelAnimationFrame(messageMotionFrame);
    messageMotionFrame = null;
    messageMotions.forEach(animation => {
      animation.onfinish = null;
      animation.cancel();
    });
    messageMotions.clear();
    messageMotionGeometry = null;
  }

  function captureMessagePositions() {
    return new Map(Array.from(els.messageList.children, row => [row, row.getBoundingClientRect()]));
  }

  function motionVisibilityFrames(delta, top, height, viewport, fullCardsOnly) {
    // Full-card mode uses the inner pair of edges; partial-card mode uses the
    // outer pair so native overflow can crop the card until it leaves entirely.
    // Discrete offsets follow compositor timing even if JS misses a frame.
    const enterEdge = fullCardsOnly ? top + height : top;
    const leaveEdge = fullCardsOnly ? top : top + height;
    const enter = Math.max(0, Math.min(1, (enterEdge - viewport.bottom) / delta));
    const leave = Math.max(0, Math.min(1, (leaveEdge - viewport.top) / delta));
    const frame = (offset, visibility) => ({ offset, transform: 'translateY(' + (delta * (1 - offset)) + 'px)', visibility });
    const frames = [frame(0, enter > 0 ? 'hidden' : 'visible')];
    if (enter > 0) frames.push(frame(enter, 'hidden'), frame(enter, 'visible'));
    if (leave < 1) frames.push(frame(leave, 'visible'), frame(leave, 'hidden'));
    frames.push(frame(1, leave < 1 ? 'hidden' : 'visible'));
    return frames;
  }

  function tickMessageMotion() {
    messageMotionFrame = null;
    if (pageHidden || !messageMotions.size) return;
    updateMessageVisibility();
    if (messageMotions.size) messageMotionFrame = requestAnimationFrame(tickMessageMotion);
  }

  function startMessageMotion(previous) {
    if (!previous || !previous.size || motionPreference.matches || pageHidden) return;
    const viewport = els.messageList.getBoundingClientRect();
    const scale = els.overlayStage.getBoundingClientRect().width / canvasWidth;
    if (viewport.height <= 0 || scale <= 0) return;
    const fullCardsOnly = currentThemeConfig().fullCardsOnly !== false;
    const rows = Array.from(els.messageList.children, row => ({ row, rect: row.getBoundingClientRect() }));
    const anchor = rows.findLast(({ row, rect }) => rect.height > 0 && previous.has(row));
    if (!anchor) return;
    const commonDelta = previous.get(anchor.row).top - anchor.rect.top;
    if (commonDelta <= 0.5) return;
    const now = performance.now();
    const interval = lastMessageMotionAt ? now - lastMessageMotionAt : 180;
    const duration = Math.max(80, Math.min(180, interval * 2.2));
    lastMessageMotionAt = now;
    messageMotionGeometry = { viewport, rows: new Map(rows.map(({ row, rect }) => [row, rect])) };
    rows.forEach(({ row, rect }) => {
      const top = previous.has(row) ? previous.get(row).top : rect.top + commonDelta;
      const delta = top - rect.top;
      // Deep history never receives an animation. Include the next incoming
      // card so rapid arrivals can continue from its still-hidden position.
      if (delta <= 0.5 || rect.height <= 0) return;
      if (fullCardsOnly
        ? rect.height > viewport.height + 0.01 || top < viewport.top - 0.01 || rect.bottom > viewport.bottom + 0.01
        : top + rect.height <= viewport.top + 0.01 || rect.top >= viewport.bottom - 0.01) return;
      const frames = motionVisibilityFrames(delta / scale, top / scale, rect.height / scale,
        { top: viewport.top / scale, bottom: viewport.bottom / scale }, fullCardsOnly);
      const animation = row.animate(frames, { duration, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', fill: 'both' });
      // An immediate next snapshot can otherwise cancel a still-pending WAAPI
      // animation before its first presentation frame, freezing the old Y and
      // pushing every subsequent incoming card farther below the viewport.
      animation.startTime = document.timeline.currentTime;
      messageMotions.set(row, animation);
      animation.onfinish = () => {
        if (messageMotions.get(row) !== animation) return;
        messageMotions.delete(row);
        animation.onfinish = null;
        animation.cancel();
        if (!messageMotions.size) {
          if (messageMotionFrame !== null) cancelAnimationFrame(messageMotionFrame);
          messageMotionFrame = null;
          messageMotionGeometry = null;
        }
        updateMessageVisibility();
      };
    });
    if (!messageMotions.size) messageMotionGeometry = null;
    if (messageMotions.size && messageMotionFrame === null) messageMotionFrame = requestAnimationFrame(tickMessageMotion);
  }

  function handleMessageResize(entries) {
    if (messageMotions.size && messageMotionGeometry) {
      const previous = messageMotionGeometry;
      const viewport = els.messageList.getBoundingClientRect();
      const changed = Math.abs(viewport.width - previous.viewport.width) > 0.1 ||
        Math.abs(viewport.height - previous.viewport.height) > 0.1 ||
        Math.abs(viewport.top - previous.viewport.top) > 0.1 || entries.some(({ target }) => {
          const before = previous.rows.get(target);
          if (!before) return false;
          const rect = target.getBoundingClientRect();
          return Math.abs(rect.width - before.width) > 0.1 || Math.abs(rect.height - before.height) > 0.1;
        });
      if (changed) cancelMessageMotion();
    }
    updateMessageVisibility();
  }

  function updateMessageVisibility() {
    if (messageFitFrame !== null) cancelAnimationFrame(messageFitFrame);
    messageFitFrame = null;
    if (pageHidden) return;
    const list = els.messageList;
    const fullCardsOnly = currentThemeConfig().fullCardsOnly !== false;
    // At rest use the canonical bottom-up layout. During FLIP, old cards stay
    // visible until their actual visual edge reaches the top, rather than
    // disappearing early merely because their final layout is outside it.
    const viewport = list.getBoundingClientRect();
    const scale = els.overlayStage.getBoundingClientRect().width / canvasWidth;
    const gap = (parseFloat(getComputedStyle(list).rowGap) || 0) * scale;
    let remaining = viewport.height;
    const rows = Array.from(list.children, row => {
      const rect = row.getBoundingClientRect();
      return { row, rect, height: rect.height };
    });
    // Keep the same newest contiguous cards in either alignment. Merely using
    // flex-start would expose the oldest retained history and hide new arrivals.
    // Move only the spare space left by whole-card fitting to the bottom.
    if (!messageMotions.size) {
      let available = viewport.height;
      let fittedHeight = 0;
      for (let index = rows.length - 1; index >= 0; index--) {
        const height = rows[index].height;
        if (height <= 0) continue;
        if (!fullCardsOnly || height <= available + 0.01) {
          fittedHeight += height + (fittedHeight > 0 ? gap : 0);
        }
        available -= height + gap;
      }
      const offset = currentThemeConfig().messageAlign === 'top' && fittedHeight > 0 && scale > 0
        ? -Math.max(0, viewport.height - fittedHeight) / scale : 0;
      const previousOffset = parseFloat(list.style.getPropertyValue('--message-alignment-offset')) || 0;
      if (Math.abs(offset - previousOffset) > 0.001) {
        list.style.setProperty('--message-alignment-offset', offset + 'px');
        const shift = (offset - previousOffset) * scale;
        rows.forEach(item => { item.rect = { top: item.rect.top + shift, bottom: item.rect.bottom + shift }; });
      }
    }
    const changes = [];
    for (let index = rows.length - 1; index >= 0; index--) {
      const { row, rect, height } = rows[index];
      const clipped = fullCardsOnly
        ? messageMotions.size
          ? height <= 0 || rect.top < viewport.top - 0.01 || rect.bottom > viewport.bottom + 0.01
          : height <= 0 || height > remaining + 0.01
        : height <= 0 || viewport.height <= 0 || rect.bottom <= viewport.top + 0.01 || rect.top >= viewport.bottom - 0.01;
      if (row.classList.contains('is-clipped') !== clipped) changes.push({ row, clipped });
      if (height > 0) remaining -= height + gap;
    }
    // Visibility preserves layout and bounded history; display:none would
    // collapse rows and repeatedly pull older messages back into the viewport.
    changes.forEach(({ row, clipped }) => {
      row.classList.toggle('is-clipped', clipped);
      row.querySelectorAll('.message-avatar').forEach(clipped ? releaseAvatar : loadAvatar);
    });
    // IntersectionObserver ignores visibility:hidden. Explicitly release and
    // unobserve clipped artwork, then observe it again if more space opens up.
    if (changes.length || !messageMotions.size) syncMessageArt();
  }

  function syncMessageFit() {
    if (pageHidden) return;
    if (!messageFitObserver) {
      messageFitObserver = new ResizeObserver(handleMessageResize);
      messageFitObserver.observe(els.messageList);
    }
    measuredMessageRows.forEach(row => {
      if (row.parentElement !== els.messageList) {
        messageFitObserver.unobserve(row);
        measuredMessageRows.delete(row);
      }
    });
    Array.from(els.messageList.children).forEach(row => {
      if (measuredMessageRows.has(row)) return;
      measuredMessageRows.add(row);
      messageFitObserver.observe(row, { box: 'border-box' });
    });
    // Reordering and changing gaps can move rows without resizing any of them.
    if (messageFitFrame === null) messageFitFrame = requestAnimationFrame(updateMessageVisibility);
  }

  function stopMessageFit() {
    cancelMessageMotion();
    if (messageFitFrame !== null) cancelAnimationFrame(messageFitFrame);
    messageFitFrame = null;
    if (messageFitObserver) messageFitObserver.disconnect();
    messageFitObserver = null;
    measuredMessageRows.clear();
  }

  function updateEmptyState() {
    const hasMessages = !!(
      els.pinnedScStack.querySelector('.message-row') ||
      els.fixedWelcome?.firstElementChild ||
      els.messageList.querySelector(currentThemeConfig().showWelcome === false || currentThemeConfig().welcomeMode === 'single'
        ? '.message-row:not(.is-welcome)' : '.message-row')
    );
    els.emptyState.hidden = hasMessages;
  }

  function stopWelcomeTimer() {
    if (welcomeTimer !== null) clearTimeout(welcomeTimer);
    welcomeTimer = null;
    welcomeDeadline = 0;
  }

  function syncFixedWelcome() {
    const host = els.fixedWelcome;
    if (!host) return;
    const config = currentThemeConfig();
    const deadline = latestWelcome && Number(latestWelcome.receivedAt) + config.welcomeDuration * 1000;
    const remaining = deadline - Date.now();
    const visible = !pageHidden && config.showWelcome !== false && config.welcomeMode === 'single' &&
      latestWelcome?.type === 'welcome' && Number.isFinite(deadline) && remaining > 0;
    document.body.classList.toggle('has-fixed-welcome', !!visible);
    let changed = false;
    if (!visible) {
      stopWelcomeTimer();
      if (host.firstElementChild) { host.replaceChildren(); changed = true; }
    }
    else {
      const signature = JSON.stringify(latestWelcome);
      if (host.firstElementChild?.dataset.welcomeSignature !== signature) {
        const row = makeMessageRow(latestWelcome);
        row.classList.remove('is-clipped');
        row.dataset.welcomeSignature = signature;
        host.replaceChildren(row);
        changed = true;
      }
      // Ordinary chat snapshots must not recreate an unchanged welcome timer.
      if (welcomeTimer === null || welcomeDeadline !== deadline) {
        stopWelcomeTimer();
        welcomeDeadline = deadline;
        welcomeTimer = setTimeout(() => {
          welcomeTimer = null;
          welcomeDeadline = 0;
          syncFixedWelcome();
          updateEmptyState();
          syncMessageFit();
        }, remaining);
      }
    }
    if (changed) syncMessageArt();
  }

  function resetSwipeRow(row) {
    if (!row.isConnected || !row.classList.contains('is-pinned-sc')) return;
    row.classList.remove('is-swiping', 'is-swipe-dismissed');
    row.classList.add('is-swipe-resetting');
    row.style.transform = '';
    row.style.opacity = '';
    setTimeout(() => row.classList.remove('is-swipe-resetting'), 180);
  }

  function dismissScRow(row, direction) {
    if (!row.isConnected || !row.classList.contains('is-pinned-sc')) return;
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
        resumeOutput();
        return;
      }
      // The shared scene replaces this pinned view with its history card.
      // A local removal timer could race that update; recover missed SSE via
      // the normal state refresh without briefly showing the old pin again.
      if (row.isConnected) resumeOutput();
    }).catch(() => {
      resetSwipeRow(row);
      resumeOutput();
    });
  }

  function bindScSwipe(row) {
    if (isObsMode || !desktopApi || !row.classList.contains('is-pinned-sc') || row.dataset.swipeBound === 'true') return;
    row.dataset.swipeBound = 'true';
    // A fully transparent pixel in a Windows layered window can pass mouse
    // input through. Cover the complete card with a virtually invisible hit
    // surface; it is desktop-only and bubbles every gesture to this row.
    const hitArea = document.createElement('div');
    hitArea.className = 'sc-hit-area';
    hitArea.setAttribute('aria-hidden', 'true');
    row.appendChild(hitArea);
    let gesture = null;

    row.addEventListener('pointerdown', (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      if (row.classList.contains('is-swipe-dismissed')) return;
      event.preventDefault();
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
      const completed = event.type === 'pointerup' && gesture.horizontal &&
        Math.abs(gesture.dx) >= Math.max(72, row.getBoundingClientRect().width * 0.22);
      const direction = gesture.dx < 0 ? -1 : 1;
      gesture = null;
      if (row.hasPointerCapture(event.pointerId)) row.releasePointerCapture(event.pointerId);
      if (completed) dismissScRow(row, direction);
      else resetSwipeRow(row);
    }

    row.addEventListener('pointerup', finishSwipe);
    row.addEventListener('pointercancel', finishSwipe);
    row.addEventListener('lostpointercapture', (event) => {
      if (gesture && event.pointerId === gesture.pointerId) {
        gesture = null;
        resetSwipeRow(row);
      }
    });
    row.addEventListener('dragstart', event => event.preventDefault());
  }

  function renderSceneSnapshot(scene) {
    if (pageHidden || !scene || !Array.isArray(scene.messages)) return;
    if (!acceptOutputSession(scene.sessionId)) return;
    if (reloadForAppVersion(scene.appVersion)) return;
    const revision = Number(scene.revision);
    if (Number.isFinite(revision) && revision <= renderedSceneRevision) return;
    latestWelcome = scene.latestWelcome || null;
    syncFixedWelcome();
    updateEmptyState();
    const existing = new Map();
    els.messageStack.querySelectorAll('.message-row[data-scene-id]').forEach((row) => {
      existing.set(row.dataset.sceneId, row);
    });
    const incoming = scene.messages.flatMap(message => {
      const id = String(message && message.id || '');
      return id ? [{ id, message, signature: JSON.stringify(message) }] : [];
    });
    const firstScene = renderedSceneRevision < 0 || !existing.size;
    const changed = incoming.length !== existing.size || incoming.some(({ id, signature }) => existing.get(id)?.dataset.sceneMessage !== signature);
    if (!changed) {
      if (Number.isFinite(revision)) renderedSceneRevision = revision;
      syncMessageFit();
      return;
    }
    const keep = new Set(incoming.map(({ id }) => id));
    const regular = incoming.filter(({ message }) => !isPinnedSc(message));
    const oldRegularOrder = Array.from(els.messageList.children, row => row.dataset.sceneId).filter(id => keep.has(id));
    const retainedOrder = regular.filter(({ id }) => existing.has(id)).map(({ id }) => id);
    const firstNew = regular.findIndex(({ id }) => !existing.has(id));
    const scChanged = JSON.stringify(Array.from(els.pinnedScStack.children, row => row.dataset.sceneMessage)) !==
      JSON.stringify(incoming.filter(({ message }) => isPinnedSc(message)).reverse().map(({ signature }) => signature));
    const corrected = regular.some(({ id, signature }) => existing.has(id) && existing.get(id).dataset.sceneMessage !== signature);
    const appending = firstNew >= 0 && regular.slice(firstNew).every(({ id }) => !existing.has(id)) &&
      JSON.stringify(oldRegularOrder) === JSON.stringify(retainedOrder);
    const previous = !firstScene && appending && !scChanged && !corrected && !motionPreference.matches
      ? captureMessagePositions() : null;
    // Sample before cancelling: an arrival halfway through the previous move
    // starts at that exact painted position, never at the old keyframe origin.
    cancelMessageMotion();
    const orderedRows = new Map([[els.pinnedScStack, []], [els.messageList, []]]);
    incoming.forEach(({ message, id, signature }) => {
      let row = existing.get(id);
      if (!row || row.dataset.sceneMessage !== signature) {
        const replacement = makeMessageRow(message);
        replacement.dataset.sceneId = id;
        replacement.dataset.sceneMessage = signature;
        if (firstScene) replacement.style.animation = 'none';
        if (isPinnedSc(message)) bindScSwipe(replacement);
        if (row) {
          // A corrected purchase stays in place without a second entrance.
          replacement.style.animation = 'none';
          row.replaceWith(replacement);
        }
        row = replacement;
      }
      const target = isPinnedSc(message) ? els.pinnedScStack : els.messageList;
      orderedRows.get(target).push(row);
    });
    existing.forEach((row, id) => {
      if (!keep.has(id)) {
        row.remove();
      }
    });
    // Put the latest paid message in view even when older pinned SC fills the
    // available height. Ordinary playback retains its existing oldest-first order.
    orderedRows.get(els.pinnedScStack).reverse();
    // Keep unchanged cards and their swipe state in place.
    orderedRows.forEach((rows, target) => {
      let next = target.firstElementChild;
      rows.forEach((row) => {
        if (row === next) next = next.nextElementSibling;
        else target.insertBefore(row, next);
      });
    });
    updateEmptyState();
    pruneMessages();
    if (Number.isFinite(revision)) renderedSceneRevision = revision;
    // Resolve alignment before sampling animation targets, including when the
    // newest card pushes a differently-sized old card out of the visible set.
    updateMessageVisibility();
    startMessageMotion(previous);
    updateMessageVisibility();
    syncMessageFit();
  }

  function clearDisplayedScene(revision) {
    // IPC and SSE can arrive in either order. A clear from an older scene
    // must not erase messages that were already rendered from a newer one.
    if (Number.isFinite(Number(revision)) && Number(revision) < renderedSceneRevision) return;
    cancelMessageMotion();
    lastMessageMotionAt = 0;
    latestWelcome = null;
    stopWelcomeTimer();
    stopMessageArt();
    els.messageStack.querySelectorAll('.message-row').forEach((row) => {
      row.remove();
    });
    syncFixedWelcome();
    syncMessageFit();
    updateEmptyState();
    // IPC clear can beat an older SSE event already on its way to the preview.
    // Keep the main process's revision so that old scene cannot flash back.
    renderedSceneRevision = Number.isFinite(Number(revision))
      ? Math.max(renderedSceneRevision, Number(revision))
      : -1;
  }

  function acceptOutputSession(value) {
    const sessionId = typeof value === 'string' ? value : '';
    // Legacy snapshots are usable only until this page has seen a session ID.
    if (!sessionId) return !renderedSessionId;
    if (sessionId === renderedSessionId) return true;
    if (retiredSessionIds.has(sessionId)) return false;
    if (renderedSessionId) {
      retiredSessionIds.add(renderedSessionId);
      if (retiredSessionIds.size > 16) retiredSessionIds.delete(retiredSessionIds.values().next().value);
    }
    renderedSessionId = sessionId;
    clearDisplayedScene();
    return true;
  }

  function reloadForAppVersion(value) {
    const appVersion = typeof value === 'string' ? value : '';
    if (!isObsMode || !loadedAppVersion || !appVersion || appVersion === loadedAppVersion) return false;
    if (versionReloadRequested) return true;
    const target = new URL(window.location.href);
    // A cached or misconfigured response must not trigger a reload loop.
    if (target.searchParams.get('_appVersion') === appVersion) return false;
    target.searchParams.set('_appVersion', appVersion);
    versionReloadRequested = true;
    window.location.replace(target.href);
    return true;
  }

  function applySettings(next) {
    settings = themeRegistry.migrateSettings(Object.assign(settings, next || {}));
    if (!isObsMode) {
      // The desktop viewport is the canonical live canvas. Saved dimensions
      // can lag behind while the user is dragging a resize handle, so using
      // them here leaves the themed surface at its previous size until a later
      // settings round-trip completes.
      setCanvasSize(window.innerWidth, window.innerHeight);
    }
    document.body.dataset.theme = settings.theme;
    document.body.classList.toggle('size-locked', settings.overlaySizeLocked === true);
    applyResponsiveTheme();
  }

  function applyOutputState(state) {
    if (pageHidden) return;
    const sessionId = state && (state.sessionId || (state.scene && state.scene.sessionId));
    if (!acceptOutputSession(sessionId)) return;
    if (state && reloadForAppVersion(state.appVersion)) return;
    if (isObsMode && state && state.canvas) {
      const width = Math.max(MIN_CANVAS_WIDTH, Math.min(3840, Math.round(Number(state.canvas.width) || 515)));
      const height = Math.max(MIN_CANVAS_HEIGHT, Math.min(2160, Math.round(Number(state.canvas.height) || 650)));
      setCanvasSize(width, height);
    }
    applySettings(state && state.settings ? state.settings : {});
    if (state && state.scene) renderSceneSnapshot(state.scene);
  }

  function stopOutputEvents() {
    streamGeneration++;
    if (outputEvents) outputEvents.close();
    outputEvents = null;
    if (stateRefreshController) stateRefreshController.abort();
    if (stateRefreshTimeout !== null) clearTimeout(stateRefreshTimeout);
    stateRefreshController = null;
    stateRefreshTimeout = null;
    stateRefreshTask = null;
  }

  function startOutputEvents() {
    if (pageHidden || !outputInitialized) return;
    if (outputEvents && outputEvents.readyState !== EventSource.CLOSED) return;
    if (outputEvents) outputEvents.close();
    const events = new EventSource('/api/desktop-output-events');
    outputEvents = events;
    streamGeneration++;
    const current = () => !pageHidden && outputEvents === events;
    events.addEventListener('settings', (event) => {
      if (!current()) return;
      try {
        const state = JSON.parse(event.data);
        streamStateSerial++;
        applyOutputState(state);
      } catch (e) {}
    });
    events.addEventListener('scene', (event) => {
      if (!current()) return;
      try {
        const scene = JSON.parse(event.data);
        streamStateSerial++;
        renderSceneSnapshot(scene);
      } catch (e) {}
    });
    // Temporary server/network failures use EventSource's built-in reconnect.
    // Every new connection starts with a complete settings/scene snapshot.
  }

  function refreshOutputState() {
    if (pageHidden || !outputInitialized) return Promise.resolve(false);
    if (stateRefreshTask) return stateRefreshTask;
    const generation = streamGeneration;
    const serial = streamStateSerial;
    const controller = new AbortController();
    stateRefreshController = controller;
    const timeout = setTimeout(() => controller.abort(), 5000);
    stateRefreshTimeout = timeout;
    stateRefreshTask = fetch('/api/desktop-output-state', { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Output state unavailable');
        const state = await response.json();
        // SSE/IPC can overtake an HTTP response. Keep that newer scene instead.
        if (pageHidden || controller.signal.aborted || stateRefreshController !== controller ||
          generation !== streamGeneration || serial !== streamStateSerial) return false;
        applyOutputState(state);
        return true;
      }).catch(() => false).finally(() => {
        clearTimeout(timeout);
        if (stateRefreshController === controller) {
          stateRefreshController = null;
          stateRefreshTimeout = null;
          stateRefreshTask = null;
        }
      });
    return stateRefreshTask;
  }

  function resumeOutput() {
    if (pageHidden || !outputInitialized) return;
    startOutputEvents();
    refreshOutputState();
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

  function init() {
    els.overlayStage = document.getElementById('overlayStage');
    els.messageStack = document.getElementById('messageStack');
    els.pinnedScStack = document.getElementById('pinnedScStack');
    els.messageList = document.getElementById('messageList');
    els.fixedWelcome = document.getElementById('fixedWelcome');
    els.emptyState = document.getElementById('emptyState');
    els.unlockToast = document.getElementById('unlockToast');
    window.addEventListener('pagehide', () => {
      pageHidden = true;
      stopWelcomeTimer();
      stopAvatars();
      skinFonts.clear();
      stopMessageFit();
      stopMessageArt();
      stopOutputEvents();
    });
    motionPreference.addEventListener('change', () => {
      cancelMessageMotion();
      if (!pageHidden) updateMessageVisibility();
    });
    window.addEventListener('pageshow', () => {
      pageHidden = false;
      applyResponsiveTheme();
      resumeOutput();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') resumeOutput();
    });
    window.addEventListener('online', resumeOutput);
    document.body.classList.toggle('obs-output', isObsMode);
    if (isObsMode && els.emptyState) {
      const hint = els.emptyState.querySelector('.empty-state-hint');
      if (hint) hint.textContent = 'OBS 镜像输出已就绪';
    }
    applySettings({});
    if (desktopApi) {
      desktopApi.onSettingsChanged((next) => {
        if (pageHidden) return;
        streamStateSerial++;
        applySettings(next);
      });
      desktopApi.onSceneCleared((revision) => {
        if (pageHidden) return;
        streamStateSerial++;
        clearDisplayedScene(revision);
      });
      desktopApi.onClickThroughChanged(showUnlockToast);
    }
    // The main process owns room reception and scene history even with no
    // desktop windows. Preview and OBS consume that same revisioned stream.
    outputInitialized = true;
    resumeOutput();
    window.addEventListener('resize', () => {
      if (isObsMode) applyStageFit();
      else {
        setCanvasSize(window.innerWidth, window.innerHeight);
        reportPreviewViewport();
      }
      applyResponsiveTheme();
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
