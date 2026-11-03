import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createWeather, describe, parsePlaceName, parseRain, parseWeather, rainLevel } from '../lib/weather.js';
import { renderPage } from '../lib/render.js';
import { rainHeight, renderScreenContent, skyFor } from '../public/forecast.js';

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

test('parses today in detail and the week ahead for the weather screen', () => {
  const weather = parseWeather(json, 'Beckenham');
  assert.equal(weather.today.hours.length, 24);
  assert.deepEqual(weather.today.hours.slice(0, 3).map((h) => h.time), ['Now', '13:00', '14:00']);
  assert.deepEqual(weather.today.hours[2], { time: '14:00', newDay: false, temperature: 16, rainChance: 60, rain: 0.6, wind: 12, label: 'Rain', icon: '🌧️' });
  assert.deepEqual(weather.today.hours.slice(11, 14).map((h) => [h.time, h.newDay]), [['23:00', false], ['Fri', true], ['01:00', false]]);
  assert.equal(weather.today.hours.at(-1).time, '11:00');
  assert.deepEqual([weather.today.sunrise, weather.today.sunset, weather.today.uv, weather.today.rain, weather.today.humidity, weather.today.wind], ['07:52', '17:41', 2, 3.2, 72, 9]);
  assert.equal(weather.days.length, 7);
  assert.deepEqual(weather.days[0], { date: '2026-10-30', day: 'Tomorrow', high: 15, low: 8, rainChance: 40, rain: 0.9, label: 'Rain', icon: '🌧️' });
  assert.deepEqual(weather.days.slice(1).map((d) => d.day), ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu']);
});

test('parses tomorrow in more detail, in parts of the day', () => {
  const { tomorrow } = parseWeather(json, 'Beckenham');
  assert.deepEqual([tomorrow.day, tomorrow.weekday, tomorrow.wind, tomorrow.uv, tomorrow.sunrise, tomorrow.sunset], ['Tomorrow', 'Fri', 14, 2, '07:52', '17:41']);
  assert.deepEqual(tomorrow.parts, [
    { name: 'Morning', low: 8, high: 12, rainChance: 0, rain: 0, wind: 7, label: 'Mostly clear', icon: '🌤️' },
    { name: 'Afternoon', low: 13, high: 15, rainChance: 0, rain: 0, wind: 14, label: 'Mostly clear', icon: '🌤️' },
    { name: 'Evening', low: 10, high: 13, rainChance: 40, rain: 0.9, wind: 7, label: 'Rain', icon: '🌧️' },
  ]);
});

test('tomorrow leaves out parts of the day the forecast does not cover', () => {
  const short = { ...json, hourly: Object.fromEntries(Object.entries(json.hourly).map(([key, values]) => [key, values.slice(0, -6)])) };
  const { tomorrow } = parseWeather(short, 'Beckenham');
  assert.deepEqual(tomorrow.parts.map((part) => part.name), ['Morning', 'Afternoon']);
  const { wind_speed_10m_max, ...older } = json.daily;
  assert.equal(parseWeather({ ...short, daily: older }, 'Beckenham').tomorrow.wind, 14); // from the hours instead
});

test('parses today hour by hour from midnight for the rain chart', () => {
  const weather = parseWeather(json, 'Beckenham');
  assert.deepEqual([weather.code, weather.isDay, weather.today.date], [2, true, '2026-10-29']);
  const hours = weather.today.rainHours;
  assert.deepEqual(hours.map((h) => h.time), ['11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00', '20:00', '21:00', '22:00', '23:00']);
  assert.deepEqual(hours[0], { time: '11:00', mm: 0, chance: 0, past: true, now: false });
  assert.deepEqual(hours[1], { time: '12:00', mm: 0, chance: 0, past: false, now: true });
  assert.deepEqual(hours[4], { time: '15:00', mm: 1.2, chance: 70, past: false, now: false });
});

test('the weather screen picks a sky for the weather now, by day or night', () => {
  assert.deepEqual(skyFor({ code: 0, isDay: true }), { sky: 'clear', time: 'day' });
  assert.deepEqual(skyFor({ code: 53, isDay: true }), { sky: 'drizzle', time: 'day' });
  assert.deepEqual(skyFor({ code: 82, isDay: false }), { sky: 'downpour', time: 'night' });
  assert.deepEqual(skyFor({ code: 95, isDay: true }), { sky: 'storm', time: 'day' });
  assert.deepEqual(skyFor({ code: 73, isDay: true }), { sky: 'snow', time: 'day' });
  assert.deepEqual(skyFor({}), { sky: 'cloud', time: 'day' }); // a forecast cached before the screen
});

test('clicking the masthead weather opens the weather screen', () => {
  const html = renderPage({ tabs: [{ id: 'home' }], activeTab: { id: 'home' }, widgets: [], weather: parseWeather(json, 'Beckenham') });
  assert.match(html, /<button class="weather-open" type="button" aria-haspopup="dialog" aria-controls="weather-screen"/);
  assert.match(html, /<dialog class="weather-screen" id="weather-screen" data-sky="fair" data-time="day" aria-label="Weather in Beckenham">/);
  assert.match(html, /<form class="ws-close-form" method="dialog">\s*<button class="ws-close"/);
  assert.match(html, /<strong>Beckenham<\/strong><span>Thursday 29 October<\/span>/);
  assert.match(html, /<p class="ws-big">15<span>°<\/span><\/p>/);
  assert.match(html, /<section class="ws-now"[\s\S]*?<section class="ws-section ws-week" aria-label="Next 7 days">[\s\S]*?<\/section>\s*<\/section>\s*<div class="ws-detail">/); // the week sits under now
  assert.match(html, /<span class="ws-day">Tomorrow<\/span>\s*<span class="ws-icon" title="Rain">/);
  assert.match(html, /Next 24 hours/);
  assert.match(html, /<li class="is-new-day">\s*<span class="ws-time">Fri<\/span>/);
  assert.match(html, /Tomorrow · Fri/);
  assert.match(html, /<span class="ws-part">Evening<\/span>[\s\S]*?10–13°[\s\S]*?40% · 0.9 mm/);
  assert.match(html, /<dt>UV<\/dt><dd>2 <small>low<\/small><\/dd>/);
  assert.match(html, /<span class="ws-temp">16°<\/span>\s*<span class="ws-wind">12 mph<\/span>/); // no rain under the hours now
});

test('the rain chart shows today with hours gone faded and the rain still to come', () => {
  const html = renderPage({ tabs: [{ id: 'home' }], activeTab: { id: 'home' }, widgets: [], weather: parseWeather(json, 'Beckenham') });
  assert.match(html, /<p class="ws-lead">Light rain to come: 1.9 mm, heaviest at 15:00<\/p>/);
  assert.match(html, /<div class="ws-bands" aria-hidden="true"><span>Heavy<\/span><span>Moderate<\/span><span>Light<\/span><\/div>/);
  assert.match(html, /<li class="is-past">\s*<span class="ws-tip is-start" aria-hidden="true">\s*<span class="ws-tip-time">11:00<\/span>\s*<span class="ws-tip-rain">Dry<\/span>/);
  assert.match(html, /<li class="is-now">[\s\S]*?<span class="ws-tip-time">12:00 · now<\/span>[\s\S]*?<span class="ws-tick">Now<\/span>/);
  assert.match(html, /<span class="ws-tip-rain"><i class="ws-dot is-light"><\/i>Light rain · <b>1.2 mm<\/b><\/span>\s*<span class="ws-tip-chance"><span class="ws-tip-meter"><span style="width:70%"><\/span><\/span>70% chance of rain<\/span>\s*<\/span>\s*<span class="ws-bar"><span class="ws-chance" style="opacity:0.70"><\/span><span class="ws-amount is-light" style="height:16%"><\/span>/);
  assert.match(html, /<span class="ws-tip is-end" aria-hidden="true">\s*<span class="ws-tip-time">23:00<\/span>/);
  const dry = parseWeather(json, 'Beckenham');
  dry.today.rainHours = dry.today.rainHours.map((hour) => ({ ...hour, mm: 0 }));
  assert.match(renderScreenContent(dry), /No rain expected today/);
});

test('rain is charted on a fixed scale, a third each for light, moderate and heavy', () => {
  assert.deepEqual([0, 0.4, 2.5, 5.05, 7.6, 11.8, 16, 30].map(rainHeight), [0, 5.3, 33.3, 50, 66.7, 83.3, 100, 100]);
  const weather = parseWeather(json, 'Beckenham');
  weather.today.rainHours[4] = { ...weather.today.rainHours[4], mm: 9 };
  assert.match(renderScreenContent(weather), /<p class="ws-lead">Heavy rain to come: 9.7 mm, heaviest at 15:00<\/p>/);
  assert.match(renderScreenContent(weather), /<span class="ws-amount is-heavy" style="height:72.2%">/);
});

test('a forecast cached before the details shows the screen with what it has', () => {
  const { today, tomorrow, days, ...older } = parseWeather(json, 'Beckenham');
  const html = renderScreenContent(older);
  assert.match(html, /<p class="ws-big">15<span>°<\/span><\/p>/);
  assert.doesNotMatch(html, /Rain today|Next 24 hours|Tomorrow|Next 7 days/);
});
