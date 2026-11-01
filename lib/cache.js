import { createHash } from 'node:crypto';
import { fetchFeed } from './feeds.js';
import { createImageFinder, smallImage } from './images.js';
import { DEFAULT_LIMIT, buildCards } from '../public/stories.js';

export { DEFAULT_LIMIT, mergeItems, storyKeys } from '../public/stories.js';

// The snapshot sends more of each feed than a card shows, so a card can still fill up
// after the browser drops stories shown in an earlier card, or after someone raises its
// number of items (up to MAX_CARD_ITEMS).
export const MAX_CARD_ITEMS = 15;
const SPARE_ITEMS = 6;

function itemsPerSource(widget, defaultLimit) {
  const limit = widget.limit ?? defaultLimit;
  const perSource = widget.sources.length > 1 ? widget.maxPerSource ?? limit : Math.max(limit, MAX_CARD_ITEMS);
  return perSource + SPARE_ITEMS;
}

// Cards claim stories in page order (tabs first, then any others), so a story
// in several cards only shows in the first of them.
function widgetOrder(config) {
  return [...new Set([...(config.tabs ?? []).flatMap((tab) => tab.widgets), ...Object.keys(config.widgets)])];
}

export function createCache(config, { fetch = fetchFeed, images = createImageFinder(), thumbs = null, log = console } = {}) {
  const defaultLimit = config.defaultLimit ?? DEFAULT_LIMIT;
  // Last good result per source URL, kept when a later fetch fails.
  const sources = new Map();
  let lastRefresh = null;
  let refreshing = null;

  async function refreshSource(source) {
    const previous = sources.get(source.url);
    try {
      const items = await fetch(source.url);
      sources.set(source.url, { items, fetchedAt: new Date().toISOString(), error: null });
    } catch (error) {
      log.warn(`Feed failed: ${source.url}: ${error.message}`);
      sources.set(source.url, { items: previous?.items ?? [], fetchedAt: previous?.fetchedAt ?? null, error: error.message });
    }
  }

  function refresh() {
    refreshing ??= (async () => {
      const urls = new Map();
      for (const widget of Object.values(config.widgets)) {
        for (const source of widget.sources) urls.set(source.url, source);
      }
      await Promise.all([...urls.values()].map(refreshSource));
      lastRefresh = new Date().toISOString();
      current = null;
      preparedImages = prepareImages().then(() => {
        current = null;
      });
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  // Every item the snapshot sends for cards with thumbnails: any of them may be shown.
  function shownItems() {
    return Object.entries(config.widgets).filter(([, definition]) => definition.thumbnails)
      .flatMap(([id, definition]) => results(id).flatMap((result) => result.items.slice(0, itemsPerSource(definition, defaultLimit))));
  }

  const originalImage = (item) => smallImage(item.image ?? images.get(item.link) ?? null);

  // For cards with thumbnails, look up a preview image for shown items whose feed had none,
  // then make their thumbnails. It runs in the background: new images appear from the next
  // page load on, and images that can't be fetched never show up as broken.
  let preparedImages = Promise.resolve();
  async function prepareImages() {
    await Promise.all(shownItems().filter((item) => !item.image && images.get(item.link) === undefined).map((item) => images.find(item.link)));
    if (thumbs) await Promise.all(shownItems().map((item) => thumbs.warm(originalImage(item))));
  }

  // With a thumbnailer the page gets a small copy served from here instead of the original.
  function withThumbnail(item) {
    const image = originalImage(item);
    return { ...item, image: thumbs && image ? thumbs.path(image) : image };
  }

  function results(id) {
    return config.widgets[id].sources.map((source) => ({ name: source.name, ...(sources.get(source.url) ?? { items: [], fetchedAt: null, error: null }) }));
  }

  // What the browser needs to build any layout: every card's settings and the top of each
  // of its feeds, with thumbnail paths. Made once per refresh (thumbnails are only known
  // once prepared, so it's made again when they are), with a version for ETags.
  let current = null;
  function snapshot() {
    if (current) return current;
    const widgets = Object.fromEntries(Object.entries(config.widgets).map(([id, definition]) => {
      const perSource = itemsPerSource(definition, defaultLimit);
      return [id, {
        title: definition.title,
        link: definition.link ?? null,
        thumbnails: Boolean(definition.thumbnails),
        limit: definition.limit ?? defaultLimit,
        maxPerSource: definition.maxPerSource ?? null,
        sources: results(id).map((result) => ({
          name: result.name,
          error: result.error,
          items: result.items.slice(0, perSource).map((item) => (definition.thumbnails ? withThumbnail(item) : item)),
        })),
      }];
    }));
    const version = createHash('sha256').update(JSON.stringify(widgets)).digest('hex').slice(0, 16);
    current = { version, defaultLimit, widgets, cards: new Map(buildCards(widgets, widgetOrder(config).map((id) => ({ id })), defaultLimit, MAX_CARD_ITEMS).map((card) => [card.id, card])) };
    return current;
  }

  function widget(id) {
    const updatedAt = results(id).map((result) => result.fetchedAt).filter(Boolean).sort().at(0) ?? null;
    return { ...snapshot().cards.get(id), updatedAt };
  }

  function start() {
    const timer = setInterval(refresh, (config.refreshMinutes ?? 10) * 60_000);
    timer.unref();
    return refresh();
  }

  return {
    refresh,
    start,
    widget,
    get lastRefresh() {
      return lastRefresh;
    },
    get ready() {
      return lastRefresh !== null;
    },
    get pending() {
      return refreshing;
    },
    // Settles once the latest refresh's preview images and thumbnails are ready.
    get imagesReady() {
      return preparedImages;
    },
    snapshot,
    // The latest result for one of the config's feed URLs (empty until the first refresh),
    // or undefined for any other URL. Lets the catalogue reuse feeds fetched here.
    source(url) {
      if (!Object.values(config.widgets).some((widget) => widget.sources.some((source) => source.url === url))) return undefined;
      return sources.get(url) ?? { items: [], fetchedAt: null, error: null };
    },
  };
}
