import { XMLParser } from 'fast-xml-parser';

export const USER_AGENT = 'start-page/0.1 (+https://start.skynolimit.dev)';
const FETCH_TIMEOUT_MS = 10_000;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  htmlEntities: true,
  isArray: (name) => ['item', 'entry', 'link', 'media:content', 'media:thumbnail', 'enclosure'].includes(name),
});

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
    if (code[0] === '#') {
      const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(point) ? String.fromCodePoint(point) : match;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? match;
  });
}

// Element text, whether the parser produced a plain value or an object with attributes.
function text(node) {
  if (node == null) return '';
  if (Array.isArray(node)) return text(node[0]);
  if (typeof node === 'object') return text(node['#text']);
  return String(node);
}

function cleanText(value) {
  return decodeEntities(value.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

export function httpUrl(value, base) {
  if (!value) return null;
  try {
    const url = new URL(decodeEntities(String(value).trim()), base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function parseDate(value) {
  const date = new Date(text(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function isImage(media) {
  const medium = media['@_medium'];
  const type = media['@_type'] ?? '';
  return medium === 'image' || type.startsWith('image/') || (!medium && !type);
}

function findImage(entry) {
  const groups = [entry, ...(entry['media:group'] ? [entry['media:group']].flat() : [])];
  for (const group of groups) {
    const thumb = group['media:thumbnail']?.find((t) => t['@_url']);
    if (thumb) return httpUrl(thumb['@_url']);
    for (const media of group['media:content'] ?? []) {
      if (media['@_url'] && isImage(media)) return httpUrl(media['@_url']);
      const nested = media['media:thumbnail']?.find((t) => t['@_url']);
      if (nested) return httpUrl(nested['@_url']);
    }
  }
  const enclosure = entry.enclosure?.find((e) => e['@_url'] && (e['@_type'] ?? '').startsWith('image/'));
  if (enclosure) return httpUrl(enclosure['@_url']);

  const html = [entry['content:encoded'], entry.content, entry.description, entry.summary].map(text).find((h) => h.includes('<img'));
  const src = html?.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1];
  return httpUrl(src);
}

function atomLink(links = []) {
  const link = links.find((l) => !l['@_rel'] || l['@_rel'] === 'alternate') ?? links[0];
  return link?.['@_href'] ?? text(link);
}

// hnrss puts points and comment counts in the description HTML.
function hackerNewsStats(entry) {
  const description = text(entry.description);
  const points = description.match(/Points:\s*(\d+)/)?.[1];
  const comments = description.match(/# Comments:\s*(\d+)/)?.[1];
  return {
    points: points ? Number(points) : null,
    comments: comments ? Number(comments) : null,
  };
}

function normaliseRssItem(item) {
  const commentsUrl = httpUrl(text(item.comments));
  return {
    title: cleanText(text(item.title)),
    link: httpUrl(text(item.link?.[0])) ?? httpUrl(text(item.guid)),
    date: parseDate(item.pubDate ?? item['dc:date']),
    image: findImage(item),
    ...(commentsUrl?.includes('news.ycombinator.com') ? { commentsUrl, ...hackerNewsStats(item) } : {}),
  };
}

function normaliseAtomEntry(entry) {
  return {
    title: cleanText(text(entry.title)),
    link: httpUrl(atomLink(entry.link)),
    date: parseDate(entry.published ?? entry.updated),
    image: findImage(entry),
  };
}

// The feed's own title (for naming a card someone adds) and its items.
export function readFeed(xml) {
  const doc = parser.parse(xml);
  let channel;
  let items;
  if (doc.rss) {
    channel = doc.rss.channel;
    items = (channel?.item ?? []).map(normaliseRssItem);
  } else if (doc.feed) {
    channel = doc.feed;
    items = (doc.feed.entry ?? []).map(normaliseAtomEntry);
  } else if (doc['rdf:RDF']) {
    channel = doc['rdf:RDF'].channel;
    items = (doc['rdf:RDF'].item ?? []).map(normaliseRssItem);
  } else {
    throw new Error('Unrecognised feed format');
  }
  return { title: cleanText(text(channel?.title)), items: items.filter((item) => item.title && item.link) };
}

export function parseFeed(xml) {
  return readFeed(xml).items;
}

export async function fetchFeed(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return parseFeed(await response.text());
}
