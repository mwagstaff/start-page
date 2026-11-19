import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardShortcut, restoredIndex, shortcutCommand, STORY_KEYS, storyShortcut, weatherShortcutCommand } from '../public/keyboard-shortcuts.js';
import { loadSettings, saveSettings, SETTINGS_KEY, validSettings } from '../public/settings.js';
import { recordChange, validHistory } from '../public/history.js';
import { renderWidget } from '../public/cards.js';

const command = (key, options = {}, extra = {}) => shortcutCommand({ key, ...extra }, { active: true, ...options });

test('keyboard navigation is enabled by default', () => {
  assert.deepEqual(shortcutCommand({ key: '1' }), { type: 'card', index: 0 });
  assert.deepEqual(shortcutCommand({ key: 'Escape' }), { type: 'reset' });
  assert.deepEqual(shortcutCommand({ key: 'ArrowDown' }), { type: 'move', key: 'ArrowDown' });
});

test('numbers select cards and story letters skip all reserved actions', () => {
  assert.deepEqual(STORY_KEYS.slice(0, 7), ['a', 'b', 'd', 'e', 'f', 'g', 'h']);
  assert.equal(new Set(STORY_KEYS).size, 23);
  for (let i = 0; i < 15; i++) assert.deepEqual(command(storyShortcut(i)), { type: 'story', index: i });
  for (let i = 0; i < 10; i++) assert.deepEqual(command(cardShortcut(i)), { type: 'card', index: i });
  assert.equal(cardShortcut(10), null);
  assert.equal(storyShortcut(-1), null);
  assert.equal(storyShortcut(23), null);
  assert.deepEqual(command('u'), { type: 'story', index: STORY_KEYS.indexOf('u') });
  assert.deepEqual(command('c'), { type: 'comments' });
  for (const key of ['s', 'w']) assert.deepEqual(command(key), { type: 'page', key });
});

test('slash focuses search even after leaving mode; letters and arrows require mode', () => {
  assert.deepEqual(command('/', { active: false }), { type: 'page', key: 's' });
  assert.deepEqual(command('/'), { type: 'page', key: 's' });
  for (const key of ['a', 'c', 'u', 's', 'w', '1', 'ArrowDown']) assert.equal(command(key, { active: false }), null);
  assert.equal(command('Enter'), null); // native link activation
  assert.equal(command('Tab'), null); // native focus order
});

test('Escape resets selection even while typing or opted out', () => {
  for (const enabled of [true, false]) {
    assert.deepEqual(command('Escape', { enabled }), { type: 'reset' });
    assert.deepEqual(command('Escape', { enabled, active: false }), { type: 'reset' });
    for (const active of [true, false]) {
      assert.deepEqual(command('Escape', { enabled, active, editing: true }), { type: 'reset' });
      assert.equal(command('Escape', { enabled, active }, { repeat: true }), null);
      assert.equal(command('Escape', { enabled, active, blocked: true }), null);
      for (const flag of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey', 'isComposing', 'defaultPrevented']) assert.equal(command('Escape', { enabled, active }, { [flag]: true }), null);
    }
  }
});

test('forecast arrows change days and W or Escape dismisses without toggling story mode', () => {
  const weather = (key, options = {}, extra = {}) => weatherShortcutCommand({ key, ...extra }, options);
  assert.deepEqual(weather('ArrowDown'), { type: 'day', step: 1 });
  assert.deepEqual(weather('ArrowUp', {}, { repeat: true }), { type: 'day', step: -1 });
  for (const key of ['w', 'Escape']) {
    assert.deepEqual(weather(key), { type: 'close' });
    assert.equal(weather(key, {}, { repeat: true }), null);
  }
  assert.equal(weather('w', { enabled: false }), null);
  assert.deepEqual(weather('Escape', { enabled: false, editing: true }), { type: 'close' });
  for (const key of ['w', 'ArrowUp', 'ArrowDown']) assert.equal(weather(key, { editing: true }), null);
  for (const key of ['w', 'Escape', 'ArrowUp', 'ArrowDown']) {
    assert.equal(weather(key, { blocked: true }), null);
    for (const flag of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey', 'isComposing', 'defaultPrevented']) assert.equal(weather(key, {}, { [flag]: true }), null);
  }
  for (const key of ['Tab', 'Enter', ' ', 'ArrowLeft', 'ArrowRight']) assert.equal(weather(key), null);
});

test('Command-period and Ctrl-period open Customise, including while typing or opted out', () => {
  for (const flag of ['metaKey', 'ctrlKey']) {
    for (const options of [{}, { editing: true }, { active: false }, { enabled: false }]) {
      assert.deepEqual(command('.', options, { [flag]: true }), { type: 'page', key: 'customise' });
    }
    for (const extra of [{ shiftKey: true }, { altKey: true }, { repeat: true }, { isComposing: true }, { defaultPrevented: true }]) {
      assert.equal(command('.', {}, { [flag]: true, ...extra }), null);
    }
    assert.equal(command('.', { blocked: true }, { [flag]: true }), null);
  }
  assert.equal(command('.'), null);
  assert.equal(command('.', {}, { ctrlKey: true, metaKey: true }), null);
});

test('typing, IME, browser combinations and existing handlers keep their keys', () => {
  for (const key of ['/', 'a', 'c', 'u', 's', 'w', '1', 'ArrowDown']) {
    assert.equal(command(key, { editing: true }), null);
    assert.equal(command(key, { blocked: true }), null);
    for (const flag of ['ctrlKey', 'metaKey', 'altKey', 'isComposing', 'defaultPrevented']) assert.equal(command(key, {}, { [flag]: true }), null);
  }
  assert.deepEqual(command('Escape', { editing: true }), { type: 'reset' });
  assert.equal(command('a', {}, { shiftKey: true }), null);
  assert.equal(command('c', {}, { repeat: true }), null);
  assert.deepEqual(command('ArrowDown', {}, { repeat: true }), { type: 'move', key: 'ArrowDown' });
});

test('opting out disables every character shortcut but retains arrows and Escape', () => {
  for (const key of ['/', 'a', 'c', 'u', 's', 'w', '1', '0']) assert.equal(command(key, { enabled: false }), null);
  assert.deepEqual(command('ArrowDown', { enabled: false }), { type: 'move', key: 'ArrowDown' });
  assert.deepEqual(command('Escape', { enabled: false }), { type: 'reset' });
});

test('a refresh follows the focused story URL rather than its former index', () => {
  const saved = { url: 'story-b', index: 1 };
  assert.equal(restoredIndex(['new', 'story-a', 'story-b', 'story-c'], saved), 2);
  assert.equal(restoredIndex(['story-b', 'story-a'], saved), 0);
  assert.equal(restoredIndex(['story-a', 'story-c'], saved), 1);
  assert.equal(restoredIndex(['only'], { url: 'gone', index: 14 }), 0);
  assert.equal(restoredIndex([], saved), -1);
});

test('shortcut opt-out survives storage, imported settings and history', () => {
  const storage = new Map();
  const previous = globalThis.localStorage;
  globalThis.localStorage = { setItem: (k, v) => storage.set(k, v), getItem: (k) => storage.get(k) ?? null, removeItem: (k) => storage.delete(k) };
  try {
    const settings = validSettings({ v: 1, tabs: {}, shortcuts: false });
    saveSettings(settings);
    assert.equal(loadSettings().shortcuts, false);
    assert.equal(validSettings(JSON.parse(storage.get(SETTINGS_KEY))).shortcuts, false);
    const history = validHistory(recordChange(null, null, settings, 'Disabled shortcuts', 1));
    assert.equal(history.entries.at(-1).settings.shortcuts, false);
    for (const value of [true, 'false', 0, null]) assert.equal(validSettings({ v: 1, tabs: {}, shortcuts: value }).shortcuts, undefined);
    saveSettings({ v: 1, tabs: {}, custom: [] });
    assert.equal(storage.has(SETTINGS_KEY), false);
  } finally {
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
  }
});

test('comments retain real links and identify the story to assistive technology', () => {
  const html = renderWidget({ id: 'hn', title: 'HN', failedSources: [], items: [{ title: 'A "quoted" story', link: 'https://example.com/story', commentsUrl: 'https://example.com/discussion', comments: 0 }] });
  assert.match(html, /class="comments-link" href="https:\/\/example.com\/discussion" target="_blank" rel="noopener" aria-label="0 comments on A &quot;quoted&quot; story"/);
});


test('T toggles forecast temperatures and respects shortcut guards', () => {
  assert.deepEqual(weatherShortcutCommand({ key: 't' }), { type: 'temperature' });
  for (const options of [{ enabled: false }, { editing: true }, { blocked: true }]) assert.equal(weatherShortcutCommand({ key: 't' }, options), null);
  for (const flag of ['repeat', 'ctrlKey', 'metaKey', 'altKey', 'shiftKey', 'isComposing', 'defaultPrevented']) assert.equal(weatherShortcutCommand({ key: 't', [flag]: true }), null);
});

test('question mark toggles help, including Shift+/ keyboards, while typing and opt-out win', () => {
  assert.deepEqual(command('?'), { type: 'help' });
  assert.deepEqual(command('?', {}, { shiftKey: true }), { type: 'help' });
  for (const options of [{ editing: true }, { enabled: false }, { blocked: true }]) assert.equal(command('?', options), null);
  for (const flag of ['repeat', 'ctrlKey', 'metaKey', 'altKey', 'isComposing', 'defaultPrevented']) assert.equal(command('?', {}, { [flag]: true }), null);
  assert.deepEqual(command('Escape'), { type: 'reset' });
});
