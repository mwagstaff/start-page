import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SEARCH_PROVIDERS, searchProvider, searchUrl, updateSearchForm, validCustomSearch } from '../public/search.js';
import { loadSettings, saveSettings, validSettings } from '../public/settings.js';

const custom = { name: 'Example', url: 'https://example.com/find/{query}?lang=en&again={query}#results' };

test('Google remains the default for old or invalid settings', () => {
  for (const value of [undefined, null, {}, { provider: 'missing' }, { provider: 'custom' }]) {
    assert.equal(searchProvider(value).name, 'Google');
  }
  assert.equal(validSettings({ v: 1, tabs: {} }).search, undefined);
});

test('each preset sends encoded search words in its correct parameter', () => {
  const query = 'tea & coffee + café/#?';
  for (const provider of SEARCH_PROVIDERS) {
    const url = new URL(searchUrl({ provider: provider.id }, query));
    assert.equal(url.searchParams.get(provider.id === 'yahoo' ? 'p' : 'q'), query);
    assert.equal(url.origin, new URL(provider.url).origin);
    assert.equal(url.hash, '');
  }
});

test('custom templates preserve fixed parameters and encode every placeholder', () => {
  assert.deepEqual(validCustomSearch({ ...custom, name: ' Example ' }), custom);
  assert.equal(searchUrl({ provider: 'custom', custom }, ' a/b & c '),
    'https://example.com/find/a%2Fb%20%26%20c?lang=en&again=a%2Fb%20%26%20c#results');
});

test('unsafe or malformed imported custom providers are discarded', () => {
  for (const url of ['javascript:alert("{query}")', 'data:text/html,{query}', '/search?q={query}',
    'https://{query}.example.com/', 'https://user:pass@example.com/?q={query}',
    'https://example.com/search', 'not a URL {query}', 'https://example.com/' + 'a'.repeat(2000) + '{query}']) {
    assert.equal(validCustomSearch({ name: 'Bad', url }), null, url);
    assert.equal(validSettings({ v: 1, tabs: {}, search: { provider: 'custom', custom: { name: 'Bad', url } } }).search, undefined);
  }
  assert.equal(validCustomSearch({ name: ' ', url: custom.url }), null);
});

test('search choice and custom template survive storage and export/import', () => {
  const previous = globalThis.localStorage;
  const store = new Map();
  globalThis.localStorage = { getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value), removeItem: (key) => store.delete(key) };
  try {
    for (const provider of ['custom', 'bing', 'google']) {
      const settings = validSettings({ v: 1, tabs: {}, search: { provider, custom } });
      saveSettings(settings);
      assert.deepEqual(loadSettings(), settings);
      assert.deepEqual(validSettings(JSON.parse(JSON.stringify(settings))), settings);
    }
  } finally { globalThis.localStorage = previous; }
});

test('masthead updates its accessible label, opens results and ignores blank searches', () => {
  const previous = globalThis.window;
  const opened = [];
  globalThis.window = { open: (...args) => opened.push(args) };
  const input = { value: 'hello & world', setAttribute(name, value) { this[name] = value; } };
  const form = { querySelector: () => input };
  try {
    updateSearchForm(form, { provider: 'duckduckgo' });
    assert.equal(input.placeholder, 'Search DuckDuckGo');
    assert.equal(input['aria-label'], input.placeholder);
    let prevented = false;
    form.onsubmit({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.deepEqual(opened, [['https://duckduckgo.com/?q=hello%20%26%20world', '_blank', 'noopener,noreferrer']]);
    assert.equal(input.value, '');
    input.value = '   ';
    form.onsubmit({ preventDefault() {} });
    assert.equal(opened.length, 1);
    updateSearchForm(form, null);
    assert.equal(input.placeholder, 'Search Google');
  } finally { globalThis.window = previous; }
});
