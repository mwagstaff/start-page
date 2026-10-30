import { forecastUrl, parseWeather } from '../public/forecast.js';

export { describe, forecastUrl, parsePlaceName, parseRain, parseWeather, rainLevel, rainSummary } from '../public/forecast.js';

const FETCH_TIMEOUT_MS = 10_000;

async function fetchWeather(location) {
  const response = await fetch(forecastUrl(location), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return parseWeather(await response.json(), location.name);
}

export function createWeather(location, { fetch = fetchWeather, log = console } = {}) {
  let current = null;

  async function refresh() {
    try {
      current = { ...(await fetch(location)), stale: false };
    } catch (error) {
      log.warn(`Weather failed: ${error.message}`);
      if (current) current = { ...current, stale: true };
    }
  }

  return {
    refresh,
    get current() {
      return current;
    },
  };
}
