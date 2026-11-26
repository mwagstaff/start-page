import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homepageCards, applyProfileChange } from '../public/homepage.js';
import { compareHomepages } from '../lib/homepage-comparison.js';
import { defaultProfile } from '../public/topics.js';
import { publicCatalogue } from '../lib/catalogue.js';
const config = JSON.parse(readFileSync(new URL('../config/feeds.json', import.meta.url)));
const catalogue = publicCatalogue(JSON.parse(readFileSync(new URL('../config/catalogue.json', import.meta.url))));
const profile = defaultProfile(catalogue, 'uk');
const legacy = config.tabs[0].widgets;
const context = { catalogue, widgets: config.widgets, legacy, defaultHomepage: profile };
const settings = { v: 1, tabs: {}, custom: [], profile };
const resolve = s => homepageCards(s, catalogue, config.widgets, legacy);
const explicit = { ...settings, tabs: {home:{cards:legacy.map(id => ({id}))}} };

test('profile-only, legacy and explicitly ordered accounts resolve consistently', () => {
  assert.equal(resolve(settings).find(c => !c.hidden).id, 'topic-top');
  assert.deepEqual(resolve(explicit).filter(c => !c.hidden).map(c => c.id), legacy);
  assert.equal(resolve(explicit).find(c => c.id === 'topic-top').hidden, true);
  const old = {v:1,tabs:{home:{cards:[{id:'space', limit:3}]}},custom:[]};
  assert.deepEqual(resolve(old).slice(0,2), [{id:'space',limit:3},{id:'bbc-news'}]);
  assert.deepEqual(resolve({...explicit,tabs:{home:{cards:[]}}}).filter(c => !c.hidden), []);
});

test('new topics preserve the BBC-first layout, hidden cards and per-card limits', () => {
  const pinned = structuredClone(explicit);
  pinned.tabs.home.cards[0].limit = 3;
  const next = { ...pinned, profile: {...profile, topics:[...profile.topics,'space']} };
  const edited = applyProfileChange(pinned, next, catalogue, config.widgets, legacy);
  assert.deepEqual(resolve(edited).filter(c => !c.hidden).slice(0,2), [{id:'bbc-news',limit:3},{id:'bbc-football'}]);
  assert.equal(resolve(edited).find(c => c.id === 'topic-top').hidden,true);
});

test('layout choices describe differing cards or preferences and skip equivalent representations', () => {
  const diff = compareHomepages(settings, explicit, context);
  assert.match(diff.account[0], /BBC News → BBC Football/);
  assert.match(diff.local[0], /Top stories/);
  const stored = {...settings, onboarded:true, tabs:{home:{cards:resolve(settings)}}};
  assert.deepEqual(compareHomepages(stored,settings,context), {local:[],account:[]});
  assert.deepEqual(compareHomepages({...explicit, footballTv:3},explicit,context), {local:['Matches on TV · 3 stars and above'],account:['Matches on TV · Off']});
});
