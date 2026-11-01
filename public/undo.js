// Undo, redo and the History dialog. Every change to the page (page.js records them in
// history.js) shows a short message with an Undo button; ⌘Z / Ctrl+Z steps back through
// the changes one at a time and ⇧⌘Z / Ctrl+Y forward again; and History lists them all, so
// the page can be rewound to any point (and forward again, until something new changes).

import { escapeHtml } from './cards.js';
import { canRedo, canUndo, whenLabel } from './history.js';
import { clearHistory, currentHistory, redo, rewindTo, undo } from './page.js';

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const UNDO_KEY = isMac ? '⌘Z' : 'Ctrl+Z';
const REDO_KEY = isMac ? '⇧⌘Z' : 'Ctrl+Y';
const TOAST_MS = 7000;

const opener = document.querySelector('.history-open');
let toast = null;
let toastTimer;
let dialog = null;

// The message at the bottom of the screen. A popover, so it shows above open dialogs too.
function showToast(message, actions) {
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'undo-toast';
    toast.setAttribute('popover', 'manual');
    toast.setAttribute('role', 'status');
    toast.addEventListener('click', (event) => {
      const action = event.target.closest('button[data-action]')?.dataset.action;
      if (action === 'undo') undo();
      else if (action === 'redo') redo();
      else if (action === 'history') openHistory();
      else if (action === 'dismiss') hideToast();
    });
    // Stay while the pointer or focus is on it.
    toast.addEventListener('pointerenter', () => clearTimeout(toastTimer));
    toast.addEventListener('pointerleave', () => { toastTimer = setTimeout(hideToast, TOAST_MS / 2); });
    toast.addEventListener('focusin', () => clearTimeout(toastTimer));
    document.body.append(toast);
  }
  toast.innerHTML = `<span class="undo-toast-text">${message}</span>${actions.map(([action, label, title]) => `<button type="button" data-action="${action}"${title ? ` title="${title}"` : ''}>${label}</button>`).join('')}<button type="button" data-action="dismiss" class="undo-toast-close" aria-label="Dismiss">×</button>`;
  // Hide and show again, so it comes up above a dialog opened since.
  if (toast.matches(':popover-open')) toast.hidePopover();
  toast.showPopover();
  toast.classList.remove('is-leaving');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, TOAST_MS);
}

function hideToast() {
  clearTimeout(toastTimer);
  if (!toast?.matches(':popover-open')) return;
  toast.classList.add('is-leaving');
  setTimeout(() => { if (toast.classList.contains('is-leaving')) toast.hidePopover(); }, 180);
}

function onHistoryChange({ detail: { type, label } }) {
  const history = currentHistory();
  if (dialog?.open) renderHistory();
  updateOpener();
  if (type === 'clear') return;
  const text = escapeHtml(label);
  const undoButton = ['undo', 'Undo', UNDO_KEY];
  const redoButton = ['redo', 'Redo', REDO_KEY];
  const historyButton = ['history', 'History'];
  if (type === 'change') showToast(text, [undoButton, historyButton]);
  else if (type === 'undo') showToast(`Undid <em>${text}</em>`, [...(canUndo(history) ? [undoButton] : []), redoButton, historyButton]);
  else if (type === 'redo') showToast(`Redid <em>${text}</em>`, [undoButton, ...(canRedo(history) ? [redoButton] : []), historyButton]);
  else showToast(`Went back to <em>${text}</em>`, [...(canUndo(history) ? [undoButton] : []), ...(canRedo(history) ? [redoButton] : []), historyButton]);
}

function updateOpener() {
  if (!opener) return;
  const count = currentHistory()?.entries.length ?? 0;
  opener.classList.toggle('has-history', count > 1);
}

// ⌘Z / Ctrl+Z, except in a box with text to undo in, which keeps the browser's own undo.
function onKey(event) {
  if (!(isMac ? event.metaKey : event.ctrlKey) || event.altKey) return;
  const key = event.key.toLowerCase();
  const wantsRedo = (key === 'z' && event.shiftKey) || (!isMac && key === 'y');
  const wantsUndo = key === 'z' && !event.shiftKey;
  if (!wantsUndo && !wantsRedo) return;
  const field = event.target.closest?.('input, textarea, [contenteditable]');
  if (field && !(field.type === 'checkbox' || field.type === 'file') && (field.value || field.isContentEditable)) return;
  const history = currentHistory();
  if (wantsUndo ? !canUndo(history) : !canRedo(history)) return;
  event.preventDefault();
  (wantsUndo ? undo : redo)();
}

function build() {
  dialog = document.createElement('dialog');
  dialog.className = 'customise history-dialog';
  dialog.setAttribute('aria-labelledby', 'history-title');
  dialog.innerHTML = `
    <div class="customise-head">
      <h2 id="history-title">History</h2>
      <p>Every change to your page, newest first. Pick any point to put the page back as it was then; later changes stay listed until you make a new one, so you can go forward again. Use <kbd>${UNDO_KEY}</kbd> and <kbd>${REDO_KEY}</kbd> to step one change at a time.</p>
    </div>
    <ol class="history-list"></ol>
    <div class="customise-actions">
      <button type="button" data-action="undo">Undo</button>
      <button type="button" data-action="redo">Redo</button>
      <button type="button" data-action="clear">Clear history</button>
      <button type="button" data-action="close" class="primary">Done</button>
    </div>`;
  document.body.append(dialog);
  dialog.addEventListener('pointerdown', (event) => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    switch (button.dataset.action) {
      case 'undo': await undo(); break;
      case 'redo': await redo(); break;
      case 'goto': {
        const index = Number(button.closest('li').dataset.index);
        await rewindTo(index);
        dialog.querySelector(`li[data-index="${index}"] .history-item`)?.focus();
        break;
      }
      case 'clear':
        if (button.dataset.confirm) {
          clearHistory();
        } else {
          // A second press confirms.
          button.dataset.confirm = 'yes';
          button.textContent = 'Clear all? Press again';
          setTimeout(() => { delete button.dataset.confirm; button.textContent = 'Clear history'; }, 4000);
        }
        break;
      case 'close': dialog.close(); break;
    }
  });
}

function renderHistory() {
  const history = currentHistory();
  const list = dialog.querySelector('.history-list');
  const now = Date.now();
  if (!history || history.entries.length < 2) {
    list.innerHTML = '<li class="history-empty">No changes yet. Remove, move or add cards and each change will be listed here.</li>';
  } else {
    list.innerHTML = history.entries.map((entry, i) => {
      const state = i === history.index ? 'is-current' : i > history.index ? 'is-undone' : '';
      const badge = i === history.index ? '<span class="history-badge">Now</span>' : i > history.index ? '<span class="history-badge">Undone</span>' : '';
      const action = i === history.index ? 'This is how your page looks now' : i > history.index ? 'Redo up to here' : 'Rewind to here';
      return `<li class="${state}" data-index="${i}">
          <button type="button" class="history-item" data-action="goto"${i === history.index ? ' aria-current="step"' : ''} title="${action}">
            <span class="history-dot" aria-hidden="true"></span>
            <span class="history-label">${escapeHtml(entry.label)}</span>
            <time datetime="${new Date(entry.at).toISOString()}">${whenLabel(entry.at, now)}</time>
            ${badge}
          </button>
        </li>`;
    }).reverse().join('');
  }
  dialog.querySelector('[data-action="undo"]').disabled = !canUndo(history);
  dialog.querySelector('[data-action="redo"]').disabled = !canRedo(history);
  dialog.querySelector('[data-action="clear"]').disabled = !history || history.entries.length < 2;
}

export function openHistory() {
  if (!dialog) build();
  renderHistory();
  document.querySelectorAll('dialog[open]').forEach((open) => { if (open !== dialog) open.close(); });
  if (!dialog.open) dialog.showModal();
  hideToast();
  (dialog.querySelector('.is-current .history-item') ?? dialog.querySelector('[data-action="close"]')).focus({ preventScroll: true });
  dialog.querySelector('.is-current')?.scrollIntoView({ block: 'nearest' });
}

document.addEventListener('history:change', onHistoryChange);
document.addEventListener('keydown', onKey);
if (opener) {
  opener.hidden = false;
  opener.addEventListener('click', openHistory);
  updateOpener();
}
