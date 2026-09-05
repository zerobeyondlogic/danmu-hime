(function (root) {
  'use strict';

  function normalizeUrl(value) {
    const source = value && typeof value === 'object' ? (value.url || value.src) : value;
    const text = String(source || '').trim();
    if (!text) return '';
    if (text.startsWith('//')) return 'https:' + text;
    if (/^http:\/\//i.test(text)) return text.replace(/^http:/i, 'https:');
    return /^https:\/\//i.test(text) ? text : '';
  }

  function readExtra(value) {
    if (!value) return null;
    if (typeof value === 'object') return value;
    if (typeof value !== 'string' || value[0] !== '{') return null;
    try {
      return JSON.parse(value);
    } catch (e) {
      return null;
    }
  }

  function firstUrl(values) {
    for (const value of values) {
      const normalized = normalizeUrl(value);
      if (normalized) return normalized;
    }
    return '';
  }

  function extractDanmakuAvatar(obj, info) {
    const packet = obj || {};
    const source = Array.isArray(info) ? info : (Array.isArray(packet.info) ? packet.info : []);
    const meta = Array.isArray(source[0]) ? source[0] : [];
    const extra = readExtra(meta[15]) || readExtra(packet.extra) || {};
    const data = packet.data || {};
    return firstUrl([
      extra.user && extra.user.base && extra.user.base.face,
      extra.user && extra.user.face,
      extra.user_info && extra.user_info.face,
      data.user && data.user.base && data.user.base.face,
      data.user && data.user.face,
      data.user_info && data.user_info.face,
      data.sender_uinfo && data.sender_uinfo.base && data.sender_uinfo.base.face,
      packet.user && packet.user.base && packet.user.base.face
    ]);
  }

  function extractEventAvatar(obj) {
    const data = obj && obj.data ? obj.data : {};
    return firstUrl([
      data.sender_uinfo && data.sender_uinfo.base && data.sender_uinfo.base.face,
      data.user_info && data.user_info.face,
      data.user && data.user.base && data.user.base.face,
      data.user && data.user.face,
      data.uinfo && data.uinfo.base && data.uinfo.base.face,
      data.face
    ]);
  }

  root.DanmuAvatars = { normalizeUrl, extractDanmakuAvatar, extractEventAvatar };
})(typeof window !== 'undefined' ? window : globalThis);
