import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packColumns } from '../public/layout.js';

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
