// The small × in each card's top-right corner takes the card off the page, after asking.
// Nothing is deleted: the card stays in Customise to tick again, and the change can be
// undone or rewound (undo.js). The buttons are in every card's markup (cards.js) but only
// show once this script has run, since without it they'd do nothing.

import { escapeHtml } from './cards.js';
import { hideCard, widgetFor, currentFeeds, fetchFeeds } from './page.js';
import { isMac } from './undo.js';

const grid = document.querySelector('.grid');
let dialog = null;
let target = null; // the card being asked about

// Clock with an arrow running backwards, as on the History button.
const HISTORY_ICON = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2.6 8a5.4 5.4 0 1 0 1.6-3.8"/><path d="M2.4 2.6v2.6H5"/><path d="M8 5.2V8l2 1.3"/></svg>';
const CUSTOMISE_ICON = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M2.5 4h11M2.5 8h11M2.5 12h11"/><circle cx="5.5" cy="4" r="1.6" fill="currentColor"/><circle cx="10.5" cy="8" r="1.6" fill="currentColor"/><circle cx="7" cy="12" r="1.6" fill="currentColor"/></svg>';

function build() {
  dialog = document.createElement('dialog');
  dialog.className = 'customise remove-dialog';
  dialog.setAttribute('aria-labelledby', 'remove-title');
  dialog.setAttribute('aria-describedby', 'remove-about');
  document.body.append(dialog);
  dialog.addEventListener('click', (event) => {
    const action = event.target.closest('button[data-action]')?.dataset.action;
    if (action === 'remove') confirm();
    else if (action === 'cancel') dialog.close();
  });
  dialog.addEventListener('pointerdown', (event) => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => { target?.querySelector('.card-close')?.focus({ preventScroll: true }); target = null; });
}

// A miniature of the card: its title and first few headlines.
function preview(card, title) {
  const headlines = [...card.querySelectorAll('.items > li')].slice(0, 3)
    .map((item) => item.querySelector('a')?.textContent.trim())
    .filter(Boolean);
  const body = headlines.length
    ? `<ul>${headlines.map((text) => `<li>${escapeHtml(text)}</li>`).join('')}</ul>`
    : '<p>No stories showing right now.</p>';
  return `<div class="remove-preview" aria-hidden="true"><strong>${escapeHtml(title)}</strong>${body}</div>`;
}

function ask(card) {
  if (!dialog) build();
  target = card;
  const title = widgetFor(card.id)?.title ?? card.querySelector('h2')?.textContent.trim() ?? 'this card';
  const key = isMac ? '⌘Z' : 'Ctrl+Z';
  dialog.innerHTML = `
    <h2 id="remove-title">Remove “${escapeHtml(title)}”?</h2>
    ${preview(card, title)}
    <div id="remove-about">
      <p class="remove-lead">It’s only taken off this page. Nothing is deleted, and you can bring it back any time:</p>
      <ul class="remove-ways">
        <li><kbd>${key}</kbd><span><strong>Undo</strong> straight away, or press Undo in the message that appears.</span></li>
        <li><span class="remove-icon">${HISTORY_ICON}</span><span><strong>History</strong> in the top bar lists every change, so you can rewind to any point.</span></li>
        <li><span class="remove-icon">${CUSTOMISE_ICON}</span><span><strong>Customise</strong> in the top bar: tick “${escapeHtml(title)}” to show it again.</span></li>
      </ul>
    </div>
    <div class="customise-actions">
      <button type="button" data-action="cancel">Cancel</button>
      <button type="button" data-action="remove" class="primary" autofocus>Remove card</button>
    </div>`;
  dialog.showModal();
}

async function confirm() {
  const card = target;
  dialog.close();
  if (!card) return;
  if (!currentFeeds() && !(await fetchFeeds())) return;
  await hideCard(card.id);
  // The card has gone, so focus the next one's close button, or the page.
  document.querySelector('.grid .card .card-close')?.focus({ preventScroll: true });
}

if (grid) {
  document.documentElement.classList.add('can-remove');
  grid.addEventListener('click', (event) => {
    const button = event.target.closest('.card-close');
    if (!button) return;
    event.preventDefault();
    ask(button.closest('.card'));
  });
}
