import { validatorHeaders } from './feed-polling.js';
import { lookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { USER_AGENT, readFeed } from './feeds.js';
import { smallImage } from './images.js';

// Feeds readers add themselves. Anyone can ask this server to fetch any URL, and it runs
// on a home network, so it only connects to public addresses on the standard ports (checked
// on every redirect, and on the address actually connected to, so DNS can't be used to
// point it somewhere private), reads at most MAX_BYTES, and fetches a limited number of new
// URLs a minute. Each feed is shared by everyone who adds it and kept for TTL_MS.

const FETCH_TIMEOUT_MS = 10_000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const MAX_URL_LENGTH = 2000;
export const CUSTOM_FEED_ITEMS = 100;

const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]) blocked.addSubnet(network, prefix, 'ipv6');

// Private, loopback, Tailscale (100.64/10), link-local, documentation and multicast ranges.
export function isBlockedAddress(address) {
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  if (mapped) return isBlockedAddress(mapped);
  const family = isIP(address);
  if (!family) return true;
  return blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

class FeedError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

// A URL this server may fetch: http(s) on the default port, no credentials, and not a
// private address written out as a literal (names are checked when they're looked up).
export function checkFeedUrl(value) {
  let url;
  try {
    url = new URL(String(value ?? '').trim());
  } catch {
    throw new FeedError('That isn\'t a web address.', 400);
  }
  if (url.href.length > MAX_URL_LENGTH) throw new FeedError('That address is too long.', 400);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new FeedError('Use an http or https address.', 400);
  if (url.username || url.password || url.port) throw new FeedError('Use a plain address, without a port or password.', 400);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.ts.net')
    || (isIP(host) && isBlockedAddress(host))) {
    throw new FeedError('That address isn\'t on the public internet.', 400);
  }
  url.hash = '';
  return url;
}

// Used for every connection: refuses names that resolve to a blocked address.
function safeLookup(hostname, options, callback) {
  lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses.length || addresses.some(({ address }) => isBlockedAddress(address))) {
      return callback(new FeedError('That address isn\'t on the public internet.', 400));
    }
    if (options.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
}

function request(url, accept, signal, validators) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.get(url, {
      lookup: safeLookup,
      signal,
      headers: { ...validators, 'User-Agent': USER_AGENT, Accept: accept },
      timeout: FETCH_TIMEOUT_MS,
    }, (res) => {
      const metadata = { url: url.href, etag: res.headers.etag, modified: res.headers['last-modified'] };
      if (res.statusCode === 304 && Object.keys(validators).length) {
        res.resume();
        return resolve({ ...metadata, unchanged: true });
      }
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve({ redirect: new URL(res.headers.location, url) });
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        const error = new FeedError(`The site answered HTTP ${res.statusCode}.`);
        error.retryable = [408, 429, 500, 502, 503, 504].includes(res.statusCode);
        return reject(error);
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BYTES) req.destroy(new FeedError('The response is too large to save.', 413));
        else chunks.push(chunk);
      });
      res.on('end', () => resolve({ ...metadata, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new FeedError('The site took too long to answer.')));
    req.on('error', reject);
  });
}

const feedAccept = 'application/rss+xml, application/atom+xml, application/xml, text/xml';
async function safeResponse(value, accept, previous) {
  const signal = AbortSignal.timeout(30_000);
  let url = checkFeedUrl(value);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const result = await request(url, accept, signal, url.href === previous?.url ? validatorHeaders(previous) : {});
    if (!result.redirect) return result;
    url = checkFeedUrl(result.redirect.href);
  }
  throw new FeedError('That address redirects too many times.');
}

export async function fetchSafely(value, accept = feedAccept) {
  return (await safeResponse(value, accept)).body;
}

export function createCustomFeeds({ ttlMinutes = 10, maxEntries = 300, maxFetchesPerMinute = 30 } = {}, { fetch, discover = () => {}, log = console, now = Date.now } = {}) {
  const feeds = new Map(); // url → { at, result: Promise<{ title, items }> }, oldest first
  let windowStart = 0;
  let fetchesInWindow = 0;

  async function load(url, entry) {
    const response = fetch ? { body: await fetch(url) } : await safeResponse(url, feedAccept, entry.metadata);
    if (response.unchanged) {
      entry.metadata = { ...entry.metadata, etag: response.etag ?? entry.metadata.etag,
        modified: response.modified ?? entry.metadata.modified };
      discover(entry.feed.items);
      return entry.feed;
    }
    let feed;
    try {
      feed = readFeed(response.body);
    } catch {
      throw new FeedError('That address isn\'t an RSS or Atom feed.');
    }
    discover(feed.items);
    entry.metadata = { url: response.url, etag: response.etag, modified: response.modified };
    entry.feed = {
      title: feed.title || new URL(url).hostname.replace(/^www\./, ''),
      items: feed.items.slice(0, CUSTOM_FEED_ITEMS).map((item) => ({ ...item, image: smallImage(item.image) })),
    };
    return entry.feed;
  }

  // The feed at `value`, from memory if it was fetched recently. Failures are remembered
  // for the same time, so a broken feed in someone's layout doesn't refetch on every visit.
  return async function get(value) {
    const url = checkFeedUrl(value).href;
    const cached = feeds.get(url);
    if (cached && now() - cached.at < ttlMinutes * 60_000) return cached.result;
    if (now() - windowStart > 60_000) {
      windowStart = now();
      fetchesInWindow = 0;
    }
    if (++fetchesInWindow > maxFetchesPerMinute) throw new FeedError('Too many new feeds right now. Try again in a minute.', 429);
    const entry = { at: now(), metadata: cached?.metadata, feed: cached?.feed };
    const result = load(url, entry);
    entry.result = result;
    result.catch((error) => log.warn(`Custom feed failed: ${url}: ${error.message}`));
    feeds.delete(url);
    feeds.set(url, entry);
    if (feeds.size > maxEntries) feeds.delete(feeds.keys().next().value);
    return result;
  };
}
