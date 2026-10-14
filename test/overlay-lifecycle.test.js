'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const themes = require('../desktop/themes');
const skinFonts = require('../desktop/skin-fonts');
const avatars = require('../js/avatars');
const source = fs.readFileSync(path.join(__dirname, '../desktop/overlay.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

// Execute the actual renderer functions, without starting a page, window or
// network connection. The separate Electron audit exercises real DOM layout.
function harness() {
  let at = 100000, nextTimer = 0, calls = 0, removed = 0, aborted = 0;
  let mode = 'success';
  const timers = new Map();
  const document = { readyState: 'loading', documentElement: { dataset: {} }, body: { classList: { toggle() {} } }, fonts: new Set(), addEventListener() {} };
  const window = { location: { search: '?mode=obs' }, DanmuThemes: themes, DanmuSkinFonts: skinFonts,
    DanmuAvatars: avatars, matchMedia: () => ({ matches: false }) };
  const context = { window, document, URL, URLSearchParams, AbortController, console,
    Date: class extends Date { static now() { return at; } },
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, at: at + delay }); return id; },
    clearTimeout: id => timers.delete(id),
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    fetch(_url, { signal } = {}) {
      calls++;
      if (mode === 'hold') return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => { aborted++; reject(Error('aborted')); }, { once: true });
      });
      return Promise.resolve({ json: async () => mode === 'fail'
        ? { ok: false, avatarUrl: '' }
        : { ok: true, avatarUrl: 'https://i0.hdslb.com/avatar.png' } });
    }
  };
  const hook = `
    window.audit = { lookup: lookupAvatar, art: artAvatarUrl,
      fixed(value, overrides = {}) {
        settings = themeRegistry.migrateSettings({ theme: 'glass', themeConfigs: { glass: { welcomeMode: 'single', ...overrides } } });
        if (!els.fixedWelcome) els.fixedWelcome = { firstElementChild: null, replaceChildren(row) { this.firstElementChild = row || null; } };
        makeMessageRow = () => ({ classList: { remove() {} }, dataset: {} });
        syncMessageArt = () => {};
        latestWelcome = value;
        syncFixedWelcome();
      },
      fixedVisible: () => !!els.fixedWelcome?.firstElementChild,
      stop: stopAvatars, cache: cacheAvatarUrl, clear: clearDisplayedScene,
      revision(value) { if (value !== undefined) renderedSceneRevision = value; return renderedSceneRevision; },
      setup(row) { settings = themeRegistry.migrateSettings(settings);
        els.messageStack = { querySelectorAll: selector => selector === '.message-avatar' ? [] : [row] };
        els.messageList = { children: [], querySelector: () => null }; els.pinnedScStack = { querySelector: () => null }; els.emptyState = {}; },
      state: () => ({ cache: avatarUrlCache.size, pending: avatarLookupPending.size, controllers: avatarLookupControllers.size }) };
  `;
  vm.runInNewContext(source.replace("  if (document.readyState === 'loading') {", hook + "  if (document.readyState === 'loading') {"), context);
  const api = window.audit;
  api.setup({ remove() { removed++; } });
  return { api, timers, timerCount: () => nextTimer, setMode: value => { mode = value; },
    counts: () => ({ calls, removed, aborted }),
    async advance(ms) {
      at += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= at) { timers.delete(id); timer.fn(); }
      await tick();
    }
  };
}

(async () => {
  {
    const h = harness();
    const first = { id: 'welcome-1', type: 'welcome', uname: '第一位', receivedAt: 100000 };
    h.api.fixed(first);
    const created = h.timerCount();
    const timerId = [...h.timers.keys()][0];
    for (let i = 0; i < 100; i++) h.api.fixed({ ...first });
    assert.equal(h.timerCount(), created, 'ordinary snapshots reuse the same deadline');
    assert.equal(h.timers.size, 1); assert.equal(h.timers.has(timerId), true);
    await h.advance(2000);
    h.api.fixed({ ...first, id: 'welcome-2', uname: '第二位', receivedAt: 102000 });
    assert.equal(h.timers.has(timerId), false); assert.equal(h.timers.size, 1);
    await h.advance(1000); assert.equal(h.api.fixedVisible(), true, 'the old welcome deadline cannot hide its replacement');
    await h.advance(2000); assert.equal(h.api.fixedVisible(), false); assert.equal(h.timers.size, 0);
    h.api.fixed({ ...first, receivedAt: 105000 });
    h.api.fixed({ ...first, receivedAt: 105000 }, { showWelcome: false });
    assert.equal(h.timers.size, 0); assert.equal(h.api.fixedVisible(), false);
    console.log('PASS unchanged welcomes reuse one timer; replacement, expiry and disabling cancel the correct deadline');
  }
  {
    const h = harness(); h.setMode('fail');
    assert.equal(await h.api.lookup(7), ''); h.setMode('success');
    await h.advance(14999); assert.equal(await h.api.lookup(7), ''); assert.equal(h.counts().calls, 1);
    await h.advance(1); assert.equal(await h.api.lookup(7), 'https://i0.hdslb.com/avatar.png');
    assert.equal(h.counts().calls, 2);
    assert.equal(await h.api.art({ uid: 7 }, new AbortController().signal), 'https://i0.hdslb.com/avatar.png');
    assert.equal(h.counts().calls, 2, 'portrait and small avatars share the recovered result');
    await h.advance(6 * 60 * 60 * 1000); await h.api.lookup(7); assert.equal(h.counts().calls, 3);
    console.log('PASS renderer avatar failures retry after 15 seconds and success expires after six hours');
  }
  {
    const h = harness(); h.setMode('hold');
    const first = h.api.lookup(8), second = h.api.lookup(8);
    assert.equal(first, second); assert.equal(h.counts().calls, 1);
    h.api.stop(); await first;
    assert.equal(h.counts().aborted, 1); assert.equal(h.api.state().cache, 0);
    assert.equal(h.api.state().pending, 0); assert.equal(h.api.state().controllers, 0); assert.equal(h.timers.size, 0);
    h.setMode('success'); assert.equal(await h.api.lookup(8), 'https://i0.hdslb.com/avatar.png');
    console.log('PASS hiding avatars cancels shared requests without poisoning the next visible lookup');
  }
  {
    const h = harness(); h.setMode('hold'); const pending = h.api.lookup(9);
    await h.advance(8000); assert.equal(await pending, ''); assert.equal(h.counts().aborted, 1);
    assert.equal(h.api.state().pending, 0); assert.equal(h.timers.size, 0);
    h.setMode('success'); await h.api.lookup(9); assert.equal(h.counts().calls, 1);
    await h.advance(15000); await h.api.lookup(9); assert.equal(h.counts().calls, 2);
    for (let uid = 0; uid < 520; uid++) h.api.cache(String(uid), 'https://i0.hdslb.com/' + uid + '.png');
    assert.equal(h.api.state().cache, 512);
    console.log('PASS stalled renderer lookups time out, recover and keep URL memory bounded');
  }
  {
    const h = harness(); h.api.revision(20); h.api.clear(19);
    assert.equal(h.counts().removed, 0); assert.equal(h.api.revision(), 20);
    h.api.clear(21); assert.equal(h.counts().removed, 1); assert.equal(h.api.revision(), 21);
    h.api.clear(); assert.equal(h.counts().removed, 2); assert.equal(h.api.revision(), -1);
    console.log('PASS late IPC clears cannot erase newer SSE messages while valid clear and session reset still work');
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
