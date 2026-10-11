'use strict';
const assert = require('node:assert/strict');
const { createGiftImageLookup } = require('../desktop/gift-images.js');
const catalogue = { code: 0, data: { list: [
  { id: 1, img_basic: 'https://i0.hdslb.com/flower.png' },
  { id: 2, img_basic: '//s1.hdslb.com/rocket.png' },
  { id: 3, img_basic: 'https://example.test/not-bilibili.png' }
] } };
(async () => {
  let calls = 0, now = 0;
  const lookup = createGiftImageLookup({ now: () => now, fetchCatalog: async () => { calls++; return catalogue; } });
  assert.equal(calls, 0, 'constructing the server must not fetch a gift catalogue');
  for (const [gift, room] of [[0, 1], [-1, 1], ['x', 1], [1, 'x'], [Number.MAX_SAFE_INTEGER + 1, 1]]) {
    assert.equal((await lookup.lookup(gift, room)).ok, false);
  }
  assert.equal(calls, 0);
  const [a,b,c] = await Promise.all([lookup.lookup(1,123),lookup.lookup(2,123),lookup.lookup(999,123)]);
  assert.deepEqual(a, { ok: true, giftImageUrl: 'https://i0.hdslb.com/flower.png' });
  assert.deepEqual(b, { ok: true, giftImageUrl: 'https://s1.hdslb.com/rocket.png' });
  assert.deepEqual(c, { ok: false, giftImageUrl: '' });
  assert.equal(calls,1,'concurrent cards share a single URL catalogue request');
  assert.equal((await lookup.lookup(3,123)).ok,false,'external image domains are rejected');
  await lookup.lookup(1,123);assert.equal(calls,1);
  now=600001;await lookup.lookup(1,123);assert.equal(calls,2);
  console.log('PASS lazy, validated, single-flight catalogue URLs with bounded lifetime');

  let failures = 0;
  const failed = createGiftImageLookup({ now: () => now, fetchCatalog: async () => { failures++;throw Error('offline'); } });
  await Promise.all([failed.lookup(1,123),failed.lookup(2,123)]);
  assert.equal(failures,1);
  await failed.lookup(1,123);assert.equal(failures,1);
  now+=60001;await failed.lookup(1,123);assert.equal(failures,2);
  console.log('PASS failed catalogue requests permit avatar fallback without repeated retries');

  let boundedCalls = 0;
  const bounded = createGiftImageLookup({ fetchCatalog: async () => { boundedCalls++;return catalogue; } });
  for(let room=1;room<=9;room++)await bounded.lookup(1,room);
  await bounded.lookup(1,9);assert.equal(boundedCalls,9);
  await bounded.lookup(1,1);assert.equal(boundedCalls,10,'old room URL catalogues are evicted');
  const limited = createGiftImageLookup({fetchCatalog:async()=>({code:0,data:{list:Array.from({length:4097},(_,index)=>({id:index+1,img_basic:'https://i0.hdslb.com/gift.png'}))}})});
  assert.equal((await limited.lookup(4096,1)).ok,true);
  assert.equal((await limited.lookup(4097,1)).ok,false);
  console.log('PASS room and catalogue item limits cap retained image metadata');
})().catch(error=>{console.error(error);process.exitCode=1;});
