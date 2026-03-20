# Multi-Display Sync — Video Wall Guide (v0.7.2)

## Overview

Xibo Player supports synchronized multi-display playback for video walls. Multiple screens switch layouts simultaneously, play videos in lockstep, and cascade transitions with choreography effects — all coordinated over LAN with <8ms precision.

## Architecture

```
┌─────────────────────────────────────────────────┐
│                     CMS                          │
│  Sync Group: assigns lead + followers            │
│  Returns: syncConfig per display on register     │
└──────────┬──────────────────────┬────────────────┘
           │                      │
    syncGroup:"lead"      syncGroup:"192.168.1.10"
    isLead:true           isLead:false
           │                      │
    ┌──────▼──────┐       ┌───────▼───────┐
    │    LEAD     │◄──ws──│   FOLLOWER    │
    │  port 8765  │       │  port 8766    │
    │  0.0.0.0    │       │  localhost    │
    │             │       └───────────────┘
    │  WebSocket  │       ┌───────────────┐
    │  Relay      │◄──ws──│   FOLLOWER    │
    │  /sync      │       │  port 8767    │
    │             │       └───────────────┘
    │  Token auth │       ┌───────────────┐
    │  (cmsKey)   │◄──ws──│   FOLLOWER    │
    └─────────────┘       │  port 8768    │
                          └───────────────┘
```

### Components

- **SyncManager** (`@xiboplayer/sync`) — lead/follower protocol, heartbeat, readiness tracking
- **WebSocketTransport** — cross-device relay over LAN
- **BroadcastChannelTransport** — same-machine multi-tab sync (fallback)
- **SyncRelay** (`@xiboplayer/proxy`) — WebSocket server attached to the lead's proxy, handles token auth and group isolation
- **Choreography** — computes stagger delays per display based on grid position

## Auto-Discovery (v0.7.1)

Starting in v0.7.1, followers discover the lead automatically via mDNS — no manual IP configuration needed.

### How it works

1. **Lead advertises** — when the proxy server starts with `isLead: true`, it publishes an mDNS service:
   - Service type: `_xibo-sync._tcp`
   - Service name: `xibo-sync-{syncGroupId}`
   - TXT record: `{ syncGroupId, displayId }`
   - Port: the server's HTTP port (same port as the WebSocket relay)

2. **Follower discovers** — on each collection cycle, the PWA calls `GET /system/discover-lead?syncGroupId=X`. The proxy server browses for `_xibo-sync._tcp`, matches the syncGroupId in the TXT record, and returns `{ host, port }`.

3. **Fallback** — if mDNS discovery times out (10s), the follower falls back to the CMS-provided IP (existing behavior). The feature is purely additive.

### LAN IP Detection

The `GET /system/lan-ip` endpoint returns the machine's first non-internal, non-Docker IPv4 address. This enables:
- **Chromium kiosk** to report its LAN IP to the CMS (previously only Electron could do this)
- **Lead IP reporting** via `notifyStatus()` works on all platforms

### Network Requirements

- mDNS uses UDP multicast on port 5353
- All players must be on the same subnet for mDNS to work
- If players are on different VLANs, mDNS won't work — use the CMS IP fallback
- No firewall changes needed for the players themselves (mDNS is outbound-only)

### Sync Protocol

1. **Lead's layout timer expires** → `advanceToNextLayout`
2. **Lead broadcasts `layout-change`** with layout ID and show timestamp
3. **Followers preload the layout** (hidden DOM in pool)
4. **Followers report `ready`** to lead
5. **Lead waits for all followers** (or 10s timeout)
6. **Lead broadcasts `layout-show`** with future timestamp (now + switchDelay)
7. **All displays show at the exact timestamp** — choreography stagger applied per position

## Setup — Step by Step

This guide walks through setting up a 2x2 video wall from scratch: 4 displays running Electron or Chromium kiosk, all synchronized with choreography effects.

### Step 1: Install and register each display

On each machine (or instance), install the player and start it:

```bash
# Electron
electron . --instance=lead       # Lead display
electron . --instance=f1         # Follower 1
electron . --instance=f2         # Follower 2
electron . --instance=f3         # Follower 3

# Chromium kiosk
launch-kiosk.sh --instance=lead  # Lead display
launch-kiosk.sh --instance=f1    # Follower 1
launch-kiosk.sh --instance=f2    # Follower 2
launch-kiosk.sh --instance=f3    # Follower 3
```

Each player shows a **setup screen** on first run. Enter the CMS URL, CMS key, and a display name (e.g. "Wall Lead", "Wall F1", etc.). Click **Connect**.

Each display will register with the CMS and appear in **Displays** as "Waiting for approval".

### Step 2: Authorize displays in the CMS

1. Go to **Displays** in the CMS web UI
2. Find each newly registered display
3. Click **Edit** → check **Authorise display** → Save
4. Verify each display shows a green status indicator

After authorization, each player starts collecting content and playing the default layout.

### Step 3: Create a Sync Group

1. Go to **Displays → Sync Groups** in the CMS
2. Click **Add Sync Group**
3. Name it (e.g. "Video Wall 1")
4. Set **Publisher Port** — this must match the lead's server port (e.g. `8765` for Electron, `8766` for Chromium)
5. Set **Switch Delay** (default: 750ms — time for followers to preload before showing)
6. Save

### Step 4: Add displays to the Sync Group

1. Go to **Displays → Sync Groups → [your group] → Members**
2. Add all 4 displays to the group
3. Set one display as **Lead** (the others are automatically Followers)
4. Save

After saving, on the next collection cycle (~60s), each display receives its sync configuration from the CMS:
- The lead gets `isLead: true` and starts the WebSocket relay + mDNS advertisement
- Followers get `isLead: false` and discover the lead via mDNS automatically (v0.7.1+)

### Step 5: Create and schedule content

1. Go to **Design → Layouts** and create a layout for the wall
2. Go to **Schedule** → **Add Event**
3. Set **Event Type** to **Synchronised Event** (not a regular layout event)
4. Select the layout
5. Assign to the **Display Group** that matches your sync group
6. Set the date/time range
7. Save

The "Synchronised Event" type is critical — regular layout events don't trigger the sync protocol. Only synchronised events broadcast `layout-change` to followers.

### Step 6: Verify sync is working

After the next collection cycle, all 4 displays should show the same layout and switch simultaneously. Check the status bar (press `D` to toggle debug overlay):

```
Lead:     Sync: LEAD (group 3)
Follower: Sync: FOLLOWER → 192.168.1.10:8765 (group 3)
```

### Optional: Local choreography config

Choreography effects are configured **locally** per display (not in the CMS). Add to each display's `config.json`:

**Lead** (`~/.config/xiboplayer/electron-lead/config.json`):
```json
{
  "sync": {
    "topology": { "x": 0, "y": 0 },
    "choreography": "diagonal-tl",
    "staggerMs": 200,
    "gridCols": 2,
    "gridRows": 2
  }
}
```

**Follower 1** (top-right):
```json
{
  "sync": {
    "topology": { "x": 1, "y": 0 }
  }
}
```

**Follower 2** (bottom-left):
```json
{
  "sync": {
    "topology": { "x": 0, "y": 1 }
  }
}
```

**Follower 3** (bottom-right):
```json
{
  "sync": {
    "topology": { "x": 1, "y": 1 }
  }
}
```

Only the lead needs `choreography`, `staggerMs`, `gridCols`, and `gridRows` — followers only need their `topology` (grid position). The CMS provides `isLead`, `syncGroupId`, `syncPublisherPort`, and other sync parameters automatically.

### Note: No IP configuration needed (v0.7.1+)

In v0.7.1+, the lead advertises its relay via mDNS (`_xibo-sync._tcp`) and followers discover it automatically. You do **not** need to:
- Set the lead's LAN IP in CMS display settings
- Configure `listenAddress` in config.json (the lead binds to `0.0.0.0` automatically)
- Worry about DHCP changing the lead's IP

The CMS-provided IP is used only as a fallback if mDNS discovery fails (e.g., players on different subnets).

### Shared content cache (v0.7.2+)

When running multiple instances on the same machine (e.g. 4-display video wall for testing), all instances share a single content cache at:

```
~/.local/share/xiboplayer/shared/cache/{cmsId}/media/
```

A 1GB video is downloaded once and shared across all instances. Browser data (localStorage, IndexedDB, Service Worker) remains instance-specific.

On upgrade from v0.7.1, existing per-instance caches are automatically migrated to the shared path via hardlinks (instant, zero-copy).

## How config.json gets populated

You don't need to manually write `sync` settings in `config.json`. Here's how the config flows from CMS to player:

### Initial setup (Steps 1-2)

When you first run the player, you enter the CMS URL, CMS key, and display name in the setup screen. The player saves this to `config.json`:

```json
{
  "cmsUrl": "https://displays.example.com",
  "cmsKey": "yourKey",
  "displayName": "Wall Lead"
}
```

### After CMS registration (Step 2)

The player registers with the CMS via `RegisterDisplay`. The CMS returns settings including the hardware key. The player generates and stores its hardware key in the browser's localStorage/IndexedDB (not in config.json).

### After sync group assignment (Steps 3-4)

Once you assign the display to a sync group in the CMS, the next `RegisterDisplay` response includes `syncConfig`:

```json
{
  "syncGroup": "lead",           // "lead" for lead, lead's IP for followers
  "syncGroupId": 3,              // Numeric group ID (same for all members)
  "syncPublisherPort": 8765,     // WebSocket relay port
  "syncSwitchDelay": 750,        // ms to wait before showing layout
  "syncVideoPauseDelay": 100,    // ms before unpausing video
  "isLead": true                 // true for lead, false for followers
}
```

The PWA processes this config and persists it to `config.json` so sync works on offline restarts:

```json
{
  "cmsUrl": "https://displays.example.com",
  "cmsKey": "yourKey",
  "displayName": "Wall Lead",
  "serverPort": 8765,
  "sync": {
    "syncGroup": "3",
    "syncGroupId": 3,
    "syncPublisherPort": 8765,
    "syncSwitchDelay": 750,
    "syncVideoPauseDelay": 100,
    "isLead": true,
    "relayUrl": "ws://localhost:8765/sync"
  }
}
```

The `relayUrl` is built automatically:
- **Lead**: `ws://localhost:<port>/sync` (connects to its own relay)
- **Follower**: discovered via mDNS → `ws://<lead-ip>:<port>/sync`

### Local-only fields

The following fields are **not** provided by the CMS — they are local configuration for choreography effects. You only need these if you want choreography stagger:

| Field | Description | Set by |
|-------|-------------|--------|
| `sync.topology` | Grid position `{ x, y, orientation }` | Local config |
| `sync.choreography` | Effect name (e.g. `diagonal-tl`) | Local config |
| `sync.staggerMs` | Delay between displays in ms | Local config |
| `sync.gridCols` | Grid width (e.g. `2`) | Local config |
| `sync.gridRows` | Grid height (e.g. `2`) | Local config |

Without these fields, all displays switch simultaneously (no stagger).

## Display Modes

### Mirror Mode
All displays play the **same layout**. Schedule a single layout to the sync group — every display shows identical content, switching in unison.

### Wall Mode
Each display plays a **different layout** for its grid position. The CMS assigns position-specific layouts via `layoutMap`. The lead drives timing, followers map the lead's layout ID to their own.

## Choreography Effects

Choreography controls the cascade pattern when displays switch layouts. The `staggerMs` value determines the delay between consecutive displays.

### 2×2 Grid Example (staggerMs: 200)

```
diagonal-tl:          wave-right:           center-out:
┌──────┬──────┐      ┌──────┬──────┐      ┌──────┬──────┐
│ 0ms  │200ms │      │ 0ms  │200ms │      │200ms │200ms │
├──────┼──────┤      ├──────┼──────┤      ├──────┼──────┤
│200ms │400ms │      │ 0ms  │200ms │      │200ms │200ms │
└──────┴──────┘      └──────┴──────┘      └──────┴──────┘

wave-down:            diagonal-br:          simultaneous:
┌──────┬──────┐      ┌──────┬──────┐      ┌──────┬──────┐
│ 0ms  │ 0ms  │      │400ms │200ms │      │ 0ms  │ 0ms  │
├──────┼──────┤      ├──────┼──────┤      ├──────┼──────┤
│200ms │200ms │      │200ms │ 0ms  │      │ 0ms  │ 0ms  │
└──────┴──────┘      └──────┴──────┘      └──────┴──────┘
```

## Comparison with Xibo Native Sync

| Feature | Xibo Native (Windows) | Xibo Player (PWA) |
|---------|----------------------|-------------------|
| **Platform** | Windows only | Any (Electron, Chromium, Android, webOS) |
| **Transport** | ZeroMQ (TCP) | WebSocket (HTTP upgrade) |
| **Sync precision** | ~50-100ms | <8ms |
| **Choreography effects** | None | 12 effects (diagonal, wave, center-out, etc.) |
| **Firewall friendly** | ZeroMQ ports needed | Uses existing HTTP port |
| **Auth** | None | Token auth (shared CMS key) |
| **Offline LAN sync** | No | Yes (persisted config) |
| **Stats delegation** | No | Followers delegate through lead |
| **Multiple sync groups** | Yes | Yes (syncGroupId isolation) |
| **Setup** | CMS + manual IP config | CMS only (mDNS auto-discovery) |
| **IP configuration** | Manual | Zero-config (mDNS) |
| **DHCP support** | Requires static IPs | Automatic re-discovery |

## Troubleshooting

### Followers can't connect to relay
- Check lead binds to `0.0.0.0` (not localhost) — needs `sync.isLead: true` in config
- Check lead's LAN IP is set in CMS display settings
- Check firewall allows WebSocket connections on the publisher port
- Verify `ss -tlnp | grep 8765` shows `0.0.0.0` on the lead

### mDNS discovery not working
- Verify lead and followers are on the same subnet
- Check lead logs for `mDNS: advertising sync group X on port Y`
- Test discovery: `curl http://localhost:<follower-port>/system/discover-lead?syncGroupId=X`
- If mDNS fails, the CMS-provided IP is used as fallback — check CMS display settings
- UDP port 5353 must not be blocked between players

### Displays in different relay groups
- All displays must be in the same CMS sync group
- Check `syncGroupId` matches across all displays
- The relay group name is `String(syncGroupId)` — verify in relay logs

### Layout not syncing
- Check layout has `syncEvent: true` in schedule (CMS Synchronised Event type)
- The schedule must be a "Synchronised Event" not a regular layout event
- Check `isSyncEvent` in player logs

### Stagger not visible
- Verify `topology`, `choreography`, `staggerMs`, `gridCols`, `gridRows` in config
- These are local-only fields — not provided by CMS
- Increase `staggerMs` to 500+ for visible testing

### Status bar shows wrong role
- Press `S` to open setup, verify CMS sync group membership
- Check `Sync: LEAD (group X)` or `Sync: FOLLOWER → IP:port (group X)` in status bar
