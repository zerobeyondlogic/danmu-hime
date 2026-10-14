'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createRelay } = require('./relay.js');
const { createGiftImageLookup } = require('./desktop/gift-images.js');
const { createMediaCache } = require('./desktop/media-cache.js');
const { safeEmoteUrl: safeBilibiliImageUrl } = require('./js/emotes.js');

const ROOT = __dirname;
const APP_VERSION = String(require('./package.json').version || '');
const parsedPort = Number(process.env.PORT);
const PORT = Number.isInteger(parsedPort) && parsedPort >= 0 ? parsedPort : 3000;
const HOST = process.env.HOST || undefined;
const DATA_DIR = process.env.DANMU_DATA_DIR ? path.resolve(process.env.DANMU_DATA_DIR) : path.join(ROOT, 'data');
const COOKIE_FILE = path.join(DATA_DIR, 'cookies.json');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2'
};

const WBI_KEY_INDEX_TABLE = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13
];

let wbiKey = '';
let wbiKeyTime = 0;

let cookies = {};
let cachedUser = null;
let cachedUserTime = 0;
let cookieRevision = 0;
let qrGeneration = 0;
let activeQrKey = '';
const API_TIMEOUT_MS = 8000;
const roomEmoteCache = new Map();
const ROOM_EMOTE_CACHE_TTL = 10 * 60 * 1000;
const MAX_ROOM_EMOTE_CACHE = 32;
const MAX_ROOM_EMOTES = 1024;
const MAX_ROOM_EMOTE_BYTES = 8 * 1024 * 1024;
let roomEmoteCacheBytes = 0;
const mediaCache = createMediaCache({
  fetchImage: url => fetchWithTimeout(url, { headers: { 'User-Agent': UA, Referer: 'https://live.bilibili.com/' } }),
  fetchAvatar: fetchUserAvatar
});
const desktopOutputClients = new Set();
const desktopOutputCleanup = new Map();
const MAX_DESKTOP_OUTPUT_BUFFER = 1024 * 1024;
let desktopOutputBridge = null;
const giftImageLookup = createGiftImageLookup({
  async fetchCatalog(room) {
    // Verified public giftPanel API: data.list[].id / img_basic.
    const response = await apiFetch('https://api.live.bilibili.com/xlive/web-room/v1/giftPanel/giftConfig?platform=pc&source=live&room_id=' + encodeURIComponent(room), {
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error('Gift catalogue request failed');
    return response.json();
  }
});

function setDesktopOutputBridge(bridge) {
  const previous = desktopOutputBridge;
  desktopOutputBridge = bridge || null;
  if (previous && previous !== desktopOutputBridge && typeof previous.onSubscribersChanged === 'function') {
    try { previous.onSubscribersChanged(0); } catch (error) { console.warn('[desktop-output] subscriber callback failed:', error.message); }
  }
  notifyDesktopOutputSubscribers();
}

function notifyDesktopOutputSubscribers() {
  if (!desktopOutputBridge || typeof desktopOutputBridge.onSubscribersChanged !== 'function') return;
  try { desktopOutputBridge.onSubscribersChanged(desktopOutputClients.size); }
  catch (error) { console.warn('[desktop-output] subscriber callback failed:', error.message); }
}

function removeDesktopOutputClient(client) {
  const removed = desktopOutputClients.delete(client);
  const cleanup = desktopOutputCleanup.get(client);
  desktopOutputCleanup.delete(client);
  if (cleanup) cleanup();
  if (removed) notifyDesktopOutputSubscribers();
}

function disconnectDesktopOutputClient(client) {
  removeDesktopOutputClient(client);
  try { client.destroy(); } catch (_) {}
}

function writeDesktopOutputPayload(client, payload) {
  // write(false) alone is ordinary stream backpressure. Only a client whose
  // outstanding buffer exceeds 1 MiB is disconnected; EventSource can then
  // reconnect to the current scene instead of accumulating unlimited snapshots.
  if (client.destroyed || client.writableEnded || client.writableLength > MAX_DESKTOP_OUTPUT_BUFFER) {
    disconnectDesktopOutputClient(client);
    return false;
  }
  try {
    client.write(payload);
    if (client.writableLength > MAX_DESKTOP_OUTPUT_BUFFER) {
      disconnectDesktopOutputClient(client);
      return false;
    }
    return true;
  } catch (_) {
    disconnectDesktopOutputClient(client);
    return false;
  }
}

function desktopOutputEvent(type, data) {
  return 'event: ' + String(type || 'message') + '\n' +
    'data: ' + JSON.stringify(data === undefined ? null : data) + '\n\n';
}

function writeDesktopOutputEvent(client, type, data) {
  return writeDesktopOutputPayload(client, desktopOutputEvent(type, data));
}

function publishDesktopOutput(type, data) {
  if (!desktopOutputClients.size) return;
  // Scene publishers can supply a snapshot factory to avoid copying an
  // unused scene. All subscribers share one snapshot and serialization.
  const payload = desktopOutputEvent(type, typeof data === 'function' ? data() : data);
  for (const client of desktopOutputClients) {
    writeDesktopOutputPayload(client, payload);
  }
}

function loadCookies() {
  try {
    cookies = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
    if (!cookies || typeof cookies !== 'object' || Array.isArray(cookies)) cookies = {};
  } catch (e) {
    cookies = {};
  }
}

function saveCookies(value = cookies) {
  const temporary = COOKIE_FILE + '.tmp';
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
    fs.renameSync(temporary, COOKIE_FILE);
  } finally {
    try { fs.unlinkSync(temporary); } catch (_) {}
  }
}

function cookieHeader(value = cookies) {
  return Object.entries(value)
    .filter(([, v]) => typeof v === 'string' && v !== '')
    .map(([k, v]) => k + '=' + v)
    .join('; ');
}

function fetchWithTimeout(url, opts = {}) {
  const timeout = AbortSignal.timeout(API_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  return fetch(url, { ...opts, signal });
}

function apiFetch(url, opts) {
  const headers = Object.assign({
    'User-Agent': UA,
    Referer: 'https://live.bilibili.com/'
  }, (opts && opts.headers) || {});
  const cookie = cookieHeader();
  if (cookie !== '') headers.Cookie = cookie;
  return fetchWithTimeout(url, Object.assign({}, opts, { headers }));
}

async function lookupUser(value) {
  if (!value.SESSDATA) return null;
  try {
    const res = await fetchWithTimeout('https://api.bilibili.com/x/web-interface/nav', {
      headers: { 'User-Agent': UA, Referer: 'https://live.bilibili.com/', Cookie: cookieHeader(value) }
    });
    const j = await res.json();
    if (j.code === 0 && j.data && j.data.isLogin) return { uid: j.data.mid, uname: j.data.uname };
  } catch (_) {}
  return null;
}

async function getUserInfo() {
  if (!cookies.SESSDATA) return null;
  const now = Date.now();
  if (cachedUser && now - cachedUserTime < 5 * 60 * 1000) {
    return cachedUser;
  }
  const revision = cookieRevision;
  const user = await lookupUser(cookies);
  if (revision !== cookieRevision) return null;
  cachedUser = user;
  cachedUserTime = Date.now();
  return user;
}

function parseSetCookies(res, target = cookies) {
  let list = [];
  if (typeof res.headers.getSetCookie === 'function') {
    list = res.headers.getSetCookie();
  } else {
    const raw = res.headers.get('set-cookie');
    if (raw) list = raw.split(/,(?=\s*[^;,\s]+=[^;,\s]+)/);
  }
  for (const item of list) {
    const seg = item.split(';')[0].trim();
    const eq = seg.indexOf('=');
    if (eq <= 0) continue;
    const value = seg.slice(eq + 1).trim();
    try { target[seg.slice(0, eq).trim()] = decodeURIComponent(value); }
    catch (_) { target[seg.slice(0, eq).trim()] = value; }
  }
}

function json(res, code, data) {
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

async function getWbiKey() {
  if (wbiKey && Date.now() - wbiKeyTime < 6 * 60 * 60 * 1000) {
    return wbiKey;
  }
  const res = await fetchWithTimeout('https://api.bilibili.com/x/web-interface/nav', {
    headers: { 'User-Agent': UA }
  });
  const j = await res.json();
  const imgKey = j.data.wbi_img.img_url.split('/').pop().split('.')[0];
  const subKey = j.data.wbi_img.sub_url.split('/').pop().split('.')[0];
  const shuffled = imgKey + subKey;
  let key = '';
  for (const idx of WBI_KEY_INDEX_TABLE) {
    if (idx < shuffled.length) key += shuffled[idx];
  }
  wbiKey = key;
  wbiKeyTime = Date.now();
  return key;
}

function wbiSign(params) {
  const wts = Math.floor(Date.now() / 1000);
  const all = Object.assign({}, params, { wts });
  const str = Object.keys(all)
    .sort()
    .map((k) => {
      const v = String(all[k]).split('').filter((c) => !"!'()*".includes(c)).join('');
      return encodeURIComponent(k) + '=' + encodeURIComponent(v);
    })
    .join('&');
  const wRid = crypto.createHash('md5').update(str + wbiKey, 'utf8').digest('hex');
  return Object.assign({}, params, { wts, w_rid: wRid });
}

async function proxyRoomInfo(roomId) {
  const res = await apiFetch('https://api.live.bilibili.com/room/v1/Room/get_info?room_id=' + encodeURIComponent(roomId));
  const j = await res.json();
  if (j.code !== 0 || !j.data) {
    return { ok: false, error: j.message || ('code ' + j.code) };
  }
  return { ok: true, roomId: j.data.room_id, ownerUid: j.data.uid };
}

async function proxyEmoteImage(res, rawUrl) {
  const url = safeBilibiliImageUrl(rawUrl);
  if (!url) return json(res, 400, { ok: false, error: 'invalid emote image URL' });
  try {
    const image = await mediaCache.image(url);
    if (res.destroyed) return;
    res.writeHead(200, { 'Content-Type': image.contentType, 'Content-Length': image.body.length,
      'Cache-Control': 'public, max-age=3600' });
    res.end(image.body);
  } catch (error) {
    if (!res.destroyed) return json(res, error.statusCode || 502, { ok: false, error: error.message });
  }
}

async function fetchUserAvatar(uid) {
  const response = await apiFetch('https://api.bilibili.com/x/web-interface/card?mid=' + encodeURIComponent(uid), {
    headers: { Referer: 'https://space.bilibili.com/' + encodeURIComponent(uid) }
  });
  const body = await response.json();
  const avatarUrl = safeBilibiliImageUrl(body && body.code === 0 && body.data && body.data.card && body.data.card.face);
  return { ok: !!avatarUrl, avatarUrl };
}

function proxyUserAvatar(uid) {
  return mediaCache.avatar(uid);
}

async function proxyRoomEmotes(roomId) {
  const key = String(roomId);
  const cached = roomEmoteCache.get(key);
  if (cached && Date.now() - cached.time < ROOM_EMOTE_CACHE_TTL) return cached.value;

  const endpoint = 'https://api.live.bilibili.com/xlive/web-ucenter/v2/emoticon/GetEmoticons?platform=pc&room_id=' + encodeURIComponent(key);
  const res = await apiFetch(endpoint, {
    headers: { Referer: 'https://live.bilibili.com/' + encodeURIComponent(key) }
  });
  const body = await res.json();
  const packages = Array.isArray(body.data)
    ? body.data
    : (body.data && Array.isArray(body.data.data) ? body.data.data : null);
  if (body.code !== 0 || !packages) {
    return { ok: false, error: body.message || ('code ' + body.code), emotes: [] };
  }

  const emotes = [];
  const seen = new Set();
  const boundedName = value => typeof value === 'string' && value.length <= 120 ? value.trim() : '';
  let inspected = 0;
  for (const packageInfo of packages) {
    if (++inspected > 4096 || emotes.length >= MAX_ROOM_EMOTES) break;
    const entries = packageInfo && Array.isArray(packageInfo.emoticons) ? packageInfo.emoticons : [];
    for (const entry of entries) {
      if (++inspected > 4096 || emotes.length >= MAX_ROOM_EMOTES) break;
      const url = safeBilibiliImageUrl(entry && entry.url);
      const unique = boundedName(entry && entry.emoticon_unique);
      const emoji = boundedName(entry && entry.emoji);
      if (!url || (!unique && !emoji)) continue;
      const dedupeKey = unique + '\n' + emoji + '\n' + url;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      emotes.push({
        unique,
        emoji,
        url,
        width: Number(entry.width) || 0,
        height: Number(entry.height) || 0
      });
    }
  }

  const value = { ok: true, roomId: key, emotes };
  // Match the renderer's 1024-input limit and bound long-lived catalogue data
  // by estimated UTF-16 bytes as well as room count. No eviction timer needed.
  const bytes = JSON.stringify(value).length * 2;
  const previous = roomEmoteCache.get(key);
  if (previous) roomEmoteCacheBytes -= previous.bytes;
  roomEmoteCache.delete(key);
  roomEmoteCache.set(key, { time: Date.now(), value, bytes });
  roomEmoteCacheBytes += bytes;
  while (roomEmoteCache.size > MAX_ROOM_EMOTE_CACHE || roomEmoteCacheBytes > MAX_ROOM_EMOTE_BYTES) {
    const oldest = roomEmoteCache.keys().next().value;
    roomEmoteCacheBytes -= roomEmoteCache.get(oldest).bytes;
    roomEmoteCache.delete(oldest);
  }
  return value;
}

async function proxyDanmuInfo(roomId, retryWbi) {
  if (retryWbi !== false) {
    await getWbiKey();
  }
  const signed = wbiSign({ id: roomId, type: 0 });
  const qs = new URLSearchParams(signed).toString();
  const res = await apiFetch('https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?' + qs);
  const j = await res.json();
  if (j.code === -352 && retryWbi !== false) {
    wbiKey = '';
    return proxyDanmuInfo(roomId, false);
  }
  if (j.code !== 0 || !j.data) {
    return { ok: false, error: j.message || ('code ' + j.code) };
  }
  return {
    ok: true,
    hosts: j.data.host_list.map((h) => ({ host: h.host, wss_port: h.wss_port || 443 })),
    token: j.data.token || ''
  };
}

const server = http
  .createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); }
    catch (_) { return json(res, 400, { ok: false, error: 'invalid request URL' }); }
    const p = url.pathname;

    try {
      if (/^\/api\/login\/(?:start|poll|logout)$/.test(p)) {
        const origin = req.headers.origin;
        let foreignOrigin = false;
        try { foreignOrigin = !!origin && new URL(origin).origin !== new URL('http://' + req.headers.host).origin; }
        catch (_) { foreignOrigin = true; }
        if (foreignOrigin || req.headers['sec-fetch-site'] === 'cross-site') {
          return json(res, 403, { ok: false, error: 'cross-site account operation denied' });
        }
      }
      if (p === '/api/room_info') {
        const roomId = url.searchParams.get('roomId');
        if (!roomId) return json(res, 400, { ok: false, error: 'roomId required' });
        return json(res, 200, await proxyRoomInfo(roomId));
      }
      if (p === '/api/room_emotes') {
        const roomId = url.searchParams.get('roomId');
        if (!roomId || !/^\d+$/.test(roomId)) return json(res, 400, { ok: false, error: 'valid roomId required' });
        return json(res, 200, await proxyRoomEmotes(roomId));
      }
      if (p === '/api/user_avatar') {
        return json(res, 200, await proxyUserAvatar(url.searchParams.get('uid')));
      }
      if (p === '/api/emote_image') {
        return await proxyEmoteImage(res, url.searchParams.get('url'));
      }
      if (p === '/api/gift_image') {
        return json(res, 200, await giftImageLookup.lookup(url.searchParams.get('giftId'), url.searchParams.get('roomId')));
      }
      if (p === '/api/danmu_info') {
        const roomId = url.searchParams.get('roomId');
        if (!roomId) return json(res, 400, { ok: false, error: 'roomId required' });
        return json(res, 200, await proxyDanmuInfo(roomId));
      }
      if (p === '/api/login/start') {
        const generation = ++qrGeneration;
        activeQrKey = '';
        const r = await fetchWithTimeout('https://passport.bilibili.com/x/passport-login/web/qrcode/generate', {
          headers: { 'User-Agent': UA }
        });
        const j = await r.json();
        if (generation !== qrGeneration || res.destroyed) return json(res, 409, { ok: false, error: '二维码请求已取消' });
        if (j.code !== 0 || !j.data) {
          return json(res, 502, { ok: false, error: '生成二维码失败: ' + (j.message || j.code) });
        }
        activeQrKey = j.data.qrcode_key;
        return json(res, 200, { ok: true, qrcodeKey: activeQrKey, url: j.data.url });
      }
      if (p === '/api/login/poll') {
        const key = url.searchParams.get('key');
        if (!key) return json(res, 400, { ok: false, error: 'key required' });
        const generation = qrGeneration;
        const isCurrent = () => !res.destroyed && generation === qrGeneration && key === activeQrKey;
        if (!isCurrent()) return json(res, 200, { ok: false, step: '86038', message: '二维码已更新，请重新扫码' });
        const r = await fetchWithTimeout(
          'https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=' + encodeURIComponent(key) + '&source=main-fe-header',
          { headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' } }
        );
        const j = await r.json();
        if (!isCurrent()) return json(res, 200, { ok: false, step: '86038', message: '二维码请求已取消' });
        if (j.code === 0 && j.data && j.data.code === 0) {
          const candidate = { ...cookies };
          parseSetCookies(r, candidate);
          const user = await lookupUser(candidate);
          if (!isCurrent()) return json(res, 200, { ok: false, step: '86038', message: '二维码请求已取消' });
          if (!user) {
            return json(res, 200, { ok: false, step: 'validate-fail', message: '登录态验证失败，请重试' });
          }
          // Commit only the current, still-open login request, after validation.
          saveCookies(candidate);
          cookies = candidate;
          cookieRevision++;
          cachedUser = user;
          cachedUserTime = Date.now();
          activeQrKey = '';
          qrGeneration++;
          return json(res, 200, { ok: true, uid: user.uid, uname: user.uname });
        }
        const step = j.data ? String(j.data.code) : String(j.code);
        return json(res, 200, { ok: false, step, message: j.data ? j.data.message : j.message });
      }
      if (p === '/api/login/status') {
        const user = await getUserInfo();
        if (user) {
          return json(res, 200, { ok: true, loggedIn: true, uid: user.uid, uname: user.uname });
        }
        return json(res, 200, { ok: true, loggedIn: false });
      }
      if (p === '/api/login/logout') {
        qrGeneration++;
        activeQrKey = '';
        saveCookies({});
        cookies = {};
        cookieRevision++;
        cachedUser = null;
        return json(res, 200, { ok: true });
      }
      if (p === '/api/status') {
        const user = await getUserInfo();
        return json(res, 200, {
          ok: true,
          loggedIn: !!user,
          uid: user ? user.uid : 0,
          uname: user ? user.uname : '',
          buvid: cookies.buvid3 || ''
        });
      }
      if (p === '/api/desktop-output-state') {
        if (!desktopOutputBridge || typeof desktopOutputBridge.getState !== 'function') {
          return json(res, 404, { ok: false, error: 'desktop output unavailable' });
        }
        return json(res, 200, Object.assign({ ok: true }, desktopOutputBridge.getState() || {}));
      }
      if (p === '/api/desktop-output-events') {
        if (!desktopOutputBridge) return json(res, 404, { ok: false, error: 'desktop output unavailable' });
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no'
        });
        let timer = null;
        const onClose = () => removeDesktopOutputClient(res);
        const onError = () => disconnectDesktopOutputClient(res);
        desktopOutputCleanup.set(res, () => {
          if (timer !== null) clearInterval(timer);
          timer = null;
          req.removeListener('close', onClose);
          res.removeListener('close', onClose);
          res.removeListener('error', onError);
        });
        req.on('close', onClose);
        res.on('close', onClose);
        res.on('error', onError);
        desktopOutputClients.add(res);
        notifyDesktopOutputSubscribers();
        if (!writeDesktopOutputPayload(res, 'retry: 1000\n\n')) return;
        try {
          if (typeof desktopOutputBridge.getState === 'function') {
            const state = desktopOutputBridge.getState() || {};
            if (!writeDesktopOutputEvent(res, 'settings', state)) return;
            if (!writeDesktopOutputEvent(res, 'scene', state.scene || { revision: 0, messages: [] })) return;
          }
        } catch (_) {
          disconnectDesktopOutputClient(res);
          return;
        }
        timer = setInterval(() => {
          writeDesktopOutputPayload(res, ': keepalive\n\n');
        }, 15000);
        return;
      }
    } catch (e) {
      const status = Number.isInteger(e.statusCode) && e.statusCode >= 400 && e.statusCode <= 599 ? e.statusCode : 502;
      return json(res, status, { ok: false, error: String(e.message || e) });
    }

    let filePath;
    try { filePath = decodeURIComponent(p); }
    catch (_) { return json(res, 400, { ok: false, error: 'invalid path' }); }
    if (filePath === '/') filePath = '/index.html';
    const file = path.resolve(ROOT, '.' + filePath);
    const relative = path.relative(ROOT, file).split(path.sep).join('/');
    const publicAsset = relative === 'index.html' || /^(?:desktop|js|css)\/.*\.(?:html|css|js|svg|png|woff2)$/i.test(relative);
    if (!publicAsset || relative.startsWith('../') || path.isAbsolute(relative)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('404 Not Found');
        return;
      }
      const headers = {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store'
      };
      let body = data;
      if (file === path.join(ROOT, 'desktop', 'overlay.html')) {
        // A page that survives an application upgrade can compare its own
        // version with the new server, then request fresh HTML/JS/CSS once.
        const versionAttribute = APP_VERSION.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        body = data.toString('utf8')
          .replace('data-app-version=""', 'data-app-version="' + versionAttribute + '"')
          .replace(/\b(src|href)="([^"]+\.(?:js|css))"/g, (_match, attribute, url) =>
            attribute + '="' + url + '?v=' + encodeURIComponent(APP_VERSION) + '"');
      }
      res.writeHead(200, headers);
      res.end(body);
    });
  })
  .listen(PORT, HOST, () => {
    loadCookies();
    const address = server.address();
    const activePort = address && typeof address === 'object' ? address.port : PORT;
    console.log('B站礼物进度追踪已启动: http://localhost:' + activePort);
    if (cookies.SESSDATA) {
      getUserInfo().then((u) => {
        if (u) {
          console.log('已登录 B 站账号: ' + u.uname + ' (uid=' + u.uid + ')');
        } else {
          console.log('检测到 cookie 但登录态已失效，可重新扫码登录');
        }
      });
    }
  });

const relay = createRelay(server, {
  getUserInfo,
  roomInfoFetcher: proxyRoomInfo,
  danmuInfoFetcher: proxyDanmuInfo,
  getCookies: () => cookies
});
process.on('SIGINT', () => {
  relay.shutDown();
  process.exit(0);
});
process.on('SIGTERM', () => {
  relay.shutDown();
  process.exit(0);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('端口 ' + PORT + ' 已被占用。');
    console.error('可能是之前启动的服务器还在运行。解决方法：');
    console.error('  1. PowerShell 执行: Get-NetTCPConnection -LocalPort ' + PORT + ' -State Listen | Select OwningProcess');
    console.error('  2. 结束对应进程: Stop-Process -Id <PID> -Force');
    console.error('  3. 重新运行: node server.js');
    process.exit(1);
  }
  throw err;
});

module.exports = {
  server, relay, setDesktopOutputBridge, publishDesktopOutput,
  getRoomInfo: proxyRoomInfo,
  getRoomEmotes: proxyRoomEmotes
};
