// Reveal another page within this card, keeping the reader's saved count as its baseline.
import { renderItem } from './cards.js';
import { mergeItems, storyKeys } from './stories.js';

const PAGE_SIZE = 10;

export function initMobileStories(grid, getWidgets) {
  const mobile = matchMedia('(max-width: 760px)');
  const expanded = new Map();
  const pages = new WeakMap();

  function show(page, added) {
    const { card, list, rows, base, more, collapse, reserve, widget } = page;
    const total = page.original + reserve.length;
    const count = Math.min(base + added, total);
    // Only create rows beyond the desktop list once someone actually requests them.
    for (let i = rows.length; i < count; i++) {
      list.insertAdjacentHTML('beforeend', renderItem(reserve[i - page.original], widget));
      list.lastElementChild.classList.add('mobile-only-story');
      rows.push(list.lastElementChild);
    }
    rows.forEach((row, i) => row.classList.toggle('mobile-overflow', i >= count));
    page.count = count;
    const next = Math.min(PAGE_SIZE, total - count);
    more.textContent = `Show ${next} more ${next === 1 ? 'story' : 'stories'}`;
    more.hidden = next === 0;
    collapse.hidden = count <= base;
    if (added) expanded.set(card.id, { base, added: count - base });
    else expanded.delete(card.id);
  }

  function prepare() {
    if (!mobile.matches) return;
    const widgets = getWidgets();
    const cards = [...grid.querySelectorAll('.card')];
    const seen = new Set();
    // Reserve stories already assigned to any card before sharing out the remainder.
    for (const link of grid.querySelectorAll('.headline')) {
      if (link.closest('.mobile-only-story')) continue;
      for (const key of storyKeys({ link: link.href, title: link.textContent })) seen.add(key);
    }
    for (const card of cards) {
      const list = card.querySelector('.items');
      if (!list) continue;
      const source = widgets[card.id];
      const reserve = source ? mergeItems({ limit: Infinity }, source.sources, undefined, seen) : [];
      if (pages.has(card)) continue;
      const rows = [...list.children];
      const base = rows.filter(row => !row.classList.contains('mobile-overflow')).length;
      if (rows.length + reserve.length <= base) continue;
      const footer = document.createElement('div');
      footer.className = 'mobile-story-actions';
      const [more, collapse] = ['more', 'collapse'].map(action => {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.stories = action;
        button.setAttribute('aria-controls', list.id);
        footer.append(button);
        return button;
      });
      collapse.textContent = 'Show fewer stories';
      card.append(footer);
      const widget = { thumbnails: source?.thumbnails, merged: source?.sources.length > 1 };
      const page = { card, list, rows, base, original: rows.length, more, collapse, reserve, widget };
      pages.set(card, page);
      const previous = expanded.get(card.id);
      show(page, previous?.base === base ? previous.added : 0);
    }
  }

  grid.addEventListener('click', event => {
    const button = event.target.closest('button[data-stories]');
    if (!button) return;
    const page = pages.get(button.closest('.card'));
    const before = page.count;
    if (button === page.more) {
      show(page, before - page.base + PAGE_SIZE);
      // Continue reading at the first new headline as the footer moves down.
      page.rows[before].querySelector('.headline').focus({ preventScroll: true });
    } else {
      show(page, 0);
      page.more.focus({ preventScroll: true });
      page.more.scrollIntoView({ block: 'nearest' });
    }
    grid.dispatchEvent(new Event('layout:change'));
  });
  grid.addEventListener('cards:change', prepare);
  mobile.addEventListener('change', prepare);
  prepare();
}
