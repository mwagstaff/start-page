// Open-Meteo forecasts: the request, reading the response, and the markup for the masthead
// and the full-screen weather.
// Shared by the server (the default location) and the browser (the reader's own location).

import { escapeHtml } from './cards.js';

const HOURS_AHEAD = 6;
const DETAIL_HOURS = 24; // hour by hour in the forecast popover, from now
const FORECAST_DAYS = 16; // today plus the next 15 days, Open-Meteo's maximum
const VISIBLE_DAYS = 10;
let upcomingExpanded = false;
const RAIN_SLOTS = 24; // 15-minute steps: the next 6 hours
// Tomorrow's day in parts, as [name, first hour, hour after the last].
const DAY_PARTS = [['Morning', 6, 12], ['Afternoon', 12, 18], ['Evening', 18, 24]];

// Rain rate bands in mm/h (American Meteorological Society): light < 2.5, moderate < 7.6, heavy above.
const RAIN_LEVELS = [[0.1, 'none'], [2.5, 'light'], [7.6, 'moderate'], [Infinity, 'heavy']];
const LEVEL_ORDER = ['none', 'light', 'moderate', 'heavy'];

// Fog has no good emoji: Apple draws 🌫️ as a filled grey tile, out of place among the
// others. So it's drawn here: a cloud over drifting mist, sized like the emoji around it.
const FOG_ICON = '<svg class="fog-icon" viewBox="0 0 32 32" width="1em" height="1em" aria-hidden="true">'
  + '<g fill="#c3ccd8"><circle cx="8.5" cy="15.5" r="4"/><circle cx="15" cy="11.5" r="6"/><circle cx="22.5" cy="13.5" r="5"/><rect x="4.5" y="14" width="23" height="5.5" rx="2.75"/></g>' // the cloud's shaded underside, showing below...
  + '<g fill="#fbfcfd" transform="translate(0 -1.5)"><circle cx="8.5" cy="15.5" r="4"/><circle cx="15" cy="11.5" r="6"/><circle cx="22.5" cy="13.5" r="5"/><rect x="4.5" y="14" width="23" height="5.5" rx="2.75"/></g>' // ...the cloud itself
  + '<g stroke="#aab4c2" stroke-width="2.2" stroke-linecap="round"><path d="M5 24h17"/><path d="M10 27.5h17"/><path d="M7 31h12"/></g>'
  + '</svg>';

// WMO weather interpretation codes, as used by Open-Meteo, with the sky the weather screen
// draws for each (weather-screen.js).
const CONDITIONS = [
  [[0], 'Clear', '☀️', '🌙', 'clear'],
  [[1], 'Mostly clear', '🌤️', '🌙', 'fair'],
  [[2], 'Partly cloudy', '⛅', '☁️', 'fair'],
  [[3], 'Overcast', '☁️', '☁️', 'cloud'],
  [[45, 48], 'Fog', FOG_ICON, FOG_ICON, 'fog'],
  [[51, 53, 55, 56, 57], 'Drizzle', '🌦️', '🌧️', 'drizzle'],
  [[61, 63, 66, 80, 81], 'Rain', '🌧️', '🌧️', 'rain'],
  [[65, 67, 82], 'Heavy rain', '🌧️', '🌧️', 'downpour'],
  [[71, 73, 75, 77, 85, 86], 'Snow', '🌨️', '🌨️', 'snow'],
  [[95, 96, 99], 'Thunderstorm', '⛈️', '⛈️', 'storm'],
];

export function describe(code, isDay = true) {
  const match = CONDITIONS.find(([codes]) => codes.includes(code));
  if (!match) return { label: 'Unknown', icon: '🌡️' };
  return { label: match[1], icon: isDay ? match[2] : match[3] };
}

// The weather screen's sky for the weather now: the condition, and day or night.
export function skyFor({ code, isDay }) {
  return {
    sky: CONDITIONS.find(([codes]) => codes.includes(code))?.[4] ?? 'cloud',
    time: isDay === false ? 'night' : 'day',
  };
}

// Temperatures are kept in Celsius and shown in the reader's unit: Fahrenheit where that's
// what people use (the US and a few others), Celsius everywhere else, unless they chose
// one in Settings. The server picks from the browser's language; the browser sets its own.
const FAHRENHEIT_REGIONS = new Set(['US', 'PR', 'GU', 'VI', 'AS', 'MP', 'UM', 'LR', 'BS', 'BZ', 'KY', 'PW', 'FM', 'MH']);

export function unitForLocale(locale) {
  try {
    return FAHRENHEIT_REGIONS.has(new Intl.Locale(locale).maximize().region) ? 'F' : 'C';
  } catch {
    return 'C';
  }
}

let shownUnit = 'C'; // in the browser, set by page.js
export const setTemperatureUnit = (unit) => { shownUnit = unit === 'F' ? 'F' : 'C'; };
export const temperatureUnit = () => shownUnit;
const deg = (celsius, unit) => Number.isFinite(celsius) ? (unit === 'F' ? Math.round(celsius * 9 / 5 + 32) : celsius) : '—';
const rounded = (value) => Number.isFinite(value) ? Math.round(value) : null;
let feelsLikeMode = false;
export const setFeelsLikeMode = (enabled) => { feelsLikeMode = Boolean(enabled); };
export const isFeelsLikeMode = () => feelsLikeMode;

export function forecastUrl({ latitude, longitude }) {
  const params = new URLSearchParams({
    latitude,
    longitude,
    current: 'temperature_2m,apparent_temperature,weather_code,is_day,relative_humidity_2m,wind_speed_10m',
    hourly: 'apparent_temperature,wind_gusts_10m,temperature_2m,weather_code,precipitation_probability,is_day,precipitation,wind_speed_10m',
    daily: 'apparent_temperature_max,apparent_temperature_min,temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code,precipitation_sum,sunrise,sunset,uv_index_max,wind_speed_10m_max',
    minutely_15: 'precipitation,precipitation_probability',
    forecast_minutely_15: String(RAIN_SLOTS),
    wind_speed_unit: 'mph',
    timezone: 'auto', // the location's own time zone, so the hours read as local time
    forecast_days: String(FORECAST_DAYS),
    past_days: '1',
  });
  return `https://api.open-meteo.com/v1/forecast?${params}`;
}

export function rainLevel(ratePerHour) {
  return RAIN_LEVELS.find(([limit]) => ratePerHour < limit)[1];
}

// Each 15-minute value is the rain that falls in the 15 minutes up to its timestamp.
export function parseRain(minutely) {
  if (!minutely?.time?.length || !minutely.precipitation) return null;
  const slots = minutely.time.slice(0, RAIN_SLOTS).map((time, i) => {
    const end = new Date(`${time}:00Z`);
    const start = new Date(end.getTime() - 15 * 60_000);
    const mm = minutely.precipitation[i] ?? 0;
    const rate = Math.round(mm * 4 * 10) / 10;
    return {
      start: start.toISOString().slice(11, 16),
      end: time.slice(11, 16),
      mm,
      rate,
      chance: minutely.precipitation_probability?.[i] ?? null,
      level: rainLevel(rate),
    };
  });
  const total = Math.round(slots.reduce((sum, slot) => sum + slot.mm, 0) * 10) / 10;
  return { slots, total, summary: rainSummary(slots) };
}

const capitalise = (text) => text.charAt(0).toUpperCase() + text.slice(1);

// One line that answers "will it rain soon, and how hard?"
export function rainSummary(slots) {
  const wet = (slot) => slot.level !== 'none';
  const first = slots.findIndex(wet);
  if (first === -1) return `Dry for the next ${Math.round(slots.length / 4)}h`;
  const spellEnd = slots.findIndex((slot, i) => i > first && !wet(slot));
  const spell = slots.slice(first, spellEnd === -1 ? undefined : spellEnd);
  const peak = spell.reduce((top, slot) => (LEVEL_ORDER.indexOf(slot.level) > LEVEL_ORDER.indexOf(top) ? slot.level : top), 'light');
  if (first === 0) {
    return spellEnd === -1 ? `${capitalise(peak)} rain for the next ${Math.round(slots.length / 4)}h` : `${capitalise(peak)} rain now, easing by ${slots[spellEnd - 1].end}`;
  }
  return `${capitalise(peak)} rain from ${slots[first].start}`;
}

const round1 = (value) => Math.round(value * 10) / 10;

// "Mon", from a local date such as "2026-11-02" (read as UTC, so no time zone can shift it).
export function weekday(date) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
}

const sum = (values) => values.reduce((total, value) => total + value, 0);

// One part of a day from its hours: the range of temperatures, the wettest and windiest it
// gets, and the most severe weather (as Open-Meteo picks a day's weather code).
function dayPart(hourly, name, indexes) {
  const temperatures = indexes.map((i) => hourly.temperature_2m[i]);
  const middle = indexes[Math.floor(indexes.length / 2)];
  return {
    name,
    feelsLow: indexes.every((i) => Number.isFinite(hourly.apparent_temperature?.[i])) ? rounded(Math.min(...indexes.map((i) => hourly.apparent_temperature[i]))) : null,
    feelsHigh: indexes.every((i) => Number.isFinite(hourly.apparent_temperature?.[i])) ? rounded(Math.max(...indexes.map((i) => hourly.apparent_temperature[i]))) : null,
    low: Math.round(Math.min(...temperatures)),
    high: Math.round(Math.max(...temperatures)),
    rainChance: Math.max(...indexes.map((i) => hourly.precipitation_probability[i] ?? 0)),
    rain: round1(sum(indexes.map((i) => hourly.precipitation?.[i] ?? 0))),
    wind: hourly.wind_speed_10m ? Math.round(Math.max(...indexes.map((i) => hourly.wind_speed_10m[i]))) : null,
    ...describe(Math.max(...indexes.map((i) => hourly.weather_code[i])), hourly.is_day[middle] === 1),
  };
}

// A day ahead in more detail than the week's one line: the extra daily figures, the morning,
// afternoon and evening, and the day hour by hour (for picking it on the weather screen). A
// part is left out unless every hour of it is in the forecast. The hours keep the weather
// code rather than its icon, as seven days of icons would swell the forecast kept and sent.
function parseDay({ hourly, daily }, day, i) {
  const hoursOf = (from, to) => hourly.time.flatMap((time, index) => {
    const hour = Number(time.slice(11, 13));
    return time.startsWith(day.date) && hour >= from && hour < to
      && [hourly.temperature_2m[index], hourly.weather_code[index], hourly.precipitation?.[index]].every(Number.isFinite) ? [index] : [];
  });
  const parts = DAY_PARTS.flatMap(([name, from, to]) => {
    const indexes = hoursOf(from, to);
    return indexes.length === to - from ? [dayPart(hourly, name, indexes)] : [];
  });
  const hourlyWind = hourly.wind_speed_10m && hoursOf(0, 24).map((index) => hourly.wind_speed_10m[index]).filter(Number.isFinite);
  const wind = daily.wind_speed_10m_max?.[i] ?? (hourlyWind?.length ? Math.max(...hourlyWind) : null);
  return {
    ...day,
    feelsHigh: rounded(daily.apparent_temperature_max?.[i]),
    feelsLow: rounded(daily.apparent_temperature_min?.[i]),
    weekday: weekday(day.date),
    sunrise: daily.sunrise[i]?.slice(11, 16) ?? null,
    sunset: daily.sunset[i]?.slice(11, 16) ?? null,
    uv: daily.uv_index_max?.[i] != null ? Math.round(daily.uv_index_max[i]) : null,
    wind: wind != null ? Math.round(wind) : null,
    parts,
    hours: hoursOf(0, 24).map((index) => ({
      time: hourly.time[index].slice(11, 16),
      temperature: Math.round(hourly.temperature_2m[index]),
      feelsLike: rounded(hourly.apparent_temperature?.[index]),
      gust: rounded(hourly.wind_gusts_10m?.[index]),
      rainChance: hourly.precipitation_probability[index] ?? null,
      rain: round1(hourly.precipitation?.[index] ?? 0),
      wind: Number.isFinite(hourly.wind_speed_10m?.[index]) ? Math.round(hourly.wind_speed_10m[index]) : null,
      code: hourly.weather_code[index],
      isDay: hourly.is_day[index] === 1,
    })),
  };
}

// Today in detail and the week ahead, for the popover. Null for forecasts fetched before
// these fields were asked for (a forecast cached in the browser).
function parseOutlook(json, currentHour, todayIndex) {
  const { current, hourly, daily } = json;
  if (!daily.weather_code || !daily.sunrise) return null;
  const from = Math.max(0, hourly.time.findIndex((time) => time >= currentHour));
  const hours = hourly.time.slice(from, from + DETAIL_HOURS).map((time, offset) => {
    const i = from + offset;
    const newDay = offset > 0 && time.slice(11, 13) === '00';
    return {
      // Midnight is named for the day it starts, so the day change stands out.
      time: offset === 0 ? 'Now' : newDay ? weekday(time.slice(0, 10)) : time.slice(11, 16),
      newDay,
      feelsLike: rounded(hourly.apparent_temperature?.[i]),
      gust: rounded(hourly.wind_gusts_10m?.[i]),
      temperature: Math.round(hourly.temperature_2m[i]),
      rainChance: hourly.precipitation_probability[i] ?? null,
      rain: round1(hourly.precipitation?.[i] ?? 0),
      wind: rounded(hourly.wind_speed_10m?.[i]),
      ...describe(hourly.weather_code[i], hourly.is_day[i] === 1),
    };
  });
  const yesterday = new Date(`${currentHour.slice(0, 10)}T12:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const yesterdayDate = yesterday.toISOString().slice(0, 10);
  const days = daily.time.flatMap((date, i) => {
    if (i === todayIndex || date < yesterdayDate || i >= todayIndex + FORECAST_DAYS) return [];
    // The API can include dates beyond model coverage with null daily values.
    if (![daily.temperature_2m_max[i], daily.temperature_2m_min[i], daily.weather_code[i], daily.precipitation_sum?.[i]].every(Number.isFinite)) return [];
    return [parseDay(json, {
      date,
      day: date === yesterdayDate ? 'Yesterday' : i === todayIndex + 1 ? 'Tomorrow' : `${weekday(date)} ${Number(date.slice(8, 10))}`,
      high: Math.round(daily.temperature_2m_max[i]),
      low: Math.round(daily.temperature_2m_min[i]),
      rainChance: daily.precipitation_probability_max[i] ?? null,
      rain: round1(daily.precipitation_sum?.[i] ?? 0),
      ...describe(daily.weather_code[i]),
    }, i)];
  });
  // Today from midnight, for the rain chart. Hours gone stay (shown dimmed) so the day reads whole.
  const rainHours = hourly.time.flatMap((time, i) => (time.startsWith(daily.time[todayIndex]) ? [{
    time: time.slice(11, 16),
    mm: round1(hourly.precipitation?.[i] ?? 0),
    chance: hourly.precipitation_probability[i] ?? null,
    past: time < currentHour,
    now: time === currentHour,
  }] : []));
  return {
    tomorrow: days.find((day) => day.date === daily.time[todayIndex + 1]),
    today: {
      ...describe(daily.weather_code[todayIndex]),
      sunrise: daily.sunrise[todayIndex].slice(11, 16),
      sunset: daily.sunset[todayIndex].slice(11, 16),
      uv: daily.uv_index_max ? Math.round(daily.uv_index_max[todayIndex]) : null,
      rain: round1(daily.precipitation_sum?.[todayIndex] ?? 0),
      humidity: current.relative_humidity_2m ?? null,
      wind: current.wind_speed_10m != null ? Math.round(current.wind_speed_10m) : null,
      date: daily.time[todayIndex],
      hours,
      rainHours,
    },
    days,
  };
}

// Open-Meteo times are local strings such as "2026-10-29T12:15".
export function parseWeather(json, name) {
  const { current, hourly, daily } = json;
  const currentHour = `${current.time.slice(0, 13)}:00`;
  const todayIndex = daily.time.indexOf(current.time.slice(0, 10));
  if (todayIndex === -1) throw new Error('Weather response is missing today');
  const start = hourly.time.findIndex((time) => time > currentHour);
  const hours = start === -1 ? [] : hourly.time.slice(start, start + HOURS_AHEAD).map((time, offset) => {
    const i = start + offset;
    return {
      time: time.slice(11, 16),
      temperature: Math.round(hourly.temperature_2m[i]),
      rainChance: hourly.precipitation_probability[i],
      ...describe(hourly.weather_code[i], hourly.is_day[i] === 1),
    };
  });
  return {
    name,
    temperature: Math.round(current.temperature_2m),
    feelsLike: rounded(current.apparent_temperature),
    feelsHigh: rounded(daily.apparent_temperature_max?.[todayIndex]),
    feelsLow: rounded(daily.apparent_temperature_min?.[todayIndex]),
    ...describe(current.weather_code, current.is_day === 1),
    code: current.weather_code,
    isDay: current.is_day === 1,
    high: Math.round(daily.temperature_2m_max[todayIndex]),
    low: Math.round(daily.temperature_2m_min[todayIndex]),
    rainChance: daily.precipitation_probability_max[todayIndex],
    hours,
    rain: parseRain(json.minutely_15),
    ...parseOutlook(json, currentHour, todayIndex),
  };
}

// OSM names come in many shapes: "City of Edinburgh", or "Greater London" with the useful
// part ("Beckenham") in the suburb. Prefer the town, then a tidied city, then the suburb.
export function parsePlaceName(json) {
  const address = json?.address ?? {};
  const town = address.town || address.village || address.hamlet;
  if (town) return town;
  const city = address.city?.replace(/^City of /, '');
  if (city && !city.startsWith('Greater ')) return city;
  return address.suburb || address.city_district?.replace(/^London Borough of /, '') || city || address.municipality || address.county || null;
}

const RAIN_LABELS = { none: 'Dry', light: 'Light rain', moderate: 'Moderate rain', heavy: 'Heavy rain' };
const RAIN_FULL_SCALE = 8; // mm/h at full bar height; anything heavier is capped

// Next 6 hours of rain in 15-minute bars: height is the rate, shade the intensity band.
function renderRain(rain) {
  if (!rain) return '';
  const bars = rain.slots.map((slot) => {
    const label = slot.level === 'none'
      ? `${slot.start}–${slot.end} · Dry`
      : `${slot.start}–${slot.end} · ${RAIN_LABELS[slot.level]}, ${slot.rate} mm/h${slot.chance != null ? ` · ${slot.chance}% chance` : ''}`;
    const height = slot.level === 'none' ? 0 : Math.min(100, (slot.rate / RAIN_FULL_SCALE) * 100);
    const fill = height ? `<span class="bar is-${slot.level}" style="height:${height.toFixed(0)}%"></span>` : '';
    return `<span class="slot" title="${escapeHtml(label)}">${fill}</span>`;
  }).join('');
  const total = rain.total > 0 ? ` · ${rain.total} mm` : '';
  const last = rain.slots.at(-1)?.end ?? '';
  const middle = rain.slots[Math.floor(rain.slots.length / 2) - 1]?.end ?? '';
  return `<figure class="rain" aria-label="${escapeHtml(`${rain.summary}${total}`)}">
        <figcaption>${escapeHtml(rain.summary)}${escapeHtml(total)}</figcaption>
        <div class="rain-bars" aria-hidden="true">${bars}</div>
        <div class="rain-axis" aria-hidden="true"><span>Now</span><span>${escapeHtml(middle)}</span><span>${escapeHtml(last)}</span></div>
      </figure>`;
}

const UV_LEVELS = [[3, 'low'], [6, 'moderate'], [8, 'high'], [11, 'very high'], [Infinity, 'extreme']];
const uvLabel = (uv) => UV_LEVELS.find(([limit]) => uv < limit)[1];

const fact = (label, value) => `<div><dt>${label}</dt><dd>${value}</dd></div>`;

// Rain for an hour or a day: the chance, and how much when there's enough to measure.
function rainText({ rainChance, rain }) {
  const parts = [];
  if (rainChance) parts.push(`${rainChance}%`);
  if (rain >= 0.1) parts.push(`${rain} mm`);
  return parts.join(' · ');
}

// "Tuesday 3 November", from a local date such as "2026-11-03".
const longDate = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

// Rain in mm/h on a fixed scale, so a bar's height says how hard it rains whatever the day:
// each band (light to 2.5, moderate to 7.6, heavy) takes a third of the chart, heavy topping
// out at 16 mm/h.
const RAIN_SCALE = [0, 2.5, 7.6, 16];

export function rainHeight(rate) {
  const band = RAIN_SCALE.findIndex((limit) => rate < limit) - 1;
  if (band < 0) return 100; // heavier than the scale goes
  const within = (rate - RAIN_SCALE[band]) / (RAIN_SCALE[band + 1] - RAIN_SCALE[band]);
  return round1(((band + within) / 3) * 100);
}

// A day's rain hour by hour: a bar for how hard it falls, on a column shaded by the chance of
// any. The line above says how hard and how much: for today, how much is still to come, then
// the next 6 hours; for a day ahead, all of it.
function renderRainToday({ today, rain }) {
  if (!today.rainHours?.length) return '';
  const ahead = today.rainHours.filter((hour) => !hour.past);
  const total = round1(sum(ahead.map((hour) => hour.mm)));
  const peak = ahead.reduce((top, hour) => (hour.mm > (top?.mm ?? 0) ? hour : top), null);
  const headline = total > 0
    ? `${capitalise(rainLevel(peak.mm) === 'none' ? 'light' : rainLevel(peak.mm))} rain to come: ${total} mm, heaviest at ${peak.time}`
    : today.rainHours.some((hour) => hour.mm > 0) ? 'Dry for the rest of the day' : 'No rain expected today';
  const note = rain ? `Next 6 hours: ${rain.summary.charAt(0).toLowerCase() + rain.summary.slice(1)}` : '';
  return renderRainChart(today.rainHours, 'Rain today', headline, note);
}

function renderRainDay(day) {
  const hours = day.hours.map((hour) => ({ time: hour.time, mm: hour.rain, chance: hour.rainChance }));
  const total = round1(sum(hours.map((hour) => hour.mm)));
  const peak = hours.reduce((top, hour) => (hour.mm > (top?.mm ?? 0) ? hour : top), null);
  const headline = total > 0
    ? `${capitalise(rainLevel(peak.mm) === 'none' ? 'light' : rainLevel(peak.mm))} rain: ${total} mm, heaviest at ${peak.time}`
    : 'No rain expected';
  return renderRainChart(hours, `Rain · ${weekday(day.date)}`, headline, hours.length < 24 ? 'Partial forecast: available hours only' : '');
}

function renderRainChart(hours, title, headline, note = '') {
  // Each hour has its own popover, shown at once on hover (style.css). Near the ends of the
  // chart it lines up with the chart's edge rather than spilling past it.
  const columns = hours.map((hour, i) => {
    const tick = hour.now ? 'Now' : Number(hour.time.slice(0, 2)) % 3 === 0 ? hour.time.slice(0, 2) : '';
    const level = hour.mm >= 0.1 ? (rainLevel(hour.mm) === 'none' ? 'light' : rainLevel(hour.mm)) : null;
    const edge = i < 3 ? ' is-start' : i >= hours.length - 3 ? ' is-end' : '';
    const classes = [hour.past && 'is-past', hour.now && 'is-now'].filter(Boolean).join(' ');
    return `<li${classes ? ` class="${classes}"` : ''}>
            <span class="ws-tip${edge}" aria-hidden="true">
              <span class="ws-tip-time">${escapeHtml(hour.time)}${hour.now ? ' · now' : ''}</span>
              <span class="ws-tip-rain">${level ? `<i class="ws-dot is-${level}"></i>${RAIN_LABELS[level]} · <b>${hour.mm} mm</b>` : 'Dry'}</span>
              ${hour.chance != null ? `<span class="ws-tip-chance"><span class="ws-tip-meter"><span style="width:${hour.chance}%"></span></span>${hour.chance}% chance of rain</span>` : ''}
            </span>
            <span class="ws-bar">${hour.chance ? `<span class="ws-chance" style="opacity:${(hour.chance / 100).toFixed(2)}"></span>` : ''}${level ? `<span class="ws-amount is-${level}" style="height:${rainHeight(hour.mm)}%"></span>` : ''}</span>
            <span class="ws-tick">${tick}</span>
          </li>`;
  }).join('');
  return `<section class="ws-section ws-rain" aria-label="${escapeHtml(title)}">
        <h3>${escapeHtml(title)}${note ? `<span class="ws-h3-note">${escapeHtml(note)}</span>` : ''}</h3>
        <p class="ws-lead">${escapeHtml(headline)}</p>
        <div class="ws-rain-chart">
          <div class="ws-bands" aria-hidden="true"><span>Heavy</span><span>Moderate</span><span>Light</span></div>
          <p class="ws-legend"><span class="ws-key-amount"></span>How hard it rains <span class="ws-key-chance"></span>Shade: chance of rain</p>
          <ol role="img" aria-label="${escapeHtml(`${title}, hour by hour. ${headline}.`)}">${columns}</ol>
        </div>
      </section>`;
}

function renderHours(hours, unit, title = `Next ${hours.length} hours`) {
  const items = hours.map((hour) => `<li${hour.newDay ? ' class="is-new-day"' : ''}>
          <span class="ws-time">${escapeHtml(hour.time)}</span>
          <span class="ws-icon" title="${escapeHtml(hour.label)}">${hour.icon}</span>
          <span class="ws-temp">${deg(hour.temperature, unit)}°</span>
          ${hour.wind != null ? `<span class="ws-wind">${hour.wind} mph</span>` : ''}
        </li>`).join('');
  return `<section class="ws-section" aria-label="${escapeHtml(title)}">
        <h3>${escapeHtml(title)}</h3>
        <ol class="ws-hours">${items}</ol>
      </section>`;
}

// A day ahead's figures go on one line, to keep the screen to one window's height. Tomorrow
// shows under today; a day picked from the week heads the column, with a way back to today.
function renderTomorrow(tomorrow, unit, picked = false) {
  const facts = [
    `Rain ${escapeHtml(rainText(tomorrow) || 'none expected')}`,
    tomorrow.wind != null && `Wind ${tomorrow.wind} mph`,
    tomorrow.uv != null && `UV ${tomorrow.uv} ${uvLabel(tomorrow.uv)}`,
    tomorrow.sunrise && tomorrow.sunset && `Sun ↑ ${escapeHtml(tomorrow.sunrise)} ↓ ${escapeHtml(tomorrow.sunset)}`,
  ].filter(Boolean).join(' · ');
  const parts = tomorrow.parts.map((part) => `<li>
          <span class="ws-icon" title="${escapeHtml(part.label)}">${part.icon}</span>
          <span class="ws-part">${escapeHtml(part.name)}</span>
          <span class="ws-temp">${part.low === part.high ? `${deg(part.high, unit)}°` : `${deg(part.low, unit)}–${deg(part.high, unit)}°`}</span>
          <span class="ws-part-detail"><span class="ws-rain-text">${escapeHtml(rainText(part))}</span>${part.wind != null ? ` <span class="ws-wind">${part.wind} mph</span>` : ''}</span>
        </li>`).join('');
  const title = picked ? longDate(tomorrow.date) : `Tomorrow · ${tomorrow.weekday}`;
  const back = picked ? '<button class="ws-back" type="button" data-day=""><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5L5.5 8l4.5 4.5"/></svg>Back to today</button>' : '';
  return `<section class="ws-section ws-tomorrow" aria-label="${escapeHtml(title)}">
        <h3>${escapeHtml(title)}${back}</h3>
        <p class="ws-lead"><span class="ws-icon" aria-hidden="true">${tomorrow.icon}</span> ${escapeHtml(tomorrow.label)}, ${deg(tomorrow.high, unit)}° <span class="ws-dim">/ ${deg(tomorrow.low, unit)}°</span></p>
        <p class="ws-sub">${facts}</p>
        ${parts ? `<ol class="ws-parts">${parts}</ol>` : ''}
      </section>`;
}

// The week, compact: each day's range of temperatures drawn on one scale for the whole week.
// A day with its hours can be picked, to show it in detail; picked again, it's back to today.
function renderWeek(days, unit, picked, today, expanded) {
  const visibleDays = VISIBLE_DAYS + days.filter((day) => day.date < today?.date).length;
  if (today?.date) days = [{ ...today, day: 'Today', isToday: true }, ...days].sort((a, b) => a.date.localeCompare(b.date));
  const lowest = Math.min(...days.map((day) => day.low).filter(Number.isFinite));
  const span = Math.max(1, Math.max(...days.map((day) => day.high).filter(Number.isFinite)) - lowest);
  const rows = days.map((day, index) => `<li${!expanded && index >= visibleDays ? ' hidden' : ''}>
          ${day.isToday || day.hours?.length ? `<button class="ws-day-pick" type="button" data-day="${day.isToday || day.date === picked ? '' : day.date}" aria-pressed="${day.isToday ? !picked : day.date === picked}" aria-label="${escapeHtml(`${longDate(day.date)}: ${day.label}, ${deg(day.high, unit)}° / ${deg(day.low, unit)}°`)}"></button>` : ''}
          <span class="ws-day">${escapeHtml(day.day)}</span>
          <span class="ws-icon" title="${escapeHtml(day.label)}">${day.icon}</span>
          <span class="ws-rain-text">${escapeHtml(rainText(day))}</span>
          <span class="ws-low">${deg(day.low, unit)}°</span>
          <span class="ws-range" aria-hidden="true"><span ${Number.isFinite(day.low) && Number.isFinite(day.high) ? '' : 'hidden'} style="left:${(Number.isFinite(day.low) ? (day.low - lowest) / span * 100 : 0).toFixed(1)}%;right:${(Number.isFinite(day.high) ? 100 - (day.high - lowest) / span * 100 : 100).toFixed(1)}%"></span></span>
          <span class="ws-high">${deg(day.high, unit)}°</span>
        </li>`).join('');
  return `<section class="ws-section ws-week" aria-label="Upcoming">
        <h3>Upcoming${days.some((day) => day.hours?.length) ? '<span class="ws-h3-note">Pick a day · ↑ ↓ to change</span>' : ''}</h3>
        <ol id="ws-upcoming-days">${rows}</ol>
        ${days.length > visibleDays ? `<button type="button" class="ws-more" data-upcoming-toggle aria-expanded="${expanded}" aria-controls="ws-upcoming-days">${expanded ? 'Less' : 'More'}</button>` : ''}
      </section>`;
}

// Project display values without mutating the shared forecast or its masthead.
function apparentValues(value) {
  if (!value) return value;
  return { ...value, temperature: value.feelsLike, high: value.feelsHigh, low: value.feelsLow,
    hours: value.hours?.map(apparentValues), parts: value.parts?.map(apparentValues),
    days: value.days?.map(apparentValues), today: apparentValues(value.today), tomorrow: apparentValues(value.tomorrow) };
}

export function windSummary(hours = []) {
  const valid = hours.filter((hour) => Number.isFinite(hour.wind) && hour.wind >= 0);
  if (!valid.length) return 'Wind forecast unavailable';
  const peak = valid.reduce((a, b) => b.wind > a.wind ? b : a);
  const low = Math.min(...valid.map((hour) => hour.wind));
  const gusts = hours.map((hour) => hour.gust).filter((gust) => Number.isFinite(gust) && gust >= 0);
  const strength = peak.wind < 4 ? 'Light winds' : peak.wind < 13 ? 'A gentle breeze' : peak.wind < 25 ? 'Breezy' : 'Windy';
  const speed = low === peak.wind ? `${low}` : `${low}–${peak.wind}`;
  return `${strength} · ${speed} mph${low !== peak.wind ? `, strongest ${peak.time === 'Now' ? 'now' : `at ${peak.time}`}` : ''}${gusts.length ? ` · gusts up to ${Math.max(...gusts)} mph` : ''}${valid.length < hours.length ? ' · partial wind forecast' : ''}`;
}

function renderWind(hours, title) {
  return `<section class="ws-section ws-wind-summary" aria-label="${escapeHtml(title)}"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(windSummary(hours))}</p></section>`;
}

// What the weather screen shows: now on one side, large, with the week under it; today's
// rain, the next 24 hours and tomorrow on the other. Forecasts cached before some of this was fetched show
// what they have.
export function renderScreenContent(weather, unit = shownUnit, date = pickedDay, expanded = upcomingExpanded, feels = feelsLikeMode) {
  const regularTemperature = weather.temperature;
  const validDays = weather.days?.filter((day) => day.label !== 'Unknown' && Number.isFinite(day.low) && Number.isFinite(day.high));
  weather = { ...weather, days: validDays };
  if (feels) weather = apparentValues(weather);
  const { today, tomorrow } = weather;
  // Also reject the old cached parser's Unknown/0-degree placeholder days.
  const days = weather.days;
  const picked = days?.find((day) => day.date === date && day.hours?.length);
  const facts = today ? [
    fact('Rain', escapeHtml(rainText({ rainChance: weather.rainChance, rain: today.rain }) || 'None expected')),
    today.wind != null && fact('Wind', `${today.wind} mph`),
    today.humidity != null && fact('Humidity', `${today.humidity}%`),
    today.uv != null && fact('UV', `${today.uv} <small>${uvLabel(today.uv)}</small>`),
    fact('Sunrise', escapeHtml(today.sunrise)),
    fact('Sunset', escapeHtml(today.sunset)),
  ].filter(Boolean).join('') : '';
  return `<header class="ws-top">
      <p class="ws-place"><strong>${escapeHtml(weather.name)}</strong>${today?.date ? `<span>${escapeHtml(longDate(today.date))}</span>` : ''}</p>
      <div class="ws-temperature-control" role="group" aria-label="Forecast temperatures">
        <button type="button" data-temperature-mode="regular" aria-pressed="${!feels}">Regular</button>
        <button type="button" data-temperature-mode="feels" aria-pressed="${feels}">Feels like</button>
        <kbd title="Toggle temperatures with T">T</kbd>
      </div>
    </header>
    <div class="ws-layout">
      <section class="ws-now" aria-label="Now">
        <p class="ws-big">${deg(weather.temperature, unit)}<span>°</span></p>
        <p class="ws-condition"><span aria-hidden="true">${weather.icon}</span> ${escapeHtml(weather.label)}</p>
        <p class="ws-range-text">High ${deg(weather.high, unit)}° · Low ${deg(weather.low, unit)}° · ${feels ? 'Regular' : 'Feels like'} ${deg(feels ? regularTemperature : weather.feelsLike, unit)}°</p>
        ${facts ? `<dl class="ws-facts">${facts}</dl>` : ''}
        ${days?.length ? renderWeek(days, unit, picked?.date, today && { ...today, high: weather.high, low: weather.low, rainChance: weather.rainChance }, expanded) : ''}
      </section>
      ${picked ? `<div class="ws-detail is-picked">
        ${renderTomorrow(picked, unit, true)}
        ${renderWind(picked.hours, `Wind · ${weekday(picked.date)}`)}
        ${renderRainDay(picked)}
        ${renderHours(picked.hours.map((hour) => ({ ...hour, ...describe(hour.code, hour.isDay) })), unit, 'Hour by hour')}
      </div>` : `<div class="ws-detail">
        ${renderWind(today?.hours, 'Wind · next 24 hours')}
        ${today ? renderRainToday(weather) : ''}
        ${today?.hours?.length ? renderHours(today.hours, unit) : ''}
        ${tomorrow ? renderTomorrow(tomorrow, unit) : ''}
      </div>`}
    </div>`;
}

// The weather screen, opened from the masthead (weather-screen.js), fills the window below it.
// The sky behind it follows the weather now; the canvas draws its rain, snow, cloud or sun.
// Close sits outside the content, so it stays put when a refresh redraws the forecast.
export function renderWeatherScreen(weather, unit = shownUnit) {
  if (!weather) return '';
  const { sky, time } = skyFor(weather);
  return `<dialog class="weather-screen" id="weather-screen" data-sky="${sky}" data-time="${time}" aria-label="Weather in ${escapeHtml(weather.name)}">
    <canvas class="ws-sky" aria-hidden="true"></canvas>
    <form class="ws-close-form" method="dialog">
      <button class="ws-close" type="submit" autofocus><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 3.5l9 9m0-9l-9 9"/></svg>Close<kbd>Esc</kbd></button>
    </form>
    <div class="ws-content">${renderScreenContent(weather, unit)}</div>
  </dialog>`;
}

export function renderWeather(weather, unit = shownUnit) {
  if (!weather) return '';
  const hours = weather.hours.map((hour) => `<li title="${escapeHtml(hour.label)}${hour.rainChance ? `, ${hour.rainChance}% chance of rain` : ''}">
        <span class="hour">${escapeHtml(hour.time)}</span>
        <span aria-hidden="true">${hour.icon}</span>
        <span>${deg(hour.temperature, unit)}°</span>
      </li>`).join('');
  const rain = weather.rainChance ? ` · ${weather.rainChance}% rain` : '';
  // The whole of the weather opens the full forecast: a button laid over it takes the click.
  return `<section class="weather${weather.stale ? ' is-stale' : ''}" data-unit="${unit}" aria-label="Weather in ${escapeHtml(weather.name)}"${weather.stale ? ' title="Weather update failed; showing the last forecast"' : ''}>
      <div class="now">
        <span class="icon" aria-hidden="true">${weather.icon}</span>
        <span class="temp">${deg(weather.temperature, unit)}°</span>
        <span class="summary">
          <strong>${escapeHtml(weather.name)}</strong> ${escapeHtml(weather.label)}
          <span class="detail">H ${deg(weather.high, unit)}° L ${deg(weather.low, unit)}° · feels ${deg(weather.feelsLike, unit)}°${rain}</span>
        </span>
      </div>
      ${renderRain(weather.rain)}
      <ul class="hours">${hours}</ul>
      <button class="weather-open" type="button" aria-haspopup="dialog" aria-controls="weather-screen" title="Open the full forecast"><span>Full forecast</span></button>
    </section>`;
}

let lastShown = null;
export const shownWeather = () => lastShown; // so a change of unit can redraw it

// The day picked from the week on the weather screen (its date), or null for today. A day
// that has since passed (a refresh after midnight) shows today again.
let pickedDay = null;

// Shows a day ahead in the weather screen's detail column, or today for null. Only the
// detail plays its entrance; the rest stays still (style.css). The forecast is the one shown,
// or for a screen the server drew, the same forecast fetched (weather-screen.js).
export function pickDay(date, weather = lastShown) {
  pickedDay = date || null;
  const screen = document.getElementById('weather-screen');
  if (!screen || !weather) return;
  const content = screen.querySelector('.ws-content');
  delete screen.dataset.refreshed;
  screen.dataset.picking = '';
  content.innerHTML = content.dataset.html = renderScreenContent(weather);
}

// In the browser: puts a newer forecast in the masthead and on the weather screen. The screen
// is updated in place, so an open one stays open, its sky still moving, through a refresh.
// weather-screen.js hears about it, to mark the new masthead button as open, or to open a
// screen the address asked for that wasn't there until now.
export function showWeather(weather) {
  lastShown = weather;
  const current = document.querySelector('.weather');
  if (current) current.outerHTML = renderWeather(weather);
  const screen = document.getElementById('weather-screen');
  if (screen) {
    Object.assign(screen.dataset, skyFor(weather));
    screen.setAttribute('aria-label', `Weather in ${weather.name}`);
    // Swapped in quietly: no entrance again (style.css), and nothing at all if nothing changed.
    const content = screen.querySelector('.ws-content');
    const html = renderScreenContent(weather);
    if (html !== content.dataset.html) {
      screen.dataset.refreshed = '';
      content.innerHTML = html;
      content.dataset.html = html;
    }
  } else {
    document.body.insertAdjacentHTML('beforeend', renderWeatherScreen(weather));
  }
  document.dispatchEvent(new Event('weather:shown'));
}

// Keep expansion across day picks and forecast refreshes; collapse returns to Today
// if the selected day would otherwise be hidden.
export function toggleUpcoming(weather = lastShown) {
  upcomingExpanded = !upcomingExpanded;
  if (!upcomingExpanded && weather?.days?.filter((day) => day.date > weather.today?.date).slice(VISIBLE_DAYS - 1).some((day) => day.date === pickedDay)) pickedDay = null;
  pickDay(pickedDay, weather);
}

export function changeTemperatureMode(enabled, weather = lastShown) {
  setFeelsLikeMode(enabled);
  const screen = document.getElementById('weather-screen');
  if (!screen || !weather) return;
  screen.dataset.refreshed = '';
  delete screen.dataset.picking;
  const content = screen.querySelector('.ws-content');
  content.innerHTML = content.dataset.html = renderScreenContent(weather);
}
