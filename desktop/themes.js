(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DanmuThemes = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ids = Object.freeze(['glass', 'portrait', 'mecha', 'comic', 'manga', 'win95', 'el', 'tui', 'outline']);
  const names = Object.freeze({
    glass: '轻雾玻璃', portrait: '映像柔焦', mecha: '机甲装甲', comic: '彩色漫画', manga: '黑白手绘', win95: 'Windows 95',
    el: '琥珀 EL', tui: 'OpenCode TUI', outline: '轻线描边'
  });
  const avatarWidthCosts = Object.freeze({ glass: 65, portrait: 65, mecha: 65, comic: 65, manga: 65, win95: 65, el: 65, tui: 64, outline: 65 });
  const aliases = Object.freeze({ pixel: 'el', risograph: 'glass', mono: 'glass', paper: 'glass' });
  const configVersion = 3;
  const outlineStyleVersion = 1;
  const oldOutlineDefaults = Object.freeze({
    bodyColor: '#f4f7fa', giftColor: '#c5d9e6', timeColor: '#95a5b3',
    viewerColor: '#e9f0f5', hostColor: '#dec1cd', managerColor: '#a9ccdf', governorColor: '#e0bbb4',
    admiralColor: '#c4b8d7', captainColor: '#b3d1db', welcomeTextColor: '#95a5b3', welcomeNameColor: '#f4f7fa',
    fontFamily: 'Microsoft YaHei UI'
  });
  const numberLimits = {
    overallScale: [60, 140], messageGap: [0, 20], horizontalPadding: [0, 64],
    messageFont: [16, 48], nameFont: [10, 30], metaFont: [8, 24], timeFont: [9, 22],
    surfaceOpacity: [0, 100], welcomeFont: [12, 48], welcomeDuration: [1, 30], emoteScale: [50, 200], baseWidth: [240, 7680], baseHeight: [160, 4320]
  };
  const colorKeys = [
    'bodyColor', 'giftColor', 'timeColor', 'viewerColor', 'hostColor', 'managerColor',
    'governorColor', 'admiralColor', 'captainColor', 'welcomeTextColor', 'welcomeNameColor'
  ];
  const extraColorKeys = Object.freeze({
    glass: Object.freeze(['medalColor']),
    tui: Object.freeze(['medalColor', 'thoughtColor', 'giftValueColor', 'giftMarkerColor'])
  });
  const common = {
    overallScale: 100, horizontalPadding: 8, showWelcome: true, welcomeFont: 18, baseWidth: 515, baseHeight: 650,
    scNeverExpire: false, emoteScale: 100, fullCardsOnly: true, messageAlign: 'bottom', welcomeMode: 'scroll', welcomeDuration: 3
  };
  const defaults = {
    glass: {
      ...common, messageGap: 10, messageFont: 26, nameFont: 16, metaFont: 13, timeFont: 12,
      fontFamily: 'Microsoft YaHei UI', bodyColor: '#fcfcfd', giftColor: '#e4a5b0', timeColor: '#c9d0d8',
      viewerColor: '#e7e9ed', hostColor: '#e99aa9', managerColor: '#72bfe7', governorColor: '#ef817c',
      admiralColor: '#c59ad8', captainColor: '#80cbe5', surfaceOpacity: 28, surfaceColor: '#000000',
      showAvatar: true, welcomeTextColor: '#c9d0d8', welcomeNameColor: '#fcfcfd', shadowStrength: 60,
      medalColor: '#eceff4'
    },
    el: {
      ...common, messageGap: 6, messageFont: 26, nameFont: 16, metaFont: 12, timeFont: 12,
      fontFamily: 'Cascadia Mono', bodyColor: '#ffd479', giftColor: '#ffe2a8', timeColor: '#b78e45',
      viewerColor: '#ecc26c', hostColor: '#ffd479', managerColor: '#ffd479', governorColor: '#ffd479',
      admiralColor: '#ffd479', captainColor: '#ffd479', surfaceOpacity: 100, showAvatar: false,
      welcomeTextColor: '#b78e45', welcomeNameColor: '#ffd479'
    },
    tui: {
      ...common, messageGap: 2, messageFont: 20, nameFont: 14, metaFont: 12, timeFont: 13,
      fontFamily: 'JetBrains Maple Mono', bodyColor: '#f3f1ee', giftColor: '#ee9ba2', timeColor: '#a8a5a3',
      viewerColor: '#f3f1ee', hostColor: '#ee8d96', managerColor: '#4fa8f5', governorColor: '#ef766f',
      admiralColor: '#c98bd2', captainColor: '#58b9e6', surfaceOpacity: 70, showAvatar: false,
      welcomeTextColor: '#a8a5a3', welcomeNameColor: '#f3f1ee',
      medalColor: '#eceff4', thoughtColor: '#f1a431', giftValueColor: '#a8a5a3', giftMarkerColor: '#4fa8f5'
    },
    outline: {
      ...common, messageGap: 8, messageFont: 26, nameFont: 16, metaFont: 12, timeFont: 12,
      fontFamily: 'YouYuan', bodyColor: '#ffffff', giftColor: '#ffffff', timeColor: '#ffffff',
      viewerColor: '#ffffff', hostColor: '#ffffff', managerColor: '#ffffff', governorColor: '#ffffff',
      admiralColor: '#ffffff', captainColor: '#ffffff', surfaceOpacity: 18, showAvatar: true,
      welcomeTextColor: '#ffffff', welcomeNameColor: '#ffffff', shadowStrength: 70, outlineStyleVersion
    },
    mecha: {
      ...common, messageGap: 10, messageFont: 26, nameFont: 16, metaFont: 12, timeFont: 11,
      fontFamily: 'Microsoft YaHei UI', bodyColor: '#f5f7fa', giftColor: '#fbbf24', timeColor: '#bbc6d4',
      viewerColor: '#dbe4ef', hostColor: '#fbbf24', managerColor: '#7fd4ff', governorColor: '#ff8686',
      admiralColor: '#c7b3ff', captainColor: '#98d6ed', surfaceOpacity: 100, showAvatar: true,
      welcomeTextColor: '#bbc6d4', welcomeNameColor: '#f5f7fa'
    },
    comic: {
      ...common, messageGap: 12, messageFont: 26, nameFont: 16, metaFont: 12, timeFont: 11,
      fontFamily: 'Microsoft YaHei UI', bodyColor: '#171717', giftColor: '#171717', timeColor: '#5b5b5b',
      viewerColor: '#ffffff', hostColor: '#ffffff', managerColor: '#ffffff', governorColor: '#ffffff',
      admiralColor: '#ffffff', captainColor: '#ffffff', surfaceOpacity: 100, showAvatar: true,
      welcomeTextColor: '#373737', welcomeNameColor: '#1b55c9'
    },
    manga: {
      ...common, messageGap: 12, messageFont: 26, nameFont: 16, metaFont: 12, timeFont: 11,
      fontFamily: 'ZCOOL KuaiLe', bodyColor: '#161616', giftColor: '#161616', timeColor: '#6b6b6b',
      viewerColor: '#292929', hostColor: '#111111', managerColor: '#424242', governorColor: '#111111',
      admiralColor: '#333333', captainColor: '#555555', surfaceOpacity: 100, showAvatar: false,
      welcomeTextColor: '#555555', welcomeNameColor: '#161616'
    },
    win95: {
      ...common, messageGap: 12, messageFont: 26, nameFont: 16, metaFont: 12, timeFont: 11,
      fontFamily: 'Microsoft YaHei UI', bodyColor: '#000000', giftColor: '#000000', timeColor: '#555555',
      viewerColor: '#ffffff', hostColor: '#ffffff', managerColor: '#ffffff', governorColor: '#ffffff',
      admiralColor: '#ffffff', captainColor: '#ffffff', surfaceOpacity: 100, showAvatar: true,
      welcomeTextColor: '#000000', welcomeNameColor: '#000000'
    },
    portrait: {
      ...common, messageGap: 12, messageFont: 26, nameFont: 16, metaFont: 13, timeFont: 11,
      fontFamily: 'Microsoft YaHei UI', bodyColor: '#ffffff', giftColor: '#fff5de', timeColor: '#d5dce2',
      viewerColor: '#f4f6f8', hostColor: '#e99aa9', managerColor: '#72bfe7', governorColor: '#ef817c',
      admiralColor: '#c59ad8', captainColor: '#80cbe5', surfaceOpacity: 92, showAvatar: false,
      welcomeTextColor: '#d5dce2', welcomeNameColor: '#ffffff', portraitWidth: 48
    }
  };
  ids.forEach((id) => Object.freeze(defaults[id]));
  Object.freeze(defaults);

  function record(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function own(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
  }

  function isKnownTheme(id) {
    return typeof id === 'string' && (ids.includes(id) || own(aliases, id));
  }

  function resolveTheme(id) {
    if (typeof id !== 'string') return 'glass';
    return ids.includes(id) ? id : own(aliases, id) ? aliases[id] : 'glass';
  }

  function numberValue(value, range, fallback, strict, name) {
    const validType = typeof value === 'number' || typeof value === 'string';
    const number = validType && String(value).trim() !== '' && String(value).length <= 32 ? Number(value) : NaN;
    if (!Number.isFinite(number)) {
      if (strict) throw new Error('预设中的' + name + '无效。');
      return fallback;
    }
    return Math.max(range[0], Math.min(range[1], number));
  }

  function colorValue(value, fallback, strict, label) {
    if (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
    if (strict) throw new Error('预设' + (label || '颜色') + '无效。');
    return fallback;
  }

  function normalizeConfig(theme, source, options) {
    const strict = !!(options && options.strict);
    if (strict && !isKnownTheme(theme)) throw new Error('预设皮肤无效。');
    const id = resolveTheme(theme);
    const fallback = defaults[id];
    // Retired themes intentionally start with their replacement design. Do not
    // carry bitmap sizing, calligraphy, or old palette into the new renderer.
    if (typeof theme === 'string' && own(aliases, theme)) return { ...fallback };
    if (strict && !record(source)) throw new Error('预设样式无效。');
    const given = record(source) ? source : {};
    const savedOutlineVersion = (typeof given.outlineStyleVersion === 'number' || typeof given.outlineStyleVersion === 'string')
      && Number.isSafeInteger(Number(given.outlineStyleVersion)) && Number(given.outlineStyleVersion) >= outlineStyleVersion
      ? Number(given.outlineStyleVersion) : 0;
    const migrateOutline = id === 'outline' && savedOutlineVersion < outlineStyleVersion;
    const config = {};
    Object.entries(numberLimits).forEach(([key, range]) => {
      // Presets saved before welcome messages had an independent font size
      // remain valid; an explicitly invalid value still fails strict validation.
      const value = (key === 'welcomeFont' || key === 'welcomeDuration' || key === 'emoteScale') && given[key] === undefined ? fallback[key] : given[key];
      config[key] = numberValue(value, range, fallback[key], strict, key);
      if (key === 'emoteScale' && strict && Number(value) !== config[key]) throw new Error('预设中的表情大小须为 50–200。');
    });
    colorKeys.forEach((key) => {
      let value = given[key];
      if (value === undefined && key === 'welcomeTextColor') {
        value = given.timeColor === undefined ? fallback.welcomeTextColor : given.timeColor;
      }
      if (value === undefined && key === 'welcomeNameColor') {
        const inherited = given.bodyColor;
        value = inherited === undefined ? fallback.welcomeNameColor : inherited;
      }
      config[key] = colorValue(value, fallback[key], strict);
      if (migrateOutline && config[key] === oldOutlineDefaults[key]) config[key] = fallback[key];
    });
    if (id === 'glass' || id === 'outline') {
      const strength = given.shadowStrength === undefined ? fallback.shadowStrength : given.shadowStrength;
      config.shadowStrength = numberValue(strength, [0, 100], fallback.shadowStrength, strict, '阴影强度');
      if (strict && Number(strength) !== config.shadowStrength) throw new Error('预设中的阴影强度须为 0–100。');
    }
    if (id === 'outline') config.outlineStyleVersion = Math.max(outlineStyleVersion, savedOutlineVersion);
    if (id === 'portrait') {
      const width = given.portraitWidth === undefined ? fallback.portraitWidth : given.portraitWidth;
      config.portraitWidth = numberValue(width, [30, 70], fallback.portraitWidth, strict, '头像占比');
      if (strict && Number(width) !== config.portraitWidth) throw new Error('预设中的头像占比须为 30–70。');
    }
    if (id === 'glass') {
      config.surfaceColor = colorValue(given.surfaceColor === undefined ? fallback.surfaceColor : given.surfaceColor,
        fallback.surfaceColor, strict, '承载面颜色');
    }
    (extraColorKeys[id] || []).forEach(key => {
      config[key] = colorValue(given[key] === undefined ? fallback[key] : given[key], fallback[key], strict, key);
    });
    ['showAvatar', 'showWelcome'].forEach((key) => {
      if (typeof given[key] === 'boolean') config[key] = given[key];
      else if (strict) throw new Error('预设显示选项无效。');
      else config[key] = fallback[key];
    });
    if (given.scNeverExpire === undefined) config.scNeverExpire = false;
    else if (typeof given.scNeverExpire === 'boolean') config.scNeverExpire = given.scNeverExpire;
    else if (strict) throw new Error('预设 SC 自动消失选项无效。');
    else config.scNeverExpire = false;
    if (given.fullCardsOnly === undefined) config.fullCardsOnly = true;
    else if (typeof given.fullCardsOnly === 'boolean') config.fullCardsOnly = given.fullCardsOnly;
    else if (strict) throw new Error('预设完整卡片显示选项无效。');
    else config.fullCardsOnly = true;
    if (given.messageAlign === undefined) config.messageAlign = 'bottom';
    else if (given.messageAlign === 'top' || given.messageAlign === 'bottom') config.messageAlign = given.messageAlign;
    else if (strict) throw new Error('预设弹幕对齐方式无效。');
    else config.messageAlign = 'bottom';
    if (given.welcomeMode === undefined) config.welcomeMode = 'scroll';
    else if (given.welcomeMode === 'single' || given.welcomeMode === 'scroll') config.welcomeMode = given.welcomeMode;
    else if (strict) throw new Error('预设欢迎显示方式无效。');
    else config.welcomeMode = 'scroll';
    const font = given.fontFamily;
    if (typeof font === 'string' && font.trim() && font.length <= 120 && !/[\u0000-\u001f\u007f]/.test(font)) {
      // Older presets may explicitly reference the removed bundled glyph set.
      config.fontFamily = /(?:Unifont|Fusion[\s-]*Pixel|单色点阵)/i.test(font) ? fallback.fontFamily : font.trim();
    } else if (strict) {
      throw new Error('预设字体无效。');
    } else {
      config.fontFamily = fallback.fontFamily;
    }
    if (migrateOutline && config.fontFamily.toLowerCase() === oldOutlineDefaults.fontFamily.toLowerCase()) {
      config.fontFamily = fallback.fontFamily;
    }
    return config;
  }

  function normalizeConfigs(source) {
    const given = record(source) ? source : {};
    const result = {};
    // Canonical configurations win when both a legacy and new ID are present.
    // Legacy keys are discarded rather than merged into the replacement.
    ids.forEach((id) => { result[id] = normalizeConfig(id, own(given, id) ? given[id] : undefined); });
    return result;
  }

  function migrateSettings(settings) {
    const source = record(settings) ? settings : {};
    const themeConfigs = normalizeConfigs(source.themeConfigs);
    if (source.scNeverExpire === true) {
      const previous = record(source.themeConfigs) ? source.themeConfigs : {};
      ids.forEach((id) => {
        if (!record(previous[id]) || previous[id].scNeverExpire === undefined) themeConfigs[id].scNeverExpire = true;
      });
    }
    const result = {
      ...source,
      theme: resolveTheme(source.theme),
      themeConfigVersion: configVersion,
      themeConfigs
    };
    delete result.scNeverExpire;
    return result;
  }

  function normalizePresetThemeConfig(theme, config) {
    if (!isKnownTheme(theme)) throw new Error('预设皮肤无效。');
    return { theme: resolveTheme(theme), config: normalizeConfig(theme, config, { strict: true }) };
  }

  return Object.freeze({
    ids, names, defaults, avatarWidthCosts, configVersion, extraColorKeys,
    resolveTheme, isKnownTheme, normalizeConfig, normalizeConfigs, migrateSettings, normalizePresetThemeConfig
  });
});
