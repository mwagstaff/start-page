import assert from 'node:assert/strict';
const base=(process.argv[2]||'http://localhost:3067')+'/api/companion/';
async function request(route,body,token){const response=await fetch(base+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));return data;}
const first=await request('create',{settings:{v:1,tabs:{},custom:[]}});
const pair=await request('pair',{},first.token);
const second=await request('claim',{code:new URL(pair.payload).searchParams.get('code')});
await request('sync',{revision:second.revision,settings:{v:1,tabs:{},custom:[],density:'compact'},reading:{'https://example.org/tab1-smoke':{read:true,saved:true}}},second.token);
const synced=await request('sync',null,first.token);assert.equal(synced.settings.density,'compact');assert.equal(synced.reading['https://example.org/tab1-smoke'].saved,true);
const cards=await request('cards',{settings:synced.settings},first.token);assert.ok(cards.cards.length);assert.ok(cards.cards.some(c=>c.items.length));
const expanded=await request('cards',{settings:synced.settings,appTopics:['science','space']},first.token);
assert.ok(expanded.cards.some(c=>c.id.startsWith('app-')));
const unchanged=await request('sync',null,second.token);
assert.deepEqual(unchanged.settings,synced.settings);
assert.equal(unchanged.revision,synced.revision);
await request('unlink',{},first.token);await request('unlink',{},second.token);
console.log(JSON.stringify({pairing:'passed',sync:'passed',appOnlyTopics:'passed',extraCards:expanded.cards.filter(c=>c.id.startsWith('app-')).length,cards:cards.cards.length,stories:cards.cards.reduce((n,c)=>n+c.items.length,0)}));
