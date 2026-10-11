'use strict';

const { safeEmoteUrl } = require('../js/emotes.js');
const MAX_ROOMS = 8;
const MAX_IMAGES = 4096;
const SUCCESS_TTL = 10 * 60 * 1000;
const FAILURE_TTL = 60 * 1000;

// The gift catalogue only contains URLs. Fetch it on demand, once per room,
// instead of downloading every gift image when the application starts.
function createGiftImageLookup({ fetchCatalog, now = Date.now }) {
  const rooms = new Map();
  const pending = new Map();
  function id(value, allowZero = false) {
    const text = String(value ?? '');
    if (!/^\d{1,16}$/.test(text)) return '';
    const number = Number(text);
    return Number.isSafeInteger(number) && (allowZero ? number >= 0 : number > 0) ? String(number) : '';
  }
  async function catalogue(room) {
    const cached = rooms.get(room);
    if (cached && now() < cached.expiresAt) return cached.images;
    if (pending.has(room)) return pending.get(room);
    if (pending.size >= MAX_ROOMS) return new Map();
    const request = Promise.resolve().then(() => fetchCatalog(room)).then(body => {
      if (!body || body.code !== 0 || !Array.isArray(body.data?.list)) throw Error('Gift catalogue unavailable');
      const images = new Map();
      for (const gift of body.data.list.slice(0, MAX_IMAGES)) {
        const key = id(gift && gift.id);
        const url = safeEmoteUrl(gift && gift.img_basic);
        if (key && url) images.set(key, url);
      }
      return { images, expiresAt: now() + SUCCESS_TTL };
    }).catch(() => ({ images: new Map(), expiresAt: now() + FAILURE_TTL })).then(entry => {
      rooms.delete(room);
      rooms.set(room, entry);
      while (rooms.size > MAX_ROOMS) rooms.delete(rooms.keys().next().value);
      return entry.images;
    }).finally(() => pending.delete(room));
    pending.set(room, request);
    return request;
  }
  return {
    async lookup(giftId, roomId) {
      const gift = id(giftId), room = id(roomId || 0, true);
      if (!gift || !room) return { ok: false, giftImageUrl: '' };
      const giftImageUrl = (await catalogue(room)).get(gift) || '';
      return { ok: !!giftImageUrl, giftImageUrl };
    }
  };
}

module.exports = { createGiftImageLookup };
