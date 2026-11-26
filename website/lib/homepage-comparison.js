import { homepageCards } from '../public/homepage.js';
import { validSettings } from '../public/settings.js';
import { searchProvider } from '../public/search.js';

function preferences(input, context) {
  const s = validSettings(input) ?? {};
  const profile = s.profile ?? context.defaultHomepage;
  const { catalogue, widgets, legacy } = context;
  const rows = homepageCards(s, catalogue, widgets, legacy).filter(card => !card.hidden);
  const name = id => s.custom?.find(c => c.id === id)?.title ?? widgets[id]?.title
    ?? catalogue.outlets[id.replace(/^outlet-/, '')]?.name ?? catalogue.topics[id.replace(/^topic-/, '')]?.label ?? id;
  const on = enabled => enabled ? 'On' : 'Off';
  const search = searchProvider(s.search);
  return {
    'Card order': rows.map(c => name(c.id)),
    'Story limits': rows.filter(c => c.limit).map(c => name(c.id) + ' · ' + c.limit).join(', ') || 'Automatic',
    'Card columns': s.tabs?.home?.arrange === 'manual'
      ? 'Manual · ' + rows.map(c => name(c.id) + ' (' + (c.col == null ? 'automatic' : c.col + 1) + ')').join(', ') : 'Automatic',
    'Topics': profile.topics.map(id => catalogue.topics[id]?.label ?? id).join(', ') || 'None',
    'Sources': profile.outlets.map(id => catalogue.outlets[id]?.name ?? id).join(', ') || 'None',
    'Group news by': profile.style === 'outlets' ? 'Source' : 'Topic',
    'Custom feeds': (s.custom ?? []).map(f => f.title + ' (' + f.url + ')').join(', ') || 'None',
    'Density': s.density ?? 'spacious', 'Fit cards on one page': on(s.fill !== false), 'Solid cards': on(s.solid),
    'Weather': on(profile.weather), 'Temperature': s.temperature ?? 'Regional default',
    'Background photo': on(profile.backdrop), 'Story pictures': on(profile.pictures), 'Subscription sources': on(profile.paywalls),
    'Search': s.search?.provider === 'custom' ? search.name + ' (' + search.url + ')' : search.name,
    'Custom search template': s.search?.custom ? s.search.custom.name + ' (' + s.search.custom.url + ')' : 'None',
    'Keyboard shortcuts': on(s.shortcuts !== false), 'Premier League fixtures': on(s.football),
    'Matches on TV': s.footballTv ? s.footballTv + ' stars and above' : 'Off'
  };
}

export function compareHomepages(local, account, context) {
  const a = preferences(local, context), b = preferences(account, context);
  const result = { local: [], account: [] };
  for (const label of Object.keys(a)) {
    let left = a[label], right = b[label];
    if (JSON.stringify(left) === JSON.stringify(right)) continue;
    if (label === 'Card order') {
      const position = Array.from({length: Math.max(left.length, right.length)}, (_, i) => i).find(i => left[i] !== right[i]);
      const preview = cards => cards.length ? cards.slice(0, 3).join(' → ') +
        (position >= 3 ? ' · Card ' + (position + 1) + ' is ' + (cards[position] ?? 'absent') : '') +
        ' (' + cards.length + ' cards)' : 'No visible cards';
      left = preview(left); right = preview(right);
    }
    result.local.push(label + ' · ' + left);
    result.account.push(label + ' · ' + right);
  }
  return result;
}
