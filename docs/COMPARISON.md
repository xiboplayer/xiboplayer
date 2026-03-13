# Xibo Player Comparison: xiboplayer SDK vs Upstream

> Generated 2026-03-13. Based on analysis of: xiboplayer SDK (16 packages), PlayerRestApi
> (CMS custom module), upstream xibo-linux (C++), xibo-dotnetclient (C#/.NET),
> xibo-layout-renderer (XLR), xibo-interactive-control (XIC), and CMS source
> (XMDS Soap3→Soap7, Widget/Render, Entity layer). XMR client is native (replaced upstream
> xibo-communication-framework which only handled 5/14 CMS actions).

---

## 1. Architecture Comparison

### xiboplayer (ours) — Modular SDK

```
16 npm packages, ~1387 tests, platform-independent core

Platform (PWA / Electron / Chromium)
  ↓ events
PlayerCore (orchestration, collection cycle, blacklist, offline)
  ↓         ↓              ↓              ↓
Schedule   Cache          Renderer       XMDS
Manager    Manager        Lite           Client
  ↓         ↓              ↓              ↓
Criteria   DownloadMgr    LayoutPool     REST + SOAP
Interrupts Chunks/Barrier Transitions    PlayerRestApi
Overlays   ServiceWorker  Drawers        JWT auth
```

### xibo-dotnetclient (Windows) — Monolithic WPF

```
Single executable (XiboClient.exe), multi-threaded agents

MainWindow (WPF master loop)
  ├─ ScheduleManager (background thread)
  ├─ RegisterAgent, FileAgent, StatAgent, LogAgent (threads)
  ├─ Layout → Regions → Media (WPF XAML visual tree)
  ├─ CefSharp / Edge WebView2 (HTML widgets)
  ├─ EmbeddedServer (localhost HTTP for HTML serving)
  ├─ MouseInterceptor + KeyInterceptor (actions)
  └─ CacheManager (filesystem + SQLite)
```

### xibo-linux (C++) — Native GTK+

```
Monolithic binary, GTK+ event loop, GStreamer media

XiboApp singleton
  ├─ Scheduler (time-based queue)
  ├─ LayoutsManager (load/unload/overlay)
  ├─ XmdsRequestSender (SOAP)
  ├─ XmrManager (ZeroMQ)
  ├─ FileCache (MD5 manifest)
  └─ GTK+ Widgets (Image, WebView, Video via GStreamer)
```

### Upstream Electron player — XLR-based

```
Electron (TypeScript), main/renderer split

Main process: XMDS, config, schedule, files
Renderer process: XLR library (shared npm module)
  ├─ Layout.ts (orchestrator)
  ├─ Region.ts (media sequencing)
  ├─ ActionController.ts (interactive triggers)
  ├─ OverlayLayoutManager.ts (overlays)
  └─ Generators.ts (dynamic content)
```

---

## 2. Feature Matrix

| Feature | xiboplayer | .NET (Win) | Linux (C++) | Upstream Electron |
|---------|:----------:|:----------:|:-----------:|:-----------------:|
| **CMS Protocol** | REST + SOAP (auto-detected), idempotent cache-through | SOAP only | SOAP only | SOAP only |
| **Auth** | JWT Bearer | hardwareKey per call | hardwareKey per call | hardwareKey per call |
| **Schedule parse** | Server-side JSON | Client-side XML | Client-side XML | Client-side XML |
| **Layout format** | XLF (XML) | XLF | XLF | XLF |
| **Regions** | ✅ | ✅ | ✅ | ✅ |
| **Drawers** | ✅ (navWidget + triggerCode) | ✅ (navWidget) | ❌ | ✅ (XLR) |
| **Overlay layouts** | ✅ | ✅ | ✅ | ✅ |
| **Interrupt layouts** | ✅ (ShareOfVoice) | ✅ | ❌ | ❌ |
| **Campaigns** | ✅ | ✅ | ❌ (single layouts) | ✅ |
| **Dayparting** | ✅ (criteria engine) | ✅ | ✅ (time-based) | ✅ |
| **Geo-fencing** | ✅ (GPS+IP+Google) | ✅ (GPS+IP) | ❌ | ❌ |
| **Weather criteria** | ✅ | ❌ | ❌ | ❌ |
| **Touch actions** | ✅ (click on widget) | ✅ (point-in-rect) | ❌ | ✅ (XLR) |
| **Keyboard actions** | ✅ (keydown map) | ✅ (KeyInterceptor) | ❌ | ✅ (XLR) |
| **Webhook triggers** | ✅ (XMR + HTTP) | ✅ (EmbeddedServer) | ✅ (XMR only) | ✅ |
| **navLayout** | ✅ | ✅ | ❌ | ✅ |
| **navWidget** | ✅ | ✅ | ❌ | ✅ |
| **next/previous** | ✅ | ✅ | ❌ | ✅ |
| **XIC support** | ✅ (SW intercept + renderer) | ✅ (EmbeddedServer) | ❌ | ✅ |
| **XMR (real-time)** | ✅ WebSocket (all 14 actions) | ✅ WebSocket+ZMQ (collectNow only) | ✅ ZMQ only (collectNow only) | ✅ WebSocket (collectNow only) |
| **Transitions** | ✅ CSS (fade/fly) | ✅ WPF (fade/fly) | ✅ GTK (fade/fly) | ✅ (XLR) |
| **Video** | HTML5 `<video>` | WPF MediaElement | GStreamer | HTML5 |
| **Audio overlays** | ✅ | ✅ | ✅ | ✅ |
| **PDF** | ✅ (pdfjs-dist) | ❌ (no native) | ❌ | ❌ |
| **HLS** | ✅ (native browser) | ✅ (Edge WebView2) | ❌ | ✅ |
| **Sub-playlists** | ✅ (cycle + playCount) | ✅ (cycle playback) | ❌ | ✅ |
| **Data connectors** | ✅ (polling + IC) | ✅ (DataAgent) | ❌ | ✅ |
| **Multi-display sync** | ✅ (BC + WebSocket LAN) | ❌ | ❌ | ❌ |
| **Offline mode** | ✅ (SW + IndexedDB) | ✅ (filesystem) | ✅ (filesystem) | ✅ (filesystem) |
| **Layout pre-loading** | ✅ (LayoutPool hot/warm) | ❌ | ❌ | ✅ (XLR) |
| **Blacklist/fault** | ✅ (3-strike) | ✅ (unsafe items) | ❌ | ❌ |
| **Stats/PoP** | ✅ (IndexedDB) | ✅ (SQLite) | ✅ (records) | ✅ |
| **Screenshot** | ✅ (Electron native) | ✅ (BitBlt capture) | ✅ (XMDS) | ✅ |
| **Bandwidth limit** | ✅ (server-side) | ✅ (XMDS) | ✅ (XMDS) | ✅ |
| **Range downloads** | ✅ (chunked + barrier) | ✅ (XMDS chunks) | ✅ (XMDS chunks) | ❌ |
| **ETag caching** | ✅ (PlayerRestApi) | ❌ | ❌ | ❌ |

---

## 3. What We Have That Upstream Doesn't

### 3a. PlayerRestApi — REST JSON API (1608 lines PHP)

Upstream players all use SOAP/XML. Our REST API provides:
- **JWT auth** — stateless, no per-request CMS lookup
- **Server-side schedule parsing** — eliminates 230+ lines of client-side XML parsing
- **Categorized RequiredFiles** — `{media, layouts, widgets, dependencies}` instead of flat list
- **ETag caching** — 304 Not Modified for schedule/media responses
- **Range request support** — resumable downloads
- **Dual JSON/XML input** — backward-compatible stats/logs submission
- **Sendfile modes** — Apache X-Sendfile, Nginx X-Accel-Redirect for large files

### 3b. Idempotent Cache-Through Architecture (v0.6.12)

Both REST and XMDS transports converge on the same proxy mirror paths (`/player/api/v2/{layouts,media,dependencies}/...`), making the ContentStore transport-agnostic:
- **XMDS signed URLs** rewritten to local proxy mirror paths (eliminates CORS failures)
- **`X-Cms-Download-Url` header** — proxy fetches from original XMDS URL on cache miss
- **Transport-agnostic caching** — files cached via XMDS are served identically to REST-cached files
- **Second collection** serves everything from cache regardless of which transport was used

### 3c. LayoutPool (pre-loading)

Only our player and XLR have this. The .NET and C++ players tear down and rebuild the DOM/widget tree on every layout switch. Our LayoutPool keeps 2 layouts ready (hot + warm) for instant transitions.

### 3d. Cross-Device Video Walls (BroadcastChannel + WebSocket)

No upstream player has this. Our SyncManager coordinates layout transitions across multiple displays with a lead/follower protocol. Two transport layers: BroadcastChannel for same-machine sync (multi-tab), and a WebSocket relay on the lead's proxy server for cross-device LAN sync. Auto-reconnect, stats delegation, and synchronized video start across all screens.

### 3e. Advanced Schedule Features

- **Interrupt layouts** with ShareOfVoice (seconds-per-hour quota tracking)
- **Weather criteria** (temperature, humidity, wind, condition)
- **Deterministic LCM-based queue** for predictable timeline
- **Timeline projection** (2-hour lookahead for debug overlay)

### 3f. Chunked Downloads with Barrier

Our DownloadManager uses a BARRIER symbol in the task queue to ensure video can start playing before all chunks arrive. No upstream player does this — they all wait for complete file download.

### 3g. PDF Support

Native PDF rendering via pdfjs-dist. No upstream player supports PDF widgets.

---

## 4. Remaining Gaps

### 4a. Engagement Tracking

The .NET player has a full `StatManager` (1020 lines) that tracks direct user engagement (clicks, form submissions) and impression URLs for ad exchange. Our StatsCollector handles layout/widget stats and event-based stats but does not track ad impressions.

Priority: LOW unless ad exchange integration is needed.

### 4b. PowerPoint / Flash

Legacy .NET-only features. Not applicable.

### 4c. RS232 Serial Port

Not available in the browser sandbox. Only relevant for industrial signage with physical serial-connected displays.

### Implemented (full parity)

All other features that upstream players have are fully implemented:
- **Interactive Control (XIC)** — all 7 HTTP endpoints, proxy IC routes, `xiboICTargetId` injection, DataConnector realtime notifications
- **Canvas regions** — simultaneous widget rendering with `Math.max()` duration
- **Cycle playback / sub-playlists** — round-robin, random selection, `playCount` enforcement
- **Shell commands** — Electron IPC + Chromium HTTP endpoint, gated by `allowShellCommands` config, 30s timeout

---

## 5. Simplification Candidates

### 5a. SOAP Client (xmds-client.js) — MUST KEEP

**Constraint**: xiboplayer must work with any vanilla Xibo CMS, not just our custom
image with PlayerRestApi. SOAP/XMDS is the universal protocol every CMS speaks.

Both transports are maintained:
- `xmds-client.js` — Full SOAP envelope builder, XML parser (400+ lines)
- `rest-client.js` — Clean REST/JSON client for PlayerRestApi

`ProtocolDetector` auto-probes `GET /api/v2/player/health` at startup — uses REST if available, falls back to SOAP. Re-probes on connection errors for runtime hot-swap.

### 5b. Schedule Parser (schedule-parser.js) — MUST KEEP

**Constraint**: When talking to a vanilla CMS via SOAP, the schedule comes back
as XML. The client-side parser is required for that path.

**Current state**: Client-side XML schedule parser + server-side ScheduleJsonService.

**Recommendation**: Keep both. When using REST (PlayerRestApi), skip the parser
(server returns JSON). When using SOAP, run the parser. The ScheduleManager
should accept either format transparently.

### 5c. RendererLite vs XLR — EVALUATE

**Current state**: We have `renderer-lite.js` (~2000+ lines) that reimplements much of what XLR does.

**XLR provides**: Layout.ts, Region.ts, ActionController.ts, OverlayLayoutManager.ts, Generators.ts, transitions.

**Our renderer-lite.js provides**: XLF parsing, region rendering, widget rendering, transitions, actions, drawers, overlays, audio overlays, layout pool.

**Key difference**: XLR is a shared upstream library consumed by the official Electron player. Our renderer is custom-built and tightly integrated with our SDK event system.

**Recommendation**: DO NOT switch to XLR. Our renderer is:
- Tightly integrated with LayoutPool (pre-loading)
- Tightly integrated with our event-driven architecture
- Handles our custom features (barrier downloads, sync manager)
- Already working and tested

However, we should periodically compare with XLR for feature parity (especially new widget types and action handling).

### 5d. Proxy Package — SIMPLIFY

The `@xiboplayer/proxy` package serves multiple roles:
1. CORS proxy for CMS API (needed for PWA)
2. Static file server for PWA assets
3. ContentStore (IndexedDB REST interface)
4. XIC endpoint routing

With PlayerRestApi now handling media serving directly (with proper CORS headers), the CORS proxy role may be reducible. Evaluate whether the proxy can be slimmed down.

### 5e. Dual REST + SOAP Support in PlayerCore

Both `RestClient` and `XmdsClient` implement the same 12-method `CmsClient` interface,
formalized via `cms-client.js` with JSDoc types, `CMS_CLIENT_METHODS` canonical list,
and `assertCmsClient()` runtime validator. `ProtocolDetector` validates conformance
on every `detect()` / `reprobe()` call — catches missing methods at startup.

```
CmsClient interface:
  registerDisplay() → {displayId, settings, commands, ...}
  requiredFiles()   → [{id, type, md5, size, url}, ...]
  schedule()        → {layouts, campaigns, overlays, actions, ...}
  getResource()     → HTML string
  submitStats()     → void
  ...
```

### 5f. Config System

`@xiboplayer/utils` config system reads from: config.json → localStorage → URL params → defaults. The `SHELL_ONLY_KEYS` separation suggests some keys are Electron-only. Consider documenting which config keys apply to which platform to avoid confusion.

---

## 6. Future Work

1. **Evaluate proxy slimdown** — audit which proxy roles are redundant with PlayerRestApi CORS
2. **Engagement tracking** — ad impressions and direct user engagement in StatsCollector
3. **Config system documentation** — platform-specific key reference
4. **Ad exchange support** (SSP widget type)

---

## 7. Code Size Comparison

| Component | xiboplayer | .NET | Linux C++ |
|-----------|-----------|------|-----------|
| **Total LoC** | ~15,000 (16 packages) | ~12,000 | ~8,000 |
| **CMS comm** | ~600 (rest-client) | ~2,000 (agents) | ~1,500 (SOAP) |
| **Schedule** | ~800 | ~2,800 | ~500 |
| **Renderer** | ~2,000 | ~3,100 | ~2,000 |
| **Cache** | ~1,200 | ~1,400 | ~500 |
| **Stats** | ~400 | ~1,020 | ~300 |
| **Actions** | ~200 (in renderer) | ~500 (dedicated) | ~0 |
| **PlayerRestApi (PHP)** | 1,608 | N/A | N/A |

Our codebase is **leaner per feature** because:
- Server-side schedule parsing eliminates client-side complexity
- REST/JSON eliminates XML parsing overhead
- Browser APIs (IndexedDB, Service Worker, CSS animations) replace custom implementations
- Event-driven architecture avoids threading complexity

---

## 8. Appendix: Key File Paths

### xiboplayer SDK
| Package | Key File | Lines |
|---------|----------|-------|
| core | `packages/core/src/player-core.js` | ~800 |
| renderer | `packages/renderer/src/renderer-lite.js` | ~2000 |
| schedule | `packages/schedule/src/schedule.js` | ~800 |
| xmds | `packages/xmds/src/rest-client.js` | ~300 |
| xmds | `packages/xmds/src/xmds-client.js` | ~400 (removable) |
| cache | `packages/cache/src/download-manager.js` | ~600 |
| cache | `packages/cache/src/store-client.js` | ~200 |
| stats | `packages/stats/src/stats-collector.js` | ~200 |
| xmr | `packages/xmr/src/xmr-client.js` | ~180 |
| xmr | `packages/xmr/src/xmr-wrapper.js` | ~200 |
| sync | `packages/sync/src/sync-manager.js` | ~300 |
| proxy | `packages/proxy/src/proxy.js` | ~400 |
| pwa | `packages/pwa/src/main.ts` | ~500 |

### PlayerRestApi (CMS)
| File | Lines |
|------|-------|
| `custom/PlayerRestApi/Controller/PlayerRestApi.php` | 1115 |
| `custom/PlayerRestApi/Service/ScheduleJsonService.php` | 291 |
| `custom/PlayerRestApi/Middleware/PlayerAuthMiddleware.php` | 202 |
| `web/api/v2/player/index.php` | 156 |

### Upstream (for reference)
| Component | Key File |
|-----------|----------|
| .NET Layout | `/Rendering/Layout.xaml.cs` (1055 lines) |
| .NET Region | `/Rendering/Region.xaml.cs` (994 lines) |
| .NET Media | `/Rendering/Media.xaml.cs` (1058 lines) |
| .NET Schedule | `/Logic/ScheduleManager.cs` (1946 lines) |
| .NET Actions | `/Action/Action.cs` + handlers |
| C++ Layout | `/control/layout/MainLayoutParser.hpp` |
| C++ Region | `/control/region/RegionImpl.hpp` |
| C++ Schedule | `/schedule/Scheduler.hpp` |
| XIC | `/src/xibo-interactive-control.js` (626 lines) |
| XMR Client | `/src/modules/xmr/xmr.ts` (231 lines) — hardcoded 5/14 actions, rest silently dropped |
