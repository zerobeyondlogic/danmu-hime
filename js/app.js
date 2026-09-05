(function () {
  'use strict';

  const STORAGE_KEY = 'biliGiftProgress.v1';
  const COIN_PER_YUAN = 1000;

  let client = null;
  let state = null;
  let els = {};
  let debugOn = true;
  let loginUid = 0;
  let loginBuvid = '';
  let qrPollTimer = null;

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  function logLine(cls, text) {
    if (!els.debugLogBody) return;
    const d = new Date();
    const t = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    const nearBottom = els.debugLogBody.scrollHeight - els.debugLogBody.scrollTop - els.debugLogBody.clientHeight < 40;
    const div = document.createElement('div');
    div.className = 'row ' + cls;
    div.innerHTML = '<span class="t">' + t + '</span>' + text.replace(/</g, '&lt;');
    els.debugLogBody.appendChild(div);
    while (els.debugLogBody.children.length > 300) {
      els.debugLogBody.removeChild(els.debugLogBody.firstChild);
    }
    if (nearBottom) {
      els.debugLogBody.scrollTop = els.debugLogBody.scrollHeight;
    }
  }

  function today() {
    const d = new Date();
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  function load() {
    const def = {
      roomId: '',
      target: 5000,
      total: 0,
      reached: false,
      lastGift: '',
      chatOn: true,
      date: today()
    };
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    } catch (e) {}
    delete saved.coinMode;
    delete saved.autoReset;
    const s = Object.assign(def, saved);
    if (s.date !== today()) {
      s.total = 0;
      s.reached = false;
      s.date = today();
    }
    return s;
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {}
  }

  function showError(msg) {
    try {
      let box = document.getElementById('errBox');
      if (!box) {
        box = document.createElement('div');
        box.id = 'errBox';
        box.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:999;background:#c0392b;color:#fff;font-size:13px;padding:8px 12px;white-space:pre-wrap;';
        document.body.appendChild(box);
      }
      box.textContent = '错误: ' + msg;
    } catch (e) {}
  }

  function fmt(n) {
    return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function toYuan(g) {
    if (g.coinIsYuan) return g.coin;
    return g.coin / COIN_PER_YUAN;
  }

  function render() {
    const pct = state.target > 0 ? Math.min(100, (state.total / state.target) * 100) : 0;
    els.barFill.style.width = pct + '%';
    els.labelAmount.textContent = '¥ ' + fmt(state.total);
    els.labelTarget.textContent = '目标 ¥ ' + fmt(state.target);
    els.labelPct.textContent = pct.toFixed(1) + '%';
    els.labelGift.textContent = state.lastGift || '等待礼物...';
    els.barShell.classList.toggle('reached', state.reached);
    els.roomIdInput.value = state.roomId;
    els.targetInput.value = state.target;
    els.chatToggleInput.checked = state.chatOn;
    els.chatPanel.classList.toggle('hidden', !state.chatOn);
  }

  let lastStatus = '';

  function setStatus(text) {
    if (text === 'reconnect' && lastStatus !== 'reconnect') {
      logLine('sys', '[重连] 连接中断，正在重连...（此期间的消息会丢失）');
    } else if (text === 'open' && lastStatus === 'reconnect') {
      logLine('sys', '[重连] 已恢复');
    }
    lastStatus = text;
    const map = {
      init: ['connecting', '获取服务器配置中...'],
      connecting: ['connecting', '连接中...'],
      auth: ['connecting', '认证中...'],
      open: ['open', '已连接'],
      reconnect: ['connecting', '重连中...'],
      closed: ['error', '已断开'],
      'auth-fail': ['error', '认证失败'],
      'api-fail': ['error', '初始化失败'],
      disconnected: ['', '未连接']
    };
    const m = map[text] || ['error', text];
    els.connDot.className = 'dot ' + m[0];
    els.connText.textContent = m[1];
    els.connTextTop.textContent = m[1];
    els.connText.className = 'conn-text' + (m[0] === 'open' ? ' open' : '');
  }

  function decodeInteractPb(b64) {
    try {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      let i = 0;
      function varint() {
        let result = 0;
        let shift = 0;
        let b;
        do {
          b = bytes[i];
          i += 1;
          result += (b & 0x7f) * Math.pow(2, shift);
          shift += 7;
        } while (b & 0x80);
        return result;
      }
      const out = {};
      while (i < bytes.length) {
        const tag = varint();
        const field = tag >>> 3;
        const wire = tag & 7;
        if (wire === 0) {
          out[field] = varint();
        } else if (wire === 2) {
          const len = varint();
          out[field] = new TextDecoder().decode(bytes.slice(i, i + len));
          i += len;
        } else if (wire === 5) {
          i += 4;
        } else if (wire === 1) {
          i += 8;
        } else {
          break;
        }
      }
      return out;
    } catch (e) {
      return null;
    }
  }

  function addChat(type, uname, text) {
    if (!els.chatBody || !state.chatOn) return;
    const nearBottom = els.chatBody.scrollHeight - els.chatBody.scrollTop - els.chatBody.clientHeight < 60;
    const div = document.createElement('div');
    div.className = 'chat-row ' + type;
    if (uname) {
      const u = document.createElement('span');
      u.className = 'chat-name';
      u.textContent = uname + ': ';
      div.appendChild(u);
    }
    const c = document.createElement('span');
    c.className = 'chat-text';
    c.textContent = text;
    div.appendChild(c);
    els.chatBody.appendChild(div);
    while (els.chatBody.children.length > 150) {
      els.chatBody.removeChild(els.chatBody.firstChild);
    }
    if (nearBottom) {
      els.chatBody.scrollTop = els.chatBody.scrollHeight;
    }
  }

  function onRaw(obj) {
    const cmd = String(obj.cmd || '?').split(':')[0];
    const d = obj.data || {};
    if (cmd === 'DANMU_MSG') {
      const info = obj.info || [];
      const uname = info[2] ? info[2][1] : '';
      const msg = info[1] || '';
      addChat('danmaku', uname, msg);
      if (debugOn) logLine('danmaku', '[弹幕] ' + uname + ': ' + msg);
    } else if (cmd === 'INTERACT_WORD_V2') {
      const pb = decodeInteractPb(d.pb);
      if (pb && pb[2]) {
        if (pb[5] === 1) {
          addChat('enter', '', pb[2] + ' 进入直播间');
        }
        if (debugOn) {
          logLine('sys', '[互动] ' + pb[2] + ' msg_type=' + (pb[5] !== undefined ? pb[5] : '?'));
        }
      } else if (debugOn) {
        logLine('sys', '[CMD] INTERACT_WORD_V2');
      }
    } else if (cmd === 'SEND_GIFT') {
      if (debugOn) {
        logLine('gift', '[礼物] ' + d.uname + ' 送 ' + d.giftName + ' x' + d.num + ' coinType=' + d.coin_type + ' totalCoin=' + d.total_coin + ' price=' + d.price);
      }
    } else if (cmd === 'SUPER_CHAT_MESSAGE') {
      if (debugOn) {
        logLine('gift', '[SC] ' + (d.user_info && d.user_info.uname) + ' ¥' + d.price);
      }
    } else if (cmd === 'GUARD_BUY') {
      if (debugOn) {
        logLine('gift', '[上舰] ' + d.username + ' ' + (d.gift_name || '') + ' price=' + d.price + ' x' + d.num);
      }
    } else if (cmd === 'USER_TOAST_MSG_V2') {
      if (debugOn) {
        logLine('gift', '[上舰V2] source=' + (d.option && d.option.source) + ' price=' + (d.pay_info && d.pay_info.price) + ' x' + (d.pay_info && d.pay_info.num));
      }
    } else if (debugOn) {
      logLine('sys', '[CMD] ' + cmd);
    }
  }

  function onGift(g) {
    const yuan = toYuan(g);
    if (g.giftName === '超级留言') {
      addChat('sc', g.uname, 'SC 醒目留言  ¥' + yuan.toFixed(0));
    } else if (g.giftName === '大航海') {
      addChat('sc', g.uname, '上舰大航海 x' + g.num + '  ¥' + yuan.toFixed(0));
    } else {
      addChat('gift', g.uname, '赠送 ' + g.giftName + ' x' + g.num + '  ¥' + yuan.toFixed(2));
    }
    logLine('gift', '[计入] ' + g.uname + ' 送 ' + g.giftName + ' x' + g.num + ' coin=' + g.coin + ' -> ¥' + yuan.toFixed(2));
    if (yuan <= 0) return;
    state.total += yuan;
    state.lastGift = g.uname + ' 送出 ' + g.giftName + ' x' + g.num + '  +¥' + yuan.toFixed(2);
    save();
    render();
    if (!state.reached && state.target > 0 && state.total >= state.target) {
      onGoal();
    }
  }

  function onGoal() {
    state.reached = true;
    save();
    render();
    els.celebrateSub.textContent = '累计收到 ¥ ' + fmt(state.total);
    els.celebrateBox.classList.remove('hidden');
    if (window.Effects) {
      try {
        window.Effects.celebrate();
        window.Effects.chime();
      } catch (e) {}
    }
    window.setTimeout(() => {
      els.celebrateBox.classList.add('hidden');
    }, 7000);
  }

  function connect() {
    const roomId = String(els.roomIdInput.value || '').trim();
    if (!roomId) {
      setStatus('请输入房间号');
      return;
    }
    state.roomId = roomId;
    state.target = Math.max(0, Number(els.targetInput.value) || 0);
    save();
    render();

    if (!window.BiliLive) {
      showError('protocol.js 未加载，请检查文件是否齐全');
      return;
    }
    if (!client) {
      client = BiliLive.createClient();
      client.onStatus(setStatus);
      client.onGift(onGift);
      client.onRawCommand(onRaw);
    }
    client.connect(roomId, { uid: loginUid, buvid: loginBuvid });
    els.settingsPanel.classList.add('hidden');
  }

  function renderLoginStatus(loggedIn, uname, uid) {
    loginUid = loggedIn ? uid : 0;
    if (loggedIn) {
      els.loginStatus.textContent = '已登录: ' + uname + ' (uid=' + uid + ')';
      els.loginStatus.className = 'login-status logged-in';
      els.loginBtn.classList.add('hidden');
      els.logoutBtn.classList.remove('hidden');
      els.qrArea.classList.add('hidden');
    } else {
      els.loginStatus.textContent = '未登录（用户名将被 B 站打码，金额统计不受影响）';
      els.loginStatus.className = 'login-status';
      els.loginBtn.classList.remove('hidden');
      els.logoutBtn.classList.add('hidden');
      els.qrArea.classList.add('hidden');
    }
  }

  function stopQrPoll() {
    if (qrPollTimer) {
      clearInterval(qrPollTimer);
      qrPollTimer = null;
    }
  }

  async function startQrLogin() {
    stopQrPoll();
    if (loginUid > 0) {
      renderLoginStatus(true, els.loginStatus.textContent, loginUid);
      return;
    }
    els.qrArea.classList.add('hidden');
    try {
      const r = await fetch('/api/login/start');
      const j = await r.json();
      if (!j.ok) {
        els.qrTip.textContent = j.error || '生成二维码失败';
        return;
      }
      let dataUrl = '';
      try {
        if (typeof qrcode !== 'function') throw new Error('qrcode lib missing');
        const qr = qrcode(0, 'M');
        qr.addData(j.url);
        qr.make();
        dataUrl = qr.createDataURL(6, 6);
      } catch (e) {
        els.qrTip.textContent = '二维码生成失败: ' + e.message;
        return;
      }
      els.qrImg.src = dataUrl;
      els.qrArea.classList.remove('hidden');
      els.qrTip.textContent = '请用 B 站 APP 扫码并确认登录';
      const key = j.qrcodeKey;
      let elapsed = 0;
      qrPollTimer = setInterval(async () => {
        elapsed += 2000;
        if (elapsed > 180000) {
          stopQrPoll();
          els.qrTip.textContent = '二维码已过期，请重新点击扫码登录';
          return;
        }
        try {
          const pr = await fetch('/api/login/poll?key=' + encodeURIComponent(key));
          const pj = await pr.json();
          if (pj.ok) {
            stopQrPoll();
            renderLoginStatus(true, pj.uname, pj.uid);
            logLine('sys', '[登录] 已登录: ' + pj.uname + ' (uid=' + pj.uid + ')');
            reconnectAfterLogin();
            return;
          }
          if (pj.step === '86038') {
            stopQrPoll();
            els.qrTip.textContent = '二维码已过期，请重新点击扫码登录';
          } else if (pj.step === '86090') {
            els.qrTip.textContent = '已扫码，请在手机上确认';
          } else if (pj.step !== '86101') {
            els.qrTip.textContent = pj.message || '登录状态异常，请重试';
          }
        } catch (e) {}
      }, 2000);
    } catch (e) {
      els.qrTip.textContent = '请求失败: ' + e.message;
    }
  }

  function reconnectAfterLogin() {
    if (client && state.roomId) {
      client.connect(state.roomId, { uid: loginUid, buvid: loginBuvid });
      logLine('sys', '[登录] 已用新账号重新连接，用户名应显示完整');
    }
  }

  async function initLoginStatus() {
    try {
      const r = await fetch('/api/status');
      const j = await r.json();
      if (j.ok) {
        loginBuvid = j.buvid || '';
        renderLoginStatus(j.loggedIn, j.uname, j.uid);
      }
    } catch (e) {}
  }

  function bindEvents() {
    els.settingsBtn.addEventListener('click', () => {
      els.settingsPanel.classList.toggle('hidden');
    });
    els.closeSettings.addEventListener('click', () => {
      els.settingsPanel.classList.add('hidden');
    });
    els.saveBtn.addEventListener('click', connect);
    els.resetBtn.addEventListener('click', () => {
      state.total = 0;
      state.reached = false;
      state.lastGift = '';
      save();
      render();
    });

    document.querySelectorAll('[data-test]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.getAttribute('data-test');
        if (mode === 'goal') {
          const need = Math.max(state.target - state.total, 0.01);
          onGift({ uname: '测试用户', giftName: '测试礼物', num: 1, coinIsYuan: true, coin: need });
        } else {
          onGift({ uname: '测试用户', giftName: '测试礼物', num: 1, coinIsYuan: true, coin: Number(mode) });
        }
      });
    });

    els.barShell.addEventListener('dblclick', () => {
      els.settingsPanel.classList.toggle('hidden');
    });

    els.debugInput.addEventListener('change', () => {
      debugOn = els.debugInput.checked;
    });

    els.chatToggleInput.addEventListener('change', () => {
      state.chatOn = els.chatToggleInput.checked;
      save();
      els.chatPanel.classList.toggle('hidden', !state.chatOn);
    });

    els.loginBtn.addEventListener('click', startQrLogin);
    els.logoutBtn.addEventListener('click', async () => {
      stopQrPoll();
      try {
        await fetch('/api/login/logout');
      } catch (e) {}
      renderLoginStatus(false);
      loginUid = 0;
      logLine('sys', '[登录] 已退出登录');
      reconnectAfterLogin();
    });
  }

  function init() {
    state = load();
    const ids = [
      'settingsPanel', 'roomIdInput', 'targetInput', 'connText', 'connTextTop',
      'connDot', 'barShell', 'barFill', 'labelAmount', 'labelTarget', 'labelPct', 'labelGift',
      'celebrateBox', 'celebrateSub', 'settingsBtn', 'closeSettings', 'saveBtn', 'resetBtn',
      'debugLog', 'debugLogBody', 'debugInput',
      'chatPanel', 'chatBody', 'chatToggleInput',
      'loginStatus', 'loginBtn', 'logoutBtn', 'qrArea', 'qrImg', 'qrTip'
    ];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el) {
        showError('页面缺少元素 #' + id + '，请确认 index.html 完整');
        return;
      }
      els[id] = el;
    }

    bindEvents();
    try {
      if (window.Effects) window.Effects.init();
    } catch (e) {}
    try {
      render();
      setStatus('disconnected');
    } catch (e) {
      showError('初始化显示失败: ' + e.message);
    }
    logLine('sys', '调试日志已开启，等待连接...');
    els.qrArea.classList.add('hidden');
    initLoginStatus();

    if (state.roomId) {
      els.settingsPanel.classList.add('hidden');
      if (window.BiliLive) {
        client = BiliLive.createClient();
        client.onStatus(setStatus);
        client.onGift(onGift);
        client.onRawCommand(onRaw);
        client.connect(state.roomId, { uid: loginUid, buvid: loginBuvid });
      }
    }
  }

  window.addEventListener('error', (e) => showError(e.message || '未知错误'));
  window.addEventListener('unhandledrejection', (e) => showError(String(e.reason || '未知错误')));

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
