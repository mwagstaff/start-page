// Draws the cards in the browser from /api/feeds.json: in the reader's own layout when
// they've customised it, and in place when the feeds change. The server's first render
// (the default layout) stays for anyone who hasn't customised, or without JavaScript.
// Cards from the setup screen's choices (topics.js) are filled from /api/sources.
// Every change to the settings is recorded (history.js), so it can be undone.

import { buildCards } from './stories.js';
import { renderWidget } from './cards.js';
import { renderWeather } from './forecast.js';
import { canRedo, canUndo, describeChange, loadHistory, moveTo, recordChange, saveHistory } from './history.js';
import { cardList, customFeedId, loadSettings, saveSettings } from './settings.js';
import { layoutForProfile, profileCards, profileSourceIds, profileWidgets } from './topics.js';

const grid = document.querySelector('.grid');
const { tab } = document.body.dataset;
let shownVersion = document.body.dataset.version;
let feeds = null;
let settings = loadSettings(); // kept here too, in case storage is blocked
const custom = new Map(); // custom feed id → { title, items } or { error }, once loaded
let catalogue = null; // /api/catalogue.json, once a profile needs it
let profileLoaded = {}; // catalogue feed id → { name, error, items }, from /api/sources
let history = loadHistory(); // kept here too, in case storage is blocked
let pending = null; // a change not yet in the history: { before, beforeCards, label }

export const currentVersion = () => shownVersion;
export const currentFeeds = () => feeds;
export const currentSettings = () => settings;
export const currentCatalogue = () => catalogue;

// The outlets and topics to choose from. The early script starts this fetch for readers
// with a profile, so their cards don't wait for it.
export async function fetchCatalogue() {
  if (catalogue) return catalogue;
  try {
    catalogue = await (window.startCatalogue?.catch(() => null) ?? fetch('/api/catalogue.json').then((response) => (response.ok ? response.json() : null)));
  } catch {
    catalogue = null;
  }
  window.startCatalogue = null;
  return catalogue;
}

// The cards the reader's profile makes (none until the catalogue has loaded).
const currentProfileCards = () => (settings?.profile && catalogue ? profileCards(settings.profile, catalogue) : []);

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

// Every card there is: the server's, the ones the reader's profile makes, then the reader's
// own feeds, in the snapshot's shape.
function allWidgets() {
  const widgets = { ...feeds.widgets, ...profileWidgets(currentProfileCards(), profileLoaded) };
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
  // "Compact" on the setup screen: no pictures on any card.
  if (settings?.profile?.pictures === false) {
    for (const [id, widget] of Object.entries(widgets)) widgets[id] = { ...widget, thumbnails: false };
  }
  return widgets;
}

export const widgetFor = (id) => allWidgets()[id];

// This tab's cards in page order, with hidden ones included (for the Customise dialog).
export function tabCards(from = settings) {
  const defaults = feeds.tabs.find((t) => t.id === tab)?.widgets ?? [];
  return cardList(from?.tabs[tab]?.cards, defaults, Object.keys(allWidgets()));
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

// Loads (or reloads) the catalogue feeds the reader's profile uses, then redraws if any
// changed. The browser revalidates its copy, so this is usually a 304.
export async function refreshProfileFeeds() {
  const ids = profileSourceIds(currentProfileCards());
  if (!ids.length) return;
  let loaded;
  try {
    const response = await fetch(`/api/sources?ids=${ids.join(',')}`, { cache: 'no-cache' });
    if (!response.ok) return;
    loaded = (await response.json()).sources;
  } catch {
    return; // offline or restarting: keep what's shown
  }
  if (JSON.stringify(loaded) === JSON.stringify(profileLoaded)) return;
  profileLoaded = loaded;
  drawCards();
}

// The weather and photo can be turned off on the setup screen. The early script in the page
// sets the same classes before it paints; this keeps them in step after a change.
function applyPageOptions() {
  const { profile } = settings ?? {};
  const root = document.documentElement;
  root.classList.toggle('no-weather', profile?.weather === false);
  root.classList.toggle('no-backdrop', profile?.backdrop === false);
  document.body.classList.toggle('has-backdrop', profile?.backdrop !== false && Boolean(document.querySelector('.backdrop')));
}

// Saves the setup screen's choices and rebuilds the cards from them: cards already on the
// page keep their place, new ones go after them, and ones no longer wanted are hidden.
export async function setProfile(profile) {
  await Promise.all([fetchCatalogue(), feeds || fetchFeeds()]);
  record('Changed topics & sources');
  const next = { v: 1, tabs: {}, custom: [], ...settings, profile, onboarded: true };
  settings = next;
  const allIds = Object.keys(allWidgets());
  const cards = layoutForProfile(settings.tabs[tab]?.cards, currentProfileCards(), allIds, (id) => widgetFor(id)?.custom);
  settings = { ...next, tabs: { ...next.tabs, [tab]: { ...next.tabs[tab], cards } } };
  saveSettings(settings);
  applyPageOptions();
  drawCards();
  await refreshProfileFeeds();
}

// Remembers that the reader has seen the setup screen, without changing their page.
export function skipSetup() {
  settings = { v: 1, tabs: {}, custom: [], ...settings, onboarded: true };
  saveSettings(settings);
}

// Shows a newer snapshot in place. A new background photo (once a day) needs a reload.
export function show(data) {
  feeds = data;
  if (settings?.profile?.backdrop !== false && data.backdrop?.url && data.backdrop.url !== document.querySelector('.backdrop')?.getAttribute('src')) {
    location.reload();
    return;
  }
  shownVersion = data.version;
  drawCards();
  // weather.js marks the page once it shows the reader's own forecast; leave that alone.
  const weather = document.querySelector('.weather');
  if (weather && data.weather && !document.body.dataset.localWeather) weather.outerHTML = renderWeather(data.weather);
}

// Notes the settings as they are before a change. Changes made together (adding a feed
// saves twice) become one step in the history, recorded once they're all done.
function record(label) {
  if (!pending) {
    pending = { before: settings, beforeCards: feeds ? tabCards() : [], label };
    queueMicrotask(commitHistory);
  }
  pending.label ??= label;
}

function commitHistory() {
  const { before, beforeCards, label } = pending;
  pending = null;
  if (JSON.stringify(before ?? null) === JSON.stringify(settings ?? null)) return;
  const description = label ?? describeChange({ before, after: settings, beforeCards, afterCards: feeds ? tabCards() : [], titleFor: (id) => widgetFor(id)?.title });
  history = recordChange(loadHistory() ?? history, before, settings, description, Date.now());
  saveHistory(history);
  announce('change', description);
}

// Tells the page (the undo message, the History and Customise dialogs) what happened.
function announce(type, label) {
  document.dispatchEvent(new CustomEvent('history:change', { detail: { type, label } }));
}

function save(next, label) {
  record(label);
  settings = next;
  saveSettings(settings);
  drawCards();
}

// Saves this tab's cards (null goes back to the default layout) and redraws. `label` names
// the change in the history, when it can say more than the settings show.
export function setTabCards(cards, arrange = arrangement(), label = undefined) {
  const tabs = { ...settings?.tabs };
  if (cards) tabs[tab] = { cards, ...(arrange === 'manual' && { arrange }) };
  else delete tabs[tab];
  save({ v: 1, custom: [], ...settings, tabs }, label);
}

// Keeps the cards in the columns shown (see shownColumns): from now on each card stays in
// its column, and page order runs down each column in turn. Cards not on screen keep their
// settings and follow.
export function placeCards(columns, label) {
  const saved = new Map(tabCards().map((card) => [card.id, card]));
  const placed = columns.flatMap((ids, col) => ids.filter((id) => saved.has(id)).map((id) => ({ ...saved.get(id), col })));
  const ids = new Set(placed.map((card) => card.id));
  setTabCards([...placed, ...[...saved.values()].filter((card) => !ids.has(card.id))], 'manual', label);
}

// 'auto' packs the cards to fit the screen again; 'manual' keeps them where they are now.
export function setArrange(mode) {
  const columns = mode === 'manual' && shownColumns();
  if (columns) placeCards(columns);
  else if (mode === 'manual') setTabCards(tabCards(), 'manual'); // one column on screen: places come later
  else setTabCards(tabCards().map(({ col, ...card }) => card), 'auto');
}

export async function replaceSettings(value, label) {
  if (value?.profile) await fetchCatalogue();
  save(value, label);
  applyPageOptions();
  refreshCustomFeeds();
  refreshProfileFeeds();
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

// Takes a card off the page. It stays in Customise, unticked, to bring back.
export async function hideCard(id) {
  if (!feeds && !(await fetchFeeds())) return;
  setTabCards(tabCards().map((card) => (card.id === id ? { ...card, hidden: true } : card)));
}

export const currentHistory = () => history;

// Puts the page back as it was at a point in the history, without recording a change.
// Having seen the setup screen stays remembered, so going back doesn't offer it again.
async function goTo(index, type) {
  history = loadHistory() ?? history;
  if (!history || index === history.index || index < 0 || index >= history.entries.length) return false;
  if (!feeds && !(await fetchFeeds())) return false;
  // Undo names the change it takes back; redo and rewind, the one they go to.
  const label = type === 'undo' ? history.entries[history.index].label : history.entries[index].label;
  history = moveTo(history, index);
  saveHistory(history);
  const target = history.entries[index].settings;
  const onboarded = settings?.onboarded || target?.onboarded;
  const value = target ? { ...target, ...(onboarded && { onboarded: true }) } : onboarded ? { v: 1, tabs: {}, custom: [], onboarded: true } : null;
  if (value?.profile) await fetchCatalogue();
  settings = value;
  saveSettings(settings);
  drawCards();
  applyPageOptions();
  refreshCustomFeeds();
  refreshProfileFeeds();
  announce(type, label);
  return true;
}

export const undo = () => (canUndo(history) ? goTo(history.index - 1, 'undo') : Promise.resolve(false));
export const redo = () => (canRedo(history) ? goTo(history.index + 1, 'redo') : Promise.resolve(false));
export const rewindTo = (index) => goTo(index, 'rewind');

// Forgets every change, keeping the page as it is now.
export function clearHistory() {
  history = null;
  saveHistory(null);
  announce('clear');
}

export function removeCustomFeed(id) {
  const tabs = Object.fromEntries(Object.entries(settings?.tabs ?? {}).map(([name, page]) => [name, { ...page, cards: page.cards.filter((card) => card.id !== id) }]));
  custom.delete(id);
  save({ ...settings, tabs, custom: (settings?.custom ?? []).filter((feed) => feed.id !== id) });
}

// With a customised layout, the early script in the page has already started the fetch.
// Custom cards show "Loading…" until their feeds arrive.
applyPageOptions();
if (settings?.tabs[tab]) {
  const [data] = await Promise.all([window.startFeeds?.catch(() => null) ?? fetchFeeds(), settings.profile && fetchCatalogue()]);
  if (data) {
    feeds = data;
    shownVersion = data.version;
    drawCards();
    refreshCustomFeeds();
    refreshProfileFeeds();
  }
  document.documentElement.classList.remove('customised');
}
