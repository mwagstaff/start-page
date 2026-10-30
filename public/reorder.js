// Drag a card by its title to move it on the page (mouse; on touch screens and from the
// keyboard, use the Customise dialog). The card goes before or after the one it's dropped
// on, depending on which half, and the new order is saved like any other customisation.
// Cards are then packed into columns again, so a card can land in a different column.

import { currentFeeds, fetchFeeds, setTabCards, tabCards } from './page.js';

const grid = document.querySelector('.grid');
let dragged = null;

function prepare() {
  for (const heading of grid.querySelectorAll('.card > h2')) {
    heading.draggable = true;
    heading.title = 'Drag to move this card';
    heading.querySelector('a')?.setAttribute('draggable', 'false');
  }
}

function clearMarks() {
  grid.querySelectorAll('.drop-before, .drop-after').forEach((card) => card.classList.remove('drop-before', 'drop-after'));
}

function finish() {
  dragged?.classList.remove('is-dragging');
  dragged = null;
  clearMarks();
}

if (grid) {
  prepare();
  grid.addEventListener('cards:change', prepare);

  grid.addEventListener('dragstart', (event) => {
    const card = event.target.closest?.('.card');
    if (!card || !event.target.matches('.card > h2')) return;
    dragged = card;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', card.querySelector('h2').textContent.trim());
    event.dataTransfer.setDragImage(card, 24, 16);
    requestAnimationFrame(() => card.classList.add('is-dragging'));
  });

  grid.addEventListener('dragover', (event) => {
    const target = dragged && event.target.closest('.card');
    if (!target || target === dragged) {
      clearMarks();
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const box = target.getBoundingClientRect();
    const mark = event.clientY > box.top + box.height / 2 ? 'drop-after' : 'drop-before';
    if (!target.classList.contains(mark)) {
      clearMarks();
      target.classList.add(mark);
    }
  });

  grid.addEventListener('drop', async (event) => {
    const target = dragged && event.target.closest('.card');
    if (!target || target === dragged) return;
    event.preventDefault();
    const after = target.classList.contains('drop-after');
    const { id } = dragged;
    finish();
    if (!currentFeeds() && !(await fetchFeeds())) return;
    const cards = tabCards();
    const moving = cards.find((card) => card.id === id);
    const rest = cards.filter((card) => card.id !== id);
    rest.splice(rest.findIndex((card) => card.id === target.id) + (after ? 1 : 0), 0, moving);
    setTabCards(rest);
  });

  grid.addEventListener('dragend', finish);
}
