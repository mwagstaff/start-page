import { USER_AGENT, fetchFeed } from './feeds.js';

const FETCH_TIMEOUT_MS = 10_000;
const BING = 'https://www.bing.com';
// ESA's feeds link 1280px "screen" images; most also have a 1920×1200 "wallpaper4" copy.
const ESA_SCREEN = /^(https:\/\/cdn\.esa\w+\.org\/archives\/images\/)screen\//;

export function londonDay(now = Date.now()) {
  return new Date(now).toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
}

// Bing's homepage archive keeps about two weeks of photos, at most 8 per request.
export function bingArchiveUrls(market = 'en-GB') {
  return [0, 7].map((idx) => `${BING}/HPImageArchive.aspx?format=js&idx=${idx}&n=8&mkt=${encodeURIComponent(market)}`);
}

export function parseBing(json) {
  return (json?.images ?? [])
    .filter((image) => image.urlbase)
    .map((image) => ({
      url: `${BING}${image.urlbase}_1920x1080.jpg`,
      title: image.title || image.copyright,
      credit: image.copyright,
      link: image.copyrightlink,
    }));
}

function feedImages(items, sourceName) {
  return items
    .filter((item) => item.image)
    .map((item) => ({ url: item.image, title: item.title, credit: sourceName, link: item.link }));
}

// Small seeded generator (mulberry32), so the same day always gives the same picture.
function seededRandom(seed) {
  let state = 2166136261;
  for (const char of seed) state = Math.imul(state ^ char.charCodeAt(0), 16777619);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Picks a source by weight, then a photo from it, skipping the photo shown last time.
export function pickBackdrop(pools, day, avoidUrl = null) {
  const random = seededRandom(day);
  const fresh = pools
    .map((pool) => ({ ...pool, images: pool.images.filter((image) => image.url !== avoidUrl) }))
    .filter((pool) => pool.images.length);
  const candidates = fresh.length ? fresh : pools.filter((pool) => pool.images.length);
  if (!candidates.length) return null;
  const total = candidates.reduce((sum, pool) => sum + (pool.weight ?? 1), 0);
  let roll = random() * total;
  const pool = candidates.find((p) => (roll -= p.weight ?? 1) < 0) ?? candidates.at(-1);
  return pool.images[Math.floor(random() * pool.images.length)];
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function urlExists(url) {
  try {
    const response = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    return response.ok;
  } catch {
    return false;
  }
}

export function createBackdrop(config, { json = fetchJson, feed = fetchFeed, exists = urlExists, log = console, now = Date.now } = {}) {
  let current = null;
  let day = null;

  async function loadSource(source) {
    if (source.type === 'bing') {
      const pages = await Promise.all(bingArchiveUrls(source.market).map(json));
      const images = pages.flatMap(parseBing);
      return images.filter((image, i) => images.findIndex((other) => other.url === image.url) === i);
    }
    return feedImages(await feed(source.url), source.name);
  }

  async function sharpen(image) {
    const match = image.url.match(ESA_SCREEN);
    if (!match) return image;
    const wallpaper = image.url.replace(ESA_SCREEN, `${match[1]}wallpaper4/`);
    return (await exists(wallpaper)) ? { ...image, url: wallpaper } : image;
  }

  // Cheap to call often: it only fetches when the day has changed (or the last try failed).
  async function refresh() {
    const today = londonDay(now());
    if (day === today) return;
    const pools = await Promise.all(config.sources.map(async (source) => {
      try {
        return { weight: source.weight ?? 1, images: await loadSource(source) };
      } catch (error) {
        log.warn(`Backdrop source ${source.name ?? source.type} failed: ${error.message}`);
        return { weight: source.weight ?? 1, images: [] };
      }
    }));
    const image = pickBackdrop(pools, today, current?.url);
    if (!image) return; // keep the previous photo and try again on the next tick
    current = await sharpen(image);
    day = today;
  }

  return {
    refresh,
    get current() {
      return current;
    },
  };
}
