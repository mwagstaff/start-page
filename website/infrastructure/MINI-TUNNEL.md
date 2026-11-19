# Dedicated Mini tunnel

## Production route

Configured 16 November 2026:

```text
Browser → Cloudflare cache/WAF → tab1-mini connector on Mini → 127.0.0.1:3060
```

- Cloudflare account: `e40a4c949b9f4703430256d38ea7f2e3`.
- Tunnel: `tab1-mini`, ID `cf93fcc3-1344-4d11-8b13-60754bd861d5`.
- Published application: `tab1.net`, all paths, service `http://127.0.0.1:3060`.
- Root DNS: proxied CNAME to `cf93fcc3-1344-4d11-8b13-60754bd861d5.cfargotunnel.com`, TTL Auto.
- Diagnostic hostname: `tunnel-check.tab1.net`, same tunnel/origin, retained for direct-origin checks. It serves the same public application. The shared API cache rule is deliberately scoped to `tab1.net`, so diagnostic API requests reach the origin.
- `www.tab1.net`: proxied CNAME directly to `dc9d6982-2296-4427-ac54-1e654c5b8941.cfargotunnel.com`, TTL Auto. Previously this aliased `tab1.net`; retaining that alias would send www traffic to the new tunnel without its Sky redirect.
- `start.skynolimit.dev`: unchanged on Sky.
- Existing cache rule `tab1.net: cache shared feed APIs (origin TTL)` remains in effect.
- Sky's shared tunnel and Caddy ingress are retained. Its setup script does not write DNS, so rerunning it does not overwrite this cutover.

No inbound firewall ports or Tailscale settings were changed. The connector uses outbound QUIC connections to Cloudflare; its readiness/metrics listener is loopback-only.

## Connector lifecycle

Homebrew cloudflared was upgraded from 2026.2.0 to 2026.11.0. Binary:
`/opt/homebrew/bin/cloudflared`. The dedicated service label is
`com.tab1.net.tunnel`, separate from the application's `com.tab1.net.web`.

Token: `/Users/mwagstaff/.cloudflared/tab1-mini/token`, mode 600, inside a mode-700
directory. Never commit the token or place it in process arguments. The temporary
copy on the deployment laptop was removed after transfer.

The installer at `infrastructure/install-mini-tunnel.py` is also copied to Mini at
`/Users/mwagstaff/.cloudflared/tab1-mini/install-mini-tunnel.py`.

It supports two modes:

```sh
# Login service, matching the current app's GUI session; no sudo needed.
python3 /Users/mwagstaff/.cloudflared/tab1-mini/install-mini-tunnel.py --user

# Boot service: run on Mini with administrator authentication.
# Removes only this connector's login service, then installs its LaunchDaemon.
sudo python3 /Users/mwagstaff/.cloudflared/tab1-mini/install-mini-tunnel.py
```

Both modes use RunAtLoad, KeepAlive and a five-second restart throttle. The boot
service runs the connector as `mwagstaff`, not root. The installer does not modify
the Node application's launch configuration. The app itself currently remains a
login LaunchAgent, so a cold boot still needs its existing login/startup workflow.
Do not claim full unattended reboot recovery without testing that workflow.

Current installation status and load-test results are recorded in
`performance/2026-11-16/tunnel/RESULTS.md`.

Logs: `/Users/mwagstaff/Library/Logs/tab1-mini-tunnel/{stdout,stderr}.log`.
Launchd redirects output to these files; they are not automatically rotated by
this installer. Check size during routine maintenance. After upgrading the binary,
restart only this service so it uses the new version.

## Checks

From a remote machine use `ssh -J sky mini` if the direct laptop→Mini route fails.

```sh
# On Mini
curl -fsS http://127.0.0.1:20246/ready
curl -fsS http://127.0.0.1:20246/metrics
curl -fsS http://127.0.0.1:3060/healthcheck
launchctl print gui/501/com.tab1.net.tunnel  # login mode
launchctl print system/com.tab1.net.tunnel   # boot mode

# Public: should return 200 with status ok and an advancing lastRefresh.
curl -fsS https://tab1.net/healthcheck
# Both redirects should return 308, preserving path and query.
curl -sSI 'https://www.tab1.net/test?check=1'
curl -sSI 'https://start.skynolimit.dev/test?check=1'
```

Tunnel Healthy means Cloudflare can reach the connector, not necessarily that
Node is serving correctly. Check both connector readiness and public app health.
No automated alert policy or broader server-tooling monitoring deployment was
added in this rollout.

## Rollback

Change **only the root tab1.net CNAME target** in the Cloudflare DNS dashboard to
`dc9d6982-2296-4427-ac54-1e654c5b8941.cfargotunnel.com`; keep it proxied, TTL Auto.
Sky retains the root ingress and Caddy proxy to Mini:3060 over Tailscale.
Verify public HTML, health and shared APIs. `www` can remain pinned to Sky.

The original DNS values were:

| Name | Type | Target | Proxy / TTL |
| --- | --- | --- | --- |
| tab1.net | CNAME | dc9d6982-2296-4427-ac54-1e654c5b8941.cfargotunnel.com | Proxied / Auto |
| www.tab1.net | CNAME | tab1.net | Proxied / Auto |

This is a manual rollback path, not automatic failover. Both paths still require
Mini and its home broadband to work. Do not add Sky as a replica of tab1-mini:
`127.0.0.1:3060` refers to a different machine there.
