'use strict';

// Run with Node. Every window, message and HTTP endpoint is test-only.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'danmu-alignment-'));
  const env = { ...process.env, DANMU_ALIGNMENT_TEMP: temporary };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [__filename], { env, encoding: 'utf8', windowsHide: true, timeout: 90000 });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  if (result.error) console.error(result.error);
  process.exitCode = result.status === null ? 1 : result.status;
} else {
  const { app, BrowserWindow } = require('electron');
  const http = require('node:http');
  const themes = require('../desktop/themes.js');
  require('./electron-test-windows.cjs')({ app, BrowserWindow });
  app.setPath('userData', path.join(process.env.DANMU_ALIGNMENT_TEMP, 'profile'));
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  const windows = [];
  let server;
  const deadline = setTimeout(() => app.exit(1), 80000);
  const empty = { sessionId: 'alignment-test', canvas: { width: 550, height: 650 }, settings: themes.migrateSettings({}), scene: { sessionId: 'alignment-test', revision: 0, messages: [] } };
  const rect = `r=>({top:r.top,bottom:r.bottom,height:r.height})`;

  async function settle(window) {
    await window.webContents.executeJavaScript('document.body.offsetHeight; document.fonts.ready.then(()=>true)');
    await window.webContents.executeJavaScript(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>{
      document.getAnimations().forEach(animation=>animation.finish());
      window.alignmentAudit.updateMessageVisibility(); resolve();
    })))`);
  }
  async function measure(window) {
    return window.webContents.executeJavaScript(`(()=>{
      const rect=${rect}; const list=document.getElementById('messageList');
      return {viewport:rect(list.getBoundingClientRect()),
        fixed:Array.from(document.querySelectorAll('.fixed-welcome > .message-row'),r=>({text:r.textContent,...rect(r.getBoundingClientRect()),
          nowrap:getComputedStyle(r.querySelector('.welcome-body')).whiteSpace})),
        rows:Array.from(list.children,r=>({id:r.dataset.sceneId,clipped:r.classList.contains('is-clipped'),...rect(r.getBoundingClientRect())})),
        pinned:Array.from(document.querySelectorAll('.pinned-sc-stack > .message-row'),r=>rect(r.getBoundingClientRect()))};
    })()`);
  }
  function visible(state) { return state.rows.filter(row => !row.clipped && row.height > 0); }
  function atEdge(state, alignment, full = true) {
    const rows = visible(state); assert(rows.length, 'some recent messages must fit');
    if (alignment === 'top') assert(Math.abs(rows[0].top - state.viewport.top) < 0.15, 'first complete card must touch top');
    else assert(Math.abs(rows.at(-1).bottom - state.viewport.bottom) < 0.15, 'last card must touch bottom');
    if (full) for (const row of rows) assert(row.top >= state.viewport.top - 0.15 && row.bottom <= state.viewport.bottom + 0.15, 'whole cards stay inside the viewport');
  }
  app.whenReady().then(async () => {
    try {
      server = http.createServer((request, response) => {
        const url = new URL(request.url, 'http://localhost');
        if (url.pathname === '/api/desktop-output-state') { response.setHeader('Content-Type', 'application/json'); return response.end(JSON.stringify(empty)); }
        if (url.pathname.startsWith('/api/')) { response.writeHead(404); return response.end(); }
        const file = path.resolve(root, '.' + url.pathname);
        if (!file.startsWith(root + path.sep)) { response.writeHead(403); return response.end(); }
        try {
          let data = fs.readFileSync(file);
          if (url.pathname === '/desktop/overlay.js') {
            data = `if(location.search.includes('testDesktop'))window.DesktopOverlay={reportViewport(){},onSettingsChanged(){},onSceneCleared(){},onClickThroughChanged(){},overlayReady(){}};\n` + data.toString().replace("  if (document.readyState === 'loading') {", `  window.alignmentAudit={applyOutputState,renderSceneSnapshot,updateMessageVisibility,stopOutputEvents};\n  if (document.readyState === 'loading') {`);
          }
          response.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' })[path.extname(file)] || 'application/octet-stream');
          response.end(data);
        } catch { response.writeHead(404); response.end(); }
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      for (const mode of ['?testDesktop=1', '?mode=obs']) {
        const window = new BrowserWindow({ width: 550, height: 650, show: false, webPreferences: { offscreen: true, backgroundThrottling: false } });
        windows.push(window);
        await window.loadURL(`http://127.0.0.1:${server.address().port}/desktop/overlay.html${mode}`);
        await window.webContents.executeJavaScript('window.alignmentAudit.stopOutputEvents()');
        await window.webContents.insertCSS('*{animation:none!important;transition:none!important}');
      }
      let revision = 0;
      const chat = count => Array.from({ length: count }, (_, i) => ({ id: 'chat-' + i, type: i % 4 === 0 ? 'welcome' : 'danmaku', uname: '测试观众', role: 'viewer', text: i % 3 ? '测试弹幕 ' + i : '这是一条用于验证多行高度的测试消息。'.repeat(4), time: '12:00:00' }));
      async function show(theme, alignment, messages, overrides = {}, latestWelcome = null) {
        const settings = themes.migrateSettings({ theme, themeConfigs: { [theme]: { ...themes.defaults[theme], showAvatar: false, showWelcome: true, surfaceOpacity: 0, messageAlign: alignment, ...overrides } } });
        const state = { ...empty, settings, scene: { sessionId: 'alignment-test', revision: ++revision, messages, latestWelcome } };
        for (const window of windows) {
          await window.webContents.executeJavaScript(`window.alignmentAudit.applyOutputState(${JSON.stringify(state)})`);
          await settle(window);
        }
        const desktop = await measure(windows[0]), obs = await measure(windows[1]);
        assert.deepEqual(obs, desktop, 'desktop and browser source layout must match');
        return desktop;
      }
      for (const theme of themes.ids) {
        for (const messages of [chat(2), chat(15)]) {
          const bottom = await show(theme, 'bottom', messages); atEdge(bottom, 'bottom');
          const top = await show(theme, 'top', messages); atEdge(top, 'top');
          assert.deepEqual(visible(top).map(r=>r.id), visible(bottom).map(r=>r.id), 'alignment must preserve newest messages and order');
          const restored = await show(theme, 'bottom', messages); assert.deepEqual(restored, bottom, 'repeated switching must not drift');
        }
        const pinned = { id: 'sc', type: 'sc', scPinned: true, uname: '测试 SC', text: '置顶留言', price: 30, time: '12:00:00' };
        const messages = [pinned, ...chat(15)];
        const bottom = await show(theme, 'bottom', messages);
        const top = await show(theme, 'top', messages); atEdge(top, 'top');
        assert.deepEqual(top.pinned, bottom.pinned, 'SC remains pinned');
        const hiddenWelcome = await show(theme, 'top', messages, { showWelcome: false }); atEdge(hiddenWelcome, 'top');
        const partial = await show(theme, 'top', chat(2), { fullCardsOnly: false }); atEdge(partial, 'top', false);
        const overflow = await show(theme, 'top', chat(15), { fullCardsOnly: false }); atEdge(overflow, 'bottom', false);
        // Exercise the append path without reapplying settings (which cancels motion).
        await show(theme, 'top', chat(15));
        for (const window of windows) {
          await window.webContents.executeJavaScript(`window.alignmentAudit.renderSceneSnapshot(${JSON.stringify({ sessionId: 'alignment-test', revision: ++revision, messages: chat(16) })})`);
          await settle(window); atEdge(await measure(window), 'top');
        }
        console.log('PASS ' + theme + ': sparse/overflow, same recent cards, SC, welcome, partial cards, append and desktop/browser parity');
        const welcome = { id: 'fixed', type: 'welcome', uname: '很长的进房昵称'.repeat(20), receivedAt: Date.now() };
        const fixed = await show(theme, 'top', messages, { welcomeMode: 'single', welcomeDuration: 30 }, welcome);
        assert.equal(fixed.fixed.length, 1); assert.equal(fixed.fixed[0].nowrap, 'nowrap');
        assert(fixed.fixed[0].top >= fixed.viewport.bottom, 'fixed welcome reserves its own footer');
        assert.equal(fixed.rows.filter(r=>r.id==='chat-0')[0].height, 0, 'scroll welcomes hidden in single mode');
        atEdge(fixed, 'top');
        const hidden = await show(theme, 'top', messages, { welcomeMode: 'single', showWelcome: false }, welcome);
        assert.equal(hidden.fixed.length, 0);
        const scroll = await show(theme, 'bottom', messages, { welcomeMode: 'scroll' }, welcome);
        assert.equal(scroll.fixed.length, 0); assert(scroll.rows.some(r=>r.id==='chat-0' && r.height>0));
        const expired = await show(theme, 'top', messages, { welcomeMode: 'single', welcomeDuration: 1 }, { ...welcome, receivedAt: Date.now()-2000 });
        assert.equal(expired.fixed.length, 0, 'reopening must not restart an expired welcome');
        console.log('PASS ' + theme + ': fixed one-line welcome, mode toggle, hidden and expired welcome');
      }
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      await show('portrait', 'bottom', chat(10), { welcomeMode: 'single', welcomeDuration: 1 }, { id: 'first', type: 'welcome', uname: '第一位', receivedAt: Date.now() });
      await sleep(650);
      await show('portrait', 'bottom', chat(10), { welcomeMode: 'single', welcomeDuration: 1 }, { id: 'second', type: 'welcome', uname: '第二位', receivedAt: Date.now() });
      await sleep(450);
      for (const window of windows) assert.match((await measure(window)).fixed[0].text, /第二位/);
      await sleep(650);
      for (const window of windows) { await settle(window); assert.equal((await measure(window)).fixed.length, 0); }
      console.log('PASS fixed welcome replacement restarts its timer and both outputs hide automatically');
      // Verify computed colors, including the pseudo-element used for the
      // amount marker, instead of only checking that settings were persisted.
      const colorMessage = [{ id: 'colors', type: 'gift', kind: 'gift', uname: '测试昵称', role: 'host', medal: '陪伴 12', text: '测试礼物', valueYuan: 30, gapMs: 451, time: '12:00:00' }];
      const readColors = window => window.webContents.executeJavaScript(`(()=>{
        const read=(selector,pseudo)=>getComputedStyle(document.querySelector(selector),pseudo).color;
        return {medal:read('.medal-label'),thought:read('.message-gap'),value:read('.gift-value'),marker:read('.gift-value','::first-letter'),body:read('.message-body')};
      })()`);
      for (const theme of ['glass', 'tui']) {
        await show(theme, 'bottom', colorMessage);
        const baseline = await readColors(windows[1]);
        assert.equal(baseline.medal, 'rgba(236, 239, 244, 0.56)');
        if (theme === 'tui') {
          assert.equal(baseline.thought, 'rgb(241, 164, 49)');
          assert.equal(baseline.value, 'rgb(168, 165, 163)');
          assert.equal(baseline.marker, 'rgb(79, 168, 245)');
        }
        await show(theme, 'bottom', colorMessage, { medalColor: '#123456', thoughtColor: '#234567', giftValueColor: '#345678', giftMarkerColor: '#456789' });
        const desktop = await readColors(windows[0]), browser = await readColors(windows[1]);
        assert.deepEqual(desktop, browser);
        assert.equal(browser.medal, 'rgba(18, 52, 86, 0.56)');
        assert.equal(browser.body, baseline.body, 'changing amount colors does not change gift text');
        if (theme === 'tui') {
          assert.equal(browser.thought, 'rgb(35, 69, 103)');
          assert.equal(browser.value, 'rgb(52, 86, 120)');
          assert.equal(browser.marker, 'rgb(69, 103, 137)');
        }
        await show(theme, 'bottom', colorMessage);
        assert.deepEqual(await readColors(windows[1]), baseline, 'reset restores the original palette');
        console.log('PASS ' + theme + ': independent text colors and original defaults match across both outputs');
      }
      // A scaled browser source must retain the same logical top alignment.
      windows[1].setSize(330, 500);
      const state = { ...empty, settings: themes.migrateSettings({ theme: 'portrait', themeConfigs: { portrait: { messageAlign: 'top', showAvatar: false, surfaceOpacity: 0 } } }), scene: { sessionId: 'alignment-test', revision: ++revision, messages: chat(15) } };
      await windows[1].webContents.executeJavaScript(`window.alignmentAudit.applyOutputState(${JSON.stringify(state)})`);
      await settle(windows[1]); atEdge(await measure(windows[1]), 'top');
      console.log('PASS scaled browser canvas retains top alignment');
    } finally {
      clearTimeout(deadline);
      for (const window of windows) if (!window.isDestroyed()) window.destroy();
      if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    }
  }).then(() => app.exit(0), error => { console.error(error); app.exit(1); });
}
