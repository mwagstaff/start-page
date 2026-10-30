import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkFeedUrl, createCustomFeeds, fetchSafely, isBlockedAddress } from '../lib/custom.js';

const rss = (title, count = 3) => `<?xml version="1.0"?><rss><channel><title>${title}</title>${Array.from({ length: count }, (_, i) => `<item><title>Story ${i}</title><link>https://example.com/${i}</link></item>`).join('')}</channel></rss>`;
const quiet = { warn() {} };

test('private, loopback, Tailscale and link-local addresses are blocked', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.10', '100.101.102.103', '169.254.169.254', '0.0.0.0', '::1', 'fd7a:115c:a1e0::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:192.168.0.1', 'nonsense']) {
    assert.equal(isBlockedAddress(address), true, address);
  }
  for (const address of ['93.184.215.14', '151.101.0.81', '2606:4700::6810:84e5', '::ffff:8.8.8.8']) {
    assert.equal(isBlockedAddress(address), false, address);
  }
});

test('feed addresses must be plain public http(s) URLs', () => {
  assert.equal(checkFeedUrl('https://example.com/feed.xml#top').href, 'https://example.com/feed.xml');
  for (const [url, message] of [
    ['not a url', /isn't a web address/],
    ['ftp://example.com/feed', /http or https/],
    ['file:///etc/passwd', /http or https/],
    ['https://user:pw@example.com/feed', /without a port or password/],
    ['https://example.com:8443/feed', /without a port or password/],
    ['http://localhost/feed', /public internet/],
    ['http://mini.dog-rattlesnake.ts.net/feed', /public internet/],
    ['http://127.0.0.1/feed', /public internet/],
    ['http://[::1]/feed', /public internet/],
    ['http://169.254.169.254/latest/meta-data', /public internet/],
  ]) {
    assert.throws(() => checkFeedUrl(url), (error) => error.status === 400 && message.test(error.message), url);
  }
});

test('fetchSafely refuses blocked addresses before connecting', async () => {
  await assert.rejects(fetchSafely('http://10.0.0.1/feed'), /public internet/);
});

test('custom feeds are named from the feed, cached, and limited per minute', async () => {
  let time = 0;
  const calls = [];
  const get = createCustomFeeds({ ttlMinutes: 10, maxFetchesPerMinute: 2 }, {
    now: () => time,
    log: quiet,
    fetch: async (url) => { calls.push(url); return url.includes('broken') ? '<html></html>' : rss('Example Blog', 30); },
  });
  const feed = await get('https://example.com/feed');
  assert.equal(feed.title, 'Example Blog');
  assert.equal(feed.items.length, 20);
  await get('https://example.com/feed');
  assert.equal(calls.length, 1);
  await assert.rejects(get('https://example.com/broken'), /isn't an RSS or Atom feed/);
  await assert.rejects(get('https://example.com/third'), (error) => error.status === 429);
  time += 61_000;
  await get('https://example.com/third');
  time += 10 * 60_000;
  await get('https://example.com/feed');
  assert.equal(calls.filter((url) => url === 'https://example.com/feed').length, 2);
});
