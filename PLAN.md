# Start Page: implementation plan (draft)

A personal iGoogle/igHome-style homepage, self-hosted on `mini`, exposed through
the existing sky Caddy + Cloudflare tunnel setup.

## 1. Architecture

```
Browser ──► Cloudflare (start.skynolimit.dev)
          ──► cloudflared tunnel on sky
          ──► Caddy :4080 on sky (host matcher)
          ──► Tailscale ──► mini :3060  (Node app, launchd)
                                  │
                                  └─ fetches RSS/APIs every ~10 min, caches in memory
```

This is the same route `bha-preview.skynolimit.dev` already uses (Caddy on sky
proxying to `mikes-mac-mini.dog-rattlesnake.ts.net:3050`).

- **One small Node app**: `node:http` or Express, no frontend framework and no build step.
- **The server fetches all feeds**, so there are no CORS problems, the page loads in one
  request, and slow or failing feeds never block the page.
- **Cache**: in memory, refreshed on a timer (about 10 minutes, set per feed). If a fetch
  fails, the page keeps showing the last good items and a quiet "stale" marker. An optional
  JSON snapshot on disk means a restart doesn't start with an empty page.
- **Pages are rendered on the server** as HTML. A little vanilla JS handles tab switching
  and auto-refresh (it re-fetches `/api/widgets` every few minutes without reloading the page).
- **Endpoints**: `/`, `/api/widgets` (JSON), `/healthcheck`.

## 2. Content (first set of feeds; easy to change)

Everything is declared in `config/feeds.json` (tabs → widgets → feed URL, item count, thumbnails on/off).

| Tab | Widget | Source |
|---|---|---|
| Home | BBC News Top Stories | `feeds.bbci.co.uk/news/rss.xml` |
| Home | BBC Football | `feeds.bbci.co.uk/sport/football/rss.xml` |
| Home | Premier League scores & fixtures | Top Scores API (see §2a) |
| Home | Hacker News | `hnrss.org/frontpage` (includes points and comment links) |
| Home | AI | Simon Willison, TechCrunch AI, The Verge AI |
| News | UK, World, Technology, Business | BBC section feeds |
| Football | Headlines, Premier League news | BBC football feeds |
| Football | Live / today / upcoming matches with a PL team | Top Scores API |
| Tech | Ars Technica, The Verge, The Register, Tom's Hardware, Six Colors, HN Best | RSS |
| Home | Science | BBC Science & Environment, New Scientist, Quanta, Ars Science |
| Home | Space | Space.com, SpaceNews, NASA, ESA, Spaceflight Now |
| AI | Simon Willison, HN `q=AI\|LLM\|Claude` filter, Ars AI | RSS |
| iOS | 9to5Mac, MacRumors, Swift.org blog, iOS Dev Weekly, Apple Developer News | RSS |

A widget can merge several feeds into one list (sorted by date, duplicates removed).
BBC thumbnails come from `media:thumbnail`.

## 2a. Premier League scores & fixtures (Top Scores)

Reuse the existing Top Scores API on sky (`127.0.0.1:3011`, served publicly at
`/top-scores*` on the API hostname; contract is in its `/openapi.json`).

- Start-page server calls `/api/v1/matches` (plus `/api/v1/tables` if we later want a table),
  filtering to matches involving a Premier League team. That covers EPL games and also
  cups and Europe. The exact filter parameters will be confirmed against `openapi.json`
  when building.
- Poll every 60s while a match is live, and every 15 min otherwise. Same cache and
  last-good fallback as the feeds.
- The card shows live matches first (score and minute), then today's results, then the
  next fixtures with kick-off times in Europe/London and the TV channel when there is one.
- No new keys: Top Scores already handles BSD/BBC data.

## 2b. Extras

- **Weather** (done; shown in the masthead rather than as a card, to save vertical space): from Open-Meteo (no key) showing now, today's high and low, and the
  next few hours. The location is set in config.
- **Search box** at the top of the page, using a search engine set in config (autofocus is optional).

## 3. UI

- Layout like igHome: a header, a row of tabs, and a responsive card grid
  (3 columns, then 2, then 1).
- Each card shows a title, a source label, about 6 items with optional thumbnails, and a
  relative time ("2h"). Links open in a new tab. Titles of visited links are dimmed.
- Light/dark theme follows the system setting. Fast to load, works without JS
  (JS is only needed for refresh and tabs).

## 4. Project layout

```
start-page/
  server.js            # http server, routes
  lib/feeds.js         # fetch + parse (fast-xml-parser), normalise items
  lib/cache.js         # refresh scheduler, last-good fallback, disk snapshot
  lib/render.js        # HTML templates (tagged template literals)
  config/feeds.json
  public/style.css, app.js
  test/                # node:test, feed parsing against fixture XML
```

Dependencies: `fast-xml-parser` (and maybe nothing else).

## 5. Deployment (server-tooling)

1. `deploy/config/node_projects.json`: add a `start-page` entry with port **3060**
   (free), `node_binary: /opt/homebrew/bin/node`, `service_label: com.start-page.web`,
   `healthcheck_path: /healthcheck`, and `public_url`.
2. `deploy/lib/project_default_hosts.zsh`: add `start-page mini`.
3. `caddy/setup-caddy-cloudflare-tunnel.zsh`: add a host block for `start.skynolimit.dev`
   that proxies to mini:3060 over Tailscale.
4. Add the Cloudflare tunnel ingress and DNS record for the hostname. The page is
   **public**, with no Cloudflare Access in front of it.
5. Monitoring: register the healthcheck as described in `monitoring/ALERTING.md`
   (sky watches mini apps).
6. Deploy with `node_project.zsh start-page`.

## 6. Phases

1. **MVP (local)**: server, feeds config, cache, Home tab, tests for the parser. ✅ Done 2026-10-29.
2. **Deploy**: steps in §5, then check the public URL from a phone.
3. **Polish**: the remaining tabs, thumbnails, auto-refresh, stale markers.
4. **Football scores widget** (Top Scores), **weather**, **search**.

## 7. Decisions

- Football: BBC headlines, plus scores and fixtures for PL teams from the Top Scores API.
- Access: public URL.
- Customisation: edit `config/feeds.json` and redeploy.
- Extras: weather and search.

- Hostname: `start.skynolimit.dev`.
- Weather: Beckenham (lat 51.408, lon -0.025), Open-Meteo, Europe/London.
- Search: Google (`https://www.google.com/search?q=`).
- Top Scores is reached over Tailscale (`sky:3011`), not the public URL.
- General tech/computing sources (Tech tab and merged into Home Tech card):
  Ars Technica, The Verge, The Register (`theregister.com/headlines.atom`),
  Tom's Hardware (`tomshardware.com/feeds/all`),
  Six Colors, HN Best.
