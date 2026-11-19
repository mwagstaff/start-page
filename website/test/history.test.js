import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canRedo, canUndo, describeChange, MAX_HISTORY, moveTo, recordChange, validHistory, whenLabel } from '../public/history.js';

const settingsWith = (cards, extra = {}) => ({ v: 1, tabs: { home: { cards } }, custom: [], ...extra });
const titles = { news: 'BBC News', football: 'BBC Football', hn: 'Hacker News' };
const titleFor = (id) => titles[id];

test('recordChange builds a timeline that undo and redo walk', () => {
  const a = settingsWith([{ id: 'news' }]);
  const b = settingsWith([{ id: 'news', hidden: true }]);
  const c = settingsWith([{ id: 'news', hidden: true, limit: 3 }]);
  let history = recordChange(null, null, a, 'first', 1);
  assert.equal(history.entries.length, 2);
  assert.equal(history.entries[0].settings, null);
  history = recordChange(history, a, b, 'second', 2);
  assert.equal(history.index, 2);
  assert.ok(canUndo(history));
  assert.ok(!canRedo(history));

  history = moveTo(history, 0);
  assert.ok(!canUndo(history));
  assert.ok(canRedo(history));
  assert.equal(moveTo(history, 99).index, 2);

  // A new change after going back drops the steps that were undone.
  history = recordChange(moveTo(history, 1), a, c, 'third', 3);
  assert.deepEqual(history.entries.map((entry) => entry.label), ['Your page before any changes', 'first', 'third']);
});

test('recordChange keeps a change made elsewhere, so it can still be gone back to', () => {
  const a = settingsWith([{ id: 'news' }]);
  const b = settingsWith([{ id: 'hn' }]);
  const c = settingsWith([{ id: 'football' }]);
  const history = recordChange(recordChange(null, null, a, 'first', 1), b, c, 'later', 2);
  assert.deepEqual(history.entries.map((entry) => entry.label), ['Your page before any changes', 'first', 'Changes made in another window', 'later']);
});

test('the same settings with keys in another order are not a change made elsewhere', () => {
  const a = { custom: [], tabs: { home: { cards: [{ id: 'news' }] } }, v: 1 };
  const b = { v: 1, custom: [], tabs: { home: { cards: [{ hidden: true, id: 'news' }] } } };
  const history = recordChange(recordChange(null, null, a, 'first', 1), { ...a }, b, 'second', 2);
  assert.deepEqual(history.entries.map((entry) => entry.label), ['Your page before any changes', 'first', 'second']);
});

test('recordChange keeps only the newest snapshots', () => {
  let history = null;
  let before = null;
  for (let i = 0; i < MAX_HISTORY + 20; i++) {
    const after = settingsWith([{ id: 'news', limit: (i % 15) + 1 }]);
    history = recordChange(history, before, after, `change ${i}`, i);
    before = after;
  }
  assert.equal(history.entries.length, MAX_HISTORY);
  assert.equal(history.index, MAX_HISTORY - 1);
  assert.equal(history.entries.at(-1).label, `change ${MAX_HISTORY + 19}`);
});

test('validHistory drops nonsense from storage', () => {
  assert.equal(validHistory(null), null);
  assert.equal(validHistory({ v: 1, entries: [] }), null);
  const history = validHistory({
    v: 1,
    index: 9,
    entries: [
      { settings: null, label: 'start', at: 1 },
      { settings: { v: 9 }, label: 'broken', at: 2 },
      { settings: settingsWith([{ id: 'news' }]), label: 'ok', at: 3 },
      { label: 'no time' },
    ],
  });
  assert.deepEqual(history.entries.map((entry) => entry.label), ['start', 'ok']);
  assert.equal(history.index, 1);
});

test('describeChange names what changed', () => {
  const describe = (beforeCards, afterCards, before = settingsWith(beforeCards), after = settingsWith(afterCards)) =>
    describeChange({ before, after, beforeCards, afterCards, titleFor });
  const base = [{ id: 'news' }, { id: 'football' }, { id: 'hn' }];
  assert.equal(describe(base, [{ id: 'news' }, { id: 'football', hidden: true }, { id: 'hn' }]), 'Removed “BBC Football”');
  assert.equal(describe([{ id: 'news', hidden: true }, { id: 'football' }, { id: 'hn' }], base), 'Brought back “BBC News”');
  assert.equal(describe(base, base.map((card) => ({ ...card, hidden: true }))), 'Removed 3 cards');
  assert.equal(describe(base, [{ id: 'news', hidden: true }, { id: 'football' }, { id: 'hn' }], null, settingsWith([{ id: 'news', hidden: true }])), 'Removed “BBC News”');
  assert.equal(describe(base, [{ id: 'news', limit: 4 }, { id: 'football' }, { id: 'hn' }]), 'Showed 4 items in “BBC News”');
  assert.equal(describe(base, [{ id: 'football' }, { id: 'hn' }, { id: 'news' }]), 'Moved “BBC News”');
  assert.equal(describe(base, [{ id: 'hn' }, { id: 'news' }, { id: 'football' }]), 'Moved “Hacker News”');
  const manual = { v: 1, tabs: { home: { cards: base, arrange: 'manual' } }, custom: [] };
  assert.equal(describe(base, base, settingsWith(base), manual), 'Kept cards in their columns');
  assert.equal(describe(base, base, manual, settingsWith(base)), 'Fitted cards to the screen');
  const feed = { id: 'custom-1', url: 'https://example.com/feed', title: 'Example' };
  assert.equal(describe(base, base, settingsWith(base), settingsWith(base, { custom: [feed] })), 'Added “Example”');
  assert.equal(describe(base, base, settingsWith(base, { custom: [feed] }), settingsWith(base)), 'Deleted “Example”');
});

test('whenLabel says how long ago, then when', () => {
  const now = new Date('2026-11-01T15:00:00').getTime();
  assert.equal(whenLabel(now - 20_000, now), 'just now');
  assert.equal(whenLabel(now - 5 * 60_000, now), '5 min ago');
  assert.equal(whenLabel(now - 3 * 3_600_000, now), '3 h ago');
  assert.match(whenLabel(now - 30 * 3_600_000, now), /^yesterday \d\d:\d\d$/);
});
