'use strict';

const { randomUUID } = require('crypto');
const themes = require('./themes.js');

const MAX_STYLE_PRESETS = 30;

function record(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function boundedNumber(value, min, max, name) {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '' || String(value).length > 32) {
    throw new Error('预设中的' + name + '无效。');
  }
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error('预设中的' + name + '无效。');
  return Math.max(min, Math.min(max, number));
}

function normalizePresetName(value) {
  if (typeof value !== 'string') throw new Error('请输入预设名称。');
  const name = value.trim();
  if (!name || Array.from(name).length > 40 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error('预设名称须为 1–40 个字。');
  }
  return name;
}

function normalizePresetId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(value)) {
    throw new Error('预设不存在。');
  }
  return value;
}

function sanitizeStyleConfig(value, theme) {
  return themes.normalizePresetThemeConfig(theme, value).config;
}

function sanitizeStylePreset(value, id) {
  if (!record(value) || !themes.isKnownTheme(value.theme)) throw new Error('预设皮肤无效。');
  const appearance = themes.normalizePresetThemeConfig(value.theme, value.config);
  return {
    id: normalizePresetId(id === undefined ? value.id : id),
    name: normalizePresetName(value.name),
    theme: appearance.theme,
    width: Math.round(boundedNumber(value.width, 240, 3840, '宽度')),
    height: Math.round(boundedNumber(value.height, 160, 2160, '高度')),
    config: appearance.config
  };
}

function normalizeStylePresets(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  const ids = new Set();
  // Bound work even if an edited state file contains an excessive list.
  for (const item of value.slice(0, MAX_STYLE_PRESETS)) {
    try {
      const preset = sanitizeStylePreset(item);
      if (ids.has(preset.id)) continue;
      ids.add(preset.id);
      result.push(preset);
    } catch (e) {
      // A malformed saved item does not prevent the console from starting.
    }
  }
  return result;
}

function saveStylePreset(presets, value, createId = randomUUID) {
  if (!record(value)) throw new Error('预设数据无效。');
  const list = normalizeStylePresets(presets);
  const updating = value.id !== undefined;
  const id = updating ? normalizePresetId(value.id) : createId();
  const index = list.findIndex((item) => item.id === id);
  if (updating && index < 0) throw new Error('预设已被删除，请重新选择。');
  if (!updating && list.length >= MAX_STYLE_PRESETS) throw new Error('最多保存 30 个预设，请先删除不需要的预设。');
  if (!updating && index >= 0) throw new Error('预设编号重复，请重试。');
  const preset = sanitizeStylePreset(value, id);
  if (list.some((item) => item.id !== id && item.name === preset.name)) {
    throw new Error('已有同名预设，请换个名称或选择覆盖。');
  }
  if (updating) list[index] = preset;
  else list.push(preset);
  return { presets: list, preset };
}

function findStylePreset(presets, id) {
  const key = normalizePresetId(id);
  const preset = normalizeStylePresets(presets).find((item) => item.id === key);
  if (!preset) throw new Error('预设已被删除，请重新选择。');
  return preset;
}

function renameStylePreset(presets, id, name) {
  const preset = findStylePreset(presets, id);
  return saveStylePreset(presets, { ...preset, name });
}

function deleteStylePreset(presets, id) {
  const preset = findStylePreset(presets, id);
  return { presets: normalizeStylePresets(presets).filter((item) => item.id !== preset.id) };
}

function settingsForStylePreset(settings, preset) {
  const current = themes.migrateSettings(settings);
  const selected = sanitizeStylePreset(preset);
  return {
    ...current,
    theme: selected.theme,
    themeConfigVersion: themes.configVersion,
    themeConfigs: { ...(record(current.themeConfigs) ? current.themeConfigs : {}), [selected.theme]: { ...selected.config } }
  };
}

function restoreStylePresetId(state) {
  const saved = record(state) ? state : {};
  const presets = normalizeStylePresets(saved.stylePresets);
  if (saved.activeStylePresetId !== undefined) {
    return presets.some(preset => preset.id === saved.activeStylePresetId) ? saved.activeStylePresetId : '';
  }
  // Older versions stored the applied appearance, but not the preset identity.
  // Recover it only when the saved style and size identify a unique preset.
  const current = themes.migrateSettings(saved.settings);
  const canvas = saved.requestedPreviewSize || saved.previewSize || saved.overlayBounds || {};
  const matches = presets.filter(preset => preset.theme === current.theme &&
    preset.width === Number(canvas.width) && preset.height === Number(canvas.height) &&
    Object.keys(preset.config).every(key => key === 'baseWidth' || key === 'baseHeight' ||
      preset.config[key] === current.themeConfigs[current.theme][key]));
  return matches.length === 1 ? matches[0].id : '';
}

module.exports = {
  MAX_STYLE_PRESETS, normalizePresetName, sanitizeStyleConfig, sanitizeStylePreset,
  normalizeStylePresets, saveStylePreset, renameStylePreset, deleteStylePreset,
  findStylePreset, settingsForStylePreset, restoreStylePresetId
};
