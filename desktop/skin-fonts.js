(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DanmuSkinFonts = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const family = 'ZCOOL KuaiLe';
  const source = 'url("/desktop/fonts/zcool-kuaile/ZCOOLKuaiLe-Regular.woff2") format("woff2")';

  function create({ fonts, FontFace }) {
    let face = null;

    function clear() {
      if (face) fonts.delete(face);
      face = null;
    }

    function sync(theme, fontFamily) {
      if (theme !== 'manga' || fontFamily !== family) {
        clear();
        return;
      }
      if (face || typeof FontFace !== 'function') return;
      // Adding a face is lazy: Chromium requests this local outline font only
      // when the selected skin actually uses it. Other skins register nothing.
      face = new FontFace(family, source, { weight: '400', style: 'normal', display: 'swap' });
      fonts.add(face);
      // Missing/corrupt font assets must leave the system-font fallback usable.
      face.loaded.catch(() => {});
    }

    return { sync, clear };
  }

  return { family, create };
});
