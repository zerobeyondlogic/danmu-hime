'use strict';

const MAX_EVENTS = 32;
const STAGES = ['raw', 'parsed', 'dropped', 'published', 'expired', 'unpinned', 'removed', 'clear', 'connection'];
const REASONS = new Set(['unsupported-command', 'parse-failed', 'publish-rejected',
  'connect', 'reconnect', 'room-switch', 'disconnect', 'dispose', 'manual-clear', 'manual-reconnect', 'upstream-delete']);
const STATUSES = new Set(['init', 'connecting', 'auth', 'open', 'reconnect', 'closed',
  'disconnected', 'api-fail', 'auth-fail', 'error']);

function incrementCount(value) {
  return Math.min(Number.MAX_SAFE_INTEGER, value + 1);
}

// Memory-only metadata. No raw packet, user identity, text, file, timer or UI.
// Fixed counters and a ring buffer keep diagnostics bounded even during floods.
function createScDiagnostics({ now = Date.now } = {}) {
  const counts = Object.fromEntries(STAGES.map(stage => [stage, 0]));
  const events = new Array(MAX_EVENTS);
  let cursor = 0;
  let size = 0;
  let total = 0;

  function record(value) {
    if (!value || !Object.hasOwn(counts, value.stage)) return false;
    const currentTime = Number(now());
    const event = { at: Number.isFinite(currentTime)
      ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(currentTime))) : 0,
    stage: value.stage };
    if (typeof value.command === 'string' && value.command.length <= 96 && /^SUPER_CHAT[A-Z0-9_]*(?::[0-9]+)*$/.test(value.command)) {
      event.command = value.command;
    }
    if (REASONS.has(value.reason)) event.reason = value.reason;
    if (STATUSES.has(value.status)) event.status = value.status;
    for (const key of ['room', 'messageId']) {
      const text = typeof value[key] === 'number' && Number.isSafeInteger(value[key])
        ? String(value[key]) : value[key];
      if (typeof text === 'string' && /^\d{1,20}$/.test(text)) event[key] = text;
    }
    if (typeof value.amount === 'number' && Number.isFinite(value.amount) &&
        value.amount >= 0 && value.amount <= Number.MAX_SAFE_INTEGER) event.amount = value.amount;
    events[cursor] = event;
    cursor = (cursor + 1) % MAX_EVENTS;
    size = Math.min(MAX_EVENTS, size + 1);
    counts[event.stage] = incrementCount(counts[event.stage]);
    total = incrementCount(total);
    return true;
  }

  function getSnapshot() {
    const ordered = [];
    for (let index = 0; index < size; index++) {
      ordered.push({ ...events[(cursor - size + index + MAX_EVENTS) % MAX_EVENTS] });
    }
    return { total, counts: { ...counts }, events: ordered };
  }

  return { record, getSnapshot };
}

module.exports = { createScDiagnostics, incrementCount };
