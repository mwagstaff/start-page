import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBackdrop, londonDay, parseBing, pickBackdrop } from '../lib/backdrop.js';

const BING_JSON = {
  images: [
    { urlbase: '/th?id=OHR.Stones_EN-GB1', title: 'Misty stones', copyright: 'Stones (© Someone)', copyrightlink: 'https://www.bing.com/search?q=stones' },
    { urlbase: '/th?id=OHR.Castle_EN-GB2', title: 'Castle', copyright: 'Castle (© Someone else)', copyrightlink: 'https://www.bing.com/search?q=castle' },
  ],
};

test('parseBing builds 1920×1080 photo URLs with credits', () => {
  assert.deepEqual(parseBing(BING_JSON)[0], {
    url: 'https://www.bing.com/th?id=OHR.Stones_EN-GB1_1920x1080.jpg',
    title: 'Misty stones',
    credit: 'Stones (© Someone)',
    link: 'https://www.bing.com/search?q=stones',
  });
  assert.deepEqual(parseBing({}), []);
});

test('pickBackdrop is stable for a day and varies across days', () => {
  const pools = [{ weight: 1, images: Array.from({ length: 10 }, (_, i) => ({ url: `https://x/${i}.jpg` })) }];
  assert.equal(pickBackdrop(pools, '2026-10-29').url, pickBackdrop(pools, '2026-10-29').url);
  const week = new Set(['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30'].map((day) => pickBackdrop(pools, day).url));
  assert.ok(week.size > 1);
});

test('pickBackdrop skips the previous photo and empty sources', () => {
  const pools = [{ weight: 100, images: [] }, { weight: 1, images: [{ url: 'a' }, { url: 'b' }] }];
  for (const day of ['2026-01-01', '2026-01-02', '2026-01-03']) assert.equal(pickBackdrop(pools, day, 'a').url, 'b');
  assert.equal(pickBackdrop([{ weight: 1, images: [{ url: 'a' }] }], '2026-01-01', 'a').url, 'a');
  assert.equal(pickBackdrop([{ weight: 1, images: [] }], '2026-01-01'), null);
});

test('pickBackdrop follows source weights', () => {
  const pools = [{ weight: 3, images: [{ url: 'earth' }] }, { weight: 1, images: [{ url: 'space' }] }];
  let earth = 0;
  for (let d = 1; d <= 400; d++) if (pickBackdrop(pools, `day-${d}`).url === 'earth') earth++;
  assert.ok(earth > 250 && earth < 350, `earth picked ${earth} of 400 days`);
});

test('createBackdrop fetches once a day and upgrades ESA images to wallpaper size', async () => {
  let time = Date.parse('2026-10-29T08:00:00Z');
  let fetches = 0;
  const backdrop = createBackdrop(
    { sources: [{ type: 'rss', name: 'ESA/Webb', url: 'https://esawebb.org/feed/' }] },
    {
      feed: async () => { fetches++; return [{ title: 'Nebula', link: 'https://esawebb.org/images/1/', image: 'https://cdn.esawebb.org/archives/images/screen/potm1a.jpg' }]; },
      exists: async (url) => url.includes('/wallpaper4/'),
      now: () => time,
      log: { warn() {} },
    },
  );
  await backdrop.refresh();
  assert.equal(backdrop.current.url, 'https://cdn.esawebb.org/archives/images/wallpaper4/potm1a.jpg');
  assert.equal(backdrop.current.credit, 'ESA/Webb');
  await backdrop.refresh();
  assert.equal(fetches, 1);
  time += 24 * 3600_000;
  await backdrop.refresh();
  assert.equal(fetches, 2);
});

test('createBackdrop keeps the last photo when every source fails', async () => {
  let fail = false;
  let time = Date.parse('2026-10-29T08:00:00Z');
  const backdrop = createBackdrop(
    { sources: [{ type: 'bing', market: 'en-GB' }] },
    { json: async () => { if (fail) throw new Error('down'); return BING_JSON; }, now: () => time, log: { warn() {} } },
  );
  await backdrop.refresh();
  const first = backdrop.current;
  fail = true;
  time += 24 * 3600_000;
  await backdrop.refresh();
  assert.equal(backdrop.current, first);
});

test('londonDay uses the UK date', () => {
  assert.equal(londonDay(Date.parse('2026-06-30T23:30:00Z')), '2026-07-01');
});
