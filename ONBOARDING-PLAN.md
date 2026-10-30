# Topics, sources and first-run setup: plan (draft)

Goal: a new visitor can build their page in one step by picking **what they care about**
(topics), **who they want to hear it from** (major UK and US outlets), and **what kind of
page they want** (mixed topic cards or one card per outlet, pictures or compact). Everything
stays in the browser, as today; no accounts.

## 1. The model: outlets × sections → topic cards

Most major outlets publish one RSS feed per section. So the catalogue is a grid:

|              | Top | Politics | World | Business | Science | Health | Sport | Culture |
|---|---|---|---|---|---|---|---|---|
| BBC News     | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| The Guardian | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| NYT          | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| …            |   |   |   |   |   |   |   |   |

A reader picks topics (columns) and outlets (rows). Each chosen topic becomes **one card**
that merges the chosen outlets' feeds for that section (using the existing `mergeItems`,
`maxPerSource` and cross-card de-dupe). If an outlet has no feed for a section it is simply
left out of that card.

Some topics aren't sections of a newspaper (AI, Space, Hacker News, Premier League, iOS).
These are **specialist topics** with their own fixed sources, exactly like today's cards, and
don't depend on which outlets are picked. Today's six cards become entries here, keeping
their ids so existing layouts keep working.

### Catalogue file: `config/catalogue.json`

```jsonc
{
  "outlets": {
    "bbc":      { "name": "BBC News", "region": "uk", "sections": { "top": "…/news/rss.xml", "politics": "…", "world": "…" } },
    "guardian": { "name": "The Guardian", "region": "uk", "sections": { … } },
    "nyt":      { "name": "The New York Times", "region": "us", "paywall": "metered", "sections": { … } }
  },
  "topics": {
    "top":      { "label": "Top stories", "section": "top" },
    "politics": { "label": "Politics", "section": "politics" },
    "football": { "label": "Football", "region": "uk", "sources": [ { "name": "BBC Sport", "url": "…" }, { "name": "Sky Sports", "url": "…" } ] },
    "ai":       { "label": "AI", "sources": [ … ] }   // today's "ai" widget, same id
  },
  "defaults": {
    "uk": { "outlets": ["bbc", "guardian", "sky"], "topics": ["top", "politics", "world", "football", "tech"] },
    "us": { "outlets": ["nyt", "npr", "cbs"],      "topics": ["top", "politics", "world", "business", "tech"] }
  }
}
```

`feeds.json` keeps weather, backdrop and the default (no-JS / not-yet-set-up) page.

### Starting catalogue (checked live today, 30 Oct 2026)

Working, with fresh items:

| UK | US |
|---|---|
| BBC News (all sections) | The New York Times (section feeds) |
| The Guardian (`/<section>/rss`, excellent coverage) | NPR (`feeds.npr.org/<id>/rss.xml`) |
| Sky News (`feeds.skynews.com/feeds/rss/<section>.xml`) | CBS News |
| The i (`inews.co.uk/feed`) | ABC News |
| Daily Mail | NBC News |
| Evening Standard | Fox News |
| Financial Times (paywall) | CNBC (business) |
| The Economist (paywall, UK/global) | Politico, The Hill (politics) |
| Sky Sports (football) | LA Times |

Not usable (no public feed any more, blocked, or stale): **Telegraph** (402), **Reuters**
(404), **AP** (403), **Washington Post** (502), **USA Today** (402), **CNN** (feed frozen
since April 2023), **WSJ** (frozen since January 2025), **ITV News** (connection refused).
The Independent works with the server's own user agent and is in the catalogue.

**Built (step 1):** `config/catalogue.json` has 21 outlets (9 UK, 12 US, adding The
Independent, ABC, NBC, PBS and Axios to the table above) and 25 topics: 8 section topics
(Tech is not a section: it borrows the existing Tech card, as do AI, Space and Hacker News;
"climate" became "Science & environment"), plus Football, NFL, NBA, MLB, Cricket, Rugby,
F1, Apple, Gaming, Film & TV, Food, Travel and Personal finance. All 155 feeds pass
`npm run check-feeds` as of 30 Oct 2026.

Notes:
- Show a small "paywall" tag on FT, Economist and NYT, so nobody's surprised.
- Aim for a spread across the political spectrum in each region (e.g. Guardian ↔ Daily
  Mail, NPR ↔ Fox News) and don't pre-select any partisan outlet by default.
- Section URLs per outlet are filled in and verified by the feed checker (§5), not by hand.

## 2. Settings shape (additive, still `v: 1`)

```jsonc
{
  "v": 1,
  "profile": {
    "outlets": ["bbc", "guardian"],
    "topics":  ["top", "politics", "football", "ai"],
    "style":   "topics",          // "topics": one card per topic, mixed outlets
                                  // "outlets": one card per outlet (its top stories)
    "pictures": true,
    "weather": true,
    "backdrop": true
  },
  "tabs": { "home": { "cards": [ … ] } },   // unchanged: order, hidden, limit, col
  "custom": [ … ]                             // unchanged: reader's own feeds
}
```

- `validSettings` keeps `profile` only if every id is in the catalogue (unknown ids are
  dropped, so a removed outlet doesn't break anyone's page).
- Card ids are stable and predictable: `topic-politics`, `outlet-guardian`, or the existing
  ids for specialist topics. So drag order, hidden cards and item counts keep working
  untouched, and a topic added later just appears at the end (as `cardList` already does).
- Old exports with no `profile` still import and behave exactly as now.
- New pure function, shared and unit-tested: `cardsFromProfile(profile, catalogue)` →
  widget definitions (`{ id, title, sources, maxPerSource }`).

## 3. Server changes

Today the server pre-fetches every widget in `feeds.json` every 10 minutes and ships them
all in `/api/feeds.json`. With ~15 outlets × 8 sections that would be ~120 feeds and a
response far too large to send to everyone, so:

1. **Cache by source, not by widget.** `lib/cache.js` already keeps "last good result per
   source URL"; expose that as the unit.
2. **Refresh lazily.** Sources used by the default page are refreshed on the timer as now.
   Catalogue sources are refreshed on the same timer only while someone has asked for them in
   the last ~24 hours; the first request for a cold source fetches it on the spot (as
   `/api/feed` does for custom feeds).
3. **New endpoint `/api/sources?ids=bbc.politics,guardian.politics,…`** (ids sorted, so
   Cloudflare caches each combination). Returns per-source items with thumbnails, the same
   item shape as today, with an ETag. Only catalogue ids are accepted, so this can't be used
   to fetch arbitrary URLs.
4. `/api/catalogue.json`: outlet/topic names, regions, paywall flags and defaults, for the
   setup screen (cached for an hour).

**Built (step 2):** `lib/sources.js` and both endpoints, as above. Cold request for 18
feeds ≈ 0.5s, warm ≈ 1ms, ~77KB before compression. The catalogue's feeds share the
default page's preview-image finder and thumbnailer (raised to 5000 and 3000 entries).
Not done: feeds that appear in both the catalogue and `feeds.json` (e.g. BBC News top
stories) are fetched twice, and the Cloudflare Cache Rule doesn't cover `/api/sources` yet.

The browser then builds topic cards from the sources it got, using the same `stories.js`
merge/de-dupe code the server uses.

## 4. One-step setup

**When:** first visit with JavaScript and no saved settings. It opens over the default page,
so "Skip" leaves a perfectly good page behind it. Existing readers (anyone with saved
settings) never see it unasked. Customise gets a **"Topics & sources…"** button that reopens
the same screen with their current choices ticked.

**What:** one panel, no wizard, no "Next". Top to bottom:

```
┌───────────────────────────────────────────────────────────┐
│  Make this page yours                                      │
│  Pick a few things. You can change any of it later.        │
│                                                            │
│  Region   [● UK]  [ US ]  [ Both ]                         │
│                                                            │
│  Topics                                                    │
│  [✓ Top stories] [✓ Politics] [✓ World] [ Business ]       │
│  [✓ Tech] [ Science ] [ Health ] [ Climate ] [✓ Football ] │
│  [ Culture ] [ AI ] [ Space ] [ Hacker News ] [ iOS ]      │
│                                                            │
│  Sources                                                   │
│  [✓ BBC] [✓ Guardian] [✓ Sky News] [ The i ] [ Daily Mail ]│
│  [ FT ·paywall ] [ Economist ·paywall ] [ Standard ]       │
│                                                            │
│  Your page                                                 │
│  Cards:    (● One per topic)  ( ○ One per source )          │
│  Stories:  (● With pictures)  ( ○ Compact )                 │
│  [✓] Weather for  [ Beckenham          ]                   │
│  [✓] Daily photo behind the page                           │
│                                                            │
│  ─────────────────────────────────────────────────────── │
│  Skip                              [ Build my page · 6 cards ] │
└───────────────────────────────────────────────────────────┘
```

Details:
- **Everything is pre-selected sensibly**, so a reader who just presses the button gets a good
  page. Region is guessed from `Intl.DateTimeFormat().resolvedOptions().timeZone`
  (`Europe/London` → UK, `America/*` → US, otherwise Both); defaults come from the catalogue.
- Changing region re-filters the source chips and swaps in that region's defaults (only if the
  reader hasn't touched the sources yet). Region-specific topics (Football vs NFL/NBA) follow
  the same rule.
- Chips are real checkboxes (`<input type=checkbox>` in a `<label>`), so keyboard and screen
  readers work; the button label counts cards live and is disabled at 0 topics.
- On mobile it's a full-screen sheet with a sticky footer button.
- Pressing **Build my page** writes `profile` plus a fresh `tabs.home.cards` (topics in the
  order shown) and redraws in place via the existing `replaceSettings` path. No reload.
- **Skip** saves `{ v: 1, tabs: {}, profile: null, onboarded: true }`-equivalent so it
  doesn't reappear (storage permitting).
- Without JavaScript nothing changes: the server-rendered default page is shown.

Weather location: needs a small geocoding lookup (Open-Meteo has a free geocoding API) and
per-reader weather, which the server doesn't do yet. **Suggest shipping v1 with just
on/off** for the shared location, and adding a per-reader location as a follow-up.

## 5. Keeping the catalogue healthy

- `npm run check-feeds`: fetches every catalogue URL, reports status, item count and newest
  date, and flags anything failing or older than 7 days (this is how the table in §1 was
  made). Run before each catalogue edit.
- Feeds that fail at runtime already fall back to last good items; a source failing for
  >24h is quietly dropped from its cards rather than leaving a stale block.
- Test that every topic has at least one source in each region it's offered in, ids are
  unique, and every default exists.

## 6. Build order

1. **Catalogue + checker**: `config/catalogue.json`, `npm run check-feeds`, validation tests.
2. **Server**: per-source cache with lazy refresh, `/api/sources`, `/api/catalogue.json`.
3. **Client cards**: `profile` in settings, `cardsFromProfile`, topic cards in `page.js`;
   style/pictures options. Existing cards and custom feeds untouched.
4. **Setup screen**: first-run dialog + "Topics & sources…" in Customise.
5. **Polish**: mobile sheet, focus handling, empty/failed-source states, `prefers-reduced-motion`.

Each step ships on its own; after step 3 the feature is usable from Customise even before
the first-run screen exists.

## 7. Open questions

- Should "Both" mix UK and US outlets in the same topic card, or label them
  ("Politics · UK", "Politics · US")? Suggest separate cards for Politics, mixed for the rest.
- Which sports for the US: NFL, NBA, MLB as separate topics, or one "US sports" card?
- Should the default (no-JS, not set up) page move to the catalogue too, so there's one source
  of truth? Likely yes once step 3 lands.
