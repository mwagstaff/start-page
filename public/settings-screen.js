// The Settings screen, a page of its own at /settings: choose how dense the page is, show or
// hide cards, change their order (arrows, or drag the handle) and number of stories, choose
// whether cards are fitted to the screen or stay in the columns they were put in, show
// temperatures in °C or °F (or whichever is usual where you are), add your
// own RSS or Atom feeds, and export or import the settings as a file. Changes apply straight
// away and are saved in this browser (see settings.js); no account needed. It's the
// "Advanced settings" of the setup bar (setup-bar.js), which opens it with a `settings:open`
// event; "Edit topics and sources" goes back to the bar. Every change can be undone, or
// rewound in History (undo.js), except "Start over", which clears everything and goes back to
// the suggested page (start-over.js).
// While it's open the address is /settings, so it can be bookmarked or shared, and a page
// loaded at /settings opens it straight away. Done, Escape or Back closes it.

import { escapeHtml } from './cards.js';
import { addCustomFeed, arrangement, currentFeeds, currentSettings, fetchCatalogue, fetchFeeds, removeCustomFeed, replaceSettings, setArrange, setDensity, setFill, setSolid, setTabCards, setTemperature, tabCards, widgetFor } from './page.js';
import { unitForLocale } from './forecast.js';
import { openHistory } from './undo.js';
import { askStartOver } from './start-over.js';
import { DENSITIES, MAX_CARD_ITEMS, MAX_CUSTOM_FEEDS, moveCard, stepCard, validSettings } from './settings.js';

const PATH = '/settings';
const opener = document.querySelector('.customise-open'); // focus goes back there on closing
let dialog = null;
let cards = []; // this tab's cards in the screen's order, hidden ones included
let pushed = false; // opening added /settings to the history, so closing goes back over it

const DENSITY_HINTS = {
  spacious: 'More of the photo',
  balanced: 'In between',
  compact: 'Most stories',
};

function build() {
  dialog = document.createElement('dialog');
  dialog.className = 'settings-screen';
  dialog.setAttribute('aria-labelledby', 'settings-title');
  dialog.innerHTML = `
    <div class="settings-content">
      <header class="settings-head">
        <h1 id="settings-title">Advanced settings</h1>
        <p class="settings-saved">Changes are saved automatically in this browser.</p>
        <p class="settings-status" role="status"></p>
        <button type="button" data-action="close" class="primary">Done<kbd aria-hidden="true">Esc</kbd></button>
      </header>
      <div class="settings-columns">
        <div class="settings-side">
          <section class="settings-section settings-link" aria-labelledby="settings-topics-title">
            <h2 id="settings-topics-title">Topics and sources</h2>
            <p class="settings-hint">Change your region, topics, news outlets, weather and background photo.</p>
            <div class="settings-buttons">
              <button type="button" data-action="setup">Edit topics and sources…</button>
            </div>
          </section>
          <section class="settings-section settings-cards" aria-labelledby="settings-cards-title">
            <h2 id="settings-cards-title">Cards</h2>
            <p class="settings-hint">Choose which cards to show and drag them into order. A story that fits more than one card appears in the highest one.</p>
            <ol class="card-list"></ol>
            <form class="add-feed">
              <label for="add-feed-url">Add an RSS or Atom feed</label>
              <div class="add-feed-row">
                <input id="add-feed-url" type="text" inputmode="url" spellcheck="false" placeholder="https://example.com/feed.xml" autocomplete="off" required>
                <button type="submit">Add feed</button>
              </div>
            </form>
          </section>
        </div>
        <div class="settings-side">
          <section class="settings-section" aria-labelledby="settings-layout-title">
            <h2 id="settings-layout-title">Layout</h2>
            <fieldset class="density">
              <legend>Density</legend>
              <div class="density-options">
                ${DENSITIES.map((density) => `<label><input type="radio" name="density" value="${density}" data-field="density"><span>${density[0].toUpperCase()}${density.slice(1)}<small>${DENSITY_HINTS[density] ?? ''}</small></span></label>`).join('')}
              </div>
            </fieldset>
            <label class="arrange-toggle">
              <input type="checkbox" data-field="arrange">
              <span>Auto-arrange cards<small>Balances the columns to keep the page short. Dragging a card turns this off.</small></span>
            </label>
            <label class="arrange-toggle">
              <input type="checkbox" data-field="fill">
              <span>Fill each column<small>Adds or removes stories so every column reaches the bottom of the screen.</small></span>
            </label>
            <label class="arrange-toggle">
              <input type="checkbox" data-field="solid">
              <span>Solid cards<small>Hides the background photo behind the cards.</small></span>
            </label>
          </section>
          <section class="settings-section" aria-labelledby="settings-weather-title">
            <h2 id="settings-weather-title">Weather</h2>
            <fieldset class="density">
              <legend>Temperature</legend>
              <div class="density-options">
                <label><input type="radio" name="temperature" value="" data-field="temperature"><span>Automatic<small>°${unitForLocale(navigator.language)} for your region</small></span></label>
                <label><input type="radio" name="temperature" value="C" data-field="temperature"><span>Celsius<small>°C</small></span></label>
                <label><input type="radio" name="temperature" value="F" data-field="temperature"><span>Fahrenheit<small>°F</small></span></label>
              </div>
            </fieldset>
          </section>
          <section class="settings-section" aria-labelledby="settings-backup-title">
            <h2 id="settings-backup-title">Backup and history</h2>
            <p class="settings-hint">Export your settings to a file to use them in another browser. History lets you undo any change.</p>
            <div class="settings-buttons">
              <button type="button" data-action="export">Export</button>
              <button type="button" data-action="import">Import</button>
              <input type="file" accept="application/json,.json" hidden>
              <button type="button" data-action="history">History…</button>
            </div>
          </section>
          <section class="settings-section" aria-labelledby="settings-reset-title">
            <h2 id="settings-reset-title">Reset</h2>
            <p class="settings-hint"><strong>Reset cards</strong> brings back the default cards and removes feeds you added. <strong>Start over</strong> clears everything and sets the page up from scratch.</p>
            <div class="settings-buttons">
              <button type="button" data-action="reset">Reset cards</button>
              <button type="button" data-action="start-over" class="danger-outline">Start over…</button>
            </div>
          </section>
        </div>
      </div>
    </div>`;
  document.body.append(dialog);

  dialog.addEventListener('click', onClick);
  dialog.addEventListener('change', onChange);
  dialog.addEventListener('close', closed);
  dialog.querySelector('input[type=file]').addEventListener('change', onImport);
  dialog.querySelector('.add-feed').addEventListener('submit', onAddFeed);
  dialog.querySelector('.card-list').addEventListener('pointerdown', startDrag);
}

function status(message) {
  dialog.querySelector('.settings-status').textContent = message;
}

function renderList(focus) {
  const { defaultLimit } = currentFeeds();
  dialog.querySelector('[data-field="arrange"]').checked = arrangement() === 'auto';
  dialog.querySelector('[data-field="fill"]').checked = currentSettings()?.fill !== false;
  dialog.querySelector('[data-field="solid"]').checked = currentSettings()?.solid === true;
  dialog.querySelector(`[data-field="density"][value="${currentSettings()?.density ?? DENSITIES[0]}"]`).checked = true;
  dialog.querySelector(`[data-field="temperature"][value="${currentSettings()?.temperature ?? ''}"]`).checked = true;
  dialog.querySelector('.card-list').innerHTML = cards.map((card, i) => {
    const widget = widgetFor(card.id);
    const title = escapeHtml(widget.title);
    const remove = widget.custom ? `<button type="button" class="card-remove" data-action="remove" aria-label="Remove ${title}" title="Remove this feed">×</button>` : '';
    return `<li class="${card.hidden ? 'is-hidden' : ''}" data-index="${i}">
        <span class="drag-handle" aria-hidden="true" title="Drag to reorder">⠿</span>
        <label class="card-toggle"><input type="checkbox" data-field="shown"${card.hidden ? '' : ' checked'}> ${title}${card.col !== undefined && !card.hidden ? ` <small class="card-column">column ${card.col + 1}</small>` : ''}</label>
        <label class="card-limit">Stories <input type="number" data-field="limit" min="1" max="${MAX_CARD_ITEMS}" value="${card.limit ?? widget.limit ?? defaultLimit}"></label>
        <span class="card-move">
          <button type="button" data-action="up" aria-label="Move ${title} up"${i === 0 ? ' disabled' : ''}>↑</button>
          <button type="button" data-action="down" aria-label="Move ${title} down"${i === cards.length - 1 ? ' disabled' : ''}>↓</button>
        </span>
        ${remove}
      </li>`;
  }).join('');
  // Keep keyboard focus on the control that was used, now in its new row.
  const row = focus && dialog.querySelector(`li[data-index="${focus.index}"]`);
  (row?.querySelector(`[data-action="${focus.action}"]:not(:disabled)`) ?? row?.querySelector('.card-move button:not(:disabled)'))?.focus();
}

// Only what differs from the card's config is saved, so later config changes still apply.
function save() {
  setTabCards(cards.map(({ id, hidden, limit, col }) => ({
    id,
    ...(hidden && { hidden: true }),
    ...(limit && limit !== widgetFor(id).limit && { limit }),
    ...(col !== undefined && { col }),
  })));
  status('');
}

async function onClick(event) {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const index = Number(button.closest('li')?.dataset.index);
  switch (button.dataset.action) {
    case 'up':
    case 'down': {
      const step = button.dataset.action === 'up' ? -1 : 1;
      const { id } = cards[index];
      cards = stepCard(cards, index, step);
      save();
      renderList({ index: cards.findIndex((card) => card.id === id), action: button.dataset.action });
      break;
    }
    case 'remove': {
      const { title } = widgetFor(cards[index].id);
      removeCustomFeed(cards[index].id);
      cards = tabCards();
      renderList();
      status(`Removed ${title}.`);
      break;
    }
    case 'export':
      exportSettings();
      break;
    case 'import':
      dialog.querySelector('input[type=file]').click();
      break;
    case 'reset': {
      // Back to the default page, without asking about topics again.
      const { profile, tabs, ...rest } = currentSettings() ?? {};
      await replaceSettings({ v: 1, custom: [], ...rest, tabs: {}, onboarded: true }, 'Reset to the default cards');
      cards = tabCards();
      renderList();
      status('Default cards restored.');
      break;
    }
    case 'setup':
      dialog.close();
      document.dispatchEvent(new CustomEvent('setup:open'));
      break;
    case 'history':
      openHistory();
      break;
    case 'start-over':
      askStartOver({ onExport: exportSettings });
      break;
    case 'close':
      dialog.close();
      break;
  }
}

function onChange(event) {
  const field = event.target.dataset.field;
  if (!field) return;
  if (field === 'arrange') {
    setArrange(event.target.checked ? 'auto' : 'manual');
    cards = tabCards();
    renderList();
    status(event.target.checked ? 'Auto-arrange is on.' : 'Auto-arrange is off. Cards stay where you put them.');
    return;
  }
  if (field === 'fill') {
    setFill(event.target.checked);
    status(event.target.checked ? 'Columns now fill the screen.' : 'Each card shows its set number of stories.');
    return;
  }
  if (field === 'density') {
    setDensity(event.target.value);
    status(`Density set to ${event.target.value}.`);
    return;
  }
  if (field === 'temperature') {
    setTemperature(event.target.value || null);
    status(event.target.value ? `Temperatures are in °${event.target.value}.` : `Temperatures follow your region (°${unitForLocale(navigator.language)}).`);
    return;
  }
  if (field === 'solid') {
    setSolid(event.target.checked);
    status(event.target.checked ? 'Solid cards are on.' : 'Solid cards are off.');
    return;
  }
  const index = Number(event.target.closest('li').dataset.index);
  if (field === 'shown') {
    cards[index] = { ...cards[index], hidden: !event.target.checked };
    event.target.closest('li').classList.toggle('is-hidden', !event.target.checked);
  } else {
    const limit = Math.round(Number(event.target.value));
    if (!(limit >= 1 && limit <= MAX_CARD_ITEMS)) {
      status(`Choose between 1 and ${MAX_CARD_ITEMS} stories.`);
      return;
    }
    cards[index] = { ...cards[index], limit };
  }
  save();
}

// Drag a row by its handle (mouse or touch): the row follows the pointer through the list,
// and the new order is saved when it's dropped.
function startDrag(event) {
  const handle = event.target.closest('.drag-handle');
  if (!handle || event.button > 0) return;
  event.preventDefault();
  const list = dialog.querySelector('.card-list');
  const row = handle.closest('li');
  const from = Number(row.dataset.index);
  row.classList.add('is-dragging');
  // Captured on the list rather than the handle: the row (and its handle) is moved in the DOM as it's
  // dragged, and moving an element releases its capture, which would end the drag after every step.
  list.setPointerCapture(event.pointerId);

  const move = (e) => {
    if (e.pointerId !== event.pointerId) return;
    const before = [...list.children].find((li) => {
      if (li === row) return false;
      const box = li.getBoundingClientRect();
      return e.clientY < box.top + box.height / 2;
    });
    if (before !== row.nextElementSibling) list.insertBefore(row, before ?? null);
  };
  // Listened for on the whole document (and on losing the capture), so a drop anywhere ends the drag.
  let ended = false;
  const end = (e) => {
    if (ended || e.pointerId !== event.pointerId) return;
    ended = true;
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', end);
    document.removeEventListener('pointercancel', end);
    list.removeEventListener('lostpointercapture', end);
    if (e.type !== 'pointercancel') move(e); // the browser may report losing the capture just before the drop
    row.classList.remove('is-dragging');
    const to = [...list.children].indexOf(row);
    if (to !== from) {
      cards = moveCard(cards, from, to);
      save();
    }
    renderList();
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', end);
  document.addEventListener('pointercancel', end);
  list.addEventListener('lostpointercapture', end);
}

async function onAddFeed(event) {
  event.preventDefault();
  const input = event.target.querySelector('input');
  const button = event.target.querySelector('button');
  let url = input.value.trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  if ((currentSettings()?.custom?.length ?? 0) >= MAX_CUSTOM_FEEDS) {
    status(`You can add up to ${MAX_CUSTOM_FEEDS} feeds.`);
    return;
  }
  button.disabled = true;
  status('Loading the feed…');
  const error = await addCustomFeed(url);
  button.disabled = false;
  if (error) {
    status(error);
    input.focus();
    return;
  }
  input.value = '';
  cards = tabCards();
  renderList();
  status(`Added ${widgetFor(cards[0].id).title} to the top of the list.`);
}

function exportSettings() {
  if (!currentSettings()) save(); // export the layout on screen, even if it's the default
  const blob = new Blob([`${JSON.stringify(currentSettings(), null, 2)}\n`], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'tab1.net-settings.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  status('Exported to tab1.net-settings.json.');
}

async function onImport(event) {
  const [file] = event.target.files;
  event.target.value = '';
  if (!file) return;
  let settings = null;
  try {
    settings = file.size < 100_000 ? validSettings(JSON.parse(await file.text())) : null;
  } catch {}
  if (!settings) {
    status("That file isn't a Start settings export.");
    return;
  }
  await replaceSettings(settings, `Imported ${file.name}`);
  cards = tabCards();
  renderList();
  status(`Imported ${file.name}.`);
}

const isSettingsPath = () => location.pathname === PATH;

async function open() {
  if (dialog?.open) return;
  if (!currentFeeds() && !(await fetchFeeds())) return;
  await fetchCatalogue(); // so the cards made from topics are listed
  if (!dialog) build();
  cards = tabCards();
  status('');
  renderList();
  dialog.showModal();
  dialog.querySelector('.settings-content').scrollTop = 0;
  if (!isSettingsPath()) {
    history.pushState(null, '', PATH);
    pushed = true;
  }
}

// However it closed (Done, Escape or Back), put the address back.
function closed() {
  if (isSettingsPath()) {
    if (pushed) history.back();
    else history.replaceState(null, '', `/${location.search}${location.hash}`);
  }
  pushed = false;
  opener?.focus();
}

// Undo, redo or rewind while the screen is open: show the page as it is now.
document.addEventListener('history:change', ({ detail: { type } }) => {
  if (!dialog?.open || type === 'change' || type === 'clear') return;
  cards = tabCards();
  renderList();
});

// Back and Forward, or /settings reached without reloading.
addEventListener('popstate', () => {
  if (isSettingsPath()) open();
  else if (dialog?.open) {
    pushed = false;
    dialog.close();
  }
});

// "Advanced settings" in the setup bar.
document.addEventListener('settings:open', open);

if (isSettingsPath()) open();
