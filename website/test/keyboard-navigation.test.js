import { test } from 'node:test';
import assert from 'node:assert/strict';
import { barCommand, spatialNeighbor } from '../public/keyboard-navigation.js';

const rect = (left, top, width, height) => ({ left, top, right: left + width, bottom: top + height });
const layout = [rect(0, 0, 300, 220), rect(0, 240, 300, 300), rect(320, 0, 300, 540), rect(640, 0, 300, 200), rect(640, 220, 300, 320)];

test('vertical card boundaries stay in their column and never wrap diagonally', () => {
  assert.equal(spatialNeighbor(layout, 0, 'ArrowDown'), 1);
  assert.equal(spatialNeighbor(layout, 1, 'ArrowUp'), 0);
  assert.equal(spatialNeighbor(layout, 0, 'ArrowUp'), -1);
  assert.equal(spatialNeighbor(layout, 1, 'ArrowDown'), -1);
  assert.equal(spatialNeighbor(layout, 2, 'ArrowDown'), -1);
  assert.equal(spatialNeighbor(layout, 3, 'ArrowDown'), 4);
  assert.equal(spatialNeighbor(layout, 4, 'ArrowUp'), 3);
});

test('horizontal movement crosses to the adjacent column at the reading height', () => {
  assert.equal(spatialNeighbor(layout, 2, 'ArrowLeft', rect(330, 20, 280, 50)), 0);
  assert.equal(spatialNeighbor(layout, 2, 'ArrowLeft', rect(330, 320, 280, 50)), 1);
  assert.equal(spatialNeighbor(layout, 2, 'ArrowRight', rect(330, 20, 280, 50)), 3);
  assert.equal(spatialNeighbor(layout, 2, 'ArrowRight', rect(330, 320, 280, 50)), 4);
  assert.equal(spatialNeighbor(layout, 0, 'ArrowRight'), 2);
  assert.equal(spatialNeighbor(layout, 0, 'ArrowLeft'), -1);
  assert.equal(spatialNeighbor(layout, 4, 'ArrowRight'), -1);
});

test('geometry is independent of DOM order and window scroll offset', () => {
  const shuffled = [layout[4], layout[1], layout[2], layout[0], layout[3]].map(r => ({ ...r, top: r.top - 450, bottom: r.bottom - 450 }));
  assert.equal(spatialNeighbor(shuffled, 2, 'ArrowRight', rect(330, -130, 280, 50)), 0);
  assert.equal(spatialNeighbor(shuffled, 1, 'ArrowUp'), 3);
});

test('a single column supports vertical travel but no left/right wrap', () => {
  const mobile = [rect(20, 0, 350, 80), rect(20, 100, 350, 600), rect(20, 720, 350, 300)];
  assert.equal(spatialNeighbor(mobile, 0, 'ArrowDown'), 1); // includes empty cards
  assert.equal(spatialNeighbor(mobile, 1, 'ArrowDown'), 2);
  assert.equal(spatialNeighbor(mobile, 1, 'ArrowLeft'), -1);
  assert.equal(spatialNeighbor(mobile, 1, 'ArrowRight'), -1);
  assert.equal(spatialNeighbor([], 0, 'ArrowRight'), -1);
});

test('drawer arrows stay aligned with visible controls', () => {
  const controls = [rect(0, 0, 80, 40), rect(100, 0, 80, 40), rect(90, 100, 90, 40), rect(0, 100, 70, 40)];
  assert.equal(spatialNeighbor(controls, 0, 'ArrowRight', controls[0], true), 1);
  assert.equal(spatialNeighbor(controls, 0, 'ArrowDown', controls[0], true), 3);
  assert.equal(spatialNeighbor(controls, 1, 'ArrowRight', controls[1], true), -1);
});

test('Customise navigation leaves native controls, modifiers and Tab alone', () => {
  const command = (key, options = {}, extra = {}) => barCommand({ key, ...extra }, options);
  assert.equal(command('ArrowRight', { inMain: true }), 'ArrowRight');
  assert.equal(command('ArrowDown', { inMain: true }), 'ArrowDown');
  assert.equal(command('Home', { inMain: true }), 'Home');
  assert.equal(command('Home'), null);
  assert.equal(command('Enter', { checkable: true }), 'toggle');
  assert.equal(command('Enter', { checkable: true }, { repeat: true }), null);
  assert.equal(command('Escape', { nativeArrows: true }), 'back');
  for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']) assert.equal(command(key, { nativeArrows: true }), null);
  for (const key of ['Tab', ' ', '/', 'a']) assert.equal(command(key), null);
  for (const flag of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey', 'isComposing', 'defaultPrevented']) assert.equal(command('ArrowRight', {}, { [flag]: true }), null);
});
