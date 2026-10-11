'use strict';

const emotes = require('../js/emotes.js');
const avatars = require('../js/avatars.js');
const { extractGift, extractGuard } = require('../js/protocol.js')._test;
const { expandGiftCommands } = require('../js/gift-events.js');
const { normalizeEntryCommand } = require('./entry-events.js');
const { createGuardMessages } = require('./guard-messages.js');

const GUARD_ROLES = { 1: 'governor', 2: 'admiral', 3: 'captain' };
const ENTRY_DEDUP_MS = 3000;
const MAX_RECENT_ENTRIES = 256;
const MAX_RECENT_SC = 4096;

function scSourceId(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : '';
  if (typeof value !== 'string' || !/^\d{1,32}$/.test(value)) return '';
  return value.replace(/^0+/, '') || '';
}

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

function extractGiftArt(data, kind) {
  const info = data.gift_info || {};
  const scGift = kind === 'sc' ? data.gift || {} : {};
  const rawId = data.giftId || data.gift_id || info.gift_id || scGift.gift_id;
  const id = (typeof rawId === 'number' || typeof rawId === 'string') ? Number(rawId) : 0;
  const giftId = Number.isSafeInteger(id) && id > 0 ? id : 0;
  let giftImageUrl = '';
  // V2 provides the drawn gift's image in gift_info. Never use blind_gift's
  // original gift here: that is the box, not the item the viewer received.
  for (const value of [info.img_basic, scGift.img_basic, data.img_basic]) {
    if (typeof value !== 'string' || value.length > 2048) continue;
    giftImageUrl = emotes.safeEmoteUrl(value);
    if (giftImageUrl) break;
  }
  // Absent artwork remains absent, so a later guard companion packet cannot
  // erase artwork already attached to the same purchase.
  return { ...(giftId ? { giftId } : {}), ...(giftImageUrl ? { giftImageUrl } : {}) };
}

function normalizeCommand(obj, ownerUid, roomEmoteAliases, guard) {
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

  const gift = guard || extractGift(obj);
  if (!gift) return null;
  const data = obj.data || {};
  const userInfo = data.user_info || {};
  const senderBase = data.sender_uinfo && data.sender_uinfo.base ? data.sender_uinfo.base : {};
  const medal = data.medal_info || userInfo.medal_info || {};
  const uid = Number((guard && guard.uid) || data.uid || userInfo.uid || (data.sender_uinfo && data.sender_uinfo.uid) || senderBase.uid) || 0;
  const isManager = Number(userInfo.manager || data.is_admin) === 1;
  const guardLevel = Number((guard && guard.guardLevel) || data.guard_level || userInfo.guard_level) || guardLevelFromName(gift.giftName);
  const kind = cmd === 'SUPER_CHAT_MESSAGE' ? 'sc' : (guard ? 'guard' : 'gift');
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
    ...extractGiftArt(data, kind),
    text,
    role: resolveRole(ownerUid, uid, isManager, guardLevel),
    medal: medal.medal_name ? String(medal.medal_name) + ' ' + (Number(medal.medal_level) || 0) : '',
    ...(gift.coin === null ? {} : {
      valueYuan: gift.coinIsYuan ? Number(gift.coin) || 0 : (Number(gift.coin) || 0) / 1000
    })
  };
}

// The live stream belongs to the main process, independently of any preview
// or settings window. Neither this service nor its dependencies create a DOM,
// a Canvas, a bitmap font, or an avatar download.
function createLiveScene({ relay, getRoomInfo, getRoomEmotes, onMessage, onMessageUpdate, onMessageDelete, onEntry, onStatus, onDiagnostic, now = Date.now }) {
  let generation = 0;
  let room = '';
  let ownerUid = 0;
  let roomEmoteAliases = {};
  let lastMessageAt = null;
  let unsubscribe = null;
  let disposed = false;
  const recentEntries = new Map();
  const recentSc = new Map();
  function rememberSc(id, entry) {
    recentSc.delete(id);
    recentSc.set(id, entry);
    if (recentSc.size > MAX_RECENT_SC) recentSc.delete(recentSc.keys().next().value);
  }
  function publishMessage(message) {
    const at = now();
    const date = new Date(at);
    const time = [date.getHours(), date.getMinutes(), date.getSeconds()]
      .map((part) => String(part).padStart(2, '0')).join(':');
    const gapMs = lastMessageAt === null ? null : Math.max(0, at - lastMessageAt);
    lastMessageAt = at;
    const formatted = { ...message, at, time, gapMs, emotes: { ...message.emotes } };
    return { message: formatted, receipt: onMessage(formatted) };
  }
  function publishSc(command, message) {
    const id = scSourceId(command.data && command.data.id);
    const previous = id && recentSc.get(id);
    if (previous) {
      if (previous.deleted) return;
      // Repeated server IDs refine a receipt; they never create a fresh card,
      // lifetime or notification, including after local dismissal/expiry.
      const merged = { ...message, at: previous.at, time: previous.time, gapMs: previous.gapMs };
      if (!merged.avatarUrl) delete merged.avatarUrl;
      rememberSc(id, previous);
      if (typeof onMessageUpdate === 'function' && previous.receipt && previous.receipt.id) {
        onMessageUpdate(previous.receipt.id, merged);
      }
      return;
    }
    const published = publishMessage(message);
    // Keep only correlation metadata, never another copy of user text/art.
    if (id) rememberSc(id, { receipt: published.receipt && { id: published.receipt.id },
      at: published.message.at, time: published.message.time, gapMs: published.message.gapMs });
  }
  function deleteSc(command) {
    const ids = command.data && command.data.ids;
    if (!Array.isArray(ids)) return null;
    const localIds = new Set();
    for (const value of ids.slice(0, MAX_RECENT_SC)) {
      const id = scSourceId(value);
      if (!id) continue;
      const previous = recentSc.get(id);
      if (previous && !previous.deleted && previous.receipt && previous.receipt.id) localIds.add(previous.receipt.id);
      // Deletion may beat its original SC. A bounded tombstone prevents a
      // subsequently delivered/resent message from resurrecting it.
      rememberSc(id, { deleted: true });
    }
    return [...localIds];
  }
  const guardMessages = createGuardMessages({
    now,
    publish: publishMessage,
    update: (receipt, message) => {
      if (typeof onMessageUpdate === 'function' && receipt && receipt.id) onMessageUpdate(receipt.id, message);
    }
  });

  function stopListening() {
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
  }

  function diagnose(event) {
    if (typeof onDiagnostic !== 'function') return;
    // Diagnostics are optional observers and must never interrupt delivery.
    try { onDiagnostic({ room, ...event }); } catch (_) {}
  }

  function report(status, reason, diagnosticRoom = room) {
    diagnose({ stage: 'connection', status, reason, room: diagnosticRoom });
    if (onStatus) onStatus(status);
  }

  async function connect(roomId) {
    if (disposed) return;
    const requested = String(roomId || '').trim();
    const nextRoom = /^\d+$/.test(requested) ? requested : '';
    const currentGeneration = ++generation;
    const isCurrent = () => !disposed && generation === currentGeneration && room === nextRoom;
    const previousRoom = room;
    if (room !== nextRoom) lastMessageAt = null;
    room = nextRoom;
    ownerUid = 0;
    roomEmoteAliases = {};
    recentEntries.clear();
    recentSc.clear();
    guardMessages.clear();
    stopListening();
    // Stop immediately, before waiting for metadata. Old-room messages must
    // never appear in the new scene while an API request is pending.
    relay.disconnectRoom();
    if (!room) {
      report('disconnected', 'disconnect', previousRoom);
      return;
    }
    report('init', previousRoom === room ? 'reconnect' : previousRoom ? 'room-switch' : 'connect');
    let ready = false;
    unsubscribe = relay.subscribe((event) => {
      if (!isCurrent() || !ready || !event || String(event.room || '') !== nextRoom) return;
      if (event.t === 'status') {
        if (['init', 'connecting', 'reconnect', 'closed', 'disconnected'].includes(event.v)) {
          recentEntries.clear();
          guardMessages.clear();
        }
        report(event.v);
        return;
      }
      if (event.t !== 'cmd') return;
      const scCommand = typeof onDiagnostic === 'function' && event.v &&
        typeof event.v.cmd === 'string' && event.v.cmd.startsWith('SUPER_CHAT') ? event.v.cmd : '';
      if (scCommand) diagnose({ stage: 'raw', command: scCommand });
      if (event.v && String(event.v.cmd || '').split(':')[0] === 'SUPER_CHAT_MESSAGE_DELETE') {
        const localIds = deleteSc(event.v);
        const parsed = localIds !== null;
        if (scCommand) diagnose({ stage: parsed ? 'parsed' : 'dropped', command: scCommand,
          ...(parsed ? {} : { reason: 'parse-failed' }) });
        if (localIds && localIds.length && typeof onMessageDelete === 'function') onMessageDelete(localIds);
        return;
      }
      const entry = typeof onEntry === 'function' ? normalizeEntryCommand(event.v) : null;
      if (entry) {
        const at = now();
        const previous = recentEntries.get(entry.uid);
        if (previous !== undefined && at >= previous && at - previous < ENTRY_DEDUP_MS) return;
        recentEntries.delete(entry.uid);
        recentEntries.set(entry.uid, at);
        if (recentEntries.size > MAX_RECENT_ENTRIES) recentEntries.delete(recentEntries.keys().next().value);
        const avatarUrl = entry.avatarUrl || (String(event.v.cmd || '').split(':')[0] === 'INTERACT_WORD'
          ? avatars.extractEventAvatar(event.v) : '');
        onEntry({ ...entry, at, ...(avatarUrl ? { avatarUrl } : {}) });
        return;
      }
      // A V2 notification contains a protobuf list, so publish every gift in
      // its original order before the scene is batched for preview and OBS.
      let parsedSc = false;
      for (const command of expandGiftCommands(event.v)) {
        const guard = extractGuard(command);
        const message = normalizeCommand(command, ownerUid, roomEmoteAliases, guard);
        if (!message) continue;
        if (scCommand && message.type === 'sc') {
          parsedSc = true;
          diagnose({ stage: 'parsed', command: scCommand, amount: message.valueYuan });
        }
        if (message.type === 'sc') publishSc(command, message);
        else if (guard) guardMessages.push(guard, message);
        else publishMessage(message);
      }
      if (scCommand && !parsedSc) diagnose({ stage: 'dropped', command: scCommand,
        reason: scCommand.split(':')[0] === 'SUPER_CHAT_MESSAGE' ? 'parse-failed' : 'unsupported-command' });
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

  function disconnect() {
    if (disposed) return;
    const previousRoom = room;
    generation += 1;
    room = '';
    ownerUid = 0;
    roomEmoteAliases = {};
    lastMessageAt = null;
    recentEntries.clear();
    recentSc.clear();
    guardMessages.clear();
    stopListening();
    relay.disconnectRoom();
    report('disconnected', 'disconnect', previousRoom);
  }

  function dispose() {
    if (disposed) return;
    diagnose({ stage: 'connection', status: 'disconnected', reason: 'dispose' });
    disposed = true;
    generation += 1;
    room = '';
    ownerUid = 0;
    roomEmoteAliases = {};
    lastMessageAt = null;
    recentEntries.clear();
    recentSc.clear();
    guardMessages.clear();
    stopListening();
    relay.disconnectRoom();
  }

  return { connect, disconnect, reconnect, dispose };
}

module.exports = { createLiveScene };
