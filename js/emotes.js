(function (root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.DanmuEmotes = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const MAX_EXTRA_LENGTH = 64 * 1024;
  const MAX_PACKET_EMOTES = 64;
  const MAX_ROOM_ALIASES = 2048;
  const validKey = key => typeof key === 'string' && key.length > 0 && key.length <= 120 &&
    key !== '__proto__' && key !== 'constructor' && key !== 'prototype';

  function safeEmoteUrl(rawUrl) {
    if (typeof rawUrl !== 'string' || !rawUrl || rawUrl.length > 2048) return '';
    try {
      const normalized = String(rawUrl).replace(/^http:\/\//i, 'https://').replace(/^\/\//, 'https://');
      const url = new URL(normalized);
      const host = url.hostname.toLowerCase();
      if (url.protocol !== 'https:' || url.username || url.password || (!host.endsWith('.hdslb.com') && !host.endsWith('.bilibili.com'))) return '';
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
    let remainingNodes = 64;
    let remainingEntries = MAX_PACKET_EMOTES;
    const visited = new WeakSet();

    function addMap(map) {
      if (!map || typeof map !== 'object') return;
      for (const key in map) {
        if (remainingEntries-- <= 0) break;
        if (!Object.hasOwn(map, key) || !validKey(key)) continue;
        const entry = normalizedEntry(map[key], false);
        if (entry) emotes[key] = entry;
      }
    }

    function inspect(candidate) {
      // Some packet extras contain another JSON-encoded extra. A bounded
      // iterative walk prevents malformed/deep metadata from dropping chat.
      while (candidate && remainingNodes-- > 0) {
        if (typeof candidate === 'string') {
          if (candidate.length > MAX_EXTRA_LENGTH) return;
          try { candidate = JSON.parse(candidate); } catch (_) { return; }
          continue;
        }
        if (typeof candidate !== 'object' || visited.has(candidate)) return;
        visited.add(candidate);
        addMap(candidate.emots);
        addMap(candidate.emoticons);
        candidate = candidate.extra;
      }
    }

    inspect(obj);
    inspect(obj && obj.data);
    const flags = Array.isArray(packetInfo[0]) ? packetInfo[0] : [];
    flags.slice(0, 32).forEach(inspect);

    // Bilibili's current DANMU_MSG format puts an official single-emote image
    // in info[0][13]. It represents the complete message in info[1].
    const direct = normalizedEntry(flags[13], true);
    const messageText = String(packetInfo[1] || '');
    if (direct && validKey(messageText)) emotes[messageText] = direct;
    return emotes;
  }

  function buildRoomEmoteAliases(entries) {
    const aliases = {};
    let size = 0;
    (Array.isArray(entries) ? entries.slice(0, 1024) : []).forEach((source) => {
      const entry = normalizedEntry(source, true);
      if (!entry) return;
      const unique = String(source.unique || source.emoticon_unique || '').trim();
      const emoji = String(source.emoji || '').trim();
      const keys = [];
      if (unique) keys.push(unique, '[' + unique + ']');
      if (emoji) keys.push(emoji.startsWith('[') && emoji.endsWith(']') ? emoji : '[' + emoji + ']');
      keys.forEach((key) => {
        if (validKey(key) && size < MAX_ROOM_ALIASES) {
          if (!Object.hasOwn(aliases, key)) size++;
          aliases[key] = entry;
        }
      });
    });
    return aliases;
  }

  function mergeRoomEmotes(text, packetEmotes, roomAliases) {
    const source = String(text || '').slice(0, 4000);
    const merged = {};
    let size = 0;
    for (const key in packetEmotes || {}) {
      if (size >= MAX_PACKET_EMOTES) break;
      if (Object.hasOwn(packetEmotes, key) && validKey(key)) { merged[key] = packetEmotes[key]; size++; }
    }
    let inspected = 0;
    for (const key in roomAliases || {}) {
      if (++inspected > MAX_ROOM_ALIASES || size >= MAX_PACKET_EMOTES) break;
      if (Object.hasOwn(roomAliases, key) && validKey(key) && !Object.hasOwn(merged, key) && source.includes(key)) {
        merged[key] = roomAliases[key]; size++;
      }
    }
    return merged;
  }

  return {
    safeEmoteUrl,
    extractDanmakuEmotes,
    buildRoomEmoteAliases,
    mergeRoomEmotes
  };
});
