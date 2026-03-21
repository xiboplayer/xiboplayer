# Changelog

## 0.7.3 (2026-03-21)

### Bug Fixes

- **Preload blob URL routing** — `_preloadingLayoutId` now reset after widget creation loop, preventing blob URLs from being tracked against the wrong layout
- **Overlay XIC completion** — removed identical ternary branches in `_advanceRegion` that caused overlay interactive control events to spuriously trigger main-layout completion checks
- **Advertise-sync port** — removed undefined `serverPort` reference in `POST /system/advertise-sync` endpoint (was silently defaulting to 8765)
- **API proxy headers** — use `SKIP_HEADERS` constant in API forward proxy, preventing stale `content-length` from being forwarded to clients
- **XLF fetch logging** — log warning on XLF fetch failure in `enqueueDownloads` instead of silently swallowing errors

### Refactoring (Code Audit)

- **Dead code removed** — PlayerState class, 5 dead methods (enqueueForLayout, prioritize, awaitAllPrepared, getMaxActivePriority, processOverlays), widgetTimers field, getCacheKey, _countUnsubmitted. Fixed stale type declarations (makeHot→setHot, remove→evict). Unexported internal fnvHash.
- **Stats/logs consolidation** — extracted shared `queryByIndex`/`deleteByIds` IDB helpers, `formatDateTime`/`escapeXml` formatters, and `enrichStatus` for notifyStatus
- **Renderer consolidation** — merged renderTextWidget/renderGenericWidget into `_renderIframeWidget`, extracted `_clearLayoutTimers` and `_createRegionEntry` helpers
- **Core split** — extracted `_processRegistration` and `_applyNewSchedule` from 253-line `collect()`, replaced `schedule._scheduleQueue` leak with `invalidateQueue()`
- **PWA split** — extracted `setupSyncEventHandlers`, `setupDownloadEventHandlers`, `setupCommandEventHandlers` from 479-line `setupCoreEventHandlers()`, merged duplicate `REGISTER_COMPLETE` handler
- **CORE_EVENTS** — added `CACHE_ANALYSIS`, `SUBMIT_FAULTS_REQUEST`, `COLLECTION_INTERVAL_SET` constants
- **Proxy cleanup** — removed redundant dynamic `import('stream')`

### Stats

- 99 audit findings addressed (5 bugs, 18 dead code, 24 duplications, 18 complexity)
- Net code reduction: ~900 lines removed
- 1588 unit tests passing, 0 skipped

## 0.7.2 (2026-03-20)

### Features

- **Shared content cache** — all player instances on the same machine share a single ContentStore at `~/.local/share/xiboplayer/shared/cache/{cmsId}/media/`. A 4-display video wall downloads each file once instead of 4 times. Safe: atomic writes via temp+rename.
- **Cache migration** — on first startup, hardlinks files from old per-instance cache dirs to the shared path, then removes old dirs. Zero-copy, instant. Remove after v0.7.3.
- **Playwright e2e tests (T1)** — 10 end-to-end tests covering setup screen, config injection, CMS registration, schedule fetch, keyboard controls (D, S), and status bar.

### Fixes

- **Startup layout storm** — layouts no longer cycle at 60s on non-fresh starts. Root cause: `_hasUnprobedVideos()` checked `widget.duration === 0` but XLF always provides `duration="60"` for videos with `useDuration=0`. Fix: check `widget._probed` flag set by `loadedmetadata` event.
- **POST /config preserves controls** — sync persist no longer strips `controls` and `logLevel` from the injected PWA config. Config.json write-back now includes `currentPwaConfig` in the merge chain.

### Tests

- Video duration tests unskipped (T4) — patched jsdom `HTMLMediaElement` prototype with writable `duration`/`currentTime`. 5 tests unskipped + 1 new test. Total: 1620 tests, 0 skipped.

## 0.7.1 (2026-03-19)

### Features

- **mDNS auto-discovery for sync** — sync leads advertise via `_xibo-sync._tcp` (bonjour-service); followers discover the lead's IP and port automatically via mDNS browse. Zero manual IP configuration needed for video walls.
- **`GET /system/lan-ip`** — proxy endpoint returns the machine's LAN IPv4 address, enabling Chromium kiosk to report its IP to the CMS (previously Electron-only).
- **`GET /system/discover-lead`** — proxy endpoint runs mDNS browse and returns the lead's host/port for a given sync group.
- **`POST /system/advertise-sync`** — runtime mDNS advertisement trigger, called by the PWA when sync config arrives from CMS.
- **CORE_EVENTS constants** — 28 event name constants shared between PlayerCore and platform layers, preventing silent typo bugs at the core/platform boundary.
- **Shared `openIDB` helper** — consolidated IndexedDB open boilerplate across 5 call sites into a single shared function in `@xiboplayer/utils`.

### Fixes

- **Follower relay URL always re-discovered** — followers no longer reuse stale persisted relay URLs; mDNS re-discovers the lead's IP on each collection cycle.
- **Bonjour named import** — fixed `TypeError: Bonjour is not a constructor` by using named import `{ Bonjour }`.
- **setup.html config save in Electron** — setup page now uses `electronAPI.setConfig` (via `window.parent`) instead of `POST /config` which hangs in Electron's session handler.

### Refactoring

- Replaced 86 lines of duplicated IndexedDB open boilerplate with shared `openIDB()` helper
- Replaced 35+ event string literals in main.ts with `CORE_EVENTS` constants

## 0.6.12 (2026-03-13)

### Features

- **XMDS file download caching** — XMDS signed URLs (`xmds.php?file=...`) now route through the cache-through proxy, eliminating CORS failures and enabling ContentStore caching for all XMDS content types (layouts, media, fonts, bundles)
- **Idempotent cache-through architecture** — both REST and XMDS transports converge on the same proxy mirror paths (`/player/api/v2/{layouts,media,dependencies}/...`), making the ContentStore transport-agnostic. Files cached via XMDS are served identically to REST-cached files
- **`X-Cms-Download-Url` header** — when the proxy receives this header on a cache miss, it fetches from the provided CMS URL instead of building a REST API path. Enables XMDS-only CMSes (without REST endpoints) to use the full cache-through pipeline

### Fixes

- **Layout XLF 500 errors on XMDS** — layout XLFs are now correctly rewritten to `/player/api/v2/layouts/{id}` (matching the renderer's lookup path) instead of `/media/file/{id}.xlf`
- **XMDS download CORS failures** — Service Worker intercepts cross-origin `xmds.php` URLs and rewrites them to local proxy paths before the browser attempts the fetch

## 0.6.4 (2026-03-06)

### Features

- **Cross-device multi-display sync** via WebSocket relay (`@xiboplayer/sync`)
- **Shell command execution** from CMS — remote commands via XMR
- **Per-CMS cache and config storage** — multiple CMS instances don't collide
- **Video controls** — press `v` to toggle native video controls (reaches into widget iframes)

### Fixes

- **FD leak** — close ReadStream file descriptors in serveFromStore and serveChunkedFile
- **V8 OOM** — reduce chunk download concurrency to prevent heap exhaustion on large files
- **Video duration** — use exact duration instead of Math.floor truncation
- **Timeline overlay** — wall-clock countdown with chained times, accurate image-only layouts
- **Layout render failure** — set status code 3 so CMS marks display as error
- **Geolocation** — cache result and skip browser API after first failure
- **Config gate** — fix per-CMS storage key isolation

### Refactoring

- **Canonical API path** — `PLAYER_API` default changed from `/api/v2/player` to `/player/api/v2`, matching CMS `.htaccess` routing. All hardcoded paths replaced with the `PLAYER_API` variable; single source of truth in `@xiboplayer/utils`
- **CmsClient interface** — formalized with conformance checks for REST/SOAP transports
- **Config consolidation** — add Config getters, fix relaxSslCerts leak
- **Rename** PlayerApiV2 → PlayerRestApi across all references
