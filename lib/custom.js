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
export const CUSTOM_FEED_ITEMS = 20;

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

function request(url) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.get(url, {
      lookup: safeLookup,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' },
      timeout: FETCH_TIMEOUT_MS,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve({ redirect: new URL(res.headers.location, url) });
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new FeedError(`The site answered HTTP ${res.statusCode}.`));
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BYTES) req.destroy(new FeedError('That feed is too large.'));
        else chunks.push(chunk);
      });
      res.on('end', () => resolve({ body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new FeedError('The site took too long to answer.')));
    req.on('error', reject);
  });
}

export async function fetchSafely(value) {
  let url = checkFeedUrl(value);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const result = await request(url);
    if (!result.redirect) return result.body;
    url = checkFeedUrl(result.redirect.href);
  }
  throw new FeedError('That address redirects too many times.');
}

export function createCustomFeeds({ ttlMinutes = 10, maxEntries = 300, maxFetchesPerMinute = 30 } = {}, { fetch = fetchSafely, log = console, now = Date.now } = {}) {
  const feeds = new Map(); // url → { at, result: Promise<{ title, items }> }, oldest first
  let windowStart = 0;
  let fetchesInWindow = 0;

  function load(url) {
    if (now() - windowStart > 60_000) {
      windowStart = now();
      fetchesInWindow = 0;
    }
    if (++fetchesInWindow > maxFetchesPerMinute) throw new FeedError('Too many new feeds right now. Try again in a minute.', 429);
    return fetch(url).then((xml) => {
      let feed;
      try {
        feed = readFeed(xml);
      } catch {
        throw new FeedError('That address isn\'t an RSS or Atom feed.');
      }
      return {
        title: feed.title || new URL(url).hostname.replace(/^www\./, ''),
        items: feed.items.slice(0, CUSTOM_FEED_ITEMS).map((item) => ({ ...item, image: smallImage(item.image) })),
      };
    });
  }

  // The feed at `value`, from memory if it was fetched recently. Failures are remembered
  // for the same time, so a broken feed in someone's layout doesn't refetch on every visit.
  return async function get(value) {
    const url = checkFeedUrl(value).href;
    const cached = feeds.get(url);
    if (cached && now() - cached.at < ttlMinutes * 60_000) return cached.result;
    const result = load(url);
    result.catch((error) => log.warn(`Custom feed failed: ${url}: ${error.message}`));
    feeds.delete(url);
    feeds.set(url, { at: now(), result });
    if (feeds.size > maxEntries) feeds.delete(feeds.keys().next().value);
    return result;
  };
}
