// Rectangles use viewport coordinates, so this works after scrolling or re-packing.
// Only candidates across the requested edge qualify: never wrap or jump diagonally.
export function spatialNeighbor(rects, index, direction, anchor = rects[index], alignedOnly = false) {
  const from = rects[index];
  if (!from || !anchor) return -1;
  const horizontal = direction === 'ArrowLeft' || direction === 'ArrowRight';
  if (!horizontal && direction !== 'ArrowUp' && direction !== 'ArrowDown') return -1;
  const forward = direction === 'ArrowRight' || direction === 'ArrowDown';
  const start = horizontal ? 'left' : 'top';
  const end = horizontal ? 'right' : 'bottom';
  const crossStart = horizontal ? 'top' : 'left';
  const crossEnd = horizontal ? 'bottom' : 'right';
  const point = (anchor[crossStart] + anchor[crossEnd]) / 2;
  const candidates = rects.flatMap((rect, i) => {
    if (i === index) return [];
    const gap = forward ? rect[start] - from[end] : from[start] - rect[end];
    if (gap < -1) return [];
    const overlap = Math.min(from[crossEnd], rect[crossEnd]) - Math.max(from[crossStart], rect[crossStart]);
    // Vertical travel must stay in the same column (or directly aligned controls).
    if ((!horizontal || alignedOnly) && overlap <= 1) return [];
    const crossGap = Math.max(rect[crossStart] - point, point - rect[crossEnd], 0);
    const centerGap = Math.abs((rect[crossStart] + rect[crossEnd]) / 2 - point);
    return [{ index: i, gap: Math.max(0, gap), crossGap, centerGap }];
  });
  candidates.sort((a, b) => a.gap - b.gap || a.crossGap - b.crossGap || a.centerGap - b.centerGap || a.index - b.index);
  return candidates[0]?.index ?? -1;
}

// Text fields, selects and radio groups keep their native arrow behavior.
export function barCommand(event, { inMain = false, nativeArrows = false, checkable = false } = {}) {
  if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  if (event.key === 'Escape') return 'back';
  if (event.key === 'Enter' && checkable && !event.repeat) return 'toggle';
  if (nativeArrows) return null;
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return event.key;
  if (inMain && ['Home', 'End'].includes(event.key)) return event.key;
  return null;
}
