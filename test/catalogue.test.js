import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { catalogueProblems, catalogueSources } from '../lib/catalogue.js';

const read = async (name) => JSON.parse(await readFile(new URL(`../config/${name}`, import.meta.url), 'utf8'));
const catalogue = await read('catalogue.json');
const { widgets } = await read('feeds.json');

const tiny = () => ({
  outlets: {
    a: { name: 'A', region: 'uk', sections: { top: 'https://a.example/top', politics: 'https://a.example/politics' } },
    b: { name: 'B', region: 'uk', sections: { top: 'https://b.example/top', politics: 'https://b.example/politics' } },
    c: { name: 'C', region: 'us', paywall: 'metered', sections: { top: 'https://c.example/top', politics: 'https://c.example/politics' } },
    d: { name: 'D', region: 'us', sections: { top: 'https://d.example/top', politics: 'https://d.example/politics' } },
  },
  topics: {
    politics: { label: 'Politics', section: 'politics' },
    chess: { label: 'Chess', sources: [{ name: 'Chess', url: 'https://chess.example/feed' }] },
    hn: { label: 'Hacker News', widget: 'hacker-news' },
  },
  defaults: { uk: { outlets: ['a'], topics: ['politics'] }, us: { outlets: ['c'], topics: ['politics', 'chess'] } },
});

test('the shipped catalogue is sound', () => {
  assert.deepEqual(catalogueProblems(catalogue, widgets), []);
});

test('every catalogue feed has a unique id and url', () => {
  const sources = catalogueSources(catalogue);
  assert.equal(new Set(sources.map((s) => s.id)).size, sources.length);
  assert.equal(new Set(sources.map((s) => s.url)).size, sources.length);
});

test('lists outlet sections and topic sources with stable ids', () => {
  assert.deepEqual(catalogueSources(tiny()).map((s) => s.id), [
    'a.top', 'a.politics', 'b.top', 'b.politics', 'c.top', 'c.politics', 'd.top', 'd.politics', 'chess.1',
  ]);
});

test('a small sound catalogue has no problems', () => {
  assert.deepEqual(catalogueProblems(tiny(), { 'hacker-news': {} }), []);
});

test('catches bad outlets', () => {
  const c = tiny();
  c.outlets.a.region = 'fr';
  c.outlets.b.paywall = 'sometimes';
  c.outlets.c.sections = { politics: 'http://c.example/politics', gossip: 'https://c.example/gossip' };
  c.outlets['Bad Id'] = { name: 'X', region: 'us', sections: { top: 'https://x.example' } };
  const problems = catalogueProblems(c, { 'hacker-news': {} });
  for (const fragment of ['region "fr"', 'paywall "sometimes"', 'Outlet c has no "top"', 'section "gossip"', 'politics isn\'t an https', 'Outlet id "Bad Id"']) {
    assert.ok(problems.some((p) => p.includes(fragment)), `expected a problem mentioning ${fragment}: ${problems.join(' | ')}`);
  }
});

test('catches topics that are ambiguous, empty or point nowhere', () => {
  const c = tiny();
  c.topics.both = { label: 'Both', section: 'politics', widget: 'hacker-news' };
  c.topics.empty = { label: 'Empty', sources: [] };
  c.topics.missing = { label: 'Missing', widget: 'nope' };
  c.topics.unknown = { label: 'Unknown', section: 'gardening' };
  const problems = catalogueProblems(c, { 'hacker-news': {} });
  for (const fragment of ['Topic both needs exactly one', 'Topic empty has no sources', 'borrows card "nope"', 'unknown section "gardening"']) {
    assert.ok(problems.some((p) => p.includes(fragment)), `expected a problem mentioning ${fragment}: ${problems.join(' | ')}`);
  }
});

test('a section topic needs at least two outlets in each region it is offered in', () => {
  const c = tiny();
  delete c.outlets.d.sections.politics;
  assert.deepEqual(catalogueProblems(c, { 'hacker-news': {} }), ['Topic politics has 1 US outlet with a "politics" feed; it needs at least 2.']);
  c.topics.politics.region = 'uk';
  c.defaults.us.topics = ['chess'];
  assert.deepEqual(catalogueProblems(c, { 'hacker-news': {} }), []);
});

test('defaults must exist and belong to their region', () => {
  const c = tiny();
  c.defaults.uk.outlets = ['c', 'zz'];
  c.topics.chess.region = 'us';
  c.defaults.uk.topics = ['chess'];
  delete c.defaults.us;
  const problems = catalogueProblems(c, { 'hacker-news': {} });
  assert.deepEqual(problems, [
    'UK default outlet "c" is from another region.',
    'UK default outlet "zz" isn\'t in the catalogue.',
    'UK default topic "chess" is for another region.',
    'No defaults for US.',
  ]);
});
