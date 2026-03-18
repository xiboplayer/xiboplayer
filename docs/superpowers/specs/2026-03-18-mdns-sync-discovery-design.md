# mDNS Sync Discovery — Design Spec

**Date:** 2026-03-18
**Status:** Approved
**Author:** Pau Aliagas

## Problem

Sync followers need the lead's LAN IP to connect via WebSocket. Currently:

1. **Lead self-detection fails in Chromium** — `discoverLanIp()` returns `''` because `electronAPI.getLanIpAddress()` is Electron-only. The CMS never receives the lead's IP.
2. **Followers depend on CMS as IP middleman** — even when the lead reports its IP, the CMS must relay it to followers via `syncConfig.syncGroup`. If the IP is stale or missing, sync breaks.

## Solution

Two complementary fixes:

1. **`GET /system/lan-ip`** — proxy endpoint exposing `os.networkInterfaces()` so any player (Electron or Chromium) can discover its own LAN IP.
2. **mDNS service discovery** — lead advertises a `_xibo-sync._tcp` service via `bonjour-service`. Followers browse for it, filtering by `syncGroupId` from CMS config. Zero-config, no CMS IP relay needed.

CMS remains the source of truth for group membership and topology. mDNS handles only network plumbing.

## Discovery Protocol

### Lead advertises

On startup, when the proxy server starts with `isLead: true` and a `syncGroupId`:

```
Service type:  _xibo-sync._tcp
Service name:  xibo-sync-{syncGroupId}
Port:          9590 (syncPublisherPort)
TXT record:    { syncGroupId: "42", displayId: "pwa-abc123" }
```

### Follower discovers

Follower browses for `_xibo-sync._tcp`, filters by matching `syncGroupId` in the TXT record, extracts the lead's IP + port from the mDNS response.

### Fallback

If mDNS discovery times out (10s), fall back to the CMS-provided `syncGroup` IP (existing behavior). The feature is purely additive.

## Architecture

### New module: `packages/proxy/src/discovery.js`

Two exported functions:

- **`advertiseSyncService({ port, syncGroupId, displayId })`** — creates a Bonjour service advertisement. Returns `{ stop() }` handle for cleanup.
- **`discoverSyncLead({ syncGroupId, timeout })`** — browses for `_xibo-sync._tcp`, filters by syncGroupId in TXT record. Returns `Promise<{ host, port } | null>`. Stops browsing once found or after timeout.

### New endpoint: `GET /system/lan-ip`

In `proxy.js`. Returns `{ ip: "192.168.1.10" }` using `os.networkInterfaces()` — picks the first non-internal IPv4 address, skipping Docker/VPN interfaces (bridge, veth, docker, br-).

### New endpoint: `GET /system/discover-lead`

In `proxy.js`. Query param: `syncGroupId`. Runs `discoverSyncLead()` server-side and returns `{ host, port }` or `404` on timeout. The PWA (browser) can't do mDNS directly, so discovery runs in Node.js and is exposed via HTTP.

### Integration points

| Where | What happens |
|-------|-------------|
| `proxy.js` `startServer()` | If `syncGroupId` + `isLead` → call `advertiseSyncService()` |
| `proxy.js` | Add `GET /system/lan-ip` route |
| `proxy.js` | Add `GET /system/discover-lead` route |
| `player-core.js` `discoverLanIp()` | Fall back to `fetch('/system/lan-ip')` when `electronAPI` unavailable |
| `pwa/main.ts` sync-config handler | If follower has no `relayUrl` → call `/system/discover-lead?syncGroupId=42` before falling back to CMS IP |

## Flows

### Lead startup

```
CMS RegisterDisplay → syncConfig { isLead: true, syncGroupId: 42 }
    |
proxy startServer() sees isLead + syncGroupId
    |
advertiseSyncService({ port: 9590, syncGroupId: 42, displayId: "lead-abc" })
    |
mDNS announces: _xibo-sync._tcp "xibo-sync-42" on port 9590
    |
GET /system/lan-ip → "192.168.1.10"
    |
notifyStatus({ lanIpAddress: "192.168.1.10" }) → CMS stores IP
```

### Follower startup

```
CMS RegisterDisplay → syncConfig { isLead: false, syncGroupId: 42 }
    |
PWA has syncGroupId but no relayUrl
    |
fetch('/system/discover-lead?syncGroupId=42')
    |
proxy runs discoverSyncLead({ syncGroupId: 42, timeout: 10000 })
    |
mDNS browse _xibo-sync._tcp → finds "xibo-sync-42" at 192.168.1.10:9590
    |
Returns { host: "192.168.1.10", port: 9590 }
    |
PWA builds relayUrl = ws://192.168.1.10:9590/sync
    |
SyncManager connects via WebSocket
```

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Lead not yet started | Follower mDNS browse times out (10s) → falls back to CMS IP |
| Lead IP changes (DHCP) | Lead re-advertises on reconnect; follower re-discovers on next collection cycle |
| Multiple sync groups on same LAN | Each group has unique syncGroupId in TXT record — followers filter by their own group |
| mDNS not working (firewall, Docker) | Timeout → graceful fallback to CMS-provided IP. No regression. |
| Lead shuts down | Bonjour `stop()` called → service de-advertised. Followers reconnect loop → re-discover |
| Multiple network interfaces | `GET /system/lan-ip` picks first non-internal, non-Docker IPv4 |

### Retry strategy

On WebSocket disconnect, before reconnecting, re-run mDNS discovery (the IP may have changed). Cap at one discovery per 30s to avoid mDNS spam.

## Dependencies

- `bonjour-service` added to `@xiboplayer/proxy` only (pure JS, zero native deps, ~30KB)

## Files

### Create
- `packages/proxy/src/discovery.js` — advertise + discover functions

### Modify
- `packages/proxy/src/proxy.js` — two new routes + advertise on lead startup
- `packages/proxy/package.json` — add `bonjour-service` dependency
- `packages/core/src/player-core.js` — `discoverLanIp()` fallback to `/system/lan-ip`
- `packages/pwa/src/main.ts` — sync-config handler calls discover endpoint before building relayUrl

## Testing

| Test | Type | What it verifies |
|------|------|-----------------|
| `discovery.test.js` — advertise and discover | Unit | `advertiseSyncService` publishes, `discoverSyncLead` finds it, returns correct host/port |
| `discovery.test.js` — group filtering | Unit | Two services with different syncGroupIds, follower only finds its own |
| `discovery.test.js` — timeout | Unit | No service advertised → returns null after timeout |
| `discovery.test.js` — stop cleanup | Unit | Calling `stop()` de-advertises the service |
| `proxy.test.js` — `GET /system/lan-ip` | Unit | Returns valid IPv4, skips internal/Docker interfaces |
| `proxy.test.js` — `GET /system/discover-lead` | Integration | Starts advertiser, hits endpoint, gets host/port back |
| `player-core.test.js` — `discoverLanIp` fallback | Unit | When no `electronAPI`, falls back to `/system/lan-ip` fetch |
