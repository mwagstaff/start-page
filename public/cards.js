// Card markup, shared by the server (the first page load) and the browser (customised
// layouts and in-place updates).

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

export function relativeTime(iso, now = Date.now()) {
  if (!iso) return '';
  const minutes = Math.round((now - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return days < 7 ? `${days}d` : new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Europe/London' });
}

function renderMeta(item, widget, now) {
  const parts = [];
  if (widget.merged) parts.push(`<span class="source">${escapeHtml(item.source)}</span>`);
  const age = relativeTime(item.date, now);
  if (age) parts.push(`<time datetime="${escapeHtml(item.date)}">${age}</time>`);
  if (item.points != null) parts.push(`${item.points} points`);
  if (item.commentsUrl) {
    const label = item.comments != null ? `${item.comments} comments` : 'comments';
    parts.push(`<a href="${escapeHtml(item.commentsUrl)}" target="_blank" rel="noopener">${label}</a>`);
  }
  return parts.length ? `<div class="meta">${parts.join('<span aria-hidden="true"> · </span>')}</div>` : '';
}

function siteInitial(item) {
  let host = '';
  try {
    host = new URL(item.link).hostname.replace(/^www\./, '');
  } catch {}
  return (host || item.source || '?').charAt(0).toUpperCase();
}

function renderItem(item, widget, now) {
  let thumb = '';
  if (widget.thumbnails && item.image) {
    thumb = `<img class="thumb" src="${escapeHtml(item.image)}" alt="" loading="lazy" decoding="async" width="54" height="36" data-initial="${escapeHtml(siteInitial(item))}">`;
  } else if (widget.thumbnails) {
    // Keeps headlines lined up when a story has no picture: the site's initial instead.
    thumb = `<span class="thumb thumb-empty" aria-hidden="true">${escapeHtml(siteInitial(item))}</span>`;
  }
  return `<li class="item${thumb ? ' has-thumb' : ''}">
      ${thumb}
      <div class="body">
        <a class="headline" href="${escapeHtml(item.link)}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a>
        ${renderMeta(item, widget, now)}
      </div>
    </li>`;
}

// The × that removes a card (remove.js shows it once it can).
const CLOSE_ICON = '<svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6"/></svg>';

export function renderWidget(widget, now) {
  const title = widget.link
    ? `<a href="${escapeHtml(widget.link)}" target="_blank" rel="noopener">${escapeHtml(widget.title)}</a>`
    : escapeHtml(widget.title);
  let body;
  if (widget.items.length) {
    body = `<ul class="items">${widget.items.map((item) => renderItem(item, widget, now)).join('')}</ul>`;
  } else if (widget.failedSources.length) {
    body = `<p class="empty">Couldn't load this feed. It will try again in a few minutes.</p>`;
  } else {
    body = `<p class="empty">Loading…</p>`;
  }
  const stale = widget.items.length && widget.failedSources.length
    ? `<p class="stale" title="Showing the last items that loaded">${escapeHtml(widget.failedSources.join(', '))} unavailable</p>`
    : '';
  return `<section class="card" id="${escapeHtml(widget.id)}" aria-labelledby="${escapeHtml(widget.id)}-title">
    <h2 id="${escapeHtml(widget.id)}-title">${title}</h2>
    <button type="button" class="card-close" aria-label="Remove ${escapeHtml(widget.title)}" title="Remove this card">${CLOSE_ICON}</button>
    ${body}
    ${stale}
  </section>`;
}
