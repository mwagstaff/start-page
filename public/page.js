// Draws the cards in the browser from /api/feeds.json: in the reader's own layout when
// they've customised it, and in place when the feeds change. The server's first render
// (the default layout) stays for anyone who hasn't customised, or without JavaScript.

import { buildCards } from './stories.js';
import { renderWidget } from './cards.js';
import { renderWeather } from './forecast.js';
import { cardList, customFeedId, loadSettings, saveSettings } from './settings.js';

const grid = document.querySelector('.grid');
const { tab } = document.body.dataset;
let shownVersion = document.body.dataset.version;
let feeds = null;
let settings = loadSettings(); // kept here too, in case storage is blocked
const custom = new Map(); // custom feed id → { title, items } or { error }, once loaded

export const currentVersion = () => shownVersion;
export const currentFeeds = () => feeds;
export const currentSettings = () => settings;

// `fresh` skips any cached copy, straight after the refresh button made the server refetch.
export async function fetchFeeds({ fresh = false } = {}) {
  try {
    const response = await fetch(`/api/feeds.json${fresh ? `?fresh=${Date.now()}` : ''}`, { cache: 'no-cache' });
    if (!response.ok) return null;
    feeds = await response.json();
    return feeds;
  } catch {
    return null; // offline or restarting: keep what's shown
  }
}

// A feed someone added, through this server (feeds rarely allow browsers to fetch them
// directly). The answer is cached for a few minutes by the browser and the server alike.
export async function fetchCustomFeed(url) {
  try {
    const response = await fetch(`/api/feed?url=${encodeURIComponent(url)}`);
    const body = await response.json();
    return response.ok ? body : { error: body.error ?? 'Couldn\'t load that feed.' };
  } catch {
    return { error: 'Couldn\'t reach the server.' };
  }
}

// Every card there is: the server's, then the reader's own feeds, in the snapshot's shape.
function allWidgets() {
  const widgets = { ...feeds.widgets };
  for (const feed of settings?.custom ?? []) {
    const loaded = custom.get(feed.id);
    widgets[feed.id] = {
      title: feed.title,
      link: null,
      thumbnails: true,
      limit: feeds.defaultLimit,
      maxPerSource: null,
      custom: true,
      sources: [{ name: feed.title, error: loaded?.error ?? null, items: loaded?.items ?? [] }],
    };
  }
  return widgets;
}

export const widgetFor = (id) => allWidgets()[id];

// This tab's cards in page order, with hidden ones included (for the Customise dialog).
export function tabCards() {
  const defaults = feeds.tabs.find((t) => t.id === tab)?.widgets ?? [];
  return cardList(settings?.tabs[tab]?.cards, defaults, Object.keys(allWidgets()));
}

// 'manual' once the reader has put cards in columns themselves, else 'auto' (packed to fit).
export const arrangement = () => settings?.tabs[tab]?.arrange ?? 'auto';

// The cards on screen, as the ids in each column (left to right), or null when they're in a
// single column.
export function shownColumns() {
  if (!grid?.classList.contains('packed')) return null;
  return [...grid.children].map((column) => [...column.children].filter((el) => el.matches('.card')).map((card) => card.id));
}

function drawCards() {
  if (!grid || !feeds) return;
  const layout = tabCards().filter((card) => !card.hidden);
  const html = buildCards(allWidgets(), layout, feeds.defaultLimit).map((card) => renderWidget(card)).join('');
  grid.classList.remove('packed');
  grid.innerHTML = html;
  // layout.js reads these to keep each card in the reader's column.
  const manual = arrangement() === 'manual';
  if (manual) grid.dataset.arrange = 'manual';
  else delete grid.dataset.arrange;
  for (const card of manual ? layout : []) {
    const element = document.getElementById(card.id);
    if (element && card.col !== undefined) element.dataset.col = card.col;
  }
  grid.dispatchEvent(new Event('cards:change'));
  document.documentElement.classList.remove('customised');
}

// Loads (or reloads) the reader's own feeds, then redraws if any of them changed.
export async function refreshCustomFeeds() {
  const list = settings?.custom ?? [];
  const results = await Promise.all(list.map((feed) => fetchCustomFeed(feed.url)));
  let changed = false;
  list.forEach((feed, i) => {
    const before = JSON.stringify(custom.get(feed.id) ?? null);
    if (before !== JSON.stringify(results[i])) changed = true;
    custom.set(feed.id, results[i]);
  });
  if (changed) drawCards();
}

// Shows a newer snapshot in place. A new background photo (once a day) needs a reload.
export function show(data) {
  feeds = data;
  if (data.backdrop?.url && data.backdrop.url !== document.querySelector('.backdrop')?.getAttribute('src')) {
    location.reload();
    return;
  }
  shownVersion = data.version;
  drawCards();
  // weather.js marks the page once it shows the reader's own forecast; leave that alone.
  const weather = document.querySelector('.weather');
  if (weather && data.weather && !document.body.dataset.localWeather) weather.outerHTML = renderWeather(data.weather);
}

function save(next) {
  settings = next;
  saveSettings(settings);
  drawCards();
}

// Saves this tab's cards (null goes back to the default layout) and redraws.
export function setTabCards(cards, arrange = arrangement()) {
  const tabs = { ...settings?.tabs };
  if (cards) tabs[tab] = { cards, ...(arrange === 'manual' && { arrange }) };
  else delete tabs[tab];
  save({ v: 1, custom: [], ...settings, tabs });
}

// Keeps the cards in the columns shown (see shownColumns): from now on each card stays in
// its column, and page order runs down each column in turn. Cards not on screen keep their
// settings and follow.
export function placeCards(columns) {
  const saved = new Map(tabCards().map((card) => [card.id, card]));
  const placed = columns.flatMap((ids, col) => ids.filter((id) => saved.has(id)).map((id) => ({ ...saved.get(id), col })));
  const ids = new Set(placed.map((card) => card.id));
  setTabCards([...placed, ...[...saved.values()].filter((card) => !ids.has(card.id))], 'manual');
}

// 'auto' packs the cards to fit the screen again; 'manual' keeps them where they are now.
export function setArrange(mode) {
  const columns = mode === 'manual' && shownColumns();
  if (columns) placeCards(columns);
  else if (mode === 'manual') setTabCards(tabCards(), 'manual'); // one column on screen: places come later
  else setTabCards(tabCards().map(({ col, ...card }) => card), 'auto');
}

export function replaceSettings(value) {
  save(value);
  refreshCustomFeeds();
}

// Adds a feed the reader typed in, at the top of this tab. Returns an error message, or null.
export async function addCustomFeed(url) {
  const id = customFeedId(url);
  if (settings?.custom?.some((feed) => feed.id === id)) return 'That feed is already on your page.';
  const result = await fetchCustomFeed(url);
  if (result.error) return result.error;
  custom.set(id, result);
  const cards = tabCards().filter((card) => card.id !== id);
  save({ v: 1, tabs: {}, ...settings, custom: [...(settings?.custom ?? []), { id, url, title: result.title }] });
  setTabCards([{ id }, ...cards]);
  return null;
}

export function removeCustomFeed(id) {
  const tabs = Object.fromEntries(Object.entries(settings?.tabs ?? {}).map(([name, page]) => [name, { ...page, cards: page.cards.filter((card) => card.id !== id) }]));
  custom.delete(id);
  save({ ...settings, tabs, custom: (settings?.custom ?? []).filter((feed) => feed.id !== id) });
}

// With a customised layout, the early script in the page has already started the fetch.
// Custom cards show "Loading…" until their feeds arrive.
if (settings?.tabs[tab]) {
  const data = await (window.startFeeds?.catch(() => null) ?? fetchFeeds());
  if (data) {
    feeds = data;
    shownVersion = data.version;
    drawCards();
    refreshCustomFeeds();
  }
  document.documentElement.classList.remove('customised');
}
