import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCache, mergeItems } from '../lib/cache.js';

const item = (link, date) => ({ title: link, link, date, image: null });
const quiet = { warn() {} };

test('single-source widgets keep feed order and apply the limit', () => {
  const items = mergeItems({ limit: 2 }, [{ name: 'BBC', items: [item('https://a/1', '2026-10-01'), item('https://a/2', '2026-10-03'), item('https://a/3', '2026-10-02')] }]);
  assert.deepEqual(items.map((i) => [i.link, i.source]), [['https://a/1', 'BBC'], ['https://a/2', 'BBC']]);
});

test('merged widgets sort newest first, cap each source and remove duplicates', () => {
  const items = mergeItems({ limit: 4, maxPerSource: 2 }, [
    { name: 'A', items: [item('https://a/1', '2026-10-05T00:00:00Z'), item('https://a/2', '2026-10-04T00:00:00Z'), item('https://a/3', '2026-10-09T00:00:00Z')] },
    { name: 'B', items: [item('https://a/1?utm_source=rss', '2026-10-06T00:00:00Z'), item('https://b/2', '2026-10-01T00:00:00Z')] },
  ]);
  assert.deepEqual(items.map((i) => [i.link, i.source]), [
    ['https://a/1?utm_source=rss', 'B'],
    ['https://a/2', 'A'],
    ['https://b/2', 'B'],
  ]);
});

test('a failed refresh keeps the last good items and reports the source', async () => {
  const config = { widgets: { tech: { title: 'Tech', sources: [{ name: 'Ars', url: 'https://ars/feed' }, { name: 'Reg', url: 'https://reg/feed' }] } } };
  let fail = false;
  const cache = createCache(config, {
    log: quiet,
    fetch: async (url) => {
      if (fail && url === 'https://reg/feed') throw new Error('HTTP 503');
      return [item(`${url}/story`, '2026-10-29T00:00:00Z')];
    },
  });

  await cache.refresh();
  assert.equal(cache.widget('tech').items.length, 2);
  assert.deepEqual(cache.widget('tech').failedSources, []);

  fail = true;
  await cache.refresh();
  const widget = cache.widget('tech');
  assert.equal(widget.items.length, 2);
  assert.deepEqual(widget.failedSources, ['Reg']);
});

test('concurrent refresh calls share one fetch round', async () => {
  let calls = 0;
  const cache = createCache({ widgets: { w: { title: 'W', sources: [{ name: 'S', url: 'https://s' }] } } }, {
    log: quiet,
    fetch: async () => { calls += 1; return []; },
  });
  await Promise.all([cache.refresh(), cache.refresh()]);
  assert.equal(calls, 1);
  assert.equal(cache.ready, true);
});

test('cards without their own limit use the configured default', () => {
  const feed = { name: 'S', items: Array.from({ length: 10 }, (_, i) => item(`https://a/${i}`, '2026-10-01')) };
  assert.equal(mergeItems({}, [feed]).length, 6);
  assert.equal(mergeItems({}, [feed], 8).length, 8);
  assert.equal(mergeItems({ limit: 3 }, [feed], 8).length, 3);
});

test('a story shown in an earlier card is left out of later cards, which backfill', async () => {
  const feeds = {
    'https://ai/feed': [item('https://verge/altman', '2026-10-30T10:00:00Z'), item('https://tc/summit', '2026-10-30T09:00:00Z')],
    'https://tech/feed': [item('https://verge/altman?utm_source=rss', '2026-10-30T10:00:00Z'), item('https://verge/miracles', '2026-10-30T11:00:00Z'), item('https://verge/nissan', '2026-10-30T08:00:00Z')],
  };
  const config = {
    tabs: [{ id: 'home', widgets: ['ai', 'tech'] }],
    widgets: {
      tech: { title: 'Tech', limit: 2, sources: [{ name: 'Verge', url: 'https://tech/feed' }] },
      ai: { title: 'AI', limit: 2, sources: [{ name: 'Verge AI', url: 'https://ai/feed' }] },
    },
  };
  const cache = createCache(config, { log: quiet, fetch: async (url) => feeds[url] });
  await cache.refresh();
  assert.deepEqual(cache.widget('ai').items.map((i) => i.link), ['https://verge/altman', 'https://tc/summit']);
  assert.deepEqual(cache.widget('tech').items.map((i) => i.link), ['https://verge/miracles', 'https://verge/nissan']);
});

test('the same headline under a different link counts as the same story', () => {
  const headline = (link) => ({ title: 'Sam Altman sympathizes with mathematicians', link, date: '2026-10-30', image: null });
  const seen = new Set();
  mergeItems({}, [{ name: 'Verge AI', items: [headline('https://verge/ai/altman')] }], 6, seen);
  const later = mergeItems({}, [{ name: 'Verge', items: [headline('https://verge/altman'), item('https://verge/other', '2026-10-30')] }], 6, seen);
  assert.deepEqual(later.map((i) => i.link), ['https://verge/other']);
});

test('buildCards follows the given layout order, limits and hidden cards', async () => {
  const { buildCards } = await import('../public/stories.js');
  const story = (link) => ({ title: `A long enough headline about ${link}`, link, date: '2026-10-30T10:00:00Z', image: null });
  const widgets = {
    ai: { title: 'AI', link: null, thumbnails: false, limit: 2, maxPerSource: null, sources: [{ name: 'Verge AI', error: null, items: [story('https://v/1'), story('https://v/2'), story('https://v/3')] }] },
    tech: { title: 'Tech', link: null, thumbnails: false, limit: 2, maxPerSource: null, sources: [{ name: 'Verge', error: 'HTTP 500', items: [story('https://v/1'), story('https://v/4')] }] },
  };
  // Tech first this time, so it keeps the shared story and AI backfills.
  const cards = buildCards(widgets, [{ id: 'tech' }, { id: 'ai', limit: 3 }, { id: 'missing' }]);
  assert.deepEqual(cards.map((card) => [card.id, card.items.map((i) => i.link), card.failedSources]), [
    ['tech', ['https://v/1', 'https://v/4'], ['Verge']],
    ['ai', ['https://v/2', 'https://v/3'], []],
  ]);
});

test('the snapshot sends spare items per source and keeps its version until something changes', async () => {
  const many = (url) => Array.from({ length: 30 }, (_, i) => item(`${url}/${i}`, `2026-10-${String(30 - (i % 28)).padStart(2, '0')}T00:00:00Z`));
  const config = {
    defaultLimit: 6,
    tabs: [{ id: 'home', widgets: ['hn', 'tech'] }],
    widgets: {
      hn: { title: 'HN', limit: 12, sources: [{ name: 'HN', url: 'https://hn' }] },
      tech: { title: 'Tech', limit: 8, maxPerSource: 2, sources: [{ name: 'Ars', url: 'https://ars' }, { name: 'Reg', url: 'https://reg' }] },
    },
  };
  const cache = createCache(config, { log: quiet, fetch: async (url) => many(url) });
  await cache.refresh();
  const first = cache.snapshot();
  assert.equal(first.widgets.hn.sources[0].items.length, 15 + 6);
  assert.equal(first.widgets.tech.sources[0].items.length, 2 + 6);
  assert.equal(first.widgets.tech.maxPerSource, 2);
  assert.equal(cache.widget('hn').items.length, 12);
  await cache.refresh();
  assert.equal(cache.snapshot().version, first.version);
});
