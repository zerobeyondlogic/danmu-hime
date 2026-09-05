(function () {
  'use strict';

  const STATUS_MAP = {
    disconnected: ['disconnected', '未连接'],
    init: ['connecting', '获取配置'],
    connecting: ['connecting', '连接中'],
    auth: ['connecting', '认证中'],
    open: ['open', '已连接'],
    reconnect: ['connecting', '重连中'],
    'waiting-obs': ['connecting', '启动输出'],
    closed: ['error', '已断开'],
    'auth-fail': ['error', '认证失败'],
    'api-fail': ['error', '初始化失败']
  };
  const THEMES = new Set(['glass', 'pixel', 'tui', 'risograph']);
  const THEME_NAMES = { glass: '轻雾玻璃', pixel: '单色点阵', tui: 'OpenCode TUI', risograph: 'Risograph' };
  const AVATAR_TEXT_WIDTH_COST = { glass: 65, pixel: 74, tui: 64, risograph: 62 };
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
    previewEnabled: true,
    overlaySizeLocked: false,
    themeConfigs: null,
    themeConfigVersion: THEME_CONFIG_VERSION
  };
  let saveTimer = null;
  let previewFrame = null;
  let qrPollTimer = null;
  let loginUid = 0;
  let overlayAvailable = false;
  let currentOverlayStatus = 'disconnected';
  let editingTheme = 'glass';
  let pixelBitmapMigrationPending = false;
  let currentOverlayBounds = { width: 450, height: 650 };
  let avatarResizeQueue = Promise.resolve();
  const els = {};

  function cloneThemeConfig(theme) {
    return Object.assign({}, DEFAULT_THEME_CONFIGS[theme]);
  }

  function normalizeThemeConfigs(source) {
    const result = {};
    THEMES.forEach((theme) => {
      const given = Object.assign({}, source && source[theme] ? source[theme] : {});
      if (theme === 'pixel') {
        given.fontFamily = DEFAULT_THEME_CONFIGS.pixel.fontFamily;
        given.pixelFontVersion = 3;
        if (Number(given.bitmapEngineVersion) !== 3) {
          pixelBitmapMigrationPending = true;
          given.bitmapEngineVersion = 3;
        }
      }
      result[theme] = Object.assign(cloneThemeConfig(theme), given);
      result[theme].showAvatar = typeof given.showAvatar === 'boolean'
        ? given.showAvatar
        : DEFAULT_THEME_CONFIGS[theme].showAvatar;
      const limits = {
        overallScale: [60, 140], messageGap: [0, 20], messageFont: [16, 48],
        nameFont: [10, 30], metaFont: [8, 24], timeFont: [9, 22], surfaceOpacity: [0, 100]
      };
      Object.keys(limits).forEach((property) => {
        const value = Number(result[theme][property]);
        const range = limits[property];
        result[theme][property] = Number.isFinite(value)
          ? Math.max(range[0], Math.min(range[1], value))
          : DEFAULT_THEME_CONFIGS[theme][property];
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

  function byId(id) {
    return document.getElementById(id);
  }

  function updateThemeButtons() {
    document.querySelectorAll('[data-theme-choice]').forEach((button) => {
      button.classList.toggle('active', button.dataset.themeChoice === settings.theme);
    });
    document.querySelectorAll('[data-theme-option]').forEach((option) => {
      option.classList.toggle('active', option.dataset.themeOption === settings.theme);
    });
  }

  function persistNow() {
    return window.DesktopOverlay.saveSettings(settings);
  }

  function previewNow() {
    if (previewFrame !== null) return;
    previewFrame = requestAnimationFrame(() => {
      previewFrame = null;
      window.DesktopOverlay.previewSettings(settings);
    });
  }

  function scheduleSave() {
    previewNow();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      persistNow();
    }, 100);
  }

  function setStatus(status) {
    currentOverlayStatus = String(status || 'disconnected');
    const mapped = STATUS_MAP[status] || ['error', String(status || '错误')];
    els.statusCard.dataset.status = mapped[0];
    els.statusText.textContent = mapped[1];
    if (status === 'open' && settings.previewEnabled !== false) overlayAvailable = true;
    els.showOverlayButton.disabled = !overlayAvailable;
    els.resetOverlayButton.disabled = !overlayAvailable;
    if (status === 'open') {
      els.connectButton.textContent = '已连接';
      els.connectButton.disabled = true;
      if (settings.roomId) els.roomHint.textContent = 'ROOM ' + settings.roomId + ' · 已连接';
    } else if (['init', 'connecting', 'auth', 'reconnect', 'waiting-obs'].includes(status)) {
      els.connectButton.textContent = status === 'reconnect' ? '重连中' : '连接中';
      els.connectButton.disabled = true;
    } else {
      els.connectButton.textContent = settings.roomId ? '重新连接' : '连接';
      els.connectButton.disabled = false;
    }
  }

  async function connectRoom() {
    const roomId = String(els.roomInput.value || '').trim();
    if (!/^\d+$/.test(roomId)) {
      els.roomHint.textContent = '请输入纯数字房间号';
      els.roomInput.focus();
      return;
    }
    settings.roomId = roomId;
    els.connectButton.textContent = '连接中';
    els.connectButton.disabled = true;
    const connected = await window.DesktopOverlay.connectRoom(roomId);
    els.roomHint.textContent = connected ? 'ROOM ' + roomId + ' · 正在连接' : '连接请求失败';
  }

  function setClickThroughState(enabled) {
    els.clickThroughButton.classList.toggle('active', enabled);
    els.clickThroughButton.querySelector('span').textContent = enabled ? '已开启鼠标穿透' : '鼠标穿透';
  }

  function setOverlaySizeFields(bounds) {
    if (!bounds) return;
    currentOverlayBounds = {
      width: Math.round(Number(bounds.width) || 720),
      height: Math.round(Number(bounds.height) || 900)
    };
    els.overlayWidthInput.value = String(currentOverlayBounds.width);
    els.overlayHeightInput.value = String(currentOverlayBounds.height);
    els.obsMirrorSizeText.textContent = '当前镜像 ' + currentOverlayBounds.width + ' × ' + currentOverlayBounds.height;
  }

  async function applyOverlaySize() {
    if (settings.overlaySizeLocked) return;
    const width = Number(els.overlayWidthInput.value);
    const height = Number(els.overlayHeightInput.value);
    const bounds = await window.DesktopOverlay.resizeOverlay(width, height);
    setOverlaySizeFields(bounds);
  }

  function setOverlaySizeLocked(locked) {
    settings.overlaySizeLocked = !!locked;
    els.overlaySizeLockedInput.checked = settings.overlaySizeLocked;
    els.overlayWidthInput.disabled = settings.overlaySizeLocked;
    els.overlayHeightInput.disabled = settings.overlaySizeLocked;
    els.applyOverlaySizeButton.disabled = settings.overlaySizeLocked;
  }

  function setPreviewEnabled(enabled) {
    settings.previewEnabled = !!enabled;
    els.previewEnabledInput.checked = settings.previewEnabled;
    els.alwaysOnTopInput.disabled = !settings.previewEnabled;
    els.clickThroughButton.disabled = !settings.previewEnabled;
    if (!settings.previewEnabled) {
      overlayAvailable = false;
    } else if (currentOverlayStatus === 'open') {
      overlayAvailable = true;
    }
    els.showOverlayButton.disabled = !overlayAvailable;
    els.resetOverlayButton.disabled = !overlayAvailable;
  }

  function updateThemeEditorValues() {
    const config = settings.themeConfigs[editingTheme];
    const isPixel = editingTheme === 'pixel';
    els.messageFontInput.min = isPixel ? '32' : '16';
    els.nameFontInput.min = isPixel ? '22' : '10';
    els.metaFontInput.min = isPixel ? '22' : '8';
    els.timeFontInput.min = isPixel ? '22' : '9';
    els.themeDialogTitle.textContent = THEME_NAMES[editingTheme] + ' · 皮肤设置';
    els.themeScaleInput.value = String(config.overallScale);
    els.messageGapInput.value = String(config.messageGap);
    els.messageFontInput.value = String(config.messageFont);
    els.nameFontInput.value = String(config.nameFont);
    els.metaFontInput.value = String(config.metaFont);
    els.timeFontInput.value = String(config.timeFont);
    els.themeOpacityInput.value = String(config.surfaceOpacity);
    els.themeAvatarInput.checked = config.showAvatar !== false;
    els.bodyColorInput.value = config.bodyColor;
    els.giftColorInput.value = config.giftColor;
    els.timeColorInput.value = config.timeColor;
    els.fontFamilyInput.value = config.fontFamily;
    els.fontFamilyInput.disabled = editingTheme === 'pixel';
    els.fontFamilyInput.title = editingTheme === 'pixel' ? '单色点阵使用内置 16×16 位图字模' : '';
    els.viewerColorInput.value = config.viewerColor;
    els.hostColorInput.value = config.hostColor;
    els.managerColorInput.value = config.managerColor;
    els.governorColorInput.value = config.governorColor;
    els.admiralColorInput.value = config.admiralColor;
    els.captainColorInput.value = config.captainColor;
    els.themeScaleValue.textContent = config.overallScale + '%';
    els.messageGapValue.textContent = config.messageGap + 'px';
    els.messageFontValue.textContent = config.messageFont + 'px';
    els.nameFontValue.textContent = config.nameFont + 'px';
    els.metaFontValue.textContent = config.metaFont + 'px';
    els.timeFontValue.textContent = config.timeFont + 'px';
    els.themeOpacityValue.textContent = config.surfaceOpacity + '%';
  }

  function openThemeEditor(theme) {
    if (!THEMES.has(theme)) return;
    editingTheme = theme;
    settings.theme = theme;
    updateThemeButtons();
    updateThemeEditorValues();
    els.themeDialog.classList.remove('hidden');
    scheduleSave();
  }

  function closeThemeEditor() {
    els.themeDialog.classList.add('hidden');
  }

  function rebaseTheme(config) {
    config.baseWidth = currentOverlayBounds.width;
    config.baseHeight = currentOverlayBounds.height;
  }

  function avatarWidthCompensation(theme, config) {
    const base = AVATAR_TEXT_WIDTH_COST[theme] || 65;
    const scale = Math.max(0.6, Math.min(1.4, Number(config && config.overallScale) / 100 || 1));
    return Math.max(1, Math.round(base * scale));
  }

  function resizeForAvatarToggle(theme, enabled) {
    const config = settings.themeConfigs[theme];
    const delta = avatarWidthCompensation(theme, config) * (enabled ? 1 : -1);
    avatarResizeQueue = avatarResizeQueue.then(async () => {
      const bounds = await window.DesktopOverlay.resizeOverlay(
        currentOverlayBounds.width + delta,
        currentOverlayBounds.height
      );
      if (bounds) {
        setOverlaySizeFields(bounds);
        rebaseTheme(config);
      }
      scheduleSave();
    }).catch(() => {});
  }

  function updateThemeMetric(property, value, rebase) {
    const config = settings.themeConfigs[editingTheme];
    config[property] = Number(value);
    if (rebase) rebaseTheme(config);
    updateThemeEditorValues();
    scheduleSave();
  }

  function stopQrPoll() {
    if (qrPollTimer) {
      clearInterval(qrPollTimer);
      qrPollTimer = null;
    }
  }

  function closeQrDialog() {
    stopQrPoll();
    els.qrDialog.classList.add('hidden');
  }

  function renderLoginStatus(loggedIn, uname, uid) {
    loginUid = loggedIn ? Number(uid) || 0 : 0;
    els.loginStatus.parentElement.classList.toggle('logged-in', loggedIn);
    if (loggedIn) {
      els.loginStatus.textContent = uname || '已登录';
      els.loginDetail.textContent = 'UID ' + loginUid + ' · 已启用账号认证';
      els.loginButton.classList.add('hidden');
      els.logoutButton.classList.remove('hidden');
      closeQrDialog();
    } else {
      els.loginStatus.textContent = '未登录';
      els.loginDetail.textContent = '登录后弹幕用户名完整，连接认证也更稳定。';
      els.loginButton.classList.remove('hidden');
      els.logoutButton.classList.add('hidden');
    }
  }

  async function reconnectWithCurrentAccount() {
    try {
      await window.DesktopOverlay.reconnectRelay();
    } catch (e) {}
  }

  async function startQrLogin() {
    stopQrPoll();
    if (loginUid > 0) return;
    els.qrDialog.classList.remove('hidden');
    els.qrImage.removeAttribute('src');
    els.qrTip.textContent = '正在生成安全登录二维码…';

    try {
      const response = await fetch('/api/login/start');
      const result = await response.json();
      if (!result.ok) throw new Error(result.error || '生成二维码失败');
      if (typeof qrcode !== 'function') throw new Error('二维码组件未加载');

      const qr = qrcode(0, 'M');
      qr.addData(result.url);
      qr.make();
      els.qrImage.src = qr.createDataURL(6, 6);
      els.qrTip.textContent = '请使用 B 站 App 扫码并在手机上确认';

      const key = result.qrcodeKey;
      let elapsed = 0;
      qrPollTimer = setInterval(async () => {
        elapsed += 2000;
        if (elapsed > 180000) {
          stopQrPoll();
          els.qrTip.textContent = '二维码已过期，请刷新后重试';
          return;
        }
        try {
          const pollResponse = await fetch('/api/login/poll?key=' + encodeURIComponent(key));
          const pollResult = await pollResponse.json();
          if (pollResult.ok) {
            stopQrPoll();
            renderLoginStatus(true, pollResult.uname, pollResult.uid);
            await reconnectWithCurrentAccount();
          } else if (pollResult.step === '86038') {
            stopQrPoll();
            els.qrTip.textContent = '二维码已过期，请刷新后重试';
          } else if (pollResult.step === '86090') {
            els.qrTip.textContent = '已扫码，请在手机上确认登录';
          } else if (pollResult.step !== '86101') {
            els.qrTip.textContent = pollResult.message || '登录状态异常，请重试';
          }
        } catch (e) {
          els.qrTip.textContent = '暂时无法查询状态，正在重试…';
        }
      }, 2000);
    } catch (e) {
      els.qrTip.textContent = '二维码生成失败：' + String(e.message || e);
    }
  }

  async function initLoginStatus() {
    try {
      const response = await fetch('/api/status');
      const result = await response.json();
      if (!result.ok) throw new Error('status failed');
      renderLoginStatus(!!result.loggedIn, result.uname, result.uid);
    } catch (e) {
      renderLoginStatus(false);
      els.loginDetail.textContent = '暂时无法读取登录状态，请稍后重试。';
    }
  }

  function bindEvents() {
    els.minimizeButton.addEventListener('click', () => window.DesktopOverlay.minimize());
    els.closeButton.addEventListener('click', () => window.DesktopOverlay.close());
    els.connectButton.addEventListener('click', connectRoom);
    els.roomInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') connectRoom();
    });
    els.roomInput.addEventListener('input', () => {
      const changed = String(els.roomInput.value || '').trim() !== String(settings.roomId || '');
      if (!changed) return;
      els.connectButton.disabled = false;
      els.connectButton.textContent = '连接';
      els.roomHint.textContent = '房间号已修改，点击连接后生效';
    });

    els.loginButton.addEventListener('click', startQrLogin);
    els.qrRefreshButton.addEventListener('click', startQrLogin);
    els.qrCloseButton.addEventListener('click', closeQrDialog);
    els.qrBackdrop.addEventListener('click', closeQrDialog);
    els.logoutButton.addEventListener('click', async () => {
      stopQrPoll();
      try {
        await fetch('/api/login/logout');
      } catch (e) {}
      renderLoginStatus(false);
      await reconnectWithCurrentAccount();
    });

    document.querySelectorAll('[data-theme-choice]').forEach((button) => {
      button.addEventListener('click', () => {
        const next = button.dataset.themeChoice;
        if (!THEMES.has(next)) return;
        settings.theme = next;
        updateThemeButtons();
        scheduleSave();
      });
    });

    document.querySelectorAll('[data-theme-settings]').forEach((button) => {
      button.addEventListener('click', () => openThemeEditor(button.dataset.themeSettings));
    });

    els.themeScaleInput.addEventListener('input', () => updateThemeMetric('overallScale', els.themeScaleInput.value, true));
    els.messageGapInput.addEventListener('input', () => updateThemeMetric('messageGap', els.messageGapInput.value, true));
    els.messageFontInput.addEventListener('input', () => updateThemeMetric('messageFont', els.messageFontInput.value, true));
    els.nameFontInput.addEventListener('input', () => updateThemeMetric('nameFont', els.nameFontInput.value, true));
    els.metaFontInput.addEventListener('input', () => updateThemeMetric('metaFont', els.metaFontInput.value, true));
    els.timeFontInput.addEventListener('input', () => updateThemeMetric('timeFont', els.timeFontInput.value, true));
    els.themeOpacityInput.addEventListener('input', () => updateThemeMetric('surfaceOpacity', els.themeOpacityInput.value, false));
    els.themeAvatarInput.addEventListener('change', () => {
      const enabled = els.themeAvatarInput.checked;
      settings.themeConfigs[editingTheme].showAvatar = enabled;
      resizeForAvatarToggle(editingTheme, enabled);
      scheduleSave();
    });
    els.bodyColorInput.addEventListener('input', () => {
      settings.themeConfigs[editingTheme].bodyColor = els.bodyColorInput.value;
      scheduleSave();
    });
    els.giftColorInput.addEventListener('input', () => {
      settings.themeConfigs[editingTheme].giftColor = els.giftColorInput.value;
      scheduleSave();
    });
    els.timeColorInput.addEventListener('input', () => {
      settings.themeConfigs[editingTheme].timeColor = els.timeColorInput.value;
      scheduleSave();
    });
    els.fontFamilyInput.addEventListener('input', () => {
      settings.themeConfigs[editingTheme].fontFamily = String(els.fontFamilyInput.value || '').trim() || cloneThemeConfig(editingTheme).fontFamily;
      rebaseTheme(settings.themeConfigs[editingTheme]);
      scheduleSave();
    });
    [
      ['viewerColorInput', 'viewerColor'], ['hostColorInput', 'hostColor'],
      ['managerColorInput', 'managerColor'], ['governorColorInput', 'governorColor'],
      ['admiralColorInput', 'admiralColor'], ['captainColorInput', 'captainColor']
    ].forEach(([id, property]) => {
      els[id].addEventListener('input', () => {
        settings.themeConfigs[editingTheme][property] = els[id].value;
        scheduleSave();
      });
    });
    els.themeBackdrop.addEventListener('click', closeThemeEditor);
    els.themeCloseButton.addEventListener('click', closeThemeEditor);
    els.saveThemeButton.addEventListener('click', closeThemeEditor);
    els.resetThemeButton.addEventListener('click', () => {
      settings.themeConfigs[editingTheme] = cloneThemeConfig(editingTheme);
      rebaseTheme(settings.themeConfigs[editingTheme]);
      updateThemeEditorValues();
      scheduleSave();
    });

    els.alwaysOnTopInput.addEventListener('change', () => {
      settings.alwaysOnTop = els.alwaysOnTopInput.checked;
      window.DesktopOverlay.setAlwaysOnTop(settings.alwaysOnTop);
      scheduleSave();
    });
    els.previewEnabledInput.addEventListener('change', () => {
      setPreviewEnabled(els.previewEnabledInput.checked);
      scheduleSave();
    });
    els.overlaySizeLockedInput.addEventListener('change', () => {
      setOverlaySizeLocked(els.overlaySizeLockedInput.checked);
      scheduleSave();
    });
    els.copyObsUrlButton.addEventListener('click', async () => {
      await window.DesktopOverlay.copyObsUrl();
      const previous = els.copyObsUrlButton.textContent;
      els.copyObsUrlButton.textContent = '已复制';
      setTimeout(() => { els.copyObsUrlButton.textContent = previous; }, 1200);
    });
    els.clickThroughButton.addEventListener('click', async () => {
      const state = await window.DesktopOverlay.getWindowState();
      const result = await window.DesktopOverlay.setClickThrough(!state.clickThrough);
      setClickThroughState(result.clickThrough);
    });
    els.showOverlayButton.addEventListener('click', () => window.DesktopOverlay.showOverlay());
    els.resetOverlayButton.addEventListener('click', () => window.DesktopOverlay.resetOverlayBounds());
    els.testMessageButton.addEventListener('click', () => window.DesktopOverlay.previewMessages());
    els.applyOverlaySizeButton.addEventListener('click', applyOverlaySize);
    els.overlayWidthInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') applyOverlaySize();
    });
    els.overlayHeightInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') applyOverlaySize();
    });
    window.DesktopOverlay.onClickThroughChanged(setClickThroughState);
    window.DesktopOverlay.onOverlayStatusChanged(setStatus);
    window.DesktopOverlay.onOverlayBoundsChanged(setOverlaySizeFields);
  }

  async function init() {
    [
      'minimizeButton', 'closeButton', 'statusCard', 'statusText', 'roomInput',
      'roomHint', 'connectButton',
      'alwaysOnTopInput', 'clickThroughButton', 'showOverlayButton',
      'resetOverlayButton', 'testMessageButton', 'loginStatus', 'loginDetail',
      'loginButton', 'logoutButton', 'qrDialog', 'qrBackdrop', 'qrImage',
      'qrTip', 'qrCloseButton', 'qrRefreshButton', 'overlayWidthInput',
      'overlayHeightInput', 'applyOverlaySizeButton', 'themeDialog',
      'themeBackdrop', 'themeDialogTitle', 'themeCloseButton', 'themeScaleInput',
      'themeScaleValue', 'messageGapInput', 'messageGapValue', 'fontFamilyInput',
      'themeAvatarInput',
      'messageFontInput', 'messageFontValue', 'nameFontInput',
      'nameFontValue', 'metaFontInput', 'metaFontValue', 'timeFontInput',
      'timeFontValue', 'themeOpacityInput', 'themeOpacityValue', 'bodyColorInput',
      'giftColorInput', 'timeColorInput', 'viewerColorInput', 'hostColorInput', 'managerColorInput',
      'governorColorInput', 'admiralColorInput', 'captainColorInput',
      'resetThemeButton', 'saveThemeButton', 'obsUrlInput', 'copyObsUrlButton',
      'obsMirrorSizeText', 'previewEnabledInput', 'overlaySizeLockedInput'
    ].forEach((id) => {
      els[id] = byId(id);
    });

    const stored = await window.DesktopOverlay.loadSettings();
    settings = Object.assign(settings, stored || {});
    delete settings.opacity;
    delete settings.obsWidth;
    delete settings.obsHeight;
    if (!THEMES.has(settings.theme)) settings.theme = 'glass';
    const resetThemeConfigs = Number(settings.themeConfigVersion) !== THEME_CONFIG_VERSION;
    if (resetThemeConfigs) {
      settings.themeConfigs = null;
      settings.themeConfigVersion = THEME_CONFIG_VERSION;
    }
    settings.themeConfigs = normalizeThemeConfigs(settings.themeConfigs);
    els.roomInput.value = settings.roomId || '';
    els.roomHint.textContent = settings.roomId ? 'ROOM ' + settings.roomId + ' · 已保存' : '连接后自动保存';
    els.alwaysOnTopInput.checked = settings.alwaysOnTop !== false;
    setOverlaySizeLocked(settings.overlaySizeLocked === true);
    setPreviewEnabled(settings.previewEnabled !== false);
    updateThemeButtons();
    bindEvents();

    const state = await window.DesktopOverlay.getWindowState();
    els.obsUrlInput.value = state.obsUrl || '';
    overlayAvailable = !!state.overlayAvailable;
    setOverlaySizeFields(state.overlayViewport || state.overlayBounds);
    if (pixelBitmapMigrationPending) {
      rebaseTheme(settings.themeConfigs.pixel);
      pixelBitmapMigrationPending = false;
    }
    if (resetThemeConfigs) THEMES.forEach((theme) => rebaseTheme(settings.themeConfigs[theme]));
    setClickThroughState(state.clickThrough);
    setStatus(state.overlayStatus || 'disconnected');
    scheduleSave();
    await initLoginStatus();
  }

  window.addEventListener('beforeunload', stopQrPoll);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
