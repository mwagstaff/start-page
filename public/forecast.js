// Open-Meteo forecasts: the request, reading the response, and the masthead markup.
// Shared by the server (the default location) and the browser (the reader's own location).

import { escapeHtml } from './cards.js';

const HOURS_AHEAD = 6;
const DETAIL_HOURS = 12; // hour by hour in the forecast popover, from now
const WEEK_DAYS = 7; // days after today in the popover
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
    current: 'temperature_2m,apparent_temperature,weather_code,is_day,relative_humidity_2m,wind_speed_10m',
    hourly: 'temperature_2m,weather_code,precipitation_probability,is_day,precipitation,wind_speed_10m',
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code,precipitation_sum,sunrise,sunset,uv_index_max',
    minutely_15: 'precipitation,precipitation_probability',
    forecast_minutely_15: String(RAIN_SLOTS),
    wind_speed_unit: 'mph',
    timezone: 'auto', // the location's own time zone, so the hours read as local time
    forecast_days: String(WEEK_DAYS + 1),
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

// Today in detail and the week ahead, for the popover. Null for forecasts fetched before
// these fields were asked for (a forecast cached in the browser).
function parseOutlook(json, currentHour) {
  const { current, hourly, daily } = json;
  if (!daily.weather_code || !daily.sunrise) return null;
  const from = Math.max(0, hourly.time.findIndex((time) => time >= currentHour));
  const hours = hourly.time.slice(from, from + DETAIL_HOURS).map((time, offset) => {
    const i = from + offset;
    return {
      time: offset === 0 ? 'Now' : time.slice(11, 16),
      temperature: Math.round(hourly.temperature_2m[i]),
      rainChance: hourly.precipitation_probability[i] ?? null,
      rain: round1(hourly.precipitation?.[i] ?? 0),
      wind: hourly.wind_speed_10m ? Math.round(hourly.wind_speed_10m[i]) : null,
      ...describe(hourly.weather_code[i], hourly.is_day[i] === 1),
    };
  });
  const days = daily.time.slice(1, WEEK_DAYS + 1).map((date, offset) => {
    const i = offset + 1;
    return {
      date,
      day: offset === 0 ? 'Tomorrow' : weekday(date),
      high: Math.round(daily.temperature_2m_max[i]),
      low: Math.round(daily.temperature_2m_min[i]),
      rainChance: daily.precipitation_probability_max[i] ?? null,
      rain: round1(daily.precipitation_sum?.[i] ?? 0),
      ...describe(daily.weather_code[i]),
    };
  });
  return {
    today: {
      ...describe(daily.weather_code[0]),
      sunrise: daily.sunrise[0].slice(11, 16),
      sunset: daily.sunset[0].slice(11, 16),
      uv: daily.uv_index_max ? Math.round(daily.uv_index_max[0]) : null,
      rain: round1(daily.precipitation_sum?.[0] ?? 0),
      humidity: current.relative_humidity_2m ?? null,
      wind: current.wind_speed_10m != null ? Math.round(current.wind_speed_10m) : null,
      hours,
    },
    days,
  };
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
    ...parseOutlook(json, currentHour),
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

// Shown when the pointer is over the weather (or it has focus): today hour by hour with the
// details that don't fit in the masthead, then the week ahead, each day's range of
// temperatures drawn on one scale for the whole week.
function renderOutlook(weather) {
  const { today, days } = weather;
  const facts = [
    fact('Feels like', `${weather.feelsLike}°`),
    fact('Rain', escapeHtml(rainText({ rainChance: weather.rainChance, rain: today.rain }) || 'None expected')),
    today.wind != null && fact('Wind', `${today.wind} mph`),
    today.humidity != null && fact('Humidity', `${today.humidity}%`),
    today.uv != null && fact('UV', `${today.uv} <small>${uvLabel(today.uv)}</small>`),
    fact('Sun', `↑ ${escapeHtml(today.sunrise)} ↓ ${escapeHtml(today.sunset)}`),
  ].filter(Boolean).join('');
  const hours = today.hours.map((hour) => `<li>
          <span class="forecast-time">${escapeHtml(hour.time)}</span>
          <span class="forecast-icon" title="${escapeHtml(hour.label)}">${hour.icon}</span>
          <span class="forecast-temp">${hour.temperature}°</span>
          <span class="forecast-rain">${escapeHtml(rainText(hour))}</span>
        </li>`).join('');
  const lowest = Math.min(...days.map((day) => day.low));
  const span = Math.max(1, Math.max(...days.map((day) => day.high)) - lowest);
  const week = days.map((day) => `<li>
          <span class="forecast-day">${escapeHtml(day.day)}</span>
          <span class="forecast-icon" aria-hidden="true">${day.icon}</span>
          <span class="forecast-label">${escapeHtml(day.label)}</span>
          <span class="forecast-rain">${escapeHtml(rainText(day))}</span>
          <span class="forecast-low">${day.low}°</span>
          <span class="forecast-range" aria-hidden="true"><span style="left:${((day.low - lowest) / span * 100).toFixed(1)}%;right:${(100 - (day.high - lowest) / span * 100).toFixed(1)}%"></span></span>
          <span class="forecast-high">${day.high}°</span>
        </li>`).join('');
  return `<div class="forecast" id="forecast-detail">
      <div class="forecast-panel">
        <section class="forecast-today" aria-label="Today">
          <header>
            <span class="forecast-big" aria-hidden="true">${weather.icon}</span>
            <div>
              <h3>Today in ${escapeHtml(weather.name)}</h3>
              <p>${escapeHtml(today.label)} · H ${weather.high}° L ${weather.low}°</p>
            </div>
            <span class="forecast-now">${weather.temperature}°</span>
          </header>
          <dl class="forecast-facts">${facts}</dl>
          <ol class="forecast-hours">${hours}</ol>
        </section>
        <section class="forecast-week" aria-label="Next ${days.length} days">
          <h3>Next ${days.length} days</h3>
          <ol>${week}</ol>
        </section>
      </div>
    </div>`;
}

export function renderWeather(weather) {
  if (!weather) return '';
  const outlook = weather.today && weather.days?.length;
  const hours = weather.hours.map((hour) => `<li title="${escapeHtml(hour.label)}${hour.rainChance ? `, ${hour.rainChance}% chance of rain` : ''}">
        <span class="hour">${escapeHtml(hour.time)}</span>
        <span aria-hidden="true">${hour.icon}</span>
        <span>${hour.temperature}°</span>
      </li>`).join('');
  const rain = weather.rainChance ? ` · ${weather.rainChance}% rain` : '';
  // Focusable, so the popover opens from the keyboard (or a tap) as well as on hover.
  return `<section class="weather${weather.stale ? ' is-stale' : ''}${outlook ? ' has-outlook' : ''}" aria-label="Weather in ${escapeHtml(weather.name)}"${outlook ? ' tabindex="0" aria-describedby="forecast-detail"' : ''}${weather.stale ? ' title="Weather update failed; showing the last forecast"' : ''}>
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
      ${outlook ? renderOutlook(weather) : ''}
    </section>`;
}
