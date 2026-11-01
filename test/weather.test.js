import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createWeather, describe, parsePlaceName, parseRain, parseWeather, rainLevel } from '../lib/weather.js';
import { renderPage } from '../lib/render.js';

const json = JSON.parse(await readFile(new URL('./fixtures/open-meteo.json', import.meta.url), 'utf8'));

test('summarises current conditions, today and the next six hours', () => {
  const weather = parseWeather(json, 'Beckenham');
  assert.equal(weather.temperature, 15);
  assert.equal(weather.feelsLike, 15);
  assert.equal(weather.label, 'Partly cloudy');
  assert.deepEqual([weather.high, weather.low, weather.rainChance], [16, 11, 70]);
  assert.deepEqual(weather.hours.map((h) => h.time), ['13:00', '14:00', '15:00', '16:00', '17:00', '18:00']);
  assert.deepEqual(weather.hours[1], { time: '14:00', temperature: 16, rainChance: 60, label: 'Rain', icon: '🌧️' });
  assert.equal(weather.hours[4].icon, '🌙');
});

test('unknown weather codes still describe something', () => {
  assert.deepEqual(describe(42), { label: 'Unknown', icon: '🌡️' });
});

test('a failed refresh keeps the last forecast and marks it stale', async () => {
  let fail = false;
  const weather = createWeather({ name: 'Beckenham' }, {
    log: { warn() {} },
    fetch: async () => { if (fail) throw new Error('HTTP 500'); return parseWeather(json, 'Beckenham'); },
  });
  await weather.refresh();
  assert.equal(weather.current.stale, false);
  fail = true;
  await weather.refresh();
  assert.equal(weather.current.temperature, 15);
  assert.equal(weather.current.stale, true);
});

test('renders weather in the masthead', () => {
  const html = renderPage({ tabs: [{ id: 'home' }], activeTab: { id: 'home' }, widgets: [], weather: parseWeather(json, 'Beckenham') });
  assert.match(html, /aria-label="Weather in Beckenham"/);
  assert.match(html, /H 16° L 11° · feels 15° · 70% rain/);
  assert.match(html, /60% chance of rain/);
});

test('parsePlaceName prefers the town or city', () => {
  assert.equal(parsePlaceName({ address: { town: 'Beckenham', county: 'Greater London' } }), 'Beckenham');
  assert.equal(parsePlaceName({ address: { city: 'Paris', suburb: 'Marais' } }), 'Paris');
  assert.equal(parsePlaceName({ address: { city: 'City of Edinburgh', suburb: 'Old Town' } }), 'Edinburgh');
  assert.equal(parsePlaceName({ address: { city: 'Greater London', suburb: 'Beckenham', city_district: 'London Borough of Bromley' } }), 'Beckenham');
  assert.equal(parsePlaceName({ address: { city: 'Greater London', city_district: 'London Borough of Bromley' } }), 'Bromley');
  assert.equal(parsePlaceName({ error: 'Unable to geocode' }), null);
});

// 15-minute rain amounts (mm) starting at 15:15, as Open-Meteo returns them.
function minutely(amounts) {
  const time = amounts.map((_, i) => {
    const minutes = 15 * 60 + 15 + i * 15;
    return `2026-10-29T${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  });
  return { time, precipitation: amounts, precipitation_probability: amounts.map((mm) => (mm ? 80 : 0)) };
}

test('rain levels follow the light / moderate / heavy rate bands', () => {
  assert.deepEqual([0, 0.05, 0.4, 2.5, 7.6, 20].map(rainLevel), ['none', 'none', 'light', 'moderate', 'heavy', 'heavy']);
});

test('parseRain gives 15-minute slots with rates, a total and a summary', () => {
  const rain = parseRain(minutely([0, 0, 0.2, 1, 2.5, 0.3, 0, ...new Array(17).fill(0)]));
  assert.equal(rain.slots.length, 24);
  assert.deepEqual(rain.slots[2], { start: '15:30', end: '15:45', mm: 0.2, rate: 0.8, chance: 80, level: 'light' });
  assert.equal(rain.slots[4].level, 'heavy');
  assert.equal(rain.total, 4);
  assert.equal(rain.summary, 'Heavy rain from 15:30');
});

test('rain summaries cover dry spells, rain now, and rain all afternoon', () => {
  assert.equal(parseRain(minutely(new Array(24).fill(0))).summary, 'Dry for the next 6h');
  assert.equal(parseRain(minutely([0.3, 0.3, 0, ...new Array(21).fill(0)])).summary, 'Light rain now, easing by 15:30');
  assert.equal(parseRain(minutely(new Array(24).fill(1))).summary, 'Moderate rain for the next 6h');
  assert.equal(parseRain(undefined), null);
});

test('the masthead shows the rain chart with a tooltip per slot', () => {
  const weather = { ...parseWeather(json, 'Beckenham'), rain: parseRain(minutely([0, 0.5, ...new Array(22).fill(0)])) };
  const html = renderPage({ tabs: [{ id: 'home', label: 'Home', widgets: [] }], activeTab: { id: 'home' }, widgets: [], weather });
  assert.match(html, /<figcaption>Light rain from 15:15 · 0.5 mm<\/figcaption>/);
  assert.match(html, /title="15:15–15:30 · Light rain, 2 mm\/h · 80% chance"><span class="bar is-light" style="height:25%">/);
  assert.equal(html.match(/class="slot"/g).length, 24);
});

test('parses today in detail and the week ahead for the popover', () => {
  const weather = parseWeather(json, 'Beckenham');
  assert.deepEqual(weather.today.hours.map((h) => h.time), ['Now', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00']);
  assert.deepEqual(weather.today.hours[2], { time: '14:00', temperature: 16, rainChance: 60, rain: 0.6, wind: 12, label: 'Rain', icon: '🌧️' });
  assert.deepEqual([weather.today.sunrise, weather.today.sunset, weather.today.uv, weather.today.rain, weather.today.humidity, weather.today.wind], ['07:52', '17:41', 2, 3.2, 72, 9]);
  assert.equal(weather.days.length, 7);
  assert.deepEqual(weather.days[0], { date: '2026-10-30', day: 'Tomorrow', high: 15, low: 8, rainChance: 0, rain: 0, label: 'Mostly clear', icon: '🌤️' });
  assert.deepEqual(weather.days.slice(1).map((d) => d.day), ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu']);
});

test('the masthead weather opens a popover with today and the week ahead', () => {
  const html = renderPage({ tabs: [{ id: 'home' }], activeTab: { id: 'home' }, widgets: [], weather: parseWeather(json, 'Beckenham') });
  assert.match(html, /class="weather has-outlook" aria-label="Weather in Beckenham" tabindex="0" aria-describedby="forecast-detail"/);
  assert.match(html, /Today in Beckenham/);
  assert.match(html, /Next 7 days/);
  assert.match(html, /<dt>UV<\/dt><dd>2 <small>low<\/small><\/dd>/);
  assert.match(html, /60% · 0.6 mm/);
});

test('a forecast cached without the week ahead shows no popover', () => {
  const { today, days, ...older } = parseWeather(json, 'Beckenham');
  const html = renderPage({ tabs: [{ id: 'home' }], activeTab: { id: 'home' }, widgets: [], weather: older });
  assert.doesNotMatch(html, /forecast-detail/);
});
