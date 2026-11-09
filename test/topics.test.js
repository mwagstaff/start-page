import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { publicCatalogue } from '../lib/catalogue.js';
import { validSettings } from '../public/settings.js';
import { PILLARS, cardChoice, defaultProfile, guessRegion, layoutForProfile, pillarTopics, profileCards, profileRegion, profileSourceIds, profileWidgets, topicCardId, validProfile, withOutlet, withRegion, withTopic, withoutPaywalls } from '../public/topics.js';

const catalogue = publicCatalogue(JSON.parse(await readFile(new URL('../config/catalogue.json', import.meta.url), 'utf8')));
const profile = (overrides) => ({ outlets: ['bbc', 'guardian'], topics: ['politics', 'football', 'ai'], style: 'topics', pictures: true, weather: true, backdrop: true, paywalls: true, ...overrides });

test('guesses the region from the time zone', () => {
  assert.equal(guessRegion('Europe/London'), 'uk');
  assert.equal(guessRegion('America/New_York'), 'us');
  assert.equal(guessRegion('Australia/Sydney'), 'both');
  assert.equal(guessRegion(undefined), 'both');
});

test('defaults come from the catalogue, and both regions combine', () => {
  assert.deepEqual(defaultProfile(catalogue, 'uk').outlets, ['bbc', 'guardian', 'sky']);
  const both = defaultProfile(catalogue, 'both');
  assert.deepEqual(both.outlets, ['bbc', 'guardian', 'sky', 'nyt', 'npr', 'cbs']);
  assert.equal(new Set(both.topics).size, both.topics.length);
});

test('one card per topic: news topics mix the chosen outlets, others keep their own sources', () => {
  const cards = profileCards(profile(), catalogue);
  assert.deepEqual(cards.map((card) => card.id), ['topic-politics', 'topic-football', 'ai']);
  assert.deepEqual(cards[0].sources, [{ id: 'bbc.politics', name: 'BBC News' }, { id: 'guardian.politics', name: 'The Guardian' }]);
  assert.equal(cards[0].maxPerSource, 4);
  assert.deepEqual(cards[2], { id: 'ai' }); // borrowed from feeds.json
});

test('a news topic none of the chosen outlets cover makes no card', () => {
  assert.deepEqual(profileCards(profile({ outlets: ['politico'], topics: ['sport', 'politics'] }), catalogue).map((card) => card.id), ['topic-politics']);
});

test('one card per source: each outlet mixes its feeds for the chosen news topics', () => {
  const cards = profileCards(profile({ style: 'outlets', topics: ['politics', 'sport', 'ai'], outlets: ['bbc', 'sky'] }), catalogue);
  assert.deepEqual(cards.map((card) => card.id), ['outlet-bbc', 'outlet-sky', 'ai']);
  assert.deepEqual(cards[0].sources.map((s) => s.id), ['bbc.politics', 'bbc.sport']);
  assert.deepEqual(cards[1].sources.map((s) => s.id), ['sky.politics']); // Sky has no sport feed
  // With no news topics, an outlet card shows its top stories.
  assert.deepEqual(profileCards(profile({ style: 'outlets', topics: [], outlets: ['nyt'] }), catalogue)[0].sources.map((s) => s.id), ['nyt.top']);
});

test('unknown ids are ignored, so a removed outlet or topic breaks nothing', () => {
  assert.deepEqual(profileCards(profile({ outlets: ['bbc', 'gone'], topics: ['politics', 'vanished'] }), catalogue).map((card) => card.id), ['topic-politics']);
});

test('source ids are unique and sorted, as /api/sources wants', () => {
  const cards = profileCards(profile({ style: 'outlets', topics: ['politics'], outlets: ['guardian', 'bbc'] }), catalogue);
  assert.deepEqual(profileSourceIds(cards), ['bbc.politics', 'guardian.politics']);
});

test('widgets are empty until their feeds load, then filled', () => {
  const cards = profileCards(profile({ topics: ['politics'] }), catalogue);
  const empty = profileWidgets(cards);
  assert.deepEqual(empty['topic-politics'].sources.map((s) => s.items.length), [0, 0]);
  const item = { title: 'A story', link: 'https://bbc/1', date: '2026-10-31T00:00:00Z', image: null };
  const filled = profileWidgets(cards, { 'bbc.politics': { items: [item], error: null }, 'guardian.politics': { items: [], error: 'HTTP 503' } });
  assert.deepEqual(filled['topic-politics'].sources, [
    { name: 'BBC News', error: null, items: [item] },
    { name: 'The Guardian', error: 'HTTP 503', items: [] },
  ]);
});

test('building a layout: first time, the profile\'s cards in order and everything else hidden', () => {
  const cards = [{ id: 'topic-politics' }, { id: 'ai' }];
  assert.deepEqual(layoutForProfile(null, cards, ['bbc-news', 'ai', 'topic-politics']), [
    { id: 'topic-politics' }, { id: 'ai' }, { id: 'bbc-news', hidden: true },
  ]);
});

test('rebuilding keeps places and settings, hides what is no longer wanted and leaves own feeds alone', () => {
  const previous = [{ id: 'ai', limit: 4, col: 1 }, { id: 'custom-x' }, { id: 'topic-politics' }, { id: 'space', hidden: true }];
  const cards = [{ id: 'topic-world' }, { id: 'space' }, { id: 'ai' }];
  assert.deepEqual(layoutForProfile(previous, cards, ['ai', 'custom-x', 'topic-politics', 'space', 'topic-world', 'tech'], (id) => id.startsWith('custom-')), [
    { id: 'ai', limit: 4, col: 1 },
    { id: 'custom-x' },
    { id: 'space' },
    { id: 'topic-world' },
    { id: 'topic-politics', hidden: true },
    { id: 'tech', hidden: true },
  ]);
});

test('profiles keep only sensible values', () => {
  assert.equal(validProfile(null), null);
  assert.deepEqual(validProfile({ outlets: ['bbc', 'bbc', 7, 'Bad Id'], topics: 'ai', style: 'columns', pictures: false }), {
    outlets: ['bbc'], topics: [], style: 'topics', pictures: false, weather: true, backdrop: true, paywalls: true,
  });
});

test('settings keep a profile, and having one or skipping marks the reader as onboarded', () => {
  const withProfile = validSettings({ v: 1, tabs: {}, profile: profile() });
  assert.deepEqual(withProfile.profile, profile());
  assert.equal(withProfile.onboarded, true);
  assert.deepEqual(validSettings({ v: 1, tabs: {}, onboarded: true }), { v: 1, tabs: {}, custom: [], onboarded: true });
  assert.deepEqual(validSettings({ v: 1, tabs: {} }), { v: 1, tabs: {}, custom: [] });
});

test('a new reader in the UK starts with top stories, Hacker News, world, tech and football', () => {
  const suggested = defaultProfile(catalogue, 'uk');
  assert.deepEqual(suggested.topics, ['top', 'hacker-news', 'world', 'tech', 'football']);
  assert.deepEqual(profileCards(suggested, catalogue).map((card) => card.id), ['topic-top', 'hacker-news', 'topic-world', 'tech', 'topic-football']);
  assert.deepEqual(defaultProfile(catalogue, 'us').topics, ['top', 'hacker-news', 'world', 'tech', 'nfl']);
});

test('every topic sits in one of the setup bar\'s pillars, and each region lists its own', () => {
  const pillars = PILLARS.map((pillar) => pillar.id);
  for (const [id, topic] of Object.entries(catalogue.topics)) assert.ok(pillars.includes(topic.pillar), id);
  assert.deepEqual(pillarTopics(catalogue, 'uk', 'news'), ['top', 'politics', 'world', 'business', 'science', 'health', 'culture']);
  assert.deepEqual(pillarTopics(catalogue, 'uk', 'tech'), ['hacker-news', 'tech', 'ai', 'apple', 'gaming', 'space', 'hn-top', 'lobsters', 'techmeme', 'ai-analysis']);
  assert.deepEqual(pillarTopics(catalogue, 'uk', 'sport'), ['football', 'cricket', 'rugby', 'f1', 'sport']);
  assert.deepEqual(pillarTopics(catalogue, 'us', 'sport'), ['football', 'nfl', 'nba', 'mlb', 'f1', 'sport']);
  assert.deepEqual(pillarTopics(catalogue, 'uk', 'more'), ['film-tv', 'food', 'travel', 'money']);
});

test('turning topics on puts them last, and sources stay in the catalogue\'s order', () => {
  const start = profile({ topics: ['top', 'football'] });
  assert.deepEqual(withTopic(start, 'cricket', true).topics, ['top', 'football', 'cricket']);
  assert.deepEqual(withTopic(start, 'top', false).topics, ['football']);
  assert.deepEqual(withTopic(start, 'top', true).topics, ['football', 'top']);
  assert.deepEqual(withOutlet(profile({ outlets: ['sky'] }), 'bbc', true, catalogue).outlets, ['bbc', 'sky']);
  assert.deepEqual(withOutlet(profile({ outlets: ['bbc', 'sky'] }), 'bbc', false, catalogue).outlets, ['sky']);
});

test('changing region swaps suggested sources, keeps chosen ones the region lists, and drops its missing topics', () => {
  const uk = defaultProfile(catalogue, 'uk');
  assert.deepEqual(withRegion(uk, catalogue, 'uk', 'us').outlets, ['nyt', 'npr', 'cbs']);
  assert.deepEqual(withRegion(profile({ outlets: ['bbc', 'inews'] }), catalogue, 'uk', 'both').outlets, ['bbc', 'inews']);
  assert.deepEqual(withRegion(profile({ outlets: ['bbc', 'inews'] }), catalogue, 'uk', 'us').outlets, []);
  assert.deepEqual(withRegion(profile({ topics: ['top', 'cricket', 'football'] }), catalogue, 'uk', 'us').topics, ['top', 'football']);
  assert.equal(profileRegion(profile({ outlets: ['bbc', 'nyt'] }), catalogue), 'both');
  assert.equal(profileRegion(profile({ outlets: ['nyt'] }), catalogue), 'us');
  assert.equal(profileRegion(profile({ outlets: [] }), catalogue, 'us'), 'us');
});

test('a card leads back to the topic or source that made it', () => {
  for (const topic of ['top', 'football', 'hacker-news', 'tech']) assert.deepEqual(cardChoice(catalogue, topicCardId(catalogue, topic)), { topic });
  assert.equal(topicCardId(catalogue, 'tech'), 'tech');
  assert.deepEqual(cardChoice(catalogue, 'outlet-bbc'), { outlet: 'bbc' });
  assert.equal(cardChoice(catalogue, 'custom-abc'), null);
  assert.equal(cardChoice(catalogue, 'science'), null); // a feeds.json card no topic borrows
});

test('settings keep the setup bar open for a new reader only while asked to', () => {
  assert.equal(validSettings({ v: 1, tabs: {}, welcome: true }).welcome, true);
  assert.equal(validSettings({ v: 1, tabs: {}, welcome: 'yes' }).welcome, undefined);
});

test('leaving out paywalled sites drops their outlets and topic sources, and cards left with none', () => {
  const cards = (overrides) => profileCards(profile({ outlets: ['bbc', 'ft', 'economist'], topics: ['world', 'food', 'f1'], ...overrides }), catalogue);
  const sourceIds = (list) => profileSourceIds(list);
  assert.ok(sourceIds(cards()).includes('ft.world'));
  assert.ok(sourceIds(cards()).includes('food.2'));
  const free = cards({ paywalls: false });
  assert.deepEqual(free.find((card) => card.id === 'topic-world').sources, [{ id: 'bbc.world', name: 'BBC News' }]);
  assert.deepEqual(free.find((card) => card.id === 'topic-food').sources.map((source) => source.name), ['Guardian Food']);
  assert.deepEqual(free.find((card) => card.id === 'topic-f1').sources.map((source) => source.name), ['BBC Sport']);
  assert.ok(!sourceIds(free).some((id) => /^(ft|economist)\./.test(id)));
  assert.deepEqual(profileCards(profile({ outlets: ['ft', 'economist'], topics: ['world'], style: 'outlets', paywalls: false }), catalogue), []);
  assert.equal(validProfile({ paywalls: false }).paywalls, false);
});

test('a server card loses its paywalled sources only when it has some', () => {
  const tech = { title: 'Tech', sources: [{ name: 'Ars Technica', items: [] }, { name: 'The Verge', paywall: 'metered', items: [] }] };
  assert.deepEqual(withoutPaywalls(tech).sources.map((source) => source.name), ['Ars Technica']);
  const free = { title: 'Space', sources: [{ name: 'NASA', items: [] }] };
  assert.equal(withoutPaywalls(free), free);
});
