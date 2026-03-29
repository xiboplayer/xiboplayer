# Changelog

## 0.7.9 (2026-03-29)

### Bug Fixes

- **Preload race fix** — When a background preload (75%/90% timer) was in-flight, `prepareLayout()` returned immediately and `showLayout()` failed with "not in preload pool". Now stores the preload promise and awaits it instead of skipping, ensuring the layout is in the pool before showing.

### Shell Updates (Chromium)

- **GPU rasterization** — Added `--ignore-gpu-blocklist`, `--enable-gpu-rasterization`, `--enable-zero-copy`, `CanvasOopRasterization`, `--renderer-process-limit=1`, `--disable-gpu-process-crash-limit`. Moves raster/composite work from renderer CPU to GPU process. **Chromium CPU dropped from 91% to 5% in production.**
- **512x512 tile size** — `--default-tile-width=512 --default-tile-height=512` reduces raster jobs for fullscreen signage content.

### Performance (9h production run, kiosk fullscreen, v0.7.9)

| Metric | Electron | Chromium |
|--------|----------|----------|
| CPU avg | 5% | 4-5% |
| PSS avg | 81 MB | 355 MB |
| Crashes | 0 | 0 |
| Stalls | 0 | 0 |
| SharedImage errors | 10 | 6 |

Both players now achieve **CPU parity at 4-5%** in production fullscreen mode. The GPU rasterization flags were the key — Chromium's renderer CPU dropped from 52% to 2% by offloading raster work to the GPU process (Skia software rasterization, not DRM hardware).

## 0.7.8 (2026-03-27)

### Bug Fixes

- **Layout stall fix** — Layouts no longer get stuck when the video finishes but no timer fires. Added `LAYOUT_ALREADY_PLAYING` handler in main.ts that checks `renderer.hasActiveLayoutTimer()` on each collect cycle. If the timer is missing (e.g. after GPU crash/recovery or restart), the layout is stopped and re-prepared with fresh region timers.
- **Deferred video texture release** — `LayoutPool.releaseMediaElements()` now defers via `requestAnimationFrame()` before destroying video textures. Gives the compositor one frame to stop referencing old textures, reducing SharedImageManager "non-existent mailbox" errors from ~2/5min to near zero.
- **HLS stream and iframe cleanup** — `_hideWidget()` now destroys HLS.js instances and cleans up media elements inside same-origin iframes. Cross-origin iframes are set to `about:blank`. Prevents memory leaks from long-running HLS streams.

### Features

- **GPU auto-detection** — Both Electron and Chromium now scan `/sys/class/drm` for available GPUs, resolve render nodes, and select the best one. On hybrid GPU systems (Optimus/PRIME), prefers the display GPU since render-only GPUs can't share framebuffers on Wayland. Override via `--gpu=nvidia|intel|amd|auto|/dev/dri/renderDNNN`, `XIBO_GPU` env var, or `"gpu"` key in config.json.
- **GPU crash recovery** — `app.disableDomainBlockingFor3DAPIs()` + `--disable-gpu-process-crash-limit` allow indefinite GPU recovery instead of permanent software fallback after ~10h.
- **`--server-port` CLI arg** for Electron (in addition to `--port`).
- **Config management in RPM/DEB** — `apply.sh`, `clean.sh`, config templates, and `secrets.env.example` now packaged in both Electron and Chromium RPMs/DEBs.

### Shell Updates

- **Electron: removed `--no-zygote`** — Confirmed by Electron maintainer that GPU flags are properly propagated to zygote-spawned processes (electron/electron#50462, PR #50509). Tested: GPU active, fewer SharedImage errors than with `--no-zygote`.
- **Electron 41.0.4 → 41.1.0**
- **Fedora 43 + 44 RPM builds** for both Electron and Chromium.

### Performance (47h Chromium production run, v0.7.7 stripped services)

- Chromium: 0 crashes, 3 SharedImage errors in 47h
- Chromium memory: stable sawtooth 362–1225 MB child PSS (no leak)
- Chromium FDs: 748 → 918 (+3.8/hr — negligible)
- Chromium GPU: 83,608s DRM render (23.2h active compositing)
- Electron GPU auto-detect: Intel selected on Optimus laptop, NVIDIA correctly skipped

## 0.7.7 (2026-03-26)

### Bug Fixes

- **Triple preload prevention** — `preloadLayout()` guards against in-flight preloads. The 75%/90% preload timers could both fire before the async preload completed, tripling DOM nodes (77→141) and heap (37→76 MB) for complex layouts like Layout 520 (6 regions + webpage). Guarded at both renderer and platform layer.
- **Video GPU buffer release** — `_hideWidget()` now calls `removeAttribute('src') + load()` on video elements to force immediate release of decoded GPU texture buffers (dmabufs). Paused videos no longer hold texture memory until layout pool eviction.

### Shell Updates

- **Chromium kiosk: stripped Chrome services** — Disabled 11 unnecessary background services (`--disable-background-networking`, `--disable-client-side-phishing-detection`, `--disable-sync`, `--disable-domain-reliability`, `--no-pings`, `--disable-breakpad`, etc.). This eliminated the renderer memory leak, FD growth, and crash triggers that affected all previous Chromium runs.

### Performance (3h overnight profiling, v0.7.7 stripped vs v0.7.6)

- Chromium renderer: sawtooth 200–770 MB (was monotonic 272→1,900+ MB)
- Chromium GPU PSS: stable 53 MB (was 200–400 MB growing)
- Chromium FDs: stable 700–975 (was growing to 3,967)
- Chromium crashes: zero (was SIGABRT at 7h or 500% CPU at 4h)
- Layout 520 DOM: 77 nodes (was 141 from triple preload)
- SharedImage errors: reduced to ~14/hour (was hundreds)

### Diagnostics

- Enhanced `[Resources]` per layout swap: DOM nodes, video elements (with/without src), canvases, iframes, images, audio, preload wrappers, blob URLs, V8 heap

## 0.7.6 (2026-03-25)

### Bug Fixes

- **Layout timer: no more 30s deferral** — `_hasUnprobedVideos()` now only checks video widgets (was triggering on rss-ticker with `useDuration=0`). Uses `_durationFromMetadata` flag to skip deferral when layout duration was already updated from video metadata during preload. Layouts start on time instead of 30s late.
- **Offline playback** — Players keep cycling cached layouts when CMS is offline. Removed download queue short-circuit in `checkAllMediaCached()` — always HEAD-check the content store directly since the queue state can be stale after completed downloads.
- **XLF storage in content store** — Layout XLFs were fetched but never written to the content store. `prepareLayout()` used `store.get()` which always returned null on fresh installs. Now `store.put()` writes XLF immediately after fetch, unifying storage for XMDS and REST transports.
- **Download/cache race condition** — Proxy `res.end()` fired before `commit()` renamed `.tmp` to `.bin`. Browser HEAD checks raced the file commit, getting 204 (not found). Fixed: `res.end()` now waits inside `writeStream.end()` callback, after `commit()`.
- **Download manager key mismatch** — `enqueueFile` used URL path format (`player/api/v2/media/file/42.jpg`) but DownloadQueue uses `type/id` format (`media/42`). `getTask()` always returned null, `removeCompleted()` was a no-op, completed tasks leaked in the active queue. Fixed: use `type/id` format for all download manager calls.

### Shell Updates

- **Electron 40.8.3 to 41.0.3** (Chrome 144 to 146) — `--no-zygote` flag fixes Wayland GPU process spawning. GPU process now receives proper `--ozone-platform=wayland`, `--render-node-override`, and `WaylandLinuxDrmSyncobj` flags. GPU CPU: 66% to 8%. GPU memory leak: eliminated. ([electron#50455](https://github.com/electron/electron/issues/50455))
- **Chromium kiosk optimization** — `--disable-extensions` and `--disable-features=SpareRendererForSitePerProcess` for single-origin signage.

### Performance

- Electron GPU PSS: 1,711 MB (leaking) to 150 MB (stable) with `--no-zygote` fix
- Electron total CPU: 48% to 7% (hardware GPU compositing vs software fallback)
- Layout transitions: immediate (was 30s delay for layouts with `useDuration=0` non-video widgets)
- Fresh installs: layouts play immediately instead of stuck on "Downloading layout"
- Offline: cached content plays through CMS outages
- 1629 unit tests passing

## 0.7.5 (2026-03-23)

### Bug Fixes

- **Store protocol: zero console errors** — `/store/*` HEAD and GET routes return 204 No Content (not 404) for non-existent files. Chromium logs 404 as "Failed to load resource" but silently ignores 204. Incomplete chunked files return 200 with `X-Store-Complete: false` header. StoreClient checks status 200 (not `ok`) to distinguish cached from missing.
- **In-memory cache tracking** — `_cachedMediaKeys` Set tracks confirmed-cached files, skipping HEAD requests entirely for known files. `checkAllMediaCached` and `checkTimelineMediaStatus` also check `downloadManager.getTask()` to skip files actively downloading. Reduces 82 console errors to 0 on fresh start.
- **Enqueue HEAD check regression** — `enqueueFile` checked `headResp.ok` which is true for 204, causing files to be skipped for download. Fixed to check `headResp.status === 200`.
- **Logger logLevel override** — Logger now reads `xibo_config.logLevel` from localStorage as a local override source. CMS `registerDisplay` can no longer downgrade debug→error when config explicitly sets debug.
- **Setup redirect preserves URL params** — Polling success redirect now carries `?logLevel=DEBUG` query string to index.html.
- **Stale timeline ⚠ badges** — `pendingLayouts` cleared on successful `prepareLayout`, not only when layout plays. Eliminates stale missing-media badges for layouts that are cached but haven't played yet.

### Stats

- 1629 unit tests passing, 0 skipped
- Zero console errors on fresh start (was 82 in v0.7.4)
- Verified: 5 complete rotations on Electron, 9+ layout plays on Chromium, both stable over 1h 40min+

## 0.7.4 (2026-03-22)

### Bug Fixes

- **Preloaded video autoplay** — `_restartMediaElement` now always calls `play()` for preloaded-then-paused videos. Previously gated on `seeked` event or `readyState>=2`, neither of which fires for videos paused at `currentTime=0`. Latent since v0.2.0. (#291)
- **Preloaded video duration** — `createdForLayoutId` now uses `_preloadingLayoutId` during preload instead of `currentLayoutId`. Duration updates were rejected for preloaded layouts, causing 10s fallback instead of actual video duration. Latent since v0.5.10. (#291)
- **Collecting lock race** — fixed re-entrant collection cycles when XMR `collectNow` arrives during an in-flight collection
- **S3 URL expiry** — download tasks now detect and skip expired signed URLs, waiting for next collection cycle to get fresh ones
- **Double XML parse** — `getMediaIds` and `fetchWidgetHtml` now share a single `DOMParser` pass
- **Playwright e2e exclusion** — e2e tests excluded from vitest runner (run separately via Playwright)

### Refactoring

- **Proxy** — cached index.html serving, IC handler factory, shared `parseRange` helper
- **Stats/logs** — merged `submitStats`/`submitLogs` into unified submit, extracted `reportFault` helper
- **Schedule** — consolidated logger conventions, sync cleanup

### Stats

- 1629 unit tests passing, 0 skipped

## 0.7.3 (2026-03-21)

### Bug Fixes

- **Chunked download write race** — per-chunk write locks in ContentStore prevent concurrent writes to the same chunk file. Two requests (download pipeline + browser playback) could previously race on the same `.tmp` file, causing data corruption that triggered FFmpeg demuxer errors and the corruption handler deleting entire multi-GB files. (#285)
- **CMS fetch timeout scaling** — proxy timeout is now `30s + 1s/MB` based on `X-Store-Chunk-Size` header. The fixed 30s timeout was too short for 100MB chunks over typical connections, causing `ERR_CONTENT_LENGTH_MISMATCH` and retries.
- **Incomplete chunked file routing** — `X-Store-Chunk-Index` header distinguishes download pipeline requests (fall through to CMS) from browser playback requests (serve from store). Previously all requests for incomplete files were served from store, returning 404 for missing chunks. (#283)
- **API client credentials persistence** — `apiClientId`/`apiClientSecret` now saved to `config.data` (was set on instance, never persisted to localStorage/config.json). Auto-authorization worked once but credentials were lost on restart.
- **Setup config flow** — setup.html always POSTs to proxy `/config` first (was exclusively using `electronAPI.setConfig` in Electron, which only writes config.json without updating proxy's in-memory config). REST auth now works immediately after configuration on all players.
- **Electron IPC allowlist** — added `apiClientId`/`apiClientSecret` to the `set-config` IPC handler allowlist (xiboplayer-electron#28).
- **RendererLite type declaration** — added missing `resumeRegionMedia()` to `index.d.ts`.
- **Preload blob URL routing** — `_preloadingLayoutId` now reset after widget creation loop, preventing blob URLs from being tracked against the wrong layout
- **Overlay XIC completion** — removed identical ternary branches in `_advanceRegion` that caused overlay interactive control events to spuriously trigger main-layout completion checks
- **Advertise-sync port** — removed undefined `serverPort` reference in `POST /system/advertise-sync` endpoint (was silently defaulting to 8765)
- **API proxy headers** — use `SKIP_HEADERS` constant in API forward proxy, preventing stale `content-length` from being forwarded to clients
- **XLF fetch logging** — log warning on XLF fetch failure in `enqueueDownloads` instead of silently swallowing errors

### Tests (42 new)

- cacheThrough integration: chunk routing, timeout scaling, HEAD store checks (13)
- ContentStore write lock concurrency (4)
- POST /config credential merging (4)
- Config data persistence, env vars, extractPwaConfig (11)
- Timeline vs playback consistency (6)
- Renderer preload layout ID tracking (4)

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
- 1629 unit tests passing, 0 skipped

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
