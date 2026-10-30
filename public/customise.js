// The Customise dialog: show or hide cards, change their order and number of items, and
// export or import the settings as a file. Changes apply straight away and are saved in
// this browser (see settings.js); no account needed.

import { escapeHtml } from './cards.js';
import { currentFeeds, currentSettings, fetchFeeds, replaceSettings, setTabCards, tabCards } from './page.js';
import { MAX_CARD_ITEMS, validSettings } from './settings.js';

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
      <p>Pick the cards you want, in the order you want them. Cards higher up get first claim on a story that's in more than one. Changes are saved in this browser.</p>
    </div>
    <ol class="card-list"></ol>
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
}

function status(message) {
  dialog.querySelector('.customise-status').textContent = message;
}

function renderList(focus) {
  const { widgets, defaultLimit } = currentFeeds();
  dialog.querySelector('.card-list').innerHTML = cards.map((card, i) => {
    const widget = widgets[card.id];
    const title = escapeHtml(widget.title);
    return `<li class="${card.hidden ? 'is-hidden' : ''}" data-index="${i}">
        <label class="card-toggle"><input type="checkbox" data-field="shown"${card.hidden ? '' : ' checked'}> ${title}</label>
        <label class="card-limit">Items <input type="number" data-field="limit" min="1" max="${MAX_CARD_ITEMS}" value="${card.limit ?? widget.limit ?? defaultLimit}"></label>
        <span class="card-move">
          <button type="button" data-action="up" aria-label="Move ${title} up"${i === 0 ? ' disabled' : ''}>↑</button>
          <button type="button" data-action="down" aria-label="Move ${title} down"${i === cards.length - 1 ? ' disabled' : ''}>↓</button>
        </span>
      </li>`;
  }).join('');
  // Keep keyboard focus on the control that was used, now in its new row.
  const row = focus && dialog.querySelector(`li[data-index="${focus.index}"]`);
  (row?.querySelector(`[data-action="${focus.action}"]:not(:disabled)`) ?? row?.querySelector('.card-move button:not(:disabled)'))?.focus();
}

// Only what differs from the card's config is saved, so later config changes still apply.
function save() {
  const { widgets } = currentFeeds();
  setTabCards(cards.map(({ id, hidden, limit }) => ({
    id,
    ...(hidden && { hidden: true }),
    ...(limit && limit !== widgets[id].limit && { limit }),
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
      const to = button.dataset.action === 'up' ? index - 1 : index + 1;
      [cards[index], cards[to]] = [cards[to], cards[index]];
      save();
      renderList({ index: to, action: button.dataset.action });
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
