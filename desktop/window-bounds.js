'use strict';

function validRectangle(rect) {
  return !!rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) &&
    rect.width > 0 && rect.height > 0;
}

function intersection(a, b) {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return width * height;
}

// Work areas and BrowserWindow bounds are already DIP coordinates. Do not
// multiply by a display's scaleFactor, including on mixed-DPI desktops.
function fullyVisible(bounds, areas) {
  const right = bounds.x + bounds.width;
  const bottom = bounds.y + bounds.height;
  const edges = [...new Set([bounds.x, right, ...areas.flatMap((area) => [
    Math.max(bounds.x, Math.min(right, area.x)),
    Math.max(bounds.x, Math.min(right, area.x + area.width))
  ])])].sort((a, b) => a - b);
  // Check the union rather than one display: a window across an adjacent
  // monitor seam is valid if every part of it remains in visible work areas.
  for (let i = 1; i < edges.length; i += 1) {
    const intervals = areas.filter((area) => area.x <= edges[i - 1] && area.x + area.width >= edges[i])
      .map((area) => [area.y, area.y + area.height]).sort((a, b) => a[0] - b[0]);
    let coveredTo = bounds.y;
    for (const [top, end] of intervals) {
      if (top > coveredTo) break;
      coveredTo = Math.max(coveredTo, end);
      if (coveredTo >= bottom) break;
    }
    if (coveredTo < bottom) return false;
  }
  return true;
}

function recoverWindowBounds(bounds, workAreas) {
  const result = { ...bounds };
  const areas = Array.isArray(workAreas) ? workAreas.filter(validRectangle) : [];
  // Undefined initial coordinates let Electron center a first-use window.
  if (!validRectangle(bounds) || !areas.length || fullyVisible(bounds, areas)) return result;
  let best = null;
  for (const area of areas) {
    // Keep the configured canvas size, even if no monitor can contain it.
    // In that case expose its top/left corner so it remains reachable.
    const x = bounds.width >= area.width ? area.x
      : Math.max(area.x, Math.min(bounds.x, area.x + area.width - bounds.width));
    const y = bounds.height >= area.height ? area.y
      : Math.max(area.y, Math.min(bounds.y, area.y + area.height - bounds.height));
    const overlap = intersection(bounds, area);
    const distance = (x - bounds.x) ** 2 + (y - bounds.y) ** 2;
    if (!best || overlap > best.overlap || (overlap === best.overlap && distance < best.distance)) {
      best = { x, y, overlap, distance };
    }
  }
  result.x = Math.round(best.x);
  result.y = Math.round(best.y);
  return result;
}

module.exports = { recoverWindowBounds };
