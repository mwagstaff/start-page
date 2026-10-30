// Rearranges the cards into balanced columns so the page is as short as possible.
// Without JavaScript the CSS multi-column layout still works; this only improves on it.

const MIN_COLUMN_WIDTH = 300; // keep in step with `columns: 300px` in style.css
const EXACT_LIMIT = 16; // above this many cards, use the greedy result alone

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

function columnCountFor(grid) {
  const style = getComputedStyle(grid);
  const width = grid.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const gap = parseFloat(style.columnGap) || 0;
  // Same rule the browser uses for `columns: 300px`.
  return Math.max(1, Math.floor((width + gap) / (MIN_COLUMN_WIDTH + gap)));
}

function initGrid(grid) {
  let cards = [...grid.children];
  let laidOutWidth = 0;

  const layout = () => {
    if (grid.clientWidth === laidOutWidth) return;
    laidOutWidth = grid.clientWidth;
    // Measure in the CSS column layout, where each card already has the column width.
    grid.classList.remove('packed');
    grid.replaceChildren(...cards);
    const count = columnCountFor(grid);
    if (count === 1) return;
    const heights = cards.map((card) => card.getBoundingClientRect().height + parseFloat(getComputedStyle(card).marginBottom));
    const groups = packColumns(heights, count);
    while (groups.length < count) groups.push([]); // keep every column the same width
    grid.replaceChildren(...groups.map((group) => {
      const column = document.createElement('div');
      column.className = 'column';
      column.append(...group.map((i) => cards[i]));
      return column;
    }));
    grid.classList.add('packed');
  };

  layout();
  // page.js puts new cards straight into the grid (a customised layout, or fresh stories) and fires this.
  grid.addEventListener('cards:change', () => {
    cards = [...grid.children];
    laidOutWidth = 0;
    layout();
  });
  // Re-pack when the grid's width changes; height changes from packing itself are ignored.
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
