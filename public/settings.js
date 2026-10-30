// The reader's own layout, kept in this browser's localStorage (no account needed) and
// exported or imported as a JSON file. Shape:
//   { v: 1, tabs: { home: { cards: [...] } }, custom: [...] }
// where cards are in page order, { id, hidden?: true, limit?: number }, and custom lists
// the feeds the reader added, { id: 'custom-…', url, title }.

export const SETTINGS_KEY = 'start-page:settings'; // the early script in lib/render.js reads it too
export const MAX_CARD_ITEMS = 15; // keep in step with lib/cache.js
export const MAX_CUSTOM_FEEDS = 20;
const MAX_TITLE_LENGTH = 80;

// A short, stable id for a feed address, so the same feed added twice is one card.
export function customFeedId(url) {
  let hash = 5381;
  for (const char of url) hash = (Math.imul(hash, 33) ^ char.codePointAt(0)) >>> 0;
  return `custom-${hash.toString(36)}`;
}

// The site's name for an http(s) address, or null for anything else.
export function hostOf(url) {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'http:' || protocol === 'https:' ? hostname.replace(/^www\./, '') : null;
  } catch {
    return null;
  }
}

// Settings come from storage or from a file someone picked, so keep only what makes sense.
export function validSettings(value) {
  if (value?.v !== 1 || typeof value.tabs !== 'object' || value.tabs === null) return null;
  const tabs = {};
  for (const [tab, page] of Object.entries(value.tabs)) {
    if (!Array.isArray(page?.cards)) continue;
    const ids = new Set();
    tabs[tab] = {
      cards: page.cards
        .filter((card) => typeof card?.id === 'string' && !ids.has(card.id) && ids.add(card.id))
        .map((card) => ({
          id: card.id,
          ...(card.hidden === true && { hidden: true }),
          ...(Number.isInteger(card.limit) && card.limit >= 1 && card.limit <= MAX_CARD_ITEMS && { limit: card.limit }),
        })),
    };
  }
  const ids = new Set();
  const custom = (Array.isArray(value.custom) ? value.custom : [])
    .filter((feed) => typeof feed?.url === 'string' && feed.url.length <= 2000 && hostOf(feed.url))
    .map((feed) => ({ id: customFeedId(feed.url), url: feed.url, title: String(feed.title ?? '').trim().slice(0, MAX_TITLE_LENGTH) || hostOf(feed.url) }))
    .filter((feed) => !ids.has(feed.id) && ids.add(feed.id))
    .slice(0, MAX_CUSTOM_FEEDS);
  return { v: 1, tabs, custom };
}

// Every card for a tab, in page order: the reader's saved order first, then any of the
// tab's default cards they haven't seen yet (new in the config), then every other card,
// hidden, so it can be added.
export function cardList(saved, defaults, allIds) {
  const known = new Set(allIds);
  const list = (saved ?? []).filter((card) => known.has(card.id)).map((card) => ({ ...card }));
  const listed = new Set(list.map((card) => card.id));
  for (const id of defaults) {
    if (known.has(id) && !listed.has(id)) list.push({ id });
    listed.add(id);
  }
  for (const id of allIds) if (!listed.has(id)) list.push({ id, hidden: true });
  return list;
}

export function loadSettings() {
  try {
    return validSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY)));
  } catch {
    return null;
  }
}

export function saveSettings(settings) {
  try {
    if (settings && Object.keys(settings.tabs).length) localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    else localStorage.removeItem(SETTINGS_KEY);
  } catch {
    // Storage blocked (private window, site data off): the change lasts until the page reloads.
  }
}
