(function () {
  'use strict';

  const OP_NOTIFY = 5;
  const encoder = new TextEncoder();

  function buildPacket(op, body, ver) {
    const headerLen = 16;
    const bodyBytes = typeof body === 'string' ? encoder.encode(body) : body;
    const total = headerLen + bodyBytes.length;
    const buf = new ArrayBuffer(total);
    const dv = new DataView(buf);
    dv.setUint32(0, total);
    dv.setUint16(4, headerLen);
    dv.setUint16(6, ver);
    dv.setUint32(8, op);
    dv.setUint32(12, 1);
    new Uint8Array(buf, headerLen).set(bodyBytes);
    return new Uint8Array(buf);
  }

  async function decompress(data, format) {
    const ds = new DecompressionStream(format);
    const out = await new Response(new Blob([data]).stream().pipeThrough(ds)).arrayBuffer();
    return new Uint8Array(out);
  }

  function readHeader(buf, offset) {
    const dv = new DataView(buf.buffer, buf.byteOffset + offset, buf.length - offset);
    return {
      totalLen: dv.getUint32(0),
      headerLen: dv.getUint16(4),
      ver: dv.getUint16(6),
      op: dv.getUint32(8)
    };
  }

  async function parseFrames(buf) {
    const frames = [];
    let off = 0;
    while (off + 16 <= buf.length) {
      const h = readHeader(buf, off);
      if (h.totalLen < 16 || off + h.totalLen > buf.length) break;
      const body = buf.slice(off + h.headerLen, off + h.totalLen);
      frames.push({ op: h.op, ver: h.ver, body });
      off += h.totalLen;
    }
    const rest = buf.slice(off);
    const payloads = [];
    for (const f of frames) {
      if (f.ver === 2) {
        const inner = await parseFrames(await decompress(f.body, 'deflate'));
        payloads.push(...inner.frames);
      } else if (f.ver === 3) {
        const inner = await parseFrames(await decompress(f.body, 'brotli'));
        payloads.push(...inner.frames);
      } else {
        payloads.push(f);
      }
    }
    return { frames: payloads, rest };
  }

  function extractGift(obj) {
    const cmd = String(obj.cmd || '').split(':')[0];
    const d = obj.data || {};
    if (cmd === 'SEND_GIFT') {
      if (d.coin_type !== 'gold') return null;
      return {
        uname: d.uname,
        giftName: d.giftName,
        num: d.num || 1,
        coin: d.total_coin || 0,
        coinIsYuan: false
      };
    }
    if (cmd === 'SUPER_CHAT_MESSAGE') {
      return {
        uname: d.user_info && d.user_info.uname,
        giftName: '超级留言',
        num: 1,
        coin: d.price || 0,
        coinIsYuan: true
      };
    }
    if (cmd === 'GUARD_BUY') {
      return {
        uname: d.username,
        giftName: d.gift_name || '大航海',
        num: d.num || 1,
        coin: (d.price || 0) * (d.num || 1),
        coinIsYuan: false
      };
    }
    if (cmd === 'USER_TOAST_MSG_V2') {
      if (d.option && d.option.source === 2) return null;
      return {
        uname: d.sender_uinfo && d.sender_uinfo.base && d.sender_uinfo.base.name,
        giftName: d.gift_info && d.gift_info.gift_name ? d.gift_info.gift_name : '大航海',
        num: (d.pay_info && d.pay_info.num) || 1,
        coin: d.pay_info ? (d.pay_info.price || 0) * (d.pay_info.num || 1) : 0,
        coinIsYuan: false
      };
    }
    return null;
  }

  function createClient() {
    let ws = null;
    let roomId = null;
    let reconnectTimer = null;
    let attempts = 0;
    let closedByUser = false;
    const listeners = { status: [], gift: [], raw: [] };

    function emitStatus(text) {
      listeners.status.forEach((cb) => cb(text));
    }

    function emitGift(g) {
      listeners.gift.forEach((cb) => cb(g));
    }

    function emitRaw(cmd) {
      listeners.raw.forEach((cb) => cb(cmd));
    }

    function relayUrl() {
      const proto = typeof location !== 'undefined' && location.protocol === 'https:' ? 'wss://' : 'ws://';
      const host = typeof location !== 'undefined' ? location.host : 'localhost:3000';
      return proto + host + '/relay?room=' + encodeURIComponent(roomId || '');
    }

    function scheduleReconnect() {
      if (closedByUser) return;
      const delay = Math.min(30000, 3000 * Math.pow(1.5, attempts));
      attempts += 1;
      emitStatus('reconnect');
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(openRelay, delay);
    }

    function openRelay() {
      emitStatus('connecting');
      try {
        ws = new WebSocket(relayUrl());
      } catch (e) {
        scheduleReconnect();
        return;
      }
      ws.onopen = function () {
        attempts = 0;
        emitStatus('connecting');
      };
      ws.onmessage = function (ev) {
        let msg = null;
        try {
          msg = JSON.parse(ev.data);
        } catch (e) {
          return;
        }
        if (!msg) return;
        if (msg.t === 'status') {
          emitStatus(msg.v);
        } else if (msg.t === 'cmd') {
          emitRaw(msg.v);
          const g = extractGift(msg.v);
          if (g) emitGift(g);
        }
      };
      ws.onclose = function () {
        if (!closedByUser) {
          emitStatus('closed');
          scheduleReconnect();
        }
      };
      ws.onerror = function () {
        try {
          ws.close();
        } catch (e) {}
      };
    }

    function connect(rid, opts) {
      roomId = rid;
      closedByUser = false;
      attempts = 0;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        try {
          ws.close();
        } catch (e) {}
      }
      openRelay();
    }

    function disconnect() {
      closedByUser = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws) {
        try {
          ws.close();
        } catch (e) {}
      }
      ws = null;
    }

    return {
      connect: connect,
      disconnect: disconnect,
      onStatus: function (cb) {
        listeners.status.push(cb);
      },
      onGift: function (cb) {
        listeners.gift.push(cb);
      },
      onRawCommand: function (cb) {
        listeners.raw.push(cb);
      },
      _test: {
        buildPacket: buildPacket,
        parseFrames: parseFrames,
        extractGift: extractGift,
        OP_NOTIFY: OP_NOTIFY
      }
    };
  }

  const BiliLive = {
    createClient: createClient,
    _test: {
      buildPacket: buildPacket,
      parseFrames: parseFrames,
      extractGift: extractGift,
      OP_NOTIFY: OP_NOTIFY
    }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = BiliLive;
  }
  if (typeof window !== 'undefined') {
    window.BiliLive = BiliLive;
  }
})();
