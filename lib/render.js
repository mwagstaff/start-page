import { escapeHtml, relativeTime, renderWidget } from '../public/cards.js';
import { renderWeather } from '../public/forecast.js';

export { escapeHtml, relativeTime, renderWeather };

const REFRESH_ICON = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2.5v3h-3"/></svg>';

// Three sliders, for the Customise button.
const CUSTOMISE_ICON = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M2.5 4h11M2.5 8h11M2.5 12h11"/><circle cx="5.5" cy="4" r="1.6" fill="currentColor"/><circle cx="10.5" cy="8" r="1.6" fill="currentColor"/><circle cx="7" cy="12" r="1.6" fill="currentColor"/></svg>';

// A small landscape (mountains and sun), drawn in currentColor.
const PHOTO_ICON = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path d="m1.5 11 4-4 3.5 3.5 2-2 3.5 3.5"/><circle cx="11" cy="5.8" r="1"/></svg>';

// Hovering (or focusing) the bottom-right corner fades the page out to show the photo, with its caption.
function renderPeek(backdrop) {
  const credit = backdrop.credit && backdrop.credit !== backdrop.title ? `<span class="peek-credit">${escapeHtml(backdrop.credit)}</span>` : '';
  const link = backdrop.link ? `<a href="${escapeHtml(backdrop.link)}" target="_blank" rel="noopener">About this photo ↗</a>` : '';
  return `<div class="peek" tabindex="0" aria-label="Show the background photo">
    <span class="peek-marker" aria-hidden="true">${PHOTO_ICON}</span>
    <div class="peek-caption">
      <strong>${escapeHtml(backdrop.title)}</strong>
      ${credit}
      ${link}
    </div>
  </div>`;
}

// Static URLs carry a content hash (when known) because browsers cache them for an hour.
function asset(name, versions) {
  return `/static/${name}${versions[name] ? `?v=${escapeHtml(versions[name])}` : ''}`;
}

// Modules import each other by plain path; the import map adds the same hashes there.
function importMap(versions) {
  const imports = Object.fromEntries(Object.keys(versions).filter((name) => name.endsWith('.js')).map((name) => [`/static/${name}`, asset(name, versions)]));
  return `<script type="importmap">${JSON.stringify({ imports }).replace(/</g, '\\u003c')}</script>`;
}

// Runs before the page paints: with a customised layout saved, hide the default cards until
// page.js has drawn the reader's own, and start fetching the feeds (and, for cards made on
// the setup screen, the catalogue) it needs straight away. If that never happens, the
// default cards come back after a few seconds. Also hides the weather and photo if the
// reader turned them off, before they show.
const SETTINGS_KEY = 'start-page:settings';
function earlyScript(tab) {
  return `<script>
    try {
      const settings = JSON.parse(localStorage.getItem(${JSON.stringify(SETTINGS_KEY)}));
      const root = document.documentElement;
      if (settings?.tabs?.[${JSON.stringify(tab)}]) {
        root.classList.add('customised');
        window.startFeeds = fetch('/api/feeds.json', { cache: 'no-cache' }).then((response) => response.json());
        if (settings.profile) window.startCatalogue = fetch('/api/catalogue.json').then((response) => response.json());
        setTimeout(() => root.classList.remove('customised'), 3000);
      }
      if (settings?.profile?.weather === false) root.classList.add('no-weather');
      if (settings?.profile?.backdrop === false) root.classList.add('no-backdrop');
    } catch {}
  </script>`;
}

export function renderPage({ tabs, activeTab, widgets, weather = null, backdrop = null, versions = {}, version = '', now = Date.now() }) {
  const today = new Date(now).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/London' });
  const nav = tabs.length > 1
    ? `<nav class="tabs" aria-label="Sections">${tabs.map((tab) => `<a href="/${tab.id === 'home' ? '' : escapeHtml(tab.id)}"${tab.id === activeTab.id ? ' aria-current="page"' : ''}>${escapeHtml(tab.label)}</a>`).join('')}</nav>`
    : '';
  return `<!doctype html>
<html lang="en-GB">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Start</title>
  <meta name="color-scheme" content="light dark">
  <link rel="stylesheet" href="${asset('style.css', versions)}">
  <link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
  ${earlyScript(activeTab.id)}
  ${importMap(versions)}
  <script type="module" src="${asset('layout.js', versions)}"></script>
  <script type="module" src="${asset('page.js', versions)}"></script>
  <script type="module" src="${asset('weather.js', versions)}"></script>
  <script type="module" src="${asset('refresh.js', versions)}"></script>
  <script type="module" src="${asset('customise.js', versions)}"></script>
  <script type="module" src="${asset('setup.js', versions)}"></script>
  <script type="module" src="${asset('reorder.js', versions)}"></script>
</head>
<body${backdrop ? ' class="has-backdrop"' : ''} data-tab="${escapeHtml(activeTab.id)}" data-version="${escapeHtml(version)}">
  ${backdrop ? `<img class="backdrop" src="${escapeHtml(backdrop.url)}" alt="" decoding="async">` : ''}
  <header class="masthead">
    <div class="wrap">
      <div class="title">
        <span class="brand">Start</span>
        <span class="date">${escapeHtml(today)}</span>
        <button class="refresh" type="button" title="Refresh all feeds now" aria-label="Refresh all feeds now">${REFRESH_ICON}</button>
        <button class="customise-open icon-button" type="button" title="Customise cards" aria-label="Customise cards" hidden>${CUSTOMISE_ICON}</button>
      </div>
      <form class="search" action="https://www.google.com/search" method="get" target="_blank" rel="noopener" role="search">
        <input type="search" name="q" placeholder="Search Google" aria-label="Search Google" autocomplete="off" autofocus>
      </form>
      ${renderWeather(weather)}
    </div>
  </header>
  ${nav}
  <main class="wrap grid">
    ${widgets.map((widget) => renderWidget(widget, now)).join('\n')}
  </main>
  ${backdrop ? renderPeek(backdrop) : ''}
</body>
</html>`;
}
