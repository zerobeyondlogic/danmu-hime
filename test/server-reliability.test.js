'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const response = (value, cookie) => ({ ok: true, json: async () => value,
  headers: new Headers(cookie ? { 'set-cookie': cookie } : {}) });
function harness() {
  const file = path.join(__dirname, '../server.js'), localRequire = createRequire(file);
  const disk = new Map(), reads = [], calls = [], deadlines = [], intervals = new Map();
  let nextInterval = 0;
  let handler, fetcher = async () => response({ code: 0, data: [] }), failure = null;
  const server = new EventEmitter();
  Object.assign(server, { listen() { return server; }, address: () => ({ port: 49111 }) });
  const mockFs = {
    mkdirSync() {},
    readFileSync(file) { if (!disk.has(file)) throw Error('absent'); return disk.get(file); },
    writeFileSync(file, value) { disk.set(file, failure === 'write' ? String(value).slice(0, 4) : String(value)); if (failure === 'write') throw Error('disk full'); },
    renameSync(from, to) { if (failure === 'rename') throw Error('locked'); disk.set(to, disk.get(from)); disk.delete(from); },
    unlinkSync(file) { disk.delete(file); },
    readFile(file, callback) { reads.push(file); callback(null, Buffer.from('public asset')); }
  };
  const context = {
    __dirname: path.dirname(file), module: { exports: {} }, Buffer, URL, URLSearchParams,
    process: { env: { PORT: '0', HOST: '127.0.0.1', DANMU_DATA_DIR: 'D:/mock-server-profile' }, on() {} },
    require: id => id === 'http' ? { createServer(fn) { handler = fn; return server; } }
      : id === 'fs' ? mockFs : id === './relay.js' ? { createRelay: () => ({ shutDown() {} }) } : localRequire(id),
    fetch: (url, options) => { calls.push({ url: String(url), options }); return fetcher(String(url), options); },
    AbortSignal: { timeout(ms) { deadlines.push(ms); return new AbortController().signal; }, any: AbortSignal.any },
    setInterval: callback => { const id = ++nextInterval; intervals.set(id, callback); return id; },
    clearInterval: id => intervals.delete(id), console: { log() {}, warn() {}, error() {} }
  };
  vm.runInNewContext(fs.readFileSync(file, 'utf8') + `
    module.exports.audit = { apiFetch, getUserInfo, getWbiKey, proxyRoomInfo, proxyRoomEmotes,
      state:()=>({cookies,cachedUser,activeQrKey,qrGeneration,roomCacheSize:roomEmoteCache.size,roomCacheBytes:roomEmoteCacheBytes}),
      setBridge:setDesktopOutputBridge,outputStats:()=>({clients:desktopOutputClients.size,cleanups:desktopOutputCleanup.size}),
      seed(value){cookies=value;cachedUser=null;cookieRevision++;},cookieFile:COOKIE_FILE };
  `, context, { filename: file });
  const api = context.module.exports.audit;
  function request(url, headers = {}) {
    const res = { destroyed: false, writableEnded: false,
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(body) { this.body = String(body); this.writableEnded = true; } };
    const task = Promise.resolve(handler({ url, headers }, res));
    return { res, task, json: () => JSON.parse(res.body) };
  }
  function stream() {
    const req = Object.assign(new EventEmitter(), { url: '/api/desktop-output-events', headers: {} });
    const res = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false, writableLength: 0,
      writeHead() {}, write() { return true; }, end() { this.writableEnded = true; },
      destroy() { this.destroyed = true; this.emit('close'); } });
    return { req, res, task: Promise.resolve(handler(req, res)) };
  }
  return { api, disk, reads, calls, deadlines, request, stream, intervals,
    fetch: fn => { fetcher = fn; }, fail: value => { failure = value; } };
}
let passed = 0;
async function test(name, run) { await run(); passed++; console.log('PASS ' + name); }
async function generate(h, key = 'new-key') {
  h.fetch(async () => response({ code: 0, data: { qrcode_key: key, url: 'https://example.invalid/qr' } }));
  const req = h.request('/api/login/start'); await req.task;
  assert.equal(req.json().qrcodeKey, key);
}
(async () => {
  await test('API requests have a deadline and retain caller cancellation', async () => {
    const h = harness(), controller = new AbortController();
    await h.api.apiFetch('https://api.bilibili.com/test', { signal: controller.signal });
    const sent = h.calls[0].options.signal;
    assert.equal(sent.aborted, false); controller.abort(); assert.equal(sent.aborted, true);
    assert.deepEqual(h.deadlines, [8000]);
    h.fetch(async () => response({ code: 0, data: { wbi_img: {
      img_url: 'https://i0.hdslb.com/a.png', sub_url: 'https://i0.hdslb.com/b.png' } } }));
    await h.api.getWbiKey(); assert.equal(h.deadlines.at(-1), 8000);
  });
  await test('out-of-order QR generation cannot replace the latest key', async () => {
    const h = harness(), older = deferred(), newer = deferred(); let n = 0;
    h.fetch(() => (++n === 1 ? older : newer).promise);
    const a = h.request('/api/login/start'), b = h.request('/api/login/start');
    newer.resolve(response({ code: 0, data: { qrcode_key: 'current', url: 'current' } })); await b.task;
    older.resolve(response({ code: 0, data: { qrcode_key: 'old', url: 'old' } })); await a.task;
    assert.equal(a.res.status, 409); assert.equal(h.api.state().activeQrKey, 'current');
  });
  await test('logout invalidates an in-flight successful poll before it can write credentials', async () => {
    const h = harness(); h.api.seed({ SESSDATA: 'previous' }); await generate(h);
    const delayed = deferred(); h.fetch(() => delayed.promise);
    const poll = h.request('/api/login/poll?key=new-key');
    const logout = h.request('/api/login/logout'); await logout.task; assert.equal(logout.json().ok, true);
    delayed.resolve(response({ code: 0, data: { code: 0 } }, 'SESSDATA=stale; Path=/')); await poll.task;
    assert.deepEqual(plain(h.api.state().cookies), {});
    assert.deepEqual(JSON.parse(h.disk.get(h.api.cookieFile)), {});
    assert.equal(poll.json().ok, false);
  });
  await test('closing the response or refreshing the QR prevents an old poll from logging in', async () => {
    for (const action of ['close', 'refresh']) {
      const h = harness(); await generate(h); const delayed = deferred(); h.fetch(() => delayed.promise);
      const poll = h.request('/api/login/poll?key=new-key');
      if (action === 'close') poll.res.destroyed = true;
      else await generate(h, 'replacement');
      delayed.resolve(response({ code: 0, data: { code: 0 } }, 'SESSDATA=old; Path=/')); await poll.task;
      assert.deepEqual(plain(h.api.state().cookies), {}); assert.equal(h.disk.has(h.api.cookieFile), false);
    }
  });
  await test('login validates new credentials instead of reusing the previous account cache', async () => {
    const h = harness(); h.api.seed({ SESSDATA: 'old' }); await generate(h);
    h.fetch(async (url, options) => url.includes('qrcode/poll')
      ? response({ code: 0, data: { code: 0 } }, 'SESSDATA=new; Path=/')
      : (assert.match(options.headers.Cookie, /SESSDATA=new/), response({ code: 0, data: { isLogin: true, mid: 456, uname: 'new account' } })));
    const poll = h.request('/api/login/poll?key=new-key'); await poll.task;
    assert.equal(poll.json().uid, 456); assert.equal(h.api.state().cachedUser.uid, 456);
    assert.equal(JSON.parse(h.disk.get(h.api.cookieFile)).SESSDATA, 'new');
    assert.equal(h.api.state().activeQrKey, '');
  });
  await test('failed credential writes preserve old disk and memory state', async () => {
    for (const failure of ['write', 'rename']) {
      const h = harness(); h.api.seed({ SESSDATA: 'old' }); h.disk.set(h.api.cookieFile, '{"SESSDATA":"old"}');
      await generate(h); h.fail(failure);
      h.fetch(async url => url.includes('qrcode/poll') ? response({ code: 0, data: { code: 0 } }, 'SESSDATA=new; Path=/')
        : response({ code: 0, data: { isLogin: true, mid: 456, uname: 'new' } }));
      const poll = h.request('/api/login/poll?key=new-key'); await poll.task;
      assert.equal(poll.res.status, 502); assert.equal(h.api.state().cookies.SESSDATA, 'old');
      assert.equal(h.disk.get(h.api.cookieFile), '{"SESSDATA":"old"}');
      assert.equal(h.disk.has(h.api.cookieFile + '.tmp'), false);
      const logout = h.request('/api/login/logout'); await logout.task;
      assert.equal(logout.res.status, 502); assert.equal(h.api.state().cookies.SESSDATA, 'old');
    }
  });
  await test('an old account-status response cannot restore the logged-out cache', async () => {
    const h = harness(); h.api.seed({ SESSDATA: 'old' }); const delayed = deferred(); h.fetch(() => delayed.promise);
    const status = h.api.getUserInfo(); const logout = h.request('/api/login/logout'); await logout.task;
    delayed.resolve(response({ code: 0, data: { isLogin: true, mid: 123, uname: 'old' } }));
    assert.equal(await status, null); assert.equal(h.api.state().cachedUser, null);
  });
  await test('static HTTP serves UI resources without exposing profiles or root files', async () => {
    const h = harness();
    for (const url of ['/data/cookies.json', '/package.json', '/server.js', '/desktop/..%5c..%5cprivate.js']) {
      const r = h.request(url); await r.task; assert.equal(r.res.status, 403, url);
    }
    assert.equal(h.reads.length, 0);
    for (const url of ['/', '/desktop/overlay.html', '/js/protocol.js', '/desktop/fonts/zcool-kuaile/ZCOOLKuaiLe-Regular.woff2']) {
      const r = h.request(url); await r.task; assert.equal(r.res.status, 200, url);
    }
    const invalid = h.request('http://['); await invalid.task; assert.equal(invalid.res.status, 400);
    const jsonReply = h.request('/api/login/poll?key=absent'); await jsonReply.task;
    assert.equal(jsonReply.res.headers['Access-Control-Allow-Origin'], undefined);
  });
  await test('room emoticon cache has a bounded number of rooms', async () => {
    const h = harness(); h.fetch(async () => response({ code: 0, data: [] }));
    for (let i = 1; i <= 40; i++) await h.api.proxyRoomEmotes(String(i));
    assert.equal(h.api.state().roomCacheSize, 32);
  });
  await test('avatar overload preserves the retryable 503 status through the HTTP route', async () => {
    const h = harness(), gate = deferred(); h.fetch(() => gate.promise);
    const pending = Array.from({ length: 68 }, (_, i) => h.request('/api/user_avatar?uid=' + (i + 1)));
    const overflow = h.request('/api/user_avatar?uid=999'); await overflow.task;
    assert.equal(overflow.res.status, 503);
    gate.resolve(response({ code: 0, data: { card: { face: 'https://i0.hdslb.com/fixture.png' } } }));
    await Promise.all(pending.map(req => req.task));
    assert.ok(pending.every(req => req.json().ok));
  });
  await test('a foreign web page cannot log out or start a QR flow through the local server', async () => {
    const h = harness(); h.api.seed({ SESSDATA: 'local-account' });
    for (const headers of [{ 'sec-fetch-site': 'cross-site' }, { origin: 'https://example.invalid', host: '127.0.0.1:3000' }]) {
      for (const route of ['start', 'poll?key=x', 'logout']) {
        const req = h.request('/api/login/' + route, headers); await req.task;
        assert.equal(req.res.status, 403);
      }
    }
    assert.equal(h.api.state().cookies.SESSDATA, 'local-account');
    assert.equal(h.calls.length, 0); assert.equal(h.disk.size, 0);
    const local = h.request('/api/login/logout', { origin: 'http://127.0.0.1:3000', host: '127.0.0.1:3000' });
    await local.task; assert.equal(local.json().ok, true);
  });
  await test('room catalogues retain only usable bounded entries and obey a total cache-byte budget', async () => {
    const h = harness();
    const entries = Array.from({ length: 2500 }, (_, id) => ({ emoticon_unique: 'e' + id, emoji: 'e' + id,
      url: 'https://i0.hdslb.com/' + 'x'.repeat(1900) + id + '.png' }));
    entries.unshift({ emoticon_unique: 'invalid', url: 'https://i0.hdslb.com/' + 'x'.repeat(3000) });
    h.fetch(async () => response({ code: 0, data: [{ emoticons: entries }] }));
    for (let room = 1; room <= 10; room++) {
      const value = await h.api.proxyRoomEmotes(String(room));
      assert.equal(value.emotes.length, 1024); assert.equal(value.emotes[0].unique, 'e0');
      assert.ok(h.api.state().roomCacheBytes <= 8 * 1024 * 1024);
    }
    assert.ok(h.api.state().roomCacheSize < 10, 'byte eviction applies even below the 32-room item cap');
    const calls = h.calls.length; await h.api.proxyRoomEmotes('10'); assert.equal(h.calls.length, calls, 'current room still hits cache');
    await h.api.proxyRoomEmotes('1'); assert.equal(h.calls.length, calls + 1, 'evicted rooms can be refetched normally');
  });
  await test('one thousand SSE open/close/error cycles return clients, cleanup hooks and heartbeat timers to zero', async () => {
    const h = harness(); h.api.setBridge({ getState: () => ({ scene: { messages: [], revision: 0 } }) });
    for (let i = 0; i < 1000; i++) {
      const stream = h.stream(); await stream.task;
      assert.deepEqual(plain(h.api.outputStats()), { clients: 1, cleanups: 1 }); assert.equal(h.intervals.size, 1);
      if (i % 3 === 0) stream.req.emit('close');
      else if (i % 3 === 1) stream.res.emit('close');
      else stream.res.emit('error', new Error('output closed'));
      assert.deepEqual(plain(h.api.outputStats()), { clients: 0, cleanups: 0 }); assert.equal(h.intervals.size, 0);
      assert.equal(stream.req.listenerCount('close'), 0); assert.equal(stream.res.listenerCount('close'), 0); assert.equal(stream.res.listenerCount('error'), 0);
    }
  });
  console.log('Server reliability tests passed: ' + passed);
})().catch(error => { console.error(error); process.exitCode = 1; });
