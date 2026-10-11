'use strict';

const { safeEmoteUrl } = require('../js/emotes.js');

const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_CACHE_BYTES = 24 * 1024 * 1024;
const MAX_IMAGES = 48;
const MAX_AVATARS = 512;
const AVATAR_SUCCESS_TTL = 6 * 60 * 60 * 1000;
const AVATAR_FAILURE_TTL = 15000;

function mediaError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

function createLimiter(concurrency, maxWaiting) {
  let active = 0;
  const waiting = [];
  function run(task) {
    // Reject before retaining a task/key/promise in any pending collection.
    if (active >= concurrency && waiting.length >= maxWaiting) throw mediaError('Media request queue is full', 503);
    return new Promise((resolve, reject) => {
      function start() {
        active++;
        function finish() {
          active--;
          const next = waiting.shift();
          if (next) next();
        }
        Promise.resolve().then(task).then(value => { finish(); resolve(value); }, error => { finish(); reject(error); });
      }
      if (active < concurrency) start();
      else waiting.push(start);
    });
  }
  return { run, getStats: () => ({ active, queued: waiting.length }) };
}

async function cancelBody(response) {
  try { if (response && response.body && typeof response.body.cancel === 'function') await response.body.cancel(); } catch (_) {}
}

async function readImage(response, requestedUrl) {
  let contentType;
  try {
    if (!response || response.ok !== true) throw mediaError('Image request failed', 502);
    const finalUrl = response.url || requestedUrl;
    if (!safeEmoteUrl(finalUrl) || new URL(finalUrl).protocol !== 'https:') throw mediaError('Invalid image response URL', 502);
    contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!/^image\/[a-z0-9.+-]+$/.test(contentType)) throw mediaError('Invalid image response type', 502);
    const lengthHeader = response.headers.get('content-length');
    if (lengthHeader !== null) {
      const length = String(lengthHeader).trim();
      if (!/^\d{1,32}$/.test(length)) throw mediaError('Invalid image response length', 502);
      if (Number(length) > MAX_IMAGE_BYTES) throw mediaError('Image exceeds size limit', 413);
    }
    if (!response.body || typeof response.body.getReader !== 'function') throw mediaError('Image response has no stream', 502);
  } catch (error) {
    await cancelBody(response);
    throw error.statusCode ? error : mediaError('Invalid image response', 502);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw mediaError('Invalid image stream chunk', 502);
      bytes += value.byteLength;
      if (bytes > MAX_IMAGE_BYTES) throw mediaError('Image exceeds size limit', 413);
      if (value.byteLength) chunks.push(Buffer.from(value));
    }
    if (!bytes) throw mediaError('Image response is empty', 502);
    return { body: chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, bytes), contentType };
  } catch (error) {
    try { await reader.cancel(); } catch (_) {}
    throw error.statusCode ? error : mediaError('Image stream failed', 502);
  } finally {
    reader.releaseLock();
  }
}

function createMediaCache({ fetchImage, fetchAvatar, now = Date.now }) {
  const images = new Map(), avatars = new Map();
  const pendingImages = new Map(), pendingAvatars = new Map();
  const imageLimiter = createLimiter(8, 64), avatarLimiter = createLimiter(4, 64);
  let imageBytes = 0;

  function image(rawUrl) {
    const url = safeEmoteUrl(rawUrl);
    if (!url) return Promise.reject(mediaError('Invalid image URL', 400));
    if (images.has(url)) {
      const cached = images.get(url);
      images.delete(url); images.set(url, cached);
      return Promise.resolve(cached);
    }
    if (pendingImages.has(url)) return pendingImages.get(url);
    let request;
    try {
      request = imageLimiter.run(async () => {
        let response;
        try { response = await fetchImage(url); }
        catch (_) { throw mediaError('Image request failed', 502); }
        const result = await readImage(response, url);
        while (images.size >= MAX_IMAGES || imageBytes + result.body.length > MAX_CACHE_BYTES) {
          const oldest = images.keys().next().value;
          if (oldest === undefined) break;
          imageBytes -= images.get(oldest).body.length;
          images.delete(oldest);
        }
        images.set(url, result); imageBytes += result.body.length;
        return result;
      });
    } catch (error) { return Promise.reject(error); }
    const pending = request.finally(() => pendingImages.delete(url));
    pendingImages.set(url, pending);
    return pending;
  }

  function avatar(rawUid) {
    const text = typeof rawUid === 'number' ? String(rawUid) : rawUid;
    const uid = typeof text === 'string' && /^\d{1,16}$/.test(text) ? Number(text) : 0;
    if (!Number.isSafeInteger(uid) || uid <= 0) return Promise.resolve({ ok: false, avatarUrl: '' });
    const key = String(uid);
    const cached = avatars.get(key);
    const at = Number(now());
    if (cached && at >= cached.at && at < cached.expiresAt) {
      avatars.delete(key); avatars.set(key, cached);
      return Promise.resolve(cached.value);
    }
    if (cached) avatars.delete(key);
    if (pendingAvatars.has(key)) return pendingAvatars.get(key);
    let request;
    try {
      request = avatarLimiter.run(async () => {
        let value = { ok: false, avatarUrl: '' };
        try {
          const result = await fetchAvatar(key);
          const avatarUrl = result && result.ok === true ? safeEmoteUrl(result.avatarUrl) : '';
          if (avatarUrl) value = { ok: true, avatarUrl };
        } catch (_) {}
        const receivedAt = Number(now());
        avatars.delete(key);
        avatars.set(key, { at: receivedAt,
          expiresAt: receivedAt + (value.ok ? AVATAR_SUCCESS_TTL : AVATAR_FAILURE_TTL), value });
        while (avatars.size > MAX_AVATARS) avatars.delete(avatars.keys().next().value);
        return value;
      });
    } catch (error) { return Promise.reject(error); }
    const pending = request.finally(() => pendingAvatars.delete(key));
    pendingAvatars.set(key, pending);
    return pending;
  }

  return { image, avatar, getStats: () => ({
    images: { cached: images.size, bytes: imageBytes, inFlight: pendingImages.size, ...imageLimiter.getStats() },
    avatars: { cached: avatars.size, inFlight: pendingAvatars.size, ...avatarLimiter.getStats() }
  }) };
}

module.exports = { createMediaCache };
