'use strict';

const MAX_RECENT_IDS = 256;

function cleanText(value, limit) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

// This controller owns only one native notification (or tray balloon). It has
// no renderer, avatar downloads, background window, or polling timer.
function createScAlerts({ createNotification, hasPreview, onOpen, showFallback, hideFallback, onError = () => {} }) {
  const seenIds = new Set();
  const pendingIds = new Set();
  let current = null;
  let disposed = false;

  function report(error) {
    try { onError(error); } catch (_) { /* Notifications must not interrupt chat delivery. */ }
  }

  function detachNotification(entry, close) {
    const notification = entry.notification;
    if (!notification) return;
    entry.notification = null;
    for (const [name, listener] of Object.entries(entry.listeners || {})) {
      if (typeof notification.removeListener === 'function') notification.removeListener(name, listener);
    }
    entry.listeners = null;
    if (close && typeof notification.close === 'function') {
      try { notification.close(); } catch (error) { report(error); }
    }
  }

  function dismissCurrent() {
    const entry = current;
    current = null;
    if (!entry) return;
    detachNotification(entry, true);
    if (typeof entry.fallbackCleanup === 'function') {
      try { entry.fallbackCleanup(); } catch (error) { report(error); }
    }
    if (entry.fallback && typeof hideFallback === 'function') {
      try { hideFallback(); } catch (error) { report(error); }
    }
  }

  function openPreview(entry) {
    if (disposed || current !== entry) return;
    dismissCurrent();
    pendingIds.clear();
    try {
      const result = onOpen();
      if (result && typeof result.catch === 'function') result.catch(report);
    } catch (error) { report(error); }
  }

  function fallback(entry) {
    if (disposed || current !== entry || entry.fallback || entry.nativeHidden) return;
    // Native toast failures can arrive after the user has opened/restored the
    // preview. Do not create a late balloon for a card already on screen.
    if (hasPreview()) {
      dismissCurrent();
      pendingIds.clear();
      return;
    }
    detachNotification(entry, true);
    entry.fallback = true;
    if (typeof showFallback !== 'function') {
      current = null;
      return;
    }
    try {
      entry.fallbackCleanup = showFallback(entry.options, () => openPreview(entry));
    } catch (error) {
      report(error);
      current = null;
    }
  }

  function notify(message) {
    if (disposed || !message || message.type !== 'sc') return false;
    const id = typeof message.id === 'number' && Number.isFinite(message.id)
      ? String(message.id) : (typeof message.id === 'string' ? message.id : '');
    if (!id || id.length > 128 || seenIds.has(id)) return false;
    seenIds.add(id);
    if (seenIds.size > MAX_RECENT_IDS) seenIds.delete(seenIds.values().next().value);

    if (hasPreview()) {
      dismissCurrent();
      pendingIds.clear();
      return false;
    }

    pendingIds.add(id);
    const pendingCount = pendingIds.size;
    dismissCurrent();
    const uname = cleanText(message.uname, 48) || '观众';
    const value = Number(message.valueYuan);
    const amount = Number.isFinite(value) && value > 0 ? ' · ¥' + value.toFixed(2).replace(/\.00$/, '') : '';
    const text = cleanText(message.text, 140) || '超级留言';
    const count = pendingCount > 999 ? '999+' : String(pendingCount);
    const entry = {
      id,
      notification: null, listeners: null, nativeHidden: false, fallback: false, fallbackCleanup: null,
      options: {
        title: pendingCount > 1 ? '收到 ' + count + ' 条 SC' : '收到新的 SC',
        body: uname + amount + '\n' + text + '\n点击打开桌面窗口，滑动取消置顶',
        silent: true,
        timeoutType: 'default'
      }
    };
    current = entry;
    try {
      const notification = typeof createNotification === 'function' ? createNotification(entry.options) : null;
      if (!notification || typeof notification.on !== 'function' || typeof notification.show !== 'function') {
        fallback(entry);
        return true;
      }
      entry.notification = notification;
      entry.listeners = {
        click: () => openPreview(entry),
        close: () => {
          if (current !== entry) return;
          // On Windows, timedOut closes only the banner; Action Center may
          // still activate this same notification later. Keep its one strong
          // reference/click handler until explicit replacement or invalidation.
          // A later close() then also removes the retained Action Center item.
          entry.nativeHidden = true;
        },
        failed: () => fallback(entry)
      };
      for (const [name, listener] of Object.entries(entry.listeners)) notification.on(name, listener);
      notification.show();
    } catch (error) {
      report(error);
      fallback(entry);
    }
    return true;
  }

  function clear() {
    dismissCurrent();
    pendingIds.clear();
    seenIds.clear();
  }

  function cancel(ids) {
    if (disposed || !Array.isArray(ids)) return;
    const keys = new Set(ids.map(id => String(id)));
    for (const id of keys) pendingIds.delete(id);
    // Expiring an older SC must not dismiss a newer SC's still-valid toast.
    // Removing the current entry also invalidates any delayed click callback.
    if (current && keys.has(current.id)) dismissCurrent();
  }

  function dispose() {
    disposed = true;
    clear();
  }

  return { notify, cancel, clear, dispose };
}

module.exports = { createScAlerts };
