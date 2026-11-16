// Deterministic probes: injected fetches only; no third-party network traffic.
import { createSources } from '../lib/sources.js';
import { createCustomFeeds } from '../lib/custom.js';
import { writeFile } from 'node:fs/promises';
let release, fetches = 0;
const blocked = new Promise(resolve => { release = resolve; });
const source = createSources([{ id: 'demo', name: 'Demo', url: 'https://example.com/rss' }], {}, {
  fetch: async () => { fetches++; await blocked; return [{ title: 'Story', link: 'https://example.com/story' }]; },
  images: { get: () => null, find: async () => null },
});
const first = source.get(['demo']);
let concurrentSettled = false;
const concurrent = source.get(['demo']).then(result => { concurrentSettled = true; return result; });
await new Promise(resolve => setImmediate(resolve));
const returnedBeforeFetch = concurrentSettled;
release();
const second = await concurrent;
const loaded = await first;
const feed = createCustomFeeds({}, {
  fetch: async () => '<rss><channel><title>Demo</title><item><title>Story</title><link>https://example.com/story</link></item></channel></rss>',
  log: { warn() {} },
});
const statuses = await Promise.all(Array.from({ length: 100 }, (_, i) => feed(`https://example.com/rss?user=${i}`).then(() => 200, e => e.status)));
const result = {
  coldSourceRace: { upstreamFetches: fetches, returnedBeforeFetch, secondResponseItems: JSON.parse(second.body).sources.demo.items.length, firstResponseItems: JSON.parse(loaded.body).sources.demo.items.length },
  customFeed100Distinct: Object.fromEntries([...new Set(statuses)].map(s => [s, statuses.filter(v => v === s).length])),
};
console.log(JSON.stringify(result));
await writeFile(process.argv[2] || 'performance/2026-11-16/component-probes.json', JSON.stringify(result, null, 2));
