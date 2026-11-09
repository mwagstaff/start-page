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
- Clicking the weather in the masthead opens the weather screen at `#weather`, which can be
  bookmarked. Its animated sky follows the weather now. To see any sky whatever the weather,
  add a test to the address, with `&time=night` for the night version, e.g.
  `/#weather?test=thunderstorm&time=night`. Tests: `clear` (or `sunny`), `fair` (or
  `mostly-clear`, `partly-cloudy`), `cloud` (or `cloudy`, `overcast`), `fog`, `drizzle`,
  `rain`, `downpour` (or `heavy-rain`), `snow`, `storm` (or `thunderstorm`).
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
  order. Without JavaScript the page falls back to plain CSS columns. Once you've placed
  cards yourself (below), it keeps each card in the column you chose instead.
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
  snapshot (origin Cache-Control)": it makes `/api/feeds.json` on tab1.net eligible
  for cache, with Browser TTL set to respect the origin (otherwise the zone's 4-hour Browser
  Cache TTL would replace `max-age=60`).
- Open pages re-request the snapshot every minute while visible, and when you switch back to
  the tab (usually a 304). If it has changed, they redraw the cards in place, but only after
  30 seconds without scrolling, typing or moving the pointer, and not while a search is
  half-typed or Settings is open. A new daily photo reloads the page. The ↻ button
  in the masthead fetches every feed and the weather straight away (`POST /api/refresh`, at
  most once a minute), then redraws.
- The sliders button in the masthead opens Settings, a full-window page at `/settings`
  (`public/settings-screen.js`; the address can be bookmarked or shared, and Back closes it): show or hide cards (including any card
  in `config.widgets` that isn't on the tab), change their order (arrows, or drag a row by its
  ⠿ handle, which works with touch too) and number of stories (up to 15), add your own RSS or
  Atom feeds (up to 20), choose whether cards are fitted to the screen, and export or import
  the settings as `tab1.net-settings.json`. On the page itself you can drag any card (press
  and move with a mouse; press and hold, then move, on a touch screen; Escape cancels): it
  lifts and follows the pointer, a dashed outline shows where it will land, and the other
  cards slide out of the way. Dropping a card keeps every card in the column it's in, with no
  limit per column (`public/reorder.js`); "Auto-arrange cards" in Settings packs them
  to fit again. Settings are kept in
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
- Endpoints: `/` (page), `/api/feeds.json` (snapshot), `/api/feed?url=` (a feed someone added), `/api/catalogue.json` (outlets and topics to choose from), `/api/sources?ids=` (catalogue feeds by id), `/api/widgets` (JSON, default layout), `POST /api/refresh`, `/healthcheck` (503 until the first refresh finishes).
- `PORT` defaults to 3060.
- `config/catalogue.json` lists the outlets and topics readers will pick from when they set up
  their page (see [ONBOARDING-PLAN.md](ONBOARDING-PLAN.md); not used by the page yet). Each
  outlet has one feed per section (`top`, `politics`, `world`, `business`, `science`, `health`,
  `sport`, `culture`); a topic either merges the chosen outlets' feeds for a section, lists its
  own `sources`, or borrows a card from `feeds.json` (`widget`). `npm run check-feeds` fetches
  every feed in it as the server would and fails if any is broken or has nothing newer than a
  week; `npm test` checks the catalogue's structure.
- Catalogue feeds aren't fetched until a page asks for them at `/api/sources?ids=bbc.politics,guardian.politics`
  (ids from `/api/catalogue.json`, which leaves out the feed addresses). The first request for a
  feed fetches it on the spot; after that it's refreshed every `refreshMinutes` for as long as
  someone has asked for it in the last 24 hours, then left alone until it's next wanted
  (`lib/sources.js`). Only catalogue ids are accepted, never URLs. Ids are sorted, and any other
  order gets a 301 to the sorted form, so pages asking for the same feeds share one response.
  Responses carry an ETag and `Cache-Control: public, max-age=60, stale-while-revalidate=600`.
  Cloudflare caches them through the Cache Rule "Start page: cache feeds snapshot, catalogue and
  sources (origin Cache-Control)", which covers `/api/feeds.json`, `/api/catalogue.json` and
  `/api/sources`. Catalogue feeds that are also on the default page (BBC News top stories, BBC
  Science, BBC Football, Six Colors) are read from its cache rather than fetched twice.
- A reader who hasn't chosen anything sees the suggested page for their region: the
  catalogue's `defaults` (for the UK, Top stories, Hacker News, World, Tech and Football from
  BBC News, The Guardian and Sky News). The server draws the UK's (so it also works without
  JavaScript); elsewhere the early script hides it until `page.js` draws the region's, guessed
  from the time zone.
- The setup bar (`public/setup-bar.js`) sits between the masthead and the cards. It opens by
  itself on a first visit and stays, on later visits too, until the reader presses Done; after
  that the masthead's Customise button opens it (as does `/settings/topics-and-sources`).
  Compact, it shows the pillars News, Tech and Sport (then More and Display) with what's
  chosen in each; each opens a drawer: news topics, sources, region and one card per topic or
  per source; tiles for Tech, Sport and More topics showing where their stories come from; and
  pictures, density, weather and the daily photo. On phones a drawer is a sheet from the
  bottom. Every choice is saved as `profile` straight away and the cards change underneath
  (`public/topics.js`): new cards go at the end and glow briefly, and each change can be
  undone. A card's × turns its topic off, so the bar always matches the page. Each topic
  names its pillar in `config/catalogue.json`.
- Settings (`/settings`) is now "Advanced settings", opened from the bar: card order and
  stories per card, fill and arrangement, temperature unit, your own feeds, import/export,
  History and "Start over…". Its "Edit topics and sources…" button goes back to the bar.
  "Reset cards" goes back to the suggested page. "Start over…" (`public/start-over.js`) asks
  first, offering an export, then clears the settings and history from this browser and
  reloads the home page as on a first visit. It can't be undone.

## Production deployment

The official address is https://tab1.net. Deploy with
`/Users/mwagstaff/dev/server-tooling/deploy/node_project.zsh tab1.net --no-tail`.
The service runs on Mini at port 3060 as `com.tab1.net.web`; Sky routes
Cloudflare Tunnel traffic through Caddy to Mini over Tailscale.
The Caddy setup script also configures redirects from `www.tab1.net` and
`start.skynolimit.dev` to the official address, preserving paths and queries.

Browser storage keys retain the `start-page:` prefix for compatibility. Settings
are origin-specific: export settings from an existing open tab on the old address before
refreshing it, then import that JSON file on tab1.net to carry your layout across. Existing exports remain supported.
