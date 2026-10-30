// The Customise dialog: show or hide cards, change their order (arrows, or drag the
// handle) and number of items, choose whether cards are fitted to the screen or stay in the
// columns they were put in, add your own RSS or Atom feeds, and export or import the
// settings as a file. Changes apply straight away and are saved in
// this browser (see settings.js); no account needed.

import { escapeHtml } from './cards.js';
import { addCustomFeed, arrangement, currentFeeds, currentSettings, fetchFeeds, removeCustomFeed, replaceSettings, setArrange, setTabCards, tabCards, widgetFor } from './page.js';
import { MAX_CARD_ITEMS, MAX_CUSTOM_FEEDS, moveCard, stepCard, validSettings } from './settings.js';

const opener = document.querySelector('.customise-open');
let dialog = null;
let cards = []; // this tab's cards in the dialog's order, hidden ones included

function build() {
  dialog = document.createElement('dialog');
  dialog.className = 'customise';
  dialog.setAttribute('aria-labelledby', 'customise-title');
  dialog.innerHTML = `
    <div class="customise-head">
      <h2 id="customise-title">Customise</h2>
      <p>Pick the cards you want, in the order you want them. Cards higher up get first claim on a story that's in more than one. You can also drag cards around the page itself. Changes are saved in this browser.</p>
    </div>
    <label class="arrange-toggle">
      <input type="checkbox" data-field="arrange">
      <span>Fit cards to the screen<small>Arranges the columns so the page is as short as it can be. Turn off to keep cards in the columns you drag them to; moving a card turns it off.</small></span>
    </label>
    <ol class="card-list"></ol>
    <form class="add-feed">
      <label for="add-feed-url">Add a feed</label>
      <div class="add-feed-row">
        <input id="add-feed-url" type="text" inputmode="url" spellcheck="false" placeholder="https://example.com/feed.xml" autocomplete="off" required>
        <button type="submit">Add</button>
      </div>
    </form>
    <p class="customise-status" role="status"></p>
    <div class="customise-actions">
      <button type="button" data-action="export">Export</button>
      <button type="button" data-action="import">Import</button>
      <input type="file" accept="application/json,.json" hidden>
      <button type="button" data-action="reset">Reset to default</button>
      <button type="button" data-action="close" class="primary">Done</button>
    </div>`;
  document.body.append(dialog);

  dialog.addEventListener('click', onClick);
  dialog.addEventListener('change', onChange);
  // Clicking the backdrop outside the panel closes it.
  dialog.addEventListener('pointerdown', (event) => { if (event.target === dialog) dialog.close(); });
  dialog.querySelector('input[type=file]').addEventListener('change', onImport);
  dialog.querySelector('.add-feed').addEventListener('submit', onAddFeed);
  dialog.querySelector('.card-list').addEventListener('pointerdown', startDrag);
}

function status(message) {
  dialog.querySelector('.customise-status').textContent = message;
}

function renderList(focus) {
  const { defaultLimit } = currentFeeds();
  dialog.querySelector('[data-field="arrange"]').checked = arrangement() === 'auto';
  dialog.querySelector('.card-list').innerHTML = cards.map((card, i) => {
    const widget = widgetFor(card.id);
    const title = escapeHtml(widget.title);
    const remove = widget.custom ? `<button type="button" class="card-remove" data-action="remove" aria-label="Remove ${title}" title="Remove this feed">×</button>` : '';
    return `<li class="${card.hidden ? 'is-hidden' : ''}" data-index="${i}">
        <span class="drag-handle" aria-hidden="true" title="Drag to reorder">⠿</span>
        <label class="card-toggle"><input type="checkbox" data-field="shown"${card.hidden ? '' : ' checked'}> ${title}${card.col !== undefined && !card.hidden ? ` <small class="card-column">column ${card.col + 1}</small>` : ''}</label>
        <label class="card-limit">Items <input type="number" data-field="limit" min="1" max="${MAX_CARD_ITEMS}" value="${card.limit ?? widget.limit ?? defaultLimit}"></label>
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

function onClick(event) {
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
    case 'reset':
      setTabCards(null);
      cards = tabCards();
      renderList();
      status('Back to the default cards.');
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
    status(event.target.checked ? 'Cards are fitted to the screen.' : 'Cards stay in the columns they\'re in now.');
    return;
  }
  const index = Number(event.target.closest('li').dataset.index);
  if (field === 'shown') {
    cards[index] = { ...cards[index], hidden: !event.target.checked };
    event.target.closest('li').classList.toggle('is-hidden', !event.target.checked);
  } else {
    const limit = Math.round(Number(event.target.value));
    if (!(limit >= 1 && limit <= MAX_CARD_ITEMS)) {
      status(`Pick between 1 and ${MAX_CARD_ITEMS} items.`);
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
  handle.setPointerCapture(event.pointerId);

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
    handle.removeEventListener('lostpointercapture', end);
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
  handle.addEventListener('lostpointercapture', end);
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
  status(`Added ${widgetFor(cards[0].id).title} at the top.`);
}

function exportSettings() {
  if (!currentSettings()) save(); // export the layout on screen, even if it's the default
  const blob = new Blob([`${JSON.stringify(currentSettings(), null, 2)}\n`], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'start-page-settings.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  status('Settings saved as start-page-settings.json.');
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
  replaceSettings(settings);
  cards = tabCards();
  renderList();
  status(`Imported ${file.name}.`);
}

async function open() {
  if (!currentFeeds() && !(await fetchFeeds())) return;
  if (!dialog) build();
  cards = tabCards();
  status('');
  renderList();
  dialog.showModal();
}

if (opener) {
  opener.hidden = false;
  opener.addEventListener('click', open);
}
