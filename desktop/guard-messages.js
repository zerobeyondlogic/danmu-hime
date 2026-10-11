'use strict';

const MATCH_WINDOW_MS = 10000;
const MAX_RECENT_GUARDS = 128;

function samePurchase(a, b) {
  if (a.payflowId && b.payflowId) return a.payflowId === b.payflowId && (!a.uid || !b.uid || a.uid === b.uid);
  if (!a.uid || a.uid !== b.uid || a.num !== b.num) return false;
  if (a.guardLevel && b.guardLevel && a.guardLevel !== b.guardLevel) return false;
  if (a.startTime && b.startTime && a.startTime !== b.startTime) return false;
  if (a.endTime && b.endTime && a.endTime !== b.endTime) return false;
  return true;
}

function mergeMessage(previous, incoming) {
  return {
    ...previous,
    ...incoming,
    uid: incoming.uid || previous.uid,
    uname: incoming.uname && incoming.uname !== '匿名用户' ? incoming.uname : previous.uname,
    avatarUrl: incoming.avatarUrl || previous.avatarUrl,
    role: incoming.role !== 'viewer' ? incoming.role : previous.role,
    medal: incoming.medal || previous.medal,
    text: incoming.text.includes('大航海') && !previous.text.includes('大航海') ? previous.text : incoming.text,
    at: previous.at,
    time: previous.time,
    gapMs: previous.gapMs
  };
}

// Pair the buy/toast protocols one-to-one, rather than dropping all purchases from
// the same viewer for a fixed interval. Only guard packets inspect this cache.
function createGuardMessages({ publish, update, now = Date.now }) {
  let recent = [];
  function compatible(entry, guard) {
    // The buy packet has no transaction ID. Once its paid companion supplied
    // one, it cannot be used as a wildcard for a different paid purchase.
    return !guard.payflowId || [...entry.sources.values()].every((previous) =>
      !previous.payflowId || previous.payflowId === guard.payflowId);
  }
  function push(guard, message) {
    const at = now();
    recent = recent.filter((entry) => at >= entry.at && at - entry.at < MATCH_WINDOW_MS);
    const repeated = recent.find((entry) => {
      const previous = entry.sources.get(guard.source);
      // Only a transaction ID proves a repeated same-protocol notification.
      // Guard event timestamps can coincide for two real purchases.
      return previous && compatible(entry, guard) && samePurchase(previous, guard) &&
        guard.payflowId && guard.payflowId === previous.payflowId;
    });
    const paired = repeated || recent.find((entry) => compatible(entry, guard) && !entry.sources.has(guard.source) &&
      [...entry.sources.values()].some((previous) => samePurchase(previous, guard)));
    if (paired) {
      const merged = mergeMessage(paired.message, message);
      paired.sources.set(guard.source, guard);
      if (JSON.stringify(merged) !== JSON.stringify(paired.message)) {
        paired.message = merged;
        update(paired.receipt, merged);
      }
      return;
    }
    const published = publish(message);
    recent.push({ at, sources: new Map([[guard.source, guard]]), ...published });
    if (recent.length > MAX_RECENT_GUARDS) recent.shift();
  }
  return { push, clear: () => { recent = []; } };
}

module.exports = { createGuardMessages };
