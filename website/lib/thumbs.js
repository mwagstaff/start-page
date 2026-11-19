import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { USER_AGENT } from './feeds.js';

const FETCH_TIMEOUT_MS = 10_000;
const MAX_SOURCE_BYTES = 15 * 1024 * 1024;
// 54×36 thumbnails at a bit over 2x density, cropped to fill.
const WIDTH = 120;
const HEIGHT = 80;

async function fetchImage(url) {
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'image/*' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (Number(response.headers.get('content-length')) > MAX_SOURCE_BYTES) throw new Error('image too large');
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > MAX_SOURCE_BYTES) throw new Error('image too large');
  return body;
}

export function resizeImage(buffer) {
  return sharp(buffer, { limitInputPixels: 50_000_000 })
    .rotate() // respect EXIF orientation
    .resize(WIDTH, HEIGHT, { fit: 'cover' })
    .webp({ quality: 72 })
    .toBuffer();
}

// Serves small thumbnails of feed and preview images from this server, so the page
// doesn't download multi-megabyte originals. Only images the server itself registered
// (by putting them on the page) can be fetched, by an opaque id.
// An image that couldn't be fetched (often a site blocking servers) is tried again this much later.
const RETRY_MS = 60 * 60_000;

export function createThumbnailer({ fetch = fetchImage, resize = resizeImage, maxEntries = 600, log = console, now = Date.now } = {}) {
  const sources = new Map(); // id → original URL
  const thumbs = new Map(); // id → Promise<Buffer | null>
  const failures = new Map(); // id → time it may be tried again

  function trim(map) {
    while (map.size > maxEntries) map.delete(map.keys().next().value);
  }

  function register(url) {
    const id = createHash('sha256').update(url).digest('hex').slice(0, 20);
    sources.delete(id);
    sources.set(id, url);
    trim(sources);
    return id;
  }

  // The resized image for an id, or null if it's unknown or couldn't be made.
  function get(id) {
    const url = sources.get(id);
    if (!url) return Promise.resolve(null);
    if (!thumbs.has(id)) {
      if (failures.get(id) > now()) return Promise.resolve(null);
      thumbs.set(id, fetch(url).then(resize).then((image) => {
        failures.delete(id);
        return image;
      }, (error) => {
        log.warn(`Thumbnail failed: ${url}: ${error.message}`);
        failures.set(id, now() + RETRY_MS);
        trim(failures);
        thumbs.delete(id);
        return null;
      }));
      trim(thumbs);
    }
    return thumbs.get(id);
  }

  return {
    // The path to use in the page for an original image URL, or null if it couldn't be
    // made, so the page shows a placeholder instead of a broken image. That holds until a
    // retry works, so the page doesn't keep switching between the two.
    path(url) {
      if (!url) return null;
      const id = register(url);
      return failures.has(id) ? null : `/thumb/${id}.webp`;
    },

    // Makes the thumbnail ahead of the first request, so failures are known before it's shown.
    warm(url) {
      return url ? get(register(url)) : Promise.resolve(null);
    },

    get,
  };
}
