# @xiboplayer/sync

**Multi-display sync for Xibo video walls — same-machine and cross-device. New in v0.7.0; zero-config mDNS discovery in v0.7.1; runtime sync-group switching (`setSyncGroup`) and layout-tag bridge in v0.7.20.**

## Overview

`@xiboplayer/sync` coordinates layout transitions and video playback across
multiple displays with sub-200 ms precision. Transports are pluggable:

- **Cross-device sync** — WebSocket relay for LAN video walls (one device
  per screen).
- **Same-machine sync** — `BroadcastChannel` for multi-tab / multi-window
  setups on a single device.

Both transports share the same sync protocol — only the wire differs.

## What this package is (and is not)

The SDK intentionally ships **two** runtime sync primitives. Everything
else ADA talks about under "fleet coordination" resolves at upload or
schedule time, not inside `SyncManager`.

### In scope — runtime sync primitives

| Primitive | Status | Precision | Notes |
|---|---|---|---|
| **identical-sync** — same content, same tick, all screens in a group | Shipped | ±200 ms | `SyncManager` lead/follower + `syncConfig.syncGroup` + two-phase prepare/show. End-to-end wired. |
| **paired-diff Tier 1** — screens in one group show *different* but time-aligned content, driven by `syncConfig.layoutMap` (e.g. lobby reception pair = visitor-list / weather) | Shipped (Phase A) | ±200 ms | `layoutMap` hand-written into config today. Tier 2 (±40 ms frame-accurate video-wall, native SMIL `syncMaster=`/`syncBase=` renderer) is **Phase B — deferred**. |

### Out of scope — composition / scheduling patterns

| ADA pattern | Where it resolves | Why not here |
|---|---|---|
| **role-based** (per-surface content — lobby vs lift vs guest-room TV) | Xibo CMS `displayGroup` + targeted schedules | Not a runtime sync concern. ADA compose emits N envelopes, each to a different display-group. See `xiboplayer-ai/ada/patterns/composition/role-based.md`. |
| **hierarchy** (org → region → property → zone → surface → screen, narrower scope wins) | Xibo scheduler priority | Not in the SDK. The CMS collapses hierarchy into `displayId[] + starts_at + priority` before anything reaches the player. See `xiboplayer-ai/ada/patterns/composition/hierarchy.md`. |
| **frame-accurate video-wall** (±40 ms, `syncMaster=`/`syncBase=`) | Phase B native SMIL renderer | Not Phase A. Tier 1 paired-diff above accepts ±200 ms drift. |

Honest framing: three of the four "fleet coordination" patterns ADA
describes are **not** sync primitives. This package is not a
composition orchestrator, not a frame-accurate video-wall renderer,
and not a hierarchy resolver. See roadmap
[`#236`](../../../xiboplayer-roadmap/plan/236-fleet-coordination-to-sdk-sync.md)
for the full decision rationale and
[`#235`](../../../xiboplayer-roadmap/plan/235-ada-xlf-capability-map.md)
for the broader ADA-side vocabulary.

## Capabilities (what identical-sync gives you)

- Synchronized layout transitions — lead signals followers to change
  layout, waits for all to be ready, then sends a simultaneous "show"
  signal.
- 12 choreography effects — diagonal cascade, wave sweep, center-out,
  etc. See `choreography.js`.
- Coordinated video start — video playback begins at the same moment
  on all displays.
- Stats / logs delegation — followers delegate proof-of-play stats and
  log submission through the lead, avoiding duplicate CMS traffic.
- Token authentication — shared CMS key secures the WebSocket relay.
- Sync-group isolation — multiple groups can share one relay via
  `syncGroupId`.
- Offline LAN sync — persisted config enables sync without CMS
  connectivity.
- Automatic follower discovery — heartbeats every 5 s, stale detection
  after 15 s.
- Graceful degradation — if a follower is unresponsive, the lead
  proceeds after a 10 s timeout.
- Auto-reconnect — WebSocket transport reconnects with exponential
  backoff (1 s → 30 s).
- **Runtime group switching** — `setSyncGroup(name)` tears down and
  rebuilds the transport when a layout-tag changes the cohort. New in
  v0.7.20.

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

The relay is a dumb pipe — it broadcasts each message to all other
connected clients. The sync protocol (heartbeats, ready-waits, layout
changes) runs entirely in `SyncManager`.

## Installation

```bash
npm install @xiboplayer/sync
```

## Usage

### Same-machine sync (default)

Multiple tabs/windows on the same origin communicate automatically
over `BroadcastChannel`:

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

When `syncGroup` is an IP address (not `"lead"`) and `syncPublisherPort`
is set, the PWA builds a WebSocket relay URL automatically. The lead
connects to its own proxy at `ws://localhost:<port>/sync`; followers
connect to `ws://<lead-ip>:<port>/sync`.

In v0.7.1+, followers no longer need the lead's IP — the lead
advertises its relay via mDNS (`_xibo-sync._tcp`) and followers
discover it by matching `syncGroupId`. If mDNS fails (e.g. different
subnets), the CMS-provided IP is used as fallback.

**CMS display settings:**

| Setting | Lead | Follower |
|---|---|---|
| Sync Group | `lead` | (auto-discovered via mDNS in v0.7.1+; CMS IP as fallback) |
| Sync Publisher Port | `8765` | `8765` |

### Injecting a custom transport

For tests or bespoke setups, pass any object implementing the
transport interface:

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

## Transport interface

Both `BroadcastChannelTransport` and `WebSocketTransport` implement:

```typescript
interface SyncTransport {
  send(msg: any): void;           // Send message to peers
  onMessage(cb: (msg) => void);   // Register message handler
  close(): void;                  // Clean up resources
  readonly connected: boolean;    // Connection status
}
```

## Sync protocol

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

## API reference

### `new SyncManager(options)`

| Option | Type | Description |
|---|---|---|
| `displayId` | `string` | This display's unique hardware key |
| `syncConfig` | `SyncConfig` | Sync configuration from CMS `RegisterDisplay` |
| `transport` | `SyncTransport?` | Optional pre-built transport (for testing) |
| `onLayoutChange` | `(layoutId, showAt) => void` | Called when lead requests a layout change |
| `onLayoutShow` | `(layoutId) => void` | Called when lead gives the show signal |
| `onVideoStart` | `(layoutId, regionId) => void` | Called when lead gives the video-start signal |
| `onStatsReport` | `Function` | (Lead) Called when a follower sends stats |
| `onLogsReport` | `Function` | (Lead) Called when a follower sends logs |
| `onStatsAck` | `Function` | (Follower) Called when the lead confirms stats |
| `onLogsAck` | `Function` | (Follower) Called when the lead confirms logs |
| `onGroupUpdate` | `Function` | Called with the current topology map |
| `onSyncGroupChanged` | `(newGroup, previousGroup) => void` | Called after `setSyncGroup()` actually changes the active group |

### Methods

| Method | Role | Description |
|---|---|---|
| `start()` | Both | Opens transport, begins heartbeats |
| `stop()` | Both | Closes transport, clears timers |
| `setSyncGroup(name)` | Both | Runtime group switch — see below |
| `requestLayoutChange(layoutId)` | Lead | Sends `layout-change`, waits for ready, sends show |
| `requestVideoStart(layoutId, regionId)` | Lead | Signals synchronized video start |
| `reportReady(layoutId)` | Follower | Reports layout is loaded and ready |
| `reportStats(statsXml)` | Follower | Delegates stats submission to lead |
| `reportLogs(logsXml)` | Follower | Delegates logs submission to lead |
| `getStatus()` | Both | Returns sync status including follower details |

### `setSyncGroup(groupName)` — runtime group switch

```typescript
setSyncGroup(groupName: string | null): boolean
```

Changes the active sync group at runtime. This is the SDK side of the
layout-tag bridge (see next section) — the PWA calls it when an
incoming layout declares `<tag>xp-sync-group:NAME</tag>`.

**Semantics:**

- **No-op guard** — returns `false` without touching the transport when
  `groupName` matches the current `syncConfig.syncGroup`. This avoids
  churn on redundant tags during rotations.
- **Tear down + rebuild** — when the name differs, the current
  transport is closed and pending ready-state is cleared (any
  in-flight `layout-change` is stale once the cohort changes, so
  cross-group message leakage is prevented). If the manager was
  already `start()`-ed, a new transport is built immediately; if not,
  `syncConfig.syncGroup` is just updated and the next `start()` will
  use it.
- **`null` leaves the group.** `setSyncGroup(null)` is supported but
  not wired into the layout-tag bridge — see design note below.
- **Callback** — fires `onSyncGroupChanged(newGroup, previousGroup)` on
  success. Callback errors are swallowed so a misbehaving consumer
  does not break the transport restart. (The method's JSDoc uses a
  `@fires syncgroup-changed` tag for documentation purposes only;
  `SyncManager` is not an `EventEmitter` — the callback is the public
  surface.)
- **Returns** — `true` if the group actually changed, `false` on
  no-op.

**Example — programmatic switch:**

```javascript
// Observe every group change for logging / analytics
const sync = new SyncManager({
  displayId: 'screen-1',
  syncConfig: { isLead: false, syncGroup: 'lobby', syncPublisherPort: 8765 },
  onSyncGroupChanged: (next, prev) => {
    log.info(`joined group ${next} (was ${prev ?? 'none'})`);
  },
});
sync.start();

// Later — e.g. from a settings panel
const changed = sync.setSyncGroup('atrium'); // → true
sync.setSyncGroup('atrium');                 // → false (no-op)
```

## Layout-tag → `setSyncGroup()` bridge

Roadmap ticket [`#236`](../../../xiboplayer-roadmap/plan/236-fleet-coordination-to-sdk-sync.md)
wires `xp-sync-group:NAME` tags on incoming layouts into
`syncConfig.syncGroup` automatically, so authors can drive cohort
membership from the same SMIL/XLF that carries the content.

### How it works end-to-end

1. **Upload time** — the `xiboplayer-smil-tools` translator (roadmap
   `#239`) emits `<tag>xp-sync-group:NAME</tag>` as a direct child of
   `<layout><tags>` whenever the source SMIL carries
   `xp:sync-group="NAME"`.
2. **Schedule time** — XMDS `getSchedule` responses may surface
   per-layout `<tags>` as an array on the layout record. The parser is
   defensive: upstream Xibo CMS (`Soap*.php`) does not emit `<tags>`
   children under `<layout>` today, so production relies on
   step 3 below. Forks that do inject `<tags>` will Just Work.
3. **Layout-change time** — `renderer-lite.parseXlf()` extracts the
   layout-level `<tags>` block and exposes it via
   `renderer.getCurrentLayoutTags(): string[]` (direct `<layout>/<tags>/<tag>`
   only — nested `<tag>` inside media options or actions is ignored).
4. **PWA handler** (`packages/pwa/src/main.ts`, `handleLayoutSyncGroupTag`)
   runs on every `layoutStart` event, pulls tags off the event payload
   or falls back to `renderer.getCurrentLayoutTags()`, scans for
   `xp-sync-group:NAME`, and schedules a **2-second debounced**
   `syncManager.setSyncGroup(NAME)` call.

### Debounce, fast-paths, edge cases

- **2 s debounce** coalesces rapid back-to-back layout changes
  (day-part boundaries, preemption, operator cycling). The transport
  restart fires at most once per 2 s window. The pending target is
  re-checked against `syncConfig.syncGroup` immediately before the
  call — if another code path already switched the cohort, the
  debounced callback exits early.
- **Fast-path no-op** — if the tag matches the current group, no
  timer is armed and no transport churn happens.
- **Multiple `xp-sync-group:*` tags on one layout** — the handler
  warns and takes the first.
- **Empty group name** (`xp-sync-group:`) is ignored.
- **`setSyncGroup` throws** — errors are logged and swallowed;
  transport hiccups must not break layout playback.

### Design decision — no-op when the layout has no tag

When an incoming layout carries no `xp-sync-group:*` tag, the handler
leaves the current group untouched rather than calling
`setSyncGroup(null)`.

Rationale: the `xiboplayer-smil-tools` translator emits the tag
**only** when the source SMIL had `xp:sync-group="…"`. A plain layout
with no tag is "not-grouped by author intent", not "explicitly leave
the group". Forcing `null` on every ungrouped layout would tear the
cohort down on each rotation.

If an explicit leave becomes necessary, it will get a dedicated marker
(e.g. `xp-sync-group:none` or an empty-value variant). Deferred until
a real scenario asks for it.

### XLF example

```xml
<layout schemaVersion="3" width="1920" height="1080" background="..." >
  <tags>
    <tag>xp-sync-group:lobby-wall</tag>
    <tag>brand:acme</tag>
  </tags>
  <region id="r1" width="1920" height="1080" top="0" left="0">
    <media id="m1" type="video" duration="10">
      <options><uri>video.mp4</uri></options>
    </media>
  </region>
</layout>
```

When this layout starts, the player (if it has a `SyncManager`
attached) debounces 2 s and then joins sync group `lobby-wall`,
tearing down any previous group's transport cleanly.

### Calling patterns

- **Via layout tag** — already wired in `packages/pwa/src/main.ts`.
  Nothing to do in consumer code if you ship the SDK PWA.
- **Programmatically** — call `syncManager.setSyncGroup(name)`
  directly from a settings UI, a headless test, or a custom event
  handler. The same semantics apply (no-op guard, tear-down + rebuild,
  callback).

## Renderer API — `getCurrentLayoutTags()`

```typescript
getCurrentLayoutTags(): string[]
```

Lives on `RendererLite` (`packages/renderer`). Returns a defensive
copy of the parsed `<tags>` array for the currently-showing layout,
or `[]` if no layout is showing or the layout carries no tags.

Only direct children of `<layout>` are considered (`<layout><tags><tag>…</tag></tags></layout>`);
nested `<tag>` elements inside `<media><actions>` etc. are ignored.
This is deliberate — the layout-tag bridge contract says "layout-level
tags only".

Useful outside the sync bridge too: any consumer that wants to read
brand markers, compliance tags, or debug annotations off the current
layout can call this directly.

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

**CMS setup:** create 4 displays. Set Screen 1's sync group to `lead`.
Set Screens 2-4's sync group to `192.168.1.10` (or let mDNS discover
in v0.7.1+). Set sync publisher port to `8765` on all four.

All four screens run the same Electron / Chromium player. The lead
drives layout transitions; followers load content in parallel and
show simultaneously when all are ready. Drop an
`<tag>xp-sync-group:wall-a</tag>` into the layout XLF and all four
will join group `wall-a` together at layout-change time (2 s debounce
per screen).

See `examples/test-multi-display.js` for a running same-machine
harness.

## Non-goals

This package is deliberately **not**:

- **A composition orchestrator** — role-based content assignment and
  hierarchy resolution belong to the ADA pattern library under
  `xiboplayer-ai/ada/patterns/composition/`. They resolve at ADA
  compose time and upload time, never at runtime.
- **A frame-accurate video-wall renderer** — Phase A (shipped) caps at
  ±200 ms. True `syncMaster=`/`syncBase=` frame alignment (Tier 2
  paired-diff) needs a native SMIL renderer and is **Phase B**,
  deferred in `#236`.
- **A schedule priority engine** — priority, starts-at, and
  display-group targeting live in the Xibo CMS scheduler. The player
  plays what the schedule tells it to play.

## References

- [`#236` — Fleet-coordination to SDK sync](../../../xiboplayer-roadmap/plan/236-fleet-coordination-to-sdk-sync.md) — design rationale for this bridge and the in-scope primitives.
- [`#235` — ADA-XLF capability map](../../../xiboplayer-roadmap/plan/235-ada-xlf-capability-map.md) — the broader ADA vocabulary and what translates to XLF today.
- `#239` (SMIL tags passthrough) — the translator side that emits `xp-sync-group:NAME` (in `xiboplayer-smil-tools`).
- `xiboplayer-ai/ada/patterns/fleet-coordination/identical-sync.md` — ADA-side doc for the shipped identical-sync primitive.
- `xiboplayer-ai/ada/patterns/fleet-coordination/paired-diff.md` — Tier 1 (Phase A, ±200 ms) / Tier 2 (Phase B, ±40 ms) precision split.
- `xiboplayer-ai/ada/patterns/composition/role-based.md` — composition pattern (not a sync concern).
- `xiboplayer-ai/ada/patterns/composition/hierarchy.md` — composition pattern (not a sync concern).

---

[xiboplayer.org](https://xiboplayer.org) · **Part of the [XiboPlayer SDK](https://github.com/xiboplayer/xiboplayer)**
