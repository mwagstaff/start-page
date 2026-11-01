// Keeps an open page current, and runs the masthead's refresh button.
// The server refetches feeds every few minutes; this page re-requests /api/feeds.json (a
// 304 when nothing changed) and, when it has changed, redraws the cards in place — but
// only while visible and not in the middle of use.

import { currentVersion, fetchFeeds, refreshCustomFeeds, refreshProfileFeeds, show } from './page.js';

const CHECK_EVERY_MS = 60_000;
const IDLE_BEFORE_UPDATE_MS = 30_000; // don't move stories from under someone reading them

let lastActivity = Date.now();
for (const type of ['pointermove', 'pointerdown', 'keydown', 'scroll', 'wheel', 'touchstart']) {
  addEventListener(type, () => { lastActivity = Date.now(); }, { passive: true });
}

// Busy: recently active, looking at the photo, customising, or with a half-typed search waiting.
const busy = () => Date.now() - lastActivity < IDLE_BEFORE_UPDATE_MS
  || document.querySelector('.peek:hover, .peek:focus-within, dialog[open]')
  || document.querySelector('.search input')?.value.trim();

async function check({ evenIfBusy = false } = {}) {
  if (document.visibilityState !== 'visible' || (!evenIfBusy && busy())) return;
  const data = await fetchFeeds();
  if (data && data.version !== currentVersion()) show(data);
  // The reader's own feeds and their profile's; each redraws only if something changed.
  await Promise.all([refreshCustomFeeds(), refreshProfileFeeds()]);
}

setInterval(check, CHECK_EVERY_MS);
// Coming back to the tab is a natural moment to catch up, even if the pointer moved.
document.addEventListener('visibilitychange', () => check({ evenIfBusy: !document.querySelector('.search input')?.value.trim() }));

const button = document.querySelector('.refresh');
button?.addEventListener('click', async () => {
  button.disabled = true;
  button.classList.add('is-spinning');
  try {
    // 429 means someone refreshed in the last minute: the latest content is already there.
    await fetch('/api/refresh', { method: 'POST' });
  } catch {
    // Fall through: the server still has whatever it last fetched.
  }
  const data = await fetchFeeds({ fresh: true });
  if (data) {
    show(data);
    await Promise.all([refreshCustomFeeds(), refreshProfileFeeds()]);
  } else {
    location.reload();
  }
  button.disabled = false;
  button.classList.remove('is-spinning');
});

// Results open in a new tab, so empty the box afterwards: this page is ready for the next
// search, and the half-typed check above doesn't hold back updates.
document.querySelector('.search')?.addEventListener('submit', (event) => {
  setTimeout(() => { event.target.reset(); }, 0);
});
