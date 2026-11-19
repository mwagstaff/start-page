# Caching fixes and relay options — 16 November 2026

**Subsequent implementation:** option A was approved and the dedicated Mini tunnel
was deployed later on 16 November. The proposal and measurements below describe
the earlier state. See [the tunnel runbook](../../infrastructure/MINI-TUNNEL.md)
and [post-cutover results](tunnel/RESULTS.md) for the current route and validation.

## Completed and live

The following application changes were deployed to Mini and the service restarted successfully. Remote file hashes matched the tested local files. No DNS, tunnel, firewall, Tailscale or hosting changes were made.

- `lib/http-cache.js`: GET/HEAD conditional requests now compare ETags weakly, including comma-separated validators, quoted commas and wildcard matching. Compression's `W/` prefix no longer defeats validation. Invalid validator syntax does not produce a false match.
- `lib/sources.js`: concurrent first readers await the same upstream request. Readers with last-good data can continue using it during an already-running refresh. Failed first loads carry `no-store`, so their empty/error response is not distributed through the edge cache; upstream retry throttling remains intact.
- `server.js`: uses the shared validator and source-specific cache policy.
- Cloudflare: created the previously missing cache rule in the **tab1.net zone**, using the authenticated dashboard. The available API tokens lacked ruleset access; no credentials or permissions were expanded.
- README: corrected the zone/rule documentation. Performance probe scripts now support post-fix checks without overwriting baseline evidence.

Cloudflare rule: **tab1.net: cache shared feed APIs (origin TTL)**, ID `e555dbdd030a4894aa1c9f1663ff764a`.

```text
(http.host eq "tab1.net" and http.request.uri.path in {"/api/feeds.json" "/api/catalogue.json" "/api/sources"})
```

Eligible for cache; Edge TTL uses origin cache-control and bypasses when absent; Browser TTL respects origin. Default cache keys preserve all query parameters. No forced TTL/status override. HTML, health checks, arbitrary custom feeds and manual refresh endpoints are outside the rule.

## Verification

**166 tests passed**, including a real HTTP compression-proxy regression test and 100 concurrent first readers. The deterministic source probe now reports one upstream fetch, no response before that fetch completes, and populated data for both callers.

Live HTTP checks confirmed:

- Shared snapshot, catalogue and source responses transition to/return `HIT`.
- Compressed conditional requests return 304 with zero body, including requests with `Cache-Control: no-cache`.
- Source queries for `bbc.top` and `bbc.top,bbc.world` return distinct, correct results.
- Invalid source IDs return 400, `no-store`, and `BYPASS`.
- HTML and health remain `DYNAMIC`.
- During the load retest, expiry produced `UPDATING` responses followed by edge HITs, exercising stale-while-revalidate.

The combined retest ran the 500-reader polling equivalent for one minute while replaying 100 new first-party page visits at two arrivals/second. It completed **7,800 scenario requests with zero errors or safety stops** (plus five warm-up requests).

| Scenario | Result after fixes | Earlier baseline |
|---|---|---|
| 1,000 polling requests with arrivals overlapping | All 304; median 20 ms, p95 89 ms; 998 HIT, 2 UPDATING; zero response-body bytes | Combined scenario stopped with one timeout; standalone polling downloaded ~17.6 MB of bodies/minute |
| 100 visits × 68 first-party URLs | All 6,800 responses 200; all visits complete; median visit 451 ms, p95 805 ms | Stopped after 53 starts, with 48 complete and five partial |
| Arrival replay cache outcomes | 6,699 HIT, one UPDATING, 100 DYNAMIC HTML requests | 3,179 HIT, 21 MISS, 203 DYNAMIC before stopping |

This is a short regression/capacity check, not a long-duration capacity guarantee. The arrival replay fetches resources but does not render them or load the third-party Bing image. Zero response-body bytes still entails HTTP headers and network/protocol traffic. Existing UI/mobile layout findings are outside this fix.

Evidence: `cache-verification-after.json`, `component-probes-after.json`, `load-poll500-after.json`, `load-arrivals-after.json`, and `cloudflare-cache-rule.jpg`. The original `REVIEW.md` and baseline captures remain historical evidence.

## What we know about the relay

- Sky → Mini still reports `DERP(lhr)` and no direct connection after three pings (~40 ms each in the follow-up check).
- Both ends report `UDP: true` and `MappingVariesByDestIP: false`. Mini has IPv4 connectivity but no working IPv6 in its netcheck.
- Sky's `tailscaled` listens on UDP 41641. Its INPUT chain calls `ts-input` **before** UFW, and `ts-input` explicitly accepts UDP 41641. The absence of this port in the friendly UFW listing is therefore not evidence that the host blocks it.
- The provider firewall configuration and home router policies have not been inspected. Working outbound STUN/UDP does not establish that inbound peer handshakes can traverse the whole path.
- Mini netcheck also logged `routerIP/FetchRIB: sysctl: cannot allocate memory` while otherwise completing successfully. Treat that as a diagnostic lead if direct connectivity remains elusive, not as proof of the cause.

## Proposed approaches

### A. Dedicated Cloudflare Tunnel on Mini — recommended for tab1.net

Route Cloudflare directly to a dedicated `cloudflared` connector on Mini, forwarding to `http://127.0.0.1:3060`. This removes Sky, its Caddy hop, and the Tailscale relay from tab1.net's request path while retaining the Cloudflare cache/WAF layer. Named tunnels can run as a macOS service at boot; see [Cloudflare's macOS service guide](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/as-a-service/macos/) and [routing documentation](https://developers.cloudflare.com/tunnel/concepts/routing/).

Proposed rollout:

1. Provision a **separate named tunnel** and boot-managed service for this app; do not attach Mini to the existing multi-service tunnel as an interchangeable connector.
2. Test localhost forwarding, application restarts, compressed/conditional responses and tunnel reconnection through a temporary hostname.
3. Change only tab1.net's tunnel route/DNS target. Retain the old Sky route for rollback; verify existing www/legacy redirects.
4. Repeat a 30–60 minute combined load test and public health monitoring, including a scheduled feed refresh. Verify service persistence at a suitable maintenance window.

Tradeoff: this removes unnecessary network dependencies but still depends on Mini's power, sleep settings and home broadband. It is a proposed change only; no tunnel has been created.

### B. Repair direct Sky–Mini Tailscale connectivity — best if other Mini services benefit too

Keep the current topology and diagnose direct peer connectivity. First inspect the **Hetzner/provider firewall** for inbound UDP 41641, then capture only handshake metadata on Sky while Mini attempts a connection. This distinguishes packets blocked before Sky from a host/client/NAT issue. Inspect Mini's macOS firewall/VPN coexistence and home-router NAT behaviour if the provider path is open. Do not add redundant UFW rules or disable firewalls broadly.

Tailscale specifically documents enabling UDP 41641 at the cloud perimeter for Hetzner direct connectivity: [official Hetzner guidance](https://tailscale.com/docs/install/cloud/hetzner). Any necessary firewall change should be narrowly scoped, verified by sustained `direct` status, and tested for fallback after inactivity/reconnects.

Tradeoff: potentially a small change with benefits across several services, but it retains the cross-host hop and depends on the network maintaining a direct path. Root cause is not yet established, so completion effort is uncertain.

### C. Move the app to a dedicated cloud host — strongest longer-term availability option

Run Node and its tunnel/proxy on the same adequately sized host, with service supervision and warm-cache/readiness handling. The app has no per-user server database to migrate; settings remain in each browser. Test `sharp` on the target architecture, outbound feed access, cache warming, restart behaviour and monitoring before switching the hostname.

Tradeoff: recurring hosting/operations cost, but removes home power/broadband availability from the public service. Avoid adding it to the already-busy Sky without checking or increasing headroom. A separate modest host is easier to reason about for capacity than sharing an overloaded one. No particular paid plan or spend is proposed here.

### D. A controlled Tailscale peer relay — fallback for the wider network

A peer relay can provide an owned, higher-throughput path if direct connections are impossible; see [Tailscale Peer Relays](https://tailscale.com/docs/features/peer-relay). It adds another service, configuration and network hop, so it is less attractive than A for this one application. Consider it if many services need the same solution and the existing topology must remain.

**Recommendation:** choose A for tab1.net; investigate B separately if improving the wider Mini/Sky setup is valuable. Choose C when availability requirements justify moving away from home hosting. The caching fixes have already made the short combined workload pass, so there is room to choose and validate the next network change deliberately.

## Rollback record

The previous production `server.js` and `lib/sources.js` are backed up on Mini in `/tmp/tab1-cache-fix.xyCubo/` (temporary storage). The deployed source hashes were verified against the checkout. To undo the app deployment, restore those two files and restart `com.tab1.net.web`; the new unused helper can be removed afterwards. The Cloudflare rule can independently be disabled in the tab1.net zone. Do not roll the concurrency fix back while leaving edge caching enabled without considering cold-source response caching.

No changes were committed to Git automatically.
