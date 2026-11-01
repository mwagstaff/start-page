// Picks the stories each card shows. Shared by the server (the default page) and the
// browser (layouts people have customised), so both make the same choices.

export const DEFAULT_LIMIT = 6;

// Tracking parameters that make the same story look like two different links.
function linkKey(link) {
  const url = new URL(link);
  for (const key of [...url.searchParams.keys()]) {
    if (key.startsWith('utm_') || key.startsWith('at_')) url.searchParams.delete(key);
  }
  url.hash = '';
  return url.href;
}

// The same story often reaches several feeds with different links (syndication,
// section feeds), so a long enough headline counts as the story too.
const MIN_TITLE_KEY_LENGTH = 25;

export function storyKeys(item) {
  const keys = [linkKey(item.link)];
  const title = item.title.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (title.length >= MIN_TITLE_KEY_LENGTH) keys.push(`title:${title}`);
  return keys;
}

// Single-source widgets keep the feed's own (often editorial) order; merged
// widgets are sorted newest first with a cap per source so no one site dominates.
// `seen` holds keys of stories already shown elsewhere: those are skipped (the
// widget backfills from further down its feeds) and the chosen items are added.
export function mergeItems(widget, results, defaultLimit = DEFAULT_LIMIT, seen = new Set()) {
  const limit = widget.limit ?? defaultLimit;
  const single = results.length === 1;
  const maxPerSource = single ? limit : widget.maxPerSource ?? limit;
  const unseen = (item) => !storyKeys(item).some((key) => seen.has(key));
  const candidates = results.flatMap(({ name, items }) => items.filter(unseen).slice(0, maxPerSource).map((item) => ({ ...item, source: name })));
  if (!single) candidates.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));

  const merged = [];
  for (const item of candidates) {
    if (!unseen(item)) continue;
    for (const key of storyKeys(item)) seen.add(key);
    merged.push(item);
    if (merged.length === limit) break;
  }
  return merged;
}

// Cards ready to render, from the feeds snapshot (`/api/feeds.json`) and a page layout:
// [{ id, limit? }] in page order. A story in several cards only shows in the first.
// With `maxItems`, each card also gets spare stories (marked `extra`) up to that many in
// all, for layout.js to show when there's room on screen. Spares are picked only once
// every card has its own stories, so they never take one another card would show.
export function buildCards(widgets, layout, defaultLimit = DEFAULT_LIMIT, maxItems = 0) {
  const seen = new Set();
  const cards = layout.filter(({ id }) => widgets[id]).map(({ id, limit }) => {
    const widget = widgets[id];
    return {
      id,
      title: widget.title,
      link: widget.link,
      thumbnails: widget.thumbnails,
      merged: widget.sources.length > 1,
      items: mergeItems({ limit: limit ?? widget.limit, maxPerSource: widget.maxPerSource }, widget.sources, defaultLimit, seen),
      failedSources: widget.sources.filter((source) => source.error).map((source) => source.name),
    };
  });
  for (const card of cards) {
    const spare = maxItems - card.items.length;
    if (spare <= 0 || !card.items.length) continue;
    const { maxPerSource, sources } = widgets[card.id];
    const extra = mergeItems({ limit: spare, maxPerSource }, sources, defaultLimit, seen);
    card.items.push(...extra.map((item) => ({ ...item, extra: true })));
  }
  return cards;
}
