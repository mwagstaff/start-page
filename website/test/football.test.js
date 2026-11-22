import assert from 'node:assert/strict';
import test from 'node:test';
import { compactLogo, shortName, todaysFixtures } from '../lib/football.js';

test('shares a single UK matchday request and preserves cup ties, scores and match links', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    calls++;
    const params = new URL(url).searchParams;
    assert.equal(params.get('time_zone'), 'Europe/London');
    const date = params.get('start');
    assert.equal(params.get('end'), date);
    const match = { date, league: 'FA Cup', home_team: 'Liverpool', away_team: 'Oxford United', time: '15:00', match_details_id: '42' };
    if (params.get('epl_only') !== 'true') return Response.json([]);
    return Response.json([
      { ...match, date: '2000-01-01' }, { ...match, tv_channels: [
        { name: 'ESPN', countryCode: 'US' }, { name: 'Sky Sports Main Event', countryCode: 'GB' }, 'BBC One',
      ] },
      { ...match, score_status: '45+2', home_score: 0, away_score: 1 },
      { ...match, score_status: 'FT', home_score: 2, away_score: 1 },
    ]);
  });
  const [day] = await Promise.all([todaysFixtures(), todaysFixtures()]);
  assert.equal(calls, 2);
  assert.deepEqual(day.matches.map(m => [m.label, m.score, m.live]), [
    ['15:00', '', false], ['45+2′', '0–1', true], ['FT', '2–1', false],
  ]);
  assert.equal(day.matches[0].channel.logo, 'https://top-scores.skynolimit.dev/generated-assets/tv-logos/sky.png');
  assert.equal(day.matches[0].channel.fallbackLogo, 'https://top-scores.skynolimit.dev/logos/tv?name=Sky%20Sports%20Main%20Event');
  assert.equal(day.matches[1].channel, null);
  assert.equal(day.matches[0].href, 'https://top-scores.skynolimit.dev/matches/42?date=' + day.date);
});

test('merges every televised match with its watchability stars, flagging Premier League ones', async t => {
  t.mock.method(globalThis, 'fetch', async url => {
    const params = new URL(url).searchParams;
    const date = params.get('start');
    const pl = { date, time: '16:30', league: 'Premier League', home_team: 'Liverpool', away_team: 'Manchester United', away_short_name: 'Man Utd', match_details_id: '1', watchability_index: { stars: 5 }, tv_channels: [{ name: 'Sky Sports Main Event', countryCode: 'GB' }] };
    const other = { date, time: '14:30', league: 'Bundesliga', home_team: 'SV Werder Bremen', away_team: 'Hamburger SV', match_details_id: '2', watchability_index: { stars: 2 }, tv_channels: [{ name: 'Prime Video (UK)', countryCode: 'GB' }] };
    return Response.json(params.get('epl_only') === 'true' ? [pl] : [pl, other]);
  });
  const realNow = Date.now;
  t.mock.method(Date, 'now', () => realNow() + 60000); // skip past the shared cache
  const { matches } = await todaysFixtures();
  assert.deepEqual(matches.map(m => [m.home.short, m.away.short, m.premier, m.stars]), [
    ['Werder Bremen', 'Hamburg', false, 2], ['Liverpool', 'Man Utd', true, 5],
  ]);
});

test('shortens club names without mangling them', () => {
  assert.equal(shortName('FC Augsburg'), 'Augsburg');
  assert.equal(shortName('1. FSV Mainz 05'), 'Mainz 05');
  assert.equal(shortName('Málaga CF'), 'Málaga');
  assert.equal(shortName('Paris FC'), 'Paris FC');
  assert.equal(shortName('Inter Milan', 'Inter'), 'Inter');
});

test('uses the compact TV channel marks from the Top Scores app', () => {
  const logo = name => compactLogo(name)?.split('/').pop();
  assert.equal(logo('Sky Go UK'), 'sky.png');
  assert.equal(logo('TNT Sports 1'), 'tnt.png');
  assert.equal(logo('Prime Video (UK)'), 'amazon.png');
  assert.equal(logo('Ligue 1+ (UK IR)'), 'ligue%201%2B.png');
  assert.equal(logo('Premier Sports 1 HD'), 'premier%20sports.png');
  assert.equal(compactLogo('Viaplay'), null);
});
