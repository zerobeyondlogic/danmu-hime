'use strict';

const assert = require('node:assert/strict');
const { createMediaCache } = require('../desktop/media-cache.js');
const MiB = 1024 * 1024;
const url = id => 'https://i0.hdslb.com/' + id + '.png';
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(setImmediate);

function response(options = {}) {
  const state = { reads: 0, cancelled: 0, released: 0 };
  const chunks = options.chunks || [Buffer.from('image')];
  const headers = new Headers({ 'content-type': options.type || 'image/png',
    ...(options.length !== undefined ? { 'content-length': String(options.length) } : {}) });
  const cancel = async () => { state.cancelled++; };
  const value = { ok: options.ok !== false, url: options.url || url('final'), headers,
    arrayBuffer() { throw new Error('Never buffer the whole response before checking its size'); },
    body: { cancel, getReader: () => ({
      async read() {
        const index = state.reads++;
        if (options.failAt === index) throw new Error('Broken network stream');
        return index < chunks.length ? { done: false, value: chunks[index] } : { done: true };
      }, cancel, releaseLock() { state.released++; }
    }) }
  };
  return { value, state };
}

let passed = 0;
async function test(name, run) { await run(); passed++; console.log('PASS ' + name); }

(async () => {
  await test('same image URL merges in-flight requests and then serves one cached Buffer', async () => {
    const gate = deferred(); let calls = 0;
    const c = createMediaCache({ fetchImage: async () => { calls++; await gate.promise; return response().value; }, fetchAvatar: async () => ({ ok: false }) });
    const first = c.image(url(1)), same = c.image('//i0.hdslb.com/1.png'); assert.strictEqual(first, same);
    await tick(); assert.equal(calls, 1); gate.resolve(); const value = await first;
    assert.equal(value.body.toString(), 'image'); assert.equal(value.contentType, 'image/png');
    assert.strictEqual((await c.image(url(1))).body, value.body); assert.equal(calls, 1);
    assert.deepEqual(c.getStats().images, { cached: 1, bytes: 5, inFlight: 0, active: 0, queued: 0 });
  });

  await test('invalid redirects, content types, status and oversized Content-Length cancel before reading', async () => {
    for (const options of [{ url: 'https://example.test/x.png' }, { url: 'http://i0.hdslb.com/x.png' },
      { url: 'https://user:secret@i0.hdslb.com/x.png' }, { type: 'text/html' }, { ok: false }, { length: 3 * MiB + 1 }]) {
      const r = response(options); const c = createMediaCache({ fetchImage: async () => r.value, fetchAvatar: async () => ({ ok: false }) });
      await assert.rejects(c.image(url(1)), error => error.statusCode === (options.length ? 413 : 502));
      assert.equal(r.state.reads, 0); assert.equal(r.state.cancelled, 1); assert.equal(c.getStats().images.cached, 0);
    }
    let called = false; const c = createMediaCache({ fetchImage: async () => { called = true; }, fetchAvatar: async () => ({ ok: false }) });
    await assert.rejects(c.image('https://example.test/image.png'), error => error.statusCode === 400); assert.equal(called, false);
  });

  await test('streaming byte accounting stops at the offending chunk even when Content-Length lies', async () => {
    const r = response({ length: 1, chunks: [Buffer.alloc(2 * MiB), Buffer.alloc(MiB + 1), Buffer.from('must not read')] });
    const c = createMediaCache({ fetchImage: async () => r.value, fetchAvatar: async () => ({ ok: false }) });
    await assert.rejects(c.image(url(1)), error => error.statusCode === 413);
    assert.equal(r.state.reads, 2); assert.equal(r.state.cancelled, 1); assert.equal(r.state.released, 1);
    assert.deepEqual(c.getStats().images, { cached: 0, bytes: 0, inFlight: 0, active: 0, queued: 0 });
    const exact = createMediaCache({ fetchImage: async () => response({ chunks: [Buffer.alloc(MiB), Buffer.alloc(2 * MiB)] }).value, fetchAvatar: async () => ({ ok: false }) });
    assert.equal((await exact.image(url(2))).body.length, 3 * MiB);
  });

  await test('image errors release readers and pending keys so the next request can recover', async () => {
    const broken = response({ failAt: 0 }); let calls = 0;
    const c = createMediaCache({ fetchImage: async () => ++calls === 1 ? broken.value : response().value, fetchAvatar: async () => ({ ok: false }) });
    await assert.rejects(c.image(url(1)), error => error.statusCode === 502);
    assert.equal(broken.state.cancelled, 1); assert.equal(broken.state.released, 1);
    assert.equal((await c.image(url(1))).body.toString(), 'image'); assert.equal(calls, 2);
    assert.equal(c.getStats().images.inFlight, 0);
  });

  await test('image concurrency is eight plus 64 waiting, overflow retains no extra key and failure drains the queue', async () => {
    const gate = deferred(); let active = 0, maxActive = 0, calls = 0;
    const c = createMediaCache({ fetchImage: async imageUrl => {
      active++; calls++; maxActive = Math.max(maxActive, active);
      await gate.promise; active--; if (imageUrl === url(0)) throw new Error('network failed'); return response().value;
    }, fetchAvatar: async () => ({ ok: false }) });
    const requests = Array.from({ length: 72 }, (_, id) => c.image(url(id))); const all = Promise.allSettled(requests);
    assert.strictEqual(c.image(url(0)), requests[0]);
    for (let id = 72; id < 172; id++) await assert.rejects(c.image(url(id)), error => error.statusCode === 503);
    assert.deepEqual(c.getStats().images, { cached: 0, bytes: 0, inFlight: 72, active: 8, queued: 64 });
    assert.equal(calls, 8); gate.resolve(); const results = await all;
    assert.equal(results.filter(result => result.status === 'rejected').length, 1); assert.equal(calls, 72); assert.equal(maxActive, 8);
    assert.equal(c.getStats().images.active, 0); assert.equal(c.getStats().images.queued, 0); assert.equal(c.getStats().images.inFlight, 0);
    assert.equal(c.getStats().images.cached, 48); assert.equal(c.getStats().images.bytes, 48 * 5);
  });

  await test('image LRU eviction obeys both 48 entries and 24 MiB with exact byte accounting', async () => {
    const calls = new Map();
    const c = createMediaCache({ fetchImage: async key => { calls.set(key, (calls.get(key) || 0) + 1); return response({ chunks: [Buffer.alloc(3 * MiB)] }).value; }, fetchAvatar: async () => ({ ok: false }) });
    for (let id = 0; id < 8; id++) await c.image(url(id));
    await c.image(url(0)); await c.image(url(8));
    assert.equal(c.getStats().images.cached, 8); assert.equal(c.getStats().images.bytes, 24 * MiB);
    await c.image(url(0)); assert.equal(calls.get(url(0)), 1, 'recently read image remains cached');
    await c.image(url(1)); assert.equal(calls.get(url(1)), 2, 'least recently used image was evicted');
    assert.equal(c.getStats().images.bytes, 24 * MiB);
  });

  await test('avatar failures have a 15 second negative cache and recover to a six hour success cache', async () => {
    let at = 1000, calls = 0;
    const c = createMediaCache({ now: () => at, fetchImage: async () => response().value,
      fetchAvatar: async () => { if (++calls === 1) throw new Error('temporarily unavailable'); return { ok: true, avatarUrl: url('avatar') }; } });
    assert.deepEqual(await c.avatar(42), { ok: false, avatarUrl: '' }); at += 14999;
    assert.equal((await c.avatar('0042')).ok, false); assert.equal(calls, 1); at++;
    assert.equal((await c.avatar('42')).ok, true); assert.equal(calls, 2); at += 6 * 60 * 60 * 1000 - 1;
    await c.avatar(42); assert.equal(calls, 2); at++;
    await c.avatar(42); assert.equal(calls, 3);
  });

  await test('avatar same-UID work coalesces with four active and 64 waiting; overload does not negative-cache', async () => {
    const gate = deferred(); let calls = 0;
    const c = createMediaCache({ fetchImage: async () => response().value,
      fetchAvatar: async () => { calls++; await gate.promise; return { ok: true, avatarUrl: url('avatar') }; } });
    const requests = Array.from({ length: 68 }, (_, id) => c.avatar(id + 1));
    assert.strictEqual(c.avatar('0001'), requests[0]);
    await assert.rejects(c.avatar(100), error => error.statusCode === 503);
    assert.deepEqual(c.getStats().avatars, { cached: 0, inFlight: 68, active: 4, queued: 64 }); assert.equal(calls, 4);
    gate.resolve(); await Promise.all(requests); assert.equal(calls, 68);
    assert.equal((await c.avatar(100)).ok, true); assert.equal(calls, 69);
    assert.equal(c.getStats().avatars.active, 0); assert.equal(c.getStats().avatars.inFlight, 0);
  });

  await test('avatar cache stays at 512, invalid UIDs do not fetch and LRU hits preserve recent entries', async () => {
    const calls = new Map();
    const c = createMediaCache({ fetchImage: async () => response().value,
      fetchAvatar: async key => { calls.set(key, (calls.get(key) || 0) + 1); return { ok: true, avatarUrl: url('avatar') }; } });
    for (const uid of [0, -1, Infinity, NaN, {}, false, 'not-a-uid', '1'.repeat(17)]) assert.equal((await c.avatar(uid)).ok, false);
    assert.equal(calls.size, 0);
    for (let uid = 1; uid <= 512; uid++) await c.avatar(uid);
    await c.avatar(1); await c.avatar(513); await c.avatar(1); assert.equal(calls.get('1'), 1);
    await c.avatar(2); assert.equal(calls.get('2'), 2); assert.equal(c.getStats().avatars.cached, 512);
  });

  console.log(passed + ' media cache tests passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
