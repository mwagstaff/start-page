// Search templates are shared by validation, settings and the masthead.
export const SEARCH_PROVIDERS = [
  { id: 'google', name: 'Google', url: 'https://www.google.com/search?q={query}' },
  { id: 'bing', name: 'Bing', url: 'https://www.bing.com/search?q={query}' },
  { id: 'duckduckgo', name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q={query}' },
  { id: 'yahoo', name: 'Yahoo', url: 'https://search.yahoo.com/search?p={query}' },
  { id: 'brave', name: 'Brave Search', url: 'https://search.brave.com/search?q={query}' },
  { id: 'ecosia', name: 'Ecosia', url: 'https://www.ecosia.org/search?q={query}' },
];

export function validCustomSearch(value) {
  if (typeof value?.name !== 'string' || typeof value?.url !== 'string') return null;
  const name = value.name.trim();
  const url = value.url.trim();
  if (!name || name.length > 80 || url.length > 2000 || !url.includes('{query}')) return null;
  try {
    const parsed = new URL(url);
    // The query may occur in the path, query string or fragment, never the origin.
    const sample = new URL(url.replaceAll('{query}', 'test'));
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password
      || parsed.origin !== sample.origin) return null;
    return { name, url };
  } catch {
    return null;
  }
}

export function validSearch(value) {
  const custom = validCustomSearch(value?.custom);
  const provider = SEARCH_PROVIDERS.some(({ id }) => id === value?.provider)
    ? value.provider : value?.provider === 'custom' && custom ? 'custom' : 'google';
  return provider === 'google' && !custom ? null : { provider, ...(custom && { custom }) };
}

export function searchProvider(value) {
  const search = validSearch(value);
  return search?.provider === 'custom' ? search.custom
    : SEARCH_PROVIDERS.find(({ id }) => id === search?.provider) ?? SEARCH_PROVIDERS[0];
}

export function searchUrl(value, query) {
  return searchProvider(value).url.replaceAll('{query}', encodeURIComponent(query.trim()));
}

export function updateSearchForm(form, value) {
  if (!form) return;
  const provider = searchProvider(value);
  const input = form.querySelector('input[type="search"]');
  input.placeholder = `Search ${provider.name}`;
  input.setAttribute('aria-label', input.placeholder);
  form.onsubmit = (event) => {
    event.preventDefault();
    if (!input.value.trim()) return;
    window.open(searchUrl(value, input.value), '_blank', 'noopener,noreferrer');
    input.value = '';
  };
}
