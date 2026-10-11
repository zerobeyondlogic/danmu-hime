(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ControlAppearanceSettings = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const defaults = Object.freeze({ theme: 'dark', opacity: 97 });

  function normalize(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const candidate = typeof source.opacity === 'number' ? source.opacity
      : typeof source.opacity === 'string' && source.opacity.trim() ? Number(source.opacity) : NaN;
    return {
      theme: source.theme === 'light' ? 'light' : defaults.theme,
      opacity: Number.isFinite(candidate) ? Math.max(30, Math.min(100, Math.round(candidate))) : defaults.opacity
    };
  }

  return Object.freeze({ defaults, normalize });
});
