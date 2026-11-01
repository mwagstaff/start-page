// The setup screen: one panel where a reader picks their region, topics and news sources,
// and how the page looks. It opens by itself on a first visit (over the default page, so
// skipping leaves a good page behind it) and from Customise later. Everything starts with
// sensible choices, so "Build my page" alone gives a good page.

import { escapeHtml } from './cards.js';
import { currentSettings, fetchCatalogue, setProfile, skipSetup } from './page.js';
import { defaultProfile, guessRegion, profileCards, regionOutlets, regionTopics } from './topics.js';

let dialog = null;
let catalogue = null;
let region = 'uk';
let choice = null; // the profile being edited
let touched = { outlets: false, topics: false }; // has the reader changed these by hand?

const REGION_LABELS = { uk: 'UK', us: 'US', both: 'Both' };

function build() {
  dialog = document.createElement('dialog');
  dialog.className = 'setup';
  dialog.setAttribute('aria-labelledby', 'setup-title');
  dialog.innerHTML = `
    <form class="setup-form">
      <div class="setup-body">
        <div class="setup-head">
          <h2 id="setup-title">Make this page yours</h2>
          <p>Pick a few things. You can change any of it later in Customise.</p>
        </div>
        <fieldset class="setup-region">
          <legend>Region</legend>
          <div class="segmented">
            ${Object.entries(REGION_LABELS).map(([value, label]) => `<label><input type="radio" name="region" value="${value}"><span>${label}</span></label>`).join('')}
          </div>
        </fieldset>
        <fieldset>
          <legend>Topics</legend>
          <div class="chips" data-list="news"></div>
          <div class="chips" data-list="interests"></div>
        </fieldset>
        <fieldset>
          <legend>News sources</legend>
          <p class="setup-hint">News topics mix stories from the sources you pick.</p>
          <div class="chips" data-list="outlets"></div>
          <p class="setup-warning" role="status"></p>
        </fieldset>
        <fieldset class="setup-options">
          <legend>Your page</legend>
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
              <label><input type="radio" name="pictures" value="false"><span>Compact</span></label>
            </div>
          </div>
          <label class="setup-check"><input type="checkbox" name="weather"> Weather in the header</label>
          <label class="setup-check"><input type="checkbox" name="backdrop"> A new photo behind the page each day</label>
        </fieldset>
      </div>
      <div class="setup-actions">
        <button type="button" data-action="skip">Skip</button>
        <button type="submit" class="primary"></button>
      </div>
    </form>`;
  document.body.append(dialog);

  const form = dialog.querySelector('form');
  form.addEventListener('change', onChange);
  form.addEventListener('submit', onSubmit);
  dialog.querySelector('[data-action="skip"]').addEventListener('click', skip);
  // Escape counts as skipping, so a first-time visitor isn't asked again.
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    skip();
  });
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
  button.textContent = count ? `Build my page · ${count} card${count === 1 ? '' : 's'}` : 'Pick a topic or source';
  button.disabled = !count;
  const newsTopics = choice.topics.filter((id) => catalogue.topics[id]?.section);
  dialog.querySelector('.setup-warning').textContent = newsTopics.length && !choice.outlets.length
    ? 'Pick at least one source for your news topics.'
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

export async function openSetup() {
  catalogue = await fetchCatalogue();
  if (!catalogue) return false;
  if (!dialog) build();
  const saved = currentSettings()?.profile;
  region = saved ? profileRegion(saved) : guessRegion(Intl.DateTimeFormat().resolvedOptions().timeZone);
  choice = saved ? { ...saved, outlets: [...saved.outlets], topics: [...saved.topics] } : defaultProfile(catalogue, region);
  touched = { outlets: Boolean(saved), topics: Boolean(saved) };
  render();
  dialog.showModal();
  return true;
}

// First visit: no settings saved in this browser at all.
if (!currentSettings() && document.body.dataset.tab === 'home') openSetup();
