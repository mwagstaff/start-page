// Open-Meteo forecasts: the request, reading the response, and the masthead markup.
// Shared by the server (the default location) and the browser (the reader's own location).

import { escapeHtml } from './cards.js';

const HOURS_AHEAD = 6;
const RAIN_SLOTS = 24; // 15-minute steps: the next 6 hours

// Rain rate bands in mm/h (American Meteorological Society): light < 2.5, moderate < 7.6, heavy above.
const RAIN_LEVELS = [[0.1, 'none'], [2.5, 'light'], [7.6, 'moderate'], [Infinity, 'heavy']];
const LEVEL_ORDER = ['none', 'light', 'moderate', 'heavy'];

// WMO weather interpretation codes, as used by Open-Meteo.
const CONDITIONS = [
  [[0], 'Clear', '☀️', '🌙'],
  [[1], 'Mostly clear', '🌤️', '🌙'],
  [[2], 'Partly cloudy', '⛅', '☁️'],
  [[3], 'Overcast', '☁️', '☁️'],
  [[45, 48], 'Fog', '🌫️', '🌫️'],
  [[51, 53, 55, 56, 57], 'Drizzle', '🌦️', '🌧️'],
  [[61, 63, 66, 80, 81], 'Rain', '🌧️', '🌧️'],
  [[65, 67, 82], 'Heavy rain', '🌧️', '🌧️'],
  [[71, 73, 75, 77, 85, 86], 'Snow', '🌨️', '🌨️'],
  [[95, 96, 99], 'Thunderstorm', '⛈️', '⛈️'],
];

export function describe(code, isDay = true) {
  const match = CONDITIONS.find(([codes]) => codes.includes(code));
  if (!match) return { label: 'Unknown', icon: '🌡️' };
  return { label: match[1], icon: isDay ? match[2] : match[3] };
}

export function forecastUrl({ latitude, longitude }) {
  const params = new URLSearchParams({
    latitude,
    longitude,
    current: 'temperature_2m,apparent_temperature,weather_code,is_day',
    hourly: 'temperature_2m,weather_code,precipitation_probability,is_day',
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    minutely_15: 'precipitation,precipitation_probability',
    forecast_minutely_15: String(RAIN_SLOTS),
    timezone: 'auto', // the location's own time zone, so the hours read as local time
    forecast_days: '2',
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

// Open-Meteo times are local strings such as "2026-10-29T12:15".
export function parseWeather(json, name) {
  const { current, hourly, daily } = json;
  const currentHour = `${current.time.slice(0, 13)}:00`;
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
    feelsLike: Math.round(current.apparent_temperature),
    ...describe(current.weather_code, current.is_day === 1),
    high: Math.round(daily.temperature_2m_max[0]),
    low: Math.round(daily.temperature_2m_min[0]),
    rainChance: daily.precipitation_probability_max[0],
    hours,
    rain: parseRain(json.minutely_15),
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

export function renderWeather(weather) {
  if (!weather) return '';
  const hours = weather.hours.map((hour) => `<li title="${escapeHtml(hour.label)}${hour.rainChance ? `, ${hour.rainChance}% chance of rain` : ''}">
        <span class="hour">${escapeHtml(hour.time)}</span>
        <span aria-hidden="true">${hour.icon}</span>
        <span>${hour.temperature}°</span>
      </li>`).join('');
  const rain = weather.rainChance ? ` · ${weather.rainChance}% rain` : '';
  return `<section class="weather${weather.stale ? ' is-stale' : ''}" aria-label="Weather in ${escapeHtml(weather.name)}"${weather.stale ? ' title="Weather update failed; showing the last forecast"' : ''}>
      <div class="now">
        <span class="icon" aria-hidden="true">${weather.icon}</span>
        <span class="temp">${weather.temperature}°</span>
        <span class="summary">
          <strong>${escapeHtml(weather.name)}</strong> ${escapeHtml(weather.label)}
          <span class="detail">H ${weather.high}° L ${weather.low}° · feels ${weather.feelsLike}°${rain}</span>
        </span>
      </div>
      ${renderRain(weather.rain)}
      <ul class="hours">${hours}</ul>
    </section>`;
}
