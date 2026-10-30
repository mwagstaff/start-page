import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardList, validSettings } from '../public/settings.js';

test('validSettings keeps sensible cards and drops the rest', () => {
  assert.equal(validSettings(null), null);
  assert.equal(validSettings({ v: 2, tabs: {} }), null);
  assert.equal(validSettings({ v: 1 }), null);
  const settings = validSettings({
    v: 1,
    tabs: {
      home: { cards: [{ id: 'ai', hidden: true, limit: 4 }, { id: 'ai' }, { id: 'tech', limit: 99, extra: 'x' }, { id: 7 }, null, { id: 'hn', hidden: 'yes', limit: 3.5 }] },
      junk: { cards: 'nope' },
    },
  });
  assert.deepEqual(settings, { v: 1, tabs: { home: { cards: [{ id: 'ai', hidden: true, limit: 4 }, { id: 'tech' }, { id: 'hn' }] } } });
});

test('cardList puts saved cards first, then new defaults, then the rest hidden', () => {
  const all = ['news', 'hn', 'ai', 'tech', 'space'];
  assert.deepEqual(cardList(null, ['news', 'hn', 'ai'], all), [{ id: 'news' }, { id: 'hn' }, { id: 'ai' }, { id: 'tech', hidden: true }, { id: 'space', hidden: true }]);
  const saved = [{ id: 'ai', limit: 3 }, { id: 'gone' }, { id: 'news', hidden: true }];
  assert.deepEqual(cardList(saved, ['news', 'hn', 'ai'], all), [{ id: 'ai', limit: 3 }, { id: 'news', hidden: true }, { id: 'hn' }, { id: 'tech', hidden: true }, { id: 'space', hidden: true }]);
});
