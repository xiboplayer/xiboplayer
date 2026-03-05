# @xiboplayer/sync

**Multi-display synchronization for Xibo video walls — same-machine and cross-device.**

## Overview

Coordinates layout transitions and video playback across multiple displays:

- **Same-machine sync** (Phase 2) — BroadcastChannel for multi-tab/multi-window setups on a single device
- **Cross-device sync** (Phase 3) — WebSocket relay for LAN video walls where each screen is a separate mini-PC

Both modes share the same sync protocol — only the transport layer differs.

### Capabilities

- **Synchronized layout transitions** — lead signals followers to change layout, waits for all to be ready, then sends a simultaneous "show" signal
- **Coordinated video start** — video playback begins at the same moment on all displays
- **Stats/logs delegation** — followers delegate proof-of-play stats and log submission through the lead, avoiding duplicate CMS traffic
- **Automatic follower discovery** — heartbeats every 5s, stale detection after 15s
- **Graceful degradation** — if a follower is unresponsive, the lead proceeds after a 10s timeout
- **Auto-reconnect** — WebSocket transport reconnects with exponential backoff (1s → 30s)

## Architecture

```
Same-machine (BroadcastChannel):       Cross-device (WebSocket relay):

  Tab 1 (Lead)    Tab 2 (Follower)      PC 1 (Lead)         PC 2 (Follower)
  ┌──────────┐    ┌──────────┐          ┌──────────┐        ┌──────────┐
  │SyncMgr   │    │SyncMgr   │          │SyncMgr   │        │SyncMgr   │
  │ └─BC     │◄──►│ └─BC     │          │ └─WS     │        │ └─WS     │
  └──────────┘    └──────────┘          └────┬─────┘        └────┬─────┘
       BroadcastChannel                      │                    │
                                             ▼                    │
                                      ┌────────────┐             │
                                      │Proxy :8765 │◄────────────┘
                                      │ └─SyncRelay│  (LAN WebSocket)
                                      └────────────┘
```

The relay is a dumb pipe — it broadcasts each message to all other connected clients. The sync protocol (heartbeats, ready-waits, layout changes) runs entirely in SyncManager.

## Installation

```bash
npm install @xiboplayer/sync
```

## Usage

### Same-machine sync (default)

No extra configuration needed. When multiple tabs/windows run on the same origin, BroadcastChannel handles message passing automatically.

```javascript
import { SyncManager } from '@xiboplayer/sync';

// Lead display
const lead = new SyncManager({
  displayId: 'screen-1',
  syncConfig: { isLead: true, syncGroup: 'lead', syncSwitchDelay: 750 },
  onLayoutShow: (layoutId) => renderer.show(layoutId),
});
lead.start();

// Request synchronized layout change (waits for followers)
await lead.requestLayoutChange('42');
```

```javascript
// Follower display (different tab)
const follower = new SyncManager({
  displayId: 'screen-2',
  syncConfig: { isLead: false, syncGroup: '192.168.1.100', syncSwitchDelay: 750 },
  onLayoutChange: async (layoutId) => {
    await renderer.prepareLayout(layoutId);
    follower.reportReady(layoutId);
  },
  onLayoutShow: (layoutId) => renderer.show(layoutId),
});
follower.start();
```

### Cross-device sync (LAN video wall)

When `syncGroup` is an IP address (not `"lead"`) and `syncPublisherPort` is set, the PWA automatically builds a WebSocket relay URL. The lead connects to its own proxy at `ws://localhost:<port>/sync`; followers connect to `ws://<lead-ip>:<port>/sync`.

**Lead config.json** (e.g. `~/.config/xiboplayer/electron/config.json`):

```json
{
  "cmsUrl": "https://cms.example.com",
  "cmsKey": "yourKey",
  "displayName": "videowall-lead",
  "listenAddress": "0.0.0.0"
}
```

The `listenAddress: "0.0.0.0"` makes the proxy reachable from the LAN. The CMS sync settings (`syncGroup`, `syncPublisherPort`) are sent via the RegisterDisplay response.

**CMS Display Settings:**

| Setting | Lead | Follower |
|---------|------|----------|
| Sync Group | `lead` | `192.168.1.100` (lead's IP) |
| Sync Publisher Port | `8765` | `8765` |

The SyncManager detects this configuration and selects the WebSocket transport:

```javascript
// This happens automatically in packages/pwa/src/main.ts:
if (syncConfig.syncPublisherPort && syncConfig.syncGroup !== 'lead') {
  const host = syncConfig.isLead ? 'localhost' : syncConfig.syncGroup;
  syncConfig.relayUrl = `ws://${host}:${syncConfig.syncPublisherPort}/sync`;
}
```

### Injecting a custom transport

For testing or custom setups, you can inject any object that implements the transport interface:

```javascript
const transport = {
  send(msg) { /* ... */ },
  onMessage(callback) { /* ... */ },
  close() { /* ... */ },
  get connected() { return true; },
};

const sync = new SyncManager({
  displayId: 'test-1',
  syncConfig: { isLead: true },
  transport,
});
sync.start();
```

## Transport Interface

Both `BroadcastChannelTransport` and `WebSocketTransport` implement:

```typescript
interface SyncTransport {
  send(msg: any): void;           // Send message to peers
  onMessage(cb: (msg) => void);   // Register message handler
  close(): void;                   // Clean up resources
  readonly connected: boolean;     // Connection status
}
```

## Sync Protocol

```
Lead                              Follower(s)
────                              ──────────
heartbeat (every 5s)            → discovers peers
layout-change(layoutId, showAt) → loads layout, prepares DOM
                                ← layout-ready(layoutId, displayId)
(waits for all or timeout 10s)
layout-show(layoutId)           → shows layout simultaneously
video-start(layoutId, regionId) → unpauses video
stats-report / logs-report      ← delegates stats to lead
stats-ack / logs-ack            → confirms submission
```

## Example: 4-screen video wall

```
┌─────────────┬─────────────┐
│ Screen 1    │ Screen 2    │
│ (LEAD)      │ (follower)  │
│ 192.168.1.10│ 192.168.1.11│
├─────────────┼─────────────┤
│ Screen 3    │ Screen 4    │
│ (follower)  │ (follower)  │
│ 192.168.1.12│ 192.168.1.13│
└─────────────┴─────────────┘
```

**CMS setup:** Create 4 displays. Set Screen 1's sync group to `lead`. Set Screens 2-4's sync group to `192.168.1.10`. Set sync publisher port to `8765` on all four.

**Screen 1 config.json:** Add `"listenAddress": "0.0.0.0"` so the proxy listens on all interfaces.

All four screens run the same Electron/Chromium player. The lead drives layout transitions; followers load content in parallel and show simultaneously when all are ready.

## API

### `new SyncManager(options)`

| Option | Type | Description |
|--------|------|-------------|
| `displayId` | string | This display's unique hardware key |
| `syncConfig` | SyncConfig | Sync configuration from CMS RegisterDisplay |
| `transport` | SyncTransport? | Optional pre-built transport (for testing) |
| `onLayoutChange` | Function? | Called when lead requests layout change |
| `onLayoutShow` | Function? | Called when lead gives show signal |
| `onVideoStart` | Function? | Called when lead gives video start signal |
| `onStatsReport` | Function? | (Lead) Called when follower sends stats |
| `onLogsReport` | Function? | (Lead) Called when follower sends logs |
| `onStatsAck` | Function? | (Follower) Called when lead confirms stats |
| `onLogsAck` | Function? | (Follower) Called when lead confirms logs |

### Methods

| Method | Role | Description |
|--------|------|-------------|
| `start()` | Both | Opens transport, begins heartbeats |
| `stop()` | Both | Closes transport, clears timers |
| `requestLayoutChange(layoutId)` | Lead | Sends layout-change, waits for ready, sends show |
| `requestVideoStart(layoutId, regionId)` | Lead | Signals synchronized video start |
| `reportReady(layoutId)` | Follower | Reports layout is loaded and ready |
| `reportStats(statsXml)` | Follower | Delegates stats submission to lead |
| `reportLogs(logsXml)` | Follower | Delegates logs submission to lead |
| `getStatus()` | Both | Returns sync status including follower details |

---

[xiboplayer.org](https://xiboplayer.org) · **Part of the [XiboPlayer SDK](https://github.com/xibo-players/xiboplayer)**
