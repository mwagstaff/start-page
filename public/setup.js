// The setup screen, a page of its own at /settings/topics-and-sources: a reader picks their
// region, topics and news sources, and how the page looks. It opens by itself on a first
// visit (over the default page, so skipping leaves a good page behind it) and from Settings
// later, on top of Settings, which Back, Escape or "← Settings" returns to (opening Settings
// if the page was loaded at this address). While it's open the address stays here, so it
// can be bookmarked or shared, and a page loaded at it opens it straight away. Everything starts with sensible choices, so "Build my page" alone gives a good page.

import { escapeHtml } from './cards.js';
import { currentSettings, fetchCatalogue, setProfile, skipSetup } from './page.js';
import { STARTING_OVER_KEY } from './settings.js';
import { defaultProfile, guessRegion, profileCards, regionOutlets, regionTopics } from './topics.js';

const PATH = '/settings/topics-and-sources';
let dialog = null;
let catalogue = null;
let region = 'uk';
let choice = null; // the profile being edited
let touched = { outlets: false, topics: false }; // has the reader changed these by hand?
let toSettings = false; // closing goes to Settings (any page already set up), not the page itself
let pushed = false; // opening added this address to the history, so closing goes back over it
let saved = false; // closed by saving, rather than skipping or going back

const REGION_LABELS = { uk: 'UK', us: 'US', both: 'UK and US' };

function build() {
  dialog = document.createElement('dialog');
  dialog.className = 'setup-screen';
  dialog.setAttribute('aria-labelledby', 'setup-title');
  dialog.innerHTML = `
    <form class="settings-content setup-form">
      <header class="settings-head">
        <button type="button" data-action="back" class="settings-back">← Settings</button>
        <h1 id="setup-title"></h1>
        <p class="setup-intro"></p>
        <button type="button" data-action="skip" class="setup-skip">Skip for now</button>
        <button type="submit" class="primary"></button>
      </header>
      <div class="settings-columns">
        <div class="settings-side">
          <section class="settings-section" aria-labelledby="setup-topics-title">
            <h2 id="setup-topics-title">Topics</h2>
            <p class="settings-hint">Choose the subjects you want to follow.</p>
            <div class="chips" data-list="news" role="group" aria-label="News topics"></div>
            <div class="chips" data-list="interests" role="group" aria-label="Interests"></div>
          </section>
          <section class="settings-section" aria-labelledby="setup-sources-title">
            <h2 id="setup-sources-title">News sources</h2>
            <p class="settings-hint">Stories for news topics, like Politics and World, come from the outlets you choose here.</p>
            <div class="chips" data-list="outlets" role="group" aria-labelledby="setup-sources-title"></div>
            <p class="setup-warning" role="status"></p>
          </section>
        </div>
        <div class="settings-side">
          <section class="settings-section" aria-labelledby="setup-region-title">
            <h2 id="setup-region-title">Region</h2>
            <p class="settings-hint">Decides which topics and outlets are listed.</p>
            <div class="segmented" role="radiogroup" aria-labelledby="setup-region-title">
              ${Object.entries(REGION_LABELS).map(([value, label]) => `<label><input type="radio" name="region" value="${value}"><span>${label}</span></label>`).join('')}
            </div>
          </section>
          <section class="settings-section setup-options" aria-labelledby="setup-look-title">
            <h2 id="setup-look-title">Appearance</h2>
            <div class="setup-option">
              <span class="setup-option-label" id="setup-style">Cards</span>
              <div class="segmented" role="radiogroup" aria-labelledby="setup-style">
                <label><input type="radio" name="style" value="topics"><span>One per topic</span></label>
                <label><input type="radio" name="style" value="outlets"><span>One per source</span></label>
              </div>
            </div>
            <div class="setup-option">
              <span class="setup-option-label" id="setup-pictures">Stories</span>
              <div class="segmented" role="radiogroup" aria-labelledby="setup-pictures">
                <label><input type="radio" name="pictures" value="true"><span>With pictures</span></label>
                <label><input type="radio" name="pictures" value="false"><span>Headlines only</span></label>
              </div>
            </div>
            <label class="setup-check"><input type="checkbox" name="weather"> Show the weather in the top bar</label>
            <label class="setup-check"><input type="checkbox" name="backdrop"> Show a new background photo each day</label>
          </section>
        </div>
      </div>
    </form>`;
  document.body.append(dialog);

  const form = dialog.querySelector('form');
  form.addEventListener('change', onChange);
  form.addEventListener('submit', onSubmit);
  dialog.querySelector('[data-action="skip"]').addEventListener('click', skip);
  dialog.querySelector('[data-action="back"]').addEventListener('click', skip);
  // Escape counts as skipping, so a first-time visitor isn't asked again.
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    skip();
  });
  dialog.addEventListener('close', closed);
}

// After "Start over" the page is blank behind the setup screen; once it closes (built or
// skipped), the cards show again.
function endStartingOver() {
  document.documentElement.classList.remove('starting-over');
  try {
    sessionStorage.removeItem(STARTING_OVER_KEY);
  } catch {}
}

function chip(name, id, label, checked, extra = '') {
  return `<label class="chip"><input type="checkbox" name="${name}" value="${escapeHtml(id)}"${checked ? ' checked' : ''}><span>${escapeHtml(label)}${extra}</span></label>`;
}

function render() {
  const form = dialog.querySelector('form');
  form.elements.region.value = region;
  const topics = regionTopics(catalogue, region);
  const isNews = (id) => Boolean(catalogue.topics[id].section);
  const topicChip = (id) => chip('topic', id, catalogue.topics[id].label, choice.topics.includes(id));
  form.querySelector('[data-list="news"]').innerHTML = topics.filter(isNews).map(topicChip).join('');
  form.querySelector('[data-list="interests"]').innerHTML = topics.filter((id) => !isNews(id)).map(topicChip).join('');
  form.querySelector('[data-list="outlets"]').innerHTML = regionOutlets(catalogue, region).map((id) => {
    const outlet = catalogue.outlets[id];
    const paywall = outlet.paywall ? ` <small class="paywall" title="${outlet.paywall === 'hard' ? 'Most stories need a subscription' : 'Some stories need a subscription'}">paywall</small>` : '';
    return chip('outlet', id, outlet.name, choice.outlets.includes(id), paywall);
  }).join('');
  form.elements.style.value = choice.style;
  form.elements.pictures.value = String(choice.pictures);
  form.elements.weather.checked = choice.weather;
  form.elements.backdrop.checked = choice.backdrop;
  update();
}

// The button says how many cards the choices make, and there's a note if news topics have
// no sources to draw on.
function update() {
  const count = profileCards(choice, catalogue).length;
  const button = dialog.querySelector('button[type="submit"]');
  const cards = `${count} card${count === 1 ? '' : 's'}`;
  button.textContent = count ? `${currentSettings()?.onboarded ? 'Save' : 'Build my page'} · ${cards}` : 'Choose a topic or source';
  button.disabled = !count;
  const newsTopics = choice.topics.filter((id) => catalogue.topics[id]?.section);
  dialog.querySelector('.setup-warning').textContent = newsTopics.length && !choice.outlets.length
    ? 'Choose at least one source for your news topics.'
    : '';
}

function onChange(event) {
  const { name, value, checked } = event.target;
  if (name === 'region') {
    region = value;
    // Swap in the new region's defaults unless the reader has picked their own, and drop
    // choices the region no longer shows.
    const defaults = defaultProfile(catalogue, region);
    const outlets = new Set(regionOutlets(catalogue, region));
    const topics = new Set(regionTopics(catalogue, region));
    choice.outlets = touched.outlets ? choice.outlets.filter((id) => outlets.has(id)) : defaults.outlets;
    choice.topics = touched.topics ? choice.topics.filter((id) => topics.has(id)) : defaults.topics;
    render();
    return;
  }
  if (name === 'topic' || name === 'outlet') {
    const key = `${name}s`;
    touched[key] = true;
    choice[key] = checked ? [...choice[key], value] : choice[key].filter((id) => id !== value);
    // Keep the catalogue's order, which is the order cards are first laid out in.
    const order = Object.keys(catalogue[key]);
    choice[key].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  } else if (name === 'style') {
    choice.style = value;
  } else if (name === 'pictures') {
    choice.pictures = value === 'true';
  } else if (name === 'weather' || name === 'backdrop') {
    choice[name] = checked;
  }
  update();
}

async function onSubmit(event) {
  event.preventDefault();
  const button = dialog.querySelector('button[type="submit"]');
  button.disabled = true;
  button.textContent = 'Building…';
  await setProfile({ ...choice });
  saved = true;
  dialog.close();
}

function skip() {
  if (!currentSettings()?.onboarded) skipSetup();
  dialog.close();
}

// The region a saved profile's sources come from: one region, or both.
function profileRegion(profile) {
  const regions = new Set(profile.outlets.map((id) => catalogue.outlets[id]?.region).filter(Boolean));
  return regions.size === 1 ? [...regions][0] : regions.size ? 'both' : guessRegion(Intl.DateTimeFormat().resolvedOptions().timeZone);
}

// The header: first visit, or changing a page that's already set up (from Settings or a link).
function renderHead() {
  const onboarded = Boolean(currentSettings()?.onboarded);
  dialog.querySelector('#setup-title').textContent = onboarded ? 'Topics and sources' : 'Set up your page';
  dialog.querySelector('.setup-intro').textContent = onboarded
    ? 'Changes apply when you save. Cards you’ve already arranged keep their place.'
    : 'Choose what you’d like to read. You can change this any time in Settings.';
  dialog.querySelector('.settings-back').hidden = !onboarded;
  dialog.querySelector('.setup-skip').hidden = onboarded;
}

export async function openSetup() {
  if (dialog?.open) return true;
  catalogue = await fetchCatalogue();
  if (!catalogue) {
    endStartingOver(); // don't leave a blank page with nothing over it
    return false;
  }
  if (!dialog) build();
  toSettings = Boolean(currentSettings()?.onboarded);
  saved = false;
  const profile = currentSettings()?.profile;
  region = profile ? profileRegion(profile) : guessRegion(Intl.DateTimeFormat().resolvedOptions().timeZone);
  choice = profile ? { ...profile, outlets: [...profile.outlets], topics: [...profile.topics] } : defaultProfile(catalogue, region);
  touched = { outlets: Boolean(profile), topics: Boolean(profile) };
  renderHead();
  render();
  dialog.showModal();
  dialog.querySelector('.settings-content').scrollTop = 0;
  if (location.pathname !== PATH) {
    history.pushState(null, '', PATH);
    pushed = true;
  }
  return true;
}

// However it closed, put the address back and tell Settings whether the page was rebuilt.
// Loaded at this address, there's nothing to go back to: go up to Settings, opening it
// (settings-screen.js listens for popstate), or to the page itself on a first visit.
function closed() {
  endStartingOver();
  if (location.pathname === PATH) {
    if (pushed) history.back();
    else {
      history.replaceState(null, '', toSettings ? '/settings' : `/${location.search}`);
      if (toSettings) dispatchEvent(new PopStateEvent('popstate'));
    }
  }
  pushed = false;
  document.dispatchEvent(new CustomEvent('setup:close', { detail: { saved } }));
}

// Back and Forward, or this address reached without reloading. Going back counts as skipping.
addEventListener('popstate', () => {
  if (location.pathname === PATH) openSetup();
  else if (dialog?.open) {
    pushed = false;
    skip();
  }
});

// A page loaded at this address, or a first visit: no settings saved in this browser at all.
// A shared /settings link opens Settings instead (settings-screen.js).
if (location.pathname === PATH || (!currentSettings() && document.body.dataset.tab === 'home' && !location.pathname.startsWith('/settings'))) openSetup();
