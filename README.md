# Xibo Player SDK

Modular JavaScript SDK for building [Xibo](https://xibosignage.com) digital signage players. Each package handles one concern — combine them to build a full player, or use individual packages in your own projects.

All packages are published to npm under the [`@xiboplayer`](https://www.npmjs.com/org/xiboplayer) scope.

[![npm](https://img.shields.io/npm/v/@xiboplayer/core?label=%40xiboplayer%2Fcore&color=0097D8)](https://www.npmjs.com/package/@xiboplayer/core)
[![npm](https://img.shields.io/npm/v/@xiboplayer/renderer?label=%40xiboplayer%2Frenderer&color=0097D8)](https://www.npmjs.com/package/@xiboplayer/renderer)
[![npm](https://img.shields.io/npm/v/@xiboplayer/schedule?label=%40xiboplayer%2Fschedule&color=0097D8)](https://www.npmjs.com/package/@xiboplayer/schedule)
[![npm](https://img.shields.io/npm/v/@xiboplayer/xmds?label=%40xiboplayer%2Fxmds&color=0097D8)](https://www.npmjs.com/package/@xiboplayer/xmds)
[![npm](https://img.shields.io/npm/v/@xiboplayer/xmr?label=%40xiboplayer%2Fxmr&color=0097D8)](https://www.npmjs.com/package/@xiboplayer/xmr)
[![npm](https://img.shields.io/npm/v/@xiboplayer/cache?label=%40xiboplayer%2Fcache&color=0097D8)](https://www.npmjs.com/package/@xiboplayer/cache)

## Features

### CMS Communication
- **Dual transport** — XMDS SOAP v3–v7 and REST API v2 with automatic protocol detection
- **XMR real-time commands** — collectNow, screenshot, changeLayout, overlayLayout, revertToSchedule, purgeAll, dataUpdate via WebSocket with auto-reconnect
- **Network resilience** — exponential backoff with jitter, CRC32-based skip optimization, ETag HTTP caching, HTTP 429 Retry-After support
- **CMS REST API client** — 77 methods covering layouts, campaigns, schedules, commands, displays, playlists, datasets, notifications, folders, tags, and display group actions
- **RSA key pair generation** for XMR display registration via Web Crypto API

### Rendering
- **Rich media** — video (MP4/HLS), images (scaleType, align/valign), audio (with overlay visualization), PDF, text/ticker, web pages, clock, calendar, weather, and all CMS widget types
- **Layout preloading** — 2-layout pool pre-builds upcoming layouts at 75% of current duration for instant zero-gap transitions
- **Transitions** — fade and fly (8-direction compass) via Web Animations API, including region exit transitions
- **Interactive actions** — touch/click and keyboard triggers for widget navigation, layout jumps, and command execution
- **Canvas regions, drawer regions, sub-playlists** — full support for advanced CMS layout features
- **Shell commands** — native command execution via Electron IPC and Chromium HTTP endpoint

### Scheduling
- **Campaign scheduling** — priority-based campaigns, daily/weekly/monthly dayparting with midnight-crossing, geo-fencing, and criteria evaluation
- **Interrupts / share of voice** — percentage-based interrupt scheduling with even interleaving across the hour
- **Overlays** — multiple simultaneous overlay layouts with independent scheduling and priority
- **Timeline prediction** — deterministic future schedule simulation for proactive content preloading
- **Weather criteria** — weather-based schedule evaluation with geolocation fallback chain (browser API → Google API → IP lookup)

### Downloads & Offline
- **Offline-first** — ContentStore (filesystem via proxy) + IndexedDB storage with automatic fallback to cached schedule
- **Parallel chunk downloads** — large files split into 50MB chunks, header+trailer first for instant MP4 playback start
- **Download resume** — incomplete chunked downloads resume from last successful chunk
- **Download window enforcement** — respects CMS-configured time windows to avoid bandwidth during peak hours

### Cross-Device Video Walls
- **Multi-display sync** — lead/follower synchronization with coordinated layout transitions and video start
- **Same-machine** — BroadcastChannel for multi-tab/multi-window setups
- **Cross-device** — WebSocket relay on the lead's proxy server for LAN video walls (each screen a separate PC)
- **Stats delegation** — followers delegate proof-of-play through the lead, avoiding duplicate CMS traffic

### Analytics & Monitoring
- **Proof of play** — per-layout and per-widget duration tracking with individual or aggregated submission
- **Event-based stats** — widget interactions and recordEvent for engagement analytics
- **Fault reporting** — independent 60s cycle for faster CMS alerts, layout blacklisting after 3 consecutive failures
- **Screenshot capture** — periodic and on-demand via getDisplayMedia + html2canvas fallback

### Infrastructure
- **CORS proxy** — shared Express server for Electron and Chromium shells with XMDS, REST, and file download proxying plus PWA static serving
- **Protocol auto-detection** — probes REST API at startup, auto-selects REST or SOAP transport
- **Persistent layout durations** — cached in IndexedDB for correct timeline on restart
- **1402 tests** across 36 test suites

## Packages

| Package | npm | Description |
|---------|-----|-------------|
| [`@xiboplayer/core`](packages/core) | [![npm](https://img.shields.io/npm/v/@xiboplayer/core?style=flat-square)](https://www.npmjs.com/package/@xiboplayer/core) | Player orchestration, collection cycle, offline mode, layout state machine |
| [`@xiboplayer/renderer`](packages/renderer) | [![npm](https://img.shields.io/npm/v/@xiboplayer/renderer?style=flat-square)](https://www.npmjs.com/package/@xiboplayer/renderer) | XLF layout rendering — video, image, PDF, text, web, transitions, actions, preloading |
| [`@xiboplayer/schedule`](packages/schedule) | [![npm](https://img.shields.io/npm/v/@xiboplayer/schedule?style=flat-square)](https://www.npmjs.com/package/@xiboplayer/schedule) | Campaigns, dayparting, interrupts, overlays, geo-fencing, criteria, timeline |
| [`@xiboplayer/xmds`](packages/xmds) | [![npm](https://img.shields.io/npm/v/@xiboplayer/xmds?style=flat-square)](https://www.npmjs.com/package/@xiboplayer/xmds) | XMDS SOAP + REST client — RegisterDisplay, RequiredFiles, Schedule, GetResource, stats |
| [`@xiboplayer/xmr`](packages/xmr) | [![npm](https://img.shields.io/npm/v/@xiboplayer/xmr?style=flat-square)](https://www.npmjs.com/package/@xiboplayer/xmr) | XMR WebSocket — real-time commands with auto-reconnect |
| [`@xiboplayer/cache`](packages/cache) | [![npm](https://img.shields.io/npm/v/@xiboplayer/cache?style=flat-square)](https://www.npmjs.com/package/@xiboplayer/cache) | Offline cache — parallel chunk downloads, MD5 verification, download queue |
| [`@xiboplayer/stats`](packages/stats) | [![npm](https://img.shields.io/npm/v/@xiboplayer/stats?style=flat-square)](https://www.npmjs.com/package/@xiboplayer/stats) | Proof of play, log reporting, fault alerts with deduplication |
| [`@xiboplayer/settings`](packages/settings) | [![npm](https://img.shields.io/npm/v/@xiboplayer/settings?style=flat-square)](https://www.npmjs.com/package/@xiboplayer/settings) | CMS display settings — resolution, intervals, download windows, screenshot config |
| [`@xiboplayer/crypto`](packages/crypto) | [![npm](https://img.shields.io/npm/v/@xiboplayer/crypto?style=flat-square)](https://www.npmjs.com/package/@xiboplayer/crypto) | RSA key generation for XMR registration (Web Crypto API) |
| [`@xiboplayer/utils`](packages/utils) | [![npm](https://img.shields.io/npm/v/@xiboplayer/utils?style=flat-square)](https://www.npmjs.com/package/@xiboplayer/utils) | EventEmitter, logger, fetchWithRetry, CMS REST API client, config |
| [`@xiboplayer/sw`](packages/sw) | [![npm](https://img.shields.io/npm/v/@xiboplayer/sw?style=flat-square)](https://www.npmjs.com/package/@xiboplayer/sw) | Service Worker — media caching, range requests, widget HTML serving |
| [`@xiboplayer/sync`](packages/sync) | [![npm](https://img.shields.io/npm/v/@xiboplayer/sync?style=flat-square)](https://www.npmjs.com/package/@xiboplayer/sync) | Cross-device video walls — BroadcastChannel + WebSocket relay, lead/follower sync |
| [`@xiboplayer/proxy`](packages/proxy) | [![npm](https://img.shields.io/npm/v/@xiboplayer/proxy?style=flat-square)](https://www.npmjs.com/package/@xiboplayer/proxy) | CORS proxy + PWA server — shared by Electron and Chromium shells |

## Quick start

Install all packages at once:

```bash
npm install @xiboplayer/core @xiboplayer/renderer @xiboplayer/schedule \
  @xiboplayer/xmds @xiboplayer/xmr @xiboplayer/cache @xiboplayer/stats \
  @xiboplayer/settings @xiboplayer/utils @xiboplayer/sync @xiboplayer/proxy
```

Or install only what you need:

```bash
npm install @xiboplayer/xmds    # just the CMS SOAP client
npm install @xiboplayer/cache   # just the offline cache
npm install @xiboplayer/proxy   # CORS proxy + PWA server for shells
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    @xiboplayer/core                      │
│         collection cycle · offline mode · events         │
├──────────┬──────────┬──────────┬──────────┬─────────────┤
│ renderer │ schedule │  cache   │  stats   │  settings   │
│  layout  │ campaign │ offline  │ proof of │  display    │
│ widgets  │ daypart  │  chunks  │   play   │  config     │
│ actions  │interrupt │   MD5    │  logs    │  windows    │
├──────────┴──────────┴──────────┴──────────┴─────────────┤
│       @xiboplayer/xmds            @xiboplayer/xmr       │
│   SOAP + REST ↔ CMS           WebSocket ↔ CMS push     │
├─────────────────────────────────────────────────────────┤
│ @xiboplayer/proxy  @xiboplayer/utils  @xiboplayer/sync crypto│
│  CORS proxy · PWA    logger · events   video wall    RSA  │
│  sync relay          fetch · config    BC + WebSocket keys │
└─────────────────────────────────────────────────────────┘
```

## CMS communication

The SDK supports three communication channels:

| Protocol | Package | Use case |
|----------|---------|----------|
| **XMDS SOAP** | `@xiboplayer/xmds` | Standard Xibo player protocol (v3–v7) |
| **REST API** | `@xiboplayer/xmds` | Lighter JSON transport (~30% smaller payloads), ETag caching |
| **XMR WebSocket** | `@xiboplayer/xmr` | Real-time push commands from CMS |

**XMDS methods:** RegisterDisplay, RequiredFiles, Schedule, GetResource, NotifyStatus, MediaInventory, BlackList, SubmitStats, SubmitScreenShot, SubmitLog

**XMR commands:** collectNow, screenshot, changeLayout, overlayLayout, revertToSchedule, purgeAll, dataUpdate, triggerWebhook, commandAction, criteriaUpdate, currentGeoLocation

## Rendering

The renderer parses Xibo Layout Format (XLF) files and builds a live DOM with:

| Widget type | Implementation |
|-------------|---------------|
| Video | `<video>` with native HLS (Safari) + hls.js fallback, pause-on-last-frame |
| Image | `<img>` with scaleType (center/stretch/fit), align/valign, blob URL from cache |
| Audio | `<audio>` with gradient visualization overlay and playback icon |
| PDF | PDF.js canvas rendering (dynamically imported) |
| Text / Ticker | iframe with CMS-rendered HTML via GetResource |
| Web page | bare `<iframe src="...">` |
| Clock, Calendar, Weather | iframe via GetResource (server-rendered) |
| All other CMS widgets | Generic iframe via GetResource |

Layout features: proportional scaling with ResizeObserver, overlay support (z-index 1000+), 2-layout preload pool for zero-gap transitions, element reuse on same-layout replay, media-ready gating (layout timer starts only when all first widgets are loaded).

## Players built with this SDK

| Player | Platform | Install |
|--------|----------|---------|
| [xiboplayer-pwa](packages/pwa) | Any browser | Hosted on your CMS |
| [xiboplayer-electron](https://github.com/xibo-players/xiboplayer-electron) | Fedora / Ubuntu | `dnf install xiboplayer-electron` |
| [xiboplayer-chromium](https://github.com/xibo-players/xiboplayer-chromium) | Fedora / Ubuntu | `dnf install xiboplayer-chromium` |
| [xiboplayer-kiosk](https://github.com/xibo-players/xiboplayer-kiosk) | Fedora / Ubuntu | `dnf install xiboplayer-kiosk` |

RPM and DEB packages are available from [dl.xiboplayer.org](https://dl.xiboplayer.org).

## Development

### Prerequisites

- Node.js 20+
- pnpm 10+

### Setup

```bash
pnpm install
```

### Testing

```bash
pnpm test              # run all tests (1402 tests across 36 suites)
pnpm test:watch        # watch mode
pnpm test:coverage     # with coverage report
```

### Workspace structure

This is a pnpm workspace monorepo. Packages use `workspace:*` internally; pnpm converts these to semver ranges on publish.

## License

AGPL-3.0-or-later
