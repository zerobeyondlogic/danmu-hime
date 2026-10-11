'use strict';

const DEFAULT_PLAYED = 48;
const DEFAULT_PENDING = 4096;
const DEFAULT_PENDING_BYTES = 8 * 1024 * 1024;
const STATE_INTERVAL = 250;

function positiveLimit(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

// A conservative serialized-data estimate, not a claim about total V8 heap
// usage. The independent item limit also bounds maps and per-message overhead.
function estimateMessageBytes(message) {
  return 256 + JSON.stringify(message).length * 2;
}

function createMessagePlayback({
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  onChange = () => {}, onStateChange = () => {},
  maxPlayed = DEFAULT_PLAYED, maxPending = DEFAULT_PENDING,
  maxPendingBytes = DEFAULT_PENDING_BYTES
} = {}) {
  maxPlayed = positiveLimit(maxPlayed, DEFAULT_PLAYED);
  maxPending = positiveLimit(maxPending, DEFAULT_PENDING);
  maxPendingBytes = positiveLimit(maxPendingBytes, DEFAULT_PENDING_BYTES);
  const played = new Map();
  const playedIds = [];
  const regularIds = [];
  const pending = new Map();
  const arrivalOrder = new Map();
  let nextArrivalOrder = 0;
  let pendingBytes = 0;
  let skipped = 0;
  let active = false;
  let disposed = false;
  let intervalMs = 0;
  let lastRevealAt = -Infinity;
  let playTimer = null, playDue = Infinity, playToken = 0;
  let stateTimer = null, stateToken = 0, lastStateAt = -Infinity;
  let lastState = { pending: 0, pendingBytes: 0, skipped: 0, active: false, intervalMs: 0 };

  function getStats() {
    return { pending: pending.size, pendingBytes, skipped, active,
      intervalMs: pending.size ? intervalMs : 0 };
  }

  function cancelStateTimer() {
    stateToken++;
    if (stateTimer !== null) clearTimer(stateTimer);
    stateTimer = null;
  }

  function sendState() {
    cancelStateTimer();
    const state = getStats();
    if (Object.keys(state).every(key => state[key] === lastState[key])) return;
    lastState = state;
    lastStateAt = now();
    onStateChange({ ...state });
  }

  function changedState(force = false) {
    if (disposed) return;
    const state = getStats();
    if (Object.keys(state).every(key => state[key] === lastState[key])) {
      if (!state.pending) cancelStateTimer();
      return;
    }
    if (force || state.pending === 0 || (state.skipped > 0 && lastState.skipped === 0) || now() - lastStateAt >= STATE_INTERVAL) {
      sendState();
      return;
    }
    if (stateTimer !== null) return;
    const token = ++stateToken;
    stateTimer = setTimer(() => {
      if (disposed || token !== stateToken) return;
      stateTimer = null;
      sendState();
    }, Math.max(0, STATE_INTERVAL - (now() - lastStateAt)));
  }

  function cancelPlayTimer() {
    playToken++;
    if (playTimer !== null) clearTimer(playTimer);
    playTimer = null;
    playDue = Infinity;
  }

  function insertInArrivalOrder(ids, id) {
    const order = arrivalOrder.get(id);
    let low = 0, high = ids.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (arrivalOrder.get(ids[middle]) < order) low = middle + 1;
      else high = middle;
    }
    ids.splice(low, 0, id);
  }

  function removePlayed(id) {
    played.delete(id);
    arrivalOrder.delete(id);
    const index = playedIds.indexOf(id);
    if (index !== -1) playedIds.splice(index, 1);
  }

  function pruneRegularHistory() {
    while (regularIds.length > maxPlayed) removePlayed(regularIds.shift());
  }

  function play(message) {
    played.set(message.id, message);
    insertInArrivalOrder(playedIds, message.id);
    if (message.type !== 'sc' || message.scPinned === false) {
      insertInArrivalOrder(regularIds, message.id);
      pruneRegularHistory();
    }
  }

  function removePending(id, keepOrder = false) {
    const entry = pending.get(id);
    if (!entry) return null;
    pending.delete(id);
    if (!keepOrder) arrivalOrder.delete(id);
    pendingBytes = Math.max(0, pendingBytes - entry.bytes);
    return entry.message;
  }

  function enforceLimit() {
    while (pending.size > maxPending || pendingBytes > maxPendingBytes) {
      let victim = null;
      // Prefer retaining paid gifts/guards over old chat and welcome notices.
      // An all-paid overload is still bounded and is reported via skipped.
      for (const [id, entry] of pending) {
        if (entry.message.type === 'chat' || entry.message.type === 'welcome') { victim = id; break; }
      }
      if (victim === null) victim = pending.keys().next().value;
      if (victim === undefined) break;
      removePending(victim);
      skipped++;
    }
  }

  function speedUp() {
    const next = pending.size >= 24 ? 16 : pending.size >= 8 ? 24 : 45;
    intervalMs = intervalMs ? Math.min(intervalMs, next) : next;
  }

  function scheduleNext() {
    if (disposed || !active || !pending.size) return;
    speedUp();
    const due = Math.max(now(), lastRevealAt + intervalMs);
    if (playTimer !== null && playDue <= due) return;
    cancelPlayTimer();
    const token = ++playToken;
    playDue = due;
    playTimer = setTimer(() => {
      if (disposed || !active || token !== playToken) return;
      playTimer = null;
      playDue = Infinity;
      revealOne();
    }, Math.max(0, due - now()));
  }

  function revealOne() {
    if (disposed || !active || !pending.size) return;
    const message = removePending(pending.keys().next().value, true);
    lastRevealAt = now();
    play(message);
    if (!pending.size) intervalMs = 0;
    // Exactly one newly presented regular message per callback. A late timer
    // never drains several items to "catch up" inside the same paint frame.
    onChange();
    changedState();
    scheduleNext();
  }

  function enqueue(message) {
    if (disposed || !message || typeof message.id !== 'string' || !message.id ||
        pending.has(message.id) || played.has(message.id)) return false;
    if (message.type === 'sc') message = { ...message, scPinned: message.scPinned !== false };
    arrivalOrder.set(message.id, ++nextArrivalOrder);
    if (message.type === 'sc' || !active) {
      play(message);
      onChange();
      return true;
    }
    pending.set(message.id, { message, bytes: estimateMessageBytes(message) });
    pendingBytes += pending.get(message.id).bytes;
    enforceLimit();
    if (!pending.size) {
      cancelPlayTimer();
      intervalMs = 0;
      changedState();
      return true;
    }
    speedUp();
    if (playTimer === null && now() - lastRevealAt >= intervalMs) revealOne();
    else {
      scheduleNext();
      changedState();
    }
    return true;
  }

  function update(id, updater) {
    if (disposed || typeof updater !== 'function') return false;
    id = String(id || '');
    const entry = pending.get(id);
    const previous = entry ? entry.message : played.get(id);
    if (!previous) return false;
    const value = updater(previous);
    if (!value || typeof value !== 'object') return false;
    const next = { ...value, id: previous.id, type: previous.type };
    // Source corrections cannot pin an expired SC again or silently change a
    // pinned card's lifetime policy. Only unpinMany changes that state.
    if (previous.type === 'sc') next.scPinned = previous.scPinned !== false;
    if (entry) {
      const bytes = estimateMessageBytes(next);
      pendingBytes += bytes - entry.bytes;
      pending.set(id, { message: next, bytes });
      enforceLimit();
      if (!pending.size) { cancelPlayTimer(); intervalMs = 0; }
      changedState();
    } else {
      played.set(id, next);
      onChange();
    }
    return true;
  }

  function dismiss(id) {
    return dismissMany([id]) > 0;
  }

  function unpinMany(ids) {
    if (disposed || !Array.isArray(ids)) return 0;
    let changed = 0;
    for (const value of ids) {
      const id = String(value || '');
      const message = played.get(id);
      if (!message || message.type !== 'sc' || message.scPinned === false) continue;
      played.set(id, { ...message, scPinned: false });
      // This card was already displayed. Return it to its original receipt
      // position without consuming, appending to or delaying pending traffic.
      insertInArrivalOrder(regularIds, id);
      changed++;
    }
    if (changed) {
      pruneRegularHistory();
      onChange();
    }
    return changed;
  }

  function dismissMany(ids) {
    if (disposed || !Array.isArray(ids)) return 0;
    let removed = 0;
    for (const value of ids) {
      const id = String(value || '');
      const message = played.get(id);
      if (!message || message.type !== 'sc') continue;
      const regularIndex = regularIds.indexOf(id);
      if (regularIndex !== -1) regularIds.splice(regularIndex, 1);
      removePlayed(id);
      removed++;
    }
    if (removed) onChange();
    return removed;
  }

  function setActive(value) {
    if (disposed || active === !!value) return;
    active = !!value;
    if (!active) {
      cancelPlayTimer();
      const hadPending = pending.size > 0;
      // No output is watching. Fold queued arrivals into the bounded current
      // history immediately, rather than replaying stale messages next launch.
      for (const entry of pending.values()) play(entry.message);
      pending.clear();
      pendingBytes = 0;
      intervalMs = 0;
      lastRevealAt = -Infinity;
      if (hadPending) onChange();
    }
    changedState(true);
  }

  function cancelPending() {
    if (disposed) return 0;
    const removed = pending.size;
    cancelPlayTimer();
    cancelStateTimer();
    for (const id of pending.keys()) arrivalOrder.delete(id);
    pending.clear();
    pendingBytes = 0;
    intervalMs = 0;
    lastRevealAt = -Infinity;
    // Disconnect is not a clear: already displayed cards and pinned SC stay.
    changedState(true);
    return removed;
  }

  function clear() {
    if (disposed) return;
    cancelPlayTimer();
    cancelStateTimer();
    pending.clear();
    played.clear();
    playedIds.length = 0;
    regularIds.length = 0;
    arrivalOrder.clear();
    nextArrivalOrder = 0;
    pendingBytes = 0;
    skipped = 0;
    intervalMs = 0;
    lastRevealAt = -Infinity;
    onChange();
    changedState(true);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelPlayTimer();
    cancelStateTimer();
    pending.clear();
    played.clear();
    playedIds.length = 0;
    regularIds.length = 0;
    arrivalOrder.clear();
    nextArrivalOrder = 0;
    pendingBytes = 0;
    skipped = 0;
    intervalMs = 0;
    active = false;
  }

  return { enqueue, update, dismiss, dismissMany, unpinMany, cancelPending, clear, dispose, setActive, getStats,
    getMessages: () => playedIds.map(id => played.get(id)),
    hasMessages: () => played.size > 0 || pending.size > 0 };
}

module.exports = { createMessagePlayback, estimateMessageBytes };
