import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { createFeedReader } from '../lib/feeds.js';
import { staggerPolls } from '../lib/feed-polling.js';
import { capacityDelay, gateOpen, withSummaryCapacity } from '../lib/summary-capacity.js';

test('each publisher keeps the full interval and its own time slot', async t => {
  t.mock.timers.enable({apis:['setTimeout','setInterval']});
  const seen = [];
  staggerPolls(['a','b'], 600000, key => seen.push(key));
  for (const [elapsed, expected] of [[149999,''],[1,'a'],[300000,'ab'],[300000,'aba'],[300000,'abab']]) {
    t.mock.timers.tick(elapsed);
    await Promise.resolve();
    assert.equal(seen.join(''),expected);
  }
});

test('validators and parsed items survive errors and 304s until replaced by a new response', async () => {
  const xml = '<rss><channel><item><title>A</title><link>https://example.org/a</link></item></channel></rss>';
  const seen = [];
  const replies = [new Response(xml,{headers:{etag:'"a"','last-modified':'yesterday'}}),
    new Response(null,{status:503}), new Response(null,{status:304}), new Response(xml), new Response(xml)];
  const read = createFeedReader({request:async (url,headers) => {seen.push(headers);return replies.shift();}});
  const [first, same] = await Promise.all([read('feed'),read('feed')]);
  assert.equal(first,same);
  await assert.rejects(read('feed'),/503/);
  assert.equal(await read('feed'),first);
  await read('feed');
  await read('feed');
  assert.deepEqual(seen[2],{'If-None-Match':'"a"','If-Modified-Since':'yesterday'});
  assert.deepEqual(seen[4],{});
});

test('only normal pressure and low load allow fast pacing; critical or unknown pauses', () => {
  assert.equal(capacityDelay(1,0.2),1000);
  assert.equal(capacityDelay(2,0.2),5000);
  assert.equal(capacityDelay(1,0.7),5000);
  for(const pair of [[1,0.9],[0,0],[4,0],[1,NaN]]) assert.equal(capacityDelay(...pair),null);
});

test('a Kidsplorers handover cancels an in-flight Tab1 request', async () => {
  let calls = 0;
  await assert.rejects(withSummaryCapacity(signal => sleep(1000, null, {signal}),
    async () => ++calls === 1 ? 1000 : null, 5), { name:'AbortError' });
});

test('only an in-flight request gets a confirmation for a transient QA claim', async () => {
  const idle = {paused:false, active:0};
  const claim = {paused:false, active:1, activeJobs:{'submission-qa':1}};
  for (const [running, states, allowed, rechecks] of [
    [false, [claim], false, 0], [true, [claim,idle], true, 1], [true,[claim,claim],false,1],
    [true, [{paused:true,active:0}], false,0], [true,[{paused:false,active:1,activeJobs:{nightly:1}}],false,0],
  ]) {
    let waits = 0;
    assert.equal(await gateOpen(running, async () => states.shift(), async () => { waits++; }), allowed);
    assert.equal(waits,rechecks);
  }
});
