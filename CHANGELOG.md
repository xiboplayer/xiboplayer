# Changelog

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
