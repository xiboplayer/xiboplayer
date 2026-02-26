# Xibo Player SDK Architecture

Technical architecture of the Xibo Player SDK.

## Design Philosophy

Build a **platform-independent, modular player** that:
- Separates core logic from platform-specific code
- Works across PWA, Electron, Android WebView, and webOS Cordova
- Uses browser-native APIs (IndexedDB, Service Worker, Web Animations) + filesystem ContentStore via proxy
- Avoids framework bloat (no React, Vue, or Angular)
- Matches or exceeds upstream player performance
- Supports both SOAP and REST CMS transports

## System Architecture

```
                        ┌─────────────────────────────────────────────────────┐
                        │              Platform Layer (pwa/main.ts)           │
                        │  PwaPlayer: wires all packages together            │
                        │  Wake Lock, Screenshot, SW registration            │
                        └──────────────────────┬──────────────────────────────┘
                                               │
        ┌──────────────────────────────────────┼──────────────────────────────────┐
        │                                      │                                  │
┌───────┴────────┐  ┌─────────┴─────────┐  ┌──┴──────────────┐  ┌───────────────┐
│  PlayerCore    │  │  RendererLite     │  │  Service Worker  │  │  XmrWrapper   │
│  (982 lines)   │  │  (2119 lines)     │  │  (sw-pwa.js)     │  │  (359 lines)  │
│                │  │                   │  │  1667 lines      │  │               │
│ Orchestration  │  │ XLF rendering    │  │                   │  │ WebSocket     │
│ Collection     │  │ Element reuse    │  │ Chunk streaming   │  │ 13 commands   │
│ Schedule sync  │  │ Transitions      │  │ Range requests    │  │ Reconnect     │
│ Offline cache  │  │ Touch/keyboard   │  │ IC interception   │  │               │
│ CRC32 skip     │  │ HLS (hls.js)     │  │ Font rewriting    │  │               │
│ Commands       │  │ PDF (PDF.js)     │  │ Cache-first       │  │               │
│ Data connectors│  │ IC server        │  │ Offline fallback   │  │               │
│ Webhooks       │  │ Overlays         │  │                   │  │               │
└───────┬────────┘  └──────────────────┘  └───────────────────┘  └───────────────┘
        │
        ├───────────────────────────┬───────────────────────┬──────────────────┐
        │                           │                       │                  │
┌───────┴──────────┐  ┌────────────┴────────┐  ┌──────────┴──────┐  ┌────────┴───────┐
│  XmdsClient      │  │  ScheduleManager    │  │  StoreClient    │  │  StatsCollector │
│  (371 lines)     │  │  (346 lines)        │  │  + DlClient     │  │  (633 lines)    │
│  + RestClient    │  │  + Interrupts       │  │  + DlManager    │  │  + LogReporter  │
│  (332 lines)     │  │  (298 lines)        │  │  (424 lines)    │  │  (541 lines)    │
│                  │  │  + Overlays         │  │                 │  │                 │
│ SOAP + REST      │  │  (155 lines)        │  │                 │  │ Proof-of-play   │
│ Dual transport   │  │                     │  │  REST → proxy   │  │ Fault reporting  │
│ All 10 methods   │  │ Dayparting          │  │ ContentStore    │  │ Log submission   │
│ ETag caching     │  │ maxPlaysPerHour     │  │ MD5 validation  │  │ Aggregation     │
│ CRC32 skip       │  │ Campaigns           │  │ Parallel dl     │  │ IndexedDB       │
│                  │  │ ShareOfVoice        │  │ MD5 validation  │  │                 │
└──────────────────┘  └─────────────────────┘  └─────────────────┘  └─────────────────┘
        │
        ├──────────────────────┬──────────────────────┐
        │                      │                      │
┌───────┴──────────┐  ┌───────┴──────────┐  ┌────────┴───────┐
│  DisplaySettings │  │  PlayerState     │  │  Utils         │
│  (352 lines)     │  │  (54 lines)      │  │                │
│                  │  │                  │  │ Config (288)   │
│ CMS settings     │  │ Centralized      │  │ Logger (237)   │
│ EventEmitter     │  │ state store      │  │ EventEmitter   │
│ Log level        │  │                  │  │ (77)           │
│ Download windows │  │                  │  │ FetchRetry (61)│
│ Screenshot cfg   │  │                  │  │ CmsApi (656)   │
└──────────────────┘  └──────────────────┘  └────────────────┘
```

## Package Breakdown

| Package | Main File | Lines | Purpose |
|---------|-----------|-------|---------|
| `@xiboplayer/core` | `player-core.js` | 982 | Platform-independent orchestration, collection cycle, offline cache |
| `@xiboplayer/core` | `state.js` | 54 | Centralized player state with EventEmitter |
| `@xiboplayer/core` | `data-connectors.js` | 198 | DataConnectorManager with polling |
| `@xiboplayer/renderer` | `renderer-lite.js` | 2,119 | XLF renderer: element reuse, transitions, HLS, PDF, IC server |
| `@xiboplayer/cache` | `store-client.js` | — | StoreClient: REST client for ContentStore (has/get/put/remove/list) |
| `@xiboplayer/cache` | `download-client.js` | — | DownloadClient: SW postMessage client for background downloads |
| `@xiboplayer/cache` | `download-manager.js` | 424 | DownloadManager: 4-chunk parallel, dynamic sizing |
| `@xiboplayer/schedule` | `schedule.js` | 346 | ScheduleManager: dayparting, campaigns, maxPlaysPerHour |
| `@xiboplayer/schedule` | `interrupts.js` | 298 | InterruptScheduler: share-of-voice interleaving |
| `@xiboplayer/schedule` | `overlays.js` | 155 | Overlay scheduling with priority and criteria |
| `@xiboplayer/xmds` | `xmds-client.js` | 371 | SOAP transport: all 10 XMDS v5 methods |
| `@xiboplayer/xmds` | `rest-client.js` | 332 | REST transport: JSON payloads, ETag 304 caching |
| `@xiboplayer/xmr` | `xmr-wrapper.js` | 359 | XMR WebSocket: 13 command handlers, exponential backoff |
| `@xiboplayer/stats` | `stats-collector.js` | 633 | Proof-of-play: layout/widget tracking, aggregation, IndexedDB |
| `@xiboplayer/stats` | `log-reporter.js` | 541 | CMS logging: fault reporting with dedup, IndexedDB persistence |
| `@xiboplayer/settings` | `settings.js` | 352 | DisplaySettings: CMS settings parser with EventEmitter |
| `@xiboplayer/utils` | `config.js` | 288 | Configuration: hardware key, CMS address, localStorage |
| `@xiboplayer/utils` | `logger.js` | 237 | Logger: level-based, CMS sink integration |
| `@xiboplayer/utils` | `event-emitter.js` | 77 | EventEmitter base class |
| `@xiboplayer/utils` | `fetch-retry.js` | 61 | fetchWithRetry: configurable retry with backoff |
| `@xiboplayer/utils` | `cms-api.js` | 656 | CMS API helpers |
| `@xiboplayer/crypto` | `rsa.js` | 75 | RSA key pair generation via Web Crypto API |

**Total source code: ~12,000 lines** (excluding tests)

## Key Design Patterns

### 1. Platform-Independent Core

PlayerCore contains all business logic without platform assumptions. The platform layer (e.g. `main.ts` in xiboplayer-pwa) wires packages together and provides platform-specific implementations (Wake Lock, screenshot capture, Service Worker registration).

This enables code reuse: the same PlayerCore works in Electron, Android WebView, and webOS Cordova.

### 2. EventEmitter Communication

All modules communicate via events, not direct method calls:

```
PlayerCore emits:  schedule-updated, collection-complete, purge-request, ...
RendererLite emits: layoutStart, layoutEnd, widgetStart, widgetEnd, action-trigger, ...
StatsCollector listens: layoutStart, layoutEnd, widgetStart, widgetEnd
LogReporter listens: reportFault calls from IC, renderer errors, collection errors
```

### 3. Dual Transport (SOAP + REST)

The XMDS package provides two transport implementations with identical API surfaces:

- **XmdsClient** (SOAP/XML) - Traditional protocol, compatible with all CMS versions
- **RestClient** (REST/JSON) - PWA-exclusive, 30% smaller payloads, ETag 304 caching

Selectable per deployment; the PlayerCore does not know which transport is active.

### 4. Element Reuse (Arexibo Pattern, Refined)

RendererLite pre-creates ALL widget DOM elements at layout load time, stores them in a Map, and toggles visibility instead of recreating DOM nodes. This eliminates DOM thrashing and enables instant layout replay (<0.5s).

```
Layout load:  Pre-create all elements -> widgetElements.set(widgetId, element)
Widget switch: Hide current -> Show next (visibility toggle, no DOM create/destroy)
Layout replay: Detect isSameLayout -> Reuse elements -> Restart videos (currentTime=0)
Layout change: Revoke all blob URLs -> Destroy all elements -> Create new set
```

### 5. Service Worker as Media Server

Instead of running a local HTTP server (like Arexibo's tiny_http on port 9696), the PWA uses its Service Worker to intercept fetch requests and serve cached media. This also enables:

- **Chunk streaming** with Range request support for large videos
- **IC interception** (Interactive Control routes served by the SW)
- **Font CSS URL rewriting** (rewrites `url()` references to local cache paths)
- **Cache-first strategy** with network fallback
- **Offline operation** using pre-cached content

## Data Flow

### Collection Cycle (every 5-900 seconds, configurable)

```
1. RegisterDisplay()        -> CMS settings, commands, XMR address
2. CRC32 comparison         -> Skip RequiredFiles/Schedule if unchanged
3. RequiredFiles()          -> File list with MD5 hashes
4. Download missing files   -> 4 parallel chunks, MD5 verify, font rewrite
5. Schedule()               -> Layout schedule XML
6. Parse schedule           -> Layouts, overlays, actions, data connectors, commands
7. MediaInventory()         -> Report cached file inventory
8. NotifyStatus()           -> Report status (disk, timezone, current layout)
9. SubmitStats()            -> Proof-of-play records
10. SubmitLog()             -> Queued log entries
11. SubmitScreenShot()      -> If screenshot was captured
```

### Layout Rendering

```
1. ScheduleManager selects layout (priority, dayparting, campaigns)
2. RendererLite receives XLF content
3. Parse layout: dimensions, background, regions, widgets
4. Pre-create ALL widget elements (img, video, iframe, etc.)
5. Prefetch ALL media URLs in parallel (Promise.all)
6. Start first widget in each region (visibility: visible)
7. Cycle widgets on duration expiry (visibility toggle)
8. Emit events: layoutStart, widgetStart, widgetEnd, layoutEnd
9. StatsCollector records proof-of-play
10. On layout change: revoke blob URLs, destroy elements, start new layout
```

### Offline Mode

```
Network down:
  -> XMDS calls fail -> PlayerCore uses IndexedDB-cached schedule/settings/requiredFiles
  -> Media requests -> Service Worker routes to proxy ContentStore (filesystem)
  -> Stats/logs -> Queued in IndexedDB, submitted when network returns
  -> Player continues rendering with last known schedule
```

## Storage Architecture

### ContentStore (Filesystem via Proxy)

All binary content is stored on the filesystem via the proxy's ContentStore.
The Service Worker intercepts fetch requests and routes them to `/store/*` REST endpoints.

```
~/.config/xiboplayer/{electron,chromium}/content-store/
├── media/
│   ├── 12.bin              -> Media files (images, videos)
│   └── 12.meta.json        -> { contentType, size, cachedAt, md5 }
├── layout/
│   └── 472.bin             -> XLF layout XML
├── widget/
│   └── 472/221/190.bin     -> Widget HTML
└── static/
    ├── bundle.min.js.bin   -> Widget JS bundle
    ├── fonts.css.bin        -> Font CSS
    └── Aileron-Heavy.otf.bin -> Font files
```

No Cache API is used anywhere. Zero `caches.open()` calls.

### IndexedDB (Structured Data)

```
Database: xibo-player
├── files          -> File metadata (id, type, md5, size, cachedAt)
├── stats          -> Proof-of-play records (pending submission)
├── logs           -> Log entries (pending submission)
├── schedule       -> Last known schedule XML (offline fallback)
├── settings       -> Last known CMS settings (offline fallback)
└── requiredFiles  -> Last known required files (offline fallback)
```

### localStorage (Configuration)

```
{
  cmsUrl: "https://cms.example.com",
  cmsKey: "server-key-from-cms",
  hardwareKey: "pwa-a1b2c3d4...",       // FNV-1a hash with pwa- prefix
  displayName: "Lobby Display",
  xmrChannel: "auto-generated-uuid",
  displayId: 42,                         // From RegisterDisplay
  transportType: "soap"                  // or "rest"
}
```

## Technology Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Language | JavaScript (ES2020+) + TypeScript (platform layer) | Cross-platform, no transpilation for core |
| Module system | ES modules | Native browser support |
| HTTP client | `fetch()` + fetchWithRetry wrapper | Built-in, promise-based, configurable retry |
| XML parsing | `DOMParser` | Built-in, namespace-aware |
| Storage | ContentStore (filesystem via proxy) + IndexedDB | Durable filesystem storage, offline-first |
| Offline | Service Worker | Built-in, intercepts all fetches |
| MD5 hashing | spark-md5 | Tiny (4KB), ArrayBuffer support |
| PDF rendering | PDF.js (lazy-loaded) | Industry standard, canvas-based |
| HLS streaming | hls.js (lazy-loaded) | Polyfill for non-Safari browsers |
| XMR client | @xibosignage/xibo-communication-framework | Official Xibo WebSocket library |
| Animations | Web Animations API | Built-in, GPU-accelerated |
| Build tool | Vite | Fast dev server, tree-shaking, minification |
| Package manager | pnpm workspaces | Workspace management |

**Runtime dependencies:** spark-md5 (4KB), hls.js (lazy), PDF.js (lazy), xibo-communication-framework

## Comparison with Upstream Players

| Aspect | XLR/Electron | Windows (.NET) | Arexibo (Rust) | PWA (This Repo) |
|--------|-------------|----------------|----------------|------------------|
| Language | TypeScript | C# | Rust + C++ | JS/TS |
| Rendering | XLR library | CEF WebView | Qt WebEngine | RendererLite |
| Transport | SOAP only | SOAP only | SOAP only | SOAP + REST |
| Media serving | Express | File system | tiny_http | Service Worker |
| XMR | WebSocket | ZeroMQ/WS | ZeroMQ + RSA | WebSocket |
| Platform | Desktop | Windows | Linux | Any browser |
| Core reuse | Electron-coupled | Monolithic | Monolithic | Platform-independent |
| Total code | ~15,000 lines | ~50,000 lines | ~8,000 lines | ~12,000 lines |

See `packages/renderer/docs/RENDERER_COMPARISON.md` for detailed renderer comparison.

## Performance Characteristics

### Measured Performance

| Metric | Value | Notes |
|--------|-------|-------|
| Initial load (cold) | 3-5s | Includes SW registration + first collection |
| Layout replay | <0.5s | Element reuse + visibility toggle |
| 1GB download | 1-2 min | 4 parallel chunks, dynamic sizing |
| Widget switch | <50ms | Visibility toggle, no DOM recreation |
| Bundle size | ~500KB | Minified, excluding lazy-loaded deps |
| Memory (10 cycles) | Stable | Blob URL lifecycle tracking |

### Why It Is Fast

1. **Parallel chunk downloads** - 4 concurrent streams, chunk size adapts to device RAM
2. **Element reuse** - Pre-create all widget DOM elements at layout load, toggle visibility
3. **Parallel media prefetch** - Promise.all for all media URLs before rendering starts
4. **Service Worker streaming** - Range request support, no full-file blocking
5. **Blob URL lifecycle** - Per-layout tracking, revoke on layout switch (no memory leaks)
6. **CRC32 skip** - Skip RequiredFiles/Schedule if CMS data is unchanged

## Security Model

### Authentication
- **CMS**: Server key + hardware key in every XMDS/REST request
- **XMR**: Channel token from RegisterDisplay response + RSA public key registration
- **Display**: Hardware key generated from FNV-1a hash of device fingerprint
- **RSA keys**: Generated via Web Crypto API (RSA-1024), sent in RegisterDisplay, rotatable via XMR rekey command

### Storage Security
- All storage (ContentStore filesystem, IndexedDB, localStorage) is local to the device
- Service Worker only routes same-origin requests to the proxy
- No external requests except to configured CMS and XMR addresses

### Content Isolation
- Widget HTML runs in sandboxed iframes
- Interactive Control uses postMessage (no direct DOM access)
- Service Worker validates cached responses

## Browser Compatibility

| Browser | Version | Status |
|---------|---------|--------|
| Chrome | 90+ | Full support |
| Firefox | 88+ | Full support |
| Edge | 90+ | Full support |
| Safari | 14+ | Full support (Service Worker available on iOS 14+) |
| Chrome Android | 90+ | Full support |
| webOS Browser | 3.0+ | Expected to work |

### Required APIs
- ES2020 (async/await, optional chaining, nullish coalescing)
- IndexedDB, Service Workers
- Web Animations API
- Screen Wake Lock API (optional, for kiosk mode)
- fetch() with AbortController

## Platform Integration

### PWA (Primary)
Direct browser access. Install as PWA via "Add to Home Screen". Full offline capability.

### Electron
Wrap with Electron shell. PlayerCore + RendererLite reused; platform layer provides native screenshot (webContents.capturePage), file system cache, and native kiosk mode.

### Android WebView
Load in Android WebView with JavaScript and DOM storage enabled. Same Service Worker and ContentStore architecture. Platform layer provides Android-specific wake lock and screenshot.

### webOS Cordova
Load in Cordova WebView. XMR service runs separately as Node.js process (ZeroMQ bridge). Platform layer handles webOS-specific display management.

## Code Statistics

| Category | Lines | Files |
|----------|-------|-------|
| Core packages | ~7,500 | 20 source files |
| Platform (PWA) | ~3,200 | 2 files (main.ts + sw-pwa.js) |
| Tests | ~3,000+ | 12 test files |
| **Total source** | **~12,000** | **~22 files** |

Compare with v0.1 (870 lines, 6 files). The codebase has grown 14x while maintaining zero framework dependencies.
