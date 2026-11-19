import { USER_AGENT, httpUrl } from './feeds.js';

const FETCH_TIMEOUT_MS = 6_000;
const MAX_HTML_BYTES = 256 * 1024; // preview tags live in <head>, well inside this
const THUMB_WIDTH = 240; // 60px thumbnails at up to 4x density

// The preview image a page offers for link cards: Open Graph first, then Twitter's tag.
export function parsePageImage(html, pageUrl) {
  for (const meta of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = meta.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i)?.[1].toLowerCase();
    if (key !== 'og:image' && key !== 'og:image:url' && key !== 'og:image:secure_url' && key !== 'twitter:image') continue;
    const image = httpUrl(meta.match(/\bcontent\s*=\s*["']([^"']+)["']/i)?.[1], pageUrl);
    if (image) return image;
  }
  return null;
}

// Feeds often link full-size photos (up to 2048px). Where the image host can resize on
// request, ask it for a thumbnail-sized copy instead.
export function smallImage(src) {
  if (!src) return src;
  let url;
  try {
    url = new URL(src);
  } catch {
    return src;
  }
  if (url.hostname.endsWith('futurecdn.net')) {
    url.pathname = url.pathname.replace(/-\d+-80\.(\w+)$/, '-320-80.$1'); // Future plc (Tom's Hardware, Space.com)
  } else if (url.hostname === 'image.theregister.com' && url.searchParams.has('width')) {
    url.searchParams.set('width', THUMB_WIDTH);
  } else if (url.hostname.endsWith('.wp.com') || url.pathname.includes('/wp-content/uploads/')) {
    url.searchParams.set('w', THUMB_WIDTH); // WordPress image CDN; plain WordPress just ignores it
  } else {
    return src;
  }
  return url.href;
}

async function fetchPageImage(pageUrl) {
  const response = await fetch(pageUrl, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok || !(response.headers.get('content-type') ?? '').includes('html')) {
    await response.body?.cancel();
    return null;
  }
  // Read only until the end of <head>, so large pages don't get downloaded in full.
  const decoder = new TextDecoder();
  let html = '';
  for await (const chunk of response.body) {
    html += decoder.decode(chunk, { stream: true });
    if (html.length > MAX_HTML_BYTES || /<\/head>/i.test(html)) break;
  }
  await response.body.cancel().catch(() => {});
  return parsePageImage(html, response.url || pageUrl);
}

// Looks up preview images for links, remembering each answer (including "none") so a
// page is fetched once, not on every feed refresh.
export function createImageFinder({ fetch = fetchPageImage, maxEntries = 2000, concurrency = 6, log = console } = {}) {
  const known = new Map();
  const inflight = new Map(); // link → promise, while queued or being fetched
  const queue = [];
  let active = 0;

  function next() {
    while (active < concurrency && queue.length) {
      const { link, resolve } = queue.shift();
      active++;
      fetch(link)
        .catch((error) => {
          log.warn(`Preview image failed: ${link}: ${error.message}`);
          return null;
        })
        .then((image) => {
          active--;
          inflight.delete(link);
          known.set(link, image);
          if (known.size > maxEntries) known.delete(known.keys().next().value);
          resolve(image);
          next();
        });
    }
  }

  return {
    // The image if it's already known (null for "none"), or undefined if not looked up yet.
    get: (link) => known.get(link),
    find(link) {
      if (known.has(link)) return Promise.resolve(known.get(link));
      if (!inflight.has(link)) {
        inflight.set(link, new Promise((resolve) => {
          queue.push({ link, resolve });
          next();
        }));
      }
      return inflight.get(link);
    },
  };
}
