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
  const themeRegistry = window.DanmuThemes;
  const THEMES = new Set(themeRegistry.ids);
  const CLOSE_ACTIONS = new Set(['ask', 'tray', 'quit']);
  const THEME_NAMES = themeRegistry.names;
  const AVATAR_TEXT_WIDTH_COST = themeRegistry.avatarWidthCosts;
  const THEME_CONFIG_VERSION = themeRegistry.configVersion;
  const DEFAULT_THEME_CONFIGS = themeRegistry.defaults;

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
  let qrRequestController = null;
  let qrGeneration = 0;
  let loginUid = 0;
  let loginStateChanges = 0;
  let overlayAvailable = false;
  let previewToggleTask = null;
  let clickThroughPending = false;
  let editingTheme = 'glass';
  let themeListExpanded = false;
  let themeEditorFocus = null;
  let qrDialogFocus = null;
  let currentOverlayBounds = { width: 515, height: 650 };
  let avatarResizeQueue = Promise.resolve();
  let settingsReady = false;
  let connectionStatus = 'disconnected';
  let connectionStatusChanges = 0;
  let roomActionPending = null;
  const els = {};
  let controlCloseToken = null;
  let controlCloseFocus = null;
  let closeAction = 'ask';
  let closeActionChangeCount = 0;
  let playbackChangeCount = 0;
  let previewChangeCount = 0;
  let boundsChangeCount = 0;
  let clickThroughChangeCount = 0;
  let closeActionSaveTask = null;
  let themeScSaveTask = null;
  let themeScSaving = '';
  let themeScSaveError = '';
  let programSettingsFocus = null;
  let settingsSaveTask = Promise.resolve(true);
  let overlaySizeTask = null;
  let stylePresets = [];
  let stylePresetsReady = false;
  let stylePresetLoadFailed = false;
  let stylePresetTask = null;
  let stylePresetEditingId = '';
  let stylePresetDeletePending = false;
  let stylePresetFocus = null;

  function cloneThemeConfig(theme) {
    return Object.assign({}, DEFAULT_THEME_CONFIGS[theme]);
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
    updateThemeListVisibility();
  }

  function updateThemeListVisibility() {
    els.themeGrid.classList.toggle('is-collapsed', !themeListExpanded);
    els.themeListToggleButton.setAttribute('aria-expanded', String(themeListExpanded));
    const toggleLabel = themeListExpanded ? '收起皮肤列表' : '展开其余 ' + Math.max(0, themeRegistry.ids.length - 2) + ' 套皮肤';
    els.themeListToggleButton.setAttribute('aria-label', toggleLabel);
    els.themeListToggleButton.title = toggleLabel;
    const hiddenSelection = !themeListExpanded && settings.theme !== 'glass' && settings.theme !== 'portrait';
    els.currentHiddenThemeHint.textContent = hiddenSelection ? '当前：' + THEME_NAMES[settings.theme] : '';
    els.currentHiddenThemeHint.classList.toggle('hidden', !hiddenSelection);
  }

  function persistNow() {
    const snapshot = structuredClone(settings);
    settingsSaveTask = settingsSaveTask.catch(() => {}).then(() => window.DesktopOverlay.saveSettings(snapshot));
    return settingsSaveTask;
  }

  function openControlCloseDialog(payload, errorMessage) {
    const dialog = byId('controlCloseDialog');
    const isError = typeof errorMessage === 'string';
    if (!isError && (!payload || typeof payload.token !== 'string')) return;
    closeProgramSettings();
    closeStylePresetDialog(true);
    if (isError || !dialog.open || controlCloseToken !== payload.token) byId('controlCloseRememberInput').checked = false;
    controlCloseToken = isError ? null : payload.token;
    byId('controlCloseTitle').textContent = isError ? '暂时无法关闭' : '关闭弹幕姬';
    byId('controlCloseDescription').textContent = isError
      ? errorMessage || '暂时无法保存设置，请返回控制台后重试。'
      : '最小化后继续接收弹幕，退出将停止输出。';
    byId('controlCloseChoices').classList.toggle('hidden', isError);
    byId('controlCloseCancelButton').classList.toggle('hidden', isError);
    byId('controlCloseReturnButton').classList.toggle('hidden', !isError);
    if (!dialog.open) {
      controlCloseFocus = document.activeElement;
      document.body.classList.add('control-close-open');
      dialog.showModal();
    }
    byId(isError ? 'controlCloseReturnButton' : 'controlCloseTrayButton').focus();
  }

  function finishControlCloseDialog(action) {
    const dialog = byId('controlCloseDialog');
    if (!dialog.open) return;
    const token = controlCloseToken;
    const remember = (action === 'tray' || action === 'quit') && byId('controlCloseRememberInput').checked;
    controlCloseToken = null;
    dialog.close();
    document.body.classList.remove('control-close-open');
    if (controlCloseFocus && controlCloseFocus.isConnected) controlCloseFocus.focus({ preventScroll: true });
    controlCloseFocus = null;
    // Remove the top-layer dialog before main starts the existing save handshake.
    if (token !== null) window.DesktopOverlay.controlCloseChoice(token, action, remember);
  }

  function bindControlCloseDialog() {
    const dialog = byId('controlCloseDialog');
    let backdropPointerDown = false;
    const outsideDialog = (event) => {
      if (event.target !== dialog) return false;
      const bounds = dialog.getBoundingClientRect();
      return event.clientX < bounds.left || event.clientX > bounds.right ||
        event.clientY < bounds.top || event.clientY > bounds.bottom;
    };
    dialog.addEventListener('pointerdown', (event) => {
      backdropPointerDown = outsideDialog(event);
    });
    dialog.addEventListener('click', (event) => {
      if (backdropPointerDown && outsideDialog(event)) finishControlCloseDialog('cancel');
      backdropPointerDown = false;
    });
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      event.stopPropagation();
      finishControlCloseDialog('cancel');
    });
    dialog.addEventListener('keydown', (event) => {
      // Keep Tab within the dialog, including when an underlying editor is open.
      event.stopPropagation();
      if (event.key !== 'Tab') return;
      const controls = Array.from(dialog.querySelectorAll('button, input')).filter((control) => control.getClientRects().length && !control.disabled);
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
    byId('controlCloseTrayButton').addEventListener('click', () => finishControlCloseDialog('tray'));
    byId('controlCloseQuitButton').addEventListener('click', () => finishControlCloseDialog('quit'));
    byId('controlCloseCancelButton').addEventListener('click', () => finishControlCloseDialog('cancel'));
    byId('controlCloseReturnButton').addEventListener('click', () => finishControlCloseDialog('cancel'));
    byId('minimizeButton').addEventListener('click', () => window.DesktopOverlay.minimize());
    byId('closeButton').addEventListener('click', () => window.DesktopOverlay.close());
    window.DesktopOverlay.onControlClosePrompt((payload) => openControlCloseDialog(payload));
    window.DesktopOverlay.onControlCloseError((message) => openControlCloseDialog(null, String(message || '')));
    window.DesktopOverlay.onCloseActionChanged((action) => {
      closeActionChangeCount++;
      setCloseActionState(action);
    });
  }

  function setCloseActionState(action) {
    closeAction = CLOSE_ACTIONS.has(action) ? action : 'ask';
    byId('closeActionSelect').value = closeAction;
  }

  function closeProgramSettings() {
    const dialog = byId('programSettingsDialog');
    if (dialog.open) dialog.close();
  }

  function bindProgramSettings() {
    const dialog = byId('programSettingsDialog');
    const button = byId('programSettingsButton');
    button.addEventListener('click', () => {
      if (dialog.open || byId('controlCloseDialog').open || stylePresetTask) return;
      programSettingsFocus = button;
      document.body.classList.add('program-settings-open');
      button.setAttribute('aria-expanded', 'true');
      dialog.showModal();
      const select = byId('closeActionSelect');
      (select.disabled ? byId('programSettingsCloseButton') : select).focus();
    });
    byId('programSettingsCloseButton').addEventListener('click', closeProgramSettings);
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeProgramSettings();
    });
    dialog.addEventListener('close', () => {
      document.body.classList.remove('program-settings-open');
      button.setAttribute('aria-expanded', 'false');
      if (!byId('controlCloseDialog').open && programSettingsFocus && programSettingsFocus.isConnected) {
        programSettingsFocus.focus({ preventScroll: true });
      }
      programSettingsFocus = null;
    });
    let backdropPointerDown = false;
    const outsideDialog = (event) => {
      if (event.target !== dialog) return false;
      const bounds = dialog.getBoundingClientRect();
      return event.clientX < bounds.left || event.clientX > bounds.right ||
        event.clientY < bounds.top || event.clientY > bounds.bottom;
    };
    dialog.addEventListener('pointerdown', (event) => { backdropPointerDown = outsideDialog(event); });
    dialog.addEventListener('click', (event) => {
      if (backdropPointerDown && outsideDialog(event)) closeProgramSettings();
      backdropPointerDown = false;
    });
    dialog.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key !== 'Tab') return;
      const controls = Array.from(dialog.querySelectorAll('button, input, select')).filter((control) => !control.disabled && control.getClientRects().length);
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
  }

  function saveCloseAction() {
    const select = byId('closeActionSelect');
    if (closeActionSaveTask) {
      select.value = closeAction;
      return closeActionSaveTask;
    }
    const next = select.value;
    if (!CLOSE_ACTIONS.has(next) || next === closeAction) {
      select.value = closeAction;
      return Promise.resolve(true);
    }
    const hint = byId('closeActionHint');
    select.disabled = true;
    hint.dataset.error = 'false';
    hint.textContent = '正在保存…';
    closeActionSaveTask = Promise.resolve().then(() => window.DesktopOverlay.setCloseAction(next)).then((result) => {
      if (!result || !CLOSE_ACTIONS.has(result.closeAction)) throw new Error('Invalid close action response');
      closeActionChangeCount++;
      setCloseActionState(result.closeAction);
      hint.textContent = '已保存，可随时修改关闭方式。';
      return true;
    }).catch(() => {
      select.value = closeAction;
      hint.dataset.error = 'true';
      hint.textContent = '保存失败，已恢复原设置。请重试。';
      return false;
    }).finally(() => {
      closeActionSaveTask = null;
      select.disabled = false;
    });
    return closeActionSaveTask;
  }

  async function prepareControlClose(token) {
    try {
      // Before controls are bound, the main process already owns the saved
      // settings. Do not overwrite them with this page's initial defaults.
      if (settingsReady) {
        await stylePresetTask;
        await overlaySizeTask;
        if (await window.ControlAppearance.flush() === false) throw new Error('Control appearance was not saved');
        if (await closeActionSaveTask === false) throw new Error('Close action was not saved');
        if (await themeScSaveTask === false) throw new Error('SC setting was not saved');
        await previewToggleTask;
        await avatarResizeQueue;
        if (saveTimer !== null) {
          clearTimeout(saveTimer);
          saveTimer = null;
        }
        if (previewFrame !== null) {
          cancelAnimationFrame(previewFrame);
          previewFrame = null;
        }
        await persistNow();
      }
      window.DesktopOverlay.controlClosePrepared(token, true);
    } catch (error) {
      window.DesktopOverlay.controlClosePrepared(token, false);
    }
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
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      // Take the snapshot after a pending SC change settles so a failed
      // preference cannot survive its rollback in a queued appearance save.
      await themeScSaveTask;
      persistNow().catch(() => showStylePresetMessage('设置暂时未保存，请稍后重试。', true));
    }, 100);
  }

  function setPlaybackState(value) {
    const state = value || {};
    const count = (number) => Number.isFinite(Number(number)) ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(Number(number)))) : 0;
    const pending = count(state.pending);
    const skipped = count(state.skipped);
    const label = skipped > 0 ? '积压保护已跳过 ' + skipped + ' 条' : pending > 0 ? '待显示 ' + pending + ' 条' : '';
    if (els.playbackStatus.textContent !== label) els.playbackStatus.textContent = label;
    els.playbackStatus.classList.toggle('hidden', !label);
    els.playbackStatus.dataset.level = skipped > 0 ? 'warning' : 'queue';
    if (skipped > 0 && pending > 0) els.playbackStatus.title = '当前待显示 ' + pending + ' 条';
    else els.playbackStatus.removeAttribute('title');
  }

  function isRoomConnectionActive() {
    return ['open', 'init', 'connecting', 'auth', 'reconnect', 'waiting-obs'].includes(connectionStatus);
  }

  function renderRoomControls() {
    const changed = String(els.roomInput.value || '').trim() !== String(settings.roomId || '');
    const active = isRoomConnectionActive();
    els.connectButton.disabled = !!roomActionPending;
    els.connectButton.setAttribute('aria-busy', String(!!roomActionPending));
    els.roomInput.disabled = !!roomActionPending;
    els.connectButton.textContent = roomActionPending
      ? (roomActionPending === 'disconnect' ? '正在断开…' : '正在连接…')
      : changed ? (active ? '切换直播间' : '连接')
        : connectionStatus === 'open' ? '断开连接'
          : active ? '取消连接'
            : settings.roomId ? '重新连接' : '连接';
    els.connectButton.dataset.action = !changed && active ? 'disconnect' : 'connect';
    els.roomHint.textContent = changed
      ? '房间号已修改，点击后连接此房间'
      : settings.roomId ? 'ROOM ' + settings.roomId + ' · ' + (STATUS_MAP[connectionStatus] || ['', '未连接'])[1]
        : '连接后自动保存';
  }

  function setStatus(status) {
    connectionStatus = status;
    connectionStatusChanges++;
    const mapped = STATUS_MAP[status] || ['error', String(status || '错误')];
    els.statusCard.dataset.status = mapped[0];
    els.statusText.textContent = mapped[1];
    if (status === 'open' && settings.previewEnabled !== false) overlayAvailable = true;
    renderPreviewControls();
    renderRoomControls();
  }

  async function toggleRoomConnection() {
    if (roomActionPending) return;
    const roomId = String(els.roomInput.value || '').trim();
    const disconnect = roomId === String(settings.roomId || '') && isRoomConnectionActive();
    if (!disconnect && !/^\d+$/.test(roomId)) {
      els.roomHint.textContent = '请输入纯数字房间号';
      els.roomInput.focus();
      return;
    }
    const previousRoom = settings.roomId;
    const previousStatus = connectionStatus;
    roomActionPending = disconnect ? 'disconnect' : 'connect';
    if (!disconnect) {
      settings.roomId = roomId;
      setStatus('connecting');
    } else renderRoomControls();
    const statusSnapshot = connectionStatusChanges;
    let failed = false;
    try {
      const accepted = disconnect
        ? await window.DesktopOverlay.disconnectRoom()
        : await window.DesktopOverlay.connectRoom(roomId);
      if (!accepted) throw new Error('Room request rejected');
      if (disconnect) setStatus('disconnected');
    } catch (_) {
      failed = true;
      if (!disconnect) settings.roomId = previousRoom;
      if (connectionStatusChanges === statusSnapshot) setStatus(previousStatus);
    } finally {
      roomActionPending = null;
      renderRoomControls();
      if (failed) els.roomHint.textContent = disconnect ? '断开失败，请重试' : '连接请求失败，请重试';
    }
  }

  function setClickThroughState(enabled) {
    clickThroughChangeCount++;
    els.clickThroughButton.classList.toggle('active', enabled);
    els.clickThroughButton.setAttribute('aria-pressed', String(!!enabled));
    els.clickThroughButton.querySelector('span').textContent = enabled ? '关闭鼠标穿透' : '开启鼠标穿透';
  }

  function setOverlaySizeFields(bounds) {
    if (!bounds) return;
    boundsChangeCount++;
    currentOverlayBounds = {
      width: Math.round(Number(bounds.width) || 515),
      height: Math.round(Number(bounds.height) || 650)
    };
    els.overlayWidthInput.value = String(currentOverlayBounds.width);
    els.overlayHeightInput.value = String(currentOverlayBounds.height);
    els.obsMirrorSizeText.textContent = '浏览器源尺寸 ' + currentOverlayBounds.width + ' × ' + currentOverlayBounds.height;
  }

  function applyOverlaySize() {
    if (settings.overlaySizeLocked || stylePresetTask || overlaySizeTask) return overlaySizeTask;
    const width = Number(els.overlayWidthInput.value);
    const height = Number(els.overlayHeightInput.value);
    overlaySizeTask = window.DesktopOverlay.resizeOverlay(width, height).then(setOverlaySizeFields)
      .catch(() => showStylePresetMessage('尺寸调整失败，请重试。', true))
      .finally(() => { overlaySizeTask = null; });
    return overlaySizeTask;
  }

  function setOverlaySizeLocked(locked) {
    settings.overlaySizeLocked = !!locked;
    els.overlaySizeLockedInput.checked = settings.overlaySizeLocked;
    els.overlayWidthInput.disabled = settings.overlaySizeLocked;
    els.overlayHeightInput.disabled = settings.overlaySizeLocked;
    els.applyOverlaySizeButton.disabled = settings.overlaySizeLocked;
  }

  function setPreviewEnabled(enabled) {
    previewChangeCount++;
    settings.previewEnabled = !!enabled;
    if (!settings.previewEnabled) overlayAvailable = false;
    renderPreviewControls();
  }

  function renderPreviewControls() {
    const enabled = settings.previewEnabled !== false;
    const busy = !!previewToggleTask;
    els.previewToggleButton.disabled = busy || clickThroughPending;
    els.previewToggleButton.classList.toggle('active', enabled);
    els.previewToggleButton.setAttribute('aria-pressed', String(enabled));
    els.previewToggleButton.setAttribute('aria-busy', String(busy));
    els.previewToggleLabel.textContent = busy
      ? (enabled ? '正在打开…' : '正在关闭…')
      : (enabled ? '关闭输出窗口' : '显示输出窗口');
    els.previewToggleHint.textContent = enabled ? '关闭后 OBS 仍继续输出' : '在桌面查看实时弹幕';
    els.previewStateText.textContent = enabled ? (overlayAvailable ? '已开启' : '连接后显示') : '已关闭';
    els.previewStateText.dataset.enabled = String(enabled);
    els.alwaysOnTopInput.disabled = !enabled || busy;
    els.clickThroughButton.disabled = !enabled || !overlayAvailable || busy || clickThroughPending;
    els.clickThroughButton.querySelector('small').textContent = !enabled
      ? '显示输出窗口后可开启'
      : (!overlayAvailable ? '连接直播间后可开启' : 'Ctrl + Shift + F10 随时切换');
  }

  function togglePreview() {
    if (previewToggleTask || clickThroughPending) return;
    const previous = settings.previewEnabled !== false;
    const previousAvailable = overlayAvailable;
    setPreviewEnabled(!previous);
    previewToggleTask = (async () => {
      let failed = false;
      try {
        const result = await window.DesktopOverlay.setPreviewEnabled(!previous);
        overlayAvailable = !!result.overlayAvailable;
        setPreviewEnabled(result.previewEnabled);
      } catch (error) {
        overlayAvailable = previousAvailable;
        setPreviewEnabled(previous);
        failed = true;
      } finally {
        previewToggleTask = null;
        renderPreviewControls();
        if (failed) els.previewToggleHint.textContent = '操作未完成，请再试一次';
      }
    })();
    renderPreviewControls();
    return previewToggleTask;
  }

  function showStylePresetMessage(message, isError = false) {
    const hint = byId('stylePresetHint');
    if (!hint) return;
    hint.textContent = message;
    hint.dataset.error = String(isError);
  }

  function selectedStylePreset() {
    return stylePresets.find((preset) => preset.id === els.stylePresetSelect.value);
  }

  function renderStylePresetControls() {
    const busy = !!stylePresetTask;
    const selected = selectedStylePreset();
    els.stylePresetSelect.disabled = busy || !stylePresetsReady || !stylePresets.length;
    els.applyStylePresetButton.disabled = busy || !selected;
    els.saveStylePresetButton.disabled = busy || !stylePresetsReady || stylePresets.length >= 30;
    els.manageStylePresetButton.disabled = busy || (!selected && !stylePresetLoadFailed);
    els.manageStylePresetButton.textContent = stylePresetLoadFailed ? '重试' : '管理';
    els.stylePresetDialog.querySelectorAll('button, input').forEach((control) => { control.disabled = busy; });
    els.stylePresetDialog.setAttribute('aria-busy', String(busy));
  }

  function setStylePresetList(presets, selectedId = els.stylePresetSelect.value) {
    stylePresets = Array.isArray(presets) ? presets : [];
    // Keep the customizable select's button / selectedcontent intact.
    Array.from(els.stylePresetSelect.options).forEach((option) => option.remove());
    const empty = new Option(stylePresets.length ? '选择已保存的样式' : '尚未保存预设', '');
    els.stylePresetSelect.add(empty);
    stylePresets.forEach((preset) => {
      els.stylePresetSelect.add(new Option(preset.name + ' · ' + (THEME_NAMES[preset.theme] || '') + ' · ' + preset.width + ' × ' + preset.height, preset.id));
    });
    els.stylePresetSelect.value = stylePresets.some((preset) => preset.id === selectedId) ? selectedId : '';
    renderStylePresetControls();
  }

  async function loadStylePresets() {
    stylePresetLoadFailed = false;
    renderStylePresetControls();
    try {
      const result = await window.DesktopOverlay.listStylePresets();
      stylePresetsReady = true;
      setStylePresetList(result.presets, result.activeStylePresetId || '');
      const restored = selectedStylePreset();
      showStylePresetMessage(restored
        ? '已恢复上次使用的预设“' + restored.name + '”，保留退出前的样式设置。'
        : stylePresets.length ? '选择预设后点击“应用”。' : '保存当前样式，下次快速切换。');
    } catch (error) {
      stylePresetLoadFailed = true;
      showStylePresetMessage('预设读取失败，点击“重试”重新加载。', true);
      renderStylePresetControls();
    }
  }

  function restoreStylePresetFocus() {
    if (stylePresetTask || byId('stylePresetDialog').open) return;
    if (!byId('controlCloseDialog').open && !byId('programSettingsDialog').open && stylePresetFocus && stylePresetFocus.isConnected) {
      stylePresetFocus.focus({ preventScroll: true });
    }
    stylePresetFocus = null;
  }

  function runStylePresetTask(run) {
    if (stylePresetTask) return stylePresetTask;
    const main = document.querySelector('main');
    main.inert = true;
    els.themeDialog.inert = true;
    byId('programSettingsButton').disabled = true;
    stylePresetTask = Promise.resolve().then(run).then(() => true).catch((error) => {
      const message = String(error && error.message || '操作失败，请重试。').replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '');
      showStylePresetMessage(message, true);
      if (els.stylePresetDialog.open) {
        els.stylePresetSummary.textContent = message;
        els.stylePresetSummary.dataset.error = 'true';
      }
      return false;
    }).finally(() => {
      stylePresetTask = null;
      main.inert = false;
      els.themeDialog.inert = false;
      byId('programSettingsButton').disabled = false;
      renderStylePresetControls();
      if (els.stylePresetDialog.open && els.stylePresetSummary.dataset.error === 'true') els.stylePresetNameInput.focus();
      restoreStylePresetFocus();
    });
    renderStylePresetControls();
    return stylePresetTask;
  }

  async function flushAppearanceSettings() {
    if (await themeScSaveTask === false) throw new Error('SC设置尚未保存，请重试。');
    await previewToggleTask;
    await avatarResizeQueue;
    await overlaySizeTask;
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = null;
    if (previewFrame !== null) cancelAnimationFrame(previewFrame);
    previewFrame = null;
    await persistNow();
  }

  async function captureStylePreset(name, id) {
    await flushAppearanceSettings();
    const current = await window.DesktopOverlay.loadSettings();
    return {
      ...(id ? { id } : {}), name, theme: settings.theme,
      width: current.previewCanvasWidth, height: current.previewCanvasHeight,
      config: structuredClone(settings.themeConfigs[settings.theme])
    };
  }

  function adoptPresetSettings(next, canvas) {
    settings = themeRegistry.migrateSettings(Object.assign(settings, next || {}));
    editingTheme = settings.theme;
    updateThemeButtons();
    updateThemeEditorValues();
    if (canvas) setOverlaySizeFields(canvas);
  }

  function applySelectedStylePreset() {
    const preset = selectedStylePreset();
    if (!preset || stylePresetTask) return;
    showStylePresetMessage('正在应用“' + preset.name + '”…');
    return runStylePresetTask(async () => {
      await flushAppearanceSettings();
      try {
        const result = await window.DesktopOverlay.applyStylePreset(preset.id);
        adoptPresetSettings(result.settings, result.canvas);
      } catch (error) {
        // Main rolls back failed applications; read that state before a close
        // handshake or a later edit can persist an obsolete renderer snapshot.
        const restored = await window.DesktopOverlay.loadSettings();
        adoptPresetSettings(restored, { width: restored.previewCanvasWidth, height: restored.previewCanvasHeight });
        throw error;
      }
      showStylePresetMessage('已应用“' + preset.name + '”。');
    });
  }

  function stylePresetName() {
    const name = els.stylePresetNameInput.value.trim();
    if (!name || name.length > 40) throw new Error('请输入 1–40 字的预设名称。');
    return name;
  }

  function renderStylePresetDialog() {
    const existing = stylePresets.find((preset) => preset.id === stylePresetEditingId);
    els.stylePresetDialogTitle.textContent = existing ? '管理样式预设' : '保存当前样式';
    els.confirmStylePresetButton.textContent = stylePresetDeletePending ? '取消删除' : (existing ? '保存名称' : '保存');
    els.deleteStylePresetButton.textContent = stylePresetDeletePending ? '确认删除' : '删除';
    els.overwriteStylePresetButton.classList.toggle('hidden', !existing || stylePresetDeletePending);
    els.deleteStylePresetButton.classList.toggle('hidden', !existing);
    els.stylePresetSummary.dataset.error = 'false';
    els.stylePresetSummary.textContent = stylePresetDeletePending
      ? '确定删除“' + existing.name + '”？当前屏幕样式会保留。'
      : existing
        ? (THEME_NAMES[existing.theme] || '') + ' · ' + existing.width + ' × ' + existing.height + '。覆盖时会使用当前皮肤、尺寸与配色。'
        : THEME_NAMES[settings.theme] + ' · ' + currentOverlayBounds.width + ' × ' + currentOverlayBounds.height + '。包含字号、间距、头像和欢迎提示设置。';
    renderStylePresetControls();
  }

  function openStylePresetDialog(manage) {
    if (stylePresetTask || !stylePresetsReady) return;
    const preset = manage ? selectedStylePreset() : null;
    if (manage && !preset) return;
    stylePresetEditingId = preset ? preset.id : '';
    stylePresetDeletePending = false;
    let name = preset ? preset.name : THEME_NAMES[settings.theme];
    if (!preset) {
      let suffix = 2;
      while (stylePresets.some((entry) => entry.name === name)) name = THEME_NAMES[settings.theme] + ' ' + suffix++;
    }
    els.stylePresetNameInput.value = name;
    renderStylePresetDialog();
    stylePresetFocus = document.activeElement;
    document.body.classList.add('style-preset-open');
    els.stylePresetDialog.showModal();
    els.stylePresetNameInput.focus();
    els.stylePresetNameInput.select();
  }

  function closeStylePresetDialog(force = false) {
    if (stylePresetTask && !force) return;
    const dialog = byId('stylePresetDialog');
    if (dialog && dialog.open) dialog.close();
  }

  function confirmStylePreset(overwrite = false) {
    if (stylePresetTask) return;
    if (stylePresetDeletePending) {
      stylePresetDeletePending = false;
      renderStylePresetDialog();
      return;
    }
    return runStylePresetTask(async () => {
      const name = stylePresetName();
      const result = stylePresetEditingId && !overwrite
        ? await window.DesktopOverlay.renameStylePreset(stylePresetEditingId, name)
        : await window.DesktopOverlay.saveStylePreset(await captureStylePreset(name, overwrite ? stylePresetEditingId : ''));
      setStylePresetList(result.presets, result.preset.id);
      showStylePresetMessage('已保存“' + result.preset.name + '”。');
      closeStylePresetDialog(true);
    });
  }

  function deleteStylePreset() {
    if (stylePresetTask || !stylePresetEditingId) return;
    if (!stylePresetDeletePending) {
      stylePresetDeletePending = true;
      renderStylePresetDialog();
      return;
    }
    return runStylePresetTask(async () => {
      const result = await window.DesktopOverlay.deleteStylePreset(stylePresetEditingId);
      setStylePresetList(result.presets, result.activeStylePresetId || '');
      showStylePresetMessage('预设已删除，当前样式保持不变。');
      closeStylePresetDialog(true);
    });
  }

  function bindStylePresetDialog() {
    const dialog = byId('stylePresetDialog');
    byId('stylePresetDialogCloseButton').addEventListener('click', () => closeStylePresetDialog());
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); event.stopPropagation(); closeStylePresetDialog(); });
    dialog.addEventListener('close', () => {
      document.body.classList.remove('style-preset-open');
      stylePresetDeletePending = false;
      restoreStylePresetFocus();
    });
    let backdropDown = false;
    const outside = (event) => {
      if (event.target !== dialog) return false;
      const bounds = dialog.getBoundingClientRect();
      return event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
    };
    dialog.addEventListener('pointerdown', (event) => { backdropDown = outside(event); });
    dialog.addEventListener('click', (event) => { if (backdropDown && outside(event)) closeStylePresetDialog(); backdropDown = false; });
    dialog.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter' && event.target.id === 'stylePresetNameInput') {
        event.preventDefault(); confirmStylePreset();
      }
      if (event.key !== 'Tab') return;
      const controls = Array.from(dialog.querySelectorAll('button, input')).filter((control) => !control.disabled && control.getClientRects().length);
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
  }

  function updateThemeScControl() {
    els.scNeverExpireInput.checked = settings.themeConfigs[editingTheme].scNeverExpire === true;
    els.scNeverExpireInput.disabled = !!themeScSaveTask;
    els.resetThemeButton.disabled = !!themeScSaveTask;
    const saving = !!themeScSaveTask && themeScSaving === editingTheme;
    const failed = themeScSaveError === editingTheme;
    els.scNeverExpireHint.dataset.error = String(failed);
    els.scNeverExpireHint.textContent = saving ? '正在保存…'
      : failed ? '保存失败，已恢复此皮肤原设置。请重试。'
        : '此皮肤独立保存；未勾选时到期进入弹幕流';
  }

  function updateThemeEditorValues() {
    const config = settings.themeConfigs[editingTheme];
    updateThemeScControl();
    els.messageFontInput.min = '16';
    els.nameFontInput.min = '10';
    els.metaFontInput.min = '8';
    els.timeFontInput.min = '9';
    els.themeDialogTitle.textContent = THEME_NAMES[editingTheme] + ' · 皮肤设置';
    els.themeScaleInput.value = String(config.overallScale);
    els.messageGapInput.value = String(config.messageGap);
    els.horizontalPaddingInput.value = String(config.horizontalPadding);
    els.messageFontInput.value = String(config.messageFont);
    els.emoteScaleInput.value = String(config.emoteScale);
    els.emoteScaleValue.textContent = config.emoteScale + '%';
    els.nameFontInput.value = String(config.nameFont);
    els.metaFontInput.value = String(config.metaFont);
    els.timeFontInput.value = String(config.timeFont);
    els.themeOpacityInput.value = String(config.surfaceOpacity);
    els.surfaceOpacityLabel.textContent = editingTheme === 'outline' ? '底色不透明度' : '承载面不透明度';
    els.surfaceOpacityHint.textContent = editingTheme === 'outline'
      ? '调节底色透明度，纯白描边保持可见'
      : '0% 仅保留弹幕 · 100% 显示完整皮肤背景';
    const hasShadowSetting = editingTheme === 'glass' || editingTheme === 'outline';
    els.shadowStrengthField.classList.toggle('hidden', !hasShadowSetting);
    els.shadowStrengthInput.disabled = !hasShadowSetting;
    els.shadowStrengthInput.value = String(config.shadowStrength ?? 0);
    els.shadowStrengthValue.textContent = (config.shadowStrength ?? 0) + '%';
    els.portraitWidthField.classList.toggle('hidden', editingTheme !== 'portrait');
    els.portraitWidthInput.disabled = editingTheme !== 'portrait';
    els.portraitWidthInput.value = String(config.portraitWidth ?? 48);
    els.portraitWidthValue.textContent = (config.portraitWidth ?? 48) + '%';
    els.glassSurfaceColorField.classList.toggle('hidden', editingTheme !== 'glass');
    els.surfaceColorInput.value = config.surfaceColor || '#000000';
    els.surfaceColorInput.disabled = editingTheme !== 'glass';
    els.themeAvatarInput.checked = config.showAvatar !== false;
    els.fullCardsOnlyInput.checked = config.fullCardsOnly !== false;
    els.messageAlignInput.value = config.messageAlign;
    byId('themeAvatarLabel').textContent = editingTheme === 'portrait' ? '额外显示用户头像' : '显示用户头像';
    byId('themeAvatarHint').textContent = editingTheme === 'portrait'
      ? '在左侧另加小头像，背景图片不受影响'
      : '开启时扩大文字宽度；关闭后缩回原宽度';
    els.themeWelcomeInput.checked = config.showWelcome !== false;
    els.welcomeFontInput.value = String(config.welcomeFont);
    els.welcomeFontInput.disabled = !els.themeWelcomeInput.checked;
    els.welcomeFontInput.parentElement.classList.toggle('is-disabled', els.welcomeFontInput.disabled);
    els.welcomeFontValue.textContent = config.welcomeFont + 'px';
    els.welcomeTextColorInput.value = config.welcomeTextColor;
    els.welcomeNameColorInput.value = config.welcomeNameColor;
    els.welcomeTextColorInput.disabled = !els.themeWelcomeInput.checked;
    els.welcomeNameColorInput.disabled = !els.themeWelcomeInput.checked;
    els.bodyColorInput.value = config.bodyColor;
    els.giftColorInput.value = config.giftColor;
    els.timeColorInput.value = config.timeColor;
    els.fontFamilyInput.value = config.fontFamily;
    els.viewerColorInput.value = config.viewerColor;
    els.hostColorInput.value = config.hostColor;
    els.managerColorInput.value = config.managerColor;
    els.governorColorInput.value = config.governorColor;
    els.admiralColorInput.value = config.admiralColor;
    els.captainColorInput.value = config.captainColor;
    els.themeScaleValue.textContent = config.overallScale + '%';
    els.messageGapValue.textContent = config.messageGap + 'px';
    els.horizontalPaddingValue.textContent = config.horizontalPadding + 'px';
    els.messageFontValue.textContent = config.messageFont + 'px';
    els.nameFontValue.textContent = config.nameFont + 'px';
    els.metaFontValue.textContent = config.metaFont + 'px';
    els.timeFontValue.textContent = config.timeFont + 'px';
    els.themeOpacityValue.textContent = config.surfaceOpacity + '%';
  }

  function openThemeEditor(theme) {
    if (!THEMES.has(theme)) return;
    if (els.themeDialog.classList.contains('hidden')) themeEditorFocus = document.activeElement;
    editingTheme = theme;
    settings.theme = theme;
    updateThemeButtons();
    updateThemeEditorValues();
    els.themeDialog.classList.remove('hidden');
    els.themeCloseButton.focus({ preventScroll: true });
    scheduleSave();
  }

  function closeThemeEditor() {
    if (els.themeDialog.classList.contains('hidden')) return;
    els.themeDialog.classList.add('hidden');
    if (themeEditorFocus && themeEditorFocus.isConnected && themeEditorFocus.getClientRects().length) {
      themeEditorFocus.focus({ preventScroll: true });
    }
    themeEditorFocus = null;
  }

  function bindSheetKeyboard(dialog, close) {
    dialog.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      if (event.key !== 'Tab') return;
      const controls = Array.from(dialog.querySelectorAll('button, input, select')).filter(
        control => !control.disabled && control.tabIndex !== -1 && control.getClientRects().length
      );
      if (!controls.length) return;
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    });
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
    qrGeneration++;
    if (qrPollTimer !== null) clearTimeout(qrPollTimer);
    qrPollTimer = null;
    if (qrRequestController) qrRequestController.abort();
    qrRequestController = null;
  }

  function closeQrDialog() {
    stopQrPoll();
    if (els.qrDialog.classList.contains('hidden')) return;
    els.qrDialog.classList.add('hidden');
    const target = qrDialogFocus && qrDialogFocus.isConnected && qrDialogFocus.getClientRects().length
      ? qrDialogFocus : loginUid > 0 ? els.logoutButton : els.loginButton;
    if (target && target.getClientRects().length) target.focus({ preventScroll: true });
    qrDialogFocus = null;
  }

  function renderLoginStatus(loggedIn, uname, uid) {
    loginStateChanges++;
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
    const generation = qrGeneration;
    const controller = new AbortController();
    qrRequestController = controller;
    const current = () => generation === qrGeneration && !controller.signal.aborted &&
      loginUid === 0 && !els.qrDialog.classList.contains('hidden');
    const opening = els.qrDialog.classList.contains('hidden');
    if (opening) qrDialogFocus = document.activeElement;
    els.qrDialog.classList.remove('hidden');
    if (opening) els.qrCloseButton.focus({ preventScroll: true });
    els.qrImage.removeAttribute('src');
    els.qrTip.textContent = '正在生成安全登录二维码…';

    try {
      const response = await fetch('/api/login/start', { signal: controller.signal });
      const result = await response.json();
      if (!current()) return;
      if (!result.ok) throw new Error(result.error || '生成二维码失败');
      if (typeof qrcode !== 'function') throw new Error('二维码组件未加载');

      const qr = qrcode(0, 'M');
      qr.addData(result.url);
      qr.make();
      els.qrImage.src = qr.createDataURL(6, 6);
      els.qrTip.textContent = '请使用 B 站 App 扫码并在手机上确认';

      const key = result.qrcodeKey;
      const expiresAt = Date.now() + 180000;
      async function poll() {
        qrPollTimer = null;
        if (!current()) return;
        if (Date.now() >= expiresAt) {
          stopQrPoll();
          els.qrTip.textContent = '二维码已过期，请刷新后重试';
          return;
        }
        try {
          const pollResponse = await fetch('/api/login/poll?key=' + encodeURIComponent(key), { signal: controller.signal });
          const pollResult = await pollResponse.json();
          if (!current()) return;
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
          if (current()) els.qrTip.textContent = '暂时无法查询状态，正在重试…';
        }
        // Schedule after the response, so slow requests cannot overlap and an
        // abandoned QR generation cannot leave background polling behind.
        if (current()) qrPollTimer = setTimeout(poll, 2000);
      }
      qrPollTimer = setTimeout(poll, 2000);
    } catch (e) {
      if (current()) els.qrTip.textContent = '二维码生成失败：' + String(e.message || e);
    }
  }

  async function initLoginStatus() {
    const loginSnapshot = loginStateChanges;
    try {
      const response = await fetch('/api/status');
      const result = await response.json();
      if (loginStateChanges !== loginSnapshot) return;
      if (!result.ok) throw new Error('status failed');
      renderLoginStatus(!!result.loggedIn, result.uname, result.uid);
    } catch (e) {
      if (loginStateChanges !== loginSnapshot) return;
      renderLoginStatus(false);
      els.loginDetail.textContent = '暂时无法读取登录状态，请稍后重试。';
    }
  }

  function bindEvents() {
    bindSheetKeyboard(els.themeDialog, closeThemeEditor);
    bindSheetKeyboard(els.qrDialog, closeQrDialog);
    els.stylePresetSelect.addEventListener('change', renderStylePresetControls);
    els.applyStylePresetButton.addEventListener('click', applySelectedStylePreset);
    els.saveStylePresetButton.addEventListener('click', () => openStylePresetDialog(false));
    els.manageStylePresetButton.addEventListener('click', () => stylePresetLoadFailed ? loadStylePresets() : openStylePresetDialog(true));
    els.confirmStylePresetButton.addEventListener('click', () => confirmStylePreset());
    els.overwriteStylePresetButton.addEventListener('click', () => confirmStylePreset(true));
    els.deleteStylePresetButton.addEventListener('click', deleteStylePreset);
    els.closeActionSelect.addEventListener('change', saveCloseAction);
    els.connectButton.addEventListener('click', toggleRoomConnection);
    els.roomInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.repeat) {
        event.preventDefault();
        toggleRoomConnection();
      }
    });
    els.roomInput.addEventListener('input', renderRoomControls);

    els.loginButton.addEventListener('click', startQrLogin);
    els.qrRefreshButton.addEventListener('click', startQrLogin);
    els.qrCloseButton.addEventListener('click', closeQrDialog);
    els.qrBackdrop.addEventListener('click', closeQrDialog);
    els.logoutButton.addEventListener('click', async () => {
      stopQrPoll();
      try {
        const response = await fetch('/api/login/logout');
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error('Logout was not saved');
        renderLoginStatus(false);
        await reconnectWithCurrentAccount();
      } catch (e) {
        els.loginDetail.textContent = '退出登录失败，已保留当前账号。请重试。';
      }
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

    els.themeListToggleButton.addEventListener('click', () => {
      themeListExpanded = !themeListExpanded;
      updateThemeListVisibility();
    });
    els.scNeverExpireInput.addEventListener('change', () => {
      if (themeScSaveTask) return;
      const theme = editingTheme;
      const previous = settings.themeConfigs[theme].scNeverExpire === true;
      settings.themeConfigs[theme].scNeverExpire = els.scNeverExpireInput.checked;
      themeScSaving = theme;
      themeScSaveError = '';
      if (saveTimer !== null) clearTimeout(saveTimer);
      saveTimer = null;
      if (previewFrame !== null) cancelAnimationFrame(previewFrame);
      previewFrame = null;
      themeScSaveTask = persistNow().then(() => {
        return true;
      }).catch(() => {
        settings.themeConfigs[theme].scNeverExpire = previous;
        themeScSaveError = theme;
        return false;
      }).finally(() => {
        themeScSaveTask = null;
        themeScSaving = '';
        updateThemeScControl();
      });
      updateThemeScControl();
    });

    els.themeScaleInput.addEventListener('input', () => updateThemeMetric('overallScale', els.themeScaleInput.value, true));
    els.messageGapInput.addEventListener('input', () => updateThemeMetric('messageGap', els.messageGapInput.value, true));
    els.horizontalPaddingInput.addEventListener('input', () => updateThemeMetric('horizontalPadding', els.horizontalPaddingInput.value, false));
    els.messageFontInput.addEventListener('input', () => updateThemeMetric('messageFont', els.messageFontInput.value, true));
    els.emoteScaleInput.addEventListener('input', () => updateThemeMetric('emoteScale', els.emoteScaleInput.value, false));
    els.nameFontInput.addEventListener('input', () => updateThemeMetric('nameFont', els.nameFontInput.value, true));
    els.metaFontInput.addEventListener('input', () => updateThemeMetric('metaFont', els.metaFontInput.value, true));
    els.timeFontInput.addEventListener('input', () => updateThemeMetric('timeFont', els.timeFontInput.value, true));
    els.themeOpacityInput.addEventListener('input', () => updateThemeMetric('surfaceOpacity', els.themeOpacityInput.value, false));
    els.shadowStrengthInput.addEventListener('input', () => {
      if (els.shadowStrengthInput.disabled) return;
      updateThemeMetric('shadowStrength', els.shadowStrengthInput.value, false);
    });
    els.portraitWidthInput.addEventListener('input', () => {
      if (editingTheme !== 'portrait' || els.portraitWidthInput.disabled) return;
      updateThemeMetric('portraitWidth', els.portraitWidthInput.value, false);
    });
    els.surfaceColorInput.addEventListener('input', () => {
      if (editingTheme !== 'glass') return;
      settings.themeConfigs.glass.surfaceColor = els.surfaceColorInput.value;
      scheduleSave();
    });
    els.fullCardsOnlyInput.addEventListener('change', () => {
      settings.themeConfigs[editingTheme].fullCardsOnly = els.fullCardsOnlyInput.checked;
      scheduleSave();
    });
    els.messageAlignInput.addEventListener('change', () => {
      settings.themeConfigs[editingTheme].messageAlign = els.messageAlignInput.value === 'top' ? 'top' : 'bottom';
      scheduleSave();
    });
    els.themeAvatarInput.addEventListener('change', () => {
      const enabled = els.themeAvatarInput.checked;
      settings.themeConfigs[editingTheme].showAvatar = enabled;
      resizeForAvatarToggle(editingTheme, enabled);
      scheduleSave();
    });
    els.themeWelcomeInput.addEventListener('change', () => {
      settings.themeConfigs[editingTheme].showWelcome = els.themeWelcomeInput.checked;
      updateThemeEditorValues();
      scheduleSave();
    });
    els.welcomeFontInput.addEventListener('input', () => {
      if (els.welcomeFontInput.disabled) return;
      updateThemeMetric('welcomeFont', els.welcomeFontInput.value, true);
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
      ['welcomeTextColorInput', 'welcomeTextColor'], ['welcomeNameColorInput', 'welcomeNameColor'],
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
      if (themeScSaveTask) return;
      themeScSaveError = '';
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
    els.previewToggleButton.addEventListener('click', togglePreview);
    els.overlaySizeLockedInput.addEventListener('change', () => {
      setOverlaySizeLocked(els.overlaySizeLockedInput.checked);
      scheduleSave();
    });
    const copyLabel = els.copyObsUrlButton.textContent;
    let copyFeedbackTimer = null;
    let copyRequest = 0;
    els.copyObsUrlButton.addEventListener('click', async () => {
      const request = ++copyRequest;
      if (copyFeedbackTimer !== null) clearTimeout(copyFeedbackTimer);
      copyFeedbackTimer = null;
      try {
        await window.DesktopOverlay.copyObsUrl();
        if (request !== copyRequest) return;
        els.copyObsUrlButton.textContent = '已复制';
      } catch (error) {
        if (request !== copyRequest) return;
        els.copyObsUrlButton.textContent = '复制失败';
      }
      copyFeedbackTimer = setTimeout(() => {
        copyFeedbackTimer = null;
        els.copyObsUrlButton.textContent = copyLabel;
      }, 1200);
    });
    els.clickThroughButton.addEventListener('click', async () => {
      if (clickThroughPending || previewToggleTask || !settings.previewEnabled || !overlayAvailable) return;
      clickThroughPending = true;
      renderPreviewControls();
      let failed = false;
      try {
        const state = await window.DesktopOverlay.getWindowState();
        const result = await window.DesktopOverlay.setClickThrough(!state.clickThrough);
        setClickThroughState(result.clickThrough);
      } catch (error) {
        failed = true;
      } finally {
        clickThroughPending = false;
        renderPreviewControls();
        if (failed) els.clickThroughButton.querySelector('small').textContent = '操作未完成，请再试一次';
      }
    });
    els.applyOverlaySizeButton.addEventListener('click', applyOverlaySize);
    els.overlayWidthInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') applyOverlaySize();
    });
    els.overlayHeightInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') applyOverlaySize();
    });
    window.DesktopOverlay.onClickThroughChanged(setClickThroughState);
    window.DesktopOverlay.onOverlayStatusChanged(setStatus);
    window.DesktopOverlay.onPlaybackChanged((state) => {
      playbackChangeCount++;
      setPlaybackState(state);
    });
    window.DesktopOverlay.onOverlayBoundsChanged(setOverlaySizeFields);
    window.DesktopOverlay.onPreviewEnabledChanged(setPreviewEnabled);
  }

  async function init() {
    [
      'minimizeButton', 'closeButton', 'appVersion', 'statusCard', 'statusText', 'playbackStatus', 'roomInput',
      'roomHint', 'connectButton',
      'alwaysOnTopInput', 'clickThroughButton', 'previewToggleButton',
      'scNeverExpireInput', 'scNeverExpireHint', 'emoteScaleInput', 'emoteScaleValue', 'themeGrid', 'themeListToggleButton', 'currentHiddenThemeHint',
      'previewToggleLabel', 'previewToggleHint', 'previewStateText', 'loginStatus', 'loginDetail',
      'loginButton', 'logoutButton', 'qrDialog', 'qrBackdrop', 'qrImage',
      'qrTip', 'qrCloseButton', 'qrRefreshButton', 'overlayWidthInput',
      'overlayHeightInput', 'applyOverlaySizeButton', 'themeDialog',
      'themeBackdrop', 'themeDialogTitle', 'themeCloseButton', 'themeScaleInput',
      'themeScaleValue', 'messageGapInput', 'messageGapValue', 'horizontalPaddingInput', 'horizontalPaddingValue', 'fontFamilyInput',
      'themeAvatarInput', 'fullCardsOnlyInput', 'messageAlignInput', 'themeWelcomeInput', 'welcomeFontInput', 'welcomeFontValue',
      'welcomeTextColorInput', 'welcomeNameColorInput',
      'messageFontInput', 'messageFontValue', 'nameFontInput',
      'nameFontValue', 'metaFontInput', 'metaFontValue', 'timeFontInput',
      'timeFontValue', 'themeOpacityInput', 'themeOpacityValue', 'glassSurfaceColorField', 'surfaceColorInput', 'bodyColorInput',
      'surfaceOpacityLabel', 'surfaceOpacityHint', 'shadowStrengthField', 'shadowStrengthInput', 'shadowStrengthValue',
      'portraitWidthField', 'portraitWidthInput', 'portraitWidthValue',
      'giftColorInput', 'timeColorInput', 'viewerColorInput', 'hostColorInput', 'managerColorInput',
      'governorColorInput', 'admiralColorInput', 'captainColorInput',
      'resetThemeButton', 'saveThemeButton', 'obsUrlInput', 'copyObsUrlButton',
      'obsMirrorSizeText', 'overlaySizeLockedInput', 'closeActionSelect',
      'stylePresetSelect', 'applyStylePresetButton', 'saveStylePresetButton', 'manageStylePresetButton', 'stylePresetHint',
      'stylePresetDialog', 'stylePresetDialogTitle', 'stylePresetDialogCloseButton', 'stylePresetNameInput', 'stylePresetSummary',
      'confirmStylePresetButton', 'overwriteStylePresetButton', 'deleteStylePresetButton'
    ].forEach((id) => {
      els[id] = byId(id);
    });

    const stored = await window.DesktopOverlay.loadSettings();
    settings = Object.assign(settings, stored || {});
    delete settings.opacity;
    delete settings.obsWidth;
    delete settings.obsHeight;
    delete settings.closeAction;
    settings = themeRegistry.migrateSettings(settings);
    els.roomInput.value = settings.roomId || '';
    els.roomHint.textContent = settings.roomId ? 'ROOM ' + settings.roomId + ' · 已保存' : '连接后自动保存';
    els.alwaysOnTopInput.checked = settings.alwaysOnTop !== false;
    setOverlaySizeLocked(settings.overlaySizeLocked === true);
    setPreviewEnabled(settings.previewEnabled !== false);
    updateThemeButtons();
    settingsReady = true;
    bindEvents();

    const closeActionSnapshot = closeActionChangeCount;
    const playbackSnapshot = playbackChangeCount;
    const connectionSnapshot = connectionStatusChanges;
    const previewSnapshot = previewChangeCount;
    const boundsSnapshot = boundsChangeCount;
    const clickThroughSnapshot = clickThroughChangeCount;
    const state = await window.DesktopOverlay.getWindowState();
    window.ControlAppearance.initialize(state.controlAppearance);
    if (closeActionChangeCount === closeActionSnapshot) setCloseActionState(state.closeAction);
    if (playbackChangeCount === playbackSnapshot) setPlaybackState(state.playback);
    els.closeActionSelect.disabled = !!closeActionSaveTask;
    const appVersion = String(state.appVersion || '').trim();
    els.appVersion.textContent = appVersion ? 'v' + appVersion : '';
    els.appVersion.classList.toggle('hidden', !appVersion);
    els.appVersion.setAttribute('aria-label', '当前运行版本 ' + appVersion);
    els.obsUrlInput.value = state.obsUrl || '';
    if (previewChangeCount === previewSnapshot) {
      if (connectionStatusChanges === connectionSnapshot) overlayAvailable = !!state.overlayAvailable;
      setPreviewEnabled(state.previewEnabled);
    }
    if (boundsChangeCount === boundsSnapshot) setOverlaySizeFields(state.overlayViewport || state.overlayBounds);
    if (clickThroughChangeCount === clickThroughSnapshot) setClickThroughState(state.clickThrough);
    if (connectionStatusChanges === connectionSnapshot) setStatus(state.overlayStatus || 'disconnected');
    scheduleSave();
    loadStylePresets();
    await initLoginStatus();
  }

  bindProgramSettings();
  bindStylePresetDialog();
  bindControlCloseDialog();
  window.DesktopOverlay.onPrepareControlClose(prepareControlClose);
  window.addEventListener('beforeunload', stopQrPoll);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
