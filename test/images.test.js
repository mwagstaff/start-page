import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCache } from '../lib/cache.js';
import { createImageFinder, parsePageImage, smallImage } from '../lib/images.js';
import { createThumbnailer } from '../lib/thumbs.js';

test('parsePageImage reads Open Graph and Twitter preview tags in any attribute order', () => {
  assert.equal(parsePageImage('<meta property="og:image" content="https://a.com/x.jpg">', 'https://a.com/post'), 'https://a.com/x.jpg');
  assert.equal(parsePageImage(`<meta content='/img/y.png' property='og:image'>`, 'https://b.com/post'), 'https://b.com/img/y.png');
  assert.equal(parsePageImage('<meta name="twitter:image" content="https://c.com/z.jpg">', 'https://c.com/'), 'https://c.com/z.jpg');
  assert.equal(parsePageImage('<meta property="og:image" content="javascript:alert(1)">', 'https://d.com/'), null);
  assert.equal(parsePageImage('<title>No preview</title>', 'https://e.com/'), null);
});

test('smallImage asks image hosts that can resize for a thumbnail-sized copy', () => {
  assert.equal(smallImage('https://cdn.mos.cms.futurecdn.net/abc-1920-80.jpg'), 'https://cdn.mos.cms.futurecdn.net/abc-320-80.jpg');
  assert.equal(smallImage('https://image.theregister.com/?imageId=1&width=800'), 'https://image.theregister.com/?imageId=1&width=240');
  assert.equal(smallImage('https://www.nasa.gov/wp-content/uploads/2026/10/a.jpg?w=2048'), 'https://www.nasa.gov/wp-content/uploads/2026/10/a.jpg?w=240');
  assert.equal(smallImage('https://i0.wp.com/sixcolors.com/a.png'), 'https://i0.wp.com/sixcolors.com/a.png?w=240');
  assert.equal(smallImage('https://ichef.bbci.co.uk/ace/standard/240/a.jpg'), 'https://ichef.bbci.co.uk/ace/standard/240/a.jpg');
  assert.equal(smallImage(null), null);
});

test('the image finder fetches each link once, including links with no image', async () => {
  const fetched = [];
  const finder = createImageFinder({ fetch: async (link) => { fetched.push(link); return link.endsWith('/a') ? 'https://img/a.jpg' : null; } });
  assert.equal(finder.get('https://x/a'), undefined);
  const [a1, a2] = await Promise.all([finder.find('https://x/a'), finder.find('https://x/a')]);
  assert.equal(a1, 'https://img/a.jpg');
  assert.equal(a2, a1);
  assert.equal(await finder.find('https://x/b'), null);
  assert.equal(await finder.find('https://x/b'), null);
  assert.deepEqual(fetched, ['https://x/a', 'https://x/b']);
  assert.equal(finder.get('https://x/b'), null);
});

test('cards with thumbnails get preview images for items whose feed had none', async () => {
  const finder = createImageFinder({ fetch: async () => 'https://img/preview.jpg' });
  const config = { widgets: { hn: { title: 'HN', thumbnails: true, sources: [{ name: 'HN', url: 'https://feed' }] } } };
  const cache = createCache(config, {
    images: finder,
    log: { warn() {} },
    fetch: async () => [
      { title: 'Has image', link: 'https://a/1', image: 'https://img/own.jpg' },
      { title: 'No image', link: 'https://a/2', image: null },
    ],
  });
  await cache.refresh();
  await finder.find('https://a/2');
  assert.deepEqual(cache.widget('hn').items.map((item) => item.image), ['https://img/own.jpg', 'https://img/preview.jpg']);
});

test('the thumbnailer only serves images it registered, shrunk to 120×80 WebP', async () => {
  const { default: sharp } = await import('sharp');
  const original = await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#3a6' } }).jpeg().toBuffer();
  let fetches = 0;
  const thumbs = createThumbnailer({ fetch: async () => { fetches++; return original; } });
  const path = thumbs.path('https://img/big.jpg');
  assert.match(path, /^\/thumb\/[0-9a-f]{20}\.webp$/);
  const id = path.slice('/thumb/'.length, -'.webp'.length);
  const image = await thumbs.get(id);
  const meta = await sharp(image).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height], ['webp', 120, 80]);
  await thumbs.get(id);
  assert.equal(fetches, 1);
  assert.equal(await thumbs.get('0'.repeat(20)), null);
});

test('an image that cannot be fetched gets no thumbnail path until a retry works', async () => {
  let clock = 0;
  let blocked = true;
  const thumbs = createThumbnailer({
    log: { warn() {} },
    now: () => clock,
    fetch: async () => { if (blocked) throw new Error('HTTP 403'); return Buffer.from('img'); },
    resize: async (buffer) => buffer,
  });
  const url = 'https://blocked/photo.jpg';
  assert.match(thumbs.path(url), /^\/thumb\//);
  assert.equal(await thumbs.warm(url), null);
  assert.equal(thumbs.path(url), null);
  blocked = false;
  assert.equal(await thumbs.warm(url), null, 'not retried straight away');
  assert.equal(thumbs.path(url), null);
  clock += 60 * 60_000 + 1;
  assert.deepEqual(await thumbs.warm(url), Buffer.from('img'));
  assert.match(thumbs.path(url), /^\/thumb\//);
});

test('after a refresh the cache makes thumbnails and drops ones that failed', async () => {
  const thumbs = createThumbnailer({
    log: { warn() {} },
    fetch: async (url) => { if (url.includes('blocked')) throw new Error('HTTP 403'); return Buffer.from('img'); },
    resize: async (buffer) => buffer,
  });
  const config = { widgets: { space: { title: 'Space', thumbnails: true, sources: [{ name: 'S', url: 'https://feed' }] } } };
  const cache = createCache(config, {
    thumbs,
    images: createImageFinder({ fetch: async () => null }),
    log: { warn() {} },
    fetch: async () => [
      { title: 'Blocked', link: 'https://a/1', image: 'https://blocked/a.jpg' },
      { title: 'Fine', link: 'https://a/2', image: 'https://ok/b.jpg' },
    ],
  });
  await cache.refresh();
  await cache.imagesReady;
  const [blocked, fine] = cache.widget('space').items;
  assert.equal(blocked.image, null);
  assert.match(fine.image, /^\/thumb\/[0-9a-f]{20}\.webp$/);
});
