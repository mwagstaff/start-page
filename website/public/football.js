const strip = document.querySelector('.fixture-strip');
let options = { premier: false, tvStars: 0 };
let enabled = false;
let timer;
let pending;

function crest(team) {
  const image = new Image(17, 17);
  image.alt = '';
  image.src = team.crest;
  image.onerror = () => { image.hidden = true; };
  return image;
}

function matchLink(match) {
  const link = document.createElement('a');
  link.href = match.href;
  link.target = '_blank';
  link.rel = 'noopener';
  const score = document.createElement('strong');
  const clock = document.createElement('small');
  const rating = document.createElement('span');
  rating.className = 'fixture-stars';
  link.append(crest(match.home), match.home.short, score, match.away.short, crest(match.away), clock, rating);
  return link;
}

function updateScore(slot, match) {
  const channel = !match.score && match.channel;
  if (!channel) {
    delete slot.dataset.channel;
    slot.textContent = match.score || 'v';
    return;
  }
  if (slot.dataset.channel === channel.logo) return;
  slot.dataset.channel = channel.logo;
  const logo = new Image();
  logo.height = 16;
  logo.alt = channel.name;
  logo.title = channel.name;
  logo.onerror = () => {
    if (channel.fallbackLogo && logo.src !== channel.fallbackLogo) logo.src = channel.fallbackLogo;
    else logo.replaceWith(channel.name);
  };
  logo.src = channel.logo;
  slot.replaceChildren(logo);
}

// Premier League club matches, plus any match on UK TV rated at least the chosen stars.
export function visibleMatches(matches, { premier, tvStars }) {
  return matches.filter(m => (premier && m.premier) || (tvStars > 0 && m.channel && m.stars >= tvStars));
}

function render(all) {
  const matches = visibleMatches(all, options);
  const wasHidden = strip.hidden;
  const existing = new Map(Array.from(strip.children, a => [a.href, a]));
  matches.forEach((match, i) => {
    const link = existing.get(match.href) || matchLink(match);
    existing.delete(match.href);
    if (strip.children[i] !== link) strip.insertBefore(link, strip.children[i] || null);
    updateScore(link.querySelector('strong'), match);
    link.querySelector('small').textContent = match.label;
    link.classList.toggle('is-live', match.live);
    const rated = options.tvStars > 0 && match.stars;
    const rating = link.querySelector('.fixture-stars');
    rating.hidden = !rated;
    rating.textContent = rated ? '★'.repeat(match.stars) : '';
    link.setAttribute('aria-label', [match.home.name, match.score || 'versus', match.away.name, match.live && 'Live', match.label, !match.score && match.channel?.name, rated && match.stars + ' star' + (match.stars === 1 ? '' : 's')].filter(Boolean).join(', '));
  });
  for (const link of existing.values()) link.remove();
  strip.hidden = !matches.length;
  if (strip.hidden !== wasHidden) document.querySelector('.grid')?.dispatchEvent(new Event('layout:refresh'));
}

function stop() {
  clearTimeout(timer);
  pending?.abort();
}

async function refresh() {
  stop();
  if (!enabled || document.hidden) return;
  const request = new AbortController();
  pending = request;
  try {
    const response = await fetch('/api/football.json', { signal: request.signal, cache: 'no-store' });
    if (!response.ok) throw new Error('Fixtures unavailable');
    const { matches } = await response.json();
    if (!request.signal.aborted) render(latest = matches);
  } catch {
    if (!request.signal.aborted) render(latest = []);
  } finally {
    if (!request.signal.aborted) timer = setTimeout(refresh, 30000);
  }
}

let latest = [];

export function showFootball({ premier = false, tvStars = 0 } = {}) {
  if (!strip) return;
  const show = premier || tvStars > 0;
  const changed = premier !== options.premier || tvStars !== options.tvStars;
  options = { premier, tvStars };
  if (show === enabled) {
    if (changed && show) render(latest);
    return;
  }
  enabled = show;
  if (!show) render(latest = []);
  refresh();
}

document.addEventListener('visibilitychange', refresh);
