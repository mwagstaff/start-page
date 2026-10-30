import { createHash } from 'node:crypto';
import { fetchFeed } from './feeds.js';
import { createImageFinder, smallImage } from './images.js';

// Feeds from the catalogue (lib/catalogue.js), fetched only once someone's page asks for
// them. A source someone asked for in the last `keepHours` is refreshed on the timer like
// the default page's feeds; one nobody has asked for lately is left alone, and fetched again
// on the spot the next time it's wanted. Pages ask by catalogue id, never by URL, so this
// can only ever fetch the catalogue's own feeds.

export const SOURCE_ITEMS = 20; // a card shows at most 15, and some are dropped as duplicates
const PREVIEW_ITEMS = 10; // stories near the top of a feed are the ones cards show

class SourceError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function createSources(list, { refreshMinutes = 10, keepHours = 24, maxResponses = 200 } = {}, { fetch = fetchFeed, images = createImageFinder(), thumbs = null, log = console, now = Date.now } = {}) {
  const refreshMs = refreshMinutes * 60_000;
  const sources = new Map(list.map(({ id, name, url }) => [id, { id, name, url, items: [], fetchedAt: null, error: null, triedAt: 0, askedAt: 0, loading: null }]));
  const responses = new Map(); // ids → { generation, body, etag }, oldest first
  let generation = 0; // goes up whenever any source's items or thumbnails change

  // Preview images and thumbnails for a source's top stories, in the background: they show
  // from the next request on, as on the default page.
  async function prepareImages(source) {
    const top = source.items.slice(0, PREVIEW_ITEMS);
    await Promise.all(top.filter((item) => !item.image && images.get(item.link) === undefined).map((item) => images.find(item.link)));
    if (thumbs) await Promise.all(top.map((item) => thumbs.warm(originalImage(item))));
    generation++;
  }

  function load(source) {
    source.loading ??= (async () => {
      source.triedAt = now();
      try {
        source.items = (await fetch(source.url)).slice(0, SOURCE_ITEMS);
        source.fetchedAt = new Date(now()).toISOString();
        source.error = null;
      } catch (error) {
        log.warn(`Catalogue feed failed: ${source.url}: ${error.message}`);
        source.error = error.message; // the last good items stay
      }
      generation++;
      prepareImages(source).catch((error) => log.warn(`Catalogue images failed: ${source.url}: ${error.message}`));
    })().finally(() => {
      source.loading = null;
    });
    return source.loading;
  }

  // The timer only refreshes sources someone has asked for lately.
  function refresh() {
    const cutoff = now() - keepHours * 3_600_000;
    return Promise.all([...sources.values()].filter((source) => source.askedAt > cutoff).map(load));
  }

  function start() {
    setInterval(refresh, refreshMs).unref();
  }

  const originalImage = (item) => smallImage(item.image ?? images.get(item.link) ?? null);
  const withThumbnail = (item) => {
    const image = originalImage(item);
    return { ...item, image: thumbs && image ? thumbs.path(image) : image };
  };

  // The ids as a request should list them: known, each once, sorted, so every page asking
  // for the same feeds shares one cached response. Throws for an unknown id.
  function canonical(ids) {
    const unique = [...new Set(ids.filter(Boolean))].sort();
    if (!unique.length) throw new SourceError('Ask for at least one source.');
    const unknown = unique.find((id) => !sources.has(id));
    if (unknown) throw new SourceError(`Unknown source: ${unknown.slice(0, 40)}`);
    return unique;
  }

  // The feeds for some ids, as { body, etag }. Sources never fetched, or not refreshed
  // since nobody's asked for them, are fetched first; the rest come from memory.
  async function get(ids) {
    const wanted = canonical(ids).map((id) => sources.get(id));
    for (const source of wanted) source.askedAt = now();
    await Promise.all(wanted.filter((source) => now() - source.triedAt > refreshMs * 1.5).map(load));

    const key = wanted.map((source) => source.id).join(',');
    const cached = responses.get(key);
    if (cached?.generation === generation) return cached;
    const body = JSON.stringify({
      sources: Object.fromEntries(wanted.map((source) => [source.id, {
        name: source.name,
        fetchedAt: source.fetchedAt,
        error: source.error,
        items: source.items.map(withThumbnail),
      }])),
    });
    const response = { generation, body, etag: `"${createHash('sha256').update(body).digest('hex').slice(0, 16)}"` };
    responses.delete(key);
    responses.set(key, response);
    if (responses.size > maxResponses) responses.delete(responses.keys().next().value);
    return response;
  }

  return { canonical, get, refresh, start };
}
