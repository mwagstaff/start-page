// Drag a card anywhere on it to move it (mouse: press and move; touch: press and hold, then
// move). The card lifts and follows the pointer, a dashed outline shows where it will land,
// and the other cards slide out of the way. On a drop the cards stay in the columns they're
// in now (page.js `placeCards`), with no limit on how many go in one column; Customise can
// turn fitting them to the screen back on. Escape puts the card back. From the keyboard, use
// the Customise dialog.

import { currentFeeds, fetchFeeds, placeCards, setTabCards, shownColumns, tabCards } from './page.js';
import { moveCard } from './settings.js';

const grid = document.querySelector('.grid');
const DRAG_DISTANCE = 6; // px a mouse moves before a press becomes a drag (less is a click)
const HOLD_MS = 350; // how long a finger presses before a drag starts (moving sooner scrolls)
const HOLD_SLOP = 8;
const EDGE = 60; // px from the top or bottom of the window that scrolls the page
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

let press = null; // a pointer down on a card that may become a drag
let drag = null; // the drag under way

const cardsIn = (column) => [...column.children].filter((el) => el.matches('.card') && el !== drag?.card);
const columns = () => (grid.classList.contains('packed') ? [...grid.children] : [grid]);

// Where the card would land: the column nearest the pointer, before the first card whose
// middle is below it. Positions come from the layout (offsetTop), not from the screen, so
// cards still sliding out of the way don't change the answer.
function dropTarget(x, y) {
  const box = grid.getBoundingClientRect();
  const gx = x - box.left;
  const gy = y - box.top;
  const distance = (column) => (column === grid ? 0 : Math.max(column.offsetLeft - gx, gx - column.offsetLeft - column.offsetWidth, 0));
  const column = columns().reduce((best, column) => (distance(column) < distance(best) ? column : best));
  const before = cardsIn(column).find((card) => gy < card.offsetTop + card.offsetHeight / 2) ?? null;
  return { column, before };
}

// Moves the outline, sliding the cards it passes from where they were (FLIP).
function movePlaceholder({ column, before }) {
  const { placeholder } = drag;
  const next = cardsIn(placeholder.parentElement).find((card) => placeholder.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING) ?? null;
  if (placeholder.parentElement === column && next === before) return;
  const cards = [...grid.querySelectorAll('.card')].filter((card) => card !== drag.card);
  const first = new Map(cards.map((card) => [card, card.getBoundingClientRect()]));
  if (before) before.before(placeholder);
  else column.append(placeholder);
  if (reduceMotion.matches) return;
  for (const card of cards) {
    card.getAnimations().forEach((animation) => animation.cancel());
    const last = card.getBoundingClientRect();
    const dx = first.get(card).left - last.left;
    const dy = first.get(card).top - last.top;
    if (dx || dy) card.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 180, easing: 'ease-out' });
  }
}

function follow() {
  const { card, x, y, offsetX, offsetY } = drag;
  card.style.transform = `translate(${x - offsetX}px, ${y - offsetY}px) rotate(1deg)`;
  movePlaceholder(dropTarget(x, y));
}

// Near the top or bottom of the window, scroll so a card can go anywhere on a long page.
function autoScroll() {
  if (!drag) return;
  const speed = drag.y < EDGE ? -(EDGE - drag.y) / 3 : drag.y > innerHeight - EDGE ? (drag.y - innerHeight + EDGE) / 3 : 0;
  if (speed) {
    scrollBy(0, speed);
    movePlaceholder(dropTarget(drag.x, drag.y));
  }
  drag.frame = requestAnimationFrame(autoScroll);
}

function start(x, y) {
  const { card } = press;
  const box = card.getBoundingClientRect();
  const placeholder = document.createElement('div');
  placeholder.className = 'card-placeholder';
  placeholder.style.height = `${box.height}px`;
  card.before(placeholder);
  drag = { card, placeholder, x, y, offsetX: x - box.left, offsetY: y - box.top, origin: { parent: card.parentElement, next: card.nextElementSibling } };
  // The card stays where it is in the page, but drawn on top, following the pointer.
  Object.assign(card.style, { width: `${box.width}px`, height: `${box.height}px` });
  card.classList.add('is-lifted');
  document.documentElement.classList.add('is-reordering');
  getSelection()?.removeAllRanges();
  if (press.touch) navigator.vibrate?.(10);
  press = null;
  follow();
  drag.frame = requestAnimationFrame(autoScroll);
}

// Ends a drag: drops the card where the outline is, or (cancel) back where it came from.
async function finish({ cancel = false } = {}) {
  const { card, placeholder, origin, frame } = drag;
  cancelAnimationFrame(frame);
  const from = card.getBoundingClientRect();
  if (cancel) {
    placeholder.remove();
    origin.parent.insertBefore(card, origin.next);
  } else {
    placeholder.replaceWith(card);
  }
  card.classList.remove('is-lifted');
  card.style.cssText = '';
  document.documentElement.classList.remove('is-reordering');
  drag = null;
  // Glide from where it was let go into its place.
  const to = card.getBoundingClientRect();
  if (!reduceMotion.matches) {
    await card.animate([{ transform: `translate(${from.left - to.left}px, ${from.top - to.top}px)` }, { transform: 'none' }], { duration: 160, easing: 'ease-out' }).finished.catch(() => {});
  }
  if (cancel || (card.parentElement === origin.parent && card.nextElementSibling === origin.next)) return;
  save(card);
}

async function save(card) {
  // Read the page before anything can redraw it.
  const placed = shownColumns();
  const order = [...grid.querySelectorAll('.card')].map((el) => el.id);
  if (!currentFeeds() && !(await fetchFeeds())) return;
  if (placed) {
    placeCards(placed);
    return;
  }
  // One column on screen: just a new place in the order, after the card now above it.
  const cards = tabCards();
  const index = order.indexOf(card.id);
  const rest = cards.filter((c) => c.id !== card.id);
  const to = index === 0 ? rest.findIndex((c) => c.id === order[1]) : rest.findIndex((c) => c.id === order[index - 1]) + 1;
  setTabCards(moveCard(cards, cards.findIndex((c) => c.id === card.id), Math.max(0, to)));
}

// The click that ends a drag isn't a click on whatever link is under the pointer.
function swallowNextClick() {
  const swallow = (event) => { event.preventDefault(); event.stopPropagation(); };
  addEventListener('click', swallow, { capture: true, once: true });
  setTimeout(() => removeEventListener('click', swallow, { capture: true }), 0);
}

function cancelPress() {
  clearTimeout(press?.timer);
  press = null;
}

if (grid) {
  grid.addEventListener('pointerdown', (event) => {
    if (drag || event.button !== 0 || !event.isPrimary) return;
    const card = event.target.closest('.card');
    if (!card || event.target.closest('input, button, select, textarea')) return;
    press = { card, id: event.pointerId, x: event.clientX, y: event.clientY, touch: event.pointerType === 'touch' };
    if (press.touch) press.timer = setTimeout(() => start(press.x, press.y), HOLD_MS);
  });

  document.addEventListener('pointermove', (event) => {
    if (drag) {
      drag.x = event.clientX;
      drag.y = event.clientY;
      follow();
      return;
    }
    if (!press || event.pointerId !== press.id) return;
    const moved = Math.hypot(event.clientX - press.x, event.clientY - press.y);
    if (press.touch) {
      if (moved > HOLD_SLOP) cancelPress(); // scrolling, not holding
    } else if (moved > DRAG_DISTANCE) {
      start(event.clientX, event.clientY);
    }
  });

  const end = (event) => {
    if (drag) {
      if (event.type === 'pointerup') swallowNextClick();
      finish({ cancel: event.type === 'pointercancel' });
    }
    cancelPress();
  };
  document.addEventListener('pointerup', end);
  document.addEventListener('pointercancel', end);
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && drag) finish({ cancel: true }); });

  // Links and pictures would otherwise start the browser's own drag (of the address).
  grid.addEventListener('dragstart', (event) => event.preventDefault());
  // Once a finger is dragging a card, it mustn't scroll the page or open a menu.
  document.addEventListener('touchmove', (event) => { if (drag) event.preventDefault(); }, { passive: false });
  grid.addEventListener('contextmenu', (event) => { if (drag || press?.touch) event.preventDefault(); });
}
