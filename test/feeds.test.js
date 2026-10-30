import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseFeed } from '../lib/feeds.js';

const fixture = (name) => readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('parses BBC RSS with thumbnails and drops unsafe links', async () => {
  const items = parseFeed(await fixture('bbc.xml'));
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    title: 'Council approves new library & café',
    link: 'https://www.bbc.co.uk/news/articles/abc123?at_medium=RSS&at_campaign=rss',
    date: '2026-10-29T10:41:50.000Z',
    image: 'https://ichef.bbci.co.uk/ace/standard/240/example.jpg',
  });
  assert.equal(items[1].image, null);
});

test('extracts Hacker News points, comments and discussion link', async () => {
  const [item] = parseFeed(await fixture('hnrss.xml'));
  assert.equal(item.title, 'Show HN: A tiny static site generator');
  assert.equal(item.link, 'https://example.com/ssg');
  assert.equal(item.commentsUrl, 'https://news.ycombinator.com/item?id=111');
  assert.equal(item.points, 142);
  assert.equal(item.comments, 57);
});

test('parses Atom entries, preferring the alternate link and published date', async () => {
  const items = parseFeed(await fixture('atom.xml'));
  assert.equal(items[0].title, 'Apple’s new chip, explained');
  assert.equal(items[0].link, 'https://example.com/chip');
  assert.equal(items[0].date, '2026-10-29T10:00:04.000Z');
  assert.equal(items[0].image, 'https://example.com/chip.jpg?quality=90&strip=all');
  assert.equal(items[1].link, 'https://example.com/plain');
  assert.equal(items[1].image, null);
});

test('finds images in media:content, enclosures and content HTML', async () => {
  const images = parseFeed(await fixture('media-content.xml')).map((item) => item.image);
  assert.deepEqual(images, ['https://example.com/one.jpg', 'https://example.com/two.png', 'https://example.com/three.webp']);
});

test('rejects documents that are not feeds', () => {
  assert.throws(() => parseFeed('<html><body>Not a feed</body></html>'), /Unrecognised feed format/);
});
