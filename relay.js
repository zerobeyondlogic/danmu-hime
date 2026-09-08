'use strict';

const tls = require('tls');
const crypto = require('crypto');
const { _test: protocol } = require('./js/protocol.js');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const PROTOVERS = [3, 2, 0];
const HEARTBEAT_INTERVAL = 10000;
const HEARTBEAT_TIMEOUT = 35000;
const MAX_WS_BUFFER = 32 * 1024 * 1024;
const MAX_HANDSHAKE_BUFFER = 64 * 1024;
const MAX_REPLAY_COMMANDS = 48;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

function isReplayableCommand(obj) {
  const cmd = String(obj && obj.cmd || '').split(':')[0];
  return cmd === 'DANMU_MSG' || cmd === 'SEND_GIFT' ||
    cmd === 'SUPER_CHAT_MESSAGE' || cmd === 'GUARD_BUY' ||
    cmd === 'USER_TOAST_MSG_V2';
}

function createCommandHistory(limit) {
  const items = [];
  const maxItems = Math.max(1, Number(limit) || MAX_REPLAY_COMMANDS);
  return {
    add(obj) {
      if (!isReplayableCommand(obj)) return;
      items.push(obj);
      if (items.length > maxItems) items.splice(0, items.length - maxItems);
    },
    clear() {
      items.length = 0;
    },
    snapshot() {
      return items.slice();
    }
  };
}

function buildPacket(op, body, ver) {
  const bodyBytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body);
  const buf = Buffer.alloc(16 + bodyBytes.length);
  buf.writeUInt32BE(16 + bodyBytes.length, 0);
  buf.writeUInt16BE(16, 4);
  buf.writeUInt16BE(ver, 6);
  buf.writeUInt32BE(op, 8);
  buf.writeUInt32BE(1, 12);
  bodyBytes.copy(buf, 16);
  return buf;
}

function wsServerFrame(payload) {
  const data = Buffer.from(payload, 'utf8');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, data]);
}

function createWebSocketReader(handlers) {
  let buffer = Buffer.alloc(0);
  let fragmentOpcode = null;
  let fragmentParts = [];
  let fragmentLength = 0;

  function resetFragments() {
    fragmentOpcode = null;
    fragmentParts = [];
    fragmentLength = 0;
  }

  function fail(message) {
    buffer = Buffer.alloc(0);
    resetFragments();
    if (handlers.onError) handlers.onError(new Error(message));
  }

  function emitMessage(opcode, payload) {
    if (handlers.onMessage) handlers.onMessage(payload, opcode);
  }

  function push(chunk) {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    if (buffer.length > MAX_WS_BUFFER) {
      fail('WebSocket buffer exceeded safety limit');
      return;
    }

    while (buffer.length >= 2) {
      const b0 = buffer[0];
      const b1 = buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;

      if (len === 126) {
        if (buffer.length < 4) return;
        len = buffer.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buffer.length < 10) return;
        const longLen = buffer.readBigUInt64BE(2);
        if (longLen > BigInt(Number.MAX_SAFE_INTEGER)) {
          fail('WebSocket frame length is too large');
          return;
        }
        len = Number(longLen);
        off = 10;
      }

      const maskLen = masked ? 4 : 0;
      if (len > MAX_WS_BUFFER) {
        fail('WebSocket frame exceeded safety limit');
        return;
      }
      if (buffer.length < off + maskLen + len) return;
      const mask = masked ? buffer.slice(off, off + 4) : null;
      const start = off + maskLen;
      let payload = buffer.slice(start, start + len);
      buffer = buffer.slice(start + len);

      if (mask) {
        const unmasked = Buffer.alloc(payload.length);
        for (let i = 0; i < payload.length; i += 1) {
          unmasked[i] = payload[i] ^ mask[i % 4];
        }
        payload = unmasked;
      }

      if (opcode >= 0x8) {
        if (!fin || payload.length > 125) {
          fail('Invalid fragmented WebSocket control frame');
          return;
        }
        if (opcode === 0x8) {
          if (handlers.onClose) handlers.onClose(payload);
          return;
        }
        if (opcode === 0x9) {
          if (handlers.onPing) handlers.onPing(payload);
        } else if (opcode === 0x0a && handlers.onPong) {
          handlers.onPong(payload);
        }
        continue;
      }

      if (opcode === 0x0) {
        if (fragmentOpcode === null) {
          fail('Unexpected WebSocket continuation frame');
          return;
        }
        fragmentParts.push(payload);
        fragmentLength += payload.length;
        if (fragmentLength > MAX_WS_BUFFER) {
          fail('Fragmented WebSocket message exceeded safety limit');
          return;
        }
        if (fin) {
          const complete = Buffer.concat(fragmentParts);
          const completeOpcode = fragmentOpcode;
          resetFragments();
          emitMessage(completeOpcode, complete);
        }
        continue;
      }

      if (opcode !== 0x1 && opcode !== 0x2) {
        fail('Unsupported WebSocket opcode: ' + opcode);
        return;
      }
      if (fragmentOpcode !== null) {
        fail('New WebSocket data frame arrived before continuation completed');
        return;
      }
      if (fin) {
        emitMessage(opcode, payload);
      } else {
        fragmentOpcode = opcode;
        fragmentParts = [payload];
        fragmentLength = payload.length;
      }
    }
  }

  return { push };
}

function createRelay(server, deps) {
  const { getUserInfo, roomInfoFetcher, danmuInfoFetcher, getCookies } = deps;
  const connectTls = deps.connectTls || tls.connect;
  const parseFrames = deps.parseFrames || protocol.parseFrames;
  const clients = new Set();
  const listeners = new Set();
  const commandHistory = createCommandHistory(MAX_REPLAY_COMMANDS);
  let bili = null;
  let biliRoom = null;
  let status = 'disconnected';
  let reconnectTimer = null;
  let attempts = 0;
  let closing = false;
  let hostIndex = 0;
  let protoverIndex = 0;
  let connectionGeneration = 0;

  function broadcast(obj) {
    const event = { ...obj, room: biliRoom };
    for (const listener of listeners) {
      try { listener(event); } catch (e) {
        console.error('[relay] subscriber error:', e.message);
      }
    }
    // Desktop consumers use objects directly. Only legacy browser clients
    // need a JSON copy and a WebSocket frame.
    if (clients.size === 0) return;
    const msg = wsServerFrame(JSON.stringify(obj));
    for (const c of clients) {
      try {
        c.write(msg);
      } catch (e) {}
    }
  }

  function setStatus(s) {
    status = s;
    broadcast({ t: 'status', v: s });
  }

  function scheduleRetry(generation) {
    if (closing || generation !== connectionGeneration) return;
    const delay = Math.min(30000, 1000 * Math.pow(1.5, attempts));
    attempts += 1;
    setStatus('reconnect');
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      runBilibili(generation);
    }, delay);
  }

  function stopBilibili() {
    if (bili) {
      try {
        bili.destroy();
      } catch (e) {}
      bili = null;
    }
  }

  async function runBilibili(generation) {
    if (closing || !biliRoom || generation !== connectionGeneration) return;
    setStatus('init');
    let realId = biliRoom;
    let hosts = null;
    let token = null;
    try {
      const ri = await roomInfoFetcher(biliRoom);
      if (closing || generation !== connectionGeneration) return;
      if (ri.ok && ri.roomId) realId = ri.roomId;
      const di = await danmuInfoFetcher(realId);
      if (di.ok && di.token) {
        hosts = di.hosts;
        token = di.token;
      }
    } catch (e) {}
    if (generation !== connectionGeneration) return;
    if (!token || !Array.isArray(hosts) || hosts.length === 0) {
      setStatus('api-fail');
      scheduleRetry(generation);
      return;
    }

    let user = null;
    try {
      user = await getUserInfo();
    } catch (e) {}
    if (generation !== connectionGeneration) return;
    const cookies = getCookies() || {};
    const uid = user ? user.uid : 0;
    const cookieStr = Object.entries(cookies)
      .filter(([, v]) => v)
      .map(([k, v]) => k + '=' + v)
      .join('; ');

    let heartTimer = null;
    let handshakeBuf = Buffer.alloc(0);
    let biliPacketBuf = Buffer.alloc(0);
    let gotAuthReply = false;
    let authenticated = false;
    let failoverAdvanced = false;
    let lastInboundAt = Date.now();
    let queue = Promise.resolve();

    function stopHeart() {
      if (heartTimer) {
        clearInterval(heartTimer);
        heartTimer = null;
      }
    }

    function advanceFailover(reason) {
      if (failoverAdvanced) return;
      failoverAdvanced = true;
      if (reason === 'auth' || reason === 'parse') {
        if (protoverIndex < PROTOVERS.length - 1) {
          protoverIndex += 1;
        } else {
          protoverIndex = 0;
          hostIndex = (hostIndex + 1) % hosts.length;
        }
      } else {
        hostIndex = (hostIndex + 1) % hosts.length;
      }
      console.log('[relay] failover reason=' + reason + ' nextPv=' + PROTOVERS[protoverIndex] + ' nextHost=' + hostIndex);
    }

    function startHeart(sendPacket, socket) {
      stopHeart();
      heartTimer = setInterval(() => {
        if (Date.now() - lastInboundAt > HEARTBEAT_TIMEOUT) {
          console.log('[relay] heartbeat timeout, reconnecting');
          advanceFailover('heartbeat-timeout');
          try {
            socket.destroy();
          } catch (e) {}
          return;
        }
        sendPacket(buildPacket(2, '{}', 1));
      }, HEARTBEAT_INTERVAL);
    }

    function handleFrame(f, socket, sendPacket) {
      if (closing || generation !== connectionGeneration || bili !== socket || socket.destroyed) return;
      if (f.op === 8) {
        gotAuthReply = true;
        let code = -1;
        try {
          code = JSON.parse(Buffer.from(f.body).toString('utf8')).code;
        } catch (e) {
          console.log('[relay] auth reply parse error:', e.message);
        }
        if (code === 0) {
          authenticated = true;
          attempts = 0;
          setStatus('open');
          console.log('[relay] auth OK, starting stream');
          sendPacket(buildPacket(2, '{}', 1));
          startHeart(sendPacket, socket);
        } else {
          advanceFailover('auth');
          try {
            socket.destroy();
          } catch (e) {}
        }
      } else if (f.op === 5) {
        let obj = null;
        try {
          obj = JSON.parse(Buffer.from(f.body).toString('utf8'));
        } catch (e) {
          console.log('[relay] cmd parse error:', e.message);
        }
        if (obj) {
          commandHistory.add(obj);
          broadcast({ t: 'cmd', v: obj });
        }
      }
    }

    function enqueueChunk(chunk, socket, sendPacket) {
      queue = queue
        .then(async () => {
          if (closing || generation !== connectionGeneration || bili !== socket || socket.destroyed) return;
          biliPacketBuf = Buffer.concat([biliPacketBuf, Buffer.from(chunk)]);
          if (biliPacketBuf.length > MAX_WS_BUFFER) throw new Error('Bilibili packet buffer exceeded safety limit');
          const { frames, rest } = await parseFrames(new Uint8Array(biliPacketBuf));
          // Decompression can finish after a room switch or a reconnect.
          if (closing || generation !== connectionGeneration || bili !== socket || socket.destroyed) return;
          biliPacketBuf = Buffer.from(rest);
          for (const f of frames) handleFrame(f, socket, sendPacket);
        })
        .catch((e) => {
          if (closing || generation !== connectionGeneration || bili !== socket || socket.destroyed) return;
          console.log('[relay] packet parse error:', e.message);
          advanceFailover('parse');
          try {
            socket.destroy();
          } catch (e) {}
        });
    }

    function connectOnce(host, port, realId) {
      setStatus('connecting');
      const socket = connectTls({ host: host, port: port }, () => {
        if (closing || generation !== connectionGeneration || bili !== socket || socket.destroyed) return;
        const key = crypto.randomBytes(16).toString('base64');
        const headers = [
          'GET /sub HTTP/1.1',
          'Host: ' + host + ':' + port,
          'Upgrade: websocket',
          'Connection: Upgrade',
          'Sec-WebSocket-Key: ' + key,
          'Sec-WebSocket-Version: 13',
          'Origin: http://localhost:3000',
          'User-Agent: ' + UA
        ];
        if (cookieStr !== '') headers.push('Cookie: ' + cookieStr);
        socket.write(headers.join('\r\n') + '\r\n\r\n');
      });
      bili = socket;
      let upgraded = false;
      const sendPacket = (packet) => {
        if (bili === socket && socket.destroyed === false) {
          socket.write(wsClientFrame(packet, 0x2));
        }
      };
      const wsReader = createWebSocketReader({
        onMessage: (payload, opcode) => {
          if (opcode === 0x1 || opcode === 0x2) enqueueChunk(payload, socket, sendPacket);
        },
        onPing: (payload) => {
          if (!socket.destroyed) socket.write(wsClientFrame(payload, 0x0a));
        },
        onClose: () => {
          try {
            socket.destroy();
          } catch (e) {}
        },
        onError: (e) => {
          console.log('[relay] websocket frame error:', e.message);
          try {
            socket.destroy();
          } catch (err) {}
        }
      });

      socket.on('data', (d) => {
        if (closing || generation !== connectionGeneration || bili !== socket || socket.destroyed) return;
        lastInboundAt = Date.now();
        if (!upgraded) {
          handshakeBuf = Buffer.concat([handshakeBuf, d]);
          if (handshakeBuf.length > MAX_HANDSHAKE_BUFFER) {
            socket.destroy();
            return;
          }
          const idx = handshakeBuf.indexOf('\r\n\r\n');
          if (idx === -1) return;
          const head = handshakeBuf.slice(0, idx).toString();
          if (!/^HTTP\/1\.[01] 101\b/.test(head)) {
            console.log('[relay] bilibili handshake fail:', head.split('\r\n')[0]);
            try {
              socket.destroy();
            } catch (e) {}
            return;
          }
          upgraded = true;
          const wsRemainder = handshakeBuf.slice(idx + 4);
          handshakeBuf = Buffer.alloc(0);
          const auth = {
            uid: uid,
            roomid: realId,
            protover: PROTOVERS[protoverIndex],
            platform: 'web',
            type: 2,
            key: token
          };
          if (cookies.buvid3) auth.buvid = cookies.buvid3;
          const packet = buildPacket(7, JSON.stringify(auth), 1);
          socket.write(wsClientFrame(packet, 0x2));
          console.log('[relay] auth sent: uid=' + uid + ' room=' + realId + ' pv=' + PROTOVERS[protoverIndex] + ' host=' + host + ':' + port);
          setStatus('auth');
          if (wsRemainder.length > 0) wsReader.push(wsRemainder);
        } else {
          wsReader.push(d);
        }
      });

      socket.on('close', () => {
        stopHeart();
        if (bili === socket) bili = null;
        if (!closing && generation === connectionGeneration) {
          setStatus('closed');
          console.log('[relay] bilibili connection closed, authReply=' + gotAuthReply + ' authenticated=' + authenticated);
          if (!failoverAdvanced) advanceFailover(authenticated ? 'stream-close' : 'connect-close');
          scheduleRetry(generation);
        }
      });

      socket.on('error', () => {
        try {
          socket.destroy();
        } catch (e) {}
      });
    }

    const selectedHost = hosts[hostIndex % hosts.length];
    connectOnce(selectedHost.host, selectedHost.wss_port || 443, realId);
  }

  function connectRoom(wantRoom) {
    wantRoom = String(wantRoom || '').trim();
    if (!/^\d+$/.test(wantRoom)) {
      disconnectRoom();
      return;
    }
    if (wantRoom === biliRoom) return;
    commandHistory.clear();
    biliRoom = wantRoom;
    reconnectCurrent();
  }

  function disconnectRoom() {
    closing = true;
    connectionGeneration += 1;
    biliRoom = null;
    commandHistory.clear();
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    stopBilibili();
    setStatus('disconnected');
  }

  function reconnectCurrent() {
    if (!biliRoom) return;
    closing = false;
    attempts = 0;
    hostIndex = 0;
    protoverIndex = 0;
    connectionGeneration += 1;
    const generation = connectionGeneration;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    stopBilibili();
    runBilibili(generation);
  }

  function shutDown() {
    disconnectRoom();
    for (const c of clients) {
      try {
        c.destroy();
      } catch (e) {}
    }
    clients.clear();
    listeners.clear();
  }

  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch (e) {
      socket.destroy();
      return;
    }
    if (url.pathname !== '/relay') {
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
    );
    clients.add(socket);
    socket.on('close', () => {
      clients.delete(socket);
    });
    socket.on('error', () => {
      clients.delete(socket);
    });
    socket.on('data', () => {});
    const want = url.searchParams.get('room');
    if (want) connectRoom(want);
    socket.write(wsServerFrame(JSON.stringify({ t: 'status', v: status })));
    if (want && want === biliRoom) {
      for (const command of commandHistory.snapshot()) {
        socket.write(wsServerFrame(JSON.stringify({ t: 'cmd', v: command })));
      }
    }
  });

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { connectRoom, reconnectCurrent, disconnectRoom, subscribe, shutDown };
}

function wsClientFrame(payload, opcode, fin) {
  const data = Buffer.from(payload);
  const len = data.length;
  const mask = crypto.randomBytes(4);
  const firstByte = (fin === false ? 0 : 0x80) | (opcode === undefined ? 0x2 : opcode);
  let header;
  if (len < 126) {
    header = Buffer.from([firstByte, 0x80 | len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = firstByte;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = firstByte;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i += 1) {
    masked[i] = data[i] ^ mask[i % 4];
  }
  return Buffer.concat([header, mask, masked]);
}

module.exports = {
  createRelay,
  _test: { buildPacket, createWebSocketReader, wsClientFrame, isReplayableCommand, createCommandHistory }
};
