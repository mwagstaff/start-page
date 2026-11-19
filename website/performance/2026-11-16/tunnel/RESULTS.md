# Direct Mini tunnel rollout — 16 November 2026

## Deployment

Production tab1.net now uses the dedicated `tab1-mini` Cloudflare Tunnel to
Mini's `127.0.0.1:3060`. Root DNS was changed after the diagnostic hostname
passed checks. Sky, Caddy and the Tailscale relay are removed from new origin
requests for the root site. Existing Cloudflare cache entries remain valid;
some retain historical `Via: 1.1 Caddy` headers until expiry.

`www.tab1.net` was pinned directly to the old Sky tunnel to preserve its redirect;
it previously aliased the root hostname. The legacy start.skynolimit.dev redirect
is unchanged. Both return 308 with the original path/query intact.

The old Sky root ingress is retained for manual DNS rollback. No router, provider
firewall or Tailscale configuration was changed. No changes to other applications'
ingress rules were made.

## Supervision

- Updated cloudflared from 2026.2.0 to 2026.11.0 using Homebrew's official formula.
- Installed `com.tab1.net.tunnel` as a boot LaunchDaemon after the owner completed
  Mini's sudo authentication. Verified `state = running`, `domain = system`,
  `username = mwagstaff`, `KeepAlive` and `RunAtLoad`.
- Removed the temporary login service; one connector process serves this tunnel.
- Readiness returns 200 and four connected edge sessions. The earlier supervised
  connector restart after upgrading cloudflared also reconnected successfully.
- Token stored outside the repository with mode 600; the laptop's temporary token
  copy was removed. Metrics listen only on 127.0.0.1:20246.
- No host reboot performed. The Node app remains its existing login LaunchAgent;
  full reboot recovery is not established by verifying the tunnel daemon alone.

## Functional checks

`preview-checks.json` and `production-checks.json` record the checks:

- HTML and health: 200, gzip, DYNAMIC.
- Shared feed snapshot and catalogue: HIT, correct ETag, 304 with zero body.
- Source API: correctly revalidates an expired entry, then 304 with zero body.
- Invalid source: 400, no-store, BYPASS.
- Both www and legacy redirects: 308 preserving path and query.

The diagnostic hostname deliberately does not match the production API cache
rule. It verified gzip and origin conditional requests without edge cache hits.
The first local DNS lookup was negatively cached before the new record existed;
1.1.1.1 resolved it, and the preview checks used that verified edge IP with curl's
`--resolve`, retaining normal HTTPS hostname/certificate verification.

## Load validation

**Passed:** the 30-minute polling workload equivalent to 500 active readers
(each reading two shared endpoints every minute), with four bounded first-party
page-arrival waves and an additional mixed-traffic ramp/HTML burst. Across these
scenarios, **60,760 requests completed with zero errors**, plus ten successful
warm-up requests. No safety stops or skipped scheduled requests occurred.

| Scenario | Requests | Result |
| --- | ---: | --- |
| 500-reader equivalent, 30 minutes | 30,000 | p50 20 ms, p95 83 ms, p99 151 ms, max 428 ms |
| Four arrival waves, 400 visits × 68 URLs | 27,200 | All 200; aggregate visit p50 345 ms, p95 485 ms, max 625 ms |
| Mixed ramp: 5, 17, 35, then 60 requests/sec | 3,460 | All 200/304; top-rate p95 126 ms |
| 100 simultaneous uncached HTML requests | 100 | All 200; p95 1.79 seconds, whole burst 1.80 seconds |

Polling returned 29,993 zero-body 304s and seven 200s as content changed. Edge
outcomes were 29,941 HIT and 59 UPDATING. Total polling response-body transfer was
129,889 bytes over the half hour, excluding HTTP/TLS overhead. This verifies
conditional caching across expiries and content changes, not merely a static
warm-cache run.

All 61 public health samples returned 200. `lastRefresh` advanced from 10:45:28
to 10:55:28 and 11:05:28 UTC, covering two subsequent scheduled refreshes during
the run. Arrival waves at 10:55 and 11:05 overlapped those refreshes.
A final post-test health check also confirmed the next refresh completed at
11:15:37 UTC (`final-health.json`).

The first arrival wave completed 100 visits × 68 URLs = 6,800 successful requests
in 49.84 seconds. Visit p50 was 336 ms and p95 was 383 ms. The earlier post-cache-fix
run through Sky had p95 805 ms. This is a comparison of two runs from the same
client, not a controlled attribution of every millisecond to the tunnel.

Across all four waves, visit p95 ranged from 383 to 520 ms. The simultaneous HTML
burst is a more demanding origin workload and approached the two-second guardrail;
do not extrapolate its successful result to an unlimited simultaneous-user count.

### Resource observations

The final boot connector metrics reported four active connections, zero
origin-proxy errors and 1,237 proxied requests since that connector started.
Most test traffic was handled by Cloudflare's edge cache. This counter also includes
health/diagnostic traffic and is not an exact cache-hit-ratio denominator.

Minute samples showed Node RSS between 119 and 272 MiB, ending at 203 MiB;
cloudflared RSS was 46–55 MiB. CPU samples peaked at 51.4% for Node and 57.4% for
cloudflared during the mixed ramp, then returned near idle. These are sampled
process figures, not exhaustive peaks or percentages of the whole eight-core host.
Node RSS increased around refreshes and fell afterwards; a longer run across many
refresh cycles is still needed to establish long-term memory behaviour.

Arrival replay fetches resources but does not render pages or fetch the third-party
Bing backdrop. Shared polling is not 500 simultaneous uncached requests. Safety
stops remain in place. These tests do not establish a universal user limit or
home-broadband/power availability.

## Operations and evidence

See [the runbook](../../../infrastructure/MINI-TUNNEL.md) for exact DNS targets,
service paths, health commands and rollback.

- `boot-service.txt`: installed service and readiness evidence.
- `cloudflare-dns.jpg`: saved dashboard screenshot of the new root and preserved www target.
- `metrics-before.txt`, `metrics-boot-start.txt`, `metrics-after-burst.txt`, `metrics-final.txt`: connector snapshots.
- `origin-samples.jsonl`: minute process/readiness samples.
- `summary.json`: aggregate counts, timings, health and resource observations.
- `health-soak.jsonl`: public health sampling every 30 seconds.
- `load-soak500-30m.json`: final polling measurements.
- `load-arrivals-*.json`: page-arrival waves.
- `load-mixed-burst.json`: mixed ramp and simultaneous HTML burst.

The diagnostic hostname is retained for operational checks. No automatic failover
or new alert policy was added. Mini's power, login/startup behaviour and home
broadband remain availability dependencies.
