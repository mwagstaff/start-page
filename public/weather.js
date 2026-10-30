// Swaps the default (Beckenham) weather for the reader's own, when the browser shares a location.
// The browser asks Open-Meteo and OpenStreetMap's Nominatim itself (both allow it), so the
// reader's location never reaches this server. If location is unavailable or refused, the
// default forecast simply stays.

import { forecastUrl, parsePlaceName, parseWeather, renderWeather } from './forecast.js';

const ROUND = 100; // two decimal places, about 1km: plenty for weather, and less precise to send
const REFRESH_MS = 15 * 60_000;
const FORECAST_KEY = 'start-page:weather';
const PLACES_KEY = 'start-page:places';
const MAX_PLACES = 20;

function stored(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function store(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

// Place names hardly change, and Nominatim asks for light use: remember them per spot.
async function placeName(spot, coords) {
  const places = stored(PLACES_KEY) ?? {};
  if (places[spot]) return places[spot];
  let name = null;
  try {
    const params = new URLSearchParams({ format: 'jsonv2', lat: coords.latitude, lon: coords.longitude, zoom: '14', 'accept-language': 'en-GB' });
    const response = await fetch(`https://nominatim.openstreetmap.org/reverse?${params}`);
    if (response.ok) name = parsePlaceName(await response.json());
  } catch {}
  if (!name) return 'Your location'; // not remembered, so it's tried again next time
  const kept = Object.entries(places).slice(-(MAX_PLACES - 1));
  store(PLACES_KEY, Object.fromEntries([...kept, [spot, name]]));
  return name;
}

// The last forecast for this spot if it's recent, else a fresh one (or null on failure).
async function forecastFor(coords) {
  const spot = `${coords.latitude},${coords.longitude}`;
  const cached = stored(FORECAST_KEY);
  if (cached?.spot === spot && Date.now() - cached.fetchedAt < REFRESH_MS) return cached.weather;
  try {
    const [response, name] = await Promise.all([fetch(forecastUrl(coords)), placeName(spot, coords)]);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const weather = { ...parseWeather(await response.json(), name), stale: false };
    store(FORECAST_KEY, { spot, fetchedAt: Date.now(), weather });
    return weather;
  } catch {
    return cached?.spot === spot ? { ...cached.weather, stale: true } : null;
  }
}

let coords = null;

async function showLocalWeather() {
  const weather = coords && (await forecastFor(coords));
  const current = document.querySelector('.weather');
  if (!weather || !current) return;
  current.outerHTML = renderWeather(weather);
  document.body.dataset.localWeather = 'true'; // page.js leaves it alone from now on
}

if (document.querySelector('.weather') && 'geolocation' in navigator) {
  // A position up to 30 minutes old is fine, and saves the browser a fresh fix on every visit.
  navigator.geolocation.getCurrentPosition(({ coords: { latitude, longitude } }) => {
    coords = { latitude: Math.round(latitude * ROUND) / ROUND, longitude: Math.round(longitude * ROUND) / ROUND };
    showLocalWeather();
    setInterval(() => { if (document.visibilityState === 'visible') showLocalWeather(); }, REFRESH_MS);
  }, () => {}, { maximumAge: 30 * 60_000, timeout: 10_000 });
}
