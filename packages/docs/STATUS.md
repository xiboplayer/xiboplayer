# PWA Player Status - v0.6.3

## Current Status: PRODUCTION READY

**Feature Parity:** ~98% vs upstream Xibo players
**Last Updated:** 2026-03-05
**Audit:** See [AUDIT.md](AUDIT.md) for full spec compliance results

## What's New in v0.6.3

### Canvas Regions
- Full canvas region support — layouts with canvas-type regions render correctly alongside standard regions

### Protocol Auto-Detection
- Player probes `/api/v2/player/auth` at startup and auto-selects REST or SOAP transport
- Zero configuration — works with any CMS version

### Persistent Layout Durations (IndexedDB)
- Layout durations cached in IndexedDB — on restart, the timeline and queue use correct durations immediately instead of 60s defaults
- Three-phase correction: XLF parse → video metadata probe → renderer DURATION comments

### XIC Interactive Control Handlers
- Renderer fires XIC events for widget interactions — enables interactive digital signage workflows

### Missing Media Timeline Overlay
- Timeline overlay highlights layouts with missing/uncached media in red
- Helps diagnose content delivery issues at a glance

### Download Resume
- Incomplete chunked downloads resume from last successful chunk instead of re-downloading entirely

### Sub-Playlist & Drawer Fixes
- Sub-playlist playCount enforcement — widgets respect their configured play count per cycle
- Drawer navigation via triggerCode and multi-widget re-hide works correctly

### Full REST API Support (v0.6.0)
First Xibo player to implement the complete CMS REST API (`/api/v2/player/*`). See [REST.md](REST.md) for full documentation.

- **Auto-detection** — player probes `/api/v2/player/auth` and falls back to SOAP
- **JWT authentication** — authenticate once, reuse token for all requests
- **ETag 304 caching** — unchanged schedule/media responses return 0 bytes
- **Dependency pipeline** — widget assets (JS, CSS, fonts, images) downloaded via dedicated endpoints
- **No SOAP dependency** — works on CMS deployments without PHP ext-soap

## What Works

### XMDS Communication (14/14 Methods)
- RegisterDisplay - Authentication, settings, XMR address
- RequiredFiles - File list with CRC32 skip optimization
- Schedule - Layout schedule with actions, commands, data connectors
- GetResource / GetWidgetHtml - Server-rendered widget content
- MediaInventory - Report cached file inventory
- NotifyStatus - Status with disk usage and timezone
- SubmitLog - CMS log submission with fault reporting
- SubmitStats - Proof-of-play with aggregation
- SubmitScreenShot - Periodic + on-demand screenshot capture
- BlackList - Media blacklisting via SOAP and REST
- GetFile - Chunked parallel download
- ReportFaults - Fault tracking with deduplication
- GetWeather - Weather data for schedule criteria evaluation

### Dual Transport (PWA Exclusive)
- SOAP/XML transport (XmdsClient) - All CMS versions
- **REST/JSON transport (RestClient)** - JWT auth, ETag caching, dependency pipeline, CDN-compatible
- Auto-detection with SOAP fallback

### Layout Rendering (RendererLite)
- Full XLF parsing with layout scaling and centering
- Image, video, audio, text, clock, webpage, embedded, PDF (multi-page cycling), HLS, dataset widgets
- Fade and fly transitions (8 compass directions)
- Element reuse pattern (pre-create all, toggle visibility)
- Parallel media prefetch (Promise.all)
- Background images and colors
- ResizeObserver for dynamic rescaling
- Blob URL lifecycle tracking (no memory leaks)

### Schedule Management
- Priority-based layout selection
- Dayparting with ISO day-of-week and midnight crossing (Week/Day/Month recurrence)
- maxPlaysPerHour with even distribution
- Campaign scheduling (first-class objects)
- Interrupt/share-of-voice interleaving
- Overlay management with priority-based z-index
- Action events, command events, data connector events
- Default layout fallback
- Geo-fencing enforcement (haversine distance filtering)
- Criteria enforcement (evaluateCriteria with 5 metrics + weather + custom display properties)
- Browser Geolocation API fallback (when CMS has no coordinates)

### XMR Push Messaging (13 Handlers)
- collectNow, screenShot, licenceCheck
- changeLayout, overlayLayout, revertToSchedule
- purgeAll, commandAction, triggerWebhook
- dataUpdate, criteriaUpdate, currentGeoLocation, rekey
- RSA key pair generation and registration (Web Crypto API)
- Key rotation via rekey command
- Exponential backoff reconnection (10 attempts)

### Interactive Control
- Full IC server via postMessage
- Touch/click action triggers
- Keyboard action triggers
- Navigate to layout, navigate to widget
- Previous/next widget navigation
- Duration control (expire, extend, set)
- Fault reporting endpoint
- Real-time data connector endpoint

### Stats and Logging
- Layout and widget proof-of-play (StatsCollector, IndexedDB)
- Stats aggregation (hourly grouping, configurable level)
- Log submission to CMS (LogReporter, IndexedDB)
- Fault reporting with deduplication (5-min cooldown)
- Replay-safe tracking (auto-end previous on replay)
- Quota-exceeded cleanup (auto-delete oldest 100)

### Cache and Offline
- 4 parallel chunk downloads (1-2 min for 1GB vs 5 min sequential)
- Dynamic chunk sizing based on device RAM
- MD5 verification (spark-md5)
- Corrupted cache auto-detection and cleanup
- Font CSS URL rewriting
- Widget HTML caching via Service Worker
- Progressive streaming (Range request support)
- Full offline mode (IndexedDB fallback for schedule, settings, required files)
- Persistent storage (navigator.storage.persist())

### Config and Settings
- Stable hardware key (FNV-1a hash, "pwa-" prefix)
- DisplaySettings class with EventEmitter
- CMS log level control
- Download window support
- Screenshot interval configuration
- Configurable log level (config.json logLevel)
- SSL certificate relaxation (relaxSslCerts config option)
- Wake Lock API (screen sleep prevention)
- Centralized PlayerState

### Screenshot Capture
- Primary: getDisplayMedia (native browser capture including video)
- Fallback: html2canvas (DOM rendering)
- Triggers: XMR command, periodic interval
- Submission: SOAP or REST

### Multi-Platform
- PWA (primary) - Any browser, installable
- Electron - Desktop wrapper (XLR fork)
- Android - WebView wrapper
- webOS - Cordova wrapper

## Known Gaps (0 remaining of 15 tracked)

All 15 audit issues resolved (PRs #86–#90). 8 implemented, 5 closed as already done, 2 closed as not needed.

### Closed
- [#84](https://github.com/xibo-players/xiboplayer/issues/84) Adspace exchange / SSP ad rotation — closed, CMS API undocumented/unstable; `isSspEnabled` stub sufficient

### Not Applicable (Browser Sandbox)
- Shell commands (use HTTP commands instead)
- RS232 serial port (N/A in browser)

## Test Suite

```
Tests:  1412 passed | 5 skipped (1417 total)
Files:  36 test files (all passed)
Time:   ~10s
```

## Performance

| Metric | PWA | XLR v1.0.22 | Windows v4 R406 |
|--------|------------|-------------|-----------------|
| Initial load | 3-5s | 17-20s | 5-10s |
| Layout replay | <0.5s | 2-3s | 1-2s |
| 1GB download | 1-2 min | ~5 min | ~5 min |
| Widget switch | <50ms | ~200ms | ~100ms |
| Bundle size | ~500KB | ~2MB | ~50MB |
| Memory (10 cycles) | Stable | +500MB | Stable |

## Code Statistics

| Category | Lines | Files |
|----------|-------|-------|
| Core packages (src) | ~22,200 | 67 source files |
| Platform (PWA) | ~2,400 | TypeScript |
| Tests | ~23,500 | 51 test files |
| **Total** | **~48,000** | **~118 files** |

## Build and Test

```bash
# Unit tests (all packages)
pnpm test

# Specific package
pnpm test --filter @xiboplayer/core
pnpm test --filter @xiboplayer/renderer

# Build PWA (from monorepo root)
pnpm --filter @xiboplayer/pwa build
```

## Browser Compatibility

| Browser | Version | Tested |
|---------|---------|--------|
| Chrome | 90+ | Yes |
| Firefox | 88+ | Yes |
| Edge | 90+ | Yes |
| Safari | 14+ | Expected |
| Chrome Android | 90+ | Expected |
| webOS Browser | 3.0+ | Expected |

## Related Documentation

- Architecture: `packages/docs/ARCHITECTURE.md`
- REST API: `packages/docs/REST.md`
- Spec Audit: `packages/docs/AUDIT.md`
- Renderer comparison: `packages/renderer/docs/RENDERER_COMPARISON.md`
- Deployment guide: `packages/docs/DEPLOYMENT.md`
