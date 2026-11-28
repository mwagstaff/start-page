// Deterministic local fixture for the iOS offline UI test. Never used in production.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { parseWeather } from "../public/forecast.js";
const weather = parseWeather(JSON.parse(readFileSync(new URL("../test/fixtures/open-meteo.json", import.meta.url))), "Beckenham");
weather.temperature = 11;
weather.days.unshift({ ...weather.days[0], day: "Yesterday", date: "2026-10-28", weekday: "Wed" });
const port = Number(process.env.PORT || 3068);
const photoURL = `http://localhost:${port}/fixture-photo.png`;
let settings = {
  v: 1,
  tabs: { home: { cards: [{ id: "fixture" }] } },
  custom: [],
  profile: {
    outlets: [],
    topics: [],
    style: "topics",
    pictures: true,
    weather: true,
    backdrop: false,
    paywalls: true,
  },
};
const summary = { unavailable: true, pending: false,
  discussion: { bullets: ["Readers compared the two routes."], count: 1, total: 2, updated: "2026-11-18T10:00:00.000Z" } };
const interruptedRefreshes = new Set();
const backgroundEditions = new Map();
let longArticle = false;
let pendingSummaryReady = false;
let downloadFailures = 0, failureStatus = 503, articleAttempts = 0;
let revision = 0,
  reading = {};
const readingTests = new Map();
async function handleRequest(req, res) {
  let body = "";
  for await (const chunk of req) body += chunk;
  const value = body ? JSON.parse(body) : {};
  const route = new URL(req.url, "http://localhost").pathname;
  const editionID = route.match(/^\/background-edition\/([^/]+)\//)?.[1];
  if (editionID) {
    const edition = backgroundEditions.get(editionID) ?? { published: false, offline: false, served: false };
    backgroundEditions.set(editionID, edition);
    if (route.endsWith("/test")) {
      if (req.method === "POST") {
        if (value.failSync) edition.failSync = true;
        if (value.failFirstArticle) edition.failFirstArticle = true;
        if (value.holdFirst) edition.holdFirst = true;
        if (value.publish) {
          edition.published = true;
          edition.release?.();
        }
        if (value.disconnect) edition.offline = true;
      }
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ served: edition.served }));
      return;
    }
    if (edition.offline || (edition.failSync && route.endsWith("/sync"))) { res.writeHead(503).end(); return; }
    const link = "https://example.org/edition/" + editionID;
    if (route.endsWith("/article") && edition.failFirstArticle) {
      edition.failFirstArticle = false;
      res.writeHead(502, { "Cache-Control": "no-store" }).end();
      return;
    }
    if (route.endsWith("/cards") || route.endsWith("/article")) {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      if (route.endsWith("/cards")) {
        // Hold the next feed response until the test has put the app in the background.
        if ((edition.opened || edition.holdFirst) && !edition.published) {
          edition.publication ??= new Promise(resolve => { edition.release = resolve; });
          await edition.publication;
        }
        edition.opened = true;
        res.end(JSON.stringify({ settings, catalogue: {}, cards: [{
          id: "fixture", title: "Your stories",
          items: edition.published ? [{ title: "Afternoon edition", link }] : [],
        }] }));
      } else {
        const requested = new URL(req.url, "http://localhost").searchParams.get("url");
        res.end(JSON.stringify({ title: "Afternoon edition", extractionVersion: 3,
          html: "<p>The afternoon report is ready to read offline.</p>", images: [],
          downloadedAt: new Date().toISOString() }));
        if (requested === link) edition.served = true;
      }
      return;
    }
  }
  if (route.startsWith("/retry-once/") && route.endsWith("/cards") && !interruptedRefreshes.has(route)) {
    interruptedRefreshes.add(route);
    res.writeHead(503).end();
    return;
  }
  if (route === "/slow-refresh/api/companion/cards") await new Promise(resolve => setTimeout(resolve, 9000));
  if (route === "/fixture-photo.png") {
    if (req.url.endsWith("?slow")) await new Promise(resolve => setTimeout(resolve, 15000));
    res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
    res.end(readFileSync(new URL("../public/apple-touch-icon.png", import.meta.url)));
    return;
  }
  if (route === "/test/downloads") {
    if (req.method === "POST") {
      downloadFailures = value.failures ?? 0;
      longArticle = value.long === true;
      failureStatus = value.status ?? 503;
      articleAttempts = 0;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ articleAttempts }));
    return;
  }
  if (route.endsWith("/article")) {
    articleAttempts++;
    if (downloadFailures > 0) {
      downloadFailures--;
      res.writeHead(failureStatus, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Fixture article unavailable", retryable: failureStatus === 503 }));
      return;
    }
  }
  if (route.startsWith("/pending-summary/") && route.endsWith("/cards")) pendingSummaryReady = false;
  let response;
  const readingTest = route.match(/^\/reading-test\/([^/]+)\//)?.[1];
  if (readingTest && (route.endsWith("/create") || route.endsWith("/sync"))) {
    if (route.includes("/tiny-batches/") && Object.keys(value.reading ?? {}).length > 1) {
      res.writeHead(413).end();
      return;
    }
    const state = readingTests.get(readingTest) ?? {
      settings: { ...settings, tabs: { home: { cards: [{ id: "fixture", limit: 1 }] } } },
      reading: {}, revision: 0,
    };
    if (route.includes("/hn-coverage/") && !readingTests.has(readingTest)) {
      state.settings.tabs.home.cards = [{ id: "tech", limit: 1 }, { id: "hacker-news", limit: 8 }];
      for (let i = 1; i <= 4; i++) state.reading["https://example.org/hn/" + i] = { read: true };
    }
    for (const [id, patch] of Object.entries(value.reading ?? {})) {
      state.reading[id] = { ...state.reading[id], ...patch };
    }
    if (req.method === "POST") state.revision++;
    readingTests.set(readingTest, state);
    response = { ...state, token: "fixture-token" };
  } else if (route.endsWith("/create"))
    response = { token: "fixture-token", revision, settings, reading };
  else if (route.endsWith("/sync")) {
    if (req.method === "POST") {
      settings = value.settings;
      for (const [key,patch] of Object.entries(value.reading||{})) reading[key]={read:false,saved:false,...reading[key],...patch};
      revision++;
    }
    response = { revision, settings, reading };
  } else if (route.endsWith("/cards"))
    response = {
      settings,
      catalogue: { outlets: {}, topics: {science:{label:"Science"}} },
      weather,
      cards: [
        ...(value.appTopics?.includes("science") ? [{id:"app-topic-science", title:"Science",items:[{title:"App-only science story",link:"https://example.org/science"}]}] : []),
        {
          id: "fixture",
          title: "Your stories",
          failedSources: ["Test newspaper"],
          items: [
            {
              title: "A story ready for the journey",
              link: "https://example.org/offline",
              source: "Test newspaper",
              date: new Date(Date.now() - 3 * 3600000).toISOString(),
              excerpt: "The publisher’s original words.", summary: route.startsWith("/pending-summary/") ? { pending: true } : summary, comments: 1,
              commentsUrl: "https://news.ycombinator.com/item?id=1",
            },
            ...Array.from({length:9}, (_, i) => ({title: `Journey story ${i+1}`, link: `https://example.org/journey/${i}`, source: "Test newspaper"})),
          ],
        },
      ],
    };
  else if (route.endsWith("/summary")) {
    const query = new URL(req.url, "http://localhost").searchParams;
    const isPendingFixture = route.startsWith("/pending-summary/") && query.get("url") === "https://example.org/offline";
    if (isPendingFixture && query.has("background")) pendingSummaryReady = true;
    response = isPendingFixture && !pendingSummaryReady ? { pending: true } : summary;
  }
  else if (route.endsWith("/article"))
    response = {
      title: "A story ready for the journey",
      extractionVersion: 3,
      html: `<p>Offline reading works even when the connection disappears.</p><figure><img src="${photoURL}" alt="Offline test photograph"><figcaption>Saved photograph</figcaption></figure><p>A journalist’s café report — £20, José and “quoted words”.</p>`,
      images: [photoURL],
      downloadedAt: new Date().toISOString(),
    };
  else if (route.endsWith("/comments"))
    response = {
      comments: [
        {
          id: "1",
          parent: null,
          depth: 0,
          author: "traveller",
          html: new URL(req.url, "http://localhost").searchParams.get("refresh") === "true"
            ? "<p>A freshly updated reply.</p>" : "<p>A thoughtful offline reply.</p>",
        },
        { id: "2", parent: "1", depth: 1, author: "reader", html: '<a href="https://example.org/guide">Discussion guide</a>' },
      ],
      total: 1, // Older cached responses can undercount saved replies.
      complete: true,
      downloadedAt: new Date().toISOString(),
    };
  else {
    res.writeHead(404);
    res.end();
    return;
  }
  if (route.startsWith("/dated-stories/") && route.endsWith("/cards")) {
    const items = response.cards[0].items;
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    Object.assign(items[9], {
      date: yesterday.toISOString(), source: "Hacker News", image: photoURL, summary,
      comments: 1, commentsUrl: "https://news.ycombinator.com/item?id=1",
    });
    items.push({ title: "Earlier report", link: "https://example.org/earlier", date: "2025-11-25T12:00:00Z" });
    items.push(items[0]);
  }
  if (readingTest && route.endsWith("/cards")) {
    response.settings = readingTests.get(readingTest).settings;
    const stories = response.cards[0].items;
    for (let i = 10; i < 55; i++) stories.push({
      title: `Journey story ${i}`, link: `https://example.org/journey/${i}`, source: "Test newspaper",
    });
    stories.forEach((story, i) => { story.date = new Date(Date.now() - i * 60000).toISOString(); });
  }
  if (route.includes("/hn-coverage/") && route.endsWith("/cards")) {
    const items = Array.from({ length: 24 }, (_, i) => ({
      title: "HN headline " + (i + 1), link: "https://example.org/hn/" + (i + 1),
      date: new Date(Date.now() - i * 1000).toISOString(), source: "Hacker News",
    }));
    response.cards = [
      { id: "tech", title: "Technology", items: [
        { title: "Tech latest", link: "https://example.org/tech/latest" },
        { title: "Older technology report", link: "https://example.org/tech/old" },
      ] },
      { id: "hacker-news", title: "Hacker News", items },
    ];
  }
  if (route.startsWith("/slow-image/") && route.endsWith("/article")) response.images = [photoURL + "?slow"];
  if (route.startsWith("/busy-library/")) {
    if (route.endsWith("/cards")) {
      response.cards = Array.from({ length: 10 }, (_, card) => ({
        id: "section-" + card, title: "Section " + card,
        items: Array.from({ length: 8 }, (_, item) => ({
          title: `Section ${card} story ${item}`, link: `https://example.org/${card}/${item}`,
          source: "Test newspaper", image: photoURL,
        })),
      }));
    } else if (route.endsWith("/article")) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      response.html += "<p>A downloaded paragraph for offline reading.</p>".repeat(3000);
    }
  }
  if (route.endsWith("/article") && longArticle) {
    response.images = [];
    response.html = '<h2>Key events</h2><ul class="reader-timeline"><li><a href="#block-end"><span class="reader-time">1m ago</span><span>Jump to final update</span></a></li><li><a href="#block-start"><span class="reader-time">5m ago</span><span>First update</span></a></li></ul>'
      + Array.from({length: 2000}, (_, i) => `<section class="reader-block" id="${i === 0 ? 'block-start' : 'block-' + i}"><h2>Update ${i}</h2><p>${'A long article should keep scrolling smoothly, without reloading the page when the library changes. '.repeat(5)}</p></section>`).join('')
      + '<section class="reader-block" id="block-end"><h2>Final update reached</h2><p>The entire article remains available offline.</p></section>';
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(response));
}
for (const host of ["127.0.0.1", "::1"]) {
  createServer(handleRequest).listen(port, host, () => console.log("iOS fixtures on " + host + " port " + port));
}
