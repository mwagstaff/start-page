import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardList, customFeedId, moveCard, stepCard, validSettings } from '../public/settings.js';

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
  assert.deepEqual(settings, { v: 1, tabs: { home: { cards: [{ id: 'ai', hidden: true, limit: 4 }, { id: 'tech' }, { id: 'hn' }] } }, custom: [] });
});

test('cardList puts saved cards first, then new defaults, then the rest hidden', () => {
  const all = ['news', 'hn', 'ai', 'tech', 'space'];
  assert.deepEqual(cardList(null, ['news', 'hn', 'ai'], all), [{ id: 'news' }, { id: 'hn' }, { id: 'ai' }, { id: 'tech', hidden: true }, { id: 'space', hidden: true }]);
  const saved = [{ id: 'ai', limit: 3 }, { id: 'gone' }, { id: 'news', hidden: true }];
  assert.deepEqual(cardList(saved, ['news', 'hn', 'ai'], all), [{ id: 'ai', limit: 3 }, { id: 'news', hidden: true }, { id: 'hn' }, { id: 'tech', hidden: true }, { id: 'space', hidden: true }]);
});

test('custom feeds keep a stable id from their address, a title and nothing unsafe', () => {
  const settings = validSettings({
    v: 1,
    tabs: {},
    custom: [
      { id: 'made-up', url: 'https://www.example.com/feed', title: '  ' },
      { url: 'https://www.example.com/feed', title: 'Duplicate' },
      { url: 'javascript:alert(1)', title: 'Nope' },
      { url: 'https://blog.example.org/atom.xml', title: 'A'.repeat(200) },
    ],
  });
  assert.deepEqual(settings.custom.map((feed) => [feed.id, feed.title.length > 20 ? feed.title.length : feed.title]), [
    [customFeedId('https://www.example.com/feed'), 'example.com'],
    [customFeedId('https://blog.example.org/atom.xml'), 80],
  ]);
  assert.match(customFeedId('https://x'), /^custom-[0-9a-z]+$/);
  assert.equal(customFeedId('https://x'), customFeedId('https://x'));
});

test('validSettings keeps placed columns and the manual arrangement', () => {
  const settings = validSettings({ v: 1, tabs: { home: { arrange: 'manual', cards: [{ id: 'a', col: 2 }, { id: 'b', col: -1 }, { id: 'c', col: 40 }, { id: 'd', col: 1.5 }] }, ai: { arrange: 'sideways', cards: [] } } });
  assert.deepEqual(settings.tabs, { home: { arrange: 'manual', cards: [{ id: 'a', col: 2 }, { id: 'b' }, { id: 'c' }, { id: 'd' }] }, ai: { cards: [] } });
});

test('stepCard moves one place in reading order, across columns too', () => {
  const cards = [{ id: 'a', col: 0 }, { id: 'b', col: 0 }, { id: 'c', col: 1 }, { id: 'd', col: 1 }];
  assert.deepEqual(stepCard(cards, 3, -1).map((c) => c.id), ['a', 'b', 'd', 'c']);
  // The top of column 2 steps up to the bottom of column 1, staying put in the list.
  assert.deepEqual(stepCard(cards, 2, -1), [{ id: 'a', col: 0 }, { id: 'b', col: 0 }, { id: 'c', col: 0 }, { id: 'd', col: 1 }]);
  assert.deepEqual(stepCard(cards, 1, 1)[1], { id: 'b', col: 1 });
  assert.deepEqual(stepCard([{ id: 'a' }, { id: 'b' }], 0, 1), [{ id: 'b' }, { id: 'a' }]);
  assert.deepEqual(stepCard(cards, 0, -1), cards);
});

test('moveCard joins the column of the card now before it', () => {
  const cards = [{ id: 'a', col: 0 }, { id: 'b', col: 0 }, { id: 'c', col: 1 }];
  assert.deepEqual(moveCard(cards, 0, 2), [{ id: 'b', col: 0 }, { id: 'c', col: 1 }, { id: 'a', col: 1 }]);
  assert.deepEqual(moveCard(cards, 2, 0), [{ id: 'c', col: 0 }, { id: 'a', col: 0 }, { id: 'b', col: 0 }]);
  assert.deepEqual(moveCard([{ id: 'a' }, { id: 'b' }], 1, 0), [{ id: 'b' }, { id: 'a' }]);
});
