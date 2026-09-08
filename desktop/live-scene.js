'use strict';

const emotes = require('../js/emotes.js');
const avatars = require('../js/avatars.js');
const { extractGift } = require('../js/protocol.js')._test;

const GUARD_ROLES = { 1: 'governor', 2: 'admiral', 3: 'captain' };

function resolveRole(ownerUid, uid, isManager, guardLevel) {
  if (ownerUid > 0 && Number(uid) === ownerUid) return 'host';
  if (isManager) return 'manager';
  return GUARD_ROLES[Number(guardLevel) || 0] || 'viewer';
}

function guardLevelFromName(name) {
  const text = String(name || '');
  if (text.includes('总督')) return 1;
  if (text.includes('提督')) return 2;
  if (text.includes('舰长')) return 3;
  return 0;
}

function normalizeCommand(obj, ownerUid, roomEmoteAliases) {
  if (!obj || typeof obj !== 'object') return null;
  const cmd = String(obj.cmd || '').split(':')[0];
  if (cmd === 'DANMU_MSG') {
    const info = Array.isArray(obj.info) ? obj.info : [];
    const user = Array.isArray(info[2]) ? info[2] : [];
    const medal = Array.isArray(info[3]) ? info[3] : [];
    const uid = Number(user[0]) || 0;
    const text = String(info[1] || '');
    const packetEmotes = emotes.extractDanmakuEmotes(obj, info);
    return {
      type: 'chat',
      uid,
      uname: user[1] || '',
      text,
      emotes: emotes.mergeRoomEmotes(text, packetEmotes, roomEmoteAliases),
      avatarUrl: avatars.extractDanmakuAvatar(obj, info),
      role: resolveRole(ownerUid, uid, Number(user[2]) === 1, Number(info[7]) || 0),
      medal: medal[1] ? String(medal[1]) + ' ' + (Number(medal[0]) || 0) : ''
    };
  }

  const gift = extractGift(obj);
  if (!gift) return null;
  const data = obj.data || {};
  const userInfo = data.user_info || {};
  const senderBase = data.sender_uinfo && data.sender_uinfo.base ? data.sender_uinfo.base : {};
  const medal = data.medal_info || userInfo.medal_info || {};
  const uid = Number(data.uid || userInfo.uid || senderBase.uid) || 0;
  const isManager = Number(userInfo.manager || data.is_admin) === 1;
  const guardLevel = Number(data.guard_level || userInfo.guard_level) || guardLevelFromName(gift.giftName);
  const kind = cmd === 'SUPER_CHAT_MESSAGE' ? 'sc' : (cmd === 'GUARD_BUY' || cmd === 'USER_TOAST_MSG_V2' ? 'guard' : 'gift');
  let text;
  if (kind === 'sc') text = data.message || '超级留言';
  else if (kind === 'guard') text = '开通  ' + (gift.giftName || '大航海') + (Number(gift.num) > 1 ? ' × ' + gift.num : '');
  else text = '赠送  ' + (gift.giftName || '礼物') + ' × ' + (Number(gift.num) || 1);
  return {
    type: kind === 'sc' ? 'sc' : 'gift',
    kind,
    uid,
    uname: gift.uname || userInfo.uname || senderBase.name || '匿名用户',
    avatarUrl: avatars.extractEventAvatar(obj),
    text,
    role: resolveRole(ownerUid, uid, isManager, guardLevel),
    medal: medal.medal_name ? String(medal.medal_name) + ' ' + (Number(medal.medal_level) || 0) : '',
    valueYuan: gift.coinIsYuan ? Number(gift.coin) || 0 : (Number(gift.coin) || 0) / 1000
  };
}

// The live stream belongs to the main process, independently of any preview
// or settings window. Neither this service nor its dependencies create a DOM,
// a Canvas, a bitmap font, or an avatar download.
function createLiveScene({ relay, getRoomInfo, getRoomEmotes, onMessage, onStatus, now = Date.now }) {
  let generation = 0;
  let room = '';
  let ownerUid = 0;
  let roomEmoteAliases = {};
  let lastMessageAt = null;
  let unsubscribe = null;
  let disposed = false;

  function stopListening() {
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
  }

  function report(status) {
    if (onStatus) onStatus(status);
  }

  async function connect(roomId) {
    if (disposed) return;
    const requested = String(roomId || '').trim();
    const nextRoom = /^\d+$/.test(requested) ? requested : '';
    const currentGeneration = ++generation;
    const isCurrent = () => !disposed && generation === currentGeneration && room === nextRoom;
    if (room !== nextRoom) lastMessageAt = null;
    room = nextRoom;
    ownerUid = 0;
    roomEmoteAliases = {};
    stopListening();
    // Stop immediately, before waiting for metadata. Old-room messages must
    // never appear in the new scene while an API request is pending.
    relay.disconnectRoom();
    if (!room) {
      report('disconnected');
      return;
    }
    report('init');
    let ready = false;
    unsubscribe = relay.subscribe((event) => {
      if (!isCurrent() || !ready || !event || String(event.room || '') !== nextRoom) return;
      if (event.t === 'status') {
        report(event.v);
        return;
      }
      if (event.t !== 'cmd') return;
      const message = normalizeCommand(event.v, ownerUid, roomEmoteAliases);
      if (!message) return;
      const at = now();
      const date = new Date(at);
      const time = [date.getHours(), date.getMinutes(), date.getSeconds()]
        .map((part) => String(part).padStart(2, '0')).join(':');
      const gapMs = lastMessageAt === null ? null : Math.max(0, at - lastMessageAt);
      lastMessageAt = at;
      onMessage({ ...message, at, time, gapMs, emotes: { ...message.emotes } });
    });

    let resolvedRoomId = nextRoom;
    try {
      const result = await getRoomInfo(nextRoom);
      if (!isCurrent()) return;
      if (result && result.ok) {
        ownerUid = Number(result.ownerUid) || 0;
        if (/^\d+$/.test(String(result.roomId || ''))) resolvedRoomId = String(result.roomId);
      }
    } catch (e) {
      if (!isCurrent()) return;
    }
    if (!isCurrent()) return;

    Promise.resolve().then(() => {
      if (isCurrent()) return getRoomEmotes(resolvedRoomId);
      return null;
    }).then((result) => {
      if (!isCurrent()) return;
      roomEmoteAliases = result && result.ok ? emotes.buildRoomEmoteAliases(result.emotes) : {};
    }).catch(() => {
      if (isCurrent()) roomEmoteAliases = {};
    });

    ready = true;
    // disconnectRoom cleared the relay's room ID, so reconnecting the same
    // room cannot be swallowed by connectRoom's duplicate-room guard.
    relay.connectRoom(nextRoom);
  }

  function reconnect() {
    return connect(room);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    generation += 1;
    room = '';
    ownerUid = 0;
    roomEmoteAliases = {};
    lastMessageAt = null;
    stopListening();
    relay.disconnectRoom();
  }

  return { connect, reconnect, dispose };
}

module.exports = { createLiveScene };
