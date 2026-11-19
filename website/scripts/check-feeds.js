// Fetches every feed in the catalogue the way the server would, and reports which ones
// work: HTTP status, number of stories and how old the newest one is. Exits with an error
// if any feed fails or has gone stale, so it can gate catalogue edits.
//
//   npm run check-feeds                      # config/catalogue.json
//   npm run check-feeds -- path/to/other.json

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { catalogueProblems, catalogueSources } from '../lib/catalogue.js';
import { USER_AGENT, readFeed } from '../lib/feeds.js';

const STALE_DAYS = 7;
const TIMEOUT_MS = 15_000;
const CONCURRENCY = 8;

const ROOT = join(import.meta.dirname, '..');
const path = process.argv[2] ?? join(ROOT, 'config', 'catalogue.json');
const catalogue = JSON.parse(await readFile(path, 'utf8'));
const { widgets } = JSON.parse(await readFile(join(ROOT, 'config', 'feeds.json'), 'utf8'));

async function check({ url }) {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return { problem: `HTTP ${response.status}` };
    const { items } = readFeed(await response.text());
    if (!items.length) return { problem: 'no stories' };
    const newest = Math.max(...items.map((item) => Date.parse(item.date ?? '') || 0));
    const days = newest ? (Date.now() - newest) / 86_400_000 : null;
    const images = items.filter((item) => item.image).length;
    return {
      stories: items.length,
      images,
      days,
      ...(days === null ? { warning: 'no dates' } : days > STALE_DAYS ? { problem: `newest story ${Math.floor(days)} days old` } : {}),
    };
  } catch (error) {
    return { problem: error.name === 'TimeoutError' ? 'timed out' : error.message.replace(/^Unrecognised feed format$/, 'not a feed') };
  }
}

// A few at a time, so no site sees a burst from us.
async function checkAll(sources) {
  const results = new Array(sources.length);
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < sources.length) {
      const i = next++;
      results[i] = { ...sources[i], ...await check(sources[i]) };
    }
  }));
  return results;
}

const age = (days) => (days === null || days === undefined ? '' : days < 1 / 24 ? 'now' : days < 1 ? `${Math.round(days * 24)}h` : `${Math.round(days)}d`);

const problems = catalogueProblems(catalogue, widgets);
for (const problem of problems) console.log(`catalogue: ${problem}`);

const results = await checkAll(catalogueSources(catalogue));
const width = Math.max(...results.map((r) => r.id.length));
for (const r of results) {
  const mark = r.problem ? 'FAIL' : r.warning ? 'warn' : ' ok ';
  const detail = r.problem ?? `${String(r.stories).padStart(3)} stories, ${String(r.images).padStart(3)} images, newest ${age(r.days)}${r.warning ? ` (${r.warning})` : ''}`;
  console.log(`${mark}  ${r.id.padEnd(width)}  ${detail}  ${r.problem ? r.url : ''}`.trimEnd());
}

const failed = results.filter((r) => r.problem).length;
console.log(`\n${results.length - failed} of ${results.length} feeds ok${problems.length ? `, ${problems.length} catalogue problem${problems.length === 1 ? '' : 's'}` : ''}.`);
if (failed || problems.length) process.exitCode = 1;
