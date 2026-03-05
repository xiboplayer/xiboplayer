# @xiboplayer/core

**Pure orchestration engine for Xibo players — manages collection cycles, layout state machines, offline mode, and lifecycle events.**

## Overview

The core package is the central orchestrator of a Xibo player. It manages:

- **Collection cycle** — periodic CMS polling (RegisterDisplay, RequiredFiles, Schedule) with CRC32 optimization to skip redundant downloads
- **Layout scheduling** — builds a playback queue from CMS schedule with support for campaigns, dayparting, priorities, and maxPlaysPerHour constraints
- **Layout state machine** — controls which layout is playing, handles XMR interrupts (changeLayout, overlayLayout), layout overrides with auto-revert, and synchronized transitions in multi-display setups
- **Offline mode** — falls back to IndexedDB-cached schedule and media when CMS is unreachable, with exponential backoff retry (30s -> 60s -> 120s -> normal interval)
- **Event bus** — emits 50+ lifecycle events (collection-start, register-complete, layout-prepare-request, layout-current, offline-mode, timeline-updated, etc.)
- **XMR integration** — WebSocket-based real-time messaging for remote commands (layout changes, purge, screenshots, geo-location, commands, triggers)
- **Multi-display sync** — coordinates synchronized layout transitions and video playback across multiple displays via optional SyncManager
- **Layout blacklisting** — automatic fallback when a layout fails to render 3+ times
- **Data connectors** — real-time polling of external data sources (weather, feeds, APIs) for dynamic content widgets
- **Timeline calculation** — predicts next 2 hours of layout playback with duration estimation and missing media detection

## Architecture

```
+-----------------------------------------------------------------+
| PlayerCore (Pure Orchestration)                                 |
|                                                                 |
|  +-------------+--------------+--------------+                  |
|  | Collection  | Layout State | Offline      |                  |
|  | Cycle       | Machine      | Cache (IDB)  |                  |
|  +-------------+--------------+--------------+                  |
|                                                                 |
|  Events emitted (NO DOM manipulation):                          |
|  collection-start, schedule-received, download-request,         |
|  layout-prepare-request, layout-current, layout-expire-current, |
|  offline-mode, timeline-updated, sync-config, xmr-connected    |
+-----------------------------------------------------------------+
                             |
+-----------------------------------------------------------------+
| Dependencies (injected)                                         |
+-----------------------------------------------------------------+
| @xiboplayer/xmds     -> XMDS client (RegisterDisplay, etc.)    |
| @xiboplayer/schedule  -> Schedule queue builder, layout eval    |
| @xiboplayer/cache     -> Blob storage (media files, XLFs)      |
| @xiboplayer/renderer  -> Layout rendering (platform-specific)  |
| @xiboplayer/utils     -> Logger, EventEmitter, config          |
| @xiboplayer/sync      -> Multi-display SyncManager (optional)  |
+-----------------------------------------------------------------+
                             |
+-----------------------------------------------------------------+
| Platform Layer (PWA / Electron / Chromium / Mobile)             |
| - Renders layouts via renderer                                  |
| - Handles UI updates, status display, progress indicators       |
| - Manages storage, downloads via cache pkg                      |
| - Listens to core events and updates the DOM                    |
+-----------------------------------------------------------------+
```

**Key principle:** PlayerCore emits events; it does not manipulate the UI. The platform layer listens to these events and implements the actual rendering, DOM updates, and platform-specific behaviors.

## Installation

```bash
npm install @xiboplayer/core
```

## Usage

### Basic setup

```javascript
import { PlayerCore } from '@xiboplayer/core';

const core = new PlayerCore({
  config: displayConfig,
  xmds: xmdsClient,
  cache: cacheClient,
  schedule: scheduleManager,
  renderer: rendererInstance,
  xmrWrapper: XmrClass,
  statsCollector: statsClient,
  displaySettings: dsManager,
});

core.on('collection-start', () => console.log('Polling CMS...'));
core.on('schedule-received', (schedule) => console.log('Schedule updated'));
core.on('download-request', ({ files, layoutOrder }) => {
  downloadQueue(files, layoutOrder);
});

core.on('layout-prepare-request', (layoutId) => {
  renderer.renderLayout(layoutId);
});

core.on('offline-mode', (isOffline) => {
  updateStatusDisplay(isOffline ? 'Offline' : 'Online');
});

await core.collect();
```

### Event handling

```javascript
// Layout lifecycle
core.on('layout-prepare-request', (layoutId) => showLoadingBar());
core.on('layout-current', (layoutId) => hideLoadingBar());
core.on('layout-expire-current', () => fadeOutAndCleanup());

// Timeline/schedule preview
core.on('timeline-updated', (timeline) => {
  // timeline: [{ layoutFile, startTime, endTime, duration, missingMedia, isDefault }]
  updateTimelineOverlay(timeline);
});

// Offline
core.on('offline-mode', (isOffline) => {
  if (isOffline) showOfflineBanner('Using cached schedule');
  else hideOfflineBanner();
});
```

### Layout overrides (XMR)

```javascript
// Change to a specific layout, auto-revert after duration
core.changeLayout(layoutId, { duration: 30 });

// Overlay: push a layout on top of current content
core.overlayLayout(layoutId, { duration: 10 });

// Manual revert
await core.revertToSchedule();
```

### Multi-display sync

```javascript
import { SyncManager } from '@xiboplayer/sync';

const syncManager = new SyncManager({
  displayId: 'screen-1',
  syncConfig: regResult.syncConfig,
  onLayoutChange: async (layoutId) => {
    await renderer.prepareLayout(layoutId);
    syncManager.reportReady(layoutId);
  },
  onLayoutShow: (layoutId) => renderer.show(layoutId),
});

syncManager.start();
core.setSyncManager(syncManager);
```

## Collection Cycle

The collection cycle runs every 300 seconds (configurable via CMS settings):

```
1. REGISTERDISPLAY
   +- Authenticates display (hardware key)
   +- Returns: settings, syncConfig, commands, checkRf/checkSchedule CRC32
   +- Saves to IndexedDB for offline use

2. CRC32 SKIP OPTIMIZATION
   +- If checkRf unchanged -> skip RequiredFiles
   +- If checkSchedule unchanged -> skip Schedule

3. REQUIREDFILES (if checkRf changed)
   +- Gets media, layouts, resources, dependencies, widgets
   +- Checks for purge items (deleted media to remove)
   +- Resets blacklist (CMS may have fixed layouts)

4. SCHEDULE (if checkSchedule changed)
   +- Gets CMS schedule (layouts, campaigns, dayparting, criteria)
   +- Evaluates criteria (location, time, device, weather, custom)
   +- Builds playback queue with priorities, maxPlaysPerHour, durations

5. LAYOUT QUEUE EVALUATION
   +- Calculates queue from schedule + durations + constraints
   +- If current layout still valid -> keep playing
   +- If expired -> emit layout-expire-current
   +- If no current layout -> emit layout-prepare-request

6. DOWNLOAD MANAGEMENT
   +- Check download window (CMS can restrict to off-peak hours)
   +- Emit download-request with files + layout priority order

7. SUBMIT STATS & LOGS
   +- Proof-of-play, diagnostic logs, fault reports
   +- Multi-display: followers delegate to lead via SyncManager

8. FINALIZE
   +- Calculate timeline (next 2 hours)
   +- Emit timeline-updated, collection-complete
   +- Schedule next cycle

OFFLINE FALLBACK:
   If XMDS fails AND cached schedule exists:
   +- Use cached schedule + cached media
   +- Retry with backoff: 30s -> 60s -> 120s -> normal
```

## Events

| Event | Payload | Description |
|-------|---------|-------------|
| `collection-start` | -- | Collection cycle beginning |
| `collection-complete` | -- | Collection cycle finished |
| `collection-error` | `(error)` | CMS communication failed |
| `register-complete` | `(regResult)` | RegisterDisplay succeeded |
| `files-received` | `(files)` | RequiredFiles call succeeded |
| `schedule-received` | `(schedule)` | Schedule call succeeded |
| `download-request` | `(layoutOrder, files)` | Download needed files in layout priority order |
| `layout-prepare-request` | `(layoutId)` | Next layout ready for rendering |
| `layout-current` | `(layoutId)` | Layout is now playing |
| `layout-pending` | `(layoutId, requiredMediaIds)` | Layout waiting for media downloads |
| `layout-expire-current` | -- | Current layout duration ended |
| `layout-already-playing` | `(layoutId)` | Schedule changed but current layout still valid |
| `no-layouts-scheduled` | -- | No layouts match current time |
| `layout-blacklisted` | `({ layoutId, reason, failures })` | Layout failed 3+ times, skipped |
| `offline-mode` | `(isOffline)` | Entered/exited offline mode |
| `xmr-connected` | `(xmrUrl)` | XMR WebSocket connected |
| `sync-config` | `(syncConfig)` | Display is in a sync group |
| `timeline-updated` | `(timeline)` | Schedule preview for next 2 hours |
| `screenshot-request` | -- | XMR requested screenshot |
| `revert-to-schedule` | -- | Layout override ended |
| `overlay-layout-request` | `(layoutId)` | Overlay layout requested |
| `execute-native-command` | `({ code, commandString })` | Non-HTTP command for platform |
| `scheduled-command` | `(command)` | Scheduled command ready |
| `submit-stats-request` | -- | Submit proof-of-play stats |
| `submit-logs-request` | -- | Submit player logs |
| `submit-faults-request` | -- | Submit faults (~60s cycle) |

## API Reference

### Constructor

```javascript
new PlayerCore({
  config,              // Display configuration (cmsUrl, hardwareKey, displayName, etc.)
  xmds,                // XMDS client instance
  cache,               // Cache/storage client
  schedule,            // Schedule manager
  renderer,            // Layout renderer
  xmrWrapper,          // XMR WebSocket wrapper class
  statsCollector?,     // Optional proof-of-play tracker
  displaySettings?,    // Optional display settings manager
})
```

### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `collect()` | `Promise<void>` | Start collection cycle |
| `collectNow()` | `Promise<void>` | Force immediate collection (clears CRC32 cache) |
| `collectOffline()` | `void` | Use cached schedule |
| `getNextLayout()` | `object \| null` | Get next layout from queue, skip blacklisted |
| `advanceToNextLayout()` | `void` | Pop next layout, emit layout-prepare-request |
| `advanceToPreviousLayout()` | `void` | Go back in schedule |
| `setCurrentLayout(layoutId)` | `void` | Mark layout as currently playing |
| `getCurrentLayoutId()` | `number \| null` | Get currently playing layout ID |
| `changeLayout(layoutId, opts)` | `Promise<void>` | XMR: change layout with optional duration |
| `overlayLayout(layoutId, opts)` | `Promise<void>` | XMR: push overlay layout |
| `revertToSchedule()` | `Promise<void>` | Exit layout override |
| `reportLayoutFailure(id, reason)` | `void` | Report render failure; blacklist after 3 |
| `reportLayoutSuccess(id)` | `void` | Clear failure counter |
| `setSyncManager(syncManager)` | `void` | Attach SyncManager for multi-display |
| `isSyncLead()` | `boolean` | Check if this display is sync lead |
| `purgeAll()` | `Promise<void>` | Delete all cache and re-download |
| `cleanup()` | `void` | Stop all timers, close XMR, remove listeners |

## Dependencies

- `@xiboplayer/utils` -- logger, events, config

---

[xiboplayer.org](https://xiboplayer.org) · **Part of the [XiboPlayer SDK](https://github.com/xibo-players/xiboplayer)**
