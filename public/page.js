// Draws the cards in the browser from /api/feeds.json: in the reader's own layout when
// they've customised it, and in place when the feeds change. The server's first render
// (the default layout) stays for anyone who hasn't customised, or without JavaScript.

import { buildCards } from './stories.js';
import { renderWidget } from './cards.js';
import { renderWeather } from './forecast.js';
import { cardList, loadSettings, saveSettings } from './settings.js';

const grid = document.querySelector('.grid');
const { tab } = document.body.dataset;
let shownVersion = document.body.dataset.version;
let feeds = null;
let settings = loadSettings(); // kept here too, in case storage is blocked

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

// This tab's cards in page order, with hidden ones included (for the Customise dialog).
export function tabCards(data = feeds) {
  const defaults = data.tabs.find((t) => t.id === tab)?.widgets ?? [];
  return cardList(settings?.tabs[tab]?.cards, defaults, Object.keys(data.widgets));
}

function drawCards() {
  if (!grid || !feeds) return;
  const layout = tabCards().filter((card) => !card.hidden);
  const html = buildCards(feeds.widgets, layout, feeds.defaultLimit).map((card) => renderWidget(card)).join('');
  grid.classList.remove('packed');
  grid.innerHTML = html;
  grid.dispatchEvent(new Event('cards:change'));
  document.documentElement.classList.remove('customised');
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

// Saves this tab's cards (null goes back to the default layout) and redraws.
export function setTabCards(cards) {
  const tabs = { ...settings?.tabs };
  if (cards) tabs[tab] = { cards };
  else delete tabs[tab];
  settings = { v: 1, tabs };
  saveSettings(settings);
  drawCards();
}

export function replaceSettings(value) {
  settings = value;
  saveSettings(settings);
  drawCards();
}

// With a customised layout, the early script in the page has already started the fetch.
if (settings?.tabs[tab]) {
  const data = await (window.startFeeds?.catch(() => null) ?? fetchFeeds());
  if (data) {
    feeds = data;
    shownVersion = data.version;
    drawCards();
  }
  document.documentElement.classList.remove('customised');
}
