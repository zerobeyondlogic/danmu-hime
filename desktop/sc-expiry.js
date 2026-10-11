'use strict';

const MAX_TIMEOUT_MS = 2147483647;
const MAX_DEADLINE = Number.MAX_SAFE_INTEGER;
const TIERS = [[2, 5000], [30, 60000], [50, 120000], [100, 300000],
  [500, 1800000], [1000, 3600000], [2000, 7200000]];

function durationMsForAmount(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') ||
      (typeof value === 'string' && !value.trim())) return 60000;
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 60000;
  if (amount <= TIERS[0][0]) return TIERS[0][1];
  for (let index = 1; index < TIERS.length; index++) {
    const [upper, upperMs] = TIERS[index];
    if (amount <= upper) {
      const [lower, lowerMs] = TIERS[index - 1];
      return Math.ceil(lowerMs + (amount - lower) * (upperMs - lowerMs) / (upper - lower));
    }
  }
  const [lastAmount, lastMs] = TIERS[TIERS.length - 1];
  const [previousAmount, previousMs] = TIERS[TIERS.length - 2];
  const milliseconds = lastMs + (amount - lastAmount) * (lastMs - previousMs) / (lastAmount - previousAmount);
  // Saturation avoids Infinity and unsafe timestamp addition for malformed or
  // extraordinarily large values. Long real durations use chunked timeouts.
  return Math.ceil(Math.min(MAX_DEADLINE, milliseconds));
}

function createScExpiry({
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  onExpire = () => {}, neverExpire = false
} = {}) {
  const entries = new Map();
  let disabled = neverExpire === true;
  let disposed = false;
  let timer = null;
  let timerDeadline = null;
  let timerToken = 0;

  function currentTime() {
    const value = Number(now());
    return Number.isFinite(value) ? Math.max(0, Math.min(MAX_DEADLINE, value)) : 0;
  }

  function keyFor(id) {
    if (typeof id === 'string') return id;
    return typeof id === 'number' && Number.isFinite(id) ? String(id) : '';
  }

  function cancelTimer() {
    timerToken++;
    if (timer !== null) clearTimer(timer);
    timer = null;
    timerDeadline = null;
  }

  function nextDeadline() {
    let next = null;
    for (const entry of entries.values()) {
      if (next === null || entry.deadline < next) next = entry.deadline;
    }
    return next;
  }

  function schedule() {
    if (disposed || disabled || !entries.size) {
      cancelTimer();
      return;
    }
    const deadline = nextDeadline();
    if (timer !== null && timerDeadline === deadline) return;
    cancelTimer();
    const token = ++timerToken;
    timerDeadline = deadline;
    timer = setTimer(() => {
      if (disposed || disabled || token !== timerToken) return;
      timer = null;
      timerDeadline = null;
      expireDue();
    }, Math.min(MAX_TIMEOUT_MS, Math.max(0, deadline - currentTime())));
  }

  function expireDue() {
    if (disposed || disabled) return;
    const at = currentTime();
    const expired = [];
    for (const [id, entry] of entries) {
      if (entry.deadline <= at) { entries.delete(id); expired.push(id); }
    }
    // One callback can remove every SC due at the same instant, keeping scene
    // publication to one snapshot and leaving ordinary playback undisturbed.
    if (expired.length) onExpire(expired);
    schedule();
  }

  function track(id, amount) {
    id = keyFor(id);
    if (disposed || !id || entries.has(id)) return false;
    const receivedAt = currentTime();
    const durationMs = durationMsForAmount(amount);
    entries.set(id, { receivedAt, durationMs, deadline: Math.min(MAX_DEADLINE, receivedAt + durationMs) });
    schedule();
    return true;
  }

  function update(id, amount) {
    id = keyFor(id);
    if (disposed || !entries.has(id)) return false;
    const entry = entries.get(id);
    const durationMs = durationMsForAmount(amount);
    if (entry.durationMs === durationMs) return true;
    entry.durationMs = durationMs;
    entry.deadline = Math.min(MAX_DEADLINE, entry.receivedAt + durationMs);
    if (!disabled) expireDue();
    return true;
  }

  function remove(id) {
    if (disposed) return false;
    const removed = entries.delete(keyFor(id));
    if (removed) schedule();
    return removed;
  }

  function setNeverExpire(value) {
    if (disposed || disabled === (value === true)) return;
    disabled = value === true;
    cancelTimer();
    if (!disabled) expireDue();
  }

  function clear() {
    if (disposed) return;
    cancelTimer();
    entries.clear();
  }

  function dispose() {
    if (disposed) return;
    clear();
    disposed = true;
  }

  return { track, update, remove, setNeverExpire, clear, dispose,
    getState: () => ({ size: entries.size, neverExpire: disabled,
      nextDeadline: disabled ? null : nextDeadline() }) };
}

module.exports = { durationMsForAmount, createScExpiry };
