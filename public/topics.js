// Turns a reader's choices from the setup screen (their "profile") into cards, using the
// catalogue from /api/catalogue.json. Shared by the browser and the tests. A profile is
//   { outlets: [...], topics: [...], style: 'topics' | 'outlets', pictures, weather, backdrop }
// With style 'topics' each section topic is one card mixing the chosen outlets' feeds for
// that section; with 'outlets' each outlet is one card mixing its feeds for the chosen
// sections (its top stories if none). Topics with their own sources are always their own
// card, and topics that borrow a card from feeds.json show that card.

export const STYLES = ['topics', 'outlets'];
const MAX_IDS = 60;
const MERGED_LIMIT = 8;

export function validProfile(value) {
  if (typeof value !== 'object' || value === null) return null;
  const ids = (list) => [...new Set((Array.isArray(list) ? list : []).filter((id) => typeof id === 'string' && /^[a-z0-9-]{1,40}$/.test(id)))].slice(0, MAX_IDS);
  return {
    outlets: ids(value.outlets),
    topics: ids(value.topics),
    style: STYLES.includes(value.style) ? value.style : 'topics',
    pictures: value.pictures !== false,
    weather: value.weather !== false,
    backdrop: value.backdrop !== false,
  };
}

// The reader's region from their time zone: London is the UK, the Americas the US, and
// anywhere else gets both.
export function guessRegion(timeZone) {
  if (timeZone === 'Europe/London' || timeZone === 'Europe/Belfast') return 'uk';
  if (/^America\//.test(timeZone ?? '')) return 'us';
  return 'both';
}

const inRegion = (item, region) => region === 'both' || !item.region || item.region === region;

export const regionOutlets = (catalogue, region) => Object.keys(catalogue.outlets).filter((id) => inRegion(catalogue.outlets[id], region));
export const regionTopics = (catalogue, region) => Object.keys(catalogue.topics).filter((id) => inRegion(catalogue.topics[id], region));

// What the setup screen starts with for a region.
export function defaultProfile(catalogue, region) {
  const regions = region === 'both' ? catalogue.regions : [region];
  const pick = (key) => [...new Set(regions.flatMap((r) => catalogue.defaults[r]?.[key] ?? []))];
  return { outlets: pick('outlets'), topics: pick('topics'), style: 'topics', pictures: true, weather: true, backdrop: true };
}

// The cards a profile makes, in order: { id, title, sources: [{ id, name }], limit,
// maxPerSource } for cards built from catalogue feeds, or { id } for a feeds.json card.
export function profileCards(profile, catalogue) {
  const outlets = profile.outlets.filter((id) => catalogue.outlets[id]);
  const topics = profile.topics.filter((id) => catalogue.topics[id]);
  const sectionTopics = topics.filter((id) => catalogue.topics[id].section);
  const merged = (id, title, sources) => ({
    id,
    title,
    sources,
    limit: MERGED_LIMIT,
    maxPerSource: Math.max(2, Math.ceil(MERGED_LIMIT / sources.length)),
  });

  const cards = [];
  if (profile.style === 'outlets') {
    for (const id of outlets) {
      const outlet = catalogue.outlets[id];
      const sections = sectionTopics.map((topic) => catalogue.topics[topic].section).filter((section) => outlet.sections.includes(section));
      cards.push(merged(`outlet-${id}`, outlet.name, (sections.length ? sections : ['top']).map((section) => ({ id: `${id}.${section}`, name: outlet.name }))));
    }
  }
  for (const id of topics) {
    const topic = catalogue.topics[id];
    if (topic.widget) {
      cards.push({ id: topic.widget });
    } else if (topic.sources) {
      cards.push(merged(`topic-${id}`, topic.label, topic.sources));
    } else if (profile.style !== 'outlets') {
      const sources = outlets.filter((outlet) => catalogue.outlets[outlet].sections.includes(topic.section))
        .map((outlet) => ({ id: `${outlet}.${topic.section}`, name: catalogue.outlets[outlet].name }));
      if (sources.length) cards.push(merged(`topic-${id}`, topic.label, sources));
    }
  }
  return cards;
}

// Every catalogue feed a profile's cards need, sorted (the order /api/sources wants).
export function profileSourceIds(cards) {
  return [...new Set(cards.flatMap((card) => (card.sources ?? []).map((source) => source.id)))].sort();
}

// Cards in the snapshot's widget shape (see /api/feeds.json), filled from /api/sources'
// `sources` once loaded, or empty (shown as "Loading…") until then.
export function profileWidgets(cards, loaded = {}) {
  return Object.fromEntries(cards.filter((card) => card.sources).map((card) => [card.id, {
    title: card.title,
    link: null,
    thumbnails: true,
    limit: card.limit,
    maxPerSource: card.sources.length > 1 ? card.maxPerSource : null,
    profile: true,
    sources: card.sources.map(({ id, name }) => ({
      name,
      error: loaded[id]?.error && !loaded[id].items.length ? loaded[id].error : null,
      items: loaded[id]?.items ?? [],
    })),
  }]));
}

// This tab's card list after (re)building a profile: cards the reader already had keep
// their place and settings, new ones go at the end, and cards the profile no longer wants
// are hidden. Feeds the reader added themselves are left as they were.
export function layoutForProfile(previous, cards, allIds, isCustom = () => false) {
  const wanted = new Set(cards.map((card) => card.id));
  const kept = (previous ?? []).filter((card) => allIds.includes(card.id)).map(({ hidden, ...card }) => {
    if (isCustom(card.id)) return hidden ? { ...card, hidden } : card;
    return wanted.has(card.id) ? card : { ...card, hidden: true };
  });
  const listed = new Set(kept.map((card) => card.id));
  // Wanted cards that were hidden before move up to sit with the others.
  const shown = [...kept.filter((card) => !card.hidden), ...cards.filter((card) => !listed.has(card.id)).map(({ id }) => ({ id }))];
  const shownIds = new Set(shown.map((card) => card.id));
  const rest = [...kept.filter((card) => !shownIds.has(card.id)), ...allIds.filter((id) => !listed.has(id) && !shownIds.has(id)).map((id) => ({ id, hidden: true }))];
  return [...shown, ...rest];
}
