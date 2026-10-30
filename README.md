# Start Page

Personal igHome-style start page: BBC News, BBC Football, Hacker News, AI and
general tech, science and space feeds, plus Beckenham weather in the masthead. See [PLAN.md](PLAN.md) for the full plan and deployment route.

```bash
npm install
npm run dev     # http://localhost:3060, restarts on file changes
npm test
```

- Feeds, cards and tabs are defined in `config/feeds.json`. Each card shows `limit` items,
  or `defaultLimit` (6) if it doesn't set one. A card with several `sources`
  merges them newest first, taking at most `maxPerSource` items from each.
- The server fetches every feed itself every `refreshMinutes` and keeps the results in
  memory. If a source fails, its last good items stay on the page and the card names the
  source that's unavailable.
- Weather comes from Open-Meteo (no key needed) and refreshes every 15 minutes. The page
  first shows the default location in `config.weather` (Beckenham), fetched by the server. If
  the browser shares its location, `public/weather.js` asks Open-Meteo for the forecast and
  OpenStreetMap's Nominatim for the place name itself, with coordinates rounded to about 1km,
  so the location never reaches this server. The browser keeps the forecast for 15 minutes
  and the place name for good (localStorage).
- The masthead's rain chart shows the next 6 hours in 15-minute bars from Open-Meteo's
  `minutely_15` forecast. Bar height is the rate, full height at 8 mm/h. The shade gives the
  band: light below 2.5 mm/h, moderate below 7.6, heavy above. A one-line summary sits beside
  it, and each bar has a tooltip.
- Thumbnails come from the feed when it has an image. Otherwise the server reads the
  article page's preview image (`og:image`) once and remembers it. The server shrinks
  every thumbnail to a ~2KB 120×80 WebP using `sharp`, kept in memory and served at
  `/thumb/<id>.webp`. It only serves images it put on the page itself. A story with no
  image shows its site's initial instead. Thumbnails are made straight after each refresh;
  if a site refuses the download (some block servers), the story gets the initial too, and
  the image is tried again an hour later. Any thumbnail that still fails in the browser is
  swapped for the initial.
- `public/layout.js` measures the cards and sorts them into the columns that make the
  tallest column as short as possible, using an exact search. Each column keeps the config
  order. Without JavaScript the page falls back to plain CSS columns.
- The background photo changes daily. The server picks one from the sources in
  `config.backdrop`: Bing's homepage photos for landscapes, nature and cities, and ESA's
  Webb and Hubble feeds for space. `weight` sets how often each source comes up, and the
  same date always gives the same photo. Hover the bottom-right corner to see the photo with its credit.
- The masthead's search box is a plain form that sends you to Google search. It's focused when
  the page loads, so you can start typing straight away.
- A story only shows in one card: cards claim stories in page order, and a later card skips
  any story an earlier one shows (same link without tracking parameters, or the same
  headline) and fills up from further down its feeds. `public/stories.js` makes these
  choices for both the server and the browser.
- `/api/feeds.json` is one snapshot of every card's settings and the top of each of its feeds
  (more than a card shows, so cards can fill up after duplicates are dropped), plus the default
  weather and the photo. It's the same for every reader and carries a version used as its
  ETag, with `Cache-Control: public, max-age=60, stale-while-revalidate=600`; a request with a
  matching `If-None-Match` gets a 304. The page itself also has an ETag. Cloudflare serves the
  snapshot from its edge through the skynolimit.dev Cache Rule "Start page: cache feeds
  snapshot (origin Cache-Control)": it makes `/api/feeds.json` on start.skynolimit.dev eligible
  for cache, with Browser TTL set to respect the origin (otherwise the zone's 4-hour Browser
  Cache TTL would replace `max-age=60`).
- Open pages re-request the snapshot every minute while visible, and when you switch back to
  the tab (usually a 304). If it has changed, they redraw the cards in place, but only after
  30 seconds without scrolling, typing or moving the pointer, and not while a search is
  half-typed or the Customise dialog is open. A new daily photo reloads the page. The ↻ button
  in the masthead fetches every feed and the weather straight away (`POST /api/refresh`, at
  most once a minute), then redraws.
- The sliders button in the masthead opens Customise: show or hide cards (including any card
  in `config.widgets` that isn't on the tab), change their order (arrows, or drag a row by its
  ⠿ handle, which works with touch too) and number of items (up to 15), add your own RSS or
  Atom feeds (up to 20), and export or import the settings as `start-page-settings.json`. On
  the page itself you can also drag a card by its title onto another card to move it before or
  after that card (mouse only); the cards are then packed into columns again. Settings are kept in
  the browser's localStorage under `start-page:settings`, with no account. With a saved
  layout, the browser draws the cards from the snapshot; a small script in the page's `<head>`
  hides the default cards until then, and starts fetching the snapshot early. Without saved
  settings or without JavaScript, the server-rendered default layout shows as before.
- Feeds you add are fetched through `GET /api/feed?url=`, since most sites don't let browsers
  read their feeds directly. Anyone can ask for any URL, and the server sits on a home network,
  so `lib/custom.js` only fetches http(s) on the default ports, without credentials, and only
  connects to public addresses: private, loopback, Tailscale (100.64/10), link-local and other
  reserved ranges are refused. That's checked on the address actually connected to (so DNS
  can't point it somewhere private) and again after each redirect (at most 3). It reads at most
  2MB, gives up after 10 seconds, and fetches at most 30 new feeds a minute. Each feed is kept
  for `refreshMinutes` and shared by everyone who adds it; its stories use the feed's own
  images, loaded by the browser.
- Modules in `public/` import each other by plain path; the page's import map adds each file's
  content hash, so browsers never mix old and new versions after a deploy. The server works the
  hashes out again whenever a file in `public/` changes.
- Endpoints: `/` (page), `/api/feeds.json` (snapshot), `/api/feed?url=` (a feed someone added), `/api/widgets` (JSON, default layout), `POST /api/refresh`, `/healthcheck` (503 until the first refresh finishes).
- `PORT` defaults to 3060.
