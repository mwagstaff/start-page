import { test } from 'node:test';
import assert from 'node:assert/strict';
import { companionCards, appTopicCards } from '../lib/companion-cards.js';
const widget = id => ({title:id, limit:2, maxPerSource:2, sources:[{name:id, items:Array.from({length:150},(_,i)=>({title:`${id}-${i}`,link:`https://example.org/${id}/${i}`}))}]});
test('mobile ignores screen limits, skips hidden cards and caps each card at 100',()=>{
 const cards=companionCards({a:widget('a'),b:widget('b')},[{id:'a',limit:1},{id:'b',hidden:true}]);
 assert.equal(cards.length,1); assert.equal(cards[0].items.length,100);
});
test('mobile collection stays within 1000 with capacity for every card',()=>{
 const widgets=Object.fromEntries(Array.from({length:12},(_,i)=>[String(i),widget(String(i))]));
 const cards=companionCards(widgets,Object.keys(widgets).map(id=>({id})));
 assert.ok(cards.every(c=>c.items.length===83));
 assert.ok(cards.flatMap(c=>c.items).length<=1000);
});
test('overlapping feeds reserve a first page per card and deduplicate downloads',()=>{
 const cards=companionCards({a:widget('a'),b:widget('a')},[{id:'a'},{id:'b'}]);
 assert.ok(cards.every(c=>c.items.length>=8));
 const links=cards.flatMap(c=>c.items.map(i=>i.link));
 assert.equal(new Set(links).size,links.length);
});

const catalogue = {outlets:{paper:{name:'Paper',sections:['news']},science:{name:'Science',sections:['science']}},topics:{news:{label:'News',section:'news'},science:{label:'Science',section:'science'},hn:{widget:'hn'}}};
const profile = {outlets:['paper'],topics:['news'],style:'outlets',paywalls:false};
test('app topics add dedicated cards without mutating the shared profile or layout',()=>{
 const layout=[{id:'outlet-paper'},{id:'hn',hidden:true}];
 const before=JSON.stringify({profile,layout});
 const cards=appTopicCards(profile,catalogue,['science','hn','science','unknown'],layout);
 assert.deepEqual(cards.map(c=>c.id),['app-topic-science','app-hn']);
 assert.equal(cards[0].sources[0].id,'science.science');
 assert.equal(JSON.stringify({profile,layout}),before);
});
test('visible homepage topics are not duplicated and malformed additions are ignored',()=>{
 assert.deepEqual(appTopicCards(profile,catalogue,['hn'],[{id:'hn'}]),[]);
 assert.deepEqual(appTopicCards(profile,catalogue,{bad:true},[]),[]);
});
