import { currentSettings } from './page.js';
import { cardShortcut, restoredIndex, shortcutCommand, storyShortcut } from './keyboard-shortcuts.js';
import { spatialNeighbor } from './keyboard-navigation.js';

// Ordinary links retain their Tab order and native activation. Keyboard mode only moves
// real focus; it never turns the feed into an ARIA application or a selection widget.
const grid = document.querySelector('.grid');
const search = document.querySelector('.search input');
const active = true;
let enabled = currentSettings()?.shortcuts !== false;
let keyboardInput = false;
let pointerActive = false;
let helpOpen = false;
let hintCardId = null;
const customiseKey = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘.' : 'Ctrl+.';
let last = null;
let pendingFocus = null;
let cardOrder = [];
let returningFrom = null;
let focusSetup = false;
const remembered = new Map();
const resetOnClose = new WeakSet();

const footer = document.createElement('footer');
footer.className = 'keyboard-footer';
footer.setAttribute('aria-label', 'Keyboard help');
footer.hidden = true;
footer.innerHTML = `
  <div class="keyboard-context"><span class="keyboard-mode-label">Keyboard help</span><span class="keyboard-location"></span><button type="button" class="keyboard-help-close" aria-label="Close keyboard help">Close <kbd>?</kbd></button></div>
  <div class="keyboard-commands">
    <span class="keyboard-single"><kbd>1–9</kbd><kbd>0</kbd> Cards</span>
    <span class="keyboard-story-guide keyboard-single" title="C, S and W keep their page actions"><kbd>A</kbd><kbd>B</kbd><kbd>D</kbd> Select story</span>
    <span><kbd>↑</kbd><kbd>↓</kbd> Stories</span><span><kbd>←</kbd><kbd>→</kbd> Cards</span>
    <span><kbd>Enter</kbd> <span class="keyboard-enter-label">Open story</span></span>
    <span class="keyboard-comments keyboard-single"><kbd>C</kbd> Comments</span>
    <span class="keyboard-page-actions"><button type="button" data-keyboard-action="customise"><kbd>${customiseKey}</kbd> Customise</button><button type="button" data-keyboard-action="s"><kbd class="keyboard-single">/</kbd> Search</button><button type="button" data-keyboard-action="w"><kbd class="keyboard-single">W</kbd> Weather</button></span>
  </div>`;
document.body.append(footer);

const visible = (element) => Boolean(element?.isConnected && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden' && !element.closest('[hidden], [inert]'));
const cards = () => [...grid.querySelectorAll('.card')].filter(visible).sort((a, b) => {
  const left = a.getBoundingClientRect();
  const right = b.getBoundingClientRect();
  return Math.abs(left.top - right.top) > 1 ? left.top - right.top : left.left - right.left;
});
const rows = (card) => [...(card?.querySelectorAll('.item') ?? [])].filter(visible);
const headline = (row) => row?.querySelector('.headline');
const comments = (row) => row?.querySelector('.comments-link');
const modalOpen = () => Boolean(document.querySelector('dialog[open]'));
const focusedRow = () => document.activeElement.closest('.item');
const editing = (element) => element.isContentEditable || Boolean(element.closest('input, textarea, select, [role="textbox"], [role="combobox"]'));

function badge(parent, className, key, prepend = false) {
  let element = parent.querySelector(`:scope > .${className}`);
  if (!element) {
    element = document.createElement('kbd');
    element.className = className;
    element.setAttribute('aria-hidden', 'true');
    if (prepend) parent.prepend(element);
    else parent.append(element);
  }
  element.textContent = key ?? '';
  element.hidden = key == null;
  return element;
}

function pageBadges() {
  const customise = document.querySelector('.customise-open');
  if (customise) {
    badge(customise, 'keyboard-page-key', customiseKey).classList.add('keyboard-modifier-key');
    customise.setAttribute('aria-keyshortcuts', 'Meta+. Control+.');
  }
  if (search) {
    badge(search.closest('form'), 'keyboard-page-key', '/');
    if (enabled) search.setAttribute('aria-keyshortcuts', '/');
    else search.removeAttribute('aria-keyshortcuts');
  }
  const weather = document.querySelector('.weather-open');
  if (weather) badge(weather, 'keyboard-page-key', 'W');
  footer.querySelector('[data-keyboard-action="w"]').hidden = !visible(weather);
}

function decorate() {
  // A dialog can make the grid inert or invisible without removing its cards.
  if (modalOpen()) { pageBadges(); reflect(); return; }
  const displayed = cards();
  const ids = displayed.map((card) => card.id);
  // Keep numbers stable while reading, even if a refresh rebalances the columns.
  cardOrder = [...cardOrder.filter((id) => ids.includes(id)), ...ids.filter((id) => !cardOrder.includes(id))];
  for (const card of displayed) {
    const title = card.querySelector('h2');
    card.dataset.keyboardTitle ??= title.textContent.trim();
    title.tabIndex = -1; // an empty card can still be reached and identified
    badge(title, 'keyboard-card-key', cardShortcut(cardOrder.indexOf(card.id)), true);
    const shown = rows(card);
    for (const row of card.querySelectorAll('.item')) {
      const key = storyShortcut(shown.indexOf(row));
      badge(row, 'keyboard-story-key', key?.toUpperCase(), true);
      badge(row, 'keyboard-enter-key', '↵');
      if (comments(row)) badge(row, 'keyboard-comment-key', 'C');
      row.dataset.keyboardKey = key ?? '';
    }
  }
  pageBadges();
  reflect();
}

function bookmark(element = document.activeElement) {
  const card = element.closest('.card');
  if (!card || !grid.contains(card)) return null;
  const row = element.closest('.item');
  return { cardId: card.id, cardIndex: cards().indexOf(card), url: headline(row)?.href, index: Math.max(0, rows(card).indexOf(row)), kind: element.matches('.comments-link') ? 'comments' : row ? 'headline' : 'heading' };
}

function focusStory(row, kind = 'headline', scroll = true) {
  const target = kind === 'comments' ? comments(row) ?? headline(row) : headline(row);
  if (!visible(target)) return;
  target.focus({ preventScroll: true });
  if (scroll) row.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  reflect();
}

function restore(saved = last, scroll = true) {
  const displayed = cards();
  const card = displayed.find((item) => item.id === saved?.cardId) ?? displayed[Math.min(saved?.cardIndex ?? 0, displayed.length - 1)];
  if (!card) { search?.focus({ preventScroll: true }); return; }
  const list = rows(card);
  if (!list.length || saved?.kind === 'heading') {
    card.querySelector('h2').focus({ preventScroll: true });
    if (scroll) card.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    reflect();
    return;
  }
  focusStory(list[restoredIndex(list.map((row) => headline(row).href), saved)], saved?.kind, scroll);
}

function reflect() {
  // Never change link geometry or re-pack cards between pointerdown and click.
  if (pointerActive) return;
  const focus = document.activeElement;
  const saved = bookmark(focus);
  if (saved) { last = saved; remembered.set(saved.cardId, saved); }
  document.body.classList.toggle('keyboard-mode', active);
  document.body.classList.toggle('keyboard-input', keyboardInput);
  document.body.classList.toggle('keyboard-no-characters', !enabled);
  document.body.classList.toggle('keyboard-typing', focus === search);
  const inSetup = Boolean(focus.closest('#setup-bar'));
  document.body.classList.toggle('keyboard-in-controls', inSetup);
  footer.hidden = !helpOpen || modalOpen();
  for (const card of grid.querySelectorAll('.card')) {
    const selected = active && keyboardInput && card.id === saved?.cardId;
    card.classList.toggle('keyboard-card', selected);
    card.classList.toggle('keyboard-hints', active && (keyboardInput || pointerActive) && enabled && card.id === hintCardId);
  }
  for (const row of grid.querySelectorAll('.item')) {
    row.classList.toggle('keyboard-row', active && keyboardInput && row.contains(focus));
    const link = headline(row);
    if (row.closest('.keyboard-card.keyboard-hints') && row.dataset.keyboardKey) link.setAttribute('aria-keyshortcuts', row.dataset.keyboardKey);
    else link.removeAttribute('aria-keyshortcuts');
  }
  const card = focus.closest('.card');
  const row = focusedRow();
  footer.querySelector('.keyboard-story-guide').hidden = !card?.classList.contains('keyboard-hints');
  footer.querySelector('.keyboard-location').textContent = focus === search
    ? 'Search · shortcuts paused · Esc clears selection'
    : inSetup ? 'Customise · ← → controls · ↓ choices · Enter / Space select · Esc resets'
      : card ? `${card.dataset.keyboardTitle} · ${row ? `Story ${rows(card).indexOf(row) + 1} of ${rows(card).length}` : 'No stories available'}`
        : '';
  footer.querySelector('.keyboard-comments').hidden = !comments(row) || !enabled;
  footer.querySelector('.keyboard-enter-label').textContent = focus.matches('.comments-link') ? 'Open comments' : row ? 'Open story' : 'Activate';
}

function enter() {
  keyboardInput = true;
  reflect();
  reserveFooter();
  decorate();
  restore();
}

function pageAction(key) {
  if (key === 's') { search?.focus(); return; }
  if (key === 'customise') {
    const bar = document.querySelector('#setup-bar');
    returningFrom = 'setup';
    focusSetup = true;
    if (bar.hidden) document.querySelector('.customise-open')?.click();
    else { bar.querySelector('button')?.focus(); focusSetup = false; }
  }
  if (key === 'w') {
    const trigger = document.querySelector('.weather-open');
    if (!visible(trigger)) return;
    returningFrom = 'weather';
    trigger.click();
    document.querySelector('.weather-screen[open] .ws-close')?.focus();
    reflect();
  }
}

function resetSelection() {
  pointerActive = false;
  keyboardInput = false;
  helpOpen = false;
  hintCardId = null;
  last = null;
  pendingFocus = null;
  returningFrom = null;
  focusSetup = false;
  remembered.clear();
  document.activeElement?.blur();
  reflect();
  reserveFooter();
}

function onKey(event) {
  const target = event.target;
  const command = shortcutCommand(event, { active, enabled, editing: editing(target) });
  if (command?.type === 'reset') {
    resetSelection();
    // Let an active drag's own Escape handler cancel it.
    if (document.documentElement.classList.contains('is-reordering')) return;
    event.preventDefault();
    for (const dialog of document.querySelectorAll('dialog[open]')) {
      resetOnClose.add(dialog);
      dialog.close();
    }
    const bar = document.querySelector('#setup-bar');
    if (bar && !bar.hidden) document.querySelector('.customise-open')?.click();
    // Closing controls can synchronously return focus to their opener.
    resetSelection();
    return;
  }
  if (!event.isComposing && !['Meta', 'Control', 'Alt', 'Shift'].includes(event.key)) {
    pointerActive = false;
    keyboardInput = true;
    reflect();
  }
  // Other keys remain owned by modal/native controls.
  if (modalOpen() || document.documentElement.classList.contains('is-reordering')) return;
  if (target.closest('#setup-bar')) return; // the bar owns its other navigation keys
  if (!command) return;
  if (command.type === 'help') {
    event.preventDefault();
    helpOpen = !helpOpen;
    reflect();
    return;
  }
  if (command.type === 'page') { event.preventDefault(); pageAction(command.key); return; }
  if (command.type === 'card') {
    const card = cards().find((item) => item.id === cardOrder[command.index]);
    if (card) {
      event.preventDefault();
      hintCardId = card.id;
      restore(remembered.get(card.id) ?? { cardId: card.id });
    }
    return;
  }
  const row = focusedRow();
  const card = document.activeElement.closest('.card');
  if (!card) return;
  if (command.type === 'comments') {
    if (comments(row)) { event.preventDefault(); comments(row).click(); }
    return;
  }
  const list = rows(card);
  let destination;
  if (command.type === 'story' && card.id === hintCardId) destination = list[command.index];
  if (command.type === 'move') {
    const index = list.indexOf(row);
    const up = command.key === 'ArrowUp';
    const down = command.key === 'ArrowDown';
    const horizontal = command.key === 'ArrowLeft' || command.key === 'ArrowRight';
    if (up && index > 0) destination = list[index - 1];
    if (down && index < list.length - 1) destination = list[index + 1];
    if (command.key === 'Home') destination = list[0];
    if (command.key === 'End') destination = list.at(-1);
    if (horizontal || (up && index <= 0) || (down && index >= list.length - 1)) {
      const displayed = cards();
      const anchor = (row ?? card.querySelector('h2')).getBoundingClientRect();
      const next = displayed[spatialNeighbor(displayed.map((item) => item.getBoundingClientRect()), displayed.indexOf(card), command.key, anchor)];
      event.preventDefault();
      if (!next) return;
      const nextRows = rows(next);
      // Enter a vertical neighbor at its adjoining end. Across columns, keep the
      // reading position as close as possible to the currently focused story.
      let nextIndex = up ? nextRows.length - 1 : 0;
      if (horizontal && nextRows.length) {
        const y = (anchor.top + anchor.bottom) / 2;
        nextIndex = nextRows.reduce((best, item, i) => {
          const rect = item.getBoundingClientRect();
          const previous = nextRows[best].getBoundingClientRect();
          return Math.abs((rect.top + rect.bottom) / 2 - y) < Math.abs((previous.top + previous.bottom) / 2 - y) ? i : best;
        }, 0);
      }
      // Arrow navigation reveals the destination's shortcuts just like its number key.
      hintCardId = next.id;
      restore({ cardId: next.id, index: Math.max(0, nextIndex) });
      return;
    }
  }
  if (destination) { event.preventDefault(); focusStory(destination); }
}

// Snapshot before either redraw or DOM reparenting, including normal Tab users. Restore
// only if the focused node was lost/hidden; never pull focus out of search or a dialog.
function beforeChange() {
  const saved = bookmark();
  if (saved) pendingFocus = { saved, element: document.activeElement };
}
function afterChange() {
  queueMicrotask(() => {
    decorate();
    const pending = pendingFocus;
    pendingFocus = null;
    if (!pending || modalOpen()) return;
    const focus = document.activeElement;
    if (focus !== document.body && focus !== pending.element && !grid.contains(focus)) return;
    if (focus !== pending.element || !visible(focus)) restore(pending.saved, active);
  });
}
grid.addEventListener('cards:beforechange', beforeChange);
grid.addEventListener('layout:beforechange', beforeChange);
grid.addEventListener('layout:change', afterChange);
grid.addEventListener('cards:change', afterChange);
document.addEventListener('focusin', reflect);
document.addEventListener('pointerdown', () => {
  pointerActive = true;
  keyboardInput = false;
  reflect();
}, true);
function finishPointer() {
  // Keep layout stable between pointerdown and click, especially for footer buttons.
  setTimeout(() => {
    pointerActive = false;
    if (!keyboardInput) hintCardId = null;
    reflect();
  }, 0);
}
document.addEventListener('click', () => { if (pointerActive) finishPointer(); }, true);
// pointerup also covers releases that do not produce a click (e.g. a drag).
document.addEventListener('pointerup', finishPointer, true);
document.addEventListener('pointercancel', finishPointer, true);
document.addEventListener('dragend', finishPointer, true);
document.addEventListener('contextmenu', finishPointer, true);
// Capture before the weather screen's Escape listener closes its non-modal dialog.
document.addEventListener('keydown', onKey, true);
document.addEventListener('keyboard:settings', ({ detail }) => { enabled = detail.enabled; decorate(); });
document.addEventListener('weather:shown', pageBadges);
document.addEventListener('setup:change', ({ detail }) => {
  queueMicrotask(() => {
    if (!active || returningFrom !== 'setup') return;
    if (detail.shown && focusSetup) {
      focusSetup = false;
      document.querySelector('#setup-bar button')?.focus();
    } else if (!detail.shown) {
      returningFrom = null;
      restore();
    }
  });
});
document.addEventListener('close', (event) => {
  // Native close listeners can restore their own trigger after the capture phase.
  // Wait for them before returning to the saved story.
  setTimeout(() => {
    if (resetOnClose.has(event.target)) {
      resetOnClose.delete(event.target);
      resetSelection();
      return;
    }
    decorate();
    if (!modalOpen() && active && returningFrom) { returningFrom = null; restore(); }
    reflect();
  }, 0);
}, true);
document.querySelector('.skip-stories')?.addEventListener('click', (event) => { event.preventDefault(); enter(); });
footer.querySelector('.keyboard-help-close').addEventListener('click', () => { helpOpen = false; restore(last, false); reflect(); });
footer.addEventListener('click', (event) => { const key = event.target.closest('[data-keyboard-action]')?.dataset.keyboardAction; if (key) pageAction(key); });

// Reserve real room for the guide, so neither the window nor an internally scrolling
// card can put a focused link behind it. Repack only when that reservation changes.
let footerHeight = 0;
function reserveFooter() {
  const height = footer.hidden ? 0 : Math.ceil(footer.getBoundingClientRect().height);
  if (height === footerHeight) return;
  footerHeight = height;
  document.documentElement.style.setProperty('--keyboard-footer-height', `${height}px`);
  grid.dispatchEvent(new Event('layout:refresh'));
}
new ResizeObserver(reserveFooter).observe(footer);
// Show only the global hints initially; never steal focus or select a story on load.
reflect();
grid.dispatchEvent(new Event('layout:refresh'));
decorate();
