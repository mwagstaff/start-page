# tab1.net load and performance review

Test date: 16 November 2026, approximately 01:47–02:00 UTC (also UK local time).

## Capacity verdict

**Hundreds of steady readers are plausible, but the current deployment is not yet proven reliable for 500 active readers plus arrival bursts.** A standalone workload equivalent to 500 default-profile readers polling once per minute passed. A mixed workload passed at 35 requests/second, but a 60 requests/second stage developed multi-second latency and stopped automatically. Adding two first-time arrivals per second to a 500-reader polling workload also hit safety limits, including one timeout.

The Node application is not showing CPU exhaustion. Direct loopback requests on Mini were fast at 50 requests/second. The strongest opportunities are restoring effective caching and reducing traffic on the Sky–Mini connection, which was observed using a Tailscale DERP relay. This is evidence of a likely transport bottleneck, **not proof that DERP alone caused every delay**; shared-host contention and client/network variability remain possible contributors.

No production code, settings, cache rules, or deployments were changed. The additions in this checkout are test scripts and review artifacts.

## Method and scope

- Inspected server, feed/source/thumbnail caches, custom feeds, rendering, browser refresh and layout code, and deployment routing.
- Local revision: `8aa947203a9e80a6b8f8c655d4e69c86412a21e3`. SHA-256 hashes of production `server.js`, `lib/sources.js`, and `public/page.js` matched this checkout. This is a targeted deployment check, not a complete filesystem comparison.
- Production route: browser → Cloudflare → Cloudflare Tunnel/Caddy on Sky → Tailscale → Node port 3060 on Mini.
- Mini: 8 logical CPUs, 16 GiB RAM; application PID 26103. Sky: 4 CPUs, approximately 7.6 GiB RAM; it also hosts other workloads and had load averages around 4–5 with swap in use. This does not by itself establish a bottleneck.
- Used an isolated Chromium 151 browser, cold and warm visits, desktop 1440×1000 and mobile 390×844. Mobile used 4× CPU slowdown, 150 ms emulated latency and 1.6 Mbps download. These are lab samples, not real-user percentile measurements.
- Captured HAR files, page timing, layout shifts, long tasks, screenshots, HTTP caching headers, response bytes, and sampled process CPU/RSS.
- Load generator used fixed arrival rates rather than waiting for each response before issuing the next. Public HTTP tests used keep-alive HTTP/1.1; real browser captures used browser-negotiated protocols. Requests were read-only GETs.
- Mixed requests: 20% HTML, 30% shared feeds, 30% default-profile sources, 10% catalogue, 10% CSS. Conditional requests were used for non-HTML endpoints after warm-up.
- Scheduled load stages capped in-flight requests at 80; stop conditions were recent-request p95 above 2 seconds or more than one HTTP/transport failure in 50 responses. Request socket timeout was 5 seconds. A planned final 100-request HTML burst was **not run**, because the preceding stage stopped.
- Did not repeatedly invoke `POST /api/refresh`, fetch arbitrary third-party feeds, restart production, or deliberately exhaust the service. Cold-source and custom-feed concurrency were tested with injected local fake fetches.
- Existing suite: **161 tests passed**.

## Measured load results

Percentiles are full-response durations, including transfer. Warm-up requests are excluded below.

| Scenario | Completed requests | p50 | p95 | p99 | Result |
|---|---:|---:|---:|---:|---|
| Public mixed, 5 req/s, 20 s | 100 | 146 ms | 279 ms | 314 ms | All 200 |
| Public mixed, 17 req/s, 30 s | 510 | 158 ms | 217 ms | 284 ms | All 200 |
| Public mixed, 35 req/s, 30 s | 1,050 | 165 ms | 239 ms | 380 ms | All 200 |
| Public mixed, target 60 req/s | 259 | 722 ms | 3,472 ms | 3,770 ms | Stopped after ~6.3 s; all completed responses 200; 10 scheduled requests skipped at concurrency cap |
| 500-reader polling equivalent, one 60 s cycle | 1,000 | 169 ms | 214 ms | 306 ms | All 200; no skipped requests |
| Same polling workload generated from Sky, separate 60 s run | 1,000 | 137 ms | 209 ms | 357 ms | All 200; no skipped requests |
| 510 distinct warm source combinations, 17 req/s | 510 | 158 ms | 234 ms | 390 ms | All 200 |
| Direct Mini loopback, 50 req/s, 20 s | 1,000 | 1.0 ms | 14.6 ms | 16.9 ms | 300 × 200, 700 × 304 |
| Planned 5-minute 500-reader soak, with arrival replay overlap | 958 | 170 ms | 328 ms | 4,127 ms | Stopped after ~61 s: 957 × 200, one 5 s timeout |

The direct-origin result is **not an apples-to-apples public-route comparison**: ETag validation works there, so most API responses are small 304s; the public compressed route returned full 200 bodies. Its value is showing that app processing and local response handling have significant headroom under this workload.

The arrival replay planned 100 visits at two visits/second, using the first cold desktop navigation's 68 first-party URLs and six parallel resource requests per visit. It intentionally excluded Bing and did not execute/render JavaScript. It overlapped the 500-reader soak. It stopped after 53 visits started, with 48 complete and five partial, when visits exceeded 5 seconds. All 3,403 completed HTTP requests were 200; 3,179 were edge HITs, 21 MISSes and 203 DYNAMIC. Partial visits mean aggregate visit p95 must not be interpreted as a successful full-page-load benchmark. The slowest HTML requests took 3.1–4.3 seconds, and the slowest completed visit took 5.49 seconds.

The 510-combination scenario varies subsets of nine already-loaded default sources. It exceeds the 200-entry response-combination cache, but does **not** simulate 510 distinct feeds or cold activation of the whole catalogue.

The second public-route polling run originated on Sky, independently of the laptop generator. It confirms the short steady-state pass from another network location, but it is not geographically independent of the hosting path. It did not repeat the failed burst scenario.

## How “hundreds of users” translates into traffic

For a default visible page, the background loop requests the shared snapshot and profile sources roughly once per minute when idle. Hidden or busy pages often skip checks; returning to a tab can trigger another check.

| Visible, eligible default-profile pages | Average polling requests/second |
|---:|---:|
| 100 | 3.3 |
| 300 | 10.0 |
| 500 | 16.7 |

These counts are workload equivalents, not hundreds of real browsers. They exclude visits, reloads, visibility-change bursts and arbitrary custom feeds. Ten additional custom feeds per person would raise a 500-reader workload to roughly 100 requests/second before visits, if each is polled every minute. Do not extrapolate the default-profile pass to that case.

Browser payloads were approximately 0.60 MB on the cold desktop visit and 53 KB on the warm visit according to Resource Timing. The cold background photograph alone was about 339 KB in the HAR, fetched from Bing. The snapshot was 111,968 bytes uncompressed; the default source combination was 42,468 bytes. Because origin responses are uncompressed and public revalidation fails, 500 polling readers imply about **77 MB/minute (~10.3 Mbps)** of body traffic from Mini to Sky for these two APIs, before protocol overhead. Public compressed polling traffic measured about **17.6 MB/minute (~2.34 Mbps)**. The first calculation is an estimate from measured body sizes and request rate, not a NIC bandwidth measurement.

## Prioritised findings

### 1. High: production API edge caching is not working as documented

Repeated requests and both browser HARs returned `CF-Cache-Status: DYNAMIC` for `/api/feeds.json`, `/api/catalogue.json`, and canonical `/api/sources?ids=...`. In the mixed tests, the 10% CSS traffic was HIT; the other 90% was DYNAMIC. Thus the cache-friendly API headers are not currently shielding the origin.

The README describes a cache rule in the `skynolimit.dev` zone. Check the actual **tab1.net zone** and the rule's hostname/expression, eligibility, order and TTL settings; the dashboard configuration was not inspected, so a particular misconfiguration is not established. Preserve the complete canonical `ids` query in source cache keys. Do not cache error responses or indiscriminately cache custom feeds/refresh endpoints.

Acceptance: repeated ordinary GETs to each canonical API show MISS then HIT with an increasing Age, expected origin TTLs, and correct updates after expiry; test actual browser revalidation requests too. Cloudflare documents DYNAMIC as ineligible for edge caching: [official troubleshooting guidance](https://developers.cloudflare.com/cache/troubleshooting/investigating-uncached-responses/).

### 2. High: compressed responses defeat ETag validation

`server.js` compares `If-None-Match` with the generated ETag using exact string equality. The public compressed response carries `W/"..."`, while the origin generates `"..."`. Repeating a gzip request with its returned validator produces another 200 and the full body. The same request with identity encoding, or direct to Node, produces 304. This was also observed in real warm browser requests, not just the load generator.

Fix validator parsing to use weak comparison for GET/HEAD, correctly handling lists and `*`. Check compression-related `Vary` behaviour at the proxy as part of that work. Add integration tests through the compression path; unit tests against bare Node alone would miss this regression. [RFC 9110 requires weak comparison for If-None-Match](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.2).

Acceptance: unchanged compressed browser API requests receive 304 with zero response body. This should sharply reduce traffic even before edge caching is repaired. It also reduces avoidable HTML rendering when browsers send a valid page validator.

### 3. High: Sky–Mini production traffic is relayed, with limited demonstrated burst headroom

`tailscale ping` from Sky returned three pongs via `DERP(lhr)` (42–193 ms) and reported that a direct connection was not established. `tailscale status` independently showed `relay "lhr"`. Caddy's live route points to Mini's Tailscale hostname. Tailscale documents that DERP relays have lower throughput and fairness limits: [official performance guidance](https://tailscale.com/docs/reference/troubleshooting/poor-performance-tailnet).

Sky's `tailscale netcheck` reported working UDP and destination-independent mapping. This rules out assuming that Sky simply has no UDP connectivity; it does not diagnose Mini's NAT/firewall or explain why this particular peer pair remained relayed.

The low app CPU, fast loopback timings and slowdown on full public responses make this route a strong suspect. The mixed-test application CPU peak was approximately 22% of one core, not all eight cores; sampled RSS stayed below 126 MiB across the observed sessions. These samples cannot rule out brief CPU/event-loop spikes or prove the absence of memory leaks.

First remove unnecessary traffic with the caching fixes. Then investigate UDP/NAT/firewall connectivity for a direct Sky–Mini path, or deliberately choose an architecture that avoids this relay, such as terminating the application tunnel on Mini. Moving the service to other hosting is another option, but Sky's existing contention should be assessed before placing more work there. No network changes were made.

Acceptance: record the route during load and repeat a multi-location sustained 500-reader test plus arrivals; require p95 <500 ms for warm API calls, no timeouts/5xx, and a stable origin queue/memory profile. A failed 60 req/s sample is not a universal maximum-throughput figure.

### 4. Medium: cold catalogue-source requests can return empty data to concurrent readers

In `lib/sources.js`, `load()` sets `triedAt` immediately. A second `get()` sees a recent attempt and skips waiting, even though `source.loading` is still pending. It can serialize an empty source and return 200. The focused local reproduction produced one upstream fetch, zero stories for the concurrent second caller, and one story for the original caller after release.

Await an existing loading promise when there is no previous usable result. When refreshing already-populated data, deliberately return stale data rather than accidentally empty data. Avoid putting incomplete first-load responses into the shared response/edge cache. This becomes more important once edge caching is enabled because an empty response could be shared for its cache TTL.

Acceptance: a burst of concurrent first requests shares one upstream fetch and all callers receive populated data or an explicit temporary failure; subsequent warm requests stay fast.

### 5. Medium: custom-feed scaling has a deliberate global admission limit

`lib/custom.js` permits 30 uncached/expired feed fetches per minute for the entire process and keeps 300 entries. A local fake-fetch probe with 100 distinct URLs produced 30 successes and 70 HTTP-429-equivalent errors. Shared warm URLs do not consume the budget, which is good, but many different personal feeds or simultaneous expiry/eviction can hit it. The UI limit of 20 feeds per reader does not solve the global limit.

Keep the protective limit; add a bounded queue, clear retry/backoff and stale-data behaviour, and size the cache based on observed usage. Do not simply remove limits. The separate reload endpoint also globally admits only one refresh per minute; many readers reloading can therefore cause more upstream refreshes than the normal ten-minute schedule even though calls are coalesced/throttled.

### 6. Medium: background feed/image work needs stronger bounds before broad catalogue adoption

There are 20 configured default feed URLs and 162 catalogue sources. Feed refreshes run in parallel; catalogue image warming and thumbnail downloads/conversions are also initiated with broad `Promise.all` fan-out. The article-preview finder already limits itself to six concurrent requests, but the thumbnail downloader does not have a corresponding global concurrency queue.

Thumbnail downloads reject an oversized Content-Length, but when that header is absent or inaccurate they buffer the whole body before enforcing 15 MB. Catalogue/default feeds similarly parse fully buffered XML without an explicit response-byte cap. Adding many topics can create a larger memory/network spike than the warm read tests exercise.

Add global queues for feed fetches and thumbnail work, enforce streaming byte limits, and measure queue depth/processing time. Persisting last-good snapshots would also reduce restart sensitivity. Do not claim the current short warm tests cover catalogue-wide cold starts, refresh storms or a 24-hour soak.

### 7. Medium: mobile startup shifts content after the first paint

| Browser sample | TTFB | LCP | Load event | CLS during sample | Long-task time |
|---|---:|---:|---:|---:|---:|
| Desktop cold | 521 ms | 1,080 ms | 1,329 ms | 0.008 | 0 ms |
| Desktop warm | 198 ms | 284 ms | 243 ms | 0.008 | 0 ms |
| Throttled mobile cold | 361 ms | 1,200 ms | 3,646 ms | 0.192 | 56 ms |
| Throttled mobile warm | 210 ms | 256 ms | 306 ms | 0.015 | 0 ms |

No page JavaScript exceptions or HTTP failures appeared in these initial browser captures. The cold mobile shift reproduced independently: approximately 0.177 from masthead/weather/search wrapping, followed by 0.015 from the content below. Attribution and source inspection point to post-load keyboard decoration and changes to reserved control/card space. Warm-load shift attribution included a recent-input exclusion, so the smaller warm CLS should not be taken as proof that the underlying movement disappears.

Reserve final masthead, weather shortcut and card-title dimensions in the initial HTML/CSS, or render stable decorations before first paint. A CLS of 0.192 is in the “needs improvement” range; [Google's good threshold is ≤0.1](https://web.dev/articles/cls). These short samples fit inside a single CLS session window. Real-user INP was not measured.

### 8. Lower priority: reduce initial bytes and add operational visibility

The cold page requested 23 static resources including CSS and the logo, plus data and thumbnails. The CSS was about 93 KB decoded and 24 KB transferred; weather/forecast and advanced-settings modules load on the main page even before those screens are used. There was no major main-thread bottleneck in the measured default layout, so defer these modules only if a measured improvement justifies added complexity. The 339 KB desktop-size backdrop is a larger mobile transfer opportunity; use responsive variants. Preserve the existing small WebP thumbnails.

Hashed static URLs currently have a one-hour origin cache lifetime; a long immutable lifetime for verified content-hashed requests could reduce repeat traffic. Keep unversioned URLs separately revalidatable. HTML is rebuilt for ordinary 200 responses even when its content is unchanged; memoising it by the existing page version/date/unit/assets key is an optional later optimisation.

The app exposes a readiness endpoint but no request-latency/cache/queue metrics in the inspected server. Add route-level request/error/duration metrics, event-loop delay, RSS/heap, active upstream fetches, image queue depth, cache hit ratios, outbound bytes and feed age. Alert on stale feeds and public-route latency as well as process health. The production logs also repeatedly report an ESA feed 404; this is a content freshness issue, not evidence of overload.

## Recommended order and sign-off

1. Fix weak ETag comparison and cold-source concurrency, with targeted regression tests.
2. Correct and verify API cache eligibility in the tab1.net Cloudflare zone.
3. Resolve or remove the relayed origin hop; measure public versus origin timings and byte volume.
4. Repeat 500-reader polling for at least 30–60 minutes, including timed refreshes and two new arrivals/second; test several source profiles and more than one geography. Scale towards 1,000 only after that passes.
5. Add upstream-work bounds, metrics, and the mobile layout-stability fix.

Until those checks pass, describe the result as **“steady 500-reader polling passed a short test; burst resilience needs improvement”**, not “supports 500 concurrent users without qualification.”

## Artifacts and reproduction

- `load-public.json`, `load-poll500.json`, `load-varied.json`, `load-origin.json`: per-request measurements and phase summaries.
- `load-public-sky.json`: second-vantage public-route polling test.
- `load-soak500.json`, `load-arrivals.json`: safety-stopped mixed/arrival scenarios. The five-minute soak was not completed.
- `desktop.har`, `mobile.har`: public-only isolated browser captures, response bodies omitted; include cold and warm navigations in each file.
- `browser.json`, `mobile-shift-attribution.json`, screenshots: browser metrics and visual evidence.
- `etag-public-node.json`, `etag-check.json`, `origin-payloads.json`: cache/compression probes. Python urllib public probes in `etag-check.json` received 403, while browser, curl and Node probes succeeded; those 403s are not included as application capacity failures.
- `component-probes.json`: deterministic local race/admission-limit results.
- `origin-telemetry.txt`, `origin-soak-telemetry.txt`, `network-route.txt`, `sky-netcheck.txt`: sampled infrastructure evidence.

Run from the repository root, one load workload at a time unless intentionally repeating the documented combined scenario:

```sh
node scripts/performance-load.mjs https://tab1.net performance/2026-11-16/retest-poll.json poll500
node scripts/performance-load.mjs https://tab1.net performance/2026-11-16/retest-varied.json varied
node scripts/performance-load.mjs https://tab1.net performance/2026-11-16/retest-mixed.json mixed
node scripts/performance-components.mjs performance/2026-11-16/retest-components.json
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node scripts/performance-browser.mjs
```

Browser tooling reuses an existing Playwright installation; no project dependencies were added. Test paths with the default date are fixed output destinations: use new output paths/directories to preserve these baseline artifacts.
