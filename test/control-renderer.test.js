'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const themes = require('../desktop/themes.js');
const renderer = fs.readFileSync(path.join(__dirname, '../desktop/renderer.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function harness() {
  const nodes = new Map(), subscriptions = new Map(), timers = new Map(), requests = [], saved = [];
  let timerId = 0;
  function element(id) {
    if (!nodes.has(id)) {
      const classes = new Set(id.endsWith('Dialog') ? ['hidden'] : []);
      nodes.set(id, {
        value: '', textContent: '', dataset: {}, handlers: new Map(), checked: false, disabled: false, tabIndex: 0,
        classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name),
          toggle(name, force) { const enabled = force === undefined ? !classes.has(name) : force; if (enabled) classes.add(name); else classes.delete(name); return enabled; } },
        addEventListener(name, callback) { this.handlers.set(name, callback); },
        setAttribute(name, value) { this[name] = value; }, removeAttribute(name) { delete this[name]; },
        querySelector: name => element(id + ':' + name), querySelectorAll: () => [], focus() { document.activeElement = this; }, select() {}, isConnected: true,
        getClientRects: () => classes.has('hidden') ? [] : [{}], parentElement: { classList: { toggle() {} } }, options: [], add(option) { this.options.push(option); }
      });
    }
    return nodes.get(id);
  }
  const snapshot = deferred();
  const desktop = new Proxy({
    loadSettings: async () => themes.migrateSettings({ theme: 'glass', previewEnabled: true }),
    getWindowState: () => snapshot.promise,
    saveSettings: async value => { saved.push(plain(value)); return value; },
    listStylePresets: async () => ({ presets: [] }),
    reconnectRelay: async () => { desktop.reconnects++; }, reconnects: 0
  }, { get(target, key) { return key in target ? target[key] : key.startsWith('on') ? callback => subscriptions.set(key, callback) : () => {}; } });
  const document = { getElementById: element, querySelectorAll: () => [], querySelector: () => element('main'),
    body: { classList: { add() {}, remove() {} } }, addEventListener() {}, activeElement: null };
  const context = {
    window: { DanmuThemes: themes, DesktopOverlay: desktop, ControlAppearance: { initialize() {}, flush: async () => true }, addEventListener() {} },
    document, structuredClone, console, AbortController, Date,
    fetch(url, options) { const request = { url, options, ...deferred() }; requests.push(request); return request.promise; },
    qrcode() { let text = ''; return { addData(value) { text = value; }, make() {}, createDataURL: () => text }; },
    Option: function (text, value) { return { text, value }; },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay, repeat: false }); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay, repeat: true }); return id; },
    clearInterval: id => timers.delete(id),
    requestAnimationFrame: () => 1, cancelAnimationFrame() {}
  };
  const instrumented = renderer.slice(0, renderer.lastIndexOf('\n  bindProgramSettings();')) + `
    window.__audit = { init, startQrLogin, closeQrDialog, stopQrPoll, initLoginStatus, renderLoginStatus, openThemeEditor, closeThemeEditor,
      seed(){settings=themeRegistry.migrateSettings({theme:'glass',previewEnabled:true});
        for(const id of ['qrDialog','qrCloseButton','qrImage','qrTip','loginStatus','loginDetail','loginButton','logoutButton'])els[id]=byId(id);},
      settings:()=>settings, login:()=>loginUid };
  })();`;
  vm.runInNewContext(instrumented, context);
  const api = context.window.__audit; api.seed();
  return { api, element, document, desktop, subscriptions, timers, requests, snapshot, saved,
    async ready() { const starting=api.init();await tick();snapshot.resolve({previewEnabled:true,overlayAvailable:true,overlayBounds:{width:515,height:650},clickThrough:false});await tick();const status=requests.find(r=>r.url==='/api/status');status.resolve({json:async()=>({ok:true,loggedIn:false})});await starting; },
    async answer(index, value) { requests[index].resolve({ json: async () => value }); await tick(); },
    async runPoll() { const entry = [...timers].find(([, timer]) => timer.delay === 2000); assert.ok(entry, 'expected a poll timer'); if (!entry[1].repeat) timers.delete(entry[0]); const task = entry[1].callback(); await tick(); return { task }; }
  };
}
const cases = [];
function test(name, run) { cases.push({ name, run }); }

test('reopening the console restores the applied preset selection without replaying it or discarding edits', async () => {
  const presets = [{ id: 'last-used', name: '上次样式', theme: 'glass', width: 550, height: 650 },
    { id: 'only-browsed', name: '另一个预设', theme: 'portrait', width: 600, height: 700 }];
  let applied = 0;
  for (let reopen = 0; reopen < 2; reopen++) {
    const h = harness();
    h.desktop.listStylePresets = async () => ({ presets, activeStylePresetId: 'last-used' });
    h.desktop.applyStylePreset = async () => { applied++; };
    h.desktop.loadSettings = async () => themes.migrateSettings({ theme: 'glass', themeConfigs: { glass: { messageFont: 37, messageAlign: 'top' } } });
    await h.ready(); await tick();
    assert.equal(h.element('stylePresetSelect').value, 'last-used');
    assert.match(h.element('stylePresetHint').textContent, /已恢复.*上次样式/);
    assert.equal(h.api.settings().themeConfigs.glass.messageFont, 37);
    assert.equal(h.api.settings().themeConfigs.glass.messageAlign, 'top');
    h.element('stylePresetSelect').value = 'only-browsed';
    h.element('stylePresetSelect').handlers.get('change')();
  }
  assert.equal(applied, 0, 'loading the selector must not reapply the stored preset');
});

test('a deleted saved preset does not select another entry or claim it was restored', async () => {
  const h = harness();
  h.desktop.listStylePresets = async () => ({ presets: [{ id: 'other', name: '其他', theme: 'glass', width: 550, height: 650 }], activeStylePresetId: 'deleted' });
  await h.ready(); await tick();
  assert.equal(h.element('stylePresetSelect').value, '');
  assert.doesNotMatch(h.element('stylePresetHint').textContent, /已恢复/);
});

test('the skin editor saves alignment for the edited skin and restores it when reopened', async () => {
  const h = harness(); await h.ready();
  h.api.openThemeEditor('portrait');
  assert.equal(h.element('messageAlignInput').value, 'bottom');
  h.element('messageAlignInput').value = 'top';
  h.element('messageAlignInput').handlers.get('change')();
  assert.equal(h.api.settings().themeConfigs.portrait.messageAlign, 'top');
  assert.equal(h.api.settings().themeConfigs.glass.messageAlign, 'bottom');
  // Flush the actual debounced save, then reopen the editor for each skin.
  for (const [id, timer] of [...h.timers]) if (!timer.repeat) { h.timers.delete(id); await timer.callback(); }
  await tick();
  assert.equal(h.saved.at(-1).themeConfigs.portrait.messageAlign, 'top');
  h.api.openThemeEditor('glass');
  assert.equal(h.element('messageAlignInput').value, 'bottom');
  h.api.openThemeEditor('portrait');
  assert.equal(h.element('messageAlignInput').value, 'top');
});

test('initial window snapshot cannot overwrite newer preview, bounds or click-through events', async () => {
  const h = harness(); const initializing = h.api.init(); await tick();
  h.subscriptions.get('onPreviewEnabledChanged')(false);
  h.subscriptions.get('onOverlayBoundsChanged')({ width: 700, height: 800 });
  h.subscriptions.get('onClickThroughChanged')(true);
  h.snapshot.resolve({ previewEnabled: true, overlayAvailable: true, overlayBounds: { width: 515, height: 650 }, clickThrough: false });
  await tick(); await h.answer(0, { ok: true, loggedIn: false }); await initializing;
  assert.equal(h.api.settings().previewEnabled, false);
  assert.equal(h.element('overlayWidthInput').value, '700');
  assert.equal(h.element('overlayHeightInput').value, '800');
  assert.equal(h.element('clickThroughButton').classList.contains('active'), true);
});

test('closing login while its start request is pending cannot start hidden polling', async () => {
  const h = harness(); const starting = h.api.startQrLogin(); h.api.closeQrDialog();
  await h.answer(0, { ok: true, url: 'old-code', qrcodeKey: 'old-key' }); await starting;
  assert.equal(h.element('qrDialog').classList.contains('hidden'), true);
  assert.equal(h.timers.size, 0);
  assert.notEqual(h.element('qrImage').src, 'old-code');
});

test('overlapping login refreshes keep only the newest code and its poll loop', async () => {
  const h = harness(); const first = h.api.startQrLogin(); const second = h.api.startQrLogin();
  await h.answer(1, { ok: true, url: 'new-code', qrcodeKey: 'new-key' }); await second;
  await h.answer(0, { ok: true, url: 'old-code', qrcodeKey: 'old-key' }); await first;
  assert.equal(h.element('qrImage').src, 'new-code');
  assert.equal(h.timers.size, 1);
  h.api.closeQrDialog(); assert.equal(h.timers.size, 0);
});

test('a stale successful poll after login closes cannot update identity or reconnect', async () => {
  const h = harness(); const starting = h.api.startQrLogin();
  await h.answer(0, { ok: true, url: 'code', qrcodeKey: 'key' }); await starting;
  const poll = await h.runPoll(); h.api.closeQrDialog();
  await h.answer(1, { ok: true, uid: 999, uname: '旧请求用户' }); await poll.task;
  assert.equal(h.api.login(), 0); assert.equal(h.desktop.reconnects, 0); assert.equal(h.timers.size, 0);
});

test('a slow poll does not create concurrent polling requests', async () => {
  const h = harness(); const starting = h.api.startQrLogin();
  await h.answer(0, { ok: true, url: 'code', qrcodeKey: 'key' }); await starting;
  const poll = await h.runPoll();
  for (const timer of h.timers.values()) if (timer.delay === 2000) timer.callback();
  await tick(); assert.equal(h.requests.length, 2);
  await h.answer(1, { ok: false, step: '86101' }); await poll.task;
  assert.equal(h.timers.size, 1); h.api.closeQrDialog(); assert.equal(h.timers.size, 0);
});

test('initial login status cannot overwrite an identity established by a newer login', async () => {
  const h = harness(); const reading = h.api.initLoginStatus();
  h.api.renderLoginStatus(true, '新登录用户', 321);
  await h.answer(0, { ok: true, loggedIn: false }); await reading;
  assert.equal(h.api.login(), 321);
  assert.equal(h.element('loginStatus').textContent, '新登录用户');
});

test('current successful login still updates identity, stops polling and reconnects once', async () => {
  const h = harness(); const starting = h.api.startQrLogin();
  await h.answer(0, { ok: true, url: 'code', qrcodeKey: 'key' }); await starting;
  const poll = await h.runPoll(); await h.answer(1, { ok: true, uid: 123, uname: '当前用户' }); await poll.task;
  assert.equal(h.api.login(), 123); assert.equal(h.desktop.reconnects, 1);
  assert.equal(h.timers.size, 0); assert.equal(h.element('qrDialog').classList.contains('hidden'), true);
});

test('repeated copying always restores the original button label', async () => {
  const h=harness();h.element('copyObsUrlButton').textContent='复制';await h.ready();
  const copy=h.element('copyObsUrlButton').handlers.get('click');await copy();await copy();
  for(const [id,timer] of [...h.timers])if(timer.delay===1200){h.timers.delete(id);timer.callback();}
  assert.equal(h.element('copyObsUrlButton').textContent,'复制');
});

test('skin settings move focus inside, trap Tab and return focus when Escape closes', async () => {
  const h=harness();await h.ready();const trigger=h.element('theme-settings-trigger');trigger.focus();
  const close=h.element('themeCloseButton'),last=h.element('saveThemeButton');
  const backdrop=h.element('themeBackdrop');backdrop.tabIndex=-1;
  h.element('themeDialog').querySelectorAll=()=>[backdrop,close,h.element('messageFontInput'),last];
  h.api.openThemeEditor('glass');assert.equal(h.document.activeElement,close);
  const keydown=h.element('themeDialog').handlers.get('keydown');assert.equal(typeof keydown,'function');
  last.focus();let prevented=false;keydown({key:'Tab',shiftKey:false,preventDefault(){prevented=true;},stopPropagation(){}});
  assert.equal(prevented,true);assert.equal(h.document.activeElement,close);
  keydown({key:'Escape',preventDefault(){},stopPropagation(){}});
  assert.equal(h.element('themeDialog').classList.contains('hidden'),true);assert.equal(h.document.activeElement,trigger);
});

test('Escape closes the QR sheet, cancels its pending request and restores focus', async () => {
  const h=harness();await h.ready();const trigger=h.element('loginButton');trigger.focus();
  const starting=h.api.startQrLogin();assert.equal(h.document.activeElement,h.element('qrCloseButton'));
  h.element('qrDialog').handlers.get('keydown')({key:'Escape',preventDefault(){},stopPropagation(){}});
  const request=h.requests.find(item=>item.url==='/api/login/start');
  assert.equal(request.options.signal.aborted,true);assert.equal(h.document.activeElement,trigger);
  request.resolve({json:async()=>({ok:true,url:'late-code',qrcodeKey:'late-key'})});await starting;
  assert.equal(h.timers.size,1); // Only the initial ordinary settings save remains.
  assert.equal([...h.timers.values()].some(timer=>timer.delay===2000),false);
});

test('a queued appearance edit preserves its value but does not replay a failed SC preference', async () => {
  const h=harness();await h.ready();h.api.openThemeEditor('glass');
  const saving=deferred(),calls=[];
  h.desktop.saveSettings=value=>{calls.push(plain(value));return calls.length===1?saving.promise:Promise.resolve(true);};
  const checkbox=h.element('scNeverExpireInput');checkbox.checked=true;checkbox.handlers.get('change')();await tick();
  const font=h.element('messageFontInput');font.value='31';font.handlers.get('input')();
  const timer=[...h.timers].find(([,entry])=>entry.delay===100);assert.ok(timer);h.timers.delete(timer[0]);const pending=timer[1].callback();await tick();
  assert.equal(calls.length,1);saving.reject(new Error('disk failure'));await pending;await tick();
  assert.equal(calls.length,2);assert.equal(calls[0].themeConfigs.glass.scNeverExpire,true);
  assert.equal(calls[1].themeConfigs.glass.scNeverExpire,false);assert.equal(calls[1].themeConfigs.glass.messageFont,31);
  assert.equal(checkbox.disabled,false);assert.equal(checkbox.checked,false);
});

test('rapid settings saves remain ordered when the first save resolves late', async () => {
  const h=harness();await h.ready();h.api.openThemeEditor('glass');
  const saving=deferred(),calls=[];
  h.desktop.saveSettings=value=>{calls.push(plain(value));return calls.length===1?saving.promise:Promise.resolve(true);};
  const font=h.element('messageFontInput');
  async function edit(value){font.value=String(value);font.handlers.get('input')();const [id,timer]=[...h.timers].find(([,entry])=>entry.delay===100);h.timers.delete(id);timer.callback();await tick();}
  await edit(28);await edit(33);assert.equal(calls.length,1);assert.equal(calls[0].themeConfigs.glass.messageFont,28);
  saving.resolve(true);await tick();assert.equal(calls.length,2);assert.equal(calls[1].themeConfigs.glass.messageFont,33);
});

test('SC permanent pinning retains the per-skin legacy key and describes expiry as joining the message flow', async () => {
  const h=harness();await h.ready();h.api.openThemeEditor('portrait');
  const hint=h.element('scNeverExpireHint'),checkbox=h.element('scNeverExpireInput');
  assert.match(hint.textContent,/未勾选时到期进入弹幕流/);
  checkbox.checked=true;checkbox.handlers.get('change')();await tick();
  assert.equal(h.saved.at(-1).themeConfigs.portrait.scNeverExpire,true);
  assert.equal(Object.hasOwn(h.saved.at(-1),'scNeverExpire'),false);
  assert.match(hint.textContent,/未勾选时到期进入弹幕流/);
  h.api.openThemeEditor('glass');assert.equal(checkbox.checked,false);
  assert.match(hint.textContent,/此皮肤独立保存/);
});

test('logout persistence failures keep the current account instead of claiming logout succeeded', async () => {
  for(const httpOk of [true,false]){
    const h=harness();await h.ready();h.api.renderLoginStatus(true,'当前账号',123);
    const loggingOut=h.element('logoutButton').handlers.get('click')();await tick();
    const request=h.requests.find(item=>item.url==='/api/login/logout');
    request.resolve({ok:httpOk,json:async()=>({ok:false,error:'mock write failure'})});await loggingOut;
    assert.equal(h.api.login(),123);assert.equal(h.element('loginStatus').textContent,'当前账号');
    assert.equal(h.desktop.reconnects,0);assert.match(h.element('loginDetail').textContent,/失败/);
  }
});

(async () => {
  let failed = 0;
  for (const { name, run } of cases) {
    try { await run(); console.log('PASS ' + name); }
    catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
  }
  console.log('Control renderer tests: ' + (cases.length - failed) + '/' + cases.length);
  if (failed) process.exitCode = 1;
})();
