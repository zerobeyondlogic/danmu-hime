(function (root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.DanmuEmotes = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  function safeEmoteUrl(rawUrl) {
    if (!rawUrl) return '';
    try {
      const normalized = String(rawUrl).replace(/^http:\/\//i, 'https://').replace(/^\/\//, 'https://');
      const url = new URL(normalized);
      const host = url.hostname.toLowerCase();
      if (url.protocol !== 'https:' || (!host.endsWith('.hdslb.com') && !host.endsWith('.bilibili.com'))) return '';
      return url.href;
    } catch (e) {
      return '';
    }
  }

  function normalizedEntry(entry, official) {
    if (!entry || typeof entry !== 'object') return null;
    const url = safeEmoteUrl(entry.url || entry.emoticon_url || entry.src);
    if (!url) return null;
    return {
      url,
      width: Number(entry.width) || 0,
      height: Number(entry.height) || 0,
      official: !!official
    };
  }

  function extractDanmakuEmotes(obj, info) {
    const emotes = {};
    const packetInfo = Array.isArray(info) ? info : [];

    function addMap(map) {
      if (!map || typeof map !== 'object') return;
      Object.keys(map).forEach((key) => {
        const entry = normalizedEntry(map[key], false);
        if (key && entry) emotes[key] = entry;
      });
    }

    function inspect(candidate) {
      if (!candidate) return;
      if (typeof candidate === 'string') {
        try { inspect(JSON.parse(candidate)); } catch (e) {}
        return;
      }
      if (typeof candidate !== 'object') return;
      addMap(candidate.emots);
      addMap(candidate.emoticons);
      if (candidate.extra) inspect(candidate.extra);
    }

    inspect(obj);
    inspect(obj && obj.data);
    const flags = Array.isArray(packetInfo[0]) ? packetInfo[0] : [];
    flags.forEach(inspect);

    // Bilibili's current DANMU_MSG format puts an official single-emote image
    // in info[0][13]. It represents the complete message in info[1].
    const direct = normalizedEntry(flags[13], true);
    const messageText = String(packetInfo[1] || '');
    if (direct && messageText) emotes[messageText] = direct;
    return emotes;
  }

  function buildRoomEmoteAliases(entries) {
    const aliases = {};
    (Array.isArray(entries) ? entries : []).forEach((source) => {
      const entry = normalizedEntry(source, true);
      if (!entry) return;
      const unique = String(source.unique || source.emoticon_unique || '').trim();
      const emoji = String(source.emoji || '').trim();
      const keys = [];
      if (unique) keys.push(unique, '[' + unique + ']');
      if (emoji) keys.push(emoji.startsWith('[') && emoji.endsWith(']') ? emoji : '[' + emoji + ']');
      keys.forEach((key) => {
        if (key) aliases[key] = entry;
      });
    });
    return aliases;
  }

  function mergeRoomEmotes(text, packetEmotes, roomAliases) {
    const source = String(text || '');
    const merged = Object.assign({}, packetEmotes || {});
    Object.keys(roomAliases || {}).forEach((key) => {
      if (!merged[key] && source.includes(key)) merged[key] = roomAliases[key];
    });
    return merged;
  }

  return {
    safeEmoteUrl,
    extractDanmakuEmotes,
    buildRoomEmoteAliases,
    mergeRoomEmotes
  };
});
