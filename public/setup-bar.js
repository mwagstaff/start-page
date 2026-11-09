// The setup bar, between the masthead and the cards: how readers choose what their page shows.
// It opens by itself for a new reader (over the suggested page, so ignoring it still leaves
// a good page) and stays, on later visits too, until they press Done; after that the
// masthead's Customise button opens it. Compact, it lists the pillars (News, Tech, Sport,
// then More and Display) with what's chosen in each; a pillar opens a drawer of choices
// under the bar (a sheet from the bottom on phones). Every choice is saved and shown on the
// page straight away (page.js), so it can be undone like any change (undo.js). Settings is
// one step further in, as "Advanced settings".

import { escapeHtml } from './cards.js';
import { currentFeeds, currentProfile, currentSettings, fetchCatalogue, fetchFeeds, finishSetup, guessedRegion, setDensity, setProfile, welcoming } from './page.js';
import { DENSITIES } from './settings.js';
import { PILLARS, defaultProfile, pillarTopics, profileRegion, regionOutlets, topicCardId, withOutlet, withRegion, withTopic } from './topics.js';

const PATH = '/settings/topics-and-sources'; // an older address for choosing topics: opens the bar
const root = document.documentElement;
const grid = document.querySelector('.grid');
const container = document.querySelector('#setup-bar');
const opener = document.querySelector('.customise-open');
let catalogue = null;
let shown = false;
let mode = 'welcome'; // 'welcome' for a new reader, 'customise' once they've pressed Done
let open = null; // the pillar whose drawer is open
let region = null; // the region whose topics and sources are listed
let choice = null; // the profile as last chosen here (changes save one after another)
let saving = Promise.resolve();
let busy = 0;
let toast = null;

const REGIONS = [['uk', 'UK'], ['us', 'US'], ['both', 'UK and US']];
const TILE_LABELS = { sport: 'All sport' }; // the card itself is just "Sport"
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

const label = (topic) => catalogue.topics[topic].label;
const tileLabel = (topic) => TILE_LABELS[topic] ?? label(topic);
const outletName = (id) => catalogue.outlets[id].name;
const regionName = (value) => REGIONS.find(([v]) => v === value)?.[1] ?? value;
const list = (names, max = 3) => (names.length > max ? `${names.slice(0, max).join(', ')} +${names.length - max}` : names.join(', '));
const phone = () => matchMedia('(max-width: 760px)').matches;

// The profile the bar edits: the reader's, or the suggested one for a layout arranged before
// topics existed (choosing anything then builds the page from topics).
const pageProfile = () => currentProfile() ?? defaultProfile(catalogue, guessedRegion());
const sync = () => {
  choice = structuredClone(pageProfile());
  region = profileRegion(choice, catalogue, region ?? guessedRegion());
};

// ---- markup ---------------------------------------------------------------------------

function summary(pillar) {
  const chosen = choice.topics.filter((topic) => catalogue.topics[topic]?.pillar === pillar.id);
  const names = chosen.map(tileLabel);
  const text = !names.length ? (pillar.id === 'more' ? '' : 'Add') : names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(', ');
  return { text, count: chosen.length };
}

function pillarButton(pillar, quiet = false) {
  const isDisplay = pillar.id === 'display';
  const { text, count } = isDisplay ? { text: '', count: 0 } : summary(pillar);
  return `<button type="button" class="sb-pillar${quiet ? ' is-quiet' : ''}${count ? '' : ' is-empty'}" data-pillar="${pillar.id}" aria-expanded="${open === pillar.id}" aria-controls="sb-drawer">
    <span class="sb-pillar-icon">${icon(pillar.id)}</span>
    <span class="sb-pillar-name">${pillar.label}</span>
    ${text ? `<span class="sb-pillar-summary">${escapeHtml(text)}</span>` : ''}
    ${isDisplay || (quiet && !count) ? '' : `<span class="sb-pillar-count" aria-label="${count} chosen">${count || '+'}</span>`}
    <span class="sb-chevron">${icon('chevron', 13)}</span>
  </button>`;
}

function chip(name, value, text, checked, extra = '') {
  return `<label class="chip"><input type="checkbox" name="${name}" value="${escapeHtml(value)}"${checked ? ' checked' : ''}><span>${escapeHtml(text)}${extra}</span></label>`;
}

function segmented(name, options, value, labelledBy) {
  return `<div class="segmented" role="radiogroup" aria-labelledby="${labelledBy}">${options.map(([v, text]) => `<label><input type="radio" name="${name}" value="${v}"${String(value) === v ? ' checked' : ''}><span>${text}</span></label>`).join('')}</div>`;
}

// Topics whose source list alone wouldn't say what they are.
const TOPIC_BLURBS = {
  'hacker-news': 'The front page, with points and comments',
  'hn-top': 'Hacker News stories past 300 points',
  lobsters: 'Programming links, with comments',
  techmeme: 'The day\'s top tech stories',
};

// Where a topic's stories come from, under its name.
function topicSources(topic) {
  const t = catalogue.topics[topic];
  if (TOPIC_BLURBS[topic]) return TOPIC_BLURBS[topic];
  if (t.widget) return list(currentFeeds()?.widgets[t.widget]?.sources.map((source) => source.name) ?? []);
  if (t.sources) return list(t.sources.map((source) => source.name));
  const outlets = choice.outlets.filter((id) => catalogue.outlets[id]?.sections.includes(t.section));
  return outlets.length ? `From ${list(outlets.map(outletName))}` : 'Choose a news source first';
}

function tile(topic) {
  return `<label class="sb-tile"><input type="checkbox" name="topic" value="${escapeHtml(topic)}"${choice.topics.includes(topic) ? ' checked' : ''}>
    <span class="sb-tile-name">${escapeHtml(tileLabel(topic))}</span>
    <span class="sb-tile-sources">${escapeHtml(topicSources(topic))}</span>
    <span class="sb-tile-check" aria-hidden="true"></span>
  </label>`;
}

const ADVANCED = '<button type="button" class="sb-link" data-action="advanced">Advanced settings</button>';

function panel(id) {
  if (id === 'news') {
    const topics = pillarTopics(catalogue, region, 'news');
    const outlets = regionOutlets(catalogue, region).map((outlet) => {
      const { paywall } = catalogue.outlets[outlet];
      const tag = paywall ? ` <small class="paywall" title="${paywall === 'hard' ? 'Most stories need a subscription' : 'Some stories need a subscription'}">paywall</small>` : '';
      return chip('outlet', outlet, outletName(outlet), choice.outlets.includes(outlet), tag);
    }).join('');
    const newsTopics = choice.topics.filter((topic) => catalogue.topics[topic]?.section);
    const warning = newsTopics.length && !choice.outlets.length ? '<p class="sb-hint sb-warning" role="status">Choose at least one source for your news topics.</p>' : '';
    return `
      <div class="sb-field"><span class="sb-label" id="sb-news-topics">Topics</span><div class="chips" role="group" aria-labelledby="sb-news-topics">${topics.map((topic) => chip('topic', topic, label(topic), choice.topics.includes(topic))).join('')}</div></div>
      <div class="sb-field"><span class="sb-label" id="sb-news-from">From</span><div class="chips" role="group" aria-labelledby="sb-news-from">${outlets}</div></div>
      <div class="sb-field sb-field-inline">
        <span class="sb-label" id="sb-region">Region</span>${segmented('region', REGIONS, region, 'sb-region')}
        <span class="sb-label sb-label-gap" id="sb-style">Show news as</span>${segmented('style', [['topics', 'One card per topic'], ['outlets', 'One card per source']], choice.style, 'sb-style')}
      </div>
      ${warning}
      <p class="sb-hint">Each news topic mixes stories from the sources you pick, newest first.</p>`;
  }
  if (id === 'display') {
    const density = currentSettings()?.density ?? DENSITIES[0];
    const names = { spacious: 'Spacious', balanced: 'Balanced', compact: 'Compact' };
    return `
      <div class="sb-field sb-field-inline">
        <span class="sb-label" id="sb-pictures">Stories</span>${segmented('pictures', [['true', 'With pictures'], ['false', 'Headlines only']], choice.pictures, 'sb-pictures')}
        <span class="sb-label sb-label-gap" id="sb-density">Density</span>${segmented('density', DENSITIES.map((d) => [d, names[d] ?? d]), density, 'sb-density')}
      </div>
      <div class="sb-field sb-field-inline">
        <label class="sb-switch"><input type="checkbox" name="weather"${choice.weather ? ' checked' : ''}><span></span>Weather in the top bar</label>
        <label class="sb-switch"><input type="checkbox" name="backdrop"${choice.backdrop ? ' checked' : ''}><span></span>A new background photo each day</label>
      </div>
      <p class="sb-hint">Card order, stories per card, your own RSS feeds and import/export are in ${ADVANCED}.</p>`;
  }
  const hint = {
    tech: 'Each topic is its own card. You can also remove a card with its ×.',
    sport: `Showing sports for the ${regionName(region)}. <button type="button" class="sb-link" data-pillar="news">Change region</button>`,
    more: `Looking for something else? Add any RSS feed in ${ADVANCED}.`,
  }[id];
  return `<div class="sb-tiles">${pillarTopics(catalogue, region, id).map(tile).join('')}</div><p class="sb-hint">${hint}</p>`;
}

function render() {
  const welcome = mode === 'welcome';
  const openLabel = open === 'display' ? 'Display' : PILLARS.find((p) => p.id === open)?.label ?? '';
  container.hidden = !shown;
  root.classList.remove('setup-pending');
  root.classList.toggle('sb-sheet-open', shown && Boolean(open));
  opener.setAttribute('aria-expanded', String(shown));
  opener.classList.toggle('is-active', shown);
  if (!shown) {
    container.replaceChildren();
    return;
  }
  container.innerHTML = `
    <section class="sb${open ? ' is-open' : ''}" aria-labelledby="sb-title">
      <div class="sb-main">
        <div class="sb-intro">
          <span class="sb-spark">${icon('spark', 16)}</span>
          <div class="sb-intro-text">
            <h2 id="sb-title">${welcome ? 'Make this page yours' : 'Customise your page'}</h2>
            <p>${welcome ? 'Pick what you follow. The page changes as you go.' : 'Changes save as you go.'}</p>
          </div>
        </div>
        <div class="sb-pillars" role="group" aria-label="Topics">
          ${PILLARS.map((pillar) => pillarButton(pillar, pillar.id === 'more')).join('')}
          <span class="sb-divider" aria-hidden="true"></span>
          ${pillarButton({ id: 'display', label: 'Display' }, true)}
        </div>
        <div class="sb-actions">
          <button type="button" class="sb-advanced" data-action="advanced">Advanced settings</button>
          <button type="button" class="sb-done" data-action="done">Done</button>
        </div>
      </div>
      <div class="sb-drawer" id="sb-drawer" role="region" aria-label="${openLabel}"${open ? '' : ' hidden'}>
        <div class="sb-sheet-head"><h3>${openLabel}</h3><button type="button" class="sb-sheet-close" data-action="close" aria-label="Close">${icon('close', 14)}</button></div>
        <form class="sb-panel">${open ? panel(open) : ''}</form>
        <div class="sb-sheet-foot"><button type="button" class="sb-done" data-action="done">Done</button></div>
      </div>
    </section>`;
}

// ---- showing and hiding -------------------------------------------------------------------

const relayout = () => grid?.dispatchEvent(new Event('layout:refresh'));

// Cross-fades the page between before and after where the browser can, but never waits
// more than a moment for it (a background tab may not run the transition at all).
function transition(update) {
  if (!document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) return update();
  let ran = false;
  const run = () => {
    if (ran) return;
    ran = true;
    update();
  };
  const fade = document.startViewTransition(run);
  for (const promise of [fade.ready, fade.finished, fade.updateCallbackDone]) promise.catch(() => {});
  setTimeout(() => {
    if (ran) return;
    fade.skipTransition();
    run();
  }, 250);
}

function redraw() {
  transition(() => {
    render();
    relayout();
  });
}

async function show({ pillar = null } = {}) {
  catalogue ??= await fetchCatalogue();
  if (!catalogue) return;
  if (!currentFeeds()) await fetchFeeds();
  mode = welcoming() ? 'welcome' : 'customise';
  sync();
  shown = true;
  open = pillar;
  redraw();
}

function setOpen(pillar) {
  open = open === pillar ? null : pillar;
  redraw();
}

function done() {
  const welcome = mode === 'welcome';
  if (welcome) finishSetup();
  shown = false;
  open = null;
  redraw();
  if (welcome) {
    showToast('Saved in this browser. Change it any time with <b>Customise</b>.');
    opener.classList.add('sb-pulse');
    setTimeout(() => opener.classList.remove('sb-pulse'), 3200);
  }
  opener.focus({ preventScroll: true });
}

function showToast(html) {
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'sb-toast';
    toast.setAttribute('role', 'status');
    document.body.append(toast);
  }
  toast.innerHTML = `<span>${html}</span>`;
  toast.hidden = false;
  toast.classList.remove('is-in');
  void toast.offsetWidth; // restart the animation
  toast.classList.add('is-in');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.hidden = true; }, 6000);
}

// ---- changes ------------------------------------------------------------------------------

// A card that's just been added glows for a moment, and comes into view (on a phone the
// sheet covers the page, so the Undo message says what happened instead). The glow carries
// on, without starting again, when the card is redrawn with its stories.
const GLOW_MS = 2600;
let glowing = null; // { id, start }

function glow({ scroll = false } = {}) {
  const elapsed = glowing ? Date.now() - glowing.start : GLOW_MS;
  const card = elapsed < GLOW_MS && document.getElementById(glowing.id);
  if (!card) return;
  card.style.animationDelay = `${-elapsed}ms`;
  card.classList.add('sb-new');
  if (scroll && !phone()) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  setTimeout(() => card.classList.remove('sb-new'), GLOW_MS - elapsed);
}

function highlight(topic) {
  glowing = { id: topicCardId(catalogue, topic), start: Date.now() };
  glow({ scroll: true });
}

grid?.addEventListener('cards:change', () => glow());

// Saves a new choice (after any still saving) and shows it in the bar straight away.
function choose(next, label, added = null) {
  choice = next;
  render();
  busy++;
  saving = saving.then(() => setProfile(structuredClone(next), label)).catch(() => {}).finally(() => {
    busy--;
    if (added) highlight(added);
  });
}

function onChange(event) {
  const { name, value, checked } = event.target;
  if (name === 'topic') {
    choose(withTopic(choice, value, checked), `${checked ? 'Added' : 'Removed'} ${label(value)}`, checked ? value : null);
  } else if (name === 'outlet') {
    choose(withOutlet(choice, value, checked, catalogue), checked ? `Added stories from ${outletName(value)}` : `Stopped stories from ${outletName(value)}`);
  } else if (name === 'region') {
    const from = region;
    region = value;
    choose(withRegion(choice, catalogue, from, value), `Switched to ${regionName(value)} news`);
  } else if (name === 'style') {
    choose({ ...choice, style: value }, value === 'outlets' ? 'Showed news as one card per source' : 'Showed news as one card per topic');
  } else if (name === 'pictures') {
    choose({ ...choice, pictures: value === 'true' }, value === 'true' ? 'Showed pictures with stories' : 'Showed headlines only');
  } else if (name === 'weather') {
    choose({ ...choice, weather: checked }, checked ? 'Showed the weather' : 'Hid the weather');
  } else if (name === 'backdrop') {
    choose({ ...choice, backdrop: checked }, checked ? 'Showed a background photo' : 'Hid the background photo');
  } else if (name === 'density') {
    setDensity(value);
  }
}

container.addEventListener('change', onChange);
container.addEventListener('submit', (event) => event.preventDefault());
container.addEventListener('click', (event) => {
  const pillar = event.target.closest('[data-pillar]');
  if (pillar) return setOpen(pillar.dataset.pillar);
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'done') done();
  else if (action === 'close') setOpen(open);
  else if (action === 'advanced') document.dispatchEvent(new CustomEvent('settings:open'));
});

opener.addEventListener('click', () => {
  if (shown) done();
  else show();
});

addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && shown && open && !document.querySelector('dialog[open]')) setOpen(open);
});

// Undo, redo or a change made elsewhere (a card's ×, Settings): show the page's choices.
document.addEventListener('history:change', () => {
  if (!shown || busy) return;
  sync();
  render();
});

// "Edit topics and sources…" in Settings.
document.addEventListener('setup:open', () => show({ pillar: 'news' }));

opener.hidden = false;
if (location.pathname === PATH) {
  history.replaceState(null, '', `/${location.search}`);
  show({ pillar: 'news' });
} else if (welcoming() && document.body.dataset.tab === 'home') {
  show();
} else {
  root.classList.remove('setup-pending');
}
