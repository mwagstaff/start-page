const origin = 'https://top-scores.skynolimit.dev';
const ukDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' });
const aliases = {
  'Brighton & Hove Albion': 'Brighton', 'Manchester United': 'Man Utd', 'Manchester City': 'Man City',
  'Nottingham Forest': 'Nott’m Forest', 'Tottenham Hotspur': 'Spurs', 'Wolverhampton Wanderers': 'Wolves',
  'West Ham United': 'West Ham', 'Newcastle United': 'Newcastle', 'AFC Bournemouth': 'Bournemouth',
  'Hamburger SV': 'Hamburg', 'Atletico Madrid': 'Atlético', 'Bayer 04 Leverkusen': 'Leverkusen',
  'Borussia Dortmund': 'Dortmund', 'Borussia Mönchengladbach': 'Gladbach', 'Paris Saint-Germain': 'PSG',
  'Queens Park Rangers': 'QPR', 'West Bromwich Albion': 'West Brom', 'Sheffield Wednesday': 'Sheff Wed',
  'Sheffield United': 'Sheff Utd', 'Blackburn Rovers': 'Blackburn', 'Paris FC': 'Paris FC',
};
// Club prefixes and suffixes that add width without helping recognition.
const affixes = /^(?:\d\.\s+)?(?:FC|AFC|CF|SV|AC|SC|SSC|CD|UD|RC|RCD|VfB|VfL|TSG|1\.\s*FC|1\.\s*FSV)\s+|\s+(?:FC|AFC|CF|SV|SC|CFC)$/g;

export function shortName(name, short) {
  if (short) return short;
  if (aliases[name]) return aliases[name];
  const trimmed = name.replace(affixes, '').trim();
  return trimmed || name;
}

function team(name, short) {
  return { name, short: shortName(name, short),
    crest: origin + '/logos/team?' + new URLSearchParams({ name, alt: short || '', v: '3' }) };
}

// The compact (mostly square) marks the Top Scores app uses, matched as Top Scores does.
const compactLogos = [
  [/ligue\s*1\s*(\+|plus)/, 'ligue 1+'], [/^s4c\b/, 's4c'], [/^stv\b/, 'stv'], [/^deetv\b/, 'deetv'],
  [/amazon|prime\s*video/, 'amazon'], [/apple/, 'apple'], [/bbc/, 'bbc'], [/channel\s*4/, 'channel 4'],
  [/dazn/, 'dazn'], [/disney/, 'disney+'], [/hbo/, 'hbo max'], [/itv/, 'itv'], [/laliga/, 'laliga tv'],
  [/now\s*tv/, 'now'], [/premier\s*sports/, 'premier sports'], [/sky/, 'sky'], [/tnt/, 'tnt'],
];

export function compactLogo(name) {
  const key = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const file = compactLogos.find(([pattern]) => pattern.test(key))?.[1];
  return file ? origin + '/generated-assets/tv-logos/' + encodeURIComponent(file) + '.png' : null;
}

// Top Scores orders channels by provider priority. Ignore overseas listings.
function primaryChannel(channels) {
  for (const entry of Array.isArray(channels) ? channels : []) {
    const channel = typeof entry === 'string' ? { name: entry } : entry;
    const name = channel?.name?.trim();
    if (!name) continue;
    const uk = channel.countryCode || channel.country
      ? /^(GB|UK)$/i.test(channel.countryCode) || /^(United Kingdom|UK)$/i.test(channel.country)
      : /\b(bbc|itv|sky sports|tnt sports|premier sports|uk)\b/i.test(name);
    if (uk) {
      const wide = origin + '/logos/tv?name=' + encodeURIComponent(name);
      const own = /^https:\/\//i.test(channel.logo) ? channel.logo : null;
      return { name, logo: compactLogo(name) || wide, fallbackLogo: own || wide };
    }
  }
  return null;
}

async function request(date, extra) {
  const query = new URLSearchParams({ start: date, end: date, time_zone: 'Europe/London', page_size: '500', sort: 'asc', ...extra });
  const response = await fetch(origin + '/api/v1/matches?' + query, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('Fixture request failed');
  const rows = await response.json();
  return Array.isArray(rows) ? rows.filter(m => m?.date === date && m.home_team && m.away_team) : [];
}

const matchId = (date, m) => m.match_details_id || [date, m.time, m.league, m.home_team, m.away_team].join('|');

function stars(m) {
  const value = Number(m.watchability_index?.stars);
  return Number.isInteger(value) && value >= 1 && value <= 5 ? value : null;
}

function watchabilityScore(m) {
  const score = m.watchability_index?.score;
  return Number.isFinite(score) && score >= 0 && score <= 100 ? score : -1;
}

function biggestMatchFirst(a, b) {
  return (stars(b) ?? 0) - (stars(a) ?? 0)
    || watchabilityScore(b) - watchabilityScore(a)
    || String(a.time || '99').localeCompare(String(b.time || '99'));
}

// One list for the day: every match, flagged when a Premier League club plays in it
// (the Premier League option) and rated 1–5 stars for watchability (the TV option).
async function load(date) {
  const [all, premier] = await Promise.all([request(date), request(date, { epl_only: 'true' })]);
  const premierIds = new Set(premier.map(m => matchId(date, m)));
  const seen = new Set(all.map(m => matchId(date, m)));
  const rows = [...all, ...premier.filter(m => !seen.has(matchId(date, m)))]
    .sort(biggestMatchFirst);
  const matches = rows.map(m => {
    const id = matchId(date, m);
    const status = String(m.score_status || '').trim().toUpperCase();
    const minute = /^(?:ET )?\d{1,3}(?:\+\d{1,2})?'?$/.test(status);
    const score = [m.home_score, m.away_score].every(n => Number.isInteger(n)) ? m.home_score + '–' + m.away_score : '';
    return {
      premier: premierIds.has(id), stars: stars(m),
      channel: primaryChannel(m.tv_channels),
      home: team(m.home_team, m.home_short_name), away: team(m.away_team, m.away_short_name),
      href: origin + '/matches/' + encodeURIComponent(id) + '?date=' + date,
      score, label: minute ? status.replace(/'$/, '') + '′' : status || (score ? '' : m.time || 'TBC'),
      live: minute || ['HT', 'ET', 'LIVE'].includes(status),
    };
  });
  return { date, matches };
}

// Share each upstream request across readers, including during a brief outage.
let cache;
export function todaysFixtures() {
  const date = ukDate.format(new Date());
  if (cache?.date !== date || Date.now() >= cache.expires) {
    cache = { date, expires: Date.now() + 20000, result: load(date) };
  }
  return cache.result;
}
