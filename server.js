import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { watch } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { createBackdrop } from './lib/backdrop.js';
import { createCache } from './lib/cache.js';
import { catalogueProblems, catalogueSources, publicCatalogue } from './lib/catalogue.js';
import { createCustomFeeds } from './lib/custom.js';
import { createImageFinder } from './lib/images.js';
import { renderPage } from './lib/render.js';
import { createSources } from './lib/sources.js';
import { createThumbnailer } from './lib/thumbs.js';
import { createWeather } from './lib/weather.js';

const PORT = Number(process.env.PORT ?? 3060);
const ROOT = import.meta.dirname;
const config = JSON.parse(await readFile(join(ROOT, 'config', 'feeds.json'), 'utf8'));
const catalogue = JSON.parse(await readFile(join(ROOT, 'config', 'catalogue.json'), 'utf8'));
for (const problem of catalogueProblems(catalogue, config.widgets)) console.warn(`Catalogue: ${problem}`);
// Room for the catalogue's feeds as well as the default page's.
const thumbs = createThumbnailer({ maxEntries: 3000 });
const images = createImageFinder({ maxEntries: 5000 });
const customFeeds = createCustomFeeds({ ttlMinutes: config.refreshMinutes });
const cache = createCache(config, { thumbs, images });
// Feeds also on the default page come from its cache rather than being fetched twice.
const sources = createSources(catalogueSources(catalogue), { refreshMinutes: config.refreshMinutes }, {
  thumbs, images, shared: cache.source, sharedVersion: () => cache.snapshot().version,
});
sources.start();
const catalogueBody = JSON.stringify(publicCatalogue(catalogue));
const catalogueEtag = `"${createHash('sha256').update(catalogueBody).digest('hex').slice(0, 16)}"`;
const weather = createWeather(config.weather);
const weatherReady = weather.refresh();
setInterval(weather.refresh, (config.weather.refreshMinutes ?? 15) * 60_000).unref();
// Checked hourly, but only picks a new photo when the date changes.
const backdrop = createBackdrop(config.backdrop);
const backdropReady = backdrop.refresh();
setInterval(backdrop.refresh, 60 * 60_000).unref();

// Static files are cached by browsers, so their URLs carry a content hash.
const assetVersion = async (name) => createHash('sha256').update(await readFile(join(ROOT, 'public', name))).digest('hex').slice(0, 10);
const assetVersions = async () => {
  const names = (await readdir(join(ROOT, 'public'))).filter((name) => ['.css', '.js'].includes(extname(name)));
  return Object.fromEntries(await Promise.all(names.map(async (name) => [name, await assetVersion(name)])));
};
// Worked out again whenever a file in public/ changes, so pages never point at old copies.
let versions = await assetVersions();
watch(join(ROOT, 'public'), () => {
  assetVersions().then((latest) => { versions = latest; }, () => {});
}).unref();

// Manual refreshes come from a public page, so at most one a minute reaches the feeds.
const MANUAL_REFRESH_GAP_MS = 60_000;
let lastManualRefresh = 0;

// Everything the browser needs to draw any layout, as served at /api/feeds.json. It only
// changes when a refresh brings something new, so its version doubles as an ETag.
let feeds = null;
function feedsData() {
  const snapshot = cache.snapshot();
  const { current: weatherNow } = weather;
  const { current: photo } = backdrop;
  if (feeds?.snapshot !== snapshot || feeds.weather !== weatherNow || feeds.backdrop !== photo) {
    const data = { tabs: config.tabs, defaultLimit: snapshot.defaultLimit, weather: weatherNow, backdrop: photo, widgets: snapshot.widgets };
    const version = createHash('sha256').update(JSON.stringify([snapshot.version, weatherNow, photo])).digest('hex').slice(0, 16);
    feeds = { snapshot, weather: weatherNow, backdrop: photo, version, body: JSON.stringify({ version, ...data }) };
  }
  return feeds;
}

// Answers a conditional request with 304 when the browser (or Cloudflare) already has this version.
function notModified(req, res, etag, cacheControl) {
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', cacheControl);
  if (req.headers['if-none-match'] !== etag) return false;
  res.writeHead(304);
  res.end();
  return true;
}

const STATIC_TYPES = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

function send(res, status, body, type) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  res.end(body);
}

async function serveStatic(res, name) {
  const type = STATIC_TYPES[extname(name)];
  if (!type || name.includes('..') || name.includes('/')) return send(res, 404, 'Not found', 'text/plain');
  try {
    const body = await readFile(join(ROOT, 'public', name));
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=3600' });
    res.end(body);
  } catch {
    send(res, 404, 'Not found', 'text/plain');
  }
}

const server = createServer(async (req, res) => {
  const { pathname, searchParams } = new URL(req.url, 'http://localhost');

  if (pathname === '/healthcheck') {
    const body = { status: cache.ready ? 'ok' : 'starting', lastRefresh: cache.lastRefresh };
    return send(res, cache.ready ? 200 : 503, JSON.stringify(body), 'application/json');
  }
  if (pathname.startsWith('/static/')) return serveStatic(res, pathname.slice('/static/'.length));

  const thumb = pathname.match(/^\/thumb\/([0-9a-f]{20})\.webp$/);
  if (thumb) {
    const image = await thumbs.get(thumb[1]);
    if (!image) return send(res, 404, 'Not found', 'text/plain');
    // The id is a hash of the source URL, so a given thumbnail never changes.
    res.writeHead(200, { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=604800, immutable' });
    return res.end(image);
  }

  if (pathname === '/api/widgets') {
    const widgets = Object.keys(config.widgets).map((id) => cache.widget(id));
    return send(res, 200, JSON.stringify({ lastRefresh: cache.lastRefresh, weather: weather.current, backdrop: backdrop.current, widgets }), 'application/json');
  }

  // Pages fetch this to draw customised layouts and to update themselves in place. Shared by
  // every reader, so Cloudflare can serve it for a minute and then check back with the ETag.
  if (pathname === '/api/feeds.json') {
    await (cache.ready || cache.pending);
    const { version, body } = feedsData();
    if (notModified(req, res, `"${version}"`, 'public, max-age=60, stale-while-revalidate=600')) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(body);
  }

  // A feed someone added in Customise, fetched (safely) and kept for a few minutes. The
  // browser draws its card; the same feed is shared by everyone who adds it.
  if (pathname === '/api/feed') {
    try {
      const feed = await customFeeds(searchParams.get('url'));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${(config.refreshMinutes ?? 10) * 60}` });
      return res.end(JSON.stringify(feed));
    } catch (error) {
      const status = error.status ?? 502;
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ error: error.status ? error.message : 'Couldn\'t load that feed.' }));
    }
  }

  // The outlets and topics readers choose from when setting up their page.
  if (pathname === '/api/catalogue.json') {
    if (notModified(req, res, catalogueEtag, 'public, max-age=3600')) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(catalogueBody);
  }

  // Catalogue feeds by id (`?ids=bbc.politics,guardian.politics`), for the topic and outlet
  // cards a reader chose. Ids are sorted so pages asking for the same feeds share a cached
  // copy; any other order is redirected to that one.
  if (pathname === '/api/sources') {
    const asked = (searchParams.get('ids') ?? '').split(',');
    try {
      const ids = sources.canonical(asked).join(',');
      if (ids !== asked.join(',')) {
        res.writeHead(301, { Location: `/api/sources?ids=${ids}`, 'Cache-Control': 'public, max-age=86400' });
        return res.end();
      }
      await (cache.ready || cache.pending);
      const { body, etag } = await sources.get(asked);
      if (notModified(req, res, etag, 'public, max-age=60, stale-while-revalidate=600')) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(body);
    } catch (error) {
      res.writeHead(error.status ?? 500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ error: error.status ? error.message : 'Couldn\'t load those sources.' }));
    }
  }

  if (pathname === '/api/refresh' && req.method === 'POST') {
    const wait = lastManualRefresh + MANUAL_REFRESH_GAP_MS - Date.now();
    if (wait > 0) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(Math.ceil(wait / 1000)) });
      return res.end(JSON.stringify({ lastRefresh: cache.lastRefresh }));
    }
    lastManualRefresh = Date.now();
    await Promise.all([cache.refresh(), weather.refresh()]);
    return send(res, 200, JSON.stringify({ lastRefresh: cache.lastRefresh }), 'application/json');
  }

  const tabId = pathname === '/' ? 'home' : pathname.slice(1);
  const tab = config.tabs.find((t) => t.id === tabId);
  if (!tab) return send(res, 404, 'Not found', 'text/plain');

  // Straight after a restart, wait for the first refresh rather than showing empty cards.
  // The weather and photo load separately, so wait for those too (instant once loaded).
  await Promise.all([cache.ready || cache.pending, weatherReady, backdropReady]);
  const { version } = feedsData();
  // The page shows the date and links hashed assets, so those are part of its ETag too.
  const today = new Date().toLocaleDateString('en-GB', { timeZone: 'Europe/London' });
  const etag = `"${createHash('sha256').update(JSON.stringify([tab.id, version, today, versions])).digest('hex').slice(0, 16)}"`;
  if (notModified(req, res, etag, 'no-cache')) return;
  const widgets = tab.widgets.map((id) => cache.widget(id));
  const html = renderPage({ tabs: config.tabs, activeTab: tab, versions, version, weather: weather.current, backdrop: backdrop.current, widgets });
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});

cache.start();
server.listen(PORT, () => console.log(`start-page listening on http://localhost:${PORT}`));
