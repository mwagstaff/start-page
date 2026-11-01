import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relativeTime, renderPage } from '../lib/render.js';

const now = Date.parse('2026-10-29T12:00:00Z');

test('relative times read as minutes, hours, days, then a date', () => {
  assert.equal(relativeTime('2026-10-29T11:55:00Z', now), '5m');
  assert.equal(relativeTime('2026-10-29T09:00:00Z', now), '3h');
  assert.equal(relativeTime('2026-10-27T12:00:00Z', now), '2d');
  assert.equal(relativeTime('2026-10-01T12:00:00Z', now), '1 Oct');
  assert.equal(relativeTime(null, now), '');
});

test('escapes feed text and shows failed sources', () => {
  const html = renderPage({
    now,
    tabs: [{ id: 'home', label: 'Home' }],
    activeTab: { id: 'home' },
    widgets: [{
      id: 'tech',
      title: 'Tech',
      link: null,
      thumbnails: false,
      merged: true,
      failedSources: ['The Register'],
      items: [{ title: '<script>alert(1)</script>', link: 'https://example.com/?a=1&b="2"', date: '2026-10-29T11:00:00Z', source: 'Ars' }],
    }],
  });
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /href="https:\/\/example\.com\/\?a=1&amp;b=&quot;2&quot;"/);
  assert.match(html, /The Register unavailable/);
  assert.match(html, /<span class="source">Ars<\/span>/);
});

test('shows an empty state when every source failed', () => {
  const html = renderPage({
    now,
    tabs: [{ id: 'home', label: 'Home' }],
    activeTab: { id: 'home' },
    widgets: [{ id: 'hn', title: 'Hacker News', link: null, thumbnails: false, merged: false, failedSources: ['Hacker News'], items: [] }],
  });
  assert.match(html, /Couldn't load this feed/);
});

test('the page carries its version, refresh and customise buttons, and an import map', () => {
  const widgets = [{ id: 'hn', title: 'HN', link: null, thumbnails: false, merged: false, failedSources: [], items: [] }];
  const html = renderPage({ tabs: [{ id: 'home', label: 'Home', widgets: ['hn'] }], activeTab: { id: 'home' }, widgets, version: 'abc123', versions: { 'page.js': 'h1', 'cards.js': 'h2' } });
  assert.match(html, /data-tab="home" data-version="abc123"/);
  assert.match(html, /<button class="refresh" type="button"/);
  assert.match(html, /<button class="customise-open icon-button" type="button"[^>]* hidden>/);
  assert.match(html, /<form class="search" action="https:\/\/www\.google\.com\/search" method="get" target="_blank" rel="noopener" role="search">\s*<input type="search" name="q"/);
  assert.match(html, /<script type="importmap">\{"imports":\{"\/static\/page\.js":"\/static\/page\.js\?v=h1","\/static\/cards\.js":"\/static\/cards\.js\?v=h2"\}\}<\/script>/);
  assert.match(html, /src="\/static\/page\.js\?v=h1"/);
  assert.match(html, /localStorage\.getItem\("start-page:settings"\)\)/);
  assert.match(html, /settings\?\.tabs\?\.\["home"\]/);
  assert.match(html, /<script type="module" src="\/static\/setup\.js">/);
});
