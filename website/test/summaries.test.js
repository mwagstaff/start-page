import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSummaries, summaryState } from '../lib/summaries.js';
import { readFeed } from '../lib/feeds.js';

test('shared article and independent discussions survive maintenance and restart', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tab1-queue-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const link = 'https://example.org/story';
  const hn = 'https://news.ycombinator.com/item?id=1';
  const lobsters = 'https://lobste.rs/s/abc';
  const options = {
    start: false,
    capacity: async () => 1000,
    run: async (job) =>
      job.kind === 'article'
        ? { unavailable: true }
        : { bullets: [job.url], count: 1, total: 5, updated: new Date().toISOString() },
  };
  const first = createSummaries(directory, { ...options, capacity: async () => null });
  first.discover([
    { link, commentsUrl: hn },
    { link: link + '?utm_campaign=a', commentsUrl: lobsters },
  ]);
  await first.step();
  const worker = createSummaries(directory, options);
  assert.equal(worker.get(link).pending, true);
  await worker.step();
  assert.equal(worker.get(link).unavailable, true);
  await worker.step();
  await worker.step();
  const reopened = createSummaries(directory, options);
  assert.deepEqual(reopened.get(link, hn).discussion.bullets, [hn]);
  assert.deepEqual(reopened.get(link, lobsters).discussion.bullets, [lobsters]);
  assert.equal(reopened.get(link).pending, false);
  assert.equal(reopened.get('https://example.org/other'), null);
});

test('publisher excerpt preserves wording and line breaks and excludes embedded scripts', () => {
  const xml =
    '<rss><channel><item><link>https://example.org/story</link><title>Story</title><description><![CDATA[<p>One  exact phrase.</p><p>Another &amp; another.</p><script>ignore()</script>]]></description></item></channel></rss>';
  assert.equal(readFeed(xml).items[0].excerpt, 'One  exact phrase.\nAnother & another.');
});

test('only generated article or discussion text enables Summary', () => {
  assert.equal(summaryState({ pending: true }), 'pending');
  assert.equal(summaryState({ recap: 'Two sentences.', pending: true }), 'ready');
  assert.equal(summaryState({ unavailable: true, discussion: { bullets: ['A theme.'] } }), 'ready');
  assert.equal(summaryState({ unavailable: true, excerpt: 'Publisher text' }), 'unavailable');
  assert.equal(summaryState(null), 'unavailable');
});
