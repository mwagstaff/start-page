import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../public/weather-screen.js', import.meta.url), 'utf8');
const cloudCode = source.slice(source.indexOf('const CLOUD_PADDING_Y'), source.indexOf('function rain('));

test('cloud puffs fit inside their sprites, including extreme random positions and radii', () => {
  for (const xFraction of [0, 0.25, 0.5, 0.75, 1]) {
    for (const yFraction of [0, 1]) {
      const puffs = [];
      const canvas = { getContext: () => ({
        createRadialGradient(x, y, _inner, _x, _y, radius) {
          puffs.push({ x, y, radius });
          return { addColorStop() {} };
        },
        fillRect() {},
      }) };
      runInNewContext(`${cloudCode}\ncloudSprite('255 255 255');`, {
        document: { createElement: () => canvas },
        random: (low, high) => low + (high - low) * (low === 120 ? xFraction : low === 110 ? yFraction : 1),
      });
      assert.equal(puffs.length, 14);
      for (const { x, y, radius } of puffs) {
        assert.ok(x - radius >= 0 && x + radius <= canvas.width);
        assert.ok(y - radius >= 0 && y + radius <= canvas.height, 'puff must fade to transparent before the sprite edge');
      }
    }
  }
});

test('sprite padding preserves cloud position and scale, including stretched fog', () => {
  for (const stretch of [1, 2.6]) {
    let puffY;
    let drawn;
    runInNewContext(`${cloudCode}\nclouds({ w: 1000, h: 800, count: 1, shade: '255 255 255', alpha: 0.6, stretch })({ drawImage: (...args) => { drawn(args); } }, 0);`, {
      stretch,
      drawn: (args) => { drawn = args; },
      random: (low, high) => (low + high) / 2,
      document: { createElement: () => ({ getContext: () => ({
        createRadialGradient(_x, y) { puffY = y; return { addColorStop() {} }; },
        fillRect() {},
      }) }) },
    });
    const [sprite, x, y, width, height] = drawn;
    const scale = 1.25;
    assert.equal(x, 350);
    assert.equal(width, 640 * scale * stretch);
    assert.equal(height / sprite.height, scale);
    assert.ok(Math.abs(y + puffY * scale - (240 + (100 - 130) * scale)) < 1e-9);
  }
});
