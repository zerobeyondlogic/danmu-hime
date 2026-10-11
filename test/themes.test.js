'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const themes = require('../desktop/themes.js');
const { normalizeStylePresets } = require('../desktop/style-presets.js');

const plain = (value) => JSON.parse(JSON.stringify(value));
const legacyOutlinePalette = {
  bodyColor: '#f4f7fa', giftColor: '#c5d9e6', timeColor: '#95a5b3', viewerColor: '#e9f0f5',
  hostColor: '#dec1cd', managerColor: '#a9ccdf', governorColor: '#e0bbb4', admiralColor: '#c4b8d7',
  captainColor: '#b3d1db', welcomeTextColor: '#95a5b3', welcomeNameColor: '#f4f7fa'
};
function legacyOutlineConfig(overrides = {}) {
  const config = { ...themes.defaults.outline, ...legacyOutlinePalette, fontFamily: 'Microsoft YaHei UI', ...overrides };
  delete config.outlineStyleVersion;
  delete config.shadowStrength;
  delete config.scNeverExpire;
  return config;
}
let passed = 0;
function test(name, run) {
  run();
  passed += 1;
  console.log('PASS ' + name);
}

test('the registry exposes nine themes with portrait second and no retired rendering engines', () => {
  assert.deepStrictEqual(themes.ids, ['glass', 'portrait', 'mecha', 'comic', 'manga', 'win95', 'el', 'tui', 'outline']);
  assert.strictEqual(themes.configVersion, 3);
  for (const id of themes.ids) {
    assert.ok(themes.names[id]);
    assert.ok(themes.avatarWidthCosts[id] > 0);
    assert.ok(Object.isFrozen(themes.defaults[id]));
    assert.ok(!Object.hasOwn(themes.defaults[id], 'bitmapEngineVersion'));
    assert.ok(!Object.hasOwn(themes.defaults[id], 'pixelFontVersion'));
    assert.ok(!/Unifont|KaiTi/i.test(themes.defaults[id].fontFamily));
  }
  assert.strictEqual(themes.resolveTheme('pixel'), 'el');
  assert.strictEqual(themes.resolveTheme('risograph'), 'glass');
  assert.strictEqual(themes.resolveTheme('mono'), 'glass');
  assert.strictEqual(themes.resolveTheme('paper'), 'glass');
  assert.notStrictEqual(themes.resolveTheme('mono'), 'manga');
  assert.strictEqual(Object.hasOwn(themes.defaults, 'mono'), false);
  assert.strictEqual(Object.hasOwn(themes.defaults, 'paper'), false);
  assert.strictEqual(themes.resolveTheme('unknown'), 'glass');
  assert.strictEqual(themes.isKnownTheme('pixel'), true);
  assert.strictEqual(themes.isKnownTheme('__proto__'), false);
});

test('browser and Node consume the same registry with no network or platform dependencies', () => {
  const source = fs.readFileSync(path.join(__dirname, '../desktop/themes.js'), 'utf8');
  const browser = {};
  vm.runInNewContext(source, browser, { filename: 'themes.js' });
  assert.ok(browser.DanmuThemes);
  assert.deepStrictEqual(plain(browser.DanmuThemes.defaults), plain(themes.defaults));
  const input = { theme: 'pixel', themeConfigs: { glass: { messageFont: 31 } } };
  assert.deepStrictEqual(plain(browser.DanmuThemes.migrateSettings(input)), plain(themes.migrateSettings(input)));
});

test('legacy selected themes become their replacements without reusing obsolete visual settings', () => {
  for (const [oldId, nextId] of [['pixel', 'el'], ['risograph', 'glass'], ['mono', 'glass'], ['paper', 'glass']]) {
    const original = {
      theme: oldId, themeConfigVersion: 3,
      themeConfigs: { [oldId]: { messageFont: 48, fontFamily: 'GNU Unifont 16 Bitmap', bodyColor: '#ff00ff', bitmapEngineVersion: 3 } },
      roomId: '123456', previewEnabled: false, overlaySizeLocked: true,
      alwaysOnTop: false, previewCanvasWidth: 840, previewCanvasHeight: 980,
      login: { uid: 100, localToken: 'synthetic-test-value' }
    };
    const before = plain(original);
    const migrated = themes.migrateSettings(original);
    assert.strictEqual(migrated.theme, nextId);
    assert.deepStrictEqual(migrated.themeConfigs[nextId], plain(themes.defaults[nextId]));
    assert.strictEqual(Object.hasOwn(migrated.themeConfigs, oldId), false);
    for (const key of ['roomId', 'previewEnabled', 'overlaySizeLocked', 'alwaysOnTop', 'previewCanvasWidth', 'previewCanvasHeight', 'login']) {
      assert.deepStrictEqual(migrated[key], before[key]);
    }
    assert.deepStrictEqual(original, before);
  }
});

test('glass and TUI customizations survive all old version numbers instead of resetting wholesale', () => {
  for (const version of [undefined, 1, 2, 3, 99]) {
    const source = {
      theme: 'glass', themeConfigVersion: version,
      themeConfigs: {
        glass: { messageFont: 29, bodyColor: '#123456', surfaceColor: '#abcdef', showWelcome: false, welcomeGap: 16 },
        tui: { messageFont: 24, fontFamily: 'Consolas', welcomeNameColor: '#fedcba', showAvatar: true }
      }
    };
    const migrated = themes.migrateSettings(source);
    assert.strictEqual(migrated.themeConfigs.glass.messageFont, 29);
    assert.strictEqual(migrated.themeConfigs.glass.bodyColor, '#123456');
    assert.strictEqual(migrated.themeConfigs.glass.surfaceColor, '#abcdef');
    assert.strictEqual(migrated.themeConfigs.glass.showWelcome, false);
    assert.strictEqual(migrated.themeConfigs.glass.welcomeFont, 18);
    assert.strictEqual(Object.hasOwn(migrated.themeConfigs.glass, 'welcomeGap'), false);
    assert.strictEqual(migrated.themeConfigs.tui.messageFont, 24);
    assert.strictEqual(migrated.themeConfigs.tui.fontFamily, 'Consolas');
    assert.strictEqual(migrated.themeConfigs.tui.welcomeNameColor, '#fedcba');
    assert.strictEqual(migrated.themeConfigs.tui.showAvatar, true);
    assert.strictEqual(migrated.themeConfigVersion, 3);
  }
});

test('outline old default colors and font migrate once to white and YouYuan without other layout resets', () => {
  const previous = legacyOutlineConfig({ messageFont: 33, nameFont: 19, welcomeFont: 24,
    horizontalPadding: 17, baseWidth: 671, baseHeight: 812, showAvatar: false, surfaceOpacity: 0 });
  const source = { theme: 'outline', scNeverExpire: true, roomId: '123', themeConfigs: { outline: previous } };
  const before = plain(source);
  const settings = themes.migrateSettings(source);
  const actual = settings.themeConfigs.outline;
  for (const key of Object.keys(legacyOutlinePalette)) assert.strictEqual(actual[key], '#ffffff', key);
  assert.strictEqual(actual.fontFamily, 'YouYuan');
  assert.strictEqual(actual.outlineStyleVersion, 1);
  assert.strictEqual(actual.shadowStrength, 70);
  for (const key of ['messageFont', 'nameFont', 'welcomeFont', 'horizontalPadding', 'baseWidth', 'baseHeight', 'showAvatar', 'surfaceOpacity']) {
    assert.strictEqual(actual[key], previous[key], key);
  }
  assert.strictEqual(settings.themeConfigs.outline.scNeverExpire, true);
  assert.strictEqual(Object.hasOwn(settings, 'scNeverExpire'), false);
  assert.strictEqual(settings.roomId, '123');
  assert.deepStrictEqual(themes.migrateSettings(settings), settings);
  assert.deepStrictEqual(source, before);
});

test('outline migration matches only each field own legacy default and keeps custom fonts and colors', () => {
  const previous = legacyOutlineConfig({ bodyColor: '#95a5b3', giftColor: '#abcdef', managerColor: '#A9CCDF',
    welcomeNameColor: '#121212', fontFamily: 'Consolas', messageFont: 30 });
  const actual = themes.normalizeConfig('outline', previous);
  assert.strictEqual(actual.bodyColor, '#95a5b3', 'matching a different field old palette is a custom color');
  assert.strictEqual(actual.giftColor, '#abcdef');
  assert.strictEqual(actual.managerColor, '#ffffff');
  assert.strictEqual(actual.welcomeNameColor, '#121212');
  assert.strictEqual(actual.fontFamily, 'Consolas');
  assert.strictEqual(actual.messageFont, 30);
  const glass = { ...themes.defaults.glass, bodyColor: '#f4f7fa', fontFamily: 'Microsoft YaHei UI', shadowStrength: 0 };
  assert.deepStrictEqual(themes.normalizeConfig('glass', glass), glass);
});

test('versioned outline settings can deliberately reuse any old palette color or old system font', () => {
  for (const outlineStyleVersion of [1, 2]) {
    const custom = { ...themes.defaults.outline, ...legacyOutlinePalette, fontFamily: 'Microsoft YaHei UI',
      shadowStrength: 0, outlineStyleVersion };
    const settings = themes.migrateSettings({ theme: 'outline', themeConfigs: { outline: custom } });
    assert.deepStrictEqual(settings.themeConfigs.outline, custom);
    assert.deepStrictEqual(themes.migrateSettings(settings), settings);
    assert.deepStrictEqual(themes.normalizePresetThemeConfig('outline', custom).config, custom);
  }
});

test('shadow strength is independent and bounded only for glass and outline with explicit zero retained', () => {
  for (const [theme, initial] of [['glass', 60], ['outline', 70]]) {
    const previous = { ...themes.defaults[theme] };
    delete previous.shadowStrength;
    assert.strictEqual(themes.normalizeConfig(theme, previous).shadowStrength, initial);
    assert.strictEqual(themes.normalizePresetThemeConfig(theme, previous).config.shadowStrength, initial);
    for (const strength of [0, 45, 100, '0', '100']) {
      const normalized = themes.normalizePresetThemeConfig(theme, { ...previous, shadowStrength: strength }).config;
      assert.strictEqual(normalized.shadowStrength, Number(strength));
    }
    assert.strictEqual(themes.normalizeConfig(theme, { ...previous, shadowStrength: -1 }).shadowStrength, 0);
    assert.strictEqual(themes.normalizeConfig(theme, { ...previous, shadowStrength: 101 }).shadowStrength, 100);
    for (const strength of [-1, 101, NaN, Infinity, null, true, '', 'invalid', {}]) {
      assert.throws(() => themes.normalizePresetThemeConfig(theme, { ...previous, shadowStrength: strength }), /阴影/);
    }
  }
  const settings = themes.migrateSettings({ themeConfigs: { glass: { shadowStrength: 0 }, outline: { shadowStrength: 100 } } });
  assert.strictEqual(settings.themeConfigs.glass.shadowStrength, 0);
  assert.strictEqual(settings.themeConfigs.outline.shadowStrength, 100);
  for (const theme of themes.ids.filter(id => id !== 'glass' && id !== 'outline')) {
    const config = themes.normalizePresetThemeConfig(theme, { ...themes.defaults[theme], shadowStrength: 'ignored', outlineStyleVersion: 1 }).config;
    assert.strictEqual(Object.hasOwn(config, 'shadowStrength'), false);
    assert.strictEqual(Object.hasOwn(config, 'outlineStyleVersion'), false);
  }
});

test('portrait width defaults to 48 and remains bounded only for the portrait skin', () => {
  assert.strictEqual(themes.defaults.portrait.portraitWidth, 48);
  const previous = { ...themes.defaults.portrait, messageFont: 31, scNeverExpire: true, fullCardsOnly: false, emoteScale: 75 };
  delete previous.portraitWidth;
  const oldSettings = { theme: 'portrait', themeConfigs: { portrait: previous } };
  const before = plain(oldSettings);
  const migrated = themes.migrateSettings(oldSettings);
  assert.deepStrictEqual(migrated.themeConfigs.portrait, { ...previous, portraitWidth: 48 });
  assert.deepStrictEqual(themes.migrateSettings(migrated), migrated);
  assert.deepStrictEqual(oldSettings, before);
  assert.strictEqual(themes.normalizePresetThemeConfig('portrait', previous).config.portraitWidth, 48);
  for (const portraitWidth of [30, 48, 64, 70, '64']) {
    assert.strictEqual(themes.normalizePresetThemeConfig('portrait', { ...previous, portraitWidth }).config.portraitWidth, Number(portraitWidth));
  }
  for (const portraitWidth of [0, 29, 71, null, true, '', 'bad', Infinity, {}]) {
    assert.throws(() => themes.normalizePresetThemeConfig('portrait', { ...previous, portraitWidth }), /头像占比/);
  }
  assert.strictEqual(themes.normalizeConfig('portrait', { portraitWidth: 0 }).portraitWidth, 30);
  assert.strictEqual(themes.normalizeConfig('portrait', { portraitWidth: 99 }).portraitWidth, 70);
  for (const id of themes.ids.filter(id => id !== 'portrait')) {
    assert.strictEqual(Object.hasOwn(themes.defaults[id], 'portraitWidth'), false);
    assert.strictEqual(Object.hasOwn(themes.normalizePresetThemeConfig(id, { ...themes.defaults[id], portraitWidth: 'ignored' }).config, 'portraitWidth'), false);
  }
});

test('new theme customizations win over obsolete entries and migration is idempotent', () => {
  const migrated = themes.migrateSettings({
    theme: 'pixel',
    themeConfigs: {
      pixel: { bodyColor: '#ff0000' }, el: { messageFont: 27, bodyColor: '#123456' },
      risograph: { bodyColor: '#00ff00' }, mono: { bodyColor: '#ffffff' },
      glass: { nameFont: 19, welcomeNameColor: '#abcdef' }
    }
  });
  assert.strictEqual(migrated.themeConfigs.el.messageFont, 27);
  assert.strictEqual(migrated.themeConfigs.el.bodyColor, '#123456');
  assert.strictEqual(migrated.themeConfigs.glass.nameFont, 19);
  assert.strictEqual(migrated.themeConfigs.glass.welcomeNameColor, '#abcdef');
  assert.deepStrictEqual(themes.migrateSettings(migrated), migrated);
  assert.deepStrictEqual(Object.keys(migrated.themeConfigs), themes.ids);
});

test('adding four styles keeps all retained skin configurations and selections intact', () => {
  const oldIds = ['glass', 'portrait', 'el', 'tui', 'outline'];
  const existing = Object.fromEntries(oldIds.map((id, index) => [id, {
    ...themes.defaults[id], messageFont: 25 + index, welcomeFont: 20 + index,
    horizontalPadding: index * 2, bodyColor: '#123456', showAvatar: index % 2 === 0
  }]));
  const before = plain(existing);
  for (const theme of oldIds) {
    const migrated = themes.migrateSettings({ theme, themeConfigVersion: 3, themeConfigs: existing });
    assert.strictEqual(migrated.theme, theme);
    for (const id of oldIds) assert.deepStrictEqual(migrated.themeConfigs[id], before[id]);
    for (const id of ['mecha', 'comic', 'manga', 'win95']) {
      assert.deepStrictEqual(migrated.themeConfigs[id], plain(themes.defaults[id]));
    }
  }
  assert.deepStrictEqual(existing, before);
  const selected = themes.migrateSettings({ theme: 'portrait', themeConfigs: {
    portrait: { ...themes.defaults.portrait, surfaceOpacity: 0, showAvatar: true, welcomeFont: 29 }
  } });
  assert.strictEqual(selected.theme, 'portrait');
  assert.strictEqual(selected.themeConfigs.portrait.surfaceOpacity, 0);
  assert.strictEqual(selected.themeConfigs.portrait.showAvatar, true);
  assert.strictEqual(selected.themeConfigs.portrait.welcomeFont, 29);
});

test('removing monochrome retains customized glass and saved preset identity across reload', () => {
  const settings = themes.migrateSettings({
    theme: 'mono', previewEnabled: false,
    themeConfigs: { mono: { messageFont: 47, bodyColor: '#ffffff' },
      glass: { ...themes.defaults.glass, surfaceColor: '#123456', messageFont: 32 },
      portrait: { ...themes.defaults.portrait, messageFont: 29 } }
  });
  assert.strictEqual(settings.theme, 'glass');
  assert.strictEqual(settings.previewEnabled, false);
  assert.strictEqual(settings.themeConfigs.glass.surfaceColor, '#123456');
  assert.strictEqual(settings.themeConfigs.glass.messageFont, 32);
  assert.strictEqual(settings.themeConfigs.portrait.messageFont, 29);
  assert.strictEqual(Object.hasOwn(settings.themeConfigs, 'mono'), false);
  const original = { id: 'saved-mono', name: '我的旧预设', theme: 'mono', width: 900, height: 720,
    config: { ...themes.defaults.glass, messageFont: 47, bodyColor: '#ffffff' } };
  const [preset] = normalizeStylePresets([original]);
  assert.deepStrictEqual(preset, { ...original, theme: 'glass', config: plain(themes.defaults.glass) });
  assert.deepStrictEqual(normalizeStylePresets([preset]), [preset]);
  assert.deepStrictEqual(themes.migrateSettings(settings), settings);
});

test('retiring paper preserves glass preferences without changing new manga or losing old presets', () => {
  const original = { theme: 'paper', previewEnabled: false, roomId: '123',
    themeConfigs: {
      paper: { messageFont: 47, bodyColor: '#ff0000' },
      glass: { ...themes.defaults.glass, surfaceColor: '#123456', messageFont: 32 },
      manga: { ...themes.defaults.manga, mangaShape: 'oval', messageFont: 30 }
    } };
  const before = plain(original);
  const settings = themes.migrateSettings(original);
  assert.strictEqual(settings.theme, 'glass');
  assert.strictEqual(settings.previewEnabled, false);
  assert.strictEqual(settings.roomId, '123');
  assert.strictEqual(settings.themeConfigs.glass.messageFont, 32);
  assert.strictEqual(settings.themeConfigs.glass.surfaceColor, '#123456');
  assert.strictEqual(Object.hasOwn(settings.themeConfigs.manga, 'mangaShape'), false);
  assert.strictEqual(settings.themeConfigs.manga.messageFont, 30);
  assert.strictEqual(Object.hasOwn(settings.themeConfigs, 'paper'), false);
  const preset = { id: 'old-paper', name: '旧暖纸预设', theme: 'paper', width: 701, height: 845,
    config: { ...themes.defaults.glass, bodyColor: '#ff0000', fontFamily: 'KaiTi' } };
  assert.deepStrictEqual(normalizeStylePresets([preset]), [{ ...preset, theme: 'glass', config: plain(themes.defaults.glass) }]);
  assert.deepStrictEqual(themes.migrateSettings(settings), settings);
  assert.deepStrictEqual(original, before);
});

test('new themes have readable ordinary typography and manga defaults remain strictly grayscale', () => {
  for (const id of ['mecha', 'comic', 'manga', 'win95']) {
    const config = themes.defaults[id];
    assert.strictEqual(config.messageFont, 26);
    assert.strictEqual(config.nameFont, 16);
    assert.strictEqual(config.welcomeFont, 18);
    assert.strictEqual(config.showAvatar, id !== 'manga');
    assert.strictEqual(config.showWelcome, true);
    assert.strictEqual(config.baseWidth, 515);
    assert.strictEqual(config.baseHeight, 650);
  }
  for (const [key, color] of Object.entries(themes.defaults.manga)) {
    if (!key.endsWith('Color')) continue;
    assert.match(color, /^#([0-9a-f]{2})\1\1$/i, key + ' must be grayscale');
  }
  assert.strictEqual(themes.defaults.manga.fontFamily, 'ZCOOL KuaiLe');
  for (const id of themes.ids.filter(id => id !== 'manga')) {
    assert.notStrictEqual(themes.defaults[id].fontFamily, 'ZCOOL KuaiLe');
  }
  assert.strictEqual(themes.defaults.win95.viewerColor, '#ffffff');
  assert.strictEqual(themes.defaults.win95.bodyColor, '#000000');
  assert.strictEqual(themes.defaults.win95.giftColor, '#000000');
});

test('manga defaults hide avatars without resetting explicit old settings or presets', () => {
  assert.strictEqual(themes.defaults.manga.showAvatar, false);
  assert.strictEqual(themes.normalizeConfig('manga', {}).showAvatar, false);
  for (const showAvatar of [true, false]) {
    const appearance = { ...themes.defaults.manga, showAvatar, messageFont: 31,
      welcomeFont: 25, bodyColor: '#252525' };
    const migrated = themes.migrateSettings({ theme: 'manga', themeConfigs: { manga: appearance } });
    assert.deepStrictEqual(migrated.themeConfigs.manga, appearance);
    assert.deepStrictEqual(themes.normalizePresetThemeConfig('manga', appearance).config, appearance);
    assert.deepStrictEqual(themes.migrateSettings(migrated), migrated);
  }
});

test('SC expiry preferences migrate from the old global flag only into skins missing their own value', () => {
  for (const input of [{}, null, ...[false, undefined, null, 'true', 'false', 1, 0, {}].map(scNeverExpire => ({ scNeverExpire }))]) {
    const normalized = themes.migrateSettings(input);
    assert.strictEqual(Object.hasOwn(normalized, 'scNeverExpire'), false);
    for (const theme of themes.ids) assert.strictEqual(normalized.themeConfigs[theme].scNeverExpire, false);
  }
  const source = { theme: 'manga', roomId: '123', scNeverExpire: true,
    themeConfigs: { manga: { showAvatar: true, messageFont: 30 }, glass: { scNeverExpire: false },
      portrait: { scNeverExpire: true }, tui: { scNeverExpire: 'true' } } };
  const before = plain(source);
  const normalized = themes.migrateSettings(source);
  assert.strictEqual(Object.hasOwn(normalized, 'scNeverExpire'), false);
  assert.strictEqual(normalized.roomId, '123');
  assert.strictEqual(normalized.themeConfigs.manga.showAvatar, true);
  assert.strictEqual(normalized.themeConfigs.manga.messageFont, 30);
  for (const theme of themes.ids) {
    assert.strictEqual(normalized.themeConfigs[theme].scNeverExpire, theme !== 'glass' && theme !== 'tui', theme);
  }
  assert.deepStrictEqual(themes.migrateSettings(normalized), normalized);
  assert.deepStrictEqual(source, before);
  const explicit = themes.migrateSettings({ scNeverExpire: false, themeConfigs: { glass: { scNeverExpire: true } } });
  assert.strictEqual(explicit.themeConfigs.glass.scNeverExpire, true);
  assert.strictEqual(explicit.themeConfigs.portrait.scNeverExpire, false);
});

test('each skin preserves SC expiry booleans and old presets default to timed expiry', () => {
  for (const theme of themes.ids) {
    assert.strictEqual(themes.defaults[theme].scNeverExpire, false);
    const previous = { ...themes.defaults[theme] };
    delete previous.scNeverExpire;
    assert.strictEqual(themes.normalizePresetThemeConfig(theme, previous).config.scNeverExpire, false);
    for (const scNeverExpire of [true, false]) {
      assert.strictEqual(themes.normalizePresetThemeConfig(theme, { ...previous, scNeverExpire }).config.scNeverExpire, scNeverExpire);
    }
    for (const scNeverExpire of [null, 'true', 'false', 0, 1, {}]) {
      assert.throws(() => themes.normalizePresetThemeConfig(theme, { ...previous, scNeverExpire }), /SC/);
      assert.strictEqual(themes.normalizeConfig(theme, { scNeverExpire }).scNeverExpire, false);
    }
  }
});

test('full-card visibility defaults on and preserves independent explicit choices through migration', () => {
  const source = { theme: 'portrait', roomId: '123', themeConfigs: {
    glass: { fullCardsOnly: false, messageFont: 31 }, portrait: { fullCardsOnly: true }, manga: { showAvatar: true }
  } };
  const before = plain(source);
  const migrated = themes.migrateSettings(source);
  assert.strictEqual(migrated.themeConfigs.glass.fullCardsOnly, false);
  assert.strictEqual(migrated.themeConfigs.glass.messageFont, 31);
  assert.strictEqual(migrated.themeConfigs.portrait.fullCardsOnly, true);
  assert.strictEqual(migrated.themeConfigs.manga.fullCardsOnly, true);
  assert.strictEqual(migrated.themeConfigs.manga.showAvatar, true);
  assert.deepStrictEqual(themes.migrateSettings(plain(migrated)), migrated);
  assert.deepStrictEqual(source, before);
  for (const theme of themes.ids) {
    assert.strictEqual(themes.defaults[theme].fullCardsOnly, true);
    const previous = { ...themes.defaults[theme] };
    delete previous.fullCardsOnly;
    assert.strictEqual(themes.normalizeConfig(theme, previous).fullCardsOnly, true);
    assert.strictEqual(themes.normalizePresetThemeConfig(theme, previous).config.fullCardsOnly, true);
    for (const fullCardsOnly of [false, true]) {
      assert.strictEqual(themes.normalizePresetThemeConfig(theme, { ...previous, fullCardsOnly }).config.fullCardsOnly, fullCardsOnly);
    }
    for (const fullCardsOnly of [null, 'false', 'true', 0, 1, {}, []]) {
      assert.throws(() => themes.normalizePresetThemeConfig(theme, { ...previous, fullCardsOnly }), /完整卡片/);
      assert.strictEqual(themes.normalizeConfig(theme, { fullCardsOnly }).fullCardsOnly, true);
    }
  }
});

test('emote size is independent per skin and old configurations retain the 100 percent baseline', () => {
  for (const theme of themes.ids) {
    assert.strictEqual(themes.defaults[theme].emoteScale, 100);
    const previous = { ...themes.defaults[theme], messageFont: 31 };
    delete previous.emoteScale;
    assert.strictEqual(themes.normalizeConfig(theme, previous).emoteScale, 100);
    assert.strictEqual(themes.normalizePresetThemeConfig(theme, previous).config.emoteScale, 100);
    for (const emoteScale of [50, 100, 125, 200, '150']) {
      const config = themes.normalizePresetThemeConfig(theme, { ...previous, emoteScale }).config;
      assert.strictEqual(config.emoteScale, Number(emoteScale));
      assert.strictEqual(config.messageFont, 31);
    }
    for (const emoteScale of [0, 49, 201, null, false, '', 'bad', Infinity]) {
      assert.throws(() => themes.normalizePresetThemeConfig(theme, { ...previous, emoteScale }), /表情|emoteScale/);
    }
    assert.strictEqual(themes.normalizeConfig(theme, { emoteScale: 0 }).emoteScale, 50);
    assert.strictEqual(themes.normalizeConfig(theme, { emoteScale: 250 }).emoteScale, 200);
  }
  const configs = themes.migrateSettings({ themeConfigs: { glass: { emoteScale: 75 }, portrait: { emoteScale: 150 } } }).themeConfigs;
  assert.strictEqual(configs.glass.emoteScale, 75);
  assert.strictEqual(configs.portrait.emoteScale, 150);
  assert.strictEqual(configs.manga.emoteScale, 100);
});

test('retired manga shape fields are ignored without resetting appearance in settings or presets', () => {
  assert.strictEqual(Object.hasOwn(themes.defaults.manga, 'mangaShape'), false);
  const appearance = { ...themes.defaults.manga, messageFont: 33, nameFont: 21, welcomeFont: 26,
    bodyColor: '#252525', welcomeNameColor: '#343434', showAvatar: false, fontFamily: 'Microsoft YaHei UI' };
  for (const mangaShape of ['panel', 'oval', 'bubble', undefined, null, {}, 'invalid']) {
    const source = { ...appearance, mangaShape };
    assert.deepStrictEqual(themes.normalizeConfig('manga', source), appearance);
    assert.deepStrictEqual(themes.normalizePresetThemeConfig('manga', source).config, appearance);
    assert.strictEqual(Object.hasOwn(source, 'mangaShape'), true);
  }
  for (const id of themes.ids) {
    const config = themes.normalizeConfig(id, { ...themes.defaults[id], mangaShape: 'oval' }, { strict: true });
    assert.strictEqual(Object.hasOwn(config, 'mangaShape'), false);
  }
});

test('normalization is bounded, whitelisted, and does not mutate caller configuration or defaults', () => {
  const source = {
    glass: { overallScale: Infinity, messageFont: 100, nameFont: -30, horizontalPadding: 9999,
      welcomeGap: -50, welcomeFont: -50, surfaceOpacity: NaN, fontFamily: ' ', bodyColor: 'red', timeColor: '#123456',
      roomId: 'never-copy', cookies: ['never-copy'], bitmapEngineVersion: 3, showAvatar: 'false' }
  };
  const normalized = themes.normalizeConfigs(source);
  assert.strictEqual(normalized.glass.messageFont, 48);
  assert.strictEqual(normalized.glass.nameFont, 10);
  assert.strictEqual(normalized.glass.horizontalPadding, 64);
  assert.strictEqual(normalized.glass.welcomeFont, 12);
  assert.strictEqual(normalized.glass.overallScale, themes.defaults.glass.overallScale);
  assert.strictEqual(normalized.glass.fontFamily, themes.defaults.glass.fontFamily);
  assert.strictEqual(normalized.glass.welcomeTextColor, '#123456');
  assert.strictEqual(normalized.glass.showAvatar, themes.defaults.glass.showAvatar);
  for (const key of ['roomId', 'cookies', 'bitmapEngineVersion', 'pixelFontVersion', 'welcomeGap']) {
    assert.strictEqual(Object.hasOwn(normalized.glass, key), false);
  }
  normalized.glass.bodyColor = '#000000';
  assert.notStrictEqual(themes.defaults.glass.bodyColor, '#000000');
  assert.strictEqual(source.glass.messageFont, 100);
  assert.deepStrictEqual(themes.normalizeConfigs(null), plain(themes.defaults));
});

test('legacy presets retain identity and exact canvas dimensions while replacing only old theme styles', () => {
  const original = [
    { id: 'old-pixel', name: '点阵直播', theme: 'pixel', width: 850, height: 910,
      config: { ...themes.defaults.glass, bodyColor: '#ff00ff', fontFamily: 'GNU Unifont 16 Bitmap' } },
    { id: 'old-risograph', name: '旧纸面', theme: 'risograph', width: 430, height: 720,
      config: { ...themes.defaults.glass, bodyColor: '#ee0000', fontFamily: 'KaiTi' } },
    { id: 'glass-kept', name: '自定义玻璃', theme: 'glass', width: 610, height: 680,
      config: { ...themes.defaults.glass, messageFont: 31, surfaceColor: '#123456', welcomeNameColor: '#abcdef' } }
  ];
  const before = plain(original);
  const migrated = normalizeStylePresets(original);
  assert.strictEqual(migrated.length, 3);
  for (let i = 0; i < migrated.length; i += 1) {
    for (const key of ['id', 'name', 'width', 'height']) assert.strictEqual(migrated[i][key], original[i][key]);
  }
  assert.strictEqual(migrated[0].theme, 'el');
  assert.deepStrictEqual(migrated[0].config, plain(themes.defaults.el));
  assert.strictEqual(migrated[1].theme, 'glass');
  assert.deepStrictEqual(migrated[1].config, plain(themes.defaults.glass));
  assert.strictEqual(migrated[2].config.messageFont, 31);
  assert.strictEqual(migrated[2].config.surfaceColor, '#123456');
  assert.strictEqual(migrated[2].config.welcomeNameColor, '#abcdef');
  assert.deepStrictEqual(normalizeStylePresets(migrated), migrated);
  assert.deepStrictEqual(original, before);
});

test('unknown preset themes remain invalid and new preset styles require valid values', () => {
  assert.throws(() => themes.normalizePresetThemeConfig('__proto__', themes.defaults.glass), /皮肤/);
  assert.throws(() => themes.normalizePresetThemeConfig('outline', { ...themes.defaults.outline, bodyColor: 'invalid' }), /颜色/);
  assert.throws(() => themes.normalizePresetThemeConfig('comic', { ...themes.defaults.comic, showWelcome: 'no' }), /显示/);
  const config = themes.normalizePresetThemeConfig('el', themes.defaults.el);
  assert.strictEqual(config.theme, 'el');
  assert.deepStrictEqual(config.config, plain(themes.defaults.el));
});

test('welcome font migrates independently per skin and retired footer spacing is discarded', () => {
  for (const theme of themes.ids) {
    const legacy = { ...themes.defaults[theme], welcomeGap: 72, messageFont: 30,
      showWelcome: false, welcomeTextColor: '#123456', welcomeNameColor: '#abcdef' };
    delete legacy.welcomeFont;
    const before = plain(legacy);
    for (const config of [themes.normalizeConfig(theme, legacy), themes.normalizePresetThemeConfig(theme, legacy).config]) {
      assert.strictEqual(config.welcomeFont, 18);
      assert.strictEqual(Object.hasOwn(config, 'welcomeGap'), false);
      assert.strictEqual(config.messageFont, 30);
      assert.strictEqual(config.showWelcome, false);
      assert.strictEqual(config.welcomeTextColor, '#123456');
      assert.strictEqual(config.welcomeNameColor, '#abcdef');
    }
    assert.deepStrictEqual(legacy, before);
    assert.strictEqual(themes.normalizeConfig(theme, { ...legacy, welcomeFont: 99 }).welcomeFont, 48);
    assert.strictEqual(themes.normalizeConfig(theme, { ...legacy, welcomeFont: 0 }).welcomeFont, 12);
    assert.strictEqual(themes.normalizeConfig(theme, { ...legacy, welcomeFont: 27 }).welcomeFont, 27);
    assert.strictEqual(themes.normalizeConfig(theme, { ...legacy, welcomeFont: NaN }).welcomeFont, 18);
    for (const welcomeFont of [null, '', 'invalid', NaN, Infinity, true]) {
      assert.throws(() => themes.normalizePresetThemeConfig(theme, { ...legacy, welcomeFont }), /welcomeFont/);
    }
  }
  const normalized = themes.normalizeConfigs({ glass: { welcomeFont: 24 }, tui: { welcomeFont: 31 } });
  assert.strictEqual(normalized.glass.welcomeFont, 24);
  assert.strictEqual(normalized.tui.welcomeFont, 31);
  assert.strictEqual(normalized.manga.welcomeFont, 18);
});

test('retired font and renderer fields cannot re-enable the removed bitmap resource in any theme', () => {
  for (const theme of themes.ids) {
    for (const fontFamily of ['GNU Unifont 16 Bitmap', 'Unifont', 'Fusion Pixel 12px Monospaced', 'FusionPixel', '单色点阵']) {
      const config = themes.normalizeConfig(theme, {
        ...themes.defaults[theme], fontFamily, bitmapEngineVersion: 3, pixelFontVersion: 3
      }, { strict: true });
      assert.strictEqual(config.fontFamily, themes.defaults[theme].fontFamily);
      assert.strictEqual(Object.hasOwn(config, 'bitmapEngineVersion'), false);
      assert.strictEqual(Object.hasOwn(config, 'pixelFontVersion'), false);
    }
  }
  const el = themes.normalizeConfig('el', { ...themes.defaults.el, messageFont: 16, nameFont: 10, metaFont: 8, timeFont: 9 });
  assert.strictEqual(el.messageFont, 16);
  assert.strictEqual(el.nameFont, 10);
  assert.strictEqual(el.metaFont, 8);
  assert.strictEqual(el.timeFont, 9);
});

test('message alignment is independent per skin, defaults to bottom and rejects invalid preset values', () => {
  for (const theme of themes.ids) {
    const previous = { ...themes.defaults[theme] };
    delete previous.messageAlign;
    assert.strictEqual(themes.normalizeConfig(theme, previous).messageAlign, 'bottom');
    assert.strictEqual(themes.normalizePresetThemeConfig(theme, previous).config.messageAlign, 'bottom');
    for (const messageAlign of ['top', 'bottom']) {
      assert.strictEqual(themes.normalizePresetThemeConfig(theme, { ...previous, messageAlign }).config.messageAlign, messageAlign);
    }
    for (const messageAlign of [null, '', 'center', true, 1, {}]) {
      assert.strictEqual(themes.normalizeConfig(theme, { messageAlign }).messageAlign, 'bottom');
      assert.throws(() => themes.normalizePresetThemeConfig(theme, { ...previous, messageAlign }), /对齐/);
    }
  }
  const settings = themes.migrateSettings({ themeConfigs: { glass: { messageAlign: 'top' } } });
  assert.strictEqual(settings.themeConfigs.glass.messageAlign, 'top');
  assert.strictEqual(settings.themeConfigs.portrait.messageAlign, 'bottom');
  assert.deepStrictEqual(themes.migrateSettings(plain(settings)), settings);
});

console.log('Theme registry tests passed: ' + passed);
