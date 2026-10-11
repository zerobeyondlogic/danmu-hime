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
      async function show(theme, alignment, messages, overrides = {}) {
        const settings = themes.migrateSettings({ theme, themeConfigs: { [theme]: { ...themes.defaults[theme], showAvatar: false, showWelcome: true, surfaceOpacity: 0, messageAlign: alignment, ...overrides } } });
        const state = { ...empty, settings, scene: { sessionId: 'alignment-test', revision: ++revision, messages } };
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
