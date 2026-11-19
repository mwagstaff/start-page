// Story labels never shadow page actions.
export const STORY_KEYS = [...'abcdefghijklmnopqrstuvwxyz'].filter((key) => !'csw'.includes(key));
export const storyShortcut = (index) => STORY_KEYS[index] ?? null;
export const cardShortcut = (index) => index < 0 || index > 9 ? null : String((index + 1) % 10);

// Leave modified keys, composition and character repeats to the browser and OS.
export function shortcutCommand(event, { active = true, enabled = true, editing = false, blocked = false } = {}) {
  if (event.defaultPrevented || event.isComposing || event.altKey || blocked) return null;
  if (event.ctrlKey || event.metaKey) {
    return event.key === '.' && !event.shiftKey && !event.repeat && !(event.ctrlKey && event.metaKey)
      ? { type: 'page', key: 'customise' } : null;
  }
  if (event.key === 'Escape' && !event.shiftKey && !event.repeat) return { type: 'reset' };
  if (editing) return null;
  if (enabled && event.key === '/' && !event.repeat) return { type: 'page', key: 's' };
  if (enabled && event.key === '?' && !event.repeat) return { type: 'help' };
  if (!active) return null;
  if (event.shiftKey) return null;
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return { type: 'move', key: event.key };
  if (!enabled || event.repeat) return null;
  const key = event.key.toLowerCase();
  if (/^[0-9]$/.test(key)) return { type: 'card', index: key === '0' ? 9 : Number(key) - 1 };
  if ('sw'.includes(key) && key.length === 1) return { type: 'page', key };
  if (key === 'c') return { type: 'comments' };
  const index = STORY_KEYS.indexOf(key);
  return index < 0 ? null : { type: 'story', index };
}

// The forecast owns these keys while open, independently of story navigation mode.
export function weatherShortcutCommand(event, { enabled = true, editing = false, blocked = false } = {}) {
  if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || blocked) return null;
  if (event.key === 'Escape' && !event.repeat) return { type: 'close' };
  if (editing) return null;
  if (enabled && event.key.toLowerCase() === 'w' && !event.repeat) return { type: 'close' };
  if (enabled && event.key.toLowerCase() === 't' && !event.repeat) return { type: 'temperature' };
  if (event.key === 'ArrowDown') return { type: 'day', step: 1 };
  if (event.key === 'ArrowUp') return { type: 'day', step: -1 };
  return null;
}

// Prefer identity across a refresh, then the nearest remaining visible story.
export function restoredIndex(urls, bookmark) {
  if (!urls.length) return -1;
  const found = urls.indexOf(bookmark?.url);
  return found >= 0 ? found : Math.min(Math.max(bookmark?.index ?? 0, 0), urls.length - 1);
}
