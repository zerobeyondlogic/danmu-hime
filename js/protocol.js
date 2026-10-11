(function () {
  'use strict';

  const giftEvents = typeof module !== 'undefined' && module.exports
    ? require('./gift-events.js') : window.BiliGiftEvents;

  const OP_NOTIFY = 5;
  const MAX_PACKET_BYTES = 32 * 1024 * 1024;
  const MAX_DECODE_DEPTH = 4;
  const MAX_DECODE_FRAMES = 65536;
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

  async function decompress(data, format, budget) {
    const ds = new DecompressionStream(format);
    const reader = new Blob([data]).stream().pipeThrough(ds).getReader();
    const chunks = [];
    let length = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        budget.bytes -= value.length;
        if (budget.bytes < 0) {
          await reader.cancel();
          throw new Error('Bilibili decompression exceeded safety limit');
        }
        chunks.push(value);
        length += value.length;
      }
    } finally { reader.releaseLock(); }
    const output = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
    return output;
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

  async function parseFrames(buf, budget = { bytes: MAX_PACKET_BYTES, frames: MAX_DECODE_FRAMES }, depth = 0) {
    if (buf.length > MAX_PACKET_BYTES || depth > MAX_DECODE_DEPTH) throw new Error('Bilibili packet exceeded safety limit');
    const frames = [];
    let off = 0;
    while (off + 16 <= buf.length) {
      const h = readHeader(buf, off);
      if (h.totalLen < 16 || h.totalLen > MAX_PACKET_BYTES || h.headerLen < 16 || h.headerLen > h.totalLen) {
        throw new Error('Invalid Bilibili packet header');
      }
      if (off + h.totalLen > buf.length) break;
      if (--budget.frames < 0) throw new Error('Bilibili frame count exceeded safety limit');
      const body = buf.slice(off + h.headerLen, off + h.totalLen);
      frames.push({ op: h.op, ver: h.ver, body });
      off += h.totalLen;
    }
    const rest = buf.slice(off);
    const payloads = [];
    for (const f of frames) {
      if (f.ver === 2 || f.ver === 3) {
        if (depth >= MAX_DECODE_DEPTH) throw new Error('Bilibili compression nesting exceeded safety limit');
        const inner = await parseFrames(await decompress(f.body, f.ver === 2 ? 'deflate' : 'brotli', budget), budget, depth + 1);
        if (inner.rest.length) throw new Error('Truncated compressed Bilibili packet');
        payloads.push(...inner.frames);
      } else {
        payloads.push(f);
      }
    }
    return { frames: payloads, rest };
  }

  function nonNegativeAmount(value) {
    if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 && number <= Number.MAX_SAFE_INTEGER ? number : null;
  }

  function guardInteger(value) {
    const number = nonNegativeAmount(value);
    return Number.isSafeInteger(number) ? number : 0;
  }

  function extractGuard(obj) {
    const source = String(obj && obj.cmd || '').split(':')[0];
    if (!['GUARD_BUY', 'USER_TOAST_MSG', 'USER_TOAST_MSG_V2'].includes(source)) return null;
    const data = obj && obj.data || {};
    const isV2 = source === 'USER_TOAST_MSG_V2';
    if (Number(isV2 ? data.option && data.option.source : data.source) === 2) return null;
    const sender = isV2 ? data.sender_uinfo || {} : {};
    const base = sender.base || {};
    const guard = isV2 ? data.guard_info || {} : data;
    const pay = isV2 ? data.pay_info || {} : data;
    const gift = isV2 ? data.gift_info || {} : data;
    const quantity = guardInteger(pay.num);
    const level = guardInteger(guard.guard_level);
    const guardLevel = level >= 1 && level <= 3 ? level : 0;
    const givenName = typeof gift.gift_name === 'string' ? gift.gift_name.trim() : '';
    const roleName = typeof guard.role_name === 'string' ? guard.role_name.trim() : '';
    const username = isV2 ? base.name : data.username;
    const price = nonNegativeAmount(pay.price);
    // GUARD_BUY.price is the list price, not the amount paid.
    // USER_TOAST_MSG(_V2) supplies the paid unit price in gold coins.
    // https://github.com/pskdje/bilibili-API-collect/blob/main/docs/live/message_stream.md#L1104-L1183
    // V2 total = pay_info.price * pay_info.num (1000 gold coins = RMB 1):
    // https://github.com/xfgryujk/blivechat/blob/848409df78d2cca65d3cc8ffe938eb6b6f261b76/frontend/src/api/chat/ChatClientDirectWeb.js#L215-L248
    const total = source !== 'GUARD_BUY' && Number.isSafeInteger(price) && quantity > 0
      ? price * quantity : null;
    return {
      source,
      uid: isV2 ? guardInteger(sender.uid) || guardInteger(base.uid) : guardInteger(data.uid),
      uname: typeof username === 'string' ? username.trim() : '',
      giftName: givenName || roleName || ({ 1: '总督', 2: '提督', 3: '舰长' })[guardLevel] || '大航海',
      guardLevel,
      num: quantity > 0 ? quantity : 1,
      coin: Number.isSafeInteger(total) && total >= 0 ? total : null,
      coinIsYuan: false,
      startTime: guardInteger(guard.start_time),
      endTime: guardInteger(guard.end_time),
      payflowId: typeof pay.payflow_id === 'string' && pay.payflow_id.length <= 160 ? pay.payflow_id.trim() : ''
    };
  }

  function extractLegacyGift(obj) {
    const cmd = String(obj.cmd || '').split(':')[0];
    const d = obj.data || {};
    if (cmd === 'SEND_GIFT') {
      if (d.coin_type !== 'gold') return null;
      const quantity = nonNegativeAmount(d.num);
      const num = Number.isSafeInteger(quantity) && quantity > 0 ? quantity : 1;
      const isBlindGift = d.blind_gift && typeof d.blind_gift === 'object' &&
        !Array.isArray(d.blind_gift) && Object.keys(d.blind_gift).length > 0;
      // In a blind-box packet, price is the drawn gift's unit value;
      // total_coin and blind_gift.original_gift_price describe the box cost.
      // https://github.com/xfgryujk/blivedm/blob/3bf17fe862b8c2fc6bc04c81c3f0c5db95de93d6/blivedm/models/web.py#L286
      // gift_tip_price/discount_price are not verified as drawn-gift values;
      // do not substitute them or use cumulative combo counts.
      const amount = nonNegativeAmount(isBlindGift ? d.price : d.total_coin);
      const coin = amount === null ? null : amount * (isBlindGift ? num : 1);
      return {
        uname: d.uname,
        giftName: d.giftName,
        num,
        coin: Number.isFinite(coin) && coin <= Number.MAX_SAFE_INTEGER ? coin : (isBlindGift ? null : 0),
        coinIsYuan: false
      };
    }
    if (cmd === 'SUPER_CHAT_MESSAGE') {
      return {
        uname: d.user_info && d.user_info.uname,
        giftName: '超级留言',
        num: 1,
        coin: nonNegativeAmount(d.price),
        coinIsYuan: true
      };
    }
    if (cmd === 'GUARD_BUY' || cmd === 'USER_TOAST_MSG' || cmd === 'USER_TOAST_MSG_V2') {
      const guard = extractGuard(obj);
      if (!guard) return null;
      return {
        uname: guard.uname,
        giftName: guard.giftName,
        num: guard.num,
        coin: guard.coin,
        coinIsYuan: false
      };
    }
    return null;
  }

  function extractGifts(obj) {
    return giftEvents.expandGiftCommands(obj).map(extractLegacyGift).filter(Boolean);
  }

  function extractGift(obj) {
    return extractGifts(obj)[0] || null;
  }

  function createClient() {
    let ws = null;
    let roomId = null;
    let reconnectTimer = null;
    let attempts = 0;
    let closedByUser = false;
    let generation = 0;
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
      const expectedGeneration = generation;
      const delay = Math.min(30000, 3000 * Math.pow(1.5, attempts));
      attempts += 1;
      emitStatus('reconnect');
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (!closedByUser && generation === expectedGeneration) openRelay();
      }, delay);
    }

    function openRelay() {
      if (closedByUser) return;
      const expectedGeneration = generation;
      let socket;
      emitStatus('connecting');
      try {
        socket = new WebSocket(relayUrl());
        ws = socket;
      } catch (e) {
        scheduleReconnect();
        return;
      }
      const isCurrent = () => !closedByUser && generation === expectedGeneration && ws === socket;
      socket.onopen = function () {
        if (!isCurrent()) return;
        attempts = 0;
        emitStatus('connecting');
      };
      socket.onmessage = function (ev) {
        if (!isCurrent()) return;
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
          extractGifts(msg.v).forEach(emitGift);
        }
      };
      socket.onclose = function () {
        if (!isCurrent()) return;
        ws = null;
        emitStatus('closed');
        scheduleReconnect();
      };
      socket.onerror = function () {
        if (!isCurrent()) return;
        try {
          socket.close();
        } catch (e) {}
      };
    }

    function connect(rid, opts) {
      generation += 1;
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
      generation += 1;
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
        extractGifts: extractGifts,
        extractGuard: extractGuard,
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
      extractGifts: extractGifts,
      extractGuard: extractGuard,
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
