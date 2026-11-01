// Rearranges the cards into columns: balanced so the page is as short as possible, or,
// once the reader has placed cards themselves (page.js marks the grid `data-arrange=manual`
// and each card `data-col`), in the columns they chose. Then, unless the reader turned it
// off (the `no-fill` class on the page), each card shows more or fewer stories, from the
// spares it was drawn with, so every column reaches the bottom of the window. Without
// JavaScript the CSS multi-column layout still works; this only improves on it.

const MIN_COLUMN_WIDTH = 300; // keep in step with `columns: 300px` in style.css
const EXACT_LIMIT = 16; // above this many cards, use the greedy result alone
const MIN_ITEMS = 2; // filling never cuts a card below this many stories (or its own number, if fewer)

// How many stories each card in a column shows so the column fills `space`. Each card is
// { start, sizes }, where sizes[k] is its height showing k stories and `start` is its own
// number. A column too tall loses stories from whichever card has most; then, while any
// story still fits, the card with fewest gains one, so the column fills evenly.
export function fillColumn(cards, space) {
  const counts = cards.map((card) => card.start);
  let height = cards.reduce((sum, card, i) => sum + card.sizes[counts[i]], 0);
  const pick = (allowed, better) => counts.reduce((best, k, i) => (allowed(k, i) && (best < 0 || better(k, counts[best])) ? i : best), -1);
  while (height > space) {
    const i = pick((k, i) => k > Math.min(MIN_ITEMS, cards[i].start), (k, best) => k >= best);
    if (i < 0) break;
    height -= cards[i].sizes[counts[i]] - cards[i].sizes[counts[i] - 1];
    counts[i]--;
  }
  const growth = (i) => cards[i].sizes[counts[i] + 1] - cards[i].sizes[counts[i]];
  for (;;) {
    const i = pick((k, i) => k + 1 < cards[i].sizes.length && height + growth(i) <= space, (k, best) => k < best);
    if (i < 0) break;
    height += growth(i);
    counts[i]++;
  }
  return counts;
}

// Splits cards (given by height) into `columnCount` columns so the tallest column is as
// short as possible. Returns arrays of card indices, each column in its original order,
// columns ordered by their first card so the top-left card stays where the config put it.
export function packColumns(heights, columnCount) {
  const n = heights.length;
  const cols = Math.max(1, Math.min(columnCount, n));
  if (cols === 1) return [heights.map((_, i) => i)];

  // Place the tallest cards first: it finds good answers early, so pruning bites sooner.
  const order = heights.map((_, i) => i).sort((a, b) => heights[b] - heights[a]);
  const loads = new Array(cols).fill(0);
  const assign = new Array(n);

  // Greedy start (each card into the currently shortest column) gives the first bound.
  for (const i of order) {
    const c = loads.indexOf(Math.min(...loads));
    assign[i] = c;
    loads[c] += heights[i];
  }
  let best = assign.slice();
  let bestMax = Math.max(...loads);

  if (n <= EXACT_LIMIT) {
    // No answer can beat the tallest card or a perfectly even split.
    const lowerBound = Math.max(Math.max(...heights), heights.reduce((a, b) => a + b, 0) / cols);
    loads.fill(0);
    const search = (k) => {
      if (bestMax <= lowerBound) return;
      if (k === n) {
        const max = Math.max(...loads);
        if (max < bestMax) { bestMax = max; best = assign.slice(); }
        return;
      }
      const i = order[k];
      const tried = new Set(); // columns with the same load are interchangeable
      for (let c = 0; c < cols; c++) {
        if (tried.has(loads[c]) || loads[c] + heights[i] >= bestMax) continue;
        tried.add(loads[c]);
        loads[c] += heights[i];
        assign[i] = c;
        search(k + 1);
        loads[c] -= heights[i];
      }
    };
    search(0);
  }

  const columns = Array.from({ length: cols }, () => []);
  heights.forEach((_, i) => columns[best[i]].push(i));
  return columns.filter((column) => column.length).sort((a, b) => a[0] - b[0]);
}

// Cards in the columns the reader chose (`cols`, null for a card not placed yet), each
// column in page order. A column beyond what fits moves into the last one; a card not
// placed yet goes into whichever column is shortest. Empty columns are kept, as somewhere
// to drop a card.
export function placeColumns(cols, heights, columnCount) {
  const count = Math.max(1, columnCount);
  const columns = Array.from({ length: count }, () => []);
  const loads = new Array(count).fill(0);
  const put = (i, c) => { columns[c].push(i); loads[c] += heights[i]; };
  cols.forEach((col, i) => { if (col !== null) put(i, Math.min(col, count - 1)); });
  cols.forEach((col, i) => { if (col === null) put(i, loads.indexOf(Math.min(...loads))); });
  return columns.map((column) => column.sort((a, b) => a - b));
}

function columnCountFor(grid) {
  const style = getComputedStyle(grid);
  const width = grid.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const gap = parseFloat(style.columnGap) || 0;
  // Same rule the browser uses for `columns: 300px`.
  return Math.max(1, Math.floor((width + gap) / (MIN_COLUMN_WIDTH + gap)));
}

// A card's height (with its margin) showing each number of its stories, measured with all
// of them showing. Hiding stories from the end takes away exactly the space down to the
// last one left; `start` is how many it shows unfilled (the ones that aren't spares).
function measureCard(card) {
  const items = [...card.querySelectorAll('.item')];
  const full = card.getBoundingClientRect().height + parseFloat(getComputedStyle(card).marginBottom);
  if (!items.length) return { items, start: 0, sizes: [full] };
  const bottoms = items.map((item) => item.getBoundingClientRect().bottom);
  const last = bottoms.at(-1);
  const sizes = [full - (last - items[0].getBoundingClientRect().top), ...bottoms.map((bottom) => full - (last - bottom))];
  return { items, start: items.filter((item) => !item.classList.contains('extra')).length, sizes };
}

function showStories(items, count) {
  items.forEach((item, i) => {
    item.classList.toggle('show', i < count);
    item.classList.toggle('cut', i >= count);
  });
}

const resetStories = (grid) => grid.querySelectorAll('.item').forEach((item) => item.classList.remove('show', 'cut'));

function initGrid(grid) {
  let cards = [...grid.children];
  let laidOutWidth = 0;
  let laidOutHeight = 0;
  const filling = () => !document.documentElement.classList.contains('no-fill');

  const layout = () => {
    // The window's height only matters when filling it.
    if (grid.clientWidth === laidOutWidth && (!filling() || window.innerHeight === laidOutHeight)) return;
    laidOutWidth = grid.clientWidth;
    laidOutHeight = window.innerHeight;
    // Measure in the CSS column layout, where each card already has the column width.
    grid.classList.remove('packed');
    grid.replaceChildren(...cards);
    const count = columnCountFor(grid);
    const fill = filling() && count > 1;
    resetStories(grid);
    if (count === 1) return;
    if (fill) grid.querySelectorAll('.item.extra').forEach((item) => item.classList.add('show'));
    const measured = cards.map(measureCard);
    // Packed by the height each card has at its own number of stories.
    const heights = measured.map(({ start, sizes }) => sizes[start]);
    const manual = grid.dataset.arrange === 'manual';
    const groups = manual
      ? placeColumns(cards.map((card) => (card.dataset.col ? Number(card.dataset.col) : null)), heights, count)
      : packColumns(heights, count);
    while (groups.length < count) groups.push([]); // keep every column the same width
    grid.replaceChildren(...groups.map((group) => {
      const column = document.createElement('div');
      column.className = 'column';
      column.append(...group.map((i) => cards[i]));
      return column;
    }));
    grid.classList.add('packed');
    if (!fill) return;
    const style = getComputedStyle(grid);
    const space = grid.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    for (const group of groups) {
      const counts = fillColumn(group.map((i) => measured[i]), space);
      group.forEach((i, j) => showStories(measured[i].items, counts[j]));
    }
  };

  layout();
  // page.js puts new cards straight into the grid (a customised layout, or fresh stories) and fires this.
  grid.addEventListener('cards:change', () => {
    cards = [...grid.children];
    laidOutWidth = 0;
    layout();
  });
  // page.js fires this when filling the screen is turned on or off.
  grid.addEventListener('layout:refresh', () => {
    laidOutWidth = 0;
    layout();
  });
  // Re-pack when the grid's width (or, when filling, the window's height) changes; height
  // changes from packing itself are ignored.
  let timer;
  new ResizeObserver(() => { clearTimeout(timer); timer = setTimeout(layout, 100); }).observe(grid);
}

if (typeof document !== 'undefined') document.querySelectorAll('.grid').forEach(initGrid);

// A thumbnail that fails to load (the server only shows ones it could make, so this is
// rare) becomes the same site-initial placeholder as a story without a picture.
function replaceBrokenThumb(img) {
  const placeholder = document.createElement('span');
  placeholder.className = 'thumb thumb-empty';
  placeholder.setAttribute('aria-hidden', 'true');
  placeholder.textContent = img.dataset.initial ?? '';
  img.replaceWith(placeholder);
}

if (typeof document !== 'undefined') {
  document.addEventListener('error', (event) => {
    if (event.target instanceof HTMLImageElement && event.target.matches('img.thumb')) replaceBrokenThumb(event.target);
  }, true);
  // Images that failed before this script ran.
  document.querySelectorAll('img.thumb').forEach((img) => {
    if (img.complete && img.naturalWidth === 0 && img.getAttribute('src')) replaceBrokenThumb(img);
  });
}
