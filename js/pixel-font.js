(function (root) {
  'use strict';

  let fontPromise = null;

  function load(url) {
    if (fontPromise) return fontPromise;
    fontPromise = fetch(url).then(async (response) => {
      if (!response.ok) throw new Error('pixel font HTTP ' + response.status);
      const view = new DataView(await response.arrayBuffer());
      if (view.byteLength < 8) {
        throw new Error('invalid pixel font');
      }
      const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
      const units = magic === 'FPB2' ? view.getUint8(4) : 12;
      const headerSize = magic === 'FPB2' ? 12 : 8;
      const recordSize = 5 + units * 2;
      if ((magic !== 'FPB1' && magic !== 'FPB2') || units < 8 || units > 16) throw new Error('invalid pixel font');
      const count = view.getUint32(magic === 'FPB2' ? 8 : 4, true);
      if (view.byteLength !== headerSize + count * recordSize) throw new Error('invalid pixel font size');
      const offsets = new Map();
      for (let index = 0; index < count; index += 1) {
        const offset = headerSize + index * recordSize;
        offsets.set(view.getUint32(offset, true), offset);
      }
      return { view, offsets, units };
    });
    return fontPromise;
  }

  function glyph(font, codePoint) {
    let offset = font.offsets.get(codePoint);
    if (offset === undefined) offset = font.offsets.get(0xfffd);
    if (offset === undefined) return null;
    const rows = new Uint16Array(font.units);
    for (let row = 0; row < font.units; row += 1) rows[row] = font.view.getUint16(offset + 5 + row * 2, true);
    return { advance: font.view.getUint8(offset + 4), rows };
  }

  function layout(font, text, maxUnits) {
    const lines = [];
    let current = [];
    let width = 0;
    for (const character of Array.from(String(text || ''))) {
      if (character === '\n') {
        lines.push({ glyphs: current, width });
        current = [];
        width = 0;
        continue;
      }
      const item = glyph(font, character.codePointAt(0));
      if (!item) continue;
      if (current.length && width + item.advance > maxUnits) {
        lines.push({ glyphs: current, width });
        current = [];
        width = 0;
      }
      current.push(item);
      width += item.advance;
    }
    if (current.length || !lines.length) lines.push({ glyphs: current, width });
    return lines;
  }

  function render(element, font, color) {
    if (!element || !element.isConnected || !font) return;
    const text = element.dataset.pixelText || element.textContent || '';
    let canvas = element.querySelector(':scope > .pixel-canvas');
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.className = 'pixel-canvas';
      canvas.setAttribute('aria-hidden', 'true');
      element.appendChild(canvas);
    }

    let layoutWidth = element.offsetWidth;
    const layoutHeight = element.offsetHeight;
    if (layoutWidth < 2 || layoutHeight < 2) return;
    const style = getComputedStyle(element);
    const fontSize = parseFloat(style.fontSize) || 12;
    const lineHeight = parseFloat(style.lineHeight) || fontSize * 1.25;
    // Keep the bitmap grid on the monitor's real pixel grid.  The old code
    // forced a 2x backing store on a 150% display, so Chromium had to resample
    // the canvas and occasionally merged neighbouring dots.  A quantized pitch
    // plus exactly one physical pixel of darkness keeps every lamp separate.
    const fixedRatio = Number(document.body && document.body.dataset.outputPixelRatio);
    const ratio = Number.isFinite(fixedRatio) && fixedRatio > 0
      ? fixedRatio
      : Math.max(1, window.devicePixelRatio || 1);
    // Keep pitch continuous instead of flooring it into DPI-dependent bands.
    // The old 27px Latin name and 22px CJK badge could both become a 2px cell
    // at 150%, while small text collapsed to a dense 1px bitmap at 100%.
    const latinName = element.classList.contains('user-name') && /[A-Za-z]/.test(text);
    const opticalScale = latinName ? 1.15 : 1;
    const pitch = Math.max(1.375, (fontSize / font.units) * ratio * opticalScale);
    const pitchCss = pitch / ratio;
    const maxUnits = element.classList.contains('message-body')
      ? Math.max(1, Math.floor(layoutWidth / pitchCss))
      : Number.MAX_SAFE_INTEGER;
    const lines = layout(font, text, maxUnits);
    const requiredWidthCss = Math.max(1, ...lines.map((line) => line.width * pitchCss));
    if (element.classList.contains('user-name') && requiredWidthCss > layoutWidth) {
      element.style.minWidth = Math.ceil(requiredWidthCss) + 'px';
      element.style.flex = '0 0 auto';
      layoutWidth = Math.max(element.offsetWidth, Math.ceil(requiredWidthCss));
    }
    canvas.width = Math.max(1, Math.ceil(layoutWidth * ratio));
    canvas.height = Math.max(1, Math.ceil(layoutHeight * ratio));
    canvas.style.width = layoutWidth + 'px';
    canvas.style.height = layoutHeight + 'px';
    const context = canvas.getContext('2d');
    context.imageSmoothingEnabled = false;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = color;

    const dot = Math.max(1, Math.round(pitch * 0.58));
    const dotInset = (pitch - dot) / 2;
    const align = style.textAlign === 'center' ? 'center' : (style.textAlign === 'right' ? 'right' : 'left');
    lines.forEach((line, lineIndex) => {
      const lineWidth = line.width * pitch;
      let cursor = Math.round(align === 'center' ? (canvas.width - lineWidth) / 2 : (align === 'right' ? canvas.width - lineWidth : 0));
      const lineY = Math.round(lineIndex * lineHeight * ratio);
      line.glyphs.forEach((item) => {
          for (let row = 0; row < font.units; row += 1) {
            const bits = item.rows[row];
          for (let column = 0; column < font.units; column += 1) {
            if ((bits & (1 << (font.units - 1 - column))) === 0) continue;
            const x = Math.round(cursor + column * pitch + dotInset);
            const y = Math.round(lineY + row * pitch + dotInset);
            context.fillRect(x, y, dot, dot);
          }
        }
        cursor += item.advance * pitch;
      });
    });
  }

  root.BitmapPixelFont = { load, render };
})(typeof window !== 'undefined' ? window : globalThis);
