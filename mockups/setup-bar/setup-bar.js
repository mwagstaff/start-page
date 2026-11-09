// Setup-bar prototype for tab1.net's first visit. Uses the site's own modules for cards,
// story picking, column packing and weather, and a content snapshot taken from tab1.net
// (data/snapshot.json), so what changes in the grid below the bar is what the real page
// would do. Only the bar (and its state) is new.
//
// URL parameters, so each state can be linked to and screenshotted:
//   state=first|returning   first visit (bar shown), or a reader who pressed Done
//   bar=1                   returning reader who reopened it with Customise
//   open=news|tech|sport|more|display   which drawer is open
//   add=ai,cricket          topics added on top of the defaults (the last one is highlighted)
//   region=uk|us|both       review=0 hides the mockup's state switcher

import { escapeHtml, renderWidget } from '/public/cards.js';
import { buildCards } from '/public/stories.js';
import { renderWeather } from '/public/forecast.js';
import { profileCards, profileWidgets, regionOutlets, regionTopics } from '/public/topics.js';
import { MAX_CARD_ITEMS } from '/public/settings.js';
import '/public/layout.js';

const params = new URLSearchParams(location.search);
const snap = await (await fetch('data/snapshot.json')).json();
const { catalogue, feeds, sources } = snap;
const NOW = Date.parse(snap.takenAt);

const root = document.documentElement;
const grid = document.querySelector('.grid');
const barWrap = document.querySelector('#setup-bar');
const opener = document.querySelector('.customise-open');
const toast = document.querySelector('.sb-toast');

// ---- what the page starts with -------------------------------------------------------

// The three pillars come first; More and Display are quieter.
const PILLARS = [
  { id: 'news', label: 'News', topics: ['top', 'world', 'politics', 'business', 'science', 'health', 'culture'] },
  { id: 'tech', label: 'Tech', topics: ['hacker-news', 'tech', 'ai', 'apple', 'gaming', 'space'] },
  { id: 'sport', label: 'Sport', topics: ['football', 'cricket', 'rugby', 'f1', 'nfl', 'nba', 'mlb', 'sport'] },
  { id: 'more', label: 'More', topics: ['film-tv', 'food', 'travel', 'money'] },
];
const pillarOf = (topic) => PILLARS.find((pillar) => pillar.topics.includes(topic));

// The page a new visitor sees before touching anything (matches today's screenshot).
const DEFAULT_TOPICS = {
  uk: ['top', 'hacker-news', 'world', 'tech', 'football'],
  us: ['top', 'hacker-news', 'world', 'tech', 'nfl'],
  both: ['top', 'hacker-news', 'world', 'tech', 'football'],
};
const defaultOutlets = (region) => (region === 'both'
  ? [...catalogue.defaults.uk.outlets, ...catalogue.defaults.us.outlets]
  : catalogue.defaults[region].outlets);

const LABELS = { sport: 'All sport' };
const label = (topic) => LABELS[topic] ?? catalogue.topics[topic].label;

const ICONS = {
  news: '<path d="M2.5 3.5h8.5v9a1.5 1.5 0 0 0 1.5 1.5H4a1.5 1.5 0 0 1-1.5-1.5z"/><path d="M11 6h2.5v6.5a1.5 1.5 0 0 1-1.5 1.5"/><path d="M4.8 6.2h3.8M4.8 8.7h3.8M4.8 11.2h2.4"/>',
  tech: '<path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5"/>',
  sport: '<circle cx="8" cy="8" r="5.8"/><path d="M8 5.4l2.2 1.6-.8 2.6H6.6L5.8 7z"/><path d="M8 2.2v3.2M10.2 7l3-1M9.4 9.6l1.9 2.6M6.6 9.6l-1.9 2.6M5.8 7l-3-1"/>',
  more: '<path d="M8 3.5v9M3.5 8h9"/>',
  display: '<rect x="2" y="2.5" width="12" height="11" rx="1.8"/><path d="M6.3 2.5v11M10.2 7.5H14"/>',
  chevron: '<path d="m4.5 6.5 3.5 3.5 3.5-3.5"/>',
  spark: '<path d="M8 1.6c.45 3.2 1.9 5.25 6.4 6.4-4.5 1.15-5.95 3.2-6.4 6.4-.45-3.2-1.9-5.25-6.4-6.4 4.5-1.15 5.95-3.2 6.4-6.4z" fill="currentColor" stroke="none"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
};
const icon = (name, size = 15) => `<svg viewBox="0 0 16 16" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

// ---- state ------------------------------------------------------------------------------

const region0 = ['uk', 'us', 'both'].includes(params.get('region')) ? params.get('region') : 'uk';
let state = {
  mode: params.get('state') === 'returning' ? 'returning' : 'first', // first visit, or set up already
  barShown: params.get('state') !== 'returning' || params.get('bar') === '1',
  open: params.get('open'),
  region: region0,
  outletsTouched: false,
  profile: { outlets: defaultOutlets(region0), topics: [...DEFAULT_TOPICS[region0]], style: 'topics', pictures: true, weather: true, backdrop: true },
  density: 'spacious',
};
let undoState = null;
let lastAdded = null;

for (const topic of (params.get('add') ?? '').split(',').filter((id) => catalogue.topics[id])) {
  if (!state.profile.topics.includes(topic)) state.profile.topics.push(topic);
  lastAdded = topic;
}

const clone = (value) => JSON.parse(JSON.stringify(value));

// ---- the grid: the site's own card pipeline ------------------------------------------

function cardIdFor(topic) {
  const t = catalogue.topics[topic];
  return t?.widget ?? `topic-${topic}`;
}

function topicForCard(cardId) {
  if (cardId.startsWith('topic-')) return { topic: cardId.slice(6) };
  if (cardId.startsWith('outlet-')) return { outlet: cardId.slice(7) };
  const topic = Object.keys(catalogue.topics).find((id) => catalogue.topics[id].widget === cardId);
  return topic ? { topic } : {};
}

function renderGrid() {
  const { profile } = state;
  const cards = profileCards(profile, catalogue);
  const widgets = { ...feeds.widgets, ...profileWidgets(cards, sources) };
  if (!profile.pictures) for (const id of Object.keys(widgets)) widgets[id] = { ...widgets[id], thumbnails: false };
  const built = buildCards(widgets, cards.map(({ id }) => ({ id })), feeds.defaultLimit ?? 6, MAX_CARD_ITEMS);
  grid.innerHTML = built.length
    ? built.map((widget) => renderWidget(widget, NOW)).join('')
    : `<section class="card sb-empty-card"><h2>Nothing here yet</h2><p class="empty">Choose a topic from News, Tech or Sport above and it appears here straight away.</p></section>`;
  grid.dispatchEvent(new Event('cards:change'));
}

// A card that's just been added glows for a moment (or stays lit, for a screenshot).
function highlight(topic, persist = false) {
  if (!topic) return;
  const card = document.getElementById(cardIdFor(topic));
  if (!card) return;
  card.classList.add(persist ? 'sb-new-static' : 'sb-new');
  // On a phone the sheet covers the page, so the toast says what happened instead.
  if (!matchMedia('(max-width: 760px)').matches) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  if (!persist) setTimeout(() => card.classList.remove('sb-new'), 2600);
}

function applyDisplay() {
  root.classList.toggle('density-balanced', state.density === 'balanced');
  root.classList.toggle('density-compact', state.density === 'compact');
  root.classList.toggle('no-weather', !state.profile.weather);
  root.classList.toggle('no-backdrop', !state.profile.backdrop);
}

const relayout = () => grid.dispatchEvent(new Event('layout:refresh'));

// Cross-fades the page between before and after, where the browser can. The redraw never
// waits more than a moment for it (a background tab may not run the transition at all).
function transition(update) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!document.startViewTransition || reduce) return update();
  let ran = false;
  const run = () => {
    if (ran) return;
    ran = true;
    update();
  };
  const vt = document.startViewTransition(run);
  for (const promise of [vt.ready, vt.finished, vt.updateCallbackDone]) promise.catch(() => {});
  setTimeout(() => {
    if (ran) return;
    vt.skipTransition();
    run();
  }, 250);
}

// ---- the bar --------------------------------------------------------------------------

function summary(pillar) {
  const chosen = state.profile.topics.filter((topic) => pillar.topics.includes(topic)).map(label);
  if (!chosen.length) return { text: pillar.id === 'more' ? '' : 'Add', count: 0 };
  return { text: chosen.length > 2 ? `${chosen.slice(0, 2).join(', ')} +${chosen.length - 2}` : chosen.join(', '), count: chosen.length };
}

function pillarButton(pillar, quiet = false) {
  const { text, count } = pillar.id === 'display' ? { text: '', count: 0 } : summary(pillar);
  const open = state.open === pillar.id;
  return `<button type="button" class="sb-pillar${quiet ? ' is-quiet' : ''}${count ? '' : ' is-empty'}" data-pillar="${pillar.id}" aria-expanded="${open}" aria-controls="sb-drawer">
    <span class="sb-pillar-icon">${icon(pillar.id)}</span>
    <span class="sb-pillar-name">${pillar.label}</span>
    ${text ? `<span class="sb-pillar-summary">${escapeHtml(text)}</span>` : ''}
    ${pillar.id === 'display' || (quiet && !count) ? '' : `<span class="sb-pillar-count" aria-label="${count} chosen">${count || '+'}</span>`}
    <span class="sb-chevron">${icon('chevron', 13)}</span>
  </button>`;
}

function chip(name, value, text, checked, extra = '') {
  return `<label class="chip"><input type="checkbox" name="${name}" value="${escapeHtml(value)}"${checked ? ' checked' : ''}><span>${escapeHtml(text)}${extra}</span></label>`;
}

function segmented(name, options, value) {
  return `<div class="segmented" role="radiogroup">${options.map(([v, text]) => `<label><input type="radio" name="${name}" value="${v}"${String(value) === v ? ' checked' : ''}><span>${text}</span></label>`).join('')}</div>`;
}

function list(names, max = 3) {
  return names.length > max ? `${names.slice(0, max).join(', ')} +${names.length - max}` : names.join(', ');
}

function topicSources(topic) {
  const t = catalogue.topics[topic];
  if (topic === 'hacker-news') return 'The front page, with points and comments';
  if (t.widget) return list(feeds.widgets[t.widget]?.sources.map((s) => s.name) ?? []);
  if (t.sources) return list(t.sources.map((s) => s.name));
  const outlets = state.profile.outlets.filter((id) => catalogue.outlets[id].sections.includes(t.section));
  return outlets.length ? `From ${list(outlets.map((id) => catalogue.outlets[id].name))}` : 'Choose a news source first';
}

function tile(topic) {
  const checked = state.profile.topics.includes(topic);
  return `<label class="sb-tile"><input type="checkbox" name="topic" value="${topic}"${checked ? ' checked' : ''}>
    <span class="sb-tile-name">${escapeHtml(label(topic))}</span>
    <span class="sb-tile-sources">${escapeHtml(topicSources(topic))}</span>
    <span class="sb-tile-check" aria-hidden="true"></span>
  </label>`;
}

const REGIONS = [['uk', 'UK'], ['us', 'US'], ['both', 'UK and US']];

function panel(id) {
  const available = new Set(regionTopics(catalogue, state.region));
  const pillar = PILLARS.find((p) => p.id === id);
  const topics = pillar ? pillar.topics.filter((topic) => available.has(topic)) : [];
  const regionName = REGIONS.find(([v]) => v === state.region)[1];

  if (id === 'news') {
    const outlets = regionOutlets(catalogue, state.region).map((outlet) => {
      const o = catalogue.outlets[outlet];
      const paywall = o.paywall ? ' <small class="paywall">paywall</small>' : '';
      return chip('outlet', outlet, o.name, state.profile.outlets.includes(outlet), paywall);
    }).join('');
    return `
      <div class="sb-field"><span class="sb-label">Topics</span><div class="chips">${topics.map((topic) => chip('topic', topic, label(topic), state.profile.topics.includes(topic))).join('')}</div></div>
      <div class="sb-field"><span class="sb-label">From</span><div class="chips">${outlets}</div></div>
      <div class="sb-field sb-field-inline">
        <span class="sb-label">Region</span>${segmented('region', REGIONS, state.region)}
        <span class="sb-label sb-label-gap">Show news as</span>${segmented('style', [['topics', 'One card per topic'], ['outlets', 'One card per source']], state.profile.style)}
      </div>
      <p class="sb-hint">Each news topic mixes stories from the sources you pick, newest first.</p>`;
  }
  if (id === 'display') {
    return `
      <div class="sb-field sb-field-inline">
        <span class="sb-label">Stories</span>${segmented('pictures', [['true', 'With pictures'], ['false', 'Headlines only']], state.profile.pictures)}
        <span class="sb-label sb-label-gap">Density</span>${segmented('density', [['spacious', 'Spacious'], ['balanced', 'Balanced'], ['compact', 'Compact']], state.density)}
      </div>
      <div class="sb-field sb-field-inline">
        <label class="sb-switch"><input type="checkbox" name="weather"${state.profile.weather ? ' checked' : ''}><span></span>Weather in the top bar</label>
        <label class="sb-switch"><input type="checkbox" name="backdrop"${state.profile.backdrop ? ' checked' : ''}><span></span>A new background photo each day</label>
      </div>
      <p class="sb-hint">Card order, stories per card, your own RSS feeds and import/export are in <a href="https://tab1.net/settings" target="_blank" rel="noopener">Advanced settings</a>.</p>`;
  }
  const hint = {
    tech: 'Each topic is its own card. Remove any card with its ×, here or on the page.',
    sport: `Showing sports for the ${regionName === 'UK and US' ? 'UK and US' : regionName}. <button type="button" class="sb-link" data-goto="news">Change region</button>`,
    more: 'Looking for something else? Add any RSS feed in <a href="https://tab1.net/settings" target="_blank" rel="noopener">Advanced settings</a>.',
  }[id];
  return `<div class="sb-tiles">${topics.map(tile).join('')}</div><p class="sb-hint">${hint}</p>`;
}

function renderBar() {
  const first = state.mode === 'first';
  const open = state.open;
  const openLabel = open === 'display' ? 'Display' : PILLARS.find((p) => p.id === open)?.label;
  barWrap.hidden = !state.barShown;
  barWrap.innerHTML = `
    <section class="sb${open ? ' is-open' : ''}" aria-labelledby="sb-title">
      <div class="sb-main">
        <div class="sb-intro">
          <span class="sb-spark">${icon('spark', 16)}</span>
          <div class="sb-intro-text">
            <h2 id="sb-title">${first ? 'Make this page yours' : 'Customise your page'}</h2>
            <p>${first ? 'Pick what you follow. The page changes as you go.' : 'Changes save as you go.'}</p>
          </div>
        </div>
        <div class="sb-pillars" role="group" aria-label="Topics">
          ${PILLARS.map((pillar) => pillarButton(pillar, pillar.id === 'more')).join('')}
          <span class="sb-divider" aria-hidden="true"></span>
          ${pillarButton({ id: 'display', label: 'Display' }, true)}
        </div>
        <div class="sb-actions">
          <a class="sb-advanced" href="https://tab1.net/settings" target="_blank" rel="noopener">Advanced settings</a>
          <button type="button" class="sb-done">Done</button>
        </div>
      </div>
      <div class="sb-drawer" id="sb-drawer" ${open ? '' : 'hidden'} role="region" aria-label="${openLabel ?? ''}">
        <div class="sb-sheet-head"><h3>${openLabel ?? ''}</h3><button type="button" class="sb-sheet-close" aria-label="Close">${icon('close', 14)}</button></div>
        <form class="sb-panel" data-panel="${open ?? ''}">${open ? panel(open) : ''}</form>
        <div class="sb-sheet-foot"><button type="button" class="sb-done">Done</button></div>
      </div>
    </section>`;
  opener.setAttribute('aria-expanded', String(state.barShown));
  opener.classList.toggle('is-active', state.barShown);
  root.classList.toggle('sb-sheet-open', Boolean(open));
}

// ---- changes ----------------------------------------------------------------------------

function showToast(html, { undo = false, ms = 5000 } = {}) {
  toast.innerHTML = `<span>${html}</span>${undo ? '<button type="button" class="sb-undo">Undo</button>' : ''}`;
  toast.hidden = false;
  toast.classList.remove('is-in');
  void toast.offsetWidth;
  toast.classList.add('is-in');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.hidden = true; }, ms);
}

// Every change: remember how things were (for Undo), change, redraw bar and page.
function change(mutate, { added = null, message = null } = {}) {
  undoState = clone(state);
  mutate(state);
  transition(() => {
    renderBar();
    applyDisplay();
    renderGrid();
  });
  setTimeout(() => highlight(added), 320);
  if (message) showToast(message, { undo: true });
}

function toggleTopic(topic, on) {
  const name = escapeHtml(label(topic));
  change((s) => {
    s.profile.topics = on ? [...s.profile.topics, topic] : s.profile.topics.filter((id) => id !== topic);
  }, { added: on ? topic : null, message: on ? `Added <b>${name}</b>` : `Removed <b>${name}</b>` });
}

function toggleOutlet(outlet, on) {
  const name = escapeHtml(catalogue.outlets[outlet].name);
  change((s) => {
    s.outletsTouched = true;
    const order = Object.keys(catalogue.outlets);
    s.profile.outlets = (on ? [...s.profile.outlets, outlet] : s.profile.outlets.filter((id) => id !== outlet))
      .sort((a, b) => order.indexOf(a) - order.indexOf(b));
  }, { message: on ? `Added stories from <b>${name}</b>` : `No more stories from <b>${name}</b>` });
}

function setRegion(region) {
  change((s) => {
    s.region = region;
    const outlets = new Set(regionOutlets(catalogue, region));
    const topics = new Set(regionTopics(catalogue, region));
    s.profile.outlets = s.outletsTouched ? s.profile.outlets.filter((id) => outlets.has(id)) : defaultOutlets(region);
    s.profile.topics = s.profile.topics.filter((id) => topics.has(id));
    for (const id of DEFAULT_TOPICS[region]) if (!s.profile.topics.includes(id) && pillarOf(id)?.id === 'sport') s.profile.topics.push(id);
  });
}

// State changes happen straight away; only the redraw waits for the cross-fade, so quick
// clicks can't race each other.
function redrawBar() {
  transition(() => {
    renderBar();
    relayout();
  });
}

function setOpen(id) {
  state.open = state.open === id ? null : id;
  redrawBar();
}

function done() {
  const first = state.mode === 'first';
  state = { ...state, mode: 'returning', barShown: false, open: null };
  redrawBar();
  if (first) {
    showToast('Saved in this browser. Change it any time with <b>Customise</b>.', { ms: 6000 });
    opener.classList.add('sb-pulse');
    setTimeout(() => opener.classList.remove('sb-pulse'), 3200);
  }
}

barWrap.addEventListener('click', (event) => {
  const pillar = event.target.closest('[data-pillar]');
  if (pillar) return setOpen(pillar.dataset.pillar);
  if (event.target.closest('.sb-done')) return done();
  if (event.target.closest('.sb-sheet-close')) return setOpen(state.open);
  const goto = event.target.closest('[data-goto]');
  if (goto) return setOpen(goto.dataset.goto);
});

barWrap.addEventListener('change', (event) => {
  const { name, value, checked } = event.target;
  if (name === 'topic') toggleTopic(value, checked);
  else if (name === 'outlet') toggleOutlet(value, checked);
  else if (name === 'region') setRegion(value);
  else if (name === 'style') change((s) => { s.profile.style = value; });
  else if (name === 'pictures') change((s) => { s.profile.pictures = value === 'true'; });
  else if (name === 'density') change((s) => { s.density = value; });
  else if (name === 'weather' || name === 'backdrop') change((s) => { s.profile[name] = checked; });
});
barWrap.addEventListener('submit', (event) => event.preventDefault());

opener.addEventListener('click', () => {
  if (state.barShown) return done();
  state.barShown = true;
  redrawBar();
});

// The × on a card takes that topic (or source) off the page, and the bar follows.
grid.addEventListener('click', (event) => {
  const close = event.target.closest('.card-close');
  if (!close) return;
  const { topic, outlet } = topicForCard(close.closest('.card').id);
  if (topic) toggleTopic(topic, false);
  else if (outlet) toggleOutlet(outlet, false);
});

toast.addEventListener('click', (event) => {
  if (!event.target.closest('.sb-undo') || !undoState) return;
  state = undoState;
  undoState = null;
  toast.hidden = true;
  transition(() => {
    renderBar();
    applyDisplay();
    renderGrid();
  });
});

addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.open) setOpen(state.open);
});

// ---- the mockup's own state switcher -----------------------------------------------------

function renderReview() {
  if (params.get('review') === '0') return;
  const nav = document.querySelector('.review');
  const states = [
    ['First visit', ''],
    ['News open', '?open=news'],
    ['Tech: + AI', '?open=tech&add=ai'],
    ['Sport: + Cricket', '?open=sport&add=cricket'],
    ['More', '?open=more'],
    ['Display', '?open=display'],
    ['US visitor', '?region=us&open=sport'],
    ['After Done', '?state=returning'],
    ['Reopened', '?state=returning&bar=1'],
  ];
  const here = location.search.replace(/&?review=[^&]*/, '') || '';
  nav.innerHTML = `<details open><summary>Mockup states</summary><ul>${states.map(([text, query]) => `<li><a href="./${query}"${query === here ? ' aria-current="page"' : ''}>${text}</a></li>`).join('')}</ul>
    <p>Content: snapshot of tab1.net, ${new Date(NOW).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}.</p></details>`;
  nav.hidden = false;
}

// ---- start ---------------------------------------------------------------------------------

document.querySelector('.date').textContent = new Date(NOW).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/London' });
document.querySelector('.weather-slot').outerHTML = renderWeather(feeds.weather, 'C');
if (feeds.backdrop?.url) document.querySelector('.backdrop').src = feeds.backdrop.url;
root.classList.add('can-remove');
renderBar();
applyDisplay();
renderGrid();
renderReview();
if (lastAdded) {
  setTimeout(() => highlight(lastAdded, true), 400);
  showToast(`Added <b>${escapeHtml(label(lastAdded))}</b>`, { undo: true, ms: 60000 });
}
if (params.get('state') === 'returning' && params.get('bar') !== '1') {
  showToast('Saved in this browser. Change it any time with <b>Customise</b>.', { ms: 60000 });
  opener.classList.add('sb-pulse-static');
}
