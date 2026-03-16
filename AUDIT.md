# Xiboplayer Codebase Audit — 2026-03-14

Comprehensive audit across all repos: xiboplayer (monorepo), xiboplayer-chromium, xiboplayer-electron, xibo-players.github.io, xiboplayer-www.

---

## Executive Summary

The codebase is well-architected with clean package separation. PlayerCore is genuinely platform-independent. The monorepo has 1484 tests across 39 test files. However, the audit found **3 bugs**, **5 memory/safety risks**, **7 refactoring opportunities**, and **4 critical test gaps**.

---

## 1. BUGS (Fix Immediately)

### 1.1 RestClient 401 infinite recursion
**Files**: `packages/xmds/src/rest-client.js:133-136, 187-189`
**Issue**: On 401, clears token and calls itself recursively. If CMS consistently returns 401 after re-auth, this recurses until stack overflow.
**Fix**: Add `retrying` flag — allow exactly one re-auth attempt per request.

### 1.2 Proxy cache-through has no fetch timeout
**Files**: `packages/proxy/src/proxy.js:470`
**Issue**: `fetch(fullUrl, { headers })` in `cacheThrough()` has no timeout. A hung CMS connection blocks the Express handler indefinitely.
**Fix**: Add `signal: AbortSignal.timeout(30000)`.

### 1.3 PlayerCore.executeCommand bare fetch with no timeout
**Files**: `packages/core/src/player-core.js:1357`
**Issue**: HTTP command execution has no timeout. A malicious or hung URL blocks forever.
**Fix**: Add `signal: AbortSignal.timeout(10000)`.

---

## 2. MEMORY & SAFETY RISKS

### 2.1 RestClient._etags and _responseCache never evicted
**Files**: `packages/xmds/src/rest-client.js:33-34`
**Issue**: Maps grow indefinitely. After days of operation with many distinct API paths, these accumulate.
**Risk**: Low in practice (player polls a handful of fixed paths), but unbounded.
**Fix**: Add simple LRU cap (e.g., max 100 entries) or clear on collection cycle.

### 2.2 DownloadQueue.active requires explicit cleanup
**Files**: `packages/cache/src/download-manager.js:572`
**Issue**: Completed `FileDownload` objects remain in `this.active` until `removeCompleted()` is explicitly called.
**Fix**: Auto-prune completed entries in `processQueue()` after download completes.

### 2.3 StoreClient returns false/null on any error
**Files**: `packages/cache/src/store-client.js:31-46`
**Issue**: `has()` returns `false` on any network error, including proxy unreachable. Callers can't distinguish "not cached" from "proxy down."
**Fix**: Check `response.status` before catch; re-throw on non-404 HTTP errors.

### 2.4 Proxy JWT token not auto-refreshed
**Files**: `packages/proxy/src/proxy.js:34`
**Issue**: `_bearerToken` is only updated via `POST /auth-token`. If PWA rotates tokens without re-posting, proxy uses stale token for cache-through.
**Fix**: Have PWA post token on every `_authenticate()` completion.

### 2.5 DataConnectorManager has no circuit breaker
**Files**: `packages/core/src/data-connectors.js:82`
**Issue**: A failing data connector keeps hammering the URL on its timer interval with no backoff.
**Fix**: Add failure counter; exponential backoff after 3 consecutive failures.

---

## 3. TEST GAPS (Critical)

### 3.1 packages/sw/ — ZERO tests (CRITICAL)
**Files**: `chunk-config.js`, `message-handler.js`, `request-handler.js`, `xlf-parser.js`, `sw-utils.js`
**Impact**: The entire service worker module is untested. Chunk sizing, fetch routing, XMDS file rewriting — all critical for offline caching.
**Action**: Write tests for all 5 source files. Priority: request-handler.js (fetch routing) and chunk-config.js (device memory detection).

### 3.2 data-connectors.js — no tests
**Files**: `packages/core/src/data-connectors.js`
**Impact**: Real-time data polling (weather, stocks, traffic widgets) is completely unverified.
**Action**: Test: setConnectors, startPolling, fetchData, cleanup on reconfigure.

### 3.3 rest-client.js — no tests
**Files**: `packages/xmds/src/rest-client.js`
**Impact**: JWT auth flow, ETag caching, proxy mode detection, 401 re-auth recursion — all untested.
**Action**: Test: authenticate, token refresh, ETag 304 handling, 401 retry (and the infinite recursion bug).

### 3.4 overlays.js — no tests
**Files**: `packages/schedule/src/overlays.js`
**Impact**: Overlay scheduling logic (time windows, criteria, priority sorting) is untested.
**Action**: Test: time window checks, priority ordering, criteria evaluation.

### 3.5 Additional gaps
- `packages/proxy/src/content-store.js` — file storage abstraction, untested
- `packages/pwa/public/sw-pwa.js` — SW lifecycle (install, activate, fetch), no unit tests

---

## 4. REFACTORING OPPORTUNITIES

### 4.1 Unify event emitter system
**Problem**: Two competing systems:
- Custom `EventEmitter` (utils/event-emitter.js) — used by cache, schedule, stats, core
- `nanoevents` (npm) — used by renderer, core (PlayerState)
**Impact**: Incompatible APIs; consumers must know which system a module uses.
**Action**: Standardize on nanoevents. Replace custom EventEmitter with a nanoevents wrapper that preserves the `.on()/.off()/.emit()` API. Or vice versa.

### 4.2 Centralize IndexedDB boilerplate
**Problem**: Promise-wrapped IndexedDB init duplicated in 4 locations:
- `utils/config.js:356-428` (xibo-hw-backup)
- `stats/stats-collector.js:61-107` (xibo-player-stats)
- `core/player-core.js:90+` (offline cache)
- Various other IndexedDB patterns
**Action**: Extract `openDatabase(name, version, onUpgrade)` helper to `@xiboplayer/utils/idb.js`. Provide `getStore()`, `transaction()`, and `put/get/delete` wrappers.

### 4.3 Consolidate retry/backoff patterns
**Problem**: Three different retry implementations:
- `fetchWithRetry()` in utils — full featured (jitter, Retry-After)
- `DownloadTask.start()` in cache — inline loop, type-specific delays, no jitter
- `WebSocketTransport._scheduleReconnect()` in sync — exponential backoff
**Action**: Extract generic `exponentialBackoff(attempt, base, max, jitter?)` to utils. Have DownloadTask and WsTransport use it instead of reimplementing.

### 4.4 Move scattered utilities to @xiboplayer/utils
**Candidates**:
| Function | Current Location | Status |
|----------|-----------------|--------|
| `formatBytes(bytes, decimals)` | sw/sw-utils.js | Generic, broadly useful |
| `escapeXml(str)` | stats/stats-collector.js (private) | Generic |
| `formatDateTime(date)` | stats/stats-collector.js (private) | Generic |
| `HTTP_STATUS` constants | sw/sw-utils.js | Generic |
| `TIMEOUTS` constants | sw/sw-utils.js | Generic |

### 4.5 Add missing explicit dependencies
**Problem**: 5+ packages import from `@xiboplayer/utils` but don't declare it in package.json:
- cache, schedule, settings, stats, sync, sw
**Risk**: Standalone npm consumption would fail without utils.
**Fix**: Add `"@xiboplayer/utils": "workspace:*"` to their package.json dependencies.

### 4.6 Remove dead code
- `Config.hash()` method (`utils/config.js:513-539`) — duplicate of exported `fnvHash()`
- Duplicate screenshot handler: `screenShot` and `screenshot` in `xmr/xmr-wrapper.js:118,243`
- `DisplaySettings`: `embeddedServerPort` and `isSspEnabled` parsed but never read

### 4.7 Fix nanoevents version inconsistency
- `pwa/package.json`: `^9.0.0`
- `core/package.json`, `renderer/package.json`: `^9.1.0`
**Fix**: Align all to `^9.1.0`.

---

## 5. CROSS-REPO CODE SHARING (Chromium ↔ Electron)

### 5.1 Duplicated shell logic
Both xiboplayer-chromium and xiboplayer-electron likely implement:
- **Screen blanking** — gsettings/xset/KDE calls (`launch-kiosk.sh:165-197`)
- **Adaptive memory tuning** — RAM-tier-based V8 flags (`launch-kiosk.sh:327-349`)
- **Browser binary resolution** — fallback chains (`launch-kiosk.sh:202-239`)
- **Lock file management** — prevent duplicate instances
- **Systemd integration** — service files with restart policies

**Action**: Create shared shell library (`xiboplayer-shell-common/`) or extract shared bash functions.

### 5.2 Chromium server uses console.log
**Files**: `xiboplayer-chromium/xiboplayer/server/server.js`
**Issue**: Violates project convention (use `log.info/warn/error` from `@xiboplayer/utils`).
**Fix**: Import and use `createLogger` from `@xiboplayer/utils`.

---

## 6. DOCUMENTATION ISSUES

| Issue | Files | Fix |
|-------|-------|-----|
| Version 0.6.12 → 0.6.13 | FEATURE_COMPARISON.md (gh-pages + www EN + www CA) | Update version references |
| "13 command handlers" → 14 | www/en/sdk/packages.md, www/ca/sdk/packages.md | Count actual handlers |
| "13 packages" → 14+ | www/en/sdk/packages.md, www/ca/sdk/packages.md | Count actual packages |
| "11 packages" in comparison | FEATURE_COMPARISON.md:82 | Update count |

---

## 7. CODE QUALITY OBSERVATIONS (No Action Needed)

These are **not issues** — just notes for awareness:

- **Config._backupKeys()** is fire-and-forget (no await) — intentional
- **FileDownload._promise.catch(() => {})** suppresses unhandled rejection — correct defensive measure
- **DownloadQueue polling** (50ms setTimeout loop) — works, could be event-driven but not a problem
- **PlayerCore has ~25 instance state fields** — complex but well-named
- **SOAP fault parsing is O(n)** on large responses — acceptable for the data sizes involved
- **CmsApiClient has no retry** — used only in tests/admin, not runtime

---

## 8. IMPLEMENTATION PLAN

### Phase 1: Bug Fixes (1-2 hours)
1. RestClient 401 recursion guard
2. Proxy cache-through timeout
3. PlayerCore.executeCommand timeout

### Phase 2: Safety Fixes (2-3 hours)
4. RestClient ETag/cache eviction (LRU cap)
5. DownloadQueue auto-prune completed
6. StoreClient error discrimination
7. DataConnectorManager circuit breaker

### Phase 3: Missing Tests (4-6 hours)
8. packages/sw/ tests (5 source files)
9. rest-client.js tests
10. data-connectors.js tests
11. overlays.js tests

### Phase 4: Refactoring (3-4 hours)
12. Unify event emitter
13. Centralize IndexedDB helpers
14. Extract backoff utility
15. Move formatBytes/escapeXml/formatDateTime to utils
16. Add missing package.json dependencies
17. Remove dead code

### Phase 5: Cross-Repo & Docs (1-2 hours)
18. Fix version/count references in docs
19. Chromium server: use createLogger

---

## 9. TEST COVERAGE MATRIX

| Package | Source Files | Test Files | Coverage | Priority Gap |
|---------|-------------|------------|----------|-------------|
| cache | 7 | 5 | Excellent | — |
| sync | 4 | 2 | Excellent | — |
| schedule | 6 | 6 | Very Good | overlays.js |
| renderer | 5 | 4 | Good | — |
| core | 4 | 3 | Fair | data-connectors.js |
| xmds | 7 | 6 | Good | rest-client.js |
| xmr | 3 | 2 | Excellent | — |
| proxy | 3 | 2 | Good | content-store.js |
| utils | 6 | 6 | Excellent | — |
| stats | 2 | 2 | Excellent | — |
| settings | 1 | 1 | Excellent | — |
| crypto | 1 | 1 | Excellent | — |
| pwa | 2 | 2 | Fair | sw-pwa.js lifecycle |
| **sw** | **5** | **0** | **NONE** | **ALL FILES** |

---

*Generated by comprehensive 6-agent parallel audit. Each agent explored the codebase independently: monorepo structure, test coverage, chromium/electron repos, code quality patterns, shared utilities potential, and documentation consistency.*
