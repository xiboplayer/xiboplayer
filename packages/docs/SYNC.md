# Multi-Display Sync — Video Wall Guide (v0.7.0)

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

### Sync Protocol

1. **Lead's layout timer expires** → `advanceToNextLayout`
2. **Lead broadcasts `layout-change`** with layout ID and show timestamp
3. **Followers preload the layout** (hidden DOM in pool)
4. **Followers report `ready`** to lead
5. **Lead waits for all followers** (or 10s timeout)
6. **Lead broadcasts `layout-show`** with future timestamp (now + switchDelay)
7. **All displays show at the exact timestamp** — choreography stagger applied per position

## Setup

### 1. CMS Configuration

1. Create a **Sync Group** in the CMS (Displays → Sync Groups)
2. Set the **lead display** and add followers
3. Configure **publisher port** (default: 8765) and **switch delay** (default: 750ms)
4. Schedule content to the sync group's display group

### 2. Lead Display Config

The lead's `config.json` needs `sync.isLead: true` so the server binds to `0.0.0.0`:

```json
{
  "cmsUrl": "https://cms.example.com",
  "cmsKey": "yourKey",
  "displayName": "wall-lead",
  "sync": {
    "isLead": true,
    "topology": { "x": 0, "y": 0, "orientation": 0 },
    "choreography": "diagonal-tl",
    "staggerMs": 200,
    "gridCols": 2,
    "gridRows": 2
  }
}
```

### 3. Follower Display Config

Followers only need their grid position — the CMS provides the rest:

```json
{
  "cmsUrl": "https://cms.example.com",
  "cmsKey": "yourKey",
  "displayName": "wall-follower-1",
  "sync": {
    "topology": { "x": 1, "y": 0, "orientation": 0 },
    "choreography": "diagonal-tl",
    "staggerMs": 200,
    "gridCols": 2,
    "gridRows": 2
  }
}
```

### 4. CMS Lead LAN IP

The CMS needs the lead display's LAN IP address to build follower relay URLs. The display reports this via `notifyStatus`. If the IP isn't detected automatically, set it in the CMS display settings.

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
| **Setup** | CMS only | CMS + local topology config |

## Troubleshooting

### Followers can't connect to relay
- Check lead binds to `0.0.0.0` (not localhost) — needs `sync.isLead: true` in config
- Check lead's LAN IP is set in CMS display settings
- Check firewall allows WebSocket connections on the publisher port
- Verify `ss -tlnp | grep 8765` shows `0.0.0.0` on the lead

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
