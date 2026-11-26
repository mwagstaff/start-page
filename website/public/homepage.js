import { cardList } from './settings.js';
import { defaultProfile, profileCards } from './topics.js';

// The same ordered list drives Settings, the browser grid and the native reader.
export function homepageCards(settings, catalogue, widgets, legacy, region = 'uk') {
  const saved = settings?.tabs?.home?.cards;
  const profile = settings?.profile ?? defaultProfile(catalogue, region);
  const definitions = saved && !settings?.profile ? [] : profileCards(profile, catalogue);
  const feeds = settings?.custom ?? [];
  const available = [...new Set([...Object.keys(widgets), ...definitions.map(c => c.id), ...feeds.map(c => c.id)])];
  const defaults = saved ? (settings.profile ? [] : legacy) : definitions.map(c => c.id);
  return cardList(saved, [...defaults, ...feeds.map(c => c.id)], available);
}

// Change only the cards affected by a topic/source edit. Other choices may have
// come from the original feed catalogue or a manual hide/reorder.
export function applyProfileChange(previous, next, catalogue, widgets, legacy, region = 'uk') {
  if (!next.profile) return next;
  const oldProfile = previous?.profile ?? defaultProfile(catalogue, region);
  const before = new Set(profileCards(oldProfile, catalogue).map(c => c.id));
  const after = new Set(profileCards(next.profile, catalogue).map(c => c.id));
  const existing = homepageCards(previous, catalogue, widgets, legacy, region);
  const rows = existing.map(card => {
    if (before.has(card.id) && !after.has(card.id)) return { ...card, hidden: true };
    if (!before.has(card.id) && after.has(card.id)) {
      const { hidden, ...shown } = card;
      return shown;
    }
    return card;
  });
  const ids = new Set(rows.map(c => c.id));
  for (const id of after) if (!ids.has(id)) rows.push({ id });
  const home = { ...previous?.tabs?.home, cards: [...rows.filter(c => !c.hidden), ...rows.filter(c => c.hidden)] };
  return { ...next, tabs: { ...next.tabs, home } };
}
