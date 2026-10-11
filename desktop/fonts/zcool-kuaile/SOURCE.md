# ZCOOL KuaiLe — local outline font for 手绘气泡

This directory contains one complete static outline font. It is not a bitmap
font, a pixel font, a selection of demonstration characters, or a texture effect.
The lettering's uneven comic strokes are part of the original glyph outlines.

## Font and license

- CSS family: `ZCOOL KuaiLe`
- Style / weight: normal / 400 (the family has one static weight)
- Font version: 2.001
- Designers: Liu Bingke, Yang Kang, Wu Shaojie and the ZCOOL KuaiLe contributors
- Copyright: 2018 The ZCOOL KuaiLe Project Authors
- License: **SIL Open Font License 1.1**, included verbatim as `OFL.txt`.
- The copyright notice declares no Reserved Font Names. This distribution only
  changes the font's container format from TTF to WOFF2. All glyphs, naming,
  license metadata and mappings are retained; the result remains under OFL 1.1.

Upstream project: <https://github.com/googlefonts/zcool-kuaile>

Google Fonts source, pinned to the font's repository revision:

- [Original TTF](https://raw.githubusercontent.com/google/fonts/a606d6f3181c62b792c8c1463d309c6a8abb8a12/ofl/zcoolkuaile/ZCOOLKuaiLe-Regular.ttf)
- [License](https://raw.githubusercontent.com/google/fonts/a606d6f3181c62b792c8c1463d309c6a8abb8a12/ofl/zcoolkuaile/OFL.txt)
- [Google Fonts family directory](https://github.com/google/fonts/tree/a606d6f3181c62b792c8c1463d309c6a8abb8a12/ofl/zcoolkuaile)

## Size and character coverage

- Original TTF: **1,514,968 bytes**.
- Bundled WOFF2: **871,928 bytes** (about 851.5 KiB).
- **7,055 glyphs**, **7,053 mapped Unicode code points**.
- **6,766 CJK Unified Ideographs**, including **all 6,763 GB2312 Han characters**.
- The font also includes Latin letters, digits, common punctuation and symbols.
- Uncommon Han characters, many traditional characters, other scripts and emoji
  use the browser's system font fallback. This is the upstream font's full
  repertoire; it is not a claim to cover all Unicode or every Chinese character.
- No embedded bitmap, SVG, color-image or variable-font tables are present.

For the manga skin, use this family with a system fallback such as
`"ZCOOL KuaiLe", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif`.
Keep it local and load it only when the manga skin actually needs this family;
other skins should neither request it nor allocate a font face for it.
Missing characters must retain normal system fallback instead of being drawn
individually into a Canvas.

## Reproduction and integrity

The bundled WOFF2 was generated with Python 3.12, fontTools **4.65.0** and
Brotli **1.2.0**. No font subset or glyph edit was applied:

```python
from fontTools.ttLib import TTFont

font = TTFont("ZCOOLKuaiLe-Regular.ttf", recalcTimestamp=False)
font.flavor = "woff2"
font.save("ZCOOLKuaiLe-Regular.woff2")
```

Verified that the WOFF2 round trip preserves the original character map,
complete glyph order, coordinates of all 7,055 glyph outlines, and the compiled
font naming/license metadata. GB2312 coverage was checked by decoding every
valid Han code point in the GB2312 B0–F7 / A1–FE byte grid and comparing the
full cmap.

SHA-256:

```text
Original TTF
812a6fc1fe54b6d73a419245c32dfeba8aa33104d5be90d1cf6af082007cb71d

Bundled WOFF2
c6fc388b486afb363e00420540b56079561e4b46eba4c0d09a65b999bd0235e0
```

Source inspection and conversion: 2026-09-11.
