import { profileCards } from '../public/topics.js';
import { buildCards } from '../public/stories.js';

// Mobile download selection is independent of synced website display preferences.
export function companionCards(widgets, layout) {
  const enabled = layout.filter(card => !card.hidden && widgets[card.id]);
  const limit = Math.min(100, Math.max(1, Math.floor(1000 / Math.max(1, enabled.length))));
  const expanded = Object.fromEntries(Object.entries(widgets).map(([id, widget]) =>
    [id, { ...widget, limit, maxPerSource: limit }]));
  // Reserve a short first page for every card before filling remaining capacity.
  return buildCards(expanded, enabled.map(({ id }) => ({ id, limit: Math.min(8, limit) })), 8, limit);
}

// App additions are request-only; never merge them into the paired profile.
export function appTopicCards(profile, catalogue, topics, sharedLayout) {
  const selected = [...new Set(Array.isArray(topics) ? topics.filter(id => typeof id === 'string' && Object.hasOwn(catalogue.topics, id)) : [])].slice(0, 60);
  const visible = new Set(sharedLayout.filter(card => !card.hidden).map(card => card.id));
  return selected.flatMap(topic => {
    const section = catalogue.topics[topic].section;
    const matching = profile.outlets.filter(id => catalogue.outlets[id]?.sections.includes(section));
    const outlets = matching.length || !section ? profile.outlets : Object.keys(catalogue.outlets).filter(id => catalogue.outlets[id].sections.includes(section));
    return profileCards({...profile, outlets, topics:[topic], style:'topics'}, catalogue)
      .filter(card => !visible.has(card.id))
      .map(card => ({...card, originalId:card.id, id:'app-' + card.id}));
  });
}
