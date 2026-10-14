'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const themes = require('../desktop/themes.js');
const { createLiveScene } = require('../desktop/live-scene.js');

const plain = value => JSON.parse(JSON.stringify(value));
function harness({ subscribers = 1 } = {}) {
  const app = new EventEmitter();
  Object.assign(app, {
    requestSingleInstanceLock: () => true,
    whenReady: () => ({ then: () => ({ catch() {} }) }), getVersion: () => 'test'
  });
  let now = 1789050000000, nextTimer = 0;
  const timers = new Map(), published = [];
  const mainPath = path.join(__dirname, '../desktop/main.js');
  const localRequire = createRequire(mainPath);
  const context = {
    require: id => id === 'electron' ? { app } : localRequire(id),
    __dirname: path.dirname(mainPath), process: { platform: 'win32' }, console,
    Date: class extends Date { static now() { return now; } },
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout: id => timers.delete(id)
  };
  vm.runInNewContext(fs.readFileSync(mainPath, 'utf8') + `
    globalThis.welcomeTest = {
      entry: addWelcomeMessage, add: addSceneMessage, clear: clearScene,
      snapshot: sceneSnapshot,
      subscribers(count) { messagePlayback.setActive(count > 0); },
      stats: () => messagePlayback.getStats(),
      settings(value) { appState.settings = themes.migrateSettings(value); },
      output(value) { embedded = value; }
    };
  `, context, { filename: mainPath });
  const api = context.welcomeTest;
  api.settings({ theme: 'glass' });
  api.output({ publishDesktopOutput: (type, get) => published.push({ type, state: plain(typeof get === 'function' ? get() : get) }) });
  api.subscribers(subscribers);
  function advance(ms) {
    const end = now + ms;
    while (true) {
      const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at; timers.delete(due[0]); due[1].callback();
    }
    now = end;
  }
  return { api, app, timers, published, advance, now: () => now };
}

let passed = 0;
function ok(name) { console.log('PASS ' + name); passed++; }

(async () => {
  const fixed = harness();
  fixed.api.settings({ theme: 'glass', themeConfigs: { glass: { welcomeMode: 'single', welcomeDuration: 3 } } });
  const chat = fixed.api.add({ type: 'chat', text: '保留普通弹幕' });
  for (let uid = 1; uid <= 100; uid++) fixed.api.entry({ uid, uname: '单行观众' + uid, at: 1 });
  assert.deepEqual(plain(fixed.api.snapshot().messages).map(message => message.id), [chat.id]);
  assert.equal(fixed.api.stats().pending, 0);
  assert.equal(fixed.api.snapshot().latestWelcome.uid, 100);
  assert.equal(fixed.api.snapshot().latestWelcome.receivedAt, fixed.now(), 'expiry uses local receipt, not upstream time');
  const copied = fixed.api.snapshot(); copied.latestWelcome.uname = '不能修改源消息';
  assert.equal(fixed.api.snapshot().latestWelcome.uname, '单行观众100');
  fixed.api.clear();
  assert.equal(fixed.published.at(-1).state.latestWelcome, null);
  fixed.api.settings({ theme: 'glass', themeConfigs: { glass: { welcomeMode: 'scroll' } } });
  fixed.api.entry({ uid: 101, uname: '滚动观众' });
  assert.equal(fixed.api.snapshot().messages[0].uid, 101);
  assert.equal(fixed.api.snapshot().latestWelcome.uid, 101);
  ok('single welcomes replace one timed slot without queueing or evicting chat, clear removes it, and scroll mode resumes normally');

  const h = harness();
  const receipt = h.api.entry({ uid: 7, uname: '欢迎观众', avatarUrl: 'https://i0.hdslb.com/arrival.png', at: h.now() });
  assert.equal(receipt.type, 'welcome');
  assert.equal(receipt.kind, 'welcome');
  assert.equal(receipt.text, '欢迎 欢迎观众 进入直播间');
  assert.equal(receipt.uid, 7);
  assert.equal(receipt.avatarUrl, 'https://i0.hdslb.com/arrival.png');
  assert.equal(Object.hasOwn(receipt, 'expiresAt'), false);
  h.advance(60000);
  assert.equal(h.api.snapshot().messages[0].id, receipt.id);
  assert.equal(h.timers.size, 0, 'there are no per-welcome expiry timers');
  assert.equal(h.published.length, 1);
  assert.equal(h.published[0].type, 'scene');
  ok('welcomes use the shared scene and remain after the old three-second timeout');

  h.api.add({ type: 'chat', text: '新弹幕' });
  h.api.add({ type: 'gift', text: '赠送 小花花', valueYuan: 20 });
  assert.deepEqual(plain(h.api.snapshot().messages).map(m => m.type), ['welcome', 'chat']);
  assert.equal(h.api.stats().pending, 1, 'the gift is queued separately from played history');
  assert.equal(h.api.snapshot().messages[0].id, receipt.id);
  h.advance(100);
  assert.deepEqual(plain(h.api.snapshot().messages).map(m => m.type), ['welcome', 'chat', 'gift']);
  assert.equal(h.api.stats().pending, 0);
  assert.deepEqual(h.published.map(item => item.state.messages.at(-1).type), ['welcome', 'chat', 'gift']);
  ok('chat and gifts are published one at a time after the unchanged welcome in arrival order');

  const artwork = harness();
  artwork.api.add({ type: 'gift', giftId: '35208', giftImageUrl: '//i0.hdslb.com/gift.png', valueYuan: 10.4 });
  artwork.api.add({ type: 'gift', giftId: -1, giftImageUrl: 'https://example.test/gift.png', valueYuan: 20 });
  artwork.api.add({ type: 'gift', giftId: true, giftImageUrl: 'https://i0.hdslb.com/' + 'a'.repeat(2048) });
  assert.equal(artwork.api.stats().pending, 2);
  assert.equal(artwork.api.snapshot().messages.length, 1);
  artwork.advance(300);
  const publishedArtwork = artwork.published.at(-1).state.messages;
  assert.equal(publishedArtwork[0].giftId, 35208);
  assert.equal(publishedArtwork[0].giftImageUrl, 'https://i0.hdslb.com/gift.png');
  assert.equal(publishedArtwork[0].valueYuan, 10.4);
  for (const message of publishedArtwork.slice(1)) {
    assert.equal(Object.hasOwn(message, 'giftId'), false);
    assert.equal(Object.hasOwn(message, 'giftImageUrl'), false);
  }
  assert.equal(publishedArtwork[1].valueYuan, 20);
  assert.equal(artwork.api.stats().pending, 0);
  ok('queued gift publication preserves safe artwork and rejects invalid IDs and image URLs');

  const hidden = harness();
  hidden.api.add({ type: 'chat', text: '保留普通弹幕' });
  for (const theme of themes.ids) {
    hidden.api.settings({ theme, themeConfigs: { [theme]: { showWelcome: false } } });
    for (let uid = 1; uid < 100; uid++) assert.equal(hidden.api.entry({ uid, uname: '关闭期间' }), null);
  }
  assert.equal(hidden.api.snapshot().messages.length, 1);
  assert.equal(hidden.api.stats().pending, 0, 'disabled welcomes never enter the pending queue');
  hidden.api.settings({ theme: 'glass' });
  hidden.api.entry({ uid: 999, uname: '重新开启' });
  assert.equal(hidden.api.snapshot().messages.length, 1);
  assert.equal(hidden.api.stats().pending, 1);
  hidden.advance(100);
  assert.equal(hidden.api.snapshot().messages.length, 2);
  ok('disabled welcomes never enter pending or played history and each theme can enable them again');

  const bounded = harness();
  const sc = bounded.api.add({ type: 'sc', text: '置顶留言', valueYuan: 50 });
  for (let uid = 1; uid <= 100; uid++) bounded.api.entry({ uid, uname: '进房观众' + uid });
  assert.equal(bounded.api.snapshot().messages.length, 2, 'SC and only the first welcome are initially played');
  assert.equal(bounded.api.stats().pending, 99, 'all remaining receipts survive outside the 48 played slots');
  assert.equal(bounded.api.stats().skipped, 0);
  bounded.advance(2200);
  const scene = plain(bounded.api.snapshot());
  assert.equal(scene.messages.length, 49);
  assert.equal(scene.messages[0].id, sc.id);
  assert.equal(scene.messages[1].uid, 53);
  assert.equal(scene.messages.at(-1).uid, 100);
  assert.equal(bounded.api.stats().pending, 0);
  assert.equal(bounded.api.stats().skipped, 0);
  const seen = new Set(), arrivalOrder = [];
  for (const item of bounded.published) {
    const fresh = item.state.messages.filter(message => message.type === 'welcome' && !seen.has(message.id));
    assert.ok(fresh.length <= 1, 'a played scene never introduces several queued welcomes together');
    fresh.forEach(message => { seen.add(message.id); arrivalOrder.push(message.uid); });
    assert.ok(item.state.messages.filter(message => message.type !== 'sc').length <= 48);
  }
  assert.deepEqual(arrivalOrder, Array.from({ length: 100 }, (_, index) => index + 1), 'every welcome gets a dispatch before played history is pruned');
  bounded.api.entry({ uid: 101, uname: '清空前已出场' });
  bounded.api.entry({ uid: 102, uname: '清空前尚未出场' });
  assert.ok(bounded.api.stats().pending > 0);
  bounded.api.clear();
  assert.equal(bounded.api.stats().pending, 0);
  assert.equal(bounded.api.stats().pendingBytes, 0);
  bounded.advance(10000);
  assert.deepEqual(plain(bounded.api.snapshot().messages), []);
  assert.deepEqual(bounded.published.at(-1).state.messages, []);
  assert.equal(bounded.timers.size, 0);
  ok('100 queued welcomes all dispatch before 48-item played pruning and clear cancels pending and played entries');

  const immediateSc = harness();
  for (let uid = 1; uid <= 10; uid++) immediateSc.api.entry({ uid, uname: '排队观众' + uid });
  assert.equal(immediateSc.api.stats().pending, 9);
  const fastSc = immediateSc.api.add({ type: 'sc', text: '无需等待普通队列', valueYuan: 30 });
  assert.equal(immediateSc.api.stats().pending, 9);
  assert.equal(immediateSc.api.snapshot().messages.some(message => message.id === fastSc.id), true);
  assert.equal(immediateSc.published.at(-1).state.messages.some(message => message.id === fastSc.id), true);
  immediateSc.advance(1000);
  assert.equal(immediateSc.api.stats().pending, 0);
  assert.equal(immediateSc.api.snapshot().messages.some(message => message.id === fastSc.id), true);
  ok('SC enters the shared scene immediately while queued welcomes continue in order');

  const unwatched = harness({ subscribers: 0 });
  for (let uid = 1; uid <= 100; uid++) unwatched.api.entry({ uid, uname: '未订阅期间' + uid });
  assert.equal(unwatched.api.stats().active, false);
  assert.equal(unwatched.api.stats().pending, 0);
  assert.equal(unwatched.timers.size, 0);
  assert.deepEqual(plain(unwatched.api.snapshot().messages).map(message => message.uid), Array.from({ length: 48 }, (_, index) => index + 53));
  unwatched.api.subscribers(1);
  const beforeResume = unwatched.published.length;
  unwatched.advance(10000);
  assert.equal(unwatched.published.length, beforeResume, 'subscribing does not replay already folded recent history');
  unwatched.api.entry({ uid: 101, uname: '恢复后的新观众' });
  unwatched.api.entry({ uid: 102, uname: '恢复后待显示' });
  assert.equal(unwatched.api.stats().pending, 1);
  unwatched.api.subscribers(0);
  assert.equal(unwatched.api.stats().pending, 0);
  assert.equal(unwatched.api.snapshot().messages.at(-1).uid, 102);
  assert.equal(unwatched.timers.size, 0);
  unwatched.api.subscribers(1);
  const afterDisconnect = unwatched.published.length;
  unwatched.advance(10000);
  assert.equal(unwatched.published.length, afterDisconnect);
  ok('unwatched welcomes retain only recent history and output reopening never replays an old pending queue');

  const wire = harness();
  let listener;
  const relay = { subscribe(fn) { listener = fn; return () => { listener = null; }; }, connectRoom() {}, disconnectRoom() {} };
  const service = createLiveScene({ relay, getRoomInfo: async () => ({ ok: true }), getRoomEmotes: async () => ({ ok: true, emotes: [] }),
    onMessage: wire.api.add, onEntry: wire.api.entry, now: wire.now });
  await service.connect('123');
  const send = packet => listener({ t: 'cmd', room: '123', v: packet });
  // Wire fixture from the verified public 22 -> 2 -> 2 avatar schema; the
  // complete reception path must carry it without a separate user API lookup.
  send({ cmd: 'INTERACT_WORD_V2', data: { pb: 'CIetSxIM5YWl5Zy65rWL6K+VKAE4gOLPqgayAQCyAR4SHBIaLy9pMC5oZHNsYi5jb20vYXJyaXZhbC5wbmc=' } });
  send({ cmd: 'INTERACT_WORD', data: { uid: 1234567, uname: '入场测试', msg_type: 1 } });
  send({ cmd: 'INTERACT_WORD', data: { uid: 8, uname: '另一位观众', msg_type: 1 } });
  assert.equal(wire.api.snapshot().messages.length, 1);
  assert.equal(wire.api.snapshot().messages[0].avatarUrl, 'https://i0.hdslb.com/arrival.png');
  assert.equal(wire.api.stats().pending, 1, 'the distinct second arrival is queued while the duplicate notification is suppressed');
  wire.advance(3500);
  assert.equal(wire.api.snapshot().messages.length, 2, 'both arrivals persist without current/latest coalescing');
  assert.equal(wire.api.stats().pending, 0);
  service.dispose();
  ok('real entry normalization feeds persistent welcomes and retains cross-protocol UID deduplication');

  for (const entry of [null, {}, { uid: 1, uname: '' }, { uid: -1, uname: 'x' }, { uid: {}, uname: 'x' }]) {
    assert.equal(wire.api.entry(entry), null);
  }
  wire.app.isQuitting = true;
  assert.equal(wire.api.entry({ uid: 7, uname: '已退出' }), null);
  ok('invalid arrivals and shutdown never append welcome rows');
  console.log('Welcome message tests passed: ' + passed);
})().catch(error => { console.error(error); process.exitCode = 1; });
