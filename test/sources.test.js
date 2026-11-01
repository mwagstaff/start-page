import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicCatalogue } from '../lib/catalogue.js';
import { SOURCE_ITEMS, createSources } from '../lib/sources.js';

const quiet = { warn() {} };
const item = (link) => ({ title: link, link, date: '2026-10-30T00:00:00Z', image: `${link}.jpg` });
const noImages = { get: () => null, find: async () => null };
const list = [
  { id: 'a.top', name: 'A', url: 'https://a/top' },
  { id: 'b.top', name: 'B', url: 'https://b/top' },
  { id: 'c.top', name: 'C', url: 'https://c/top' },
];

function setup({ fail = () => false } = {}) {
  const clock = { now: Date.parse('2026-10-30T12:00:00Z') };
  const fetched = [];
  const sources = createSources(list, { refreshMinutes: 10, keepHours: 24 }, {
    log: quiet,
    images: noImages,
    now: () => clock.now,
    fetch: async (url) => {
      fetched.push(url);
      if (fail(url)) throw new Error('HTTP 503');
      return Array.from({ length: 30 }, (_, i) => item(`${url}/${i}`));
    },
  });
  return { sources, fetched, clock };
}

const read = async (sources, ids) => JSON.parse((await sources.get(ids)).body).sources;

test('canonical ids are known, unique and sorted', () => {
  const { sources } = setup();
  assert.deepEqual(sources.canonical(['b.top', 'a.top', 'b.top', '']), ['a.top', 'b.top']);
  assert.throws(() => sources.canonical(['a.top', 'https://evil/feed']), { status: 400, message: /Unknown source/ });
  assert.throws(() => sources.canonical(['']), { status: 400 });
});

test('fetches a source the first time it is asked for, then serves it from memory', async () => {
  const { sources, fetched } = setup();
  const first = await read(sources, ['b.top', 'a.top']);
  assert.deepEqual(Object.keys(first), ['a.top', 'b.top']);
  assert.equal(first['a.top'].name, 'A');
  assert.equal(first['a.top'].items.length, SOURCE_ITEMS);
  assert.deepEqual(fetched, ['https://a/top', 'https://b/top']);

  await read(sources, ['a.top']);
  assert.equal(fetched.length, 2);
});

test('the timer refreshes only sources asked for lately', async () => {
  const { sources, fetched, clock } = setup();
  await sources.get(['a.top']);
  clock.now += 2 * 3_600_000;
  await sources.get(['b.top']);
  fetched.length = 0;

  await sources.refresh();
  assert.deepEqual(fetched.sort(), ['https://a/top', 'https://b/top']);

  clock.now += 23 * 3_600_000; // a.top was last asked for 25 hours ago
  fetched.length = 0;
  await sources.refresh();
  assert.deepEqual(fetched, ['https://b/top']);
});

test('a source nobody kept warm is fetched again when next asked for', async () => {
  const { sources, fetched, clock } = setup();
  await sources.get(['a.top']);
  clock.now += 16 * 60_000;
  await sources.get(['a.top']);
  assert.equal(fetched.length, 2);
});

test('a failed fetch keeps the last good items and reports the error', async () => {
  let down = false;
  const { sources, clock } = setup({ fail: () => down });
  await sources.get(['a.top']);
  down = true;
  clock.now += 16 * 60_000;
  const { 'a.top': source } = await read(sources, ['a.top']);
  assert.equal(source.error, 'HTTP 503');
  assert.equal(source.items.length, SOURCE_ITEMS);
});

test('responses carry an etag that changes only when a feed does', async () => {
  const { sources, clock } = setup();
  const first = await sources.get(['a.top', 'b.top']);
  const again = await sources.get(['b.top', 'a.top']);
  assert.equal(again.etag, first.etag);
  clock.now += 16 * 60_000;
  await sources.refresh();
  // Same stories, but fetched at a new time.
  assert.notEqual((await sources.get(['a.top', 'b.top'])).etag, first.etag);
});

test('items get thumbnail paths when there is a thumbnailer', async () => {
  const thumbs = { path: (url) => `/thumb/${encodeURIComponent(url)}.webp`, warm: async () => null };
  const sources = createSources(list, {}, { log: quiet, images: noImages, thumbs, fetch: async () => [item('https://a/1')] });
  const { 'a.top': source } = await read(sources, ['a.top']);
  assert.equal(source.items[0].image, '/thumb/https%3A%2F%2Fa%2F1.jpg.webp');
});

test('the public catalogue names feeds by id and leaves out their addresses', () => {
  const shown = publicCatalogue({
    outlets: { ft: { name: 'FT', region: 'uk', paywall: 'hard', sections: { top: 'https://ft/top', world: 'https://ft/world' } } },
    topics: {
      world: { label: 'World', section: 'world' },
      nfl: { label: 'NFL', region: 'us', sources: [{ name: 'ESPN', url: 'https://espn/nfl' }] },
      ai: { label: 'AI', widget: 'ai' },
    },
    defaults: { uk: { outlets: ['ft'], topics: ['world'] } },
  });
  assert.deepEqual(shown.outlets, { ft: { name: 'FT', region: 'uk', paywall: 'hard', sections: ['top', 'world'] } });
  assert.deepEqual(shown.topics, {
    world: { label: 'World', section: 'world' },
    nfl: { label: 'NFL', region: 'us', sources: [{ id: 'nfl.1', name: 'ESPN' }] },
    ai: { label: 'AI', widget: 'ai' },
  });
  assert.ok(!JSON.stringify(shown).includes('https://'));
});

test('feeds the default page already fetches are read from its cache, not fetched again', async () => {
  const fetched = [];
  let version = 1;
  const page = { items: [item('https://a/page')], fetchedAt: '2026-10-30T11:55:00Z', error: null };
  const sources = createSources(list, {}, {
    log: quiet,
    images: noImages,
    shared: (url) => (url === 'https://a/top' ? page : undefined),
    sharedVersion: () => version,
    fetch: async (url) => { fetched.push(url); return [item(`${url}/1`)]; },
  });
  const first = await sources.get(['a.top', 'b.top']);
  assert.deepEqual(fetched, ['https://b/top']);
  assert.equal(JSON.parse(first.body).sources['a.top'].items[0].link, 'https://a/page');

  await sources.refresh();
  assert.deepEqual(fetched, ['https://b/top', 'https://b/top']);

  // A refresh of the default page shows up in the next response.
  page.items = [item('https://a/newer')];
  version = 2;
  assert.equal(JSON.parse((await sources.get(['a.top'])).body).sources['a.top'].items[0].link, 'https://a/newer');
});
