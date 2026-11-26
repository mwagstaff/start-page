import { homedir } from 'node:os';
import { applyProfileChange, homepageCards } from './public/homepage.js';
import { withoutPaywalls } from './public/topics.js';
import { accounts } from './lib/accounts.js';
import { mongoProfiles } from './lib/profile-store.js';
import { todaysFixtures } from './lib/football.js';
import { createSummaries, summaryState } from './lib/summaries.js';
import { createFeedReader } from './lib/feeds.js';
import { createCompanion } from './lib/companion.js';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, watch } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { createBackdrop } from './lib/backdrop.js';
import { MAX_CARD_ITEMS, createCache } from './lib/cache.js';
import { catalogueProblems, catalogueSources, publicCatalogue } from './lib/catalogue.js';
import { createCustomFeeds } from './lib/custom.js';
import { createImageFinder } from './lib/images.js';
import { notModified } from './lib/http-cache.js';
import { renderPage } from './lib/render.js';
import { createSources } from './lib/sources.js';
import { createThumbnailer } from './lib/thumbs.js';
import { createWeather, unitForLocale } from './lib/weather.js';
import { buildCards, canonicalStoryURL } from './public/stories.js';
import { companionCards, appTopicCards } from './lib/companion-cards.js';
import { defaultProfile, profileCards, profileSourceIds, profileWidgets } from './public/topics.js';

const PORT = Number(process.env.PORT ?? 3060);
const ROOT = import.meta.dirname;
const config = JSON.parse(await readFile(join(ROOT, 'config', 'feeds.json'), 'utf8'));
const catalogue = JSON.parse(await readFile(join(ROOT, 'config', 'catalogue.json'), 'utf8'));
for (const problem of catalogueProblems(catalogue, config.widgets)) console.warn(`Catalogue: ${problem}`);
// Room for the catalogue's feeds as well as the default page's.
const thumbs = createThumbnailer({ maxEntries: 3000 });
const images = createImageFinder({ maxEntries: 5000 });
const summaries = createSummaries(process.env.TAB1_DATA_DIR || join(ROOT, 'data'));
const feedCounts = { checked: 0, unchanged: 0 };
const fetchFeed = createFeedReader({ observe(status) {
  feedCounts.checked++;
  if (status === 304) feedCounts.unchanged++;
} });
setInterval(() => {
  console.info(`Feed polls in last minute: ${feedCounts.checked} successful, ${feedCounts.unchanged} HTTP 304`);
  console.info('Summary pacing totals:', JSON.stringify(summaries.counts));
  feedCounts.checked = feedCounts.unchanged = 0;
}, 60000).unref();
async function discoverFeed(url) {
  const items = await fetchFeed(url);
  summaries.discover(items);
  return items;
}
const customFeeds = createCustomFeeds({ ttlMinutes: config.refreshMinutes }, { discover: summaries.discover });
const cache = createCache(config, { fetch: discoverFeed, thumbs, images });
// Feeds also on the default page come from its cache rather than being fetched twice.
const sources = createSources(catalogueSources(catalogue), { refreshMinutes: config.refreshMinutes }, {
  fetch: discoverFeed, thumbs, images, shared: cache.source, sharedVersion: () => cache.snapshot().version,
});
sources.start();
const clientCatalogue = publicCatalogue(catalogue);
const catalogueBody = JSON.stringify(clientCatalogue);
const catalogueEtag = `"${createHash('sha256').update(catalogueBody).digest('hex').slice(0, 16)}"`;
const weather = createWeather(config.weather);
const weatherReady = weather.refresh();
setInterval(weather.refresh, (config.weather.refreshMinutes ?? 15) * 60_000).unref();
// Checked hourly, but only picks a new photo when the date changes.
const backdrop = createBackdrop(config.backdrop);
const backdropReady = backdrop.refresh();
setInterval(backdrop.refresh, 60 * 60_000).unref();

// The home page a reader sees before choosing anything: the UK's suggested topics and sources,
// built just as page.js builds them (it draws other regions' suggestions in their place).
const suggestedCards = profileCards(defaultProfile(clientCatalogue, 'uk'), clientCatalogue);
const suggestedSources = profileSourceIds(suggestedCards);
let suggested = null; // { etag, loaded } from the latest /api/sources answer for those feeds
async function suggestedPage() {
  const { body, etag } = await sources.get(suggestedSources);
  if (suggested?.etag !== etag) suggested = { etag, loaded: JSON.parse(body).sources };
  return suggested;
}
suggestedPage().catch((error) => console.warn(`Suggested page: ${error.message}`)); // fetch its feeds now

// Static files are cached by browsers, so their URLs carry a content hash.
const assetVersion = async (name) => createHash('sha256').update(await readFile(join(ROOT, 'public', name))).digest('hex').slice(0, 10);
const assetVersions = async () => {
  const names = (await readdir(join(ROOT, 'public'))).filter((name) => ['.css', '.js', '.svg', '.png'].includes(extname(name)));
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

const STATIC_TYPES = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

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

// Host-only account configuration lives outside the deployment directory.
const directory = process.env.TAB1_DATA_DIR || join(ROOT, 'data');
let accountConfig = {};
try { accountConfig = JSON.parse(await readFile(process.env.TAB1_ACCOUNT_CONFIG || join(homedir(), '.config/tab1/accounts.json'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
Object.assign(accountConfig, process.env);
const store = accountConfig.TAB1_MONGO_URI ? mongoProfiles(accountConfig.TAB1_MONGO_URI, directory) : undefined;
const unavailable = (process.env.NODE_ENV === 'production' || existsSync(join(directory, '.mongo-required')))
  ? { ready() { throw Object.assign(new Error('Account storage is unavailable'), { status: 503 }); } }
  : undefined;
const legacyCards = config.tabs.find(t => t.id === 'home').widgets;
function reconcileNativeSettings(previous, next) {
  if (!next.profile || !previous?.tabs?.home || JSON.stringify(previous.profile) === JSON.stringify(next.profile)) return next;
  if (next.tabs.home && JSON.stringify(previous.tabs.home) !== JSON.stringify(next.tabs.home)) return next;
  return applyProfileChange(previous, next, clientCatalogue, config.widgets, legacyCards);
}
const companion = createCompanion({ directory, reconcileSettings:reconcileNativeSettings, store: store ?? unavailable, account: store && accounts(store, { ...accountConfig, defaultHomepage:defaultProfile(clientCatalogue, "uk"), catalogue:clientCatalogue, widgets:config.widgets, legacy:legacyCards }), cards: async (settings, appTopics) => {
 await (cache.ready || cache.pending);
 const profile = settings?.profile || defaultProfile(clientCatalogue, 'uk');
 const definitions = profileCards(profile, clientCatalogue);
 const sharedLayout = homepageCards(settings, clientCatalogue, config.widgets, legacyCards);
 const additions = appTopicCards(profile, clientCatalogue, appTopics, sharedLayout);
 const ids = profileSourceIds([...definitions, ...additions]);
 const loaded = ids.length ? JSON.parse((await sources.get(ids, 100)).body).sources : {};
 const widgets = { ...cache.snapshot(100).widgets, ...profileWidgets([...definitions, ...additions], loaded) };
 if (profile.paywalls === false) for (const id of Object.keys(config.widgets)) widgets[id] = withoutPaywalls(widgets[id]);
 for (const card of additions) if (!card.sources && widgets[card.originalId]) widgets[card.id] = widgets[card.originalId];
 for (const feed of settings?.custom || []) {
  try { const value = await customFeeds(feed.url); widgets[feed.id] = { title: feed.title, limit: 8, sources: [{ name: feed.title, items: value.items }] }; }
  catch (e) { widgets[feed.id] = { title: feed.title, sources: [{ name: feed.title, items: [], error: e.message }] }; }
 }
 const layout = [...sharedLayout, ...additions.map(({id})=>({id}))];
 const discussions=new Map(Object.values(widgets).flatMap(widget=>widget.sources.flatMap(source=>source.items)).filter(item=>item.commentsUrl).map(item=>[canonicalStoryURL(item.link),item.commentsUrl]));
 const cards=companionCards(widgets, layout).map(card=>({...card,items:card.items.map(item=>({...item,...(!item.commentsUrl && discussions.has(canonicalStoryURL(item.link))?{commentsUrl:discussions.get(canonicalStoryURL(item.link))}:{})}))}));
 for (const card of cards) for (const item of card.items) item.summary = summaries.get(item.link, item.commentsUrl);
 return { cards, settings: {...(settings || {v:1,tabs:{},custom:[]}), ...(!settings?.profile && settings?.tabs?.home && { tabs:{...settings.tabs,home:{...settings.tabs.home,cards:sharedLayout}} }),profile}, catalogue:clientCatalogue, weather:weather.current, backdrop:backdrop.current };
}});
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const { pathname, searchParams } = url;
  if (pathname === '/auth/github/callback') {
    const result = new URLSearchParams();
    for (const field of ['state', 'code', 'error'])
      if (searchParams.has(field)) result.set(field, searchParams.get(field));
    res.writeHead(303, { Location: '/settings#github=' + result.toString(), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    return res.end();
  }
  if (pathname === '/privacy') return send(res, 200, await readFile(join(ROOT,'public','privacy.html')), 'text/html; charset=utf-8');
  if (await companion(req, res, url)) return;

  if (pathname === '/api/football.json') {
    try {
      return send(res, 200, JSON.stringify(await todaysFixtures()), 'application/json');
    } catch {
      return send(res, 503, JSON.stringify({ error: 'Fixtures unavailable' }), 'application/json');
    }
  }
  if (pathname === '/api/summary-status' && req.method === 'POST') {
    try {
      req.setEncoding('utf8');
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 262144) return send(res, 413, 'Batch too large', 'text/plain');
      }
      const stories = JSON.parse(body);
      if (!Array.isArray(stories) || stories.length > 100) throw new Error();
      const states = stories.map(([url, thread]) => summaryState(summaries.get(url, thread)));
      return send(res, 200, JSON.stringify(states), 'application/json');
    } catch {
      return send(res, 400, 'Invalid stories', 'text/plain');
    }
  }
  if (pathname === '/api/summary' && req.method === 'GET') {
    const result = summaries.get(searchParams.get('url'), searchParams.get('thread'), !searchParams.has('background'));
    res.writeHead(result ? 200 : 404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(result || { error: 'Story unavailable' }));
  }
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

  // A feed someone added in Settings, fetched (safely) and kept for a few minutes. The
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
      const { body, etag, cacheControl } = await sources.get(asked);
      if (notModified(req, res, etag, cacheControl)) return;
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

  // /settings and /settings/topics-and-sources are the home page with Settings or the setup
  // bar open (settings-screen.js, setup-bar.js).
  const tabId = ['/', '/settings', '/settings/topics-and-sources'].includes(pathname) ? 'home' : pathname.slice(1);
  const tab = config.tabs.find((t) => t.id === tabId);
  if (!tab) return send(res, 404, 'Not found', 'text/plain');

  // Straight after a restart, wait for the first refresh rather than showing empty cards.
  // The weather and photo load separately, so wait for those too (instant once loaded).
  await Promise.all([cache.ready || cache.pending, weatherReady, backdropReady]);
  const { version } = feedsData();
  const home = tab.id === 'home' ? await suggestedPage() : null;
  // The page shows the date and links hashed assets, so those are part of its ETag too.
  const today = new Date().toLocaleDateString('en-GB', { timeZone: 'Europe/London' });
  // Temperatures in the unit of the browser's language, as the browser itself would choose
  // (forecast.js); one saved in Settings is put right in the browser.
  const unit = unitForLocale(req.headers['accept-language']?.split(/[,;]/)[0].trim());
  res.setHeader('Vary', 'Accept-Language');
  let widgets;
  if (home) {
    const snapshot = cache.snapshot();
    const all = { ...snapshot.widgets, ...profileWidgets(suggestedCards, home.loaded) };
    widgets = buildCards(all, suggestedCards.map(({ id }) => ({ id })), snapshot.defaultLimit, MAX_CARD_ITEMS);
  } else {
    widgets = tab.widgets.map((id) => cache.widget(id));
  }
  widgets = widgets.map(widget => ({ ...widget, items: widget.items.map(item => ({
    ...item, summaryState: summaryState(summaries.get(item.link, item.commentsUrl)),
  })) }));
  const etag = `"${createHash('sha256').update(JSON.stringify([tab.id, version, home?.etag, today, versions, unit, widgets.map(w => w.items.map(i => i.summaryState))])).digest('hex').slice(0, 16)}"`;
  if (notModified(req, res, etag, 'no-cache')) return;
  const html = renderPage({ tabs: config.tabs, activeTab: tab, versions, version, weather: weather.current, backdrop: backdrop.current, widgets, unit });
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});

cache.start();
server.listen(PORT, () => console.log(`tab1.net listening on http://localhost:${PORT}`));
