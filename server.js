'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createRelay } = require('./relay.js');

const ROOT = __dirname;
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
const roomEmoteCache = new Map();
const ROOM_EMOTE_CACHE_TTL = 10 * 60 * 1000;
const emoteImageCache = new Map();
const MAX_EMOTE_IMAGE_CACHE = 48;
const MAX_EMOTE_IMAGE_BYTES = 3 * 1024 * 1024;
const userAvatarCache = new Map();
const USER_AVATAR_CACHE_TTL = 6 * 60 * 60 * 1000;
const MAX_USER_AVATAR_CACHE = 512;
const desktopOutputClients = new Set();
let desktopOutputBridge = null;

function setDesktopOutputBridge(bridge) {
  desktopOutputBridge = bridge || null;
}

function writeDesktopOutputEvent(client, type, data) {
  client.write('event: ' + String(type || 'message') + '\n' +
    'data: ' + JSON.stringify(data === undefined ? null : data) + '\n\n');
}

function publishDesktopOutput(type, data) {
  for (const client of desktopOutputClients) {
    try {
      writeDesktopOutputEvent(client, type, data);
    } catch (e) {
      desktopOutputClients.delete(client);
    }
  }
}

function loadCookies() {
  try {
    cookies = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
  } catch (e) {
    cookies = {};
  }
}

function saveCookies() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2));
  } catch (e) {
    console.error('保存 cookie 失败:', e.message);
  }
}

function cookieHeader() {
  return Object.entries(cookies)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => k + '=' + v)
    .join('; ');
}

function apiFetch(url, opts) {
  const headers = Object.assign({
    'User-Agent': UA,
    Referer: 'https://live.bilibili.com/'
  }, (opts && opts.headers) || {});
  const cookie = cookieHeader();
  if (cookie !== '') headers.Cookie = cookie;
  return fetch(url, Object.assign({}, opts, { headers }));
}

async function getUserInfo() {
  if (!cookies.SESSDATA) return null;
  const now = Date.now();
  if (cachedUser && now - cachedUserTime < 5 * 60 * 1000) {
    return cachedUser;
  }
  try {
    const res = await apiFetch('https://api.bilibili.com/x/web-interface/nav');
    const j = await res.json();
    if (j.code === 0 && j.data && j.data.isLogin) {
      cachedUser = { uid: j.data.mid, uname: j.data.uname };
      cachedUserTime = now;
      return cachedUser;
    }
  } catch (e) {}
  cachedUser = null;
  return null;
}

function parseSetCookies(res) {
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
    cookies[seg.slice(0, eq).trim()] = decodeURIComponent(seg.slice(eq + 1).trim());
  }
}

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

async function getWbiKey() {
  if (wbiKey && Date.now() - wbiKeyTime < 6 * 60 * 60 * 1000) {
    return wbiKey;
  }
  const res = await fetch('https://api.bilibili.com/x/web-interface/nav', {
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

function safeBilibiliImageUrl(rawUrl) {
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

async function proxyEmoteImage(res, rawUrl) {
  const url = safeBilibiliImageUrl(rawUrl);
  if (!url) return json(res, 400, { ok: false, error: 'invalid emote image URL' });

  let cached = emoteImageCache.get(url);
  if (!cached) {
    const upstream = await apiFetch(url, {
      headers: { Referer: 'https://live.bilibili.com/' }
    });
    const finalUrl = safeBilibiliImageUrl(upstream.url);
    const contentType = String(upstream.headers.get('content-type') || '').split(';')[0].toLowerCase();
    if (!upstream.ok || !finalUrl || !contentType.startsWith('image/')) {
      return json(res, 502, { ok: false, error: 'emote image fetch failed' });
    }
    const body = Buffer.from(await upstream.arrayBuffer());
    if (body.length > MAX_EMOTE_IMAGE_BYTES) {
      return json(res, 413, { ok: false, error: 'emote image too large' });
    }
    cached = { body, contentType };
    emoteImageCache.set(url, cached);
    while (emoteImageCache.size > MAX_EMOTE_IMAGE_CACHE) {
      emoteImageCache.delete(emoteImageCache.keys().next().value);
    }
  }

  res.writeHead(200, {
    'Content-Type': cached.contentType,
    'Content-Length': cached.body.length,
    'Cache-Control': 'public, max-age=3600'
  });
  res.end(cached.body);
}

async function proxyUserAvatar(uid) {
  const key = String(uid || '');
  if (!/^\d+$/.test(key) || key === '0') return { ok: false, avatarUrl: '' };
  const cached = userAvatarCache.get(key);
  if (cached && Date.now() - cached.time < USER_AVATAR_CACHE_TTL) return cached.value;
  let value = { ok: false, avatarUrl: '' };
  try {
    const response = await apiFetch('https://api.bilibili.com/x/web-interface/card?mid=' + encodeURIComponent(key), {
      headers: { Referer: 'https://space.bilibili.com/' + encodeURIComponent(key) }
    });
    const body = await response.json();
    const avatarUrl = safeBilibiliImageUrl(body && body.code === 0 && body.data && body.data.card && body.data.card.face);
    if (avatarUrl) value = { ok: true, avatarUrl };
  } catch (e) {}
  userAvatarCache.set(key, { time: Date.now(), value });
  while (userAvatarCache.size > MAX_USER_AVATAR_CACHE) {
    userAvatarCache.delete(userAvatarCache.keys().next().value);
  }
  return value;
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
  packages.forEach((packageInfo) => {
    const entries = packageInfo && Array.isArray(packageInfo.emoticons) ? packageInfo.emoticons : [];
    entries.forEach((entry) => {
      const url = safeBilibiliImageUrl(entry && entry.url);
      const unique = String(entry && entry.emoticon_unique || '').trim();
      const emoji = String(entry && entry.emoji || '').trim();
      if (!url || (!unique && !emoji)) return;
      const dedupeKey = unique + '\n' + emoji + '\n' + url;
      if (seen.has(dedupeKey)) return;
      seen.add(dedupeKey);
      emotes.push({
        unique,
        emoji,
        url,
        width: Number(entry.width) || 0,
        height: Number(entry.height) || 0
      });
    });
  });

  const value = { ok: true, roomId: key, emotes };
  roomEmoteCache.set(key, { time: Date.now(), value });
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
  .createServer(async (req, res) => {    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    try {
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
        return proxyEmoteImage(res, url.searchParams.get('url'));
      }
      if (p === '/api/danmu_info') {
        const roomId = url.searchParams.get('roomId');
        if (!roomId) return json(res, 400, { ok: false, error: 'roomId required' });
        return json(res, 200, await proxyDanmuInfo(roomId));
      }
      if (p === '/api/login/start') {
        const r = await fetch('https://passport.bilibili.com/x/passport-login/web/qrcode/generate', {
          headers: { 'User-Agent': UA }
        });
        const j = await r.json();
        if (j.code !== 0 || !j.data) {
          return json(res, 502, { ok: false, error: '生成二维码失败: ' + (j.message || j.code) });
        }
        return json(res, 200, { ok: true, qrcodeKey: j.data.qrcode_key, url: j.data.url });
      }
      if (p === '/api/login/poll') {
        const key = url.searchParams.get('key');
        if (!key) return json(res, 400, { ok: false, error: 'key required' });
        const r = await fetch(
          'https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=' + encodeURIComponent(key) + '&source=main-fe-header',
          { headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' } }
        );
        const j = await r.json();
        if (j.code === 0 && j.data && j.data.code === 0) {
          parseSetCookies(r);
          saveCookies();
          const user = await getUserInfo();
          if (!user) {
            return json(res, 200, { ok: false, step: 'validate-fail', message: '登录态验证失败，请重试' });
          }
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
        cookies = {};
        cachedUser = null;
        try {
          fs.rmSync(COOKIE_FILE, { force: true });
        } catch (e) {}
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
        res.write('retry: 1000\n\n');
        desktopOutputClients.add(res);
        if (typeof desktopOutputBridge.getState === 'function') {
          const state = desktopOutputBridge.getState() || {};
          writeDesktopOutputEvent(res, 'settings', state);
          writeDesktopOutputEvent(res, 'scene', state.scene || { revision: 0, messages: [] });
        }
        const timer = setInterval(() => {
          try { res.write(': keepalive\n\n'); } catch (e) {}
        }, 15000);
        req.on('close', () => {
          clearInterval(timer);
          desktopOutputClients.delete(res);
        });
        return;
      }
    } catch (e) {
      return json(res, 502, { ok: false, error: String(e.message || e) });
    }

    let filePath = p;
    if (filePath === '/') filePath = '/index.html';
    const file = path.join(ROOT, path.normalize(filePath));
    if (!file.startsWith(ROOT)) {
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
      const isCompressedPixelFont = file.endsWith('.fpb.gz');
      const headers = {
        'Content-Type': isCompressedPixelFont ? 'application/octet-stream' : (MIME[path.extname(file)] || 'application/octet-stream'),
        'Cache-Control': 'no-store'
      };
      if (isCompressedPixelFont) headers['Content-Encoding'] = 'gzip';
      res.writeHead(200, headers);
      res.end(data);
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

module.exports = { server, relay, setDesktopOutputBridge, publishDesktopOutput };
