// Every change to the reader's settings, kept so any of them can be undone. The history is
// a timeline of whole settings snapshots, oldest first, with `index` pointing at the one on
// screen: undo steps back, redo steps forward, and rewinding jumps to any point. A new
// change after stepping back drops the steps that were undone. Shape:
//   { v: 1, index, entries: [{ settings, label, at }] }
// where `settings` is a settings object (see settings.js) or null for the default page,
// `label` says what the change was ("Removed BBC Football") and `at` is when, in ms.
// Kept in this browser's localStorage next to the settings.

import { validSettings } from './settings.js';

export const HISTORY_KEY = 'start-page:history';
export const MAX_HISTORY = 100; // snapshots kept; the oldest go first
const FIRST_LABEL = 'Your page before any changes';
const ELSEWHERE_LABEL = 'Changes made in another window';

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
// Settings in the same shape (and key order) as they come back from storage, to compare.
const tidy = (settings) => (settings ? validSettings(settings) : null);

// History comes from storage, so keep only what makes sense.
export function validHistory(value) {
  if (value?.v !== 1 || !Array.isArray(value.entries)) return null;
  const entries = value.entries
    .filter((entry) => typeof entry?.label === 'string' && Number.isFinite(entry.at))
    .map((entry) => ({ settings: entry.settings === null ? null : validSettings(entry.settings), label: entry.label.slice(0, 200), at: entry.at }))
    .filter((entry, i) => entry.settings !== null || value.entries[i].settings === null)
    .slice(-MAX_HISTORY);
  if (!entries.length) return null;
  const index = Number.isInteger(value.index) ? Math.min(Math.max(value.index, 0), entries.length - 1) : entries.length - 1;
  return { v: 1, index, entries };
}

// Adds a change from `before` to `after`. If the point on screen isn't `before` (settings
// changed in another window, or the history was cleared), `before` is recorded first, so it
// can still be got back to.
export function recordChange(history, untidyBefore, untidyAfter, label, at) {
  const before = tidy(untidyBefore);
  const after = tidy(untidyAfter);
  const entries = history ? history.entries.slice(0, history.index + 1) : [{ settings: before, label: FIRST_LABEL, at }];
  if (!same(entries.at(-1).settings, before)) entries.push({ settings: before, label: ELSEWHERE_LABEL, at });
  entries.push({ settings: after, label, at });
  const kept = entries.slice(-MAX_HISTORY);
  return { v: 1, index: kept.length - 1, entries: kept };
}

export const canUndo = (history) => Boolean(history && history.index > 0);
export const canRedo = (history) => Boolean(history && history.index < history.entries.length - 1);

// The history with a different point on screen (clamped to the ones there are).
export function moveTo(history, index) {
  return { ...history, index: Math.min(Math.max(index, 0), history.entries.length - 1) };
}

const quoted = (title) => `“${title}”`;

function listOf(titles, verb, noun) {
  if (titles.length === 1) return `${verb} ${quoted(titles[0])}`;
  if (titles.length === 2) return `${verb} ${quoted(titles[0])} and ${quoted(titles[1])}`;
  return `${verb} ${titles.length} ${noun}`;
}

// The one card that moved, if taking it out of both orders leaves them the same.
function movedCard(beforeIds, afterIds) {
  return afterIds.find((id) => same(beforeIds.filter((x) => x !== id), afterIds.filter((x) => x !== id)));
}

// A short description of a change, for the history and the undo message. `beforeCards`
// and `afterCards` are this tab's full card lists (settings.js `cardList`), so default cards
// the reader never touched still count; `titleFor` names a card.
export function describeChange({ before, after, beforeCards, afterCards, titleFor }) {
  const title = (id) => titleFor(id) ?? id;
  const beforeFeeds = before?.custom ?? [];
  const afterFeeds = after?.custom ?? [];
  const added = afterFeeds.filter((feed) => !beforeFeeds.some((f) => f.id === feed.id));
  const removed = beforeFeeds.filter((feed) => !afterFeeds.some((f) => f.id === feed.id));
  if (added.length) return listOf(added.map((feed) => feed.title), 'Added', 'feeds');
  if (removed.length) return listOf(removed.map((feed) => feed.title), 'Deleted', 'feeds');
  if (!same(before?.profile, after?.profile)) return 'Changed topics & sources';

  const was = new Map(beforeCards.map((card) => [card.id, card]));
  const now = new Map(afterCards.map((card) => [card.id, card]));
  const hidden = afterCards.filter((card) => card.hidden && was.has(card.id) && !was.get(card.id).hidden).map((card) => title(card.id));
  const shown = afterCards.filter((card) => !card.hidden && was.has(card.id) && was.get(card.id).hidden).map((card) => title(card.id));
  if (hidden.length && !shown.length) return listOf(hidden, 'Removed', 'cards');
  if (shown.length && !hidden.length) return listOf(shown, 'Brought back', 'cards');
  if (hidden.length) return `Showed ${shown.length} and removed ${hidden.length} cards`;

  const limits = afterCards.filter((card) => was.has(card.id) && card.limit !== was.get(card.id).limit);
  if (limits.length === 1) {
    const [card] = limits;
    return card.limit ? `Showed ${card.limit} items in ${quoted(title(card.id))}` : `Reset the items in ${quoted(title(card.id))}`;
  }
  if (limits.length) return `Changed the items in ${limits.length} cards`;

  const manual = (settings) => Object.values(settings?.tabs ?? {}).some((page) => page.arrange === 'manual');
  const beforeArrange = manual(before);
  const afterArrange = manual(after);
  const beforeIds = beforeCards.filter((card) => !card.hidden).map((card) => card.id);
  const afterIds = afterCards.filter((card) => !card.hidden).map((card) => card.id);
  const columnsChanged = afterCards.some((card) => was.has(card.id) && card.col !== was.get(card.id).col);
  if (beforeArrange !== afterArrange) return afterArrange ? 'Kept cards in their columns' : 'Fitted cards to the screen';
  if (!same(beforeIds, afterIds) || columnsChanged) {
    const recolumned = afterCards.filter((card) => was.has(card.id) && card.col !== was.get(card.id).col);
    const moved = movedCard(beforeIds, afterIds) ?? (same(beforeIds, afterIds) && recolumned.length === 1 ? recolumned[0].id : null);
    return moved ? `Moved ${quoted(title(moved))}` : 'Rearranged the cards';
  }
  if (!same(before?.tabs ?? {}, after?.tabs ?? {}) && !Object.keys(after?.tabs ?? {}).length) return 'Reset to the default cards';
  if (now.size !== was.size) return 'Updated the list of cards';
  return 'Changed the page';
}

// "just now", "5 min ago", "3 h ago", "yesterday 14:05", "12 Oct 09:30".
export function whenLabel(at, now = Date.now()) {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 12) return `${hours} h ago`;
  const date = new Date(at);
  const time = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const day = (d) => new Date(d).toDateString();
  if (day(at) === day(now)) return `today ${time}`;
  if (day(at) === day(now - 86_400_000)) return `yesterday ${time}`;
  return `${date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${time}`;
}

export function loadHistory() {
  try {
    return validHistory(JSON.parse(localStorage.getItem(HISTORY_KEY)));
  } catch {
    return null;
  }
}

export function saveHistory(history) {
  try {
    if (history) localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    else localStorage.removeItem(HISTORY_KEY);
  } catch {
    // Storage blocked or full: the history lasts until the page reloads.
  }
}
