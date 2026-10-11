'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createScAlerts } = require('../desktop/sc-alerts.js');

function harness({ mode = 'native' } = {}) {
  const notifications = [], balloons = [], errors = [];
  let preview = false, opens = 0, hidden = 0;
  class MockNotification extends EventEmitter {
    constructor(options) { super(); this.options = options; this.shown = 0; this.closed = 0; }
    show() {
      this.shown++;
      if (mode === 'throw-show') throw new Error('show failed');
      if (mode === 'sync-fail') this.emit('failed', {}, 'unsupported');
    }
    close() { this.closed++; this.emit('close'); }
  }
  const api = createScAlerts({
    createNotification: options => {
      if (mode === 'unsupported') return null;
      if (mode === 'throw-create') throw new Error('constructor failed');
      const notification = new MockNotification(options);
      notifications.push(notification);
      return notification;
    },
    hasPreview: () => preview,
    onOpen: () => { opens++; preview = true; },
    showFallback: (options, onClick) => {
      const balloon = { options, onClick, cleaned: false };
      balloons.push(balloon);
      return () => { balloon.cleaned = true; };
    },
    hideFallback: () => { hidden++; },
    onError: error => errors.push(error)
  });
  return {
    api, notifications, balloons, errors,
    setPreview(value) { preview = value; },
    get opens() { return opens; }, get hidden() { return hidden; }
  };
}

function sc(id, extra = {}) {
  return { id: String(id), type: 'sc', uname: '测试观众', text: '晚上好', valueYuan: 30, ...extra };
}

let passed = 0;
function test(name, run) { run(); console.log('PASS ' + name); passed++; }

test('only new SCs with stable ids alert while the desktop preview is closed', () => {
  const h = harness();
  for (const type of ['chat', 'gift', 'welcome', 'guard']) assert.equal(h.api.notify(sc(type, { type })), false);
  assert.equal(h.api.notify(null), false);
  assert.equal(h.api.notify(sc(1, { id: '' })), false);
  assert.equal(h.api.notify(sc(1, { id: {} })), false);
  assert.equal(h.api.notify(sc(1, { id: 'x'.repeat(129) })), false);
  h.setPreview(true);
  assert.equal(h.api.notify(sc(1)), false);
  h.setPreview(false);
  assert.equal(h.api.notify(sc(1, { text: '同一条 SC 的补充更新' })), false);
  assert.equal(h.api.notify(sc(2)), true);
  assert.equal(h.notifications.length, 1);
  assert.equal(h.notifications[0].shown, 1);
  assert.equal(h.notifications[0].options.title, '收到新的 SC');
  assert.match(h.notifications[0].options.body, /测试观众 · ¥30\n晚上好\n点击打开桌面窗口，滑动取消置顶$/);
  assert.equal(h.notifications[0].options.silent, true);
});

test('new SCs replace the previous notification and aggregate without duplicating updates', () => {
  const h = harness();
  h.api.notify(sc(1));
  const first = h.notifications[0];
  h.api.notify(sc(2, { text: '新的留言', valueYuan: 10.5 }));
  const second = h.notifications[1];
  assert.equal(first.closed, 1);
  assert.equal(first.eventNames().length, 0);
  assert.equal(second.options.title, '收到 2 条 SC');
  assert.match(second.options.body, /¥10.50\n新的留言/);
  assert.equal(h.api.notify(sc(2, { valueYuan: 100 })), false);
  first.emit('click');
  first.emit('failed');
  assert.equal(h.opens, 0);
  assert.equal(h.balloons.length, 0);
  second.emit('click');
  second.emit('click');
  assert.equal(h.opens, 1);
  assert.equal(second.closed, 1);
  assert.equal(second.eventNames().length, 0);
  h.setPreview(false);
  h.api.notify(sc(3));
  assert.equal(h.notifications[2].options.title, '收到新的 SC');
  assert.equal(h.api.notify(sc(2)), false);
});

test('native timeout keeps the latest center handler and replacement explicitly removes that item', () => {
  const h = harness();
  h.api.notify(sc(1));
  const first = h.notifications[0];
  const firstClick = first.listeners('click')[0];
  first.emit('close', { reason: 'timedOut' });
  assert.equal(first.listenerCount('click'), 1);
  h.api.notify(sc(2));
  assert.equal(h.notifications[1].options.title, '收到 2 条 SC');
  assert.equal(first.closed, 1, 'replacement removes the old item from Action Center as well');
  assert.equal(first.eventNames().length, 0);
  firstClick(); first.emit('click');
  assert.equal(h.opens, 0, 'replaced notification-center clicks cannot open stale content');
  h.notifications[1].emit('click');
  assert.equal(h.opens, 1);
});

test('Windows notification-center click still works after the toast timed out on screen', () => {
  const h = harness();
  h.api.notify(sc(1));
  const notification = h.notifications[0];
  // Electron 43 documents close(reason=timedOut) while the same notification
  // remains actionable in Windows Action Center. The later click is separate.
  notification.emit('close', { reason: 'timedOut' });
  assert.equal(notification.closed, 0, 'hiding the banner must not proactively close its center entry');
  notification.emit('click');
  notification.emit('click');
  assert.equal(h.opens, 1, 'a later notification-center click must open the desktop output once');
  assert.equal(notification.closed, 1);
  assert.equal(notification.eventNames().length, 0);
});

test('repeated close signals retain one activation handle without closing or duplicating the notification', () => {
  const h = harness();
  h.api.notify(sc(1));
  const notification = h.notifications[0];
  notification.emit('close', { reason: 'timedOut' });
  notification.emit('close', { reason: 'timedOut' });
  assert.equal(h.notifications.length, 1);
  assert.equal(notification.closed, 0);
  assert.equal(notification.listenerCount('click'), 1);
  notification.emit('click');
  assert.equal(h.opens, 1);
  assert.equal(notification.closed, 1);
  assert.equal(notification.eventNames().length, 0);
});

test('a late failed signal after native timeout does not replace a center entry with an unsolicited balloon', () => {
  const h = harness();
  h.api.notify(sc(1));
  const notification = h.notifications[0];
  notification.emit('close', { reason: 'timedOut' });
  notification.emit('failed', {}, 'late native callback');
  assert.equal(h.balloons.length, 0);
  assert.equal(notification.closed, 0);
  assert.equal(notification.listenerCount('click'), 1);
  notification.emit('click');
  assert.equal(h.opens, 1);
});

test('clear, expiry and disposal remove a timed-out center item and invalidate captured click callbacks', () => {
  for (const action of ['clear', 'cancel', 'dispose']) {
    const h = harness();
    h.api.notify(sc(1));
    const notification = h.notifications[0];
    const click = notification.listeners('click')[0];
    notification.emit('close', { reason: 'timedOut' });
    if (action === 'cancel') h.api.cancel(['1']); else h.api[action]();
    assert.equal(notification.closed, 1, action);
    assert.equal(notification.eventNames().length, 0, action);
    click(); notification.emit('click'); notification.emit('close'); notification.emit('failed');
    assert.equal(h.opens, 0, action);
    assert.equal(h.balloons.length, 0, action);
    assert.equal(notification.closed, 1, 'stale close must not recursively close again');
  }
});

test('many timed-out notifications still retain only the newest actionable native object', () => {
  const h = harness();
  for (let id = 1; id <= 300; id++) {
    h.api.notify(sc(id));
    h.notifications.at(-1).emit('close', { reason: 'timedOut' });
  }
  assert.equal(h.notifications.filter(notification => notification.listenerCount('click')).length, 1);
  assert.equal(h.notifications.filter(notification => !notification.closed).length, 1);
  h.api.dispose();
  assert.equal(h.notifications.filter(notification => notification.eventNames().length).length, 0);
  assert.equal(h.notifications.filter(notification => !notification.closed).length, 0);
});

test('opening the preview stops pending notifications and restarts the unseen count', () => {
  const h = harness();
  h.api.notify(sc(1));
  h.setPreview(true);
  assert.equal(h.api.notify(sc(2)), false);
  assert.equal(h.notifications[0].closed, 1);
  h.setPreview(false);
  h.api.notify(sc(3));
  assert.equal(h.notifications[1].options.title, '收到新的 SC');
});

test('unsupported, throwing, and synchronously failing notifications fall back to a clickable tray balloon', () => {
  for (const mode of ['unsupported', 'throw-create', 'throw-show', 'sync-fail']) {
    const h = harness({ mode });
    assert.equal(h.api.notify(sc(1)), true);
    assert.equal(h.balloons.length, 1, mode);
    assert.match(h.balloons[0].options.body, /点击打开桌面窗口/);
    h.balloons[0].onClick();
    h.balloons[0].onClick();
    assert.equal(h.opens, 1, mode);
    assert.equal(h.hidden, 1, mode);
    assert.equal(h.balloons[0].cleaned, true, mode);
    for (const notification of h.notifications) assert.equal(notification.eventNames().length, 0, mode);
  }
});

test('asynchronous failure falls back once and stale callbacks cannot reopen the preview', () => {
  const h = harness();
  h.api.notify(sc(1));
  h.notifications[0].emit('failed', {}, 'notifications unavailable');
  h.notifications[0].emit('failed');
  assert.equal(h.balloons.length, 1);
  assert.equal(h.notifications[0].closed, 1);
  h.api.notify(sc(2));
  assert.equal(h.balloons[0].cleaned, true);
  assert.equal(h.hidden, 1);
  h.balloons[0].onClick();
  assert.equal(h.opens, 0);
  h.notifications[1].emit('click');
  assert.equal(h.opens, 1);
});

test('a delayed native failure after the preview opens does not create a stale tray balloon', () => {
  const h = harness();
  h.api.notify(sc(1));
  h.setPreview(true);
  h.notifications[0].emit('failed', {}, 'late notification error');
  assert.equal(h.balloons.length, 0);
  assert.equal(h.notifications[0].closed, 1);
  assert.equal(h.notifications[0].eventNames().length, 0);
  h.setPreview(false);
  h.api.notify(sc(2));
  assert.equal(h.notifications[1].options.title, '收到新的 SC');
});

test('clear removes notifications and room state; dispose also rejects subsequent SCs', () => {
  for (const mode of ['native', 'unsupported']) {
    const h = harness({ mode });
    h.api.notify(sc(1));
    h.api.clear();
    if (mode === 'native') {
      assert.equal(h.notifications[0].closed, 1);
      h.notifications[0].emit('click');
    } else {
      assert.equal(h.balloons[0].cleaned, true);
      h.balloons[0].onClick();
    }
    assert.equal(h.opens, 0);
    assert.equal(h.api.notify(sc(1)), true, 'new scene may reuse ids after clear');
    h.api.dispose();
    h.api.dispose();
    assert.equal(h.api.notify(sc(2)), false);
  }
});

test('notification text is bounded and contains no control characters from viewer input', () => {
  const h = harness();
  h.api.notify(sc(1, { uname: '\u0000\r\n观众' + 'x'.repeat(1000), text: '\u0007\n留言' + 'y'.repeat(4000), valueYuan: NaN }));
  const options = h.notifications[0].options;
  assert.equal(options.body.split('\n').length, 3);
  assert.ok(options.body.length < 230);
  assert.equal(/[\u0000-\u0009\u000b-\u001f\u007f]/.test(options.body), false);
  assert.equal(options.body.includes('NaN'), false);
});

test('dense SCs retain only one active native notification and detach all replaced listeners', () => {
  const h = harness();
  for (let id = 1; id <= 1100; id++) h.api.notify(sc(id));
  assert.equal(h.notifications.filter(notification => !notification.closed).length, 1);
  assert.equal(h.notifications.filter(notification => notification.eventNames().length).length, 1);
  assert.equal(h.notifications.at(-1).options.title, '收到 999+ 条 SC');
  assert.equal(h.api.notify(sc(1100)), false);
  h.api.dispose();
  assert.equal(h.notifications.filter(notification => notification.eventNames().length).length, 0);
});

test('expiry cancels only the matching notification and old callbacks cannot open a preview', () => {
  const h=harness();h.api.notify(sc(1));h.api.notify(sc(2));const current=h.notifications[1];
  h.api.cancel(['1']);assert.equal(current.closed,0,'expiring an older SC cannot close the current one');
  const click=current.listeners('click')[0];h.api.cancel(['2']);assert.equal(current.closed,1);
  click();current.emit('click');assert.equal(h.opens,0);
  h.api.notify(sc(3));assert.equal(h.notifications[2].options.title,'收到新的 SC');
});

test('expiry clears unseen count even after the native toast has already closed', () => {
  const h=harness();h.api.notify(sc(1));h.notifications[0].emit('close');h.api.cancel(['1']);
  h.api.notify(sc(2));assert.equal(h.notifications[1].options.title,'收到新的 SC');
});

test('expired fallback balloons detach handlers without canceling unrelated current SC', () => {
  const h=harness({mode:'unsupported'});h.api.notify(sc(1));const first=h.balloons[0];
  h.api.notify(sc(2));h.api.cancel(['1']);assert.equal(h.balloons[1].cleaned,false);
  h.api.cancel(['2']);assert.equal(h.balloons[1].cleaned,true);first.onClick();h.balloons[1].onClick();assert.equal(h.opens,0);
});

console.log('\n' + passed + ' SC alert tests passed.');
