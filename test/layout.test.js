import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packColumns, placeColumns } from '../public/layout.js';

const tallest = (heights, columns) => Math.max(...columns.map((column) => column.reduce((sum, i) => sum + heights[i], 0)));

// Tries every assignment, for checking the search against small inputs.
function bruteForce(heights, cols) {
  let best = Infinity;
  for (let code = 0; code < cols ** heights.length; code++) {
    const loads = new Array(cols).fill(0);
    let rest = code;
    for (const h of heights) { loads[rest % cols] += h; rest = Math.floor(rest / cols); }
    best = Math.min(best, Math.max(...loads));
  }
  return best;
}

test('packColumns finds the shortest possible tallest column', () => {
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let run = 0; run < 200; run++) {
    const heights = Array.from({ length: 2 + Math.floor(random() * 6) }, () => 100 + Math.round(random() * 500));
    const cols = 2 + Math.floor(random() * 3);
    assert.equal(tallest(heights, packColumns(heights, cols)), bruteForce(heights, cols), `heights ${heights}, ${cols} columns`);
  }
});

test('packColumns beats the greedy split where greedy goes wrong', () => {
  // Greedy gives 3+2+2 | 3+2 → 7; the best split is 3+3 | 2+2+2 → 6.
  const heights = [3, 3, 2, 2, 2];
  assert.equal(tallest(heights, packColumns(heights, 2)), 6);
});

test('packColumns keeps config order within and across columns', () => {
  const columns = packColumns([400, 300, 500, 200, 600, 350, 450], 4);
  assert.deepEqual(columns.flat().sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6]);
  for (const column of columns) assert.deepEqual(column, [...column].sort((a, b) => a - b));
  assert.equal(columns[0][0], 0);
});

test('packColumns stacks everything in one column when only one fits', () => {
  assert.deepEqual(packColumns([10, 20, 30], 1), [[0, 1, 2]]);
});

test('placeColumns keeps cards in their chosen columns, however many each has', () => {
  // Everything in the first column stays there; nothing is moved to balance the page.
  assert.deepEqual(placeColumns([0, 0, 0, 0], [100, 100, 100, 100], 3), [[0, 1, 2, 3], [], []]);
  assert.deepEqual(placeColumns([1, 0, 2, 0], [10, 10, 10, 10], 3), [[1, 3], [0], [2]]);
});

test('placeColumns folds extra columns into the last and puts new cards in the shortest', () => {
  assert.deepEqual(placeColumns([0, 3, 2], [10, 10, 10], 2), [[0], [1, 2]]);
  assert.deepEqual(placeColumns([null, 0, 0, 1], [50, 100, 100, 80], 2), [[1, 2], [0, 3]]);
  assert.deepEqual(placeColumns([0, 1], [10, 10], 1), [[0, 1]]);
});

// A card of `n` stories, `item` tall each, under a heading `head` tall, starting at `start`.
const card = (start, n, item = 40, head = 30) => ({ start, sizes: Array.from({ length: n + 1 }, (_, k) => head + k * item) });

test('fillColumn adds stories evenly until the column is full', async () => {
  const { fillColumn } = await import('../public/layout.js');
  // 2 × (30 + 6×40) = 540; 200 more fits five stories, fewest first.
  assert.deepEqual(fillColumn([card(6, 15), card(6, 15)], 740), [9, 8]);
});

test('fillColumn cuts stories from the fullest card when the column is too tall', async () => {
  const { fillColumn } = await import('../public/layout.js');
  // 30+8×40 + 30+4×40 = 540; 400 needs four stories cut, all from the bigger card.
  assert.deepEqual(fillColumn([card(8, 15), card(4, 15)], 400), [4, 4]);
});

test('fillColumn keeps a few stories in each card and leaves cards without any alone', async () => {
  const { fillColumn } = await import('../public/layout.js');
  assert.deepEqual(fillColumn([card(6, 6), card(0, 0)], 50), [2, 0]);
  assert.deepEqual(fillColumn([card(1, 1)], 10), [1]);
  // Nothing more to show: stays at what it has.
  assert.deepEqual(fillColumn([card(3, 3)], 1000), [3]);
});

test('storySpread shares a column\'s spare room between its stories, within a limit', async () => {
  const { storySpread } = await import('../public/layout.js');
  assert.equal(storySpread(800, 760, 10), 2); // 40px over 10 stories: 2px above and below each
  assert.equal(storySpread(800, 820, 10), 0); // too tall already: nothing added
  assert.equal(storySpread(800, 200, 2), 10); // short of stories: capped, the last card stretches
  assert.equal(storySpread(800, 100, 0), 0);
});

test('fitCount keeps most of a card\'s stories, and at least a few', async () => {
  const { fitCount } = await import('../public/layout.js');
  assert.equal(fitCount(8), 4); // half of 8
  assert.equal(fitCount(9), 5); // rounded up
  assert.equal(fitCount(4), 3); // the floor
  assert.equal(fitCount(2), 2); // never more than it has
  assert.equal(fitCount(0), 0);
});

test('overflows: the page scrolls once a column can\'t fit with its cards still useful', async () => {
  const { overflows } = await import('../public/layout.js');
  // Each card: 30 + 40 a story. Squeezed to four of its eight stories, a card is 190 tall.
  const cards = [card(8, 15), card(8, 15), card(8, 15), card(8, 15)];
  // Filling: two cards squeezed need 380.
  assert.equal(overflows([[0, 1], [2, 3]], cards, 380, true), false);
  assert.equal(overflows([[0, 1], [2, 3]], cards, 379, true), true);
  // Not filling: every card but the last keeps its own eight stories (350), the last needs 190.
  assert.equal(overflows([[0, 1]], cards, 540, false), false);
  assert.equal(overflows([[0, 1]], cards, 539, false), true);
  // A margin keeps that much spare: a scrolling page needs room to go back to fitting.
  assert.equal(overflows([[0, 1], [2, 3]], cards, 400, true, 40), true);
  assert.equal(overflows([[0, 1], [2, 3]], cards, 420, true, 40), false);
});
