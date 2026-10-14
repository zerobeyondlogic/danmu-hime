'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const { createRequire } = require('module');
const presets = require('../desktop/style-presets.js');
const themes = require('../desktop/themes.js');

function fixture(overrides = {}) {
  return {
    name: '日常直播', theme: 'glass', width: 515, height: 650,
    config: {
      overallScale: 100, messageGap: 10, messageFont: 26, nameFont: 16, metaFont: 13, timeFont: 12,
      fontFamily: 'Microsoft YaHei UI', bodyColor: '#fcfcfd', giftColor: '#e4a5b0', timeColor: '#c9d0d8',
      viewerColor: '#e7e9ed', hostColor: '#e99aa9', managerColor: '#72bfe7', governorColor: '#ef817c',
      admiralColor: '#c59ad8', captainColor: '#80cbe5', surfaceOpacity: 28, showAvatar: true,
      showWelcome: true, welcomeFont: 18, horizontalPadding: 8, baseWidth: 515, baseHeight: 650,
      welcomeTextColor: '#123456', welcomeNameColor: '#abcdef'
    }, ...overrides
  };
}

const plain = (value) => JSON.parse(JSON.stringify(value));
const cases = [];
function test(name, run) { cases.push({ name, run }); }

test('named presets retain only bounded visual configuration and canvas dimensions', () => {
  const source = fixture({ name: '  游戏  ', roomId: '123', cookie: 'secret', x: 100, alwaysOnTop: false });
  Object.assign(source.config, { roomId: '456', cookies: ['secret'], arbitrary: { data: true } });
  const result = presets.saveStylePreset([], source, () => 'new-id');
  assert.strictEqual(result.preset.name, '游戏');
  assert.strictEqual(result.preset.id, 'new-id');
  assert.strictEqual(result.preset.config.welcomeTextColor, '#123456');
  assert.strictEqual(result.preset.config.welcomeNameColor, '#abcdef');
  for (const key of ['cookie', 'cookies', 'roomId', 'arbitrary', 'alwaysOnTop', 'x']) {
    assert.ok(!(key in result.preset) && !(key in result.preset.config));
  }
  const edge = fixture({ width: 20000, height: -100 });
  edge.config.horizontalPadding = 10000;
  edge.config.surfaceOpacity = -20;
  const clamped = presets.saveStylePreset([], edge, () => 'edge').preset;
  assert.strictEqual(clamped.width, 3840);
  assert.strictEqual(clamped.height, 160);
  assert.strictEqual(clamped.config.horizontalPadding, 64);
  assert.strictEqual(clamped.config.surfaceOpacity, 0);
});

test('validation rejects empty, oversized, malformed, and non-finite inputs', () => {
  for (const name of ['', ' ', 'a'.repeat(41), 'test\nname', null]) {
    assert.throws(() => presets.saveStylePreset([], fixture({ name }), () => 'id'));
  }
  assert.strictEqual(presets.normalizePresetName('😀'.repeat(40)), '😀'.repeat(40));
  for (const width of [NaN, Infinity, null, {}, true, '']) {
    assert.throws(() => presets.saveStylePreset([], fixture({ width }), () => 'id'));
  }
  for (const color of ['red', '#gggggg', '#1234567', 'url(remote)', null]) {
    const input = fixture();
    input.config.welcomeNameColor = color;
    assert.throws(() => presets.saveStylePreset([], input, () => 'id'));
  }
  assert.throws(() => presets.saveStylePreset([], fixture({ theme: '__proto__' }), () => 'id'));
  const input = fixture();
  input.config.showWelcome = 'false';
  assert.throws(() => presets.saveStylePreset([], input, () => 'id'));
});

test('missing welcome colors inherit the appropriate ordinary theme colors', () => {
  const input = fixture({ theme: 'comic' });
  delete input.config.welcomeTextColor;
  delete input.config.welcomeNameColor;
  const restored = presets.saveStylePreset([], input, () => 'r').preset;
  assert.strictEqual(restored.config.welcomeTextColor, input.config.timeColor);
  assert.strictEqual(restored.config.welcomeNameColor, input.config.bodyColor);
  const plainTheme = presets.saveStylePreset([], { ...input, theme: 'el' }, () => 'e').preset;
  assert.strictEqual(plainTheme.config.welcomeNameColor, input.config.bodyColor);
  assert.strictEqual(plainTheme.config.messageFont, 26);
  assert.strictEqual(plainTheme.config.nameFont, 16);
});

test('old welcome presets survive migration and new welcome fonts round-trip independently', () => {
  for (const theme of themes.ids) {
    const input = fixture({ theme });
    delete input.config.welcomeFont;
    input.config.welcomeGap = 67;
    const legacy = { ...input, id: 'legacy-' + theme };
    const [restored] = presets.normalizeStylePresets(JSON.parse(JSON.stringify([legacy])));
    assert.ok(restored, 'legacy ' + theme + ' preset must not be dropped');
    assert.strictEqual(restored.id, legacy.id);
    assert.strictEqual(restored.config.welcomeFont, 18);
    assert.strictEqual(Object.hasOwn(restored.config, 'welcomeGap'), false);
    assert.strictEqual(restored.config.welcomeTextColor, '#123456');
    assert.strictEqual(restored.config.welcomeNameColor, '#abcdef');
    restored.config.welcomeFont = 32;
    const saved = presets.saveStylePreset([restored], restored).preset;
    const [restarted] = presets.normalizeStylePresets(JSON.parse(JSON.stringify([saved])));
    assert.strictEqual(restarted.config.welcomeFont, 32);
    const otherTheme = theme === 'tui' ? 'glass' : 'tui';
    const otherConfig = { ...themes.defaults[otherTheme], welcomeFont: 21 };
    const applied = presets.settingsForStylePreset({ themeConfigs: { [otherTheme]: otherConfig } }, restarted);
    assert.strictEqual(applied.themeConfigs[theme].welcomeFont, 32);
    assert.deepStrictEqual(applied.themeConfigs[otherTheme], otherConfig);
  }
});

test('old theme presets migrate to new defaults while preserving identity and dimensions', () => {
  for (const [oldId, newId] of [['pixel', 'el'], ['risograph', 'glass'], ['mono', 'glass'], ['paper', 'glass']]) {
    const saved = presets.saveStylePreset([], fixture({ theme: oldId, width: 777, height: 888 }), () => 'legacy').preset;
    assert.strictEqual(saved.id, 'legacy');
    assert.strictEqual(saved.name, fixture().name);
    assert.strictEqual(saved.width, 777);
    assert.strictEqual(saved.height, 888);
    assert.strictEqual(saved.theme, newId);
    assert.deepStrictEqual(saved.config, plain(themes.defaults[newId]));
    assert.strictEqual(Object.hasOwn(saved.config, 'bitmapEngineVersion'), false);
    assert.strictEqual(Object.hasOwn(saved.config, 'pixelFontVersion'), false);
  }
});

test('glass surface color survives presets while legacy glass stays black and other skins stay independent', () => {
  const legacy = presets.saveStylePreset([], fixture(), () => 'legacy').preset;
  assert.strictEqual(legacy.config.surfaceColor, '#000000');
  const input = fixture();
  input.config.surfaceColor = '#183A52';
  const saved = presets.saveStylePreset([], input, () => 'tinted').preset;
  assert.strictEqual(saved.config.surfaceColor, '#183a52');
  const restored = presets.normalizeStylePresets(JSON.parse(JSON.stringify([saved])))[0];
  assert.strictEqual(presets.settingsForStylePreset({}, restored).themeConfigs.glass.surfaceColor, '#183a52');
  for (const color of ['red', '#123', '#gggggg', null, 'url(remote)']) {
    input.config.surfaceColor = color;
    assert.throws(() => presets.saveStylePreset([], input, () => 'bad'), /承载面颜色/);
  }
  input.config.surfaceColor = '#183a52';
  for (const theme of ['el', 'tui', 'outline', 'portrait', 'mecha', 'comic', 'manga', 'win95', 'pixel']) {
    const other = presets.saveStylePreset([], { ...input, theme }, () => theme).preset;
    assert.strictEqual(Object.hasOwn(other.config, 'surfaceColor'), false);
  }
});

test('glass and outline shadow strength round-trips through presets including zero, defaults and invalid rejection', () => {
  for (const [theme, initial] of [['glass', 60], ['outline', 70]]) {
    const oldConfig = { ...themes.defaults[theme] };
    delete oldConfig.shadowStrength;
    const legacy = presets.saveStylePreset([], fixture({ theme, config: oldConfig }), () => 'legacy-' + theme).preset;
    assert.strictEqual(legacy.config.shadowStrength, initial);
    for (const shadowStrength of [0, 100]) {
      const saved = presets.saveStylePreset([], fixture({ theme, width: 683, height: 794,
        config: { ...themes.defaults[theme], shadowStrength } }), () => theme + '-' + shadowStrength).preset;
      const [restored] = presets.normalizeStylePresets(JSON.parse(JSON.stringify([saved])));
      assert.deepStrictEqual(restored, saved);
      const other = theme === 'glass' ? 'outline' : 'glass';
      const otherConfig = { ...themes.defaults[other], shadowStrength: 37, scNeverExpire: true };
      const applied = presets.settingsForStylePreset({ themeConfigs: { [other]: otherConfig } }, restored);
      assert.strictEqual(applied.themeConfigs[theme].shadowStrength, shadowStrength);
      assert.deepStrictEqual(applied.themeConfigs[other], otherConfig);
      assert.strictEqual(applied.themeConfigs[other].scNeverExpire, true);
      assert.strictEqual(restored.width, 683);
      assert.strictEqual(restored.height, 794);
    }
    for (const shadowStrength of [null, 'bad', -1, 101, Infinity]) {
      assert.throws(() => presets.saveStylePreset([], fixture({ theme,
        config: { ...themes.defaults[theme], shadowStrength } }), () => 'bad'), /阴影/);
    }
  }
  for (const theme of themes.ids.filter(theme => theme !== 'glass' && theme !== 'outline')) {
    const saved = presets.saveStylePreset([], fixture({ theme,
      config: { ...themes.defaults[theme], shadowStrength: 90, outlineStyleVersion: 1 } }), () => theme).preset;
    assert.strictEqual(Object.hasOwn(saved.config, 'shadowStrength'), false);
    assert.strictEqual(Object.hasOwn(saved.config, 'outlineStyleVersion'), false);
  }
});

test('legacy outline presets migrate old palette and font once while preserving identity and later custom choices', () => {
  const oldPalette = { bodyColor: '#f4f7fa', giftColor: '#c5d9e6', timeColor: '#95a5b3', viewerColor: '#e9f0f5',
    hostColor: '#dec1cd', managerColor: '#a9ccdf', governorColor: '#e0bbb4', admiralColor: '#c4b8d7',
    captainColor: '#b3d1db', welcomeTextColor: '#95a5b3', welcomeNameColor: '#f4f7fa' };
  const old = fixture({ id: 'old-outline', name: '日常描边', theme: 'outline', width: 617, height: 829,
    config: { ...themes.defaults.outline, ...oldPalette, fontFamily: 'Microsoft YaHei UI',
      messageFont: 31, welcomeFont: 25, showAvatar: false, viewerColor: '#123456' } });
  delete old.config.outlineStyleVersion;
  delete old.config.shadowStrength;
  const before = plain(old);
  const [migrated] = presets.normalizeStylePresets([old]);
  assert.ok(migrated);
  for (const key of ['id', 'name', 'width', 'height']) assert.strictEqual(migrated[key], before[key]);
  for (const key of Object.keys(oldPalette).filter(key => key !== 'viewerColor')) assert.strictEqual(migrated.config[key], '#ffffff', key);
  assert.strictEqual(migrated.config.viewerColor, '#123456');
  assert.strictEqual(migrated.config.fontFamily, 'YouYuan');
  assert.strictEqual(migrated.config.messageFont, 31);
  assert.strictEqual(migrated.config.welcomeFont, 25);
  assert.strictEqual(migrated.config.showAvatar, false);
  assert.strictEqual(migrated.config.shadowStrength, 70);
  assert.strictEqual(migrated.config.outlineStyleVersion, 1);
  assert.deepStrictEqual(presets.normalizeStylePresets([migrated]), [migrated]);
  const custom = { ...migrated, config: { ...migrated.config, ...oldPalette, shadowStrength: 0, fontFamily: 'Microsoft YaHei UI' } };
  const edited = presets.saveStylePreset([migrated], custom).preset;
  const [restarted] = presets.normalizeStylePresets(JSON.parse(JSON.stringify([edited])));
  assert.deepStrictEqual(restarted, custom, 'versioned user choices are never re-migrated');
  assert.deepStrictEqual(old, before);
});

test('CRUD requires explicit overwrite, rejects name collisions and bounds the list', () => {
  let list = presets.saveStylePreset([], fixture(), () => 'one').presets;
  list = presets.saveStylePreset(list, fixture({ name: '游戏', width: 800 }), () => 'two').presets;
  assert.throws(() => presets.saveStylePreset(list, fixture({ name: ' 游戏 ' }), () => 'three'), /同名/);
  assert.throws(() => presets.renameStylePreset(list, 'one', '游戏'), /同名/);
  assert.throws(() => presets.saveStylePreset(list, fixture({ id: 'missing' })), /删除/);
  const renamed = presets.renameStylePreset(list, 'one', '新名字');
  assert.strictEqual(renamed.preset.id, 'one');
  assert.strictEqual(renamed.preset.config.welcomeNameColor, '#abcdef');
  const updated = presets.saveStylePreset(renamed.presets, fixture({ id: 'one', name: '新名字', width: 600 }));
  assert.strictEqual(updated.presets.length, 2);
  assert.strictEqual(updated.preset.width, 600);
  assert.strictEqual(presets.deleteStylePreset(updated.presets, 'one').presets.length, 1);
  const full = Array.from({ length: 30 }, (_, i) => presets.sanitizeStylePreset(fixture({ name: '名称' + i }), 'id-' + i));
  assert.throws(() => presets.saveStylePreset(full, fixture({ name: '额外' }), () => 'extra'), /30/);
  assert.strictEqual(presets.saveStylePreset(full, fixture({ id: 'id-0', name: '覆盖' })).presets.length, 30);
});

test('malformed persisted entries are isolated and cloned without growing unbounded', () => {
  const valid = presets.sanitizeStylePreset(fixture(), 'id');
  const restored = presets.normalizeStylePresets([null, { ...valid, theme: 'unknown' }, valid, valid, ...Array(100).fill(valid)]);
  assert.strictEqual(restored.length, 1);
  restored[0].config.bodyColor = '#000000';
  assert.strictEqual(valid.config.bodyColor, '#fcfcfd');
  assert.deepStrictEqual(presets.normalizeStylePresets({}), []);
});

test('application keeps nonvisual settings and every other skin intact', () => {
  const state = {
    roomId: '12345', previewEnabled: false, overlaySizeLocked: true, alwaysOnTop: false,
    theme: 'tui', themeConfigVersion: 3, login: { uid: '999' },
    themeConfigs: { tui: { messageFont: 23 }, glass: { bodyColor: '#111111' } }
  };
  const before = plain(state);
  const preset = presets.sanitizeStylePreset(fixture(), 'id');
  const applied = presets.settingsForStylePreset(state, preset);
  assert.deepStrictEqual(state, before);
  assert.strictEqual(applied.theme, 'glass');
  assert.strictEqual(applied.themeConfigVersion, 3);
  assert.deepStrictEqual(applied.themeConfigs.tui, themes.normalizeConfig('tui', before.themeConfigs.tui));
  for (const key of ['roomId', 'previewEnabled', 'overlaySizeLocked', 'alwaysOnTop', 'login']) {
    assert.deepStrictEqual(applied[key], before[key]);
  }
});

test('style presets restore the selected skin SC preference without altering other skins', () => {
  for (const theme of themes.ids) {
    for (const scNeverExpire of [false, true]) {
      const input = fixture({ theme, scNeverExpire: !scNeverExpire,
        config: { ...themes.defaults[theme], scNeverExpire } });
      const saved = presets.saveStylePreset([], input, () => 'sc-' + theme).preset;
      assert.strictEqual(Object.hasOwn(saved, 'scNeverExpire'), false);
      const [restored] = presets.normalizeStylePresets(plain([saved]));
      assert.strictEqual(restored.config.scNeverExpire, scNeverExpire);
      const current = themes.migrateSettings({ theme: 'manga', scNeverExpire: !scNeverExpire });
      const applied = presets.settingsForStylePreset(current, restored);
      assert.strictEqual(Object.hasOwn(applied, 'scNeverExpire'), false);
      for (const id of themes.ids) {
        assert.strictEqual(applied.themeConfigs[id].scNeverExpire, id === theme ? scNeverExpire : !scNeverExpire);
      }
    }
  }
});

test('old presets default to timed SC expiry and do not revive the legacy global field', () => {
  const old = fixture({ id: 'old-sc', scNeverExpire: true });
  const [restored] = presets.normalizeStylePresets([old]);
  assert.strictEqual(restored.config.scNeverExpire, false);
  assert.strictEqual(Object.hasOwn(restored, 'scNeverExpire'), false);
  const applied = presets.settingsForStylePreset({ scNeverExpire: true }, restored);
  assert.strictEqual(Object.hasOwn(applied, 'scNeverExpire'), false);
  assert.strictEqual(applied.themeConfigs.glass.scNeverExpire, false);
  assert.strictEqual(applied.themeConfigs.manga.scNeverExpire, true);
  for (const scNeverExpire of [null, 0, 1, 'true', 'false']) {
    assert.throws(() => presets.saveStylePreset([], fixture({ config: { ...old.config, scNeverExpire } }), () => 'bad'), /SC/);
  }
});

test('fixed welcome mode and timeout survive preset save, reload and apply per skin', () => {
  for (const theme of themes.ids) {
    const saved = presets.saveStylePreset([], fixture({ theme, config: { ...themes.defaults[theme], welcomeMode: 'single', welcomeDuration: 9 } }), () => 'welcome').preset;
    const [restored] = presets.normalizeStylePresets(plain([saved]));
    const applied = presets.settingsForStylePreset({}, restored);
    assert.strictEqual(applied.themeConfigs[theme].welcomeMode, 'single');
    assert.strictEqual(applied.themeConfigs[theme].welcomeDuration, 9);
    for (const other of themes.ids.filter(id => id !== theme)) assert.strictEqual(applied.themeConfigs[other].welcomeMode, 'scroll');
  }
});

test('independent medal and TUI colors survive preset save, reload and apply', () => {
  for (const theme of ['glass', 'tui']) {
    const extra = theme === 'tui' ? { medalColor: '#123456', thoughtColor: '#234567', giftValueColor: '#345678', giftMarkerColor: '#456789' } : { medalColor: '#123456' };
    const input = fixture({ theme, config: { ...themes.defaults[theme], ...extra } });
    const saved = presets.saveStylePreset([], input, () => 'extra-colors').preset;
    const [restored] = presets.normalizeStylePresets(plain([saved]));
    const original = themes.migrateSettings({});
    const applied = presets.settingsForStylePreset(original, restored);
    for (const [key, value] of Object.entries(extra)) assert.strictEqual(applied.themeConfigs[theme][key], value);
    for (const other of themes.ids.filter(id => id !== theme)) assert.deepStrictEqual(applied.themeConfigs[other], original.themeConfigs[other]);
  }
});

test('alignment survives preset save and reload without changing other skins', () => {
  for (const theme of themes.ids) {
    const previous = { ...themes.defaults[theme] }; delete previous.messageAlign;
    assert.strictEqual(presets.sanitizeStylePreset(fixture({ theme, config: previous }), 'old-align').config.messageAlign, 'bottom');
    for (const messageAlign of ['top', 'bottom']) {
      const saved = presets.saveStylePreset([], fixture({ theme, config: { ...previous, messageAlign } }), () => 'align').preset;
      const [restored] = presets.normalizeStylePresets(plain([saved]));
      const current = themes.migrateSettings({});
      const applied = presets.settingsForStylePreset(current, restored);
      assert.strictEqual(applied.themeConfigs[theme].messageAlign, messageAlign);
      for (const other of themes.ids.filter(id => id !== theme)) assert.deepStrictEqual(applied.themeConfigs[other], current.themeConfigs[other]);
    }
  }
});

test('presets preserve each skin full-card choice and older presets retain complete-card behavior', () => {
  for (const theme of themes.ids) {
    const previous = { ...themes.defaults[theme] };
    delete previous.fullCardsOnly;
    const old = presets.sanitizeStylePreset(fixture({ theme, config: previous }), 'old-full-cards');
    assert.strictEqual(old.config.fullCardsOnly, true);
    for (const fullCardsOnly of [false, true]) {
      const input = fixture({ theme, width: 611, height: 777, config: { ...previous, fullCardsOnly, messageFont: 31 } });
      const saved = presets.saveStylePreset([], input, () => 'full-' + theme).preset;
      const [restored] = presets.normalizeStylePresets(plain([saved]));
      assert.deepStrictEqual(restored, saved);
      assert.strictEqual(restored.width, 611);
      assert.strictEqual(restored.height, 777);
      const current = themes.migrateSettings({ themeConfigs: Object.fromEntries(themes.ids.map(id => [id, { fullCardsOnly: !fullCardsOnly }])) });
      const applied = presets.settingsForStylePreset(current, restored);
      assert.strictEqual(applied.themeConfigs[theme].fullCardsOnly, fullCardsOnly);
      assert.strictEqual(applied.themeConfigs[theme].messageFont, 31);
      for (const id of themes.ids.filter(id => id !== theme)) {
        assert.deepStrictEqual(applied.themeConfigs[id], current.themeConfigs[id]);
      }
    }
    for (const fullCardsOnly of [null, 'false', 'true', 0, 1]) {
      assert.throws(() => presets.saveStylePreset([], fixture({ theme, config: { ...previous, fullCardsOnly } }), () => 'bad'), /完整卡片/);
    }
  }
});

test('presets keep independent emote scaling and supply the baseline for older presets', () => {
  const old = presets.sanitizeStylePreset(fixture(), 'old-emote');
  assert.strictEqual(old.config.emoteScale, 100);
  for (const theme of themes.ids) {
    for (const emoteScale of [50, 135, 200]) {
      const input = fixture({ theme, config: { ...themes.defaults[theme], emoteScale, messageFont: 31 } });
      const saved = presets.saveStylePreset([], input, () => 'emote-' + theme).preset;
      const [restored] = presets.normalizeStylePresets(plain([saved]));
      const current = themes.migrateSettings({ themeConfigs: Object.fromEntries(themes.ids.map(id => [id, { emoteScale: 75 }])) });
      const applied = presets.settingsForStylePreset(current, restored);
      assert.strictEqual(applied.themeConfigs[theme].emoteScale, emoteScale);
      assert.strictEqual(applied.themeConfigs[theme].messageFont, 31);
      for (const id of themes.ids.filter(id => id !== theme)) assert.strictEqual(applied.themeConfigs[id].emoteScale, 75);
    }
  }
});

test('legacy manga presets keep an explicitly enabled avatar despite the new hidden-avatar default', () => {
  const appearance = { ...themes.defaults.manga, showAvatar: true, messageFont: 30,
    welcomeFont: 26, viewerColor: '#454545' };
  const original = fixture({ id: 'old-manga-avatars', theme: 'manga', config: appearance, width: 601, height: 745 });
  const [restored] = presets.normalizeStylePresets(JSON.parse(JSON.stringify([original])));
  assert.deepStrictEqual(restored.config, appearance);
  const current = themes.migrateSettings({ theme: 'glass', scNeverExpire: true });
  const applied = presets.settingsForStylePreset(current, restored);
  assert.strictEqual(applied.themeConfigs.manga.showAvatar, true);
  assert.strictEqual(applied.themeConfigs.manga.messageFont, 30);
  assert.strictEqual(applied.themeConfigs.manga.welcomeFont, 26);
  assert.strictEqual(applied.themeConfigs.manga.scNeverExpire, false);
  assert.strictEqual(applied.themeConfigs.glass.scNeverExpire, true);
  assert.strictEqual(restored.width, 601);
  assert.strictEqual(restored.height, 745);
});

test('portrait presets preserve image-surface visibility and typography across save and apply', () => {
  for (const surfaceOpacity of [0, 63, 100]) {
    const input = fixture({ theme: 'portrait', name: '映像直播', width: 620, height: 880,
      config: { ...themes.defaults.portrait, surfaceOpacity, messageFont: 31, welcomeFont: 23, showAvatar: true } });
    const saved = presets.saveStylePreset([], input, () => 'portrait-preset').preset;
    const [restarted] = presets.normalizeStylePresets(JSON.parse(JSON.stringify([saved])));
    assert.ok(restarted);
    assert.strictEqual(restarted.theme, 'portrait');
    assert.strictEqual(restarted.width, 620);
    assert.strictEqual(restarted.height, 880);
    assert.deepStrictEqual(restarted.config, input.config);
    const current = { theme: 'glass', roomId: '12345', themeConfigs: {
      glass: { ...themes.defaults.glass, surfaceColor: '#183a52', messageFont: 29 }
    } };
    const applied = presets.settingsForStylePreset(current, restarted);
    assert.strictEqual(applied.theme, 'portrait');
    assert.strictEqual(applied.roomId, '12345');
    assert.deepStrictEqual(applied.themeConfigs.glass, current.themeConfigs.glass);
    assert.deepStrictEqual(applied.themeConfigs.portrait, input.config);
  }
});

test('portrait width round-trips through presets while older presets gain the 48 percent default', () => {
  const previous = { ...themes.defaults.portrait, messageFont: 31, fullCardsOnly: false, scNeverExpire: true, emoteScale: 125 };
  delete previous.portraitWidth;
  const legacy = fixture({ id: 'old-portrait-width', name: '柔焦旧预设', theme: 'portrait', config: previous, width: 601, height: 811 });
  const [restoredOld] = presets.normalizeStylePresets(plain([legacy]));
  assert.strictEqual(restoredOld.id, legacy.id);
  assert.strictEqual(restoredOld.name, legacy.name);
  assert.strictEqual(restoredOld.width, 601);
  assert.strictEqual(restoredOld.height, 811);
  assert.deepStrictEqual(restoredOld.config, { ...previous, portraitWidth: 48 });
  for (const portraitWidth of [30, 48, 64, 70]) {
    const input = { ...legacy, config: { ...previous, portraitWidth } };
    delete input.id;
    const saved = presets.saveStylePreset([], input, () => 'width-' + portraitWidth).preset;
    const [restored] = presets.normalizeStylePresets(plain([saved]));
    assert.deepStrictEqual(restored, saved);
    const current = themes.migrateSettings({ theme: 'glass', themeConfigs: { glass: { scNeverExpire: true, fullCardsOnly: false, emoteScale: 150 } } });
    const applied = presets.settingsForStylePreset(current, restored);
    assert.deepStrictEqual(applied.themeConfigs.portrait, { ...previous, portraitWidth });
    for (const id of themes.ids.filter(id => id !== 'portrait')) assert.deepStrictEqual(applied.themeConfigs[id], current.themeConfigs[id]);
  }
});

test('all four new themes preserve independent visual settings in saved presets', () => {
  for (const theme of ['mecha', 'comic', 'manga', 'win95']) {
    const input = fixture({ theme, name: '新皮肤 ' + theme, width: 601, height: 789,
      config: { ...themes.defaults[theme], messageFont: 31, nameFont: 19, welcomeFont: 25,
        showAvatar: false, showWelcome: false, welcomeTextColor: '#123456', welcomeNameColor: '#abcdef' } });
    const saved = presets.saveStylePreset([], input, () => 'new-' + theme).preset;
    const [restarted] = presets.normalizeStylePresets(JSON.parse(JSON.stringify([saved])));
    assert.deepStrictEqual(restarted, saved);
    const otherConfig = { ...themes.defaults.portrait, messageFont: 33 };
    const current = { theme: 'portrait', roomId: '12345', previewEnabled: false,
      themeConfigs: { portrait: otherConfig } };
    const applied = presets.settingsForStylePreset(current, restarted);
    assert.strictEqual(restarted.width, 601);
    assert.strictEqual(restarted.height, 789);
    assert.strictEqual(applied.theme, theme);
    assert.deepStrictEqual(applied.themeConfigs[theme], input.config);
    assert.deepStrictEqual(applied.themeConfigs.portrait, otherConfig);
    assert.strictEqual(applied.roomId, '12345');
    assert.strictEqual(applied.previewEnabled, false);
  }
});

test('old panel and oval manga presets retain identities and appearance with obsolete shape removed', () => {
  let list = [];
  const shared = { ...themes.defaults.manga, messageFont: 29, nameFont: 18, welcomeFont: 24,
    welcomeNameColor: '#444444', bodyColor: '#252525', fontFamily: 'Microsoft YaHei UI', showAvatar: false };
  for (const shape of ['panel', 'oval']) {
    const input = fixture({ theme: 'manga', name: shape, width: 660, height: 780,
      config: { ...shared, mangaShape: shape } });
    list = presets.saveStylePreset(list, input, () => shape).presets;
  }
  const restarted = presets.normalizeStylePresets(JSON.parse(JSON.stringify(list)));
  assert.strictEqual(restarted.length, 2);
  for (const shape of ['oval', 'panel']) {
    const selected = restarted.find(preset => preset.id === shape);
    const current = { theme: 'glass', themeConfigs: { glass: { ...themes.defaults.glass, messageFont: 36 } } };
    const applied = presets.settingsForStylePreset(current, selected);
    assert.deepStrictEqual(applied.themeConfigs.manga, shared);
    assert.strictEqual(selected.id, shape);
    assert.strictEqual(selected.name, shape);
    assert.strictEqual(selected.width, 660);
    assert.strictEqual(selected.height, 780);
    assert.strictEqual(applied.themeConfigs.glass.messageFont, 36);
  }
  const legacy = { ...restarted[0], config: { ...shared, mangaShape: 'oval' } };
  assert.deepStrictEqual(presets.normalizeStylePresets([legacy])[0].config, shared);
  const unrelated = presets.saveStylePreset([], fixture({ theme: 'win95', config: {
    ...themes.defaults.win95, mangaShape: 'oval' } }), () => 'win95').preset;
  assert.strictEqual(Object.hasOwn(unrelated.config, 'mangaShape'), false);
});

function mainHarness(initial, { preview = false } = {}) {
  const handlers = new Map();
  const events = new EventEmitter();
  const ipcMain = { handle: (name, callback) => handlers.set(name, callback), on: events.on.bind(events) };
  const app = new EventEmitter();
  Object.assign(app, {
    requestSingleInstanceLock: () => true, whenReady: () => ({ then: () => ({ catch() {} }) }),
    getVersion: () => 'test', getPath: () => '/mock'
  });
  const screen = new EventEmitter();
  screen.getAllDisplays = () => [{ workArea: { x: 0, y: 0, width: 3840, height: 2160 } }];
  const sent = [];
  const published = [];
  const control = { isDestroyed: () => false, webContents: { send: (...args) => sent.push(args) } };
  let failWrite = false;
  let failRename = false;
  const disk = new Map([['/mock/desktop-state.json', JSON.stringify(initial)]]);
  const fileKey = (file) => String(file).replace(/\\/g, '/');
  const mockFs = {
    mkdirSync() {},
    writeFileSync(file, contents) { if (failWrite) throw new Error('no space'); disk.set(fileKey(file), contents); },
    renameSync(from, to) { if (failRename) throw new Error('locked'); disk.set(fileKey(to), disk.get(fileKey(from))); disk.delete(fileKey(from)); },
    unlinkSync: (file) => disk.delete(fileKey(file)),
    readFileSync: (file) => disk.get(fileKey(file))
  };
  let nextTimer = 0;
  const timers = new Map();
  const mainPath = path.join(__dirname, '../desktop/main.js');
  const localRequire = createRequire(mainPath);
  const context = {
    require: (id) => id === 'electron' ? { app, screen, ipcMain } : id === 'fs' ? mockFs : localRequire(id),
    __dirname: path.dirname(mainPath), process: { platform: 'win32' }, console: { ...console, error() {}, warn() {} },
    setTimeout: (callback) => { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout: (id) => timers.delete(id)
  };
  vm.runInNewContext(fs.readFileSync(mainPath, 'utf8') + `
    globalThis.presetTest = {
      init(state, control, output, window) {
        appState = state; stateFile = '/mock/desktop-state.json'; controlWindow = control;
        embedded = output; overlayWindow = window; roomConnectionRequested = true; bindIpc();
      },
      state: () => appState, viewport: acceptPreviewViewport, load: loadState,
      loading: () => stylePresetApplying, resizeQueue: () => stylePresetApplyTask,
      schedule: saveStateSoon, pendingTimers: () => saveTimer
    };
  `, context, { filename: mainPath });
  const api = context.presetTest;
  let heldRead = null;
  let releaseRead = null;
  const window = preview ? {
    bounds: { x: 80, y: 90, width: initial.requestedPreviewSize.width, height: initial.requestedPreviewSize.height },
    isDestroyed: () => false, isMaximized: () => false, isMinimized: () => false,
    getBounds() { return { ...this.bounds }; },
    setBounds(bounds) { this.bounds = { ...this.bounds, ...bounds }; api.viewport(this.bounds); },
    setContentSize(width, height) { this.setBounds({ width, height }); },
    webContents: { isDestroyed: () => false, send: (...args) => sent.push(args),
      async executeJavaScript() { if (heldRead) await heldRead; return { width: window.bounds.width, height: window.bounds.height }; }
    }
  } : null;
  api.init(plain(initial), control, { publishDesktopOutput: (...args) => published.push(plain(args)) }, window);
  return {
    api, window, sent, published, timers,
    call: (name, ...args) => handlers.get('desktop:' + name)({ sender: control.webContents }, ...args),
    outsider: (name, ...args) => handlers.get('desktop:' + name)({ sender: {} }, ...args),
    previewSettings: (value) => events.emit('desktop:preview-settings', { sender: control.webContents }, value),
    disk: () => JSON.parse(disk.get('/mock/desktop-state.json')),
    tempExists: () => disk.has('/mock/desktop-state.json.tmp'),
    failWrite: (value) => { failWrite = value; }, failRename: (value) => { failRename = value; },
    holdRead() { heldRead = new Promise((resolve) => { releaseRead = resolve; }); },
    releaseRead() { heldRead = null; releaseRead(); }
  };
}

function stateFixture() {
  return {
    settings: { theme: 'tui', themeConfigVersion: 3, themeConfigs: { tui: fixture().config },
      previewEnabled: false, alwaysOnTop: false, overlaySizeLocked: true, roomId: '12345' },
    closeAction: 'tray', requestedPreviewSize: { width: 500, height: 700 },
    previewSize: { width: 500, height: 700 }, overlayBounds: { x: 80, y: 90, width: 500, height: 700 },
    stylePresets: [presets.sanitizeStylePreset(fixture({ width: 800, height: 900 }), 'one')]
  };
}

test('actual startup migration resolves retired active skin and presets without touching dimensions or nonvisual state', () => {
  const initial = stateFixture();
  initial.dimensionModelVersion = 7;
  initial.settings.theme = 'pixel';
  initial.settings.themeConfigs.glass = { ...fixture().config, messageFont: 29, surfaceColor: '#123456' };
  initial.settings.themeConfigs.pixel = { ...fixture().config, fontFamily: 'GNU Unifont 16 Bitmap' };
  initial.stylePresets = [{ ...fixture({ theme: 'risograph', width: 600, height: 750 }), id: 'legacy' }];
  const before = plain(initial);
  const h = mainHarness(initial);
  h.api.load();
  const loaded = plain(h.api.state());
  assert.strictEqual(loaded.settings.theme, 'el');
  assert.strictEqual(loaded.settings.themeConfigs.glass.messageFont, 29);
  assert.strictEqual(loaded.settings.themeConfigs.glass.surfaceColor, '#123456');
  assert.strictEqual(loaded.settings.themeConfigs.tui.messageFont, initial.settings.themeConfigs.tui.messageFont);
  assert.deepStrictEqual(loaded.settings.themeConfigs.el, plain(themes.defaults.el));
  assert.strictEqual(loaded.stylePresets[0].id, 'legacy');
  assert.strictEqual(loaded.stylePresets[0].theme, 'glass');
  assert.strictEqual(loaded.stylePresets[0].width, 600);
  assert.strictEqual(loaded.stylePresets[0].height, 750);
  assert.deepStrictEqual(loaded.stylePresets[0].config, plain(themes.defaults.glass));
  for (const key of ['requestedPreviewSize', 'previewSize', 'overlayBounds', 'closeAction']) assert.deepStrictEqual(loaded[key], before[key]);
  for (const key of ['roomId', 'previewEnabled', 'overlaySizeLocked', 'alwaysOnTop']) assert.strictEqual(loaded.settings[key], before.settings[key]);
  assert.deepStrictEqual(initial, before);
});

test('actual startup migrates paper and mono to glass and drops only manga obsolete shape', () => {
  const initial = stateFixture();
  initial.dimensionModelVersion = 7;
  initial.settings.theme = 'paper';
  initial.settings.themeConfigs.paper = { ...themes.defaults.glass, messageFont: 47 };
  initial.settings.themeConfigs.glass = { ...themes.defaults.glass, messageFont: 30, surfaceColor: '#123456' };
  initial.settings.themeConfigs.manga = { ...themes.defaults.manga, mangaShape: 'oval', welcomeFont: 27 };
  initial.stylePresets = ['paper', 'mono'].map(theme => ({ ...fixture({ theme, width: 711, height: 899 }), id: theme }));
  const h = mainHarness(initial);
  h.api.load();
  const loaded = plain(h.api.state());
  assert.strictEqual(loaded.settings.theme, 'glass');
  assert.strictEqual(loaded.settings.themeConfigs.glass.messageFont, 30);
  assert.strictEqual(loaded.settings.themeConfigs.glass.surfaceColor, '#123456');
  assert.strictEqual(Object.hasOwn(loaded.settings.themeConfigs.manga, 'mangaShape'), false);
  assert.strictEqual(loaded.settings.themeConfigs.manga.welcomeFont, 27);
  assert.strictEqual(Object.hasOwn(loaded.settings.themeConfigs, 'paper'), false);
  assert.strictEqual(loaded.stylePresets.length, 2);
  for (const preset of loaded.stylePresets) {
    assert.strictEqual(preset.theme, 'glass');
    assert.strictEqual(preset.width, 711);
    assert.strictEqual(preset.height, 899);
    assert.deepStrictEqual(preset.config, plain(themes.defaults.glass));
  }
});

test('legacy presets recover only a unique matching saved appearance and canvas', () => {
  const initial = stateFixture();
  initial.dimensionModelVersion = 7;
  initial.settings = presets.settingsForStylePreset(initial.settings, initial.stylePresets[0]);
  initial.requestedPreviewSize = { width: 800, height: 900 };
  assert.strictEqual(presets.restoreStylePresetId(initial), 'one');
  const h = mainHarness(initial); h.api.load();
  assert.strictEqual(h.api.state().activeStylePresetId, 'one');
  assert.strictEqual(h.call('list-style-presets').activeStylePresetId, 'one');
  assert.strictEqual(presets.restoreStylePresetId({ ...initial, activeStylePresetId: '' }), '');
  assert.strictEqual(presets.restoreStylePresetId({ ...initial, activeStylePresetId: 'deleted' }), '');
  assert.strictEqual(presets.restoreStylePresetId({ ...initial, stylePresets: [...initial.stylePresets, { ...initial.stylePresets[0], id: 'copy' }] }), '');
  initial.requestedPreviewSize.width = 801;
  assert.strictEqual(presets.restoreStylePresetId(initial), '');
});

test('last used preset survives restart and later manual edits without reapplying older values', async () => {
  const h = mainHarness({ ...stateFixture(), dimensionModelVersion: 7 });
  await h.call('apply-style-preset', 'one');
  assert.strictEqual(h.disk().activeStylePresetId, 'one');
  const edited = plain(h.api.state().settings);
  edited.themeConfigs.glass.messageAlign = 'top';
  edited.themeConfigs.glass.messageFont = 37;
  h.call('save-settings', edited);
  const restarted = mainHarness(h.disk()); restarted.api.load();
  assert.strictEqual(restarted.call('list-style-presets').activeStylePresetId, 'one');
  assert.strictEqual(restarted.api.state().settings.themeConfigs.glass.messageAlign, 'top');
  assert.strictEqual(restarted.api.state().settings.themeConfigs.glass.messageFont, 37);
  assert.deepStrictEqual(plain(restarted.api.state().requestedPreviewSize), { width: 800, height: 900 });
});

test('save, rename, deletion and failed application retain an atomic active preset identity', async () => {
  const h = mainHarness(stateFixture());
  await h.call('apply-style-preset', 'one');
  const saved = h.call('save-style-preset', fixture({ name: '当前样式' }));
  assert.strictEqual(saved.activeStylePresetId, saved.preset.id);
  assert.strictEqual(h.disk().activeStylePresetId, saved.preset.id);
  assert.strictEqual(h.call('rename-style-preset', saved.preset.id, '重命名').activeStylePresetId, saved.preset.id);
  const before = h.disk();
  h.failRename(true);
  await assert.rejects(h.call('apply-style-preset', 'one'), /保存失败/);
  assert.throws(() => h.call('delete-style-preset', saved.preset.id), /保存失败/);
  assert.deepStrictEqual(h.disk(), before);
  assert.strictEqual(h.api.state().activeStylePresetId, saved.preset.id);
  h.failRename(false);
  assert.strictEqual(h.call('delete-style-preset', 'one').activeStylePresetId, saved.preset.id);
  const settings = plain(h.api.state().settings);
  assert.strictEqual(h.call('delete-style-preset', saved.preset.id).activeStylePresetId, '');
  assert.strictEqual(h.disk().activeStylePresetId, '');
  assert.deepStrictEqual(plain(h.api.state().settings), settings);
});

test('only control IPC can read, save, rename, delete or apply presets', () => {
  const h = mainHarness(stateFixture());
  for (const channel of ['list-style-presets', 'save-style-preset', 'rename-style-preset', 'delete-style-preset', 'apply-style-preset']) {
    assert.throws(() => h.outsider(channel, 'one'), /控制台/);
  }
});

test('CRUD persistence is atomic, rolls back on failure, and survives state reload', () => {
  const h = mainHarness(stateFixture());
  const saved = h.call('save-style-preset', fixture({ name: '游戏' }));
  assert.strictEqual(saved.presets.length, 2);
  assert.strictEqual(h.disk().stylePresets.length, 2);
  assert.strictEqual(h.tempExists(), false);
  const before = plain(h.api.state());
  h.failRename(true);
  assert.throws(() => h.call('rename-style-preset', saved.preset.id, '失败名字'), /保存失败/);
  assert.deepStrictEqual(plain(h.api.state()), before);
  assert.deepStrictEqual(h.disk(), before);
  assert.strictEqual(h.tempExists(), false);
  assert.throws(() => h.call('delete-style-preset', saved.preset.id), /保存失败/);
  assert.strictEqual(h.api.state().stylePresets.length, 2);
  h.failRename(false);
  const renamed = h.call('rename-style-preset', saved.preset.id, '新名字');
  assert.strictEqual(renamed.preset.id, saved.preset.id);
  const restarted = mainHarness(h.disk());
  assert.strictEqual(restarted.call('list-style-presets').presets[1].name, '新名字');
  h.call('delete-style-preset', saved.preset.id);
  assert.strictEqual(h.disk().stylePresets.length, 1);
});

test('apply while preview is released persists canonical canvas and sends OBS settings without creating a window', async () => {
  const initial = stateFixture();
  const h = mainHarness(initial);
  const result = await h.call('apply-style-preset', 'one');
  assert.deepStrictEqual(plain(result.canvas), { width: 800, height: 900 });
  assert.strictEqual(result.settings.previewCanvasWidth, 800);
  assert.strictEqual(result.settings.previewCanvasHeight, 900);
  assert.strictEqual(result.settings.theme, 'glass');
  assert.strictEqual(result.settings.previewEnabled, false);
  assert.strictEqual(result.settings.overlaySizeLocked, true);
  assert.strictEqual(result.settings.alwaysOnTop, false);
  assert.strictEqual(result.settings.roomId, '12345');
  assert.deepStrictEqual(plain(result.settings.themeConfigs.tui), themes.normalizeConfig('tui', initial.settings.themeConfigs.tui));
  assert.strictEqual(h.api.state().closeAction, 'tray');
  assert.strictEqual(h.api.state().overlayBounds.x, 80);
  assert.strictEqual(h.window, null);
  assert.strictEqual(h.disk().settings.theme, 'glass');
  assert.deepStrictEqual(h.disk().requestedPreviewSize, { width: 800, height: 900 });
  const last = h.published.at(-1);
  assert.strictEqual(last[0], 'settings');
  assert.deepStrictEqual(last[1].canvas, { width: 800, height: 900 });
});

test('visible locked preview resizes with its canvas while retaining window position', async () => {
  const h = mainHarness(stateFixture(), { preview: true });
  const result = await h.call('apply-style-preset', 'one');
  assert.deepStrictEqual(plain(result.canvas), { width: 800, height: 900 });
  assert.deepStrictEqual(h.window.getBounds(), { x: 80, y: 90, width: 800, height: 900 });
  assert.ok(h.sent.some(([channel, value]) => channel === 'desktop:settings-changed' && value.theme === 'glass'));
});

test('apply rejects overlapping saves and resizes and ignores stale preview broadcasts until commit', async () => {
  const initial = stateFixture();
  const h = mainHarness(initial, { preview: true });
  h.api.schedule();
  h.holdRead();
  const applying = h.call('apply-style-preset', 'one');
  assert.strictEqual(h.api.loading(), true);
  assert.strictEqual(h.timers.size, 0);
  assert.throws(() => h.call('apply-style-preset', 'one'), /正在套用/);
  assert.throws(() => h.call('save-settings', initial.settings), /正在套用/);
  assert.throws(() => h.call('resize-overlay', 600, 800), /正在套用/);
  assert.throws(() => h.call('delete-style-preset', 'one'), /正在套用/);
  assert.throws(() => h.call('set-close-action', 'quit'), /save/);
  assert.strictEqual(h.api.state().closeAction, initial.closeAction,
    'an unrelated immediate write cannot persist a partially applied preset');
  h.previewSettings(initial.settings);
  assert.strictEqual(h.published.length, 0);
  assert.deepStrictEqual(h.disk(), initial, 'in-flight resizing cannot persist partial state');
  h.releaseRead();
  await applying;
  assert.strictEqual(h.api.loading(), false);
  assert.strictEqual(h.api.resizeQueue(), null);
  assert.strictEqual(h.disk().settings.theme, 'glass');
});

test('failed application restores settings, dimensions, rendered output, and disk state', async () => {
  for (const preview of [false, true]) {
    const initial = stateFixture();
    const h = mainHarness(initial, { preview });
    h.failRename(true);
    await assert.rejects(h.call('apply-style-preset', 'one'), /保存失败/);
    assert.deepStrictEqual(plain(h.api.state()), initial);
    assert.deepStrictEqual(h.disk(), initial);
    assert.strictEqual(h.tempExists(), false);
    assert.strictEqual(h.api.loading(), false);
    assert.strictEqual(h.api.pendingTimers(), null);
    assert.deepStrictEqual(h.published.at(-1)[1].canvas, { width: 500, height: 700 });
    assert.strictEqual(h.published.at(-1)[1].settings.theme, 'tui');
    if (preview) assert.deepStrictEqual(h.window.getBounds(), { x: 80, y: 90, width: 500, height: 700 });
    h.failRename(false);
    assert.strictEqual((await h.call('apply-style-preset', 'one')).settings.theme, 'glass');
  }
});

(async () => {
  for (const { name, run } of cases) {
    await run();
    console.log('PASS ' + name);
  }
  console.log('Style preset tests passed: ' + cases.length);
})().catch((error) => { console.error(error); process.exitCode = 1; });
